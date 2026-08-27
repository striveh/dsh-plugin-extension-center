import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { AcceptanceFailure } from '../full-p0/support.mjs'
import {
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_ROOT,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from '../../lib/catalog-data.js'
import { canonicalJson, canonicalSha256 } from '../../lib/catalog.js'
import {
  EXPECTED_PUBLIC_CATALOG,
  PUBLIC_CATALOG_URL,
  assertPackagedCatalogAuthority,
  parsePublicCatalogArguments,
  runPublicCatalogDeploymentAcceptance,
  verifyPublicCatalogDeployment,
  verifySignedPublicCatalogAdvance,
} from './verify-public-catalog.mjs'

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const deployedBytes = await readFile(join(projectRoot, 'catalog/public/plugins.json'))
const deployedDocument = JSON.parse(deployedBytes)
const NOW = Date.parse(deployedDocument.envelope.issuedAt) + 1_000

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function acceptanceCode(code) {
  return error => error instanceof AcceptanceFailure && error.code === code
}

function responseAt(body, options = {}) {
  const bytes = Buffer.from(body)
  const headers = new Headers(options.headers ?? {})
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
  if (!options.omitContentLength && !headers.has('content-length')) headers.set('content-length', String(bytes.length))
  const response = new Response(bytes, { status: options.status ?? 200, headers })
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: options.url ?? PUBLIC_CATALOG_URL,
  })
  if (options.redirected === true) Object.defineProperty(response, 'redirected', { configurable: true, value: true })
  return response
}

function localFetch(factory) {
  const calls = []
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init })
    return factory()
  }
  return { calls, fetchImpl }
}

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), 'public-catalog-acceptance-test-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('accepts the exact committed adjacent successor and writes a SHA-bound receipt', async () => {
  assert.equal(deployedBytes.length, EXPECTED_PUBLIC_CATALOG.sizeBytes)
  assert.equal(digest(deployedBytes), EXPECTED_PUBLIC_CATALOG.bytesSha256)
  assert.equal(canonicalSha256(deployedDocument), EXPECTED_PUBLIC_CATALOG.documentDigest)
  assert.equal(EXPECTED_PUBLIC_CATALOG.previousRevision, BOOTSTRAP_CATALOG_ENVELOPE.revision)
  assert.equal(EXPECTED_PUBLIC_CATALOG.revision, BOOTSTRAP_CATALOG_ENVELOPE.revision + 1)
  assert.equal(EXPECTED_PUBLIC_CATALOG.envelopeDigest, canonicalSha256(deployedDocument.envelope))
  const network = localFetch(() => responseAt(deployedBytes))
  await withTemporaryDirectory(async root => {
    const receiptPath = join(root, 'receipt.json')
    const result = await runPublicCatalogDeploymentAcceptance({
      fetchImpl: network.fetchImpl,
      now: NOW,
      receiptPath,
    })
    assert.equal(result.receiptPath, await realpath(receiptPath))
    assert.equal(result.receipt.schemaVersion, 2)
    assert.deepEqual(result.receipt.target, {
      url: PUBLIC_CATALOG_URL,
      redirectPolicy: 'forbidden',
      expectedContentType: 'application/json',
      expectedRevision: EXPECTED_PUBLIC_CATALOG.revision,
      expectedSizeBytes: EXPECTED_PUBLIC_CATALOG.sizeBytes,
      expectedBytesSha256: EXPECTED_PUBLIC_CATALOG.bytesSha256,
      expectedEnvelopeDigest: EXPECTED_PUBLIC_CATALOG.envelopeDigest,
    })
    assert.deepEqual(result.receipt.packagedBootstrap, {
      revision: EXPECTED_PUBLIC_CATALOG.previousRevision,
      previousRevisionDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapPreviousRevisionDigest,
      entriesDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapEntriesDigest,
      envelopeDigest: EXPECTED_PUBLIC_CATALOG.previousRevisionDigest,
      rootDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapRootDigest,
      signatureSetDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapSignatureSetDigest,
    })
    assert.deepEqual(result.receipt.runtimeRefresh, {
      source: 'remote',
      freshness: 'fresh',
      degraded: false,
      degradedReason: null,
      lastRefreshAtMs: NOW,
      revision: EXPECTED_PUBLIC_CATALOG.revision,
      entriesDigest: EXPECTED_PUBLIC_CATALOG.entriesDigest,
      keyIds: deployedDocument.signatures.map(signature => signature.keyId),
    })
    assert.deepEqual(result.receipt.deployment, {
      httpStatus: 200,
      finalUrl: PUBLIC_CATALOG_URL,
      redirected: false,
      contentType: 'application/json',
      sizeBytes: EXPECTED_PUBLIC_CATALOG.sizeBytes,
      bytesSha256: EXPECTED_PUBLIC_CATALOG.bytesSha256,
      canonicalOneLine: true,
      documentDigest: EXPECTED_PUBLIC_CATALOG.documentDigest,
      envelopeDigest: EXPECTED_PUBLIC_CATALOG.envelopeDigest,
      signatureSetDigest: EXPECTED_PUBLIC_CATALOG.signatureSetDigest,
      revision: EXPECTED_PUBLIC_CATALOG.revision,
      previousRevisionDigest: EXPECTED_PUBLIC_CATALOG.previousRevisionDigest,
      entriesDigest: EXPECTED_PUBLIC_CATALOG.entriesDigest,
      keyIds: deployedDocument.signatures.map(signature => signature.keyId),
    })
    const written = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal((await stat(receiptPath)).mode & 0o777, 0o600)
    const { receiptDigest, ...body } = written
    assert.equal(receiptDigest, canonicalSha256(body))
    assert.deepEqual(written, result.receipt)
  })
  assert.equal(network.calls.length, 1)
  assert.equal(network.calls[0].url, PUBLIC_CATALOG_URL)
  assert.equal(network.calls[0].init.method, 'GET')
  assert.equal(network.calls[0].init.redirect, 'manual')
  assert.deepEqual(network.calls[0].init.headers, {
    accept: 'application/json',
    'accept-encoding': 'identity',
  })
})

