#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AcceptanceFailure,
  sanitizeDiagnostic,
} from '../full-p0/support.mjs'
import { canonicalSha256 } from '../full-p0/receipt-binding.mjs'
import {
  runBuffered,
  validateGitHubCiArtifactReceipt,
} from './verify-github-ci.mjs'

export const GITHUB_REPOSITORY = 'striveh/dsh-plugin-extension-center'
export const GITHUB_BRANCH = 'main'
export const FAILED_WORKFLOW_PATH = '.github/workflows/post-publication-evidence.yml'
export const INCIDENT_WORKFLOW_PATH = '.github/workflows/publication-incident-evidence.yml'
export const FAILED_JOB_NAME = 'Exact-commit runtime, Release, catalog, and composite receipt'
export const FAILED_STEP_NAME = 'Verify exact Release artifact runtime on official DSH'

export const FAILED_ARTIFACT_ENTRIES = Object.freeze([
  'acceptance/github-ci/current.json',
  'acceptance/github-ci/previous.json',
  'acceptance/github-ci/verifier.json',
])

export const PREVIOUS_ARTIFACT_ENTRIES = Object.freeze([
  'acceptance/github-ci/current.json',
  'acceptance/github-ci/verifier.json',
  'acceptance/runtime-release/receipt.json',
  'acceptance/public-release/receipt.json',
  'acceptance/public-catalog/receipt.json',
  'acceptance/catalog-sources/receipt.json',
  'acceptance/release-ready/receipt.json',
  'pnpm-binding.json',
])

const PREVIOUS_WANTED_ENTRIES = Object.freeze([
  'acceptance/github-ci/current.json',
  'acceptance/github-ci/verifier.json',
  'acceptance/release-ready/receipt.json',
])
const API_ROOT = `https://api.github.com/repos/${GITHUB_REPOSITORY}`
const COMMIT = /^[0-9a-f]{40}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const VERSION = /^0\.1\.0(?:-rc\.(?:0|[1-9][0-9]*))?$/u
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_ARCHIVE_BYTES = 8 * 1024 * 1024
const MAX_ARTIFACT_ENTRY_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_ENTRY_LIST_BYTES = 64 * 1024
const DEFAULT_RECEIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../.artifacts/acceptance/publication-incident/receipt.json',
)
const USAGE = [
  'usage: node acceptance/release/assert-publication-incident.mjs',
  '--commit <40-character-sha>',
  '--failed-run-id <positive-integer>',
  '--failed-run-attempt <positive-integer>',
  '--previous-commit <40-character-sha>',
  '--previous-evidence-run-id <positive-integer>',
  '--previous-evidence-run-attempt <positive-integer>',
  '--verifier-commit <40-character-sha>',
  '--verifier-run-id <positive-integer>',
  '--verifier-run-attempt <positive-integer>',
  '--verifier-ref-protected true',
  '--verifier-ci-receipt <path>',
  '--verifier-ci-receipt-sha256 <sha256:hex>',
  '[--receipt <path>]',
  '',
].join(' ') + '\n'

function fail(code, message) {
  throw new AcceptanceFailure(code, message)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('P0-PUBLICATION-INCIDENT-FORMAT', `${label} must be an object`)
  }
  return value
}

function bounded(value, label, maximum = 4_096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('P0-PUBLICATION-INCIDENT-INPUT', `${label} must be one bounded string`)
  }
  return value
}

function exactCommit(value, label) {
  const decoded = bounded(value, label, 40)
  if (!COMMIT.test(decoded)) {
    fail('P0-PUBLICATION-INCIDENT-INPUT', `${label} must be one lowercase 40-character SHA`)
  }
  return decoded
}

function positiveInteger(value, label, code = 'P0-PUBLICATION-INCIDENT-FORMAT') {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, `${label} must be a positive integer`)
  return value
}

function positiveIntegerArgument(value, label) {
  const decoded = bounded(value, label, 32)
  if (!/^[1-9][0-9]*$/u.test(decoded)) {
    fail('P0-PUBLICATION-INCIDENT-INPUT', `${label} must be a positive integer`)
  }
  return positiveInteger(Number(decoded), label, 'P0-PUBLICATION-INCIDENT-INPUT')
}

function timestamp(value, label) {
  const decoded = bounded(value, label, 64)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(decoded)
    || !Number.isFinite(Date.parse(decoded))) {
    fail('P0-PUBLICATION-INCIDENT-FORMAT', `${label} must be one valid GitHub UTC timestamp`)
  }
  return decoded
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function exactSha256(value, label) {
  const decoded = bounded(value, label, 80)
  if (!SHA256.test(decoded)) fail('P0-PUBLICATION-INCIDENT-FORMAT', `${label} must be one SHA-256`)
  return decoded
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const normalized = [...expected].sort()
  if (actual.length !== normalized.length || actual.some((key, index) => key !== normalized[index])) {
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} changed its exact entry set`)
  }
}

function exactEntries(value, expected, label) {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} entry list is invalid`)
  }
  const actual = [...value].sort()
  const normalized = [...expected].sort()
  if (actual.length !== normalized.length || actual.some((entry, index) => entry !== normalized[index])) {
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} does not contain its exact admitted receipts`)
  }
}

function receiptBytes(value, label) {
  if (!(value instanceof Uint8Array) || value.byteLength < 2
    || value.byteLength > MAX_ARTIFACT_ENTRY_BYTES || value[value.byteLength - 1] !== 0x0a) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} must be one bounded newline-terminated receipt`)
  }
  return Buffer.from(value)
}

