import { failDomain } from "./errors.js";
import { isArtifactIntegrity, isSha256Digest } from "./json.js";
/**
 * Decode a plain object containing exactly the expected fields.
 *
 * @param value Candidate object.
 * @param fields Exact field list.
 * @param path Diagnostic path.
 * @returns Strict record view.
 */
export function readStrictRecord(value, fields, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        failDomain('invalid-data', `${path} must be an object`);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        failDomain('invalid-data', `${path} must be a plain object`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key === 'symbol'))
        failDomain('invalid-data', `${path} contains a symbol field`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of ownKeys) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
            failDomain('invalid-data', `${path}.${key} must be an enumerable data field`);
        }
    }
    const actual = ownKeys.sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
        failDomain('invalid-data', `${path} fields must be exactly ${expected.join(', ')}`);
    }
    return value;
}
/**
 * Decode a bounded non-empty string without control characters.
 *
 * @param value Candidate string.
 * @param path Diagnostic path.
 * @param maximumLength Maximum accepted length.
 * @returns Validated string.
 */
export function readBoundedString(value, path, maximumLength = 512) {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > maximumLength
        || value.trim() !== value
        || /[\u0000-\u001f\u007f]/.test(value)) {
        failDomain('invalid-data', `${path} must be a bounded non-empty string`);
    }
    return value;
}
/**
 * Decode a non-negative safe integer.
 *
 * @param value Candidate integer.
 * @param path Diagnostic path.
 * @returns Validated integer.
 */
export function readNonNegativeInteger(value, path) {
    if (!Number.isSafeInteger(value) || value < 0) {
        failDomain('invalid-data', `${path} must be a non-negative safe integer`);
    }
    return value;
}
/**
 * Decode one literal from a closed set.
 *
 * @param value Candidate literal.
 * @param values Accepted literals.
 * @param path Diagnostic path.
 * @returns Validated literal.
 */
export function readLiteral(value, values, path) {
    if (typeof value !== 'string' || !values.includes(value)) {
        failDomain('invalid-data', `${path} is not an accepted value`);
    }
    return value;
}
/**
 * Decode a lowercase SHA-256 digest.
 *
 * @param value Candidate digest.
 * @param path Diagnostic path.
 * @returns Validated digest.
 */
export function readSha256Digest(value, path) {
    if (!isSha256Digest(value))
        failDomain('invalid-data', `${path} must be a lowercase SHA-256 digest`);
    return value;
}
/**
 * Decode an integrity-pinned artifact digest.
 *
 * @param value Candidate integrity value.
 * @param path Diagnostic path.
 * @returns Validated integrity value.
 */
export function readArtifactIntegrity(value, path) {
    if (!isArtifactIntegrity(value))
        failDomain('invalid-data', `${path} must be a pinned artifact integrity`);
    return value;
}
/**
 * Decode null or a lowercase SHA-256 digest.
 *
 * @param value Candidate nullable digest.
 * @param path Diagnostic path.
 * @returns Validated nullable digest.
 */
export function readNullableSha256Digest(value, path) {
    return value === null ? null : readSha256Digest(value, path);
}
//# sourceMappingURL=codec.js.map
