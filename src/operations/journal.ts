import {
  readArtifactIntegrity,
  readBoundedString,
  readLiteral,
  readNonNegativeInteger,
  readNullableSha256Digest,
  readSha256Digest,
  readStrictRecord,
} from '../domain/codec.ts'
import { failDomain } from '../domain/errors.ts'
import { canonicalSha256, immutableJsonClone, type Sha256Digest } from '../domain/json.ts'
import { decodeOperationAuthorization, decodeStoredRecoveryExecutableBinding } from '../plans/codec.ts'
import { decodePlanReviewEvidence } from '../plans/review-codec.ts'
import type { OperationAuthorization, OperationKind, RuntimeBinding } from '../plans/types.ts'
import {
  OPERATION_RECORD_SCHEMA_VERSION,
  type JournalCheckpoint,
  type OperationJournal,
  type OperationJournalEntry,
  type OperationJournalEvent,
  type OperationOutcome,
  type OperationPhase,
  type OperationPlanEvidence,
  type OperationProjection,
  type OperationReceipt,
  type OperationReceiptBody,
  type OperationReceiptEvidence,
} from './types.ts'

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
const OPERATION_PHASES: readonly OperationPhase[] = [
  'authorized',
  'staging',
  'applying',
  'verifying',
  'rolling-back',
  'committed',
  'rolled-back',
  'failed',
  'recovery-required',
]
const MANAGED_OBJECTS = ['artifact', 'connection'] as const
const EXTERNAL_RUNTIME_ACTIONS = ['download', 'none'] as const
const TERMINAL_PHASES: readonly OperationOutcome[] = [
  'committed',
  'rolled-back',
  'failed',
]
const EXTENSION_KINDS = ['plugin', 'mcp', 'skill'] as const
const DESIRED_STATES = ['enabled', 'disabled', 'removed'] as const
const EVIDENCE_STATUSES = ['proven', 'not-required', 'not-proven'] as const
const NOT_PROVEN_CLAIMS = ['mutation', 'verification', 'rollback', 'restart', 'recovery'] as const
const NEXT_PHASES: Readonly<Record<OperationPhase, readonly OperationPhase[]>> = {
  authorized: ['staging', 'failed'],
  staging: ['applying', 'rolling-back', 'failed'],
  applying: ['verifying', 'rolling-back', 'failed'],
  verifying: ['committed', 'rolling-back', 'failed'],
  'rolling-back': ['rolled-back', 'recovery-required'],
  committed: [],
  'rolled-back': [],
  failed: [],
  'recovery-required': ['rolling-back'],
}

function readNullableReason(value: unknown, path: string): string | null {
  if (value === null) return null
  const reason = readBoundedString(value, path, 64)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(reason)) {
    failDomain('invalid-data', `${path} must be a stable reason code`)
  }
  return reason
}

function readDigestArray(value: unknown, path: string): readonly Sha256Digest[] {
  if (!Array.isArray(value)) failDomain('invalid-data', `${path} must be an array`)
  return Object.freeze(value.map((entry, index) => readSha256Digest(entry, `${path}[${index}]`)))
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') failDomain('invalid-data', `${path} must be boolean`)
  return value
}

function decodeFences(value: unknown, path: string): OperationPlanEvidence['fences'] {
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
  return immutableJsonClone({
    catalogRevision,
    inventoryRevision: readSha256Digest(record.inventoryRevision, `${path}.inventoryRevision`),
    targetRevision: readBoundedString(record.targetRevision, `${path}.targetRevision`),
    ownerRevision: readBoundedString(record.ownerRevision, `${path}.ownerRevision`),
    scopeRevision: readBoundedString(record.scopeRevision, `${path}.scopeRevision`),
    profileRevision: readBoundedString(record.profileRevision, `${path}.profileRevision`),
  }) as OperationPlanEvidence['fences']
}