function parseReceiptBytes(value, label) {
  const bytes = receiptBytes(value, label)
  let receipt
  try {
    receipt = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} is not JSON`)
  }
  return Object.freeze({ bytes, receipt: record(receipt, label), fileSha256: sha256(bytes) })
}

function ciReceiptEvidence(value, commit, label) {
  const parsed = parseReceiptBytes(value, label)
  const pack = record(parsed.receipt.packAttestation, `${label} pack attestation`)
  const version = bounded(pack.version, `${label} version`, 128)
  if (!VERSION.test(version)) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} has an unsupported release version`)
  }
  const specification = Object.freeze({
    commit,
    version,
    sha256: exactSha256(pack.sha256, `${label} artifact SHA-256`),
    sizeBytes: positiveInteger(pack.sizeBytes, `${label} artifact size`),
    manifestSha256: exactSha256(pack.manifestSha256, `${label} manifest SHA-256`),
  })
  let validated
  try {
    validated = validateGitHubCiArtifactReceipt(parsed.receipt, specification)
  } catch (error) {
    if (error instanceof AcceptanceFailure) {
      fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} failed exact CI receipt validation`)
    }
    throw error
  }
  return Object.freeze({
    receipt: parsed.receipt,
    fileSha256: parsed.fileSha256,
    receiptDigest: validated.receiptDigest,
    version,
    runId: validated.runId,
    runAttempt: validated.runAttempt,
    artifact: validated.artifact,
  })
}

function failedRunEvidence(value, commit, runId, runAttempt) {
  const run = record(value, 'failed workflow run')
  const repository = record(run.repository, 'failed workflow run repository')
  const headRepository = record(run.head_repository, 'failed workflow run head repository')
  if (run.id !== runId || run.run_attempt !== runAttempt || run.name !== 'Post-publication evidence'
    || run.path !== FAILED_WORKFLOW_PATH || run.event !== 'workflow_dispatch'
    || run.head_branch !== GITHUB_BRANCH || run.head_sha !== commit
    || run.status !== 'completed' || run.conclusion !== 'failure'
    || repository.full_name !== GITHUB_REPOSITORY || headRepository.full_name !== GITHUB_REPOSITORY
    || run.html_url !== `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${String(runId)}`) {
    fail('P0-PUBLICATION-INCIDENT-RUN', 'target run is not the exact failed post-publication workflow attempt')
  }
  return Object.freeze({
    id: runId,
    attempt: runAttempt,
    runNumber: positiveInteger(run.run_number, 'failed workflow run number'),
    workflowPath: run.path,
    event: run.event,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    createdAt: timestamp(run.created_at, 'failed workflow run created_at'),
    updatedAt: timestamp(run.updated_at, 'failed workflow run updated_at'),
  })
}

function successfulPreviousRunEvidence(value, runId, runAttempt) {
  const run = record(value, 'previous evidence workflow run')
  const repository = record(run.repository, 'previous evidence workflow run repository')
  const headRepository = record(run.head_repository, 'previous evidence workflow run head repository')
  const headSha = exactCommit(run.head_sha, 'previous evidence verifier commit')
  if (run.id !== runId || run.run_attempt !== runAttempt || run.name !== 'Post-publication evidence'
    || run.path !== FAILED_WORKFLOW_PATH || run.event !== 'workflow_dispatch'
    || run.head_branch !== GITHUB_BRANCH || run.status !== 'completed' || run.conclusion !== 'success'
    || repository.full_name !== GITHUB_REPOSITORY || headRepository.full_name !== GITHUB_REPOSITORY
    || run.html_url !== `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${String(runId)}`) {
    fail('P0-PUBLICATION-INCIDENT-PREVIOUS', 'previous run is not one exact successful post-publication workflow attempt')
  }
  return Object.freeze({
    id: runId,
    attempt: runAttempt,
    runNumber: positiveInteger(run.run_number, 'previous evidence workflow run number'),
    workflowPath: run.path,
    event: run.event,
    headBranch: run.head_branch,
    headSha,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    createdAt: timestamp(run.created_at, 'previous evidence workflow run created_at'),
    updatedAt: timestamp(run.updated_at, 'previous evidence workflow run updated_at'),
  })
}

function jobStep(value, label) {
  const step = record(value, label)
  return Object.freeze({
    number: positiveInteger(step.number, `${label} number`),
    name: bounded(step.name, `${label} name`, 256),
    status: bounded(step.status, `${label} status`, 32),
    conclusion: bounded(step.conclusion, `${label} conclusion`, 32),
    startedAt: timestamp(step.started_at, `${label} started_at`),
    completedAt: timestamp(step.completed_at, `${label} completed_at`),
  })
}

function failedJobEvidence(value, run, commit) {
  const response = record(value, 'failed workflow jobs response')
  if (response.total_count !== 1 || !Array.isArray(response.jobs) || response.jobs.length !== 1) {
    fail('P0-PUBLICATION-INCIDENT-JOB', 'failed workflow attempt must contain exactly one job')
  }
  const job = record(response.jobs[0], 'failed workflow job')
  const id = positiveInteger(job.id, 'failed workflow job id')
  if (job.name !== FAILED_JOB_NAME || job.run_id !== run.id || job.run_attempt !== run.attempt
    || job.head_sha !== commit || job.status !== 'completed' || job.conclusion !== 'failure'
    || job.html_url !== `${run.htmlUrl}/job/${String(id)}` || !Array.isArray(job.steps)) {
    fail('P0-PUBLICATION-INCIDENT-JOB', 'job is not the exact failed publication verification job')
  }
  const steps = job.steps.map((step, index) => jobStep(step, `failed workflow step ${String(index)}`))
  if (new Set(steps.map(step => step.name)).size !== steps.length
    || new Set(steps.map(step => step.number)).size !== steps.length) {
    fail('P0-PUBLICATION-INCIDENT-JOB', 'failed workflow job has duplicate step identities')
  }
  const failures = steps.filter(step => step.conclusion === 'failure')
  const failedStep = failures[0]
  if (failures.length !== 1 || failedStep?.name !== FAILED_STEP_NAME || failedStep.number !== 15
    || failedStep.status !== 'completed') {
    fail('P0-PUBLICATION-INCIDENT-JOB', 'runtime Release verification is not the unique failed step')
  }
  const expectedSuccessful = [
    'Verify current and previous exact main CI',
    'Resolve attested release coordinates',
    'Download previous exact release-ready receipt',
    'Download exact public Release assets',
    'Download exact full lifecycle receipt from current CI attempt',
    'Upload bounded post-publication receipts',
  ]
  for (const name of expectedSuccessful) {
    const step = steps.find(candidate => candidate.name === name)
    if (step?.status !== 'completed' || step.conclusion !== 'success') {
      fail('P0-PUBLICATION-INCIDENT-JOB', `${name} was not successful in the failed attempt`)
    }
  }
  const expectedSkipped = [
    'Resolve immutable pnpm binding',
    'Verify public GitHub Release install, update, and removal',
    'Verify signed public catalog deployment',
    'Re-fetch every signed catalog source and artifact',
    'Compose one cross-bound release-ready receipt',
  ]
  for (const name of expectedSkipped) {
    const step = steps.find(candidate => candidate.name === name)
    if (step?.status !== 'completed' || step.conclusion !== 'skipped') {
      fail('P0-PUBLICATION-INCIDENT-JOB', `${name} was not blocked by the runtime verification failure`)
    }
  }
  const compositeStep = steps.find(step => step.name === 'Compose one cross-bound release-ready receipt')
  return Object.freeze({
    id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: timestamp(job.started_at, 'failed workflow job started_at'),
    completedAt: timestamp(job.completed_at, 'failed workflow job completed_at'),
    htmlUrl: job.html_url,
    failedStep,
    releaseReadyCompositeStep: Object.freeze({
      number: compositeStep.number,
      name: compositeStep.name,
      status: compositeStep.status,
      conclusion: compositeStep.conclusion,
    }),
  })
}

function artifactMetadata(value, expected, archive, label) {
  const response = record(value, `${label} artifacts response`)
  if (response.total_count !== 1 || !Array.isArray(response.artifacts) || response.artifacts.length !== 1) {
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} must expose exactly one Actions artifact`)
  }
  const artifact = record(response.artifacts[0], `${label} artifact`)
  const id = positiveInteger(artifact.id, `${label} artifact id`)
  const workflowRun = record(artifact.workflow_run, `${label} artifact workflow run`)
  const archiveSha256 = exactSha256(archive.archiveSha256, `${label} downloaded archive SHA-256`)
  const archiveSizeBytes = positiveInteger(archive.archiveSizeBytes, `${label} downloaded archive size`)
  if (artifact.name !== expected.name || artifact.expired !== false
    || artifact.digest !== archiveSha256 || artifact.size_in_bytes !== archiveSizeBytes
    || artifact.url !== `${API_ROOT}/actions/artifacts/${String(id)}`
    || artifact.archive_download_url !== `${API_ROOT}/actions/artifacts/${String(id)}/zip`
    || workflowRun.id !== expected.runId || workflowRun.head_branch !== GITHUB_BRANCH
    || workflowRun.head_sha !== expected.headSha) {
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} metadata does not bind its exact workflow run and ZIP bytes`)
  }
  return Object.freeze({
    id,
    name: artifact.name,
    archiveSizeBytes,
    archiveSha256,
  })
}

function archiveFiles(value, expectedEntries, wantedEntries, label) {
  const archive = record(value, `${label} downloaded archive`)
  exactEntries(archive.entries, expectedEntries, label)
  const files = record(archive.files, `${label} extracted files`)
  exactKeys(files, wantedEntries, `${label} extracted files`)
  return Object.freeze({ archive, files })
}

function publicReleaseEvidence(value, tagRefValue, current, commit) {
  const release = record(value, 'target GitHub Release')
  const tag = `v${current.version}`
  const releaseId = positiveInteger(release.id, 'target GitHub Release id')
  if (release.tag_name !== tag || release.target_commitish !== commit || release.name !== tag
    || release.draft !== false || release.prerelease !== current.version.includes('-')
    || release.immutable !== true
    || release.html_url !== `https://github.com/${GITHUB_REPOSITORY}/releases/tag/${tag}`
    || !Array.isArray(release.assets)) {
    fail('P0-PUBLICATION-INCIDENT-RELEASE', 'target is not the exact immutable GitHub Release')
  }
  const expectedAssets = current.artifact.releaseAssets
  if (release.assets.length !== expectedAssets.length) {
    fail('P0-PUBLICATION-INCIDENT-RELEASE', 'immutable Release changed its exact three-asset payload')
  }
  const actualByName = new Map()
  for (const candidate of release.assets) {
    const asset = record(candidate, 'target GitHub Release asset')
    const name = bounded(asset.name, 'target GitHub Release asset name', 256)
    if (actualByName.has(name)) fail('P0-PUBLICATION-INCIDENT-RELEASE', 'immutable Release has duplicate asset names')
    actualByName.set(name, asset)
  }
  const assets = expectedAssets.map(expected => {
    const asset = actualByName.get(expected.name)
    if (asset === undefined) fail('P0-PUBLICATION-INCIDENT-RELEASE', `immutable Release is missing ${expected.name}`)
    const id = positiveInteger(asset.id, `${expected.name} Release asset id`)
    const expectedDownload = `https://github.com/${GITHUB_REPOSITORY}/releases/download/${tag}/${expected.name}`
    if (asset.state !== 'uploaded' || asset.size !== expected.sizeBytes || asset.digest !== expected.sha256
      || asset.url !== `${API_ROOT}/releases/assets/${String(id)}`
      || asset.browser_download_url !== expectedDownload) {
      fail('P0-PUBLICATION-INCIDENT-RELEASE', `${expected.name} does not match the CI-attested immutable asset`)
    }
    return Object.freeze({
      id,
      name: expected.name,
      sizeBytes: expected.sizeBytes,
      sha256: expected.sha256,
      publicUrl: expectedDownload,
    })
  })
  const tagRef = record(tagRefValue, 'target Git tag ref')
  const tagObject = record(tagRef.object, 'target Git tag object')
  if (tagRef.ref !== `refs/tags/${tag}`
    || tagRef.url !== `${API_ROOT}/git/refs/tags/${tag}`
    || tagObject.type !== 'commit' || tagObject.sha !== commit
    || tagObject.url !== `${API_ROOT}/git/commits/${commit}`) {
    fail('P0-PUBLICATION-INCIDENT-RELEASE', 'protected Release tag does not resolve directly to the target commit')
  }
  return Object.freeze({
    id: releaseId,
    version: current.version,
    tag,
    tagCommit: commit,
    immutable: true,
    prerelease: release.prerelease,
    htmlUrl: release.html_url,
    createdAt: timestamp(release.created_at, 'target GitHub Release created_at'),
    publishedAt: timestamp(release.published_at, 'target GitHub Release published_at'),
    assets: Object.freeze(assets),
  })
}

