#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { canonicalJson } from '../lib/catalog.js'
import {
  admitCatalogEntries,
  createSignedCatalogDocument,
  discoverCommunityCatalog,
  discoverGithubSkillRepositories,
  discoverOfficialMcpRegistry,
} from './catalog-pipeline-core.mjs'

const COMMUNITY_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const MCP_REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io'
const GITHUB_SKILL_SEARCHES = Object.freeze([
  Object.freeze({
    sourceId: 'github-agent-skill-search',
    url: 'https://api.github.com/search/repositories?q=topic%3Aagent-skill&sort=updated&order=desc&per_page=100&page=1',
  }),
  Object.freeze({
    sourceId: 'github-agent-skills-search',
    url: 'https://api.github.com/search/repositories?q=topic%3Aagent-skills&sort=updated&order=desc&per_page=100&page=1',
  }),
])
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
const MAX_INPUT_BYTES = 16 * 1024 * 1024
const PACKAGE_VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
if (typeof PACKAGE_VERSION !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(PACKAGE_VERSION)) {
  throw new Error('catalog-pipeline: package version is invalid')
}

function fail(message) {
  throw new Error(`catalog-pipeline: ${message}`)
}

function argumentsFor(command, values) {
  const options = new Map()
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]
    const value = values[index + 1]
    if (name === undefined || value === undefined || !name.startsWith('--')) fail(`${command} expects --name value pairs`)
    const key = name.slice(2)
    const prior = options.get(key)
    options.set(key, prior === undefined ? [value] : [...prior, value])
  }
  return {
    one(name, { required = false } = {}) {
      const values = options.get(name)
      if (values === undefined) {
        if (required) fail(`${command} requires --${name}`)
        return undefined
      }
      if (values.length !== 1) fail(`${command} accepts --${name} once`)
      options.delete(name)
      return values[0]
    },
    many(name) {
      const output = options.get(name) ?? []
      options.delete(name)
      return output
    },
    done() {
      const unknown = [...options.keys()]
      if (unknown.length > 0) fail(`${command} does not support --${unknown[0]}`)
    },
  }
}

async function readBounded(path, maximum = MAX_INPUT_BYTES) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) fail(`${path} must be a bounded regular file`)
  return readFile(path)
}

async function readJson(path) {
  const bytes = await readBounded(path)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    throw new Error(`catalog-pipeline: ${path} is not strict UTF-8 JSON`, { cause })
  }
}

async function readPrivateKey(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) fail(`${path} must be a bounded regular private-key file`)
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail(`${path} private-key permissions must exclude group and other users`)
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
}

async function writeExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function requireAbsent(path, subject) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  fail(`${subject} already exists`)
}

async function responseJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      'User-Agent': `dsh-extension-center-catalog-pipeline/${PACKAGE_VERSION}`,
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status !== 200 || (response.url !== '' && response.url !== url)) fail(`source ${url} did not return its exact HTTP 200 resource`)
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') fail(`source ${url} did not return application/json`)
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_DOCUMENT_BYTES)) {
    fail(`source ${url} exceeds the response bound`)
  }
  if (response.body === null) fail(`source ${url} has no body`)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > MAX_DOCUMENT_BYTES) {
        await reader.cancel()
        fail(`source ${url} exceeds the response bound`)
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    throw new Error(`catalog-pipeline: source ${url} is not strict UTF-8 JSON`, { cause })
  }
}

function canonicalTimestamp(value) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail('timestamps must be canonical ISO strings')
  return value
}

async function discover(options) {
  const output = resolve(options.one('out', { required: true }))
  const now = canonicalTimestamp(options.one('now') ?? new Date().toISOString())
  const maxPagesText = options.one('max-mcp-pages') ?? '20'
  const startingCursor = options.one('mcp-cursor') ?? null
  const updatedSince = options.one('mcp-updated-since')
  if (!/^\d+$/u.test(maxPagesText)) fail('--max-mcp-pages must be an integer')
  const maxPages = Number(maxPagesText)
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) fail('--max-mcp-pages must be between 1 and 100')
  if (startingCursor !== null && (startingCursor.length === 0 || startingCursor.length > 1_024 || startingCursor.trim() !== startingCursor)) {
    fail('--mcp-cursor is invalid')
  }
  if (updatedSince !== undefined) canonicalTimestamp(updatedSince)
  options.done()

  const community = await responseJson(COMMUNITY_URL)
  const sources = [discoverCommunityCatalog(community, COMMUNITY_URL, now)]
  let cursor = startingCursor
  for (let page = 0; page < maxPages; page += 1) {
    const endpoint = new URL('/v0.1/servers', MCP_REGISTRY_ORIGIN)
    endpoint.searchParams.set('limit', '100')
    endpoint.searchParams.set('version', 'latest')
    if (cursor !== null) endpoint.searchParams.set('cursor', cursor)
    if (updatedSince !== undefined) endpoint.searchParams.set('updated_since', updatedSince)
    const document = await responseJson(endpoint.href)
    sources.push(discoverOfficialMcpRegistry(document, endpoint.href, now))
    const metadata = document !== null && typeof document === 'object' && !Array.isArray(document)
      ? document.metadata
      : null
    const next = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata.nextCursor
      : null
    if (next === undefined || next === null || next === '') {
      cursor = null
      break
    }
    if (typeof next !== 'string' || next.length > 1_024 || next.trim() !== next) fail('MCP Registry returned an invalid cursor')
    cursor = next
  }
  for (const search of GITHUB_SKILL_SEARCHES) {
    const github = await responseJson(search.url)
    sources.push(discoverGithubSkillRepositories(github, search.url, now, search.sourceId))
  }
  const report = Object.freeze({
    schemaVersion: 1,
    generatedAt: now,
    continuations: Object.freeze({
      mcpNextCursor: cursor,
      mcpUpdatedSince: updatedSince ?? null,
    }),
    sources: Object.freeze(sources),
  })
  await writeExclusive(output, report)
  const leadCount = sources.reduce((total, source) => total + source.leads.length, 0)
  const rejectedCount = sources.reduce((total, source) => total + source.rejections.length, 0)
  process.stdout.write(`catalog-pipeline: wrote ${String(leadCount)} non-admitted leads; ${String(rejectedCount)} rejected source rows; MCP continuation ${cursor === null ? 'complete' : 'retained'}\n`)
}

