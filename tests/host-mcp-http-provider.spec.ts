import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { verifyBootstrapCatalog } from '../src/catalog.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { CenterStateStore, type HostOwners } from '../src/host/index.ts'
import {
  createOperationJournal,
  issueOperationReceipt,
  recordOperationMutation,
  recordOperationVerification,
  transitionOperation,
} from '../src/operations/index.ts'
import {
  McpLifecycleProvider,
  type AdmittedMcpHttpRuntime,
  type AppliedProviderOperation,
  type ProviderOperationRequest,
} from '../src/providers/index.ts'
import { HostInventoryService } from '../src/service/inventory-service.ts'
import { IntentPlanService } from '../src/service/intent-plan-service.ts'
import type { RpcJson } from '../src/service/rpc-contract.ts'
import { FilePlanStore } from '../src/storage/index.ts'
import { TEST_RECOVERY_EXECUTABLE_BINDING } from './support/recovery-binding.ts'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface OwnerRow {
  id: string
  revision: number
  desired: { id: string; enabled: boolean; transport: RpcJson }
  observed: { state: 'disabled' | 'ready'; desiredRevision: number; generation: number }
  tools: { generation: number; digest: string; names: string[] }
}

class HttpOwner {
  revision = 0
  toolGeneration = 0
  failEnable = false
  removeCalls = 0
  purgeCalls = 0
  readonly mutations: Array<Readonly<{ operation: string; mutationId: string }>> = []
  readonly active = new Map<string, OwnerRow>()
  readonly removed = new Map<string, { id: string; revision: number; desired: OwnerRow['desired'] }>()

  snapshot() { return { revision: this.revision, connections: [...this.active.values()], removed: [...this.removed.values()] } }
  get(id: string) { return this.active.get(id) }
  getRemoved(id: string) { return this.removed.get(id) }
  registeredToolNames(id: string, exactNames: readonly string[] = []) {
    const prefix = `mcp__${id}__`
    return [...new Set([...(this.active.get(id)?.tools.names ?? []), ...exactNames.filter(name =>
      this.active.get(id)?.tools.names.includes(name) === true)])].filter(name => name.startsWith(prefix)).sort()
  }

  async configure(request: any) {
    this.recordMutation('configure', request)
    if (request.expectedRevision !== 0 || this.active.has(request.desired.id) || this.removed.has(request.desired.id)) {
      throw new Error('configure conflict')
    }
    const row = this.row(request.desired.id, 1, request.desired.enabled, request.desired.transport)
    this.active.set(row.id, row)
    return this.receipt('configure', row)
  }

  async enable(request: any) {
    this.recordMutation('enable', request)
    if (this.failEnable) {
      this.failEnable = false
      throw new Error('simulated HTTP handshake failure')
    }
    return this.setEnabled('enable', request, true)
  }

  async disable(request: any) {
    this.recordMutation('disable', request)
    return this.setEnabled('disable', request, false)
  }

  async update(request: any) {
    this.recordMutation('update', request)
    const before = this.require(request.id, request.expectedRevision)
    const row = this.row(before.id, before.revision + 1, before.desired.enabled, request.transport)
    this.active.set(row.id, row)
    return this.receipt('update', row)
  }

  async remove(request: any) {
    this.recordMutation('remove', request)
    const before = this.require(request.id, request.expectedRevision)
    this.active.delete(before.id)
    const removed = { id: before.id, revision: before.revision + 1, desired: before.desired }
    this.removed.set(before.id, removed)
    this.revision += 1
    this.removeCalls += 1
    return { operation: 'remove', id: before.id, revision: removed.revision, snapshotRevision: this.revision }
  }

  async restore(request: any) {
    this.recordMutation('restore', request)
    const before = this.removed.get(request.id)
    if (before?.revision !== request.expectedRevision) throw new Error('restore conflict')
    this.removed.delete(request.id)
    const row = this.row(before.id, before.revision + 1, before.desired.enabled, before.desired.transport)
    this.active.set(row.id, row)
    return this.receipt('restore', row)
  }

  async purge(request: any) {
    this.recordMutation('purge', request)
    const before = this.removed.get(request.id)
    if (before?.revision !== request.expectedRevision) throw new Error('purge conflict')
    this.removed.delete(request.id)
    this.revision += 1
    this.purgeCalls += 1
    return { operation: 'purge', id: request.id, revision: before.revision + 1, snapshotRevision: this.revision }
  }

