/** Exact bundled pnpm identity emitted by the current writable generation. */
export const CURRENT_PNPM_EXECUTION_IDENTITY = Object.freeze({
  packageVersion: '11.21.0',
  registryIntegrity: 'sha512-UhcFvOaJkk6scvWjWHEi82JonvZXHlW6gAdv1jfBETLs/62ib61Op5xIW/3b/T1aKlsFgFp36JPeceyKbMo7sQ==',
} as const)

/** Retired pnpm identity accepted only while reading rc.0 durable history. */
export const RETIRED_PNPM_EXECUTION_IDENTITY = Object.freeze({
  packageVersion: '11.7.0',
  registryIntegrity: 'sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==',
} as const)

/** Current writable pnpm version and registry-integrity pair. */
export type CurrentPnpmExecutionIdentity = typeof CURRENT_PNPM_EXECUTION_IDENTITY

/** Retired read-only pnpm version and registry-integrity pair. */
export type RetiredPnpmExecutionIdentity = typeof RETIRED_PNPM_EXECUTION_IDENTITY

/** Every exact pnpm identity that durable readers can decode. */
export type ReadablePnpmExecutionIdentity = CurrentPnpmExecutionIdentity | RetiredPnpmExecutionIdentity

/**
 * Test whether a version and SRI name the current writable pnpm runtime.
 * @param value Candidate package identity.
 * @returns Whether both fields equal the current pinned pair.
 */
export function isCurrentPnpmExecutionIdentity(
  value: Readonly<{ packageVersion: unknown; registryIntegrity: unknown }>,
): value is CurrentPnpmExecutionIdentity {
  return value.packageVersion === CURRENT_PNPM_EXECUTION_IDENTITY.packageVersion
    && value.registryIntegrity === CURRENT_PNPM_EXECUTION_IDENTITY.registryIntegrity
}

/**
 * Test whether a version and SRI name one exact current or retired durable identity.
 * @param value Candidate package identity.
 * @returns Whether the fields equal one recognized pair without mixing generations.
 */
export function isReadablePnpmExecutionIdentity(
  value: Readonly<{ packageVersion: unknown; registryIntegrity: unknown }>,
): value is ReadablePnpmExecutionIdentity {
  return isCurrentPnpmExecutionIdentity(value)
    || value.packageVersion === RETIRED_PNPM_EXECUTION_IDENTITY.packageVersion
      && value.registryIntegrity === RETIRED_PNPM_EXECUTION_IDENTITY.registryIntegrity
}
