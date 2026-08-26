import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { createInventorySnapshot } from '../src/inventory/index.ts'
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
  }, { profileTransaction: true, dynamicMcpConnection: true, durableContinuation: true })
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
