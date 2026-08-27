import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import {
  createExtensionManagementClient,
  parseConfigurationDraft,
  parseIntentPreviewResponse,
  parseInventoryListResponse,
  parseOperationListResponse,
  parseOperationReceiptsResponse,
  parseTaskAttemptListResponse,
} from '../src/client/management-api.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { createInventorySnapshot, type InventoryRow } from '../src/inventory/index.ts'
import {
  consumeApprovedPlan,
  createImmutablePlan,
  createPlanAuthorizationState,
  CURRENT_PNPM_EXECUTION_IDENTITY,
  decidePlan,
  RETIRED_PNPM_EXECUTION_IDENTITY,
  type ImmutablePlan,
  type PlanUseContext,
} from '../src/plans/index.ts'
import {
  createOperationJournal,
  issueOperationReceipt,
  recordOperationMutation,
  recordOperationVerification,
  transitionOperation,
} from '../src/operations/index.ts'
import { TEST_RECOVERY_EXECUTABLE_BINDING } from './support/recovery-binding.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const CREATED = Date.parse('2026-08-25T10:00:00.000Z')
const capabilities = {
  managedPluginLifecycle: true,
  dynamicMcpConnection: true,
  durableContinuation: true,
  skillRegistry: true,
  toolRegistry: true,
  loaderMutation: true,
  acquisition: true,
  reason: null,
} as const

function digest(label: string) {
  return canonicalSha256({ label })
}

function immutablePlan(
  operationKind: 'install' | 'configure' = 'install',
  origin: 'store' | 'task' = 'store',
): ImmutablePlan {
  return createImmutablePlan({
    schemaVersion: 1,
    singleUse: true,
    planId: `plan:${origin}:${operationKind}:1`,
    intentId: `intent:${origin}:${operationKind}:1`,
    origin,
    candidateRef: 'skill:example@revision-2',
    extensionKind: 'skill',
    extensionId: 'example',
    managedObject: 'artifact',
    externalRuntimeAction: operationKind === 'install' || operationKind === 'update' ? 'download' : 'none',
    runtimeBinding: null,
    artifactRevision: 'revision-2',
    artifactIntegrity: digest('artifact'),
    artifactUrl: 'https://example.test/example.md',
    artifactSizeBytes: 123,
    operationKind,
    desiredState: 'enabled',
    targetKey: 'skill:user/example',
    ownerKey: 'skills:user',
    scopeKey: 'user',
    profileId: 'web',
    idempotencyKey: `idempotency:${operationKind}:1`,
    authorityDigest: digest('authority'),
    configurationDigest: digest('configuration'),
    retentionDigest: digest('retention'),
    reviewEvidence: testReviewEvidence('skill', operationKind),
    mutationDigest: digest(`mutation:${operationKind}`),
    verificationDigest: digest('verification'),
    restartRequired: false,
    createdAtMs: CREATED,
    expiresAtMs: CREATED + 60_000,
    fences: {
      catalogRevision: 2,
      inventoryRevision: digest('inventory'),
      targetRevision: 'target:1',
      ownerRevision: 'owner:1',
      scopeRevision: 'scope:1',
      profileRevision: 'profile:1',
    },
  })
}

function pluginConfigurePlan(): ImmutablePlan {
  const base = immutablePlan('configure')
  return createImmutablePlan({
    ...base.content,
    planId: 'plan:plugin-configure:1',
    intentId: 'intent:plugin-configure:1',
    candidateRef: 'plugin:fixture@1.0.0',
    extensionKind: 'plugin',
    extensionId: 'fixture',
    artifactRevision: '1.0.0',
    artifactUrl: 'https://example.test/fixture.tgz',
    targetKey: 'plugin:web:profile:web:fixture',
    ownerKey: 'managedPlugins',
    scopeKey: 'profile:web',
    reviewEvidence: testReviewEvidence('plugin', 'configure'),
    restartRequired: false,
  })
}

function useContext(plan: ImmutablePlan): PlanUseContext {
  return {
    operationKind: plan.content.operationKind,
    targetKey: plan.content.targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    fences: plan.content.fences,
  }
}

