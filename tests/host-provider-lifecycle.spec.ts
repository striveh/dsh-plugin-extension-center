import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { CenterStateStore } from '../src/host/index.ts'
import {
  buildCapabilityResolverPatch,
  inspectNpmArchive,
  LoaderPluginRuntimeProbe,
  McpLifecycleProvider,
  PluginLifecycleProvider,
  pluginConfigurationMutationDigest,
  SkillLifecycleProvider,
  type AdmittedMcpRuntime,
  type AppliedProviderOperation,
  type LifecycleProvider,
  type ProviderOperationRequest,
} from '../src/providers/index.ts'
import type { RpcJson } from '../src/service/rpc-contract.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class SkillRegistry {
  private provider: any

  registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => any): () => void {
    this.provider = create({ signal: new AbortController().signal, invalidate() {} })
    return () => { this.provider = undefined }
  }

  async snapshot(options?: unknown) {
    const candidates: any[] = this.provider === undefined ? [] : await this.provider.list(options)
    return {
      complete: true,
      skills: candidates.map(({ name, description, whenToUse, invocation, source, provider, resourceBase }) => ({
        name,
        description,
        ...(whenToUse === undefined ? {} : { whenToUse }),
        invocation,
        source,
        provider,
        ...(resourceBase === undefined ? {} : { resourceBase }),
      })),
    }
  }

  async list(options?: unknown) { return (await this.snapshot(options)).skills }

  async get(name: string, options?: unknown) {
    const candidates: any[] = this.provider === undefined ? [] : await this.provider.list(options)
    const candidate = candidates.find((item: any) => item.name === name)
    return candidate === undefined ? undefined : await this.provider.get(candidate, options)
  }
}

interface McpRow {
  id: string
  revision: number
  desired: { id: string; enabled: boolean; transport: any }
  observed: { state: 'disabled' | 'ready'; desiredRevision: number; generation: number }
  tools: { generation: number; digest: string; names: string[] }
}

class McpOwner {
  revision = 0
  freezeNextToolGeneration = false
  readonly active = new Map<string, McpRow>()
  readonly removed = new Map<string, any>()

  snapshot() { return { revision: this.revision, connections: [...this.active.values()], removed: [...this.removed.values()] } }
  get(id: string) { return this.active.get(id) }
  getRemoved(id: string) { return this.removed.get(id) }

  async configure(request: any) {
    if (this.active.has(request.desired.id) || request.expectedRevision !== 0) throw new Error('configure conflict')
    const row = this.row(request.desired.id, 1, request.desired.enabled, request.desired.transport)
    this.active.set(row.id, row)
    return this.receipt('configure', row)
  }

  async enable(request: any) { return this.setEnabled('enable', request, true) }
  async disable(request: any) { return this.setEnabled('disable', request, false) }

  async update(request: any) {
    const before = this.require(request.id, request.expectedRevision)
    const row = this.row(before.id, before.revision + 1, before.desired.enabled, request.transport)
    this.active.set(row.id, row)
    return this.receipt('update', row)
  }

  async remove(request: any) {
    const before = this.require(request.id, request.expectedRevision)
    this.active.delete(before.id)
    const removed = { id: before.id, revision: before.revision + 1, desired: before.desired }
    this.removed.set(before.id, removed)
    this.revision += 1
    return { operation: 'remove', id: before.id, revision: removed.revision, snapshotRevision: this.revision }
  }

  async restore(request: any) {
    const before = this.removed.get(request.id)
    if (before?.revision !== request.expectedRevision) throw new Error('restore conflict')
    this.removed.delete(request.id)
    const row = this.row(before.id, before.revision + 1, before.desired.enabled, before.desired.transport)
    this.active.set(row.id, row)
    return this.receipt('restore', row)
  }

