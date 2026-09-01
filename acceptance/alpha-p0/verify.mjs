#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from '../full-p0/receipt-binding.mjs'
import {
  evaluateAlphaP0Composite,
  verifyAlphaP0CompositeReceipt,
} from './support.mjs'

const INPUTS = Object.freeze([
  'ordinary-user', 'ordinary-actions', 'npm-provenance', 'catalog', 'plugin', 'mcp', 'agent',
])
const MAX_INPUT_BYTES = 4 * 1024 * 1024

/** Parse optional lane receipt paths and one output path. */
export function parseAlphaP0CompositeArguments(argv, cwd = process.cwd()) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  if (args.length % 2 !== 0) throw new TypeError('alpha P0 composite expects --name value pairs')
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (typeof name !== 'string' || !name.startsWith('--') || value === undefined
      || options.has(name.slice(2))) {
      throw new TypeError('alpha P0 composite expects unique --name value pairs')
    }
    options.set(name.slice(2), resolve(cwd, value))
  }
  for (const name of options.keys()) {
    if (![...INPUTS, 'receipt'].includes(name)) throw new TypeError(`alpha P0 composite does not support --${name}`)
  }
  const receiptPath = options.get('receipt')
    ?? resolve(cwd, '.artifacts/acceptance/alpha-p0/composite-receipt.json')
  options.delete('receipt')
  return Object.freeze({
    receiptPath,
    inputs: Object.freeze(Object.fromEntries(INPUTS.map(name => [name, options.get(name) ?? null]))),
  })
}

/** Run the verifier once; RED is a normal fail-closed result with exit code 2. */
export async function runAlphaP0Composite(options) {
  const loaded = Object.fromEntries(await Promise.all(INPUTS.map(async name => [
    name,
    options.inputs[name] === null ? null : await readInputOrInvalid(options.inputs[name]),
  ])))
  const receipt = evaluateAlphaP0Composite({
    ordinaryUser: loaded['ordinary-user'],
    ordinaryActions: loaded['ordinary-actions'],
    npmProvenance: loaded['npm-provenance'],
    catalog: loaded.catalog,
    plugin: loaded.plugin,
    mcp: loaded.mcp,
    agent: loaded.agent,
  })
  verifyAlphaP0CompositeReceipt(receipt)
  await writeReceipt(options.receiptPath, receipt)
  return receipt
}

async function readInputOrInvalid(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_INPUT_BYTES) return Object.freeze({})
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return Object.freeze({})
  }
}

async function writeReceipt(path, receipt) {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = resolve(directory, `.alpha-p0-${randomUUID()}.json`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${canonicalJson(receipt)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temporary, path)
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

const invoked = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    const receipt = await runAlphaP0Composite(parseAlphaP0CompositeArguments(process.argv.slice(2)))
    if (receipt.p0Status === 'proven') {
      process.stdout.write(`passed: ${receipt.acceptanceId}; receiptDigest=${receipt.receiptDigest}\n`)
    } else {
      process.stderr.write(`RED: ${receipt.acceptanceId}; ${receipt.notProven.join(', ')}\n`)
      process.exitCode = 2
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'alpha P0 composite failed'}\n`)
    process.exitCode = 1
  }
}
