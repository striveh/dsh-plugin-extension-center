import { type Sha256Digest } from '../domain/index.ts';
import { type ImmutablePlan, type OperationAuthorization, type PlanAuthorizationState, type PlanDecisionInput, type PlanUseContext, type RecoveryExecutableBinding } from '../plans/index.ts';
/** Durable immutable plan and single-assignment human-decision store. */
export declare class FilePlanStore {
    private readonly root;
    private readonly recoveryExecutable;
    private readonly queues;
    /**
     * Create a plan store below one center-owned data directory.
     * @param root Exact durable data directory.
     * @param recoveryExecutable Hash-pinned standalone recovery Consumer, or `null` on an explicitly read-only Host.
     */
    constructor(root: string, recoveryExecutable: RecoveryExecutableBinding | null);
    /**
     * Persist a new immutable plan, idempotently accepting the same exact plan.
     * @param value Verified or serialized plan.
     * @returns Initial pending authorization state.
     */
    put(value: ImmutablePlan): Promise<PlanAuthorizationState>;
    /**
     * Load the strongest durable state for one plan hash.
     * @param hash Exact immutable plan hash.
     * @returns Verified state, or `undefined` when no plan exists.
     */
    load(hash: Sha256Digest): Promise<PlanAuthorizationState | undefined>;
    /**
     * Record the only human decision after rechecking all current fences.
     * @param hash Exact plan hash.
     * @param decision Trusted loopback decision payload.
     * @param context Current authoritative owner revisions.
     * @param nowMs Trusted decision time.
     * @returns Approved, rejected, or expired durable state.
     */
    decide(hash: Sha256Digest, decision: PlanDecisionInput, context: PlanUseContext, nowMs: number): Promise<PlanAuthorizationState>;
    /**
     * Consume one approved plan once after rechecking all current fences.
     * @param hash Exact plan hash.
     * @param operationId New operation identity.
     * @param context Current authoritative owner revisions.
     * @param nowMs Trusted consumption time.
     * @returns Durable consumed state and exact operation authorization.
     */
    consume(hash: Sha256Digest, operationId: string, context: PlanUseContext, nowMs: number): Promise<Readonly<{
        state: PlanAuthorizationState;
        authorization: OperationAuthorization;
    }>>;
    /** Return every durable plan state sorted by plan id. */
    list(): Promise<readonly PlanAuthorizationState[]>;
    private planDirectory;
    private requireUnlocked;
    private loadUnlocked;
    private serialize;
}
//# sourceMappingURL=plan-store.d.ts.map
