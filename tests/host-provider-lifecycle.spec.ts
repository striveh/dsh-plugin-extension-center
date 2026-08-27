import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { CenterStateStore } from '../src/host/index.ts'
import { operationRestartRequired } from '../src/policy/index.ts'
import {
  inspectNpmArchive,
  LoaderPluginRuntimeProbe,
  McpLifecycleProvider,
  PluginLifecycleProvider,
  pluginConfigurationMutationDigest,
  SkillLifecycleProvider,
  type AdmittedMcpRuntime,
  type AppliedProviderOperation,
  type LifecycleProvider,
  type ManagedPluginLoader,
  type ProviderOperationRequest,
} from '../src/providers/index.ts'
import type { RpcJson } from '../src/service/rpc-contract.ts'
import { testReviewEvidence } from './support/review-evidence.ts'
import { ProfilePluginCli } from './support/managed-plugin-cli.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class SkillRegistry {
  private provider: any
  private frozenSnapshot: any | undefined
  private readonly frozenDefinitions = new Map<string, any>()
  useFrozenView = false

  registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => any): () => void {
    this.provider = create({ signal: new AbortController().signal, invalidate() {} })
    return () => { this.provider = undefined }
  }

  async snapshot(options?: unknown) {
    if (this.useFrozenView && this.frozenSnapshot !== undefined) return structuredClone(this.frozenSnapshot)
    const candidates: any[] = this.provider === undefined ? [] : await this.provider.list(options)
    const snapshot = {
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
    this.frozenSnapshot = structuredClone(snapshot)
    return snapshot
  }

  async list(options?: unknown) { return (await this.snapshot(options)).skills }

  async get(name: string, options?: unknown) {
    if (this.useFrozenView && this.frozenDefinitions.has(name)) {
      return structuredClone(this.frozenDefinitions.get(name))
    }
    const candidates: any[] = this.provider === undefined ? [] : await this.provider.list(options)
    const candidate = candidates.find((item: any) => item.name === name)
    const definition = candidate === undefined ? undefined : await this.provider.get(candidate, options)
    if (definition !== undefined) this.frozenDefinitions.set(name, structuredClone(definition))
    return definition
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
  readonly residualToolNames = new Set<string>()

  snapshot() { return { revision: this.revision, connections: [...this.active.values()], removed: [...this.removed.values()] } }
  get(id: string) { return this.active.get(id) }
  getRemoved(id: string) { return this.removed.get(id) }
  registeredToolNames(id: string, exactNames: readonly string[] = []) {
    const prefix = `mcp__${id}__`
    return [...new Set([
      ...(this.active.get(id)?.tools.names ?? []),
      ...this.residualToolNames,
      ...exactNames.filter(name => this.residualToolNames.has(name)),
    ])].filter(name => name.startsWith(prefix)).sort()
  }

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
        names: enabled ? [`mcp__${id}__read`] : [],
      },
    }
  }

  private receipt(operation: string, row: McpRow) {
    this.revision += 1
    return { operation, id: row.id, revision: row.revision, snapshotRevision: this.revision }
  }
}

interface LoaderRow {
  readonly id: string
  readonly options: Readonly<{ id?: string; name: string; config?: unknown; group?: boolean }>
  readonly disabled: boolean
  readonly refresh: () => Promise<void>
  readonly fiber?: Readonly<{ state: number; await: () => Promise<void> }>
}

class MemoryLoader implements ManagedPluginLoader {
  readonly rows = new Map<string, LoaderRow>()

  async create(options: Readonly<{ name: string; config?: unknown }>): Promise<string> {
    const id = `row-${String(this.rows.size + 1)}`
    this.rows.set(id, {
      id, options, disabled: false, refresh: async () => {}, fiber: { state: 2, await: async () => {} },
    })
    return id
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id)
  }

  async update(id: string, options: Readonly<{ config?: unknown }>): Promise<void> {
    const row = this.rows.get(id)
    if (row === undefined) throw new Error(`missing loader row: ${id}`)
    this.rows.set(id, { ...row, options: { ...row.options, ...options } })
  }

  seed(name: string): void {
    const id = `seed-${String(this.rows.size + 1)}`
    this.rows.set(id, {
      id, options: { name }, disabled: false, refresh: async () => {}, fiber: { state: 2, await: async () => {} },
    })
  }

  entries(): Iterable<LoaderRow> {
    return this.rows.values()
  }

  await(): Promise<void> {
    return Promise.resolve()
  }
}

