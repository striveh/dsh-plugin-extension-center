/** Plugin-owned verifier-gated continuation owner over official DSH rc.2 APIs. */
import type { TaskContinuationsOwner } from '../../host/owners.ts';
import type { ContinuationMessage, InternalTaskContinuationConfig, InternalTaskContinuationsOwner, TaskContinuationClaim } from './types.ts';
/** SQLite-backed owner that never persists the original task text. */
export declare class InternalTaskContinuationOwner implements InternalTaskContinuationsOwner, TaskContinuationsOwner {
    private readonly config;
    readonly protocolVersion: 1;
    private readonly store;
    private readonly verifiers;
    private readonly subscribers;
    private readonly ownedHandles;
    private readonly retiringHandles;
    private readonly settling;
    private readonly settledDispatches;
    private readonly retryDelays;
    private readonly retryTimers;
    private readonly leaseTimers;
    private readonly stopSignal;
    private readonly ownerId;
    private readonly dispatchClaimLeaseMs;
    private readonly retryInitialDelayMs;
    private readonly retryMaxDelayMs;
    private storeActivated;
    private requested;
    private running;
    private stopping;
    private disposePromise;
    private disposeLifecycle;
    constructor(config: InternalTaskContinuationConfig);
    /** Open prior durable state without creating a database for an unused owner. */
    initialize(): Promise<void>;
    create(agentValue: unknown, requestValue: unknown): Promise<TaskContinuationClaim>;
    reserve(requestValue: unknown): Promise<TaskContinuationClaim>;
    get(id: string): Promise<TaskContinuationClaim | undefined>;
    list(requestValue?: unknown): Promise<readonly TaskContinuationClaim[]>;
    cancel(refValue: unknown): Promise<boolean>;
    supersede(requestValue: unknown): Promise<boolean>;
    registerVerifier(verifierValue: Readonly<{
        id: string;
        verify(claim: unknown, signal: AbortSignal): Promise<unknown>;
    }>): () => void;
    /** Observe durable claim changes as invalidation signals without receiving claim authority. */
    subscribe(listener: () => void): () => void;
    /** Reconcile every active record and queue at most one exact follow-up identity. */
    reconcile(signal?: AbortSignal): Promise<void>;
    /** Stop recovery, close cold-resumed handles, and release SQLite state. */
    dispose(): Promise<void>;
    private disposeOwner;
    private reserveRecord;
    private runRequested;
    private processClaim;
    private resolveAgent;
    private readEvents;
    private readPersistedEvents;
    private readDispatchedEvents;
    private failDispatch;
    private watchSettlement;
    private transition;
    private invalidate;
    private logInvalid;
    private removeLiveMarker;
    private releaseOwnedHandle;
    private assertExactLiveAgent;
    private assertOriginalTask;
    private assertFuture;
    private activateStore;
    private activateExistingStore;
    private schedule;
    private scheduleRetry;
    private scheduleLeaseRecovery;
    private clearLeaseRecovery;
    private clearRetry;
    private wakeRetries;
    private claimChanged;
    private notifySubscribers;
    private notifySubscriber;
    private assertActive;
}
/** Construct and initialize the plugin-owned durable owner. */
export declare function createInternalTaskContinuations(config: InternalTaskContinuationConfig): Promise<InternalTaskContinuationOwner>;
export type { ContinuationMessage };
//# sourceMappingURL=owner.d.ts.map
