import type { ManagedTargetRecord, SkillsOwner } from '../host/index.ts';
import { CenterStateStore } from '../host/index.ts';
import type { RpcJson } from '../service/rpc-contract.ts';
import type { AppliedProviderOperation, LifecycleProvider, PreparedProviderOperation, ProviderOperationRequest, ProviderVerification } from './types.ts';
/** Exact regular-file bytes and digest observed without following the final path. */
export interface SkillArtifactInspection {
    readonly text: string;
    readonly integrity: string;
    readonly matchesExpected: boolean;
    readonly executable: boolean;
}
/** Hash one bounded regular Skill artifact using its declared integrity algorithm. */
export declare function inspectSkillArtifact(path: string, expectedIntegrity: string): Promise<SkillArtifactInspection>;
/** Resolve and validate the exact Skill scope before an immutable plan is minted. */
export declare function preflightSkillConfiguration(value: RpcJson, scopeKey: string): Promise<RpcJson>;
/** Center-owned Skill lifecycle and merged-registry provider. */
export declare class SkillLifecycleProvider implements LifecycleProvider {
    private readonly root;
    private readonly store;
    private readonly skills;
    readonly kind: "skill";
    private invalidate;
    constructor(root: string, store: CenterStateStore, skills: SkillsOwner);
    /** Register the center's durable records as one real merged Skill provider. */
    register(): () => void;
    observe(targetKey: string): Promise<ManagedTargetRecord | null>;
    prepare(request: ProviderOperationRequest): Promise<PreparedProviderOperation>;
    recoveryPoint(prepared: PreparedProviderOperation): RpcJson;
    apply(prepared: PreparedProviderOperation): Promise<AppliedProviderOperation>;
    verify(applied: AppliedProviderOperation): Promise<ProviderVerification | null>;
    rollback(applied: AppliedProviderOperation): Promise<`sha256:${string}`>;
    recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation | null>;
    cleanup(prepared: PreparedProviderOperation): Promise<void>;
    private inspectManaged;
    private removeRetained;
    private removeMaterial;
    private removeQuarantine;
}
//# sourceMappingURL=skill-provider.d.ts.map
