import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import type { ImmutablePlan, PlanAuthorizationState } from '../plans/types.ts';
import type { IntentPreviewRequest, IntentPreviewResponse, InventoryListResponse, LifecycleResponse, OperationListResponse, OperationReceiptsResponse, ConfigurationOptionsResponse, RpcJson, TaskApprovalListResponse, TaskAttemptCancelResponse, TaskAttemptListResponse, TaskAttemptResolutionResponse, TaskConfigurationResponse } from '../service/rpc-contract.ts';
/** Current Browser observation context supplied by the Host composition. */
export interface ExtensionManagementContext {
    readonly profileId: string;
    readonly defaultScopeKey: string;
}
/** Exact Browser preview input; existing targets remain opaque inventory values. */
export type StorePreviewInput = Omit<IntentPreviewRequest, 'protocolVersion' | 'origin' | 'continuationId'>;
/** Browser client for loopback-only Extension Center management RPC. */
export interface ExtensionManagementClient {
    /** Read one normalized inventory observation. */
    inventory(scopeKey: string, profileId: string, signal?: AbortSignal): Promise<InventoryListResponse>;
    /** Explicitly refresh authoritative evidence for one exact target without minting a plan or receipt. */
    verify(scopeKey: string, profileId: string, targetKey: string, signal?: AbortSignal): Promise<InventoryListResponse>;
    /** Mint a non-authorizing Store plan preview. */
    preview(input: StorePreviewInput, signal?: AbortSignal): Promise<IntentPreviewResponse>;
    /** Read safe typed configuration selectors for one exact candidate or managed target. */
    configurationOptions(input: Readonly<{
        candidateRef: string;
        targetKey: string | null;
        scopeKey: string;
        profileId: string;
    }>, signal?: AbortSignal): Promise<ConfigurationOptionsResponse>;
    /** List task-origin plans awaiting review or exact approved-plan resumption. */
    taskApprovals(signal?: AbortSignal): Promise<TaskApprovalListResponse>;
    /** Submit typed human configuration for one opaque task candidate; this creates but does not approve its plan. */
    configureTask(input: Readonly<{
        resolutionId: string;
        candidateRef: string;
        continuationId: string;
        configuration: RpcJson;
    }>, signal?: AbortSignal): Promise<TaskConfigurationResponse>;
    /** List durable task attempts separately from extension operation history. */
    taskAttempts(signal?: AbortSignal): Promise<TaskAttemptListResponse>;
    /** Turn one terminal human choice into a new, non-authorizing task attempt. */
    selectTaskCandidate(taskAttemptId: string, candidateRef: string, signal?: AbortSignal): Promise<TaskAttemptResolutionResponse>;
    /** Retry the original message through existing-first resolution after management. */
    retryOriginalTask(taskAttemptId: string, signal?: AbortSignal): Promise<TaskAttemptResolutionResponse>;
    /** Cancel one mutable task attempt without changing any extension operation. */
    cancelTaskAttempt(taskAttemptId: string, signal?: AbortSignal): Promise<TaskAttemptCancelResponse>;
    /** Reconcile one exact immutable plan after an uncertain decision or lifecycle response. */
    plan(planHash: string, signal?: AbortSignal): Promise<PlanAuthorizationState | null>;
    /** Record one explicit human decision for the exact plan. */
    decide(plan: ImmutablePlan, decision: 'approve' | 'reject', signal?: AbortSignal): Promise<PlanAuthorizationState>;
    /** Consume one approved plan and start its lifecycle operation. */
    execute(planHash: string, signal?: AbortSignal): Promise<LifecycleResponse>;
    /** Retry the fenced rollback for one exact recovery-required operation. */
    recover(operationId: string, signal?: AbortSignal): Promise<LifecycleResponse>;
    /** List verified operation projections. */
    operations(signal?: AbortSignal): Promise<OperationListResponse>;
    /** List verified terminal receipts. */
    receipts(signal?: AbortSignal): Promise<OperationReceiptsResponse>;
}
/** Compute the canonical digest shown for one staged configuration payload. */
export declare function configurationDigest(value: RpcJson): Promise<string>;
/** Strictly validate an inventory/list response and recompute its canonical revision. */
export declare function parseInventoryListResponse(value: unknown): Promise<InventoryListResponse>;
/** Strictly validate an intent/preview response and recompute its plan hash. */
export declare function parseIntentPreviewResponse(value: unknown): Promise<IntentPreviewResponse>;
/** Strictly validate task approval rows and their exact typed configuration. */
export declare function parseTaskApprovalListResponse(value: unknown): Promise<TaskApprovalListResponse>;
/** Strictly validate the durable task-attempt activity projection. */
export declare function parseTaskAttemptListResponse(value: unknown): TaskAttemptListResponse;
/** Strictly validate a non-authorizing task choice or Retry-original resolution. */
export declare function parseTaskAttemptResolutionResponse(value: unknown): TaskAttemptResolutionResponse;
/** Strictly validate safe MCP selectors and current Center-owned configuration. */
export declare function parseConfigurationOptionsResponse(value: unknown): ConfigurationOptionsResponse;
/** Strictly validate an operation/list response. */
export declare function parseOperationListResponse(value: unknown): OperationListResponse;
/** Strictly validate an operation/receipts response and every receipt digest. */
export declare function parseOperationReceiptsResponse(value: unknown): Promise<OperationReceiptsResponse>;
/** Create a stateless, strict management client over the Connection carrier. */
export declare function createExtensionManagementClient(rpc: ClientConnectionRpc): ExtensionManagementClient;
/** Parse one JSON configuration draft into the strict RPC JSON subset. */
export declare function parseConfigurationDraft(text: string): RpcJson;
//# sourceMappingURL=management-api.d.ts.map