function decodePlanEvidence(value: unknown, path: string): OperationPlanEvidence {
  const record = readStrictRecord(value, [
    'origin',
    'candidateRef',
    'extensionKind',
    'extensionId',
    'artifactRevision',
    'artifactIntegrity',
    'artifactUrl',
    'artifactSizeBytes',
    'desiredState',
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
  ], path)
  return immutableJsonClone({
    origin: readLiteral(record.origin, ['store', 'task'], `${path}.origin`),
    candidateRef: readBoundedString(record.candidateRef, `${path}.candidateRef`),
    extensionKind: readLiteral(record.extensionKind, EXTENSION_KINDS, `${path}.extensionKind`),
    extensionId: readBoundedString(record.extensionId, `${path}.extensionId`),
    artifactRevision: readBoundedString(record.artifactRevision, `${path}.artifactRevision`),
    artifactIntegrity: readArtifactIntegrity(record.artifactIntegrity, `${path}.artifactIntegrity`),
    artifactUrl: readBoundedString(record.artifactUrl, `${path}.artifactUrl`, 2_048),
    artifactSizeBytes: readNonNegativeInteger(record.artifactSizeBytes, `${path}.artifactSizeBytes`),
    desiredState: readLiteral(record.desiredState, DESIRED_STATES, `${path}.desiredState`),
    ownerKey: readBoundedString(record.ownerKey, `${path}.ownerKey`),
    scopeKey: readBoundedString(record.scopeKey, `${path}.scopeKey`),
    profileId: readBoundedString(record.profileId, `${path}.profileId`),
    idempotencyKey: readBoundedString(record.idempotencyKey, `${path}.idempotencyKey`),
    authorityDigest: readSha256Digest(record.authorityDigest, `${path}.authorityDigest`),
    configurationDigest: readSha256Digest(record.configurationDigest, `${path}.configurationDigest`),
    retentionDigest: readSha256Digest(record.retentionDigest, `${path}.retentionDigest`),
    mutationDigest: readSha256Digest(record.mutationDigest, `${path}.mutationDigest`),
    verificationDigest: readSha256Digest(record.verificationDigest, `${path}.verificationDigest`),
    reviewEvidence: decodePlanReviewEvidence(record.reviewEvidence, `${path}.reviewEvidence`),
    restartRequired: readBoolean(record.restartRequired, `${path}.restartRequired`),
    fences: decodeFences(record.fences, `${path}.fences`),
    recoveryExecutable: decodeStoredRecoveryExecutableBinding(record.recoveryExecutable, `${path}.recoveryExecutable`),
  }) as OperationPlanEvidence
}

function deriveReceiptEvidence(input: Readonly<{
  outcome: OperationOutcome
  mutationDigests: readonly Sha256Digest[]
  verificationDigests: readonly Sha256Digest[]
  restartRequired: boolean
  rollbackAttempted: boolean
  recoveryAttempts: number
  completedReviewPhases: OperationProjection['completedReviewPhases']
  planEvidence: OperationPlanEvidence
}>): OperationReceiptEvidence {
  const mutation = input.mutationDigests.length > 0
    ? 'proven'
    : input.outcome === 'failed' ? 'not-required' : 'not-proven'
  const verification = input.outcome === 'committed' && input.verificationDigests.length > 0
    ? 'proven'
    : input.outcome === 'failed' ? 'not-required' : 'not-proven'
  const rollback = input.rollbackAttempted
    ? input.outcome === 'rolled-back' ? 'proven' : 'not-proven'
    : 'not-required'
  const restartIsRequired = input.restartRequired && input.mutationDigests.length > 0
  const restart = !restartIsRequired
    ? 'not-required'
    : input.verificationDigests.length > 0 && input.outcome !== 'failed' ? 'proven' : 'not-proven'
  const recovery = input.recoveryAttempts === 0
    ? 'not-required'
    : input.outcome === 'rolled-back' ? 'proven' : 'not-proven'
  const statuses = { mutation, verification, rollback, restart, recovery } as const
  return immutableJsonClone({
    checksActuallyRun: input.planEvidence.reviewEvidence.checks.filter(check => input.completedReviewPhases.includes(check.phase)),
    mutation,
    verification,
    rollback: { attempted: input.rollbackAttempted, status: rollback },
    restart: { required: restartIsRequired, status: restart },
    recovery: { attempts: input.recoveryAttempts, status: recovery },
    notProven: NOT_PROVEN_CLAIMS.filter(claim => statuses[claim] === 'not-proven'),
  }) as OperationReceiptEvidence
}

