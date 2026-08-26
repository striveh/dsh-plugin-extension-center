import type { ManagedTargetRecord, ManagedVersion, McpConnectionsOwner } from '../host/index.ts';
import type { McpReviewEvidence } from '../plans/index.ts';
import { CenterStateStore } from '../host/index.ts';
import type { RpcJson } from '../service/rpc-contract.ts';
import type { AppliedProviderOperation, LifecycleProvider, PreparedProviderOperation, ProviderOperationRequest, ProviderVerification } from './types.ts';
interface AdmittedMcpRuntimeBase {
    readonly runtimeRef: string;
    readonly candidateRef: string;
    readonly version: string;
}
/** Exact Host-preprovisioned stdio runtime; the Center never acquires these bytes. */
export interface AdmittedMcpStdioRuntime extends AdmittedMcpRuntimeBase {
    readonly transport: 'stdio';
    readonly executablePath: string;
    readonly executableSha256: `sha256:${string}`;
    readonly fixedArgs: readonly string[];
    readonly workingDirectory: string;
}
/** Exact unauthenticated HTTPS connection admitted by the Host. */
export interface AdmittedMcpHttpRuntime extends AdmittedMcpRuntimeBase {
    readonly transport: 'streamable-http';
    readonly origin: string;
    readonly endpoint: string;
    readonly authentication: 'none';
    readonly redirects: 'forbidden';
    readonly dataEgressDisclosure: string;
}
/** Host-authored immutable MCP descriptor allowlist; payloads select only its opaque id. */
export type AdmittedMcpRuntime = AdmittedMcpStdioRuntime | AdmittedMcpHttpRuntime;
/** Verified fixed Host runtime descriptor bound into an immutable plan. */
export interface McpRuntimePreflight {
    readonly runtimeRef: string;
    readonly version: string;
    readonly descriptorDigest: `sha256:${string}`;
    readonly reviewDescriptor: McpReviewEvidence['descriptor'];
    readonly runtimeDigest: `sha256:${string}` | null;
}
interface McpRuntimeOptionBase {
    readonly candidateRef: string;
    readonly runtimeRef: string;
    readonly version: string;
}
/** Browser-safe stdio selector facts; none are accepted back as authority. */
export interface McpStdioRuntimeOption extends McpRuntimeOptionBase {
    readonly transport: 'stdio';
    readonly executablePath: string;
    readonly fixedArgs: readonly string[];
    readonly workingDirectory: string;
}
/** Browser-safe HTTPS selector facts and mandatory data-egress disclosure. */
export interface McpHttpRuntimeOption extends McpRuntimeOptionBase {
    readonly transport: 'streamable-http';
    readonly origin: string;
    readonly endpoint: string;
    readonly authentication: 'none';
    readonly redirects: 'forbidden';
    readonly dataEgressDisclosure: string;
}
/** Safe exact selector row; the browser can select only runtimeRef. */
export type McpRuntimeOption = McpStdioRuntimeOption | McpHttpRuntimeOption;
/** Exact Host-owner observation for one Center-managed MCP version. */
export interface McpManagedOwnerEvidence {
    readonly descriptorMatches: boolean;
    readonly descriptorDigest: `sha256:${string}` | null;
    readonly descriptorRevision: string | null;
    readonly transport: 'stdio' | 'http' | null;
    readonly desiredEnabled: boolean;
    readonly observedLifecycle: 'absent' | 'disabled' | 'starting' | 'ready' | 'degraded' | 'unknown';
    readonly liveDetailAvailable: boolean;
    readonly toolGeneration: number | null;
    readonly qualifiedTools: readonly string[];
}
/** Dynamic MCP lifecycle over one explicit preinstalled runtime allowlist. */
export declare class McpLifecycleProvider implements LifecycleProvider {
    private readonly store;
    private readonly owner;
    readonly kind: "mcp";
    private readonly runtimes;
    constructor(store: CenterStateStore, owner: McpConnectionsOwner, runtimes: readonly AdmittedMcpRuntime[]);
    observe(targetKey: string): Promise<ManagedTargetRecord | null>;
    /** Verify a selected allowlisted runtime and bounded user roots without mutating its owner. */
    preflight(candidateRef: string, value: RpcJson): Promise<McpRuntimePreflight | null>;
    /** List currently usable descriptor facts; the browser can submit only the opaque selector. */
    options(candidateRef: string): Promise<readonly McpRuntimeOption[]>;
    /**
     * Compare durable Center state with the exact admitted runtime and current MCP owner record.
     * @param version Managed version whose authority must still match the Host owner.
     * @returns Sanitized owner evidence; descriptor drift never qualifies tools as visible.
     */
    inspect(version: ManagedVersion): Promise<McpManagedOwnerEvidence>;
    prepare(request: ProviderOperationRequest): Promise<PreparedProviderOperation>;
    recoveryPoint(prepared: PreparedProviderOperation): RpcJson;
    apply(prepared: PreparedProviderOperation): Promise<AppliedProviderOperation>;
    verify(applied: AppliedProviderOperation): Promise<ProviderVerification | null>;
    rollback(applied: AppliedProviderOperation): Promise<`sha256:${string}`>;
    recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation | null>;
    cleanup(): Promise<void>;
    private mutateOwner;
    private restoreOwner;
}
export {};
//# sourceMappingURL=mcp-provider.d.ts.map
