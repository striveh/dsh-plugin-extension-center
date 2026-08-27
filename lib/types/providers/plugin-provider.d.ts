import type { LoaderOwner, ManagedTargetRecord } from '../host/index.ts';
import { CenterStateStore } from '../host/index.ts';
import { type ManagedPluginLoader, type ManagedPluginOwnerOptions, type ManagedPluginSnapshot } from '../internal/plugin/index.ts';
import type { RpcJson } from '../service/rpc-contract.ts';
import type { AppliedProviderOperation, LifecycleProvider, PreparedProviderOperation, ProviderOperationRequest, ProviderVerification } from './types.ts';
export type { ManagedPluginLoader, ManagedPluginOwnerOptions, ManagedPluginSnapshot } from '../internal/plugin/index.ts';
/** Loader evidence derived inside the Host after the exact owner row settles. */
export interface PluginRuntimeEvidence {
    readonly entryId: string;
    readonly moduleName: string;
    readonly fiberPhase: 'active' | 'absent';
}
/** Compatibility observer retained for callers that only need read-only Loader evidence. */
export interface PluginRuntimeProbe {
    observe(packageName: string, operation: ProviderOperationRequest['plan']['operationKind']): Promise<PluginRuntimeEvidence>;
}
/** Direct official Loader observer; row ids are Loader-generated and never package identities. */
export declare class LoaderPluginRuntimeProbe implements PluginRuntimeProbe {
    private readonly loader;
    constructor(loader: Pick<LoaderOwner, 'entries'>);
    observe(packageName: string, operation: ProviderOperationRequest['plan']['operationKind']): Promise<PluginRuntimeEvidence>;
}
/** Exact Center-owned configuration digest; no official Profile patch is read or changed. */
export declare function pluginConfigurationMutationDigest(configuration: RpcJson, ownerRevision: string): `sha256:${string}`;
/** Center-owned lifecycle using the official Profile CLI for packages and Loader APIs for runtime configuration. */
export declare class PluginLifecycleProvider implements LifecycleProvider {
    private readonly store;
    readonly kind: "plugin";
    private readonly owner;
    private readonly officialDsh;
    constructor(store: CenterStateStore, loader: ManagedPluginLoader, options: ManagedPluginOwnerOptions);
    /** Reconcile official Profile packages and Loader rows with Center-owned desired state. */
    initialize(): Promise<void>;
    /** Project the exact Center-owned profile state used by planning fences. */
    snapshot(profileId: string): Promise<ManagedPluginSnapshot>;
    observe(targetKey: string): Promise<ManagedTargetRecord | null>;
    /** Check durable Center and owner projections without reconciling Loader or Profile state. */
    referencesDurableOperation(operationId: string, targetKey: string, profileId: string): Promise<boolean>;
    prepare(request: ProviderOperationRequest): Promise<PreparedProviderOperation>;
    recoveryPoint(prepared: PreparedProviderOperation): RpcJson;
    apply(prepared: PreparedProviderOperation): Promise<AppliedProviderOperation>;
    verify(applied: AppliedProviderOperation): Promise<ProviderVerification | null>;
    /** A process restart token is acknowledged only after a new Host rehydrates the managed Plugin. */
    acknowledgeBoot(input: Readonly<{
        operationId: string;
        targetKey: string;
        profileId: string;
        restartToken?: string;
    }>): Promise<void>;
    rollback(applied: AppliedProviderOperation): Promise<`sha256:${string}`>;
    /** Runtime repair is complete only when the Center owner has no pending restart. */
    bootReady(input: Readonly<{
        profileId: string;
        restartToken?: string;
    }>): Promise<boolean>;
    /** Verify the exact restored state before the operation publishes its terminal receipt. */
    verifyRollbackFinalization(applied: AppliedProviderOperation): Promise<void>;
    /** Complete post-receipt rollback cleanup from durable operation authority without an intent payload. */
    finalizeDurableRollback(input: Readonly<{
        operationId: string;
        targetKey: string;
        beforeDigest: `sha256:${string}`;
    }>): Promise<boolean>;
    /** Remove transient absent-state proof only after the terminal receipt is durable. */
    finalizeRollback(applied: AppliedProviderOperation): Promise<void>;
    /** Consume only exact evidence produced after the pinned executable restored official and Center state. */
    reconcileBreakGlassRestore(request: ProviderOperationRequest, expectedBeforeDigest: `sha256:${string}`, journalHeadDigest: `sha256:${string}`): Promise<AppliedProviderOperation | null>;
    recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation | null>;
    cleanup(): Promise<void>;
    private pendingState;
    private rollbackPending;
    private markRollback;
    private applied;
}
//# sourceMappingURL=plugin-provider.d.ts.map
