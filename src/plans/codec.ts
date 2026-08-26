import { isAbsolute } from 'node:path'
import {
  readArtifactIntegrity,
  readBoundedString,
  readLiteral,
  readNonNegativeInteger,
  readSha256Digest,
  readStrictRecord,
} from '../domain/codec.ts'
import { failDomain } from '../domain/errors.ts'
import { canonicalSha256, immutableJsonClone } from '../domain/json.ts'
import {
  IMMUTABLE_PLAN_SCHEMA_VERSION,
  type DesiredState,
  type ImmutablePlan,
  type ManagedExtensionKind,
  type OperationAuthorization,
  type PlanAuthorizationState,
  type PlanDecisionRecord,
  type OperationKind,
  type PlanContent,
  type PlanDecisionInput,
  type PlanRevisionFences,
  type RecoveryExecutableBinding,
  type PlanUseContext,
} from './types.ts'
import { decodePlanReviewEvidence } from './review-codec.ts'

const OPERATION_KINDS: readonly OperationKind[] = [
  'install',
  'configure',
  'update',
  'enable',
  'disable',
  'uninstall',
  'restore',
  'purge',
]
const EXTENSION_KINDS: readonly ManagedExtensionKind[] = ['plugin', 'mcp', 'skill']
const DESIRED_STATES: readonly DesiredState[] = ['enabled', 'disabled', 'removed']
const MANAGED_OBJECTS = ['artifact', 'connection'] as const
const EXTERNAL_RUNTIME_ACTIONS = ['download', 'none'] as const

function decodeRuntimeBinding(value: unknown, path: string): PlanContent['runtimeBinding'] {
  if (value === null) return null
  const record = readStrictRecord(value, ['descriptorDigest', 'runtimeRef', 'version'], path)
  return immutableJsonClone({
    runtimeRef: readBoundedString(record.runtimeRef, `${path}.runtimeRef`),
    version: readBoundedString(record.version, `${path}.version`),
    descriptorDigest: readSha256Digest(record.descriptorDigest, `${path}.descriptorDigest`),
  }) as PlanContent['runtimeBinding']
}

/** Strictly decode the absolute hash-pinned break-glass executable, Host CLI, and Host home. */
export function decodeRecoveryExecutableBinding(value: unknown, path = 'recoveryExecutable'): RecoveryExecutableBinding {
  const record = readStrictRecord(value, [
    'arch', 'executablePath', 'executableSha256', 'hostCliPath', 'hostCliSha256', 'hostHome', 'packageVersion', 'platform', 'schemaVersion',
  ], path)
  const executablePath = readBoundedString(record.executablePath, `${path}.executablePath`, 4_096)
  const hostCliPath = readBoundedString(record.hostCliPath, `${path}.hostCliPath`, 4_096)
  const hostHome = readBoundedString(record.hostHome, `${path}.hostHome`, 4_096)
  const arch = readBoundedString(record.arch, `${path}.arch`, 64)
  if (record.schemaVersion !== 2 || !isAbsolute(executablePath) || !isAbsolute(hostCliPath) || !isAbsolute(hostHome)
    || !/^[a-z0-9][a-z0-9._-]*$/u.test(arch)) {
    failDomain('invalid-data', `${path} values are invalid`)
  }
  return immutableJsonClone({
    schemaVersion: 2,
    executablePath,
    executableSha256: readSha256Digest(record.executableSha256, `${path}.executableSha256`),
    hostCliPath,
    hostCliSha256: readSha256Digest(record.hostCliSha256, `${path}.hostCliSha256`),
    hostHome,
    packageVersion: readBoundedString(record.packageVersion, `${path}.packageVersion`, 128),
    platform: readLiteral(record.platform, ['darwin', 'linux', 'win32'], `${path}.platform`),
    arch,
  }) as RecoveryExecutableBinding
}

function assertManagedObjectBinding(value: Readonly<{
  managedObject: PlanContent['managedObject']
  externalRuntimeAction: PlanContent['externalRuntimeAction']
  runtimeBinding: PlanContent['runtimeBinding']
  operationKind: PlanContent['operationKind']
}>, path: string): void {
  const connection = value.managedObject === 'connection'
  const artifactDownload = ['install', 'update'].includes(value.operationKind)
  if ((connection && (value.externalRuntimeAction !== 'none' || value.runtimeBinding === null))
    || (!connection && (value.runtimeBinding !== null
      || value.externalRuntimeAction !== (artifactDownload ? 'download' : 'none')))) {
    failDomain('invalid-data', `${path} managed object and runtime authority are inconsistent`)
  }
}

