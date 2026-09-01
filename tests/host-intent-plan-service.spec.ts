import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { verifyBootstrapCatalog, type VerifiedCatalog } from '../src/catalog.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import type { ManagedTargetRecord, ManagedVersion, StoredIntent } from '../src/host/index.ts'
import type { ImmutablePlan } from '../src/plans/index.ts'
import { CAPABILITY_RESOLVER_CANDIDATES } from '../src/resolver-candidates.ts'
import { IntentPlanService, resolveDesiredState } from '../src/service/intent-plan-service.ts'
import type { RpcJson } from '../src/service/rpc-contract.ts'
import { alphaPolicyCatalogFixture } from './support/alpha-catalog.ts'

function version(enabled: boolean): ManagedVersion {
  return {
    candidateRef: 'skill:documentation-writer@v1',
    artifactRevision: 'v1',
    artifactIntegrity: `sha256:${'1'.repeat(64)}`,
    materialPath: '/managed/SKILL.md',
    configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
    enabled,
    ownerRevision: 'skills:1',
    kindState: {},
  }
}

function record(input: Readonly<{
  current: ManagedVersion | null
  removed: ManagedVersion | null
  lastGood: ManagedVersion | null
}>): ManagedTargetRecord {
  return {
    schemaVersion: 1,
    kind: 'skill',
    extensionId: 'documentation-writer',
    targetKey: 'skill:web:user:documentation-writer',
    scopeKey: 'user',
    profileId: 'web',
    revision: 1,
    lastOperationId: null,
    current: input.current,
    removed: input.removed,
    lastGood: input.lastGood,
    pending: null,
    updatedAtMs: 1,
  }
}

