interface LockOwner {
    readonly schemaVersion: 1;
    readonly targetKey: string;
    readonly operationId: string;
    readonly acquiredAtMs: number;
}
/** Durable one-target lease built from atomic directory installation. */
export declare class FileTargetLock {
    private readonly root;
    constructor(root: string);
    /** Acquire one exact target, failing if any operation already owns it. */
    acquire(targetKey: string, operationId: string, atMs?: number): Promise<void>;
    /** Release only the exact lease owner. */
    release(targetKey: string, operationId: string): Promise<void>;
    /** Enumerate complete durable leases for startup recovery. */
    list(): Promise<readonly LockOwner[]>;
    private readOwner;
}
export {};
//# sourceMappingURL=target-lock.d.ts.map
