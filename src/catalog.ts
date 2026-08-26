import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  EXTENSION_CENTER_PROTOCOL_VERSION,
  type CatalogEntry,
  type CatalogEnvelope,
  type CatalogHostCapabilities,
  type CatalogListResponse,
  type CatalogRoot,
  type CatalogSignature,
} from './catalog-contract.ts'
import {
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_ROOT,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from './catalog-data.ts'
import type { CatalogAdmissionStatus } from './catalog-refresh.ts'

const PACKAGE_PINNED_REVIEW_IDENTITIES = Object.freeze([
  Object.freeze({
    kind: 'plugin',
    candidateRef: 'plugin:dsh-capability-resolver@0.1.0',
    name: 'dsh-capability-resolver',
    artifact: Object.freeze({
      id: 'dsh-capability-resolver',
      version: '0.1.0',
      integrity: 'sha256:895e1e44ee9edaff0c4982c671379bbc3122e2c0189250e9870ee70102f2c27e',
      sizeBytes: 92_128,
    }),
  }),
  Object.freeze({
    kind: 'skill',
    candidateRef: 'skill:github-awesome-copilot/documentation-writer@d0d9d9f014abb27bf0d8321851867500a3a46bba',
    name: 'documentation-writer',
    artifact: Object.freeze({
      id: 'skills/documentation-writer/SKILL.md',
      version: 'd0d9d9f014abb27bf0d8321851867500a3a46bba',
      integrity: 'sha256:7e8244988c9f4eb63bf8c0edf160578544621eb96e5e51e2d848f1401c5de8f1',
      sizeBytes: 2_748,
    }),
  }),
])

/** How the Host can construct candidate-bound review evidence before authorization. */
export type CatalogReviewEvidenceSupport = 'package-pinned' | 'runtime-bound' | 'unavailable'

/** Reject signed eligibility that has no exact review record understood by this package build. */
export function catalogReviewEvidenceSupport(entry: CatalogEntry): CatalogReviewEvidenceSupport {
  if (entry.kind === 'mcp') return 'runtime-bound'
  const identity = {
    kind: entry.kind,
    candidateRef: entry.candidateRef,
    name: entry.name,
    artifact: {
      id: entry.artifact.id,
      version: entry.artifact.version,
      integrity: entry.artifact.integrity,
      sizeBytes: entry.artifact.sizeBytes,
    },
  }
  return PACKAGE_PINNED_REVIEW_IDENTITIES.some(candidate => canonicalJson(candidate) === canonicalJson(identity))
    ? 'package-pinned'
    : 'unavailable'
}

/** Recursively canonicalize JSON-compatible data with lexicographically sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('catalog canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => {
      const child = record[key]
      if (child === undefined) throw new Error(`catalog canonical JSON rejects undefined field ${key}`)
      return `${JSON.stringify(key)}:${canonicalJson(child)}`
    }).join(',')}}`
  }
  throw new Error(`catalog canonical JSON rejects ${typeof value}`)
}

/** Hash one canonical JSON value. */
export function canonicalSha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

/** Verified immutable catalog plus the accepted signing key ids. */
export interface VerifiedCatalog {
  readonly envelope: CatalogEnvelope
  readonly keyIds: readonly string[]
}

/** Validate and verify one immutable catalog against a packaged trust root. */
export function verifyCatalog(
  root: CatalogRoot,
  envelope: CatalogEnvelope,
  signatures: readonly CatalogSignature[],
  now = Date.now(),
): VerifiedCatalog {
  if (root.catalogId !== envelope.catalogId) throw new Error('catalog id does not match the packaged trust root')
  if (envelope.revision < root.minimumRevision) throw new Error('catalog revision is below the packaged minimum')
  if (!Number.isSafeInteger(envelope.revision) || envelope.revision < 1) throw new Error('catalog revision is invalid')
  if (envelope.revision === 1 && envelope.previousRevisionDigest !== null) {
    throw new Error('catalog revision 1 must not name a previous revision')
  }
  if (
    envelope.revision > 1
    && (envelope.previousRevisionDigest === null
      || !/^sha256:[a-f0-9]{64}$/.test(envelope.previousRevisionDigest))
  ) {
    throw new Error('catalog revision must name a valid previous revision digest')
  }
  const issuedAt = Date.parse(envelope.issuedAt)
  const expiresAt = Date.parse(envelope.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt) {
    throw new Error('catalog validity interval is invalid')
  }
  if (now < issuedAt) throw new Error('catalog is not valid yet')
  if (now >= expiresAt || now - issuedAt > root.maximumAgeMs) throw new Error('catalog is expired')
  if (canonicalSha256(envelope.entries) !== envelope.entriesDigest) throw new Error('catalog entries digest mismatch')

  const refs = new Set<string>()
  for (const entry of envelope.entries) {
    if (refs.has(entry.candidateRef)) throw new Error(`duplicate candidateRef: ${entry.candidateRef}`)
    refs.add(entry.candidateRef)
    if (!entry.candidateRef.startsWith(`${entry.kind}:`)) throw new Error(`candidate kind mismatch: ${entry.candidateRef}`)
    if (entry.artifact.version === 'latest' || entry.source.revision === 'main' || entry.source.revision === 'master') {
      throw new Error(`moving artifact reference is forbidden: ${entry.candidateRef}`)
    }
    if (entry.scopes.length === 0) throw new Error(`candidate has no target scope: ${entry.candidateRef}`)
    if (catalogReviewEvidenceSupport(entry) === 'unavailable') {
      throw new Error(`candidate has no exact review evidence record: ${entry.candidateRef}`)
    }
    if (
      (entry.license.status === 'unknown' && (entry.license.spdx !== null || entry.license.sourceUrl !== null))
      || (entry.license.status !== 'unknown' && (entry.license.spdx === null || entry.license.sourceUrl === null))
    ) {
      throw new Error(`candidate license evidence is inconsistent: ${entry.candidateRef}`)
    }
    for (const [action, availability] of Object.entries(entry.lifecycle)) {
      if (
        (availability.status === 'available' && availability.reason !== undefined)
        || (availability.status === 'unavailable'
          && (availability.reason === undefined || availability.reason.trim() === ''))
      ) {
        throw new Error(`catalog lifecycle claim is invalid for ${entry.candidateRef}: ${action}`)
      }
    }
  }

  const rootKeys = new Map(root.keys.map(key => [key.keyId, key]))
  const accepted = new Set<string>()
  const bytes = Buffer.from(canonicalJson(envelope))
  for (const signature of signatures) {
    const key = rootKeys.get(signature.keyId)
    if (key === undefined || key.algorithm !== signature.algorithm || accepted.has(signature.keyId)) continue
    if (verify(null, bytes, createPublicKey(key.publicKeyPem), Buffer.from(signature.value, 'base64'))) {
      accepted.add(signature.keyId)
    }
  }
  if (accepted.size < root.threshold) throw new Error('catalog signature threshold was not met')
  return { envelope, keyIds: [...accepted].sort() }
}

/** Verify the packaged offline bootstrap catalog. */
export function verifyBootstrapCatalog(now = Date.now()): VerifiedCatalog {
  return verifyCatalog(
    BOOTSTRAP_CATALOG_ROOT,
    BOOTSTRAP_CATALOG_ENVELOPE,
    BOOTSTRAP_CATALOG_SIGNATURES,
    now,
  )
}

/** Project a verified catalog onto the private browser RPC. */
export function catalogListResponse(
  catalog: VerifiedCatalog,
  hostCapabilities: CatalogHostCapabilities = {
    profileTransaction: false,
    dynamicMcpConnection: false,
    durableContinuation: false,
    skillRegistry: false,
    toolRegistry: false,
    loaderObservation: false,
    acquisition: false,
    reason: 'host-capability',
  },
  admission: CatalogAdmissionStatus = {
    source: 'bootstrap',
    freshness: 'bootstrap',
    degraded: false,
    degradedReason: null,
    lastRefreshAtMs: null,
  },
): CatalogListResponse {
  const { envelope } = catalog
  const ownersAvailable = hostCapabilities.profileTransaction
    && hostCapabilities.dynamicMcpConnection
    && hostCapabilities.durableContinuation
    && hostCapabilities.skillRegistry
    && hostCapabilities.toolRegistry
    && hostCapabilities.loaderObservation
  if (
    (hostCapabilities.acquisition && !ownersAvailable)
    || hostCapabilities.reason !== (hostCapabilities.acquisition ? null : 'host-capability')
  ) {
    throw new TypeError('Host acquisition claim requires all owners and a ready writable runtime')
  }
  return {
    protocolVersion: EXTENSION_CENTER_PROTOCOL_VERSION,
    catalog: {
      id: envelope.catalogId,
      revision: envelope.revision,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      entriesDigest: envelope.entriesDigest,
      signatureStatus: 'verified',
      keyIds: catalog.keyIds,
      source: admission.source,
      freshness: admission.freshness,
      degraded: admission.degraded,
      degradedReason: admission.degradedReason,
      lastRefreshAtMs: admission.lastRefreshAtMs,
    },
    hostCapabilities,
    entries: envelope.entries,
  }
}
