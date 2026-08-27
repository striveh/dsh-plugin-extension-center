/** Strict codecs for plugin-owned continuation inputs and durable records. */
import { TASK_CONTINUATION_INVALID_REASONS } from "./types.js";
/** Fixed prompt that asks the existing Agent to re-check the now-visible capability. */
export const TASK_CONTINUATION_PROMPT = 'The requested capability is now verified for the existing task. Re-check it and continue that task.';
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_ROUTE_BYTES = 256;
const MAX_RESUME_TOKENS = 1_000_000;
/** Stable rejection for malformed continuation input. */
export class TaskContinuationInputError extends Error {
    code = 'TASK_CONTINUATION_INVALID_INPUT';
}
/** Stable rejection for replay of one caller key with different immutable fields. */
export class TaskContinuationMutationConflictError extends Error {
    code = 'TASK_CONTINUATION_MUTATION_CONFLICT';
    constructor(callerId, mutationId) {
        super(`task continuation mutation "${callerId}/${mutationId}" is already bound to different input`);
    }
}
/** Parse one fixed invalid-claim diagnosis without admitting free-form text. */
export function invalidReason(value) {
    if (typeof value !== 'string'
        || !TASK_CONTINUATION_INVALID_REASONS.includes(value)) {
        throw new TaskContinuationInputError('task continuation invalid reason is unsupported');
    }
    return value;
}
/** Parse the exact fields shared by live and cold reservations. */
export function createRequest(value) {
    const record = exactRecord(value, [
        'callerId', 'expiresAtMs', 'mutationId', 'needDigest', 'originalMessageId', 'sessionId',
        'taskRevision', 'verificationPayloadDigest', 'verifierId',
    ], 'task continuation request');
    return Object.freeze({
        callerId: kebab(record['callerId'], 'continuation caller id'),
        mutationId: safeId(record['mutationId'], 'continuation mutation id'),
        sessionId: boundedIdentity(record['sessionId'], 'continuation session id'),
        originalMessageId: boundedIdentity(record['originalMessageId'], 'continuation original message id'),
        needDigest: digest(record['needDigest'], 'continuation need digest'),
        taskRevision: safeId(record['taskRevision'], 'continuation task revision'),
        verifierId: kebab(record['verifierId'], 'continuation verifier id'),
        verificationPayloadDigest: digest(record['verificationPayloadDigest'], 'continuation verification payload digest'),
        expiresAtMs: epoch(record['expiresAtMs'], 'continuation expiry'),
    });
}
/** Parse a cold-safe reservation including its restricted Agent route. */
export function reserveRequest(value) {
    const record = exactRecord(value, [
        'callerId', 'expiresAtMs', 'mutationId', 'needDigest', 'originalMessageId', 'resumeAgentOptions',
        'sessionId', 'taskRevision', 'verificationPayloadDigest', 'verifierId',
    ], 'task continuation reservation');
    const base = createRequest(Object.fromEntries(Object.entries(record)
        .filter(([key]) => key !== 'resumeAgentOptions')));
    return Object.freeze({ ...base, resumeAgentOptions: agentOptions(record['resumeAgentOptions']) });
}
/** Parse optional exact list filters. */
export function listRequest(value = {}) {
    const record = exactRecord(value, Object.keys(recordValue(value, 'task continuation list')).sort(), 'task continuation list');
    if (Object.keys(record).some(key => !['callerId', 'mutationId', 'sessionId'].includes(key))) {
        throw new TaskContinuationInputError('task continuation list contains unsupported fields');
    }
    const callerId = record['callerId'] === undefined ? undefined : kebab(record['callerId'], 'continuation caller id');
    const mutationId = record['mutationId'] === undefined ? undefined : safeId(record['mutationId'], 'continuation mutation id');
    if (mutationId !== undefined && callerId === undefined) {
        throw new TaskContinuationInputError('task continuation mutation filter requires callerId');
    }
    return Object.freeze({
        ...(record['sessionId'] === undefined ? {} : { sessionId: boundedIdentity(record['sessionId'], 'continuation session id') }),
        ...(callerId === undefined ? {} : { callerId }),
        ...(mutationId === undefined ? {} : { mutationId }),
    });
}
/** Parse an exact cancel fence. */
export function continuationRef(value) {
    const record = exactRecord(value, ['id', 'sessionId', 'taskRevision'], 'task continuation ref');
    return Object.freeze({
        id: uuid(record['id'], 'continuation id'),
        sessionId: boundedIdentity(record['sessionId'], 'continuation session id'),
        taskRevision: safeId(record['taskRevision'], 'continuation task revision'),
    });
}
/** Parse an exact supersede fence and replacement revision. */
export function supersedeRequest(value) {
    const record = exactRecord(value, ['id', 'replacementTaskRevision', 'sessionId', 'taskRevision'], 'task continuation supersede');
    return Object.freeze({
        id: uuid(record['id'], 'continuation id'),
        sessionId: boundedIdentity(record['sessionId'], 'continuation session id'),
        taskRevision: safeId(record['taskRevision'], 'continuation task revision'),
        replacementTaskRevision: safeId(record['replacementTaskRevision'], 'continuation replacement task revision'),
    });
}
/** Validate and snapshot a bounded cold-resume route. */
export function agentOptions(value) {
    const record = recordValue(value, 'task continuation Agent options');
    if (Object.keys(record).some(key => !['maxTokens', 'model', 'provider'].includes(key))) {
        throw new TaskContinuationInputError('task continuation Agent options contain unsupported fields');
    }
    const output = {};
    for (const key of ['provider', 'model']) {
        const field = record[key];
        if (field === undefined)
            continue;
        if (typeof field !== 'string' || field === '' || Buffer.byteLength(field, 'utf8') > MAX_ROUTE_BYTES) {
            throw new TaskContinuationInputError(`task continuation Agent ${key} must be 1-${String(MAX_ROUTE_BYTES)} UTF-8 bytes`);
        }
        ;
        output[key] = field;
    }
    const maxTokens = record['maxTokens'];
    if (maxTokens !== undefined) {
        if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > MAX_RESUME_TOKENS) {
            throw new TaskContinuationInputError(`task continuation Agent maxTokens must be 1-${String(MAX_RESUME_TOKENS)}`);
        }
        ;
        output.maxTokens = maxTokens;
    }
    return Object.freeze(output);
}
/** Parse an unknown live Agent at the official same-process boundary. */
export function continuationAgent(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TaskContinuationInputError('task continuation requires an official live Agent');
    }
    const record = value;
    const session = record['session'];
    if (typeof record['id'] !== 'string' || typeof session !== 'object' || session === null || Array.isArray(session)
        || !Array.isArray(session['events']) || typeof record['followup'] !== 'function'
        || typeof record['whenIdle'] !== 'function') {
        throw new TaskContinuationInputError('task continuation requires an official live Agent');
    }
    return value;
}
/** Create the ordinary plugin-sourced follow-up without original task text. */
export function continuationMessage(claim) {
    return Object.freeze({
        id: claim.dispatchMessageId,
        role: 'user',
        content: Object.freeze([Object.freeze({ type: 'text', text: TASK_CONTINUATION_PROMPT })]),
        source: Object.freeze({ kind: 'plugin', plugin: 'dsh-plugin-extension-center' }),
    });
}
/** Compare a message to the one canonical dispatch identity and content. */
export function isContinuationMessage(value, claim) {
    if (!isRecord(value) || value['id'] !== claim.dispatchMessageId || value['role'] !== 'user'
        || !Array.isArray(value['content']) || value['content'].length !== 1 || !isRecord(value['content'][0])
        || value['content'][0]['type'] !== 'text' || value['content'][0]['text'] !== TASK_CONTINUATION_PROMPT
        || !isRecord(value['source']))
        return false;
    return value['source']['kind'] === 'plugin' && value['source']['plugin'] === 'dsh-plugin-extension-center';
}
/** Require a fully echoed positive verifier result. */
export function readyDecision(value, claim) {
    if (isRecord(value) && value['kind'] === 'not-ready' && Object.keys(value).length === 1)
        return 'not-ready';
    if (!isRecord(value) || value['kind'] !== 'ready')
        return 'invalid';
    const expected = {
        kind: 'ready',
        continuationId: claim.continuationId,
        sessionId: claim.sessionId,
        originalMessageId: claim.originalMessageId,
        needDigest: claim.needDigest,
        taskRevision: claim.taskRevision,
        verificationPayloadDigest: claim.verificationPayloadDigest,
    };
    if (Object.keys(value).sort().join('\0') !== Object.keys(expected).sort().join('\0'))
        return 'invalid';
    for (const [key, field] of Object.entries(expected)) {
        if (value[key] !== field)
            return 'invalid';
    }
    return expected;
}
/** Compare restricted routes without depending on object key order. */
export function sameAgentOptions(left, right) {
    return left.provider === right.provider && left.model === right.model && left.maxTokens === right.maxTokens;
}
/** Compare one existing claim with an idempotent replay. */
export function assertSameReservation(existing, request, options) {
    if (existing.callerId !== request.callerId || existing.mutationId !== request.mutationId
        || existing.sessionId !== request.sessionId || existing.originalMessageId !== request.originalMessageId
        || existing.needDigest !== request.needDigest || existing.taskRevision !== request.taskRevision
        || existing.verifierId !== request.verifierId
        || existing.verificationPayloadDigest !== request.verificationPayloadDigest
        || existing.expiresAtMs !== request.expiresAtMs || !sameAgentOptions(existing.resumeAgentOptions, options)) {
        throw new TaskContinuationMutationConflictError(existing.callerId, existing.mutationId);
    }
}
/** Validate one database or API continuation identity. */
export function continuationId(value) {
    return uuid(value, 'continuation id');
}
/** Validate one database state-machine revision. */
export function taskRevision(value) {
    return safeId(value, 'continuation task revision');
}
function exactRecord(value, keys, label) {
    const record = recordValue(value, label);
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new TaskContinuationInputError(`${label} has unexpected fields`);
    }
    return record;
}
function recordValue(value, label) {
    if (!isRecord(value))
        throw new TaskContinuationInputError(`${label} must be a plain object`);
    return value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function boundedIdentity(value, label) {
    if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > 512) {
        throw new TaskContinuationInputError(`${label} must be 1-512 UTF-8 bytes`);
    }
    return value;
}
function safeId(value, label) {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) {
        throw new TaskContinuationInputError(`${label} must be a 1-128 safe identifier`);
    }
    return value;
}
function kebab(value, label) {
    if (typeof value !== 'string' || value.length > 128 || !KEBAB.test(value)) {
        throw new TaskContinuationInputError(`${label} must be 1-128 lower-kebab characters`);
    }
    return value;
}
function digest(value, label) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw new TaskContinuationInputError(`${label} must use canonical lower-case SHA-256 syntax`);
    }
    return value;
}
function uuid(value, label) {
    if (typeof value !== 'string' || !UUID.test(value))
        throw new TaskContinuationInputError(`${label} must be a UUID`);
    return value;
}
function epoch(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TaskContinuationInputError(`${label} must be a non-negative epoch-millisecond integer`);
    }
    return value;
}
//# sourceMappingURL=codec.js.map
