#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canonicalJson } from '../lib/catalog.js'
import {
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_ROOT,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from '../lib/catalog-data.js'
import {
  ALPHA_WIKI_CANDIDATES,
  PRODUCTION_ALPHA_ADMISSION_POLICY,
  prepareAlphaCatalogAdmission,
  prepareAlphaLifecycleCatalog,
} from './alpha-catalog-admission-core.mjs'

const MAX_JSON_BYTES = 32 * 1024 * 1024
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 64 * 1024
const SHA256 = /^sha256:[a-f0-9]{64}$/u

function fail(message) {
  throw new Error(`alpha-catalog-admission: ${message}`)
}

function argumentsFor(command, values) {
  if (!['admit', 'lifecycle-candidate'].includes(command)) {
    fail('usage: admit ... | lifecycle-candidate ...')
  }
  if (values.length % 2 !== 0) fail('expects --name value pairs')
  const options = new Map()
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]
    const value = values[index + 1]
    if (name === undefined || value === undefined || !name.startsWith('--') || options.has(name.slice(2))) {
      fail('expects unique --name value pairs')
    }
    options.set(name.slice(2), value)
  }
  const one = (name) => {
    const value = options.get(name)
    if (value === undefined) fail(`requires --${name}`)
    options.delete(name)
    return value
  }
  const common = {
    previousPath: resolve(one('previous')),
    privateKeyPath: resolve(one('private-key')),
    outputPath: resolve(one('out')),
    evidencePath: resolve(one('evidence-out')),
  }
  const input = Object.freeze(command === 'admit'
    ? {
      ...common,
      mode: 'admit',
      centerSourceCommit: one('center-source-commit'),
      lifecycleReceiptPath: resolve(one('lifecycle-receipt')),
      lifecycleReceiptSha256: one('lifecycle-receipt-sha256'),
    }
    : { ...common, mode: 'lifecycle-candidate' })
  if (options.size > 0) fail(`does not support --${options.keys().next().value}`)
  if (input.outputPath === input.evidencePath) fail('document and evidence outputs must differ')
  if (input.mode === 'admit' && !SHA256.test(input.lifecycleReceiptSha256)) {
    fail('--lifecycle-receipt-sha256 must be canonical')
  }
  return input
}

async function boundedFile(path, maximum, subject) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) {
    fail(`${subject} must be a bounded regular file`)
  }
  return readFile(path)
}

async function canonicalJsonFile(path, maximum, subject) {
  const bytes = await boundedFile(path, maximum, subject)
  let value
  let body
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    value = JSON.parse(body)
  } catch {
    fail(`${subject} must be strict UTF-8 JSON`)
  }
  if (!body.endsWith('\n') || body.slice(0, -1).includes('\n') || `${canonicalJson(value)}\n` !== body) {
    fail(`${subject} must be one canonical JSON line`)
  }
  return Object.freeze({ value, bytes })
}

async function privateKey(path) {
  const bytes = await boundedFile(path, 64 * 1024, 'catalog private key')
  const info = await lstat(path)
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    fail('catalog private-key permissions must exclude group and other users')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('catalog private key must be strict UTF-8')
  }
}

