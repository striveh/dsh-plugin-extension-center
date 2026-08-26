import type { ImmutablePlan, PlanAuthorizationState, PlanConsumptionTransition, PlanDecisionTransition } from './types.ts';
/**
 * Create the initial immutable authorization state for one verified plan.
 *
 * @param value Verified or serialized immutable plan.
 * @returns Pending plan state.
 */
export declare function createPlanAuthorizationState(value: ImmutablePlan): PlanAuthorizationState;
/**
 * Apply the plan's single trusted human decision after checking current revisions.
 *
 * @param state Current immutable plan state.
 * @param decisionValue Untrusted decision payload.
 * @param contextValue Current owner observations.
 * @param nowValue Trusted current time in epoch milliseconds.
 * @param recoveryExecutableValue Hash-pinned standalone recovery Consumer installed by the Host package.
 * @returns Approved, rejected, or expired state without operation authorization.
 */
export declare function decidePlan(state: PlanAuthorizationState, decisionValue: unknown, contextValue: unknown, nowValue: number): PlanDecisionTransition;
/**
 * Consume one approved plan exactly once and emit operation authorization.
 *
 * @param state Current immutable plan state.
 * @param operationIdValue New operation identifier.
 * @param contextValue Current owner observations.
 * @param nowValue Trusted current time in epoch milliseconds.
 * @returns Consumed plan state and its exact operation authorization.
 */
export declare function consumeApprovedPlan(state: PlanAuthorizationState, operationIdValue: unknown, contextValue: unknown, nowValue: number, recoveryExecutableValue: unknown): PlanConsumptionTransition;
//# sourceMappingURL=state.d.ts.map
