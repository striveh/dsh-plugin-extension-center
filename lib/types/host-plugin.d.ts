/** Independent Extension Center Host lifecycle assembled on official DSH services. */
import type { Context } from '@deepseek-ai/cordis';
import { type AdmittedMcpRuntime } from './providers/index.ts';
/** Cordis identity for the independent Extension Center Host half. */
export declare const name = "extension-center";
/** Connection is the carrier; internal bindings track all other official services. */
export declare const inject: string[];
/** Product-owned Host configuration; credentials and arbitrary commands are absent. */
export interface Config {
    readonly root?: string;
    readonly maximumArtifactRedirects?: number;
    readonly allowedArtifactRedirectHosts?: readonly string[];
    readonly mcpRuntimes?: readonly AdmittedMcpRuntime[];
    readonly catalogTrustedUrl?: string;
    readonly catalogFetchTimeoutMs?: number;
    readonly catalogRefreshIntervalMs?: number;
    /** Absolute current `@deepseek-ai/dsh` CLI entrypoint; defaults to this Host's startup entrypoint. */
    readonly dshCliEntrypoint?: string;
    readonly dshCliTimeoutMs?: number;
}
/** Assemble every managed lifecycle inside one independent plugin on official DSH rc.2. */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
//# sourceMappingURL=host-plugin.d.ts.map
