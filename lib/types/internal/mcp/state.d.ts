import type { CenterMcpConnectionDesired, CenterMcpConnectionMutationReceipt } from './types.ts';
/** Durable active record. */
export interface StoredCenterMcpConnection {
    desired: CenterMcpConnectionDesired;
    revision: number;
}
/** Durable removed record retained for restore. */
export interface StoredCenterRemovedMcpConnection extends StoredCenterMcpConnection {
    removedAtRevision: number;
}
/** One accepted idempotency key and exact receipt. */
export interface StoredCenterMcpMutation {
    mutationId: string;
    requestDigest: string;
    receipt: CenterMcpConnectionMutationReceipt;
}
/** Authoritative Center-owned MCP state. */
export interface StoredCenterMcpState {
    schemaVersion: 1;
    revision: number;
    connections: StoredCenterMcpConnection[];
    removed: StoredCenterRemovedMcpConnection[];
    mutations: StoredCenterMcpMutation[];
}
/** Checksummed state-file envelope. */
export interface StoredCenterMcpEnvelope {
    schemaVersion: 1;
    state: StoredCenterMcpState;
    digest: string;
}
/** Create an empty mutable state. */
export declare function emptyCenterMcpState(): StoredCenterMcpState;
/** Clone one validated state for mutation. */
export declare function cloneCenterMcpState(value: StoredCenterMcpState): StoredCenterMcpState;
/** Canonically sort all identity-indexed records before persistence. */
export declare function normalizeCenterMcpState(value: StoredCenterMcpState): void;
/** Create the checksummed durable envelope. */
export declare function envelopeForCenterMcpState(value: StoredCenterMcpState): StoredCenterMcpEnvelope;
/** Parse and verify a durable envelope. */
export declare function parseCenterMcpEnvelope(value: unknown): StoredCenterMcpState;
/** Return a recursively frozen detached public value. */
export declare function immutableCenterMcpValue<T>(value: T): Readonly<T>;
//# sourceMappingURL=state.d.ts.map