function decodeReceiptEvidence(
  value: unknown,
  body: Readonly<{
    outcome: OperationOutcome
    mutationDigests: readonly Sha256Digest[]
    verificationDigests: readonly Sha256Digest[]
    planEvidence: OperationPlanEvidence
  }>,
  path: string,
): OperationReceiptEvidence {
  const record = readStrictRecord(value, ['checksActuallyRun', 'mutation', 'verification', 'rollback', 'restart', 'recovery', 'notProven'], path)
  const rollback = readStrictRecord(record.rollback, ['attempted', 'status'], `${path}.rollback`)
  const restart = readStrictRecord(record.restart, ['required', 'status'], `${path}.restart`)
  const recovery = readStrictRecord(record.recovery, ['attempts', 'status'], `${path}.recovery`)
  if (!Array.isArray(record.notProven)) failDomain('invalid-data', `${path}.notProven must be an array`)
  const decoded = immutableJsonClone({
    checksActuallyRun: decodePlanReviewEvidence({
      ...body.planEvidence.reviewEvidence,
      checks: record.checksActuallyRun,
    }, `${path}.checksActuallyRunContainer`).checks,
    mutation: readLiteral(record.mutation, EVIDENCE_STATUSES, `${path}.mutation`),
    verification: readLiteral(record.verification, EVIDENCE_STATUSES, `${path}.verification`),
    rollback: {
      attempted: readBoolean(rollback.attempted, `${path}.rollback.attempted`),
      status: readLiteral(rollback.status, EVIDENCE_STATUSES, `${path}.rollback.status`),
    },
    restart: {
      required: readBoolean(restart.required, `${path}.restart.required`),
      status: readLiteral(restart.status, EVIDENCE_STATUSES, `${path}.restart.status`),
    },
    recovery: {
      attempts: readNonNegativeInteger(recovery.attempts, `${path}.recovery.attempts`),
      status: readLiteral(recovery.status, EVIDENCE_STATUSES, `${path}.recovery.status`),
    },
    notProven: record.notProven.map((claim, index) => readLiteral(claim, NOT_PROVEN_CLAIMS, `${path}.notProven[${String(index)}]`)),
  }) as OperationReceiptEvidence
  const expected = deriveReceiptEvidence({
    ...body,
    restartRequired: body.planEvidence.restartRequired,
    rollbackAttempted: decoded.rollback.attempted,
    recoveryAttempts: decoded.recovery.attempts,
    completedReviewPhases: decoded.checksActuallyRun.map(check => check.phase),
    planEvidence: body.planEvidence,
  })
  if (canonicalSha256(decoded) !== canonicalSha256(expected)) {
    failDomain('invalid-data', `${path} is inconsistent with the terminal evidence`)
  }
  return decoded
}

function decodeRuntimeBinding(value: unknown, path: string): RuntimeBinding | null {
  if (value === null) return null
  const record = readStrictRecord(value, ['descriptorDigest', 'runtimeRef', 'version'], path)
  return immutableJsonClone({
    runtimeRef: readBoundedString(record.runtimeRef, `${path}.runtimeRef`),
    version: readBoundedString(record.version, `${path}.version`),
    descriptorDigest: readSha256Digest(record.descriptorDigest, `${path}.descriptorDigest`),
  }) as RuntimeBinding
}

function assertManagedObjectBinding(
  operationKind: OperationKind,
  managedObject: 'artifact' | 'connection',
  externalRuntimeAction: 'download' | 'none',
  runtimeBinding: RuntimeBinding | null,
  path: string,
): void {
  const connection = managedObject === 'connection'
  const artifactDownload = operationKind === 'install' || operationKind === 'update'
  if ((connection && (externalRuntimeAction !== 'none' || runtimeBinding === null))
    || (!connection && (runtimeBinding !== null
      || externalRuntimeAction !== (artifactDownload ? 'download' : 'none')))) {
    failDomain('invalid-data', `${path} managed object and runtime authority are inconsistent`)
  }
}

function decodeReceiptBody(value: unknown): OperationReceiptBody {
  const record = readStrictRecord(value, [
    'schemaVersion',
    'operationId',
    'planId',
    'planHash',
    'operationKind',
    'managedObject',
    'externalRuntimeAction',
    'runtimeBinding',
    'planEvidence',
    'targetKey',
    'outcome',
    'beforeDigest',
    'afterDigest',
    'mutationDigests',
    'verificationDigests',
    'evidence',
    'journalEventCount',
    'journalHeadDigest',
    'issuedAtMs',
  ], 'receipt.body')
  if (record.schemaVersion !== OPERATION_RECORD_SCHEMA_VERSION) {
    failDomain('invalid-data', 'receipt.body.schemaVersion is unsupported')
  }
  const outcome = readLiteral(record.outcome, TERMINAL_PHASES, 'receipt.body.outcome')
  const planEvidence = decodePlanEvidence(record.planEvidence, 'receipt.body.planEvidence')
  const mutationDigests = readDigestArray(record.mutationDigests, 'receipt.body.mutationDigests')
  const verificationDigests = readDigestArray(record.verificationDigests, 'receipt.body.verificationDigests')
  const body: OperationReceiptBody = {
    schemaVersion: OPERATION_RECORD_SCHEMA_VERSION,
    operationId: readBoundedString(record.operationId, 'receipt.body.operationId'),
    planId: readBoundedString(record.planId, 'receipt.body.planId'),
    planHash: readSha256Digest(record.planHash, 'receipt.body.planHash'),
    operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'receipt.body.operationKind'),
    managedObject: readLiteral(record.managedObject, MANAGED_OBJECTS, 'receipt.body.managedObject'),
    externalRuntimeAction: readLiteral(record.externalRuntimeAction, EXTERNAL_RUNTIME_ACTIONS, 'receipt.body.externalRuntimeAction'),
    runtimeBinding: decodeRuntimeBinding(record.runtimeBinding, 'receipt.body.runtimeBinding'),
    planEvidence,
    targetKey: readBoundedString(record.targetKey, 'receipt.body.targetKey'),
    outcome,
    beforeDigest: readSha256Digest(record.beforeDigest, 'receipt.body.beforeDigest'),
    afterDigest: readNullableSha256Digest(record.afterDigest, 'receipt.body.afterDigest'),
    mutationDigests,
    verificationDigests,
    evidence: decodeReceiptEvidence(record.evidence, {
      outcome,
      mutationDigests,
      verificationDigests,
      planEvidence,
    }, 'receipt.body.evidence'),
    journalEventCount: readNonNegativeInteger(record.journalEventCount, 'receipt.body.journalEventCount'),
    journalHeadDigest: readSha256Digest(record.journalHeadDigest, 'receipt.body.journalHeadDigest'),
    issuedAtMs: readNonNegativeInteger(record.issuedAtMs, 'receipt.body.issuedAtMs'),
  }
  assertManagedObjectBinding(
    body.operationKind,
    body.managedObject,
    body.externalRuntimeAction,
    body.runtimeBinding,
    'receipt.body',
  )
  if (body.journalEventCount === 0) failDomain('invalid-data', 'receipt must reference a non-empty journal')
  return immutableJsonClone(body) as OperationReceiptBody
}

