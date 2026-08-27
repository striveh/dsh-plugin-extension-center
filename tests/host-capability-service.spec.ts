import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { verifyBootstrapCatalog, type VerifiedCatalog } from '../src/catalog.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { CenterStateStore, type HostOwners } from '../src/host/index.ts'
import type { InventoryRow } from '../src/inventory/index.ts'
import { createImmutablePlan, type ImmutablePlan, type PlanUseContext } from '../src/plans/index.ts'
import { mintAcquisitionIntent } from '../src/policy/index.ts'
import { CapabilityAcquisitionService } from '../src/service/capability-service.ts'
import { IntentPlanService } from '../src/service/intent-plan-service.ts'
import { FileOperationStore, FilePlanStore } from '../src/storage/index.ts'
import { FileTaskAttemptStore } from '../src/task-attempt/index.ts'
import { TEST_RECOVERY_EXECUTABLE_BINDING } from './support/recovery-binding.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const roots: string[] = []

function managedPluginSnapshots(materialRoot = '/managed-plugins') {
  return {
    snapshot: async (profileId: string) => {
      const digest = canonicalSha256({ profileId, managedPlugins: [] })
      return {
        profileId,
        revision: 0,
        digest,
        materialRoot,
        bootStatus: 'live' as const,
        ownerRevision: `managed-plugin:0:${digest}`,
      }
    },
  }
}

const NO_PROVIDER_PREFLIGHT = Object.freeze({
  mcpOptions: async () => [],
  mcpRuntime: async () => null,
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function files(root: string, current = root): Promise<readonly string[]> {
  const output: string[] = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) output.push(...await files(root, path))
    else output.push(path.slice(root.length + 1))
  }
  return output.sort()
}

function agent(id: string, cwd: string, messageId = `message-${id}`) {
  return {
    id,
    options: { provider: `provider-${id}`, model: `model-${id}`, maxTokens: 512 },
    session: {
      header: { cwd },
      events: [{ type: 'user/message', data: { id: messageId, source: { kind: 'user' } } }],
    },
  }
}

class ContinuationOwner {
  readonly claims = new Map<string, any>()
  readonly listeners = new Set<() => void>()
  reserveFailures = 0
  cancelCalls = 0
  reconcileCalls = 0
  reconcileHook: (() => Promise<void>) | undefined
  readonly verifiers = new Map<string, Readonly<{ id: string; verify(claim: unknown, signal: AbortSignal): Promise<unknown> }>>()

  async create(_agent: unknown, request: any) { return await this.reserve(request) }
  async reserve(request: any) {
    if (this.reserveFailures > 0) {
      this.reserveFailures -= 1
      throw new Error('simulated kill before continuation reserve')
    }
    const key = `${request.callerId}/${request.mutationId}`
    const prior = this.claims.get(key)
    if (prior !== undefined) {
      expect(prior.request).toEqual(request)
      return prior.claim
    }
    const claim = {
      kind: 'task-continuation',
      version: 3,
      ...request,
      continuationId: '00000000-0000-4000-8000-000000000321',
      dispatchMessageId: '00000000-0000-4000-8000-000000000322',
      recordRevision: 1,
      state: 'pending',
      dispatchFence: 0,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    }
    this.claims.set(key, { request: structuredClone(request), claim })
    this.notify()
    return claim
  }
  async get(id: string) { return [...this.claims.values()].find(value => value.claim.continuationId === id)?.claim }
  async list(request: any = {}) {
    return [...this.claims.values()].map(value => value.claim).filter(claim =>
      (request.sessionId === undefined || claim.sessionId === request.sessionId)
      && (request.callerId === undefined || claim.callerId === request.callerId)
      && (request.mutationId === undefined || claim.mutationId === request.mutationId))
  }
  async cancel(ref: any) {
    const value = [...this.claims.values()].find(candidate => candidate.claim.continuationId === ref.id)
    if (value === undefined
      || value.claim.sessionId !== ref.sessionId
      || value.claim.taskRevision !== ref.taskRevision
      || !['pending', 'ready', 'consumed'].includes(value.claim.state)) return false
    this.cancelCalls += 1
    value.claim = { ...value.claim, state: 'canceled', recordRevision: value.claim.recordRevision + 1 }
    this.notify()
    return true
  }
  async supersede() { return false }
  async reconcile() {
    this.reconcileCalls += 1
    await this.reconcileHook?.()
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    queueMicrotask(listener)
    return () => { this.listeners.delete(listener) }
  }
  setState(claim: any, state: string): void {
    claim.state = state
    claim.recordRevision += 1
    claim.updatedAtMs += 1
    if (['dispatching', 'dispatched', 'claimed', 'delivery-unknown'].includes(state)) {
      claim.dispatchOwnerId = '00000000-0000-4000-8000-000000000323'
      claim.dispatchFence = 1
      claim.dispatchStartedAtMs = claim.updatedAtMs
      if (state === 'dispatching') claim.dispatchLeaseExpiresAtMs = claim.updatedAtMs + 30_000
      else delete claim.dispatchLeaseExpiresAtMs
      if (state === 'delivery-unknown') claim.deliveryUnknownReason = 'owner-lease-expired'
      else delete claim.deliveryUnknownReason
    } else {
      claim.dispatchFence = 0
      delete claim.dispatchOwnerId
      delete claim.dispatchLeaseExpiresAtMs
      delete claim.dispatchStartedAtMs
      delete claim.deliveryUnknownReason
    }
    if (state === 'superseded') claim.supersededByTaskRevision = 'task-attempt:newer'
    else delete claim.supersededByTaskRevision
    if (state === 'invalid') claim.invalidReason = 'verifier-echo-mismatch'
    else delete claim.invalidReason
    this.notify()
  }
  private notify(): void {
    for (const listener of this.listeners) queueMicrotask(listener)
  }
  registerVerifier(verifier: Readonly<{ id: string; verify(claim: unknown, signal: AbortSignal): Promise<unknown> }>) {
    this.verifiers.set(verifier.id, verifier)
    return () => { if (this.verifiers.get(verifier.id) === verifier) this.verifiers.delete(verifier.id) }
  }
}

class FailOnceActivationStore extends CenterStateStore {
  failActivationWrite = false

  override async putContinuationActivation(value: Parameters<CenterStateStore['putContinuationActivation']>[0]): Promise<void> {
    if (this.failActivationWrite) {
      this.failActivationWrite = false
      throw new Error('simulated kill after Host reserve')
    }
    await super.putContinuationActivation(value)
  }
}

