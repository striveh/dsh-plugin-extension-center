import type { OperationAuthorization } from '../plans/index.ts';
import type { ImmutablePlan } from '../plans/index.ts';
import type { VerifiedCatalog } from '../catalog.ts';
/** Exact signed-catalog artifact coordinates re-bound after plan consumption. */
export interface ArtifactFetchSpec {
    readonly candidateRef: string;
    readonly revision: string;
    readonly url: string;
    readonly sizeBytes: number;
    readonly integrity: `sha256:${string}` | `sha512:${string}`;
    readonly fileSuffix: '.md' | '.tgz';
}
/** Four-way binding required before acquisition may touch the network. */
export interface ArtifactFetchBinding {
    readonly authorization: OperationAuthorization;
    readonly plan: ImmutablePlan;
    readonly catalog: VerifiedCatalog;
}
/** Explicit redirect policy for integrity-pinned downloads. */
export interface ArtifactRedirectPolicy {
    readonly maximumRedirects: number;
    readonly allowedCrossOriginHosts: readonly string[];
}
/** Resulting center-owned immutable artifact. */
export interface FetchedArtifact {
    readonly path: string;
    readonly sizeBytes: number;
    readonly integrity: ArtifactFetchSpec['integrity'];
    readonly finalUrl: string;
}
type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>;
/** HTTPS-only integrity-pinned artifact acquisition with bounded explicit redirects. */
export declare class ArtifactFetcher {
    private readonly root;
    private readonly redirects;
    private readonly fetchImpl;
    constructor(root: string, redirects: ArtifactRedirectPolicy, fetchImpl?: FetchImplementation);
    /** Fetch only while carrying the single-use authorization returned by plan consumption. */
    fetch(binding: ArtifactFetchBinding, signal: AbortSignal): Promise<FetchedArtifact>;
}
export {};
//# sourceMappingURL=artifact-fetcher.d.ts.map
