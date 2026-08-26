import type { LoaderOwner, ManagedTargetRecord, ProfileTransactionsOwner } from '../host/index.ts';
import { CenterStateStore } from '../host/index.ts';
import type { RpcJson } from '../service/rpc-contract.ts';
import { type PluginConfigurationPatch } from './plugin-config-adapter.ts';
import type { AppliedProviderOperation, LifecycleProvider, PreparedProviderOperation, ProviderOperationRequest, ProviderVerification } from './types.ts';
/** Loader evidence derived inside the Host after the complete tree settles. */
export interface PluginRuntimeEvidence {
    readonly entryId: string;
    readonly moduleName: string;
    readonly fiberPhase: 'active' | 'absent';
}
/** Host-only observer; browser payloads never supply consumer evidence. */
export interface PluginRuntimeProbe {
    observe(packageName: string, operation: ProviderOperationRequest['plan']['operationKind']): Promise<PluginRuntimeEvidence>;
}
/** Direct Loader observer used after app-boot has acknowledged the active generation. */
export declare class LoaderPluginRuntimeProbe implements PluginRuntimeProbe {
    private readonly loader;
    constructor(loader: LoaderOwner);
    observe(packageName: string, operation: ProviderOperationRequest['plan']['operationKind']): Promise<PluginRuntimeEvidence>;
}
/** Exact plan mutation digest for the typed Profile patch adapter. */
export declare function pluginConfigurationMutationDigest(patch: PluginConfigurationPatch, ownerRevision: string): `sha256:${string}`;
/** Profile generation adapter for install, update, uninstall, restore, and boot acknowledgement. */
export declare class PluginLifecycleProvider implements LifecycleProvider {
    private readonly store;
    private readonly owner;
    private readonly runtime;
    readonly kind: "plugin";
    constructor(store: CenterStateStore, owner: ProfileTransactionsOwner, runtime: PluginRuntimeProbe);
    observe(targetKey: string): Promise<ManagedTargetRecord | null>;
    prepare(request: ProviderOperationRequest): Promise<PreparedProviderOperation>;
    recoveryPoint(prepared: PreparedProviderOperation): RpcJson;
    apply(prepared: PreparedProviderOperation): Promise<AppliedProviderOperation>;
    verify(applied: AppliedProviderOperation): Promise<ProviderVerification | null>;
    /** Reconcile an already acknowledged Profile boot with exact settled Loader evidence. */
    acknowledgeBoot(input: Readonly<{
        operationId: string;
        targetKey: string;
        profileId: string;
        generation: string;
    }>): Promise<void>;
    rollback(applied: AppliedProviderOperation): Promise<`sha256:${string}`>;
    /** Check app-boot evidence before the Loader probe can trigger rollback. */
    bootReady(input: Readonly<{
        profileId: string;
        generation: string;
    }>): Promise<boolean>;
    /** Remove the temporary rollback tombstone used when the original target was absent. */
    finalizeRollback(applied: AppliedProviderOperation): Promise<void>;
    /**
     * Rebuild the Center rollback-pending record only after the Host exposes the
     * exact generation and tree digest pinned by the immutable approval.
     *
     * @param request Exact consumed Plugin operation.
     * @param expectedBeforeDigest Journal-authenticated pre-mutation Center state.
     * @returns Pending rollback evidence, or null while the pinned Host restore is absent.
     */
    reconcileBreakGlassRestore(request: ProviderOperationRequest, expectedBeforeDigest: `sha256:${string}`): Promise<AppliedProviderOperation | null>;
    recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation | null>;
    cleanup(): Promise<void>;
    private applied;
}
//# sourceMappingURL=plugin-provider.d.ts.map