function previousReleaseReadyEvidence(value, previous, previousVerifier, previousRun, previousCommit) {
  const parsed = parseReceiptBytes(value, 'previous release-ready receipt')
  const receipt = parsed.receipt
  const { receiptDigest, ...body } = receipt
  const target = record(receipt.target, 'previous release-ready target')
  const verifier = record(receipt.verifier, 'previous release-ready verifier')
  const evidence = record(receipt.evidence, 'previous release-ready evidence')
  const githubCi = record(evidence.githubCi, 'previous release-ready target CI evidence')
  const verifierGithubCi = record(evidence.verifierGithubCi, 'previous release-ready verifier CI evidence')
  if (receipt.schemaVersion !== 2 || receipt.acceptanceId !== 'P0-EXTENSION-CENTER-RELEASE-READY'
    || receipt.status !== 'passed' || typeof receipt.p0Status !== 'string'
    || !receipt.p0Status.endsWith('-release-ready') || receipt.p0Status === 'not-release-ready'
    || receiptDigest !== canonicalSha256(body)
    || target.repository !== GITHUB_REPOSITORY || target.sourceCommit !== previousCommit
    || target.version !== previous.version
    || verifier.repository !== GITHUB_REPOSITORY || verifier.workflowPath !== FAILED_WORKFLOW_PATH
    || verifier.ref !== 'refs/heads/main' || verifier.refProtected !== true
    || verifier.commit !== previousRun.headSha || verifier.runId !== previousRun.id
    || verifier.runAttempt !== previousRun.attempt
    || githubCi.acceptanceId !== 'P0-GITHUB-CI-EXACT-COMMIT'
    || githubCi.sha256 !== previous.fileSha256 || githubCi.receiptDigest !== previous.receiptDigest
    || githubCi.runId !== previous.runId
    || verifierGithubCi.acceptanceId !== 'P0-GITHUB-CI-EXACT-COMMIT'
    || verifierGithubCi.sha256 !== previousVerifier.fileSha256
    || verifierGithubCi.receiptDigest !== previousVerifier.receiptDigest
    || verifierGithubCi.commit !== previousRun.headSha
    || verifierGithubCi.runId !== previousVerifier.runId
    || verifierGithubCi.runAttempt !== previousVerifier.runAttempt) {
    fail('P0-PUBLICATION-INCIDENT-PREVIOUS', 'previous successful receipt does not cross-bind its target, verifier, and CI bytes')
  }
  return Object.freeze({
    acceptanceId: receipt.acceptanceId,
    p0Status: receipt.p0Status,
    fileSha256: parsed.fileSha256,
    receiptDigest,
    targetVersion: target.version,
    verifierCommit: verifier.commit,
  })
}

