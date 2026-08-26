import { canonicalSha256, immutableJsonClone, type Sha256Digest } from '../domain/index.ts'
import type { ManagedTargetRecord, ManagedVersion } from '../host/index.ts'
import type { ProviderOperationRequest } from './types.ts'

/** Digest only the restorable target state, excluding audit revisions and timestamps. */
export function managedStateDigest(record: ManagedTargetRecord | null): Sha256Digest {
  if (record === null) return canonicalSha256(null)
  return canonicalSha256({
    kind: record.kind,
    extensionId: record.extensionId,
    targetKey: record.targetKey,
    scopeKey: record.scopeKey,
    profileId: record.profileId,
    current: record.current,
    lastGood: record.lastGood,
    removed: record.removed,
    pending: record.pending,
  })
}

/** Derive the next center-owned record for one already-preflighted operation. */
export function nextManagedRecord(
  before: ManagedTargetRecord | null,
  request: ProviderOperationRequest,
  suppliedVersion: ManagedVersion | null,
  nowMs: number,
): ManagedTargetRecord {
  const { plan, authorization } = request
  const operation = plan.operationKind
  if (before !== null && (
    before.kind !== plan.extensionKind
    || before.extensionId !== plan.extensionId
    || before.scopeKey !== plan.scopeKey
    || before.profileId !== plan.profileId
  )) throw new Error('managed target identity does not match the immutable plan')
  let current = before?.current ?? null
  let lastGood = before?.lastGood ?? null
  let removed = before?.removed ?? null
  switch (operation) {
    case 'install':
      if (current !== null || suppliedVersion === null) throw new Error('install requires an absent target and staged material')
      current = suppliedVersion
      removed = null
      break
    case 'configure':
      if (current === null) throw new Error('configure requires installed material')
      lastGood = current
      current = immutableJsonClone({ ...current, configuration: request.payload.configuration }) as ManagedVersion
      break
    case 'update':
      if (current === null || suppliedVersion === null) throw new Error('update requires current and staged material')
      lastGood = current
      current = suppliedVersion
      break
    case 'enable':
    case 'disable':
      if (current === null) throw new Error(`${operation} requires installed material`)
      lastGood = current
      current = immutableJsonClone({ ...current, enabled: operation === 'enable' }) as ManagedVersion
      break
    case 'uninstall':
      if (current === null) throw new Error('uninstall requires installed material')
      removed = current
      current = null
      break
    case 'restore':
      if (current === null) {
        if (removed === null) throw new Error('restore has no removed material')
        current = removed
        removed = null
      } else {
        if (lastGood === null) throw new Error('restore has no last-good material')
        const replacement = lastGood
        lastGood = current
        current = replacement
      }
      break
    case 'purge':
      if (current !== null || (removed === null && lastGood === null)) throw new Error('purge requires retained removed material')
      removed = null
      lastGood = null
      break
  }
  return immutableJsonClone({
    schemaVersion: 1,
    kind: plan.extensionKind,
    extensionId: plan.extensionId,
    targetKey: plan.targetKey,
    scopeKey: plan.scopeKey,
    profileId: plan.profileId,
    revision: (before?.revision ?? 0) + 1,
    lastOperationId: authorization.operationId,
    current,
    lastGood,
    removed,
    pending: null,
    updatedAtMs: nowMs,
  }) as unknown as ManagedTargetRecord
}