  async purge(request: any) {
    const before = this.removed.get(request.id)
    if (before?.revision !== request.expectedRevision) throw new Error('purge conflict')
    this.removed.delete(request.id)
    this.revision += 1
    return { operation: 'purge', id: request.id, revision: before.revision + 1, snapshotRevision: this.revision }
  }

  private async setEnabled(operation: string, request: any, enabled: boolean) {
    const before = this.require(request.id, request.expectedRevision)
    const row = this.row(before.id, before.revision + 1, enabled, before.desired.transport)
    if (this.freezeNextToolGeneration) {
      this.freezeNextToolGeneration = false
      row.tools.generation = before.tools.generation
    }
    this.active.set(row.id, row)
    return this.receipt(operation, row)
  }

  private require(id: string, revision: number): McpRow {
    const row = this.active.get(id)
    if (row?.revision !== revision) throw new Error('MCP revision conflict')
    return row
  }

  private row(id: string, revision: number, enabled: boolean, transport: any): McpRow {
    return {
      id,
      revision,
      desired: { id, enabled, transport },
      observed: { state: enabled ? 'ready' : 'disabled', desiredRevision: revision, generation: revision },
      tools: {
        generation: revision,
        digest: canonicalSha256({ id, revision, enabled }),
        names: enabled ? [`${id}/read`] : [],
      },
    }
  }

  private receipt(operation: string, row: McpRow) {
    this.revision += 1
    return { operation, id: row.id, revision: row.revision, snapshotRevision: this.revision }
  }
}

class ProfileOwner {
  private state: any
  private readonly generations = new Map<string, { treeDigest: string; path: string }>()

  constructor(private readonly root: string) {
    this.state = {
      profile: 'web', revision: 0, treeDigest: 'tree:0', effectivePath: join(root, 'profile-live'),
      activeGeneration: null, lastGoodGeneration: null, rollbackGeneration: null, bootStatus: 'live',
    }
  }

  async initialize() {
    await mkdir(this.state.effectivePath, { recursive: true })
    await writeFile(join(this.state.effectivePath, 'cordis.patch.yml'), '[]\n', 'utf8')
  }

  async snapshot() { return structuredClone(this.state) }

  async stage(request: any) {
    if (request.expectedRevision !== this.state.revision || request.expectedTreeDigest !== this.state.treeDigest) {
      throw new Error('Profile stage fence conflict')
    }
    const generation = `generation:${request.mutationId}`
    const path = join(this.root, generation)
    await mkdir(path, { recursive: true })
    const currentPatch = await readFile(join(this.state.effectivePath, 'cordis.patch.yml'), 'utf8')
    const patch = request.mutation.operation === 'configure' ? request.mutation.patch.nextUtf8 : currentPatch
    await writeFile(join(path, 'cordis.patch.yml'), patch, 'utf8')
    const treeDigest = canonicalSha256({ generation, mutation: request.mutation, patch })
    this.generations.set(generation, { treeDigest, path })
    return {
      profile: request.profile,
      mutationId: request.mutationId,
      generation,
      basedOnRevision: request.expectedRevision,
      basedOnTreeDigest: request.expectedTreeDigest,
      treeDigest,
      mutation: request.mutation,
    }
  }

