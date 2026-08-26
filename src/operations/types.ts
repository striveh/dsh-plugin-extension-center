import type { ArtifactIntegrity, Sha256Digest } from '../domain/json.ts'
import type {
  DesiredState,
  ExternalRuntimeAction,
  ManagedExtensionKind,
  ManagedObject,
  OperationKind,
  PlanReviewEvidence,
  PlannedReviewCheck,
  PlanRevisionFences,
  RecoveryExecutableBinding,
  RuntimeBinding,
} from '../plans/types.ts'

/** Current operation journal and receipt schema. */
export const OPERATION_RECORD_SCHEMA_VERSION = 1 as const

/** Pure operation phases; only the published transition table can change them. */
export type OperationPhase =
  | 'authorized'
  | 'staging'
  | 'applying'
  | 'verifying'
  | 'rolling-back'
  | 'committed'
  | 'rolled-back'
  | 'failed'
  | 'recovery-required'

/** Terminal operation outcomes recorded in receipts. */
export type OperationOutcome = 'committed' | 'rolled-back' | 'failed'

/** Secret-free immutable plan facts copied into the consumed authorization and receipt. */
export interface OperationPlanEvidence {
  readonly origin: 'store' | 'task'
  readonly candidateRef: string
  readonly extensionKind: ManagedExtensionKind
  readonly extensionId: string
  readonly artifactRevision: string
  readonly artifactIntegrity: ArtifactIntegrity
  readonly artifactUrl: string
  readonly artifactSizeBytes: number
  readonly desiredState: DesiredState
  readonly ownerKey: string
  readonly scopeKey: string
  readonly profileId: string
  readonly idempotencyKey: string
  readonly authorityDigest: Sha256Digest
  readonly configurationDigest: Sha256Digest
  readonly retentionDigest: Sha256Digest
  readonly mutationDigest: Sha256Digest
  readonly verificationDigest: Sha256Digest
  readonly reviewEvidence: PlanReviewEvidence
  readonly restartRequired: boolean
  readonly fences: PlanRevisionFences
  readonly recoveryExecutable: RecoveryExecutableBinding
}

/** Whether a receipt proves, does not require, or cannot prove one lifecycle claim. */
export type OperationEvidenceStatus = 'proven' | 'not-required' | 'not-proven'

/** Lifecycle claims explicitly called out when terminal evidence is incomplete. */
export type OperationNotProvenClaim = 'mutation' | 'verification' | 'rollback' | 'restart' | 'recovery'

/** Honest terminal evidence summary derived only from the verified journal prefix. */
export interface OperationReceiptEvidence {
  /** Planned checks that completed successfully in the authenticated journal prefix. */
  readonly checksActuallyRun: readonly PlannedReviewCheck[]
  readonly mutation: OperationEvidenceStatus
  readonly verification: OperationEvidenceStatus
  readonly rollback: Readonly<{ attempted: boolean; status: OperationEvidenceStatus }>
  readonly restart: Readonly<{ required: boolean; status: OperationEvidenceStatus }>
  readonly recovery: Readonly<{ attempts: number; status: OperationEvidenceStatus }>
  readonly notProven: readonly OperationNotProvenClaim[]
}

/** First entry binding an operation to one consumed plan and before-state digest. */
export interface OperationOpenedEntry {
  readonly type: 'operation-opened'
  readonly planId: string
  readonly planHash: Sha256Digest
  readonly operationKind: OperationKind
  readonly managedObject: ManagedObject
  readonly externalRuntimeAction: ExternalRuntimeAction
  readonly runtimeBinding: RuntimeBinding | null
  readonly planEvidence: OperationPlanEvidence
  readonly beforeDigest: Sha256Digest
}

/** One allowed operation phase transition and its owner evidence. */
export interface OperationPhaseTransitionEntry {
  readonly type: 'phase-transition'
  readonly from: OperationPhase
  readonly to: OperationPhase
  readonly evidenceDigest: Sha256Digest | null
  readonly reason: string | null
}

