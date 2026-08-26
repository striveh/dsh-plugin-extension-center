import { dirname } from 'node:path'
import type { VerifiedCatalog } from '../catalog.ts'
import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type { HostOwners, ManagedTargetRecord, ManagedVersion } from '../host/index.ts'
import { CenterStateStore, hostCapabilities } from '../host/index.ts'
import { createInventorySnapshot, type InventoryRow, type InventorySnapshot } from '../inventory/index.ts'
import type { RpcJson } from './rpc-contract.ts'
import { inspectSkillArtifact } from '../providers/skill-provider.ts'
import type { McpManagedOwnerEvidence } from '../providers/mcp-provider.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function kindState(value: ManagedVersion): Record<string, RpcJson> {
  const state = value.kindState
  if (typeof state !== 'object' || state === null || Array.isArray(state)) throw new Error('managed kind state is invalid')
  return state as Record<string, RpcJson>
}

function retained(record: ManagedTargetRecord): ManagedVersion | null {
  return record.current ?? record.removed ?? record.lastGood
}

function updateObservation(
  catalog: VerifiedCatalog,
  target: ManagedTargetRecord,
  version: ManagedVersion | null,
): InventoryRow['updateObservation'] {
  if (version === null) return Object.freeze({ status: 'unknown' })
  const candidates = catalog.envelope.entries.filter(entry => entry.kind === target.kind
    && entry.name === target.extensionId
    && entry.scopes.includes(target.scopeKey as never)
    && entry.artifact.version !== version.artifactRevision
    && entry.artifact.integrity !== version.artifactIntegrity)
  if (candidates.length === 0) return Object.freeze({ status: 'none' })
  if (candidates.length > 1) return Object.freeze({ status: 'unknown' })
  const current = candidates[0]!
  return Object.freeze({
    status: 'available',
    candidateRef: current.candidateRef,
    revision: current.artifact.version,
    integrity: current.artifact.integrity,
  })
}

/** Normalize center-owned durable state against the actual Skill, MCP, and Loader consumers. */
export class HostInventoryService {
  constructor(
    private readonly store: CenterStateStore,
    private readonly owners: HostOwners,
    private readonly catalog: () => VerifiedCatalog,
    private readonly inspectManagedMcp: ((version: ManagedVersion) => Promise<McpManagedOwnerEvidence>) | null = null,
  ) {}

  /** Observe one exact scope/profile without mutating desired state. */
  async list(scopeKey: string, profileId: string, projectRoot: string | null = null): Promise<InventorySnapshot> {
    const managed = (await this.store.listManaged()).filter(row => row.scopeKey === scopeKey && row.profileId === profileId)
    const rows: Array<Omit<InventoryRow, 'actions'>> = []
    for (const row of managed) rows.push(await this.centerRow(row))
    rows.push(...await this.externalRows(scopeKey, profileId, managed, projectRoot))
    const observedAtMs = rows.reduce((maximum, row) => Math.max(maximum, row.observedAtMs), 0)
    const capabilities = hostCapabilities(this.owners)
    return createInventorySnapshot({
      scopeKey,
      profileId,
      complete: capabilities.acquisition,
      observedAtMs,
      rows,
    }, capabilities)
  }

  /** Re-read every authoritative owner and require one exact target in the resulting projection. */
  async verify(scopeKey: string, profileId: string, targetKey: string, projectRoot: string | null = null): Promise<InventorySnapshot> {
    const snapshot = await this.list(scopeKey, profileId, projectRoot)
    if (!snapshot.rows.some(row => row.targetKey === targetKey)) {
      throw new Error('inventory verification target is absent from the authoritative observation')
    }
    return snapshot
  }

