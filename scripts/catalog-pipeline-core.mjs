import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto'
import {
  canonicalJson,
  canonicalSha256,
  catalogReviewEvidenceSupport,
  verifyCatalog,
} from '../lib/catalog.js'

const MAX_LEADS = 10_000
const MAX_TEXT = 2_048
const SHA256 = /^sha256:[a-f0-9]{64}$/u
const SHA512 = /^sha512:[A-Za-z0-9+/]+={0,2}$/u
const RECEIPT_DIGEST = /^sha256:[a-f0-9]{64}$/u
const DSH_VERSION = '0.1.1-rc.2'
const LIFECYCLE_ACTIONS = ['install', 'configure', 'update', 'uninstall', 'restore']

function object(value, subject) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`)
  }
  return value
}

function exactObject(value, subject, fields) {
  const record = object(value, subject)
  const actual = Object.keys(record).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${subject} fields are invalid`)
  }
  return record
}

function text(value, subject, { nullable = false, maximum = MAX_TEXT } = {}) {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new Error(`${subject} must be a bounded non-blank string`)
  }
  return value
}

function optionalText(value, subject) {
  return value === undefined || value === null ? null : text(value, subject)
}

function integer(value, subject, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${subject} must be a safe integer`)
  return value
}

function timestamp(value, subject) {
  const parsed = Date.parse(text(value, subject, { maximum: 64 }))
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${subject} must be a canonical ISO timestamp`)
  }
  return value
}

function httpsUrl(value, subject, { query = true } = {}) {
  const source = text(value, subject)
  let url
  try {
    url = new URL(source)
  } catch (cause) {
    throw new Error(`${subject} must be an absolute HTTPS URL`, { cause })
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== ''
    || (!query && url.search !== '') || url.href !== source) {
    throw new Error(`${subject} must be a canonical credential-free HTTPS URL`)
  }
  return source
}

function leadId(value) {
  return `lead:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function rejection(sourceId, index, value, error) {
  let digest
  try {
    digest = canonicalSha256(value)
  } catch {
    digest = `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
  }
  return Object.freeze({
    sourceId,
    index,
    recordDigest: digest,
    reason: error instanceof Error ? error.message.slice(0, 512) : 'lead record is invalid',
  })
}

function sourceReport(sourceId, sourceUrl, retrievedAt, document, parse) {
  timestamp(retrievedAt, 'retrievedAt')
  httpsUrl(sourceUrl, 'sourceUrl')
  const records = parse.records(document)
  if (!Array.isArray(records) || records.length > MAX_LEADS) throw new Error(`${sourceId} lead count exceeds its bound`)
  const documentDigest = canonicalSha256(document)
  const leads = []
  const rejections = []
  records.forEach((value, index) => {
    try {
      leads.push(parse.record(value, {
        sourceId,
        sourceUrl,
        retrievedAt,
        documentDigest,
      }))
    } catch (error) {
      rejections.push(rejection(sourceId, index, value, error))
    }
  })
  leads.sort((left, right) => left.leadId.localeCompare(right.leadId))
  return Object.freeze({
    sourceId,
    sourceUrl,
    retrievedAt,
    documentDigest,
    leads: Object.freeze(leads),
    rejections: Object.freeze(rejections),
  })
}

/** Convert the unofficial DSH directory into non-executable curation leads. */
export function discoverCommunityCatalog(document, sourceUrl, retrievedAt) {
  return sourceReport('dsh-community', sourceUrl, retrievedAt, document, {
    records(value) {
      const root = object(value, 'community catalog')
      return root.plugins
    },
    record(value, source) {
      const row = object(value, 'community plugin')
      const externalId = text(row.name, 'community plugin name', { maximum: 256 })
      const publisherHint = text(row.owner, 'community plugin owner', { maximum: 256 })
      const upstreamUrl = httpsUrl(row.url, 'community plugin URL', { query: false })
      const artifactId = optionalText(row.npm, 'community npm id')
      const category = optionalText(row.category, 'community category')
      const stars = row.stars === null || row.stars === undefined ? null : integer(row.stars, 'community stars')
      const downloads = row.downloads === null || row.downloads === undefined
        ? null
        : integer(row.downloads, 'community downloads')
      const identity = {
        sourceId: source.sourceId,
        sourceDocumentDigest: source.documentDigest,
        externalId,
        upstreamUrl,
      }
      return Object.freeze({
        leadId: leadId(identity),
        sourceId: source.sourceId,
        sourceUrl: source.sourceUrl,
        sourceDocumentDigest: source.documentDigest,
        kindHint: 'plugin',
        externalId,
        versionHint: null,
        publisherHint,
        upstreamUrl,
        artifactHint: artifactId === null ? null : Object.freeze({ registry: 'npm', id: artifactId, version: null }),
        remoteUrls: Object.freeze([]),
        discoveredAt: source.retrievedAt,
        signals: Object.freeze({ category, stars, downloads, registryStatus: null }),
      })
    },
  })
}

