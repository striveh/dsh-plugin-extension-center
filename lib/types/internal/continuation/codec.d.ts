/** Strict codecs for plugin-owned continuation inputs and durable records. */
import type { ContinuationAgent, ContinuationAgentOptions, ContinuationMessage, CreateTaskContinuationRequest, ListTaskContinuationsRequest, ReserveTaskContinuationRequest, SupersedeTaskContinuationRequest, TaskContinuationClaim, TaskContinuationInvalidReason, TaskContinuationRef, TaskContinuationReady } from './types.ts';
/** Fixed prompt that asks the existing Agent to re-check the now-visible capability. */
export declare const TASK_CONTINUATION_PROMPT = "The requested capability is now verified for the existing task. Re-check it and continue that task.";
/** Stable rejection for malformed continuation input. */
export declare class TaskContinuationInputError extends Error {
    readonly code = "TASK_CONTINUATION_INVALID_INPUT";
}
/** Stable rejection for replay of one caller key with different immutable fields. */
export declare class TaskContinuationMutationConflictError extends Error {
    readonly code = "TASK_CONTINUATION_MUTATION_CONFLICT";
    constructor(callerId: string, mutationId: string);
}
/** Parse one fixed invalid-claim diagnosis without admitting free-form text. */
export declare function invalidReason(value: unknown): TaskContinuationInvalidReason;
/** Parse the exact fields shared by live and cold reservations. */
export declare function createRequest(value: unknown): CreateTaskContinuationRequest;
/** Parse a cold-safe reservation including its restricted Agent route. */
export declare function reserveRequest(value: unknown): ReserveTaskContinuationRequest;
/** Parse optional exact list filters. */
export declare function listRequest(value?: unknown): ListTaskContinuationsRequest;
/** Parse an exact cancel fence. */
export declare function continuationRef(value: unknown): TaskContinuationRef;
/** Parse an exact supersede fence and replacement revision. */
export declare function supersedeRequest(value: unknown): SupersedeTaskContinuationRequest;
/** Validate and snapshot a bounded cold-resume route. */
export declare function agentOptions(value: unknown): Readonly<ContinuationAgentOptions>;
/** Parse an unknown live Agent at the official same-process boundary. */
export declare function continuationAgent(value: unknown): ContinuationAgent;
/** Create the ordinary plugin-sourced follow-up without original task text. */
export declare function continuationMessage(claim: TaskContinuationClaim): ContinuationMessage;
/** Compare a message to the one canonical dispatch identity and content. */
export declare function isContinuationMessage(value: unknown, claim: TaskContinuationClaim): boolean;
/** Require a fully echoed positive verifier result. */
export declare function readyDecision(value: unknown, claim: TaskContinuationClaim): TaskContinuationReady | 'not-ready' | 'invalid';
/** Compare restricted routes without depending on object key order. */
export declare function sameAgentOptions(left: Readonly<ContinuationAgentOptions>, right: Readonly<ContinuationAgentOptions>): boolean;
/** Compare one existing claim with an idempotent replay. */
export declare function assertSameReservation(existing: TaskContinuationClaim, request: CreateTaskContinuationRequest, options: Readonly<ContinuationAgentOptions>): void;
/** Validate one database or API continuation identity. */
export declare function continuationId(value: unknown): string;
/** Validate one database state-machine revision. */
export declare function taskRevision(value: unknown): string;
//# sourceMappingURL=codec.d.ts.map
