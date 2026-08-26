import { describe, expect, it } from 'vitest'
import { createInventorySnapshot, type InventoryRow } from '../src/inventory/index.ts'

const host = {
  profileTransaction: true,
  dynamicMcpConnection: true,
  durableContinuation: true,
  skillRegistry: true,
  toolRegistry: true,
  loaderObservation: true,
  acquisition: true,
}

function base(kind: 'plugin' | 'mcp' | 'skill', extensionId: string): Omit<InventoryRow, 'actions' | 'evidence'> {
  return {
    schemaVersion: 1,
    kind,
    extensionId,
    candidateRef: `${kind}:${extensionId}@1`,
    targetKey: `${kind}:user/${extensionId}`,
    scopeKey: 'agent:1:/workspace',
    profileId: 'profile:web',
    ownership: 'center',
    desired: 'enabled',
    materialized: 'configured',
    effective: 'active',
    agentVisibility: 'visible',
    verification: 'runtime',
    rollback: 'available',
    managedRevision: 'managed:1',
    ownerRevision: 'owner:1',
    configurationRevision: 'config:1',
    observedAtMs: 10,
    updateObservation: { status: 'none' },
  }
}

describe('full P0 normalized inventory', () => {
  it('keeps all lifecycle dimensions and kind-specific owner evidence separate', () => {
    const snapshot = createInventorySnapshot({
      scopeKey: 'agent:1:/workspace',
      profileId: 'profile:web',
      complete: true,
      observedAtMs: 10,
      rows: [
        {
          ...base('skill', 'alpha'),
          evidence: {
            kind: 'skill',
            contentRevision: 'sha256:skill',
            catalogComplete: true,
            winningProvider: 'filesystem',
            winningPath: '/managed/alpha/SKILL.md',
            definitionLoaded: true,
            invocation: { modelInvocable: true, userInvocable: true },
          },
        },
        {
          ...base('mcp', 'bravo'),
          evidence: {
            kind: 'mcp',
            descriptorMatches: true,
            descriptorDigest: `sha256:${'a'.repeat(64)}`,
            descriptorRevision: 'descriptor:1',
            transport: 'stdio',
            desiredEnabled: true,
            observedLifecycle: 'ready',
            liveDetailAvailable: true,
            toolGeneration: 3,
            qualifiedTools: ['bravo/read'],
          },
        },
        {
          ...base('plugin', 'charlie'),
          evidence: {
            kind: 'plugin',
            profileGeneration: 'generation:4',
            loaderPhase: 'active',
            consumerObserved: true,
            externalRestartObserved: true,
          },
        },
      ],
    }, host)
    expect(snapshot.rows.map(row => row.kind)).toEqual(['mcp', 'plugin', 'skill'])
    expect(snapshot.rows[0]).toMatchObject({
      desired: 'enabled',
      materialized: 'configured',
      effective: 'active',
      agentVisibility: 'visible',
      verification: 'runtime',
      rollback: 'available',
    })
    expect(snapshot.rows.find(row => row.kind === 'plugin')?.actions).toMatchObject({
      enable: { status: 'unavailable', reason: 'plugin-enable-disable-unsupported' },
      disable: { status: 'unavailable', reason: 'plugin-enable-disable-unsupported' },
      uninstall: { status: 'available' },
      restore: { status: 'available' },
    })
  })

  it('is deterministic across input order and disables all writes when an owner is absent', () => {
    const skill = {
      ...base('skill', 'alpha'),
      evidence: {
        kind: 'skill' as const,
        contentRevision: 'sha256:skill',
        catalogComplete: true,
        winningProvider: 'filesystem',
        winningPath: '/managed/alpha/SKILL.md',
        definitionLoaded: true,
        invocation: { modelInvocable: true, userInvocable: true },
      },
    }
    const plugin = {
      ...base('plugin', 'charlie'),
      evidence: {
        kind: 'plugin' as const,
        profileGeneration: 'generation:4',
        loaderPhase: 'active',
        consumerObserved: true,
        externalRestartObserved: true,
      },
    }
    const left = createInventorySnapshot({
      scopeKey: 'agent:1:/workspace', profileId: 'profile:web', complete: true, observedAtMs: 10, rows: [skill, plugin],
    }, host)
    const right = createInventorySnapshot({
      scopeKey: 'agent:1:/workspace', profileId: 'profile:web', complete: true, observedAtMs: 10, rows: [plugin, skill],
    }, host)
    expect(left.revision).toBe(right.revision)

    const gated = createInventorySnapshot({
      scopeKey: 'agent:1:/workspace', profileId: 'profile:web', complete: true, observedAtMs: 10, rows: [plugin],
    }, { ...host, profileTransaction: false })
    expect(Object.values(gated.rows[0]!.actions).every(action =>
      action.status === 'unavailable' && action.reason === 'host-capability')).toBe(true)
  })

  it('rejects visible or active claims without the required owner evidence', () => {
    expect(() => createInventorySnapshot({
      scopeKey: 'agent:1:/workspace',
      profileId: 'profile:web',
      complete: false,
      observedAtMs: 10,
      rows: [{
        ...base('skill', 'alpha'),
        evidence: {
          kind: 'skill',
          contentRevision: 'sha256:skill',
          catalogComplete: false,
          winningProvider: 'filesystem',
          winningPath: '/managed/alpha/SKILL.md',
          definitionLoaded: true,
          invocation: { modelInvocable: true, userInvocable: true },
        },
      }],
    }, host)).toThrow('lacks complete registry evidence')
  })

  it('keeps project-scoped center Skill writes unavailable until a workspace Agent selector exists', () => {
    const projectSkill = {
      ...base('skill', 'project-skill'),
      scopeKey: 'project',
      ownership: 'center' as const,
      evidence: {
        kind: 'skill' as const,
        contentRevision: 'sha256:skill',
        catalogComplete: true,
        winningProvider: 'extension-center',
        winningPath: '/workspace/.agents/skills/project-skill/SKILL.md',
        definitionLoaded: true,
        invocation: { modelInvocable: true, userInvocable: true },
      },
    }
    const snapshot = createInventorySnapshot({
      scopeKey: 'project', profileId: 'profile:web', complete: true, observedAtMs: 10, rows: [projectSkill],
    }, host)

    expect(Object.values(snapshot.rows[0]!.actions)).toHaveLength(8)
    expect(Object.values(snapshot.rows[0]!.actions).every(action => action.status === 'unavailable'
      && action.reason === 'workspace-agent-selector-unavailable')).toBe(true)
  })
})