  async commit(request: any) {
    const generation = this.generations.get(request.generation)
    if (generation === undefined) throw new Error('Profile generation is absent')
    if (request.expectedRevision !== this.state.revision || request.expectedTreeDigest !== this.state.treeDigest) {
      throw new Error('Profile commit fence conflict')
    }
    const before = structuredClone(this.state)
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      treeDigest: generation.treeDigest,
      effectivePath: generation.path,
      activeGeneration: request.generation,
      bootStatus: 'pending-restart',
    }
    return { operation: 'commit', before, after: structuredClone(this.state), restartRequired: true }
  }

  async abort() { return false }

  async restoreLastGood(request: any) {
    if (request.expectedRevision !== this.state.revision || request.expectedTreeDigest !== this.state.treeDigest) {
      throw new Error('Profile restore fence conflict')
    }
    const target = this.state.rollbackGeneration ?? this.state.lastGoodGeneration
    const generation = target === null ? undefined : this.generations.get(target)
    if (target === null || generation === undefined) throw new Error('Profile recovery generation is absent')
    const before = structuredClone(this.state)
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      treeDigest: generation.treeDigest,
      effectivePath: generation.path,
      activeGeneration: target,
      bootStatus: 'pending-restart',
    }
    return { operation: 'restore', before, after: structuredClone(this.state), restartRequired: true }
  }

  markBootVerified(generation: string) {
    if (this.state.activeGeneration !== generation) throw new Error('wrong active generation')
    if (this.state.lastGoodGeneration !== generation) {
      this.state = {
        ...this.state,
        revision: this.state.revision + 1,
        rollbackGeneration: this.state.lastGoodGeneration,
        lastGoodGeneration: generation,
        bootStatus: 'verified',
      }
    } else {
      this.state = { ...this.state, bootStatus: 'verified' }
    }
  }

  async acknowledgeBoot() { return { before: this.state, after: this.state, restartRequired: false } }
  async list() { return { snapshot: this.state, active: null, staged: [], recoverable: [] } }
}

function octal(value: number, length: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii')
}

function tarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  octal(0o644, 8).copy(header, 100)
  octal(0, 8).copy(header, 108)
  octal(0, 8).copy(header, 116)
  octal(content.length, 12).copy(header, 124)
  octal(0, 12).copy(header, 136)
  header.fill(32, 148, 156)
  header[156] = '0'.charCodeAt(0)
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let checksum = 0
  for (const byte of header) checksum += byte
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148)
  const padding = Buffer.alloc((512 - content.length % 512) % 512)
  return Buffer.concat([header, content, padding])
}

async function pluginArchive(root: string): Promise<string> {
  const patch = Buffer.from('plugins:\n  dsh-capability-resolver: {}\n')
  const manifest = Buffer.from(JSON.stringify({
    name: 'dsh-capability-resolver',
    version: '0.1.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    scripts: { build: 'tsc', test: 'vitest run' },
    devDependencies: { typescript: '^6.0.0' },
  }))
  const archive = Buffer.concat([
    tarEntry('package/package.json', manifest),
    tarEntry('package/index.js', Buffer.from('export default function apply() {}\n')),
    tarEntry('package/cordis.patch.yml', patch),
    Buffer.alloc(1024),
  ])
  const path = join(root, 'dsh-capability-resolver-0.1.0.tgz')
  await writeFile(path, gzipSync(archive))
  return path
}