test('rejects any public catalog redirect', async () => {
  for (const response of [
    () => responseAt('', {
      status: 302,
      url: PUBLIC_CATALOG_URL,
      headers: { location: 'https://example.test/plugins.json' },
    }),
    () => responseAt(deployedBytes, {
      url: 'https://example.test/plugins.json',
      redirected: true,
    }),
  ]) {
    const network = localFetch(response)
    await assert.rejects(
      verifyPublicCatalogDeployment({ fetchImpl: network.fetchImpl, now: NOW }),
      acceptanceCode('P0-PUBLIC-CATALOG-REDIRECT'),
    )
  }
})

test('rejects tampered successor bytes even when canonical length and coordinates remain unchanged', async () => {
  const tampered = structuredClone(deployedDocument)
  const signature = tampered.signatures[0].value
  tampered.signatures[0].value = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
  const bytes = Buffer.from(`${canonicalJson(tampered)}\n`)
  assert.equal(bytes.length, deployedBytes.length)
  const network = localFetch(() => responseAt(bytes))
  await assert.rejects(
    verifyPublicCatalogDeployment({ fetchImpl: network.fetchImpl, now: NOW }),
    acceptanceCode('P0-PUBLIC-CATALOG-BYTES'),
  )
})

test('direct signature verification rejects a tampered signature independently of the byte pin', () => {
  const tampered = structuredClone(deployedDocument)
  const signature = tampered.signatures[0].value
  tampered.signatures[0].value = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
  assert.throws(
    () => verifySignedPublicCatalogAdvance(tampered, NOW),
    acceptanceCode('P0-PUBLIC-CATALOG-SIGNATURE'),
  )
})

test('rejects drift in the packaged trust root or bootstrap signature set', () => {
  assert.throws(
    () => assertPackagedCatalogAuthority({ ...BOOTSTRAP_CATALOG_ROOT, threshold: 0 }),
    acceptanceCode('P0-PUBLIC-CATALOG-AUTHORITY'),
  )
  assert.throws(
    () => assertPackagedCatalogAuthority(
      BOOTSTRAP_CATALOG_ROOT,
      BOOTSTRAP_CATALOG_ENVELOPE,
      [],
    ),
    acceptanceCode('P0-PUBLIC-CATALOG-AUTHORITY'),
  )
})

