import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogReviewEvidenceSupport } from "../catalog.js";
import { canonicalSha256 } from "../domain/index.js";
import { hostCapabilities } from "../host/index.js";
import { createImmutablePlan, } from "../plans/index.js";
import { evaluateCandidatePolicy, mintAcquisitionIntent, candidateAdmissionFacts, currentHostPlatform, verificationRecipeDigest, } from "../policy/index.js";
import { buildCapabilityResolverPatch, hasPluginConfigurationAdapter, pluginConfigurationMutationDigest, preflightSkillConfiguration, } from "../providers/index.js";
import { admitCenterManagement, admitInstallTarget } from "./management-admission.js";
import { HOST_RPC_PROTOCOL_VERSION } from "./rpc-contract.js";
import { buildPlanReviewEvidence } from "./review-evidence.js";
/** Admission refusal that retains the exact policy result for strict RPC projection. */
export class IntentPolicyDeniedError extends Error {
    policy;
    constructor(policy) {
        super(policy.reason);
        this.policy = policy;
        this.name = 'IntentPolicyDeniedError';
    }
}
function profileObservation(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Profile owner observation is invalid');
    const item = value;
    if (!Number.isSafeInteger(item.revision) || typeof item.treeDigest !== 'string' || typeof item.effectivePath !== 'string'
        || (item.activeGeneration !== null && typeof item.activeGeneration !== 'string')
        || (item.lastGoodGeneration !== null && typeof item.lastGoodGeneration !== 'string')
        || (item.rollbackGeneration !== null && typeof item.rollbackGeneration !== 'string')) {
        throw new Error('Profile owner observation fields are invalid');
    }
    return item;
}
function profileFence(value) {
    return `profile:${String(value.revision)}:${value.treeDigest}`;
}
/** Resolve the post-operation desired state from the exact retained version the provider will select. */
export function resolveDesiredState(operation, origin, kind, record) {
    if (operation === 'uninstall' || operation === 'purge')
        return 'removed';
    if (operation === 'disable')
        return 'disabled';
    if (operation === 'enable')
        return 'enabled';
    if (operation === 'install')
        return origin === 'store' && kind === 'mcp' ? 'disabled' : 'enabled';
    if (operation === 'restore') {
        const restored = record?.current === null ? record.removed : record?.lastGood;
        return restored?.enabled === false ? 'disabled' : 'enabled';
    }
    return record?.current?.enabled === false ? 'disabled' : 'enabled';
}
function ownerKey(kind) {
    return kind === 'plugin' ? 'profileTransactions' : kind === 'mcp' ? 'mcpConnections' : 'skills';
}
function targetKey(entry, scopeKey, profileId) {
    return `${entry.kind}:${profileId}:${scopeKey}:${entry.name}`;
}
function authorityDelta(entry, configuration, runtimeDescriptorDigest) {
    return canonicalSha256({
        candidateRef: entry.candidateRef,
        permissions: entry.permissions,
        dependencies: entry.dependencies,
        configuration,
        runtimeDescriptorDigest,
    });
}
/** Intent, immutable-plan, fence, and trusted-decision owner. */
export class IntentPlanService {
    store;
    plans;
    inventory;
    owners;
    catalog;
    preflight;
    planTtlMs;
    constructor(store, plans, inventory, owners, catalog, preflight, planTtlMs = 15 * 60 * 1000) {
        this.store = store;
        this.plans = plans;
        this.inventory = inventory;
        this.owners = owners;
        this.catalog = catalog;
        this.preflight = preflight;
        this.planTtlMs = planTtlMs;
    }
    /** Mint a plan from a browser Store/Installed action or an internally verified task resolution. */
    async preview(request, authority, nowMs = Date.now(), taskBinding = null) {
        if ((authority === 'loopback-browser') !== (request.origin === 'store'))
            throw new Error('intent origin is not authorized by this carrier');
        const capabilities = hostCapabilities(this.owners);
        if (!capabilities.acquisition) {
            throw new IntentPolicyDeniedError({
                status: 'denied', policyRevision: 'extension-center-p0-policy-v2', code: 'host-capability',
                reason: 'the exact Host does not publish every required P0 owner and consumer',
            });
        }
        const catalog = this.catalog();
        const entry = catalog.envelope.entries.find(candidate => candidate.candidateRef === request.candidateRef);
        if (entry === undefined)
            throw new Error('candidateRef is absent from the current verified catalog');
        if (catalogReviewEvidenceSupport(entry) === 'unavailable') {
            throw new IntentPolicyDeniedError({
                status: 'denied',
                policyRevision: 'extension-center-p0-policy-v2',
                code: 'review-evidence-unavailable',
                reason: 'the exact candidate has no review evidence record understood by this package',
            });
        }
        if (entry.kind === 'skill' && request.scopeKey === 'project') {
            throw new IntentPolicyDeniedError({
                status: 'denied',
                policyRevision: 'extension-center-p0-policy-v2',
                code: 'action-unavailable',
                reason: 'project-scoped Skill writes require a published workspace and Agent selector',
            });
        }
        if (request.origin === 'task')
            await this.assertTaskBinding(request, entry, taskBinding);
        else if (taskBinding !== null)
            throw new Error('Store intent cannot carry a task binding');
        let payloadConfiguration = entry.kind === 'skill'
            ? await preflightSkillConfiguration(request.configuration, request.scopeKey)
            : request.configuration;
        const skillProjectRoot = entry.kind === 'skill' && request.scopeKey === 'project'
            ? String(payloadConfiguration.projectRoot)
            : null;
        const snapshot = await this.inventory.list(request.scopeKey, request.profileId, skillProjectRoot);
        const inferredTarget = targetKey(entry, request.scopeKey, request.profileId);
        const selectedTarget = request.targetKey ?? inferredTarget;
        const managed = await this.store.getManaged(selectedTarget);
        const row = snapshot.rows.find(item => item.targetKey === selectedTarget);
        let policy;
        const management = ['enable', 'disable', 'purge'].includes(request.operationKind);
        if (management) {
            const admitted = admitCenterManagement({
                operationKind: request.operationKind,
                targetKey: request.targetKey,
                scopeKey: request.scopeKey,
                profileId: request.profileId,
                candidate: entry,
                inventory: snapshot,
                managed,
            });
            if (admitted.status === 'denied')
                throw new IntentPolicyDeniedError(admitted.policy);
            policy = admitted.policy;
            payloadConfiguration = admitted.record.current?.configuration
                ?? admitted.record.removed?.configuration
                ?? admitted.record.lastGood?.configuration
                ?? null;
        }
        else {
            if (request.operationKind !== 'install') {
                if (managed === undefined || row === undefined || row.ownership !== 'center') {
                    throw new IntentPolicyDeniedError({
                        status: 'denied', policyRevision: 'extension-center-p0-policy-v2', code: 'action-unavailable',
                        reason: 'the lifecycle action requires an exact center-owned installed row',
                    });
                }
                const action = row.actions[request.operationKind];
                if (action.status !== 'available') {
                    throw new IntentPolicyDeniedError({
                        status: 'denied', policyRevision: 'extension-center-p0-policy-v2', code: 'action-unavailable',
                        reason: action.reason ?? 'the current inventory row does not admit this action',
                    });
                }
            }
            else {
                const denied = admitInstallTarget(row, managed);
                if (denied !== null)
                    throw new IntentPolicyDeniedError(denied);
            }
            const runtime = entry.kind === 'mcp'
                ? await this.preflight.mcpRuntime(entry.candidateRef, payloadConfiguration)
                : null;
            const externalRuntimeResolved = entry.kind !== 'mcp' || runtime !== null;
            const admission = candidateAdmissionFacts(entry, request.operationKind);
            policy = evaluateCandidatePolicy({
                entry,
                catalogVerified: true,
                catalogComplete: snapshot.complete,
                hostCapabilities: capabilities,
                operationKind: request.operationKind,
                desiredState: resolveDesiredState(request.operationKind, request.origin, entry.kind, managed),
                selectedScope: request.scopeKey,
                currentPlatform: currentHostPlatform(),
                completeLifecycle: admission.completeLifecycle,
                authorityKnown: admission.authorityKnown,
                authorityDigest: authorityDelta(entry, payloadConfiguration, runtime?.descriptorDigest ?? null),
                lifecycleScriptControl: admission.lifecycleScriptControl,
                externalRuntimeResolved,
                reviewEvidenceAvailable: admission.reviewEvidenceAvailable,
                verificationRecipeComplete: admission.verificationRecipeComplete,
                taskOneClick: false,
                unresolvedUserChoices: 0,
            });
            if (policy.status === 'denied')
                throw new IntentPolicyDeniedError(policy);
        }
        if (policy.status !== 'eligible')
            throw new IntentPolicyDeniedError(policy);
        const profile = profileObservation(await this.owners.profileTransactions.snapshot(request.profileId));
        const ownerRevision = await this.ownerRevision(entry, row, skillProjectRoot);
        const profileRevision = profileFence(profile);
        const runtime = entry.kind === 'mcp'
            ? await this.preflight.mcpRuntime(entry.candidateRef, payloadConfiguration)
            : null;
        if (entry.kind === 'mcp' && runtime === null)
            throw new Error('MCP runtime preflight changed while creating the plan');
        let mutationDigest = canonicalSha256({
            operationKind: request.operationKind,
            candidateRef: entry.candidateRef,
            targetKey: selectedTarget,
            configuration: payloadConfiguration,
            desiredState: resolveDesiredState(request.operationKind, request.origin, entry.kind, managed),
            ownerRevision,
            targetRevision: row?.managedRevision ?? 'absent',
            runtimeDescriptorDigest: runtime?.descriptorDigest ?? null,
        });
        if (request.operationKind === 'configure' && entry.kind === 'plugin') {
            if (!hasPluginConfigurationAdapter(entry.candidateRef, entry.artifact.version)) {
                throw new IntentPolicyDeniedError({
                    status: 'denied', policyRevision: 'extension-center-p0-policy-v2', code: 'action-unavailable',
                    reason: 'the exact Plugin version has no typed configuration adapter',
                });
            }
            const patch = buildCapabilityResolverPatch(await readFile(join(profile.effectivePath, 'cordis.patch.yml'), 'utf8'), payloadConfiguration);
            mutationDigest = pluginConfigurationMutationDigest(patch, profileRevision);
        }
        const candidate = {
            kind: entry.kind,
            extensionId: entry.name,
            candidateRef: entry.candidateRef,
            artifactRevision: entry.artifact.version,
            artifactIntegrity: entry.artifact.integrity,
            artifactUrl: entry.artifact.acquisitionUrl,
            artifactSizeBytes: entry.artifact.sizeBytes,
            scopeKey: request.scopeKey,
            profileId: request.profileId,
            operationKind: request.operationKind,
            desiredState: resolveDesiredState(request.operationKind, request.origin, entry.kind, managed),
            admittedCapabilities: Object.freeze([...entry.tags].sort()),
            authorityDeltaDigest: authorityDelta(entry, payloadConfiguration, runtime?.descriptorDigest ?? null),
            policyResult: policy,
            catalogRevision: catalog.envelope.revision,
            inventoryRevision: snapshot.revision,
        };
        const intentId = taskBinding?.intentId ?? `intent:${randomUUID()}`;
        const createdAtMs = taskBinding?.createdAtMs ?? nowMs;
        const expiresAtMs = taskBinding?.expiresAtMs ?? nowMs + this.planTtlMs;
        const intent = mintAcquisitionIntent({
            intentId,
            origin: request.origin,
            idempotencyKey: canonicalSha256({ origin: request.origin, selectedTarget, mutationDigest, createdAtMs }),
            ...(request.continuationId === null ? {} : { continuationId: request.continuationId }),
            createdAtMs,
            expiresAtMs,
            candidate,
        });
        const reviewEvidence = await buildPlanReviewEvidence({
            entry,
            operationKind: request.operationKind,
            profileId: request.profileId,
            ownerRevision,
            configuration: payloadConfiguration,
            managed,
            profile,
            runtime,
        });
        const plan = createImmutablePlan({
            schemaVersion: 1,
            singleUse: true,
            planId: taskBinding?.planId ?? `plan:${randomUUID()}`,
            intentId,
            origin: request.origin,
            candidateRef: entry.candidateRef,
            extensionKind: entry.kind,
            extensionId: entry.name,
            managedObject: entry.kind === 'mcp' ? 'connection' : 'artifact',
            externalRuntimeAction: entry.kind === 'mcp' || !['install', 'update'].includes(request.operationKind)
                ? 'none'
                : 'download',
            runtimeBinding: runtime === null ? null : {
                runtimeRef: runtime.runtimeRef,
                version: runtime.version,
                descriptorDigest: runtime.descriptorDigest,
            },
            artifactRevision: entry.artifact.version,
            artifactIntegrity: entry.artifact.integrity,
            artifactUrl: entry.artifact.acquisitionUrl,
            artifactSizeBytes: entry.artifact.sizeBytes,
            operationKind: request.operationKind,
            desiredState: candidate.desiredState,
            targetKey: selectedTarget,
            ownerKey: ownerKey(entry.kind),
            scopeKey: request.scopeKey,
            profileId: request.profileId,
            idempotencyKey: intent.idempotencyKey,
            authorityDigest: policy.authorityDigest,
            configurationDigest: canonicalSha256(payloadConfiguration),
            retentionDigest: canonicalSha256({ candidateRef: entry.candidateRef, retainedData: entry.retainedData }),
            mutationDigest,
            verificationDigest: verificationRecipeDigest(entry.kind, request.operationKind, candidate.desiredState),
            reviewEvidence,
            restartRequired: entry.restart.required,
            createdAtMs,
            expiresAtMs,
            fences: {
                catalogRevision: catalog.envelope.revision,
                inventoryRevision: snapshot.revision,
                targetRevision: row?.managedRevision ?? 'absent',
                ownerRevision,
                scopeRevision: canonicalSha256({
                    scopeKey: request.scopeKey,
                    profileId: request.profileId,
                    configuration: payloadConfiguration,
                    runtimeDescriptorDigest: runtime?.descriptorDigest ?? null,
                }),
                profileRevision,
            },
        });
        const stored = {
            schemaVersion: 1,
            intent,
            payload: {
                configuration: payloadConfiguration,
                continuationId: request.continuationId,
                resolutionId: taskBinding?.resolutionId ?? null,
                verificationPayloadDigest: taskBinding?.verificationPayloadDigest ?? null,
                taskSessionId: taskBinding?.sessionId ?? null,
                taskOriginalMessageId: taskBinding?.originalMessageId ?? null,
            },
            planHash: plan.hash,
        };
        await this.store.putIntent(stored);
        await this.plans.put(plan);
        return Object.freeze({ protocolVersion: HOST_RPC_PROTOCOL_VERSION, intentId, plan, policy });
    }
    /** Re-observe every fence before decision or consumption. */
    async context(plan) {
        const entry = this.catalog().envelope.entries.find(candidate => candidate.candidateRef === plan.content.candidateRef);
        if (entry === undefined)
            throw new Error('plan candidate disappeared from the verified catalog');
        if (plan.content.verificationDigest !== verificationRecipeDigest(entry.kind, plan.content.operationKind, plan.content.desiredState))
            throw new Error('plan verification recipe is stale or invalid');
        const stored = await this.store.getIntent(plan.content.intentId);
        if (stored === undefined || stored.planHash !== plan.hash)
            throw new Error('plan has no exact durable intent binding');
        if (plan.content.configurationDigest !== canonicalSha256(stored.payload.configuration)) {
            throw new Error('plan configuration digest does not bind the durable typed payload');
        }
        if (plan.content.retentionDigest !== canonicalSha256({ candidateRef: entry.candidateRef, retainedData: entry.retainedData })) {
            throw new Error('plan retention digest does not bind the verified catalog');
        }
        if (plan.content.restartRequired !== entry.restart.required) {
            throw new Error('plan restart requirement does not bind the verified catalog');
        }
        const skillProjectRoot = entry.kind === 'skill' && plan.content.scopeKey === 'project'
            ? String(stored.payload.configuration.projectRoot)
            : null;
        const snapshot = await this.inventory.list(plan.content.scopeKey, plan.content.profileId, skillProjectRoot);
        const row = snapshot.rows.find(item => item.targetKey === plan.content.targetKey);
        const profile = profileObservation(await this.owners.profileTransactions.snapshot(plan.content.profileId));
        const runtime = entry.kind === 'mcp'
            ? await this.preflight.mcpRuntime(entry.candidateRef, stored.payload.configuration)
            : null;
        if (entry.kind === 'mcp' && runtime === null)
            throw new Error('MCP runtime preflight is no longer satisfied');
        const ownerRevision = await this.ownerRevision(entry, row, skillProjectRoot);
        const reviewEvidence = await buildPlanReviewEvidence({
            entry,
            operationKind: plan.content.operationKind,
            profileId: plan.content.profileId,
            ownerRevision,
            configuration: stored.payload.configuration,
            managed: await this.store.getManaged(plan.content.targetKey),
            profile,
            runtime,
        });
        if (canonicalSha256(reviewEvidence) !== canonicalSha256(plan.content.reviewEvidence)) {
            throw new Error('plan review evidence changed after preview');
        }
        return Object.freeze({
            operationKind: plan.content.operationKind,
            targetKey: plan.content.targetKey,
            ownerKey: plan.content.ownerKey,
            scopeKey: plan.content.scopeKey,
            profileId: plan.content.profileId,
            fences: {
                catalogRevision: this.catalog().envelope.revision,
                inventoryRevision: snapshot.revision,
                targetRevision: row?.managedRevision ?? 'absent',
                ownerRevision,
                scopeRevision: canonicalSha256({
                    scopeKey: plan.content.scopeKey,
                    profileId: plan.content.profileId,
                    configuration: stored.payload.configuration,
                    runtimeDescriptorDigest: runtime?.descriptorDigest ?? null,
                }),
                profileRevision: profileFence(profile),
            },
        });
    }
    /** List bounded task-origin plans with only the typed configuration needed for human review. */
    async listTaskApprovals(maximum = 128) {
        const output = [];
        for (const state of await this.plans.list()) {
            if (state.plan.content.origin !== 'task' || !['pending', 'approved'].includes(state.status))
                continue;
            const intent = await this.store.getIntent(state.plan.content.intentId);
            if (intent === undefined
                || intent.planHash !== state.plan.hash
                || intent.intent.intentId !== state.plan.content.intentId
                || intent.intent.origin !== 'task') {
                throw new Error('task approval has no exact durable intent binding');
            }
            output.push(Object.freeze({
                state: state,
                configuration: intent.payload.configuration,
            }));
            if (output.length > maximum)
                throw new Error('task approval queue exceeds its P0 bound');
        }
        return Object.freeze(output.sort((left, right) => left.state.plan.content.createdAtMs - right.state.plan.content.createdAtMs
            || left.state.plan.content.planId.localeCompare(right.state.plan.content.planId)));
    }
    /** Project safe selectors for an exact MCP candidate's currently usable Host runtimes. */
    async configurationOptions(input) {
        const { candidateRef } = input;
        const entry = this.catalog().envelope.entries.find(candidate => candidate.candidateRef === candidateRef);
        if (entry === undefined)
            throw new Error('configuration candidate is absent');
        let currentConfiguration = null;
        if (input.targetKey !== null) {
            const record = await this.store.getManaged(input.targetKey);
            if (record === undefined
                || record.current === null
                || record.current.candidateRef !== candidateRef
                || record.scopeKey !== input.scopeKey
                || record.profileId !== input.profileId) {
                throw new Error('configuration target is absent or does not match its exact scope');
            }
            currentConfiguration = record.current.configuration;
        }
        const options = entry.kind === 'mcp' ? await this.preflight.mcpOptions(candidateRef) : [];
        return Object.freeze({ options, currentConfiguration });
    }
    async ownerRevision(entry, row, skillProjectRoot) {
        if (entry.kind === 'plugin')
            return row?.ownerRevision ?? 'profile:absent';
        if (entry.kind === 'mcp')
            return row?.ownerRevision ?? `mcp:${String(this.owners.mcpConnections.snapshot().revision)}`;
        if (row !== undefined)
            return row.ownerRevision;
        const snapshot = await this.owners.skills.snapshot(skillProjectRoot === null ? undefined : { cwd: skillProjectRoot });
        return `skills:${canonicalSha256(snapshot)}`;
    }
    async assertTaskBinding(request, entry, binding) {
        if (binding === null || request.continuationId === null)
            throw new Error('task intent has no Host continuation binding');
        const resolution = await this.store.getResolution(binding.resolutionId);
        if (resolution === undefined
            || resolution.expiresAtMs <= Date.now()
            || !resolution.candidateRefs.includes(entry.candidateRef)) {
            throw new Error('task resolution is absent, expired, or does not bind the candidate');
        }
        const value = typeof resolution.value === 'object' && resolution.value !== null && !Array.isArray(resolution.value)
            ? resolution.value
            : undefined;
        if (value?.continuationId !== request.continuationId
            || value.verificationPayloadDigest !== binding.verificationPayloadDigest
            || value.intentId !== binding.intentId
            || value.planId !== binding.planId
            || value.createdAtMs !== binding.createdAtMs
            || value.expiresAtMs !== binding.expiresAtMs
            || value.scopeKey !== request.scopeKey
            || value.profileId !== request.profileId) {
            throw new Error('task resolution fields do not bind the requested intent');
        }
    }
}
//# sourceMappingURL=intent-plan-service.js.map