/** Validate exact failed publication evidence without converting failure into release readiness. */
export function validatePublicationIncidentEvidence(inputValue) {
  const input = record(inputValue, 'publication incident evidence')
  const commit = exactCommit(input.commit, 'target commit')
  const previousCommit = exactCommit(input.previousCommit, 'previous successful commit')
  if (commit === previousCommit) {
    fail('P0-PUBLICATION-INCIDENT-INPUT', 'target and previous successful commits must differ')
  }
  const failedRunId = positiveInteger(input.failedRunId, 'failed run id')
  const failedRunAttempt = positiveInteger(input.failedRunAttempt, 'failed run attempt')
  const previousRunId = positiveInteger(input.previousEvidenceRunId, 'previous evidence run id')
  const previousRunAttempt = positiveInteger(input.previousEvidenceRunAttempt, 'previous evidence run attempt')
  if (failedRunId === previousRunId) {
    fail('P0-PUBLICATION-INCIDENT-INPUT', 'failed and previous successful evidence runs must differ')
  }
  const failedRun = failedRunEvidence(input.failedRun, commit, failedRunId, failedRunAttempt)
  const failedJob = failedJobEvidence(input.failedJobs, failedRun, commit)
  const failedArchive = archiveFiles(
    input.failedArtifactArchive,
    FAILED_ARTIFACT_ENTRIES,
    FAILED_ARTIFACT_ENTRIES,
    'failed post-publication artifact',
  )
  const failedArtifact = artifactMetadata(
    input.failedArtifacts,
    {
      name: `post-publication-evidence-${commit}-${String(failedRunAttempt)}`,
      runId: failedRunId,
      headSha: commit,
    },
    failedArchive.archive,
    'failed post-publication artifact',
  )
  const current = ciReceiptEvidence(
    failedArchive.files['acceptance/github-ci/current.json'],
    commit,
    'failed artifact current CI receipt',
  )
  const previous = ciReceiptEvidence(
    failedArchive.files['acceptance/github-ci/previous.json'],
    previousCommit,
    'failed artifact previous CI receipt',
  )
  const verifier = ciReceiptEvidence(
    failedArchive.files['acceptance/github-ci/verifier.json'],
    failedRun.headSha,
    'failed artifact verifier CI receipt',
  )
  if (current.version === previous.version) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'failed publication target did not advance the previous successful version')
  }
  if (failedRun.headSha === commit && (current.fileSha256 !== verifier.fileSha256
    || current.receiptDigest !== verifier.receiptDigest)) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'same-commit target and verifier CI receipt bytes differ')
  }
  const release = publicReleaseEvidence(input.release, input.tagRef, current, commit)

  const previousRun = successfulPreviousRunEvidence(
    input.previousEvidenceRun,
    previousRunId,
    previousRunAttempt,
  )
  const previousArchive = archiveFiles(
    input.previousEvidenceArtifactArchive,
    PREVIOUS_ARTIFACT_ENTRIES,
    PREVIOUS_WANTED_ENTRIES,
    'previous successful post-publication artifact',
  )
  const previousArtifact = artifactMetadata(
    input.previousEvidenceArtifacts,
    {
      name: `post-publication-evidence-${previousCommit}-${String(previousRunAttempt)}`,
      runId: previousRunId,
      headSha: previousRun.headSha,
    },
    previousArchive.archive,
    'previous successful post-publication artifact',
  )
  const previousArtifactCurrent = ciReceiptEvidence(
    previousArchive.files['acceptance/github-ci/current.json'],
    previousCommit,
    'previous successful artifact target CI receipt',
  )
  const previousArtifactVerifier = ciReceiptEvidence(
    previousArchive.files['acceptance/github-ci/verifier.json'],
    previousRun.headSha,
    'previous successful artifact verifier CI receipt',
  )
  if (previousArtifactCurrent.fileSha256 !== previous.fileSha256
    || previousArtifactCurrent.receiptDigest !== previous.receiptDigest) {
    fail('P0-PUBLICATION-INCIDENT-PREVIOUS', 'failed attempt did not retain the exact previous successful target CI receipt')
  }
  const previousReleaseReady = previousReleaseReadyEvidence(
    previousArchive.files['acceptance/release-ready/receipt.json'],
    previousArtifactCurrent,
    previousArtifactVerifier,
    previousRun,
    previousCommit,
  )

  const verifierCommit = exactCommit(input.verifierCommit, 'incident verifier commit')
  const verifierRunId = positiveInteger(input.verifierRunId, 'incident verifier run id')
  const verifierRunAttempt = positiveInteger(input.verifierRunAttempt, 'incident verifier run attempt')
  if (input.verifierRefProtected !== true || verifierRunId === failedRunId
    || verifierRunId === previousRunId) {
    fail('P0-PUBLICATION-INCIDENT-VERIFIER', 'incident receipt must run once on a distinct protected-main workflow attempt')
  }
  const incidentVerifierCi = ciReceiptEvidence(
    input.incidentVerifierCiReceipt,
    verifierCommit,
    'incident verifier exact-main CI receipt',
  )
  const observedAt = input.observedAt === undefined
    ? new Date().toISOString()
    : timestamp(input.observedAt, 'incident observedAt')
  const body = Object.freeze({
    schemaVersion: 1,
    acceptanceId: 'P0-EXTENSION-CENTER-PUBLICATION-INCIDENT',
    status: 'failed',
    p0Status: 'not-release-ready',
    observedAt,
    target: Object.freeze({
      repository: GITHUB_REPOSITORY,
      sourceCommit: commit,
      version: current.version,
      release,
    }),
    verifier: Object.freeze({
      repository: GITHUB_REPOSITORY,
      workflowPath: INCIDENT_WORKFLOW_PATH,
      ref: 'refs/heads/main',
      refProtected: true,
      commit: verifierCommit,
      runId: verifierRunId,
      runAttempt: verifierRunAttempt,
      githubCi: Object.freeze({
        acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
        fileSha256: incidentVerifierCi.fileSha256,
        receiptDigest: incidentVerifierCi.receiptDigest,
        runId: incidentVerifierCi.runId,
        runAttempt: incidentVerifierCi.runAttempt,
      }),
    }),
    failure: Object.freeze({
      classification: 'runtime-release-verification-failed',
      run: failedRun,
      job: failedJob,
      artifact: Object.freeze({
        ...failedArtifact,
        entries: FAILED_ARTIFACT_ENTRIES,
        receipts: Object.freeze({
          current: Object.freeze({
            fileSha256: current.fileSha256,
            receiptDigest: current.receiptDigest,
            commit,
            version: current.version,
            ciRunId: current.runId,
            ciRunAttempt: current.runAttempt,
          }),
          previous: Object.freeze({
            fileSha256: previous.fileSha256,
            receiptDigest: previous.receiptDigest,
            commit: previousCommit,
            version: previous.version,
            ciRunId: previous.runId,
            ciRunAttempt: previous.runAttempt,
          }),
          verifier: Object.freeze({
            fileSha256: verifier.fileSha256,
            receiptDigest: verifier.receiptDigest,
            commit: failedRun.headSha,
            version: verifier.version,
            ciRunId: verifier.runId,
            ciRunAttempt: verifier.runAttempt,
          }),
        }),
      }),
      releaseReadyReceiptPresent: false,
      releaseReadyCompositeConclusion: failedJob.releaseReadyCompositeStep.conclusion,
    }),
    previousSuccessfulPublication: Object.freeze({
      targetCommit: previousCommit,
      run: previousRun,
      artifact: previousArtifact,
      releaseReadyReceipt: previousReleaseReady,
    }),
    releaseReadyAcceptanceId: null,
    notProven: Object.freeze([
      'release-readiness',
      'root-cause-from-actions-metadata',
      'successful-update-runtime-verification',
    ]),
  })
  return Object.freeze({ ...body, receiptDigest: canonicalSha256(body) })
}

function persistedReceiptRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} must be an object`)
  }
  return value
}

function persistedReceiptKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const normalized = [...expected].sort()
  if (actual.length !== normalized.length || actual.some((key, index) => key !== normalized[index])) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} has an unexpected key set`)
  }
}

function persistedReceiptString(value, label, maximum = 4_096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} must be one bounded string`)
  }
  return value
}

function persistedReceiptCommit(value, label) {
  const commit = persistedReceiptString(value, label, 40)
  if (!COMMIT.test(commit)) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} must be one lowercase 40-character SHA`)
  }
  return commit
}

function persistedReceiptSha256(value, label) {
  const digest = persistedReceiptString(value, label, 80)
  if (!SHA256.test(digest)) fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} must be one SHA-256`)
  return digest
}

function persistedReceiptInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} must be a positive integer`)
  }
  return value
}

function persistedReceiptTimestamp(value, label) {
  const decoded = persistedReceiptString(value, label, 64)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(decoded)
    || !Number.isFinite(Date.parse(decoded))) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} must be one valid UTC timestamp`)
  }
  return decoded
}

function persistedWorkflowRun(value, label, conclusion) {
  const run = persistedReceiptRecord(value, label)
  persistedReceiptKeys(run, [
    'attempt',
    'conclusion',
    'createdAt',
    'event',
    'headBranch',
    'headSha',
    'htmlUrl',
    'id',
    'runNumber',
    'status',
    'updatedAt',
    'workflowPath',
  ], label)
  const id = persistedReceiptInteger(run.id, `${label} id`)
  const attempt = persistedReceiptInteger(run.attempt, `${label} attempt`)
  const headSha = persistedReceiptCommit(run.headSha, `${label} head commit`)
  if (run.workflowPath !== FAILED_WORKFLOW_PATH || run.event !== 'workflow_dispatch'
    || run.headBranch !== GITHUB_BRANCH || run.status !== 'completed' || run.conclusion !== conclusion
    || run.htmlUrl !== `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${String(id)}`) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} is not the exact post-publication workflow result`)
  }
  return Object.freeze({
    id,
    attempt,
    runNumber: persistedReceiptInteger(run.runNumber, `${label} run number`),
    headSha,
    createdAt: persistedReceiptTimestamp(run.createdAt, `${label} createdAt`),
    updatedAt: persistedReceiptTimestamp(run.updatedAt, `${label} updatedAt`),
  })
}

function persistedCiCoordinate(value, label) {
  const coordinate = persistedReceiptRecord(value, label)
  persistedReceiptKeys(coordinate, [
    'ciRunAttempt',
    'ciRunId',
    'commit',
    'fileSha256',
    'receiptDigest',
    'version',
  ], label)
  const version = persistedReceiptString(coordinate.version, `${label} version`, 128)
  if (!VERSION.test(version)) fail('P0-PUBLICATION-INCIDENT-RECEIPT', `${label} version is unsupported`)
  return Object.freeze({
    commit: persistedReceiptCommit(coordinate.commit, `${label} commit`),
    version,
    fileSha256: persistedReceiptSha256(coordinate.fileSha256, `${label} file SHA-256`),
    receiptDigest: persistedReceiptSha256(coordinate.receiptDigest, `${label} receipt digest`),
    runId: persistedReceiptInteger(coordinate.ciRunId, `${label} CI run id`),
    runAttempt: persistedReceiptInteger(coordinate.ciRunAttempt, `${label} CI run attempt`),
  })
}

function assertedExpectedIncidentCoordinate(specification, key, observed, type) {
  if (specification === undefined || !Object.hasOwn(specification, key)) return
  const expected = type === 'commit'
    ? exactCommit(specification[key], `expected ${key}`)
    : positiveInteger(specification[key], `expected ${key}`, 'P0-PUBLICATION-INCIDENT-INPUT')
  if (observed !== expected) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', `publication incident receipt does not bind expected ${key}`)
  }
}

