import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { CatalogEntry } from '../src/catalog-contract.ts'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { canonicalJson, canonicalSha256 } from '../src/domain/index.ts'
import { CenterStateStore, storageKey } from '../src/host/index.ts'
import {
  McpLifecycleProvider,
  inspectNpmArchive,
  PluginLifecycleProvider,
  SkillLifecycleProvider,
  type AdmittedMcpRuntime,
  type ManagedPluginLoader,
  type ProviderOperationRequest,
} from '../src/providers/index.ts'
import { testReviewEvidence } from './support/review-evidence.ts'
import { ProfilePluginCli } from './support/managed-plugin-cli.ts'
import { managedStateDigest } from '../src/providers/records.ts'

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
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)])
}

async function pluginArchive(root: string): Promise<Readonly<{ path: string; integrity: `sha256:${string}` }>> {
  await mkdir(root, { recursive: true })
  const patch = Buffer.from('- insert:\n    - id: dsh-capability-resolver\n      name: dsh-capability-resolver\n')
  const manifest = Buffer.from(JSON.stringify({
    name: 'dsh-capability-resolver', version: '0.1.0', type: 'module', main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: [] } },
    peerDependencies: { '@deepseek-ai/cordis': '4.0.1' },
  }))
  const bytes = gzipSync(Buffer.concat([
    tarEntry('package/package.json', manifest),
    tarEntry('package/index.js', Buffer.from("import '@deepseek-ai/cordis'\nexport default function apply() {}\n")),
    tarEntry('package/cordis.patch.yml', patch),
    Buffer.alloc(1024),
  ]))
  const path = join(root, 'dsh-capability-resolver-0.1.0.tgz')
  await writeFile(path, bytes)
  return { path, integrity: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
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

async function pluginRequest(
  provider: PluginLifecycleProvider,
  input: Readonly<{
    operationId: string
    operationKind: 'install' | 'uninstall'
    entry: CatalogEntry
    artifactPath?: string | null
  }>,
): Promise<ProviderOperationRequest> {
  const inspection = input.artifactPath === null || input.artifactPath === undefined
    ? null
    : await inspectNpmArchive(input.artifactPath, null)
  const owner = await provider.snapshot('web')
  const targetKey = `plugin:web:profile:web:${input.entry.name}`
  const managed = await provider.observe(targetKey)
  const operationKind = input.operationKind
  const review = testReviewEvidence('plugin', operationKind)
  const reviewEvidence = {
    ...review,
    rollbackPoint: managed?.current === null || managed === null
      ? { kind: 'absent-state' as const, id: 'absent', digest: canonicalSha256(null) }
      : { kind: 'managed-version' as const, id: managed.current!.candidateRef, digest: canonicalSha256(managed.current) },
    rollbackLimits: ['dsh-managed-state-only' as const],
    manifest: {
      ...review.manifest,
      packageName: input.entry.artifact.id,
      beforeVersion: managed?.current?.artifactRevision ?? null,
      afterVersion: operationKind === 'uninstall' ? null : input.entry.artifact.version,
      body: inspection?.manifestBody ?? '',
      manifestDigest: inspection?.manifestDigest ?? canonicalSha256({}),
      files: inspection?.files ?? [],
      fileManifestDigest: inspection?.fileManifestDigest ?? canonicalSha256([]),
    },
    dependencies: Object.entries(inspection?.peerDependencies ?? {}).map(([id, afterVersion]) => ({
      id, kind: 'peer' as const, beforeVersion: null, afterVersion, required: true,
    })),
    managedMaterial: {
      ...review.managedMaterial,
      packageName: input.entry.artifact.id,
      beforeVersion: managed?.current?.artifactRevision ?? null,
      afterVersion: operationKind === 'uninstall' ? null : input.entry.artifact.version,
      targetIntegrity: operationKind === 'uninstall' ? null : input.entry.artifact.integrity,
    },
    packageMetadata: {
      bundlePatch: inspection?.bundlePatch === null || inspection === null ? null : {
        path: 'cordis.patch.yml' as const,
        patchDigest: inspection.bundlePatch.digest,
        patchBody: inspection.bundlePatch.body,
      },
    },
    activation: {
      ...review.activation,
      profileDependency: operationKind === 'uninstall' ? 'remove' as const
        : operationKind === 'restore' ? 'restore' as const
          : operationKind === 'update' ? 'replace' as const
            : managed?.current === null || managed === null ? 'add' as const : 'retain' as const,
      loaderEntry: operationKind === 'uninstall' ? 'remove' as const
        : operationKind === 'restore' ? 'restore' as const
          : operationKind === 'update' ? 'replace' as const
            : managed?.current === null || managed === null ? 'create' as const : 'retain' as const,
      packageName: input.entry.artifact.id,
    },
    scripts: { ...review.scripts, after: inspection?.scripts ?? [] },
    settings: {
      ...review.settings,
      ownerRevision: owner.ownerRevision,
      diffDigest: canonicalSha256({}),
    },
  }
  const externalRuntimeAction = operationKind === 'install' ? 'download' as const : 'none' as const
  return {
    authorization: {
      operationId: input.operationId,
      planId: `plan:${input.operationId}`,
      planHash: canonicalSha256({ operationId: input.operationId }),
      operationKind,
      managedObject: 'artifact',
      externalRuntimeAction,
      runtimeBinding: null,
      targetKey,
      ownerKey: 'managedPlugins',
      scopeKey: 'profile:web',
      profileId: 'web',
      authorizedAtMs: 1,
    },
    plan: {
      schemaVersion: 1,
      singleUse: true,
      planId: `plan:${input.operationId}`,
      intentId: `intent:${input.operationId}`,
      origin: 'store',
      candidateRef: input.entry.candidateRef,
      extensionKind: 'plugin',
      extensionId: input.entry.name,
      managedObject: 'artifact',
      externalRuntimeAction,
      runtimeBinding: null,
      artifactRevision: input.entry.artifact.version,
      artifactIntegrity: input.entry.artifact.integrity,
      artifactUrl: input.entry.artifact.acquisitionUrl,
      artifactSizeBytes: input.entry.artifact.sizeBytes,
      operationKind,
      desiredState: operationKind === 'uninstall' ? 'removed' : 'enabled',
      targetKey,
      ownerKey: 'managedPlugins',
      scopeKey: 'profile:web',
      profileId: 'web',
      idempotencyKey: input.operationId,
      authorityDigest: canonicalSha256({ authority: input.operationId }),
      configurationDigest: canonicalSha256({}),
      retentionDigest: canonicalSha256({ candidateRef: input.entry.candidateRef, retainedData: input.entry.retainedData }),
      reviewEvidence,
      mutationDigest: canonicalSha256({ operationKind, ownerRevision: owner.ownerRevision }),
      verificationDigest: canonicalSha256({ verification: input.operationId }),
      restartRequired: input.entry.restart.required,
      createdAtMs: 1,
      expiresAtMs: 10_000,
      fences: {
        catalogRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
        inventoryRevision: canonicalSha256({ inventory: input.operationId }),
        targetRevision: managed === null ? 'absent' : `center:${String(managed.revision)}`,
        ownerRevision: owner.ownerRevision,
        scopeRevision: canonicalSha256({ scope: 'profile:web' }),
        profileRevision: owner.ownerRevision,
      },
    },
    payload: {
      configuration: {},
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

  it('reconciles Center-owned Plugin sidecar state after the Loader mutation completed before the Center write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-recovery-'))
    roots.push(root)
    const centerRoot = join(root, 'center')
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    await writeFile(join(profile, 'package.json'), '{"name":"official-profile","dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const archive = await pluginArchive(join(centerRoot, 'artifacts', 'sha256'))
    const baseEntry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'plugin')!
    const entry: CatalogEntry = {
      ...baseEntry,
      artifact: {
        ...baseEntry.artifact,
        integrity: archive.integrity,
        sizeBytes: (await readFile(archive.path)).length,
      },
    }
    const store = new FailOnceManagedStore(centerRoot)
    await store.initialize()
    const cli = new ProfilePluginCli(hostHome)
    let loader = new MemoryLoader()
    let provider = new PluginLifecycleProvider(store, loader, { hostHome, pluginCli: cli })
    await provider.initialize()

    const install = await pluginRequest(provider, {
      operationId: 'operation:plugin-install', operationKind: 'install', entry, artifactPath: archive.path,
    })
    const installPrepared = await provider.prepare(install)
    await store.putProviderSnapshot({
      schemaVersion: 1,
      operationId: install.authorization.operationId,
      targetKey: install.plan.targetKey,
      before: installPrepared.before,
      beforeDigest: installPrepared.beforeDigest,
      recoveryPoint: provider.recoveryPoint(installPrepared),
    })
    const installed = await provider.apply(installPrepared)
    expect(installed.restartRequired).toBe(true)
    await expect(provider.verify(installed)).resolves.toBeNull()

    loader = new MemoryLoader()
    loader.seed(entry.artifact.id)
    provider = new PluginLifecycleProvider(store, loader, { hostHome, pluginCli: cli })
    await provider.initialize()
    const recoveredInstall = await provider.recover(install)
    expect(recoveredInstall).not.toBeNull()
    await expect(provider.verify(recoveredInstall!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
    expect([...loader.rows.values()].map(row => row.options.name)).toEqual([entry.artifact.id])
    const targetKey = install.plan.targetKey
    const installedPath = join(profile, 'node_modules', 'dsh-capability-resolver')
    expect((await lstat(installedPath)).isSymbolicLink()).toBe(false)

    const operation = await pluginRequest(provider, {
      operationId: 'operation:plugin-kill', operationKind: 'uninstall', entry,
    })
    const prepared = await provider.prepare(operation)
    await store.putProviderSnapshot({
      schemaVersion: 1,
      operationId: operation.authorization.operationId,
      targetKey,
      before: prepared.before,
      beforeDigest: prepared.beforeDigest,
      recoveryPoint: provider.recoveryPoint(prepared),
    })
    store.failManagedWrite = true
    await expect(provider.apply(prepared)).rejects.toThrow('simulated kill')
    expect((await store.getManaged(targetKey))?.current).not.toBeNull()
    await expect(lstat(installedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect([...loader.rows.values()].map(row => row.options.name)).toEqual([entry.artifact.id])

    loader = new MemoryLoader()
    provider = new PluginLifecycleProvider(store, loader, { hostHome, pluginCli: cli })
    await provider.initialize()
    store.snapshotTransform = value => {
      const point = value.recoveryPoint as Record<string, any>
      return {
        ...value,
        recoveryPoint: { ...point, snapshot: { ...(point.snapshot as Record<string, any>), profileId: 'replacement' } },
      }
    }
    await expect(provider.recover(operation)).rejects.toThrow('does not bind the plan')
    store.snapshotTransform = null
    const recovered = await provider.recover(operation)
    expect(recovered).toMatchObject({
      restartToken: 'managed:operation:plugin-kill',
      restartRequired: true,
      rollbackRestartRequired: false,
    })
    expect((await store.getManaged(targetKey))?.current).toBeNull()
    expect((await store.getManaged(targetKey))?.pending).toBeNull()
    expect(loader.rows.size).toBe(0)
    await expect(provider.verify(recovered!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
    const retained = (await store.getManaged(targetKey))?.removed?.materialPath
    expect(retained).toContain(join(centerRoot, 'material', 'plugins'))
    const recoveryHead = canonicalSha256({ recoveryRequired: operation.authorization.operationId })
    await expect(provider.reconcileBreakGlassRestore(operation, canonicalSha256({ tampered: true }), recoveryHead))
      .rejects.toThrow('does not bind the journal')
    await expect(provider.reconcileBreakGlassRestore(operation, prepared.beforeDigest, recoveryHead)).resolves.toBeNull()

    await expect(provider.acknowledgeBoot({
      operationId: 'operation:replacement',
      targetKey,
      profileId: 'web',
      restartToken: 'managed:operation:plugin-kill',
    })).rejects.toThrow('does not bind')
    await expect(provider.acknowledgeBoot({
      operationId: operation.authorization.operationId,
      targetKey,
      profileId: 'replacement',
      restartToken: 'managed:operation:plugin-kill',
    })).rejects.toThrow('does not bind')
    await expect(provider.acknowledgeBoot({
      operationId: operation.authorization.operationId,
      targetKey,
      profileId: 'web',
      restartToken: 'managed:operation:plugin-kill',
    })).resolves.toBeUndefined()
    expect((await store.getManaged(targetKey))?.pending).toBeNull()
    expect((await store.getManaged(targetKey))?.current).toBeNull()
    await expect(lstat(installedPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(provider.rollback(recovered!)).resolves.toBe(prepared.beforeDigest)
    const rollbackPending = await provider.recover(operation)
    expect(rollbackPending).toMatchObject({
      restartRequired: false,
      rollbackRestartRequired: true,
      restartToken: 'managed-rollback:operation:plugin-kill',
    })
    expect((await store.getManaged(targetKey))?.pending).toMatchObject({
      operationId: 'operation:plugin-kill',
      operationKind: 'rollback',
    })
    await expect(provider.verify(rollbackPending!)).resolves.toBeNull()
    expect((await lstat(installedPath)).isSymbolicLink()).toBe(false)

    loader = new MemoryLoader()
    loader.seed(entry.artifact.id)
    provider = new PluginLifecycleProvider(store, loader, { hostHome, pluginCli: cli })
    await provider.initialize()
    const rollback = await provider.recover(operation)
    expect(rollback).toMatchObject({
      restartRequired: false,
      rollbackRestartRequired: true,
      restartToken: 'managed-rollback:operation:plugin-kill',
    })
    await expect(provider.verify(rollback!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
    expect([...loader.rows.values()].map(row => row.options.name)).toEqual([entry.artifact.id])
    await expect(provider.acknowledgeBoot({
      operationId: operation.authorization.operationId,
      targetKey,
      profileId: 'web',
      restartToken: 'managed-rollback:operation:plugin-kill',
    })).resolves.toBeUndefined()
    expect((await store.getManaged(targetKey))?.pending).toBeNull()
    expect((await store.getManaged(targetKey))?.current?.kindState).toMatchObject({
      rollbackOperationId: operation.authorization.operationId,
      loaderPhase: 'active',
    })
    expect((await lstat(installedPath)).isSymbolicLink()).toBe(false)
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toMatchObject({
      name: 'official-profile', dependencies: { 'dsh-capability-resolver': `file:${archive.path}` },
    })
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')

    const settled = (await store.getManaged(targetKey))!
    const breakGlassRestored = {
      ...prepared.before!,
      revision: settled.revision + 1,
      lastOperationId: operation.authorization.operationId,
      pending: null,
      updatedAtMs: Date.now(),
    }
    await store.putManaged(breakGlassRestored, settled.revision)
    const sidecarPath = join(
      centerRoot,
      'plugin',
      'profiles',
      storageKey('web'),
      'packages',
      `${storageKey(targetKey)}.json`,
    )
    const priorSidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as Record<string, unknown>
    await writeFile(sidecarPath, canonicalJson({
      ...priorSidecar,
      revision: breakGlassRestored.revision,
      lastOperationId: operation.authorization.operationId,
      managed: breakGlassRestored,
      loaderEntryId: null,
      loaderName: null,
      restartPending: true,
      lastGoodMaterialPath: breakGlassRestored.lastGood?.materialPath ?? null,
      tombstoneMaterialPath: breakGlassRestored.removed?.materialPath ?? null,
    }) + '\n')
    const durable = (await store.getProviderSnapshot(operation.authorization.operationId))!
    const markerDirectory = join(centerRoot, 'plugin', 'break-glass-restores')
    await mkdir(markerDirectory, { recursive: true })
    await writeFile(join(markerDirectory, `${storageKey(operation.authorization.operationId)}.json`), canonicalJson({
      schemaVersion: 1,
      operationId: operation.authorization.operationId,
      targetKey,
      profileId: 'web',
      packageName: entry.artifact.id,
      journalHeadDigest: recoveryHead,
      providerSnapshotDigest: canonicalSha256(durable),
      beforeDigest: prepared.beforeDigest,
      restoredManagedDigest: managedStateDigest(breakGlassRestored),
      restoredRevision: breakGlassRestored.revision,
      status: 'settled',
    }) + '\n')
    loader = new MemoryLoader()
    loader.seed(entry.artifact.id)
    provider = new PluginLifecycleProvider(store, loader, { hostHome, pluginCli: cli })
    await provider.initialize()
    expect((await store.getManaged(targetKey))?.revision).toBe(breakGlassRestored.revision + 1)
    await expect(provider.reconcileBreakGlassRestore(
      operation, prepared.beforeDigest, canonicalSha256({ wrongHead: true }),
    )).rejects.toThrow('does not bind')
    await expect(provider.reconcileBreakGlassRestore(operation, prepared.beforeDigest, recoveryHead)).resolves.toMatchObject({
      restartRequired: false,
      rollbackRestartRequired: true,
      restartToken: `managed-rollback:${operation.authorization.operationId}`,
    })
  })
})
