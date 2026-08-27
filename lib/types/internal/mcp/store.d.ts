import { type StoredCenterMcpState } from './state.ts';
import { type CenterMcpConnectionMutationReceipt } from './types.ts';
/** Result of one durable mutation. */
export interface CenterMcpMutationResult {
    readonly state: StoredCenterMcpState;
    readonly receipt: CenterMcpConnectionMutationReceipt;
    readonly replayed: boolean;
}
/** Stable refusal for an incompatible or malformed MCP database. */
export declare class CenterMcpConnectionStoreCorruptionError extends Error {
    readonly code = "CENTER_MCP_STORE_CORRUPT";
}
/** SQLite store whose writer reservation covers load, CAS, and commit. */
export declare class CenterMcpConnectionStore {
    readonly statePath: string;
    private readonly legacyPaths;
    private database;
    private opening;
    constructor(root: string);
    /** Open and validate the private database, rejecting unreleased file-store formats. */
    initialize(): Promise<void>;
    /** Release this process's SQLite handle. */
    close(): void;
    /** Load current durable state, repairing a corrupt current payload only from its transactionally paired last-good value. */
    load(): Promise<StoredCenterMcpState>;
    /** Commit one exact idempotent mutation while retaining the cross-process writer reservation. */
    mutate(mutationId: string, requestValue: unknown, transform: (state: StoredCenterMcpState) => CenterMcpConnectionMutationReceipt, validateCommit?: () => void): Promise<CenterMcpMutationResult>;
    private ready;
    private open;
}
//# sourceMappingURL=store.d.ts.map