  private async externalRows(
    scopeKey: string,
    profileId: string,
    managed: readonly ManagedTargetRecord[],
    projectRoot: string | null,
  ): Promise<Array<Omit<InventoryRow, 'actions'>>> {
    const output: Array<Omit<InventoryRow, 'actions'>> = []
    const knownTargets = new Set(managed.map(row => row.targetKey))
    const knownMcpConnections = new Set(managed.filter(row => row.kind === 'mcp')
      .map(row => retained(row))
      .filter((version): version is ManagedVersion => version !== null)
      .map(version => String(kindState(version).connectionId)))
    const catalog = this.catalog().envelope.entries
    const catalogTarget = (kind: InventoryRow['kind'], name: string): Readonly<{ targetKey: string; candidateRef: string | null }> => {
      const entry = catalog.find(candidate => candidate.kind === kind
        && candidate.name === name
        && candidate.scopes.includes(scopeKey as never))
      return entry === undefined
        ? { targetKey: `${kind}:${profileId}:${scopeKey}:external:${name}`, candidateRef: null }
        : { targetKey: `${kind}:${profileId}:${scopeKey}:${entry.name}`, candidateRef: entry.candidateRef }
    }
    if (this.owners.skills !== null
      && ['project', 'user'].includes(scopeKey)
      && (scopeKey !== 'project' || projectRoot !== null)) {
      const options = scopeKey === 'project' ? { cwd: projectRoot } : {}
      const view = await this.owners.skills.snapshot(options)
      for (const item of view.skills.map(record).filter((item): item is Record<string, unknown> => item !== undefined)
        .sort((left, right) => String(left.name).localeCompare(String(right.name)))) {
        if (typeof item.name !== 'string' || item.provider === 'extension-center') continue
        const identity = catalogTarget('skill', item.name)
        if (knownTargets.has(identity.targetKey)) continue
        knownTargets.add(identity.targetKey)
        const invocation = record(item.invocation)
        let loaded: Record<string, unknown> | undefined
        try {
          loaded = record(await this.owners.skills.get(item.name, options))
        } catch {
          loaded = undefined
        }
        const loadedInvocation = record(loaded?.invocation)
        const definitionLoaded = loaded?.name === item.name
          && loaded.provider === item.provider
          && typeof loaded.content === 'string'
          && loadedInvocation?.modelInvocable === invocation?.modelInvocable
          && loadedInvocation?.userInvocable === invocation?.userInvocable
        const runtimeReady = view.complete && definitionLoaded
        output.push({
          schemaVersion: 1, kind: 'skill', extensionId: item.name, candidateRef: identity.candidateRef,
          targetKey: identity.targetKey, scopeKey, profileId, ownership: 'external', desired: 'enabled',
          materialized: 'configured', effective: runtimeReady ? 'active' : 'degraded',
          agentVisibility: runtimeReady ? 'visible' : 'not-visible', verification: runtimeReady ? 'runtime' : 'structural',
          rollback: 'unavailable', managedRevision: `external:skill:${canonicalSha256(item)}`,
          ownerRevision: `skills:${canonicalSha256(view)}`, configurationRevision: null, observedAtMs: 0,
          updateObservation: identity.candidateRef === null ? { status: 'unknown' } : { status: 'none' },
          evidence: {
            kind: 'skill', contentRevision: null, catalogComplete: view.complete,
            winningProvider: typeof item.provider === 'string' ? item.provider : null,
            winningPath: typeof loaded?.path === 'string' ? loaded.path : null,
            definitionLoaded,
            invocation: typeof invocation?.modelInvocable === 'boolean' && typeof invocation.userInvocable === 'boolean'
              ? { modelInvocable: invocation.modelInvocable, userInvocable: invocation.userInvocable } : null,
          },
        })
      }
    }
    if (this.owners.mcpConnections !== null && scopeKey === 'profile:web') {
      const snapshot = this.owners.mcpConnections.snapshot()
      for (const raw of [...snapshot.connections].map(record).filter((item): item is Record<string, unknown> => item !== undefined)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
        if (typeof raw.id !== 'string' || knownMcpConnections.has(raw.id)) continue
        const identity = catalogTarget('mcp', raw.id)
        if (knownTargets.has(identity.targetKey)) continue
        knownTargets.add(identity.targetKey)
        const desired = record(raw.desired)
        const observed = record(raw.observed)
        const tools = record(raw.tools)
        const names = Array.isArray(tools?.names) ? tools.names.filter((name): name is string => typeof name === 'string').sort() : []
        const state = observed?.state === 'ready' ? 'ready' : observed?.state === 'disabled' ? 'disabled'
          : observed?.state === 'connecting' ? 'starting' : observed?.state === 'error' ? 'degraded' : 'unknown'
        const enabled = desired?.enabled === true
        output.push({
          schemaVersion: 1, kind: 'mcp', extensionId: raw.id, candidateRef: identity.candidateRef,
          targetKey: identity.targetKey, scopeKey, profileId, ownership: 'external',
          desired: enabled ? 'enabled' : 'disabled', materialized: 'configured',
          effective: state === 'ready' ? 'active' : state === 'disabled' ? 'inactive' : state === 'starting' ? 'starting' : 'degraded',
          agentVisibility: state === 'ready' && names.length > 0 ? 'visible' : 'not-visible',
          verification: state === 'ready' ? 'runtime' : 'structural', rollback: 'unavailable',
          managedRevision: `external:mcp:${String(raw.revision ?? 0)}`, ownerRevision: `mcp:${String(raw.revision ?? 0)}`,
          configurationRevision: canonicalSha256(desired ?? null), observedAtMs: 0,
          updateObservation: identity.candidateRef === null ? { status: 'unknown' } : { status: 'none' },
          evidence: {
            kind: 'mcp', descriptorMatches: true, descriptorDigest: null, descriptorRevision: String(raw.revision ?? ''),
            transport: record(desired?.transport)?.transport === 'stdio' ? 'stdio'
              : record(desired?.transport)?.transport === 'streamable-http' ? 'http' : null,
            desiredEnabled: enabled, observedLifecycle: state, liveDetailAvailable: true,
            toolGeneration: Number.isSafeInteger(tools?.generation) ? tools!.generation as number : null,
            qualifiedTools: names,
          },
        })
      }
      for (const raw of [...snapshot.removed].map(record).filter((item): item is Record<string, unknown> => item !== undefined)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
        if (typeof raw.id !== 'string' || knownMcpConnections.has(raw.id)) continue
        const identity = catalogTarget('mcp', raw.id)
        if (knownTargets.has(identity.targetKey)) continue
        knownTargets.add(identity.targetKey)
        output.push({
          schemaVersion: 1, kind: 'mcp', extensionId: raw.id, candidateRef: identity.candidateRef,
          targetKey: identity.targetKey, scopeKey, profileId, ownership: 'external', desired: 'removed',
          materialized: 'absent', effective: 'inactive', agentVisibility: 'not-visible', verification: 'structural',
          rollback: 'available', managedRevision: `external:mcp-removed:${String(raw.revision ?? 0)}`,
          ownerRevision: `mcp:${String(raw.revision ?? 0)}`, configurationRevision: null, observedAtMs: 0,
          updateObservation: identity.candidateRef === null ? { status: 'unknown' } : { status: 'none' },
          evidence: { kind: 'mcp', descriptorMatches: true, descriptorDigest: null, descriptorRevision: String(raw.revision ?? ''), transport: null,
            desiredEnabled: false, observedLifecycle: 'absent', liveDetailAvailable: true,
            toolGeneration: null, qualifiedTools: [] },
        })
      }
    }
    if (this.owners.loader !== null && scopeKey === 'profile:web') {
      await this.owners.loader.await()
      const entries = [...this.owners.loader.entries()].filter(entry => !entry.options.group)
        .sort((left, right) => left.id.localeCompare(right.id))
      for (const entry of entries) {
        const identity = catalogTarget('plugin', entry.options.name)
        if (knownTargets.has(identity.targetKey)) continue
        knownTargets.add(identity.targetKey)
        const active = !entry.disabled && entry.fiber?.state === 2
        const ownership = entry.options.name.startsWith('@deepseek-ai/') || entry.options.name.startsWith('cordis:')
          ? 'system'
          : 'external'
        output.push({
          schemaVersion: 1, kind: 'plugin', extensionId: entry.options.name, candidateRef: identity.candidateRef,
          targetKey: identity.targetKey, scopeKey, profileId, ownership,
          desired: entry.disabled ? 'disabled' : 'enabled', materialized: 'configured',
          effective: active ? 'active' : entry.disabled ? 'inactive' : 'degraded',
          agentVisibility: active ? 'visible' : 'not-visible', verification: active ? 'runtime' : 'structural',
          rollback: 'unavailable', managedRevision: `loader:${entry.id}:${String(entry.fiber?.state ?? -1)}`,
          ownerRevision: `loader:${entry.id}:${String(entry.fiber?.state ?? -1)}`, configurationRevision: null, observedAtMs: 0,
          updateObservation: identity.candidateRef === null ? { status: 'unknown' } : { status: 'none' },
          evidence: { kind: 'plugin', profileGeneration: null,
            loaderPhase: active ? 'active' : entry.disabled ? 'disabled' : 'failed',
            consumerObserved: active, externalRestartObserved: active },
        })
      }
    }
    return output
  }

