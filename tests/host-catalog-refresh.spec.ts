import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { CatalogEnvelope, CatalogRoot } from '../src/catalog-contract.ts'
import {
  CatalogSnapshotManager,
  canonicalCatalogUrl,
  verifyCatalogAdvance,
  type SignedCatalogDocument,
} from '../src/catalog-refresh.ts'
import {
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from '../src/catalog-data.ts'
import { canonicalJson, canonicalSha256, verifyCatalog } from '../src/catalog.ts'

const NOW = Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000
const CATALOG_URL = 'https://catalog.example.test/project/plugins.json'
const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'extension-center-catalog-'))
  roots.push(root)
  return root
}

function responseAt(url: string, body: BodyInit, init: ResponseInit = {}): Response {
  const response = new Response(body, init)
  Object.defineProperty(response, 'url', { configurable: true, value: url })
  return response
}

function bootstrapResponse(url = CATALOG_URL): Response {
  return responseAt(url, canonicalJson({
    envelope: BOOTSTRAP_CATALOG_ENVELOPE,
    signatures: BOOTSTRAP_CATALOG_SIGNATURES,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function signedChain(): Readonly<{
  root: CatalogRoot
  first: SignedCatalogDocument
  second: SignedCatalogDocument
  document(envelope: CatalogEnvelope): SignedCatalogDocument
}> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const root: CatalogRoot = {
    catalogId: 'test.catalog',
    minimumRevision: 1,
    maximumAgeMs: 60_000,
    threshold: 1,
    keys: [{
      keyId: 'test-key',
      algorithm: 'ed25519',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }],
  }
  const document = (envelope: CatalogEnvelope): SignedCatalogDocument => ({
    envelope,
    signatures: [{
      keyId: 'test-key',
      algorithm: 'ed25519',
      value: sign(null, Buffer.from(canonicalJson(envelope)), privateKey).toString('base64'),
    }],
  })
  const firstEnvelope: CatalogEnvelope = {
    catalogId: root.catalogId,
    revision: 1,
    issuedAt: '2026-08-26T00:00:00.000Z',
    expiresAt: '2026-08-26T00:00:30.000Z',
    previousRevisionDigest: null,
    entriesDigest: canonicalSha256([]),
    entries: [],
  }
  const secondEnvelope: CatalogEnvelope = {
    ...firstEnvelope,
    revision: 2,
    issuedAt: '2026-08-26T00:00:01.000Z',
    expiresAt: '2026-08-26T00:00:31.000Z',
    previousRevisionDigest: canonicalSha256(firstEnvelope),
  }
  return { root, first: document(firstEnvelope), second: document(secondEnvelope), document }
}

describe('live admitted catalog snapshot', () => {
  it('accepts one exact canonical HTTPS resource URL without credentials, query, or fragment', () => {
    expect(canonicalCatalogUrl(CATALOG_URL)).toBe(CATALOG_URL)
    for (const value of [
      'http://catalog.example.test/project/plugins.json',
      'https://user@catalog.example.test/project/plugins.json',
      'https://catalog.example.test/project/plugins.json?revision=1',
      'https://catalog.example.test/project/plugins.json#revision-1',
      'https://CATALOG.example.test/project/plugins.json',
      'https://catalog.example.test:443/project/plugins.json',
      ' https://catalog.example.test/project/plugins.json',
    ]) {
      expect(() => canonicalCatalogUrl(value)).toThrow('one canonical HTTPS URL')
    }
  })

  it('admits one same-or-next signed revision and rejects rollback, gaps, and broken links', () => {
    const chain = signedChain()
    const now = Date.parse(chain.first.envelope.issuedAt) + 2_000
    const first = verifyCatalog(chain.root, chain.first.envelope, chain.first.signatures, now)
    expect(verifyCatalogAdvance(chain.root, first, chain.second, now).envelope.revision).toBe(2)
    expect(() => verifyCatalogAdvance(chain.root, verifyCatalog(
      chain.root,
      chain.second.envelope,
      chain.second.signatures,
      now,
    ), chain.first, now)).toThrow('rollback')
    const gap = chain.document({ ...chain.second.envelope, revision: 3 })
    expect(() => verifyCatalogAdvance(chain.root, first, gap, now)).toThrow('gap')
    const broken = chain.document({ ...chain.second.envelope, previousRevisionDigest: canonicalSha256([]) })
    expect(() => verifyCatalogAdvance(chain.root, first, broken, now)).toThrow('previous revision digest')
  })

  it('downloads a bounded complete signed envelope, persists canonical last-good, and single-flights refresh', async () => {
    const root = await scratch()
    let calls = 0
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => { release = resolve })
    const requests: Array<{ url: string; init: RequestInit | undefined }> = []
    const manager = new CatalogSnapshotManager(root, {
      trustedUrl: CATALOG_URL,
      fetchTimeoutMs: 5_000,
    }, {
      now: () => NOW,
      fetch: (async (input, init) => {
        calls += 1
        requests.push({ url: String(input), init })
        if (calls > 1) await blocked
        return bootstrapResponse()
      }) as typeof fetch,
    })
    await manager.initialize()
    expect(manager.current()).toMatchObject({
      catalog: { envelope: { revision: BOOTSTRAP_CATALOG_ENVELOPE.revision } },
      status: { source: 'remote', freshness: 'fresh', degraded: false },
    })
    const first = manager.refresh()
    const second = manager.refresh()
    expect(first).toBe(second)
    release!()
    await Promise.all([first, second])
    expect(calls).toBe(2)
    expect(requests).toEqual([
      { url: CATALOG_URL, init: expect.objectContaining({ method: 'GET', redirect: 'error' }) },
      { url: CATALOG_URL, init: expect.objectContaining({ method: 'GET', redirect: 'error' }) },
    ])
    const cache = await readFile(join(root, 'catalog', 'last-good.json'), 'utf8')
    expect(cache).toBe(`${canonicalJson(JSON.parse(cache))}\n`)
  })

  it('retains an unexpired last-good snapshot with explicit degraded evidence on fetch and size failures', async () => {
    const root = await scratch()
    let mode: 'ok' | 'network' | 'oversized' | 'redirected' | 'wrong-content-type' | 'invalid-json' = 'ok'
    const manager = new CatalogSnapshotManager(root, {
      trustedUrl: CATALOG_URL,
      fetchTimeoutMs: 5_000,
    }, {
      now: () => NOW,
      fetch: (async () => {
        if (mode === 'network') throw new Error('deterministic offline')
        if (mode === 'oversized') {
          return responseAt(CATALOG_URL, 'x', {
            status: 200,
            headers: { 'content-type': 'application/json', 'content-length': String(512 * 1024 + 1) },
          })
        }
        if (mode === 'redirected') return bootstrapResponse('https://other.example.test/plugins.json')
        if (mode === 'wrong-content-type') {
          return responseAt(CATALOG_URL, '{}', { status: 200, headers: { 'content-type': 'text/plain' } })
        }
        if (mode === 'invalid-json') {
          return responseAt(CATALOG_URL, '{', { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return bootstrapResponse()
      }) as typeof fetch,
    })
    await manager.initialize()
    mode = 'network'
    await expect(manager.refresh()).resolves.toMatchObject({
      status: { degraded: true, degradedReason: 'deterministic offline' },
    })
    mode = 'oversized'
    await expect(manager.refresh()).resolves.toMatchObject({
      status: { degraded: true, degradedReason: 'catalog response exceeds its download bound' },
    })
    mode = 'redirected'
    await expect(manager.refresh()).resolves.toMatchObject({
      status: { degraded: true, degradedReason: 'catalog endpoint redirected outside its fixed URL' },
    })
    mode = 'wrong-content-type'
    await expect(manager.refresh()).resolves.toMatchObject({
      status: { degraded: true, degradedReason: 'catalog endpoint did not return application/json' },
    })
    mode = 'invalid-json'
    await expect(manager.refresh()).resolves.toMatchObject({
      status: { degraded: true, degradedReason: 'catalog response is not strict UTF-8 JSON' },
    })
    expect(manager.current().catalog.envelope.entriesDigest).toBe(BOOTSTRAP_CATALOG_ENVELOPE.entriesDigest)
  })

  it('never follows a substituted last-good symlink', async () => {
    const root = await scratch()
    const first = new CatalogSnapshotManager(root, { trustedUrl: null, fetchTimeoutMs: 5_000 }, {
      now: () => NOW,
      fetch: globalThis.fetch,
    })
    await first.initialize()
    const cache = join(root, 'catalog', 'last-good.json')
    const target = join(root, 'attacker.json')
    const { rm, writeFile } = await import('node:fs/promises')
    await writeFile(target, '{}\n')
    await rm(cache)
    await symlink(target, cache)
    const reopened = new CatalogSnapshotManager(root, { trustedUrl: null, fetchTimeoutMs: 5_000 }, {
      now: () => NOW,
      fetch: globalThis.fetch,
    })
    await expect(reopened.initialize()).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('{}\n')
  })
})
