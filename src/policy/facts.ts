import type { CatalogEntry } from '../catalog-contract.ts'
import { catalogReviewEvidenceSupport } from '../catalog.ts'
import { canonicalSha256, type Sha256Digest } from '../domain/index.ts'
import type { DesiredState, OperationKind } from '../plans/index.ts'

type PermissionKey = `${CatalogEntry['permissions'][number]['phase']}/${CatalogEntry['permissions'][number]['kind']}`

const REQUIRED_PERMISSION_ROWS: Readonly<Record<CatalogEntry['kind'], readonly PermissionKey[]>> = {
  plugin: [
    'acquisition/network', 'acquisition/filesystem', 'acquisition/subprocess', 'acquisition/credentials',
    'runtime/network', 'runtime/filesystem', 'runtime/subprocess', 'runtime/credentials', 'runtime/model-context',
  ],
  mcp: ['acquisition/network', 'runtime/filesystem', 'runtime/subprocess', 'runtime/credentials'],
  skill: ['acquisition/network', 'runtime/model-context', 'runtime/subprocess'],
}

const ACTIVE_VERIFICATION_STEPS: Readonly<Record<CatalogEntry['kind'], readonly string[]>> = {
  plugin: ['profile-generation', 'external-boot-ack', 'loader-consumer', 'active-generation'],
  mcp: ['runtime-binding', 'desired-observed-state', 'mcp-handshake', 'qualified-tool-generation'],
  skill: ['artifact-rehash', 'complete-scope-snapshot', 'winning-provider', 'winning-path-and-invocation'],
}

/** Platform key used by both Store and task admission. */
export function currentHostPlatform(): 'darwin' | 'linux' | 'windows' | 'unsupported' {
  if (process.platform === 'darwin' || process.platform === 'linux') return process.platform
  if (process.platform === 'win32') return 'windows'
  return 'unsupported'
}

/** Derive catalog facts instead of accepting optimistic booleans from either product entrance. */
export function candidateAdmissionFacts(entry: CatalogEntry, operationKind: OperationKind): Readonly<{
  completeLifecycle: boolean
  authorityKnown: boolean
  lifecycleScriptControl: 'not-applicable' | 'inspect-before-mutation'
  reviewEvidenceAvailable: boolean
  verificationRecipeComplete: boolean
}> {
  const permissionRows = entry.permissions.map(permission => `${permission.phase}/${permission.kind}` as PermissionKey)
  const uniqueRows = new Set(permissionRows)
  const authorityKnown = uniqueRows.size === permissionRows.length
    && REQUIRED_PERMISSION_ROWS[entry.kind].every(row => uniqueRows.has(row))
  const downloadsPluginPackage = entry.kind === 'plugin' && ['install', 'update'].includes(operationKind)
  return Object.freeze({
    completeLifecycle: Object.values(entry.lifecycle).every(action => action.status === 'available'),
    authorityKnown,
    lifecycleScriptControl: downloadsPluginPackage ? 'inspect-before-mutation' : 'not-applicable',
    reviewEvidenceAvailable: catalogReviewEvidenceSupport(entry) !== 'unavailable',
    verificationRecipeComplete: ACTIVE_VERIFICATION_STEPS[entry.kind].length > 0,
  })
}

/** Digest of the owner-specific observation recipe enforced by the selected provider implementation. */
export function verificationRecipeDigest(
  kind: CatalogEntry['kind'],
  operationKind: OperationKind,
  desiredState: DesiredState,
): Sha256Digest {
  const steps = desiredState === 'removed'
    ? [`${kind}-owner-absence`, 'center-inventory-absence']
    : ACTIVE_VERIFICATION_STEPS[kind]
  return canonicalSha256({ recipeRevision: 1, kind, operationKind, desiredState, steps })
}