  private async setEnabled(operation: string, request: any, enabled: boolean) {
    const before = this.require(request.id, request.expectedRevision)
    const row = this.row(before.id, before.revision + 1, enabled, before.desired.transport)
    this.active.set(row.id, row)
    return this.receipt(operation, row)
  }

  private recordMutation(operation: string, request: any): void {
    this.mutations.push({ operation, mutationId: request.mutationId })
  }

  private require(id: string, revision: number): OwnerRow {
    const row = this.active.get(id)
    if (row?.revision !== revision) throw new Error('owner revision conflict')
    return row
  }

  private row(id: string, revision: number, enabled: boolean, transport: RpcJson): OwnerRow {
    this.toolGeneration += 1
    return {
      id,
      revision,
      desired: { id, enabled, transport },
      observed: { state: enabled ? 'ready' : 'disabled', desiredRevision: revision, generation: revision },
      tools: {
        generation: this.toolGeneration,
        digest: canonicalSha256({ id, revision, enabled, transport }),
        names: enabled ? [`mcp__${id}__query`] : [],
      },
    }
  }

  private receipt(operation: string, row: OwnerRow) {
    this.revision += 1
    return { operation, id: row.id, revision: row.revision, snapshotRevision: this.revision }
  }
}

const reconnect = { enabled: true, initialDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 3 } as const

function expectedOwnerMutationId(
  operationId: string,
  phase: string,
  descriptorDigest: `sha256:${string}`,
): string {
  return `mcp:${canonicalSha256({ operationId, phase, descriptorDigest }).slice('sha256:'.length)}`
}

function httpRuntime(candidateRef: string, suffix = 'v1'): AdmittedMcpHttpRuntime {
  const version = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.candidateRef === candidateRef)?.artifact.version
  if (version === undefined) throw new Error('fixture MCP candidate is absent from the bootstrap catalog')
  return {
    transport: 'streamable-http',
    runtimeRef: `runtime:https:${suffix}`,
    candidateRef,
    version,
    origin: 'https://mcp.example.test',
    endpoint: `https://mcp.example.test/mcp/${suffix}`,
    authentication: 'none',
    redirects: 'forbidden',
    dataEgressDisclosure: 'Tool names, tool arguments, and MCP session metadata leave this Host for mcp.example.test.',
  }
}

function config(runtime: AdmittedMcpHttpRuntime): RpcJson {
  return {
    transport: 'streamable-http',
    connectionId: 'remote',
    runtimeRef: runtime.runtimeRef,
    toolCallTimeoutMs: 5_000,
    reconnect,
  }
}