function decodeFences(value: unknown, path: string): PlanRevisionFences {
  const record = readStrictRecord(value, [
    'catalogRevision',
    'inventoryRevision',
    'targetRevision',
    'ownerRevision',
    'scopeRevision',
    'profileRevision',
  ], path)
  const catalogRevision = readNonNegativeInteger(record.catalogRevision, `${path}.catalogRevision`)
  if (catalogRevision === 0) failDomain('invalid-data', `${path}.catalogRevision must be positive`)
  return {
    catalogRevision,
    inventoryRevision: readSha256Digest(record.inventoryRevision, `${path}.inventoryRevision`),
    targetRevision: readBoundedString(record.targetRevision, `${path}.targetRevision`),
    ownerRevision: readBoundedString(record.ownerRevision, `${path}.ownerRevision`),
    scopeRevision: readBoundedString(record.scopeRevision, `${path}.scopeRevision`),
    profileRevision: readBoundedString(record.profileRevision, `${path}.profileRevision`),
  }
}

/**
 * Strictly decode canonical immutable plan content.
 *
 * @param value Untrusted plan content.
 * @returns Recursively frozen validated content.
 */
export function decodePlanContent(value: unknown): PlanContent {
  const record = readStrictRecord(value, [
    'schemaVersion',
    'singleUse',
    'planId',
    'intentId',
    'origin',
    'candidateRef',
    'extensionKind',
    'extensionId',
    'managedObject',
    'externalRuntimeAction',
    'runtimeBinding',
    'artifactRevision',
    'artifactIntegrity',
    'artifactUrl',
    'artifactSizeBytes',
    'operationKind',
    'desiredState',
    'targetKey',
    'ownerKey',
    'scopeKey',
    'profileId',
    'idempotencyKey',
    'authorityDigest',
    'configurationDigest',
    'retentionDigest',
    'mutationDigest',
    'verificationDigest',
    'reviewEvidence',
    'restartRequired',
    'createdAtMs',
    'expiresAtMs',
    'fences',
  ], 'plan.content')
  if (record.schemaVersion !== IMMUTABLE_PLAN_SCHEMA_VERSION) {
    failDomain('invalid-data', 'plan.content.schemaVersion is unsupported')
  }
  if (record.singleUse !== true) failDomain('invalid-data', 'plan.content.singleUse must be true')
  const createdAtMs = readNonNegativeInteger(record.createdAtMs, 'plan.content.createdAtMs')
  const expiresAtMs = readNonNegativeInteger(record.expiresAtMs, 'plan.content.expiresAtMs')
  if (createdAtMs >= expiresAtMs) failDomain('invalid-data', 'plan validity interval is invalid')
  const decoded: PlanContent = {
    schemaVersion: IMMUTABLE_PLAN_SCHEMA_VERSION,
    singleUse: true,
    planId: readBoundedString(record.planId, 'plan.content.planId'),
    intentId: readBoundedString(record.intentId, 'plan.content.intentId'),
    origin: readLiteral(record.origin, ['store', 'task'], 'plan.content.origin'),
    candidateRef: readBoundedString(record.candidateRef, 'plan.content.candidateRef'),
    extensionKind: readLiteral(record.extensionKind, EXTENSION_KINDS, 'plan.content.extensionKind'),
    extensionId: readBoundedString(record.extensionId, 'plan.content.extensionId'),
    managedObject: readLiteral(record.managedObject, MANAGED_OBJECTS, 'plan.content.managedObject'),
    externalRuntimeAction: readLiteral(record.externalRuntimeAction, EXTERNAL_RUNTIME_ACTIONS, 'plan.content.externalRuntimeAction'),
    runtimeBinding: decodeRuntimeBinding(record.runtimeBinding, 'plan.content.runtimeBinding'),
    artifactRevision: readBoundedString(record.artifactRevision, 'plan.content.artifactRevision'),
    artifactIntegrity: readArtifactIntegrity(record.artifactIntegrity, 'plan.content.artifactIntegrity'),
    artifactUrl: readBoundedString(record.artifactUrl, 'plan.content.artifactUrl', 2_048),
    artifactSizeBytes: readNonNegativeInteger(record.artifactSizeBytes, 'plan.content.artifactSizeBytes'),
    operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'plan.content.operationKind'),
    desiredState: readLiteral(record.desiredState, DESIRED_STATES, 'plan.content.desiredState'),
    targetKey: readBoundedString(record.targetKey, 'plan.content.targetKey'),
    ownerKey: readBoundedString(record.ownerKey, 'plan.content.ownerKey'),
    scopeKey: readBoundedString(record.scopeKey, 'plan.content.scopeKey'),
    profileId: readBoundedString(record.profileId, 'plan.content.profileId'),
    idempotencyKey: readBoundedString(record.idempotencyKey, 'plan.content.idempotencyKey'),
    authorityDigest: readSha256Digest(record.authorityDigest, 'plan.content.authorityDigest'),
    configurationDigest: readSha256Digest(record.configurationDigest, 'plan.content.configurationDigest'),
    retentionDigest: readSha256Digest(record.retentionDigest, 'plan.content.retentionDigest'),
    mutationDigest: readSha256Digest(record.mutationDigest, 'plan.content.mutationDigest'),
    verificationDigest: readSha256Digest(record.verificationDigest, 'plan.content.verificationDigest'),
    reviewEvidence: decodePlanReviewEvidence(record.reviewEvidence),
    restartRequired: record.restartRequired === true
      ? true
      : record.restartRequired === false
        ? false
        : failDomain('invalid-data', 'plan.content.restartRequired must be boolean'),
    createdAtMs,
    expiresAtMs,
    fences: decodeFences(record.fences, 'plan.content.fences'),
  }
  if ((decoded.extensionKind === 'mcp') !== (decoded.managedObject === 'connection')) {
    failDomain('invalid-data', 'plan.content extension kind and managed object are inconsistent')
  }
  if (decoded.reviewEvidence.kind !== decoded.extensionKind
    || decoded.reviewEvidence.operationKind !== decoded.operationKind) {
    failDomain('invalid-data', 'plan.content review evidence does not match the operation')
  }
  assertManagedObjectBinding(decoded, 'plan.content')
  return immutableJsonClone(decoded) as PlanContent
}

