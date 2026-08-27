#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcceptanceFailure, sanitizeDiagnostic } from '../full-p0/support.mjs'
import { canonicalJson, canonicalSha256 } from '../../lib/catalog.js'
import { verifySignedPublicCatalogAdvance } from './verify-public-catalog.mjs'

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_JSON_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 3
const GITHUB_API_ORIGIN = 'https://api.github.com'
const MCP_REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io'
const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_ASSET_REDIRECT_ORIGINS = new Set([
  'https://objects.githubusercontent.com',
  'https://release-assets.githubusercontent.com',
])
const DEFAULT_CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../catalog/public/plugins.json',
)
const DEFAULT_RECEIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../.artifacts/acceptance/catalog-sources/receipt.json',
)
const USAGE = 'usage: node acceptance/release/verify-catalog-sources.mjs [--receipt <path>]\n'

function fail(code, message) {
  throw new AcceptanceFailure(code, message)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('P0-CATALOG-SOURCES-FORMAT', `${label} must be an object`)
  }
  return value
}

function boundedText(value, label, maximum = 2_048) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('P0-CATALOG-SOURCES-FORMAT', `${label} must be one bounded string`)
  }
  return value
}

function exactHttpsUrl(value, label) {
  const input = boundedText(value, label)
  let url
  try {
    url = new URL(input)
  } catch {
    fail('P0-CATALOG-SOURCES-URL', `${label} is not an absolute URL`)
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/u, '')
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== ''
    || url.port !== '' || url.href !== input || isIP(unbracketed) !== 0 || host === 'localhost'
    || host.endsWith('.localhost') || host.endsWith('.local')) {
    fail('P0-CATALOG-SOURCES-URL', `${label} is outside the credential-free HTTPS policy`)
  }
  return url
}

function responseContentType(response) {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? null
}

async function boundedResponseBytes(response, maximum, label, expectedSize = null) {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > maximum
    || (expectedSize !== null && Number(declared) !== expectedSize))) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-CATALOG-SOURCES-SIZE', `${label} Content-Length does not match its admitted bound`)
  }
  if (response.body === null) fail('P0-CATALOG-SOURCES-SIZE', `${label} response has no body`)
  const chunks = []
  let total = 0
  for await (const value of response.body) {
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > maximum || (expectedSize !== null && total > expectedSize)) {
      await response.body.cancel().catch(() => undefined)
      fail('P0-CATALOG-SOURCES-SIZE', `${label} response exceeds its admitted bound`)
    }
    chunks.push(chunk)
  }
  if ((declared !== null && Number(declared) !== total) || (expectedSize !== null && total !== expectedSize)) {
    fail('P0-CATALOG-SOURCES-SIZE', `${label} body is incomplete or changed size`)
  }
  return Buffer.concat(chunks, total)
}

function redirectAllowed(coordinates, current, next) {
  if (coordinates.redirectPolicy !== 'github-release') return false
  if (current.origin === coordinates.artifactUrl.origin) {
    return next.origin === current.origin || GITHUB_ASSET_REDIRECT_ORIGINS.has(next.origin)
  }
  return GITHUB_ASSET_REDIRECT_ORIGINS.has(current.origin) && next.origin === current.origin
}

function credentialFreeReceiptUrl(url) {
  return `${url.origin}${url.pathname}`
}

