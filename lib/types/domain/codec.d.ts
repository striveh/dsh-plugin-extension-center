import { type ArtifactIntegrity, type Sha256Digest } from './json.ts';
/**
 * Decode a plain object containing exactly the expected fields.
 *
 * @param value Candidate object.
 * @param fields Exact field list.
 * @param path Diagnostic path.
 * @returns Strict record view.
 */
export declare function readStrictRecord(value: unknown, fields: readonly string[], path: string): Readonly<Record<string, unknown>>;
/**
 * Decode a bounded non-empty string without control characters.
 *
 * @param value Candidate string.
 * @param path Diagnostic path.
 * @param maximumLength Maximum accepted length.
 * @returns Validated string.
 */
export declare function readBoundedString(value: unknown, path: string, maximumLength?: number): string;
/**
 * Decode a non-negative safe integer.
 *
 * @param value Candidate integer.
 * @param path Diagnostic path.
 * @returns Validated integer.
 */
export declare function readNonNegativeInteger(value: unknown, path: string): number;
/**
 * Decode one literal from a closed set.
 *
 * @param value Candidate literal.
 * @param values Accepted literals.
 * @param path Diagnostic path.
 * @returns Validated literal.
 */
export declare function readLiteral<T extends string>(value: unknown, values: readonly T[], path: string): T;
/**
 * Decode a lowercase SHA-256 digest.
 *
 * @param value Candidate digest.
 * @param path Diagnostic path.
 * @returns Validated digest.
 */
export declare function readSha256Digest(value: unknown, path: string): Sha256Digest;
/**
 * Decode an integrity-pinned artifact digest.
 *
 * @param value Candidate integrity value.
 * @param path Diagnostic path.
 * @returns Validated integrity value.
 */
export declare function readArtifactIntegrity(value: unknown, path: string): ArtifactIntegrity;
/**
 * Decode null or a lowercase SHA-256 digest.
 *
 * @param value Candidate nullable digest.
 * @param path Diagnostic path.
 * @returns Validated nullable digest.
 */
export declare function readNullableSha256Digest(value: unknown, path: string): Sha256Digest | null;
//# sourceMappingURL=codec.d.ts.map
