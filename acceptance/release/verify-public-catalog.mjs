#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcceptanceFailure, sanitizeDiagnostic } from '../full-p0/support.mjs'
import { CatalogSnapshotManager, PUBLISHED_CATALOG_URL, verifyCatalogAdvance } from '../../lib/catalog-refresh.js'
import {
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_ROOT,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from '../../lib/catalog-data.js'
import { canonicalJson, canonicalSha256, verifyBootstrapCatalog } from '../../lib/catalog.js'

/** Exact public deployment owned by this repository. */
export const PUBLIC_CATALOG_URL = 'https://striveh.github.io/dsh-plugin-extension-center/plugins.json'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const expectedCatalogPath = resolve(projectRoot, 'catalog/public/plugins.json')
const expectedCatalogBytes = await readFile(expectedCatalogPath)
const expectedCatalogDocument = decodeCanonicalDocument(expectedCatalogBytes)
const expectedCatalogEnvelope = record(expectedCatalogDocument.envelope, 'committed public catalog envelope')
const expectedCatalogSignatures = expectedCatalogDocument.signatures
const expectedCatalogState = classifyCommittedPublicCatalog(expectedCatalogDocument)
const packagedBootstrapEnvelopeDigest = canonicalSha256(BOOTSTRAP_CATALOG_ENVELOPE)

/** Exact committed public-tip coordinates admitted by this source commit. */
export const EXPECTED_PUBLIC_CATALOG = Object.freeze({
  state: expectedCatalogState,
  revision: expectedCatalogEnvelope.revision,
  previousRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
  previousRevisionDigest: packagedBootstrapEnvelopeDigest,
  committedPreviousRevisionDigest: expectedCatalogEnvelope.previousRevisionDigest,
  entriesDigest: expectedCatalogEnvelope.entriesDigest,
  envelopeDigest: canonicalSha256(expectedCatalogEnvelope),
  signatureSetDigest: canonicalSha256(expectedCatalogSignatures),
  documentDigest: canonicalSha256(expectedCatalogDocument),
  bytesSha256: sha256(expectedCatalogBytes),
  sizeBytes: expectedCatalogBytes.length,
  packagedBootstrapPreviousRevisionDigest: BOOTSTRAP_CATALOG_ENVELOPE.previousRevisionDigest,
  packagedBootstrapEntriesDigest: BOOTSTRAP_CATALOG_ENVELOPE.entriesDigest,
  packagedBootstrapEnvelopeDigest,
  packagedBootstrapRootDigest: canonicalSha256(BOOTSTRAP_CATALOG_ROOT),
  packagedBootstrapSignatureSetDigest: canonicalSha256(BOOTSTRAP_CATALOG_SIGNATURES),
})

const MAX_CATALOG_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 20_000
const DEFAULT_RECEIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../.artifacts/acceptance/public-catalog/receipt.json',
)
const USAGE = 'usage: node acceptance/release/verify-public-catalog.mjs [--receipt <path>]\n'

function fail(code, message) {
  throw new AcceptanceFailure(code, message)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('P0-PUBLIC-CATALOG-FORMAT', `${label} must be an object`)
  }
  return value
}

function exactFields(value, fields, label) {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail('P0-PUBLIC-CATALOG-FORMAT', `${label} fields are invalid`)
  }
}