/**
 * Strictly normalize a persisted incident receipt for a later release composite.
 * @param {unknown} value Persisted schema-1 publication incident receipt.
 * @param {Record<string, unknown>} [specification] Optional expected run and commit coordinates.
 * @returns {Readonly<Record<string, unknown>>} Cross-bound terminal incident coordinates.
 */
export function validatePublicationIncidentReceipt(value, specification) {
  const receipt = persistedReceiptRecord(value, 'publication incident receipt')
  persistedReceiptKeys(receipt, [
    'acceptanceId',
    'failure',
    'notProven',
    'observedAt',
    'p0Status',
    'previousSuccessfulPublication',
    'receiptDigest',
    'releaseReadyAcceptanceId',
    'schemaVersion',
    'status',
    'target',
    'verifier',
  ], 'publication incident receipt')
  const { receiptDigest, ...body } = receipt
  if (receipt.schemaVersion !== 1
    || receipt.acceptanceId !== 'P0-EXTENSION-CENTER-PUBLICATION-INCIDENT'
    || receipt.status !== 'failed' || receipt.p0Status !== 'not-release-ready'
    || receipt.releaseReadyAcceptanceId !== null
    || receiptDigest !== canonicalSha256(body)) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident receipt status or self-digest is invalid')
  }
  persistedReceiptTimestamp(receipt.observedAt, 'publication incident observedAt')
  const expectedNotProven = [
    'release-readiness',
    'root-cause-from-actions-metadata',
    'successful-update-runtime-verification',
  ]
  if (!Array.isArray(receipt.notProven) || receipt.notProven.length !== expectedNotProven.length
    || receipt.notProven.some((entry, index) => entry !== expectedNotProven[index])) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident notProven set changed')
  }

  const target = persistedReceiptRecord(receipt.target, 'publication incident target')
  persistedReceiptKeys(target, ['release', 'repository', 'sourceCommit', 'version'], 'publication incident target')
  const targetCommit = persistedReceiptCommit(target.sourceCommit, 'publication incident target commit')
  const targetVersion = persistedReceiptString(target.version, 'publication incident target version', 128)
  if (target.repository !== GITHUB_REPOSITORY || !VERSION.test(targetVersion)) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident target repository or version changed')
  }
  const release = persistedReceiptRecord(target.release, 'publication incident immutable Release')
  persistedReceiptKeys(release, [
    'assets',
    'createdAt',
    'htmlUrl',
    'id',
    'immutable',
    'prerelease',
    'publishedAt',
    'tag',
    'tagCommit',
    'version',
  ], 'publication incident immutable Release')
  const releaseId = persistedReceiptInteger(release.id, 'publication incident Release id')
  const tag = `v${targetVersion}`
  if (release.version !== targetVersion || release.tag !== tag || release.tagCommit !== targetCommit
    || release.immutable !== true || release.prerelease !== targetVersion.includes('-')
    || release.htmlUrl !== `https://github.com/${GITHUB_REPOSITORY}/releases/tag/${tag}`) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident immutable Release identity changed')
  }
  persistedReceiptTimestamp(release.createdAt, 'publication incident Release createdAt')
  persistedReceiptTimestamp(release.publishedAt, 'publication incident Release publishedAt')
  const expectedAssetNames = [
    `dsh-plugin-extension-center-${targetVersion}.tgz`,
    'SHA256SUMS',
    'pack-attestation.json',
  ]
  if (!Array.isArray(release.assets) || release.assets.length !== expectedAssetNames.length) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident immutable Release asset set changed')
  }
  const assets = release.assets.map((value_, index) => {
    const asset = persistedReceiptRecord(value_, `publication incident Release asset ${String(index)}`)
    persistedReceiptKeys(asset, ['id', 'name', 'publicUrl', 'sha256', 'sizeBytes'], `publication incident Release asset ${String(index)}`)
    const name = expectedAssetNames[index]
    const expectedUrl = `https://github.com/${GITHUB_REPOSITORY}/releases/download/${tag}/${name}`
    if (asset.name !== name || asset.publicUrl !== expectedUrl) {
      fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident Release asset identity changed')
    }
    return Object.freeze({
      id: persistedReceiptInteger(asset.id, `${name} asset id`),
      name,
      sizeBytes: persistedReceiptInteger(asset.sizeBytes, `${name} asset size`),
      sha256: persistedReceiptSha256(asset.sha256, `${name} asset SHA-256`),
    })
  })

  const verifier = persistedReceiptRecord(receipt.verifier, 'publication incident verifier')
  persistedReceiptKeys(verifier, [
    'commit',
    'githubCi',
    'ref',
    'refProtected',
    'repository',
    'runAttempt',
    'runId',
    'workflowPath',
  ], 'publication incident verifier')
  const verifierCommit = persistedReceiptCommit(verifier.commit, 'publication incident verifier commit')
  const verifierRunId = persistedReceiptInteger(verifier.runId, 'publication incident verifier run id')
  const verifierRunAttempt = persistedReceiptInteger(verifier.runAttempt, 'publication incident verifier run attempt')
  if (verifier.repository !== GITHUB_REPOSITORY || verifier.workflowPath !== INCIDENT_WORKFLOW_PATH
    || verifier.ref !== 'refs/heads/main' || verifier.refProtected !== true) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident verifier is not protected main')
  }
  const verifierGithubCi = persistedReceiptRecord(verifier.githubCi, 'publication incident verifier CI')
  persistedReceiptKeys(verifierGithubCi, [
    'acceptanceId',
    'fileSha256',
    'receiptDigest',
    'runAttempt',
    'runId',
  ], 'publication incident verifier CI')
  if (verifierGithubCi.acceptanceId !== 'P0-GITHUB-CI-EXACT-COMMIT') {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident verifier lacks exact-main CI evidence')
  }
  const normalizedVerifierCi = Object.freeze({
    acceptanceId: verifierGithubCi.acceptanceId,
    fileSha256: persistedReceiptSha256(verifierGithubCi.fileSha256, 'incident verifier CI file SHA-256'),
    receiptDigest: persistedReceiptSha256(verifierGithubCi.receiptDigest, 'incident verifier CI receipt digest'),
    runId: persistedReceiptInteger(verifierGithubCi.runId, 'incident verifier CI run id'),
    runAttempt: persistedReceiptInteger(verifierGithubCi.runAttempt, 'incident verifier CI run attempt'),
  })

  const failure = persistedReceiptRecord(receipt.failure, 'publication incident failure')
  persistedReceiptKeys(failure, [
    'artifact',
    'classification',
    'job',
    'releaseReadyCompositeConclusion',
    'releaseReadyReceiptPresent',
    'run',
  ], 'publication incident failure')
  if (failure.classification !== 'runtime-release-verification-failed'
    || failure.releaseReadyReceiptPresent !== false
    || failure.releaseReadyCompositeConclusion !== 'skipped') {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident failure classification changed')
  }
  const failedRun = persistedWorkflowRun(failure.run, 'publication incident failed run', 'failure')
  if (failedRun.headSha !== targetCommit) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident failed run does not bind the target commit')
  }
  const job = persistedReceiptRecord(failure.job, 'publication incident failed job')
  persistedReceiptKeys(job, [
    'completedAt',
    'conclusion',
    'failedStep',
    'htmlUrl',
    'id',
    'name',
    'releaseReadyCompositeStep',
    'startedAt',
    'status',
  ], 'publication incident failed job')
  const jobId = persistedReceiptInteger(job.id, 'publication incident failed job id')
  if (job.name !== FAILED_JOB_NAME || job.status !== 'completed' || job.conclusion !== 'failure'
    || job.htmlUrl !== `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${String(failedRun.id)}/job/${String(jobId)}`) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident failed job identity changed')
  }
  persistedReceiptTimestamp(job.startedAt, 'publication incident failed job startedAt')
  persistedReceiptTimestamp(job.completedAt, 'publication incident failed job completedAt')
  const failedStep = persistedReceiptRecord(job.failedStep, 'publication incident failed step')
  persistedReceiptKeys(failedStep, [
    'completedAt',
    'conclusion',
    'name',
    'number',
    'startedAt',
    'status',
  ], 'publication incident failed step')
  if (failedStep.number !== 15 || failedStep.name !== FAILED_STEP_NAME
    || failedStep.status !== 'completed' || failedStep.conclusion !== 'failure') {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident failed step identity changed')
  }
  persistedReceiptTimestamp(failedStep.startedAt, 'publication incident failed step startedAt')
  persistedReceiptTimestamp(failedStep.completedAt, 'publication incident failed step completedAt')
  const compositeStep = persistedReceiptRecord(
    job.releaseReadyCompositeStep,
    'publication incident skipped release-ready step',
  )
  persistedReceiptKeys(compositeStep, ['conclusion', 'name', 'number', 'status'], 'publication incident skipped release-ready step')
  if (compositeStep.number !== 20 || compositeStep.name !== 'Compose one cross-bound release-ready receipt'
    || compositeStep.status !== 'completed' || compositeStep.conclusion !== 'skipped') {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident release-ready step was not skipped')
  }

  const artifact = persistedReceiptRecord(failure.artifact, 'publication incident failed artifact')
  persistedReceiptKeys(artifact, [
    'archiveSha256',
    'archiveSizeBytes',
    'entries',
    'id',
    'name',
    'receipts',
  ], 'publication incident failed artifact')
  const artifactId = persistedReceiptInteger(artifact.id, 'publication incident failed artifact id')
  const artifactName = `post-publication-evidence-${targetCommit}-${String(failedRun.attempt)}`
  if (artifact.name !== artifactName || !Array.isArray(artifact.entries)
    || artifact.entries.length !== FAILED_ARTIFACT_ENTRIES.length
    || artifact.entries.some((entry, index) => entry !== FAILED_ARTIFACT_ENTRIES[index])) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident failed artifact entry set changed')
  }
  const artifactArchiveSizeBytes = persistedReceiptInteger(
    artifact.archiveSizeBytes,
    'publication incident failed artifact archive size',
  )
  const artifactArchiveSha256 = persistedReceiptSha256(
    artifact.archiveSha256,
    'publication incident failed artifact archive SHA-256',
  )
  const receiptCoordinates = persistedReceiptRecord(artifact.receipts, 'publication incident failed artifact receipts')
  persistedReceiptKeys(receiptCoordinates, ['current', 'previous', 'verifier'], 'publication incident failed artifact receipts')
  const current = persistedCiCoordinate(receiptCoordinates.current, 'publication incident current CI receipt')
  const previous = persistedCiCoordinate(receiptCoordinates.previous, 'publication incident previous CI receipt')
  const failedVerifier = persistedCiCoordinate(receiptCoordinates.verifier, 'publication incident failed verifier CI receipt')
  if (current.commit !== targetCommit || current.version !== targetVersion
    || failedVerifier.commit !== failedRun.headSha || failedVerifier.version !== targetVersion
    || current.fileSha256 !== failedVerifier.fileSha256
    || current.receiptDigest !== failedVerifier.receiptDigest) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident target and failed-verifier CI coordinates diverged')
  }

  const prior = persistedReceiptRecord(
    receipt.previousSuccessfulPublication,
    'publication incident previous successful publication',
  )
  persistedReceiptKeys(prior, [
    'artifact',
    'releaseReadyReceipt',
    'run',
    'targetCommit',
  ], 'publication incident previous successful publication')
  const previousCommit = persistedReceiptCommit(prior.targetCommit, 'previous successful publication target commit')
  if (previousCommit === targetCommit || previous.commit !== previousCommit
    || previous.version === targetVersion) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'previous successful publication does not bind the retained previous CI receipt')
  }
  const previousRun = persistedWorkflowRun(prior.run, 'previous successful publication run', 'success')
  if (previousRun.id === failedRun.id || verifierRunId === failedRun.id || verifierRunId === previousRun.id) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'publication incident workflow run identities are not distinct')
  }
  const previousArtifact = persistedReceiptRecord(prior.artifact, 'previous successful publication artifact')
  persistedReceiptKeys(previousArtifact, ['archiveSha256', 'archiveSizeBytes', 'id', 'name'], 'previous successful publication artifact')
  const previousArtifactId = persistedReceiptInteger(previousArtifact.id, 'previous successful publication artifact id')
  if (previousArtifact.name !== `post-publication-evidence-${previousCommit}-${String(previousRun.attempt)}`) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'previous successful publication artifact identity changed')
  }
  const previousArtifactArchiveSizeBytes = persistedReceiptInteger(
    previousArtifact.archiveSizeBytes,
    'previous successful publication artifact archive size',
  )
  const previousArtifactArchiveSha256 = persistedReceiptSha256(
    previousArtifact.archiveSha256,
    'previous successful publication artifact archive SHA-256',
  )
  const previousReady = persistedReceiptRecord(prior.releaseReadyReceipt, 'previous successful release-ready receipt')
  persistedReceiptKeys(previousReady, [
    'acceptanceId',
    'fileSha256',
    'p0Status',
    'receiptDigest',
    'targetVersion',
    'verifierCommit',
  ], 'previous successful release-ready receipt')
  if (previousReady.acceptanceId !== 'P0-EXTENSION-CENTER-RELEASE-READY'
    || typeof previousReady.p0Status !== 'string' || !previousReady.p0Status.endsWith('-release-ready')
    || previousReady.p0Status === 'not-release-ready' || previousReady.targetVersion !== previous.version
    || previousReady.verifierCommit !== previousRun.headSha) {
    fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'previous successful release-ready receipt binding changed')
  }
  const previousReadyFileSha256 = persistedReceiptSha256(
    previousReady.fileSha256,
    'previous successful release-ready receipt file SHA-256',
  )
  const previousReadyReceiptDigest = persistedReceiptSha256(
    previousReady.receiptDigest,
    'previous successful release-ready receipt digest',
  )

  if (specification !== undefined) persistedReceiptRecord(specification, 'expected incident coordinates')
  assertedExpectedIncidentCoordinate(specification, 'targetCommit', targetCommit, 'commit')
  assertedExpectedIncidentCoordinate(specification, 'failedRunId', failedRun.id, 'integer')
  assertedExpectedIncidentCoordinate(specification, 'failedRunAttempt', failedRun.attempt, 'integer')
  assertedExpectedIncidentCoordinate(specification, 'previousCommit', previousCommit, 'commit')
  assertedExpectedIncidentCoordinate(specification, 'previousEvidenceRunId', previousRun.id, 'integer')
  assertedExpectedIncidentCoordinate(specification, 'previousEvidenceRunAttempt', previousRun.attempt, 'integer')
  assertedExpectedIncidentCoordinate(specification, 'verifierCommit', verifierCommit, 'commit')
  assertedExpectedIncidentCoordinate(specification, 'verifierRunId', verifierRunId, 'integer')
  assertedExpectedIncidentCoordinate(specification, 'verifierRunAttempt', verifierRunAttempt, 'integer')

  return Object.freeze({
    acceptanceId: receipt.acceptanceId,
    status: receipt.status,
    p0Status: receipt.p0Status,
    receiptDigest,
    target: Object.freeze({
      repository: GITHUB_REPOSITORY,
      sourceCommit: targetCommit,
      version: targetVersion,
      releaseId,
      assets: Object.freeze(assets),
    }),
    verifier: Object.freeze({
      commit: verifierCommit,
      runId: verifierRunId,
      runAttempt: verifierRunAttempt,
      githubCi: normalizedVerifierCi,
    }),
    failure: Object.freeze({
      classification: failure.classification,
      runId: failedRun.id,
      runAttempt: failedRun.attempt,
      jobId,
      failedStep: FAILED_STEP_NAME,
      artifactId,
      artifactName,
      artifactArchiveSizeBytes,
      artifactArchiveSha256,
      current,
      previous,
      verifier: failedVerifier,
    }),
    previousSuccessfulPublication: Object.freeze({
      targetCommit: previousCommit,
      runId: previousRun.id,
      runAttempt: previousRun.attempt,
      artifactId: previousArtifactId,
      artifactArchiveSizeBytes: previousArtifactArchiveSizeBytes,
      artifactArchiveSha256: previousArtifactArchiveSha256,
      releaseReadyFileSha256: previousReadyFileSha256,
      releaseReadyReceiptDigest: previousReadyReceiptDigest,
    }),
  })
}

