import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalJson, ExtensionDomainError, } from "../domain/index.js";
import { consumeApprovedPlan, createPlanAuthorizationState, decidePlan, decodeImmutablePlan, decodePlanAuthorizationState, decodeStoredPlanAuthorizationState, } from "../plans/index.js";
const PLAN_FILENAME = 'plan.json';
const DECISION_FILENAME = 'decision.json';
const CONSUMPTION_FILENAME = 'consumption.json';
function planDirectoryName(hash) {
    return hash.slice('sha256:'.length);
}
async function syncDirectory(path) {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function writeExclusive(path, content) {
    const temporary = join(dirname(path), `.plan-${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(temporary, path);
        await unlink(temporary);
        await syncDirectory(dirname(path));
    }
    catch (error) {
        try {
            await unlink(temporary);
        }
        catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT')
                throw cleanupError;
        }
        throw error;
    }
}
async function writeSingleAssignment(path, content) {
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await syncDirectory(dirname(path));
}
function parseCanonical(text, subject) {
    if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
        throw new ExtensionDomainError('plan-integrity', `${subject} is not one complete JSON record`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new ExtensionDomainError('plan-integrity', `${subject} is not valid JSON`);
    }
    if (`${canonicalJson(parsed)}\n` !== text) {
        throw new ExtensionDomainError('plan-integrity', `${subject} is not canonical JSON`);
    }
    return parsed;
}
async function readOptional(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
function replayFailure(subject) {
    return new ExtensionDomainError('plan-replay', `${subject} was already assigned`);
}
/** Durable immutable plan and single-assignment human-decision store. */
export class FilePlanStore {
    root;
    recoveryExecutable;
    queues = new Map();
    /**
     * Create a plan store below one center-owned data directory.
     * @param root Exact durable data directory.
     * @param recoveryExecutable Hash-pinned standalone recovery Consumer, or `null` on an explicitly read-only Host.
     */
    constructor(root, recoveryExecutable) {
        this.root = root;
        this.recoveryExecutable = recoveryExecutable;
    }
    /**
     * Persist a new immutable plan, idempotently accepting the same exact plan.
     * @param value Verified or serialized plan.
     * @returns Initial pending authorization state.
     */
    put(value) {
        const plan = decodeImmutablePlan(value);
        return this.serialize(plan.hash, async () => {
            const directory = this.planDirectory(plan.hash);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const path = join(directory, PLAN_FILENAME);
            const existing = await readOptional(path);
            if (existing === undefined) {
                try {
                    await writeExclusive(path, `${canonicalJson(plan)}\n`);
                }
                catch (error) {
                    if (error.code !== 'EEXIST')
                        throw error;
                    const raced = await readOptional(path);
                    if (raced === undefined)
                        throw error;
                    const prior = decodeImmutablePlan(parseCanonical(raced, `plan ${plan.hash}`));
                    if (canonicalJson(prior) !== canonicalJson(plan)) {
                        throw new ExtensionDomainError('plan-integrity', `plan ${plan.hash} content changed`);
                    }
                }
            }
            else {
                const prior = decodeImmutablePlan(parseCanonical(existing, `plan ${plan.hash}`));
                if (canonicalJson(prior) !== canonicalJson(plan)) {
                    throw new ExtensionDomainError('plan-integrity', `plan ${plan.hash} content changed`);
                }
            }
            return createPlanAuthorizationState(plan);
        });
    }
    /**
     * Load the strongest durable state for one plan hash.
     * @param hash Exact immutable plan hash.
     * @returns Verified state, or `undefined` when no plan exists.
     */
    load(hash) {
        return this.serialize(hash, () => this.loadUnlocked(hash));
    }
    /**
     * Record the only human decision after rechecking all current fences.
     * @param hash Exact plan hash.
     * @param decision Trusted loopback decision payload.
     * @param context Current authoritative owner revisions.
     * @param nowMs Trusted decision time.
     * @returns Approved, rejected, or expired durable state.
     */
    decide(hash, decision, context, nowMs) {
        return this.serialize(hash, async () => {
            const state = await this.requireUnlocked(hash);
            if (state.status !== 'pending')
                throw replayFailure(`plan ${hash} decision`);
            const next = decidePlan(state, decision, context, nowMs).state;
            try {
                await writeSingleAssignment(join(this.planDirectory(hash), DECISION_FILENAME), `${canonicalJson(next)}\n`);
            }
            catch (error) {
                if (error.code === 'EEXIST')
                    throw replayFailure(`plan ${hash} decision`);
                throw error;
            }
            return decodePlanAuthorizationState(next);
        });
    }
    /**
     * Consume one approved plan once after rechecking all current fences.
     * @param hash Exact plan hash.
     * @param operationId New operation identity.
     * @param context Current authoritative owner revisions.
     * @param nowMs Trusted consumption time.
     * @returns Durable consumed state and exact operation authorization.
     */
    consume(hash, operationId, context, nowMs) {
        return this.serialize(hash, async () => {
            const state = await this.requireUnlocked(hash);
            if (state.status !== 'approved')
                throw replayFailure(`plan ${hash} consumption`);
            if (this.recoveryExecutable === null) {
                throw new ExtensionDomainError('invalid-data', 'operation authorization is unavailable on a read-only Host');
            }
            const next = consumeApprovedPlan(state, operationId, context, nowMs, this.recoveryExecutable);
            try {
                await writeSingleAssignment(join(this.planDirectory(hash), CONSUMPTION_FILENAME), `${canonicalJson(next.state)}\n`);
            }
            catch (error) {
                if (error.code === 'EEXIST')
                    throw replayFailure(`plan ${hash} consumption`);
                throw error;
            }
            return Object.freeze({ state: decodePlanAuthorizationState(next.state), authorization: next.authorization });
        });
    }
    /** Return every durable plan state sorted by plan id. */
    async list() {
        const root = join(this.root, 'plans');
        let entries;
        try {
            entries = await readdir(root, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        }
        const states = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name))
                continue;
            const state = await this.load(`sha256:${entry.name}`);
            if (state !== undefined)
                states.push(state);
        }
        return Object.freeze(states.sort((left, right) => left.plan.content.planId.localeCompare(right.plan.content.planId)));
    }
    planDirectory(hash) {
        return join(this.root, 'plans', planDirectoryName(hash));
    }
    async requireUnlocked(hash) {
        const state = await this.loadUnlocked(hash);
        if (state === undefined)
            throw new ExtensionDomainError('invalid-data', `plan ${hash} does not exist`);
        return state;
    }
    async loadUnlocked(hash) {
        const directory = this.planDirectory(hash);
        const planText = await readOptional(join(directory, PLAN_FILENAME));
        if (planText === undefined)
            return undefined;
        const plan = decodeImmutablePlan(parseCanonical(planText, `plan ${hash}`));
        if (plan.hash !== hash)
            throw new ExtensionDomainError('plan-integrity', `plan ${hash} hash does not match its path`);
        const consumption = await readOptional(join(directory, CONSUMPTION_FILENAME));
        if (consumption !== undefined) {
            if (await readOptional(join(directory, DECISION_FILENAME)) === undefined) {
                throw new ExtensionDomainError('plan-integrity', `plan ${hash} consumption has no decision`);
            }
            const state = decodeStoredPlanAuthorizationState(parseCanonical(consumption, `plan ${hash} consumption`));
            if (state.plan.hash !== hash || state.status !== 'consumed') {
                throw new ExtensionDomainError('plan-integrity', `plan ${hash} consumption is invalid`);
            }
            return state;
        }
        const decision = await readOptional(join(directory, DECISION_FILENAME));
        if (decision !== undefined) {
            const state = decodePlanAuthorizationState(parseCanonical(decision, `plan ${hash} decision`));
            if (state.plan.hash !== hash || state.status === 'pending' || state.status === 'consumed') {
                throw new ExtensionDomainError('plan-integrity', `plan ${hash} decision is invalid`);
            }
            return state;
        }
        return createPlanAuthorizationState(plan);
    }
    serialize(hash, action) {
        const prior = this.queues.get(hash) ?? Promise.resolve();
        const run = prior.then(action, action);
        const settled = run.then(() => undefined, () => undefined);
        this.queues.set(hash, settled);
        void settled.then(() => {
            if (this.queues.get(hash) === settled)
                this.queues.delete(hash);
        });
        return run;
    }
}
//# sourceMappingURL=plan-store.js.map
