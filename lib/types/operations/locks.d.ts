import type { TargetLockState } from './types.ts';
/** Create an empty immutable per-target serialization state. */
export declare function createTargetLockState(): TargetLockState;
/**
 * Acquire one target for an operation without mutating the prior lock state.
 *
 * @param value Current target lock state.
 * @param targetKeyValue Exact target identity.
 * @param operationIdValue Exact operation identity.
 * @returns New immutable lock state.
 */
export declare function acquireTarget(value: TargetLockState, targetKeyValue: unknown, operationIdValue: unknown): TargetLockState;
/**
 * Release one target only for the operation that owns it.
 *
 * @param value Current target lock state.
 * @param targetKeyValue Exact target identity.
 * @param operationIdValue Exact operation identity.
 * @returns New immutable lock state.
 */
export declare function releaseTarget(value: TargetLockState, targetKeyValue: unknown, operationIdValue: unknown): TargetLockState;
//# sourceMappingURL=locks.d.ts.map
