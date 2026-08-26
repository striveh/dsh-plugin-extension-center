import { readBoundedString, readNonNegativeInteger } from '../domain/codec.ts'
import { failDomain } from '../domain/errors.ts'
import { immutableJsonClone } from '../domain/json.ts'
import {
  assertImmutablePlan,
  decodeOperationAuthorization,
  decodePlanDecisionInput,
  decodePlanUseContext,
} from './codec.ts'
import type {
  ApprovedPlanState,
  ExpiredPlanState,
  ImmutablePlan,
  OperationAuthorization,
  PlanAuthorizationState,
  PlanConsumptionTransition,
  PlanDecisionInput,
  PlanDecisionRecord,
  PlanDecisionTransition,
  PlanRevisionFences,
  PlanUseContext,
} from './types.ts'

function assertPlanContext(plan: ImmutablePlan, value: unknown): PlanUseContext {
  const context = decodePlanUseContext(value)
  const content = plan.content
  const identityFields = [
    ['operationKind', context.operationKind, content.operationKind],
    ['targetKey', context.targetKey, content.targetKey],
    ['ownerKey', context.ownerKey, content.ownerKey],
    ['scopeKey', context.scopeKey, content.scopeKey],
    ['profileId', context.profileId, content.profileId],
  ] as const
  const identityMismatch = identityFields.find(([, observed, expected]) => observed !== expected)
  if (identityMismatch !== undefined) {
    failDomain('plan-context-mismatch', `plan ${identityMismatch[0]} does not match current context`)
  }
  const revisionFields: readonly (keyof PlanRevisionFences)[] = [
    'catalogRevision',
    'inventoryRevision',
    'targetRevision',
    'ownerRevision',
    'scopeRevision',
    'profileRevision',
  ]
  const stale = revisionFields.find(field => context.fences[field] !== content.fences[field])
  if (stale !== undefined) failDomain('revision-stale', `plan ${stale} fence is stale`)
  return context
}

function expiredState(plan: ImmutablePlan, nowMs: number): ExpiredPlanState {
  return immutableJsonClone({ status: 'expired', plan, expiredAtMs: nowMs }) as unknown as ExpiredPlanState
}

/**
 * Create the initial immutable authorization state for one verified plan.
 *
 * @param value Verified or serialized immutable plan.
 * @returns Pending plan state.
 */
export function createPlanAuthorizationState(value: ImmutablePlan): PlanAuthorizationState {
  const plan = assertImmutablePlan(value)
  return immutableJsonClone({ status: 'pending', plan }) as unknown as PlanAuthorizationState
}

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
export function decidePlan(
  state: PlanAuthorizationState,
  decisionValue: unknown,
  contextValue: unknown,
  nowValue: number,
): PlanDecisionTransition {
  if (state.status !== 'pending') failDomain('plan-replay', `plan is already ${state.status}`)
  const plan = assertImmutablePlan(state.plan)
  const nowMs = readNonNegativeInteger(nowValue, 'nowMs')
  if (nowMs >= plan.content.expiresAtMs) {
    return Object.freeze({ state: expiredState(plan, nowMs), authorization: null })
  }
  const decision: PlanDecisionInput = decodePlanDecisionInput(decisionValue)
  if (decision.planId !== plan.content.planId || decision.planHash !== plan.hash) {
    failDomain('plan-integrity', 'decision does not bind the exact plan')
  }
  if (decision.operationKind !== plan.content.operationKind) {
    failDomain('plan-context-mismatch', 'decision operation does not match the plan')
  }
  assertPlanContext(plan, contextValue)
  const record = immutableJsonClone({ ...decision, decidedAtMs: nowMs }) as unknown as PlanDecisionRecord
  if (record.decision === 'reject') {
    return Object.freeze({
      state: immutableJsonClone({ status: 'rejected', plan, decision: record }) as PlanDecisionTransition['state'],
      authorization: null,
    })
  }
  const approved = immutableJsonClone({ status: 'approved', plan, decision: record }) as unknown as ApprovedPlanState
  return Object.freeze({ state: approved, authorization: null })
}

/**
 * Consume one approved plan exactly once and emit operation authorization.
 *
 * @param state Current immutable plan state.
 * @param operationIdValue New operation identifier.
 * @param contextValue Current owner observations.
 * @param nowValue Trusted current time in epoch milliseconds.
 * @returns Consumed plan state and its exact operation authorization.
 */
export function consumeApprovedPlan(
  state: PlanAuthorizationState,
  operationIdValue: unknown,
  contextValue: unknown,
  nowValue: number,
  recoveryExecutableValue: unknown,
): PlanConsumptionTransition {
  if (state.status !== 'approved') failDomain('plan-replay', `plan cannot be consumed from ${state.status}`)
  const plan = assertImmutablePlan(state.plan)
  const nowMs = readNonNegativeInteger(nowValue, 'nowMs')
  if (nowMs >= plan.content.expiresAtMs) failDomain('plan-expired', 'approved plan expired before consumption')
  assertPlanContext(plan, contextValue)
  const operationId = readBoundedString(operationIdValue, 'operationId')
  const authorization: OperationAuthorization = decodeOperationAuthorization({
    operationId,
    planId: plan.content.planId,
    planHash: plan.hash,
    origin: plan.content.origin,
    candidateRef: plan.content.candidateRef,
    extensionKind: plan.content.extensionKind,
    extensionId: plan.content.extensionId,
    operationKind: plan.content.operationKind,
    managedObject: plan.content.managedObject,
    externalRuntimeAction: plan.content.externalRuntimeAction,
    runtimeBinding: plan.content.runtimeBinding,
    artifactRevision: plan.content.artifactRevision,
    artifactIntegrity: plan.content.artifactIntegrity,
    artifactUrl: plan.content.artifactUrl,
    artifactSizeBytes: plan.content.artifactSizeBytes,
    desiredState: plan.content.desiredState,
    targetKey: plan.content.targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    idempotencyKey: plan.content.idempotencyKey,
    authorityDigest: plan.content.authorityDigest,
    configurationDigest: plan.content.configurationDigest,
    retentionDigest: plan.content.retentionDigest,
    mutationDigest: plan.content.mutationDigest,
    verificationDigest: plan.content.verificationDigest,
    reviewEvidence: plan.content.reviewEvidence,
    restartRequired: plan.content.restartRequired,
    fences: plan.content.fences,
    recoveryExecutable: recoveryExecutableValue,
    authorizedAtMs: nowMs,
  })
  const consumed = immutableJsonClone({
    status: 'consumed',
    plan,
    decision: state.decision,
    authorization,
  }) as PlanConsumptionTransition['state']
  return Object.freeze({ state: consumed, authorization })
}