function mcpPackage(value, index) {
  const row = object(value, `MCP package ${String(index)}`)
  const registry = text(row.registryType, `MCP package ${String(index)} registry`, { maximum: 64 })
  const id = text(row.identifier, `MCP package ${String(index)} identifier`, { maximum: 512 })
  const version = text(row.version, `MCP package ${String(index)} version`, { maximum: 128 })
  if (version === 'latest') throw new Error(`MCP package ${String(index)} uses a moving version`)
  return Object.freeze({ registry, id, version })
}

/** Convert one official MCP Registry page into non-admitted curation leads. */
export function discoverOfficialMcpRegistry(document, sourceUrl, retrievedAt) {
  return sourceReport('official-mcp-registry', sourceUrl, retrievedAt, document, {
    records(value) {
      const root = object(value, 'MCP registry page')
      return root.servers
    },
    record(value, source) {
      const wrapper = object(value, 'MCP registry row')
      const server = object(wrapper.server, 'MCP registry server')
      const externalId = text(server.name, 'MCP server name', { maximum: 512 })
      const versionHint = text(server.version, 'MCP server version', { maximum: 128 })
      if (versionHint === 'latest') throw new Error('MCP registry lead uses a moving version')
      const metadata = object(wrapper._meta ?? {}, 'MCP registry metadata')
      const official = object(metadata['io.modelcontextprotocol.registry/official'] ?? {}, 'official MCP metadata')
      const registryStatus = optionalText(official.status, 'MCP registry status')
      if (registryStatus === 'deleted') throw new Error('MCP registry lead is deleted')
      const repository = server.repository === undefined ? null : object(server.repository, 'MCP repository')
      const upstreamUrl = repository === null ? source.sourceUrl : httpsUrl(repository.url, 'MCP repository URL', { query: false })
      const packages = server.packages === undefined ? [] : server.packages
      const remotes = server.remotes === undefined ? [] : server.remotes
      if (!Array.isArray(packages) || packages.length > 16 || !Array.isArray(remotes) || remotes.length > 16) {
        throw new Error('MCP registry transports exceed their bound')
      }
      const packageHints = packages.map(mcpPackage)
      const remoteUrls = remotes.map((remote, index) => {
        const row = object(remote, `MCP remote ${String(index)}`)
        if (row.type !== 'streamable-http') throw new Error(`MCP remote ${String(index)} is not streamable-http`)
        return httpsUrl(row.url, `MCP remote ${String(index)} URL`)
      }).sort()
      const identity = {
        sourceId: source.sourceId,
        sourceDocumentDigest: source.documentDigest,
        externalId,
        versionHint,
      }
      return Object.freeze({
        leadId: leadId(identity),
        sourceId: source.sourceId,
        sourceUrl: source.sourceUrl,
        sourceDocumentDigest: source.documentDigest,
        kindHint: 'mcp',
        externalId,
        versionHint,
        publisherHint: null,
        upstreamUrl,
        artifactHint: packageHints.length === 1 ? packageHints[0] : null,
        remoteUrls: Object.freeze(remoteUrls),
        discoveredAt: source.retrievedAt,
        signals: Object.freeze({ category: null, stars: null, downloads: null, registryStatus }),
      })
    },
  })
}