async function boundedJsonResponse(response, label) {
  if (response.status !== 200 || response.redirected) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-PUBLICATION-INCIDENT-HTTP', `${label} returned an unexpected HTTP response`)
  }
  const encoding = response.headers.get('content-encoding')
  if (encoding !== null && encoding !== 'identity') {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-PUBLICATION-INCIDENT-HTTP', `${label} changed response byte identity`)
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/u.test(declared)
    || Number(declared) > MAX_JSON_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-PUBLICATION-INCIDENT-HTTP', `${label} exceeded its response bound`)
  }
  if (response.body === null) fail('P0-PUBLICATION-INCIDENT-HTTP', `${label} returned no body`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_JSON_RESPONSE_BYTES) fail('P0-PUBLICATION-INCIDENT-HTTP', `${label} exceeded its response bound`)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } catch {
    fail('P0-PUBLICATION-INCIDENT-FORMAT', `${label} response is not JSON`)
  }
}

async function fetchGitHubJson(path, fetchImpl, token, label) {
  const headers = {
    accept: 'application/vnd.github+json',
    'accept-encoding': 'identity',
    'user-agent': 'dsh-extension-center-publication-incident',
    'x-github-api-version': '2022-11-28',
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  let response
  try {
    response = await fetchImpl(`${API_ROOT}/${path}`, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    fail('P0-PUBLICATION-INCIDENT-HTTP', `${label} request failed: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}`)
  }
  return boundedJsonResponse(response, label)
}

function artifactRedirect(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', 'Actions artifact returned an invalid redirect')
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== ''
    || !(url.hostname.endsWith('.blob.core.windows.net')
      || url.hostname.endsWith('.actions.githubusercontent.com'))) {
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', 'Actions artifact redirected outside admitted GitHub storage')
  }
  return url
}

async function boundedArchiveResponse(response, label) {
  if (response.status !== 200 || response.redirected || response.body === null) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} returned an unexpected HTTP response`)
  }
  const encoding = response.headers.get('content-encoding')
  if (encoding !== null && encoding !== 'identity') {
    await response.body.cancel().catch(() => undefined)
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} changed response byte identity`)
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/u.test(declared)
    || Number(declared) > MAX_ARTIFACT_ARCHIVE_BYTES)) {
    await response.body.cancel().catch(() => undefined)
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} exceeded its archive bound`)
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_ARTIFACT_ARCHIVE_BYTES) {
      fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} exceeded its archive bound`)
    }
    chunks.push(chunk)
  }
  if (size < 1) fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} returned an empty archive`)
  return Buffer.concat(chunks, size)
}

async function downloadArtifactBytes(metadataValue, fetchImpl, token, label) {
  const metadata = record(metadataValue, `${label} metadata`)
  const id = positiveInteger(metadata.id, `${label} id`)
  const expectedUrl = `${API_ROOT}/actions/artifacts/${String(id)}/zip`
  if (metadata.archive_download_url !== expectedUrl) {
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} has an unexpected download URL`)
  }
  const headers = {
    accept: 'application/vnd.github+json',
    'accept-encoding': 'identity',
    'user-agent': 'dsh-extension-center-publication-incident',
    'x-github-api-version': '2022-11-28',
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  let response
  try {
    response = await fetchImpl(expectedUrl, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} API request failed`)
  }
  if ([302, 303, 307].includes(response.status)) {
    const redirect = artifactRedirect(response.headers.get('location'))
    await response.body?.cancel().catch(() => undefined)
    try {
      response = await fetchImpl(redirect, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/zip', 'accept-encoding': 'identity' },
        signal: AbortSignal.timeout(60_000),
      })
    } catch {
      fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${label} storage request failed`)
    }
  }
  return boundedArchiveResponse(response, label)
}