async function fetchArtifact(entry, coordinates, fetchImpl) {
  const artifact = record(entry.artifact, `${entry.candidateRef} artifact`)
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 || artifact.sizeBytes > MAX_ARTIFACT_BYTES) {
    fail('P0-CATALOG-SOURCES-SIZE', `${entry.candidateRef} artifact size is outside the release bound`)
  }
  const initial = coordinates.artifactUrl
  let current = initial
  let response
  let redirectCount = 0
  for (;;) {
    try {
      response = await fetchImpl(current.href, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: {
          accept: 'application/octet-stream',
          'accept-encoding': 'identity',
          'user-agent': 'dsh-extension-center-catalog-source-acceptance/1',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      fail('P0-CATALOG-SOURCES-FETCH', `${entry.candidateRef} artifact fetch failed: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}`)
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    await response.body?.cancel().catch(() => undefined)
    if (redirectCount >= MAX_REDIRECTS) {
      fail('P0-CATALOG-SOURCES-REDIRECT', `${entry.candidateRef} artifact exceeded its redirect bound`)
    }
    const location = response.headers.get('location')
    if (location === null) fail('P0-CATALOG-SOURCES-REDIRECT', `${entry.candidateRef} redirect omitted Location`)
    const next = exactHttpsUrl(new URL(location, current).href, `${entry.candidateRef} redirect URL`)
    if (!redirectAllowed(coordinates, current, next)) {
      fail('P0-CATALOG-SOURCES-REDIRECT', `${entry.candidateRef} redirected outside its admitted artifact hosts`)
    }
    current = next
    redirectCount += 1
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-CATALOG-SOURCES-HTTP', `${entry.candidateRef} artifact returned HTTP ${String(response.status)}`)
  }
  const bytes = await boundedResponseBytes(response, artifact.sizeBytes, `${entry.candidateRef} artifact`, artifact.sizeBytes)
  const integrity = boundedText(artifact.integrity, `${entry.candidateRef} artifact integrity`, 256)
  const separator = integrity.indexOf(':')
  const algorithm = integrity.slice(0, separator)
  const encoded = integrity.slice(separator + 1)
  let observed
  if (algorithm === 'sha256' && /^[0-9a-f]{64}$/u.test(encoded)) {
    observed = createHash('sha256').update(bytes).digest('hex')
  } else if (algorithm === 'sha512' && /^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    observed = createHash('sha512').update(bytes).digest('base64')
  } else {
    fail('P0-CATALOG-SOURCES-INTEGRITY', `${entry.candidateRef} uses an unsupported integrity encoding`)
  }
  if (observed !== encoded) fail('P0-CATALOG-SOURCES-INTEGRITY', `${entry.candidateRef} artifact bytes changed`)
  return Object.freeze({
    sizeBytes: bytes.length,
    integrity,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    redirectCount,
    initialUrl: initial.href,
    finalUrl: credentialFreeReceiptUrl(current),
    finalOrigin: current.origin,
  })
}

async function fetchJson(urlValue, fetchImpl, token, label) {
  const url = exactHttpsUrl(urlValue, label)
  const headers = {
    accept: 'application/vnd.github+json, application/json',
    'accept-encoding': 'identity',
    'user-agent': 'dsh-extension-center-catalog-source-acceptance/1',
  }
  if (url.origin === GITHUB_API_ORIGIN) headers['x-github-api-version'] = GITHUB_API_VERSION
  if (token !== null) {
    if (url.origin !== GITHUB_API_ORIGIN) fail('P0-CATALOG-SOURCES-URL', `${label} cannot receive GitHub credentials`)
    headers.authorization = `Bearer ${token}`
  }
  let response
  try {
    response = await fetchImpl(url.href, {
      method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    fail('P0-CATALOG-SOURCES-FETCH', `${label} fetch failed: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}`)
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-CATALOG-SOURCES-HTTP', `${label} returned HTTP ${String(response.status)}`)
  }
  if (response.url !== '' && response.url !== url.href) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-CATALOG-SOURCES-REDIRECT', `${label} did not return its exact URL`)
  }
  const type = responseContentType(response)
  if (type !== 'application/json' && type !== 'application/vnd.github+json') {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-CATALOG-SOURCES-FORMAT', `${label} did not return JSON`)
  }
  const bytes = await boundedResponseBytes(response, MAX_JSON_BYTES, label)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    fail('P0-CATALOG-SOURCES-FORMAT', `${label} is not strict UTF-8 JSON`)
  }
}

function githubRepository(source, candidateRef) {
  const upstream = exactHttpsUrl(source.upstreamUrl, `${candidateRef} upstream URL`)
  const segments = upstream.pathname.split('/').filter(Boolean)
  if (upstream.origin !== 'https://github.com' || upstream.search !== '' || segments.length !== 2
    || segments.some(segment => !/^[A-Za-z0-9_.-]+$/u.test(segment))
    || upstream.href !== `https://github.com/${segments[0]}/${segments[1]}`
    || segments[1].endsWith('.git')) {
    fail('P0-CATALOG-SOURCES-SOURCE', `${candidateRef} upstream is not one exact GitHub repository`)
  }
  return Object.freeze({ owner: segments[0], repository: segments[1], upstream })
}

function cleanRelativePath(value, label) {
  const input = boundedText(value, label)
  const segments = input.split('/')
  if (segments.length === 0 || segments.some(segment => segment === '' || segment === '.' || segment === '..'
    || !/^[A-Za-z0-9._-]+$/u.test(segment))) {
    fail('P0-CATALOG-SOURCES-SOURCE', `${label} is not one clean repository-relative path`)
  }
  return input
}

function exactVersion(value, label) {
  const version = boundedText(value, label, 128)
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u.test(version)
    || ['latest', 'main', 'master', 'head'].includes(version.toLowerCase())) {
    fail('P0-CATALOG-SOURCES-SOURCE', `${label} is not one exact immutable version`)
  }
  return version
}

function githubReleaseCoordinates(entry) {
  const source = record(entry.source, `${entry.candidateRef} source`)
  const artifact = record(entry.artifact, `${entry.candidateRef} artifact`)
  const repository = githubRepository(source, entry.candidateRef)
  const version = exactVersion(artifact.version, `${entry.candidateRef} artifact version`)
  const revision = boundedText(source.revision, `${entry.candidateRef} source revision`, 40)
  const tag = `v${version}`
  const artifactUrl = exactHttpsUrl(artifact.acquisitionUrl, `${entry.candidateRef} artifact URL`)
  const prefix = `/${repository.owner}/${repository.repository}/releases/download/${tag}/`
  if (source.url !== `${repository.upstream.href}/releases/tag/${tag}`
    || artifactUrl.origin !== 'https://github.com' || artifactUrl.search !== ''
    || !artifactUrl.pathname.startsWith(prefix)
    || artifactUrl.pathname.slice(prefix.length).length === 0
    || artifactUrl.pathname.slice(prefix.length).includes('/')
    || !/^[0-9a-f]{40}$/u.test(revision)
    || !entry.candidateRef.startsWith('plugin:') || !entry.candidateRef.endsWith(`@${version}`)) {
    fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} Release coordinates do not share one exact tag`)
  }
  return Object.freeze({
    sourceType: 'github-release', repository, tag, revision, artifactUrl,
    redirectPolicy: 'github-release',
    sourceEndpoint: `${GITHUB_API_ORIGIN}/repos/${repository.owner}/${repository.repository}/git/ref/tags/${encodeURIComponent(tag)}`,
  })
}

async function githubReleaseObservation(entry, coordinates, fetchImpl, token) {
  const refDocument = record(await fetchJson(
    coordinates.sourceEndpoint,
    fetchImpl,
    token,
    `${entry.candidateRef} GitHub tag ref`,
  ), `${entry.candidateRef} GitHub tag ref`)
  if (refDocument.ref !== `refs/tags/${coordinates.tag}`) {
    fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} GitHub ref identity changed`)
  }
  let objectValue = refDocument.object
  for (let depth = 0; depth < 4; depth += 1) {
    const object = record(objectValue, `${entry.candidateRef} GitHub tag object`)
    const sha = boundedText(object.sha, `${entry.candidateRef} GitHub object SHA`, 40)
    if (!/^[0-9a-f]{40}$/u.test(sha)) fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} GitHub object SHA is invalid`)
    if (object.type === 'commit') {
      if (sha !== coordinates.revision) fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} tag no longer resolves to its admitted commit`)
      return Object.freeze({ sourceType: 'github-release', endpoint: coordinates.sourceEndpoint, resolvedRevision: sha })
    }
    if (object.type !== 'tag') fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} tag resolves to an unsupported object`)
    const tagDocument = record(await fetchJson(
      `${GITHUB_API_ORIGIN}/repos/${coordinates.repository.owner}/${coordinates.repository.repository}/git/tags/${sha}`,
      fetchImpl,
      token,
      `${entry.candidateRef} annotated GitHub tag`,
    ), `${entry.candidateRef} annotated GitHub tag`)
    if (tagDocument.sha !== sha || (depth === 0 && tagDocument.tag !== coordinates.tag)) {
      fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} annotated tag identity changed`)
    }
    objectValue = tagDocument.object
  }
  fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} annotated tag chain exceeds its bound`)
}

function githubContentCoordinates(entry) {
  const source = record(entry.source, `${entry.candidateRef} source`)
  const artifact = record(entry.artifact, `${entry.candidateRef} artifact`)
  const repository = githubRepository(source, entry.candidateRef)
  const revision = boundedText(source.revision, `${entry.candidateRef} source revision`, 40)
  const artifactPath = cleanRelativePath(artifact.id, `${entry.candidateRef} artifact id`)
  const slash = artifactPath.lastIndexOf('/')
  const sourcePath = slash === -1 ? '' : artifactPath.slice(0, slash)
  const artifactUrl = exactHttpsUrl(artifact.acquisitionUrl, `${entry.candidateRef} artifact URL`)
  if (!/^[0-9a-f]{40}$/u.test(revision) || artifact.version !== revision
    || !entry.candidateRef.startsWith('skill:') || !entry.candidateRef.endsWith(`@${revision}`)
    || artifactUrl.href !== `https://raw.githubusercontent.com/${repository.owner}/${repository.repository}/${revision}/${artifactPath}`
    || source.url !== `${repository.upstream.href}/tree/${revision}/${sourcePath}`) {
    fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} content URL is not bound to its admitted GitHub commit`)
  }
  return Object.freeze({
    sourceType: 'github-content', repository, revision, artifactUrl, redirectPolicy: 'forbidden',
    sourceEndpoint: `${GITHUB_API_ORIGIN}/repos/${repository.owner}/${repository.repository}/git/commits/${revision}`,
  })
}

async function githubContentObservation(entry, coordinates, fetchImpl, token) {
  const document = record(await fetchJson(
    coordinates.sourceEndpoint,
    fetchImpl,
    token,
    `${entry.candidateRef} GitHub commit`,
  ), `${entry.candidateRef} GitHub commit`)
  if (document.sha !== coordinates.revision) {
    fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} GitHub commit identity changed`)
  }
  return Object.freeze({
    sourceType: 'github-content', endpoint: coordinates.sourceEndpoint, resolvedRevision: coordinates.revision,
  })
}