/**
 * Strictly decode and verify one terminal receipt.
 *
 * @param value Untrusted receipt value.
 * @returns Recursively frozen verified receipt.
 */
export function decodeOperationReceipt(value: unknown): OperationReceipt {
  const record = readStrictRecord(value, ['body', 'digest'], 'receipt')
  const body = decodeReceiptBody(record.body)
  const digest = readSha256Digest(record.digest, 'receipt.digest')
  if (canonicalSha256(body) !== digest) failDomain('journal-corrupt', 'receipt digest does not match its body')
  return immutableJsonClone({ body, digest }) as unknown as OperationReceipt
}

function decodeEntry(value: unknown): OperationJournalEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failDomain('invalid-data', 'journal event entry must be an object')
  }
  const type = readLiteral(
    (value as Readonly<Record<string, unknown>>).type,
    ['operation-opened', 'phase-transition', 'mutation-observed', 'verification-observed', 'receipt-issued'],
    'journal.event.entry.type',
  )
  if (type === 'operation-opened') {
    const record = readStrictRecord(
      value,
      ['type', 'planId', 'planHash', 'operationKind', 'managedObject', 'externalRuntimeAction', 'runtimeBinding', 'planEvidence', 'beforeDigest'],
      'journal.event.entry',
    )
    const opened = immutableJsonClone({
      type,
      planId: readBoundedString(record.planId, 'journal.event.entry.planId'),
      planHash: readSha256Digest(record.planHash, 'journal.event.entry.planHash'),
      operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'journal.event.entry.operationKind'),
      managedObject: readLiteral(record.managedObject, MANAGED_OBJECTS, 'journal.event.entry.managedObject'),
      externalRuntimeAction: readLiteral(record.externalRuntimeAction, EXTERNAL_RUNTIME_ACTIONS, 'journal.event.entry.externalRuntimeAction'),
      runtimeBinding: decodeRuntimeBinding(record.runtimeBinding, 'journal.event.entry.runtimeBinding'),
      planEvidence: decodePlanEvidence(record.planEvidence, 'journal.event.entry.planEvidence'),
      beforeDigest: readSha256Digest(record.beforeDigest, 'journal.event.entry.beforeDigest'),
    }) as unknown as Extract<OperationJournalEntry, { type: 'operation-opened' }>
    assertManagedObjectBinding(
      opened.operationKind,
      opened.managedObject,
      opened.externalRuntimeAction,
      opened.runtimeBinding,
      'journal.event.entry',
    )
    return opened
  }
  if (type === 'phase-transition') {
    const record = readStrictRecord(
      value,
      ['type', 'from', 'to', 'evidenceDigest', 'reason'],
      'journal.event.entry',
    )
    return immutableJsonClone({
      type,
      from: readLiteral(record.from, OPERATION_PHASES, 'journal.event.entry.from'),
      to: readLiteral(record.to, OPERATION_PHASES, 'journal.event.entry.to'),
      evidenceDigest: readNullableSha256Digest(record.evidenceDigest, 'journal.event.entry.evidenceDigest'),
      reason: readNullableReason(record.reason, 'journal.event.entry.reason'),
    }) as unknown as OperationJournalEntry
  }
  if (type === 'mutation-observed') {
    const record = readStrictRecord(value, ['type', 'mutationDigest'], 'journal.event.entry')
    return Object.freeze({
      type,
      mutationDigest: readSha256Digest(record.mutationDigest, 'journal.event.entry.mutationDigest'),
    })
  }
  if (type === 'verification-observed') {
    const record = readStrictRecord(value, ['type', 'verificationDigest'], 'journal.event.entry')
    return Object.freeze({
      type,
      verificationDigest: readSha256Digest(record.verificationDigest, 'journal.event.entry.verificationDigest'),
    })
  }
  const record = readStrictRecord(value, ['type', 'receipt'], 'journal.event.entry')
  return immutableJsonClone({ type, receipt: decodeOperationReceipt(record.receipt) }) as unknown as OperationJournalEntry
}