function request(input: Readonly<{
  kind: 'skill' | 'mcp' | 'plugin'
  operationId: string
  operationKind: 'install' | 'configure' | 'update' | 'enable' | 'disable' | 'uninstall' | 'restore' | 'purge'
  desiredState: 'enabled' | 'disabled' | 'removed'
  scopeKey: string
  profileId?: string
  configuration: RpcJson
  artifactPath?: string | null
  artifactIntegrity?: `sha256:${string}`
  profileRevision?: string
  runtimeBinding?: Readonly<{ runtimeRef: string; version: string; descriptorDigest: `sha256:${string}` }> | null
  mutationDigest?: `sha256:${string}`
  ownerRevision?: string
  reviewEvidence?: ProviderOperationRequest['plan']['reviewEvidence']
}>): ProviderOperationRequest {
  const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === input.kind)!
  const profileId = input.profileId ?? 'web'
  const targetKey = `${input.kind}:${profileId}:${input.scopeKey}:${entry.name}`
  const runtimeBinding = input.runtimeBinding ?? null
  const externalRuntimeAction = input.kind !== 'mcp' && ['install', 'update'].includes(input.operationKind)
    ? 'download' as const
    : 'none' as const
  return {
    authorization: {
      operationId: input.operationId,
      planId: `plan:${input.operationId}`,
      planHash: canonicalSha256({ plan: input.operationId }),
      operationKind: input.operationKind,
      managedObject: input.kind === 'mcp' ? 'connection' : 'artifact',
      externalRuntimeAction,
      runtimeBinding,
      targetKey,
      ownerKey: input.kind === 'plugin' ? 'profileTransactions' : input.kind === 'mcp' ? 'mcpConnections' : 'skills',
      scopeKey: input.scopeKey,
      profileId,
      authorizedAtMs: Date.now(),
    },
    plan: {
      schemaVersion: 1,
      singleUse: true,
      planId: `plan:${input.operationId}`,
      intentId: `intent:${input.operationId}`,
      origin: 'store',
      candidateRef: entry.candidateRef,
      extensionKind: input.kind,
      extensionId: entry.name,
      managedObject: input.kind === 'mcp' ? 'connection' : 'artifact',
      externalRuntimeAction,
      runtimeBinding,
      artifactRevision: entry.artifact.version,
      artifactIntegrity: input.artifactIntegrity ?? entry.artifact.integrity,
      artifactUrl: entry.artifact.acquisitionUrl,
      artifactSizeBytes: entry.artifact.sizeBytes,
      operationKind: input.operationKind,
      desiredState: input.desiredState,
      targetKey,
      ownerKey: input.kind === 'plugin' ? 'profileTransactions' : input.kind === 'mcp' ? 'mcpConnections' : 'skills',
      scopeKey: input.scopeKey,
      profileId,
      idempotencyKey: `idem:${input.operationId}`,
      authorityDigest: canonicalSha256({ authority: input.operationId }),
      reviewEvidence: input.reviewEvidence ?? testReviewEvidence(input.kind, input.operationKind),
      mutationDigest: input.mutationDigest ?? canonicalSha256({ mutation: input.operationId }),
      verificationDigest: canonicalSha256({ verification: input.operationId }),
      createdAtMs: 1,
      expiresAtMs: 1_000_000,
      fences: {
        catalogRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
        inventoryRevision: canonicalSha256({ inventory: input.operationId }),
        targetRevision: 'fixture',
        ownerRevision: input.ownerRevision ?? (input.kind === 'plugin'
          ? (input.profileRevision ?? 'profile:0:tree:0')
          : input.kind === 'mcp'
            ? 'mcp:0'
            : 'skills:fixture'),
        scopeRevision: input.kind === 'mcp'
          ? canonicalSha256({
              scopeKey: input.scopeKey,
              profileId,
              configuration: input.configuration,
              runtimeDescriptorDigest: runtimeBinding?.descriptorDigest ?? null,
            })
          : canonicalSha256({ scope: input.scopeKey }),
        profileRevision: input.profileRevision ?? 'profile:0:tree:0',
      },
    },
    entry,
    payload: {
      configuration: input.configuration,
      continuationId: null,
      resolutionId: null,
      verificationPayloadDigest: null,
      taskSessionId: null,
      taskOriginalMessageId: null,
    },
    artifactPath: input.artifactPath ?? null,
    signal: new AbortController().signal,
  }
}

async function execute(provider: LifecycleProvider, operation: ProviderOperationRequest): Promise<AppliedProviderOperation> {
  const prepared = await provider.prepare(operation)
  const applied = await provider.apply(prepared)
  const verification = await provider.verify(applied)
  expect(verification).not.toBeNull()
  await provider.cleanup(prepared)
  return applied
}

