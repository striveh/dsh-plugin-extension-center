import { Context, Service, type Plugin } from '@deepseek-ai/cordis';
import { type CenterMcpClientConfig, type CenterMcpConnectionMutationReceipt, type CenterMcpConnectionsSnapshot, type CenterMcpConnectionView, type CenterRemovedMcpConnectionView } from './types.ts';
/** Runtime configuration for the Center's internal MCP owner. */
export interface CenterMcpConnectionsConfig {
    /** Private Extension Center management root. */
    readonly root: string;
    /** Deterministic test seam; production always omits this and loads the official MCP client. */
    readonly clientPlugin?: Plugin<CenterMcpClientConfig>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        mcpConnections: CenterMcpConnections;
    }
}
/** Center-owned durable MCP desired-state service and dynamic child-Fiber owner. */
export declare class CenterMcpConnections extends Service {
    static inject: string[];
    readonly protocolVersion: 1;
    private readonly ownerContext;
    private readonly store;
    private readonly clientPlugin;
    private state;
    private readonly live;
    private readonly observed;
    private readonly toolGenerations;
    private readonly runtimeGenerations;
    private operations;
    private toolRefreshQueued;
    private stopped;
    constructor(ctx: Context, config: CenterMcpConnectionsConfig);
    /** Load state and remount enabled child Fibers before the service becomes injectable. */
    [Service.init](): AsyncGenerator<() => Promise<void>, void, void>;
    /** Return an immutable inventory snapshot. */
    snapshot(): CenterMcpConnectionsSnapshot;
    /** Return one immutable active connection. */
    get(id: string): CenterMcpConnectionView | undefined;
    /** Return one immutable restorable removed connection. */
    getRemoved(id: string): CenterRemovedMcpConnectionView | undefined;
    /** Read the official Tool registry for this namespace and any exact names captured before teardown. */
    registeredToolNames(id: string, exactNames?: readonly string[]): readonly string[];
    /** Persist one new desired record and reconcile its enabled state. */
    configure(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt>;
    /** Enable and mount one active desired record. */
    enable(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt>;
    /** Disable one record and await complete child-Fiber teardown. */
    disable(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt>;
    /** Replace the transport and restart an enabled child Fiber. */
    update(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt>;
    /** Move one active record to the restorable removed inventory. */
    remove(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt>;
    /** Restore one removed record and reconcile its retained enabled state. */
    restore(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt>;
    /** Permanently delete one revision-matched removed record. */
    purge(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt>;
    private setEnabled;
    private runMutation;
    private enqueue;
    private reconcileAll;
    private activate;
    private deactivate;
    private queueToolRefresh;
    private refreshAllToolGenerations;
    private refreshToolGeneration;
    private viewOf;
    private removedViewOf;
    private assertNamespaceAvailable;
    private toolsRuntime;
}
export default CenterMcpConnections;
//# sourceMappingURL=owner.d.ts.map