  private async centerRow(value: ManagedTargetRecord): Promise<Omit<InventoryRow, 'actions'>> {
    const current = value.current
    const evidenceVersion = retained(value)
    const configured = current === null
      ? false
      : value.kind !== 'mcp' || kindState(current).configured === true
    const evidence = value.kind === 'skill'
      ? await this.skillEvidence(value, evidenceVersion)
      : value.kind === 'mcp'
        ? await this.mcpEvidence(evidenceVersion)
        : await this.pluginEvidence(value, evidenceVersion)
    const effective = value.pending !== null
        ? 'restart-required'
      : current === null
        ? 'inactive'
        : evidence.kind === 'skill'
          ? !current.enabled ? 'inactive'
            : evidence.definitionLoaded && evidence.winningProvider === 'extension-center' ? 'active' : 'degraded'
          : evidence.kind === 'mcp'
            ? evidence.descriptorMatches && evidence.observedLifecycle === 'ready' ? 'active'
              : evidence.observedLifecycle === 'disabled' ? 'inactive'
                : evidence.observedLifecycle === 'starting' ? 'starting' : 'degraded'
            : evidence.consumerObserved && evidence.externalRestartObserved ? 'active'
              : current !== null
                && kindState(current).consumerObserved === true
                && kindState(current).externalRestartObserved === true ? 'degraded' : 'restart-required'
    const visibility = evidence.kind === 'skill'
      ? current?.enabled === true
        && evidence.definitionLoaded
        && evidence.winningProvider === 'extension-center' ? 'visible' : 'not-visible'
      : evidence.kind === 'mcp'
        ? evidence.descriptorMatches && evidence.observedLifecycle === 'ready' && evidence.qualifiedTools.length > 0
          ? 'visible' : 'not-visible'
        : evidence.consumerObserved && evidence.loaderPhase === 'active' ? 'visible' : 'not-visible'
    return immutableJsonClone({
      schemaVersion: 1,
      kind: value.kind,
      extensionId: value.extensionId,
      candidateRef: evidenceVersion?.candidateRef ?? null,
      targetKey: value.targetKey,
      scopeKey: value.scopeKey,
      profileId: value.profileId,
      ownership: 'center',
      desired: current === null ? 'removed' : current.enabled ? 'enabled' : 'disabled',
      materialized: current === null ? 'absent' : configured ? 'configured' : 'installed',
      effective,
      agentVisibility: visibility,
      verification: effective === 'active' ? 'runtime' : current === null ? 'unverified' : 'structural',
      rollback: value.lastGood !== null || value.removed !== null ? 'available' : 'unavailable',
      managedRevision: `center:${String(value.revision)}`,
      ownerRevision: current?.ownerRevision ?? evidenceVersion?.ownerRevision ?? 'owner:absent',
      configurationRevision: current === null || !configured ? null : canonicalSha256(current.configuration),
      observedAtMs: value.updatedAtMs,
      updateObservation: updateObservation(this.catalog(), value, current),
      evidence,
    }) as unknown as Omit<InventoryRow, 'actions'>
  }

