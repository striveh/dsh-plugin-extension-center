import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson, canonicalSha256 } from "../domain/index.js";
import { ensurePrivateDirectory, openRegularNoFollow, storageKey, writeCanonicalAtomic, writeCanonicalExclusive, } from "../host/files.js";
import { decodeTaskAttempt, decodeTaskAttemptDerivation, decodeTaskRetryContinuation } from "./codec.js";
const TRANSITIONS = Object.freeze({
    'checking-existing': ['resolving'],
    resolving: ['awaiting-approval'],
    'awaiting-approval': ['acquiring'],
    acquiring: ['verifying-visibility', 'restart-required'],
    'verifying-visibility': ['restart-required', 'ready-to-resume'],
    'restart-required': ['verifying-visibility', 'ready-to-resume'],
    'ready-to-resume': ['resuming'],
    resuming: [],
});
async function readDurableOptional(path) {
    let handle;
    try {
        handle = await openRegularNoFollow(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    let text;
    try {
        text = await handle.readFile('utf8');
    }
    finally {
        await handle.close();
    }
    if (!text.endsWith('\n') || text.slice(0, -1).includes('\n'))
        throw new Error(`durable task record is incomplete: ${path}`);
    const value = JSON.parse(text);
    if (`${canonicalJson(value)}\n` !== text)
        throw new Error(`durable task record is not canonical: ${path}`);
    return value;
}
function initialAttempt(input) {
    return decodeTaskAttempt({
        schemaVersion: 1,
        taskAttemptId: input.taskAttemptId ?? `task-attempt:${randomUUID()}`,
        parentAttemptId: input.parentAttemptId,
        trigger: input.trigger,
        revision: 0,
        sessionId: input.sessionId,
        originalMessageId: input.originalMessageId,
        profileId: input.profileId,
        projectRoot: resolve(input.projectRoot),
        need: input.need,
        needDigest: canonicalSha256(input.need),
        resumeAgentOptions: input.resumeAgentOptions,
        createdAtMs: input.createdAtMs,
        expiresAtMs: input.expiresAtMs,
        updatedAtMs: input.createdAtMs,
        phase: 'checking-existing',
        outcome: null,
        reason: null,
        result: null,
    });
}
/** Strict file-backed owner for terminal-once original-task attempts. */
export class FileTaskAttemptStore {
    root;
    queue = Promise.resolve();
    constructor(root) {
        this.root = resolve(root);
    }
    /** Audit records and complete any derivation interrupted after its durable claim. */
    async initialize() {
        await ensurePrivateDirectory(join(this.root, 'state'));
        const derivations = await this.listDerivations();
        for (const derivation of derivations) {
            const child = await this.get(derivation.attempt.taskAttemptId);
            if (child === undefined)
                await this.putExclusiveAttempt(derivation.attempt);
            else
                this.assertClaimChild(derivation.attempt, child);
        }
        const attempts = await this.list();
        const byId = new Map(attempts.map(attempt => [attempt.taskAttemptId, attempt]));
        const derivedIds = new Set();
        for (const derivation of derivations) {
            const source = byId.get(derivation.sourceAttemptId);
            const child = byId.get(derivation.attempt.taskAttemptId);
            if (source === undefined || child === undefined)
                throw new Error('task derivation source or child is absent');
            this.assertDerivation(source, derivation.kind, derivation.candidateRef, derivation.createdAtMs);
            if (derivedIds.has(child.taskAttemptId)) {
                throw new Error('task derivation does not bind one unique child attempt');
            }
            this.assertClaimChild(derivation.attempt, child);
            this.assertInheritedAttempt(source, child);
            derivedIds.add(child.taskAttemptId);
        }
        for (const attempt of attempts) {
            if ((attempt.trigger === 'model') !== !derivedIds.has(attempt.taskAttemptId)) {
                throw new Error('task attempt has no exact derivation authority');
            }
        }
        for (const retry of await this.listRetryContinuations())
            this.assertRetryContinuation(retry, byId);
    }
    /** Start one model-origin attempt and supersede older mutable attempts for the same message. */
    async create(input) {
        return this.serialize(async () => {
            for (const prior of await this.list()) {
                if (prior.outcome === null && prior.sessionId === input.sessionId && prior.originalMessageId === input.originalMessageId) {
                    await this.closeUnlocked(prior, 'resume-conflict', 'superseded-by-new-attempt', prior.result, input.createdAtMs);
                }
            }
            const attempt = initialAttempt({ ...input, parentAttemptId: null, trigger: 'model' });
            await this.putExclusiveAttempt(attempt);
            return attempt;
        });
    }
    /** Derive exactly one new attempt from one terminal choice or management handoff. */
    async derive(input) {
        return this.serialize(async () => {
            const priorClaim = await this.getDerivation(input.sourceAttemptId);
            if (priorClaim !== undefined) {
                if (input.kind === 'retry-original'
                    && priorClaim.kind === input.kind
                    && priorClaim.candidateRef === null) {
                    return await this.required(priorClaim.attempt.taskAttemptId);
                }
                throw new Error('task attempt derivation was already consumed');
            }
            const source = await this.get(input.sourceAttemptId);
            if (source === undefined)
                throw new Error('source task attempt is absent');
            this.assertDerivation(source, input.kind, input.candidateRef, input.createdAtMs);
            const attempt = initialAttempt({
                taskAttemptId: `task-attempt:${randomUUID()}`,
                parentAttemptId: source.taskAttemptId,
                trigger: input.kind,
                sessionId: source.sessionId,
                originalMessageId: source.originalMessageId,
                profileId: source.profileId,
                projectRoot: source.projectRoot,
                need: source.need,
                resumeAgentOptions: source.resumeAgentOptions,
                createdAtMs: input.createdAtMs,
                expiresAtMs: input.expiresAtMs,
            });
            const derivation = decodeTaskAttemptDerivation({
                schemaVersion: 1,
                sourceAttemptId: source.taskAttemptId,
                kind: input.kind,
                candidateRef: input.candidateRef,
                createdAtMs: input.createdAtMs,
                attempt,
            });
            await writeCanonicalExclusive(this.derivationPath(source.taskAttemptId), derivation);
            await this.putExclusiveAttempt(attempt);
            return attempt;
        });
    }
    /** Read one task attempt by opaque id. */
    async get(taskAttemptId) {
        const value = await readDurableOptional(this.attemptPath(taskAttemptId));
        return value === undefined ? undefined : decodeTaskAttempt(value, taskAttemptId);
    }
    /** Find the exact task attempt that owns one candidate-bound resolution. */
    async getByResolution(resolutionId) {
        const matches = (await this.list()).filter(attempt => attempt.result?.kind === 'acquisition-candidate' && attempt.result.resolutionId === resolutionId);
        if (matches.length > 1)
            throw new Error('task resolution is bound to multiple attempts');
        return matches[0];
    }
    /** Read one Retry-original continuation binding by its derived task attempt. */
    async getRetryContinuation(taskAttemptId) {
        const value = await readDurableOptional(this.retryContinuationPath(taskAttemptId));
        return value === undefined ? undefined : decodeTaskRetryContinuation(value, taskAttemptId);
    }
    /** Persist the verifier binding before asking the Host continuation owner to reserve. */
    async putRetryContinuation(value) {
        return this.serialize(async () => {
            const decoded = decodeTaskRetryContinuation(value, value.taskAttemptId);
            const attempts = await this.list();
            this.assertRetryContinuation(decoded, new Map(attempts.map(attempt => [attempt.taskAttemptId, attempt])));
            const existing = await this.getRetryContinuation(decoded.taskAttemptId);
            if (existing !== undefined) {
                const left = { ...existing, continuationId: null, canceledAtMs: null };
                const right = { ...decoded, continuationId: null, canceledAtMs: null };
                if (canonicalSha256(left) !== canonicalSha256(right))
                    throw new Error('task Retry continuation binding conflicts');
                return existing;
            }
            await writeCanonicalExclusive(this.retryContinuationPath(decoded.taskAttemptId), decoded);
            return decoded;
        });
    }
    /** Bind the actual Host continuation id after an exact reserve or restart reconciliation. */
    async bindRetryContinuation(taskAttemptId, continuationId) {
        return this.serialize(async () => {
            const prior = await this.getRetryContinuation(taskAttemptId);
            if (prior === undefined)
                throw new Error('task Retry continuation binding is absent');
            if (prior.continuationId !== null) {
                if (prior.continuationId !== continuationId)
                    throw new Error('task Retry continuation id conflicts');
                return prior;
            }
            const next = decodeTaskRetryContinuation({ ...prior, continuationId }, taskAttemptId);
            await writeCanonicalAtomic(this.retryContinuationPath(taskAttemptId), next);
            return next;
        });
    }
    /** Persist a cancellation intent before reconciling it with the Host continuation owner. */
    async cancelRetryContinuation(taskAttemptId, nowMs) {
        return this.serialize(async () => {
            const prior = await this.getRetryContinuation(taskAttemptId);
            if (prior === undefined)
                throw new Error('task Retry continuation binding is absent');
            if (prior.canceledAtMs !== null)
                return prior;
            const next = decodeTaskRetryContinuation({ ...prior, canceledAtMs: nowMs }, taskAttemptId);
            await writeCanonicalAtomic(this.retryContinuationPath(taskAttemptId), next);
            return next;
        });
    }
    /** List every task attempt deterministically. */
    async list() {
        const values = await this.listGroup('task-attempts', (value, name) => {
            const attempt = decodeTaskAttempt(value);
            if (name !== `${storageKey(attempt.taskAttemptId)}.json`)
                throw new Error('task attempt filename does not bind its identity');
            return attempt;
        });
        return Object.freeze(values.sort((left, right) => left.createdAtMs - right.createdAtMs
            || left.taskAttemptId.localeCompare(right.taskAttemptId)));
    }
    /** Advance a mutable task phase with an optional non-authorizing result. */
    async transition(taskAttemptId, expectedRevision, phase, result, nowMs) {
        return this.serialize(async () => {
            const prior = await this.required(taskAttemptId);
            if (prior.revision !== expectedRevision)
                throw new Error('task attempt revision conflict');
            if (prior.outcome !== null)
                throw new Error('terminal task attempt cannot transition');
            if (!TRANSITIONS[prior.phase].includes(phase))
                throw new Error('invalid task attempt phase transition');
            const next = decodeTaskAttempt({
                ...prior,
                revision: prior.revision + 1,
                updatedAtMs: nowMs,
                phase,
                result,
            });
            if (prior.result !== null && canonicalSha256(prior.result) !== canonicalSha256(next.result)) {
                throw new Error('task attempt result is already assigned');
            }
            await writeCanonicalAtomic(this.attemptPath(taskAttemptId), next);
            return next;
        });
    }
    /** Assign one terminal outcome exactly once. */
    async close(taskAttemptId, expectedRevision, outcome, reason, result, nowMs) {
        return this.serialize(async () => {
            const prior = await this.required(taskAttemptId);
            if (prior.revision !== expectedRevision)
                throw new Error('task attempt revision conflict');
            return this.closeUnlocked(prior, outcome, reason, result, nowMs);
        });
    }
    /** Reject an expired mutable attempt once and return its current terminal state on replay. */
    async expire(taskAttemptId, nowMs) {
        return this.serialize(async () => {
            const prior = await this.required(taskAttemptId);
            if (prior.outcome !== null)
                return prior;
            if (prior.expiresAtMs > nowMs)
                throw new Error('task attempt has not expired');
            return this.closeUnlocked(prior, 'rejected', 'attempt-expired', prior.result, nowMs);
        });
    }
    async closeUnlocked(prior, outcome, reason, result, nowMs) {
        if (prior.outcome !== null)
            throw new Error('task attempt outcome is already terminal');
        const next = decodeTaskAttempt({
            ...prior,
            revision: prior.revision + 1,
            updatedAtMs: nowMs,
            outcome,
            reason,
            result,
        });
        if (prior.result !== null && canonicalSha256(prior.result) !== canonicalSha256(next.result)) {
            throw new Error('task attempt result is already assigned');
        }
        await writeCanonicalAtomic(this.attemptPath(prior.taskAttemptId), next);
        return next;
    }
    async required(taskAttemptId) {
        const value = await this.get(taskAttemptId);
        if (value === undefined)
            throw new Error('task attempt is absent');
        return value;
    }
    assertDerivation(source, kind, candidateRef, createdAtMs) {
        if (createdAtMs < source.updatedAtMs || createdAtMs >= source.expiresAtMs) {
            throw new Error('task attempt derivation is outside the source validity interval');
        }
        if (kind === 'choice-selection') {
            if (source.outcome !== 'choice-required' || source.result?.kind !== 'choice-required'
                || candidateRef === null || !source.result.candidateRefs.includes(candidateRef)) {
                throw new Error('task choice does not bind a terminal candidate');
            }
        }
        else if (source.outcome !== 'management-required' || candidateRef !== null) {
            throw new Error('Retry original requires a terminal management attempt');
        }
    }
    assertInheritedAttempt(source, child) {
        if (child.parentAttemptId !== source.taskAttemptId
            || child.sessionId !== source.sessionId
            || child.originalMessageId !== source.originalMessageId
            || child.profileId !== source.profileId
            || child.projectRoot !== source.projectRoot
            || child.needDigest !== source.needDigest
            || canonicalSha256(child.need) !== canonicalSha256(source.need)
            || canonicalSha256(child.resumeAgentOptions) !== canonicalSha256(source.resumeAgentOptions)) {
            throw new Error('derived task attempt does not preserve the original task binding');
        }
    }
    assertClaimChild(claim, current) {
        if (current.taskAttemptId !== claim.taskAttemptId
            || current.parentAttemptId !== claim.parentAttemptId
            || current.trigger !== claim.trigger
            || current.sessionId !== claim.sessionId
            || current.originalMessageId !== claim.originalMessageId
            || current.profileId !== claim.profileId
            || current.projectRoot !== claim.projectRoot
            || current.needDigest !== claim.needDigest
            || current.createdAtMs !== claim.createdAtMs
            || current.expiresAtMs !== claim.expiresAtMs
            || current.revision < claim.revision
            || canonicalSha256(current.need) !== canonicalSha256(claim.need)
            || canonicalSha256(current.resumeAgentOptions) !== canonicalSha256(claim.resumeAgentOptions)) {
            throw new Error('task derivation claim does not bind its durable child');
        }
    }
    assertRetryContinuation(retry, byId) {
        const attempt = byId.get(retry.taskAttemptId);
        const parent = byId.get(retry.parentAttemptId);
        if (attempt?.trigger !== 'retry-original'
            || attempt.parentAttemptId !== retry.parentAttemptId
            || attempt.outcome !== 'use-existing'
            || attempt.result?.kind !== 'use-existing'
            || attempt.result.capabilityId !== retry.existingCapabilityId
            || attempt.sessionId !== retry.sessionId
            || attempt.originalMessageId !== retry.originalMessageId
            || attempt.needDigest !== retry.needDigest
            || attempt.updatedAtMs !== retry.createdAtMs
            || attempt.expiresAtMs !== retry.expiresAtMs
            || parent?.outcome !== 'management-required'
            || parent.result?.kind !== 'management-required'
            || parent.result.targetKey !== retry.targetKey
            || parent.result.action !== retry.action
            || retry.verificationPayloadDigest !== canonicalSha256({
                taskAttemptId: retry.taskAttemptId,
                parentAttemptId: retry.parentAttemptId,
                targetKey: retry.targetKey,
                action: retry.action,
                needDigest: retry.needDigest,
                existingCapabilityId: retry.existingCapabilityId,
            })) {
            throw new Error('task Retry continuation does not bind the terminal attempt and management target');
        }
    }
    async putExclusiveAttempt(value) {
        const decoded = decodeTaskAttempt(value, value.taskAttemptId);
        const path = this.attemptPath(decoded.taskAttemptId);
        const existing = await readDurableOptional(path);
        if (existing !== undefined) {
            if (canonicalSha256(existing) !== canonicalSha256(decoded))
                throw new Error('task attempt identity already has different content');
            return;
        }
        try {
            await writeCanonicalExclusive(path, decoded);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const raced = await readDurableOptional(path);
            if (canonicalSha256(raced) !== canonicalSha256(decoded))
                throw new Error('task attempt creation raced with different content');
        }
    }
    async getDerivation(sourceAttemptId) {
        const value = await readDurableOptional(this.derivationPath(sourceAttemptId));
        return value === undefined ? undefined : decodeTaskAttemptDerivation(value, sourceAttemptId);
    }
    async listDerivations() {
        return this.listGroup('task-attempt-derivations', (value, name) => {
            const derivation = decodeTaskAttemptDerivation(value);
            if (name !== `${storageKey(derivation.sourceAttemptId)}.json`)
                throw new Error('task derivation filename does not bind its source');
            return derivation;
        });
    }
    attemptPath(taskAttemptId) {
        return join(this.root, 'state', 'task-attempts', `${storageKey(taskAttemptId)}.json`);
    }
    derivationPath(sourceAttemptId) {
        return join(this.root, 'state', 'task-attempt-derivations', `${storageKey(sourceAttemptId)}.json`);
    }
    retryContinuationPath(taskAttemptId) {
        return join(this.root, 'state', 'task-retry-continuations', `${storageKey(taskAttemptId)}.json`);
    }
    async listRetryContinuations() {
        return this.listGroup('task-retry-continuations', (value, name) => {
            const retry = decodeTaskRetryContinuation(value);
            if (name !== `${storageKey(retry.taskAttemptId)}.json`)
                throw new Error('task Retry continuation filename does not bind its attempt');
            return retry;
        });
    }
    async listGroup(group, decode) {
        const directory = join(this.root, 'state', group);
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
            const info = await lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink())
                throw new Error(`task state group is not a real directory: ${directory}`);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        }
        const output = [];
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (entry.name.startsWith('.tmp-'))
                continue;
            if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
                throw new Error(`unexpected task state entry: ${join(directory, entry.name)}`);
            }
            const value = await readDurableOptional(join(directory, entry.name));
            if (value !== undefined)
                output.push(decode(value, entry.name));
        }
        return output;
    }
    async serialize(work) {
        const prior = this.queue;
        let release;
        this.queue = new Promise(resolveQueue => { release = resolveQueue; });
        await prior;
        try {
            return await work();
        }
        finally {
            release();
        }
    }
}
//# sourceMappingURL=store.js.map
