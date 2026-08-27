import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type { InventoryRow } from '../inventory/index.ts'
import type {
  CapabilityNeed,
  CapabilityResolution,
  CapabilityResolutionInput,
  ExistingCapability,
  RetrievedCandidate,
} from './types.ts'

const TAG = /^[a-z0-9]+(?:[./-][a-z0-9]+)*$/
const PERMISSION_KINDS = new Set(['credentials', 'filesystem', 'model-context', 'network', 'subprocess'])
const PERMISSION_ACCESS = new Set(['execute', 'none', 'read', 'send', 'write'])

interface RankedCandidate {
  readonly projection: RetrievedCandidate
  readonly materialIdentityDigest: `sha256:${string}`
}

function normalizedTags(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map(value => value.trim().toLowerCase()).filter(value => TAG.test(value)))].sort())
}

function canonicalNeed(value: CapabilityNeed): CapabilityNeed {
  return immutableJsonClone({
    ...value,
    outcomeTags: normalizedTags(value.outcomeTags),
    inputModalities: [...new Set(value.inputModalities)].sort(),
    outputModalities: [...new Set(value.outputModalities)].sort(),
    requiredDataAccess: [...new Set(value.requiredDataAccess)].sort(),
    maximumAuthority: [...new Set(value.maximumAuthority)].sort(),
  }) as unknown as CapabilityNeed
}

function existingSatisfies(need: CapabilityNeed, capability: ExistingCapability): boolean {
  if (!capability.visible || !capability.observationComplete || !capability.authorityKnown) return false
  const tags = new Set(normalizedTags(capability.outcomeTags))
  const access = new Set(capability.dataAccess)
  const maximum = new Set(need.maximumAuthority)
  return need.outcomeTags.every(tag => tags.has(tag))
    && need.requiredDataAccess.every(item => access.has(item))
    && capability.authority.every(item => maximum.has(item))
}

function managementAction(row: InventoryRow): 'configure' | 'enable' | 'update' | 'restore' | undefined {
  if (row.materialized !== 'absent' && row.configurationRevision === null && row.actions.configure.status === 'available') {
    return 'configure'
  }
  if (row.materialized !== 'absent' && row.desired === 'disabled' && row.actions.enable.status === 'available') {
    return 'enable'
  }
  if (row.effective === 'activation-failed' && row.actions.restore.status === 'available') return 'restore'
  if (row.updateObservation.status === 'available' && row.actions.update.status === 'available') return 'update'
  return undefined
}

function inventoryMatches(need: CapabilityNeed, row: InventoryRow): boolean {
  if (row.candidateRef === null) return false
  const tags = normalizedTags(row.candidateRef.split(/[:@/_-]/u))
  return need.outcomeTags.every(tag => tags.includes(tag))
}

function authorityFlags(entry: CapabilityResolutionInput['catalog'][number]): readonly string[] | null {
  const flags: string[] = []
  for (const permission of entry.permissions) {
    if (!PERMISSION_KINDS.has(permission.kind) || !PERMISSION_ACCESS.has(permission.access)) return null
    if (permission.access !== 'none') flags.push(`${permission.kind}:${permission.access}`)
  }
  return Object.freeze([...new Set(flags)].sort())
}

function maximumAllows(need: CapabilityNeed, flags: readonly string[]): boolean {
  const maximum = new Set(need.maximumAuthority)
  return flags.every((flag) => {
    if (flag.startsWith('network:')) return maximum.has('network')
    if (flag === 'filesystem:read') return maximum.has('filesystem-read')
    if (flag === 'filesystem:write') return maximum.has('filesystem-write')
    if (flag.startsWith('subprocess:')) return maximum.has('subprocess')
    if (flag.startsWith('credentials:')) return maximum.has('credentials')
    if (flag.startsWith('model-context:')) return maximum.has('model-context')
    return false
  })
}

function requiredAccessSatisfied(need: CapabilityNeed, flags: readonly string[]): boolean {
  return need.requiredDataAccess.every((required) => {
    if (required === 'network') return flags.some(flag => flag.startsWith('network:'))
    if (required === 'filesystem-read') return flags.includes('filesystem:read') || flags.includes('filesystem:write')
    if (required === 'filesystem-write') return flags.includes('filesystem:write')
    return flags.some(flag => flag.startsWith('subprocess:'))
  })
}

