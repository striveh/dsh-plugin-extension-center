/** Independent Extension Center Host: verified Store, durable lifecycle, and task acquisition. */
import type { Context } from '@deepseek-ai/cordis';
import { type AdmittedMcpRuntime } from './providers/index.ts';
/** Cordis identity for the independent Extension Center Host half. */
export declare const name = "extension-center";
/** Connection is the only hard dependency; writable owners are probed at runtime. */
export declare const inject: string[];
/** Product-owned Host configuration; credentials and arbitrary commands are intentionally absent. */
export interface Config {
    readonly root?: string;
    readonly maximumArtifactRedirects?: number;
    readonly allowedArtifactRedirectHosts?: readonly string[];
    readonly mcpRuntimes?: readonly AdmittedMcpRuntime[];
    readonly catalogTrustedOrigin?: string;
    readonly catalogFetchTimeoutMs?: number;
    readonly catalogRefreshIntervalMs?: number;
}
/** Register read-only Store access on every Host and acquisition only when all six owners exist. */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
export { catalogListResponse, verifyBootstrapCatalog } from './catalog.ts';
export { CatalogSnapshotManager, catalogEndpoint, verifyCatalogAdvance } from './catalog-refresh.ts';
export type { CatalogEntry, CatalogListResponse } from './catalog-contract.ts';
export * from './service/rpc-contract.ts';
//# sourceMappingURL=index.d.ts.map
