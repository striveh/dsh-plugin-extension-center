/** A SHA-256 digest over canonical JSON. */
export type Sha256Digest = `sha256:${string}`;
/** An integrity-pinned artifact digest accepted by an immutable plan. */
export type ArtifactIntegrity = `sha256:${string}` | `sha512:${string}`;
/**
 * Serialize strict JSON with lexicographically sorted object keys.
 *
 * @param value Candidate JSON value.
 * @returns Deterministic JSON text.
 */
export declare function canonicalJson(value: unknown): string;
/**
 * Hash strict JSON after canonical serialization.
 *
 * @param value Candidate JSON value.
 * @returns Lowercase SHA-256 digest.
 */
export declare function canonicalSha256(value: unknown): Sha256Digest;
/**
 * Clone strict JSON into a recursively frozen value.
 *
 * @param value Candidate JSON value.
 * @returns Canonically ordered immutable clone.
 */
export declare function immutableJsonClone<T>(value: T): Readonly<T>;
/**
 * Check whether a value is a lowercase SHA-256 digest.
 *
 * @param value Candidate digest.
 * @returns Whether the value is a SHA-256 digest.
 */
export declare function isSha256Digest(value: unknown): value is Sha256Digest;
/**
 * Check whether a value is an accepted artifact integrity digest.
 *
 * @param value Candidate integrity value.
 * @returns Whether the value is an accepted integrity digest.
 */
export declare function isArtifactIntegrity(value: unknown): value is ArtifactIntegrity;
//# sourceMappingURL=json.d.ts.map
