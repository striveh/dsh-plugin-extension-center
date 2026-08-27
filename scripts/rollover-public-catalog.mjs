#!/usr/bin/env node
import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalJson, canonicalSha256 } from '../lib/catalog.js'
import {
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_ROOT,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from '../lib/catalog-data.js'
import { createSignedCatalogDocument } from './catalog-pipeline-core.mjs'

function fail(message) {
  throw new Error(`catalog-rollover: ${message}`)
}

function argumentsFor(values) {
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
  const optional = (name) => {
    const value = options.get(name)
    options.delete(name)
    return value
  }
  const input = {
    issuedAt: one('issued-at'),
    expiresAt: one('expires-at'),
    keyId: one('key-id'),
    privateKeyPath: resolve(one('private-key')),
    outputPath: resolve(one('out')),
    evidencePath: resolve(one('evidence-out')),
    previousPath: optional('previous'),
  }
  if (input.previousPath !== undefined) input.previousPath = resolve(input.previousPath)
  if (options.size > 0) fail(`does not support --${options.keys().next().value}`)
  if (input.outputPath === input.evidencePath) fail('document and evidence outputs must differ')
  return input
}

async function privateKey(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
    fail('private key must be a bounded regular file')
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    fail('private key permissions must exclude group and other users')
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
}

async function signedDocument(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 512 * 1024) {
    fail('previous catalog must be a bounded regular file')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
  let document
  try {
    document = JSON.parse(text)
  } catch {
    fail('previous catalog is not strict UTF-8 JSON')
  }
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || `${canonicalJson(document)}\n` !== text) {
    fail('previous catalog is not one canonical JSON line')
  }
  return document
}

async function writeExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'wx', 0o644)
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Sign one exact next revision without changing the admitted entry set. */
export async function rolloverPublicCatalog(input) {
  const previous = input.previousPath === undefined
    ? Object.freeze({
      envelope: BOOTSTRAP_CATALOG_ENVELOPE,
      signatures: BOOTSTRAP_CATALOG_SIGNATURES,
    })
    : await signedDocument(input.previousPath)
  const signed = createSignedCatalogDocument({
    root: BOOTSTRAP_CATALOG_ROOT,
    previous,
    entries: previous.envelope.entries,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    signers: [{ keyId: input.keyId, privateKeyPem: await privateKey(input.privateKeyPath) }],
  })
  const unchangedEntries = structuredClone(previous.envelope.entries)
    .sort((left, right) => left.candidateRef.localeCompare(right.candidateRef))
  if (signed.document.envelope.revision !== previous.envelope.revision + 1
    || canonicalJson(signed.document.envelope.entries) !== canonicalJson(unchangedEntries)
    || signed.document.envelope.previousRevisionDigest !== canonicalSha256(previous.envelope)) {
    fail('signed document is not an entry-preserving exact successor')
  }
  const evidence = Object.freeze({
    schemaVersion: 1,
    kind: 'entry-preserving-catalog-rollover',
    catalogId: signed.document.envelope.catalogId,
    previousRevision: previous.envelope.revision,
    revision: signed.document.envelope.revision,
    previousRevisionDigest: signed.document.envelope.previousRevisionDigest,
    previousEntriesDigest: previous.envelope.entriesDigest,
    entriesDigest: signed.document.envelope.entriesDigest,
    documentDigest: canonicalSha256(signed.document),
    signingKeyIds: signed.keyIds,
    issuedAt: signed.document.envelope.issuedAt,
    expiresAt: signed.document.envelope.expiresAt,
  })
  await writeExclusive(input.evidencePath, evidence)
  await writeExclusive(input.outputPath, signed.document)
  return Object.freeze({ document: signed.document, evidence })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await rolloverPublicCatalog(argumentsFor(process.argv.slice(2)))
    process.stdout.write(`catalog-rollover: wrote revision ${String(result.evidence.revision)} (${result.evidence.documentDigest})\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