describe('real provider lifecycle sequences', () => {
  it('runs the complete Skill lifecycle through the merged winner and retained-material purge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-skill-lifecycle-'))
    roots.push(root)
    const store = new CenterStateStore(root)
    await store.initialize()
    const registry = new SkillRegistry()
    const provider = new SkillLifecycleProvider(root, store, registry as any)
    provider.register()
    const original = join(root, 'skill-original.md')
    const updated = join(root, 'skill-updated.md')
    const originalBody = '---\nname: documentation-writer\ndescription: Original\n---\nOriginal body.\n'
    const updatedBody = '---\nname: documentation-writer\ndescription: Updated\n---\nUpdated body.\n'
    await writeFile(original, originalBody)
    await writeFile(updated, updatedBody)
    const originalIntegrity = `sha256:${createHash('sha256').update(await readFile(original)).digest('hex')}` as const
    const updatedIntegrity = `sha256:${createHash('sha256').update(await readFile(updated)).digest('hex')}` as const
    const config = { modelInvocable: true, userInvocable: true, projectRoot: null }
    const skillEvidence = (kind: ProviderOperationRequest['plan']['operationKind'], before: string | null, after: string | null) => {
      const base = testReviewEvidence('skill', kind)
      const bytesDigest = (body: string | null) => body === null
        ? null
        : `sha256:${createHash('sha256').update(body).digest('hex')}` as const
      return {
        ...base,
        body: { before, after, beforeDigest: bytesDigest(before), afterDigest: bytesDigest(after) },
        files: [{
          ...base.files[0]!,
          change: before === null ? 'add' as const : after === null ? 'remove' as const : 'replace' as const,
          beforeDigest: bytesDigest(before), afterDigest: bytesDigest(after),
          sizeBytes: Buffer.byteLength(after ?? before ?? '', 'utf8'),
        }],
      }
    }
    const operation = (
      id: string,
      kind: ProviderOperationRequest['plan']['operationKind'],
      desired: 'enabled' | 'disabled' | 'removed',
      configuration: RpcJson,
      artifactPath: string | null = null,
      integrity = originalIntegrity,
      before: string | null = null,
      after: string | null = null,
    ) => request({
      kind: 'skill', operationId: `operation:skill-${id}`, operationKind: kind, desiredState: desired,
      scopeKey: 'user', configuration, artifactPath, artifactIntegrity: integrity,
      reviewEvidence: skillEvidence(kind, before, after),
    })

    await execute(provider, operation('install', 'install', 'enabled', config, original, originalIntegrity, null, originalBody))
    expect((await registry.snapshot()).skills[0]).toMatchObject({
      provider: 'extension-center',
      resourceBase: { kind: 'directory' },
    })
    expect((await registry.snapshot()).skills[0]).not.toHaveProperty('path')
    await execute(provider, operation('configure', 'configure', 'enabled', { ...config, userInvocable: false }, null, originalIntegrity, originalBody))
    expect(await registry.get('documentation-writer')).toMatchObject({ invocation: { userInvocable: false } })

    await execute(provider, operation('disable', 'disable', 'disabled', { ...config, userInvocable: false }, null, originalIntegrity, originalBody))
    expect(await registry.list()).toEqual([])
    await execute(provider, operation('enable', 'enable', 'enabled', { ...config, userInvocable: false }, null, originalIntegrity, originalBody))
    expect(await registry.get('documentation-writer')).toBeDefined()

    await execute(provider, operation('update', 'update', 'enabled', config, updated, updatedIntegrity, originalBody, updatedBody))
    expect(await registry.get('documentation-writer')).toMatchObject({ description: 'Updated' })
    await execute(provider, operation('uninstall', 'uninstall', 'removed', config, null, originalIntegrity, updatedBody))
    expect(await registry.list()).toEqual([])
    const restored = await execute(provider, operation('restore', 'restore', 'enabled', config, null, originalIntegrity, updatedBody))
    expect(await registry.get('documentation-writer')).toMatchObject({ description: 'Updated' })
    await expect(provider.rollback(restored)).resolves.toBe(restored.prepared.beforeDigest)
    expect(await registry.list()).toEqual([])
    const retained = (await store.getManaged(restored.prepared.request.plan.targetKey))?.removed?.materialPath
    expect(retained).toBeDefined()
    await expect(readFile(retained!, 'utf8')).resolves.toContain('Updated body.')
    await execute(provider, operation('restore-again', 'restore', 'enabled', config, null, originalIntegrity, updatedBody))
    await execute(provider, operation('uninstall-again', 'uninstall', 'removed', config, null, originalIntegrity, updatedBody))
    await execute(provider, operation('purge', 'purge', 'removed', config))
    expect(await store.getManaged(operation('view', 'purge', 'removed', config).plan.targetKey)).toMatchObject({
      current: null, removed: null, lastGood: null,
    })
  })

  it('runs MCP as a preprovisioned connection without catalog runtime download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-mcp-lifecycle-'))
    roots.push(root)
    const store = new CenterStateStore(root)
    await store.initialize()
    const executable = join(root, 'filesystem-mcp')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
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
    const owner = new McpOwner()
    const provider = new McpLifecycleProvider(store, owner as any, [runtime])
    const config = {
      transport: 'stdio', connectionId: 'filesystem', runtimeRef: runtime.runtimeRef, roots: [await realpath(root)], toolCallTimeoutMs: 5_000,
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 3 },
    }
    const preflight = await provider.preflight(entry.candidateRef, config)
    const binding = { runtimeRef: runtime.runtimeRef, version: runtime.version, descriptorDigest: preflight!.descriptorDigest }
    const mcpEvidence = (kind: ProviderOperationRequest['plan']['operationKind']) => ({
      ...testReviewEvidence('mcp', kind),
      descriptor: preflight!.reviewDescriptor,
      runtime: { ownership: 'host' as const, version: runtime.version, digest: preflight!.runtimeDigest, action: 'none' as const },
    })
    const operation = (id: string, kind: ProviderOperationRequest['plan']['operationKind'], desired: 'enabled' | 'disabled' | 'removed') => request({
      kind: 'mcp', operationId: `operation:mcp-${id}`, operationKind: kind, desiredState: desired,
      scopeKey: 'profile:web', configuration: config, runtimeBinding: binding,
      ownerRevision: `mcp:${String(owner.get(config.connectionId)?.revision ?? owner.getRemoved(config.connectionId)?.revision ?? owner.revision)}`,
      reviewEvidence: mcpEvidence(kind),
    })

    await expect(provider.prepare(request({
      kind: 'mcp', operationId: 'operation:mcp-stale-owner', operationKind: 'install', desiredState: 'disabled',
      scopeKey: 'profile:web', configuration: config, runtimeBinding: binding, ownerRevision: 'mcp:999',
      reviewEvidence: mcpEvidence('install'),
    }))).rejects.toThrow('owner revision changed')
    expect(owner.snapshot()).toMatchObject({ revision: 0, connections: [], removed: [] })

    const rolledBackInstall = await execute(provider, operation('install-rollback', 'install', 'disabled'))
    await expect(provider.rollback(rolledBackInstall)).resolves.toBe(rolledBackInstall.prepared.beforeDigest)
    expect(owner.get('filesystem')).toBeUndefined()
    expect(owner.getRemoved('filesystem')).toBeUndefined()
    expect(await store.getManaged(rolledBackInstall.prepared.request.plan.targetKey)).toBeUndefined()

    await execute(provider, operation('install', 'install', 'disabled'))
    expect(owner.get('filesystem')).toMatchObject({
      desired: { enabled: false },
      observed: { state: 'disabled' },
      tools: { names: [] },
    })
    const configuredForRollback = await execute(provider, operation('configure-rollback', 'configure', 'disabled'))
    await expect(provider.rollback(configuredForRollback)).resolves.toBe(configuredForRollback.prepared.beforeDigest)
    expect(owner.get('filesystem')).toMatchObject({ desired: { enabled: false }, observed: { state: 'disabled' }, tools: { names: [] } })
    expect(owner.getRemoved('filesystem')).toBeUndefined()

    await execute(provider, operation('configure', 'configure', 'disabled'))
    expect(owner.get('filesystem')?.observed.state).toBe('disabled')

    const exact = structuredClone(owner.get('filesystem')!)
    owner.active.set('filesystem', {
      ...exact,
      desired: { ...exact.desired, transport: { ...exact.desired.transport, args: ['--tampered'] } },
    })
    const ownerRevisionBeforeDriftCheck = owner.revision
    await expect(provider.prepare(operation('descriptor-drift', 'enable', 'enabled')))
      .rejects.toThrow('owner descriptor changed')
    expect(owner.revision).toBe(ownerRevisionBeforeDriftCheck)
    owner.active.set('filesystem', exact)

    owner.freezeNextToolGeneration = true
    const staleToolsPrepared = await provider.prepare(operation('stale-tools', 'enable', 'enabled'))
    const staleToolsApplied = await provider.apply(staleToolsPrepared)
    await expect(provider.verify(staleToolsApplied)).rejects.toThrow('tool generation did not advance')
    await expect(provider.rollback(staleToolsApplied)).resolves.toBe(staleToolsPrepared.beforeDigest)
    expect(owner.get('filesystem')).toMatchObject({ desired: { enabled: false }, tools: { names: [] } })

    await execute(provider, operation('enable', 'enable', 'enabled'))
    expect(owner.get('filesystem')?.tools.names).toEqual(['filesystem/read'])
    await execute(provider, operation('disable', 'disable', 'disabled'))
    await execute(provider, operation('update', 'update', 'disabled'))
    await execute(provider, operation('uninstall', 'uninstall', 'removed'))
    expect(owner.getRemoved('filesystem')).toBeDefined()
    const restored = await execute(provider, operation('restore', 'restore', 'disabled'))
    expect(owner.get('filesystem')).toBeDefined()
    await expect(provider.rollback(restored)).resolves.toBe(restored.prepared.beforeDigest)
    expect(owner.get('filesystem')).toBeUndefined()
    expect(owner.getRemoved('filesystem')).toBeDefined()
    await execute(provider, operation('restore-again', 'restore', 'disabled'))
    await execute(provider, operation('uninstall-again', 'uninstall', 'removed'))
    const purged = await execute(provider, operation('purge', 'purge', 'removed'))
    expect(owner.getRemoved('filesystem')).toBeUndefined()
    await expect(provider.rollback(purged)).resolves.toBe(purged.prepared.beforeDigest)
    expect(owner.get('filesystem')).toBeUndefined()
    expect(owner.getRemoved('filesystem')).toBeDefined()
    await execute(provider, operation('purge-again', 'purge', 'removed'))
    expect(owner.getRemoved('filesystem')).toBeUndefined()
  })

  it('requires exact Loader absence for Plugin uninstall evidence', async () => {
    let entries: any[] = [{
      id: 'dsh-capability-resolver',
      options: { id: 'dsh-capability-resolver', name: 'dsh-capability-resolver' },
      disabled: true,
    }]
    const probe = new LoaderPluginRuntimeProbe({
      await: async () => {},
      entries: () => entries,
    } as any)

    await expect(probe.observe('dsh-capability-resolver', 'uninstall')).rejects.toThrow('remains')
    entries = []
    await expect(probe.observe('dsh-capability-resolver', 'uninstall')).resolves.toMatchObject({ fiberPhase: 'absent' })
  })

  it('runs Plugin install/configure/update/uninstall/restore only through Profile generations and boot evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-lifecycle-'))
    roots.push(root)
    const store = new CenterStateStore(root)
    await store.initialize()
    const owner = new ProfileOwner(root)
    await owner.initialize()
    const provider = new PluginLifecycleProvider(store, owner as any, {
      observe: async (_packageName: string, operationKind: string) => ({
        entryId: 'dsh-capability-resolver', moduleName: 'dsh-capability-resolver',
        fiberPhase: operationKind === 'uninstall' ? 'absent' : 'active',
      }),
    })
    const archive = await pluginArchive(root)
    const archiveInspection = await inspectNpmArchive(archive, null)
    const pluginEntry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'plugin')!
    const config = {
      freshCacheMs: 5_000, staleCacheMs: 30_000, fetchTimeoutMs: 10_000,
      maxCatalogBytes: 1_048_576, maxCatalogEntries: 2_000, maxTaskChars: 4_000,
      maxResults: 5, maxCurrentMatches: 10, maxDescriptionChars: 500, maxMatchedTerms: 10,
    }

    const operation = async (
      id: string,
      kind: ProviderOperationRequest['plan']['operationKind'],
      desired: 'enabled' | 'removed',
      configuration: RpcJson,
      artifactPath: string | null = null,
    ) => {
      const snapshot = await owner.snapshot()
      const profileRevision = `profile:${String(snapshot.revision)}:${snapshot.treeDigest}`
      let mutationDigest: `sha256:${string}` | undefined
      if (kind === 'configure') {
        const patch = buildCapabilityResolverPatch(await readFile(join(snapshot.effectivePath, 'cordis.patch.yml'), 'utf8'), configuration)
        mutationDigest = pluginConfigurationMutationDigest(patch, profileRevision)
      }
      const baseReview = testReviewEvidence('plugin', kind)
      const reviewEvidence = {
        ...baseReview,
        manifest: {
          ...baseReview.manifest,
          packageName: archiveInspection.name,
          afterVersion: archiveInspection.version,
          body: archiveInspection.manifestBody,
          manifestDigest: archiveInspection.manifestDigest,
          files: archiveInspection.files,
          fileManifestDigest: archiveInspection.fileManifestDigest,
        },
        dependencies: Object.entries(archiveInspection.peerDependencies).map(([id, afterVersion]) => ({
          id, kind: 'peer' as const, beforeVersion: null, afterVersion, required: true,
        })),
        bundles: archiveInspection.bundlePatch === null ? [] : [{
          id: pluginEntry.artifact.id,
          action: kind === 'install' ? 'add' as const : 'update' as const,
          patchDigest: archiveInspection.bundlePatch.digest,
          patchBody: archiveInspection.bundlePatch.body,
        }],
        scripts: { ...baseReview.scripts, after: archiveInspection.scripts },
      }
      return request({
        kind: 'plugin', operationId: `operation:plugin-${id}`, operationKind: kind, desiredState: desired,
        scopeKey: 'profile:web', configuration, artifactPath, profileRevision, mutationDigest, reviewEvidence,
      })
    }
    const boot = async (applied: AppliedProviderOperation) => {
      owner.markBootVerified(applied.profileGeneration!)
      await provider.acknowledgeBoot({
        operationId: applied.prepared.request.authorization.operationId,
        targetKey: applied.prepared.request.plan.targetKey,
        profileId: 'web',
        generation: applied.profileGeneration!,
      })
      await expect(provider.verify(applied)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
    }
    const mutate = async (value: ProviderOperationRequest) => {
      const prepared = await provider.prepare(value)
      const applied = await provider.apply(prepared)
      await expect(provider.verify(applied)).resolves.toBeNull()
      await boot(applied)
      return applied
    }

    await mutate(await operation('install', 'install', 'enabled', {}, archive))
    await mutate(await operation('configure', 'configure', 'enabled', config))
    expect(await readFile(join((await owner.snapshot()).effectivePath, 'cordis.patch.yml'), 'utf8'))
      .toContain('freshCacheMs: 5000')
    await mutate(await operation('update', 'update', 'enabled', config, archive))
    await mutate(await operation('uninstall', 'uninstall', 'removed', config))
    const restored = await mutate(await operation('restore', 'restore', 'enabled', config))
    expect((await store.getManaged(restored.prepared.request.plan.targetKey))?.current).not.toBeNull()
    await expect(provider.prepare(await operation('purge', 'purge', 'removed', config))).rejects.toThrow('purge is unavailable')
  })
})
