import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { CenterStateStore, storageKey } from '../src/host/index.ts'
import {
  McpLifecycleProvider,
  PluginLifecycleProvider,
  SkillLifecycleProvider,
  type AdmittedMcpRuntime,
  type ProviderOperationRequest,
} from '../src/providers/index.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FailOnceManagedStore extends CenterStateStore {
  failManagedWrite = false
  snapshotTransform: ((value: NonNullable<Awaited<ReturnType<CenterStateStore['getProviderSnapshot']>>>) =>
    NonNullable<Awaited<ReturnType<CenterStateStore['getProviderSnapshot']>>>) | null = null

  override async putManaged(record: Parameters<CenterStateStore['putManaged']>[0], expectedRevision: number): Promise<void> {
    if (this.failManagedWrite) {
      this.failManagedWrite = false
      throw new Error('simulated kill after provider mutation')
    }
    await super.putManaged(record, expectedRevision)
  }

  override async getProviderSnapshot(operationId: string) {
    const value = await super.getProviderSnapshot(operationId)
    return value === undefined || this.snapshotTransform === null ? value : this.snapshotTransform(structuredClone(value))
  }
}

class MergedSkillsFixture {
  private provider: any

  registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => any): () => void {
    this.provider = create({ signal: new AbortController().signal, invalidate() {} })
    return () => { this.provider = undefined }
  }

  async snapshot(options?: unknown) {
    return { skills: this.provider === undefined ? [] : await this.provider.list(options), complete: true }
  }

  async list(options?: unknown) {
    return (await this.snapshot(options)).skills
  }

  async get(name: string, options?: unknown) {
    const candidate = (await this.list(options)).find((item: any) => item.name === name)
    return candidate === undefined ? undefined : await this.provider.get(candidate, options)
  }
}

interface McpRecord {
  id: string
  revision: number
  desired: { id: string; enabled: boolean; transport: any }
  observed: { state: 'disabled' | 'ready'; desiredRevision: number; generation: number }
  tools: { generation: number; digest: string; names: string[] }
}

class IdempotentMcpOwner {
  revision = 0
  active = new Map<string, McpRecord>()
  removed = new Map<string, any>()
  receipts = new Map<string, { request: string; receipt: any }>()

  snapshot() {
    return { revision: this.revision, connections: [...this.active.values()], removed: [...this.removed.values()] }
  }

  get(id: string) { return this.active.get(id) }
  getRemoved(id: string) { return this.removed.get(id) }

  configure = async (request: any) => this.mutate(request.mutationId, request, () => {
    if (request.expectedRevision !== 0 || this.active.has(request.desired.id)) throw new Error('configure conflict')
    const record = this.view(request.desired.id, 1, request.desired.enabled, request.desired.transport)
    this.active.set(record.id, record)
    return this.receipt(request.mutationId, 'configure', record.id, record.revision)
  })

  enable = async (request: any) => this.setEnabled('enable', request, true)
  disable = async (request: any) => this.setEnabled('disable', request, false)

  update = async (request: any) => this.mutate(request.mutationId, request, () => {
    const prior = this.requireActive(request.id, request.expectedRevision)
    const next = this.view(prior.id, prior.revision + 1, prior.desired.enabled, request.transport)
    this.active.set(next.id, next)
    return this.receipt(request.mutationId, 'update', next.id, next.revision)
  })

  remove = async (request: any) => this.mutate(request.mutationId, request, () => {
    const prior = this.requireActive(request.id, request.expectedRevision)
    const revision = prior.revision + 1
    this.active.delete(prior.id)
    this.removed.set(prior.id, { id: prior.id, revision, desired: prior.desired, removedAtRevision: this.revision + 1 })
    return this.receipt(request.mutationId, 'remove', prior.id, revision)
  })

  restore = async (request: any) => this.mutate(request.mutationId, request, () => {
    const prior = this.removed.get(request.id)
    if (prior?.revision !== request.expectedRevision) throw new Error('restore conflict')
    const next = this.view(prior.id, prior.revision + 1, prior.desired.enabled, prior.desired.transport)
    this.removed.delete(prior.id)
    this.active.set(prior.id, next)
    return this.receipt(request.mutationId, 'restore', prior.id, next.revision)
  })

