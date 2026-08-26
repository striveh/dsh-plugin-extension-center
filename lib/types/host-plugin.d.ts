/** Independent Extension Center Host lifecycle and dynamic owner activation. */
import { type Context } from '@deepseek-ai/cordis';
import { type HostOwnerDefinitions } from './host/index.ts';
import { type AdmittedMcpRuntime } from './providers/index.ts';
/** Cordis identity for the independent Extension Center Host half. */
export declare const name = "extension-center";
/** Connection is the only hard dependency; writable owners activate dynamically. */
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
/**
 * Register the Host using an already loaded owner-Definition set.
 *
 * This internal entrypoint lets the assembled lifecycle regression provide the
 * same Definition identities as its late owner services. Package consumers use
 * {@link apply}, which loads the installed official Definitions.
 */
export declare function applyWithHostOwnerDefinitions(ctx: Context, config: Config, definitions: HostOwnerDefinitions): Promise<void>;
/** Register read-only Store access immediately and writable acquisition while all six owners are live. */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
//# sourceMappingURL=host-plugin.d.ts.map
