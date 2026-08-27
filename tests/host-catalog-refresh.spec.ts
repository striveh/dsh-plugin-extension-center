// @vitest-environment node

import { fork, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { withCatalogCacheWriter } from '../src/catalog-cache-reservation.ts'
import type { CatalogEnvelope, CatalogRoot } from '../src/catalog-contract.ts'
import {
  CatalogSnapshotManager,
  canonicalCatalogUrl,
  verifyCatalogAdvance,
  type SignedCatalogDocument,
} from '../src/catalog-refresh.ts'
import {
  BOOTSTRAP_CATALOG_ENTRIES,
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_ROOT,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from '../src/catalog-data.ts'
import { canonicalJson, canonicalSha256, verifyCatalog } from '../src/catalog.ts'

const NOW = Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000
const CATALOG_URL = 'https://catalog.example.test/project/plugins.json'
const roots: string[] = []
const children = new Set<ChildProcess>()
const catalogWorker = resolve('tests/fixtures/catalog-refresh-worker.mts')

interface CatalogWorkerMessage {
  readonly event: string
  readonly revision?: number
  readonly source?: string
  readonly freshness?: string
  readonly degraded?: boolean
  readonly degradedReason?: string | null
  readonly message?: string
}

interface CatalogWorker {
  readonly child: ChildProcess
  readonly stderr: () => string
  readonly message: (event: string) => Promise<CatalogWorkerMessage>
}

const LEGACY_R8_REFS = Object.freeze([
  'plugin:dsh-capability-resolver@0.1.0',
  'plugin:dsh-capability-resolver@0.1.1',
  'mcp:io.github.domdomegg/filesystem-mcp@1.2.2',
  'mcp:io.github.domdomegg/filesystem-mcp@1.3.0',
  'skill:github-awesome-copilot/documentation-writer@d0d9d9f014abb27bf0d8321851867500a3a46bba',
  'skill:microsoft-skills/wiki-page-writer@6142f8e60ac58372845c0fcdd2dbf043cd1bb698',
  'skill:microsoft-skills/wiki-page-writer@67ae723a23ba880e3e5c8a3e5e2320092024476e',
])

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function startCatalogWorker(
  mode: 'lock-crash' | 'stale' | 'stale-offline' | 'winner',
  root: string,
  now: number,
): CatalogWorker {
  const child = fork(catalogWorker, [mode, root, String(now)], {
    execArgv: ['--experimental-transform-types', '--no-warnings'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  children.add(child)
  let stderr = ''
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const queued: CatalogWorkerMessage[] = []
  const waiters = new Map<string, Array<Readonly<{
    resolve: (value: CatalogWorkerMessage) => void
    reject: (error: Error) => void
  }>>>()
  child.on('message', (value: CatalogWorkerMessage) => {
    const waiter = waiters.get(value.event)?.shift()
    if (waiter === undefined) queued.push(value)
    else waiter.resolve(value)
  })
  child.on('exit', (code, signal) => {
    children.delete(child)
    for (const pending of waiters.values()) {
      for (const waiter of pending) {
        waiter.reject(new Error(`catalog worker exited before ${String(code ?? signal)}\n${stderr}`))
      }
    }
    waiters.clear()
  })
  return {
    child,
    stderr: () => stderr,
    message: event => {
      const index = queued.findIndex(value => value.event === event)
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]!)
      return new Promise((resolveMessage, reject) => {
        const pending = waiters.get(event) ?? []
        pending.push({ resolve: resolveMessage, reject })
        waiters.set(event, pending)
      })
    },
  }
}

async function waitForCatalogWorker(worker: CatalogWorker): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
    if (worker.child.exitCode !== 0) throw new Error(`catalog worker failed\n${worker.stderr()}`)
    return
  }
  await new Promise<void>((resolveExit, reject) => {
    worker.child.once('exit', code => {
      if (code === 0) resolveExit()
      else reject(new Error(`catalog worker failed with ${String(code)}\n${worker.stderr()}`))
    })
    worker.child.once('error', reject)
  })
}

async function waitForCatalogWorkerCode(worker: CatalogWorker, expected: number): Promise<void> {
  if (worker.child.exitCode !== null) {
    expect(worker.child.exitCode).toBe(expected)
    return
  }
  await new Promise<void>((resolveExit, reject) => {
    worker.child.once('exit', code => {
      try {
        expect(code).toBe(expected)
        resolveExit()
      } catch (error: unknown) {
        reject(error)
      }
    })
    worker.child.once('error', reject)
  })
}

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

function legacyR8Document(): SignedCatalogDocument {
  const entries = new Map(BOOTSTRAP_CATALOG_ENTRIES.map(entry => [entry.candidateRef, entry]))
  const ordered = LEGACY_R8_REFS.map((candidateRef) => {
    const entry = entries.get(candidateRef)
    if (entry === undefined) throw new Error(`missing legacy catalog entry ${candidateRef}`)
    return entry
  })
  return Object.freeze({
    envelope: Object.freeze({
      catalogId: BOOTSTRAP_CATALOG_ROOT.catalogId,
      revision: 8,
      issuedAt: '2026-08-26T18:00:00.000Z',
      expiresAt: '2027-08-26T18:00:00.000Z',
      previousRevisionDigest: 'sha256:e222344dc9c0c63cce0f3f9304841041a43d70a135abbbbaa323c29135c8096c',
      entriesDigest: 'sha256:37a10ad2e71edf5574a16c63541a10e9fc492088133d92d9f5137ccb6f15a299',
      entries: Object.freeze(ordered),
    }),
    signatures: Object.freeze([{
      keyId: 'bootstrap-2026-08-26-8',
      algorithm: 'ed25519' as const,
      value: 'rZysVT2B10GBcYHDjXDKoSnZ+hK755+J88iDQ0KQiGeD7m6Up05VUBrA/6jy9nAd7ro+AbIhpyh07OYcPILxAQ==',
    }]),
  })
}

async function publicR10Document(): Promise<SignedCatalogDocument> {
  const bytes = await readFile(join(process.cwd(), 'catalog', 'public', 'plugins.json'), 'utf8')
  return JSON.parse(bytes) as SignedCatalogDocument
}

async function writeCatalogCache(
  root: string,
  chain: readonly SignedCatalogDocument[],
  acceptedAtMs = NOW,
): Promise<string> {
  const directory = join(root, 'catalog')
  const path = join(directory, 'last-good.json')
  await mkdir(directory, { mode: 0o700 })
  await writeFile(path, `${canonicalJson({
    schemaVersion: 1,
    catalogId: BOOTSTRAP_CATALOG_ROOT.catalogId,
    chain,
    acceptedAtMs,
  })}\n`, { mode: 0o600 })
  return path
}

async function readCatalogCache(path: string): Promise<{
  readonly chain: readonly SignedCatalogDocument[]
}> {
  return JSON.parse(await readFile(path, 'utf8')) as { readonly chain: readonly SignedCatalogDocument[] }
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

  it('atomically rebases a verified older cache and refreshes the same Profile to the adjacent public catalog', async () => {
    const root = await scratch()
    const legacy = legacyR8Document()
    const remote = await publicR10Document()
    const cachePath = await writeCatalogCache(root, [legacy])
    const now = Date.parse(remote.envelope.issuedAt) + 1_000
    let calls = 0
    expect(canonicalSha256(legacy.envelope)).toBe(BOOTSTRAP_CATALOG_ENVELOPE.previousRevisionDigest)
    const manager = new CatalogSnapshotManager(root, {
      trustedUrl: CATALOG_URL,
      fetchTimeoutMs: 5_000,
    }, {
      now: () => now,
      fetch: (async () => {
        calls += 1
        return responseAt(CATALOG_URL, canonicalJson(remote), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })

    await expect(manager.initialize()).resolves.toMatchObject({
      catalog: { envelope: { revision: 10 } },
      status: { source: 'remote', freshness: 'fresh', degraded: false },
    })
    expect(calls).toBe(1)
    const persisted = await readCatalogCache(cachePath)
    expect(persisted.chain.map(document => document.envelope.revision)).toEqual([9, 10])
    expect(persisted.chain[0]).toEqual({
      envelope: BOOTSTRAP_CATALOG_ENVELOPE,
      signatures: BOOTSTRAP_CATALOG_SIGNATURES,
    })
  })

  it('queues same-process cache writers before a second callback can enter', async () => {
    const root = await scratch()
    const directory = join(root, 'catalog')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let secondEntered = false
    const first = withCatalogCacheWriter(directory, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const second = withCatalogCacheWriter(directory, () => {
      secondEntered = true
      return Promise.resolve()
    })
    await new Promise<void>(resolveImmediate => { setImmediate(resolveImmediate) })
    expect(secondEntered).toBe(false)
    release.resolve()
    await Promise.all([first, second])
    expect(secondEntered).toBe(true)
  })

  it('keeps the newest durable chain when two processes finish stale refreshes out of order', async () => {
    const root = await scratch()
    const remote = await publicR10Document()
    const cachePath = await writeCatalogCache(root, [legacyR8Document()])
    const now = Date.parse(remote.envelope.issuedAt) + 1_000

    const stale = startCatalogWorker('stale', root, now)
    await expect(stale.message('fetch-entered')).resolves.toEqual({ event: 'fetch-entered' })

    const winner = startCatalogWorker('winner', root, now)
    await expect(winner.message('done')).resolves.toMatchObject({
      revision: 10,
      source: 'remote',
      freshness: 'fresh',
      degraded: false,
      degradedReason: null,
    })
    await waitForCatalogWorker(winner)
    const winnerBytes = await readFile(cachePath, 'utf8')
    expect((JSON.parse(winnerBytes) as { chain: SignedCatalogDocument[] }).chain
      .map(document => document.envelope.revision)).toEqual([9, 10])

    stale.child.send({ command: 'release' })
    await expect(stale.message('done')).resolves.toMatchObject({
      revision: 10,
      source: 'last-good',
      freshness: 'cached',
      degraded: true,
      degradedReason: 'catalog endpoint is older than the durable last-good revision',
    })
    await waitForCatalogWorker(stale)

    expect(await readFile(cachePath, 'utf8')).toBe(winnerBytes)
    const reopened = new CatalogSnapshotManager(root, { trustedUrl: null, fetchTimeoutMs: 5_000 }, {
      now: () => now,
      fetch: globalThis.fetch,
    })
    await expect(reopened.initialize()).resolves.toMatchObject({
      catalog: { envelope: { revision: 10 } },
      status: { source: 'last-good', freshness: 'cached', degraded: false },
    })
    expect((await readdir(join(root, 'catalog'))).filter(name => (
      name.startsWith('.catalog-') || name.endsWith('-journal')
    ))).toEqual([])
  })

  it('adopts a newer durable chain after another process wins and this process fetch fails', async () => {
    const root = await scratch()
    const remote = await publicR10Document()
    const cachePath = await writeCatalogCache(root, [legacyR8Document()])
    const now = Date.parse(remote.envelope.issuedAt) + 1_000

    const offline = startCatalogWorker('stale-offline', root, now)
    await expect(offline.message('fetch-entered')).resolves.toEqual({ event: 'fetch-entered' })
    const winner = startCatalogWorker('winner', root, now)
    await expect(winner.message('done')).resolves.toMatchObject({ revision: 10, degraded: false })
    await waitForCatalogWorker(winner)
    const winnerBytes = await readFile(cachePath, 'utf8')

    offline.child.send({ command: 'release' })
    await expect(offline.message('done')).resolves.toMatchObject({
      revision: 10,
      source: 'last-good',
      freshness: 'cached',
      degraded: true,
      degradedReason: 'deterministic offline',
    })
    await waitForCatalogWorker(offline)
    expect(await readFile(cachePath, 'utf8')).toBe(winnerBytes)
  })

  it('releases the cross-process writer reservation when its owner crashes', async () => {
    const root = await scratch()
    const remote = await publicR10Document()
    const cachePath = await writeCatalogCache(root, [legacyR8Document()])
    const now = Date.parse(remote.envelope.issuedAt) + 1_000

    const crashed = startCatalogWorker('lock-crash', root, now)
    await expect(crashed.message('locked')).resolves.toEqual({ event: 'locked' })
    const Database = (await import('node:sqlite')).DatabaseSync
    const reservationPath = join(root, 'catalog', 'cache-writer.sqlite')
    const blocked = new Database(reservationPath)
    try {
      blocked.exec('PRAGMA busy_timeout = 0')
      expect(() => { blocked.exec('BEGIN IMMEDIATE') }).toThrow('database is locked')
    } finally {
      blocked.close()
    }
    crashed.child.send({ command: 'crash' })
    await waitForCatalogWorkerCode(crashed, 17)

    const recovered = new Database(reservationPath)
    try {
      recovered.exec('PRAGMA busy_timeout = 0')
      recovered.exec('BEGIN IMMEDIATE')
      recovered.exec('COMMIT')
    } finally {
      recovered.close()
    }

    const successor = startCatalogWorker('winner', root, now)
    await expect(successor.message('done')).resolves.toMatchObject({
      revision: 10,
      source: 'remote',
      freshness: 'fresh',
      degraded: false,
    })
    await waitForCatalogWorker(successor)
    const persisted = await readCatalogCache(cachePath)
    expect(persisted.chain.map(document => document.envelope.revision)).toEqual([9, 10])
    expect((await readdir(join(root, 'catalog'))).filter(name => name.endsWith('-journal'))).toEqual([])
  })

  it('trims a verified legacy prefix while retaining the current bootstrap suffix', async () => {
    const legacy = legacyR8Document()
    const current = Object.freeze({
      envelope: BOOTSTRAP_CATALOG_ENVELOPE,
      signatures: BOOTSTRAP_CATALOG_SIGNATURES,
    })
    const remote = await publicR10Document()
    for (const chain of [[legacy, current], [legacy, current, remote]]) {
      const root = await scratch()
      const cachePath = await writeCatalogCache(root, chain)
      const manager = new CatalogSnapshotManager(root, { trustedUrl: null, fetchTimeoutMs: 5_000 }, {
        now: () => Date.parse(chain.at(-1)!.envelope.issuedAt) + 1_000,
        fetch: globalThis.fetch,
      })
      await manager.initialize()
      const persisted = await readCatalogCache(cachePath)
      expect(persisted.chain.map(document => document.envelope.revision)).toEqual(
        chain.length === 2 ? [9] : [9, 10],
      )
      expect(manager.current().catalog.envelope.revision).toBe(chain.at(-1)!.envelope.revision)
    }
  })

  it('rejects equivocated, future, gapped, and signature-drifted rollover caches without fetching or rewriting', async () => {
    const legacy = legacyR8Document()
    const current = Object.freeze({
      envelope: BOOTSTRAP_CATALOG_ENVELOPE,
      signatures: BOOTSTRAP_CATALOG_SIGNATURES,
    })
    const remote = await publicR10Document()
    const cases: readonly (readonly SignedCatalogDocument[])[] = [
      [{
        envelope: { ...legacy.envelope, entriesDigest: canonicalSha256([]), entries: [] },
        signatures: legacy.signatures,
      }],
      [remote],
      [legacy, remote],
      [legacy, {
        envelope: current.envelope,
        signatures: [...current.signatures, {
          keyId: 'unknown-drift',
          algorithm: 'ed25519',
          value: Buffer.alloc(64).toString('base64'),
        }],
      }],
    ]
    for (const chain of cases) {
      const root = await scratch()
      const cachePath = await writeCatalogCache(root, chain)
      const before = await readFile(cachePath, 'utf8')
      let calls = 0
      const manager = new CatalogSnapshotManager(root, { trustedUrl: CATALOG_URL, fetchTimeoutMs: 5_000 }, {
        now: () => Date.parse(remote.envelope.issuedAt) + 1_000,
        fetch: (async () => {
          calls += 1
          return responseAt(CATALOG_URL, canonicalJson(remote), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }) as typeof fetch,
      })
      await expect(manager.initialize()).rejects.toThrow()
      expect(calls).toBe(0)
      expect(await readFile(cachePath, 'utf8')).toBe(before)
    }
  })

  it('leaves the legacy bytes intact when the durable rollover replacement cannot start', async () => {
    const root = await scratch()
    const cachePath = await writeCatalogCache(root, [legacyR8Document()])
    const directory = join(root, 'catalog')
    const before = await readFile(cachePath, 'utf8')
    await chmod(directory, 0o500)
    try {
      const manager = new CatalogSnapshotManager(root, { trustedUrl: null, fetchTimeoutMs: 5_000 }, {
        now: () => NOW,
        fetch: globalThis.fetch,
      })
      await expect(manager.initialize()).rejects.toThrow()
      expect(await readFile(cachePath, 'utf8')).toBe(before)
    } finally {
      await chmod(directory, 0o700)
    }
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
