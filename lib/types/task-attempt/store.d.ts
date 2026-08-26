import type { TaskAttempt, TaskAttemptAgentRoute, TaskAttemptNeed, TaskAttemptOutcome, TaskAttemptPhase, TaskAttemptResult, TaskRetryContinuation } from './types.ts';
/** Strict file-backed owner for terminal-once original-task attempts. */
export declare class FileTaskAttemptStore {
    private readonly root;
    private queue;
    constructor(root: string);
    /** Audit records and complete any derivation interrupted after its durable claim. */
    initialize(): Promise<void>;
    /** Start one model-origin attempt and supersede older mutable attempts for the same message. */
    create(input: Readonly<{
        sessionId: string;
        originalMessageId: string;
        profileId: string;
        projectRoot: string;
        need: TaskAttemptNeed;
        resumeAgentOptions: TaskAttemptAgentRoute;
        createdAtMs: number;
        expiresAtMs: number;
    }>): Promise<TaskAttempt>;
    /** Derive exactly one new attempt from one terminal choice or management handoff. */
    derive(input: Readonly<{
        sourceAttemptId: string;
        kind: 'choice-selection' | 'retry-original';
        candidateRef: string | null;
        createdAtMs: number;
        expiresAtMs: number;
    }>): Promise<TaskAttempt>;
    /** Read one task attempt by opaque id. */
    get(taskAttemptId: string): Promise<TaskAttempt | undefined>;
    /** Find the exact task attempt that owns one candidate-bound resolution. */
    getByResolution(resolutionId: string): Promise<TaskAttempt | undefined>;
    /** Read one Retry-original continuation binding by its derived task attempt. */
    getRetryContinuation(taskAttemptId: string): Promise<TaskRetryContinuation | undefined>;
    /** Persist the verifier binding before asking the Host continuation owner to reserve. */
    putRetryContinuation(value: TaskRetryContinuation): Promise<TaskRetryContinuation>;
    /** Bind the actual Host continuation id after an exact reserve or restart reconciliation. */
    bindRetryContinuation(taskAttemptId: string, continuationId: string): Promise<TaskRetryContinuation>;
    /** Persist a cancellation intent before reconciling it with the Host continuation owner. */
    cancelRetryContinuation(taskAttemptId: string, nowMs: number): Promise<TaskRetryContinuation>;
    /** List every task attempt deterministically. */
    list(): Promise<readonly TaskAttempt[]>;
    /** Advance a mutable task phase with an optional non-authorizing result. */
    transition(taskAttemptId: string, expectedRevision: number, phase: TaskAttemptPhase, result: TaskAttemptResult, nowMs: number): Promise<TaskAttempt>;
    /** Assign one terminal outcome exactly once. */
    close(taskAttemptId: string, expectedRevision: number, outcome: TaskAttemptOutcome, reason: string, result: TaskAttemptResult, nowMs: number): Promise<TaskAttempt>;
    /** Reject an expired mutable attempt once and return its current terminal state on replay. */
    expire(taskAttemptId: string, nowMs: number): Promise<TaskAttempt>;
    private closeUnlocked;
    private required;
    private assertDerivation;
    private assertInheritedAttempt;
    private assertClaimChild;
    private assertRetryContinuation;
    private putExclusiveAttempt;
    private getDerivation;
    private listDerivations;
    private attemptPath;
    private derivationPath;
    private retryContinuationPath;
    private listRetryContinuations;
    private listGroup;
    private serialize;
}
//# sourceMappingURL=store.d.ts.map
