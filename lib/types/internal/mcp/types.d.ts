/** Center-owned managed MCP connection records and mutation API. */
/** Fully resolved reconnect policy passed to the official MCP client. */
export interface CenterMcpReconnectPolicy {
    readonly enabled: boolean;
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
    readonly maxAttempts: number;
}
/** Center-admitted stdio MCP transport. */
export interface CenterMcpStdioTransport {
    readonly transport: 'stdio';
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
    readonly toolCallTimeoutMs: number;
    readonly reconnect: CenterMcpReconnectPolicy;
}
/** Center-admitted Streamable HTTP MCP transport. */
export interface CenterMcpHttpTransport {
    readonly transport: 'streamable-http';
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly redirect: 'error' | 'follow' | 'manual';
    readonly toolCallTimeoutMs: number;
    readonly reconnect: CenterMcpReconnectPolicy;
}
/** Complete resolved transport accepted by the Center owner. */
export type CenterMcpTransport = CenterMcpStdioTransport | CenterMcpHttpTransport;
/** Durable desired state for one Center-managed MCP connection. */
export interface CenterMcpConnectionDesired {
    readonly id: string;
    readonly enabled: boolean;
    readonly transport: CenterMcpTransport;
}
/** Current process-local lifecycle observation. */
export interface CenterMcpConnectionObserved {
    readonly state: 'disabled' | 'connecting' | 'ready' | 'stopping' | 'error';
    readonly desiredRevision: number;
    readonly generation: number;
    readonly message?: string;
}
/** Actual qualified tools registered by one managed child Fiber. */
export interface CenterMcpToolGeneration {
    readonly generation: number;
    readonly digest: string;
    readonly names: readonly string[];
}
/** Immutable active connection view. */
export interface CenterMcpConnectionView {
    readonly id: string;
    readonly revision: number;
    readonly desired: CenterMcpConnectionDesired;
    readonly observed: CenterMcpConnectionObserved;
    readonly tools: CenterMcpToolGeneration;
}
/** Restorable removed connection view. */
export interface CenterRemovedMcpConnectionView {
    readonly id: string;
    readonly revision: number;
    readonly desired: CenterMcpConnectionDesired;
    readonly removedAtRevision: number;
}
/** Immutable active and removed inventory. */
export interface CenterMcpConnectionsSnapshot {
    readonly revision: number;
    readonly connections: readonly CenterMcpConnectionView[];
    readonly removed: readonly CenterRemovedMcpConnectionView[];
}
/** New desired record request. */
export interface CenterConfigureMcpConnectionRequest {
    readonly desired: CenterMcpConnectionDesired;
    readonly mutationId: string;
    readonly expectedRevision: 0;
}
/** Revision-checked request for one known record. */
export interface CenterMcpConnectionMutationRequest {
    readonly id: string;
    readonly mutationId: string;
    readonly expectedRevision: number;
}
/** Revision-checked transport replacement. */
export interface CenterUpdateMcpConnectionRequest extends CenterMcpConnectionMutationRequest {
    readonly transport: CenterMcpTransport;
}
/** Supported durable mutation name. */
export type CenterMcpConnectionOperation = 'configure' | 'enable' | 'disable' | 'update' | 'remove' | 'restore' | 'purge';
/** Durable result returned for a new mutation or exact replay. */
export interface CenterMcpConnectionMutationReceipt {
    readonly mutationId: string;
    readonly operation: CenterMcpConnectionOperation;
    readonly id: string;
    readonly previousRevision?: number;
    readonly revision: number;
    readonly snapshotRevision: number;
    readonly changed: boolean;
    readonly desiredDigest: string | null;
}
/** Configuration accepted by the official `@deepseek-ai/dsh-mcp-client`. */
export type CenterMcpClientConfig = Readonly<{
    transport: 'stdio';
    serverName: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    toolCallTimeoutMs: number;
    failOnStartupError: boolean;
    reconnect: CenterMcpReconnectPolicy;
}> | Readonly<{
    transport: 'streamable-http';
    serverName: string;
    url: string;
    headers: Record<string, string>;
    toolCallTimeoutMs: number;
    failOnStartupError: boolean;
    reconnect: CenterMcpReconnectPolicy;
}>;
/** A desired record changed after the caller read it. */
export declare class CenterMcpConnectionConflictError extends Error {
    readonly id: string;
    readonly expected: number;
    readonly actual: number;
    readonly code = "MCP_CONNECTION_CONFLICT";
    constructor(id: string, expected: number, actual: number);
}
/** A mutation addressed an absent active or removed record. */
export declare class CenterMcpConnectionNotFoundError extends Error {
    readonly code = "MCP_CONNECTION_NOT_FOUND";
    constructor(id: string, inventory: 'active' | 'removed');
}
/** One idempotency key was reused with different request fields. */
export declare class CenterMcpConnectionIdempotencyError extends Error {
    readonly code = "MCP_CONNECTION_IDEMPOTENCY_MISMATCH";
    constructor(mutationId: string);
}
/** The official MCP Client does not expose a redirect-forbidden HTTP policy. */
export declare class CenterMcpHttpUnsupportedError extends Error {
    readonly code = "MCP_HTTP_REDIRECT_GUARD_UNAVAILABLE";
    constructor();
}
/** Parse and detach a complete desired record at the wire or durable boundary. */
export declare function parseCenterMcpConnectionDesired(value: unknown, path?: string): CenterMcpConnectionDesired;
/** Parse and detach one complete resolved transport. */
export declare function parseCenterMcpTransport(value: unknown, path?: string): CenterMcpTransport;
/** Parse common mutation fields without accepting surplus authority. */
export declare function parseCenterMcpMutationRequest(value: unknown, path?: string): CenterMcpConnectionMutationRequest;
/** Parse a configure request. */
export declare function parseCenterConfigureMcpRequest(value: unknown, path?: string): CenterConfigureMcpConnectionRequest;
/** Parse an update request. */
export declare function parseCenterUpdateMcpRequest(value: unknown, path?: string): CenterUpdateMcpConnectionRequest;
//# sourceMappingURL=types.d.ts.map