function childPath(root, configured, subject) {
  if (typeof configured !== 'string' || configured.length === 0 || isAbsolute(configured)) fail(`${subject} must be a relative path`)
  const path = resolve(root, configured)
  const rel = relative(root, path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) fail(`${subject} escapes --artifact-root`)
  return path
}

async function artifactObservation(root, admission) {
  if (typeof admission !== 'object' || admission === null || Array.isArray(admission)) fail('admission must be an object')
  if (typeof admission.entry !== 'object' || admission.entry === null || Array.isArray(admission.entry)) fail('admission.entry must be an object')
  const path = childPath(root, admission.artifactFile, `${String(admission.entry.candidateRef)} artifactFile`)
  const canonicalRoot = await realpath(root)
  const canonicalPath = await realpath(path)
  const rel = relative(canonicalRoot, canonicalPath)
  if (rel === '' || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) fail('artifact resolves outside --artifact-root')
  const bytes = await readBounded(canonicalPath, 512 * 1024 * 1024)
  const expected = admission.entry.artifact?.integrity
  const integrity = typeof expected === 'string' && expected.startsWith('sha512:')
    ? `sha512:${createHash('sha512').update(bytes).digest('base64')}`
    : `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  return Object.freeze({ integrity, sizeBytes: bytes.byteLength })
}

async function publish(options) {
  const leadsPath = resolve(options.one('leads', { required: true }))
  const admissionsPath = resolve(options.one('admissions', { required: true }))
  const artifactRoot = resolve(options.one('artifact-root', { required: true }))
  const previousPath = resolve(options.one('previous', { required: true }))
  const rootPath = resolve(options.one('root', { required: true }))
  const output = resolve(options.one('out', { required: true }))
  const evidenceOutput = resolve(options.one('evidence-out', { required: true }))
  const issuedAt = canonicalTimestamp(options.one('issued-at', { required: true }))
  const expiresAt = canonicalTimestamp(options.one('expires-at', { required: true }))
  const keyArguments = options.many('key')
  if (keyArguments.length === 0 || keyArguments.length > 16) fail('publish requires one to sixteen --key keyId=private-key.pem values')
  options.done()
  if (output === evidenceOutput) fail('--out and --evidence-out must be different paths')
  await Promise.all([
    requireAbsent(output, 'signed catalog output'),
    requireAbsent(evidenceOutput, 'catalog evidence output'),
  ])

  const [leadDocument, admissionDocument, previous, root] = await Promise.all([
    readJson(leadsPath),
    readJson(admissionsPath),
    readJson(previousPath),
    readJson(rootPath),
  ])
  if (leadDocument?.schemaVersion !== 1 || !Array.isArray(leadDocument.sources)) fail('lead report schema is invalid')
  if (admissionDocument?.schemaVersion !== 1 || !Array.isArray(admissionDocument.admissions)) fail('admission document schema is invalid')
  const artifacts = new Map()
  for (const admission of admissionDocument.admissions) {
    const candidateRef = admission?.entry?.candidateRef
    if (typeof candidateRef !== 'string' || artifacts.has(candidateRef)) fail('admission candidateRef is absent or duplicated')
    artifacts.set(candidateRef, await artifactObservation(artifactRoot, admission))
  }
  const admitted = admitCatalogEntries(leadDocument.sources, admissionDocument.admissions, artifacts)
  const signers = []
  for (const value of keyArguments) {
    const separator = value.indexOf('=')
    if (separator < 1 || separator === value.length - 1) fail('--key must be keyId=private-key.pem')
    const keyId = value.slice(0, separator)
    const keyPath = resolve(value.slice(separator + 1))
    const privateKeyPem = await readPrivateKey(keyPath)
    signers.push(Object.freeze({ keyId, privateKeyPem }))
  }
  const signed = createSignedCatalogDocument({
    root,
    previous,
    entries: admitted.entries,
    issuedAt,
    expiresAt,
    signers,
  })
  const evidence = Object.freeze({
    schemaVersion: 1,
    catalogId: signed.document.envelope.catalogId,
    revision: signed.document.envelope.revision,
    entriesDigest: signed.document.envelope.entriesDigest,
    previousRevisionDigest: signed.document.envelope.previousRevisionDigest,
    signingKeyIds: signed.keyIds,
    admissions: admitted.evidence,
  })
  await writeExclusive(evidenceOutput, evidence)
  await writeExclusive(output, signed.document)
  process.stdout.write(`catalog-pipeline: wrote signed revision ${String(signed.document.envelope.revision)} with ${String(admitted.entries.length)} admitted entries\n`)
}

const [command, ...values] = process.argv.slice(2)
try {
  if (command === 'discover') await discover(argumentsFor(command, values))
  else if (command === 'publish') await publish(argumentsFor(command, values))
  else fail('usage: discover ... | publish ...')
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'catalog-pipeline failed'}\n`)
  process.exitCode = 1
}