  purge = async (request: any) => this.mutate(request.mutationId, request, () => {
    const prior = this.removed.get(request.id)
    if (prior?.revision !== request.expectedRevision) throw new Error('purge conflict')
    this.removed.delete(request.id)
    return this.receipt(request.mutationId, 'purge', request.id, prior.revision + 1)
  })

  private async setEnabled(operation: string, request: any, enabled: boolean) {
    return await this.mutate(request.mutationId, request, () => {
      const prior = this.requireActive(request.id, request.expectedRevision)
      const next = this.view(prior.id, prior.revision + 1, enabled, prior.desired.transport)
      this.active.set(next.id, next)
      return this.receipt(request.mutationId, operation, next.id, next.revision)
    })
  }

  private async mutate(id: string, request: unknown, apply: () => any) {
    const encoded = JSON.stringify(request)
    const prior = this.receipts.get(id)
    if (prior !== undefined) {
      if (prior.request !== encoded) throw new Error('mutation id replay changed request')
      return prior.receipt
    }
    const receipt = apply()
    this.revision += 1
    receipt.snapshotRevision = this.revision
    this.receipts.set(id, { request: encoded, receipt })
    return receipt
  }

  private requireActive(id: string, revision: number): McpRecord {
    const record = this.active.get(id)
    if (record?.revision !== revision) throw new Error('active revision conflict')
    return record
  }

  private view(id: string, revision: number, enabled: boolean, transport: any): McpRecord {
    return {
      id,
      revision,
      desired: { id, enabled, transport },
      observed: { state: enabled ? 'ready' : 'disabled', desiredRevision: revision, generation: revision },
      tools: { generation: revision, digest: `tools:${revision}`, names: enabled ? [`${id}/read`] : [] },
    }
  }

  private receipt(mutationId: string, operation: string, id: string, revision: number) {
    return { mutationId, operation, id, revision, changed: true, desiredDigest: `desired:${revision}` }
  }
}

class IdempotentProfileOwner {
  readonly stages = new Map<string, { request: string; value: any }>()
  readonly restores = new Map<string, { request: string; value: any }>()
  private state: any

  constructor(private readonly root: string) {
    this.state = {
      profile: 'web', revision: 1, treeDigest: 'tree:before', effectivePath: root,
      activeGeneration: 'generation:before', lastGoodGeneration: 'generation:baseline',
      rollbackGeneration: null, bootStatus: 'verified',
    }
  }

  async snapshot() { return structuredClone(this.state) }

  markBootVerified(revision = this.state.revision) {
    this.state = { ...this.state, revision, bootStatus: 'verified' }
  }

  replaceBootEvidence(value: Readonly<{ treeDigest?: string; activeGeneration?: string }>) {
    this.state = { ...this.state, ...value }
  }

  async stage(request: any) {
    const encoded = JSON.stringify(request)
    const replay = this.stages.get(request.mutationId)
    if (replay !== undefined) {
      if (replay.request !== encoded) throw new Error('Profile mutation replay changed request')
      return structuredClone(replay.value)
    }
    if (request.expectedRevision !== this.state.revision || request.expectedTreeDigest !== this.state.treeDigest) {
      throw new Error('Profile stage fence conflict')
    }
    const value = {
      profile: request.profile,
      mutationId: request.mutationId,
      generation: `generation:${request.mutationId}`,
      basedOnRevision: request.expectedRevision,
      basedOnTreeDigest: request.expectedTreeDigest,
      treeDigest: `tree:${request.mutationId}`,
      mutation: request.mutation,
    }
    this.stages.set(request.mutationId, { request: encoded, value })
    return structuredClone(value)
  }

  async commit(request: any) {
    const staged = [...this.stages.values()].find(value => value.value.generation === request.generation)?.value
    if (staged === undefined) throw new Error('Profile generation is absent')
    const before = structuredClone(this.state)
    if (this.state.activeGeneration !== request.generation) {
      if (request.expectedRevision !== this.state.revision || request.expectedTreeDigest !== this.state.treeDigest) {
        throw new Error('Profile commit fence conflict')
      }
      this.state = {
        ...this.state,
        revision: this.state.revision + 1,
        treeDigest: staged.treeDigest,
        effectivePath: join(this.root, request.generation),
        activeGeneration: request.generation,
        bootStatus: 'pending-restart',
      }
    }
    return { operation: 'commit', before, after: structuredClone(this.state), restartRequired: true }
  }

