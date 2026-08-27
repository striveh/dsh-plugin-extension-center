#!/usr/bin/env node

import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { immutablePackageTreeDigest } from '../acceptance/full-p0/support.mjs'

const requested = process.argv[2]
if (typeof requested !== 'string' || requested.length === 0) {
  throw new Error('usage: node scripts/resolve-pnpm-binding.mjs <pnpm executable>')
}

const binPath = await realpath(resolve(requested))
let cursor = dirname(binPath)
let binding = null
for (let depth = 0; depth < 12; depth += 1) {
  const manifestPath = join(cursor, 'package.json')
  try {
    const info = await lstat(manifestPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
      throw new Error('pnpm package manifest is not a bounded regular file')
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pnpm
    if (manifest.name === 'pnpm' && typeof manifest.version === 'string' && typeof declared === 'string'
      && await realpath(join(cursor, declared)) === binPath) {
      binding = Object.freeze({
        packageRoot: await realpath(cursor),
        binPath,
        version: manifest.version,
        treeSha256: await immutablePackageTreeDigest(cursor),
      })
      break
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const parent = dirname(cursor)
  if (parent === cursor || parent === parse(cursor).root) break
  cursor = parent
}
if (binding === null) throw new Error('pnpm executable is not contained by a matching pnpm package root')
process.stdout.write(`${JSON.stringify(binding)}\n`)
