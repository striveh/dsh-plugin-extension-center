import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogEntry } from '../src/catalog-contract.ts'
import { canonicalJson, canonicalSha256 } from '../src/domain/index.ts'
import { CenterStateStore, captureCurrentProcessIdentity, storageKey } from '../src/host/index.ts'
import {
  inspectNpmArchive,
  materializeNpmArchive,
  PluginLifecycleProvider,
  pluginConfigurationMutationDigest,
  type AppliedProviderOperation,
  type ManagedPluginCli,
  type ManagedPluginLoader,
  type ProviderOperationRequest,
} from '../src/providers/index.ts'
import type { RpcJson } from '../src/service/rpc-contract.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface LoaderRow {
  readonly id: string
  readonly options: Readonly<{ id?: string; name: string; config?: unknown; group?: boolean }>
  readonly disabled: boolean
  readonly refresh: () => Promise<void>
  readonly fiber?: Readonly<{ state: number; await: () => Promise<void> }>
}

class MemoryLoader implements ManagedPluginLoader {
  readonly rows = new Map<string, LoaderRow>()
  writes = 0
  failAwait = false

  async create(options: Readonly<{ name: string; config?: unknown }>): Promise<string> {
    if (options.name.startsWith('file:')) {
      execFileSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(options.name)})`])
    }
    const id = `row-${String(this.rows.size + 1)}`
    if (this.rows.has(id)) throw new Error(`duplicate loader entry: ${id}`)
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
    if (row === undefined) throw new Error(`missing loader entry: ${id}`)
    this.rows.set(id, { ...row, options: { ...row.options, ...options } })
    this.writes += 1
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
    if (this.failAwait) return Promise.reject(new Error('Loader settlement must not be awaited'))
    return Promise.resolve()
  }
}

class ProfileCli implements ManagedPluginCli {
  readonly calls: Array<Readonly<{ kind: 'add' | 'remove'; profileId: string; packageName: string; version?: string; artifactPath?: string }>> = []
  readonly auditModes: boolean[] = []

  constructor(private readonly hostHome: string) {}

  async audit(
    _profileId: string,
    _metadataCache: Parameters<ManagedPluginCli['audit']>[1],
    requireCurrentProfile: boolean,
  ): Promise<void> {
    this.auditModes.push(requireCurrentProfile)
  }

  failAddBefore = 0
  failAddAfter = 0
  afterAdd: ((input: Readonly<{ profileId: string; packageName: string; artifactPath: string }>) => Promise<void>) | null = null

  async add(profileId: string, packageName: string, version: string, artifactPath: string): Promise<void> {
    this.calls.push({ kind: 'add', profileId, packageName, version, artifactPath })
    if (this.failAddBefore > 0) {
      this.failAddBefore -= 1
      throw new Error('simulated official CLI add failure before mutation')
    }
    const profile = join(this.hostHome, 'profiles', profileId)
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.dependencies = { ...manifest.dependencies as Record<string, string> | undefined, [packageName]: `file:${artifactPath}` }
    const dsh = (manifest.dsh ?? {}) as Record<string, unknown>
    const profileMetadata = (dsh.profile ?? {}) as Record<string, unknown>
    profileMetadata.bundles = [...new Set([
      ...((profileMetadata.bundles ?? []) as string[]).filter(name => name !== packageName), packageName,
    ])]
    dsh.profile = profileMetadata
    manifest.dsh = dsh
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
    const packagePath = join(profile, 'node_modules', ...packageName.split('/'))
    await rm(packagePath, { recursive: true, force: true })
    await mkdir(dirname(packagePath), { recursive: true })
    const inspection = await materializeNpmArchive(artifactPath, packagePath, null)
    if (inspection.name !== packageName || inspection.version !== version) throw new Error('fake official CLI package mismatch')
    await this.afterAdd?.({ profileId, packageName, artifactPath })
    if (this.failAddAfter > 0) {
      this.failAddAfter -= 1
      throw new Error('simulated official CLI add failure after mutation')
    }
  }

  async remove(profileId: string, packageName: string): Promise<void> {
    this.calls.push({ kind: 'remove', profileId, packageName })
    const profile = join(this.hostHome, 'profiles', profileId)
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as Record<string, unknown>
    const dependencies = { ...manifest.dependencies as Record<string, string> | undefined }
    delete dependencies[packageName]
    manifest.dependencies = dependencies
    const dsh = (manifest.dsh ?? {}) as Record<string, unknown>
    const profileMetadata = (dsh.profile ?? {}) as Record<string, unknown>
    profileMetadata.bundles = ((profileMetadata.bundles ?? []) as string[]).filter(name => name !== packageName)
    dsh.profile = profileMetadata
    manifest.dsh = dsh
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
    await rm(join(profile, 'node_modules', ...packageName.split('/')), { recursive: true, force: true })
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

async function pluginArchive(
  root: string,
  input: Readonly<{ name: string; version: string; client: boolean }>,
): Promise<Readonly<{ path: string; integrity: `sha256:${string}` }>> {
  await mkdir(root, { recursive: true })
  const patch = Buffer.from(`- insert:\n    - id: ${input.name}\n      name: ${input.name}\n`)
  const manifest = Buffer.from(JSON.stringify({
    name: input.name,
    version: input.version,
    type: 'module',
    main: './index.js',
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      ...(input.client ? { client: { platform: 'web', inject: [] } } : {}),
    },
    peerDependencies: { '@deepseek-ai/cordis': '4.0.1' },
  }))
  const bytes = gzipSync(Buffer.concat([
    tarEntry('package/package.json', manifest),
    tarEntry('package/README.md', Buffer.from('# Fixture\n')),
    tarEntry('package/index.js', Buffer.from("import '@deepseek-ai/cordis'\nexport default function apply() {}\n")),
    tarEntry('package/cordis.patch.yml', patch),
    Buffer.alloc(1024),
  ]))
  const path = join(root, `${input.name.replaceAll('/', '-')}-${input.version}.tgz`)
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

function entry(name: string, version: string, integrity: `sha256:${string}`): CatalogEntry {
  return {
    candidateRef: `plugin:${name}@${version}`,
    kind: 'plugin',
    name,
    displayName: { en: name, zh: name },
    summary: { en: name, zh: name },
    publisher: { name: 'fixture', status: 'community' },
    license: { spdx: 'MIT', status: 'verified', sourceUrl: null },
    source: {
      type: 'github-release', label: 'fixture', url: 'https://example.test/release',
      upstreamUrl: 'https://example.test/source', revision: 'fixture', admittedAt: '2026-08-26T00:00:00.000Z',
    },
    artifact: {
      id: name, version, integrity, sizeBytes: 1,
      acquisitionUrl: 'https://example.test/plugin.tgz',
    },
    compatibility: {
      status: 'compatible', dsh: '0.1.1-rc.2', platforms: ['darwin', 'linux', 'windows'],
      detail: { en: 'fixture', zh: 'fixture' },
    },
    components: [], permissions: [], dependencies: [], scopes: ['profile:web'],
    configuration: { required: false, credentials: 'none', fields: [] },
    conflicts: [],
    restart: { required: true, detail: { en: 'fixture', zh: 'fixture' } },
    lifecycle: {
      install: { status: 'available' }, configure: { status: 'available' },
      update: { status: 'available' }, uninstall: { status: 'available' }, restore: { status: 'available' },
    },
    verification: [], retainedData: { en: 'fixture', zh: 'fixture' }, tags: [],
  }
}

async function request(
  provider: PluginLifecycleProvider,
  input: Readonly<{
    operationId: string
    operationKind: 'install' | 'configure' | 'update' | 'uninstall' | 'restore'
    entry: CatalogEntry
    configuration?: RpcJson
    artifactPath?: string | null
  }>,
): Promise<ProviderOperationRequest> {
  const inspection = input.artifactPath === null || input.artifactPath === undefined
    ? null
    : await inspectNpmArchive(input.artifactPath, null)
  const owner = await provider.snapshot('web')
  const managed = await provider.observe(`plugin:web:profile:web:${input.entry.name}`)
  const configuration = input.configuration ?? {}
  const operationKind = input.operationKind
  const restartRequired = input.entry.restart.required && operationKind !== 'configure'
  const review = {
    schemaVersion: 1 as const,
    kind: 'plugin' as const,
    operationKind,
    checks: [], removed: [], retained: [], credentialChoice: 'not-applicable' as const,
    rollbackPoint: managed?.current === null || managed === null
      ? { kind: 'absent-state' as const, id: 'absent', digest: canonicalSha256(null) }
      : { kind: 'managed-version' as const, id: managed.current!.candidateRef, digest: canonicalSha256(managed.current) },
    rollbackLimits: ['dsh-managed-state-only' as const], notProven: ['user-task-outcome' as const],
    manifest: {
      packageName: input.entry.artifact.id,
      beforeVersion: managed?.current?.artifactRevision ?? null,
      afterVersion: ['uninstall'].includes(operationKind) ? null : input.entry.artifact.version,
      body: inspection?.manifestBody ?? '',
      manifestDigest: inspection?.manifestDigest ?? canonicalSha256({}),
      files: inspection?.files ?? [],
      fileManifestDigest: inspection?.fileManifestDigest ?? canonicalSha256([]),
    },
    dependencies: Object.entries(inspection?.peerDependencies ?? {}).map(([id, afterVersion]) => ({
      id, kind: 'peer' as const, beforeVersion: null, afterVersion, required: true,
    })),
    managedMaterial: {
      owner: 'extension-center' as const, packageName: input.entry.artifact.id,
      beforeVersion: managed?.current?.artifactRevision ?? null,
      afterVersion: ['uninstall'].includes(operationKind) ? null : input.entry.artifact.version,
      targetIntegrity: ['uninstall'].includes(operationKind) ? null : input.entry.artifact.integrity,
    },
    packageMetadata: {
      bundlePatch: inspection?.bundlePatch === null || inspection === null ? null : {
        path: 'cordis.patch.yml' as const,
        patchDigest: inspection.bundlePatch.digest, patchBody: inspection.bundlePatch.body,
      },
    },
    activation: {
      mutationOwner: operationKind === 'configure' ? 'official-loader' as const : 'official-dsh-cli' as const,
      profileDependency: operationKind === 'uninstall' ? 'remove' as const
        : operationKind === 'restore' ? 'restore' as const
          : operationKind === 'update' ? 'replace' as const
            : managed?.current === null || managed === null ? 'add' as const : 'retain' as const,
      loaderEntry: operationKind === 'uninstall' ? 'remove' as const
        : operationKind === 'restore' ? 'restore' as const
          : operationKind === 'update' ? 'replace' as const
            : operationKind === 'configure' ? 'replace' as const
              : managed?.current === null || managed === null ? 'create' as const : 'retain' as const,
      restartRequired,
      packageName: input.entry.artifact.id,
    },
    scripts: { before: [], after: inspection?.scripts ?? [], forbiddenLifecycle: [] },
    settings: {
      adapterVersion: null, adapterDigest: null, schemaDigest: null, ownerRevision: owner.ownerRevision,
      migration: 'not-required' as const, schema: [], migrationChanges: [], diffDigest: canonicalSha256(configuration),
    },
  }
  const targetKey = `plugin:web:profile:web:${input.entry.name}`
  return {
    authorization: {
      operationId: input.operationId, planId: `plan:${input.operationId}`,
      planHash: canonicalSha256({ operationId: input.operationId }), operationKind,
      managedObject: 'artifact', externalRuntimeAction: ['install', 'update'].includes(operationKind) ? 'download' : 'none',
      runtimeBinding: null, targetKey, ownerKey: 'managedPlugins', scopeKey: 'profile:web',
      profileId: 'web', authorizedAtMs: Date.now(),
    },
    plan: {
      schemaVersion: 1, singleUse: true, planId: `plan:${input.operationId}`, intentId: `intent:${input.operationId}`,
      origin: 'store', candidateRef: input.entry.candidateRef, extensionKind: 'plugin', extensionId: input.entry.name,
      managedObject: 'artifact', externalRuntimeAction: ['install', 'update'].includes(operationKind) ? 'download' : 'none',
      runtimeBinding: null, artifactRevision: input.entry.artifact.version, artifactIntegrity: input.entry.artifact.integrity,
      artifactUrl: input.entry.artifact.acquisitionUrl, artifactSizeBytes: input.entry.artifact.sizeBytes,
      operationKind, desiredState: operationKind === 'uninstall' ? 'removed' : 'enabled', targetKey,
      ownerKey: 'managedPlugins', scopeKey: 'profile:web', profileId: 'web', idempotencyKey: input.operationId,
      authorityDigest: canonicalSha256({ authority: input.operationId }),
      configurationDigest: canonicalSha256(configuration),
      retentionDigest: canonicalSha256({ candidateRef: input.entry.candidateRef, retainedData: input.entry.retainedData }),
      reviewEvidence: review,
      mutationDigest: operationKind === 'configure'
        ? pluginConfigurationMutationDigest(configuration, owner.ownerRevision)
        : canonicalSha256({ operationKind, candidateRef: input.entry.candidateRef, owner: owner.ownerRevision }),
      verificationDigest: canonicalSha256({ verification: input.operationId }), restartRequired,
      createdAtMs: 1, expiresAtMs: 1_000_000,
      fences: {
        catalogRevision: 1, inventoryRevision: canonicalSha256({ inventory: input.operationId }), targetRevision: 'fixture',
        ownerRevision: owner.ownerRevision, scopeRevision: canonicalSha256({ scope: 'profile:web' }),
        profileRevision: owner.ownerRevision,
      },
    },
    payload: {
      configuration, continuationId: null, resolutionId: null, verificationPayloadDigest: null,
      taskSessionId: null, taskOriginalMessageId: null,
    }, artifactPath: input.artifactPath ?? null, signal: new AbortController().signal,
  }
}

async function apply(
  provider: PluginLifecycleProvider,
  state: CenterStateStore,
  operation: ProviderOperationRequest,
): Promise<AppliedProviderOperation> {
  const prepared = await provider.prepare(operation)
  await state.putProviderSnapshot({
    schemaVersion: 1,
    operationId: operation.authorization.operationId,
    targetKey: operation.plan.targetKey,
    before: prepared.before,
    beforeDigest: prepared.beforeDigest,
    recoveryPoint: provider.recoveryPoint(prepared),
  })
  return await provider.apply(prepared)
}

describe('Center-owned managed Plugin owner', () => {
  it('delegates a Host-only Bundle to the official CLI and verifies its canonical row after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-owner-'))
    roots.push(root)
    const centerRoot = join(root, 'center')
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    await writeFile(join(profile, 'package.json'), '{"name":"untouched","dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const archive = await pluginArchive(join(centerRoot, 'artifacts', 'sha256'), {
      name: 'fixture-host-plugin', version: '1.0.0', client: false,
    })
    const catalog = entry('fixture-host-plugin', '1.0.0', archive.integrity)
    const state = new CenterStateStore(centerRoot)
    await state.initialize()
    const cli = new ProfileCli(hostHome)
    const loader = new MemoryLoader()
    const provider = new PluginLifecycleProvider(state, loader, { hostHome, pluginCli: cli })

    const applied = await apply(provider, state, await request(provider, {
      operationId: 'operation:host-install', operationKind: 'install', entry: catalog, artifactPath: archive.path,
    }))

    expect(applied.restartRequired).toBe(true)
    expect(loader.rows.size).toBe(0)
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toMatchObject({
      name: 'untouched',
      dependencies: { 'fixture-host-plugin': `file:${archive.path}` },
      dsh: { profile: { bundles: ['fixture-host-plugin'] } },
    })
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    await expect(provider.verify(applied)).resolves.toBeNull()

    const restartedLoader = new MemoryLoader()
    restartedLoader.seed('fixture-host-plugin')
    const restarted = new PluginLifecycleProvider(new CenterStateStore(centerRoot), restartedLoader, {
      hostHome, pluginCli: cli,
    })
    await restarted.initialize()
    const recovered = await restarted.recover(applied.prepared.request)
    await expect(restarted.verify(recovered!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
  })

  it('settles only the exact managed Loader row while an unrelated FAILED row remains untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-exact-loader-row-'))
    roots.push(root)
    const centerRoot = join(root, 'center')
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'official-profile', dependencies: {}, dsh: { profile: { bundles: [] } },
    }))
    const archive = await pluginArchive(join(centerRoot, 'artifacts', 'sha256'), {
      name: 'fixture-exact-row-plugin', version: '1.0.0', client: false,
    })
    const state = new CenterStateStore(centerRoot)
    await state.initialize()
    const cli = new ProfileCli(hostHome)
    const first = new PluginLifecycleProvider(state, new MemoryLoader(), { hostHome, pluginCli: cli })
    const applied = await apply(first, state, await request(first, {
      operationId: 'operation:exact-loader-row', operationKind: 'install',
      entry: entry('fixture-exact-row-plugin', '1.0.0', archive.integrity), artifactPath: archive.path,
    }))

    const exactRefresh = vi.fn(async () => {})
    const exactAwait = vi.fn(async () => {})
    const failedRefresh = vi.fn(async () => { throw new Error('unrelated FAILED row refresh must not run') })
    const failedAwait = vi.fn(async () => { throw new Error('unrelated FAILED row await must not run') })
    const restartedLoader = new MemoryLoader()
    restartedLoader.failAwait = true
    restartedLoader.rows.set('unrelated-failed-row', {
      id: 'unrelated-failed-row',
      options: { name: 'unrelated-failed-plugin' },
      disabled: false,
      refresh: failedRefresh,
      fiber: { state: 3, await: failedAwait },
    })
    restartedLoader.rows.set('exact-managed-row', {
      id: 'exact-managed-row',
      options: { name: 'fixture-exact-row-plugin' },
      disabled: false,
      refresh: exactRefresh,
      fiber: { state: 2, await: exactAwait },
    })
    const restarted = new PluginLifecycleProvider(new CenterStateStore(centerRoot), restartedLoader, {
      hostHome, pluginCli: cli,
    })

    await expect(restarted.initialize()).resolves.toBeUndefined()
    const recovered = await restarted.recover(applied.prepared.request)
    expect(recovered).not.toBeNull()
    await expect(restarted.verify(recovered!)).resolves.toMatchObject({
      digest: expect.stringMatching(/^sha256:/),
    })
    expect(exactRefresh).toHaveBeenCalledTimes(3)
    expect(exactAwait).toHaveBeenCalledTimes(3)
    expect(failedRefresh).not.toHaveBeenCalled()
    expect(failedAwait).not.toHaveBeenCalled()
  })

  it('requires current Profile provenance only for the initial mutation, not startup recovery or rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-cache-use-'))
    roots.push(root)
    const centerRoot = join(root, 'center')
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'official-profile', dependencies: {}, dsh: { profile: { bundles: [] } },
    }))
    const archive = await pluginArchive(join(centerRoot, 'artifacts', 'sha256'), {
      name: 'fixture-recovery-plugin', version: '1.0.0', client: true,
    })
    const state = new CenterStateStore(centerRoot)
    await state.initialize()
    const cli = new ProfileCli(hostHome)
    const first = new PluginLifecycleProvider(state, new MemoryLoader(), { hostHome, pluginCli: cli })
    const applied = await apply(first, state, await request(first, {
      operationId: 'operation:cache-use', operationKind: 'install',
      entry: entry('fixture-recovery-plugin', '1.0.0', archive.integrity), artifactPath: archive.path,
    }))
    expect(cli.auditModes).toEqual([true])

    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    delete (manifest.dependencies as Record<string, unknown>)['fixture-recovery-plugin']
    const profileMetadata = (manifest.dsh as Record<string, unknown>).profile as Record<string, unknown>
    profileMetadata.bundles = []
    await writeFile(manifestPath, JSON.stringify(manifest))
    await rm(join(profile, 'node_modules', 'fixture-recovery-plugin'), { recursive: true, force: true })

    const restarted = new PluginLifecycleProvider(new CenterStateStore(centerRoot), new MemoryLoader(), {
      hostHome,
      pluginCli: cli,
    })
    await restarted.initialize()
    expect(cli.auditModes).toEqual([true, false])
    const recovered = await restarted.recover(applied.prepared.request)
    await expect(restarted.rollback(recovered!)).resolves.toBe(applied.prepared.beforeDigest)
    expect(cli.auditModes).toEqual([true, false, false])
  })

  it('delegates Host+Client material to the official CLI and verifies its canonical row after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-client-owner-'))
    roots.push(root)
    const centerRoot = join(root, 'center')
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    await writeFile(join(profile, 'package.json'), '{"name":"untouched","dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const archive = await pluginArchive(join(centerRoot, 'artifacts', 'sha256'), {
      name: '@fixture/client-plugin', version: '1.0.0', client: true,
    })
    const catalog = entry('@fixture/client-plugin', '1.0.0', archive.integrity)
    const state = new CenterStateStore(centerRoot)
    await state.initialize()
    const cli = new ProfileCli(hostHome)
    const firstLoader = new MemoryLoader()
    const first = new PluginLifecycleProvider(state, firstLoader, { hostHome, pluginCli: cli })
    const applied = await apply(first, state, await request(first, {
      operationId: 'operation:client-install', operationKind: 'install', entry: catalog, artifactPath: archive.path,
    }))

    expect(applied.restartRequired).toBe(true)
    expect(firstLoader.rows.size).toBe(0)
    const installed = join(hostHome, 'profiles', 'web', 'node_modules', '@fixture', 'client-plugin')
    expect((await lstat(installed)).isSymbolicLink()).toBe(false)
    expect(cli.calls).toEqual([{
      kind: 'add', profileId: 'web', packageName: '@fixture/client-plugin', version: '1.0.0', artifactPath: archive.path,
    }])
    expect(cli.auditModes).toEqual([true])
    await expect(first.verify(applied)).resolves.toBeNull()

    const restartedLoader = new MemoryLoader()
    restartedLoader.seed('@fixture/client-plugin')
    const restarted = new PluginLifecycleProvider(new CenterStateStore(centerRoot), restartedLoader, { hostHome, pluginCli: cli })
    await restarted.initialize()
    expect([...restartedLoader.rows.values()].map(row => row.options.name))
      .toEqual(['@fixture/client-plugin'])
    const recovered = await restarted.recover(applied.prepared.request)
    expect(recovered).not.toBeNull()
    await expect(restarted.verify(recovered!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })

    const installedEntrypoint = join(installed, 'index.js')
    const admittedEntrypoint = await readFile(installedEntrypoint, 'utf8')
    await writeFile(installedEntrypoint, 'export default function tampered() {}\n')
    const replaced = new PluginLifecycleProvider(
      new CenterStateStore(centerRoot),
      new MemoryLoader(),
      { hostHome, pluginCli: cli },
    )
    await expect(replaced.initialize()).rejects.toThrow('installed tree does not match the admitted archive')
    await writeFile(installedEntrypoint, admittedEntrypoint)

    await expect(restarted.rollback(recovered!)).resolves.toBe(recovered!.prepared.beforeDigest)
    expect(cli.auditModes).toEqual([true, false])
    expect(await state.getManaged(applied.prepared.request.plan.targetKey)).toBeUndefined()
    const sidecar = join(
      centerRoot,
      'plugin',
      'profiles',
      storageKey('web'),
      'packages',
      `${storageKey(applied.prepared.request.plan.targetKey)}.json`,
    )
    await expect(lstat(sidecar)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(installed)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(restartedLoader.rows.size).toBe(1)
    const sameProcessRollback = await restarted.recover(applied.prepared.request)
    expect(sameProcessRollback).toMatchObject({
      restartRequired: false,
      rollbackRestartRequired: true,
      restartToken: 'managed-rollback:operation:client-install',
    })
    await expect(restarted.bootReady({
      profileId: 'web', restartToken: sameProcessRollback!.restartToken!,
    })).resolves.toBe(false)

    const absentReceiptPath = join(
      centerRoot,
      'plugin',
      'absent-rollbacks',
      `${storageKey(applied.prepared.request.authorization.operationId)}.json`,
    )
    const receiptBody = await readFile(absentReceiptPath, 'utf8')
    await writeFile(absentReceiptPath, `${canonicalJson({ ...JSON.parse(receiptBody), foreign: true })}\n`)
    const tampered = new PluginLifecycleProvider(new CenterStateStore(centerRoot), new MemoryLoader(), { hostHome, pluginCli: cli })
    await expect(tampered.initialize()).rejects.toThrow('receipt')
    await writeFile(absentReceiptPath, receiptBody)

    const rollbackLoader = new MemoryLoader()
    const rollbackHost = new PluginLifecycleProvider(new CenterStateStore(centerRoot), rollbackLoader, { hostHome, pluginCli: cli })
    await rollbackHost.initialize()
    expect(cli.calls.map(call => call.kind)).toEqual(['add', 'remove'])
    const rolledBack = await rollbackHost.recover(applied.prepared.request)
    expect(rolledBack).toMatchObject({
      restartRequired: false,
      rollbackRestartRequired: true,
      restartToken: 'managed-rollback:operation:client-install',
    })
    await expect(rollbackHost.bootReady({
      profileId: 'web', restartToken: rolledBack!.restartToken!,
    })).resolves.toBe(true)
    rollbackLoader.failAwait = true
    await expect(rollbackHost.verify(rolledBack!)).resolves.toMatchObject({ digest: expect.stringMatching(/^sha256:/) })
    await expect(rollbackHost.acknowledgeBoot({
      operationId: applied.prepared.request.authorization.operationId,
      targetKey: applied.prepared.request.plan.targetKey,
      profileId: 'web',
      restartToken: rolledBack!.restartToken!,
    })).resolves.toBeUndefined()
    await rollbackHost.finalizeRollback(rolledBack!)
    await expect(lstat(absentReceiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(rollbackHost.recover(applied.prepared.request)).resolves.toBeNull()
    expect(rollbackLoader.rows.size).toBe(0)
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toEqual({
      name: 'untouched', dependencies: {}, dsh: { profile: { bundles: [] } },
    })
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  })

  it('rejects a Center artifact changed after review before invoking the official CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-artifact-change-'))
    roots.push(root)
    const centerRoot = join(root, 'center')
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    await writeFile(join(profile, 'package.json'), '{"name":"official-profile","dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n')
    const archive = await pluginArchive(join(centerRoot, 'artifacts', 'sha256'), {
      name: 'fixture-client-plugin', version: '1.0.0', client: true,
    })
    const state = new CenterStateStore(centerRoot)
    await state.initialize()
    const cli = new ProfileCli(hostHome)
    const provider = new PluginLifecycleProvider(state, new MemoryLoader(), { hostHome, pluginCli: cli })
    const operation = await request(provider, {
      operationId: 'operation:changed-artifact', operationKind: 'install',
      entry: entry('fixture-client-plugin', '1.0.0', archive.integrity), artifactPath: archive.path,
    })
    const prepared = await provider.prepare(operation)
    await writeFile(archive.path, 'changed after review')

    await expect(provider.apply(prepared)).rejects.toThrow('retained artifact evidence changed')
    expect(cli.calls).toEqual([])
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toEqual({
      name: 'official-profile', dependencies: {}, dsh: { profile: { bundles: [] } },
    })
  })

  it('rejects an unowned Profile package path instead of replacing foreign file, directory, or symlink state', async () => {
    for (const kind of ['file', 'directory', 'symlink'] as const) {
      const root = await mkdtemp(join(tmpdir(), `extension-plugin-foreign-${kind}-`))
      roots.push(root)
      const centerRoot = join(root, 'center')
      const hostHome = join(root, 'dsh-home')
      const profile = await profileWithCordis(hostHome)
      await writeFile(join(profile, 'package.json'), '{"name":"official-profile","dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n')
      const packagePath = join(hostHome, 'profiles', 'web', 'node_modules', 'fixture-client-plugin')
      await mkdir(join(packagePath, '..'), { recursive: true })
      if (kind === 'file') await writeFile(packagePath, 'foreign')
      else if (kind === 'directory') await mkdir(packagePath)
      else await symlink(join(root, 'foreign-target'), packagePath)
      const archive = await pluginArchive(join(centerRoot, 'artifacts', 'sha256'), {
        name: 'fixture-client-plugin', version: '1.0.0', client: true,
      })
      const state = new CenterStateStore(centerRoot)
      await state.initialize()
      const provider = new PluginLifecycleProvider(state, new MemoryLoader(), {
        hostHome, pluginCli: new ProfileCli(hostHome),
      })
      const operation = await request(provider, {
        operationId: `operation:foreign-${kind}`, operationKind: 'install',
        entry: entry('fixture-client-plugin', '1.0.0', archive.integrity), artifactPath: archive.path,
      })
      await expect(apply(provider, state, operation)).rejects.toThrow(/foreign|unowned/)
      expect(await readFile(packagePath, 'utf8').catch(() => null)).toBe(kind === 'file' ? 'foreign' : null)
    }
  })

  it.each(['before', 'after'] as const)(
    'compensates an official add failure %s mutation without removing an already-absent target',
    async (stage) => {
      const root = await mkdtemp(join(tmpdir(), `extension-plugin-add-failure-${stage}-`))
      roots.push(root)
      const centerRoot = join(root, 'center')
      const hostHome = join(root, 'dsh-home')
      const profile = await profileWithCordis(hostHome)
      const initial = { name: 'official-profile', dependencies: {}, dsh: { profile: { bundles: [] } } }
      await writeFile(join(profile, 'package.json'), JSON.stringify(initial))
      const archive = await pluginArchive(join(centerRoot, 'artifacts', 'sha256'), {
        name: 'fixture-failing-plugin', version: '1.0.0', client: true,
      })
      const state = new CenterStateStore(centerRoot)
      await state.initialize()
      const cli = new ProfileCli(hostHome)
      if (stage === 'before') cli.failAddBefore = 1
      else cli.failAddAfter = 1
      const provider = new PluginLifecycleProvider(state, new MemoryLoader(), { hostHome, pluginCli: cli })
      const operation = await request(provider, {
        operationId: `operation:add-failure-${stage}`,
        operationKind: 'install',
        entry: entry('fixture-failing-plugin', '1.0.0', archive.integrity),
        artifactPath: archive.path,
      })

      await expect(apply(provider, state, operation)).rejects.toThrow(`failure ${stage} mutation`)
      expect(cli.calls.map(call => call.kind)).toEqual(stage === 'before' ? ['add'] : ['add', 'remove'])
      expect(cli.auditModes).toEqual(stage === 'before' ? [true] : [true, false])
      expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toEqual(initial)
      expect(await state.getManaged(operation.plan.targetKey)).toBeUndefined()
      await expect(lstat(join(
        hostHome,
        '.extension-center-plugin-coordination',
        'quarantine',
        `${storageKey('web')}.json`,
      ))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it.each(['target-only', 'foreign-drift'] as const)(
    'classifies %s pnpm lockfile changes around one official add',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), `extension-plugin-lock-${mode}-`))
      roots.push(root)
      const centerRoot = join(root, 'center-one')
      const hostHome = join(root, 'dsh-home')
      const profile = await profileWithCordis(hostHome)
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'official-profile',
        dependencies: { 'foreign-package': '1.0.0' },
        dsh: { profile: { bundles: [] } },
      }))
      const baselineLock = {
        lockfileVersion: '9.0',
        settings: { autoInstallPeers: false, excludeLinksFromLockfile: false },
        importers: { '.': { dependencies: {
          'foreign-package': { specifier: '1.0.0', version: '1.0.0' },
        } } },
        packages: { 'foreign-package@1.0.0': { resolution: { integrity: 'sha512:fixture' } } },
        snapshots: { 'foreign-package@1.0.0': {} },
      }
      await writeFile(join(profile, 'pnpm-lock.yaml'), JSON.stringify(baselineLock))
      const archive = await pluginArchive(join(centerRoot, 'artifacts', 'sha256'), {
        name: 'fixture-lock-plugin', version: '1.0.0', client: true,
      })
      const state = new CenterStateStore(centerRoot)
      await state.initialize()
      const cli = new ProfileCli(hostHome)
      cli.afterAdd = async ({ packageName, artifactPath }) => {
        const next = JSON.parse(JSON.stringify(baselineLock)) as typeof baselineLock
        const dependencies = next.importers['.'].dependencies as Record<string, { specifier: string; version: string }>
        dependencies[packageName] = {
          specifier: `file:${artifactPath}`,
          version: `file:${artifactPath}`,
        }
        Object.assign(next.packages, { [`${packageName}@file:${artifactPath}`]: { resolution: { integrity: 'sha512:target' } } })
        Object.assign(next.snapshots, { [`${packageName}@file:${artifactPath}`]: {} })
        if (mode === 'foreign-drift') dependencies['foreign-package']!.specifier = '2.0.0'
        await writeFile(join(profile, 'pnpm-lock.yaml'), JSON.stringify(next))
      }
      const provider = new PluginLifecycleProvider(state, new MemoryLoader(), { hostHome, pluginCli: cli })
      const operation = await request(provider, {
        operationId: `operation:lock-${mode}`,
        operationKind: 'install',
        entry: entry('fixture-lock-plugin', '1.0.0', archive.integrity),
        artifactPath: archive.path,
      })

      if (mode === 'target-only') {
        await expect(apply(provider, state, operation)).resolves.toMatchObject({ restartRequired: true })
        return
      }
      await expect(apply(provider, state, operation)).rejects.toMatchObject({ code: 'profile-state-ambiguous' })
      const quarantine = JSON.parse(await readFile(join(
        hostHome,
        '.extension-center-plugin-coordination',
        'quarantine',
        `${storageKey('web')}.json`,
      ), 'utf8')) as Record<string, unknown>
      expect(quarantine).toMatchObject({
        schemaVersion: 1,
        profileId: 'web',
        packageName: 'fixture-lock-plugin',
        operationId: operation.authorization.operationId,
        targetKey: operation.plan.targetKey,
        centerRoot,
        reason: 'official CLI changed non-target Profile state',
      })
      const second = new PluginLifecycleProvider(
        new CenterStateStore(join(root, 'center-two')),
        new MemoryLoader(),
        { hostHome, pluginCli: new ProfileCli(hostHome) },
      )
      await expect(second.initialize()).rejects.toMatchObject({ code: 'profile-state-ambiguous' })
      await expect(readFile(join(
        hostHome,
        '.extension-center-plugin-coordination',
        'quarantine',
        `${storageKey('web')}.json`,
      ), 'utf8')).resolves.toContain(operation.authorization.operationId)
    },
  )

  it('uses one hostHome Profile lease across independent Center roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-shared-lease-'))
    roots.push(root)
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'official-profile', dependencies: {}, dsh: { profile: { bundles: [] } },
    }))
    const lease = join(
      hostHome,
      '.extension-center-plugin-coordination',
      'leases',
      storageKey('web'),
    )
    await mkdir(lease, { recursive: true })
    await writeFile(join(lease, 'owner.json'), canonicalJson({
      schemaVersion: 2,
      profileId: 'web',
      ownerId: 'other-center-root',
      leaseId: `lease:${randomUUID()}`,
      processIdentity: await captureCurrentProcessIdentity(),
      acquiredAtMs: Date.now(),
    }) + '\n')
    const provider = new PluginLifecycleProvider(
      new CenterStateStore(join(root, 'center-two')),
      new MemoryLoader(),
      { hostHome, pluginCli: new ProfileCli(hostHome) },
    )

    await expect(provider.initialize()).rejects.toThrow(`owned by live process ${String(process.pid)}`)
  })

  it.each([
    { code: 'EPERM', expected: 'has a live official CLI subtree' },
    { code: 'EACCES', expected: 'CLI subtree cannot be verified' },
  ])('does not recover a dead Profile owner when process-group liveness is $code', async ({ code, expected }) => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-group-liveness-'))
    roots.push(root)
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'official-profile', dependencies: {}, dsh: { profile: { bundles: [] } },
    }))
    const lease = join(
      hostHome,
      '.extension-center-plugin-coordination',
      'leases',
      storageKey('web'),
    )
    const currentIdentity = await captureCurrentProcessIdentity()
    const owner = {
      schemaVersion: 2,
      profileId: 'web',
      ownerId: 'dead-owner-with-cli-subtree',
      leaseId: `lease:${randomUUID()}`,
      processIdentity: {
        ...currentIdentity,
        pid: 2_147_483_647,
        birthDigest: `sha256:${'0'.repeat(64)}`,
      },
      acquiredAtMs: 1,
    }
    await mkdir(lease, { recursive: true })
    const ownerBody = `${canonicalJson(owner)}\n`
    await writeFile(join(lease, 'owner.json'), ownerBody)
    const execution = {
      schemaVersion: 1,
      profileId: 'web',
      ownerId: owner.ownerId,
      parentPid: owner.processIdentity.pid,
      processGroupPid: 424_242,
      supervisorSha256: `sha256:${'1'.repeat(64)}`,
      startedAtMs: 1,
    }
    await writeFile(join(lease, 'execution.json'), `${canonicalJson(execution)}\n`)
    await writeFile(join(lease, 'execution-dispatch.json'), `${canonicalJson({
      schemaVersion: 1,
      profileId: 'web',
      ownerId: owner.ownerId,
      leaseId: owner.leaseId,
      processGroupPid: execution.processGroupPid,
      executionDigest: canonicalSha256(execution),
      dispatchedAtMs: 2,
    })}\n`)
    const processError = Object.assign(new Error(`simulated ${code}`), { code })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw processError })
    const provider = new PluginLifecycleProvider(
      new CenterStateStore(join(root, 'center')),
      new MemoryLoader(),
      { hostHome, pluginCli: new ProfileCli(hostHome) },
    )
    try {
      const platformExpected = process.platform === 'win32' ? 'CLI subtree cannot be verified' : expected
      await expect(provider.initialize()).rejects.toThrow(platformExpected)
    } finally {
      kill.mockRestore()
    }
    expect(await readFile(join(lease, 'owner.json'), 'utf8')).toBe(ownerBody)
    await expect(lstat(join(
      hostHome,
      '.extension-center-plugin-coordination',
      'lease-takeovers',
      storageKey('web'),
    ))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(
      hostHome,
      '.extension-center-plugin-coordination',
      'lease-quarantine',
      storageKey('web'),
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an orphan execution dispatch without deleting the Profile lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-orphan-dispatch-'))
    roots.push(root)
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'official-profile', dependencies: {}, dsh: { profile: { bundles: [] } },
    }))
    const lease = join(hostHome, '.extension-center-plugin-coordination', 'leases', storageKey('web'))
    const currentIdentity = await captureCurrentProcessIdentity()
    const owner = {
      schemaVersion: 2,
      profileId: 'web',
      ownerId: 'dead-owner-with-orphan-dispatch',
      leaseId: `lease:${randomUUID()}`,
      processIdentity: {
        ...currentIdentity,
        pid: 2_147_483_647,
        birthDigest: `sha256:${'0'.repeat(64)}`,
      },
      acquiredAtMs: 1,
    }
    await mkdir(lease, { recursive: true })
    await writeFile(join(lease, 'owner.json'), `${canonicalJson(owner)}\n`)
    await writeFile(join(lease, 'execution-dispatch.json'), `${canonicalJson({
      schemaVersion: 1,
      profileId: 'web',
      ownerId: owner.ownerId,
      leaseId: owner.leaseId,
      processGroupPid: 424_242,
      executionDigest: `sha256:${'1'.repeat(64)}`,
      dispatchedAtMs: 2,
    })}\n`)
    const provider = new PluginLifecycleProvider(
      new CenterStateStore(join(root, 'center')),
      new MemoryLoader(),
      { hostHome, pluginCli: new ProfileCli(hostHome) },
    )

    await expect(provider.initialize()).rejects.toThrow('execution dispatch has no execution lease')
    await expect(readFile(join(lease, 'owner.json'), 'utf8')).resolves.toContain(owner.ownerId)
  })

  it.each(['canonical', 'retired'] as const)(
    'continues a dead Profile claimant from the exact shared quarantine format with a %s gate',
    async gatePlacement => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-profile-takeover-'))
    roots.push(root)
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'official-profile', dependencies: {}, dsh: { profile: { bundles: [] } },
    }))
    const profileId = 'web'
    const key = storageKey(profileId)
    const leaseId = `lease:${randomUUID()}`
    const quarantineId = `quarantine:${randomUUID()}`
    const currentIdentity = await captureCurrentProcessIdentity()
    const owner = {
      schemaVersion: 2,
      profileId,
      ownerId: 'dead-profile-claimant',
      leaseId,
      processIdentity: {
        ...currentIdentity,
        pid: 2_147_483_647,
        birthDigest: `sha256:${'0'.repeat(64)}`,
      },
      acquiredAtMs: 1,
    }
    const coordination = join(hostHome, '.extension-center-plugin-coordination')
    const quarantine = join(
      coordination,
      'lease-quarantine',
      key,
      quarantineId.slice('quarantine:'.length),
    )
    const takeoverRoot = join(coordination, 'lease-takeovers')
    const takeover = gatePlacement === 'canonical'
      ? join(takeoverRoot, key)
      : join(takeoverRoot, `.retired-${randomUUID()}`)
    await mkdir(quarantine, { recursive: true, mode: 0o700 })
    await mkdir(takeover, { recursive: true, mode: 0o700 })
    await writeFile(join(quarantine, 'owner.json'), `${canonicalJson(owner)}\n`)
    await writeFile(join(takeover, 'record.json'), `${canonicalJson({
      schemaVersion: 1,
      profileId,
      sourceLeaseId: leaseId,
      sourceOwnerDigest: canonicalSha256(owner),
      quarantineId,
      takeoverId: `takeover:${randomUUID()}`,
      claimantOwnerId: owner.ownerId,
      claimantProcessIdentity: owner.processIdentity,
      claimedAtMs: 1,
    })}\n`)
    const provider = new PluginLifecycleProvider(
      new CenterStateStore(join(root, 'center')),
      new MemoryLoader(),
      { hostHome, pluginCli: new ProfileCli(hostHome) },
    )

    await expect(provider.initialize()).resolves.toBeUndefined()

    await expect(lstat(takeover)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(takeoverRoot)).resolves.toEqual([])
    await expect(lstat(join(coordination, 'lease-quarantine', key))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(coordination, 'leases', key))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('advances the Profile fence for direct dependency, Bundle order, and lockfile drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-plugin-profile-fence-'))
    roots.push(root)
    const centerRoot = join(root, 'center')
    const hostHome = join(root, 'dsh-home')
    const profile = await profileWithCordis(hostHome)
    const manifest = {
      name: 'official-profile',
      dependencies: { 'foreign-a': '1.0.0', 'foreign-b': '1.0.0' },
      dsh: { profile: { bundles: ['foreign-a', 'foreign-b'] } },
    }
    const lock = {
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: false, excludeLinksFromLockfile: false },
      importers: { '.': { dependencies: {
        'foreign-a': { specifier: '1.0.0', version: '1.0.0' },
        'foreign-b': { specifier: '1.0.0', version: '1.0.0' },
      } } },
      packages: {},
      snapshots: {},
    }
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(profile, 'pnpm-lock.yaml'), JSON.stringify(lock))
    const state = new CenterStateStore(centerRoot)
    await state.initialize()
    const provider = new PluginLifecycleProvider(state, new MemoryLoader(), {
      hostHome,
      pluginCli: new ProfileCli(hostHome),
    })

    const first = await provider.snapshot('web')
    manifest.dependencies['foreign-a'] = '2.0.0'
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
    const dependencyDrift = await provider.snapshot('web')
    manifest.dsh.profile.bundles.reverse()
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
    const bundleDrift = await provider.snapshot('web')
    lock.importers['.'].dependencies['foreign-b']!.specifier = '2.0.0'
    await writeFile(join(profile, 'pnpm-lock.yaml'), JSON.stringify(lock))
    const lockDrift = await provider.snapshot('web')

    expect([
      first.revision,
      dependencyDrift.revision,
      bundleDrift.revision,
      lockDrift.revision,
    ]).toEqual([0, 1, 2, 3])
    expect(new Set([
      first.digest,
      dependencyDrift.digest,
      bundleDrift.digest,
      lockDrift.digest,
    ])).toHaveLength(4)
  })
})