function inventoryResponse() {
  const row: Omit<InventoryRow, 'actions'> = {
    schemaVersion: 1,
    kind: 'skill',
    extensionId: 'example',
    candidateRef: 'skill:example@revision-1',
    targetKey: 'skill:user/example',
    scopeKey: 'profile:web',
    profileId: 'web',
    ownership: 'center',
    desired: 'enabled',
    materialized: 'configured',
    effective: 'active',
    agentVisibility: 'visible',
    verification: 'runtime',
    rollback: 'available',
    managedRevision: 'revision-1',
    ownerRevision: 'owner-1',
    configurationRevision: 'configuration-1',
    observedAtMs: CREATED,
    updateObservation: {
      status: 'available',
      candidateRef: 'skill:example@revision-2',
      revision: 'revision-2',
      integrity: digest('artifact-2'),
    },
    restoreObservation: {
      status: 'available',
      candidateRef: 'skill:example@revision-1',
      revision: 'revision-1',
      integrity: digest('artifact-1'),
    },
    evidence: {
      kind: 'skill',
      contentRevision: 'revision-1',
      catalogComplete: true,
      winningProvider: 'extension-center',
      winningPath: '/managed/example/SKILL.md',
      definitionLoaded: true,
      invocation: { modelInvocable: true, userInvocable: true },
    },
  }
  return {
    protocolVersion: 1 as const,
    hostCapabilities: capabilities,
    inventory: createInventorySnapshot({
      scopeKey: 'profile:web',
      profileId: 'web',
      complete: true,
      observedAtMs: CREATED,
      rows: [row],
    }, capabilities),
  }
}

function issuedReceipt() {
  const plan = immutablePlan()
  const pending = createPlanAuthorizationState(plan)
  const decision = decidePlan(pending, {
    planId: plan.content.planId,
    planHash: plan.hash,
    operationKind: plan.content.operationKind,
    decision: 'approve',
  }, useContext(plan), CREATED + 1)
  if (decision.state.status !== 'approved') throw new Error('fixture approval failed')
  const consumed = consumeApprovedPlan(
    decision.state,
    'operation:1',
    useContext(plan),
    CREATED + 2,
    TEST_RECOVERY_EXECUTABLE_BINDING,
  )
  let journal = createOperationJournal(consumed.authorization, digest('before'), CREATED + 3)
  journal = transitionOperation(journal, 'staging', null, null, CREATED + 4)
  journal = transitionOperation(journal, 'applying', null, null, CREATED + 5)
  journal = recordOperationMutation(journal, digest('mutation-observed'), CREATED + 6)
  journal = transitionOperation(journal, 'verifying', null, null, CREATED + 7)
  journal = recordOperationVerification(journal, digest('verification-observed'), CREATED + 8)
  journal = transitionOperation(journal, 'committed', digest('after'), null, CREATED + 9)
  return issueOperationReceipt(journal, CREATED + 10).receipt
}

