/** Exact bundled pnpm identity emitted by the current writable generation. */
export declare const CURRENT_PNPM_EXECUTION_IDENTITY: Readonly<{
    readonly packageVersion: "11.21.0";
    readonly registryIntegrity: "sha512-UhcFvOaJkk6scvWjWHEi82JonvZXHlW6gAdv1jfBETLs/62ib61Op5xIW/3b/T1aKlsFgFp36JPeceyKbMo7sQ==";
}>;
/** Retired pnpm identity accepted only while reading rc.0 durable history. */
export declare const RETIRED_PNPM_EXECUTION_IDENTITY: Readonly<{
    readonly packageVersion: "11.7.0";
    readonly registryIntegrity: "sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==";
}>;
/** Current writable pnpm version and registry-integrity pair. */
export type CurrentPnpmExecutionIdentity = typeof CURRENT_PNPM_EXECUTION_IDENTITY;
/** Retired read-only pnpm version and registry-integrity pair. */
export type RetiredPnpmExecutionIdentity = typeof RETIRED_PNPM_EXECUTION_IDENTITY;
/** Every exact pnpm identity that durable readers can decode. */
export type ReadablePnpmExecutionIdentity = CurrentPnpmExecutionIdentity | RetiredPnpmExecutionIdentity;
/**
 * Test whether a version and SRI name the current writable pnpm runtime.
 * @param value Candidate package identity.
 * @returns Whether both fields equal the current pinned pair.
 */
export declare function isCurrentPnpmExecutionIdentity(value: Readonly<{
    packageVersion: unknown;
    registryIntegrity: unknown;
}>): value is CurrentPnpmExecutionIdentity;
/**
 * Test whether a version and SRI name one exact current or retired durable identity.
 * @param value Candidate package identity.
 * @returns Whether the fields equal one recognized pair without mixing generations.
 */
export declare function isReadablePnpmExecutionIdentity(value: Readonly<{
    packageVersion: unknown;
    registryIntegrity: unknown;
}>): value is ReadablePnpmExecutionIdentity;
//# sourceMappingURL=pnpm-runtime.d.ts.map