function npmPackageName(value, label) {
  const name = boundedText(value, label, 214)
  const parts = name.startsWith('@') ? name.slice(1).split('/') : [name]
  if ((name.startsWith('@') && parts.length !== 2) || (!name.startsWith('@') && parts.length !== 1)
    || parts.some(part => !/^[a-z0-9][a-z0-9._~-]*$/u.test(part))) {
    fail('P0-CATALOG-SOURCES-SOURCE', `${label} is not one canonical npm package name`)
  }
  return name
}

function mcpRegistryCoordinates(entry) {
  const source = record(entry.source, `${entry.candidateRef} source`)
  const artifact = record(entry.artifact, `${entry.candidateRef} artifact`)
  const version = exactVersion(artifact.version, `${entry.candidateRef} artifact version`)
  const packageName = npmPackageName(artifact.id, `${entry.candidateRef} artifact id`)
  const packageBasename = packageName.slice(packageName.lastIndexOf('/') + 1)
  const artifactUrl = exactHttpsUrl(artifact.acquisitionUrl, `${entry.candidateRef} artifact URL`)
  const repository = githubRepository(source, entry.candidateRef)
  const expectedArtifactUrl = `${NPM_REGISTRY_ORIGIN}/${packageName}/-/${packageBasename}-${version}.tgz`
  const endpoint = `${MCP_REGISTRY_ORIGIN}/v0.1/servers/${encodeURIComponent(entry.name)}/versions/${encodeURIComponent(artifact.version)}`
  if (entry.candidateRef !== `mcp:${entry.name}@${version}` || source.revision !== version
    || source.url !== `${MCP_REGISTRY_ORIGIN}/?q=${encodeURIComponent(entry.name)}`
    || artifactUrl.href !== expectedArtifactUrl) {
    fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} MCP coordinates are not one exact npm-backed Registry version`)
  }
  return Object.freeze({
    sourceType: 'mcp-registry', artifactUrl, redirectPolicy: 'forbidden', repository,
    version, packageName, sourceEndpoint: endpoint,
    packageRegistryEndpoint: `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
  })
}

