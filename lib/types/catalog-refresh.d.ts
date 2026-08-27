import type { CatalogEnvelope, CatalogRoot, CatalogSignature } from './catalog-contract.ts';
import { type VerifiedCatalog } from './catalog.ts';
/** Exact public Pages resource selected by the installable Bundle. */
export declare const PUBLISHED_CATALOG_URL = "https://striveh.github.io/dsh-plugin-extension-center/plugins.json";
/** One signed payload downloaded from the configured fixed catalog endpoint. */
export interface SignedCatalogDocument {
    readonly envelope: CatalogEnvelope;
    readonly signatures: readonly CatalogSignature[];
}
/** User-visible admission state for the single catalog snapshot shared by Store and task retrieval. */
export interface CatalogAdmissionStatus {
    readonly source: 'bootstrap' | 'remote' | 'last-good';
    readonly freshness: 'bootstrap' | 'fresh' | 'cached';
    readonly degraded: boolean;
    readonly degradedReason: string | null;
    readonly lastRefreshAtMs: number | null;
}
/** Current verified catalog and its live-fetch state. */
export interface AdmittedCatalogSnapshot {
    readonly catalog: VerifiedCatalog;
    readonly status: CatalogAdmissionStatus;
}
/** Network and schedule configuration after Host config validation. */
export interface CatalogRefreshConfig {
    readonly trustedUrl: string | null;
    readonly fetchTimeoutMs: number;
}
/** Deterministic network and clock seam used by focused fault tests. */
export interface CatalogRefreshDependencies {
    readonly fetch: typeof globalThis.fetch;
    readonly now: () => number;
}
/** Verify one same-or-next revision without allowing rollback, gaps, or a broken predecessor link. */
export declare function verifyCatalogAdvance(root: CatalogRoot, current: VerifiedCatalog, document: SignedCatalogDocument, now?: number): VerifiedCatalog;
/** Accept only one credential-free canonical HTTPS resource URL. */
export declare function canonicalCatalogUrl(trustedUrl: string): string;
/** Own the one admitted snapshot used by both Store RPC and local task retrieval. */
export declare class CatalogSnapshotManager {
    private readonly root;
    private readonly config;
    private readonly dependencies;
    private snapshot;
    private cache;
    private refreshing;
    constructor(root: string, config: CatalogRefreshConfig, dependencies?: CatalogRefreshDependencies);
    /** Establish the durable bootstrap anchor, verify the full last-good chain, then attempt one live refresh. */
    initialize(): Promise<AdmittedCatalogSnapshot>;
    /** Return the exact current admitted snapshot without starting a second fetch. */
    current(): AdmittedCatalogSnapshot;
    /** Fetch and admit one same-or-next signed revision, retaining unexpired last-good on failure. */
    refresh(): Promise<AdmittedCatalogSnapshot>;
    private refreshOnce;
}
//# sourceMappingURL=catalog-refresh.d.ts.map