async function responseBytes(url, maximum, accept, token = null) {
  const headers = {
    Accept: accept,
    'User-Agent': 'dsh-extension-center-alpha-catalog-admission/0.2.0-alpha.1',
  }
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`
    headers['X-GitHub-Api-Version'] = '2022-11-28'
  }
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers,
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status !== 200 || response.url !== url || response.body === null) {
    fail(`external source ${url} did not return its exact HTTP 200 resource`)
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const expectedContentType = accept === 'application/vnd.github+json' ? 'application/json' : 'text/plain'
  if (contentType !== expectedContentType) {
    fail(`external source ${url} returned an unexpected content type`)
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    fail(`external source ${url} exceeds its byte bound`)
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > maximum) {
        await reader.cancel()
        fail(`external source ${url} exceeds its byte bound`)
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
  const sourceDate = response.headers.get('date')
  const observedAtMs = Date.parse(sourceDate ?? '')
  if (!Number.isFinite(observedAtMs) || Math.abs(Date.now() - observedAtMs) > 5 * 60 * 1_000) {
    fail(`external source ${url} did not provide a current authenticated HTTP Date`)
  }
  return Object.freeze({ bytes, observedAt: new Date(observedAtMs).toISOString() })
}

async function responseJson(url, token) {
  const response = await responseBytes(url, MAX_JSON_BYTES, 'application/vnd.github+json', token)
  try {
    return Object.freeze({
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)),
      observedAt: response.observedAt,
    })
  } catch {
    fail(`external source ${url} is not strict UTF-8 JSON`)
  }
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

async function main(options) {
  const token = process.env.GITHUB_TOKEN
  if (typeof token !== 'string' || token.length < 1 || token.length > 4_096) {
    fail('GITHUB_TOKEN is required for bounded GitHub metadata verification')
  }
  const [previous, lifecycle, key] = await Promise.all([
    canonicalJsonFile(options.previousPath, MAX_JSON_BYTES, 'previous catalog'),
    options.mode === 'admit'
      ? canonicalJsonFile(options.lifecycleReceiptPath, MAX_RECEIPT_BYTES, 'lifecycle receipt')
      : Promise.resolve(null),
    privateKey(options.privateKeyPath),
  ])
  let workflowRun
  if (options.mode === 'admit') {
    const observedLifecycleSha256 = `sha256:${createHash('sha256').update(lifecycle.bytes).digest('hex')}`
    if (observedLifecycleSha256 !== options.lifecycleReceiptSha256) {
      fail('downloaded lifecycle receipt SHA-256 does not match the dispatch input')
    }
    const runId = lifecycle.value?.run?.runId
    if (!Number.isSafeInteger(runId) || runId < 1) fail('lifecycle receipt run id is invalid')
    const workflowRunUrl = `https://api.github.com/repos/striveh/dsh-plugin-extension-center/actions/runs/${String(runId)}`
    workflowRun = (await responseJson(workflowRunUrl, token)).value
  }
  const search = await responseJson(PRODUCTION_ALPHA_ADMISSION_POLICY.searchUrl, token)
  const commitDocuments = {}
  const treeDocuments = {}
  const artifacts = {}
  for (const candidate of ALPHA_WIKI_CANDIDATES) {
    const commitUrl = `https://api.github.com/repos/microsoft/skills/git/commits/${candidate.version}`
    commitDocuments[candidate.version] = (await responseJson(commitUrl, token)).value
    const treeUrl = `https://api.github.com/repos/microsoft/skills/git/trees/${candidate.treeSha}?recursive=1`
    treeDocuments[candidate.version] = (await responseJson(treeUrl, token)).value
    artifacts[candidate.version] = (await responseBytes(candidate.rawUrl, MAX_ARTIFACT_BYTES, 'text/plain')).bytes
  }
  const lifecycleTimes = options.mode === 'admit'
    ? {
      observedAt: lifecycle.value?.target?.catalogObservedAt,
      issuedAt: lifecycle.value?.target?.catalogIssuedAt,
      expiresAt: lifecycle.value?.target?.catalogExpiresAt,
    }
    : {
      observedAt: search.observedAt,
      issuedAt: search.observedAt,
      expiresAt: new Date(Date.parse(search.observedAt) + 24 * 60 * 60 * 1_000).toISOString(),
    }
  const commonInput = {
    previous: previous.value,
    previousFileSha256: `sha256:${createHash('sha256').update(previous.bytes).digest('hex')}`,
    packagedPrevious: {
      envelope: BOOTSTRAP_CATALOG_ENVELOPE,
      signatures: BOOTSTRAP_CATALOG_SIGNATURES,
    },
    root: BOOTSTRAP_CATALOG_ROOT,
    searchDocument: search.value,
    commitDocuments,
    treeDocuments,
    artifacts,
    ...lifecycleTimes,
    signers: [{ keyId: 'bootstrap-2026-08-26-8', privateKeyPem: key }],
  }
  const result = options.mode === 'admit'
    ? prepareAlphaCatalogAdmission({
      ...commonInput,
      lifecycleReceipt: lifecycle.value,
      workflowRun,
      centerSourceCommit: options.centerSourceCommit,
      admissionTimeMs: Date.now(),
    })
    : prepareAlphaLifecycleCatalog(commonInput)
  await writeExclusive(options.outputPath, result.document)
  await writeExclusive(options.evidencePath, result.evidence)
  const label = options.mode === 'admit' ? 'for review' : 'for isolated lifecycle development evidence'
  process.stdout.write(`alpha-catalog-admission: prepared signed revision ${String(result.evidence.revision)} ${label} (${result.evidence.documentDigest})\n`)
}

try {
  const [command, ...values] = process.argv.slice(2)
  await main(argumentsFor(command, values))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'alpha-catalog-admission failed'}\n`)
  process.exitCode = 1
}
