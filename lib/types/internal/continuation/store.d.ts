/** Strict SQLite persistence for plugin-owned continuation claims. */
import type { TaskContinuationClaim, TaskContinuationDeliveryUnknownReason, TaskContinuationInvalidReason, TaskContinuationState } from './types.ts';
/** Durable fields supplied for a new pending record. */
export type NewTaskContinuation = Omit<TaskContinuationClaim, 'recordRevision' | 'state' | 'updatedAtMs' | 'dispatchFence' | 'dispatchOwnerId' | 'dispatchLeaseExpiresAtMs' | 'dispatchStartedAtMs' | 'deliveryUnknownReason' | 'invalidReason'>;
/** Compare-and-set lifecycle transition. */
export interface TaskContinuationTransition {
    readonly id: string;
    readonly from: readonly TaskContinuationState[];
    readonly to: TaskContinuationState;
    readonly updatedAtMs: number;
    readonly expectedRecordRevision?: number;
    readonly expectedSessionId?: string;
    readonly expectedTaskRevision?: string;
    readonly supersededByTaskRevision?: string;
    readonly invalidReason?: TaskContinuationInvalidReason;
}
/** Atomic ownership request before the at-most-once Agent call begins. */
export interface TaskContinuationDispatchClaimRequest {
    readonly id: string;
    readonly ownerId: string;
    readonly nowMs: number;
    readonly leaseExpiresAtMs: number;
    readonly expectedSessionId: string;
    readonly expectedTaskRevision: string;
}
/** Exact owner/fence required to cross the irreversible Agent-call boundary. */
export interface TaskContinuationDispatchFence {
    readonly id: string;
    readonly ownerId: string;
    readonly fence: number;
    readonly expectedRecordRevision: number;
    readonly updatedAtMs: number;
}
/** Confirmed result of one owner-fenced Agent dispatch attempt. */
export interface TaskContinuationDispatchFinish extends TaskContinuationDispatchFence {
    readonly to: 'dispatched' | 'claimed';
}
/** Secret-free uncertain outcome of one owner-fenced Agent dispatch attempt. */
export interface TaskContinuationDispatchFailure extends TaskContinuationDispatchFence {
    readonly reason: Exclude<TaskContinuationDeliveryUnknownReason, 'owner-lease-expired' | 'legacy-consumed'>;
}
/** Stable refusal for an incompatible or malformed claims database. */
export declare class TaskContinuationStoreCorruptionError extends Error {
    readonly code = "TASK_CONTINUATION_STORE_CORRUPT";
}
/** One-process connection using SQLite writer reservations for every mutation. */
export declare class InternalTaskContinuationStore {
    private readonly busyTimeoutMs;
    private readonly path;
    private database;
    private opening;
    constructor(root: string, busyTimeoutMs: number);
    /** Open and validate storage, creating the exact schema when absent. */
    initialize(): Promise<void>;
    /** Open storage only when a prior process materialized it. */
    initializeIfPresent(): Promise<boolean>;
    /** Release the process-owned SQLite connection. */
    close(): void;
    /** Atomically reserve a caller key or return its exact idempotent binding. */
    createOrGet(input: NewTaskContinuation): Promise<Readonly<{
        claim: TaskContinuationClaim;
        created: boolean;
    }>>;
    /** Find one exact claim identity. */
    get(id: string): Promise<TaskContinuationClaim | undefined>;
    /** Find a caller-scoped idempotency binding. */
    getByMutation(callerId: string, mutationId: string): Promise<TaskContinuationClaim | undefined>;
    /** List every claim in deterministic creation order. */
    list(): Promise<readonly TaskContinuationClaim[]>;
    /** Apply one record-revision-fenced lifecycle transition. */
    transition(request: TaskContinuationTransition): Promise<TaskContinuationClaim | undefined>;
    /** Claim or safely reclaim a pre-call dispatch lease, incrementing its fence. */
    claimDispatch(request: TaskContinuationDispatchClaimRequest): Promise<TaskContinuationClaim | undefined>;
    /** Persist the irreversible boundary immediately before `Agent.followup()`. */
    beginDispatch(request: TaskContinuationDispatchFence): Promise<TaskContinuationClaim | undefined>;
    /** Record a flush-confirmed dispatch without permitting a second Agent call. */
    finishDispatch(request: TaskContinuationDispatchFinish): Promise<TaskContinuationClaim | undefined>;
    /** Terminalize an ambiguous owner-observed call result without retrying it. */
    failDispatch(request: TaskContinuationDispatchFailure): Promise<TaskContinuationClaim | undefined>;
    /** Resolve a crashed post-boundary owner to a non-retrying diagnostic state. */
    expireDispatch(id: string, nowMs: number): Promise<TaskContinuationClaim | undefined>;
    /** Repair an uncertain or queued dispatch only from exact durable Session evidence. */
    observeDispatch(claim: TaskContinuationClaim, to: 'dispatched' | 'claimed' | 'invalid', updatedAtMs: number, reason?: TaskContinuationInvalidReason): Promise<TaskContinuationClaim | undefined>;
    private ready;
    private open;
}
//# sourceMappingURL=store.d.ts.map