function request(input: Readonly<{
  runtime: AdmittedMcpHttpRuntime
  configuration: RpcJson
  bindingDigest: `sha256:${string}`
  owner: HttpOwner
  operationId: string
  operationKind: ProviderOperationRequest['plan']['operationKind']
  desiredState: 'enabled' | 'disabled' | 'removed'
  origin?: 'store' | 'task'
}>): ProviderOperationRequest {
  const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'mcp')!
  const targetKey = `mcp:web:profile:web:${entry.name}`
  const held = input.owner.get('remote') ?? input.owner.getRemoved('remote')
  const ownerRevision = held?.revision ?? input.owner.revision
  const origin = input.origin ?? 'store'
  const runtimeBinding = {
    runtimeRef: input.runtime.runtimeRef,
    version: input.runtime.version,
    descriptorDigest: input.bindingDigest,
  }
  return {
    authorization: {
      operationId: input.operationId,
      planId: `plan:${input.operationId}`,
      planHash: canonicalSha256({ plan: input.operationId }),
      origin,
      candidateRef: entry.candidateRef,
      extensionKind: 'mcp',
      extensionId: entry.name,
      operationKind: input.operationKind,
      managedObject: 'connection',
      externalRuntimeAction: 'none',
      runtimeBinding,
      targetKey,
      ownerKey: 'mcpConnections',
      scopeKey: 'profile:web',
      profileId: 'web',
      authorizedAtMs: Date.now(),
    },
    plan: {
      schemaVersion: 1,
      singleUse: true,
      planId: `plan:${input.operationId}`,
      intentId: `intent:${input.operationId}`,
      origin,
      candidateRef: entry.candidateRef,
      extensionKind: 'mcp',
      extensionId: entry.name,
      managedObject: 'connection',
      externalRuntimeAction: 'none',
      runtimeBinding,
      artifactRevision: entry.artifact.version,
      artifactIntegrity: entry.artifact.integrity,
      artifactUrl: entry.artifact.acquisitionUrl,
      artifactSizeBytes: entry.artifact.sizeBytes,
      operationKind: input.operationKind,
      desiredState: input.desiredState,
      targetKey,
      ownerKey: 'mcpConnections',
      scopeKey: 'profile:web',
      profileId: 'web',
      idempotencyKey: `idempotency:${input.operationId}`,
      authorityDigest: canonicalSha256({ authority: input.operationId }),
      configurationDigest: canonicalSha256(input.configuration),
      retentionDigest: canonicalSha256({ retention: input.operationId }),
      mutationDigest: canonicalSha256({ mutation: input.operationId }),
      verificationDigest: canonicalSha256({ verification: input.operationId }),
      reviewEvidence: {
        schemaVersion: 1,
        kind: 'mcp',
        operationKind: input.operationKind,
        checks: [{ code: 'mcp-descriptor', phase: 'prepare' }],
        removed: [],
        retained: [],
        credentialChoice: 'not-applicable',
        rollbackPoint: { kind: 'absent-state', id: 'fixture', digest: canonicalSha256(null) },
        rollbackLimits: ['dsh-managed-state-only'],
        notProven: ['user-task-outcome'],
        descriptor: {
          transport: 'http',
          serverName: 'remote',
          origin: input.runtime.origin,
          endpoint: input.runtime.endpoint,
          authentication: 'none',
          redirects: 'forbidden',
          dataEgressDisclosure: input.runtime.dataEgressDisclosure,
          toolCallTimeoutMs: 5_000,
          reconnect,
        },
        runtime: { ownership: 'remote', version: input.runtime.version, digest: null, action: 'none' },
        credentials: 'none',
        dataEgress: 'remote-origin',
      },
      restartRequired: false,
      createdAtMs: 1,
      expiresAtMs: 999_999,
      fences: {
        catalogRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
        inventoryRevision: canonicalSha256({ inventory: input.operationId }),
        targetRevision: 'fixture',
        ownerRevision: `mcp:${String(ownerRevision)}`,
        scopeRevision: canonicalSha256({
          scopeKey: 'profile:web',
          profileId: 'web',
          configuration: input.configuration,
          runtimeDescriptorDigest: input.bindingDigest,
        }),
        profileRevision: 'profile:0:fixture',
      },
    },
    payload: {
      configuration: input.configuration,
      continuationId: null,
      resolutionId: null,
      verificationPayloadDigest: null,
      taskSessionId: null,
      taskOriginalMessageId: null,
    },
    artifactPath: null,
    signal: new AbortController().signal,
  } as ProviderOperationRequest
}

