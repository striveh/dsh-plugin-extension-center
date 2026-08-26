import { randomUUID } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson } from "../domain/index.js";
import { ensurePrivateDirectory, openRegularNoFollow, storageKey, writeCanonicalAtomic, writeCanonicalExclusive, } from "./files.js";
import { assertStateFileIdentity, decodeCenterManifest, decodeContinuationActivation, decodeContinuationActivationIntent, decodeManagedTarget, decodeOperationIndex, decodeProfileBootAck, decodeProviderSnapshot, decodeStoredIntent, decodeStoredResolution, decodeTaskReceipt, } from "./state-codec.js";
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
        throw new Error(`durable record is incomplete: ${path}`);
    const value = JSON.parse(text);
    if (`${canonicalJson(value)}\n` !== text)
        throw new Error(`durable record is not canonical: ${path}`);
    return value;
}
/** File-backed center manifest and per-identity durable records. */
export class CenterStateStore {
    root;
    constructor(root) {
        this.root = resolve(root);
    }
    /** Initialize the private root and its single-assignment identity manifest. */
    async initialize(nowMs = Date.now()) {
        await ensurePrivateDirectory(this.root);
        const path = join(this.root, 'manifest.json');
        const existing = await readDurableOptional(path);
        if (existing === undefined) {
            const manifest = decodeCenterManifest({ schemaVersion: 1, centerId: randomUUID(), createdAtMs: nowMs });
            try {
                await writeCanonicalExclusive(path, manifest);
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
            }
        }
        decodeCenterManifest(await readDurableOptional(path));
        await this.auditDurableState();
    }
    /** Load one managed target. */
    async getManaged(targetKey) {
        const value = await readDurableOptional(this.path('managed', targetKey));
        return value === undefined ? undefined : decodeManagedTarget(value, this.root, targetKey);
    }
    /** Replace one target after checking its center revision. */
    async putManaged(record, expectedRevision) {
        const decoded = decodeManagedTarget(record, this.root, record.targetKey);
        const prior = await this.getManaged(decoded.targetKey);
        const actual = prior?.revision ?? 0;
        if (actual !== expectedRevision || decoded.revision !== expectedRevision + 1) {
            throw new Error(`managed target revision conflict: expected ${String(expectedRevision)}, actual ${String(actual)}`);
        }
        await writeCanonicalAtomic(this.path('managed', decoded.targetKey), decoded);
    }
    /** Remove an exact managed record only when its revision still matches. */
    async deleteManaged(targetKey, expectedRevision) {
        const prior = await this.getManaged(targetKey);
        if (prior === undefined || prior.revision !== expectedRevision) {
            throw new Error(`managed target revision conflict while deleting ${targetKey}`);
        }
        await rm(this.path('managed', targetKey));
    }
    /** Enumerate center-owned target records deterministically. */
    async listManaged() {
        return this.listDirectory('managed', (value, name) => {
            const decoded = decodeManagedTarget(value, this.root);
            assertStateFileIdentity(name, decoded.targetKey, 'managed target');
            return decoded;
        });
    }
    /** Persist one immutable intent binding exactly once. */
    async putIntent(value) {
        const decoded = decodeStoredIntent(value, value.intent.intentId);
        await this.putExclusive(this.path('intents', decoded.intent.intentId), decoded);
    }
    /** Read an intent by identity. */
    async getIntent(intentId) {
        const value = await readDurableOptional(this.path('intents', intentId));
        return value === undefined ? undefined : decodeStoredIntent(value, intentId);
    }
    /** Persist one opaque resolution exactly once. */
    async putResolution(value) {
        const decoded = decodeStoredResolution(value, value.resolutionId);
        await this.putExclusive(this.path('resolutions', decoded.resolutionId), decoded);
    }
    /** Read one opaque resolution. */
    async getResolution(resolutionId) {
        const value = await readDurableOptional(this.path('resolutions', resolutionId));
        return value === undefined ? undefined : decodeStoredResolution(value, resolutionId);
    }
    /** List Host-only task resolutions deterministically. */
    async listResolutions() {
        const values = await this.listDirectory('resolutions', (value, name) => {
            const decoded = decodeStoredResolution(value);
            assertStateFileIdentity(name, decoded.resolutionId, 'stored resolution');
            return decoded;
        });
        return Object.freeze([...values].sort((left, right) => left.createdAtMs - right.createdAtMs
            || left.resolutionId.localeCompare(right.resolutionId)));
    }
    /** Replace the non-authoritative operation lookup row. */
    async putOperationIndex(value) {
        const decoded = decodeOperationIndex(value, value.operationId);
        await writeCanonicalAtomic(this.path('operation-index', decoded.operationId), decoded);
    }
    /** List operation lookup rows; callers re-read journals before trusting phase fields. */
    async listOperationIndexes() {
        return this.listDirectory('operation-index', (value, name) => {
            const decoded = decodeOperationIndex(value);
            assertStateFileIdentity(name, decoded.operationId, 'operation index');
            return decoded;
        });
    }
    /** Persist the exact provider recovery point before entering applying. */
    async putProviderSnapshot(value) {
        const decoded = decodeProviderSnapshot(value, this.root, value.operationId);
        await this.putExclusive(this.path('provider-snapshots', decoded.operationId), decoded);
    }
    /** Read one exact provider recovery point. */
    async getProviderSnapshot(operationId) {
        const value = await readDurableOptional(this.path('provider-snapshots', operationId));
        return value === undefined ? undefined : decodeProviderSnapshot(value, this.root, operationId);
    }
    /** Persist or idempotently replace an exact external boot acknowledgement. */
    async putBootAck(value) {
        const next = decodeProfileBootAck(value, value.operationId);
        const path = this.path('boot-acks', next.operationId);
        const prior = await readDurableOptional(path);
        if (prior !== undefined) {
            const decoded = decodeProfileBootAck(prior, next.operationId);
            const same = decoded.profileId === next.profileId
                && decoded.generation === next.generation
                && decoded.phase === next.phase
                && decoded.revision === next.revision
                && decoded.treeDigest === next.treeDigest;
            const forwardRollback = decoded.profileId === next.profileId
                && decoded.phase === 'candidate'
                && next.phase === 'rollback';
            if (!same && !forwardRollback) {
                throw new Error('boot acknowledgement conflicts with its prior binding');
            }
        }
        await writeCanonicalAtomic(path, next);
    }
    /** Read one external boot acknowledgement. */
    async getBootAck(operationId) {
        const value = await readDurableOptional(this.path('boot-acks', operationId));
        return value === undefined ? undefined : decodeProfileBootAck(value, operationId);
    }
    /** Persist the single verified lifecycle result that may release one parked task. */
    async putTaskReceipt(value) {
        const decoded = decodeTaskReceipt(value, value.continuationId);
        await this.putExclusive(this.path('task-receipts', decoded.continuationId), decoded);
    }
    /** Read the verified lifecycle result for one continuation claim. */
    async getTaskReceipt(continuationId) {
        const value = await readDurableOptional(this.path('task-receipts', continuationId));
        return value === undefined ? undefined : decodeTaskReceipt(value, continuationId);
    }
    /** Persist the actual continuation claim bound to an approved plan reservation. */
    async putContinuationActivation(value) {
        const decoded = decodeContinuationActivation(value, value.reservationId);
        await this.putExclusive(this.path('continuation-activations', decoded.reservationId), decoded);
    }
    /** Read an approved plan's reservation-to-claim binding. */
    async getContinuationActivation(reservationId) {
        const value = await readDurableOptional(this.path('continuation-activations', reservationId));
        return value === undefined
            ? undefined
            : decodeContinuationActivation(value, reservationId);
    }
    /** Persist the approved claim-creation intent before touching the continuation owner. */
    async putContinuationActivationIntent(value) {
        const decoded = decodeContinuationActivationIntent(value, value.reservationId);
        await this.putExclusive(this.path('continuation-activation-intents', decoded.reservationId), decoded);
    }
    /** Read an approved claim-creation intent during cold reconciliation. */
    async getContinuationActivationIntent(reservationId) {
        const value = await readDurableOptional(this.path('continuation-activation-intents', reservationId));
        return value === undefined
            ? undefined
            : decodeContinuationActivationIntent(value, reservationId);
    }
    path(group, id) {
        return join(this.root, 'state', group, `${storageKey(id)}.json`);
    }
    async putExclusive(path, value) {
        const prior = await readDurableOptional(path);
        if (prior !== undefined) {
            if (JSON.stringify(prior) !== JSON.stringify(value))
                throw new Error('single-assignment record already exists');
            return;
        }
        try {
            await writeCanonicalExclusive(path, value);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const raced = await readDurableOptional(path);
            if (JSON.stringify(raced) !== JSON.stringify(value))
                throw new Error('single-assignment record raced with different content');
        }
    }
    async auditDurableState() {
        const stateRoot = join(this.root, 'state');
        let entries;
        try {
            entries = await readdir(stateRoot, { withFileTypes: true });
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            entries = [];
        }
        const groups = new Set([
            'boot-acks',
            'continuation-activation-intents',
            'continuation-activations',
            'intents',
            'managed',
            'operation-index',
            'provider-snapshots',
            'resolutions',
            'task-receipts',
            'task-attempt-derivations',
            'task-attempts',
            'task-retry-continuations',
        ]);
        for (const entry of entries) {
            if (!groups.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
                throw new Error(`unexpected durable state entry: ${join(stateRoot, entry.name)}`);
            }
        }
        await this.listManaged();
        await this.listResolutions();
        await this.listOperationIndexes();
        await this.listDirectory('intents', (value, name) => {
            const decoded = decodeStoredIntent(value);
            assertStateFileIdentity(name, decoded.intent.intentId, 'stored intent');
        });
        await this.listDirectory('provider-snapshots', (value, name) => {
            const decoded = decodeProviderSnapshot(value, this.root);
            assertStateFileIdentity(name, decoded.operationId, 'provider snapshot');
        });
        await this.listDirectory('boot-acks', (value, name) => {
            const decoded = decodeProfileBootAck(value);
            assertStateFileIdentity(name, decoded.operationId, 'profile boot acknowledgement');
        });
        await this.listDirectory('task-receipts', (value, name) => {
            const decoded = decodeTaskReceipt(value);
            assertStateFileIdentity(name, decoded.continuationId, 'task receipt');
        });
        await this.listDirectory('continuation-activations', (value, name) => {
            const decoded = decodeContinuationActivation(value);
            assertStateFileIdentity(name, decoded.reservationId, 'continuation activation');
        });
        await this.listDirectory('continuation-activation-intents', (value, name) => {
            const decoded = decodeContinuationActivationIntent(value);
            assertStateFileIdentity(name, decoded.reservationId, 'continuation activation intent');
        });
    }
    async listDirectory(group, decode) {
        const directory = join(this.root, 'state', group);
        let names;
        try {
            const info = await lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink())
                throw new Error(`durable state group is not a real directory: ${directory}`);
            names = await readdir(directory);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        }
        const output = [];
        for (const name of names.sort()) {
            if (/^\.tmp-[0-9a-f-]{36}$/.test(name))
                continue;
            if (!/^[0-9a-f]{64}\.json$/.test(name))
                throw new Error(`unexpected durable record entry: ${join(directory, name)}`);
            const value = await readDurableOptional(join(directory, name));
            if (value !== undefined)
                output.push(decode(value, name));
        }
        return Object.freeze(output);
    }
}
//# sourceMappingURL=state-store.js.map
