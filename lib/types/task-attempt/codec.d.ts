import type { TaskAttempt, TaskAttemptDerivation, TaskRetryContinuation } from './types.ts';
/** Decode one task attempt and enforce its terminal/result invariants. */
export declare function decodeTaskAttempt(value: unknown, expectedTaskAttemptId?: string): TaskAttempt;
/** Decode one durable one-shot task-attempt derivation claim. */
export declare function decodeTaskAttemptDerivation(value: unknown, expectedSourceAttemptId?: string): TaskAttemptDerivation;
/** Decode one durable verifier binding for management Retry original. */
export declare function decodeTaskRetryContinuation(value: unknown, expectedTaskAttemptId?: string): TaskRetryContinuation;
//# sourceMappingURL=codec.d.ts.map
