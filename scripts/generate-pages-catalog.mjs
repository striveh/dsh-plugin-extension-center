#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MAX_CATALOG_BYTES = 512 * 1024
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Materialize one verified signed document as a canonical Pages resource. */
export async function generatePagesCatalog(input) {
  input.verify()
  const document = Object.freeze({ envelope: input.envelope, signatures: input.signatures })
  const body = `${input.canonicalJson(document)}\n`
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_CATALOG_BYTES) {
    throw new Error(`Pages catalog exceeds the ${String(MAX_CATALOG_BYTES)} byte runtime download bound`)
  }
  JSON.parse(body)
  await mkdir(dirname(input.outputPath), { recursive: true })
  const temporary = `${input.outputPath}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o644)
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, input.outputPath)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return Object.freeze({
    outputPath: input.outputPath,
    bytes,
    sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    revision: input.envelope.revision,
  })
}

export async function generateFromPublishedCatalog() {
  const [{
    BOOTSTRAP_CATALOG_ENVELOPE,
    BOOTSTRAP_CATALOG_ROOT,
    BOOTSTRAP_CATALOG_SIGNATURES,
  }, catalog, refresh] = await Promise.all([
    import('../lib/catalog-data.js'),
    import('../lib/catalog.js'),
    import('../lib/catalog-refresh.js'),
  ])
  const inputPath = resolve(projectRoot, 'catalog', 'public', 'plugins.json')
  const info = await lstat(inputPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CATALOG_BYTES) {
    throw new Error('published catalog must be a bounded regular file')
  }
  const body = await readFile(inputPath, 'utf8')
  if (!body.endsWith('\n') || body.slice(0, -1).includes('\n')) {
    throw new Error('published catalog must be one complete canonical JSON line')
  }
  const document = JSON.parse(body)
  if (`${catalog.canonicalJson(document)}\n` !== body) {
    throw new Error('published catalog is not canonical JSON')
  }
  if (document?.envelope?.revision !== BOOTSTRAP_CATALOG_ENVELOPE.revision + 1
    || document.envelope.previousRevisionDigest !== catalog.canonicalSha256(BOOTSTRAP_CATALOG_ENVELOPE)) {
    throw new Error('published catalog is not the exact adjacent successor to the packaged bootstrap')
  }
  const bootstrap = catalog.verifyCatalog(
    BOOTSTRAP_CATALOG_ROOT,
    BOOTSTRAP_CATALOG_ENVELOPE,
    BOOTSTRAP_CATALOG_SIGNATURES,
    Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1,
  )
  return await generatePagesCatalog({
    outputPath: resolve(projectRoot, 'site', 'plugins.json'),
    envelope: document.envelope,
    signatures: document.signatures,
    canonicalJson: catalog.canonicalJson,
    verify: () => {
      refresh.verifyCatalogAdvance(
        BOOTSTRAP_CATALOG_ROOT,
        bootstrap,
        document,
        Date.parse(document.envelope.issuedAt) + 1,
      )
    },
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    process.stderr.write('usage: node scripts/generate-pages-catalog.mjs\n')
    process.exitCode = 2
  } else {
    try {
      const generated = await generateFromPublishedCatalog()
      process.stdout.write(`generated signed catalog revision ${String(generated.revision)}: ${generated.outputPath} (${String(generated.bytes)} bytes, ${generated.sha256})\n`)
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
  }
}