async function mcpRegistryObservation(entry, coordinates, fetchImpl) {
  const source = record(entry.source, `${entry.candidateRef} source`)
  const artifact = record(entry.artifact, `${entry.candidateRef} artifact`)
  const endpoint = coordinates.sourceEndpoint
  const document = record(await fetchJson(endpoint, fetchImpl, null, `${entry.candidateRef} official MCP Registry version`), `${entry.candidateRef} official MCP Registry version`)
  const server = record(document.server, `${entry.candidateRef} MCP server`)
  const metadata = record(record(document._meta, `${entry.candidateRef} MCP metadata`)['io.modelcontextprotocol.registry/official'], `${entry.candidateRef} official MCP metadata`)
  const repository = record(server.repository, `${entry.candidateRef} MCP repository`)
  const upstream = boundedText(repository.url, `${entry.candidateRef} MCP repository URL`).replace(/\.git$/u, '')
  const packages = server.packages
  const packageMatches = Array.isArray(packages) && packages.some(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const registryBaseUrl = value.registryBaseUrl
    return value.registryType === 'npm' && value.identifier === artifact.id && value.version === artifact.version
      && (registryBaseUrl === undefined || registryBaseUrl === NPM_REGISTRY_ORIGIN || registryBaseUrl === `${NPM_REGISTRY_ORIGIN}/`)
      && typeof value.transport === 'object' && value.transport !== null && value.transport.type === 'stdio'
  })
  if (server.name !== entry.name || server.version !== artifact.version || source.revision !== artifact.version
    || repository.source !== 'github' || upstream !== source.upstreamUrl || upstream !== coordinates.repository.upstream.href
    || metadata.status !== 'active' || !packageMatches) {
    fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} no longer matches one active exact MCP Registry version`)
  }
  const packageDocument = record(await fetchJson(
    coordinates.packageRegistryEndpoint,
    fetchImpl,
    null,
    `${entry.candidateRef} exact npm version`,
  ), `${entry.candidateRef} exact npm version`)
  const dist = record(packageDocument.dist, `${entry.candidateRef} npm dist`)
  const npmIntegrity = boundedText(dist.integrity, `${entry.candidateRef} npm integrity`, 256)
  if (packageDocument.name !== coordinates.packageName || packageDocument.version !== coordinates.version
    || dist.tarball !== coordinates.artifactUrl.href
    || !artifact.integrity.startsWith('sha512:')
    || npmIntegrity !== artifact.integrity.replace('sha512:', 'sha512-')) {
    fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} npm metadata does not bind the admitted tarball and integrity`)
  }
  return Object.freeze({
    sourceType: 'mcp-registry', endpoint, resolvedRevision: artifact.version,
    packageRegistryEndpoint: coordinates.packageRegistryEndpoint,
  })
}

