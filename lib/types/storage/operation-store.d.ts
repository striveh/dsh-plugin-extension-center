import { type Sha256Digest } from '../domain/index.ts';
import { type JournalCheckpoint, type OperationJournal, type OperationProjection, type OperationReceipt } from '../operations/index.ts';
declare const STORE_SCHEMA_VERSION: 1;
/** Durable zero-mutation reservation spanning plan consumption and the first journal event. */
export interface OperationReservation {
    readonly schemaVersion: typeof STORE_SCHEMA_VERSION;
    readonly operationId: string;
    readonly planHash: Sha256Digest;
    readonly targetKey: string;
    readonly beforeDigest: Sha256Digest;
    readonly reservedAtMs: number;
}
/** Loaded durable operation plus whether an interrupted pointer advance was repaired. */
export interface LoadedOperation {
    readonly journal: OperationJournal;
    readonly projection: OperationProjection;
    readonly recovered: boolean;
}
/** Receipt projected from a verified durable operation. */
export interface StoredReceipt {
    readonly operationId: string;
    readonly targetKey: string;
    readonly receipt: OperationReceipt;
}
/**
 * Durable content-addressed operation journal store.
 *
 * Every event is installed once under its sequence and digest. `CURRENT.json`
 * advances atomically after the event reaches disk. A valid event left beyond
 * the pointer by process death is recovered on the next load; a missing,
 * reordered, or altered event is rejected.
 */
export declare class FileOperationStore {
    private readonly root;
    private readonly queues;
    /**
     * Create a store below one center-owned data directory.
     * @param root Exact durable data directory.
     */
    constructor(root: string);
    /** Exact Center root passed to the pinned standalone recovery executable. */
    centerRoot(): string;
    /** Persist the exact pre-consumption reservation before the plan becomes single-use. */
    reserve(value: OperationReservation): Promise<void>;
    /** Load one exact reservation, if plan consumption has not yet crossed into a journal. */
    loadReservation(operationId: string): Promise<OperationReservation | undefined>;
    /** Enumerate every strict reservation in deterministic operation-id order. */
    listReservations(): Promise<readonly OperationReservation[]>;
    /** Delete only the exact durable reservation after a journal or safe cancellation is durable. */
    deleteReservation(operationId: string): Promise<void>;
    /**
     * Persist exactly one new logical journal event.
     * @param journal Verified journal whose prior prefix is already durable, or its opening event.
     * @returns Durable head checkpoint after the pointer advance.
     */
    persist(journal: OperationJournal): Promise<JournalCheckpoint>;
    /**
     * Load and verify one operation, repairing a valid event-ahead-of-pointer crash.
     * @param operationId Exact operation identity.
     * @returns Verified operation, or `undefined` when it was never persisted.
     */
    load(operationId: string): Promise<LoadedOperation | undefined>;
    /**
     * Enumerate only terminal operations that contain a verified receipt.
     * @returns Receipts sorted by operation id.
     */
    listReceipts(): Promise<readonly StoredReceipt[]>;
    /** Enumerate every verified operation journal, including rows missing an advisory index after a crash. */
    list(): Promise<readonly LoadedOperation[]>;
    private operationDirectory;
    private reservationPath;
    private loadUnlocked;
    private writePointer;
    private serialize;
}
/** Test-only durable path helper retained outside the store's public protocol. */
export declare function operationStoreStat(root: string, operationId: string): Promise<Readonly<{
    files: readonly string[];
}>>;
export {};
//# sourceMappingURL=operation-store.d.ts.map
