import type { VerifiedCatalog } from '../catalog.ts';
import type { HostOwners } from '../host/index.ts';
import { CenterStateStore } from '../host/index.ts';
import { FileOperationStore, FilePlanStore } from '../storage/index.ts';
import { FileTaskAttemptStore, type TaskAttemptProjection } from '../task-attempt/index.ts';
import type { IntentPreviewResponse, RpcJson, TaskAttemptResolutionResponse, TaskConfigurationRow } from './rpc-contract.ts';
import { HOST_RPC_PROTOCOL_VERSION } from './rpc-contract.ts';
import type { IntentPlanService } from './intent-plan-service.ts';
import { HostInventoryService } from './inventory-service.ts';
declare const MODALITIES: readonly ["audio", "file", "image", "structured-data", "text", "video"];
declare const DATA_ACCESS: readonly ["filesystem-read", "filesystem-write", "network", "subprocess"];
declare const AUTHORITY: readonly ["credentials", "filesystem-read", "filesystem-write", "model-context", "network", "subprocess"];
/** Package-scoped model tool that resolves current or admitted capabilities. */
export declare const EXTENSION_CENTER_RESOLVE_TOOL_NAME = "extension_center_resolve";
/** Package-scoped model tool that creates a reviewable acquisition request. */
export declare const EXTENSION_CENTER_REQUEST_TOOL_NAME = "extension_center_request_acquisition";
/** Strict model input for local existing-first capability retrieval. */
export interface ModelCapabilityNeed {
    readonly outcomeTags: readonly string[];
    readonly inputModalities: readonly (typeof MODALITIES)[number][];
    readonly outputModalities: readonly (typeof MODALITIES)[number][];
    readonly scopeKey: 'profile:web' | 'user' | 'project';
    readonly profileId: string;
    readonly requiredDataAccess: readonly (typeof DATA_ACCESS)[number][];
    readonly maximumAuthority: readonly (typeof AUTHORITY)[number][];
}
/** Safe, prose-free result returned to the model. */
export interface ModelCapabilityResolution extends TaskAttemptResolutionResponse {
}
/** Opaque-only request accepted by the acquisition tool. */
export interface ModelAcquisitionRequest {
    readonly resolutionId: string;
    readonly candidateRef: string;
    readonly continuationId: string;
}
/** Safe immutable-plan projection; it never records a human decision. */
export interface ModelAcquisitionResult {
    readonly protocolVersion: typeof HOST_RPC_PROTOCOL_VERSION;
    readonly resolutionId: string;
    readonly continuationId: string;
    readonly candidateRef: string;
    readonly planId: string;
    readonly planHash: string;
    readonly operationKind: string;
    readonly status: 'approval-required';
}
/** Existing-first local retrieval, opaque acquisition planning, and continuation verification. */
export declare class CapabilityAcquisitionService {
    private readonly state;
    private readonly inventory;
    private readonly intentPlans;
    private readonly plans;
    private readonly operations;
    private readonly owners;
    private readonly catalog;
    private readonly ttlMs;
    private readonly taskAttempts;
    private readonly volatileResolutions;
    private taskAttemptInitialization;
    private continuationReconciliationRequested;
    private continuationReconciliation;
    constructor(state: CenterStateStore, inventory: HostInventoryService, intentPlans: IntentPlanService, plans: FilePlanStore, operations: FileOperationStore, owners: HostOwners, catalog: () => VerifiedCatalog, ttlMs?: number, taskAttempts?: FileTaskAttemptStore);
    /** Resolve current capabilities first, then the verified local catalog without exposing catalog prose. */
    resolve(value: unknown, agent: unknown, signal: AbortSignal): Promise<ModelCapabilityResolution>;
    /** Turn one terminal human choice into a new candidate-bound attempt without granting approval. */
    selectTaskCandidate(taskAttemptId: string, candidateRef: string, signal: AbortSignal): Promise<ModelCapabilityResolution>;
    /** Retry a terminal management handoff as a new existing-first attempt for the original message. */
    retryOriginalTask(taskAttemptId: string, signal: AbortSignal): Promise<ModelCapabilityResolution>;
    /** Cancel one mutable task attempt without changing an already committed extension operation. */
    cancelTaskAttempt(taskAttemptId: string): Promise<TaskAttemptProjection>;
    /** List durable task attempts, expiring mutable records before projection. */
    listTaskAttempts(nowMs?: number): Promise<readonly TaskAttemptProjection[]>;
    private evaluateAttempt;
    /** Mint a task-origin immutable plan from three opaque bindings; never approve or execute it. */
    request(value: unknown, agent: unknown, signal: AbortSignal): Promise<ModelAcquisitionResult>;
    /** List expired-filtered task candidates that still require trusted typed configuration. */
    listConfigurationRequests(nowMs?: number, maximum?: number): Promise<readonly TaskConfigurationRow[]>;
    /** Mint one task plan after a trusted human supplies the exact typed MCP connection configuration. */
    configureTaskCandidate(input: Readonly<{
        resolutionId: string;
        candidateRef: string;
        continuationId: string;
        configuration: RpcJson;
    }>, nowMs?: number): Promise<IntentPreviewResponse>;
    /** Create the real Host continuation only after the trusted plan decision approved acquisition. */
    activateApprovedPlan(planHash: string): Promise<void>;
    /** Reconcile every approved task plan after Host restart without consuming it. */
    recoverApprovedPlans(signal?: AbortSignal): Promise<void>;
    /** Register the non-mutating verifier that releases only exact committed task receipts. */
    registerVerifier(): () => void;
    /** Bind a loopback plan decision to its independent task attempt. */
    assertPlanDecisionAllowed(planHash: string, decision: 'approve' | 'reject'): Promise<void>;
    /** Bind a loopback plan decision to its independent task attempt. */
    recordPlanDecision(planHash: string, decision: 'approve' | 'reject'): Promise<void>;
    /** Project operation progress without using it as the task's terminal outcome. */
    recordLifecycleResult(planHash: string, status: 'committed' | 'failed' | 'recovery-required' | 'restart-required' | 'rolled-back'): Promise<void>;
    private ensureTaskAttempts;
    private scheduleTaskContinuationReconciliation;
    private reconcileTaskContinuations;
    private runTaskContinuationReconciliation;
    private observeAcquisitionContinuationClaim;
    private agentForAttempt;
    private modelProjection;
    private projectAttempt;
    private rejectAttempt;
    private resolutionObservationIsCurrent;
    private markTaskVisibilityReady;
    private projectRetryContinuation;
    private observeRetryContinuationClaim;
    private ensureRetryContinuation;
    private verifyRetryContinuation;
    private cancelContinuation;
    private supersedeContinuation;
    private existing;
    private pruneVolatileResolutions;
    private resolutionCandidates;
}
/** Create the two strict model tool definitions without importing a newer Host package. */
export declare function capabilityToolDefinitions(service: CapabilityAcquisitionService): readonly unknown[];
export {};
//# sourceMappingURL=capability-service.d.ts.map