/** Distinguish an exact packaged public tip from a signed adjacent-successor input. */
export function classifyCommittedPublicCatalog(
  document,
  packagedEnvelope = BOOTSTRAP_CATALOG_ENVELOPE,
  packagedSignatures = BOOTSTRAP_CATALOG_SIGNATURES,
) {
  const input = record(document, 'committed public catalog document')
  exactFields(input, ['envelope', 'signatures'], 'committed public catalog document')
  const envelope = record(input.envelope, 'committed public catalog envelope')
  if (!Array.isArray(input.signatures)) {
    fail('P0-PUBLIC-CATALOG-FORMAT', 'committed public catalog signatures must be an array')
  }
  const revision = envelope.revision
  if (!Number.isSafeInteger(revision)) {
    fail('P0-PUBLIC-CATALOG-FORMAT', 'committed public catalog revision is invalid')
  }
  if (revision < packagedEnvelope.revision) {
    fail('P0-PUBLIC-CATALOG-ROLLBACK', 'committed public catalog is older than the packaged bootstrap')
  }
  if (revision === packagedEnvelope.revision) {
    if (canonicalSha256(envelope) !== canonicalSha256(packagedEnvelope)
      || canonicalSha256(input.signatures) !== canonicalSha256(packagedSignatures)) {
      fail('P0-PUBLIC-CATALOG-CHAIN', 'committed public catalog conflicts with the signed packaged tip')
    }
    return 'packaged-tip'
  }
  if (revision !== packagedEnvelope.revision + 1
    || envelope.previousRevisionDigest !== canonicalSha256(packagedEnvelope)) {
    fail('P0-PUBLIC-CATALOG-CHAIN', 'committed public catalog is neither the packaged tip nor its exact adjacent successor')
  }
  return 'adjacent-successor'
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function contentType(response) {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? null
}

async function boundedResponseBytes(response) {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > MAX_CATALOG_BYTES)) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-PUBLIC-CATALOG-SIZE', 'public catalog Content-Length exceeds its bound')
  }
  if (response.body === null) fail('P0-PUBLIC-CATALOG-SIZE', 'public catalog response has no body')
  const chunks = []
  let total = 0
  for await (const value of response.body) {
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > MAX_CATALOG_BYTES) {
      await response.body.cancel().catch(() => undefined)
      fail('P0-PUBLIC-CATALOG-SIZE', 'public catalog response exceeds its byte bound')
    }
    chunks.push(chunk)
  }
  if (declared !== null && Number(declared) !== total) {
    fail('P0-PUBLIC-CATALOG-SIZE', 'public catalog Content-Length does not match its complete body')
  }
  return Buffer.concat(chunks, total)
}

function decodeCanonicalDocument(bytes) {
  let text
  let document
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    document = JSON.parse(text)
  } catch {
    fail('P0-PUBLIC-CATALOG-FORMAT', 'public catalog is not strict UTF-8 JSON')
  }
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || `${canonicalJson(document)}\n` !== text) {
    fail('P0-PUBLIC-CATALOG-FORMAT', 'public catalog is not one canonical JSON line with a trailing newline')
  }
  const input = record(document, 'public catalog document')
  exactFields(input, ['envelope', 'signatures'], 'public catalog document')
  return input
}

function assertExpectedDocument(document) {
  const envelope = record(document.envelope, 'public catalog envelope')
  const revision = envelope.revision
  if (!Number.isSafeInteger(revision)) fail('P0-PUBLIC-CATALOG-FORMAT', 'public catalog revision is invalid')
  if (revision !== EXPECTED_PUBLIC_CATALOG.revision) {
    fail('P0-PUBLIC-CATALOG-CHAIN', `public catalog revision is ${String(revision)}, not committed revision ${String(EXPECTED_PUBLIC_CATALOG.revision)}`)
  }
  if (envelope.previousRevisionDigest !== EXPECTED_PUBLIC_CATALOG.committedPreviousRevisionDigest) {
    fail('P0-PUBLIC-CATALOG-CHAIN', 'public catalog predecessor digest does not match the committed document')
  }
  if (envelope.entriesDigest !== EXPECTED_PUBLIC_CATALOG.entriesDigest) {
    fail('P0-PUBLIC-CATALOG-CHAIN', 'public catalog entries digest does not match the committed document')
  }
  return envelope
}

function assertDeploymentUpgradeState() {
  if (EXPECTED_PUBLIC_CATALOG.state !== 'adjacent-successor') {
    fail('P0-PUBLIC-CATALOG-NO-ADVANCE', 'public catalog equals the packaged signed tip; deployment upgrade acceptance requires an exact adjacent successor')
  }
}

