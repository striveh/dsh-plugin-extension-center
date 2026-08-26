import type { CatalogEntry } from '../catalog-contract.ts';
import type { ManagedTargetRecord, LifecyclePayload } from '../host/index.ts';
import type { OperationAuthorization, PlanContent } from '../plans/index.ts';
import type { Sha256Digest } from '../domain/index.ts';
import type { RpcJson } from '../service/rpc-contract.ts';
/** Complete exact input handed to one kind-specific provider. */
export interface ProviderOperationRequest {
    readonly authorization: OperationAuthorization;
    readonly plan: PlanContent;
    readonly entry: CatalogEntry;
    readonly payload: LifecyclePayload;
    readonly artifactPath: string | null;
    readonly signal: AbortSignal;
}
/** Staged provider work that has not changed authoritative desired state. */
export interface PreparedProviderOperation {
    readonly request: ProviderOperationRequest;
    readonly before: ManagedTargetRecord | null;
    readonly beforeDigest: Sha256Digest;
    readonly stagingPath: string | null;
    readonly prepared: unknown;
}
/** Authoritative mutation result requiring owner verification or restart acknowledgement. */
export interface AppliedProviderOperation {
    readonly prepared: PreparedProviderOperation;
    readonly mutationDigest: Sha256Digest;
    readonly afterDigest: Sha256Digest;
    readonly restartRequired: boolean;
    readonly profileGeneration: string | null;
    readonly rollbackRestart: boolean;
}
/** Provider verification result bound into the operation journal. */
export interface ProviderVerification {
    readonly digest: Sha256Digest;
}
/** Provider-owned lifecycle implementation. */
export interface LifecycleProvider {
    readonly kind: CatalogEntry['kind'];
    observe(targetKey: string): Promise<ManagedTargetRecord | null>;
    prepare(request: ProviderOperationRequest): Promise<PreparedProviderOperation>;
    recoveryPoint(prepared: PreparedProviderOperation): RpcJson;
    apply(prepared: PreparedProviderOperation): Promise<AppliedProviderOperation>;
    verify(applied: AppliedProviderOperation): Promise<ProviderVerification | null>;
    rollback(applied: AppliedProviderOperation): Promise<Sha256Digest>;
    recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation | null>;
    cleanup(prepared: PreparedProviderOperation): Promise<void>;
}
//# sourceMappingURL=types.d.ts.map