/** Convert a fixed GitHub repository-search page into Skill curation leads. */
export function discoverGithubSkillRepositories(document, sourceUrl, retrievedAt) {
  return sourceReport('github-skill-search', sourceUrl, retrievedAt, document, {
    records(value) {
      const root = object(value, 'GitHub repository search')
      return root.items
    },
    record(value, source) {
      const row = object(value, 'GitHub Skill repository')
      const externalId = text(row.full_name, 'GitHub repository full_name', { maximum: 256 })
      const upstreamUrl = httpsUrl(row.html_url, 'GitHub repository URL', { query: false })
      const owner = object(row.owner, 'GitHub repository owner')
      const publisherHint = text(owner.login, 'GitHub repository owner login', { maximum: 128 })
      const stars = integer(row.stargazers_count, 'GitHub repository stars')
      const topics = row.topics ?? []
      if (!Array.isArray(topics) || topics.length > 64 || topics.some(topic => typeof topic !== 'string')) {
        throw new Error('GitHub repository topics are invalid')
      }
      const identity = {
        sourceId: source.sourceId,
        sourceDocumentDigest: source.documentDigest,
        externalId,
        upstreamUrl,
      }
      return Object.freeze({
        leadId: leadId(identity),
        sourceId: source.sourceId,
        sourceUrl: source.sourceUrl,
        sourceDocumentDigest: source.documentDigest,
        kindHint: 'skill',
        externalId,
        versionHint: null,
        publisherHint,
        upstreamUrl,
        artifactHint: null,
        remoteUrls: Object.freeze([]),
        discoveredAt: source.retrievedAt,
        signals: Object.freeze({
          category: topics.includes('agent-skill') ? 'agent-skill' : 'agents',
          stars,
          downloads: null,
          registryStatus: null,
        }),
      })
    },
  })
}

function receipt(record, subject, fields) {
  const value = exactObject(record, subject, fields)
  const candidateRef = text(value.candidateRef, `${subject}.candidateRef`, { maximum: 512 })
  return { value, candidateRef, digest: canonicalSha256(value) }
}