/** Pin the complete packaged bootstrap authority, not only its envelope. */
export function assertPackagedCatalogAuthority(
  root = BOOTSTRAP_CATALOG_ROOT,
  envelope = BOOTSTRAP_CATALOG_ENVELOPE,
  signatures = BOOTSTRAP_CATALOG_SIGNATURES,
) {
  const envelopeDigest = canonicalSha256(envelope)
  const rootDigest = canonicalSha256(root)
  const signatureSetDigest = canonicalSha256(signatures)
  if (envelope.revision !== EXPECTED_PUBLIC_CATALOG.previousRevision
    || envelope.previousRevisionDigest !== EXPECTED_PUBLIC_CATALOG.packagedBootstrapPreviousRevisionDigest
    || envelope.entriesDigest !== EXPECTED_PUBLIC_CATALOG.packagedBootstrapEntriesDigest
    || envelopeDigest !== EXPECTED_PUBLIC_CATALOG.packagedBootstrapEnvelopeDigest
    || rootDigest !== EXPECTED_PUBLIC_CATALOG.packagedBootstrapRootDigest
    || signatureSetDigest !== EXPECTED_PUBLIC_CATALOG.packagedBootstrapSignatureSetDigest) {
    fail('P0-PUBLIC-CATALOG-AUTHORITY', 'built package no longer contains the exact committed bootstrap trust root, envelope, and signatures')
  }
  return Object.freeze({ envelopeDigest, rootDigest, signatureSetDigest })
}

/** Verify one signed same-tip or adjacent public document against the pinned packaged authority. */
export function verifySignedPublicCatalogAdvance(document, now) {
  assertPackagedCatalogAuthority()
  try {
    const bootstrap = verifyBootstrapCatalog(now)
    return verifyCatalogAdvance(BOOTSTRAP_CATALOG_ROOT, bootstrap, document, now)
  } catch (error) {
    fail('P0-PUBLIC-CATALOG-SIGNATURE', `public catalog signature or predecessor verification failed: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}`)
  }
}

function responseFromBytes(bytes) {
  const response = new Response(bytes, {
    status: 200,
    headers: {
      'content-length': String(bytes.length),
      'content-type': 'application/json',
    },
  })
  Object.defineProperty(response, 'url', { configurable: true, value: PUBLIC_CATALOG_URL })
  return response
}

