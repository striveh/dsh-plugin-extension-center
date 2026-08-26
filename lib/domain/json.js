import { createHash } from 'node:crypto';
import { failDomain } from "./errors.js";
function canonicalize(value, path, ancestors) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            failDomain('invalid-data', `${path} contains a non-finite number`);
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        if (ancestors.has(value))
            failDomain('invalid-data', `${path} contains a cycle`);
        const ownKeys = Reflect.ownKeys(value);
        const permittedKeys = new Set(['length', ...value.map((_, index) => String(index))]);
        if (ownKeys.some(key => !permittedKeys.has(key)) || Object.keys(value).length !== value.length) {
            failDomain('invalid-data', `${path} must be a dense JSON array without custom properties`);
        }
        ancestors.add(value);
        try {
            return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`, ancestors)).join(',')}]`;
        }
        finally {
            ancestors.delete(value);
        }
    }
    if (typeof value === 'object') {
        const object = value;
        const prototype = Object.getPrototypeOf(object);
        if (prototype !== Object.prototype && prototype !== null) {
            failDomain('invalid-data', `${path} must be a plain JSON object`);
        }
        if (ancestors.has(object))
            failDomain('invalid-data', `${path} contains a cycle`);
        const ownKeys = Reflect.ownKeys(object);
        if (ownKeys.some(key => typeof key === 'symbol')) {
            failDomain('invalid-data', `${path} contains a symbol key`);
        }
        const propertyNames = ownKeys;
        const descriptors = Object.getOwnPropertyDescriptors(object);
        for (const key of propertyNames) {
            const descriptor = descriptors[key];
            if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
                failDomain('invalid-data', `${path}.${key} must be an enumerable data property`);
            }
            if (descriptor.value === undefined)
                failDomain('invalid-data', `${path}.${key} is undefined`);
        }
        ancestors.add(object);
        try {
            return `{${propertyNames.sort().map((key) => {
                const descriptor = descriptors[key];
                return `${JSON.stringify(key)}:${canonicalize(descriptor.value, `${path}.${key}`, ancestors)}`;
            }).join(',')}}`;
        }
        finally {
            ancestors.delete(object);
        }
    }
    failDomain('invalid-data', `${path} contains unsupported ${typeof value}`);
}
/**
 * Serialize strict JSON with lexicographically sorted object keys.
 *
 * @param value Candidate JSON value.
 * @returns Deterministic JSON text.
 */
export function canonicalJson(value) {
    return canonicalize(value, '$', new Set());
}
/**
 * Hash strict JSON after canonical serialization.
 *
 * @param value Candidate JSON value.
 * @returns Lowercase SHA-256 digest.
 */
export function canonicalSha256(value) {
    return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
function freezeRecursively(value) {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value))
            freezeRecursively(child);
        Object.freeze(value);
    }
    return value;
}
/**
 * Clone strict JSON into a recursively frozen value.
 *
 * @param value Candidate JSON value.
 * @returns Canonically ordered immutable clone.
 */
export function immutableJsonClone(value) {
    const clone = JSON.parse(canonicalJson(value));
    return freezeRecursively(clone);
}
/**
 * Check whether a value is a lowercase SHA-256 digest.
 *
 * @param value Candidate digest.
 * @returns Whether the value is a SHA-256 digest.
 */
export function isSha256Digest(value) {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
/**
 * Check whether a value is an accepted artifact integrity digest.
 *
 * @param value Candidate integrity value.
 * @returns Whether the value is an accepted integrity digest.
 */
export function isArtifactIntegrity(value) {
    if (typeof value !== 'string')
        return false;
    if (/^sha256:[0-9a-f]{64}$/.test(value) || /^sha512:[0-9a-f]{128}$/.test(value))
        return true;
    const sri = /^sha512:([A-Za-z0-9+/]{86}==)$/.exec(value);
    if (sri === null)
        return false;
    const encoded = sri[1];
    const decoded = Buffer.from(encoded, 'base64');
    return decoded.length === 64 && decoded.toString('base64') === encoded;
}
//# sourceMappingURL=json.js.map
