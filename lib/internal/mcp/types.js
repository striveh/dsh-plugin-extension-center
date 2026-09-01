/** Center-owned managed MCP connection records and mutation API. */
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MUTATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** A desired record changed after the caller read it. */
export class CenterMcpConnectionConflictError extends Error {
    id;
    expected;
    actual;
    code = 'MCP_CONNECTION_CONFLICT';
    constructor(id, expected, actual) {
        super(`MCP connection "${id}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`);
        this.id = id;
        this.expected = expected;
        this.actual = actual;
        this.name = 'CenterMcpConnectionConflictError';
    }
}
/** A mutation addressed an absent active or removed record. */
export class CenterMcpConnectionNotFoundError extends Error {
    code = 'MCP_CONNECTION_NOT_FOUND';
    constructor(id, inventory) {
        super(`MCP connection "${id}" does not exist in the ${inventory} inventory`);
        this.name = 'CenterMcpConnectionNotFoundError';
    }
}
/** One idempotency key was reused with different request fields. */
export class CenterMcpConnectionIdempotencyError extends Error {
    code = 'MCP_CONNECTION_IDEMPOTENCY_MISMATCH';
    constructor(mutationId) {
        super(`MCP connection mutation id "${mutationId}" was already used for a different request`);
        this.name = 'CenterMcpConnectionIdempotencyError';
    }
}
/** The official MCP Client does not expose a redirect-forbidden HTTP policy. */
export class CenterMcpHttpUnsupportedError extends Error {
    code = 'MCP_HTTP_REDIRECT_GUARD_UNAVAILABLE';
    constructor() {
        super('Streamable HTTP MCP is unavailable because the official MCP Client cannot enforce the required redirect-forbidden policy');
        this.name = 'CenterMcpHttpUnsupportedError';
    }
}
/** Parse and detach a complete desired record at the wire or durable boundary. */
export function parseCenterMcpConnectionDesired(value, path = '$') {
    const object = exactObject(value, ['id', 'enabled', 'transport'], path);
    const id = connectionId(object.id, `${path}.id`);
    if (typeof object.enabled !== 'boolean')
        throw new TypeError(`${path}.enabled must be a boolean`);
    return deepFreeze({ id, enabled: object.enabled, transport: parseCenterMcpTransport(object.transport, `${path}.transport`) });
}
/** Parse and detach one complete resolved transport. */
export function parseCenterMcpTransport(value, path = '$') {
    if (!isPlainObject(value))
        throw new TypeError(`${path} must be an object`);
    if (value.transport === 'stdio') {
        const object = exactObject(value, ['transport', 'command', 'args', 'env', 'cwd', 'toolCallTimeoutMs', 'reconnect'], path);
        const command = nonEmptyString(object.command, `${path}.command`);
        const cwd = stringValue(object.cwd, `${path}.cwd`);
        rejectNul(command, `${path}.command`);
        rejectNul(cwd, `${path}.cwd`);
        return deepFreeze({
            transport: 'stdio',
            command,
            args: stringArray(object.args, `${path}.args`),
            env: stringRecord(object.env, `${path}.env`),
            cwd,
            toolCallTimeoutMs: positiveInteger(object.toolCallTimeoutMs, `${path}.toolCallTimeoutMs`),
            reconnect: parseReconnect(object.reconnect, `${path}.reconnect`),
        });
    }
    if (value.transport === 'streamable-http') {
        const object = exactObject(value, ['transport', 'url', 'headers', 'redirect', 'toolCallTimeoutMs', 'reconnect'], path);
        const text = nonEmptyString(object.url, `${path}.url`);
        let url;
        try {
            url = new URL(text);
        }
        catch (cause) {
            throw new TypeError(`${path}.url must be an absolute HTTP or HTTPS URL`, { cause });
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new TypeError(`${path}.url must use HTTP or HTTPS`);
        }
        if (object.redirect !== 'error' && object.redirect !== 'follow' && object.redirect !== 'manual') {
            throw new TypeError(`${path}.redirect is invalid`);
        }
        return deepFreeze({
            transport: 'streamable-http',
            url: url.toString(),
            headers: stringRecord(object.headers, `${path}.headers`),
            redirect: object.redirect,
            toolCallTimeoutMs: positiveInteger(object.toolCallTimeoutMs, `${path}.toolCallTimeoutMs`),
            reconnect: parseReconnect(object.reconnect, `${path}.reconnect`),
        });
    }
    throw new TypeError(`${path}.transport must be "stdio" or "streamable-http"`);
}
/** Parse common mutation fields without accepting surplus authority. */
export function parseCenterMcpMutationRequest(value, path = '$') {
    const object = exactObject(value, ['id', 'mutationId', 'expectedRevision'], path);
    return deepFreeze({
        id: connectionId(object.id, `${path}.id`),
        mutationId: mutationId(object.mutationId, `${path}.mutationId`),
        expectedRevision: nonNegativeInteger(object.expectedRevision, `${path}.expectedRevision`),
    });
}
/** Parse a configure request. */
export function parseCenterConfigureMcpRequest(value, path = '$') {
    const object = exactObject(value, ['desired', 'mutationId', 'expectedRevision'], path);
    if (object.expectedRevision !== 0)
        throw new TypeError(`${path}.expectedRevision must be zero`);
    return deepFreeze({
        desired: parseCenterMcpConnectionDesired(object.desired, `${path}.desired`),
        mutationId: mutationId(object.mutationId, `${path}.mutationId`),
        expectedRevision: 0,
    });
}
/** Parse an update request. */
export function parseCenterUpdateMcpRequest(value, path = '$') {
    const object = exactObject(value, ['id', 'mutationId', 'expectedRevision', 'transport'], path);
    return deepFreeze({
        id: connectionId(object.id, `${path}.id`),
        mutationId: mutationId(object.mutationId, `${path}.mutationId`),
        expectedRevision: nonNegativeInteger(object.expectedRevision, `${path}.expectedRevision`),
        transport: parseCenterMcpTransport(object.transport, `${path}.transport`),
    });
}
function parseReconnect(value, path) {
    const object = exactObject(value, ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'], path);
    if (typeof object.enabled !== 'boolean')
        throw new TypeError(`${path}.enabled must be a boolean`);
    const initialDelayMs = positiveInteger(object.initialDelayMs, `${path}.initialDelayMs`);
    const maxDelayMs = positiveInteger(object.maxDelayMs, `${path}.maxDelayMs`);
    if (initialDelayMs > maxDelayMs)
        throw new TypeError(`${path}.initialDelayMs must not exceed maxDelayMs`);
    return deepFreeze({
        enabled: object.enabled,
        initialDelayMs,
        maxDelayMs,
        maxAttempts: positiveInteger(object.maxAttempts, `${path}.maxAttempts`),
    });
}
function connectionId(value, path) {
    if (typeof value !== 'string' || !CONNECTION_ID.test(value)) {
        throw new TypeError(`${path} must match ${String(CONNECTION_ID)}`);
    }
    return value;
}
function mutationId(value, path) {
    if (typeof value !== 'string' || !MUTATION_ID.test(value)) {
        throw new TypeError(`${path} must match ${String(MUTATION_ID)}`);
    }
    return value;
}
function stringArray(value, path) {
    if (!Array.isArray(value))
        throw new TypeError(`${path} must be an array`);
    return value.map((entry, index) => {
        const item = stringValue(entry, `${path}[${String(index)}]`);
        rejectNul(item, `${path}[${String(index)}]`);
        return item;
    });
}
function stringRecord(value, path) {
    if (!isPlainObject(value))
        throw new TypeError(`${path} must be an object`);
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        rejectNul(key, `${path} key`);
        const item = stringValue(entry, `${path}.${key}`);
        rejectNul(item, `${path}.${key}`);
        result[key] = item;
    }
    return result;
}
function nonEmptyString(value, path) {
    const result = stringValue(value, path);
    if (result.length === 0)
        throw new TypeError(`${path} must not be empty`);
    return result;
}
function stringValue(value, path) {
    if (typeof value !== 'string')
        throw new TypeError(`${path} must be a string`);
    return value;
}
function positiveInteger(value, path) {
    const result = nonNegativeInteger(value, path);
    if (result === 0)
        throw new TypeError(`${path} must be positive`);
    return result;
}
function nonNegativeInteger(value, path) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError(`${path} must be a non-negative integer`);
    return value;
}
function rejectNul(value, path) {
    if (value.includes('\0'))
        throw new TypeError(`${path} must not contain NUL`);
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
function deepFreeze(value) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
//# sourceMappingURL=types.js.map