describe('intent plan desired state', () => {
  it('restores the enabled removed version after disable, enable, and uninstall', () => {
    const managed = record({ current: null, removed: version(true), lastGood: version(false) })

    expect(resolveDesiredState('restore', 'store', 'skill', managed)).toBe('enabled')
  })

  it('uses the disabled removed version instead of an unrelated enabled last-good version', () => {
    const managed = record({ current: null, removed: version(false), lastGood: version(true) })

    expect(resolveDesiredState('restore', 'store', 'skill', managed)).toBe('disabled')
  })

  it('uses last-good only when restore swaps an installed current version', () => {
    const managed = record({ current: version(true), removed: null, lastGood: version(false) })

    expect(resolveDesiredState('restore', 'store', 'skill', managed)).toBe('disabled')
  })

  it('rejects an install targetKey that is not the exact candidate identity before managed-state access', async () => {
    const catalog = alphaPolicyCatalogFixture()
    const entry = catalog.envelope.entries.find(candidate => candidate.kind === 'plugin')!
    let managedReads = 0
    let planWrites = 0
    const service = new IntentPlanService(
      {
        getManaged: async () => {
          managedReads += 1
          return undefined
        },
      } as never,
      { put: async () => { planWrites += 1 } } as never,
      {
        list: async () => ({
          schemaVersion: 1,
          scopeKey: 'profile:web',
          profileId: 'web',
          complete: true,
          observedAtMs: 1,
          rows: [],
          revision: canonicalSha256({ inventory: 'empty' }),
        }),
      } as never,
      {
        managedPlugins: {}, mcpConnections: {}, taskContinuations: {}, skills: {}, tools: {}, loader: {},
      } as never,
      () => catalog,
      {} as never,
      { mcpOptions: async () => [], mcpRuntime: async () => null },
    )

    await expect(service.preview({
      protocolVersion: 1,
      origin: 'store',
      candidateRef: entry.candidateRef,
      operationKind: 'install',
      scopeKey: 'profile:web',
      profileId: 'web',
      continuationId: null,
      targetKey: 'plugin:web:profile:web:another-plugin',
      configuration: {},
    }, 'authenticated-browser-session', 1_000)).rejects.toThrow('targetKey does not bind')
    expect(managedReads).toBe(0)
    expect(planWrites).toBe(0)
  })

  it('returns current settings for an exact update candidate of the same resolver target', async () => {
    const verified = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const currentEntry = verified.envelope.entries.find(entry => entry.kind === 'plugin')!
    const [, next] = CAPABILITY_RESOLVER_CANDIDATES
    const nextEntry = {
      ...currentEntry,
      candidateRef: next.candidateRef,
      artifact: {
        ...currentEntry.artifact,
        version: next.version,
        integrity: next.integrity,
        sizeBytes: next.sizeBytes,
      },
    }
    const catalog = {
      ...verified,
      envelope: {
        ...verified.envelope,
        entries: [...verified.envelope.entries, nextEntry],
      },
    } as VerifiedCatalog
    const configuration = {
      freshCacheMs: 5_000,
      staleCacheMs: 30_000,
      fetchTimeoutMs: 10_000,
      maxCatalogBytes: 1_048_576,
      maxCatalogEntries: 2_000,
      maxTaskChars: 4_000,
      maxResults: 5,
      maxCurrentMatches: 10,
      maxDescriptionChars: 500,
      maxMatchedTerms: 10,
    }
    const managed: ManagedTargetRecord = {
      schemaVersion: 1,
      kind: 'plugin',
      extensionId: currentEntry.name,
      targetKey: `plugin:web:profile:web:${currentEntry.name}`,
      scopeKey: 'profile:web',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:installed',
      current: {
        candidateRef: currentEntry.candidateRef,
        artifactRevision: currentEntry.artifact.version,
        artifactIntegrity: currentEntry.artifact.integrity,
        materialPath: '/managed/dsh-capability-resolver',
        configuration,
        enabled: true,
        ownerRevision: 'managed-plugin:1',
        kindState: {},
      },
      removed: null,
      lastGood: null,
      pending: null,
      updatedAtMs: 1,
    }
    const service = new IntentPlanService(
      { getManaged: async (targetKey: string) => targetKey === managed.targetKey ? managed : undefined } as never,
      {} as never,
      {} as never,
      {} as never,
      () => catalog,
      {} as never,
      { mcpOptions: async () => [], mcpRuntime: async () => null },
    )

    await expect(service.configurationOptions({
      candidateRef: next.candidateRef,
      operationKind: 'update',
      targetKey: managed.targetKey,
      scopeKey: 'profile:web',
      profileId: 'web',
    })).resolves.toEqual({ options: [], currentConfiguration: configuration })
    await expect(service.configurationOptions({
      candidateRef: verified.envelope.entries.find(entry => entry.kind === 'mcp')!.candidateRef,
      operationKind: 'update',
      targetKey: managed.targetKey,
      scopeKey: 'profile:web',
      profileId: 'web',
    })).rejects.toThrow('does not match')
    await expect(service.configurationOptions({
      candidateRef: 'plugin:dsh-capability-resolver@0.1.2',
      operationKind: 'update',
      targetKey: managed.targetKey,
      scopeKey: 'profile:web',
      profileId: 'web',
    })).rejects.toThrow('absent')
  })

  it('selects retained configuration for restore even when configure uses the same candidateRef', async () => {
    const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const entry = catalog.envelope.entries.find(candidate => candidate.kind === 'mcp')!
    const targetKey = `mcp:web:profile:web:${entry.name}`
    const currentConfiguration = { transport: 'stdio', runtimeRef: 'runtime:filesystem', connectionId: 'filesystem', roots: ['/current'] }
    const retainedConfiguration = { transport: 'stdio', runtimeRef: 'runtime:filesystem', connectionId: 'filesystem', roots: ['/retained'] }
    const version = (configuration: RpcJson) => ({
      candidateRef: entry.candidateRef,
      artifactRevision: entry.artifact.version,
      artifactIntegrity: entry.artifact.integrity,
      materialPath: '/managed/filesystem-mcp',
      configuration,
      enabled: true,
      ownerRevision: 'mcp:7',
      kindState: {},
    })
    const managed: ManagedTargetRecord = {
      schemaVersion: 1,
      kind: 'mcp',
      extensionId: entry.name,
      targetKey,
      scopeKey: 'profile:web',
      profileId: 'web',
      revision: 2,
      lastOperationId: 'operation:configured',
      current: version(currentConfiguration),
      lastGood: version(retainedConfiguration),
      removed: null,
      pending: null,
      updatedAtMs: 2,
    }
    const service = new IntentPlanService(
      { getManaged: async () => managed } as never,
      {} as never,
      {} as never,
      {} as never,
      () => catalog,
      {} as never,
      { mcpOptions: async () => [], mcpRuntime: async () => null },
    )

    await expect(service.configurationOptions({
      candidateRef: entry.candidateRef,
      operationKind: 'configure',
      targetKey,
      scopeKey: 'profile:web',
      profileId: 'web',
    })).resolves.toEqual({ options: [], currentConfiguration })
    await expect(service.configurationOptions({
      candidateRef: entry.candidateRef,
      operationKind: 'restore',
      targetKey,
      scopeKey: 'profile:web',
      profileId: 'web',
    })).resolves.toEqual({ options: [], currentConfiguration: retainedConfiguration })
  })

  it('returns current settings only for exact same-target MCP and Skill update successors', async () => {
    const verified = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
    const pairs = [
      {
        kind: 'mcp' as const,
        scopeKey: 'profile:web',
        entries: verified.envelope.entries.filter(entry => entry.kind === 'mcp'),
        configuration: { transport: 'stdio', runtimeRef: 'runtime:filesystem', connectionId: 'filesystem' },
      },
      {
        kind: 'skill' as const,
        scopeKey: 'user',
        entries: verified.envelope.entries.filter(entry => entry.name === 'wiki-page-writer'),
        configuration: { modelInvocable: true, userInvocable: false, projectRoot: null },
      },
    ]

    for (const pair of pairs) {
      const [currentEntry, nextEntry] = pair.entries
      if (currentEntry === undefined || nextEntry === undefined) throw new Error('fixture update pair is incomplete')
      const targetKey = `${pair.kind}:web:${pair.scopeKey}:${currentEntry.name}`
      const managed = {
        schemaVersion: 1,
        kind: pair.kind,
        extensionId: currentEntry.name,
        targetKey,
        scopeKey: pair.scopeKey,
        profileId: 'web',
        revision: 1,
        lastOperationId: 'operation:installed-old-version',
        current: {
          candidateRef: currentEntry.candidateRef,
          artifactRevision: currentEntry.artifact.version,
          artifactIntegrity: currentEntry.artifact.integrity,
          materialPath: '/managed/exact-update-target',
          configuration: pair.configuration,
          enabled: true,
          ownerRevision: `${pair.kind}:1`,
          kindState: {},
        },
        removed: null,
        lastGood: null,
        pending: null,
        updatedAtMs: 1,
      } as ManagedTargetRecord
      const optionRequests: string[] = []
      const service = new IntentPlanService(
        { getManaged: async (requested: string) => requested === targetKey ? managed : undefined } as never,
        {} as never,
        {} as never,
        {} as never,
        () => verified,
        {} as never,
        {
          mcpOptions: async (candidateRef) => {
            optionRequests.push(candidateRef)
            return []
          },
          mcpRuntime: async () => null,
        },
      )

      await expect(service.configurationOptions({
        candidateRef: nextEntry.candidateRef,
        operationKind: 'update',
        targetKey,
        scopeKey: pair.scopeKey,
        profileId: 'web',
      })).resolves.toEqual({ options: [], currentConfiguration: pair.configuration })
      expect(optionRequests).toEqual(pair.kind === 'mcp' ? [nextEntry.candidateRef] : [])
    }
  })

  it('plans Plugin configure as an exact same-Host Loader replacement and rejects restart or activation drift', async () => {
    const catalog = alphaPolicyCatalogFixture()
    const rollover = {
      ...catalog,
      envelope: { ...catalog.envelope, revision: catalog.envelope.revision + 1, entries: [] },
    } as VerifiedCatalog
    let exposeRolloverAfterFirstRead = false
    let catalogReads = 0
    const currentCatalog = (): VerifiedCatalog => {
      catalogReads += 1
      return exposeRolloverAfterFirstRead && catalogReads > 1 ? rollover : catalog
    }
    const entry = catalog.envelope.entries.find(candidate => candidate.kind === 'plugin')!
    const targetKey = `plugin:web:profile:web:${entry.name}`
    const configuration = {
      freshCacheMs: 5_000,
      staleCacheMs: 30_000,
      fetchTimeoutMs: 10_000,
      maxCatalogBytes: 1_048_576,
      maxCatalogEntries: 2_000,
      maxTaskChars: 4_000,
      maxResults: 4,
      maxCurrentMatches: 10,
      maxDescriptionChars: 500,
      maxMatchedTerms: 10,
    }
    const ownerDigest = canonicalSha256({ owner: 'plugin-configure-plan' })
    const ownerRevision = `managed-plugin:1:${ownerDigest}`
    const managed: ManagedTargetRecord = {
      schemaVersion: 1,
      kind: 'plugin',
      extensionId: entry.name,
      targetKey,
      scopeKey: 'profile:web',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:installed',
      current: {
        candidateRef: entry.candidateRef,
        artifactRevision: entry.artifact.version,
        artifactIntegrity: entry.artifact.integrity,
        materialPath: '/managed/dsh-capability-resolver',
        configuration: { ...configuration, maxResults: 5 },
        enabled: true,
        ownerRevision,
        kindState: {},
      },
      removed: null,
      lastGood: null,
      pending: null,
      updatedAtMs: 1,
    }
    const available = { status: 'available' as const }
    const row = {
      schemaVersion: 1,
      kind: 'plugin',
      extensionId: entry.name,
      candidateRef: entry.candidateRef,
      targetKey,
      scopeKey: 'profile:web',
      profileId: 'web',
      ownership: 'center',
      desired: 'enabled',
      materialized: 'configured',
      effective: 'active',
      agentVisibility: 'visible',
      verification: 'runtime',
      rollback: 'available',
      managedRevision: 'center:1',
      ownerRevision,
      configurationRevision: canonicalSha256(managed.current!.configuration),
      observedAtMs: 1,
      actions: {
        install: available, configure: available, update: available, enable: available,
        disable: available, uninstall: available, restore: available, purge: available,
      },
      updateObservation: { status: 'none' },
      restoreObservation: { status: 'none' },
      evidence: {
        kind: 'plugin', restartToken: null, loaderPhase: 'active', consumerObserved: true, restartObserved: true,
      },
    }
    const inventory = {
      schemaVersion: 1,
      scopeKey: 'profile:web',
      profileId: 'web',
      complete: true,
      observedAtMs: 1,
      rows: [row],
      revision: canonicalSha256({ inventory: 'plugin-configure-plan' }),
    }
    let storedIntent: StoredIntent | undefined
    const store = {
      getManaged: async (requested: string) => requested === targetKey ? managed : undefined,
      putIntent: async (value: StoredIntent) => { storedIntent = value },
      getIntent: async (intentId: string) => storedIntent?.intent.intentId === intentId ? storedIntent : undefined,
    }
    const plans = { put: async () => {} }
    const managedPlugins = {
      snapshot: async () => ({
        profileId: 'web', revision: 1, digest: ownerDigest, materialRoot: '/managed',
        bootStatus: 'live' as const, ownerRevision,
      }),
    }
    const service = new IntentPlanService(
      store as never,
      plans as never,
      { list: async () => inventory } as never,
      {
        managedPlugins: {}, mcpConnections: {}, taskContinuations: {}, skills: {}, tools: {}, loader: {},
      } as never,
      currentCatalog,
      managedPlugins,
      { mcpOptions: async () => [], mcpRuntime: async () => null },
    )

    const preview = await service.preview({
      protocolVersion: 1,
      origin: 'store',
      candidateRef: entry.candidateRef,
      operationKind: 'configure',
      scopeKey: 'profile:web',
      profileId: 'web',
      continuationId: null,
      targetKey,
      configuration,
    }, 'authenticated-browser-session', 1_000)
    expect(preview.plan.content.restartRequired).toBe(false)
    expect(preview.plan.content.reviewEvidence).toMatchObject({
      kind: 'plugin',
      activation: {
        mutationOwner: 'official-loader', profileDependency: 'retain', loaderEntry: 'replace', restartRequired: false,
      },
    })
    exposeRolloverAfterFirstRead = true
    catalogReads = 0
    await expect(service.context(preview.plan)).resolves.toMatchObject({
      operationKind: 'configure',
      targetKey,
      fences: { catalogRevision: catalog.envelope.revision },
    })
    expect(catalogReads).toBe(1)
    exposeRolloverAfterFirstRead = false

    const forgedRestart = structuredClone(preview.plan) as unknown as { content: { restartRequired: boolean } }
    forgedRestart.content.restartRequired = true
    await expect(service.context(forgedRestart as unknown as ImmutablePlan)).rejects.toThrow('restart requirement')

    const forgedActivation = structuredClone(preview.plan) as unknown as {
      content: { reviewEvidence: { activation: { mutationOwner: string } } }
    }
    forgedActivation.content.reviewEvidence.activation.mutationOwner = 'official-dsh-cli'
    await expect(service.context(forgedActivation as unknown as ImmutablePlan)).rejects.toThrow('review evidence changed')
  })
})
