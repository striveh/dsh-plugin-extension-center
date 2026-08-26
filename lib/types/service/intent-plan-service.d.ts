import type { CatalogEntry } from '../catalog-contract.ts';
import type { VerifiedCatalog } from '../catalog.ts';
import type { HostOwners, ManagedTargetRecord } from '../host/index.ts';
import { CenterStateStore } from '../host/index.ts';
import { type DesiredState, type ImmutablePlan, type OperationKind, type PlanUseContext } from '../plans/index.ts';
import { type CandidatePolicyResult } from '../policy/index.ts';
import { type McpRuntimePreflight, type McpRuntimeOption } from '../providers/index.ts';
import { FilePlanStore } from '../storage/index.ts';
import type { IntentPreviewRequest, IntentPreviewResponse, RpcJson, TaskApprovalRow } from './rpc-contract.ts';
import { HostInventoryService } from './inventory-service.ts';
/** Admission refusal that retains the exact policy result for strict RPC projection. */
export declare class IntentPolicyDeniedError extends Error {
    readonly policy: Extract<CandidatePolicyResult, {
        status: 'denied';
    }>;
    constructor(policy: Extract<CandidatePolicyResult, {
        status: 'denied';
    }>);
}
/** Candidate-specific preflight that performs no acquisition or desired-state mutation. */
export interface IntentProviderPreflight {
    mcpRuntime(candidateRef: string, configuration: RpcJson): Promise<McpRuntimePreflight | null>;
    mcpOptions(candidateRef: string): Promise<readonly McpRuntimeOption[]>;
}
/** Host-only task binding produced by the resolution/continuation service. */
export interface TaskIntentBinding {
    readonly resolutionId: string;
    readonly verificationPayloadDigest: string;
    readonly intentId: string;
    readonly planId: string;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
    readonly sessionId: string;
    readonly originalMessageId: string;
}
/** Resolve the post-operation desired state from the exact retained version the provider will select. */
export declare function resolveDesiredState(operation: OperationKind, origin: 'store' | 'task', kind: CatalogEntry['kind'], record: ManagedTargetRecord | undefined): DesiredState;
/** Intent, immutable-plan, fence, and trusted-decision owner. */
export declare class IntentPlanService {
    private readonly store;
    private readonly plans;
    private readonly inventory;
    private readonly owners;
    private readonly catalog;
    private readonly preflight;
    private readonly planTtlMs;
    constructor(store: CenterStateStore, plans: FilePlanStore, inventory: HostInventoryService, owners: HostOwners, catalog: () => VerifiedCatalog, preflight: IntentProviderPreflight, planTtlMs?: number);
    /** Mint a plan from a browser Store/Installed action or an internally verified task resolution. */
    preview(request: IntentPreviewRequest, authority: 'loopback-browser' | 'model-resolution', nowMs?: number, taskBinding?: TaskIntentBinding | null): Promise<IntentPreviewResponse>;
    /** Re-observe every fence before decision or consumption. */
    context(plan: ImmutablePlan): Promise<PlanUseContext>;
    /** List bounded task-origin plans with only the typed configuration needed for human review. */
    listTaskApprovals(maximum?: number): Promise<readonly TaskApprovalRow[]>;
    /** Project safe selectors for an exact MCP candidate's currently usable Host runtimes. */
    configurationOptions(input: Readonly<{
        candidateRef: string;
        targetKey: string | null;
        scopeKey: string;
        profileId: string;
    }>): Promise<Readonly<{
        options: readonly McpRuntimeOption[];
        currentConfiguration: RpcJson | null;
    }>>;
    private ownerRevision;
    private assertTaskBinding;
}
//# sourceMappingURL=intent-plan-service.d.ts.map
