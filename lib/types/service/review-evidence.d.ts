import type { CatalogEntry } from '../catalog-contract.ts';
import type { ManagedTargetRecord } from '../host/index.ts';
import type { OperationKind, PlanReviewEvidence } from '../plans/index.ts';
import { type McpRuntimePreflight } from '../providers/index.ts';
import type { RpcJson } from './rpc-contract.ts';
/** Profile facts read before approval and rebound immediately before consumption. */
export interface ReviewProfileObservation {
    readonly revision: number;
    readonly treeDigest: string;
    readonly effectivePath: string;
    readonly activeGeneration: string | null;
    readonly lastGoodGeneration: string | null;
    readonly rollbackGeneration: string | null;
}
/** Complete inputs used to build one immutable, secret-free approval record. */
export interface BuildReviewEvidenceInput {
    readonly entry: CatalogEntry;
    readonly operationKind: OperationKind;
    readonly profileId: string;
    readonly ownerRevision: string;
    readonly configuration: RpcJson;
    readonly managed: ManagedTargetRecord | undefined;
    readonly profile: ReviewProfileObservation;
    readonly runtime: McpRuntimePreflight | null;
}
/** Build package-pinned evidence without downloading or executing a candidate before approval. */
export declare function buildPlanReviewEvidence(input: BuildReviewEvidenceInput): Promise<PlanReviewEvidence>;
//# sourceMappingURL=review-evidence.d.ts.map