function decodeEvent(value: unknown): OperationJournalEvent {
  const record = readStrictRecord(value, [
    'schemaVersion',
    'operationId',
    'targetKey',
    'sequence',
    'previousDigest',
    'atMs',
    'entry',
    'digest',
  ], 'journal.event')
  if (record.schemaVersion !== OPERATION_RECORD_SCHEMA_VERSION) {
    failDomain('invalid-data', 'journal.event.schemaVersion is unsupported')
  }
  return immutableJsonClone({
    schemaVersion: OPERATION_RECORD_SCHEMA_VERSION,
    operationId: readBoundedString(record.operationId, 'journal.event.operationId'),
    targetKey: readBoundedString(record.targetKey, 'journal.event.targetKey'),
    sequence: readNonNegativeInteger(record.sequence, 'journal.event.sequence'),
    previousDigest: readNullableSha256Digest(record.previousDigest, 'journal.event.previousDigest'),
    atMs: readNonNegativeInteger(record.atMs, 'journal.event.atMs'),
    entry: decodeEntry(record.entry),
    digest: readSha256Digest(record.digest, 'journal.event.digest'),
  }) as unknown as OperationJournalEvent
}

function decodeJournal(value: unknown): OperationJournal {
  const record = readStrictRecord(value, ['schemaVersion', 'operationId', 'targetKey', 'events'], 'journal')
  if (record.schemaVersion !== OPERATION_RECORD_SCHEMA_VERSION) {
    failDomain('invalid-data', 'journal.schemaVersion is unsupported')
  }
  if (!Array.isArray(record.events)) failDomain('invalid-data', 'journal.events must be an array')
  return immutableJsonClone({
    schemaVersion: OPERATION_RECORD_SCHEMA_VERSION,
    operationId: readBoundedString(record.operationId, 'journal.operationId'),
    targetKey: readBoundedString(record.targetKey, 'journal.targetKey'),
    events: record.events.map(decodeEvent),
  }) as unknown as OperationJournal
}

function unsignedEvent(event: OperationJournalEvent): Omit<OperationJournalEvent, 'digest'> {
  return {
    schemaVersion: event.schemaVersion,
    operationId: event.operationId,
    targetKey: event.targetKey,
    sequence: event.sequence,
    previousDigest: event.previousDigest,
    atMs: event.atMs,
    entry: event.entry,
  }
}

function receiptBody(
  projection: OperationProjection,
  checkpoint: JournalCheckpoint,
  issuedAtMs: number,
): OperationReceiptBody {
  if (!TERMINAL_PHASES.includes(projection.phase as OperationOutcome)) {
    failDomain('journal-transition', 'a receipt requires a terminal operation')
  }
  return immutableJsonClone({
    schemaVersion: OPERATION_RECORD_SCHEMA_VERSION,
    operationId: projection.operationId,
    planId: projection.planId,
    planHash: projection.planHash,
    operationKind: projection.operationKind,
    managedObject: projection.managedObject,
    externalRuntimeAction: projection.externalRuntimeAction,
    runtimeBinding: projection.runtimeBinding,
    planEvidence: projection.planEvidence,
    targetKey: projection.targetKey,
    outcome: projection.phase as OperationOutcome,
    beforeDigest: projection.beforeDigest,
    afterDigest: projection.afterDigest,
    mutationDigests: projection.mutationDigests,
    verificationDigests: projection.verificationDigests,
    evidence: deriveReceiptEvidence({
      outcome: projection.phase as OperationOutcome,
      mutationDigests: projection.mutationDigests,
      verificationDigests: projection.verificationDigests,
      restartRequired: projection.planEvidence.restartRequired,
      rollbackAttempted: projection.rollbackAttempted,
      recoveryAttempts: projection.recoveryAttempts,
      completedReviewPhases: projection.completedReviewPhases,
      planEvidence: projection.planEvidence,
    }),
    journalEventCount: checkpoint.eventCount,
    journalHeadDigest: checkpoint.headDigest,
    issuedAtMs,
  }) as OperationReceiptBody
}