/**
 * Create one recursively frozen plan and bind its exact canonical hash.
 *
 * @param value Untrusted plan content.
 * @returns Immutable plan.
 */
export function createImmutablePlan(value: unknown): ImmutablePlan {
  const content = decodePlanContent(value)
  return immutableJsonClone({ content, hash: canonicalSha256(content) }) as unknown as ImmutablePlan
}

/**
 * Strictly decode an immutable plan and reject content tampering.
 *
 * @param value Untrusted serialized plan.
 * @returns Recursively frozen verified plan.
 */
export function decodeImmutablePlan(value: unknown): ImmutablePlan {
  const record = readStrictRecord(value, ['content', 'hash'], 'plan')
  const content = decodePlanContent(record.content)
  const hash = readSha256Digest(record.hash, 'plan.hash')
  if (canonicalSha256(content) !== hash) failDomain('plan-integrity', 'plan hash does not match its content')
  return immutableJsonClone({ content, hash }) as unknown as ImmutablePlan
}

/**
 * Revalidate a typed plan before every authorization transition.
 *
 * @param plan Candidate immutable plan.
 * @returns Verified recursively frozen plan.
 */
export function assertImmutablePlan(plan: ImmutablePlan): ImmutablePlan {
  return decodeImmutablePlan(plan)
}

/**
 * Strictly decode one human decision.
 *
 * @param value Untrusted decision payload.
 * @returns Recursively frozen decision.
 */
export function decodePlanDecisionInput(value: unknown): PlanDecisionInput {
  const record = readStrictRecord(value, ['planId', 'planHash', 'operationKind', 'decision'], 'decision')
  return immutableJsonClone({
    planId: readBoundedString(record.planId, 'decision.planId'),
    planHash: readSha256Digest(record.planHash, 'decision.planHash'),
    operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'decision.operationKind'),
    decision: readLiteral(record.decision, ['approve', 'reject'], 'decision.decision'),
  }) as unknown as PlanDecisionInput
}