function sourceCoordinates(entry) {
  const source = record(entry.source, `${entry.candidateRef} source`)
  const expected = { plugin: 'github-release', skill: 'github-content', mcp: 'mcp-registry' }[entry.kind]
  if (source.type !== expected) fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} source type does not match its extension kind`)
  if (source.type === 'github-release') return githubReleaseCoordinates(entry)
  if (source.type === 'github-content') return githubContentCoordinates(entry)
  if (source.type === 'mcp-registry') return mcpRegistryCoordinates(entry)
  fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} uses an unsupported source type`)
}

async function sourceObservation(entry, coordinates, fetchImpl, token) {
  if (coordinates.sourceType === 'github-release') return githubReleaseObservation(entry, coordinates, fetchImpl, token)
  if (coordinates.sourceType === 'github-content') return githubContentObservation(entry, coordinates, fetchImpl, token)
  if (coordinates.sourceType === 'mcp-registry') return mcpRegistryObservation(entry, coordinates, fetchImpl)
  fail('P0-CATALOG-SOURCES-SOURCE', `${entry.candidateRef} uses an unsupported source type`)
}

/** Re-fetch every signed artifact and exact upstream version without promoting discovery leads. */
export async function verifyCatalogSources(envelope, dependencies = {}) {
  const input = record(envelope, 'catalog envelope')
  if (!Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > 100) {
    fail('P0-CATALOG-SOURCES-FORMAT', 'catalog entries are absent or exceed their bound')
  }
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const token = dependencies.githubToken ?? null
  if (typeof fetchImpl !== 'function') fail('P0-CATALOG-SOURCES-FETCH', 'HTTPS fetch is unavailable')
  if (token !== null && (typeof token !== 'string' || token.length === 0 || token.length > 4_096 || /[\r\n]/u.test(token))) {
    fail('P0-CATALOG-SOURCES-INPUT', 'GitHub token is invalid')
  }
  const entries = [...input.entries]
    .map(entryValue => record(entryValue, 'catalog entry'))
    .sort((left, right) => boundedText(left.candidateRef, 'catalog candidateRef', 512)
      .localeCompare(boundedText(right.candidateRef, 'catalog candidateRef', 512)))
    .map(entry => Object.freeze({ entry, coordinates: sourceCoordinates(entry) }))
  const observations = []
  for (const { entry, coordinates } of entries) {
    const source = await sourceObservation(entry, coordinates, fetchImpl, token)
    const artifact = await fetchArtifact(entry, coordinates, fetchImpl)
    observations.push(Object.freeze({
      candidateRef: entry.candidateRef,
      kind: entry.kind,
      entryDigest: canonicalSha256(entry),
      source,
      artifact,
    }))
  }
  return Object.freeze(observations)
}