function validateAdmission(admission, leads, artifact) {
  const input = exactObject(admission, 'admission', [
    'artifactFile', 'authorityReceipt', 'compatibilityReceipt', 'dependencyScanReceipt', 'entry',
    'leadIds', 'lifecycleReceipt', 'reviewer', 'verifiedAt',
  ])
  const entry = object(input.entry, 'admission.entry')
  const candidateRef = text(entry.candidateRef, 'entry.candidateRef', { maximum: 512 })
  if (catalogReviewEvidenceSupport(entry) === 'unavailable') {
    throw new Error(`${candidateRef} has no exact candidate-bound review evidence record`)
  }
  const leadIds = input.leadIds
  if (!Array.isArray(leadIds) || leadIds.length === 0 || leadIds.length > 16) {
    throw new Error(`${candidateRef} must bind one to sixteen source leads`)
  }
  for (const value of leadIds) {
    const id = text(value, `${candidateRef} lead id`, { maximum: 128 })
    if (!leads.has(id)) throw new Error(`${candidateRef} references an unknown source lead`)
  }
  const artifactCoordinates = object(entry.artifact, `${candidateRef}.artifact`)
  const expectedIntegrity = text(artifactCoordinates.integrity, `${candidateRef}.artifact.integrity`, { maximum: 256 })
  if (!SHA256.test(expectedIntegrity) && !SHA512.test(expectedIntegrity)) throw new Error(`${candidateRef} artifact integrity is invalid`)
  if (artifact.integrity !== expectedIntegrity
    || artifact.sizeBytes !== integer(artifactCoordinates.sizeBytes, `${candidateRef}.artifact.sizeBytes`, 1)) {
    throw new Error(`${candidateRef} artifact observation does not match catalog coordinates`)
  }
  const source = object(entry.source, `${candidateRef}.source`)
  const sourceRevision = text(source.revision, `${candidateRef}.source.revision`, { maximum: 256 })
  if (['latest', 'main', 'master', 'head'].includes(sourceRevision.toLowerCase())) {
    throw new Error(`${candidateRef} uses a moving source revision`)
  }
  httpsUrl(source.url, `${candidateRef}.source.url`)
  const upstreamUrl = httpsUrl(source.upstreamUrl, `${candidateRef}.source.upstreamUrl`)
  httpsUrl(artifactCoordinates.acquisitionUrl, `${candidateRef}.artifact.acquisitionUrl`)
  const lineage = leadIds
    .map(id => leads.get(id))
    .some(lead => lead.kindHint === entry.kind
      && (lead.upstreamUrl === upstreamUrl || upstreamUrl.startsWith(`${lead.upstreamUrl}/`)))
  if (!lineage) throw new Error(`${candidateRef} source leads do not bind its kind and upstream repository`)
  const lifecycle = object(entry.lifecycle, `${candidateRef}.lifecycle`)
  for (const action of LIFECYCLE_ACTIONS) {
    if (object(lifecycle[action], `${candidateRef}.lifecycle.${action}`).status !== 'available') {
      throw new Error(`${candidateRef} is not a writable P0 candidate because ${action} is unavailable`)
    }
  }

  const lifecycleReceipt = receipt(input.lifecycleReceipt, 'lifecycle receipt', [
    'actions', 'candidateRef', 'dshVersion', 'fixtureDigest', 'sourceRevision',
  ])
  const actions = exactObject(lifecycleReceipt.value.actions, 'lifecycle receipt actions', LIFECYCLE_ACTIONS)
  if (Object.values(actions).some(status => status !== 'passed')) throw new Error(`${candidateRef} lifecycle receipt is incomplete`)
  if (lifecycleReceipt.value.dshVersion !== DSH_VERSION || lifecycleReceipt.value.sourceRevision !== sourceRevision
    || !RECEIPT_DIGEST.test(lifecycleReceipt.value.fixtureDigest)) {
    throw new Error(`${candidateRef} lifecycle receipt does not bind the exact fixture`)
  }

  const compatibilityReceipt = receipt(input.compatibilityReceipt, 'compatibility receipt', [
    'candidateRef', 'dshVersion', 'platforms', 'status',
  ])
  const platforms = compatibilityReceipt.value.platforms
  if (compatibilityReceipt.value.dshVersion !== DSH_VERSION || compatibilityReceipt.value.status !== 'passed'
    || !Array.isArray(platforms) || platforms.length === 0
    || platforms.some(platform => !['darwin', 'linux', 'windows'].includes(platform))) {
    throw new Error(`${candidateRef} compatibility receipt is incomplete`)
  }

  const authorityReceipt = receipt(input.authorityReceipt, 'authority receipt', [
    'authorityDigest', 'candidateRef', 'reviewed',
  ])
  if (authorityReceipt.value.reviewed !== true || !RECEIPT_DIGEST.test(authorityReceipt.value.authorityDigest)) {
    throw new Error(`${candidateRef} authority receipt is incomplete`)
  }

  const dependencyReceipt = receipt(input.dependencyScanReceipt, 'dependency scan receipt', [
    'candidateRef', 'dependencyGraphDigest', 'status',
  ])
  if (dependencyReceipt.value.status !== 'no-lifecycle-scripts'
    || !RECEIPT_DIGEST.test(dependencyReceipt.value.dependencyGraphDigest)) {
    throw new Error(`${candidateRef} dependency scan did not reject lifecycle scripts`)
  }
  for (const candidate of [lifecycleReceipt, compatibilityReceipt, authorityReceipt, dependencyReceipt]) {
    if (candidate.candidateRef !== candidateRef) throw new Error(`${candidateRef} receipt identity mismatch`)
  }
  timestamp(input.verifiedAt, `${candidateRef}.verifiedAt`)
  const reviewer = text(input.reviewer, `${candidateRef}.reviewer`, { maximum: 128 })
  return Object.freeze({
    entry: structuredClone(entry),
    evidence: Object.freeze({
      candidateRef,
      leadIds: Object.freeze([...new Set(leadIds)].sort()),
      artifactIntegrity: artifact.integrity,
      artifactSizeBytes: artifact.sizeBytes,
      reviewer,
      verifiedAt: input.verifiedAt,
      lifecycleReceiptDigest: lifecycleReceipt.digest,
      compatibilityReceiptDigest: compatibilityReceipt.digest,
      authorityReceiptDigest: authorityReceipt.digest,
      dependencyScanReceiptDigest: dependencyReceipt.digest,
    }),
  })
}

/** Admit only exact artifacts with complete P0 lifecycle, compatibility, authority, and script-scan receipts. */
export function admitCatalogEntries(leadReports, admissions, artifacts) {
  if (!Array.isArray(leadReports) || leadReports.length === 0) throw new Error('at least one discovery report is required')
  const leads = new Map()
  for (const report of leadReports) {
    const source = object(report, 'lead report')
    if (!Array.isArray(source.leads)) throw new Error('lead report has no leads')
    for (const lead of source.leads) {
      const id = text(object(lead, 'lead').leadId, 'lead id', { maximum: 128 })
      if (leads.has(id)) throw new Error(`duplicate lead id ${id}`)
      leads.set(id, lead)
    }
  }
  if (!Array.isArray(admissions) || admissions.length === 0 || admissions.length > 100) {
    throw new Error('admission count is invalid')
  }
  const results = admissions.map((admission) => {
    const candidateRef = object(object(admission, 'admission').entry, 'admission.entry').candidateRef
    const artifact = artifacts.get(candidateRef)
    if (artifact === undefined) throw new Error(`${String(candidateRef)} has no artifact observation`)
    return validateAdmission(admission, leads, artifact)
  })
  results.sort((left, right) => left.entry.candidateRef.localeCompare(right.entry.candidateRef))
  const refs = new Set(results.map(result => result.entry.candidateRef))
  if (refs.size !== results.length) throw new Error('duplicate admitted candidateRef')
  return Object.freeze({
    entries: Object.freeze(results.map(result => Object.freeze(result.entry))),
    evidence: Object.freeze(results.map(result => result.evidence)),
  })
}

