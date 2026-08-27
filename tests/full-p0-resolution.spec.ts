import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { createInventorySnapshot } from '../src/inventory/index.ts'
import { taskAcquisitionCandidates } from '../src/kind-candidates.ts'
import { resolveCapability, type CapabilityNeed } from '../src/resolution/index.ts'

const need: CapabilityNeed = {
  schemaVersion: 1,
  outcomeTags: ['filesystem'],
  inputModalities: ['text'],
  outputModalities: ['structured-data'],
  scopeKey: 'agent:1:/workspace',
  platform: 'darwin',
  requiredDataAccess: ['filesystem-read'],
  maximumAuthority: ['network', 'filesystem-read', 'filesystem-write', 'subprocess'],
}

const eligible = {
  status: 'eligible' as const,
  policyRevision: 'extension-center-p0-policy-v2',
  authorityDigest: canonicalSha256({ authority: 1 }),
}

function emptyInventory() {
  return createInventorySnapshot({
    scopeKey: need.scopeKey,
    profileId: 'profile:web',
    complete: true,
    observedAtMs: 1,
    rows: [],
  }, {
    managedPluginLifecycle: true,
    dynamicMcpConnection: true,
    durableContinuation: true,
    skillRegistry: true,
    toolRegistry: true,
    loaderMutation: true,
    acquisition: true,
  })
}