function assertTransition(projection: OperationProjection, entry: Extract<OperationJournalEntry, { type: 'phase-transition' }>): void {
  if (entry.from !== projection.phase || !NEXT_PHASES[projection.phase].includes(entry.to)) {
    failDomain('journal-transition', `operation cannot transition from ${entry.from} to ${entry.to}`)
  }
  const terminal = TERMINAL_PHASES.includes(entry.to as OperationOutcome)
  if (!terminal && entry.evidenceDigest !== null) {
    failDomain('journal-transition', 'non-terminal transitions cannot publish final evidence')
  }
  if ((entry.to === 'failed' || entry.to === 'recovery-required') && entry.reason === null) {
    failDomain('journal-transition', `${entry.to} requires a bounded reason`)
  }
  if (entry.to === 'committed') {
    if (entry.evidenceDigest === null || projection.verificationDigests.length === 0) {
      failDomain('journal-transition', 'commit requires owner evidence and a verification observation')
    }
    if (entry.reason !== null) failDomain('journal-transition', 'commit cannot carry a failure reason')
  }
  if (entry.to === 'rolled-back') {
    if (entry.evidenceDigest !== projection.beforeDigest) {
      failDomain('journal-transition', 'rollback evidence must match the before-state digest')
    }
    if (entry.reason !== null) failDomain('journal-transition', 'rolled-back outcome cannot carry a failure reason')
  }
  if (entry.to === 'failed') {
    if (projection.mutationDigests.length !== 0 || entry.evidenceDigest !== projection.beforeDigest) {
      failDomain('journal-transition', 'failed terminal state must prove the unchanged before-state')
    }
  }
}

function applyEntry(
  projection: OperationProjection | null,
  event: OperationJournalEvent,
): OperationProjection {
  const { entry } = event
  if (projection === null) {
    if (entry.type !== 'operation-opened') failDomain('journal-transition', 'journal must begin with operation-opened')
    return immutableJsonClone({
      operationId: event.operationId,
      targetKey: event.targetKey,
      planId: entry.planId,
      planHash: entry.planHash,
      operationKind: entry.operationKind,
      managedObject: entry.managedObject,
      externalRuntimeAction: entry.externalRuntimeAction,
      runtimeBinding: entry.runtimeBinding,
      planEvidence: entry.planEvidence,
      phase: 'authorized',
      beforeDigest: entry.beforeDigest,
      afterDigest: null,
      mutationDigests: [],
      verificationDigests: [],
      rollbackAttempted: false,
      recoveryAttempts: 0,
      completedReviewPhases: ['planning'],
      lastAtMs: event.atMs,
      receipt: null,
    }) as unknown as OperationProjection
  }
  if (projection.receipt !== null) failDomain('journal-transition', 'receipt must be the final journal event')
  if (entry.type === 'operation-opened') failDomain('journal-transition', 'operation-opened cannot repeat')
  if (entry.type === 'phase-transition') {
    assertTransition(projection, entry)
    return immutableJsonClone({
      ...projection,
      phase: entry.to,
      afterDigest: TERMINAL_PHASES.includes(entry.to as OperationOutcome) ? entry.evidenceDigest : null,
      rollbackAttempted: projection.rollbackAttempted || entry.to === 'rolling-back',
      recoveryAttempts: projection.recoveryAttempts + (entry.to === 'recovery-required' ? 1 : 0),
      completedReviewPhases: entry.to === 'applying' && !projection.completedReviewPhases.includes('prepare')
        ? [...projection.completedReviewPhases, 'prepare']
        : projection.completedReviewPhases,
      lastAtMs: event.atMs,
    }) as unknown as OperationProjection
  }
  if (entry.type === 'mutation-observed') {
    if (!['applying', 'verifying', 'rolling-back'].includes(projection.phase)) {
      failDomain('journal-transition', `mutation observation is invalid during ${projection.phase}`)
    }
    return immutableJsonClone({
      ...projection,
      mutationDigests: [...projection.mutationDigests, entry.mutationDigest],
      completedReviewPhases: projection.completedReviewPhases.includes('apply')
        ? projection.completedReviewPhases
        : [...projection.completedReviewPhases, 'apply'],
      lastAtMs: event.atMs,
    }) as unknown as OperationProjection
  }
  if (entry.type === 'verification-observed') {
    if (!['verifying', 'rolling-back'].includes(projection.phase)) {
      failDomain('journal-transition', `verification observation is invalid during ${projection.phase}`)
    }
    return immutableJsonClone({
      ...projection,
      verificationDigests: [...projection.verificationDigests, entry.verificationDigest],
      completedReviewPhases: [
        ...projection.completedReviewPhases,
        ...(!projection.completedReviewPhases.includes('verify') ? ['verify' as const] : []),
        ...(projection.planEvidence.restartRequired && !projection.completedReviewPhases.includes('external-restart')
          ? ['external-restart' as const]
          : []),
      ],
      lastAtMs: event.atMs,
    }) as unknown as OperationProjection
  }
  if (!TERMINAL_PHASES.includes(projection.phase as OperationOutcome)) {
    failDomain('journal-transition', 'receipt requires a terminal operation')
  }
  const checkpoint: JournalCheckpoint = {
    eventCount: event.sequence - 1,
    headDigest: event.previousDigest ?? failDomain('journal-corrupt', 'receipt event has no previous digest'),
  }
  const expected = receiptBody(projection, checkpoint, entry.receipt.body.issuedAtMs)
  if (entry.receipt.body.issuedAtMs !== event.atMs || canonicalSha256(expected) !== entry.receipt.digest) {
    failDomain('journal-corrupt', 'receipt does not match the terminal journal prefix')
  }
  return immutableJsonClone({ ...projection, lastAtMs: event.atMs, receipt: entry.receipt }) as unknown as OperationProjection
}