/**
 * Strictly decode current owner observations used by revision fences.
 *
 * @param value Untrusted observation payload.
 * @returns Recursively frozen observation.
 */
export function decodePlanUseContext(value: unknown): PlanUseContext {
  const record = readStrictRecord(
    value,
    ['operationKind', 'targetKey', 'ownerKey', 'scopeKey', 'profileId', 'fences'],
    'planContext',
  )
  return immutableJsonClone({
    operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'planContext.operationKind'),
    targetKey: readBoundedString(record.targetKey, 'planContext.targetKey'),
    ownerKey: readBoundedString(record.ownerKey, 'planContext.ownerKey'),
    scopeKey: readBoundedString(record.scopeKey, 'planContext.scopeKey'),
    profileId: readBoundedString(record.profileId, 'planContext.profileId'),
    fences: decodeFences(record.fences, 'planContext.fences'),
  }) as unknown as PlanUseContext
}

/**
 * Strictly decode an operation authorization produced by plan consumption.
 *
 * @param value Untrusted authorization payload.
 * @returns Recursively frozen authorization.
 */
export function decodeOperationAuthorization(value: unknown): OperationAuthorization {
  const record = readStrictRecord(value, [
    'operationId',
    'planId',
    'planHash',
    'origin',
    'candidateRef',
    'extensionKind',
    'extensionId',
    'operationKind',
    'managedObject',
    'externalRuntimeAction',
    'runtimeBinding',
    'artifactRevision',
    'artifactIntegrity',
    'artifactUrl',
    'artifactSizeBytes',
    'desiredState',
    'targetKey',
    'ownerKey',
    'scopeKey',
    'profileId',
    'idempotencyKey',
    'authorityDigest',
    'configurationDigest',
    'retentionDigest',
    'mutationDigest',
    'verificationDigest',
    'reviewEvidence',
    'restartRequired',
    'fences',
    'recoveryExecutable',
    'authorizedAtMs',
  ], 'authorization')
  const decoded = immutableJsonClone({
    operationId: readBoundedString(record.operationId, 'authorization.operationId'),
    planId: readBoundedString(record.planId, 'authorization.planId'),
    planHash: readSha256Digest(record.planHash, 'authorization.planHash'),
    origin: readLiteral(record.origin, ['store', 'task'], 'authorization.origin'),
    candidateRef: readBoundedString(record.candidateRef, 'authorization.candidateRef'),
    extensionKind: readLiteral(record.extensionKind, EXTENSION_KINDS, 'authorization.extensionKind'),
    extensionId: readBoundedString(record.extensionId, 'authorization.extensionId'),
    operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'authorization.operationKind'),
    managedObject: readLiteral(record.managedObject, MANAGED_OBJECTS, 'authorization.managedObject'),
    externalRuntimeAction: readLiteral(record.externalRuntimeAction, EXTERNAL_RUNTIME_ACTIONS, 'authorization.externalRuntimeAction'),
    runtimeBinding: decodeRuntimeBinding(record.runtimeBinding, 'authorization.runtimeBinding'),
    artifactRevision: readBoundedString(record.artifactRevision, 'authorization.artifactRevision'),
    artifactIntegrity: readArtifactIntegrity(record.artifactIntegrity, 'authorization.artifactIntegrity'),
    artifactUrl: readBoundedString(record.artifactUrl, 'authorization.artifactUrl', 2_048),
    artifactSizeBytes: readNonNegativeInteger(record.artifactSizeBytes, 'authorization.artifactSizeBytes'),
    desiredState: readLiteral(record.desiredState, DESIRED_STATES, 'authorization.desiredState'),
    targetKey: readBoundedString(record.targetKey, 'authorization.targetKey'),
    ownerKey: readBoundedString(record.ownerKey, 'authorization.ownerKey'),
    scopeKey: readBoundedString(record.scopeKey, 'authorization.scopeKey'),
    profileId: readBoundedString(record.profileId, 'authorization.profileId'),
    idempotencyKey: readBoundedString(record.idempotencyKey, 'authorization.idempotencyKey'),
    authorityDigest: readSha256Digest(record.authorityDigest, 'authorization.authorityDigest'),
    configurationDigest: readSha256Digest(record.configurationDigest, 'authorization.configurationDigest'),
    retentionDigest: readSha256Digest(record.retentionDigest, 'authorization.retentionDigest'),
    mutationDigest: readSha256Digest(record.mutationDigest, 'authorization.mutationDigest'),
    verificationDigest: readSha256Digest(record.verificationDigest, 'authorization.verificationDigest'),
    reviewEvidence: decodePlanReviewEvidence(record.reviewEvidence, 'authorization.reviewEvidence'),
    restartRequired: record.restartRequired === true
      ? true
      : record.restartRequired === false
        ? false
        : failDomain('invalid-data', 'authorization.restartRequired must be boolean'),
    fences: decodeFences(record.fences, 'authorization.fences'),
    recoveryExecutable: decodeRecoveryExecutableBinding(record.recoveryExecutable, 'authorization.recoveryExecutable'),
    authorizedAtMs: readNonNegativeInteger(record.authorizedAtMs, 'authorization.authorizedAtMs'),
  }) as unknown as OperationAuthorization
  assertManagedObjectBinding(decoded, 'authorization')
  if (decoded.reviewEvidence.kind !== decoded.extensionKind
    || decoded.reviewEvidence.operationKind !== decoded.operationKind) {
    failDomain('invalid-data', 'authorization review evidence does not match the operation')
  }
  return decoded
}