async function observeRuntimeRefresh(bytes, now) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-public-catalog-')))
  try {
    const manager = new CatalogSnapshotManager(root, {
      trustedUrl: PUBLIC_CATALOG_URL,
      fetchTimeoutMs: FETCH_TIMEOUT_MS,
    }, {
      now: () => now,
      fetch: (async (input, init) => {
        if (String(input) !== PUBLIC_CATALOG_URL || init?.method !== 'GET' || init.redirect !== 'error') {
          fail('P0-PUBLIC-CATALOG-RUNTIME', 'built runtime refresh changed its fixed request contract')
        }
        return responseFromBytes(bytes)
      }),
    })
    const snapshot = await manager.initialize()
    if (snapshot.catalog.envelope.revision !== EXPECTED_PUBLIC_CATALOG.revision
      || snapshot.catalog.envelope.entriesDigest !== EXPECTED_PUBLIC_CATALOG.entriesDigest
      || snapshot.status.source !== 'remote'
      || snapshot.status.freshness !== 'fresh'
      || snapshot.status.degraded !== false
      || snapshot.status.degradedReason !== null
      || snapshot.status.lastRefreshAtMs !== now) {
      fail('P0-PUBLIC-CATALOG-RUNTIME', 'built runtime did not admit the exact committed public catalog as one fresh non-degraded remote snapshot')
    }
    return Object.freeze({
      source: snapshot.status.source,
      freshness: snapshot.status.freshness,
      degraded: snapshot.status.degraded,
      degradedReason: snapshot.status.degradedReason,
      lastRefreshAtMs: snapshot.status.lastRefreshAtMs,
      revision: snapshot.catalog.envelope.revision,
      entriesDigest: snapshot.catalog.envelope.entriesDigest,
      keyIds: Object.freeze([...snapshot.catalog.keyIds]),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function fetchDeployment(fetchImpl) {
  let response
  try {
    response = await fetchImpl(PUBLIC_CATALOG_URL, {
      method: 'GET',
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    fail('P0-PUBLIC-CATALOG-FETCH', `public catalog fetch failed: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}`)
  }
  if (response.redirected || response.url !== PUBLIC_CATALOG_URL
    || (response.status >= 300 && response.status < 400)) {
    fail('P0-PUBLIC-CATALOG-REDIRECT', 'public catalog must not redirect away from its fixed URL')
  }
  if (response.status !== 200) {
    fail('P0-PUBLIC-CATALOG-HTTP', `public catalog returned HTTP ${String(response.status)}, not 200`)
  }
  const observedContentType = contentType(response)
  if (observedContentType !== 'application/json') {
    fail('P0-PUBLIC-CATALOG-CONTENT-TYPE', 'public catalog did not return application/json')
  }
  return Object.freeze({
    bytes: await boundedResponseBytes(response),
    status: response.status,
    finalUrl: response.url,
    redirected: response.redirected,
    contentType: observedContentType,
  })
}

/** Verify the exact deployed public tip without claiming that its revision advanced. */
export async function verifyPublicCatalogObservation(dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const now = dependencies.now ?? Date.now()
  if (typeof fetchImpl !== 'function') fail('P0-PUBLIC-CATALOG-FETCH', 'HTTPS fetch is unavailable')
  if (!Number.isSafeInteger(now) || now < 0) fail('P0-PUBLIC-CATALOG-INPUT', 'acceptance time must be a non-negative safe integer')
  if (PUBLISHED_CATALOG_URL !== PUBLIC_CATALOG_URL) {
    fail('P0-PUBLIC-CATALOG-URL', 'built runtime public catalog URL drifted from the release acceptance URL')
  }
  const packagedAuthority = assertPackagedCatalogAuthority()

  const deployed = await fetchDeployment(fetchImpl)
  const document = decodeCanonicalDocument(deployed.bytes)
  const envelope = assertExpectedDocument(document)
  const observedBytesSha256 = sha256(deployed.bytes)
  const observedDocumentDigest = canonicalSha256(document)
  if (deployed.bytes.length !== EXPECTED_PUBLIC_CATALOG.sizeBytes
    || observedBytesSha256 !== EXPECTED_PUBLIC_CATALOG.bytesSha256) {
    fail('P0-PUBLIC-CATALOG-BYTES', 'public catalog bytes do not match the committed SHA-256 and size')
  }
  if (observedDocumentDigest !== EXPECTED_PUBLIC_CATALOG.documentDigest) {
    fail('P0-PUBLIC-CATALOG-BYTES', 'public catalog canonical document digest does not match the committed document')
  }

  const advanced = verifySignedPublicCatalogAdvance(document, now)
  if (advanced.envelope.revision !== EXPECTED_PUBLIC_CATALOG.revision) {
    fail('P0-PUBLIC-CATALOG-CHAIN', 'direct catalog verification did not produce the committed public catalog')
  }
  const runtimeRefresh = await observeRuntimeRefresh(deployed.bytes, now)

  return Object.freeze({
    catalogState: EXPECTED_PUBLIC_CATALOG.state,
    observedAt: new Date(now).toISOString(),
    target: Object.freeze({
      url: PUBLIC_CATALOG_URL,
      redirectPolicy: 'forbidden',
      expectedContentType: 'application/json',
      expectedRevision: EXPECTED_PUBLIC_CATALOG.revision,
      expectedSizeBytes: EXPECTED_PUBLIC_CATALOG.sizeBytes,
      expectedBytesSha256: EXPECTED_PUBLIC_CATALOG.bytesSha256,
      expectedEnvelopeDigest: EXPECTED_PUBLIC_CATALOG.envelopeDigest,
    }),
    packagedBootstrap: Object.freeze({
      revision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
      previousRevisionDigest: BOOTSTRAP_CATALOG_ENVELOPE.previousRevisionDigest,
      entriesDigest: BOOTSTRAP_CATALOG_ENVELOPE.entriesDigest,
      envelopeDigest: packagedAuthority.envelopeDigest,
      rootDigest: packagedAuthority.rootDigest,
      signatureSetDigest: packagedAuthority.signatureSetDigest,
    }),
    deployment: Object.freeze({
      httpStatus: deployed.status,
      finalUrl: deployed.finalUrl,
      redirected: deployed.redirected,
      contentType: deployed.contentType,
      sizeBytes: deployed.bytes.length,
      bytesSha256: observedBytesSha256,
      canonicalOneLine: true,
      documentDigest: observedDocumentDigest,
      envelopeDigest: canonicalSha256(envelope),
      signatureSetDigest: canonicalSha256(document.signatures),
      revision: envelope.revision,
      previousRevisionDigest: envelope.previousRevisionDigest,
      entriesDigest: envelope.entriesDigest,
      keyIds: Object.freeze([...advanced.keyIds]),
    }),
    runtimeRefresh,
  })
}

/** Prove an exact deployed adjacent successor and issue the release-upgrade receipt body. */
export async function verifyPublicCatalogDeployment(dependencies = {}) {
  assertDeploymentUpgradeState()
  const observation = await verifyPublicCatalogObservation(dependencies)

  const body = Object.freeze({
    schemaVersion: 2,
    acceptanceId: 'P0-PUBLIC-CATALOG-DEPLOYMENT',
    status: 'passed',
    p0Status: 'public-catalog-deployment-proven',
    observedAt: observation.observedAt,
    target: observation.target,
    packagedBootstrap: observation.packagedBootstrap,
    deployment: observation.deployment,
    runtimeRefresh: observation.runtimeRefresh,
    notProven: Object.freeze([]),
  })
  return Object.freeze({ ...body, receiptDigest: canonicalSha256(body) })
}

async function prepareReceiptDestination(path) {
  const requested = resolve(path)
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 })
  const destination = join(await realpath(dirname(requested)), basename(requested))
  try {
    await lstat(destination)
    fail('P0-PUBLIC-CATALOG-RECEIPT', 'public catalog receipt output already exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return destination
}

async function writeReceipt(destination, receipt) {
  const temporary = join(dirname(destination), `.public-catalog-receipt-${randomUUID()}`)
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  try {
    await link(temporary, destination)
  } catch (error) {
    if (error?.code === 'EEXIST') fail('P0-PUBLIC-CATALOG-RECEIPT', 'public catalog receipt appeared concurrently')
    throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** Run deployment acceptance and atomically publish one immutable receipt. */
export async function runPublicCatalogDeploymentAcceptance(options = {}) {
  const receiptPath = await prepareReceiptDestination(options.receiptPath ?? DEFAULT_RECEIPT_PATH)
  const receipt = await verifyPublicCatalogDeployment(options)
  await writeReceipt(receiptPath, receipt)
  return Object.freeze({ receipt, receiptPath })
}

export function parsePublicCatalogArguments(arguments_) {
  if (!Array.isArray(arguments_)) fail('P0-PUBLIC-CATALOG-INPUT', 'CLI arguments must be an array')
  if (arguments_.length === 0) return Object.freeze({ help: false, receiptPath: DEFAULT_RECEIPT_PATH })
  if (arguments_.length === 1 && arguments_[0] === '--help') return Object.freeze({ help: true })
  if (arguments_.length === 2 && arguments_[0] === '--receipt'
    && typeof arguments_[1] === 'string' && arguments_[1].length > 0
    && arguments_[1].length <= 4_096 && !arguments_[1].includes('\0')) {
    return Object.freeze({ help: false, receiptPath: resolve(arguments_[1]) })
  }
  fail('P0-PUBLIC-CATALOG-INPUT', 'CLI accepts only one optional --receipt path')
}

async function main() {
  try {
    const parsed = parsePublicCatalogArguments(process.argv.slice(2))
    if (parsed.help) {
      process.stdout.write(USAGE)
      return 0
    }
    const result = await runPublicCatalogDeploymentAcceptance({ receiptPath: parsed.receiptPath })
    process.stdout.write(`${result.receipt.p0Status}; receipt=${result.receiptPath}; digest=${result.receipt.receiptDigest}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`)
    process.stderr.write(USAGE)
    return 1
  }
}

async function isMainModule() {
  if (process.argv[1] === undefined) return false
  try {
    return await realpath(resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (await isMainModule()) process.exitCode = await main()