function projectJournal(journal: OperationJournal): OperationProjection {
  let previousDigest: Sha256Digest | null = null
  let previousAtMs = 0
  let projection: OperationProjection | null = null
  for (const [index, event] of journal.events.entries()) {
    const expectedSequence = index + 1
    if (
      event.operationId !== journal.operationId
      || event.targetKey !== journal.targetKey
      || event.sequence !== expectedSequence
      || event.previousDigest !== previousDigest
    ) {
      failDomain('journal-corrupt', `journal link mismatch at event ${expectedSequence}`)
    }
    if (index > 0 && event.atMs < previousAtMs) {
      failDomain('journal-corrupt', `journal time moved backwards at event ${expectedSequence}`)
    }
    if (canonicalSha256(unsignedEvent(event)) !== event.digest) {
      failDomain('journal-corrupt', `journal digest mismatch at event ${expectedSequence}`)
    }
    projection = applyEntry(projection, event)
    previousDigest = event.digest
    previousAtMs = event.atMs
  }
  if (projection === null) failDomain('journal-corrupt', 'journal is empty')
  return projection
}

/**
 * Return the exact head of a non-empty verified journal.
 *
 * @param value Typed or serialized operation journal.
 * @returns Event-count and head-digest checkpoint.
 */
export function operationJournalCheckpoint(value: unknown): JournalCheckpoint {
  const journal = decodeJournal(value)
  projectJournal(journal)
  const head = journal.events[journal.events.length - 1]!
  return Object.freeze({ eventCount: journal.events.length, headDigest: head.digest })
}

/**
 * Verify a digest-linked journal and optionally require its externally anchored head.
 *
 * @param value Typed or serialized operation journal.
 * @param expectedCheckpoint Optional externally anchored final head.
 * @returns Pure reconstructed operation projection.
 */
export function verifyOperationJournal(
  value: unknown,
  expectedCheckpoint?: JournalCheckpoint,
): OperationProjection {
  const journal = decodeJournal(value)
  const projection = projectJournal(journal)
  if (expectedCheckpoint !== undefined) {
    const eventCount = readNonNegativeInteger(expectedCheckpoint.eventCount, 'checkpoint.eventCount')
    const headDigest = readSha256Digest(expectedCheckpoint.headDigest, 'checkpoint.headDigest')
    if (journal.events.length < eventCount) failDomain('journal-truncated', 'journal is shorter than its anchored head')
    if (journal.events.length !== eventCount || journal.events[eventCount - 1]?.digest !== headDigest) {
      failDomain('journal-corrupt', 'journal does not match its anchored head')
    }
  }
  return projection
}

function appendEntry(
  value: unknown,
  entryValue: unknown,
  atValue: number,
): OperationJournal {
  const journal = decodeJournal(value)
  const projection = projectJournal(journal)
  const entry = decodeEntry(entryValue)
  const atMs = readNonNegativeInteger(atValue, 'atMs')
  if (atMs < projection.lastAtMs) failDomain('journal-corrupt', 'journal append time moved backwards')
  const previous = journal.events[journal.events.length - 1]!
  const unsigned = {
    schemaVersion: OPERATION_RECORD_SCHEMA_VERSION,
    operationId: journal.operationId,
    targetKey: journal.targetKey,
    sequence: journal.events.length + 1,
    previousDigest: previous.digest,
    atMs,
    entry,
  }
  const event = immutableJsonClone({ ...unsigned, digest: canonicalSha256(unsigned) }) as unknown as OperationJournalEvent
  const appended = immutableJsonClone({ ...journal, events: [...journal.events, event] }) as unknown as OperationJournal
  projectJournal(appended)
  return appended
}

/**
 * Start an in-memory journal from one consumed plan authorization.
 *
 * @param authorizationValue Consumed operation authorization.
 * @param beforeDigestValue Authoritative before-state digest.
 * @param atValue Trusted current time in epoch milliseconds.
 * @returns Journal containing its immutable opening event.
 */