function decodeDecisionRecord(value: unknown): PlanDecisionRecord {
  const record = readStrictRecord(
    value,
    ['planId', 'planHash', 'operationKind', 'decision', 'decidedAtMs'],
    'planState.decision',
  )
  return immutableJsonClone({
    planId: readBoundedString(record.planId, 'planState.decision.planId'),
    planHash: readSha256Digest(record.planHash, 'planState.decision.planHash'),
    operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'planState.decision.operationKind'),
    decision: readLiteral(record.decision, ['approve', 'reject'], 'planState.decision.decision'),
    decidedAtMs: readNonNegativeInteger(record.decidedAtMs, 'planState.decision.decidedAtMs'),
  }) as unknown as PlanDecisionRecord
}

function assertStateBindings(state: PlanAuthorizationState): PlanAuthorizationState {
  const { plan } = state
  if (state.status === 'pending') return state
  if (state.status === 'expired') {
    if (state.expiredAtMs < plan.content.expiresAtMs) {
      failDomain('invalid-data', 'planState expired before plan expiry')
    }
    return state
  }
  const { decision } = state
  if (
    decision.planId !== plan.content.planId
    || decision.planHash !== plan.hash
    || decision.operationKind !== plan.content.operationKind
    || decision.decidedAtMs < plan.content.createdAtMs
    || decision.decidedAtMs >= plan.content.expiresAtMs
  ) {
    failDomain('plan-integrity', 'planState decision does not bind the exact plan')
  }
  if (state.status === 'approved' && decision.decision !== 'approve') {
    failDomain('plan-integrity', 'approved planState does not contain approval')
  }
  if (state.status === 'rejected' && decision.decision !== 'reject') {
    failDomain('plan-integrity', 'rejected planState does not contain rejection')
  }
  if (state.status !== 'consumed') return state
  const { authorization } = state
  const authorizationBinding = canonicalSha256({
    origin: authorization.origin,
    candidateRef: authorization.candidateRef,
    extensionKind: authorization.extensionKind,
    extensionId: authorization.extensionId,
    managedObject: authorization.managedObject,
    externalRuntimeAction: authorization.externalRuntimeAction,
    runtimeBinding: authorization.runtimeBinding,
    artifactRevision: authorization.artifactRevision,
    artifactIntegrity: authorization.artifactIntegrity,
    artifactUrl: authorization.artifactUrl,
    artifactSizeBytes: authorization.artifactSizeBytes,
    operationKind: authorization.operationKind,
    desiredState: authorization.desiredState,
    targetKey: authorization.targetKey,
    ownerKey: authorization.ownerKey,
    scopeKey: authorization.scopeKey,
    profileId: authorization.profileId,
    idempotencyKey: authorization.idempotencyKey,
    authorityDigest: authorization.authorityDigest,
    configurationDigest: authorization.configurationDigest,
    retentionDigest: authorization.retentionDigest,
    mutationDigest: authorization.mutationDigest,
    verificationDigest: authorization.verificationDigest,
    reviewEvidence: authorization.reviewEvidence,
    restartRequired: authorization.restartRequired,
    fences: authorization.fences,
  })
  const planBinding = canonicalSha256({
    origin: plan.content.origin,
    candidateRef: plan.content.candidateRef,
    extensionKind: plan.content.extensionKind,
    extensionId: plan.content.extensionId,
    managedObject: plan.content.managedObject,
    externalRuntimeAction: plan.content.externalRuntimeAction,
    runtimeBinding: plan.content.runtimeBinding,
    artifactRevision: plan.content.artifactRevision,
    artifactIntegrity: plan.content.artifactIntegrity,
    artifactUrl: plan.content.artifactUrl,
    artifactSizeBytes: plan.content.artifactSizeBytes,
    operationKind: plan.content.operationKind,
    desiredState: plan.content.desiredState,
    targetKey: plan.content.targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    idempotencyKey: plan.content.idempotencyKey,
    authorityDigest: plan.content.authorityDigest,
    configurationDigest: plan.content.configurationDigest,
    retentionDigest: plan.content.retentionDigest,
    mutationDigest: plan.content.mutationDigest,
    verificationDigest: plan.content.verificationDigest,
    reviewEvidence: plan.content.reviewEvidence,
    restartRequired: plan.content.restartRequired,
    fences: plan.content.fences,
  })
  if (
    decision.decision !== 'approve'
    || authorization.planId !== plan.content.planId
    || authorization.planHash !== plan.hash
    || authorization.operationKind !== plan.content.operationKind
    || authorization.targetKey !== plan.content.targetKey
    || authorization.ownerKey !== plan.content.ownerKey
    || authorization.scopeKey !== plan.content.scopeKey
    || authorization.profileId !== plan.content.profileId
    || authorizationBinding !== planBinding
    || authorization.authorizedAtMs < decision.decidedAtMs
    || authorization.authorizedAtMs >= plan.content.expiresAtMs
  ) {
    failDomain('plan-integrity', 'consumed planState authorization does not bind the exact plan')
  }
  return state
}