  private async skillEvidence(value: ManagedTargetRecord, version: ManagedVersion | null): Promise<InventoryRow['evidence']> {
    if (version === null || this.owners.skills === null) return {
      kind: 'skill', contentRevision: null, catalogComplete: false, winningProvider: null,
      winningPath: null, definitionLoaded: false, invocation: null,
    }
    const state = kindState(version)
    const options = value.scopeKey === 'project'
      ? { cwd: record(version.configuration)?.projectRoot }
      : {}
    const snapshot = await this.owners.skills.snapshot(options)
    let inspection: Awaited<ReturnType<typeof inspectSkillArtifact>> | null = null
    try {
      inspection = await inspectSkillArtifact(version.materialPath, version.artifactIntegrity)
    } catch {
      inspection = null
    }
    if (inspection === null || !inspection.matchesExpected) return {
      kind: 'skill',
      contentRevision: inspection?.integrity ?? null,
      catalogComplete: snapshot.complete,
      winningProvider: null,
      winningPath: null,
      definitionLoaded: false,
      invocation: null,
    }
    const winner = (snapshot.skills as readonly unknown[]).map(record).find(item => item?.name === state.skillName)
    let loaded: Record<string, unknown> | undefined
    try {
      loaded = record(await this.owners.skills.get(String(state.skillName), options))
    } catch {
      loaded = undefined
    }
    const invocation = record(winner?.invocation)
    const loadedInvocation = record(loaded?.invocation)
    const winnerResourceBase = record(winner?.resourceBase)
    const winnerMatchesMaterial = winner?.provider === 'extension-center'
      && winnerResourceBase?.kind === 'directory'
      && winnerResourceBase.path === dirname(version.materialPath)
    const definitionLoaded = winnerMatchesMaterial
      && loaded !== undefined
      && loaded.name === state.skillName
      && loaded.provider === 'extension-center'
      && loaded.path === version.materialPath
      && typeof loaded.content === 'string'
      && loadedInvocation?.modelInvocable === invocation?.modelInvocable
      && loadedInvocation?.userInvocable === invocation?.userInvocable
    return {
      kind: 'skill',
      contentRevision: inspection.integrity,
      catalogComplete: snapshot.complete,
      winningProvider: typeof winner?.provider === 'string' ? winner.provider : null,
      winningPath: typeof loaded?.path === 'string' ? loaded.path : null,
      definitionLoaded,
      invocation: typeof invocation?.modelInvocable === 'boolean' && typeof invocation.userInvocable === 'boolean'
        ? { modelInvocable: invocation.modelInvocable, userInvocable: invocation.userInvocable }
        : null,
    }
  }

