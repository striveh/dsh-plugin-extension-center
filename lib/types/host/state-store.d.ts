import type { AcquisitionIntent } from '../policy/index.ts';
import type { ManagedExtensionKind, OperationKind } from '../plans/index.ts';
import type { OperationPhase } from '../operations/index.ts';
import type { RpcJson } from '../service/rpc-contract.ts';
/** Exact materialized version controlled by the center. */
export interface ManagedVersion {
    readonly candidateRef: string;
    readonly artifactRevision: string;
    readonly artifactIntegrity: string;
    readonly materialPath: string;
    readonly configuration: RpcJson;
    readonly enabled: boolean;
    readonly ownerRevision: string;
    readonly kindState: RpcJson;
}
/** Durable center-owned target state with one named recovery point. */
export interface ManagedTargetRecord {
    readonly schemaVersion: 1;
    readonly kind: ManagedExtensionKind;
    readonly extensionId: string;
    readonly targetKey: string;
    readonly scopeKey: string;
    readonly profileId: string;
    readonly revision: number;
    readonly lastOperationId: string | null;
    readonly current: ManagedVersion | null;
    readonly lastGood: ManagedVersion | null;
    readonly removed: ManagedVersion | null;
    readonly pending: RpcJson | null;
    readonly updatedAtMs: number;
}
/** Exact mutation payload kept outside the model-visible immutable plan. */
export interface LifecyclePayload {
    readonly configuration: RpcJson;
    readonly continuationId: string | null;
    readonly resolutionId: string | null;
    readonly verificationPayloadDigest: string | null;
    readonly taskSessionId: string | null;
    readonly taskOriginalMessageId: string | null;
}
/** Durable binding between an intent, its payload, and one immutable plan hash. */
export interface StoredIntent {
    readonly schemaVersion: 1;
    readonly intent: AcquisitionIntent;
    readonly payload: LifecyclePayload;
    readonly planHash: string;
}
/** Opaque model resolution retained only on the Host. */
export interface StoredResolution {
    readonly schemaVersion: 1;
    readonly resolutionId: string;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
    readonly needDigest: string;
    readonly decision: string;
    readonly candidateRefs: readonly string[];
    readonly value: RpcJson;
}
/** Durable operation index used without weakening the journal's authority. */
export interface StoredOperationIndex {
    readonly schemaVersion: 1;
    readonly operationId: string;
    readonly planHash: string;
    readonly targetKey: string;
    readonly extensionKind: ManagedExtensionKind;
    readonly operationKind: OperationKind;
    readonly phase: OperationPhase;
    readonly lastAtMs: number;
}
/** Exact pre-mutation provider state needed to rollback after process death. */
export interface StoredProviderSnapshot {
    readonly schemaVersion: 1;
    readonly operationId: string;
    readonly targetKey: string;
    readonly before: ManagedTargetRecord | null;
    readonly beforeDigest: string;
    readonly recoveryPoint: RpcJson;
}
/** External boot acknowledgement bound to one Profile generation operation. */
export interface StoredProfileBootAck {
    readonly schemaVersion: 1;
    readonly operationId: string;
    readonly profileId: string;
    readonly generation: string;
    readonly phase: 'candidate' | 'rollback';
    readonly revision: number;
    readonly treeDigest: string;
    readonly consumerObserved: true;
    readonly acknowledgedAtMs: number;
}
/** Separate task-completion receipt consumed only by the continuation verifier. */
export interface StoredTaskReceipt {
    readonly schemaVersion: 1;
    readonly continuationId: string;
    readonly resolutionId: string;
    readonly verificationPayloadDigest: string;
    readonly planHash: string;
    readonly operationId: string;
    readonly operationReceiptDigest: string;
    readonly completedAtMs: number;
}
/** Durable reservation-to-claim binding created only after a human approval. */
export interface StoredContinuationActivation {
    readonly schemaVersion: 1;
    readonly reservationId: string;
    readonly continuationId: string;
    readonly resolutionId: string;
    readonly planHash: string;
    readonly sessionId: string;
    readonly originalMessageId: string;
    readonly needDigest: string;
    readonly taskRevision: string;
    readonly verificationPayloadDigest: string;
    readonly createdAtMs: number;
}
/** Durable claim-creation intent written only after the exact plan is approved. */
export interface StoredContinuationActivationIntent {
    readonly schemaVersion: 1;
    readonly reservationId: string;
    readonly callerId: 'extension-center';
    readonly mutationId: string;
    readonly resolutionId: string;
    readonly planHash: string;
    readonly sessionId: string;
    readonly originalMessageId: string;
    readonly needDigest: string;
    readonly taskRevision: string;
    readonly verificationPayloadDigest: string;
    readonly resumeAgentOptions: Readonly<{
        readonly provider?: string;
        readonly model?: string;
        readonly maxTokens?: number;
    }>;
    readonly expiresAtMs: number;
    readonly createdAtMs: number;
}
/** File-backed center manifest and per-identity durable records. */
export declare class CenterStateStore {
    readonly root: string;
    constructor(root: string);
    /** Initialize the private root and its single-assignment identity manifest. */
    initialize(nowMs?: number): Promise<void>;
    /** Load one managed target. */
    getManaged(targetKey: string): Promise<ManagedTargetRecord | undefined>;
    /** Replace one target after checking its center revision. */
    putManaged(record: ManagedTargetRecord, expectedRevision: number): Promise<void>;
    /** Remove an exact managed record only when its revision still matches. */
    deleteManaged(targetKey: string, expectedRevision: number): Promise<void>;
    /** Enumerate center-owned target records deterministically. */
    listManaged(): Promise<readonly ManagedTargetRecord[]>;
    /** Persist one immutable intent binding exactly once. */
    putIntent(value: StoredIntent): Promise<void>;
    /** Read an intent by identity. */
    getIntent(intentId: string): Promise<StoredIntent | undefined>;
    /** Persist one opaque resolution exactly once. */
    putResolution(value: StoredResolution): Promise<void>;
    /** Read one opaque resolution. */
    getResolution(resolutionId: string): Promise<StoredResolution | undefined>;
    /** List Host-only task resolutions deterministically. */
    listResolutions(): Promise<readonly StoredResolution[]>;
    /** Replace the non-authoritative operation lookup row. */
    putOperationIndex(value: StoredOperationIndex): Promise<void>;
    /** List operation lookup rows; callers re-read journals before trusting phase fields. */
    listOperationIndexes(): Promise<readonly StoredOperationIndex[]>;
    /** Persist the exact provider recovery point before entering applying. */
    putProviderSnapshot(value: StoredProviderSnapshot): Promise<void>;
    /** Read one exact provider recovery point. */
    getProviderSnapshot(operationId: string): Promise<StoredProviderSnapshot | undefined>;
    /** Persist or idempotently replace an exact external boot acknowledgement. */
    putBootAck(value: StoredProfileBootAck): Promise<void>;
    /** Read one external boot acknowledgement. */
    getBootAck(operationId: string): Promise<StoredProfileBootAck | undefined>;
    /** Persist the single verified lifecycle result that may release one parked task. */
    putTaskReceipt(value: StoredTaskReceipt): Promise<void>;
    /** Read the verified lifecycle result for one continuation claim. */
    getTaskReceipt(continuationId: string): Promise<StoredTaskReceipt | undefined>;
    /** Persist the actual continuation claim bound to an approved plan reservation. */
    putContinuationActivation(value: StoredContinuationActivation): Promise<void>;
    /** Read an approved plan's reservation-to-claim binding. */
    getContinuationActivation(reservationId: string): Promise<StoredContinuationActivation | undefined>;
    /** Persist the approved claim-creation intent before touching the continuation owner. */
    putContinuationActivationIntent(value: StoredContinuationActivationIntent): Promise<void>;
    /** Read an approved claim-creation intent during cold reconciliation. */
    getContinuationActivationIntent(reservationId: string): Promise<StoredContinuationActivationIntent | undefined>;
    private path;
    private putExclusive;
    private auditDurableState;
    private listDirectory;
}
//# sourceMappingURL=state-store.d.ts.map