async function profileWithCordis(hostHome: string): Promise<string> {
  const profile = join(hostHome, 'profiles', 'web')
  const cordis = join(profile, 'node_modules', '@deepseek-ai', 'cordis')
  await mkdir(cordis, { recursive: true })
  await writeFile(join(cordis, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/cordis', version: '4.0.1', type: 'module', main: './index.js',
  }))
  await writeFile(join(cordis, 'index.js'), 'export const fixture = true\n')
  return profile
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
  await mkdir(root, { recursive: true })
  const patch = Buffer.from('plugins:\n  dsh-capability-resolver: {}\n')
  const manifest = Buffer.from(JSON.stringify({
    name: 'dsh-capability-resolver',
    version: '0.1.0',
    type: 'module',
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: [] } },
    peerDependencies: { '@deepseek-ai/cordis': '4.0.1' },
    scripts: { build: 'tsc', test: 'vitest run' },
    devDependencies: { typescript: '^6.0.0' },
  }))
  const archive = Buffer.concat([
    tarEntry('package/package.json', manifest),
    tarEntry('package/index.js', Buffer.from("import '@deepseek-ai/cordis'\nexport default function apply() {}\n")),
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
  candidateRef?: string
}>): ProviderOperationRequest {
  const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === input.kind
    && (input.candidateRef === undefined || candidate.candidateRef === input.candidateRef))!
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
      ownerKey: input.kind === 'plugin' ? 'managedPlugins' : input.kind === 'mcp' ? 'mcpConnections' : 'skills',
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
      ownerKey: input.kind === 'plugin' ? 'managedPlugins' : input.kind === 'mcp' ? 'mcpConnections' : 'skills',
      scopeKey: input.scopeKey,
      profileId,
      idempotencyKey: `idem:${input.operationId}`,
      authorityDigest: canonicalSha256({ authority: input.operationId }),
      configurationDigest: canonicalSha256(input.configuration),
      retentionDigest: canonicalSha256({ candidateRef: entry.candidateRef, retainedData: entry.retainedData }),
      reviewEvidence: input.reviewEvidence ?? testReviewEvidence(input.kind, input.operationKind),
      mutationDigest: input.mutationDigest ?? canonicalSha256({ mutation: input.operationId }),
      verificationDigest: canonicalSha256({ verification: input.operationId }),
      restartRequired: operationRestartRequired(entry, input.operationKind),
      createdAtMs: 1,
      expiresAtMs: 1_000_000,
      fences: {
        catalogRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
        inventoryRevision: canonicalSha256({ inventory: input.operationId }),
        targetRevision: 'fixture',
        ownerRevision: input.ownerRevision ?? (input.kind === 'plugin'
          ? (input.profileRevision ?? 'managed-plugin:0:tree:0')
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
    const uninstallPrepared = await provider.prepare(operation(
      'uninstall', 'uninstall', 'removed', config, null, originalIntegrity, updatedBody,
    ))
    registry.useFrozenView = true
    const uninstallApplied = await provider.apply(uninstallPrepared)
    await expect(provider.verify(uninstallApplied)).rejects.toThrow('still contributes')
    registry.useFrozenView = false
    await expect(provider.verify(uninstallApplied)).resolves.not.toBeNull()
    await provider.cleanup(uninstallPrepared)
    expect(await registry.list()).toEqual([])
    const restored = await execute(provider, operation('restore', 'restore', 'enabled', config, null, updatedIntegrity, updatedBody))
    expect(await registry.get('documentation-writer')).toMatchObject({ description: 'Updated' })
    await expect(provider.rollback(restored)).resolves.toBe(restored.prepared.beforeDigest)
    expect(await registry.list()).toEqual([])
    const retained = (await store.getManaged(restored.prepared.request.plan.targetKey))?.removed?.materialPath
    expect(retained).toBeDefined()
    await expect(readFile(retained!, 'utf8')).resolves.toContain('Updated body.')
    await execute(provider, operation('restore-again', 'restore', 'enabled', config, null, updatedIntegrity, updatedBody))
    await execute(provider, operation('uninstall-again', 'uninstall', 'removed', config, null, originalIntegrity, updatedBody))
    const purgePrepared = await provider.prepare(operation('purge', 'purge', 'removed', config))
    registry.useFrozenView = true
    const purgeApplied = await provider.apply(purgePrepared)
    await expect(provider.verify(purgeApplied)).rejects.toThrow('still contributes')
    registry.useFrozenView = false
    await expect(provider.verify(purgeApplied)).resolves.not.toBeNull()
    await provider.cleanup(purgePrepared)
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
    const nextEntry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'mcp'
      && candidate.candidateRef !== entry.candidateRef)!
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
    const nextRuntime: AdmittedMcpRuntime = {
      ...runtime,
      runtimeRef: 'fixture-runtime-next',
      candidateRef: nextEntry.candidateRef,
      version: nextEntry.artifact.version,
      fixedArgs: ['--stdio', '--next'],
    }
    const owner = new McpOwner()
    const provider = new McpLifecycleProvider(store, owner as any, [runtime, nextRuntime])
    const config = {
      transport: 'stdio', connectionId: 'filesystem', runtimeRef: runtime.runtimeRef, roots: [await realpath(root)], toolCallTimeoutMs: 5_000,
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 3 },
    }
    const preflight = await provider.preflight(entry.candidateRef, config)
    const nextConfig = { ...config, runtimeRef: nextRuntime.runtimeRef }
    const nextPreflight = await provider.preflight(nextEntry.candidateRef, nextConfig)
    const binding = { runtimeRef: runtime.runtimeRef, version: runtime.version, descriptorDigest: preflight!.descriptorDigest }
    const mcpEvidence = (kind: ProviderOperationRequest['plan']['operationKind']) => ({
      ...testReviewEvidence('mcp', kind),
      descriptor: preflight!.reviewDescriptor,
      runtime: { ownership: 'host' as const, version: runtime.version, digest: preflight!.runtimeDigest, action: 'none' as const },
    })
    const operation = (
      id: string,
      kind: ProviderOperationRequest['plan']['operationKind'],
      desired: 'enabled' | 'disabled' | 'removed',
      selected: 'current' | 'next' = 'current',
    ) => {
      const selectedEntry = selected === 'current' ? entry : nextEntry
      const selectedRuntime = selected === 'current' ? runtime : nextRuntime
      const selectedConfiguration = selected === 'current' ? config : nextConfig
      const selectedPreflight = selected === 'current' ? preflight! : nextPreflight!
      return request({
        kind: 'mcp', operationId: `operation:mcp-${id}`, operationKind: kind, desiredState: desired,
        scopeKey: 'profile:web', configuration: selectedConfiguration, candidateRef: selectedEntry.candidateRef,
        runtimeBinding: {
          runtimeRef: selectedRuntime.runtimeRef,
          version: selectedRuntime.version,
          descriptorDigest: selectedPreflight.descriptorDigest,
        },
        ownerRevision: `mcp:${String(owner.get(config.connectionId)?.revision ?? owner.getRemoved(config.connectionId)?.revision ?? owner.revision)}`,
        reviewEvidence: {
          ...testReviewEvidence('mcp', kind),
          descriptor: selectedPreflight.reviewDescriptor,
          runtime: {
            ownership: 'host' as const,
            version: selectedRuntime.version,
            digest: selectedPreflight.runtimeDigest,
            action: 'none' as const,
          },
        },
      })
    }

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
    expect(owner.get('filesystem')?.tools.names).toEqual(['mcp__filesystem__read'])
    await execute(provider, operation('update-next', 'update', 'enabled', 'next'))
    expect(await store.getManaged(operation('view-next', 'update', 'enabled', 'next').plan.targetKey)).toMatchObject({
      current: { candidateRef: nextEntry.candidateRef, configuration: nextConfig },
      lastGood: { candidateRef: entry.candidateRef, configuration: config },
    })
    expect(owner.get('filesystem')?.desired.transport).toMatchObject({ args: ['--stdio', '--next', await realpath(root)] })
    await execute(provider, operation('restore-active', 'restore', 'enabled'))
    expect(await store.getManaged(operation('view-restored', 'restore', 'enabled').plan.targetKey)).toMatchObject({
      current: { candidateRef: entry.candidateRef, configuration: config },
      lastGood: { candidateRef: nextEntry.candidateRef, configuration: nextConfig },
    })
    expect(owner.get('filesystem')?.desired.transport).toMatchObject({ args: ['--stdio', await realpath(root)] })
    await execute(provider, operation('disable-before-enabled-restore', 'disable', 'disabled'))
    await execute(provider, operation('restore-enabled-state', 'restore', 'enabled'))
    expect(owner.get('filesystem')).toMatchObject({ desired: { enabled: true }, observed: { state: 'ready' } })
    await execute(provider, operation('disable', 'disable', 'disabled'))
    await execute(provider, operation('enable-after-disable', 'enable', 'enabled'))
    await execute(provider, operation('update', 'update', 'enabled'))
    const priorToolName = owner.get('filesystem')!.tools.names[0]!
    const uninstallPrepared = await provider.prepare(operation('uninstall', 'uninstall', 'removed'))
    expect((uninstallPrepared.prepared as { ownerToolNames: readonly string[] }).ownerToolNames).toEqual([priorToolName])
    const uninstallApplied = await provider.apply(uninstallPrepared)
    owner.residualToolNames.add(priorToolName)
    await expect(provider.verify(uninstallApplied)).rejects.toThrow('still exposes Tool registry entries')
    owner.residualToolNames.clear()
    await expect(provider.verify(uninstallApplied)).resolves.not.toBeNull()
    await provider.cleanup(uninstallPrepared)
    expect(owner.getRemoved('filesystem')).toBeDefined()
    const restored = await execute(provider, operation('restore', 'restore', 'disabled'))
    expect(owner.get('filesystem')).toBeDefined()
    await expect(provider.rollback(restored)).resolves.toBe(restored.prepared.beforeDigest)
    expect(owner.get('filesystem')).toBeUndefined()
    expect(owner.getRemoved('filesystem')).toBeDefined()
    await execute(provider, operation('restore-again', 'restore', 'disabled'))
    await execute(provider, operation('uninstall-again', 'uninstall', 'removed'))
    owner.residualToolNames.add(priorToolName)
    const purgePrepared = await provider.prepare(operation('purge', 'purge', 'removed'))
    expect((purgePrepared.prepared as { ownerToolNames: readonly string[] }).ownerToolNames).toEqual([priorToolName])
    const purged = await provider.apply(purgePrepared)
    await expect(provider.verify(purged)).rejects.toThrow('still exposes Tool registry entries')
    owner.residualToolNames.clear()
    await expect(provider.verify(purged)).resolves.not.toBeNull()
    await provider.cleanup(purgePrepared)
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

  it('runs Plugin lifecycle through Center state, the official Profile CLI, and restart rehydration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-lifecycle-'))
    roots.push(root)
    const centerRoot = join(root, 'center')
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    await writeFile(join(profile, 'package.json'), '{"name":"official-profile","dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const archive = await pluginArchive(join(centerRoot, 'artifacts', 'sha256'))
    const archiveIntegrity = `sha256:${createHash('sha256').update(await readFile(archive)).digest('hex')}` as const
    const archiveInspection = await inspectNpmArchive(archive, null)
    const pluginEntry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'plugin')!
    let store = new CenterStateStore(centerRoot)
    let loader = new MemoryLoader()
    const cli = new ProfilePluginCli(hostHome)
    let provider = new PluginLifecycleProvider(store, loader, { hostHome, pluginCli: cli })
    await store.initialize()
    await provider.initialize()
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
      const snapshot = await provider.snapshot('web')
      const profileRevision = snapshot.ownerRevision
      const mutationDigest = kind === 'configure'
        ? pluginConfigurationMutationDigest(configuration, profileRevision)
        : undefined
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
        managedMaterial: {
          ...baseReview.managedMaterial,
          packageName: archiveInspection.name,
          afterVersion: archiveInspection.version,
          targetIntegrity: archiveIntegrity,
        },
        packageMetadata: {
          bundlePatch: archiveInspection.bundlePatch === null ? null : {
            path: 'cordis.patch.yml' as const,
            patchDigest: archiveInspection.bundlePatch.digest,
            patchBody: archiveInspection.bundlePatch.body,
          },
        },
        activation: {
          ...baseReview.activation,
          profileDependency: kind === 'install' ? 'add' as const
            : kind === 'update' ? 'replace' as const
              : kind === 'uninstall' ? 'remove' as const
                : kind === 'restore' ? 'restore' as const : 'retain' as const,
          loaderEntry: kind === 'install' ? 'create' as const
            : kind === 'update' ? 'replace' as const
              : kind === 'uninstall' ? 'remove' as const
                : kind === 'restore' ? 'restore' as const
                  : kind === 'configure' ? 'replace' as const : 'retain' as const,
          packageName: archiveInspection.name,
        },
        scripts: { ...baseReview.scripts, after: archiveInspection.scripts },
      }
      return request({
        kind: 'plugin', operationId: `operation:plugin-${id}`, operationKind: kind, desiredState: desired,
        scopeKey: 'profile:web', configuration, artifactPath, artifactIntegrity: archiveIntegrity,
        profileRevision, mutationDigest, reviewEvidence,
      })
    }
    const mutate = async (value: ProviderOperationRequest) => {
      const prepared = await provider.prepare(value)
      await store.putProviderSnapshot({
        schemaVersion: 1,
        operationId: value.authorization.operationId,
        targetKey: value.plan.targetKey,
        before: prepared.before,
        beforeDigest: prepared.beforeDigest,
        recoveryPoint: provider.recoveryPoint(prepared),
      })
      const applied = await provider.apply(prepared)
      const restartRequired = value.plan.operationKind !== 'configure'
      expect(applied.restartRequired).toBe(restartRequired)
      if (!restartRequired) {
        await expect(provider.verify(applied)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
        return applied
      }
      await expect(provider.verify(applied)).resolves.toBeNull()
      store = new CenterStateStore(centerRoot)
      await store.initialize()
      loader = new MemoryLoader()
      const review = value.plan.reviewEvidence
      if (review.kind !== 'plugin') throw new Error('Plugin fixture has no Plugin review evidence')
      if (value.plan.desiredState === 'enabled') loader.seed(review.manifest.packageName)
      provider = new PluginLifecycleProvider(store, loader, { hostHome, pluginCli: cli })
      await provider.initialize()
      const recovered = await provider.recover(value)
      expect(recovered).toMatchObject({
        restartRequired: true,
        rollbackRestartRequired: false,
        restartToken: applied.restartToken,
      })
      await expect(provider.acknowledgeBoot({
        operationId: value.authorization.operationId,
        targetKey: value.plan.targetKey,
        profileId: 'web',
        restartToken: applied.restartToken!,
      })).resolves.toBeUndefined()
      await expect(provider.verify(recovered!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
      return recovered!
    }

    await mutate(await operation('install', 'install', 'enabled', {}, archive))
    const installed = join(profile, 'node_modules', 'dsh-capability-resolver')
    expect((await lstat(installed)).isSymbolicLink()).toBe(false)
    expect([...loader.rows.values()].map(row => row.options.name)).toEqual(['dsh-capability-resolver'])
    await mutate(await operation('configure', 'configure', 'enabled', config))
    expect((await store.getManaged(`plugin:web:profile:web:${pluginEntry.name}`))?.current?.configuration).toEqual(config)
    const cliCallsBeforeConfigureRollback = cli.calls.length
    const rejectedConfiguration = { ...config, maxResults: 4 }
    const rejectedConfigure = await operation('configure-rollback', 'configure', 'enabled', rejectedConfiguration)
    const rejectedPrepared = await provider.prepare(rejectedConfigure)
    await store.putProviderSnapshot({
      schemaVersion: 1,
      operationId: rejectedConfigure.authorization.operationId,
      targetKey: rejectedConfigure.plan.targetKey,
      before: rejectedPrepared.before,
      beforeDigest: rejectedPrepared.beforeDigest,
      recoveryPoint: provider.recoveryPoint(rejectedPrepared),
    })
    const rejectedApplied = await provider.apply(rejectedPrepared)
    await expect(provider.rollback(rejectedApplied)).resolves.toBe(rejectedPrepared.beforeDigest)
    const liveRollback = await provider.recover(rejectedConfigure)
    expect(liveRollback).toMatchObject({
      restartRequired: false,
      rollbackRestartRequired: false,
      restartToken: null,
    })
    await expect(provider.verify(liveRollback!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
    await provider.finalizeRollback(liveRollback!)
    const configureRollbackFinalization = {
      operationId: rejectedConfigure.authorization.operationId,
      targetKey: rejectedConfigure.plan.targetKey,
      beforeDigest: rejectedPrepared.beforeDigest,
    }
    await expect(provider.finalizeDurableRollback(configureRollbackFinalization)).resolves.toBe(true)
    expect((await store.getManaged(`plugin:web:profile:web:${pluginEntry.name}`))?.current?.configuration).toEqual(config)
    expect(cli.calls).toHaveLength(cliCallsBeforeConfigureRollback)
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toMatchObject({
      name: 'official-profile', dependencies: { 'dsh-capability-resolver': `file:${archive}` },
    })
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    await mutate(await operation('update', 'update', 'enabled', config, archive))
    await mutate(await operation('uninstall', 'uninstall', 'removed', config))
    await expect(lstat(installed)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(loader.rows.size).toBe(0)
    const restored = await mutate(await operation('restore', 'restore', 'enabled', config))
    expect((await store.getManaged(restored.prepared.request.plan.targetKey))?.current).not.toBeNull()
    expect((await lstat(installed)).isSymbolicLink()).toBe(false)
    expect([...loader.rows.values()].map(row => row.options.name)).toEqual(['dsh-capability-resolver'])
    expect(cli.calls.map(call => call.kind)).toEqual(['add', 'remove', 'add'])
    await expect(provider.finalizeDurableRollback(configureRollbackFinalization)).resolves.toBe(false)
    await expect(provider.prepare(await operation('purge', 'purge', 'removed', config))).rejects.toThrow('purge is unavailable')

    const driftedConfigure = await operation(
      'configure-rollback-core-drift',
      'configure',
      'enabled',
      { ...config, maxResults: 4 },
    )
    const driftedPrepared = await provider.prepare(driftedConfigure)
    await store.putProviderSnapshot({
      schemaVersion: 1,
      operationId: driftedConfigure.authorization.operationId,
      targetKey: driftedConfigure.plan.targetKey,
      before: driftedPrepared.before,
      beforeDigest: driftedPrepared.beforeDigest,
      recoveryPoint: provider.recoveryPoint(driftedPrepared),
    })
    const driftedApplied = await provider.apply(driftedPrepared)
    await expect(provider.rollback(driftedApplied)).resolves.toBe(driftedPrepared.beforeDigest)
    const driftedRecovery = await provider.recover(driftedConfigure)
    expect(driftedRecovery).not.toBeNull()
    const rolledBack = await store.getManaged(driftedConfigure.plan.targetKey)
    if (rolledBack?.current === null || rolledBack === undefined) throw new Error('Plugin rollback fixture is absent')
    await store.putManaged({
      ...rolledBack,
      revision: rolledBack.revision + 1,
      current: {
        ...rolledBack.current,
        configuration: { ...config, maxResults: 99 },
      },
      updatedAtMs: Date.now(),
    }, rolledBack.revision)
    await expect(provider.verifyRollbackFinalization(driftedRecovery!))
      .rejects.toThrow('has no exact restored state')
    await expect(provider.finalizeDurableRollback({
      operationId: driftedConfigure.authorization.operationId,
      targetKey: driftedConfigure.plan.targetKey,
      beforeDigest: driftedPrepared.beforeDigest,
    })).resolves.toBe(false)
  })
})
