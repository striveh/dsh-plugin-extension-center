import type { InventorySnapshot } from '../inventory/index.ts';
import type { LoadedOperation, StoredReceipt } from '../storage/index.ts';
import type { ImmutablePlan, OperationKind, PlanAuthorizationState } from '../plans/index.ts';
import type { CandidatePolicyResult } from '../policy/index.ts';
import type { OperationOutcome, OperationPhase, OperationReceipt } from '../operations/index.ts';
import type { TaskAttemptProjection } from '../task-attempt/index.ts';
/** Protocol carried by every Extension Center management request and response. */
export declare const HOST_RPC_PROTOCOL_VERSION: 1;
/** Strict JSON accepted in configuration fields. */
export type RpcJson = null | boolean | number | string | readonly RpcJson[] | {
    readonly [key: string]: RpcJson;
};
/** Dynamic acquisition availability derived from live Host owners. */
export interface HostCapabilityProjection {
    readonly managedPluginLifecycle: boolean;
    readonly dynamicMcpConnection: boolean;
    readonly durableContinuation: boolean;
    readonly skillRegistry: boolean;
    readonly toolRegistry: boolean;
    readonly loaderMutation: boolean;
    readonly acquisition: boolean;
    readonly reason: 'host-capability' | null;
}
/** Common version field on every RPC payload. */
export interface RpcVersioned {
    readonly protocolVersion: typeof HOST_RPC_PROTOCOL_VERSION;
}
/** Read the normalized inventory for one exact observation scope. */
export interface InventoryListRequest extends RpcVersioned {
    readonly scopeKey: string;
    readonly profileId: string;
}
/** Inventory response with current Host capability evidence. */
export interface InventoryListResponse extends RpcVersioned {
    readonly hostCapabilities: HostCapabilityProjection;
    readonly inventory: InventorySnapshot;
}
/** Re-read authoritative owner evidence for one exact inventory target. */
export interface InventoryVerifyRequest extends InventoryListRequest {
    readonly targetKey: string;
}
/** Verify is a read-only fresh inventory projection and never an operation receipt. */
export type InventoryVerifyResponse = InventoryListResponse;
/** Create and persist one immutable preview without authorizing mutation. */
export interface IntentPreviewRequest extends RpcVersioned {
    readonly origin: 'store' | 'task';
    readonly candidateRef: string;
    readonly operationKind: OperationKind;
    readonly scopeKey: string;
    readonly profileId: string;
    readonly continuationId: string | null;
    readonly targetKey: string | null;
    readonly configuration: RpcJson;
}
/** Durable intent and plan preview. */
export interface IntentPreviewResponse extends RpcVersioned {
    readonly intentId: string;
    readonly plan: ImmutablePlan;
    readonly policy: CandidatePolicyResult;
}
/** Read one plan by content hash. */
export interface PlanGetRequest extends RpcVersioned {
    readonly planHash: string;
}
/** Exact durable state of one plan, when present. */
export interface PlanGetResponse extends RpcVersioned {
    readonly state: PlanAuthorizationState | null;
}
/** List every durable plan. */
export type PlanListRequest = RpcVersioned;
/** Deterministic durable plan list. */
export interface PlanListResponse extends RpcVersioned {
    readonly states: readonly PlanAuthorizationState[];
}
/** Human-review projection for one task-origin immutable plan and its typed configuration. */
export interface TaskApprovalRow {
    readonly state: Extract<PlanAuthorizationState, {
        status: 'pending' | 'approved';
    }>;
    readonly configuration: RpcJson;
}
/** Opaque task candidate awaiting trusted typed MCP configuration before a plan can exist. */
export interface TaskConfigurationRow {
    readonly resolutionId: string;
    readonly candidateRef: string;
    readonly continuationId: string;
    readonly extensionKind: 'mcp';
    readonly scopeKey: string;
    readonly profileId: string;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
}
/** Bounded task-origin approval queue without session text or Agent state. */
export interface TaskApprovalListResponse extends RpcVersioned {
    readonly approvals: readonly TaskApprovalRow[];
    readonly configurations: readonly TaskConfigurationRow[];
}
/** Trusted typed configuration submission for one opaque task candidate. */
export interface TaskConfigurationRequest extends RpcVersioned {
    readonly resolutionId: string;
    readonly candidateRef: string;
    readonly continuationId: string;
    readonly configuration: RpcJson;
}
/** Task-origin immutable plan created after trusted configuration, still awaiting approval. */
export interface TaskConfigurationResponse extends IntentPreviewResponse {
    readonly resolutionId: string;
}
/** List every durable original-task capability attempt without raw task text. */
export type TaskAttemptListRequest = RpcVersioned;
/** Deterministic task-attempt history used by the ordinary-user Activity surface. */
export interface TaskAttemptListResponse extends RpcVersioned {
    readonly attempts: readonly TaskAttemptProjection[];
}
/** Select one exact candidate from a terminal choice-required attempt. */
export interface TaskAttemptSelectRequest extends RpcVersioned {
    readonly taskAttemptId: string;
    readonly candidateRef: string;
}
/** Retry the original task after a terminal management-required handoff. */
export interface TaskAttemptRetryRequest extends RpcVersioned {
    readonly taskAttemptId: string;
}
/** Cancel one mutable task attempt without changing its extension operation. */
export type TaskAttemptCancelRequest = TaskAttemptRetryRequest;
/** Strict candidate-resolution projection returned by task choice and retry actions. */
export interface TaskAttemptResolutionResponse extends RpcVersioned {
    readonly taskAttemptId: string;
    readonly resolutionId: string | null;
    readonly decision: 'use-existing' | 'management-required' | 'acquisition-candidate' | 'choice-required' | 'no-eligible-candidate' | 'discovery-unavailable';
    readonly needDigest: string;
    readonly existingCapabilityId: string | null;
    readonly candidateRefs: readonly string[];
    readonly continuationId: string | null;
    readonly extensionRef: string | null;
    readonly managementAction: 'configure' | 'enable' | 'restore' | 'update' | null;
    readonly next: 'use-existing' | 'request-acquisition' | 'human-choice' | 'unavailable';
}
/** Current durable task attempt after one explicit cancellation. */
export interface TaskAttemptCancelResponse extends RpcVersioned {
    readonly attempt: TaskAttemptProjection;
}
interface ConfigurationRuntimeOptionBase {
    readonly candidateRef: string;
    readonly runtimeRef: string;
    readonly version: string;
}
/** Exact preprovisioned stdio selector disclosed to the loopback management UI. */
export interface ConfigurationStdioRuntimeOption extends ConfigurationRuntimeOptionBase {
    readonly transport: 'stdio';
    readonly executablePath: string;
    readonly fixedArgs: readonly string[];
    readonly workingDirectory: string;
}
/** Exact preprovisioned unauthenticated HTTPS selector and egress disclosure. */
export interface ConfigurationHttpRuntimeOption extends ConfigurationRuntimeOptionBase {
    readonly transport: 'streamable-http';
    readonly origin: string;
    readonly endpoint: string;
    readonly authentication: 'none';
    readonly redirects: 'forbidden';
    readonly dataEgressDisclosure: string;
}
/** Safe exact selector; preview accepts only runtimeRef from this row. */
export type ConfigurationRuntimeOption = ConfigurationStdioRuntimeOption | ConfigurationHttpRuntimeOption;
/** Exact catalog or installed target whose safe typed options are requested. */
export interface ConfigurationOptionsRequest extends RpcVersioned {
    readonly candidateRef: string;
    readonly targetKey: string | null;
    readonly scopeKey: string;
    readonly profileId: string;
}
/** Bounded configuration selectors for one catalog candidate. */
export interface ConfigurationOptionsResponse extends RpcVersioned {
    readonly options: readonly ConfigurationRuntimeOption[];
    readonly currentConfiguration: RpcJson | null;
}
/** Human decision accepted only from the loopback-authorized RPC carrier. */
export interface PlanDecideRequest extends RpcVersioned {
    readonly planId: string;
    readonly planHash: string;
    readonly operationKind: OperationKind;
    readonly decision: 'approve' | 'reject';
}
/** Durable result of the single decision. */
export interface PlanDecideResponse extends RpcVersioned {
    readonly state: PlanAuthorizationState;
}
/** Consume one approved plan and run its exact lifecycle operation. */
export interface LifecycleRequest extends RpcVersioned {
    readonly planHash: string;
}
/** Current operation result; non-terminal restart or recovery states intentionally have no receipt. */
export interface LifecycleResponse extends RpcVersioned {
    readonly operationId: string;
    readonly status: OperationOutcome | 'restart-required' | 'recovery-required';
    readonly receipt: OperationReceipt | null;
}
/** Read one operation by opaque id. */
export interface OperationGetRequest extends RpcVersioned {
    readonly operationId: string;
}
/** Exact verified operation journal and projection, when present. */
export interface OperationGetResponse extends RpcVersioned {
    readonly operation: LoadedOperation | null;
}
/** List operation projections without journal bodies. */
export type OperationListRequest = RpcVersioned;
/** Bounded operation-list row. */
export interface OperationSummary {
    readonly operationId: string;
    readonly targetKey: string;
    readonly phase: OperationPhase;
    readonly operationKind: OperationKind;
    readonly lastAtMs: number;
    /** Exact secret-free standalone argv for recovery-required Plugin operations. */
    readonly recoveryCommand: readonly [string, string, string] | null;
    readonly recoveryNotice: 'journal-reconciliation-pending' | null;
}
/** Deterministic operation projection list. */
export interface OperationListResponse extends RpcVersioned {
    readonly operations: readonly OperationSummary[];
}
/** List terminal verified receipts. */
export type OperationReceiptsRequest = RpcVersioned;
/** Verified terminal receipts. */
export interface OperationReceiptsResponse extends RpcVersioned {
    readonly receipts: readonly StoredReceipt[];
}
/** Exact operation whose retained owner recovery point must be replayed. */
export type OperationRecoverRequest = OperationGetRequest;
/** Current state after one explicit fenced recovery attempt. */
export interface OperationRecoverResponse extends RpcVersioned {
    readonly operationId: string;
    readonly status: OperationOutcome | 'restart-required' | 'recovery-required';
    readonly receipt: OperationReceipt | null;
}
/** Names of the full-P0 private management endpoints. */
export type HostRpcEndpoint = 'catalog/list' | 'catalog/refresh' | 'inventory/list' | 'inventory/verify' | 'intent/preview' | 'plan/get' | 'plan/list' | 'plan/decide' | 'approval/list' | 'approval/configure' | 'task-attempt/list' | 'task-attempt/select' | 'task-attempt/retry' | 'task-attempt/cancel' | 'configuration/options' | 'lifecycle/request' | 'operation/get' | 'operation/list' | 'operation/receipts' | 'operation/recover';
export {};
//# sourceMappingURL=rpc-contract.d.ts.map
