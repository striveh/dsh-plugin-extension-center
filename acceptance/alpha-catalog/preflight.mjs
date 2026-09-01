#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, canonicalSha256 } from '../../lib/catalog.js'
import {
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from '../../lib/catalog-data.js'
import { PRODUCTION_ALPHA_ADMISSION_POLICY } from '../../scripts/alpha-catalog-admission-core.mjs'
import { AlphaLifecycleFailure } from './support.mjs'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Require the installed package bootstrap to be the exact committed r11 predecessor. */
export async function assertPackagedAlphaPredecessor(input = {}) {
  const catalogPath = input.catalogPath ?? join(projectRoot, 'catalog', 'public', 'plugins.json')
  const bytes = input.catalogBytes ?? await readFile(catalogPath)
  let document
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    throw new AlphaLifecycleFailure(
      'ALPHA-LIFECYCLE-PACKAGED-PREDECESSOR',
      'committed predecessor is not strict UTF-8 JSON',
      cause,
    )
  }
  const packaged = input.packaged ?? {
    envelope: BOOTSTRAP_CATALOG_ENVELOPE,
    signatures: BOOTSTRAP_CATALOG_SIGNATURES,
  }
  const policy = input.policy ?? PRODUCTION_ALPHA_ADMISSION_POLICY
  const fileSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (document?.envelope?.revision !== policy.previousRevision
    || document?.envelope?.entriesDigest !== policy.previousEntriesDigest
    || canonicalSha256(document) !== policy.previousDocumentDigest
    || fileSha256 !== policy.previousFileSha256
    || canonicalJson(packaged) !== canonicalJson(document)) {
    throw new AlphaLifecycleFailure(
      'ALPHA-LIFECYCLE-PACKAGED-PREDECESSOR',
      'packaged bootstrap has not promoted the exact signed revision 11 predecessor; lifecycle receipt production remains RED',
    )
  }
  return Object.freeze({
    revision: policy.previousRevision,
    documentDigest: policy.previousDocumentDigest,
    fileSha256: policy.previousFileSha256,
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await assertPackagedAlphaPredecessor()
    process.stdout.write(`passed: exact packaged alpha predecessor r${String(result.revision)} (${result.documentDigest})\n`)
  } catch (error) {
    const code = error instanceof AlphaLifecycleFailure ? error.code : 'ALPHA-LIFECYCLE-UNEXPECTED'
    const message = error instanceof Error ? error.message.replace(/^\[[^\]]+\]\s*/u, '') : 'preflight failed'
    process.stderr.write(`RED [${code}]: ${message}\n`)
    process.exitCode = 1
  }
}
