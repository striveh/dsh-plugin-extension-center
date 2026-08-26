import type { Sha256Digest } from '../domain/index.ts';
/** Mutable progress of one original-task capability attempt before its terminal result. */
export type TaskAttemptPhase = 'checking-existing' | 'resolving' | 'awaiting-approval' | 'acquiring' | 'verifying-visibility' | 'restart-required' | 'ready-to-resume' | 'resuming';
/** Single-assignment result of one task attempt, independent from any extension operation. */
export type TaskAttemptOutcome = 'use-existing' | 'continued' | 'choice-required' | 'management-required' | 'no-eligible-candidate' | 'discovery-unavailable' | 'external-only' | 'rejected' | 'canceled' | 'recovery-required' | 'resume-conflict' | 'failed';
/** Safe normalized need retained for eligibility replay without retaining the raw task. */
export interface TaskAttemptNeed {
    readonly schemaVersion: 1;
    readonly outcomeTags: readonly string[];
    readonly inputModalities: readonly ('audio' | 'file' | 'image' | 'structured-data' | 'text' | 'video')[];
    readonly outputModalities: readonly ('audio' | 'file' | 'image' | 'structured-data' | 'text' | 'video')[];
    readonly scopeKey: 'profile:web' | 'project' | 'user';
    readonly platform: 'darwin' | 'linux' | 'windows';
    readonly requiredDataAccess: readonly ('filesystem-read' | 'filesystem-write' | 'network' | 'subprocess')[];
    readonly maximumAuthority: readonly ('filesystem-read' | 'filesystem-write' | 'network' | 'subprocess')[];
}
/** Bounded Agent route retained for a new attempt and eventual continuation. */
export interface TaskAttemptAgentRoute {
    readonly provider?: string;
    readonly model?: string;
    readonly maxTokens?: number;
}
/** Non-authorizing decision evidence retained by one task attempt. */
export type TaskAttemptResult = null | Readonly<{
    kind: 'use-existing';
    capabilityId: string;
}> | Readonly<{
    kind: 'choice-required';
    candidateRefs: readonly string[];
}> | Readonly<{
    kind: 'management-required';
    extensionRef: string;
    targetKey: string;
    action: 'configure' | 'enable' | 'restore' | 'update';
}> | Readonly<{
    kind: 'acquisition-candidate';
    resolutionId: string;
    candidateRef: string;
    continuationId: string;
    verificationPayloadDigest: Sha256Digest;
}>;
/** Durable state of one existing-first attempt for one original user message. */
export interface TaskAttempt {
    readonly schemaVersion: 1;
    readonly taskAttemptId: string;
    readonly parentAttemptId: string | null;
    readonly trigger: 'model' | 'choice-selection' | 'retry-original';
    readonly revision: number;
    readonly sessionId: string;
    readonly originalMessageId: string;
    readonly profileId: string;
    readonly projectRoot: string;
    readonly need: TaskAttemptNeed;
    readonly needDigest: Sha256Digest;
    readonly resumeAgentOptions: TaskAttemptAgentRoute;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
    readonly updatedAtMs: number;
    readonly phase: TaskAttemptPhase;
    readonly outcome: TaskAttemptOutcome | null;
    readonly reason: string | null;
    readonly result: TaskAttemptResult;
}
/** Immutable one-shot claim that creates a new attempt from a terminal predecessor. */
export interface TaskAttemptDerivation {
    readonly schemaVersion: 1;
    readonly sourceAttemptId: string;
    readonly kind: 'choice-selection' | 'retry-original';
    readonly candidateRef: string | null;
    readonly createdAtMs: number;
    readonly attempt: TaskAttempt;
}
/** Durable verifier binding for a management Retry-original continuation. */
export interface TaskRetryContinuation {
    readonly schemaVersion: 1;
    readonly taskAttemptId: string;
    readonly parentAttemptId: string;
    readonly sessionId: string;
    readonly originalMessageId: string;
    readonly needDigest: Sha256Digest;
    readonly targetKey: string;
    readonly action: 'configure' | 'enable' | 'restore' | 'update';
    readonly existingCapabilityId: string;
    readonly verificationPayloadDigest: Sha256Digest;
    readonly continuationId: string | null;
    readonly canceledAtMs: number | null;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
}
/** Host-owned lifecycle states exposed for one durable Retry-original continuation. */
export type TaskRetryContinuationState = 'pending' | 'ready' | 'consumed' | 'claimed' | 'canceled' | 'superseded' | 'expired' | 'invalid';
/** Activity states, including Center-to-Host reconciliation and observation failure. */
export type TaskRetryContinuationProjectionState = TaskRetryContinuationState | 'reconciling' | 'unavailable';
/** Public state joined from the Center binding and its exact Host continuation claim. */
export interface TaskRetryContinuationProjection {
    readonly continuationId: string | null;
    readonly state: TaskRetryContinuationProjectionState;
}
/** Public task-attempt projection that omits the internal managed target key and Agent route. */
export interface TaskAttemptProjection {
    readonly taskAttemptId: string;
    readonly parentAttemptId: string | null;
    readonly trigger: TaskAttempt['trigger'];
    readonly sessionId: string;
    readonly originalMessageId: string;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
    readonly updatedAtMs: number;
    readonly phase: TaskAttemptPhase;
    readonly outcome: TaskAttemptOutcome | null;
    readonly reason: string | null;
    readonly choice: Readonly<{
        candidateRefs: readonly string[];
    }> | null;
    readonly management: Readonly<{
        extensionRef: string;
        action: 'configure' | 'enable' | 'restore' | 'update';
    }> | null;
    readonly acquisition: Readonly<{
        resolutionId: string;
        candidateRef: string;
        continuationId: string;
    }> | null;
    /** Null when this attempt did not create a Retry-original continuation. */
    readonly retryContinuation: TaskRetryContinuationProjection | null;
}
//# sourceMappingURL=types.d.ts.map