function owners(continuations: ContinuationOwner, projectSkills: Readonly<Record<string, string>> = {}): HostOwners {
  return {
    managedPlugins: managedPluginSnapshots(),
    mcpConnections: {} as never,
    taskContinuations: continuations as never,
    skills: {
      registerProvider: () => () => {},
      snapshot: async (options?: any) => {
        const name = typeof options?.cwd === 'string' ? projectSkills[options.cwd] : undefined
        return {
          complete: true,
          skills: name === undefined ? [] : [{
            name,
            provider: `provider-${name}`,
            path: join(options.cwd, 'SKILL.md'),
            invocation: { modelInvocable: true, userInvocable: true },
          }],
        }
      },
      list: async () => [],
      get: async () => undefined,
    },
    tools: {
      register: () => () => {},
      schemas: () => [],
    },
    loader: {} as never,
  }
}

function inventory() {
  return {
    list: async (scopeKey: string, profileId: string, projectRoot: string | null) => ({
      schemaVersion: 1,
      scopeKey,
      profileId,
      complete: true,
      observedAtMs: 0,
      revision: canonicalSha256({ scopeKey, profileId, projectRoot }),
      rows: [],
    }),
  }
}

function service(
  state: CenterStateStore,
  plans: FilePlanStore,
  operations: FileOperationStore,
  hostOwners: HostOwners,
) {
  return new CapabilityAcquisitionService(
    state,
    inventory() as never,
    { configurationOptions: async () => ({ options: [] }) } as never,
    plans,
    operations,
    hostOwners,
    () => verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000),
  )
}

function need(outcomeTag: string) {
  return {
    outcomeTags: [outcomeTag],
    inputModalities: ['text'],
    outputModalities: ['text'],
    scopeKey: 'user',
    profileId: 'web',
    requiredDataAccess: [],
    maximumAuthority: [],
  }
}

async function approvedTaskPlan(
  root: string,
  state: CenterStateStore,
  plans: FilePlanStore,
): Promise<Readonly<{ plan: ImmutablePlan; reservationId: string; context: PlanUseContext }>> {
  const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
  const entry = catalog.envelope.entries.find(candidate => candidate.kind === 'skill')!
  const now = Date.now()
  const reservationId = '00000000-0000-4000-8000-000000000123'
  const resolutionId = 'resolution:00000000-0000-4000-8000-000000000124'
  const verificationPayloadDigest = canonicalSha256({ verification: root })
  const plan = createImmutablePlan({
    schemaVersion: 1,
    singleUse: true,
    planId: 'plan:task-continuation-test',
    intentId: 'intent:task-continuation-test',
    origin: 'task',
    candidateRef: entry.candidateRef,
    extensionKind: 'skill',
    extensionId: entry.name,
    managedObject: 'artifact',
    externalRuntimeAction: 'download',
    runtimeBinding: null,
    artifactRevision: entry.artifact.version,
    artifactIntegrity: entry.artifact.integrity,
    artifactUrl: entry.artifact.acquisitionUrl,
    artifactSizeBytes: entry.artifact.sizeBytes,
    operationKind: 'install',
    desiredState: 'enabled',
    targetKey: `skill:web:user:${entry.name}`,
    ownerKey: 'skills',
    scopeKey: 'user',
    profileId: 'web',
    idempotencyKey: canonicalSha256({ idempotency: root }),
    authorityDigest: canonicalSha256({ authority: root }),
    configurationDigest: canonicalSha256({}),
    retentionDigest: canonicalSha256({ candidateRef: entry.candidateRef, retainedData: entry.retainedData }),
    reviewEvidence: testReviewEvidence('skill', 'install'),
    mutationDigest: canonicalSha256({ mutation: root }),
    verificationDigest: canonicalSha256({ verification: root }),
    restartRequired: entry.restart.required,
    createdAtMs: now,
    expiresAtMs: now + 60_000,
    fences: {
      catalogRevision: catalog.envelope.revision,
      inventoryRevision: canonicalSha256({ inventory: root }),
      targetRevision: 'absent',
      ownerRevision: 'skills:empty',
      scopeRevision: canonicalSha256({ scope: root }),
      profileRevision: 'profile:0:tree',
    },
  })
  const context: PlanUseContext = {
    operationKind: plan.content.operationKind,
    targetKey: plan.content.targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    fences: plan.content.fences,
  }
  const attempts = new FileTaskAttemptStore(root)
  await attempts.initialize()
  const created = await attempts.create({
    sessionId: 'session-task',
    originalMessageId: 'message-task',
    profileId: 'web',
    projectRoot: root,
    need: {
      schemaVersion: 1,
      outcomeTags: ['fixture'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      scopeKey: 'user',
      platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux',
      requiredDataAccess: [],
      maximumAuthority: [],
    },
    resumeAgentOptions: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 1024 },
    createdAtMs: now,
    expiresAtMs: now + 60_000,
  })
  const resolving = await attempts.transition(created.taskAttemptId, created.revision, 'resolving', null, now)
  await attempts.transition(resolving.taskAttemptId, resolving.revision, 'awaiting-approval', {
    kind: 'acquisition-candidate',
    resolutionId,
    candidateRef: entry.candidateRef,
    continuationId: reservationId,
    verificationPayloadDigest,
  }, now)
  await state.putResolution({
    schemaVersion: 1,
    resolutionId,
    createdAtMs: now,
    expiresAtMs: now + 60_000,
    needDigest: created.needDigest,
    decision: 'acquisition-candidate',
    candidateRefs: [entry.candidateRef],
    value: {
      decision: 'acquisition-candidate',
      taskAttemptId: created.taskAttemptId,
      scopeKey: 'user',
      profileId: 'web',
      catalogRevision: catalog.envelope.revision,
      catalogEntriesDigest: catalog.envelope.entriesDigest,
      inventoryRevision: plan.content.fences.inventoryRevision,
      continuationId: reservationId,
      verificationPayloadDigest,
      intentId: plan.content.intentId,
      planId: plan.content.planId,
      createdAtMs: now,
      expiresAtMs: now + 60_000,
      sessionId: 'session-task',
      originalMessageId: 'message-task',
      resumeAgentOptions: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 1024 },
      candidates: [{ candidateRef: entry.candidateRef, operationKind: 'install', targetKey: null, configuration: {} }],
    },
  })
  const intent = mintAcquisitionIntent({
    intentId: plan.content.intentId,
    origin: 'task',
    idempotencyKey: plan.content.idempotencyKey,
    continuationId: reservationId,
    createdAtMs: now,
    expiresAtMs: now + 60_000,
    candidate: {
      kind: entry.kind,
      extensionId: entry.name,
      candidateRef: entry.candidateRef,
      artifactRevision: entry.artifact.version,
      artifactIntegrity: entry.artifact.integrity,
      artifactUrl: entry.artifact.acquisitionUrl,
      artifactSizeBytes: entry.artifact.sizeBytes,
      scopeKey: 'user',
      profileId: 'web',
      operationKind: 'install',
      desiredState: 'enabled',
      admittedCapabilities: [],
      authorityDeltaDigest: canonicalSha256({ authority: root }),
      policyResult: {
        status: 'eligible',
        policyRevision: 'extension-center-p0-policy-v2',
        authorityDigest: canonicalSha256({ candidateRef: entry.candidateRef }),
      },
      catalogRevision: catalog.envelope.revision,
      inventoryRevision: plan.content.fences.inventoryRevision,
    },
  })
  await state.putIntent({
    schemaVersion: 1,
    intent,
    payload: {
      configuration: {},
      continuationId: reservationId,
      resolutionId,
      verificationPayloadDigest,
      taskSessionId: 'session-task',
      taskOriginalMessageId: 'message-task',
    },
    planHash: plan.hash,
  })
  await plans.put(plan)
  await plans.decide(plan.hash, {
    planId: plan.content.planId,
    planHash: plan.hash,
    operationKind: plan.content.operationKind,
    decision: 'approve',
  }, context, now + 1)
  return { plan, reservationId, context }
}

