import type { VerifiedCatalog } from '../catalog.ts';
import type { CenterStateStore } from '../host/index.ts';
import { ArtifactFetcher, FileTargetLock } from '../host/index.ts';
import type { LifecycleProvider } from '../providers/index.ts';
import { FileOperationStore, FilePlanStore, type LoadedOperation, type StoredReceipt } from '../storage/index.ts';
import type { LifecycleResponse, OperationSummary } from './rpc-contract.ts';
import type { IntentPlanService } from './intent-plan-service.ts';
/** Registry of exactly one provider for each extension kind. */
export type LifecycleProviders = Readonly<Record<'plugin' | 'mcp' | 'skill', LifecycleProvider>>;
/** Durable single-use plan consumer and append-only lifecycle runner. */
export declare class OperationRunner {
    private readonly state;
    private readonly plans;
    private readonly operations;
    private readonly locks;
    private readonly fetcher;
    private readonly intentPlans;
    private readonly providers;
    private readonly catalog;
    constructor(state: CenterStateStore, plans: FilePlanStore, operations: FileOperationStore, locks: FileTargetLock, fetcher: ArtifactFetcher, intentPlans: IntentPlanService, providers: LifecycleProviders, catalog: () => VerifiedCatalog);
    /** Consume one approved plan once, then perform its provider operation. */
    run(planHashValue: unknown, signal: AbortSignal): Promise<LifecycleResponse>;
    /** Read one verified operation. */
    get(operationId: string): Promise<LoadedOperation | null>;
    /** List authoritative operation projections through the durable lookup index. */
    list(): Promise<readonly OperationSummary[]>;
    /** List content-addressed terminal receipts. */
    listReceipts(): Promise<readonly StoredReceipt[]>;
    /** Retry an exact fenced rollback while retaining the target lock until owner state is reconciled. */
    recoverOperation(operationId: string, signal: AbortSignal): Promise<LifecycleResponse>;
    /** Reconcile a Profile operation only from Host-owned boot and Loader evidence. */
    acknowledgeProfileBoot(input: Readonly<{
        operationId: string;
        profileId: string;
        generation: string;
    }>, signal: AbortSignal): Promise<LifecycleResponse>;
    /** Repair interrupted journals without replaying a consumed plan or a committed mutation. */
    recover(signal: AbortSignal): Promise<void>;
    private recoverLoaded;
    private recoverRollback;
    private execute;
    private needsArtifact;
    private recoverReservations;
    private providerRequest;
    private planForProjection;
    private append;
    private index;
    private indexPlan;
    private finishTerminal;
    private persistTaskReceipt;
    private toRecoveryRequired;
    private release;
    private response;
}
//# sourceMappingURL=operation-runner.d.ts.map
