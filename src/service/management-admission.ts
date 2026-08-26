import type { CatalogEntry } from '../catalog-contract.ts'
import { canonicalSha256 } from '../domain/index.ts'
import type { ManagedTargetRecord } from '../host/index.ts'
import type { InventoryRow, InventorySnapshot } from '../inventory/index.ts'
import { POLICY_REVISION, type CandidatePolicyResult } from '../policy/index.ts'
import type { OperationKind } from '../plans/index.ts'

/** Management actions whose authority comes only from current center inventory. */
export type CenterManagementOperation = 'enable' | 'disable' | 'purge'

function denied(reason: string): Extract<CandidatePolicyResult, { status: 'denied' }> {
  return Object.freeze({ status: 'denied', policyRevision: POLICY_REVISION, code: 'action-unavailable', reason })
}

/** Result of exact current-row management admission. */
export type ManagementAdmission =
  | Readonly<{
      status: 'eligible'
      row: InventoryRow
      record: ManagedTargetRecord
      policy: Extract<CandidatePolicyResult, { status: 'eligible' }>
    }>
  | Readonly<{ status: 'denied'; policy: Extract<CandidatePolicyResult, { status: 'denied' }> }>

/** Refuse installation over any currently observed target not exclusively owned by this center. */
export function admitInstallTarget(
  row: InventoryRow | undefined,
  managed: ManagedTargetRecord | undefined,
): Extract<CandidatePolicyResult, { status: 'denied' }> | null {
  if (row === undefined) return managed === undefined ? null : denied('install-target-stale')
  if (row.ownership !== 'center') return denied(`install-target-${row.ownership}-owned`)
  if (managed === undefined || `center:${String(managed.revision)}` !== row.managedRevision) {
    return denied('install-target-stale')
  }
  if (managed.current !== null || row.materialized !== 'absent') return denied('install-target-already-materialized')
  return denied('install-target-retained-use-restore-or-purge')
}

/**
 * Admit enable, disable, or purge only from one exact center-owned current inventory row.
 * Catalog cards cannot supply a target identity and external ownership never becomes writable.
 */
export function admitCenterManagement(input: Readonly<{
  operationKind: OperationKind
  targetKey: string | null
  scopeKey: string
  profileId: string
  candidate: CatalogEntry | undefined
  inventory: InventorySnapshot
  managed: ManagedTargetRecord | undefined
}>): ManagementAdmission {
  if (!['enable', 'disable', 'purge'].includes(input.operationKind)) {
    return Object.freeze({ status: 'denied', policy: denied('management-operation-kind') })
  }
  if (input.targetKey === null) return Object.freeze({ status: 'denied', policy: denied('management-target-required') })
  if (input.inventory.scopeKey !== input.scopeKey || input.inventory.profileId !== input.profileId || !input.inventory.complete) {
    return Object.freeze({ status: 'denied', policy: denied('management-inventory-incomplete') })
  }
  const row = input.inventory.rows.find(item => item.targetKey === input.targetKey)
  if (row === undefined) return Object.freeze({ status: 'denied', policy: denied('management-target-absent') })
  if (row.ownership !== 'center') {
    return Object.freeze({ status: 'denied', policy: denied(`management-owner-${row.ownership}`) })
  }
  if (row.scopeKey !== input.scopeKey || row.profileId !== input.profileId) {
    return Object.freeze({ status: 'denied', policy: denied('management-scope-mismatch') })
  }
  const candidate = input.candidate
  if (candidate === undefined || row.candidateRef !== candidate.candidateRef || row.kind !== candidate.kind) {
    return Object.freeze({ status: 'denied', policy: denied('management-kind-or-candidate-mismatch') })
  }
  const managed = input.managed
  if (managed === undefined
    || managed.targetKey !== row.targetKey
    || managed.kind !== row.kind
    || managed.scopeKey !== row.scopeKey
    || managed.profileId !== row.profileId
    || `center:${String(managed.revision)}` !== row.managedRevision) {
    return Object.freeze({ status: 'denied', policy: denied('management-target-stale') })
  }
  const action = row.actions[input.operationKind as CenterManagementOperation]
  if (action.status !== 'available') {
    return Object.freeze({ status: 'denied', policy: denied(`management-action-${action.status}:${action.reason ?? 'unavailable'}`) })
  }
  const policy = Object.freeze({
    status: 'eligible' as const,
    policyRevision: POLICY_REVISION,
    authorityDigest: canonicalSha256({
      operationKind: input.operationKind,
      targetKey: row.targetKey,
      managedRevision: row.managedRevision,
      ownerRevision: row.ownerRevision,
      inventoryRevision: input.inventory.revision,
      action,
    }),
  })
  return Object.freeze({ status: 'eligible', row, record: managed, policy })
}