async function loadArtifactArchive(metadata, options) {
  const archiveBytes = await downloadArtifactBytes(
    metadata,
    options.fetchImpl,
    options.token,
    options.label,
  )
  const root = await mkdtemp(join(tmpdir(), 'dsh-publication-incident-'))
  try {
    const archivePath = join(root, 'artifact.zip')
    await writeFile(archivePath, archiveBytes, { flag: 'wx', mode: 0o600 })
    const listBytes = await runBuffered(
      'unzip',
      ['-Z1', archivePath],
      MAX_ARTIFACT_ENTRY_LIST_BYTES,
      'P0-PUBLICATION-INCIDENT-ARTIFACT',
    )
    const entries = listBytes.toString('utf8').split(/\r?\n/u).filter(Boolean)
    if (entries.length < 1 || entries.length > 64 || new Set(entries).size !== entries.length
      || entries.some(entry => entry.length > 512 || !/^[ -~]+$/u.test(entry)
        || entry.startsWith('/') || entry.includes('\\')
        || entry.split('/').some(segment => segment === '' || segment === '.' || segment === '..'))) {
      fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${options.label} has an unsafe or ambiguous entry list`)
    }
    const files = {}
    for (const entry of options.wantedEntries) {
      if (!entries.includes(entry)) {
        fail('P0-PUBLICATION-INCIDENT-ARTIFACT', `${options.label} is missing ${entry}`)
      }
      files[entry] = await runBuffered(
        'unzip',
        ['-p', archivePath, entry],
        MAX_ARTIFACT_ENTRY_BYTES,
        'P0-PUBLICATION-INCIDENT-ARTIFACT',
      )
    }
    return Object.freeze({
      archiveSha256: sha256(archiveBytes),
      archiveSizeBytes: archiveBytes.byteLength,
      entries: Object.freeze(entries),
      files: Object.freeze(files),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function prepareReceiptDestination(path, verifierCiReceiptPath) {
  const requested = resolve(path)
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 })
  const destination = resolve(await realpath(dirname(requested)), basename(requested))
  if (await realpath(verifierCiReceiptPath) === destination) {
    fail('P0-PUBLICATION-INCIDENT-OUTPUT', 'publication incident output aliases its verifier CI input')
  }
  try {
    await lstat(destination)
    fail('P0-PUBLICATION-INCIDENT-OUTPUT', 'publication incident receipt already exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return destination
}

async function writeReceipt(destination, receipt) {
  const temporary = resolve(dirname(destination), `.publication-incident-${randomUUID()}`)
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  try {
    await link(temporary, destination)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail('P0-PUBLICATION-INCIDENT-OUTPUT', 'publication incident receipt appeared concurrently')
    }
    throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** Fetch exact GitHub evidence and atomically persist one terminal not-release-ready receipt. */
export async function runPublicationIncidentAcceptance(optionsValue) {
  const options = record(optionsValue, 'publication incident options')
  const commit = exactCommit(options.commit, 'target commit')
  const previousCommit = exactCommit(options.previousCommit, 'previous successful commit')
  const failedRunId = positiveInteger(options.failedRunId, 'failed run id')
  const failedRunAttempt = positiveInteger(options.failedRunAttempt, 'failed run attempt')
  const previousEvidenceRunId = positiveInteger(options.previousEvidenceRunId, 'previous evidence run id')
  const previousEvidenceRunAttempt = positiveInteger(
    options.previousEvidenceRunAttempt,
    'previous evidence run attempt',
  )
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') fail('P0-PUBLICATION-INCIDENT-HTTP', 'HTTPS fetch is unavailable')
  const token = options.token === undefined || options.token === null || options.token === ''
    ? null
    : bounded(options.token, 'GitHub token', 4_096)
  const verifierCiReceiptPath = resolve(bounded(options.verifierCiReceiptPath, 'verifier CI receipt path'))
  const verifierCiInfo = await lstat(verifierCiReceiptPath)
  if (!verifierCiInfo.isFile() || verifierCiInfo.isSymbolicLink()
    || verifierCiInfo.size < 2 || verifierCiInfo.size > MAX_JSON_RESPONSE_BYTES) {
    fail('P0-PUBLICATION-INCIDENT-VERIFIER', 'verifier CI receipt is not one bounded regular file')
  }
  const incidentVerifierCiReceipt = await readFile(verifierCiReceiptPath)
  const verifierCiReceiptSha256 = exactSha256(
    options.verifierCiReceiptSha256,
    'verifier CI receipt file SHA-256',
  )
  if (sha256(incidentVerifierCiReceipt) !== verifierCiReceiptSha256) {
    fail('P0-PUBLICATION-INCIDENT-VERIFIER', 'verifier CI receipt bytes differ from their supplied SHA-256')
  }
  const destination = await prepareReceiptDestination(
    options.receiptPath ?? DEFAULT_RECEIPT_PATH,
    verifierCiReceiptPath,
  )
  const [failedRun, failedJobs, failedArtifacts, previousEvidenceRun, previousEvidenceArtifacts] = await Promise.all([
    fetchGitHubJson(`actions/runs/${String(failedRunId)}`, fetchImpl, token, 'failed workflow run'),
    fetchGitHubJson(
      `actions/runs/${String(failedRunId)}/attempts/${String(failedRunAttempt)}/jobs?per_page=100`,
      fetchImpl,
      token,
      'failed workflow jobs',
    ),
    fetchGitHubJson(
      `actions/runs/${String(failedRunId)}/artifacts?per_page=100`,
      fetchImpl,
      token,
      'failed workflow artifacts',
    ),
    fetchGitHubJson(
      `actions/runs/${String(previousEvidenceRunId)}`,
      fetchImpl,
      token,
      'previous evidence workflow run',
    ),
    fetchGitHubJson(
      `actions/runs/${String(previousEvidenceRunId)}/artifacts?per_page=100`,
      fetchImpl,
      token,
      'previous evidence workflow artifacts',
    ),
  ])
  const failedArtifactResponse = record(failedArtifacts, 'failed workflow artifacts response')
  const previousArtifactResponse = record(previousEvidenceArtifacts, 'previous workflow artifacts response')
  if (!Array.isArray(failedArtifactResponse.artifacts) || failedArtifactResponse.artifacts.length !== 1
    || !Array.isArray(previousArtifactResponse.artifacts) || previousArtifactResponse.artifacts.length !== 1) {
    fail('P0-PUBLICATION-INCIDENT-ARTIFACT', 'workflow artifact responses are incomplete or ambiguous')
  }
  const artifactArchiveLoader = options.artifactArchiveLoader ?? loadArtifactArchive
  const [failedArtifactArchive, previousEvidenceArtifactArchive] = await Promise.all([
    artifactArchiveLoader(failedArtifactResponse.artifacts[0], {
      fetchImpl,
      token,
      label: 'failed post-publication artifact',
      wantedEntries: FAILED_ARTIFACT_ENTRIES,
    }),
    artifactArchiveLoader(previousArtifactResponse.artifacts[0], {
      fetchImpl,
      token,
      label: 'previous successful post-publication artifact',
      wantedEntries: PREVIOUS_WANTED_ENTRIES,
    }),
  ])
  const failedFiles = record(failedArtifactArchive.files, 'failed post-publication artifact files')
  const currentParsed = parseReceiptBytes(
    failedFiles['acceptance/github-ci/current.json'],
    'failed artifact current CI receipt',
  )
  const currentPack = record(currentParsed.receipt.packAttestation, 'failed artifact current pack attestation')
  const version = bounded(currentPack.version, 'failed publication version', 128)
  if (!VERSION.test(version)) fail('P0-PUBLICATION-INCIDENT-RECEIPT', 'failed publication version is unsupported')
  const tag = `v${version}`
  const [release, tagRef] = await Promise.all([
    fetchGitHubJson(`releases/tags/${tag}`, fetchImpl, token, 'target immutable Release'),
    fetchGitHubJson(`git/ref/tags/${tag}`, fetchImpl, token, 'target Git tag'),
  ])
  const receipt = validatePublicationIncidentEvidence({
    commit,
    previousCommit,
    failedRunId,
    failedRunAttempt,
    previousEvidenceRunId,
    previousEvidenceRunAttempt,
    verifierCommit: options.verifierCommit,
    verifierRunId: options.verifierRunId,
    verifierRunAttempt: options.verifierRunAttempt,
    verifierRefProtected: options.verifierRefProtected,
    incidentVerifierCiReceipt,
    observedAt: options.observedAt,
    failedRun,
    failedJobs,
    failedArtifacts,
    failedArtifactArchive,
    release,
    tagRef,
    previousEvidenceRun,
    previousEvidenceArtifacts,
    previousEvidenceArtifactArchive,
  })
  validatePublicationIncidentReceipt(receipt)
  await writeReceipt(destination, receipt)
  return Object.freeze({ receipt, receiptPath: destination })
}

export function parsePublicationIncidentArguments(arguments_) {
  if (!Array.isArray(arguments_)) fail('P0-PUBLICATION-INCIDENT-INPUT', 'CLI arguments must be an array')
  if (arguments_.length === 1 && arguments_[0] === '--help') return Object.freeze({ help: true })
  if (arguments_.length % 2 !== 0) {
    fail('P0-PUBLICATION-INCIDENT-INPUT', 'CLI flags must be key/value pairs')
  }
  const admitted = new Set([
    '--commit',
    '--failed-run-id',
    '--failed-run-attempt',
    '--previous-commit',
    '--previous-evidence-run-id',
    '--previous-evidence-run-attempt',
    '--verifier-commit',
    '--verifier-run-id',
    '--verifier-run-attempt',
    '--verifier-ref-protected',
    '--verifier-ci-receipt',
    '--verifier-ci-receipt-sha256',
    '--receipt',
  ])
  const values = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (!admitted.has(key) || values.has(key) || value === undefined) {
      fail('P0-PUBLICATION-INCIDENT-INPUT', 'CLI received an unknown, duplicate, or valueless flag')
    }
    values.set(key, value)
  }
  const required = [...admitted].filter(key => key !== '--receipt')
  if (required.some(key => !values.has(key))) {
    fail('P0-PUBLICATION-INCIDENT-INPUT', 'CLI is missing one or more required incident coordinates')
  }
  if (values.get('--verifier-ref-protected') !== 'true') {
    fail('P0-PUBLICATION-INCIDENT-INPUT', '--verifier-ref-protected must be exactly true')
  }
  return Object.freeze({
    help: false,
    commit: exactCommit(values.get('--commit'), 'target commit'),
    failedRunId: positiveIntegerArgument(values.get('--failed-run-id'), 'failed run id'),
    failedRunAttempt: positiveIntegerArgument(values.get('--failed-run-attempt'), 'failed run attempt'),
    previousCommit: exactCommit(values.get('--previous-commit'), 'previous successful commit'),
    previousEvidenceRunId: positiveIntegerArgument(
      values.get('--previous-evidence-run-id'),
      'previous evidence run id',
    ),
    previousEvidenceRunAttempt: positiveIntegerArgument(
      values.get('--previous-evidence-run-attempt'),
      'previous evidence run attempt',
    ),
    verifierCommit: exactCommit(values.get('--verifier-commit'), 'incident verifier commit'),
    verifierRunId: positiveIntegerArgument(values.get('--verifier-run-id'), 'incident verifier run id'),
    verifierRunAttempt: positiveIntegerArgument(
      values.get('--verifier-run-attempt'),
      'incident verifier run attempt',
    ),
    verifierRefProtected: true,
    verifierCiReceiptPath: resolve(bounded(values.get('--verifier-ci-receipt'), 'verifier CI receipt path')),
    verifierCiReceiptSha256: exactSha256(
      values.get('--verifier-ci-receipt-sha256'),
      'verifier CI receipt file SHA-256',
    ),
    receiptPath: resolve(values.has('--receipt')
      ? bounded(values.get('--receipt'), 'receipt path')
      : DEFAULT_RECEIPT_PATH),
  })
}

async function main() {
  try {
    const parsed = parsePublicationIncidentArguments(process.argv.slice(2))
    if (parsed.help) {
      process.stdout.write(USAGE)
      return 0
    }
    const result = await runPublicationIncidentAcceptance({
      ...parsed,
      token: process.env.GITHUB_TOKEN,
    })
    process.stdout.write(
      `${result.receipt.p0Status}; receipt=${result.receiptPath}; digest=${result.receipt.receiptDigest}\n`,
    )
    return 0
  } catch (error) {
    const code = error instanceof AcceptanceFailure ? error.code : 'P0-PUBLICATION-INCIDENT-HARNESS'
    process.stderr.write(`${code}: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