  async abort() { return false }

  async restoreLastGood(request: any) {
    const encoded = JSON.stringify(request)
    const replay = this.restores.get(request.mutationId)
    if (replay !== undefined) {
      if (replay.request !== encoded) throw new Error('Profile restore replay changed request')
      return structuredClone(replay.value)
    }
    if (request.expectedRevision !== this.state.revision || request.expectedTreeDigest !== this.state.treeDigest) {
      throw new Error('Profile restore fence conflict')
    }
    const before = structuredClone(this.state)
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      treeDigest: 'tree:rollback',
      activeGeneration: this.state.lastGoodGeneration,
      bootStatus: 'pending-restart',
    }
    const value = { operation: 'restore', before, after: structuredClone(this.state), restartRequired: true }
    this.restores.set(request.mutationId, { request: encoded, value })
    return structuredClone(value)
  }

  async acknowledgeBoot() { return { before: this.state, after: this.state, restartRequired: false } }
  async list() { return { snapshot: this.state, active: null, staged: [], recoverable: [] } }
}

function request(
  kind: 'skill' | 'mcp',
  operationId: string,
  configuration: any,
  scopeRevision: string,
  runtimeBinding: Readonly<{ runtimeRef: string; version: string; descriptorDigest: `sha256:${string}` }> | null = null,
  artifactIntegrity?: `sha256:${string}`,
  reviewEvidence?: ProviderOperationRequest['plan']['reviewEvidence'],
): ProviderOperationRequest {
  const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === kind)!
  const targetKey = `${kind}:web:user:${entry.name}`
  return {
    authorization: {
      operationId,
      planId: `plan:${operationId}`,
      planHash: canonicalSha256({ operationId }),
      operationKind: 'install',
      managedObject: kind === 'mcp' ? 'connection' : 'artifact',
      externalRuntimeAction: kind === 'mcp' ? 'none' : 'download',
      runtimeBinding,
      targetKey,
      ownerKey: kind === 'mcp' ? 'mcpConnections' : 'skills',
      scopeKey: 'user',
      profileId: 'web',
      authorizedAtMs: 1,
    },
    plan: {
      schemaVersion: 1,
      singleUse: true,
      planId: `plan:${operationId}`,
      intentId: `intent:${operationId}`,
      origin: kind === 'mcp' ? 'task' : 'store',
      candidateRef: entry.candidateRef,
      extensionKind: kind,
      extensionId: entry.name,
      managedObject: kind === 'mcp' ? 'connection' : 'artifact',
      externalRuntimeAction: kind === 'mcp' ? 'none' : 'download',
      runtimeBinding,
      artifactRevision: entry.artifact.version,
      artifactIntegrity: artifactIntegrity ?? entry.artifact.integrity,
      artifactUrl: entry.artifact.acquisitionUrl,
      artifactSizeBytes: entry.artifact.sizeBytes,
      operationKind: 'install',
      desiredState: 'enabled',
      targetKey,
      ownerKey: kind === 'mcp' ? 'mcpConnections' : 'skills',
      scopeKey: 'user',
      profileId: 'web',
      idempotencyKey: `idem:${operationId}`,
      authorityDigest: canonicalSha256({ authority: operationId }),
      reviewEvidence: reviewEvidence ?? testReviewEvidence(kind, 'install'),
      mutationDigest: canonicalSha256({ mutation: operationId }),
      verificationDigest: canonicalSha256({ verification: operationId }),
      createdAtMs: 1,
      expiresAtMs: 10_000,
      fences: {
        catalogRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
        inventoryRevision: canonicalSha256({ inventory: operationId }),
        targetRevision: 'absent',
        ownerRevision: kind === 'mcp' ? 'mcp:0' : 'skills:empty',
        scopeRevision,
        profileRevision: 'profile:0:tree',
      },
    },
    entry,
    payload: {
      configuration,
      continuationId: null,
      resolutionId: null,
      verificationPayloadDigest: null,
      taskSessionId: null,
      taskOriginalMessageId: null,
    },
    artifactPath: null,
    signal: new AbortController().signal,
  }
}