/** Digest-only observation that an authorized target mutation occurred. */
export interface OperationMutationEntry {
  readonly type: 'mutation-observed'
  readonly mutationDigest: Sha256Digest
}

/** Digest-only observation returned by the authoritative owner verification. */
export interface OperationVerificationEntry {
  readonly type: 'verification-observed'
  readonly verificationDigest: Sha256Digest
}

/** Immutable receipt fields derived from a terminal journal prefix. */
export interface OperationReceiptBody {
  readonly schemaVersion: typeof OPERATION_RECORD_SCHEMA_VERSION
  readonly operationId: string
  readonly planId: string
  readonly planHash: Sha256Digest
  readonly operationKind: OperationKind
  readonly managedObject: ManagedObject
  readonly externalRuntimeAction: ExternalRuntimeAction
  readonly runtimeBinding: RuntimeBinding | null
  readonly planEvidence: OperationPlanEvidence
  readonly targetKey: string
  readonly outcome: OperationOutcome
  readonly beforeDigest: Sha256Digest
  readonly afterDigest: Sha256Digest | null
  readonly mutationDigests: readonly Sha256Digest[]
  readonly verificationDigests: readonly Sha256Digest[]
  readonly evidence: OperationReceiptEvidence
  readonly journalEventCount: number
  readonly journalHeadDigest: Sha256Digest
  readonly issuedAtMs: number
}

/** One content-addressed terminal operation receipt. */
export interface OperationReceipt {
  readonly body: OperationReceiptBody
  readonly digest: Sha256Digest
}

/** Journal entry that appends a receipt without changing the terminal outcome. */
export interface OperationReceiptIssuedEntry {
  readonly type: 'receipt-issued'
  readonly receipt: OperationReceipt
}

/** Closed set of append-only operation journal entries. */
export type OperationJournalEntry =
  | OperationOpenedEntry
  | OperationPhaseTransitionEntry
  | OperationMutationEntry
  | OperationVerificationEntry
  | OperationReceiptIssuedEntry

/** One digest-linked event in an operation journal. */
export interface OperationJournalEvent {
  readonly schemaVersion: typeof OPERATION_RECORD_SCHEMA_VERSION
  readonly operationId: string
  readonly targetKey: string
  readonly sequence: number
  readonly previousDigest: Sha256Digest | null
  readonly atMs: number
  readonly entry: OperationJournalEntry
  readonly digest: Sha256Digest
}

/** One in-memory append-only journal for an exact operation and target. */
export interface OperationJournal {
  readonly schemaVersion: typeof OPERATION_RECORD_SCHEMA_VERSION
  readonly operationId: string
  readonly targetKey: string
  readonly events: readonly OperationJournalEvent[]
}

/** Externally anchored journal head used to detect a valid-prefix truncation. */
export interface JournalCheckpoint {
  readonly eventCount: number
  readonly headDigest: Sha256Digest
}

/** Pure projection reconstructed from a verified journal. */
export interface OperationProjection {
  readonly operationId: string
  readonly targetKey: string
  readonly planId: string
  readonly planHash: Sha256Digest
  readonly operationKind: OperationKind
  readonly managedObject: ManagedObject
  readonly externalRuntimeAction: ExternalRuntimeAction
  readonly runtimeBinding: RuntimeBinding | null
  readonly planEvidence: OperationPlanEvidence
  readonly phase: OperationPhase
  readonly beforeDigest: Sha256Digest
  readonly afterDigest: Sha256Digest | null
  readonly mutationDigests: readonly Sha256Digest[]
  readonly verificationDigests: readonly Sha256Digest[]
  readonly rollbackAttempted: boolean
  readonly recoveryAttempts: number
  readonly completedReviewPhases: readonly ('planning' | 'prepare' | 'apply' | 'verify' | 'external-restart')[]
  readonly lastAtMs: number
  readonly receipt: OperationReceipt | null
}

/** One held pure-memory serialization lease. */
export interface TargetLease {
  readonly targetKey: string
  readonly operationId: string
}

/** Immutable set of per-target operation leases. */
export interface TargetLockState {
  readonly leases: readonly TargetLease[]
}