describe('full P0 existing-first local Capability RAG', () => {
  it('short-circuits on a complete current Agent-visible capability without catalog acquisition', () => {
    const inventory = emptyInventory()
    expect(resolveCapability({
      need,
      existing: [{
        capabilityId: 'tool:workspace/read',
        kind: 'tool',
        outcomeTags: ['filesystem'],
        dataAccess: ['filesystem-read'],
        authority: ['filesystem-read'],
        authorityKnown: true,
        visible: true,
        observationComplete: true,
      }],
      inventory: inventory.rows,
      inventoryComplete: inventory.complete,
      catalog: BOOTSTRAP_CATALOG_ENVELOPE.entries,
      catalogComplete: true,
      policy: new Map(),
      maximumCandidates: 3,
    })).toMatchObject({ decision: 'use-existing', capabilityId: 'tool:workspace/read' })
  })

  it('fails closed when existing authority is unknown or exceeds the task maximum', () => {
    const inventory = emptyInventory()
    const existing = {
      capabilityId: 'tool:workspace/read',
      kind: 'tool' as const,
      outcomeTags: ['filesystem'],
      dataAccess: ['filesystem-read'] as const,
      authority: ['filesystem-read'] as const,
      visible: true,
      observationComplete: true,
    }
    const resolve = (candidate: typeof existing & { readonly authorityKnown: boolean }, maximumAuthority: CapabilityNeed['maximumAuthority']) =>
      resolveCapability({
        need: { ...need, maximumAuthority },
        existing: [candidate],
        inventory: inventory.rows,
        inventoryComplete: false,
        catalog: [],
        catalogComplete: false,
        policy: new Map(),
        maximumCandidates: 3,
      })

    expect(resolve({ ...existing, authorityKnown: false }, ['filesystem-read']))
      .toMatchObject({ decision: 'discovery-unavailable' })
    expect(resolve({ ...existing, authorityKnown: true }, []))
      .toMatchObject({ decision: 'discovery-unavailable' })
    expect(resolve({ ...existing, authorityKnown: true }, ['filesystem-read']))
      .toMatchObject({ decision: 'use-existing', capabilityId: existing.capabilityId })
  })

  it('retrieves and ranks only locally admitted structured catalog candidates', () => {
    const inventory = emptyInventory()
    const mcp = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(entry => entry.kind === 'mcp')!
    const result = resolveCapability({
      need,
      existing: [],
      inventory: inventory.rows,
      inventoryComplete: true,
      catalog: BOOTSTRAP_CATALOG_ENVELOPE.entries,
      catalogComplete: true,
      policy: new Map([[mcp.candidateRef, eligible]]),
      maximumCandidates: 3,
    })
    expect(result).toMatchObject({
      decision: 'acquisition-candidate',
      candidate: { candidateRef: mcp.candidateRef, matchedTags: ['filesystem'] },
    })
    expect(JSON.stringify(result)).not.toContain('acquisitionUrl')
    expect(JSON.stringify(result)).not.toContain(mcp.summary.en)
  })

  it('requires every requested outcome tag and every required data access domain', () => {
    const inventory = emptyInventory()
    const mcp = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(entry => entry.kind === 'mcp')!
    const completeNeed: CapabilityNeed = {
      ...need,
      outcomeTags: ['files', 'filesystem'],
      requiredDataAccess: ['filesystem-write', 'subprocess'],
      maximumAuthority: ['filesystem-write', 'subprocess'],
    }
    const input = {
      need: completeNeed,
      existing: [],
      inventory: inventory.rows,
      inventoryComplete: true,
      catalogComplete: true,
      maximumCandidates: 3,
    } as const
    expect(resolveCapability({
      ...input,
      catalog: [mcp],
      policy: new Map([[mcp.candidateRef, eligible]]),
    })).toMatchObject({
      decision: 'acquisition-candidate',
      candidate: { matchedTags: ['files', 'filesystem'] },
    })
    expect(resolveCapability({
      ...input,
      catalog: [{ ...mcp, tags: ['filesystem'] }],
      policy: new Map([[mcp.candidateRef, eligible]]),
    })).toMatchObject({ decision: 'no-eligible-candidate' })
    expect(resolveCapability({
      ...input,
      catalog: [{ ...mcp, permissions: mcp.permissions.filter(permission => permission.kind !== 'subprocess') }],
      policy: new Map([[mcp.candidateRef, eligible]]),
    })).toMatchObject({ decision: 'no-eligible-candidate' })
  })

  it('covers credentials and model context explicitly and rejects unknown authority values', () => {
    const inventory = emptyInventory()
    const plugin = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(entry => entry.kind === 'plugin')!
    const skill = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(entry => entry.kind === 'skill')!
    const resolve = (candidate: typeof plugin, requirement: CapabilityNeed) => resolveCapability({
      need: requirement,
      existing: [],
      inventory: inventory.rows,
      inventoryComplete: true,
      catalog: [candidate],
      catalogComplete: true,
      policy: new Map([[candidate.candidateRef, eligible]]),
      maximumCandidates: 3,
    })
    const pluginNeed: CapabilityNeed = {
      ...need,
      outcomeTags: ['plugin'],
      requiredDataAccess: [],
      maximumAuthority: ['filesystem-write', 'model-context', 'network', 'subprocess'],
    }
    expect(resolve(plugin, pluginNeed)).toMatchObject({ decision: 'no-eligible-candidate' })
    expect(resolve(plugin, {
      ...pluginNeed,
      maximumAuthority: [...pluginNeed.maximumAuthority, 'credentials'],
    })).toMatchObject({ decision: 'acquisition-candidate' })
    expect(resolve(skill, {
      ...need,
      outcomeTags: ['documentation'],
      requiredDataAccess: [],
      maximumAuthority: ['network'],
    })).toMatchObject({ decision: 'no-eligible-candidate' })
    expect(resolve(skill, {
      ...need,
      outcomeTags: ['documentation'],
      requiredDataAccess: [],
      maximumAuthority: ['model-context', 'network'],
    })).toMatchObject({ decision: 'acquisition-candidate' })
    expect(resolve({
      ...plugin,
      permissions: plugin.permissions.map((permission, index) => index === 0
        ? { ...permission, kind: 'future-authority' as never }
        : permission),
    }, {
      ...pluginNeed,
      maximumAuthority: [...pluginNeed.maximumAuthority, 'credentials'],
    })).toMatchObject({ decision: 'no-eligible-candidate' })
    expect(resolve({
      ...plugin,
      permissions: plugin.permissions.map((permission, index) => index === 0
        ? { ...permission, access: 'root' as never }
        : permission),
    }, {
      ...pluginNeed,
      maximumAuthority: [...pluginNeed.maximumAuthority, 'credentials'],
    })).toMatchObject({ decision: 'no-eligible-candidate' })
  })

  it('requires a human choice for near-scoring candidates with the same kind, authority, and scope', () => {
    const inventory = emptyInventory()
    const mcp = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(entry => entry.kind === 'mcp')!
    const alternative: typeof mcp = {
      ...mcp,
      candidateRef: 'mcp:example/filesystem-mcp@1.3.0',
      publisher: { name: 'example', status: 'community' },
      source: {
        ...mcp.source,
        url: 'https://example.test/releases/filesystem-mcp-1.3.0',
        upstreamUrl: 'https://example.test/filesystem-mcp',
      },
      artifact: {
        ...mcp.artifact,
        id: 'example-filesystem-mcp',
        acquisitionUrl: 'https://example.test/filesystem-mcp-1.3.0.tgz',
      },
    }
    const result = resolveCapability({
      need,
      existing: [],
      inventory: inventory.rows,
      inventoryComplete: true,
      catalog: [mcp, alternative],
      catalogComplete: true,
      policy: new Map([[mcp.candidateRef, eligible], [alternative.candidateRef, eligible]]),
      maximumCandidates: 3,
    })
    expect(result).toMatchObject({ decision: 'choice-required' })
    if (result.decision !== 'choice-required') throw new Error('expected a material candidate choice')
    expect(result.candidates.map(candidate => candidate.candidateRef).sort()).toEqual([
      alternative.candidateRef,
      mcp.candidateRef,
    ].sort())
  })

  it('filters only an exact superseded task candidate and keeps unknown or forked versions as a material choice', () => {
    const [older, current] = BOOTSTRAP_CATALOG_ENVELOPE.entries.filter(entry => entry.kind === 'mcp')
    if (older === undefined || current === undefined) throw new Error('bootstrap MCP update pair is incomplete')
    const unknown = {
      ...current,
      candidateRef: 'mcp:io.github.domdomegg/filesystem-mcp@2.0.0',
      artifact: {
        ...current.artifact,
        version: '2.0.0',
        acquisitionUrl: 'https://registry.npmjs.org/filesystem-mcp/-/filesystem-mcp-2.0.0.tgz',
      },
    }
    const fork = {
      ...current,
      candidateRef: 'mcp:community/filesystem-mcp@1.3.0-fork',
      publisher: { name: 'community', status: 'community' as const },
      artifact: { ...current.artifact, id: 'community-filesystem-mcp', version: '1.3.0-fork' },
    }
    const catalog = taskAcquisitionCandidates(
      [...BOOTSTRAP_CATALOG_ENVELOPE.entries, unknown, fork],
      'profile:web',
      ['filesystem'],
    )
    const candidates = catalog.filter(entry => entry.kind === 'mcp')
    expect(candidates.map(entry => entry.candidateRef).sort()).toEqual([
      current.candidateRef,
      fork.candidateRef,
      unknown.candidateRef,
    ].sort())

    const inventory = emptyInventory()
    const result = resolveCapability({
      need: {
        ...need,
        scopeKey: 'profile:web',
        requiredDataAccess: ['filesystem-write'],
        maximumAuthority: ['filesystem-write', 'subprocess'],
      },
      existing: [],
      inventory: inventory.rows,
      inventoryComplete: true,
      catalog,
      catalogComplete: true,
      policy: new Map(candidates.map(entry => [entry.candidateRef, eligible])),
      maximumCandidates: 3,
    })
    expect(result).toMatchObject({ decision: 'choice-required' })
    if (result.decision !== 'choice-required') throw new Error('expected unknown candidates to remain a material choice')
    expect(result.candidates.map(candidate => candidate.candidateRef).sort()).toEqual([
      current.candidateRef,
      fork.candidateRef,
      unknown.candidateRef,
    ].sort())
  })

  it('does not turn an incomplete observation into a successful empty result', () => {
    const inventory = emptyInventory()
    expect(resolveCapability({
      need,
      existing: [],
      inventory: inventory.rows,
      inventoryComplete: true,
      catalog: [],
      catalogComplete: false,
      policy: new Map(),
      maximumCandidates: 3,
    })).toMatchObject({ decision: 'discovery-unavailable' })
  })
})