function skillReviewEvidence(
  operationKind: ProviderOperationRequest['plan']['operationKind'],
  before: string | null,
  after: string | null,
): ProviderOperationRequest['plan']['reviewEvidence'] {
  const base = testReviewEvidence('skill', operationKind)
  const bytesDigest = (body: string | null) => body === null
    ? null
    : `sha256:${createHash('sha256').update(body).digest('hex')}` as const
  return {
    ...base,
    body: { before, after, beforeDigest: bytesDigest(before), afterDigest: bytesDigest(after) },
    files: [{
      ...base.files[0]!,
      change: before === null ? 'add' : after === null ? 'remove' : 'replace',
      beforeDigest: bytesDigest(before), afterDigest: bytesDigest(after),
      sizeBytes: Buffer.byteLength(after ?? before ?? '', 'utf8'),
    }],
  }
}

describe('provider crash-point reconciliation', () => {
  it('recovers a Skill rename that completed before the Center record write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-skill-recovery-'))
    roots.push(root)
    const store = new FailOnceManagedStore(root)
    await store.initialize()
    const registry = new MergedSkillsFixture()
    const provider = new SkillLifecycleProvider(root, store, registry as any)
    provider.register()
    const artifact = join(root, 'documentation-writer.md')
    const artifactBody = '---\nname: documentation-writer\ndescription: Exact test skill\n---\nDo the exact task.\n'
    await writeFile(artifact, artifactBody, 'utf8')
    const configuration = { modelInvocable: true, userInvocable: true, projectRoot: null }
    const skillIntegrity = `sha256:${createHash('sha256').update(await readFile(artifact)).digest('hex')}` as const
    const operation = request(
      'skill',
      'operation:skill-kill',
      configuration,
      canonicalSha256({ scope: 'skill' }),
      null,
      skillIntegrity,
      skillReviewEvidence('install', null, artifactBody),
    )
    operation.artifactPath = artifact
    const prepared = await provider.prepare(operation)
    await store.putProviderSnapshot({
      schemaVersion: 1,
      operationId: operation.authorization.operationId,
      targetKey: operation.plan.targetKey,
      before: prepared.before,
      beforeDigest: prepared.beforeDigest,
      recoveryPoint: provider.recoveryPoint(prepared),
    })
    store.snapshotTransform = value => ({
      ...value,
      recoveryPoint: {
        ...(value.recoveryPoint as Record<string, any>),
        configuration: { modelInvocable: true, userInvocable: false, projectRoot: null },
      },
    })
    await expect(provider.recover({ ...operation, artifactPath: null })).rejects.toThrow('does not bind the immutable plan')
    expect(await store.getManaged(operation.plan.targetKey)).toBeUndefined()
    store.snapshotTransform = null
    store.failManagedWrite = true
    await expect(provider.apply(prepared)).rejects.toThrow('simulated kill')
    expect(await store.getManaged(operation.plan.targetKey)).toBeUndefined()

    const recovered = await provider.recover({ ...operation, artifactPath: null })
    expect(recovered).not.toBeNull()
    await expect(provider.verify(recovered!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
    const managed = await store.getManaged(operation.plan.targetKey)
    expect(managed?.current?.materialPath).toMatch(/SKILL\.md$/)
    await expect(readFile(managed!.current!.materialPath, 'utf8')).resolves.toContain('Exact test skill')

    await writeFile(
      managed!.current!.materialPath,
      '---\nname: documentation-writer\ndescription: Exact test skill\n---\nReplaced authority-bearing instructions.\n',
      'utf8',
    )
    await expect(registry.snapshot()).resolves.toMatchObject({ skills: [] })
    const uninstall = {
      ...operation,
      authorization: {
        ...operation.authorization,
        operationId: 'operation:skill-tampered-uninstall',
        operationKind: 'uninstall' as const,
      },
      plan: {
        ...operation.plan,
        planId: 'plan:skill-tampered-uninstall',
        operationKind: 'uninstall' as const,
        desiredState: 'removed' as const,
      },
      artifactPath: null,
    }
    const beforeTamperedAttempt = canonicalSha256(await store.getManaged(operation.plan.targetKey))
    await expect(provider.prepare(uninstall)).rejects.toThrow(/integrity changed/)
    expect(canonicalSha256(await store.getManaged(operation.plan.targetKey))).toBe(beforeTamperedAttempt)
  })

  it('idempotently replays task MCP configure and enable after the owner changed but the Center write was killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-mcp-recovery-'))
    roots.push(root)
    const store = new FailOnceManagedStore(root)
    await store.initialize()
    const executable = join(root, 'filesystem-mcp')
    await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(executable, 0o700)
    const canonicalExecutable = await realpath(executable)
    const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'mcp')!
    const runtime: AdmittedMcpRuntime = {
      transport: 'stdio',
      runtimeRef: 'fixture-runtime',
      candidateRef: entry.candidateRef,
      executablePath: canonicalExecutable,
      version: entry.artifact.version,
      executableSha256: `sha256:${createHash('sha256').update(await readFile(executable)).digest('hex')}`,
      fixedArgs: ['--stdio'],
      workingDirectory: await realpath(root),
    }
    const owner = new IdempotentMcpOwner()
    const provider = new McpLifecycleProvider(store, owner as any, [runtime])
    const configuration = {
      transport: 'stdio', connectionId: 'filesystem', runtimeRef: runtime.runtimeRef, roots: [await realpath(root)], toolCallTimeoutMs: 5_000,
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 3 },
    }
    const preflight = await provider.preflight(entry.candidateRef, configuration)
    const scopeRevision = canonicalSha256({
      scopeKey: 'user', profileId: 'web', configuration, runtimeDescriptorDigest: preflight!.descriptorDigest,
    })
    const operation = request('mcp', 'operation:mcp-kill', configuration, scopeRevision, {
      runtimeRef: runtime.runtimeRef,
      version: runtime.version,
      descriptorDigest: preflight!.descriptorDigest,
    }, undefined, {
      ...testReviewEvidence('mcp', 'install'),
      descriptor: preflight!.reviewDescriptor,
      runtime: { ownership: 'host', version: runtime.version, digest: preflight!.runtimeDigest, action: 'none' },
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
    store.snapshotTransform = value => ({
      ...value,
      recoveryPoint: {
        ...(value.recoveryPoint as Record<string, any>),
        configuration: { ...configuration, toolCallTimeoutMs: 5_001 },
      },
    })
    await expect(provider.recover(operation)).rejects.toThrow('runtime no longer matches the immutable plan')
    expect(owner.receipts.size).toBe(0)
    store.snapshotTransform = null
    store.failManagedWrite = true
    await expect(provider.apply(prepared)).rejects.toThrow('simulated kill')
    expect(owner.get('filesystem')?.desired.enabled).toBe(true)
    expect(owner.get('filesystem')?.tools.names).toEqual(['filesystem/read'])
    expect(await store.getManaged(operation.plan.targetKey)).toBeUndefined()

    const recovered = await provider.recover(operation)
    expect(recovered).not.toBeNull()
    await expect(provider.verify(recovered!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
    expect(owner.receipts.size).toBe(2)
    expect((await store.getManaged(operation.plan.targetKey))?.current?.kindState).toMatchObject({ configured: true })
  })

  it('finishes a killed Skill purge from the durable snapshot without following a substituted symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-skill-purge-'))
    roots.push(root)
    const store = new FailOnceManagedStore(root)
    await store.initialize()
    const registry = new MergedSkillsFixture()
    const provider = new SkillLifecycleProvider(root, store, registry as any)
    provider.register()
    const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'skill')!
    const targetKey = `skill:web:user:${entry.name}`
    const retainedDirectory = join(root, 'material', 'skills', storageKey(targetKey), storageKey(entry.artifact.integrity))
    const retainedPath = join(retainedDirectory, 'SKILL.md')
    await mkdir(retainedDirectory, { recursive: true })
    await writeFile(retainedPath, '---\nname: documentation-writer\ndescription: Retained\n---\nold\n', 'utf8')
    const version = {
      candidateRef: entry.candidateRef,
      artifactRevision: entry.artifact.version,
      artifactIntegrity: entry.artifact.integrity,
      materialPath: retainedPath,
      configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
      enabled: true,
      ownerRevision: 'skills:1',
      kindState: {
        skillName: entry.name,
        description: 'Retained',
        modelInvocable: true,
        userInvocable: true,
      },
    }
    const install = request('skill', 'operation:prior', version.configuration, canonicalSha256({ scope: 'skill' }))
    await store.putManaged({
      schemaVersion: 1,
      kind: 'skill',
      extensionId: entry.name,
      targetKey: install.plan.targetKey,
      scopeKey: 'user',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:prior',
      current: null,
      lastGood: version,
      removed: version,
      pending: null,
      updatedAtMs: 1,
    }, 0)
    const purge = {
      ...install,
      authorization: { ...install.authorization, operationId: 'operation:purge-kill', operationKind: 'purge' as const },
      plan: {
        ...install.plan,
        operationKind: 'purge' as const,
        desiredState: 'removed' as const,
        reviewEvidence: skillReviewEvidence('purge', null, null),
      },
      artifactPath: null,
    }
    const prepared = await provider.prepare(purge)
    await store.putProviderSnapshot({
      schemaVersion: 1,
      operationId: purge.authorization.operationId,
      targetKey: purge.plan.targetKey,
      before: prepared.before,
      beforeDigest: prepared.beforeDigest,
      recoveryPoint: provider.recoveryPoint(prepared),
    })
    ;(provider as any).removeRetained = async () => { throw new Error('simulated kill before retained deletion') }
    await expect(provider.apply(prepared)).rejects.toThrow('simulated kill')

    const external = await mkdtemp(join(tmpdir(), 'extension-external-marker-'))
    roots.push(external)
    const marker = join(external, 'must-survive.txt')
    await writeFile(marker, 'safe', 'utf8')
    await rm(retainedDirectory, { recursive: true })
    await symlink(external, retainedDirectory, 'dir')

    const recoveredProvider = new SkillLifecycleProvider(root, store, registry as any)
    const recovered = await recoveredProvider.recover(purge)
    expect(recovered).not.toBeNull()
    await expect(recoveredProvider.verify(recovered!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
    await expect(readFile(marker, 'utf8')).resolves.toBe('safe')
    expect((await store.getManaged(purge.plan.targetKey))?.lastGood).toBeNull()

    const orphanedQuarantine = join(root, 'material', 'skills', '.removing', storageKey(retainedDirectory))
    await mkdir(orphanedQuarantine, { recursive: true })
    await writeFile(join(orphanedQuarantine, 'SKILL.md'), 'orphaned after rename', 'utf8')
    await expect(recoveredProvider.recover(purge)).resolves.not.toBeNull()
    await expect(lstat(orphanedQuarantine)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reconciles an idempotent Profile commit that completed before the Center record write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-recovery-'))
    roots.push(root)
    const store = new FailOnceManagedStore(root)
    await store.initialize()
    const owner = new IdempotentProfileOwner(root)
    const provider = new PluginLifecycleProvider(store, owner as any, {
      observe: async (_packageName: string, operationKind: string) => ({
        entryId: 'dsh-capability-resolver',
        moduleName: 'dsh-capability-resolver',
        fiberPhase: operationKind === 'uninstall' ? 'absent' : 'active',
      }),
    })
    const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'plugin')!
    const targetKey = `plugin:web:profile:web:${entry.name}`
    const version = {
      candidateRef: entry.candidateRef,
      artifactRevision: entry.artifact.version,
      artifactIntegrity: entry.artifact.integrity,
      materialPath: root,
      configuration: {},
      enabled: true,
      ownerRevision: 'profile:1:tree:before',
      kindState: {
        packageName: entry.artifact.id,
        profileGeneration: 'generation:before',
        treeDigest: 'tree:before',
        loaderPhase: 'active',
        consumerObserved: true,
        externalRestartObserved: true,
        runtimeEvidence: {
          entryId: entry.artifact.id,
          moduleName: entry.artifact.id,
          fiberPhase: 'active',
        },
      },
    }
    await store.putManaged({
      schemaVersion: 1,
      kind: 'plugin',
      extensionId: entry.name,
      targetKey,
      scopeKey: 'profile:web',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:prior-plugin',
      current: version,
      lastGood: null,
      removed: null,
      pending: null,
      updatedAtMs: 1,
    }, 0)
    const operation: ProviderOperationRequest = {
      authorization: {
        operationId: 'operation:plugin-kill',
        planId: 'plan:plugin-kill',
        planHash: canonicalSha256({ plan: 'plugin-kill' }),
        operationKind: 'uninstall',
        managedObject: 'artifact',
        externalRuntimeAction: 'none',
        runtimeBinding: null,
        targetKey,
        ownerKey: 'profileTransactions',
        scopeKey: 'profile:web',
        profileId: 'web',
        authorizedAtMs: 1,
      },
      plan: {
        schemaVersion: 1,
        singleUse: true,
        planId: 'plan:plugin-kill',
        intentId: 'intent:plugin-kill',
        origin: 'store',
        candidateRef: entry.candidateRef,
        extensionKind: 'plugin',
        extensionId: entry.name,
        managedObject: 'artifact',
        externalRuntimeAction: 'none',
        runtimeBinding: null,
        artifactRevision: entry.artifact.version,
        artifactIntegrity: entry.artifact.integrity,
        artifactUrl: entry.artifact.acquisitionUrl,
        artifactSizeBytes: entry.artifact.sizeBytes,
        operationKind: 'uninstall',
        desiredState: 'removed',
        targetKey,
        ownerKey: 'profileTransactions',
        scopeKey: 'profile:web',
        profileId: 'web',
        idempotencyKey: 'plugin-kill',
        authorityDigest: canonicalSha256({ authority: 'plugin-kill' }),
        reviewEvidence: testReviewEvidence('plugin', 'uninstall', {
          generation: 'generation:baseline',
          treeDigest: 'tree:rollback' as `sha256:${string}`,
        }),
        mutationDigest: canonicalSha256({ mutation: 'plugin-kill' }),
        verificationDigest: canonicalSha256({ verification: 'plugin-kill' }),
        createdAtMs: 1,
        expiresAtMs: 10_000,
        fences: {
          catalogRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
          inventoryRevision: canonicalSha256({ inventory: 'plugin-kill' }),
          targetRevision: 'center:1',
          ownerRevision: 'profile:1:tree:before',
          scopeRevision: canonicalSha256({ scope: 'plugin-kill' }),
          profileRevision: 'profile:1:tree:before',
        },
      },
      entry,
      payload: {
        configuration: {}, continuationId: null, resolutionId: null, verificationPayloadDigest: null,
        taskSessionId: null, taskOriginalMessageId: null,
      },
      artifactPath: null,
      signal: new AbortController().signal,
    }
    const prepared = await provider.prepare(operation)
    await store.putProviderSnapshot({
      schemaVersion: 1,
      operationId: operation.authorization.operationId,
      targetKey,
      before: prepared.before,
      beforeDigest: prepared.beforeDigest,
      recoveryPoint: provider.recoveryPoint(prepared),
    })
    store.snapshotTransform = value => {
      const point = value.recoveryPoint as Record<string, any>
      return {
        ...value,
        recoveryPoint: { ...point, snapshot: { ...point.snapshot, revision: 2 } },
      }
    }
    await expect(provider.recover(operation)).rejects.toThrow('does not bind the immutable Profile fence')
    expect(owner.stages.size).toBe(0)
    store.snapshotTransform = null
    store.failManagedWrite = true
    await expect(provider.apply(prepared)).rejects.toThrow('simulated kill')
    expect((await owner.snapshot()).activeGeneration).toBe('generation:operation:plugin-kill:apply')
    expect((await store.getManaged(targetKey))?.current).not.toBeNull()

    const recovered = await provider.recover(operation)
    expect(recovered).toMatchObject({ profileGeneration: 'generation:operation:plugin-kill:apply', restartRequired: true })
    expect((await store.getManaged(targetKey))?.current).toBeNull()
    expect((await store.getManaged(targetKey))?.pending).toMatchObject({
      operationId: 'operation:plugin-kill',
      revision: 2,
    })
    expect(owner.stages.size).toBe(1)

    owner.markBootVerified(3)
    await expect(provider.acknowledgeBoot({
      operationId: operation.authorization.operationId,
      targetKey,
      profileId: 'web',
      generation: 'generation:operation:plugin-kill:apply',
    })).resolves.toBeUndefined()
    const candidateAcknowledged = await provider.recover(operation)
    expect(candidateAcknowledged).toMatchObject({
      rollbackRestart: false,
      profileGeneration: 'generation:operation:plugin-kill:apply',
    })
    expect((await store.getManaged(targetKey))?.current).toBeNull()
    expect((await store.getManaged(targetKey))?.pending).toBeNull()
    expect(await store.getBootAck(operation.authorization.operationId)).toMatchObject({ phase: 'candidate', revision: 3 })

    store.failManagedWrite = true
    await expect(provider.rollback(candidateAcknowledged!)).rejects.toThrow('simulated kill')
    expect((await owner.snapshot()).treeDigest).toBe('tree:rollback')
    owner.replaceBootEvidence({ treeDigest: 'tree:drifted' })
    await expect(provider.reconcileBreakGlassRestore(operation, prepared.beforeDigest)).resolves.toBeNull()
    owner.replaceBootEvidence({ treeDigest: 'tree:rollback' })
    await expect(provider.reconcileBreakGlassRestore(operation, canonicalSha256({ tampered: true })))
      .rejects.toThrow('does not bind the journal')
    await expect(provider.reconcileBreakGlassRestore(operation, prepared.beforeDigest)).resolves.toMatchObject({
      rollbackRestart: true,
      profileGeneration: 'generation:baseline',
    })
    expect(owner.restores.size).toBe(1)
    const rollback = await provider.recover(operation)
    expect(rollback).toMatchObject({ rollbackRestart: true, profileGeneration: 'generation:baseline' })
    expect((await store.getManaged(targetKey))?.pending).toMatchObject({
      operationId: 'operation:plugin-kill',
      operationKind: 'rollback',
      revision: 4,
    })

    owner.markBootVerified(5)
    await expect(provider.acknowledgeBoot({
      operationId: 'operation:replacement',
      targetKey,
      profileId: 'web',
      generation: 'generation:baseline',
    })).rejects.toThrow('does not bind')
    await expect(provider.acknowledgeBoot({
      operationId: operation.authorization.operationId,
      targetKey,
      profileId: 'replacement',
      generation: 'generation:baseline',
    })).rejects.toThrow('does not bind')
    await expect(provider.acknowledgeBoot({
      operationId: operation.authorization.operationId,
      targetKey,
      profileId: 'web',
      generation: 'generation:replacement',
    })).rejects.toThrow('does not bind')

    owner.markBootVerified(6)
    await expect(provider.acknowledgeBoot({
      operationId: operation.authorization.operationId,
      targetKey,
      profileId: 'web',
      generation: 'generation:baseline',
    })).rejects.toThrow('successful app boot')
    expect((await store.getManaged(targetKey))?.pending).not.toBeNull()

    owner.markBootVerified(5)
    owner.replaceBootEvidence({ treeDigest: 'tree:replacement' })
    await expect(provider.acknowledgeBoot({
      operationId: operation.authorization.operationId,
      targetKey,
      profileId: 'web',
      generation: 'generation:baseline',
    })).rejects.toThrow('successful app boot')
    owner.replaceBootEvidence({ treeDigest: 'tree:rollback', activeGeneration: 'generation:replacement' })
    await expect(provider.acknowledgeBoot({
      operationId: operation.authorization.operationId,
      targetKey,
      profileId: 'web',
      generation: 'generation:baseline',
    })).rejects.toThrow('successful app boot')
    owner.replaceBootEvidence({ activeGeneration: 'generation:baseline' })
    await expect(provider.acknowledgeBoot({
      operationId: operation.authorization.operationId,
      targetKey,
      profileId: 'web',
      generation: 'generation:baseline',
    })).resolves.toBeUndefined()
    expect((await store.getManaged(targetKey))?.pending).toBeNull()
    expect(await store.getBootAck(operation.authorization.operationId)).toMatchObject({
      phase: 'rollback',
      revision: 5,
      generation: 'generation:baseline',
    })
    await expect(provider.recover(operation)).resolves.toMatchObject({
      rollbackRestart: true,
      profileGeneration: 'generation:baseline',
    })
  })
})