describe('existing-first capability scope and durable continuation activation', () => {
  it('uses only the invoking Agent Tool/Skill view and records terminal attempts without acquisition state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-capability-scope-'))
    roots.push(root)
    const projectA = join(root, 'project-a')
    const projectB = join(root, 'project-b')
    await mkdir(projectA)
    await mkdir(projectB)
    const state = new CenterStateStore(root)
    await state.initialize()
    const continuations = new ContinuationOwner()
    const base = owners(continuations, {
      [await realpath(projectA)]: 'alpha-skill',
      [await realpath(projectB)]: 'beta-skill',
    })
    const hostOwners: HostOwners = {
      ...base,
      tools: {
        register: () => () => {},
        schemas: (value?: any) => value?.id === 'agent-a'
          ? [{ name: 'web_search', description: 'Search the public web.' }]
          : [{ name: 'str_replace_editor', description: 'Read and edit files.' }],
      },
    }
    const capability = service(
      state,
      new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING),
      new FileOperationStore(root),
      hostOwners,
    )
    await expect(capability.resolve({
      ...need('search'), requiredDataAccess: ['network'], maximumAuthority: ['network'],
    }, agent('agent-a', projectA), new AbortController().signal))
      .resolves.toMatchObject({ next: 'use-existing', existingCapabilityId: 'tool:web_search' })
    await expect(capability.resolve({
      ...need('alpha-skill'), maximumAuthority: ['model-context', 'network'],
    }, agent('agent-a', projectA), new AbortController().signal))
      .resolves.toMatchObject({ next: 'use-existing', existingCapabilityId: 'skill:alpha-skill' })
    const wrongScope = await capability.resolve({
      ...need('alpha-skill'), maximumAuthority: ['filesystem-read', 'filesystem-write', 'model-context'],
    }, agent('agent-b', projectB), new AbortController().signal)
    expect(wrongScope.existingCapabilityId).toBeNull()
    const attempts = await new FileTaskAttemptStore(root).list()
    expect(attempts).toHaveLength(3)
    expect(attempts.every(attempt => attempt.outcome !== null)).toBe(true)
    expect(await state.listResolutions()).toEqual([])
    expect(continuations.claims.size).toBe(0)
  })

  it('uses admitted DSH Tool authority and the same Agent Tool set for existing Skill composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-capability-existing-authority-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const state = new CenterStateStore(root)
    await state.initialize()
    const continuations = new ContinuationOwner()
    const base = owners(continuations, { [await realpath(project)]: 'documentation-writer' })
    const hostOwners: HostOwners = {
      ...base,
      tools: {
        register: () => () => {},
        schemas: () => [{ name: 'web_search', description: 'Search the public web.' }, {
          name: 'str_replace_editor', description: 'Read and edit files.',
        }],
      },
    }
    const capability = service(
      state,
      new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING),
      new FileOperationStore(root),
      hostOwners,
    )

    await expect(capability.resolve({
      ...need('search'), requiredDataAccess: ['network'], maximumAuthority: ['network'],
    }, agent('agent-tools', project), new AbortController().signal)).resolves.toMatchObject({
      next: 'use-existing', existingCapabilityId: 'tool:web_search',
    })
    await expect(capability.resolve({
      ...need('documentation-writer'),
      requiredDataAccess: ['filesystem-write'],
      maximumAuthority: ['filesystem-read', 'filesystem-write', 'model-context', 'network'],
    }, agent('agent-tools', project), new AbortController().signal)).resolves.toMatchObject({
      next: 'use-existing', existingCapabilityId: 'skill:documentation-writer',
    })
  })

  it('does not treat unknown Tool prose or a Skill with unknown Tool authority as complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-capability-unknown-authority-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const state = new CenterStateStore(root)
    await state.initialize()
    const continuations = new ContinuationOwner()
    const base = owners(continuations, { [await realpath(project)]: 'documentation-writer' })
    const capability = service(
      state,
      new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING),
      new FileOperationStore(root),
      {
        ...base,
        tools: {
          register: () => () => {},
          schemas: () => [{
            name: 'third_party_search',
            description: 'Search the public web with network access.',
          }],
        },
      },
    )

    await expect(capability.resolve({
      ...need('search'), maximumAuthority: ['network'],
    }, agent('unknown-tool-agent', project), new AbortController().signal)).resolves.not.toMatchObject({
      next: 'use-existing',
    })
    await expect(capability.resolve({
      ...need('documentation-writer'), maximumAuthority: ['model-context', 'network'],
    }, agent('unknown-skill-agent', project), new AbortController().signal)).resolves.not.toMatchObject({
      next: 'use-existing',
    })
  })

  it('keeps project-scoped Skill writes unavailable without a published workspace and Agent selector', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-capability-project-write-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const state = new CenterStateStore(root)
    await state.initialize()
    const capability = service(
      state,
      new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING),
      new FileOperationStore(root),
      owners(new ContinuationOwner()),
    )
    const resolution = await capability.resolve({
      ...need('documentation'),
      scopeKey: 'project',
      maximumAuthority: ['model-context', 'network'],
    }, agent('agent-project-write', project), new AbortController().signal)

    expect(resolution).toMatchObject({ next: 'unavailable', candidateRefs: [], continuationId: null })
    expect(await state.listResolutions()).toEqual([])
  })

  it('rejects an oversized continuation route before writing resolution state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-capability-route-bound-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const state = new CenterStateStore(root)
    await state.initialize()
    const capability = service(
      state,
      new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING),
      new FileOperationStore(root),
      owners(new ContinuationOwner()),
    )
    const before = await files(root)
    const oversized = { ...agent('agent-route-bound', project), options: { provider: 'p'.repeat(257), model: 'model' } }

    await expect(capability.resolve(need('documentation'), oversized, new AbortController().signal))
      .rejects.toThrow('outside the continuation allowlist')
    expect(await files(root)).toEqual(before)
    expect(await state.listResolutions()).toEqual([])
  })

  it('rejects an expired opaque acquisition binding without persisting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-capability-expired-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const state = new CenterStateStore(root)
    await state.initialize()
    const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
    const capability = new CapabilityAcquisitionService(
      state,
      inventory() as never,
      { configurationOptions: async () => ({ options: [] }) } as never,
      plans,
      new FileOperationStore(root),
      owners(new ContinuationOwner()),
      () => verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000),
      -1,
    )
    const resolution = await capability.resolve(
      { ...need('documentation'), maximumAuthority: ['model-context', 'network'] },
      agent('agent-expired', project),
      new AbortController().signal,
    )
    expect(resolution.next).toBe('request-acquisition')
    await expect(capability.request({
      resolutionId: resolution.resolutionId!,
      candidateRef: resolution.candidateRefs[0]!,
      continuationId: resolution.continuationId!,
    }, agent('agent-expired', project), new AbortController().signal)).rejects.toThrow('attempt expired')
    expect((await new FileTaskAttemptStore(root).list())[0]).toMatchObject({
      outcome: 'rejected',
      reason: 'attempt-expired',
    })
    expect(await state.listResolutions()).toHaveLength(1)
    expect(await plans.list()).toEqual([])
  })

  it.each(['choice-required', 'management-required'] as const)(
    'does not let the model turn %s into an acquisition plan',
    async (decision) => {
      const root = await mkdtemp(join(tmpdir(), `extension-capability-${decision}-`))
      roots.push(root)
      const project = join(root, 'project')
      await mkdir(project)
      const state = new CenterStateStore(root)
      await state.initialize()
      const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
      const capability = service(state, plans, new FileOperationStore(root), owners(new ContinuationOwner()))
      const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'skill')!
      const resolutionId = 'resolution:00000000-0000-4000-8000-000000000451'
      const continuationId = '00000000-0000-4000-8000-000000000452'
      const now = Date.now()
      await state.putResolution({
        schemaVersion: 1,
        resolutionId,
        createdAtMs: now,
        expiresAtMs: now + 60_000,
        needDigest: canonicalSha256({ decision }),
        decision,
        candidateRefs: [entry.candidateRef],
        value: {
          candidates: [{
            candidateRef: entry.candidateRef,
            configuration: { modelInvocable: true, userInvocable: true, projectRoot: project },
            operationKind: decision === 'management-required' ? 'configure' : 'install',
            targetKey: decision === 'management-required' ? `skill:web:project:${entry.name}` : null,
          }],
          catalogEntriesDigest: BOOTSTRAP_CATALOG_ENVELOPE.entriesDigest,
          catalogRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
          continuationId,
          createdAtMs: now,
          decision,
          expiresAtMs: now + 60_000,
          intentId: `intent:${decision}`,
          inventoryRevision: canonicalSha256({ decision, inventory: true }),
          originalMessageId: 'message-decision-boundary',
          planId: `plan:${decision}`,
          profileId: 'web',
          resumeAgentOptions: { provider: 'provider', model: 'model' },
          scopeKey: 'project',
          sessionId: 'agent-decision-boundary',
          taskAttemptId: 'task-attempt:00000000-0000-4000-8000-000000000453',
          verificationPayloadDigest: canonicalSha256({ decision, verification: true }),
        },
      })

      await expect(capability.request({ resolutionId, candidateRef: entry.candidateRef, continuationId }, {
        ...agent('agent-decision-boundary', project, 'message-decision-boundary'),
        id: 'agent-decision-boundary',
      }, new AbortController().signal)).rejects.toThrow('does not bind an acquisition-candidate task attempt')
      expect(await plans.list()).toEqual([])
    },
  )

  it('recovers approval-to-reserve and reserve-to-Center-write crashes without orphan or duplicate claims', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-continuation-activation-'))
    roots.push(root)
    const state = new FailOnceActivationStore(root)
    await state.initialize()
    const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
    const operations = new FileOperationStore(root)
    const continuation = new ContinuationOwner()
    const hostOwners = owners(continuation)
    const approved = await approvedTaskPlan(root, state, plans)

    continuation.reserveFailures = 1
    await expect(service(state, plans, operations, hostOwners).activateApprovedPlan(approved.plan.hash))
      .rejects.toThrow('simulated kill')
    expect(await state.getContinuationActivationIntent(approved.reservationId)).toMatchObject({
      callerId: 'extension-center',
      mutationId: approved.reservationId,
      resumeAgentOptions: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 1024 },
    })
    expect(continuation.claims.size).toBe(0)

    state.failActivationWrite = true
    await expect(service(state, plans, operations, hostOwners).recoverApprovedPlans()).resolves.toBeUndefined()
    expect(continuation.claims.size).toBe(1)
    expect(await state.getContinuationActivation(approved.reservationId)).toBeUndefined()

    await expect(service(state, plans, operations, hostOwners).recoverApprovedPlans()).resolves.toBeUndefined()
    expect(continuation.claims.size).toBe(1)
    expect(await state.getContinuationActivation(approved.reservationId)).toMatchObject({
      reservationId: approved.reservationId,
      planHash: approved.plan.hash,
      continuationId: '00000000-0000-4000-8000-000000000321',
    })
  })

  it('automatically reconciles a claimed Host continuation to one continued task attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-continuation-attempt-reconcile-'))
    roots.push(root)
    const state = new CenterStateStore(root)
    await state.initialize()
    const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
    const continuation = new ContinuationOwner()
    const capability = service(state, plans, new FileOperationStore(root), owners(continuation))
    const approved = await approvedTaskPlan(root, state, plans)
    await capability.activateApprovedPlan(approved.plan.hash)
    const stop = capability.registerVerifier()
    const attempts = new FileTaskAttemptStore(root)
    await attempts.initialize()
    let attempt = (await attempts.list()).find(candidate => candidate.result?.kind === 'acquisition-candidate')!
    attempt = await attempts.transition(attempt.taskAttemptId, attempt.revision, 'verifying-visibility', attempt.result, Date.now())
    attempt = await attempts.transition(attempt.taskAttemptId, attempt.revision, 'ready-to-resume', attempt.result, Date.now())
    const claim = [...continuation.claims.values()][0]!.claim

    continuation.setState(claim, 'consumed')
    await vi.waitFor(async () => {
      expect(await attempts.get(attempt.taskAttemptId)).toMatchObject({ phase: 'resuming', outcome: null })
    })
    continuation.setState(claim, 'claimed')
    await vi.waitFor(async () => {
      expect(await attempts.get(attempt.taskAttemptId)).toMatchObject({
        phase: 'resuming',
        outcome: 'continued',
        reason: 'continuation-claimed',
      })
    })
    expect(await capability.listTaskAttempts()).toContainEqual(expect.objectContaining({
      taskAttemptId: attempt.taskAttemptId,
      outcome: 'continued',
      reason: 'continuation-claimed',
    }))
    stop()
  })

  it('wakes the pending continuation verifier after the committed task receipt and phase are durable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-continuation-committed-wake-'))
    roots.push(root)
    const state = new CenterStateStore(root)
    await state.initialize()
    const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
    const continuation = new ContinuationOwner()
    const capability = service(state, plans, new FileOperationStore(root), owners(continuation))
    const approved = await approvedTaskPlan(root, state, plans)
    const stop = capability.registerVerifier()
    await capability.activateApprovedPlan(approved.plan.hash)
    const resolution = (await state.listResolutions())[0]!
    const activation = await state.getContinuationActivation(approved.reservationId)
    expect(activation).toBeDefined()
    const attempts = new FileTaskAttemptStore(root)
    await attempts.initialize()
    const observations: Array<Readonly<{ receiptPresent: boolean; phase: string | undefined }>> = []
    continuation.reconcileHook = async () => {
      observations.push(Object.freeze({
        receiptPresent: await state.getTaskReceipt(activation!.continuationId) !== undefined,
        phase: (await attempts.getByResolution(resolution.resolutionId))?.phase,
      }))
    }

    await continuation.reconcile()
    expect(observations).toEqual([{ receiptPresent: false, phase: 'acquiring' }])

    const operationId = 'operation:committed-wake'
    const operationReceiptDigest = canonicalSha256({ operationId, outcome: 'committed' })
    await plans.consume(approved.plan.hash, operationId, approved.context, Date.now())
    await state.putTaskReceipt({
      schemaVersion: 1,
      continuationId: activation!.continuationId,
      resolutionId: resolution.resolutionId,
      verificationPayloadDigest: activation!.verificationPayloadDigest,
      planHash: approved.plan.hash,
      operationId,
      operationReceiptDigest,
      completedAtMs: Date.now(),
    })

    await capability.recordLifecycleResult(approved.plan.hash, 'committed')

    expect(continuation.reconcileCalls).toBe(2)
    expect(observations).toEqual([
      { receiptPresent: false, phase: 'acquiring' },
      { receiptPresent: true, phase: 'verifying-visibility' },
    ])
    stop()
  })

  it('re-reads exact live inventory before ready and refuses drift or cancellation after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-continuation-live-verifier-'))
    roots.push(root)
    const state = new CenterStateStore(root)
    await state.initialize()
    const taskAttempts = new FileTaskAttemptStore(root)
    await taskAttempts.initialize()
    const now = Date.now()
    const resolutionId = 'resolution:00000000-0000-4000-8000-000000000811'
    const reservationId = '00000000-0000-4000-8000-000000000812'
    const continuationId = '00000000-0000-4000-8000-000000000813'
    const candidateRef = 'skill:documentation-writer@0.1.0'
    const targetKey = 'skill:web:user:documentation-writer'
    const verificationPayloadDigest = canonicalSha256({ verification: 'live-inventory' })
    const operationReceiptDigest = canonicalSha256({ receipt: 'committed' })
    const planHash = canonicalSha256({ plan: 'committed' })
    const operationId = 'operation:live-inventory'
    const created = await taskAttempts.create({
      sessionId: 'session-live-inventory',
      originalMessageId: 'message-live-inventory',
      profileId: 'web',
      projectRoot: root,
      need: {
        schemaVersion: 1,
        outcomeTags: ['documentation'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        scopeKey: 'user',
        platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux',
        requiredDataAccess: [],
        maximumAuthority: ['model-context'],
      },
      resumeAgentOptions: {},
      createdAtMs: now,
      expiresAtMs: now + 60_000,
    })
    const resolving = await taskAttempts.transition(created.taskAttemptId, created.revision, 'resolving', null, now + 1)
    const awaiting = await taskAttempts.transition(resolving.taskAttemptId, resolving.revision, 'awaiting-approval', {
      kind: 'acquisition-candidate', resolutionId, candidateRef, continuationId: reservationId, verificationPayloadDigest,
    }, now + 2)
    await taskAttempts.transition(awaiting.taskAttemptId, awaiting.revision, 'acquiring', awaiting.result, now + 3)
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    await state.putResolution({
      schemaVersion: 1,
      resolutionId,
      createdAtMs: now,
      expiresAtMs: now + 60_000,
      needDigest: created.needDigest,
      decision: 'acquisition-candidate',
      candidateRefs: [candidateRef],
      value: {
        candidates: [{ candidateRef, configuration: {}, operationKind: 'install', targetKey: null }],
        catalogEntriesDigest: catalog.envelope.entriesDigest,
        catalogRevision: catalog.envelope.revision,
        continuationId: reservationId,
        createdAtMs: now,
        decision: 'acquisition-candidate',
        expiresAtMs: now + 60_000,
        intentId: 'intent:live-inventory',
        inventoryRevision: canonicalSha256({ inventory: 'pre-acquisition' }),
        originalMessageId: created.originalMessageId,
        planId: 'plan:live-inventory',
        profileId: 'web',
        resumeAgentOptions: {},
        scopeKey: 'user',
        sessionId: created.sessionId,
        taskAttemptId: created.taskAttemptId,
        verificationPayloadDigest,
      },
    })
    const taskRevision = 'extension-center-live-inventory'
    await state.putContinuationActivation({
      schemaVersion: 1,
      reservationId,
      continuationId,
      resolutionId,
      planHash,
      sessionId: created.sessionId,
      originalMessageId: created.originalMessageId,
      needDigest: created.needDigest,
      taskRevision,
      verificationPayloadDigest,
      createdAtMs: now + 3,
    })
    await state.putTaskReceipt({
      schemaVersion: 1,
      continuationId,
      resolutionId,
      verificationPayloadDigest,
      planHash,
      operationId,
      operationReceiptDigest,
      completedAtMs: now + 4,
    })
    let visible = false
    let needSatisfied = false
    const liveRow = (): InventoryRow => ({
      schemaVersion: 1,
      kind: 'skill',
      extensionId: 'documentation-writer',
      candidateRef,
      targetKey,
      scopeKey: 'user',
      profileId: 'web',
      ownership: 'center',
      desired: 'enabled',
      materialized: 'configured',
      effective: 'active',
      agentVisibility: visible ? 'visible' : 'not-visible',
      verification: 'runtime',
      rollback: 'available',
      managedRevision: 'managed:1',
      ownerRevision: 'owner:1',
      configurationRevision: null,
      observedAtMs: now + 4,
      actions: {
        install: { status: 'unavailable', reason: 'already-installed' },
        configure: { status: 'unavailable', reason: 'already-configured' },
        update: { status: 'unavailable', reason: 'no-update' },
        enable: { status: 'unavailable', reason: 'already-enabled' },
        disable: { status: 'unavailable', reason: 'fixture' },
        uninstall: { status: 'unavailable', reason: 'fixture' },
        restore: { status: 'unavailable', reason: 'not-removed' },
        purge: { status: 'unavailable', reason: 'not-removed' },
      },
      updateObservation: { status: 'none' },
      restoreObservation: { status: 'none' },
      evidence: {
        kind: 'skill', contentRevision: '0.1.0', catalogComplete: true,
        winningProvider: 'extension-center', winningPath: join(root, 'SKILL.md'), definitionLoaded: true,
        invocation: { modelInvocable: true, userInvocable: true },
      },
    })
    const liveInventory = {
      list: async () => ({
        schemaVersion: 1, scopeKey: 'user', profileId: 'web', complete: true,
        observedAtMs: now + 4, rows: [liveRow()], revision: canonicalSha256({ visible }),
      }),
    }
    const fakePlans = { load: async () => ({
      status: 'consumed',
      plan: { content: { candidateRef, targetKey } },
      authorization: { operationId },
    }) }
    const fakeOperations = { load: async () => ({
      projection: { phase: 'committed', receipt: { digest: operationReceiptDigest } },
    }) }
    const continuation = new ContinuationOwner()
    const baseOwners = owners(continuation)
    const liveOwners: HostOwners = {
      ...baseOwners,
      skills: {
        ...baseOwners.skills!,
        snapshot: async () => ({
          complete: true,
          skills: needSatisfied ? [{
            name: 'documentation',
            provider: 'extension-center',
            path: join(root, 'SKILL.md'),
            invocation: { modelInvocable: true, userInvocable: true },
          }] : [],
        }),
      },
    }
    const createVerifierService = () => new CapabilityAcquisitionService(
      state,
      liveInventory as never,
      {} as never,
      fakePlans as never,
      fakeOperations as never,
      liveOwners,
      () => catalog,
    )
    const claim = {
      continuationId,
      sessionId: created.sessionId,
      originalMessageId: created.originalMessageId,
      needDigest: created.needDigest,
      taskRevision,
      verificationPayloadDigest,
    }
    createVerifierService().registerVerifier()
    await expect(continuation.verifiers.get('extension-center-acquisition')!.verify(claim, new AbortController().signal)).resolves.toEqual({ kind: 'not-ready' })
    expect((await taskAttempts.get(created.taskAttemptId))?.phase).toBe('acquiring')

    visible = true
    const restarted = createVerifierService()
    restarted.registerVerifier()
    await expect(continuation.verifiers.get('extension-center-acquisition')!.verify(claim, new AbortController().signal)).resolves.toEqual({ kind: 'not-ready' })
    expect((await taskAttempts.get(created.taskAttemptId))?.phase).toBe('acquiring')

    needSatisfied = true
    await expect(continuation.verifiers.get('extension-center-acquisition')!.verify(claim, new AbortController().signal)).resolves.toMatchObject({ kind: 'ready' })
    expect((await taskAttempts.get(created.taskAttemptId))?.phase).toBe('ready-to-resume')

    await restarted.cancelTaskAttempt(created.taskAttemptId)
    await expect(continuation.verifiers.get('extension-center-acquisition')!.verify(claim, new AbortController().signal)).resolves.toEqual({ kind: 'not-ready' })
  })

  it('parks an MCP task for trusted typed configuration before minting an unapproved plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-task-mcp-config-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const state = new CenterStateStore(root)
    await state.initialize()
    const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
    const operations = new FileOperationStore(root)
    const continuation = new ContinuationOwner()
    const hostOwners: HostOwners = {
      ...owners(continuation),
      managedPlugins: managedPluginSnapshots(project),
      mcpConnections: {
        snapshot: () => ({ revision: 1, connections: [], removed: [] }),
      } as never,
    }
    const scopedInventory = inventory()
    const runtimeRef = 'runtime:filesystem-mcp-1.3.0'
    const descriptorDigest = canonicalSha256({ runtimeRef, version: '1.3.0' })
    const intentPlans = new IntentPlanService(
      state,
      plans,
      scopedInventory as never,
      hostOwners,
      () => verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000),
      managedPluginSnapshots(project),
      {
        mcpOptions: async candidateRef => [{ candidateRef, runtimeRef, version: '1.3.0' }],
        mcpRuntime: async (_candidateRef, configuration) => {
          const record = typeof configuration === 'object' && configuration !== null && !Array.isArray(configuration)
            ? configuration as Readonly<Record<string, unknown>>
            : undefined
          return record?.runtimeRef === runtimeRef ? {
            runtimeRef,
            version: '1.3.0',
            descriptorDigest,
            reviewDescriptor: {
              transport: 'stdio' as const,
              serverName: 'filesystem',
              executable: '/usr/bin/true',
              arguments: ['/workspace'],
              workingDirectory: '/workspace',
              toolCallTimeoutMs: 30_000,
              reconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 5_000, maxAttempts: 8 },
            },
            runtimeDigest: canonicalSha256({ executable: '/usr/bin/true' }),
          } : null
        },
      },
    )
    const capability = new CapabilityAcquisitionService(
      state,
      scopedInventory as never,
      intentPlans,
      plans,
      operations,
      hostOwners,
      () => verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000),
    )
    const execution = agent('mcp-agent', project, 'message-mcp-task')
    const resolution = await capability.resolve({
      outcomeTags: ['filesystem'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      scopeKey: 'profile:web',
      profileId: 'web',
      requiredDataAccess: ['filesystem-write'],
      maximumAuthority: ['filesystem-write', 'subprocess'],
    }, execution, new AbortController().signal)

    expect(resolution).toMatchObject({
      decision: 'acquisition-candidate',
      next: 'human-choice',
      existingCapabilityId: null,
    })
    expect(resolution.candidateRefs).toEqual(['mcp:io.github.domdomegg/filesystem-mcp@1.3.0'])
    expect(resolution.continuationId).not.toBeNull()
    expect(await state.listResolutions()).toHaveLength(1)
    await expect(capability.request({
      resolutionId: resolution.resolutionId,
      candidateRef: resolution.candidateRefs[0],
      continuationId: resolution.continuationId,
    }, execution, new AbortController().signal)).rejects.toThrow('trusted human configuration')
    expect(await state.listResolutions()).toHaveLength(1)
    await expect(capability.listConfigurationRequests()).resolves.toMatchObject([{
      resolutionId: resolution.resolutionId,
      candidateRef: resolution.candidateRefs[0],
      continuationId: resolution.continuationId,
      extensionKind: 'mcp',
      scopeKey: 'profile:web',
      profileId: 'web',
    }])
    expect(continuation.claims.size).toBe(0)

    const configured = await capability.configureTaskCandidate({
      resolutionId: resolution.resolutionId,
      candidateRef: resolution.candidateRefs[0]!,
      continuationId: resolution.continuationId!,
      configuration: {
        transport: 'stdio',
        connectionId: 'filesystem',
        runtimeRef,
        roots: ['/workspace'],
        toolCallTimeoutMs: 30_000,
        reconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 5_000, maxAttempts: 8 },
      },
    })
    expect(configured.plan.content).toMatchObject({
      origin: 'task',
      managedObject: 'connection',
      externalRuntimeAction: 'none',
      runtimeBinding: { runtimeRef, version: '1.3.0', descriptorDigest },
    })
    expect(await state.listResolutions()).toHaveLength(1)
    expect((await plans.load(configured.plan.hash))?.status).toBe('pending')
    await expect(capability.listConfigurationRequests()).resolves.toEqual([])
    await expect(intentPlans.listTaskApprovals()).resolves.toMatchObject([{
      state: { status: 'pending', plan: { hash: configured.plan.hash } },
      configuration: { transport: 'stdio', runtimeRef, roots: ['/workspace'] },
    }])
    expect(continuation.claims.size).toBe(0)
  })

  it('closes choice-required, derives one new eligible attempt, and keeps selection non-authorizing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-task-choice-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const state = new CenterStateStore(root)
    await state.initialize()
    const base = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const skill = base.envelope.entries.find(entry => entry.kind === 'skill')!
    const plugin = base.envelope.entries.find(entry => entry.kind === 'plugin')!
    const choiceCatalog: VerifiedCatalog = {
      keyIds: base.keyIds,
      envelope: {
        ...base.envelope,
        entries: [skill, { ...plugin, tags: ['documentation'], scopes: ['user'] }],
      },
    }
    const hostOwners = owners(new ContinuationOwner())
    const scopedInventory = inventory()
    const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
    const intentPlans = new IntentPlanService(
      state,
      plans,
      scopedInventory as never,
      hostOwners,
      () => choiceCatalog,
      managedPluginSnapshots(project),
      NO_PROVIDER_PREFLIGHT,
    )
    const capability = new CapabilityAcquisitionService(
      state,
      scopedInventory as never,
      intentPlans,
      plans,
      new FileOperationStore(root),
      hostOwners,
      () => choiceCatalog,
    )

    const choice = await capability.resolve({
      ...need('documentation'),
      maximumAuthority: ['credentials', 'network', 'filesystem-read', 'filesystem-write', 'model-context', 'subprocess'],
    }, agent('choice-agent', project), new AbortController().signal)
    expect(choice).toMatchObject({
      decision: 'choice-required',
      resolutionId: null,
      continuationId: null,
      next: 'human-choice',
    })
    expect(choice.candidateRefs).toContain(skill.candidateRef)
    expect(await plans.list()).toEqual([])

    const selected = await capability.selectTaskCandidate(
      choice.taskAttemptId,
      skill.candidateRef,
      new AbortController().signal,
    )
    expect(selected).toMatchObject({
      decision: 'acquisition-candidate',
      candidateRefs: [skill.candidateRef],
      next: 'request-acquisition',
    })
    expect(selected.resolutionId).not.toBeNull()
    expect(selected.continuationId).not.toBeNull()
    expect(await plans.list()).toEqual([])
    const attempts = await capability.listTaskAttempts()
    expect(attempts).toMatchObject([{
      taskAttemptId: choice.taskAttemptId,
      outcome: 'choice-required',
    }, {
      taskAttemptId: selected.taskAttemptId,
      parentAttemptId: choice.taskAttemptId,
      trigger: 'choice-selection',
      outcome: null,
      phase: 'awaiting-approval',
    }])
    await expect(capability.selectTaskCandidate(
      choice.taskAttemptId,
      skill.candidateRef,
      new AbortController().signal,
    )).rejects.toThrow('already consumed')
  })

  it('closes management-required without acquisition ids and Retry original re-runs existing-first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-task-management-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const state = new CenterStateStore(root)
    await state.initialize()
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const skill = catalog.envelope.entries.find(entry => entry.kind === 'skill')!
    const targetKey = `skill:web:user:${skill.name}`
    const available = { status: 'available' as const }
    const unavailable = { status: 'unavailable' as const, reason: 'fixture' }
    let row: InventoryRow = {
      schemaVersion: 1,
      kind: 'skill',
      extensionId: skill.name,
      candidateRef: skill.candidateRef,
      targetKey,
      scopeKey: 'user',
      profileId: 'web',
      ownership: 'center',
      desired: 'enabled',
      materialized: 'installed',
      effective: 'inactive',
      agentVisibility: 'not-visible',
      verification: 'structural',
      rollback: 'available',
      managedRevision: 'managed:1',
      ownerRevision: 'skills:1',
      configurationRevision: null,
      observedAtMs: 1,
      actions: {
        install: unavailable,
        configure: available,
        update: unavailable,
        enable: unavailable,
        disable: unavailable,
        uninstall: available,
        restore: unavailable,
        purge: unavailable,
      },
      updateObservation: { status: 'none' },
      restoreObservation: { status: 'none' },
      evidence: {
        kind: 'skill',
        contentRevision: skill.artifact.version,
        catalogComplete: true,
        winningProvider: null,
        winningPath: null,
        definitionLoaded: false,
        invocation: null,
      },
    }
    const scopedInventory = {
      list: async (scopeKey: string, profileId: string, projectRoot: string | null) => ({
        schemaVersion: 1 as const,
        scopeKey,
        profileId,
        complete: true,
        observedAtMs: Date.now(),
        revision: canonicalSha256({ scopeKey, profileId, projectRoot, row: true }),
        rows: [row],
      }),
    }
    const visibleSkills: Record<string, string> = {}
    const projectRealpath = await realpath(project)
    const continuations = new ContinuationOwner()
    const hostOwners = owners(continuations, visibleSkills)
    const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
    const intentPlans = new IntentPlanService(
      state,
      plans,
      scopedInventory as never,
      hostOwners,
      () => catalog,
      managedPluginSnapshots(project),
      NO_PROVIDER_PREFLIGHT,
    )
    const capability = new CapabilityAcquisitionService(
      state,
      scopedInventory as never,
      intentPlans,
      plans,
      new FileOperationStore(root),
      hostOwners,
      () => catalog,
    )

    const management = await capability.resolve(
      { ...need('documentation'), maximumAuthority: ['model-context'] },
      agent('management-agent', project),
      new AbortController().signal,
    )
    expect(management).toMatchObject({
      decision: 'management-required',
      resolutionId: null,
      continuationId: null,
      candidateRefs: [],
      managementAction: 'configure',
      next: 'unavailable',
    })
    expect(management.extensionRef).toMatch(/^extension-ref:/u)
    expect(await state.listResolutions()).toEqual([])
    expect(await plans.list()).toEqual([])

    visibleSkills[projectRealpath] = 'documentation'
    row = {
      ...row,
      configurationRevision: 'configuration:2',
      effective: 'active',
      agentVisibility: 'visible',
      verification: 'task',
      evidence: {
        kind: 'skill',
        contentRevision: skill.artifact.version,
        catalogComplete: true,
        winningProvider: 'provider-documentation',
        winningPath: join(projectRealpath, 'SKILL.md'),
        definitionLoaded: true,
        invocation: { modelInvocable: true, userInvocable: true },
      },
    }
    continuations.reserveFailures = 1
    await expect(capability.retryOriginalTask(management.taskAttemptId, new AbortController().signal))
      .rejects.toThrow('simulated kill before continuation reserve')
    expect(continuations.claims.size).toBe(0)
    expect((await capability.listTaskAttempts())[1]!.retryContinuation).toEqual({
      continuationId: null,
      state: 'reconciling',
    })

    const restartedState = new CenterStateStore(root)
    await restartedState.initialize()
    const restartedPlans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
    const restartedIntentPlans = new IntentPlanService(
      restartedState,
      restartedPlans,
      scopedInventory as never,
      hostOwners,
      () => catalog,
      managedPluginSnapshots(project),
      NO_PROVIDER_PREFLIGHT,
    )
    const restarted = new CapabilityAcquisitionService(
      restartedState,
      scopedInventory as never,
      restartedIntentPlans,
      restartedPlans,
      new FileOperationStore(root),
      hostOwners,
      () => catalog,
    )
    const disposeVerifier = restarted.registerVerifier()
    await restarted.recoverApprovedPlans()
    const retried = await restarted.retryOriginalTask(management.taskAttemptId, new AbortController().signal)
    expect(retried).toMatchObject({
      decision: 'use-existing',
      existingCapabilityId: 'skill:documentation',
      resolutionId: null,
      continuationId: null,
    })
    const attempts = await restarted.listTaskAttempts()
    expect(attempts[0]).toMatchObject({ outcome: 'management-required', retryContinuation: null })
    expect(attempts[1]).toMatchObject({
      parentAttemptId: management.taskAttemptId,
      trigger: 'retry-original',
      sessionId: 'management-agent',
      originalMessageId: 'message-management-agent',
      outcome: 'use-existing',
      retryContinuation: {
        continuationId: '00000000-0000-4000-8000-000000000321',
        state: 'pending',
      },
    })
    expect(continuations.claims.size).toBe(1)
    const retryClaim = [...continuations.claims.values()][0]!.claim
    for (const state of [
      'ready', 'consumed', 'dispatching', 'dispatched', 'claimed', 'delivery-unknown',
      'canceled', 'superseded', 'expired', 'invalid',
    ] as const) {
      continuations.setState(retryClaim, state)
      expect((await restarted.listTaskAttempts())[1]!.retryContinuation).toEqual({
        continuationId: retryClaim.continuationId,
        state,
      })
    }
    continuations.setState(retryClaim, 'pending')
    retryClaim.injected = true
    await expect(restarted.listTaskAttempts()).rejects.toThrow('invalid claim')
    delete retryClaim.injected
    const retryVerifier = continuations.verifiers.get('extension-center-management-retry')!
    row = { ...row, effective: 'inactive', agentVisibility: 'not-visible', verification: 'structural' }
    expect(await retryVerifier.verify(retryClaim, new AbortController().signal)).toEqual({ kind: 'not-ready' })
    row = { ...row, effective: 'active', agentVisibility: 'visible', verification: 'task' }
    expect(await retryVerifier.verify(retryClaim, new AbortController().signal)).toMatchObject({
      kind: 'ready',
      continuationId: retryClaim.continuationId,
      taskRevision: retried.taskAttemptId,
      originalMessageId: 'message-management-agent',
    })
    const replay = await restarted.retryOriginalTask(management.taskAttemptId, new AbortController().signal)
    expect(replay.taskAttemptId).toBe(retried.taskAttemptId)
    expect(await restarted.listTaskAttempts()).toHaveLength(2)
    expect(continuations.claims.size).toBe(1)
    await expect(restarted.cancelTaskAttempt(retried.taskAttemptId)).resolves.toMatchObject({
      taskAttemptId: retried.taskAttemptId,
      outcome: 'use-existing',
      retryContinuation: { state: 'canceled' },
    })
    await expect(restarted.cancelTaskAttempt(retried.taskAttemptId)).resolves.toMatchObject({
      outcome: 'use-existing',
      retryContinuation: { state: 'canceled' },
    })
    expect(continuations.cancelCalls).toBe(1)
    expect([...continuations.claims.values()][0]!.claim.state).toBe('canceled')
    expect(await retryVerifier.verify(retryClaim, new AbortController().signal)).toEqual({ kind: 'not-ready' })
    await restarted.recoverApprovedPlans()
    expect(continuations.claims.size).toBe(1)
    expect(continuations.cancelCalls).toBe(1)
    disposeVerifier()
  })

  it('cancels and supersedes candidate attempts durably, rejecting later acquisition with zero plans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-task-cancel-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const state = new CenterStateStore(root)
    await state.initialize()
    const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
    const operations = new FileOperationStore(root)
    const hostOwners = owners(new ContinuationOwner())
    const capability = service(state, plans, operations, hostOwners)
    const execution = agent('cancel-agent', project)
    const first = await capability.resolve(
      { ...need('documentation'), maximumAuthority: ['model-context', 'network'] },
      execution,
      new AbortController().signal,
    )
    const second = await capability.resolve(
      { ...need('documentation'), maximumAuthority: ['model-context', 'network'] },
      execution,
      new AbortController().signal,
    )
    expect((await capability.listTaskAttempts()).find(attempt => attempt.taskAttemptId === first.taskAttemptId))
      .toMatchObject({ outcome: 'resume-conflict', reason: 'superseded-by-new-attempt' })
    await expect(capability.request({
      resolutionId: first.resolutionId!,
      candidateRef: first.candidateRefs[0]!,
      continuationId: first.continuationId!,
    }, execution, new AbortController().signal)).rejects.toThrow('terminal')

    await expect(capability.cancelTaskAttempt(second.taskAttemptId)).resolves.toMatchObject({ outcome: 'canceled' })
    await expect(capability.cancelTaskAttempt(second.taskAttemptId)).resolves.toMatchObject({ outcome: 'canceled' })
    await expect(capability.request({
      resolutionId: second.resolutionId!,
      candidateRef: second.candidateRefs[0]!,
      continuationId: second.continuationId!,
    }, execution, new AbortController().signal)).rejects.toThrow('terminal')
    expect(await plans.list()).toEqual([])

    const restarted = new CapabilityAcquisitionService(
      state,
      inventory() as never,
      { configurationOptions: async () => ({ options: [] }) } as never,
      plans,
      operations,
      hostOwners,
      () => verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000),
    )
    expect(await restarted.listTaskAttempts()).toHaveLength(2)
  })
})
