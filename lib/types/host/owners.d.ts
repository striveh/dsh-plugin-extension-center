import type { HostCapabilityProjection } from '../service/rpc-contract.ts';
/** Center-owned Plugin lifecycle snapshot used for planning and recovery fences. */
export interface ManagedPluginsOwner {
    snapshot(profileId: string): Promise<Readonly<{
        profileId: string;
        revision: number;
        digest: `sha256:${string}`;
        materialRoot: string;
        bootStatus: 'live' | 'pending-restart' | 'verified';
        ownerRevision: string;
    }>>;
}
/** Center-owned dynamic MCP desired-state lifecycle. */
export interface McpConnectionsOwner {
    readonly protocolVersion: 1;
    snapshot(): Readonly<{
        revision: number;
        connections: readonly unknown[];
        removed: readonly unknown[];
    }>;
    get(id: string): unknown;
    getRemoved(id: string): unknown;
    /** Query the real official Tool registry for one namespace and exact prior names. */
    registeredToolNames(id: string, exactNames?: readonly string[]): readonly string[];
    configure(request: unknown): Promise<unknown>;
    enable(request: unknown): Promise<unknown>;
    disable(request: unknown): Promise<unknown>;
    update(request: unknown): Promise<unknown>;
    remove(request: unknown): Promise<unknown>;
    restore(request: unknown): Promise<unknown>;
    purge(request: unknown): Promise<unknown>;
}
/** Center-owned durable continuation lifecycle over official Agent and Session services. */
export interface TaskContinuationsOwner {
    readonly protocolVersion: 1;
    create(agent: unknown, request: unknown): Promise<unknown>;
    reserve(request: unknown): Promise<unknown>;
    get(id: string): Promise<unknown>;
    list(request?: unknown): Promise<readonly unknown[]>;
    cancel(ref: unknown): Promise<boolean>;
    supersede(request: unknown): Promise<boolean>;
    reconcile(signal?: AbortSignal): Promise<void>;
    registerVerifier(verifier: Readonly<{
        id: string;
        verify(claim: unknown, signal: AbortSignal): Promise<unknown>;
    }>): () => void;
}
/** Official merged Skill registry used to publish and prove a winning definition. */
export interface SkillsOwner {
    registerProvider(create: (control: Readonly<{
        signal: AbortSignal;
        invalidate(): void;
    }>) => unknown): () => void;
    snapshot(options?: unknown): Promise<Readonly<{
        skills: readonly unknown[];
        complete: boolean;
    }>>;
    list(options?: unknown): Promise<readonly unknown[]>;
    get(name: string, options?: unknown): Promise<unknown>;
}
/** Official Tool registry receiving Center tools and managed MCP tools. */
export interface ToolsOwner {
    register(definition: unknown): () => void;
    schemas?(agent?: unknown): readonly unknown[];
}
/** Official Loader mutation and observation surface used by managed Plugins. */
export interface LoaderOwner {
    create(options: Readonly<{
        name: string;
        config?: unknown;
        group?: boolean | null;
        disabled?: boolean | null;
        inject?: unknown;
    }>, parent?: string | null, position?: number): Promise<string>;
    update(id: string, options: Readonly<{
        config?: unknown;
        group?: boolean | null;
        disabled?: boolean | null;
        inject?: unknown;
    }>, parent?: string | null, position?: number): Promise<void>;
    remove(id: string): Promise<void>;
    await(): Promise<void>;
    entries(): Iterable<Readonly<{
        id: string;
        options: Readonly<{
            id?: string;
            name: string;
            group?: boolean;
        }>;
        disabled: boolean;
        refresh(): Promise<void>;
        fiber?: Readonly<{
            state: number;
            await(): Promise<unknown>;
        }>;
    }>>;
}
/** One coherent owner set assembled entirely inside the Extension Center plugin. */
export interface HostOwners {
    readonly managedPlugins: ManagedPluginsOwner | null;
    readonly mcpConnections: McpConnectionsOwner | null;
    readonly taskContinuations: TaskContinuationsOwner | null;
    readonly skills: SkillsOwner | null;
    readonly tools: ToolsOwner | null;
    readonly loader: LoaderOwner | null;
}
interface ServiceLookup {
    get(name: string): unknown;
}
/** Bind Center-owned lifecycles to the exact official rc.2 registries they use. */
export declare function bindHostOwners(lookup: ServiceLookup, internal: Readonly<{
    managedPlugins: ManagedPluginsOwner;
    mcpConnections: McpConnectionsOwner;
    taskContinuations: TaskContinuationsOwner;
}>): HostOwners;
/** Project truthful lifecycle capability without depending on non-official Host services. */
export declare function hostCapabilities(owners: HostOwners): HostCapabilityProjection;
export {};
//# sourceMappingURL=owners.d.ts.map