  private async mcpEvidence(version: ManagedVersion | null): Promise<InventoryRow['evidence']> {
    if (version === null || this.owners.mcpConnections === null || this.inspectManagedMcp === null) return {
      kind: 'mcp', descriptorMatches: false, descriptorDigest: null, descriptorRevision: null, transport: null, desiredEnabled: false,
      observedLifecycle: 'absent', liveDetailAvailable: false, toolGeneration: null, qualifiedTools: [],
    }
    return { kind: 'mcp', ...await this.inspectManagedMcp(version) }
  }

  private async pluginEvidence(value: ManagedTargetRecord, version: ManagedVersion | null): Promise<InventoryRow['evidence']> {
    const state = version === null ? undefined : kindState(version)
    const generation = typeof state?.profileGeneration === 'string' ? state.profileGeneration : null
    const packageName = typeof state?.packageName === 'string' ? state.packageName : null
    const treeDigest = typeof state?.treeDigest === 'string' ? state.treeDigest : null
    if (generation === null || packageName === null || treeDigest === null
      || this.owners.profileTransactions === null || this.owners.loader === null) {
      return {
        kind: 'plugin', profileGeneration: generation, loaderPhase: null,
        consumerObserved: false, externalRestartObserved: false,
      }
    }
    try {
      const profile = await this.owners.profileTransactions.snapshot(value.profileId)
      const generationMatches = profile.profile === value.profileId
        && profile.activeGeneration === generation
        && profile.treeDigest === treeDigest
        && profile.bootStatus === 'verified'
      await this.owners.loader.await()
      const entries = [...this.owners.loader.entries()].filter(entry => !entry.options.group
        && (entry.options.id === packageName || entry.options.name === packageName))
      const active = entries.some(entry => entry.options.id === packageName
        && entry.options.name === packageName
        && !entry.disabled
        && entry.fiber?.state === 2)
      const expectedPresent = value.current !== null
      const consumerObserved = generationMatches && (expectedPresent ? active : entries.length === 0)
      return {
        kind: 'plugin',
        profileGeneration: generation,
        loaderPhase: consumerObserved ? expectedPresent ? 'active' : 'absent' : 'failed',
        consumerObserved,
        externalRestartObserved: generationMatches,
      }
    } catch {
      return {
        kind: 'plugin', profileGeneration: generation, loaderPhase: 'failed',
        consumerObserved: false, externalRestartObserved: false,
      }
    }
  }
}