async function readCatalog(path, now) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 512 * 1024) {
    fail('P0-CATALOG-SOURCES-INPUT', 'catalog input must be one bounded regular file')
  }
  const bytes = await readFile(path)
  let document
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    document = JSON.parse(text)
    if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || `${canonicalJson(document)}\n` !== text) {
      fail('P0-CATALOG-SOURCES-FORMAT', 'catalog input is not one canonical JSON line')
    }
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error
    fail('P0-CATALOG-SOURCES-FORMAT', 'catalog input is not strict UTF-8 JSON')
  }
  verifySignedPublicCatalogAdvance(document, now)
  return Object.freeze({ document, bytes })
}

/** Verify the committed signed catalog's source and artifact coordinates and return one digest-bound receipt. */
export async function verifyCatalogSourceFreshness(dependencies = {}) {
  const now = dependencies.now ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0) fail('P0-CATALOG-SOURCES-INPUT', 'acceptance time is invalid')
  const loaded = await readCatalog(dependencies.catalogPath ?? DEFAULT_CATALOG_PATH, now)
  const observations = await verifyCatalogSources(loaded.document.envelope, {
    fetchImpl: dependencies.fetchImpl,
    githubToken: dependencies.githubToken ?? process.env.GITHUB_TOKEN ?? null,
  })
  const body = Object.freeze({
    schemaVersion: 2,
    acceptanceId: 'P0-CATALOG-SOURCE-FRESHNESS',
    status: 'passed',
    p0Status: 'exact-signed-catalog-source-observations-proven',
    observedAt: new Date(now).toISOString(),
    catalog: Object.freeze({
      revision: loaded.document.envelope.revision,
      entriesDigest: loaded.document.envelope.entriesDigest,
      documentDigest: canonicalSha256(loaded.document),
      bytesSha256: `sha256:${createHash('sha256').update(loaded.bytes).digest('hex')}`,
    }),
    entries: observations,
    notProven: Object.freeze([
      'third-party-code-safety',
      'human-authority-review-independent-reexecution',
      'future-source-availability-or-status',
    ]),
  })
  return Object.freeze({ ...body, receiptDigest: canonicalSha256(body) })
}

async function prepareReceiptDestination(path) {
  const requested = resolve(path)
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 })
  const destination = resolve(await realpath(dirname(requested)), basename(requested))
  try {
    await lstat(destination)
    fail('P0-CATALOG-SOURCES-RECEIPT', 'catalog source receipt output already exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return destination
}

async function writeReceipt(destination, receipt) {
  const temporary = resolve(dirname(destination), `.catalog-sources-${randomUUID()}`)
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  try {
    await link(temporary, destination)
  } catch (error) {
    if (error?.code === 'EEXIST') fail('P0-CATALOG-SOURCES-RECEIPT', 'catalog source receipt appeared concurrently')
    throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** Run source freshness acceptance and atomically persist its receipt. */
export async function runCatalogSourceFreshnessAcceptance(options = {}) {
  const receiptPath = await prepareReceiptDestination(options.receiptPath ?? DEFAULT_RECEIPT_PATH)
  const receipt = await verifyCatalogSourceFreshness(options)
  await writeReceipt(receiptPath, receipt)
  return Object.freeze({ receipt, receiptPath })
}

export function parseCatalogSourceArguments(arguments_) {
  if (!Array.isArray(arguments_)) fail('P0-CATALOG-SOURCES-INPUT', 'CLI arguments must be an array')
  if (arguments_.length === 0) return Object.freeze({ help: false, receiptPath: DEFAULT_RECEIPT_PATH })
  if (arguments_.length === 1 && arguments_[0] === '--help') return Object.freeze({ help: true })
  if (arguments_.length === 2 && arguments_[0] === '--receipt'
    && typeof arguments_[1] === 'string' && arguments_[1].length > 0
    && arguments_[1].length <= 4_096 && !arguments_[1].includes('\0')) {
    return Object.freeze({ help: false, receiptPath: resolve(arguments_[1]) })
  }
  fail('P0-CATALOG-SOURCES-INPUT', 'CLI accepts only one optional --receipt path')
}

async function main() {
  try {
    const parsed = parseCatalogSourceArguments(process.argv.slice(2))
    if (parsed.help) {
      process.stdout.write(USAGE)
      return 0
    }
    const result = await runCatalogSourceFreshnessAcceptance({ receiptPath: parsed.receiptPath })
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
