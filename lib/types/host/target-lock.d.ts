import { type ProcessIdentity } from './process-identity.ts';
/** Immutable durable owner installed with one exact target lock. */
export interface TargetLockOwner {
    readonly schemaVersion: 2;
    readonly targetKey: string;
    readonly operationId: string;
    readonly leaseId: string;
    readonly hostInstanceId: string;
    readonly processIdentity: ProcessIdentity;
    readonly acquiredAtMs: number;
}
/** Durable one-target lease built from atomic directory installation. */
export declare class FileTargetLock {
    private readonly root;
    private readonly hostInstanceId;
    private processIdentity;
    private readonly claims;
    constructor(root: string);
    /** Acquire one exact target, failing if any operation or recovery gate already owns it. */
    acquire(targetKey: string, operationId: string, atMs?: number): Promise<void>;
    /** Release only the complete lease token held by this lock instance. */
    release(targetKey: string, operationId: string): Promise<void>;
    /** Enumerate complete durable leases for startup recovery. */
    list(): Promise<readonly TargetLockOwner[]>;
    /** Resume crash-interrupted takeovers before ordinary journal recovery enumerates locks. */
    resumeTakeovers(): Promise<readonly TargetLockOwner[]>;
    /** Claim one unchanged dead owner's operation by installing a new exact lease. */
    claimRecovery(owner: TargetLockOwner): Promise<'claimed' | 'owned' | 'live' | 'unknown'>;
    /** Reclaim only an unchanged orphan whose original process identity is proven dead. */
    reclaimOrphan(owner: TargetLockOwner): Promise<'reclaimed' | 'live' | 'unknown'>;
    private newOwner;
    private installTransferredOwner;
    private acquireTakeoverGate;
    private quarantineOwner;
    private finishTakeover;
    private assertNoRecoveryGate;
    private hasQuarantine;
    private quarantineOwnerForTakeover;
    private listTakeovers;
    private installTakeoverGate;
    private removeTakeoverEntry;
    private removeExactTakeoverPath;
    private removeRetiredTakeovers;
    private readTakeover;
    private currentProcessIdentity;
    private sameProcessIdentity;
    private sameOwner;
    private sameTakeover;
    private readOwner;
    private pathExists;
    private locksRoot;
    private takeoversRoot;
    private quarantineRoot;
    private lockPath;
    private takeoverPath;
    private quarantineTargetRoot;
}
//# sourceMappingURL=target-lock.d.ts.map