/**
 * Strictly decode one durable plan authorization state and verify all identity bindings.
 *
 * @param value Untrusted persisted plan state.
 * @returns Recursively frozen verified state.
 */
export function decodePlanAuthorizationState(value: unknown): PlanAuthorizationState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failDomain('invalid-data', 'planState must be an object')
  }
  const status = readLiteral(
    (value as Readonly<Record<string, unknown>>).status,
    ['pending', 'approved', 'rejected', 'expired', 'consumed'],
    'planState.status',
  )
  if (status === 'pending') {
    const record = readStrictRecord(value, ['status', 'plan'], 'planState')
    return assertStateBindings(immutableJsonClone({
      status,
      plan: decodeImmutablePlan(record.plan),
    }) as unknown as PlanAuthorizationState)
  }
  if (status === 'expired') {
    const record = readStrictRecord(value, ['status', 'plan', 'expiredAtMs'], 'planState')
    return assertStateBindings(immutableJsonClone({
      status,
      plan: decodeImmutablePlan(record.plan),
      expiredAtMs: readNonNegativeInteger(record.expiredAtMs, 'planState.expiredAtMs'),
    }) as unknown as PlanAuthorizationState)
  }
  if (status === 'approved' || status === 'rejected') {
    const record = readStrictRecord(value, ['status', 'plan', 'decision'], 'planState')
    return assertStateBindings(immutableJsonClone({
      status,
      plan: decodeImmutablePlan(record.plan),
      decision: decodeDecisionRecord(record.decision),
    }) as unknown as PlanAuthorizationState)
  }
  const record = readStrictRecord(value, ['status', 'plan', 'decision', 'authorization'], 'planState')
  return assertStateBindings(immutableJsonClone({
    status,
    plan: decodeImmutablePlan(record.plan),
    decision: decodeDecisionRecord(record.decision),
    authorization: decodeOperationAuthorization(record.authorization),
  }) as unknown as PlanAuthorizationState)
}