describe('management Client wire validation', () => {
  it('binds exact endpoint payloads and rejects injected inventory or tampered revisions', async () => {
    const response = inventoryResponse()
    const call = vi.fn().mockResolvedValue({ ok: true, value: response })
    const client = createExtensionManagementClient({ call } as ClientConnectionRpc)
    await expect(client.inventory('profile:web', 'web')).resolves.toEqual(response)
    expect(call).toHaveBeenCalledWith(
      '/dsh-extension-center',
      'inventory/list',
      { protocolVersion: 1, scopeKey: 'profile:web', profileId: 'web' },
      undefined,
    )
    await expect(client.verify('profile:web', 'web', 'skill:user/example')).resolves.toEqual(response)
    expect(call).toHaveBeenLastCalledWith(
      '/dsh-extension-center',
      'inventory/verify',
      { protocolVersion: 1, scopeKey: 'profile:web', profileId: 'web', targetKey: 'skill:user/example' },
      undefined,
    )
    await expect(client.verify('profile:web', 'web', 'skill:user/missing')).rejects.toThrow('request binding')

    const activating = structuredClone(response)
    activating.hostCapabilities.acquisition = false
    activating.hostCapabilities.reason = 'host-capability'
    await expect(parseInventoryListResponse(activating)).resolves.toMatchObject({
      hostCapabilities: { acquisition: false, reason: 'host-capability' },
    })
    await expect(parseInventoryListResponse({ ...response, injected: true })).rejects.toThrow('unexpected fields')
    const tampered = structuredClone(response)
    tampered.inventory.rows[0]!.effective = 'degraded'
    await expect(parseInventoryListResponse(tampered)).rejects.toThrow('inventory revision mismatch')
    const wrongEvidence = structuredClone(response) as unknown as { inventory: { rows: Array<{ evidence: { kind: string } }> } }
    wrongEvidence.inventory.rows[0]!.evidence.kind = 'plugin'
    await expect(parseInventoryListResponse(wrongEvidence)).rejects.toThrow('evidence.kind')
    const incompleteRestore = structuredClone(response) as unknown as {
      inventory: { rows: Array<{ restoreObservation: { integrity?: string } }> }
    }
    delete incompleteRestore.inventory.rows[0]!.restoreObservation.integrity
    await expect(parseInventoryListResponse(incompleteRestore)).rejects.toThrow('restoreObservation')
    const unboundRestore = structuredClone(response)
    unboundRestore.inventory.rows[0]!.restoreObservation = { status: 'unknown' }
    const { revision: _revision, ...unboundBody } = unboundRestore.inventory
    unboundRestore.inventory.revision = canonicalSha256(unboundBody)
    await expect(parseInventoryListResponse(unboundRestore)).rejects.toThrow('restoreObservation')
  })

  it('carries only explicit inventory target keys and binds the returned plan to them', async () => {
    const plan = immutablePlan()
    const preview = {
      protocolVersion: 1 as const,
      intentId: plan.content.intentId,
      plan,
      policy: {
        status: 'eligible' as const,
        policyRevision: 'extension-center-p0-policy-v2',
        authorityDigest: plan.content.authorityDigest,
      },
    }
    const call = vi.fn().mockResolvedValue({ ok: true, value: preview })
    const client = createExtensionManagementClient({ call } as ClientConnectionRpc)
    const input = {
      candidateRef: plan.content.candidateRef,
      operationKind: plan.content.operationKind,
      scopeKey: plan.content.scopeKey,
      profileId: plan.content.profileId,
      targetKey: plan.content.targetKey,
      configuration: {},
    } as const
    await expect(client.preview(input)).resolves.toEqual(preview)
    expect(call).toHaveBeenCalledWith('/dsh-extension-center', 'intent/preview', {
      protocolVersion: 1,
      origin: 'store',
      continuationId: null,
      ...input,
    }, undefined)

    await expect(client.preview({ ...input, targetKey: 'skill:user/different' })).rejects.toThrow('request binding')
    const callsBeforeInvalid = call.mock.calls.length
    await expect(client.preview({ ...input, operationKind: 'enable', targetKey: null })).rejects.toThrow('targetKey')
    expect(call).toHaveBeenCalledTimes(callsBeforeInvalid)
  })

  it('recomputes immutable plan and receipt digests before exposing decisions or activity', async () => {
    const plan = immutablePlan()
    const preview = {
      protocolVersion: 1 as const,
      intentId: plan.content.intentId,
      plan,
      policy: {
        status: 'eligible' as const,
        policyRevision: 'extension-center-p0-policy-v2',
        authorityDigest: plan.content.authorityDigest,
      },
    }
    await expect(parseIntentPreviewResponse(preview)).resolves.toEqual(preview)
    const tamperedPlan = structuredClone(preview)
    tamperedPlan.plan.content.artifactRevision = 'moving-target'
    await expect(parseIntentPreviewResponse(tamperedPlan)).rejects.toThrow('plan hash mismatch')

    const legacyReview = structuredClone(preview) as unknown as {
      plan: { content: { reviewEvidence: { checks: Array<{ code: string }> } }; hash: string }
    }
    legacyReview.plan.content.reviewEvidence.checks[0]!.code = 'profile-lockfile'
    legacyReview.plan.hash = canonicalSha256(legacyReview.plan.content)
    await expect(parseIntentPreviewResponse(legacyReview)).rejects.toThrow('checks[0].code')

    const pluginPlan = pluginConfigurePlan()
    const pluginPreview = {
      protocolVersion: 1 as const,
      intentId: pluginPlan.content.intentId,
      plan: pluginPlan,
      policy: {
        status: 'eligible' as const,
        policyRevision: 'extension-center-p0-policy-v2',
        authorityDigest: pluginPlan.content.authorityDigest,
      },
    }
    await expect(parseIntentPreviewResponse(pluginPreview)).resolves.toEqual(pluginPreview)
    for (const [field, value] of [
      ['mutationOwner', 'official-dsh-cli'],
      ['profileDependency', 'replace'],
      ['loaderEntry', 'retain'],
      ['restartRequired', true],
    ] as const) {
      const forged = structuredClone(pluginPreview)
      Object.assign(forged.plan.content.reviewEvidence.kind === 'plugin'
        ? forged.plan.content.reviewEvidence.activation
        : {}, { [field]: value })
      forged.plan.hash = canonicalSha256(forged.plan.content)
      await expect(parseIntentPreviewResponse(forged)).rejects.toThrow('activation operation binding')
    }
    const forgedRestart = structuredClone(pluginPreview)
    forgedRestart.plan.content.restartRequired = true
    forgedRestart.plan.hash = canonicalSha256(forgedRestart.plan.content)
    await expect(parseIntentPreviewResponse(forgedRestart)).rejects.toThrow('restartRequired binding')

    const receipt = issuedReceipt()
    const receipts = {
      protocolVersion: 1 as const,
      receipts: [{ operationId: 'operation:1', targetKey: plan.content.targetKey, receipt }],
    }
    await expect(parseOperationReceiptsResponse(receipts)).resolves.toEqual(receipts)
    expect(receipts.receipts[0]!.receipt.body).toMatchObject({
      planEvidence: {
        candidateRef: plan.content.candidateRef,
        artifactRevision: plan.content.artifactRevision,
        artifactIntegrity: plan.content.artifactIntegrity,
        configurationDigest: plan.content.configurationDigest,
        authorityDigest: plan.content.authorityDigest,
        retentionDigest: plan.content.retentionDigest,
        reviewEvidence: plan.content.reviewEvidence,
      },
      evidence: { mutation: 'proven', verification: 'proven', notProven: [] },
    })
    const tamperedReceipt = structuredClone(receipts)
    tamperedReceipt.receipts[0]!.receipt.body.outcome = 'failed'
    await expect(parseOperationReceiptsResponse(tamperedReceipt)).rejects.toThrow(/digest mismatch|body\.evidence/)

    const retiredReceipt = structuredClone(receipts)
    Object.assign(
      retiredReceipt.receipts[0]!.receipt.body.planEvidence.recoveryExecutable.officialDsh.pnpm,
      RETIRED_PNPM_EXECUTION_IDENTITY,
    )
    retiredReceipt.receipts[0]!.receipt.digest = canonicalSha256(retiredReceipt.receipts[0]!.receipt.body)
    await expect(parseOperationReceiptsResponse(retiredReceipt)).resolves.toEqual(retiredReceipt)

    const mixedReceipt = structuredClone(retiredReceipt)
    mixedReceipt.receipts[0]!.receipt.body.planEvidence.recoveryExecutable.officialDsh.pnpm.registryIntegrity
      = CURRENT_PNPM_EXECUTION_IDENTITY.registryIntegrity
    mixedReceipt.receipts[0]!.receipt.digest = canonicalSha256(mixedReceipt.receipts[0]!.receipt.body)
    await expect(parseOperationReceiptsResponse(mixedReceipt)).rejects.toThrow('pnpm identity')

    const rawConfiguration = structuredClone(receipts) as unknown as { receipts: Array<{ receipt: { body: { planEvidence: Record<string, unknown> }; digest: string } }> }
    rawConfiguration.receipts[0]!.receipt.body.planEvidence.configuration = { secret: 'must-not-cross-wire' }
    await expect(parseOperationReceiptsResponse(rawConfiguration)).rejects.toThrow('unexpected fields')

    const missingCenterRoot = structuredClone(receipts) as unknown as { receipts: Array<{ receipt: { body: { planEvidence: { recoveryExecutable: Record<string, unknown> } }; digest: string } }> }
    delete missingCenterRoot.receipts[0]!.receipt.body.planEvidence.recoveryExecutable.centerRoot
    missingCenterRoot.receipts[0]!.receipt.digest = canonicalSha256(missingCenterRoot.receipts[0]!.receipt.body)
    await expect(parseOperationReceiptsResponse(missingCenterRoot)).rejects.toThrow('unexpected fields')

    const lifecycleCall = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        protocolVersion: 1,
        operationId: receipt.body.operationId,
        status: receipt.body.outcome,
        receipt,
      },
    })
    const lifecycleClient = createExtensionManagementClient({ call: lifecycleCall } as ClientConnectionRpc)
    await expect(lifecycleClient.execute(plan.hash)).resolves.toMatchObject({ operationId: receipt.body.operationId })
    await expect(lifecycleClient.execute(digest('different-plan'))).rejects.toThrow('request binding')
  })

  it('binds safe configuration selectors to the exact candidate and target request', async () => {
    const request = {
      candidateRef: 'mcp:filesystem@1.0.0',
      operationKind: 'configure',
      targetKey: 'mcp:profile:web:filesystem',
      scopeKey: 'profile:web',
      profileId: 'web',
    } as const
    const response = {
      protocolVersion: 1 as const,
      options: [{
        candidateRef: request.candidateRef,
        runtimeRef: 'runtime:filesystem:1',
        version: '1.0.0',
        transport: 'stdio' as const,
        executablePath: '/opt/dsh/bin/filesystem-mcp',
        fixedArgs: ['--stdio'],
        workingDirectory: '/opt/dsh',
      }],
      currentConfiguration: {
        transport: 'stdio',
        runtimeRef: 'runtime:filesystem:1',
        roots: ['/workspace'],
      },
    }
    const call = vi.fn().mockResolvedValue({ ok: true, value: response })
    const client = createExtensionManagementClient({ call } as ClientConnectionRpc)

    await expect(client.configurationOptions(request)).resolves.toEqual(response)
    expect(call).toHaveBeenCalledWith('/dsh-extension-center', 'configuration/options', {
      protocolVersion: 1,
      ...request,
    }, undefined)

    call.mockResolvedValueOnce({
      ok: true,
      value: {
        ...response,
        options: [{ ...response.options[0], candidateRef: 'mcp:different@1.0.0' }],
      },
    })
    await expect(client.configurationOptions(request)).rejects.toThrow('request binding')

    call.mockResolvedValueOnce({
      ok: true,
      value: {
        ...response,
        options: [{ ...response.options[0], headers: { Authorization: 'secret' } }],
      },
    })
    await expect(client.configurationOptions(request)).rejects.toThrow('unexpected fields')
  })

  it('exposes only exact pending or approved task plans in the approval queue', async () => {
    const taskPlan = immutablePlan('install', 'task')
    const pending = createPlanAuthorizationState(taskPlan)
    const response = {
      protocolVersion: 1 as const,
      approvals: [{ state: pending, configuration: { modelInvocable: true } }],
      configurations: [{
        resolutionId: 'resolution:00000000-0000-4000-8000-000000000601',
        candidateRef: 'mcp:example/filesystem@1.0.0',
        continuationId: '00000000-0000-4000-8000-000000000602',
        extensionKind: 'mcp' as const,
        scopeKey: 'profile:web',
        profileId: 'web',
        createdAtMs: CREATED,
        expiresAtMs: CREATED + 60_000,
      }],
    }
    const call = vi.fn().mockResolvedValue({ ok: true, value: response })
    const client = createExtensionManagementClient({ call } as ClientConnectionRpc)

    await expect(client.taskApprovals()).resolves.toEqual(response)
    expect(call).toHaveBeenCalledWith(
      '/dsh-extension-center',
      'approval/list',
      { protocolVersion: 1 },
      undefined,
    )

    call.mockResolvedValueOnce({
      ok: true,
      value: { ...response, approvals: [...response.approvals, ...response.approvals] },
    })
    await expect(client.taskApprovals()).rejects.toThrow('duplicate plan')

    call.mockResolvedValueOnce({
      ok: true,
      value: {
        ...response,
        approvals: [{ state: createPlanAuthorizationState(immutablePlan()), configuration: {} }],
      },
    })
    await expect(client.taskApprovals()).rejects.toThrow('state')
  })

  it('submits only one opaque task configuration and verifies the returned task-origin plan', async () => {
    const resolutionId = 'resolution:00000000-0000-4000-8000-000000000611'
    const continuationId = '00000000-0000-4000-8000-000000000612'
    const candidateRef = 'mcp:example/filesystem@1.0.0'
    const base = immutablePlan('install', 'task')
    const taskPlan = createImmutablePlan({
      ...base.content,
      candidateRef,
      extensionKind: 'mcp',
      extensionId: 'example/filesystem',
      managedObject: 'connection',
      externalRuntimeAction: 'none',
      runtimeBinding: {
        runtimeRef: 'runtime:filesystem:1',
        version: '1.0.0',
        descriptorDigest: digest('runtime descriptor'),
      },
      reviewEvidence: testReviewEvidence('mcp', 'install'),
    })
    const response = {
      protocolVersion: 1 as const,
      resolutionId,
      intentId: taskPlan.content.intentId,
      plan: taskPlan,
      policy: {
        status: 'eligible' as const,
        policyRevision: 'extension-center-p0-policy-v2',
        authorityDigest: taskPlan.content.authorityDigest,
      },
    }
    const call = vi.fn().mockResolvedValue({ ok: true, value: response })
    const client = createExtensionManagementClient({ call } as ClientConnectionRpc)
    const configuration = { transport: 'stdio', connectionId: 'filesystem', runtimeRef: 'runtime:filesystem:1', roots: ['/workspace'] }

    await expect(client.configureTask({ resolutionId, candidateRef, continuationId, configuration })).resolves.toEqual(response)
    expect(call).toHaveBeenCalledWith('/dsh-extension-center', 'approval/configure', {
      protocolVersion: 1,
      resolutionId,
      candidateRef,
      continuationId,
      configuration,
    }, undefined)

    call.mockResolvedValueOnce({ ok: true, value: { ...response, resolutionId: 'resolution:00000000-0000-4000-8000-000000000699' } })
    await expect(client.configureTask({ resolutionId, candidateRef, continuationId, configuration })).rejects.toThrow('request binding')
  })

  it('reconciles and recovers only the exact opaque identifiers supplied by the Browser', async () => {
    const plan = immutablePlan()
    const pending = createPlanAuthorizationState(plan)
    const planCall = vi.fn().mockResolvedValue({
      ok: true,
      value: { protocolVersion: 1, state: pending },
    })
    const planClient = createExtensionManagementClient({ call: planCall } as ClientConnectionRpc)
    await expect(planClient.plan(plan.hash)).resolves.toEqual(pending)
    expect(planCall).toHaveBeenCalledWith(
      '/dsh-extension-center',
      'plan/get',
      { protocolVersion: 1, planHash: plan.hash },
      undefined,
    )
    const callsBeforeInvalid = planCall.mock.calls.length
    await expect(planClient.plan('not-a-digest')).rejects.toThrow('planHash')
    expect(planCall).toHaveBeenCalledTimes(callsBeforeInvalid)

    planCall.mockResolvedValueOnce({
      ok: true,
      value: { protocolVersion: 1, state: createPlanAuthorizationState(immutablePlan('configure')) },
    })
    await expect(planClient.plan(plan.hash)).rejects.toThrow('request binding')

    const recoveryCall = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        protocolVersion: 1,
        operationId: 'operation:recovery:1',
        status: 'recovery-required',
        receipt: null,
      },
    })
    const recoveryClient = createExtensionManagementClient({ call: recoveryCall } as ClientConnectionRpc)
    await expect(recoveryClient.recover('operation:recovery:1')).resolves.toMatchObject({
      operationId: 'operation:recovery:1',
      status: 'recovery-required',
    })
    expect(recoveryCall).toHaveBeenCalledWith(
      '/dsh-extension-center',
      'operation/recover',
      { protocolVersion: 1, operationId: 'operation:recovery:1' },
      undefined,
    )

    recoveryCall.mockResolvedValueOnce({
      ok: true,
      value: {
        protocolVersion: 1,
        operationId: 'operation:different',
        status: 'recovery-required',
        receipt: null,
      },
    })
    await expect(recoveryClient.recover('operation:recovery:1')).rejects.toThrow('request binding')
  })

  it('rejects malformed operation projections and parses only strict JSON drafts', () => {
    expect(parseOperationListResponse({
      protocolVersion: 1,
      operations: [{
        operationId: 'operation:1',
        targetKey: 'skill:user/example',
        phase: 'recovery-required',
        operationKind: 'install',
        lastAtMs: CREATED,
        recoveryCommand: null,
        recoveryNotice: null,
      }],
    }).operations).toHaveLength(1)
    expect(parseOperationListResponse({
      protocolVersion: 1,
      operations: [{
        operationId: 'operation:retired',
        targetKey: 'skill:user/example',
        phase: 'authorized',
        operationKind: 'install',
        lastAtMs: CREATED,
        recoveryCommand: null,
        recoveryNotice: 'retired-runtime-quarantined',
      }],
    }).operations).toHaveLength(1)
    expect(parseOperationListResponse({
      protocolVersion: 1,
      operations: [{
        operationId: 'operation:retired-failed',
        targetKey: 'plugin:web:profile:web/example',
        phase: 'failed',
        operationKind: 'install',
        lastAtMs: CREATED,
        recoveryCommand: null,
        recoveryNotice: 'retired-runtime-quarantined',
      }],
    }).operations).toHaveLength(1)
    expect(() => parseOperationListResponse({
      protocolVersion: 1,
      operations: [{
        operationId: 'operation:1',
        targetKey: 'skill:user/example',
        phase: 'complete',
        operationKind: 'install',
        lastAtMs: CREATED,
        recoveryCommand: null,
        recoveryNotice: null,
      }],
    })).toThrow('phase')
    expect(parseConfigurationDraft('{"roots":["/workspace"],"enabled":true}')).toEqual({
      roots: ['/workspace'], enabled: true,
    })
    expect(() => parseConfigurationDraft('{broken')).toThrow('invalid-json')
    expect(() => parseConfigurationDraft('{"value":1e999}')).toThrow('invalid-json')
  })

  it('uses strict task-attempt list, choice, Retry-original, and cancellation RPC bindings', async () => {
    const sourceId = 'task-attempt:00000000-0000-4000-8000-000000000701'
    const selectedId = 'task-attempt:00000000-0000-4000-8000-000000000702'
    const retryId = 'task-attempt:00000000-0000-4000-8000-000000000703'
    const choice = {
      taskAttemptId: sourceId,
      parentAttemptId: null,
      trigger: 'model' as const,
      sessionId: 'session:task',
      originalMessageId: 'message:task',
      createdAtMs: CREATED,
      expiresAtMs: CREATED + 60_000,
      updatedAtMs: CREATED + 1,
      phase: 'resolving' as const,
      outcome: 'choice-required' as const,
      reason: 'material-candidate-choice-required',
      choice: { candidateRefs: ['mcp:search@1', 'skill:search@1'] },
      management: null,
      acquisition: null,
      retryContinuation: null,
    }
    const list = { protocolVersion: 1 as const, attempts: [choice] }
    const acquisition = {
      protocolVersion: 1 as const,
      taskAttemptId: selectedId,
      resolutionId: 'resolution:00000000-0000-4000-8000-000000000704',
      decision: 'acquisition-candidate' as const,
      needDigest: digest('task-need'),
      existingCapabilityId: null,
      candidateRefs: ['skill:search@1'],
      continuationId: '00000000-0000-4000-8000-000000000705',
      extensionRef: null,
      managementAction: null,
      next: 'request-acquisition' as const,
    }
    const retried = {
      protocolVersion: 1 as const,
      taskAttemptId: retryId,
      resolutionId: null,
      decision: 'use-existing' as const,
      needDigest: digest('task-need'),
      existingCapabilityId: 'skill:search',
      candidateRefs: [],
      continuationId: null,
      extensionRef: null,
      managementAction: null,
      next: 'use-existing' as const,
    }
    const canceled = {
      ...choice,
      outcome: 'canceled' as const,
      reason: 'canceled-by-user',
      choice: null,
    }
    const retryAttempt = {
      ...choice,
      taskAttemptId: retryId,
      parentAttemptId: sourceId,
      trigger: 'retry-original' as const,
      createdAtMs: CREATED + 2,
      updatedAtMs: CREATED + 3,
      outcome: 'use-existing' as const,
      reason: 'existing-capability-visible',
      choice: null,
      retryContinuation: {
        continuationId: '00000000-0000-4000-8000-000000000706',
        state: 'canceled' as const,
      },
    }
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: list })
      .mockResolvedValueOnce({ ok: true, value: acquisition })
      .mockResolvedValueOnce({ ok: true, value: retried })
      .mockResolvedValueOnce({ ok: true, value: { protocolVersion: 1, attempt: canceled } })
      .mockResolvedValueOnce({ ok: true, value: { protocolVersion: 1, attempt: retryAttempt } })
    const client = createExtensionManagementClient({ call } as ClientConnectionRpc)

    await expect(client.taskAttempts()).resolves.toEqual(list)
    await expect(client.selectTaskCandidate(sourceId, 'skill:search@1')).resolves.toEqual(acquisition)
    await expect(client.retryOriginalTask(sourceId)).resolves.toEqual(retried)
    await expect(client.cancelTaskAttempt(sourceId)).resolves.toEqual({ protocolVersion: 1, attempt: canceled })
    await expect(client.cancelTaskAttempt(retryId)).resolves.toEqual({ protocolVersion: 1, attempt: retryAttempt })
    expect(call.mock.calls.map(call => call[1])).toEqual([
      'task-attempt/list', 'task-attempt/select', 'task-attempt/retry', 'task-attempt/cancel', 'task-attempt/cancel',
    ])
    for (const state of [
      'pending', 'ready', 'consumed', 'dispatching', 'dispatched', 'claimed', 'delivery-unknown',
      'canceled', 'superseded', 'expired', 'invalid',
      'reconciling', 'unavailable',
    ] as const) {
      expect(parseTaskAttemptListResponse({
        protocolVersion: 1,
        attempts: [choice, {
          ...retryAttempt,
          retryContinuation: {
            continuationId: '00000000-0000-4000-8000-000000000706',
            state,
          },
        }],
      }).attempts[1]!.retryContinuation?.state).toBe(state)
    }
    expect(() => parseTaskAttemptListResponse({
      protocolVersion: 1,
      attempts: [choice, { ...retryAttempt, retryContinuation: { continuationId: null, state: 'pending' } }],
    })).toThrow('retryContinuation')
    expect(() => parseTaskAttemptListResponse({
      protocolVersion: 1,
      attempts: [{ ...choice, retryContinuation: retryAttempt.retryContinuation }],
    })).toThrow('retryContinuation')
    expect(() => parseTaskAttemptListResponse({ ...list, injected: true })).toThrow('unexpected fields')
    await expect(client.retryOriginalTask('task-attempt:not-a-uuid')).rejects.toThrow('taskAttemptId')
  })
})
