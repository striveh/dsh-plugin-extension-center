import { type ImmutablePlan, type OperationAuthorization, type PlanAuthorizationState, type PlanContent, type PlanDecisionInput, type RecoveryExecutableBinding, type PlanUseContext } from './types.ts';
/** Strictly decode the absolute hash-pinned break-glass executable, Host CLI, and Host home. */
export declare function decodeRecoveryExecutableBinding(value: unknown, path?: string): RecoveryExecutableBinding;
/**
 * Strictly decode canonical immutable plan content.
 *
 * @param value Untrusted plan content.
 * @returns Recursively frozen validated content.
 */
export declare function decodePlanContent(value: unknown): PlanContent;
/**
 * Create one recursively frozen plan and bind its exact canonical hash.
 *
 * @param value Untrusted plan content.
 * @returns Immutable plan.
 */
export declare function createImmutablePlan(value: unknown): ImmutablePlan;
/**
 * Strictly decode an immutable plan and reject content tampering.
 *
 * @param value Untrusted serialized plan.
 * @returns Recursively frozen verified plan.
 */
export declare function decodeImmutablePlan(value: unknown): ImmutablePlan;
/**
 * Revalidate a typed plan before every authorization transition.
 *
 * @param plan Candidate immutable plan.
 * @returns Verified recursively frozen plan.
 */
export declare function assertImmutablePlan(plan: ImmutablePlan): ImmutablePlan;
/**
 * Strictly decode one human decision.
 *
 * @param value Untrusted decision payload.
 * @returns Recursively frozen decision.
 */
export declare function decodePlanDecisionInput(value: unknown): PlanDecisionInput;
/**
 * Strictly decode current owner observations used by revision fences.
 *
 * @param value Untrusted observation payload.
 * @returns Recursively frozen observation.
 */
export declare function decodePlanUseContext(value: unknown): PlanUseContext;
/**
 * Strictly decode an operation authorization produced by plan consumption.
 *
 * @param value Untrusted authorization payload.
 * @returns Recursively frozen authorization.
 */
export declare function decodeOperationAuthorization(value: unknown): OperationAuthorization;
/**
 * Strictly decode one durable plan authorization state and verify all identity bindings.
 *
 * @param value Untrusted persisted plan state.
 * @returns Recursively frozen verified state.
 */
export declare function decodePlanAuthorizationState(value: unknown): PlanAuthorizationState;
//# sourceMappingURL=codec.d.ts.map
