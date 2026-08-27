import type { CatalogEntry } from '../catalog-contract.ts';
import { type Sha256Digest } from '../domain/index.ts';
import type { ManagedTargetRecord } from '../host/index.ts';
import type { OperationKind, PlanReviewEvidence } from '../plans/index.ts';
import { type McpRuntimePreflight } from '../providers/index.ts';
import type { RpcJson } from './rpc-contract.ts';
/** Center-owned Plugin state read before approval and rebound before plan consumption. */
export interface ManagedPluginSnapshot {
    readonly profileId: string;
    readonly revision: number;
    readonly digest: Sha256Digest;
    readonly materialRoot: string;
    readonly bootStatus: 'live' | 'pending-restart' | 'verified';
    readonly ownerRevision: string;
}
/** Narrow read-only port implemented by the Center-owned Plugin lifecycle provider. */
export interface ManagedPluginSnapshotPort {
    snapshot(profileId: string): Promise<ManagedPluginSnapshot>;
}
/** Complete inputs used to build one immutable, secret-free approval record. */
export interface BuildReviewEvidenceInput {
    readonly entry: CatalogEntry;
    readonly operationKind: OperationKind;
    readonly profileId: string;
    readonly ownerRevision: string;
    readonly configuration: RpcJson;
    readonly managed: ManagedTargetRecord | undefined;
    readonly managedPlugins: ManagedPluginSnapshot;
    readonly runtime: McpRuntimePreflight | null;
}
/** Build package-pinned evidence without downloading or executing a candidate before approval. */
export declare function buildPlanReviewEvidence(input: BuildReviewEvidenceInput): Promise<PlanReviewEvidence>;
//# sourceMappingURL=review-evidence.d.ts.map
