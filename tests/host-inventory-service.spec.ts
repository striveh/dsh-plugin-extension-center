import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { verifyBootstrapCatalog } from '../src/catalog.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { CenterStateStore, storageKey, type HostOwners } from '../src/host/index.ts'
import { SKILL_CANDIDATES } from '../src/kind-candidates.ts'
import { HostInventoryService } from '../src/service/inventory-service.ts'
import { McpLifecycleProvider } from '../src/providers/mcp-provider.ts'

const roots: string[] = []

function managedPluginSnapshots(
  observe: (profileId: string) => Readonly<{
    profileId: string
    revision: number
    digest: `sha256:${string}`
    materialRoot: string
    bootStatus: 'live' | 'pending-restart' | 'verified'
    ownerRevision: string
  }> = profileId => {
    const digest = canonicalSha256({ profileId, managedPlugins: [] })
    return {
      profileId,
      revision: 0,
      digest,
      materialRoot: '/managed-plugins',
      bootStatus: 'live',
      ownerRevision: `managed-plugin:0:${digest}`,
    }
  },
) {
  return { snapshot: async (profileId: string) => observe(profileId) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function ownerFixture(failedSkill?: string): Readonly<{ owners: HostOwners; skillLookups: unknown[] }> {
  const skillLookups: unknown[] = []
  let reverse = false
  const active = [{
    id: 'zeta', revision: 4,
    desired: { enabled: true, transport: { transport: 'streamable-http' } },
    observed: { state: 'ready' },
    tools: { generation: 7, digest: 'tools:zeta', names: ['zeta/read'] },
  }, {
    id: 'alpha', revision: 2,
    desired: { enabled: false, transport: { transport: 'stdio' } },
    observed: { state: 'disabled' },
    tools: { generation: 2, digest: 'tools:alpha', names: [] },
  }]
  const removed = [{ id: 'beta', revision: 3 }]
  const loaderEntries = [{
    id: 'z-plugin', options: { id: 'z-plugin', name: 'z-plugin' }, disabled: false,
    refresh: async () => {}, fiber: { state: 2, await: async () => {} },
  }, {
    id: 'system-core', options: { id: 'system-core', name: '@deepseek-ai/system-core' }, disabled: false,
    refresh: async () => {}, fiber: { state: 2, await: async () => {} },
  }, {
    id: 'group-child', options: { id: 'group-child', name: 'group-child', group: true }, disabled: false,
    refresh: async () => {}, fiber: { state: 2, await: async () => {} },
  }]
  const owners: HostOwners = {
    managedPlugins: managedPluginSnapshots(),
    mcpConnections: {
      snapshot: () => {
        reverse = !reverse
        return {
          revision: 9,
          connections: reverse ? [...active].reverse() : active,
          removed: reverse ? removed : [...removed].reverse(),
        }
      },
    } as never,
    taskContinuations: {} as never,
    skills: {
      snapshot: async (options?: unknown) => {
        skillLookups.push(options)
        const skills = [{
          name: 'zeta-skill', provider: 'fixture-zeta', resourceBase: { kind: 'directory', path: '/skills/zeta' },
          invocation: { modelInvocable: true, userInvocable: false },
        }, {
          name: 'documentation-writer', provider: 'fixture-docs', resourceBase: { kind: 'directory', path: '/skills/docs' },
          invocation: { modelInvocable: true, userInvocable: true },
        }]
        reverse = !reverse
        return { complete: true, skills: reverse ? skills : [...skills].reverse() }
      },
      get: async (name: string) => {
        if (name === failedSkill) throw new Error('simulated definition load failure')
        if (name === 'zeta-skill') return {
          name, provider: 'fixture-zeta', path: '/skills/zeta/SKILL.md', content: 'zeta',
          invocation: { modelInvocable: true, userInvocable: false },
        }
        if (name === 'documentation-writer') return {
          name, provider: 'fixture-docs', path: '/skills/docs/SKILL.md', content: 'docs',
          invocation: { modelInvocable: true, userInvocable: true },
        }
        return undefined
      },
    } as never,
    tools: {} as never,
    loader: {
      await: async () => {},
      entries: () => {
        reverse = !reverse
        return reverse ? loaderEntries : [...loaderEntries].reverse()
      },
    } as never,
  }
  return { owners, skillLookups }
}

describe('Host inventory owner normalization', () => {
  it('enumerates exact Profile MCP and top-level Loader truth deterministically without cross-scope Skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-inventory-owner-'))
    roots.push(root)
    const state = new CenterStateStore(root)
    await state.initialize()
    const fixture = ownerFixture()
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const inventory = new HostInventoryService(state, fixture.owners, () => catalog, managedPluginSnapshots())

    const first = await inventory.list('profile:web', 'web')
    const second = await inventory.list('profile:web', 'web')

    expect(first.revision).toBe(second.revision)
    expect(first.rows.map(row => `${row.kind}:${row.extensionId}`)).toEqual([
      'mcp:alpha', 'mcp:beta', 'mcp:zeta', 'plugin:@deepseek-ai/system-core', 'plugin:z-plugin',
    ])
    expect(first.rows.find(row => row.extensionId === 'zeta')?.evidence).toMatchObject({
      kind: 'mcp', transport: 'http', observedLifecycle: 'ready', toolGeneration: 7,
    })
    expect(first.rows.find(row => row.extensionId === '@deepseek-ai/system-core')?.ownership).toBe('system')
    expect(first.rows.find(row => row.extensionId === 'z-plugin')?.ownership).toBe('external')
    expect(first.rows.some(row => row.extensionId === 'group-child')).toBe(false)
    expect(first.rows.every(row => Object.values(row.actions).every(action => action.status === 'external'))).toBe(true)
    expect(fixture.skillLookups).toEqual([])
  })

  it('enumerates Skill winners only in user/project scope and requires the exact project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-inventory-skill-'))
    roots.push(root)
    const state = new CenterStateStore(root)
    await state.initialize()
    const fixture = ownerFixture()
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const inventory = new HostInventoryService(state, fixture.owners, () => catalog, managedPluginSnapshots())

    const user = await inventory.list('user', 'web')
    expect(user.rows.map(row => `${row.kind}:${row.extensionId}`)).toEqual([
      'skill:documentation-writer', 'skill:zeta-skill',
    ])
    expect(user.rows.find(row => row.extensionId === 'documentation-writer')).toMatchObject({
      candidateRef: expect.stringMatching(/^skill:/),
      targetKey: 'skill:web:user:documentation-writer',
      ownership: 'external',
      effective: 'active',
      evidence: { winningPath: '/skills/docs/SKILL.md', definitionLoaded: true },
    })

    await expect(inventory.list('project', 'web')).resolves.toMatchObject({ rows: [] })
    const project = await inventory.list('project', 'web', root)
    expect(project.rows.map(row => row.kind)).toEqual(['skill', 'skill'])
    expect(fixture.skillLookups).toEqual([{}, { cwd: root }])
  })

  it('degrades an external Skill when its winning summary cannot load an exact definition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-inventory-skill-fault-'))
    roots.push(root)
    const state = new CenterStateStore(root)
    await state.initialize()
    const fixture = ownerFixture('documentation-writer')
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const inventory = new HostInventoryService(state, fixture.owners, () => catalog, managedPluginSnapshots())

    const snapshot = await inventory.list('user', 'web')
    expect(snapshot.rows.find(row => row.extensionId === 'documentation-writer')).toMatchObject({
      effective: 'degraded',
      agentVisibility: 'not-visible',
      verification: 'structural',
      evidence: { winningProvider: 'fixture-docs', winningPath: null, definitionLoaded: false },
    })
    expect(snapshot.rows.find(row => row.extensionId === 'zeta-skill')).toMatchObject({
      effective: 'active',
      evidence: { winningPath: '/skills/zeta/SKILL.md', definitionLoaded: true },
    })
  })

  it('degrades a managed MCP when the live owner descriptor drifts from the admitted runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-inventory-mcp-drift-'))
    roots.push(root)
    const canonicalRoot = await realpath(root)
    const writtenExecutablePath = join(root, 'filesystem-mcp')
    const executable = '#!/bin/sh\nexit 0\n'
    await writeFile(writtenExecutablePath, executable)
    await chmod(writtenExecutablePath, 0o755)
    const executablePath = await realpath(writtenExecutablePath)
    const executableSha256 = `sha256:${createHash('sha256').update(executable).digest('hex')}` as const
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const source = catalog.envelope.entries.find(entry => entry.kind === 'mcp')!
    const update = catalog.envelope.entries.find(entry => entry.kind === 'mcp' && entry.artifact.version === '1.3.0')!
    const runtime = {
      transport: 'stdio' as const,
      runtimeRef: 'runtime:filesystem-mcp:test',
      candidateRef: source.candidateRef,
      executablePath,
      version: source.artifact.version,
      executableSha256,
      fixedArgs: ['--fixed'],
      workingDirectory: canonicalRoot,
    }
    const reconnect = { enabled: true, initialDelayMs: 50, maxDelayMs: 1_000, maxAttempts: 3 }
    const expectedTransport = {
      transport: 'stdio', command: executablePath, args: ['--fixed', canonicalRoot], env: {}, cwd: canonicalRoot,
      toolCallTimeoutMs: 1_000, reconnect,
    }
    let active = {
      id: 'filesystem', revision: 4,
      desired: { id: 'filesystem', enabled: true, transport: expectedTransport },
      observed: { state: 'ready', desiredRevision: 4, generation: 2 },
      tools: { generation: 7, digest: 'tools:filesystem:7', names: ['filesystem/read'] },
    }
    const mcpOwner = {
      get: (id: string) => id === 'filesystem' ? active : undefined,
      getRemoved: () => undefined,
      snapshot: () => ({ revision: 4, connections: [active], removed: [] }),
    }
    const owners: HostOwners = {
      managedPlugins: null,
      mcpConnections: mcpOwner as never,
      taskContinuations: null,
      skills: null,
      tools: null,
      loader: null,
    }
    const state = new CenterStateStore(root)
    await state.initialize()
    await state.putManaged({
      schemaVersion: 1,
      kind: 'mcp',
      extensionId: source.name,
      targetKey: `mcp:web:profile:web:${source.name}`,
      scopeKey: 'profile:web',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:test-install',
      current: {
        candidateRef: source.candidateRef,
        artifactRevision: source.artifact.version,
        artifactIntegrity: source.artifact.integrity,
        materialPath: executablePath,
        configuration: {
          transport: 'stdio', connectionId: 'filesystem', runtimeRef: runtime.runtimeRef, roots: [canonicalRoot],
          toolCallTimeoutMs: 1_000, reconnect,
        },
        enabled: true,
        ownerRevision: 'mcp:4',
        kindState: {
          connectionId: 'filesystem', runtimeRef: runtime.runtimeRef,
          runtimeVersion: runtime.version, descriptorDigest: canonicalSha256(runtime),
          transport: 'stdio', executablePath, configured: true,
        },
      },
      lastGood: null,
      removed: null,
      pending: null,
      updatedAtMs: 1,
    }, 0)
    const provider = new McpLifecycleProvider(state, mcpOwner as never, [runtime])
    const inventory = new HostInventoryService(
      state,
      owners,
      () => catalog,
      managedPluginSnapshots(),
      version => provider.inspect(version),
    )

    await expect(inventory.list('profile:web', 'web')).resolves.toMatchObject({
      rows: [{
        effective: 'active', agentVisibility: 'visible', verification: 'runtime',
        updateObservation: {
          status: 'available', candidateRef: update.candidateRef,
          revision: update.artifact.version, integrity: update.artifact.integrity,
        },
        evidence: { descriptorMatches: true, descriptorDigest: canonicalSha256(runtime), observedLifecycle: 'ready', qualifiedTools: ['filesystem/read'] },
      }],
    })

    active = {
      ...active,
      revision: 5,
      desired: { ...active.desired, transport: { ...expectedTransport, args: ['--unapproved', canonicalRoot] } },
      observed: { ...active.observed, desiredRevision: 5 },
    }
    await expect(inventory.list('profile:web', 'web')).resolves.toMatchObject({
      rows: [{
        effective: 'degraded', agentVisibility: 'not-visible', verification: 'structural',
        evidence: { descriptorMatches: false, observedLifecycle: 'degraded', qualifiedTools: [] },
      }],
    })
  })

  it('finds only the exact package-reviewed successor for an older managed Skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-inventory-update-'))
    roots.push(root)
    const state = new CenterStateStore(root)
    await state.initialize()
    const [v1Identity, v2Identity] = SKILL_CANDIDATES.slice(1)
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const v1 = catalog.envelope.entries.find(entry => entry.candidateRef === v1Identity.candidateRef)!
    const v2 = catalog.envelope.entries.find(entry => entry.candidateRef === v2Identity.candidateRef)!
    const material = v1Identity.reviewBody!
    const targetKey = 'skill:web:user:wiki-page-writer'
    const materialPath = join(root, 'material', 'skills', storageKey(targetKey), storageKey(v1.artifact.integrity), 'SKILL.md')
    await mkdir(dirname(materialPath), { recursive: true })
    await writeFile(materialPath, material)
    await state.putManaged({
      schemaVersion: 1,
      kind: 'skill',
      extensionId: 'wiki-page-writer',
      targetKey,
      scopeKey: 'user',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:test-install',
      current: {
        candidateRef: v1.candidateRef,
        artifactRevision: v1.artifact.version,
        artifactIntegrity: v1.artifact.integrity,
        materialPath,
        configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
        enabled: true,
        ownerRevision: 'skills:1',
        kindState: {
          skillName: 'wiki-page-writer', description: 'Managed',
          modelInvocable: true, userInvocable: true,
        },
      },
      lastGood: null,
      removed: null,
      pending: null,
      updatedAtMs: 1,
    }, 0)
    const owners: HostOwners = {
      managedPlugins: managedPluginSnapshots(),
      mcpConnections: {} as never,
      taskContinuations: {} as never,
      skills: {
        snapshot: async () => ({
          complete: true,
          skills: [{
            name: 'wiki-page-writer', provider: 'extension-center',
            resourceBase: { kind: 'directory', path: dirname(materialPath) },
            invocation: { modelInvocable: true, userInvocable: true },
          }],
        }),
        get: async () => ({
          name: 'wiki-page-writer', provider: 'extension-center', path: materialPath,
          content: material, invocation: { modelInvocable: true, userInvocable: true },
        }),
      } as never,
      tools: {} as never,
      loader: {} as never,
    }
    const inventory = new HostInventoryService(state, owners, () => catalog, managedPluginSnapshots())

    const available = await inventory.list('user', 'web')
    expect(available.rows[0]).toMatchObject({
      updateObservation: {
        status: 'available',
        candidateRef: v2.candidateRef,
        revision: v2.artifact.version,
        integrity: v2.artifact.integrity,
      },
      evidence: { winningProvider: 'extension-center', winningPath: materialPath, definitionLoaded: true },
    })
  })

  it('projects only an exact catalog-bound last-good version as an active restore target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-inventory-restore-'))
    roots.push(root)
    const state = new CenterStateStore(root)
    await state.initialize()
    const [v1Identity, v2Identity] = SKILL_CANDIDATES.slice(1)
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const v1 = catalog.envelope.entries.find(entry => entry.candidateRef === v1Identity.candidateRef)!
    const v2 = catalog.envelope.entries.find(entry => entry.candidateRef === v2Identity.candidateRef)!
    const targetKey = 'skill:web:user:wiki-page-writer'
    const v1Path = join(root, 'material', 'skills', storageKey(targetKey), storageKey(v1.artifact.integrity), 'SKILL.md')
    const v2Path = join(root, 'material', 'skills', storageKey(targetKey), storageKey(v2.artifact.integrity), 'SKILL.md')
    await mkdir(dirname(v1Path), { recursive: true })
    await mkdir(dirname(v2Path), { recursive: true })
    await writeFile(v1Path, v1Identity.reviewBody!)
    await writeFile(v2Path, v2Identity.reviewBody!)
    const configuration = { modelInvocable: true, userInvocable: true, projectRoot: null }
    const version = (entry: typeof v1, materialPath: string, description: string) => ({
      candidateRef: entry.candidateRef,
      artifactRevision: entry.artifact.version,
      artifactIntegrity: entry.artifact.integrity,
      materialPath,
      configuration,
      enabled: true,
      ownerRevision: 'skills:2',
      kindState: {
        skillName: 'wiki-page-writer', description,
        modelInvocable: true, userInvocable: true,
      },
    })
    const managed = {
      schemaVersion: 1 as const,
      kind: 'skill' as const,
      extensionId: 'wiki-page-writer',
      targetKey,
      scopeKey: 'user',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:test-update',
      current: version(v2, v2Path, 'Current'),
      lastGood: version(v1, v1Path, 'Retained'),
      removed: null,
      pending: null,
      updatedAtMs: 2,
    }
    await state.putManaged(managed, 0)
    const owners: HostOwners = {
      managedPlugins: managedPluginSnapshots(),
      mcpConnections: {} as never,
      taskContinuations: {} as never,
      skills: {
        snapshot: async () => ({ complete: true, skills: [{
          name: 'wiki-page-writer', provider: 'extension-center',
          resourceBase: { kind: 'directory', path: dirname(v2Path) },
          invocation: { modelInvocable: true, userInvocable: true },
        }] }),
        get: async () => ({
          name: 'wiki-page-writer', provider: 'extension-center', path: v2Path,
          content: v2Identity.reviewBody!, invocation: { modelInvocable: true, userInvocable: true },
        }),
      } as never,
      tools: {} as never,
      loader: {} as never,
    }
    let projectedCatalog = catalog
    const inventory = new HostInventoryService(state, owners, () => projectedCatalog, managedPluginSnapshots())

    await expect(inventory.list('user', 'web')).resolves.toMatchObject({
      rows: [{
        candidateRef: v2.candidateRef,
        restoreObservation: {
          status: 'available',
          candidateRef: v1.candidateRef,
          revision: v1.artifact.version,
          integrity: v1.artifact.integrity,
        },
        actions: { restore: { status: 'available' } },
      }],
    })

    projectedCatalog = {
      ...catalog,
      envelope: {
        ...catalog.envelope,
        entries: catalog.envelope.entries.filter(entry => entry.candidateRef !== v1.candidateRef),
      },
    }
    await expect(inventory.list('user', 'web')).resolves.toMatchObject({
      rows: [{
        restoreObservation: { status: 'unknown' },
        actions: { restore: { status: 'unavailable', reason: 'no-exact-restore' } },
      }],
    })
  })

  it('keeps a disabled managed Skill invisible and degrades one definition-load fault without losing inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-inventory-managed-skill-drift-'))
    roots.push(root)
    const state = new CenterStateStore(root)
    await state.initialize()
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const source = catalog.envelope.entries.find(entry => entry.kind === 'skill')!
    const content = 'managed skill\n'
    const integrity = `sha256:${createHash('sha256').update(content).digest('hex')}`
    const targetKey = `skill:web:user:${source.name}`
    const materialPath = join(root, 'material', 'skills', storageKey(targetKey), storageKey(integrity), 'SKILL.md')
    await mkdir(dirname(materialPath), { recursive: true })
    await writeFile(materialPath, content)
    const managed = {
      schemaVersion: 1 as const,
      kind: 'skill' as const,
      extensionId: source.name,
      targetKey,
      scopeKey: 'user',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:skill-drift',
      current: {
        candidateRef: source.candidateRef,
        artifactRevision: source.artifact.version,
        artifactIntegrity: integrity,
        materialPath,
        configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
        enabled: false,
        ownerRevision: 'skills:1',
        kindState: { skillName: source.name, description: 'Managed Skill', modelInvocable: true, userInvocable: true },
      },
      lastGood: null,
      removed: null,
      pending: null,
      updatedAtMs: 1,
    }
    await state.putManaged(managed, 0)
    let failLoad = false
    const owners: HostOwners = {
      managedPlugins: managedPluginSnapshots(),
      mcpConnections: {} as never,
      taskContinuations: {} as never,
      skills: {
        snapshot: async () => ({ complete: true, skills: [{
          name: source.name, provider: 'extension-center',
          resourceBase: { kind: 'directory', path: dirname(materialPath) },
          invocation: { modelInvocable: true, userInvocable: true },
        }] }),
        get: async () => {
          if (failLoad) throw new Error('simulated managed definition load fault')
          return {
            name: source.name, provider: 'extension-center', path: materialPath, content,
            invocation: { modelInvocable: true, userInvocable: true },
          }
        },
      } as never,
      tools: {} as never,
      loader: {} as never,
    }
    const inventory = new HostInventoryService(state, owners, () => catalog, managedPluginSnapshots())

    await expect(inventory.verify('user', 'web', targetKey)).resolves.toMatchObject({
      rows: [{ effective: 'inactive', agentVisibility: 'not-visible', evidence: { definitionLoaded: true } }],
    })
    await expect(inventory.verify('user', 'web', 'skill:web:user:missing')).rejects.toThrow('target is absent')

    failLoad = true
    await state.putManaged({
      ...managed,
      revision: 2,
      current: { ...managed.current, enabled: true },
      updatedAtMs: 2,
    }, 1)
    await expect(inventory.list('user', 'web')).resolves.toMatchObject({
      rows: [{ effective: 'degraded', agentVisibility: 'not-visible', evidence: { definitionLoaded: false } }],
    })
  })

  it('re-reads the managed Plugin snapshot and Loader so a Plugin cannot stay falsely active after drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-inventory-plugin-drift-'))
    roots.push(root)
    const state = new CenterStateStore(root)
    await state.initialize()
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const source = catalog.envelope.entries.find(entry => entry.kind === 'plugin')!
    const generation = '00000000-0000-4000-8000-000000000741'
    const treeDigest = `sha256:${'7'.repeat(64)}`
    const targetKey = `plugin:web:profile:web:${source.name}`
    await state.putManaged({
      schemaVersion: 1,
      kind: 'plugin',
      extensionId: source.name,
      targetKey,
      scopeKey: 'profile:web',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:plugin-drift',
      current: {
        candidateRef: source.candidateRef,
        artifactRevision: source.artifact.version,
        artifactIntegrity: source.artifact.integrity,
        materialPath: root,
        configuration: {},
        enabled: true,
        ownerRevision: `managed-plugin:4:${treeDigest}`,
        kindState: {
          packageName: source.artifact.id,
          restartToken: generation,
          treeDigest,
          loaderPhase: 'active',
          consumerObserved: true,
          restartObserved: true,
          runtimeEvidence: {
            entryId: source.artifact.id,
            moduleName: source.artifact.id,
            fiberPhase: 'active',
          },
        },
      },
      lastGood: null,
      removed: null,
      pending: null,
      updatedAtMs: 1,
    }, 0)
    let bootStatus: 'verified' | 'pending-restart' = 'verified'
    let loaderActive = true
    const pluginSnapshots = managedPluginSnapshots(profileId => ({
      profileId,
      revision: 4,
      digest: treeDigest,
      materialRoot: root,
      bootStatus,
      ownerRevision: `managed-plugin:4:${treeDigest}`,
    }))
    const owners: HostOwners = {
      managedPlugins: pluginSnapshots,
      mcpConnections: null,
      taskContinuations: null,
      skills: null,
      tools: null,
      loader: {
        await: async () => {},
        entries: () => loaderActive ? [{
          id: source.artifact.id,
          options: { id: source.artifact.id, name: source.artifact.id },
          disabled: false,
          refresh: async () => {},
          fiber: { state: 2, await: async () => {} },
        }] : [],
      },
    }
    const inventory = new HostInventoryService(state, owners, () => catalog, pluginSnapshots)

    await expect(inventory.list('profile:web', 'web')).resolves.toMatchObject({
      rows: [{
        effective: 'active',
        agentVisibility: 'visible',
        updateObservation: {
          status: 'available',
          candidateRef: 'plugin:dsh-capability-resolver@0.1.1',
          revision: '0.1.1',
          integrity: 'sha256:650fab654ad7a7c22d2dd34814d8625810b67d5b6345e6ffe136c19373127c17',
        },
        evidence: { consumerObserved: true },
      }],
    })
    loaderActive = false
    await expect(inventory.list('profile:web', 'web')).resolves.toMatchObject({
      rows: [{ effective: 'degraded', agentVisibility: 'not-visible', evidence: { consumerObserved: false } }],
    })
    bootStatus = 'pending-restart'
    await expect(inventory.list('profile:web', 'web')).resolves.toMatchObject({
      rows: [{ effective: 'degraded', agentVisibility: 'not-visible', evidence: { restartObserved: false } }],
    })
  })
})