test('rejects the valid signed packaged bootstrap as a deployment rollback', async () => {
  const rollback = Buffer.from(`${canonicalJson({
    envelope: BOOTSTRAP_CATALOG_ENVELOPE,
    signatures: BOOTSTRAP_CATALOG_SIGNATURES,
  })}\n`)
  const network = localFetch(() => responseAt(rollback))
  await assert.rejects(
    verifyPublicCatalogDeployment({ fetchImpl: network.fetchImpl, now: NOW }),
    acceptanceCode('P0-PUBLIC-CATALOG-ROLLBACK'),
  )
})

test('rejects a non-JSON content type before reading deployment bytes', async () => {
  const network = localFetch(() => responseAt(deployedBytes, {
    headers: { 'content-type': 'text/plain', 'content-length': String(deployedBytes.length) },
  }))
  await assert.rejects(
    verifyPublicCatalogDeployment({ fetchImpl: network.fetchImpl, now: NOW }),
    acceptanceCode('P0-PUBLIC-CATALOG-CONTENT-TYPE'),
  )
})

test('rejects non-200, oversized, and noncanonical deployment responses', async () => {
  const cases = [
    {
      code: 'P0-PUBLIC-CATALOG-HTTP',
      response: () => responseAt(deployedBytes, { status: 503 }),
    },
    {
      code: 'P0-PUBLIC-CATALOG-SIZE',
      response: () => responseAt('', {
        headers: { 'content-type': 'application/json', 'content-length': String(512 * 1024 + 1) },
      }),
    },
    {
      code: 'P0-PUBLIC-CATALOG-SIZE',
      response: () => responseAt(Buffer.alloc(512 * 1024 + 1, 0x20), { omitContentLength: true }),
    },
    {
      code: 'P0-PUBLIC-CATALOG-SIZE',
      response: () => responseAt(deployedBytes, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(deployedBytes.length + 1),
        },
      }),
    },
    {
      code: 'P0-PUBLIC-CATALOG-FORMAT',
      response: () => responseAt(Buffer.concat([deployedBytes, Buffer.from('\n')])),
    },
  ]
  for (const fixture of cases) {
    const network = localFetch(fixture.response)
    await assert.rejects(
      verifyPublicCatalogDeployment({ fetchImpl: network.fetchImpl, now: NOW }),
      acceptanceCode(fixture.code),
    )
  }
})

test('never overwrites an existing or symlinked receipt destination', async () => {
  await withTemporaryDirectory(async root => {
    const target = join(root, 'existing.json')
    const link = join(root, 'link.json')
    await writeFile(target, 'keep\n')
    await symlink(target, link)
    for (const receiptPath of [target, link]) {
      const network = localFetch(() => responseAt(deployedBytes))
      await assert.rejects(
        runPublicCatalogDeploymentAcceptance({ fetchImpl: network.fetchImpl, now: NOW, receiptPath }),
        acceptanceCode('P0-PUBLIC-CATALOG-RECEIPT'),
      )
      assert.equal(network.calls.length, 0)
    }
    assert.equal(await readFile(target, 'utf8'), 'keep\n')
  })
})

test('accepts only the fixed optional receipt CLI argument', () => {
  assert.deepEqual(parsePublicCatalogArguments([]), {
    help: false,
    receiptPath: resolve(projectRoot, '.artifacts/acceptance/public-catalog/receipt.json'),
  })
  assert.deepEqual(parsePublicCatalogArguments(['--help']), { help: true })
  assert.deepEqual(parsePublicCatalogArguments(['--receipt', '/tmp/public-catalog-receipt.json']), {
    help: false,
    receiptPath: '/tmp/public-catalog-receipt.json',
  })
  assert.throws(
    () => parsePublicCatalogArguments(['--url', 'https://example.test/plugins.json']),
    acceptanceCode('P0-PUBLIC-CATALOG-INPUT'),
  )
})
