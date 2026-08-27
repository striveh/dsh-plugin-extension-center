import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withCatalogCacheWriter } from '../../src/catalog-cache-reservation.ts'
import { canonicalJson } from '../../src/catalog.ts'
import { CatalogSnapshotManager, type SignedCatalogDocument } from '../../src/catalog-refresh.ts'
import {
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from '../../src/catalog-data.ts'

interface ParentCommand {
  readonly command: 'crash' | 'release'
}

function notify(value: Readonly<Record<string, unknown>>): void {
  if (process.send === undefined) throw new Error('catalog refresh worker requires an IPC channel')
  process.send(value)
}

function finish(value: Readonly<Record<string, unknown>>, exitCode: number): void {
  if (process.send === undefined) throw new Error('catalog refresh worker requires an IPC channel')
  process.send(value, () => {
    process.exitCode = exitCode
    process.disconnect()
  })
}

function responseAt(url: string, document: SignedCatalogDocument): Response {
  const response = new Response(canonicalJson(document), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  Object.defineProperty(response, 'url', { configurable: true, value: url })
  return response
}

async function waitForRelease(): Promise<void> {
  await new Promise<void>(resolveRelease => {
    process.once('message', (value: ParentCommand) => {
      if (value.command !== 'release') throw new Error('catalog refresh worker command is unsupported')
      resolveRelease()
    })
  })
}

async function run(mode: string, root: string, now: number): Promise<void> {
  if (mode === 'lock-crash') {
    process.once('message', (value: ParentCommand) => {
      if (value.command === 'crash') process.exit(17)
    })
    await withCatalogCacheWriter(join(root, 'catalog'), async () => {
      notify({ event: 'locked' })
      await new Promise<void>(() => {})
    })
    return
  }
  const url = 'https://catalog.example.test/project/plugins.json'
  const publicDocument = JSON.parse(
    await readFile(resolve('catalog/public/plugins.json'), 'utf8'),
  ) as SignedCatalogDocument
  const bootstrapDocument: SignedCatalogDocument = {
    envelope: BOOTSTRAP_CATALOG_ENVELOPE,
    signatures: BOOTSTRAP_CATALOG_SIGNATURES,
  }
  const manager = new CatalogSnapshotManager(root, { trustedUrl: url, fetchTimeoutMs: 5_000 }, {
    now: () => now,
    fetch: (async () => {
      if (mode === 'stale' || mode === 'stale-offline') {
        notify({ event: 'fetch-entered' })
        await waitForRelease()
        if (mode === 'stale-offline') throw new Error('deterministic offline')
        return responseAt(url, bootstrapDocument)
      }
      if (mode === 'winner') return responseAt(url, publicDocument)
      throw new Error(`catalog refresh worker mode is unsupported: ${mode}`)
    }) as typeof fetch,
  })
  const snapshot = await manager.initialize()
  finish({
    event: 'done',
    revision: snapshot.catalog.envelope.revision,
    source: snapshot.status.source,
    freshness: snapshot.status.freshness,
    degraded: snapshot.status.degraded,
    degradedReason: snapshot.status.degradedReason,
  }, 0)
}

const [mode, root, nowValue] = process.argv.slice(2)
if (mode === undefined || root === undefined || nowValue === undefined || !/^\d+$/u.test(nowValue)) {
  throw new Error('catalog refresh worker arguments are incomplete')
}

try {
  await run(mode, root, Number(nowValue))
} catch (error: unknown) {
  finish({ event: 'error', message: error instanceof Error ? error.message : String(error) }, 1)
}