function signingKey(root, signer) {
  const rootKey = root.keys.find(key => key.keyId === signer.keyId)
  if (rootKey === undefined || rootKey.algorithm !== 'ed25519') throw new Error(`signing key ${signer.keyId} is not trusted by the root`)
  const privateKey = createPrivateKey(signer.privateKeyPem)
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const expected = createPublicKey(rootKey.publicKeyPem).export({ type: 'spki', format: 'der' })
  if (!Buffer.from(derived).equals(Buffer.from(expected))) throw new Error(`private key ${signer.keyId} does not match the trust root`)
  return privateKey
}

function previousVerificationTime(envelope) {
  const issuedAt = Date.parse(envelope.issuedAt)
  const expiresAt = Date.parse(envelope.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt) {
    throw new Error('previous catalog validity interval is invalid')
  }
  return issuedAt + Math.min(1_000, Math.max(1, expiresAt - issuedAt - 1))
}

/** Create, threshold-sign, and self-verify the next immutable catalog revision. */
export function createSignedCatalogDocument({ root, previous, entries, issuedAt, expiresAt, signers }) {
  const trustRoot = exactObject(root, 'catalog root', [
    'catalogId', 'keys', 'maximumAgeMs', 'minimumRevision', 'threshold',
  ])
  const previousDocument = exactObject(previous, 'previous catalog document', ['envelope', 'signatures'])
  verifyCatalog(trustRoot, previousDocument.envelope, previousDocument.signatures, previousVerificationTime(previousDocument.envelope))
  timestamp(issuedAt, 'issuedAt')
  timestamp(expiresAt, 'expiresAt')
  const issuedAtMs = Date.parse(issuedAt)
  const expiresAtMs = Date.parse(expiresAt)
  if (issuedAtMs >= expiresAtMs || expiresAtMs - issuedAtMs > trustRoot.maximumAgeMs) {
    throw new Error('next catalog validity interval exceeds the trust root')
  }
  if (issuedAtMs <= Date.parse(previousDocument.envelope.issuedAt)) throw new Error('next catalog issue time must advance')
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 100) throw new Error('next catalog entry count is invalid')
  const sorted = structuredClone(entries).sort((left, right) => left.candidateRef.localeCompare(right.candidateRef))
  const envelope = Object.freeze({
    catalogId: trustRoot.catalogId,
    revision: previousDocument.envelope.revision + 1,
    issuedAt,
    expiresAt,
    previousRevisionDigest: canonicalSha256(previousDocument.envelope),
    entriesDigest: canonicalSha256(sorted),
    entries: Object.freeze(sorted),
  })
  if (!Array.isArray(signers) || signers.length === 0 || signers.length > 16) throw new Error('signer count is invalid')
  const unique = new Set()
  const bytes = Buffer.from(canonicalJson(envelope))
  const signatures = signers.map((signer) => {
    const keyId = text(signer.keyId, 'signer keyId', { maximum: 128 })
    if (unique.has(keyId)) throw new Error(`duplicate signer ${keyId}`)
    unique.add(keyId)
    const privateKey = signingKey(trustRoot, signer)
    return Object.freeze({ keyId, algorithm: 'ed25519', value: sign(null, bytes, privateKey).toString('base64') })
  }).sort((left, right) => left.keyId.localeCompare(right.keyId))
  const verified = verifyCatalog(trustRoot, envelope, signatures, issuedAtMs)
  return Object.freeze({
    document: Object.freeze({ envelope, signatures: Object.freeze(signatures) }),
    keyIds: Object.freeze(verified.keyIds),
  })
}

/** Canonical SHA-256 digest of one immutable curation receipt. */
export function receiptDigest(value) {
  return canonicalSha256(value)
}