async function execute(provider: McpLifecycleProvider, operation: ProviderOperationRequest): Promise<AppliedProviderOperation> {
  const prepared = await provider.prepare(operation)
  const applied = await provider.apply(prepared)
  await expect(provider.verify(applied)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
  return applied
}

function mcpPlanningOwners(root: string, owner: HttpOwner): Readonly<{
  owners: HostOwners
  managedPlugins: NonNullable<HostOwners['managedPlugins']>
}> {
  const managedPlugins = {
    snapshot: async (profileId: string) => {
      const digest = canonicalSha256({ profileId, managedPlugins: [] })
      return {
        profileId,
        revision: 0,
        digest,
        materialRoot: join(root, 'managed-plugins'),
        bootStatus: 'live' as const,
        ownerRevision: `managed-plugin:0:${digest}`,
      }
    },
  }
  return {
    managedPlugins,
    owners: {
      managedPlugins,
      mcpConnections: owner as never,
      taskContinuations: {} as never,
      skills: {} as never,
      tools: {} as never,
      loader: {
        await: async () => {},
        entries: () => [],
      } as never,
    },
  }
}

describe('preprovisioned Streamable HTTPS MCP lifecycle', () => {
  it('uses one opaque selector, binds exact no-secret transport evidence, and completes every lifecycle action transactionally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-mcp-http-'))
    roots.push(root)
    const store = new CenterStateStore(root)
    await store.initialize()
    const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'mcp')!
    const first = httpRuntime(entry.candidateRef)
    const second = httpRuntime(entry.candidateRef, 'v2')
    const owner = new HttpOwner()
    const provider = new McpLifecycleProvider(store, owner as never, [first, second])
    const fetch = vi.spyOn(globalThis, 'fetch')
    const firstConfig = config(first)
    const firstPreflight = await provider.preflight(entry.candidateRef, firstConfig)
    expect(firstPreflight?.reviewDescriptor).toEqual({
      transport: 'http',
      serverName: 'remote',
      origin: first.origin,
      endpoint: first.endpoint,
      authentication: 'none',
      redirects: 'forbidden',
      dataEgressDisclosure: first.dataEgressDisclosure,
      toolCallTimeoutMs: 5_000,
      reconnect,
    })
    await expect(provider.options(entry.candidateRef)).resolves.toContainEqual(expect.objectContaining({
      runtimeRef: first.runtimeRef,
      transport: 'streamable-http',
      origin: first.origin,
      endpoint: first.endpoint,
      authentication: 'none',
      redirects: 'forbidden',
      dataEgressDisclosure: first.dataEgressDisclosure,
    }))
    expect(fetch).not.toHaveBeenCalled()
    expect(owner.snapshot()).toMatchObject({ revision: 0, connections: [], removed: [] })
    const firstDigest = firstPreflight!.descriptorDigest
    const operation = (
      id: string,
      operationKind: ProviderOperationRequest['plan']['operationKind'],
      desiredState: 'enabled' | 'disabled' | 'removed',
      runtime = first,
      configuration = firstConfig,
      digest = runtime === first ? firstDigest : canonicalSha256(runtime),
    ) => request({
      runtime,
      configuration,
      bindingDigest: digest,
      owner,
      operationId: `operation:http-${id}`,
      operationKind,
      desiredState,
    })

    await expect(provider.prepare(operation('wrong-digest', 'install', 'disabled', first, firstConfig, canonicalSha256('wrong'))))
      .rejects.toThrow('exact preprovisioned runtime connection')
    expect(fetch).not.toHaveBeenCalled()
    expect(owner.revision).toBe(0)

    const installRequest = operation('install', 'install', 'disabled')
    const installed = await execute(provider, installRequest)
    expect(owner.mutations).toContainEqual({
      operation: 'configure',
      mutationId: expectedOwnerMutationId('operation:http-install', 'configure-create', firstDigest),
    })
    expect(owner.get('remote')).toMatchObject({
      desired: { enabled: false },
      observed: { state: 'disabled' },
      tools: { names: [] },
    })
    const installedVerification = await provider.verify(installed)
    if (installedVerification === null) throw new Error('manual MCP Install returned no owner verification')
    const openedAt = Date.now()
    const receiptAuthorization = {
      operationId: installRequest.authorization.operationId,
      planId: installRequest.plan.planId,
      planHash: installRequest.authorization.planHash,
      operationKind: installRequest.plan.operationKind,
      managedObject: installRequest.plan.managedObject,
      externalRuntimeAction: installRequest.plan.externalRuntimeAction,
      runtimeBinding: installRequest.plan.runtimeBinding,
      origin: installRequest.plan.origin,
      candidateRef: installRequest.plan.candidateRef,
      extensionKind: installRequest.plan.extensionKind,
      extensionId: installRequest.plan.extensionId,
      artifactRevision: installRequest.plan.artifactRevision,
      artifactIntegrity: installRequest.plan.artifactIntegrity,
      artifactUrl: installRequest.plan.artifactUrl,
      artifactSizeBytes: installRequest.plan.artifactSizeBytes,
      desiredState: installRequest.plan.desiredState,
      targetKey: installRequest.plan.targetKey,
      ownerKey: installRequest.plan.ownerKey,
      scopeKey: installRequest.plan.scopeKey,
      profileId: installRequest.plan.profileId,
      idempotencyKey: installRequest.plan.idempotencyKey,
      authorityDigest: installRequest.plan.authorityDigest,
      configurationDigest: installRequest.plan.configurationDigest,
      retentionDigest: installRequest.plan.retentionDigest,
      reviewEvidence: installRequest.plan.reviewEvidence,
      mutationDigest: installRequest.plan.mutationDigest,
      verificationDigest: installRequest.plan.verificationDigest,
      restartRequired: installRequest.plan.restartRequired,
      recoveryExecutable: TEST_RECOVERY_EXECUTABLE_BINDING,
      fences: installRequest.plan.fences,
      authorizedAtMs: installRequest.authorization.authorizedAtMs,
    }
    let journal = createOperationJournal(receiptAuthorization, installed.prepared.beforeDigest, openedAt)
    journal = transitionOperation(journal, 'staging', null, null, openedAt + 1)
    journal = transitionOperation(journal, 'applying', null, null, openedAt + 2)
    journal = recordOperationMutation(journal, installed.mutationDigest, openedAt + 3)
    journal = transitionOperation(journal, 'verifying', null, null, openedAt + 4)
    journal = recordOperationVerification(journal, installedVerification.digest, openedAt + 5)
    journal = transitionOperation(journal, 'committed', installed.afterDigest, null, openedAt + 6)
    const receipt = issueOperationReceipt(journal, openedAt + 7).receipt
    expect(receipt.body).toMatchObject({
      operationKind: 'install',
      managedObject: 'connection',
      runtimeBinding: {
        runtimeRef: first.runtimeRef,
        version: first.version,
        descriptorDigest: firstDigest,
      },
      planEvidence: { desiredState: 'disabled' },
      outcome: 'committed',
      evidence: { mutation: 'proven', verification: 'proven' },
    })
    const rolledBackConfigure = await execute(provider, operation('configure-rollback', 'configure', 'disabled'))
    await expect(provider.rollback(rolledBackConfigure)).resolves.toBe(rolledBackConfigure.prepared.beforeDigest)
    expect(owner.get('remote')).toMatchObject({ desired: { enabled: false }, observed: { state: 'disabled' }, tools: { names: [] } })
    expect(owner.getRemoved('remote')).toBeUndefined()

    await execute(provider, operation('configure', 'configure', 'disabled'))
    expect(owner.mutations).toContainEqual({
      operation: 'update',
      mutationId: expectedOwnerMutationId('operation:http-configure', 'configure-update', firstDigest),
    })
    expect(owner.get('remote')?.desired.transport).toEqual({
      transport: 'streamable-http',
      url: first.endpoint,
      headers: {},
      redirect: 'error',
      toolCallTimeoutMs: 5_000,
      reconnect,
    })
    await execute(provider, operation('enable', 'enable', 'enabled'))
    const current = (await store.getManaged(operation('view', 'enable', 'enabled').plan.targetKey))!.current!
    expect(current.kindState).toMatchObject({
      transport: 'streamable-http',
      descriptorDigest: firstDigest,
      origin: first.origin,
      endpoint: first.endpoint,
      dataEgressDisclosure: first.dataEgressDisclosure,
      configured: true,
    })
    await expect(provider.inspect(current)).resolves.toMatchObject({
      descriptorMatches: true,
      descriptorDigest: firstDigest,
      transport: 'http',
      observedLifecycle: 'ready',
      qualifiedTools: ['mcp__remote__query'],
    })

    const exact = structuredClone(owner.get('remote')!)
    owner.active.set('remote', {
      ...exact,
      desired: { ...exact.desired, transport: { ...(exact.desired.transport as object), url: 'https://mcp.example.test/unapproved' } as RpcJson },
    })
    await expect(provider.inspect(current)).resolves.toMatchObject({
      descriptorMatches: false,
      descriptorDigest: null,
      observedLifecycle: 'degraded',
      qualifiedTools: [],
    })
    await expect(provider.prepare(operation('drift', 'disable', 'disabled'))).rejects.toThrow('owner descriptor changed')
    owner.active.set('remote', exact)

    const secondConfig = config(second)
    const secondDigest = (await provider.preflight(entry.candidateRef, secondConfig))!.descriptorDigest
    const updated = await execute(provider, operation('update', 'update', 'enabled', second, secondConfig, secondDigest))
    const firstDescriptorMutationId = expectedOwnerMutationId('operation:descriptor-binding', 'update', firstDigest)
    const secondDescriptorMutationId = expectedOwnerMutationId('operation:descriptor-binding', 'update', secondDigest)
    expect(secondDescriptorMutationId).not.toBe(firstDescriptorMutationId)
    expect(owner.mutations).toContainEqual({
      operation: 'update',
      mutationId: expectedOwnerMutationId('operation:http-update', 'update', secondDigest),
    })
    expect(owner.get('remote')?.desired.transport).toMatchObject({ url: second.endpoint, headers: {}, redirect: 'error' })
    await expect(provider.rollback(updated)).resolves.toBe(updated.prepared.beforeDigest)
    expect(owner.get('remote')?.desired.transport).toMatchObject({ url: first.endpoint })
    await execute(provider, operation('update-again', 'update', 'enabled', second, secondConfig, secondDigest))
    await execute(provider, operation('disable', 'disable', 'disabled', second, secondConfig, secondDigest))
    await execute(provider, operation('enable-again', 'enable', 'enabled', second, secondConfig, secondDigest))
    await execute(provider, operation('uninstall', 'uninstall', 'removed', second, secondConfig, secondDigest))
    expect(owner.get('remote')).toBeUndefined()
    expect(owner.getRemoved('remote')).toBeDefined()
    const restored = await execute(provider, operation('restore', 'restore', 'enabled', second, secondConfig, secondDigest))
    await expect(provider.rollback(restored)).resolves.toBe(restored.prepared.beforeDigest)
    expect(owner.getRemoved('remote')).toBeDefined()
    await execute(provider, operation('restore-again', 'restore', 'enabled', second, secondConfig, secondDigest))
    await execute(provider, operation('uninstall-again', 'uninstall', 'removed', second, secondConfig, secondDigest))
    await execute(provider, operation('purge', 'purge', 'removed', second, secondConfig, secondDigest))
    expect(owner.getRemoved('remote')).toBeUndefined()
    expect(owner.removeCalls).toBeGreaterThan(0)
    expect(owner.purgeCalls).toBeGreaterThan(0)
    expect(owner.mutations.every(mutation => /^mcp:[0-9a-f]{64}$/.test(mutation.mutationId))).toBe(true)
  })

  it('carries the removed owner revision through inventory and IntentPlan into restore preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-mcp-http-planned-restore-'))
    roots.push(root)
    const store = new CenterStateStore(root)
    await store.initialize()
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const entry = catalog.envelope.entries.find(candidate => candidate.kind === 'mcp')!
    const runtime = httpRuntime(entry.candidateRef)
    const owner = new HttpOwner()
    const provider = new McpLifecycleProvider(store, owner as never, [runtime])
    const configuration = config(runtime)
    const bindingDigest = (await provider.preflight(entry.candidateRef, configuration))!.descriptorDigest
    const operation = (
      id: string,
      operationKind: ProviderOperationRequest['plan']['operationKind'],
      desiredState: 'enabled' | 'disabled' | 'removed',
    ) => request({
      runtime,
      configuration,
      bindingDigest,
      owner,
      operationId: `operation:http-planned-${id}`,
      operationKind,
      desiredState,
    })

    await execute(provider, operation('install', 'install', 'disabled'))
    await execute(provider, operation('uninstall', 'uninstall', 'removed'))
    const removed = owner.getRemoved('remote')
    if (removed === undefined) throw new Error('MCP owner retained no removed record')

    const planning = mcpPlanningOwners(root, owner)
    const inventory = new HostInventoryService(
      store,
      planning.owners,
      () => catalog,
      planning.managedPlugins,
      version => provider.inspect(version),
    )
    const intentPlans = new IntentPlanService(
      store,
      new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING),
      inventory,
      planning.owners,
      () => catalog,
      planning.managedPlugins,
      {
        mcpRuntime: (candidateRef, value) => provider.preflight(candidateRef, value),
        mcpOptions: candidateRef => provider.options(candidateRef),
      },
    )
    const preview = await intentPlans.preview({
      protocolVersion: 1,
      origin: 'store',
      candidateRef: entry.candidateRef,
      operationKind: 'restore',
      scopeKey: 'profile:web',
      profileId: 'web',
      continuationId: null,
      targetKey: operation('target', 'restore', 'disabled').plan.targetKey,
      configuration: {},
    }, 'loopback-browser')
    expect(preview.plan.content.fences.ownerRevision).toBe(`mcp:${String(removed.revision)}`)

    const storedIntent = await store.getIntent(preview.intentId)
    if (storedIntent === undefined) throw new Error('planned restore has no durable intent')
    expect(storedIntent.payload.configuration).toEqual(configuration)
    const wrongEntry = catalog.envelope.entries.find(candidate => candidate.kind === 'mcp'
      && candidate.candidateRef !== entry.candidateRef)!
    await expect(intentPlans.preview({
      protocolVersion: 1,
      origin: 'store',
      candidateRef: wrongEntry.candidateRef,
      operationKind: 'restore',
      scopeKey: 'profile:web',
      profileId: 'web',
      continuationId: null,
      targetKey: operation('wrong-target', 'restore', 'disabled').plan.targetKey,
      configuration: {},
    }, 'loopback-browser')).rejects.toThrow('exact retained restore target is unavailable')
    const fixture = operation('restore', 'restore', 'disabled')
    const plannedRestore = {
      ...fixture,
      authorization: {
        ...fixture.authorization,
        planId: preview.plan.content.planId,
        planHash: preview.plan.hash,
      },
      plan: preview.plan.content,
      payload: storedIntent.payload,
    } as ProviderOperationRequest
    await expect(provider.prepare(plannedRestore)).resolves.toMatchObject({
      before: { removed: { ownerRevision: `mcp:${String(removed.revision)}` } },
    })
  })

  it('fails task composition atomically when HTTP activation does not publish qualified tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-mcp-http-task-'))
    roots.push(root)
    const store = new CenterStateStore(root)
    await store.initialize()
    const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'mcp')!
    const runtime = httpRuntime(entry.candidateRef)
    const owner = new HttpOwner()
    owner.failEnable = true
    const provider = new McpLifecycleProvider(store, owner as never, [runtime])
    const configuration = config(runtime)
    const digest = (await provider.preflight(entry.candidateRef, configuration))!.descriptorDigest
    const operation = request({
      runtime,
      configuration,
      bindingDigest: digest,
      owner,
      operationId: 'operation:http-task-install',
      operationKind: 'install',
      desiredState: 'enabled',
      origin: 'task',
    })
    const prepared = await provider.prepare(operation)
    await expect(provider.apply(prepared)).rejects.toThrow('simulated HTTP handshake failure')
    expect(owner.get('remote')).toBeUndefined()
    expect(owner.getRemoved('remote')).toBeUndefined()
    expect(await store.getManaged(operation.plan.targetKey)).toBeUndefined()
    const firstAttempt = owner.mutations.map(mutation => mutation.mutationId)
    expect(firstAttempt).toEqual([
      expectedOwnerMutationId(operation.authorization.operationId, 'task-configure', digest),
      expectedOwnerMutationId(operation.authorization.operationId, 'task-enable', digest),
      expectedOwnerMutationId(operation.authorization.operationId, 'task-rollback-remove', digest),
      expectedOwnerMutationId(operation.authorization.operationId, 'task-rollback-purge', digest),
    ])

    owner.failEnable = true
    await expect(provider.apply(prepared)).rejects.toThrow('simulated HTTP handshake failure')
    expect(owner.mutations.slice(firstAttempt.length).map(mutation => mutation.mutationId)).toEqual(firstAttempt)
  })

  it('cold-recovers the exact HTTP descriptor from a durable provider snapshot without replaying mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-mcp-http-recovery-'))
    roots.push(root)
    const store = new CenterStateStore(root)
    await store.initialize()
    const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'mcp')!
    const runtime = httpRuntime(entry.candidateRef)
    const owner = new HttpOwner()
    const provider = new McpLifecycleProvider(store, owner as never, [runtime])
    const configuration = config(runtime)
    const bindingDigest = (await provider.preflight(entry.candidateRef, configuration))!.descriptorDigest
    const operation = request({
      runtime,
      configuration,
      bindingDigest,
      owner,
      operationId: 'operation:http-cold-recovery',
      operationKind: 'install',
      desiredState: 'enabled',
      origin: 'task',
    })
    const prepared = await provider.prepare(operation)
    await store.putProviderSnapshot({
      schemaVersion: 1,
      operationId: operation.authorization.operationId,
      targetKey: operation.plan.targetKey,
      before: prepared.before,
      beforeDigest: prepared.beforeDigest,
      recoveryPoint: provider.recoveryPoint(prepared),
    })

    const recoveredProvider = new McpLifecycleProvider(store, owner as never, [runtime])
    const recovered = await recoveredProvider.recover(operation)
    expect(recovered).not.toBeNull()
    await expect(recoveredProvider.verify(recovered!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
    expect(owner.mutations.slice(0, 2).map(mutation => mutation.mutationId)).toEqual([
      expectedOwnerMutationId(operation.authorization.operationId, 'task-configure', bindingDigest),
      expectedOwnerMutationId(operation.authorization.operationId, 'task-enable', bindingDigest),
    ])
    expect(owner.get('remote')?.desired.transport).toMatchObject({
      transport: 'streamable-http',
      url: runtime.endpoint,
      headers: {},
      redirect: 'error',
    })
    const ownerRevision = owner.revision
    await expect(recoveredProvider.recover(operation)).resolves.toMatchObject({ afterDigest: recovered!.afterDigest })
    expect(owner.revision).toBe(ownerRevision)

    const drifted = { ...runtime, endpoint: 'https://mcp.example.test/mcp/drifted' }
    const driftedProvider = new McpLifecycleProvider(store, owner as never, [drifted])
    await expect(driftedProvider.recover(operation)).rejects.toThrow('runtime no longer matches the immutable plan')
    expect(owner.revision).toBe(ownerRevision)
  })

  it('cold-recovers a manual Install as one strict disabled owner row without a duplicate mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-mcp-http-store-recovery-'))
    roots.push(root)
    const store = new CenterStateStore(root)
    await store.initialize()
    const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'mcp')!
    const runtime = httpRuntime(entry.candidateRef)
    const owner = new HttpOwner()
    const provider = new McpLifecycleProvider(store, owner as never, [runtime])
    const configuration = config(runtime)
    const bindingDigest = (await provider.preflight(entry.candidateRef, configuration))!.descriptorDigest
    const operation = request({
      runtime,
      configuration,
      bindingDigest,
      owner,
      operationId: 'operation:http-store-cold-recovery',
      operationKind: 'install',
      desiredState: 'disabled',
      origin: 'store',
    })
    const prepared = await provider.prepare(operation)
    await store.putProviderSnapshot({
      schemaVersion: 1,
      operationId: operation.authorization.operationId,
      targetKey: operation.plan.targetKey,
      before: prepared.before,
      beforeDigest: prepared.beforeDigest,
      recoveryPoint: provider.recoveryPoint(prepared),
    })

    const recovered = await provider.recover(operation)
    expect(recovered).not.toBeNull()
    await expect(provider.verify(recovered!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
    expect(owner.get('remote')).toMatchObject({
      desired: { enabled: false, transport: { url: runtime.endpoint, headers: {}, redirect: 'error' } },
      observed: { state: 'disabled' },
      tools: { names: [] },
    })
    expect(owner.mutations).toEqual([{
      operation: 'configure',
      mutationId: expectedOwnerMutationId(operation.authorization.operationId, 'configure-create', bindingDigest),
    }])
    const revision = owner.revision
    await expect(provider.recover(operation)).resolves.toMatchObject({ afterDigest: recovered!.afterDigest })
    expect(owner.revision).toBe(revision)
    expect(owner.mutations).toHaveLength(1)
  })

  it('rejects auth, headers, arbitrary URLs, non-HTTPS, noncanonical coordinates, redirects, and HTTP roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-mcp-http-reject-'))
    roots.push(root)
    const store = new CenterStateStore(root)
    await store.initialize()
    const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'mcp')!
    const base = httpRuntime(entry.candidateRef)
    const invalid = [
      { ...base, endpoint: 'http://mcp.example.test/mcp' },
      { ...base, endpoint: 'https://MCP.EXAMPLE.TEST/mcp/v1' },
      { ...base, endpoint: 'https://user:secret@mcp.example.test/mcp/v1' },
      { ...base, origin: 'https://different.example.test' },
      { ...base, redirects: 'follow' },
      { ...base, authentication: 'bearer' },
      { ...base, headers: { Authorization: 'Bearer secret' } },
      { ...base, env: { TOKEN: 'secret' } },
      { ...base, candidateRef: 'mcp:io.github.domdomegg/filesystem-mcp@9.9.9' },
      { ...base, version: '9.9.9' },
    ]
    for (const runtime of invalid) {
      expect(() => new McpLifecycleProvider(store, new HttpOwner() as never, [runtime as never])).toThrow()
    }

    const provider = new McpLifecycleProvider(store, new HttpOwner() as never, [base])
    for (const badConfiguration of [
      { ...config(base), url: base.endpoint },
      { ...config(base), headers: {} },
      { ...config(base), authorization: 'Bearer secret' },
      { ...config(base), roots: ['/tmp'] },
      { ...config(base), transport: 'stdio', roots: ['/tmp'] },
    ]) {
      await expect(provider.preflight(entry.candidateRef, badConfiguration as RpcJson)).rejects.toThrow()
    }
  })
})
