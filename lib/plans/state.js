import { readBoundedString, readNonNegativeInteger } from "../domain/codec.js";
import { failDomain } from "../domain/errors.js";
import { immutableJsonClone } from "../domain/json.js";
import { assertImmutablePlan, decodeOperationAuthorization, decodePlanDecisionInput, decodePlanUseContext, } from "./codec.js";
function assertPlanContext(plan, value) {
    const context = decodePlanUseContext(value);
    const content = plan.content;
    const identityFields = [
        ['operationKind', context.operationKind, content.operationKind],
        ['targetKey', context.targetKey, content.targetKey],
        ['ownerKey', context.ownerKey, content.ownerKey],
        ['scopeKey', context.scopeKey, content.scopeKey],
        ['profileId', context.profileId, content.profileId],
    ];
    const identityMismatch = identityFields.find(([, observed, expected]) => observed !== expected);
    if (identityMismatch !== undefined) {
        failDomain('plan-context-mismatch', `plan ${identityMismatch[0]} does not match current context`);
    }
    const revisionFields = [
        'catalogRevision',
        'inventoryRevision',
        'targetRevision',
        'ownerRevision',
        'scopeRevision',
        'profileRevision',
    ];
    const stale = revisionFields.find(field => context.fences[field] !== content.fences[field]);
    if (stale !== undefined)
        failDomain('revision-stale', `plan ${stale} fence is stale`);
    return context;
}
function expiredState(plan, nowMs) {
    return immutableJsonClone({ status: 'expired', plan, expiredAtMs: nowMs });
}
/**
 * Create the initial immutable authorization state for one verified plan.
 *
 * @param value Verified or serialized immutable plan.
 * @returns Pending plan state.
 */
export function createPlanAuthorizationState(value) {
    const plan = assertImmutablePlan(value);
    return immutableJsonClone({ status: 'pending', plan });
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
export function decidePlan(state, decisionValue, contextValue, nowValue) {
    if (state.status !== 'pending')
        failDomain('plan-replay', `plan is already ${state.status}`);
    const plan = assertImmutablePlan(state.plan);
    const nowMs = readNonNegativeInteger(nowValue, 'nowMs');
    if (nowMs >= plan.content.expiresAtMs) {
        return Object.freeze({ state: expiredState(plan, nowMs), authorization: null });
    }
    const decision = decodePlanDecisionInput(decisionValue);
    if (decision.planId !== plan.content.planId || decision.planHash !== plan.hash) {
        failDomain('plan-integrity', 'decision does not bind the exact plan');
    }
    if (decision.operationKind !== plan.content.operationKind) {
        failDomain('plan-context-mismatch', 'decision operation does not match the plan');
    }
    assertPlanContext(plan, contextValue);
    const record = immutableJsonClone({ ...decision, decidedAtMs: nowMs });
    if (record.decision === 'reject') {
        return Object.freeze({
            state: immutableJsonClone({ status: 'rejected', plan, decision: record }),
            authorization: null,
        });
    }
    const approved = immutableJsonClone({ status: 'approved', plan, decision: record });
    return Object.freeze({ state: approved, authorization: null });
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
export function consumeApprovedPlan(state, operationIdValue, contextValue, nowValue, recoveryExecutableValue) {
    if (state.status !== 'approved')
        failDomain('plan-replay', `plan cannot be consumed from ${state.status}`);
    const plan = assertImmutablePlan(state.plan);
    const nowMs = readNonNegativeInteger(nowValue, 'nowMs');
    if (nowMs >= plan.content.expiresAtMs)
        failDomain('plan-expired', 'approved plan expired before consumption');
    assertPlanContext(plan, contextValue);
    const operationId = readBoundedString(operationIdValue, 'operationId');
    const authorization = decodeOperationAuthorization({
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
    });
    const consumed = immutableJsonClone({
        status: 'consumed',
        plan,
        decision: state.decision,
        authorization,
    });
    return Object.freeze({ state: consumed, authorization });
}
//# sourceMappingURL=state.js.map
