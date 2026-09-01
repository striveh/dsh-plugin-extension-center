#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { verifyOrdinaryUserReceiptDigest } from './support.mjs'

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const GITHUB_NUMBER = /^[1-9][0-9]{0,19}$/u
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u

/** Create a self-digested statement binding one receipt to the primary Actions artifact archive. */
export function createActionsArtifactEvidence(receipt, artifact) {
  requireReceipt(receipt, false)
  if (!ARTIFACT_NAME.test(artifact?.name ?? '')
    || !GITHUB_NUMBER.test(artifact?.id ?? '')
    || !SHA256.test(artifact?.digest ?? '')) {
    throw new TypeError('ordinary-user actions evidence has invalid artifact coordinates')
  }
  const expectedName = receipt.actionsProvenance.workflowFile === '.github/workflows/npm-publish.yml'
    ? `ordinary-user-publication-${receipt.actionsProvenance.commit}-attempt-${receipt.actionsProvenance.runAttempt}`
    : `ordinary-user-${receipt.actionsProvenance.commit}-attempt-${receipt.actionsProvenance.runAttempt}`
  if (artifact.name !== expectedName) {
    throw new TypeError('ordinary-user actions evidence artifact name does not bind the workflow invocation')
  }
  const body = {
    schemaVersion: 2,
    kind: 'ordinary-user-actions-artifact-evidence',
    status: receipt.status,
    laneStatus: receipt.laneStatus,
    p0Status: receipt.p0Status,
    acceptanceId: receipt.acceptanceId,
    acceptanceReceiptDigest: receipt.receiptDigest,
    actionsProvenance: receipt.actionsProvenance,
    artifact: { name: artifact.name, id: artifact.id, digest: artifact.digest },
  }
  return Object.freeze({ ...body, evidenceDigest: canonicalSha256(body) })
}

/** Verify the evidence self-digest and its exact receipt binding. */
export function verifyActionsArtifactEvidence(receipt, evidence) {
  requireReceipt(receipt, false)
  if (!isRecord(evidence) || !SHA256.test(evidence.evidenceDigest ?? '')) return false
  const { evidenceDigest: _evidenceDigest, ...body } = evidence
  return evidence.evidenceDigest === canonicalSha256(body)
    && evidence.schemaVersion === 2
    && evidence.kind === 'ordinary-user-actions-artifact-evidence'
    && evidence.status === receipt.status
    && evidence.laneStatus === receipt.laneStatus
    && evidence.p0Status === receipt.p0Status
    && evidence.acceptanceId === receipt.acceptanceId
    && evidence.acceptanceReceiptDigest === receipt.receiptDigest
    && canonicalJson(evidence.actionsProvenance) === canonicalJson(receipt.actionsProvenance)
}

/** Verify GitHub run metadata, artifact metadata, and downloaded archive bytes against the evidence. */
export function verifyActionsRunBinding(evidence, run, artifacts, archiveBytes) {
  if (!isRecord(evidence) || !isRecord(evidence.actionsProvenance) || !isRecord(evidence.artifact)
    || !isRecord(run) || !isRecord(run.repository) || !isRecord(artifacts)
    || !Array.isArray(artifacts.artifacts) || !(archiveBytes instanceof Uint8Array)) return false
  const provenance = evidence.actionsProvenance
  const artifact = artifacts.artifacts.find(value => isRecord(value)
    && String(value.id) === evidence.artifact.id
    && value.name === evidence.artifact.name)
  if (!isRecord(artifact) || !isRecord(artifact.workflow_run)) return false
  return String(run.id) === provenance.runId
    && String(run.run_attempt) === provenance.runAttempt
    && run.event === provenance.eventName
    && run.status === 'completed'
    && run.conclusion === 'success'
    && run.head_branch === 'main'
    && run.head_sha === provenance.commit
    && run.path === provenance.workflowFile
    && run.repository.full_name === provenance.repository
    && String(run.repository.id) === provenance.repositoryId
    && String(artifact.id) === evidence.artifact.id
    && artifact.name === evidence.artifact.name
    && artifact.expired === false
    && artifact.digest === evidence.artifact.digest
    && String(artifact.workflow_run.id) === provenance.runId
    && String(artifact.workflow_run.repository_id) === provenance.repositoryId
    && artifact.workflow_run.head_branch === 'main'
    && artifact.workflow_run.head_sha === provenance.commit
    && `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}` === evidence.artifact.digest
}

function requireReceipt(receipt, requireProven) {
  if (!isRecord(receipt) || !verifyOrdinaryUserReceiptDigest(receipt)
    || !isRecord(receipt.actionsProvenance)
    || requireProven && (receipt.status !== 'passed'
      || receipt.laneStatus !== 'proven'
      || receipt.p0Status !== 'red')) {
    throw new TypeError('ordinary-user actions receipt is not a valid protected-run receipt')
  }
}

function canonicalSha256(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new TypeError('ordinary-user actions evidence contains a non-canonical value')
}

function isRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

async function readJsonFile(path, maximumBytes) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) {
    throw new TypeError('ordinary-user actions evidence input is not one bounded regular file')
  }
  return JSON.parse(await readFile(path, 'utf8'))
}

function parseOptions(argv) {
  const [mode, ...rest] = argv
  if (!['verify-receipt', 'write', 'verify-actions'].includes(mode)) {
    throw new TypeError('usage: actions-evidence.mjs <verify-receipt|write|verify-actions> [options]')
  }
  const options = { mode }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new TypeError('ordinary-user actions evidence options require one value each')
    }
    options[key.slice(2)] = value
  }
  return options
}

async function main(argv) {
  const options = parseOptions(argv)
  const receipt = await readJsonFile(resolve(options.receipt), 256 * 1024)
  if (options.mode === 'verify-receipt') {
    requireReceipt(receipt, options['require-proven'] === 'true')
    return
  }
  if (options.mode === 'write') {
    const evidence = createActionsArtifactEvidence(receipt, {
      name: options['artifact-name'],
      id: options['artifact-id'],
      digest: options['artifact-digest'],
    })
    const output = resolve(options.output)
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return
  }
  const [evidence, run, artifacts, archive] = await Promise.all([
    readJsonFile(resolve(options.evidence), 64 * 1024),
    readJsonFile(resolve(options.run), 1024 * 1024),
    readJsonFile(resolve(options.artifacts), 4 * 1024 * 1024),
    readFile(resolve(options.archive)),
  ])
  if (!verifyActionsArtifactEvidence(receipt, evidence)
    || !verifyActionsRunBinding(evidence, run, artifacts, archive)) {
    throw new TypeError('ordinary-user Actions artifact evidence did not verify')
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'ordinary-user actions evidence failed'}\n`)
    process.exitCode = 1
  }
}