export function createOperationJournal(
  authorizationValue: OperationAuthorization,
  beforeDigestValue: unknown,
  atValue: number,
): OperationJournal {
  const authorization = decodeOperationAuthorization(authorizationValue)
  const beforeDigest = readSha256Digest(beforeDigestValue, 'beforeDigest')
  const atMs = readNonNegativeInteger(atValue, 'atMs')
  const entry: OperationJournalEntry = {
    type: 'operation-opened',
    planId: authorization.planId,
    planHash: authorization.planHash,
    operationKind: authorization.operationKind,
    managedObject: authorization.managedObject,
    externalRuntimeAction: authorization.externalRuntimeAction,
    runtimeBinding: authorization.runtimeBinding,
    planEvidence: {
      origin: authorization.origin,
      candidateRef: authorization.candidateRef,
      extensionKind: authorization.extensionKind,
      extensionId: authorization.extensionId,
      artifactRevision: authorization.artifactRevision,
      artifactIntegrity: authorization.artifactIntegrity,
      artifactUrl: authorization.artifactUrl,
      artifactSizeBytes: authorization.artifactSizeBytes,
      desiredState: authorization.desiredState,
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
      recoveryExecutable: authorization.recoveryExecutable,
    },
    beforeDigest,
  }
  const unsigned = {
    schemaVersion: OPERATION_RECORD_SCHEMA_VERSION,
    operationId: authorization.operationId,
    targetKey: authorization.targetKey,
    sequence: 1,
    previousDigest: null,
    atMs,
    entry,
  }
  const event = immutableJsonClone({ ...unsigned, digest: canonicalSha256(unsigned) }) as unknown as OperationJournalEvent
  const journal = immutableJsonClone({
    schemaVersion: OPERATION_RECORD_SCHEMA_VERSION,
    operationId: authorization.operationId,
    targetKey: authorization.targetKey,
    events: [event],
  }) as unknown as OperationJournal
  projectJournal(journal)
  return journal
}

/**
 * Append one allowed operation phase transition.
 *
 * @param journal Current verified journal.
 * @param to Target phase.
 * @param evidenceDigest Final owner evidence for terminal phases, otherwise null.
 * @param reason Bounded failure reason where required.
 * @param atMs Trusted current time in epoch milliseconds.
 * @returns New immutable journal.
 */
export function transitionOperation(
  journal: OperationJournal,
  to: OperationPhase,
  evidenceDigest: Sha256Digest | null,
  reason: string | null,
  atMs: number,
): OperationJournal {
  const projection = verifyOperationJournal(journal)
  return appendEntry(journal, {
    type: 'phase-transition',
    from: projection.phase,
    to,
    evidenceDigest,
    reason,
  }, atMs)
}

/**
 * Append one digest-only target mutation observation.
 *
 * @param journal Current verified journal.
 * @param mutationDigest Exact mutation digest.
 * @param atMs Trusted current time in epoch milliseconds.
 * @returns New immutable journal.
 */
export function recordOperationMutation(
  journal: OperationJournal,
  mutationDigest: Sha256Digest,
  atMs: number,
): OperationJournal {
  return appendEntry(journal, { type: 'mutation-observed', mutationDigest }, atMs)
}

/**
 * Append one authoritative verification observation.
 *
 * @param journal Current verified journal.
 * @param verificationDigest Exact owner evidence digest.
 * @param atMs Trusted current time in epoch milliseconds.
 * @returns New immutable journal.
 */
export function recordOperationVerification(
  journal: OperationJournal,
  verificationDigest: Sha256Digest,
  atMs: number,
): OperationJournal {
  return appendEntry(journal, { type: 'verification-observed', verificationDigest }, atMs)
}

/**
 * Derive and append the only receipt for a terminal operation.
 *
 * @param journal Current verified terminal journal.
 * @param atMs Trusted receipt time in epoch milliseconds.
 * @returns New journal and its immutable receipt.
 */
export function issueOperationReceipt(
  journal: OperationJournal,
  atMs: number,
): Readonly<{ journal: OperationJournal; receipt: OperationReceipt }> {
  const projection = verifyOperationJournal(journal)
  if (projection.receipt !== null) failDomain('journal-transition', 'operation receipt was already issued')
  const issuedAtMs = readNonNegativeInteger(atMs, 'atMs')
  if (issuedAtMs < projection.lastAtMs) failDomain('journal-corrupt', 'receipt time moved backwards')
  const checkpoint = operationJournalCheckpoint(journal)
  const body = receiptBody(projection, checkpoint, issuedAtMs)
  const receipt = decodeOperationReceipt({ body, digest: canonicalSha256(body) })
  const appended = appendEntry(journal, { type: 'receipt-issued', receipt }, issuedAtMs)
  return Object.freeze({ journal: appended, receipt })
}
