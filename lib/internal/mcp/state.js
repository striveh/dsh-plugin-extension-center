import { canonicalJson, canonicalSha256, immutableJsonClone, isSha256Digest } from "../../domain/index.js";
import { parseCenterMcpConnectionDesired } from "./types.js";
/** Create an empty mutable state. */
export function emptyCenterMcpState() {
    return { schemaVersion: 1, revision: 0, connections: [], removed: [], mutations: [] };
}
/** Clone one validated state for mutation. */
export function cloneCenterMcpState(value) {
    return JSON.parse(canonicalJson(value));
}
/** Canonically sort all identity-indexed records before persistence. */
export function normalizeCenterMcpState(value) {
    value.connections.sort((left, right) => left.desired.id.localeCompare(right.desired.id));
    value.removed.sort((left, right) => left.desired.id.localeCompare(right.desired.id));
}
/** Create the checksummed durable envelope. */
export function envelopeForCenterMcpState(value) {
    normalizeCenterMcpState(value);
    return { schemaVersion: 1, state: value, digest: canonicalSha256(value) };
}
/** Parse and verify a durable envelope. */
export function parseCenterMcpEnvelope(value) {
    const envelope = exactObject(value, ['schemaVersion', 'state', 'digest'], '$');
    if (envelope.schemaVersion !== 1)
        throw new Error('Center MCP state envelope version is unsupported');
    if (!isSha256Digest(envelope.digest))
        throw new Error('Center MCP state envelope digest is invalid');
    const state = parseState(envelope.state);
    if (canonicalSha256(state) !== envelope.digest)
        throw new Error('Center MCP state envelope digest does not match its state');
    return state;
}
/** Return a recursively frozen detached public value. */
export function immutableCenterMcpValue(value) {
    return immutableJsonClone(value);
}
function parseState(value) {
    const object = exactObject(value, ['schemaVersion', 'revision', 'connections', 'removed', 'mutations'], '$.state');
    if (object.schemaVersion !== 1)
        throw new Error('Center MCP desired-state version is unsupported');
    const revision = integer(object.revision, '$.state.revision', 0);
    const connections = array(object.connections, '$.state.connections').map((entry, index) => {
        const record = exactObject(entry, ['desired', 'revision'], `$.state.connections[${String(index)}]`);
        return {
            desired: parseCenterMcpConnectionDesired(record.desired, `$.state.connections[${String(index)}].desired`),
            revision: integer(record.revision, `$.state.connections[${String(index)}].revision`, 1),
        };
    });
    const removed = array(object.removed, '$.state.removed').map((entry, index) => {
        const record = exactObject(entry, ['desired', 'revision', 'removedAtRevision'], `$.state.removed[${String(index)}]`);
        return {
            desired: parseCenterMcpConnectionDesired(record.desired, `$.state.removed[${String(index)}].desired`),
            revision: integer(record.revision, `$.state.removed[${String(index)}].revision`, 1),
            removedAtRevision: integer(record.removedAtRevision, `$.state.removed[${String(index)}].removedAtRevision`, 1),
        };
    });
    const mutations = array(object.mutations, '$.state.mutations').map((entry, index) => parseMutation(entry, index));
    const ids = new Set();
    for (const record of [...connections, ...removed]) {
        if (ids.has(record.desired.id))
            throw new Error(`Center MCP state contains duplicate connection "${record.desired.id}"`);
        ids.add(record.desired.id);
        if (record.revision > revision)
            throw new Error(`Center MCP connection "${record.desired.id}" exceeds the global revision`);
    }
    for (const record of removed) {
        if (record.removedAtRevision > revision)
            throw new Error(`Center MCP removal "${record.desired.id}" exceeds the global revision`);
    }
    const mutationIds = new Set();
    for (const mutation of mutations) {
        if (mutationIds.has(mutation.mutationId))
            throw new Error(`Center MCP state contains duplicate mutation "${mutation.mutationId}"`);
        mutationIds.add(mutation.mutationId);
        if (mutation.receipt.snapshotRevision > revision)
            throw new Error(`Center MCP mutation "${mutation.mutationId}" exceeds the global revision`);
    }
    return { schemaVersion: 1, revision, connections, removed, mutations };
}
function parseMutation(value, index) {
    const path = `$.state.mutations[${String(index)}]`;
    const object = exactObject(value, ['mutationId', 'requestDigest', 'receipt'], path);
    if (typeof object.mutationId !== 'string')
        throw new TypeError(`${path}.mutationId must be a string`);
    if (!isSha256Digest(object.requestDigest))
        throw new TypeError(`${path}.requestDigest must be a SHA-256 digest`);
    const receipt = parseReceipt(object.receipt, `${path}.receipt`);
    if (receipt.mutationId !== object.mutationId)
        throw new Error(`${path}.receipt mutation id does not match its entry`);
    return { mutationId: object.mutationId, requestDigest: object.requestDigest, receipt };
}
function parseReceipt(value, path) {
    if (!isPlainObject(value))
        throw new TypeError(`${path} must be an object`);
    const hasPrevious = Object.hasOwn(value, 'previousRevision');
    const object = exactObject(value, hasPrevious
        ? ['mutationId', 'operation', 'id', 'previousRevision', 'revision', 'snapshotRevision', 'changed', 'desiredDigest']
        : ['mutationId', 'operation', 'id', 'revision', 'snapshotRevision', 'changed', 'desiredDigest'], path);
    if (typeof object.mutationId !== 'string' || typeof object.id !== 'string') {
        throw new TypeError(`${path} has invalid identity fields`);
    }
    if (!isOperation(object.operation))
        throw new TypeError(`${path}.operation is unsupported`);
    if (typeof object.changed !== 'boolean')
        throw new TypeError(`${path}.changed must be a boolean`);
    if (object.desiredDigest !== null && !isSha256Digest(object.desiredDigest)) {
        throw new TypeError(`${path}.desiredDigest must be a SHA-256 digest or null`);
    }
    if ((object.operation === 'purge') !== (object.desiredDigest === null)) {
        throw new TypeError(`${path}.desiredDigest must be null exactly for purge`);
    }
    return {
        mutationId: object.mutationId,
        operation: object.operation,
        id: object.id,
        ...hasPrevious ? { previousRevision: integer(object.previousRevision, `${path}.previousRevision`, 1) } : {},
        revision: integer(object.revision, `${path}.revision`, 1),
        snapshotRevision: integer(object.snapshotRevision, `${path}.snapshotRevision`, 1),
        changed: object.changed,
        desiredDigest: object.desiredDigest,
    };
}
function isOperation(value) {
    return value === 'configure' || value === 'enable' || value === 'disable' || value === 'update'
        || value === 'remove' || value === 'restore' || value === 'purge';
}
function exactObject(value, keys, path) {
    if (!isPlainObject(value))
        throw new TypeError(`${path} must be an object`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new TypeError(`${path} contains unsupported or missing fields`);
    }
    return value;
}
function isPlainObject(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function array(value, path) {
    if (!Array.isArray(value))
        throw new TypeError(`${path} must be an array`);
    return value;
}
function integer(value, path, minimum) {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new TypeError(`${path} must be an integer at least ${String(minimum)}`);
    }
    return value;
}
//# sourceMappingURL=state.js.map