function retrieve(input: CapabilityResolutionInput, need: CapabilityNeed): RankedCandidate[] {
  const values: RankedCandidate[] = []
  for (const entry of input.catalog) {
    const policy = input.policy.get(entry.candidateRef)
    if (policy?.status !== 'eligible' || !entry.compatibility.platforms.includes(need.platform)) continue
    const flags = authorityFlags(entry)
    if (flags === null || !maximumAllows(need, flags) || !requiredAccessSatisfied(need, flags)) continue
    const tags = normalizedTags(entry.tags)
    const matchedTags = need.outcomeTags.filter(tag => tags.includes(tag))
    if (matchedTags.length !== need.outcomeTags.length) continue
    const requiredAccessCoverage = need.requiredDataAccess.filter((required) => {
      if (required === 'network') return flags.some(flag => flag.startsWith('network:'))
      if (required === 'filesystem-read') return flags.includes('filesystem:read') || flags.includes('filesystem:write')
      if (required === 'filesystem-write') return flags.includes('filesystem:write')
      return flags.some(flag => flag.startsWith('subprocess:'))
    }).length
    const score = matchedTags.length * 100
      + requiredAccessCoverage * 20
      + (entry.scopes.length === 1 ? 5 : 0)
      - flags.length
    values.push(Object.freeze({
      projection: Object.freeze({
        candidateRef: entry.candidateRef,
        kind: entry.kind,
        artifactRevision: entry.artifact.version,
        matchedTags: Object.freeze(matchedTags),
        score,
        authorityFlags: flags,
        scopes: Object.freeze([...entry.scopes].sort()),
        policy,
      }),
      materialIdentityDigest: canonicalSha256({
        publisher: entry.publisher,
        source: entry.source,
        artifact: entry.artifact,
      }),
    }))
  }
  return values.sort((left, right) =>
    right.projection.score - left.projection.score
      || left.projection.candidateRef.localeCompare(right.projection.candidateRef))
}

function materiallyDifferent(left: RankedCandidate, right: RankedCandidate): boolean {
  return left.projection.kind !== right.projection.kind
    || left.projection.authorityFlags.join('\u0000') !== right.projection.authorityFlags.join('\u0000')
    || left.projection.scopes.join('\u0000') !== right.projection.scopes.join('\u0000')
    || left.materialIdentityDigest !== right.materialIdentityDigest
}

/**
 * Resolve existing capability, existing management, or an admitted local catalog candidate in that order.
 * @param input Complete current-scope and catalog observations with deterministic policy results.
 * @returns Closed decision without executable installation material or untrusted prose.
 */
export function resolveCapability(input: CapabilityResolutionInput): CapabilityResolution {
  const need = canonicalNeed(input.need)
  const needDigest = canonicalSha256(need)
  const existing = [...input.existing]
    .filter(capability => existingSatisfies(need, capability))
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))[0]
  if (existing !== undefined) {
    return Object.freeze({ decision: 'use-existing', needDigest, capabilityId: existing.capabilityId })
  }
  if (!input.inventoryComplete) return Object.freeze({ decision: 'discovery-unavailable', needDigest })
  const management = input.inventory
    .filter(row => inventoryMatches(need, row))
    .map(row => ({ row, action: managementAction(row) }))
    .filter((value): value is { row: InventoryRow; action: 'configure' | 'enable' | 'update' | 'restore' } =>
      value.action !== undefined)
    .sort((left, right) => left.row.targetKey.localeCompare(right.row.targetKey))[0]
  if (management !== undefined) {
    return Object.freeze({
      decision: 'management-required',
      needDigest,
      extensionRef: management.row.targetKey,
      action: management.action,
    })
  }
  if (!input.catalogComplete) return Object.freeze({ decision: 'discovery-unavailable', needDigest })
  const maximumCandidates = Math.max(1, Math.min(3, Math.trunc(input.maximumCandidates)))
  const candidates = retrieve(input, need).slice(0, maximumCandidates)
  if (candidates.length === 0) return Object.freeze({ decision: 'no-eligible-candidate', needDigest })
  const best = candidates[0]!
  const alternatives = candidates.slice(1).filter(candidate =>
    candidate.projection.score * 1.25 >= best.projection.score && materiallyDifferent(best, candidate))
  if (alternatives.length > 0) {
    return Object.freeze({
      decision: 'choice-required',
      needDigest,
      candidates: Object.freeze([best, ...alternatives].map(candidate => candidate.projection)),
    })
  }
  return Object.freeze({ decision: 'acquisition-candidate', needDigest, candidate: best.projection })
}
