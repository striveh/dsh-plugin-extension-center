#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import {
  AcceptanceFailure,
  sanitizeDiagnostic,
} from '../full-p0/support.mjs'
import { canonicalSha256 } from '../full-p0/receipt-binding.mjs'

export const GITHUB_REPOSITORY = 'striveh/dsh-plugin-extension-center'
export const GITHUB_WORKFLOW_PATH = '.github/workflows/ci.yml'
export const GITHUB_BRANCH = 'main'
export const REQUIRED_CI_JOBS = Object.freeze([
  Object.freeze({ key: 'node22', name: 'Node 22.19.0 source, package, and committed artifacts' }),
  Object.freeze({ key: 'node24', name: 'Node 24 source, package, and committed artifacts' }),
  Object.freeze({ key: 'linuxLifecycle', name: 'Official rc.2 Store and plugin-only lifecycle (ubuntu-latest)' }),
  Object.freeze({ key: 'macosLifecycle', name: 'Official rc.2 Store and plugin-only lifecycle (macos-15)' }),
  Object.freeze({ key: 'aggregate', name: 'Official rc.2 plugin-only release gate' }),
])

const API_ROOT = `https://api.github.com/repos/${GITHUB_REPOSITORY}`
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_ATTESTATION_BYTES = 1024 * 1024
const MAX_PACK_ENTRY_LIST_BYTES = 32 * 1024 * 1024
const MAX_PACK_TAR_BYTES = 64 * 1024 * 1024
const MAX_PACKED_PNPM_ENTRIES = 10_000
const MAX_PACKED_PNPM_FILE_BYTES = 64 * 1024 * 1024
const MAX_PACKED_PNPM_TREE_BYTES = 128 * 1024 * 1024
const COMMIT = /^[0-9a-f]{40}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const DEFAULT_RECEIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../.artifacts/acceptance/github-ci/receipt.json',
)
const USAGE = 'usage: node acceptance/release/verify-github-ci.mjs --commit <40-character-sha> [--receipt <path>]\n'

function fail(code, message) {
  throw new AcceptanceFailure(code, message)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('P0-GITHUB-CI-FORMAT', `${label} must be an object`)
  }
  return value
}

function bounded(value, label, maximum = 4_096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('P0-GITHUB-CI-INPUT', `${label} must be one bounded string`)
  }
  return value
}

function exactCommit(value) {
  const decoded = bounded(value, 'commit', 40)
  if (!COMMIT.test(decoded)) fail('P0-GITHUB-CI-INPUT', 'commit must be one lowercase 40-character SHA')
  return decoded
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('P0-GITHUB-CI-FORMAT', `${label} must be a positive integer`)
  return value
}

function timestamp(value, label) {
  const decoded = bounded(value, label, 64)
  const milliseconds = Date.parse(decoded)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(decoded)
    || !Number.isFinite(milliseconds)) {
    fail('P0-GITHUB-CI-FORMAT', `${label} must be one valid GitHub UTC timestamp`)
  }
  return decoded
}

function workflowRun(value, commit) {
  const run = record(value, 'workflow run')
  const repository = record(run.repository, 'workflow run repository')
  const headRepository = record(run.head_repository, 'workflow run head repository')
  const id = positiveInteger(run.id, 'workflow run id')
  const attempt = positiveInteger(run.run_attempt, 'workflow run attempt')
  if (run.name !== 'CI' || run.path !== GITHUB_WORKFLOW_PATH || run.event !== 'push'
    || run.head_branch !== GITHUB_BRANCH || run.head_sha !== commit
    || run.status !== 'completed' || run.conclusion !== 'success'
    || repository.full_name !== GITHUB_REPOSITORY || headRepository.full_name !== GITHUB_REPOSITORY
    || run.html_url !== `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${String(id)}`) {
    fail('P0-GITHUB-CI-RUN', 'workflow run is not the successful main push for the exact release commit')
  }
  return Object.freeze({
    id,
    attempt,
    runNumber: positiveInteger(run.run_number, 'workflow run number'),
    event: run.event,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    createdAt: timestamp(run.created_at, 'workflow run created_at'),
    updatedAt: timestamp(run.updated_at, 'workflow run updated_at'),
  })
}

function successfulJob(value, requirement, run, commit) {
  const job = record(value, `${requirement.key} job`)
  const id = positiveInteger(job.id, `${requirement.key} job id`)
  if (job.name !== requirement.name || job.run_id !== run.id || job.run_attempt !== run.attempt
    || job.head_sha !== commit || job.status !== 'completed' || job.conclusion !== 'success'
    || job.html_url !== `${run.htmlUrl}/job/${String(id)}`) {
    fail('P0-GITHUB-CI-JOB', `${requirement.name} is not one successful job from the exact workflow attempt`)
  }
  return Object.freeze({
    id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: timestamp(job.started_at, `${requirement.key} job started_at`),
    completedAt: timestamp(job.completed_at, `${requirement.key} job completed_at`),
    htmlUrl: job.html_url,
  })
}

function packArtifactName(commit, attempt) {
  return `release-candidate-${commit}-attempt-${String(attempt)}`
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function exactPayloadBytes(value, label, maximum = MAX_ATTESTATION_BYTES) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
    fail('P0-GITHUB-CI-PACK-ARCHIVE', `${label} is not one bounded CI artifact entry`)
  }
  return Buffer.from(value)
}

function releaseAsset(name, bytes) {
  return Object.freeze({ name, sizeBytes: bytes.byteLength, sha256: sha256(bytes) })
}

function validatePackArtifact(inputValue, run, commit) {
  const input = record(inputValue, 'pack artifact evidence')
  const metadata = record(input.metadata, 'pack artifact metadata')
  const artifactId = positiveInteger(metadata.id, 'pack artifact id')
  const expectedName = packArtifactName(commit, run.attempt)
  const workflowRun = record(metadata.workflow_run, 'pack artifact workflow run')
  const archiveBytesSha256 = bounded(input.archiveBytesSha256, 'pack artifact archive SHA-256', 80)
  if (!SHA256.test(archiveBytesSha256)
    || metadata.name !== expectedName || metadata.expired !== false
    || metadata.digest !== archiveBytesSha256
    || metadata.archive_download_url !== `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/artifacts/${String(artifactId)}/zip`
    || metadata.url !== `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/artifacts/${String(artifactId)}`
    || metadata.size_in_bytes !== positiveInteger(input.archiveSizeBytes, 'pack artifact archive size')
    || workflowRun.id !== run.id || workflowRun.head_branch !== GITHUB_BRANCH
    || workflowRun.head_sha !== commit) {
    fail('P0-GITHUB-CI-PACK-ARTIFACT', 'Actions artifact metadata does not bind the exact workflow run and downloaded archive')
  }
  const attestation = record(input.attestation, 'pack attestation')
  const attestationBytes = exactPayloadBytes(input.attestationBytes, 'pack-attestation.json')
  const sumsBytes = exactPayloadBytes(input.sumsBytes, 'SHA256SUMS')
  const { attestationDigest, ...attestationBody } = attestation
  if (attestationDigest !== canonicalSha256(attestationBody)
    || attestation.schemaVersion !== 1 || attestation.attestationId !== 'DSH-CENTER-DETERMINISTIC-PACK'
    || attestation.repository !== GITHUB_REPOSITORY || attestation.workflow !== GITHUB_WORKFLOW_PATH
    || attestation.event !== 'push' || attestation.ref !== 'refs/heads/main'
    || attestation.commit !== commit || attestation.runId !== run.id
    || attestation.runAttempt !== run.attempt || attestation.job !== 'verify') {
    fail('P0-GITHUB-CI-PACK-ATTESTATION', 'pack attestation does not bind the exact main verify job')
  }
  const artifact = record(attestation.artifact, 'attested pack artifact')
  const version = bounded(artifact.version, 'attested pack version', 128)
  const filename = bounded(artifact.filename, 'attested pack filename', 256)
  const packedPnpmTreeSha256 = bounded(
    input.packedPnpmTreeSha256,
    'recomputed packed pnpm tree SHA-256',
    80,
  )
  const tgzBytes = input.tgzBytes
  if (!(tgzBytes instanceof Uint8Array) || artifact.packageName !== 'dsh-plugin-extension-center'
    || !/^0\.1\.0(?:-rc\.(?:0|[1-9][0-9]*))?$/u.test(version)
    || filename !== `dsh-plugin-extension-center-${version}.tgz`
    || artifact.sizeBytes !== tgzBytes.byteLength || artifact.sha256 !== sha256(tgzBytes)
    || !SHA256.test(artifact.manifestSha256) || !SHA256.test(artifact.sourceManifestSha256)
    || !SHA256.test(artifact.pnpmTreeSha256)
    || !SHA256.test(packedPnpmTreeSha256)
    || artifact.pnpmTreeSha256 !== packedPnpmTreeSha256) {
    fail('P0-GITHUB-CI-PACK-ATTESTATION', 'attested pack coordinates do not match the archive tgz bytes')
  }
  const entries = input.entries
  const expectedEntries = ['SHA256SUMS', filename, 'pack-attestation.json'].sort()
  if (!Array.isArray(entries) || entries.length !== expectedEntries.length
    || [...entries].sort().some((entry, index) => entry !== expectedEntries[index])) {
    fail('P0-GITHUB-CI-PACK-ARCHIVE', 'Actions artifact archive does not contain the exact attestation payload')
  }
  if (input.sumsText !== `${artifact.sha256.slice('sha256:'.length)}  ${filename}\n`) {
    fail('P0-GITHUB-CI-PACK-ARCHIVE', 'Actions artifact SHA256SUMS does not bind the attested tgz')
  }
  if (!sumsBytes.equals(Buffer.from(input.sumsText, 'utf8'))
    || !attestationBytes.equals(Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`, 'utf8'))) {
    fail('P0-GITHUB-CI-PACK-ARCHIVE', 'Actions artifact sidecar bytes are not the deterministic release payload')
  }
  const releaseAssets = Object.freeze([
    releaseAsset(filename, Buffer.from(tgzBytes)),
    releaseAsset('SHA256SUMS', sumsBytes),
    releaseAsset('pack-attestation.json', attestationBytes),
  ])
  return Object.freeze({
    actionsArtifactId: artifactId,
    actionsArtifactName: expectedName,
    actionsArchiveSha256: archiveBytesSha256,
    attestationDigest,
    version,
    filename,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    manifestSha256: artifact.manifestSha256,
    sourceManifestSha256: artifact.sourceManifestSha256,
    pnpmTreeSha256: artifact.pnpmTreeSha256,
    sourceCommit: commit,
    releaseAssets,
  })
}

/** Validate one exact successful main CI run and every required current job. */
export function validateExactCommitCiEvidence(inputValue) {
  const input = record(inputValue, 'CI evidence')
  const commit = exactCommit(input.commit)
  const runs = record(input.runs, 'workflow runs response')
  if (!Number.isSafeInteger(runs.total_count) || runs.total_count < 1 || !Array.isArray(runs.workflow_runs)
    || runs.total_count !== runs.workflow_runs.length || runs.workflow_runs.length > 100) {
    fail('P0-GITHUB-CI-RUN', 'workflow runs response is incomplete, empty, or excessive')
  }
  const candidates = runs.workflow_runs.filter(candidate => candidate?.head_sha === commit
    && candidate?.path === GITHUB_WORKFLOW_PATH && candidate?.event === 'push'
    && candidate?.head_branch === GITHUB_BRANCH)
  if (candidates.length !== 1) {
    fail('P0-GITHUB-CI-RUN', 'exact release commit must have one unambiguous main push CI run')
  }
  const run = workflowRun(candidates[0], commit)
  const jobs = record(input.jobs, 'workflow jobs response')
  if (!Number.isSafeInteger(jobs.total_count) || jobs.total_count < REQUIRED_CI_JOBS.length
    || !Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length || jobs.jobs.length > 100) {
    fail('P0-GITHUB-CI-JOB', 'workflow jobs response is incomplete or excessive')
  }
  const requiredJobs = {}
  for (const requirement of REQUIRED_CI_JOBS) {
    const matches = jobs.jobs.filter(candidate => candidate?.name === requirement.name)
    if (matches.length !== 1) {
      fail('P0-GITHUB-CI-JOB', `${requirement.name} must appear exactly once in the exact workflow attempt`)
    }
    requiredJobs[requirement.key] = successfulJob(matches[0], requirement, run, commit)
  }
  const aggregateStarted = Date.parse(requiredJobs.aggregate.startedAt)
  const latestDependencyCompletion = Math.max(...[
    requiredJobs.node22,
    requiredJobs.node24,
    requiredJobs.linuxLifecycle,
    requiredJobs.macosLifecycle,
  ].map(job => Date.parse(job.completedAt)))
  if (aggregateStarted < latestDependencyCompletion) {
    fail('P0-GITHUB-CI-JOB', 'aggregate gate started before all required matrix jobs completed')
  }
  const packAttestation = validatePackArtifact(input.packArtifact, run, commit)
  const observedAt = input.observedAt === undefined
    ? new Date().toISOString()
    : timestamp(input.observedAt, 'observedAt')
  const body = Object.freeze({
    schemaVersion: 1,
    acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
    status: 'passed',
    p0Status: 'exact-commit-ci-proven',
    observedAt,
    target: Object.freeze({
      repository: GITHUB_REPOSITORY,
      branch: GITHUB_BRANCH,
      workflowPath: GITHUB_WORKFLOW_PATH,
      commit,
    }),
    run,
    requiredJobs: Object.freeze(requiredJobs),
    packAttestation,
    notProven: Object.freeze([]),
  })
  return Object.freeze({ ...body, receiptDigest: canonicalSha256(body) })
}

/** Validate a persisted exact-run CI receipt against one release artifact coordinate set. */
export function validateGitHubCiArtifactReceipt(receiptValue, specificationValue) {
  const receipt = record(receiptValue, 'persisted GitHub CI receipt')
  const specification = record(specificationValue, 'release artifact specification')
  const { receiptDigest, ...body } = receipt
  if (receiptDigest !== canonicalSha256(body) || receipt.schemaVersion !== 1
    || receipt.acceptanceId !== 'P0-GITHUB-CI-EXACT-COMMIT' || receipt.status !== 'passed'
    || receipt.p0Status !== 'exact-commit-ci-proven'
    || !Array.isArray(receipt.notProven) || receipt.notProven.length !== 0) {
    fail('P0-GITHUB-CI-RECEIPT-BINDING', 'persisted GitHub CI receipt status or digest is invalid')
  }
  const target = record(receipt.target, 'persisted GitHub CI target')
  const sourceCommit = exactCommit(specification.commit)
  if (target.repository !== GITHUB_REPOSITORY || target.branch !== GITHUB_BRANCH
    || target.workflowPath !== GITHUB_WORKFLOW_PATH || target.commit !== sourceCommit) {
    fail('P0-GITHUB-CI-RECEIPT-BINDING', 'persisted GitHub CI receipt does not bind the release commit')
  }
  const run = record(receipt.run, 'persisted GitHub CI run')
  if (run.event !== 'push' || run.headBranch !== GITHUB_BRANCH || run.headSha !== sourceCommit
    || run.status !== 'completed' || run.conclusion !== 'success') {
    fail('P0-GITHUB-CI-RECEIPT-BINDING', 'persisted GitHub CI run is not the exact successful main push')
  }
  const jobs = record(receipt.requiredJobs, 'persisted GitHub CI jobs')
  for (const requirement of REQUIRED_CI_JOBS) {
    const job = record(jobs[requirement.key], `${requirement.key} persisted GitHub CI job`)
    if (job.name !== requirement.name || job.status !== 'completed' || job.conclusion !== 'success') {
      fail('P0-GITHUB-CI-RECEIPT-BINDING', `persisted GitHub CI job ${requirement.name} is not successful`)
    }
  }
  const pack = record(receipt.packAttestation, 'persisted pack attestation')
  const expectedSha256 = bounded(specification.sha256, 'release artifact SHA-256', 80)
  const expectedManifestSha256 = bounded(specification.manifestSha256, 'release manifest SHA-256', 80)
  if (!SHA256.test(expectedSha256) || !SHA256.test(expectedManifestSha256)
    || pack.version !== specification.version || pack.sha256 !== expectedSha256
    || pack.sizeBytes !== specification.sizeBytes || pack.manifestSha256 !== expectedManifestSha256
    || pack.sourceCommit !== sourceCommit || !SHA256.test(pack.actionsArchiveSha256)
    || !SHA256.test(pack.attestationDigest) || !SHA256.test(pack.sourceManifestSha256)
    || !SHA256.test(pack.pnpmTreeSha256)) {
    fail('P0-GITHUB-CI-RECEIPT-BINDING', 'CI deterministic pack does not match the release artifact coordinates')
  }
  const releaseAssets = pack.releaseAssets
  const expectedNames = [pack.filename, 'SHA256SUMS', 'pack-attestation.json']
  if (!Array.isArray(releaseAssets) || releaseAssets.length !== expectedNames.length) {
    fail('P0-GITHUB-CI-RECEIPT-BINDING', 'CI receipt omits the exact three-file release payload')
  }
  const normalizedReleaseAssets = Object.freeze(releaseAssets.map((value, index) => {
    const asset = record(value, `persisted release asset ${String(index)}`)
    const assetSha256 = bounded(asset.sha256, `persisted release asset ${String(index)} SHA-256`, 80)
    if (asset.name !== expectedNames[index] || !SHA256.test(assetSha256)) {
      fail('P0-GITHUB-CI-RECEIPT-BINDING', 'CI receipt release payload names or digests changed')
    }
    const sizeBytes = positiveInteger(asset.sizeBytes, `persisted release asset ${String(index)} size`)
    return Object.freeze({ name: asset.name, sizeBytes, sha256: assetSha256 })
  }))
  if (normalizedReleaseAssets[0].sha256 !== pack.sha256
    || normalizedReleaseAssets[0].sizeBytes !== pack.sizeBytes) {
    fail('P0-GITHUB-CI-RECEIPT-BINDING', 'CI receipt tgz payload entry differs from the pack attestation')
  }
  return Object.freeze({
    acceptanceId: receipt.acceptanceId,
    receiptDigest,
    runId: positiveInteger(run.id, 'persisted GitHub CI run id'),
    runAttempt: positiveInteger(run.attempt, 'persisted GitHub CI run attempt'),
    artifact: Object.freeze({
      version: pack.version,
      sha256: pack.sha256,
      sizeBytes: pack.sizeBytes,
      manifestSha256: pack.manifestSha256,
      pnpmTreeSha256: pack.pnpmTreeSha256,
      sourceCommit: pack.sourceCommit,
      attestationDigest: pack.attestationDigest,
      actionsArtifactId: positiveInteger(pack.actionsArtifactId, 'persisted Actions artifact id'),
      actionsArchiveSha256: pack.actionsArchiveSha256,
      releaseAssets: normalizedReleaseAssets,
    }),
  })
}

/** Load one exact regular CI receipt and bind its bytes and pack statement to a release artifact. */
export async function loadGitHubCiArtifactReceipt(inputValue, specification) {
  const input = record(inputValue, 'GitHub CI receipt input')
  const path = resolve(bounded(input.path, 'GitHub CI receipt path'))
  const opened = await lstat(path)
  if (!opened.isFile() || opened.isSymbolicLink() || opened.size < 2 || opened.size > MAX_RESPONSE_BYTES) {
    fail('P0-GITHUB-CI-RECEIPT-BINDING', 'GitHub CI receipt input is not one bounded regular file')
  }
  const bytes = await readFile(path)
  const fileSha256 = sha256(bytes)
  if (!SHA256.test(input.sha256) || input.sha256 !== fileSha256 || bytes[bytes.length - 1] !== 0x0a) {
    fail('P0-GITHUB-CI-RECEIPT-BINDING', 'GitHub CI receipt bytes do not match their supplied SHA-256')
  }
  let receipt
  try {
    receipt = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('P0-GITHUB-CI-RECEIPT-BINDING', 'GitHub CI receipt is not JSON')
  }
  return Object.freeze({
    ...validateGitHubCiArtifactReceipt(receipt, specification),
    fileSha256,
    path: await realpath(path),
  })
}

async function boundedJsonResponse(response, label) {
  if (response.status !== 200 || response.redirected) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-GITHUB-CI-HTTP', `${label} returned an unexpected HTTP response`)
  }
  const encoding = response.headers.get('content-encoding')
  if (encoding !== null && encoding !== 'identity') {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-GITHUB-CI-HTTP', `${label} changed response byte identity`)
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-GITHUB-CI-HTTP', `${label} exceeded its response bound`)
  }
  if (response.body === null) fail('P0-GITHUB-CI-HTTP', `${label} returned no body`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_RESPONSE_BYTES) fail('P0-GITHUB-CI-HTTP', `${label} exceeded its response bound`)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } catch {
    fail('P0-GITHUB-CI-FORMAT', `${label} response is not JSON`)
  }
}

async function fetchGitHubJson(url, fetchImpl, token, label) {
  const headers = {
    accept: 'application/vnd.github+json',
    'accept-encoding': 'identity',
    'user-agent': 'dsh-extension-center-ci-acceptance',
    'x-github-api-version': '2022-11-28',
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    fail('P0-GITHUB-CI-HTTP', `${label} request failed: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}`)
  }
  return boundedJsonResponse(response, label)
}

function workflowRunsUrl(commit) {
  const url = new URL(`${API_ROOT}/actions/workflows/ci.yml/runs`)
  url.searchParams.set('branch', GITHUB_BRANCH)
  url.searchParams.set('event', 'push')
  url.searchParams.set('head_sha', commit)
  url.searchParams.set('status', 'completed')
  url.searchParams.set('per_page', '100')
  return url.href
}

function workflowJobsUrl(run) {
  const url = new URL(`${API_ROOT}/actions/runs/${String(run.id)}/attempts/${String(run.attempt)}/jobs`)
  url.searchParams.set('per_page', '100')
  return url.href
}

function workflowArtifactsUrl(run) {
  const url = new URL(`${API_ROOT}/actions/runs/${String(run.id)}/artifacts`)
  url.searchParams.set('per_page', '100')
  return url.href
}

async function boundedBinaryResponse(response, label) {
  if (response.status !== 200 || response.redirected) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-GITHUB-CI-PACK-DOWNLOAD', `${label} returned an unexpected HTTP response`)
  }
  const encoding = response.headers.get('content-encoding')
  if (encoding !== null && encoding !== 'identity') {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-GITHUB-CI-PACK-DOWNLOAD', `${label} changed response byte identity`)
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > MAX_ARTIFACT_ARCHIVE_BYTES)) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-GITHUB-CI-PACK-DOWNLOAD', `${label} exceeded its response bound`)
  }
  if (response.body === null) fail('P0-GITHUB-CI-PACK-DOWNLOAD', `${label} returned no body`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_ARTIFACT_ARCHIVE_BYTES) fail('P0-GITHUB-CI-PACK-DOWNLOAD', `${label} exceeded its response bound`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

function artifactRedirect(location) {
  let url
  try {
    url = new URL(location)
  } catch {
    fail('P0-GITHUB-CI-PACK-DOWNLOAD', 'Actions artifact returned an invalid redirect')
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== ''
    || !(url.hostname.endsWith('.blob.core.windows.net')
      || url.hostname.endsWith('.actions.githubusercontent.com'))) {
    fail('P0-GITHUB-CI-PACK-DOWNLOAD', 'Actions artifact redirected outside admitted GitHub storage')
  }
  return url
}

async function downloadArtifactArchive(metadataValue, fetchImpl, token) {
  const metadata = record(metadataValue, 'pack artifact download metadata')
  const artifactId = positiveInteger(metadata.id, 'pack artifact download id')
  const expectedDownloadUrl = `${API_ROOT}/actions/artifacts/${String(artifactId)}/zip`
  if (metadata.archive_download_url !== expectedDownloadUrl) {
    fail('P0-GITHUB-CI-PACK-DOWNLOAD', 'Actions artifact download URL is outside the fixed GitHub API repository')
  }
  const headers = {
    accept: 'application/vnd.github+json',
    'accept-encoding': 'identity',
    'user-agent': 'dsh-extension-center-ci-acceptance',
    'x-github-api-version': '2022-11-28',
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  let response
  try {
    response = await fetchImpl(expectedDownloadUrl, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    fail('P0-GITHUB-CI-PACK-DOWNLOAD', 'Actions artifact API request failed')
  }
  if ([302, 303, 307].includes(response.status)) {
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    const redirect = artifactRedirect(location)
    try {
      response = await fetchImpl(redirect, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/zip', 'accept-encoding': 'identity' },
        signal: AbortSignal.timeout(60_000),
      })
    } catch {
      fail('P0-GITHUB-CI-PACK-DOWNLOAD', 'Actions artifact storage request failed')
    }
  }
  return boundedBinaryResponse(response, 'Actions artifact archive')
}

export function runBuffered(command, arguments_, maximumBytes, code, timeoutMs = 30_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    fail(code, 'unzip timeout is outside its execution bound')
  }
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref()
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maximumBytes) child.kill('SIGKILL')
      else stdout.push(chunk)
    })
    child.stderr.on('data', chunk => { stderrBytes += chunk.byteLength })
    child.once('error', error => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      rejectRun(error)
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (timedOut) {
        rejectRun(new AcceptanceFailure(code, `unzip timed out (stdoutBytes=${String(stdoutBytes)}, stderrBytes=${String(stderrBytes)})`))
        return
      }
      if (exitCode === 0 && stdoutBytes <= maximumBytes) resolveRun(Buffer.concat(stdout, stdoutBytes))
      else rejectRun(new AcceptanceFailure(code, `unzip failed (${signal ?? String(exitCode)}; stdoutBytes=${String(stdoutBytes)}; stderrBytes=${String(stderrBytes)})`))
    })
  })
}

/**
 * Hash an extracted bundled pnpm tree while bounding logical file and entry sizes.
 * @param {string} root Extracted pnpm package root.
 * @param {string} failureCode Acceptance failure code owned by the calling verifier.
 * @returns {Promise<string>} Bounded no-follow content-tree SHA-256.
 */
export async function boundedPackedPnpmTreeDigest(root, failureCode) {
  const canonicalRoot = await realpath(root)
  const hash = createHash('sha256')
  let entryCount = 0
  let fileBytes = 0
  const visit = async path => {
    entryCount += 1
    if (entryCount > MAX_PACKED_PNPM_ENTRIES) {
      fail(failureCode, 'bundled pnpm tree exceeds its entry bound')
    }
    const name = relative(canonicalRoot, path).split(sep).join('/') || '.'
    const info = await lstat(path)
    if (info.isFile()) {
      fileBytes += info.size
      if (info.size > MAX_PACKED_PNPM_FILE_BYTES || fileBytes > MAX_PACKED_PNPM_TREE_BYTES) {
        fail(failureCode, 'bundled pnpm tree exceeds its logical file-byte bound')
      }
      const bytes = await readFile(path)
      if (bytes.byteLength !== info.size) fail(failureCode, 'bundled pnpm file changed while hashing')
      hash.update(`file:${name}:${String(info.size)}\0`)
      hash.update(bytes)
      return
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(failureCode, `bundled pnpm tree contains an unsupported entry: ${name}`)
    }
    hash.update(`dir:${name}\0`)
    for (const entry of (await readdir(path, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      await visit(join(path, entry.name))
    }
  }
  await visit(canonicalRoot)
  return `sha256:${hash.digest('hex')}`
}

/**
 * Recompute the bundled pnpm content-tree digest from one downloaded release tarball.
 * @param {Uint8Array} tgzBytesValue Exact release tarball bytes.
 * @param {string} failureCode Acceptance failure code owned by the calling verifier.
 * @returns {Promise<string>} Recomputed bundled pnpm tree SHA-256.
 */
export async function inspectPackedPnpmTreeSha256(
  tgzBytesValue,
  failureCode = 'P0-GITHUB-CI-PACK-ARCHIVE',
) {
  const tgzBytes = exactPayloadBytes(tgzBytesValue, 'release tarball', MAX_ARTIFACT_ARCHIVE_BYTES)
  try {
    gunzipSync(tgzBytes, { maxOutputLength: MAX_PACK_TAR_BYTES })
  } catch {
    fail(failureCode, 'release tarball is invalid or exceeds its uncompressed byte bound')
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-ci-packed-pnpm-'))
  try {
    const archivePath = join(root, 'release.tgz')
    const unpackRoot = join(root, 'unpacked')
    await Promise.all([
      writeFile(archivePath, tgzBytes, { flag: 'wx', mode: 0o600 }),
      mkdir(unpackRoot, { mode: 0o700 }),
    ])
    const [entries, verboseEntries] = await Promise.all([
      runBuffered(
        'tar',
        ['-tzf', archivePath],
        MAX_PACK_ENTRY_LIST_BYTES,
        failureCode,
        60_000,
      ),
      runBuffered(
        'tar',
        ['-tvzf', archivePath],
        MAX_PACK_ENTRY_LIST_BYTES,
        failureCode,
        60_000,
      ),
    ])
    const names = entries.toString('utf8').split(/\r?\n/u).filter(Boolean)
    const verbose = verboseEntries.toString('utf8').split(/\r?\n/u).filter(Boolean)
    const pnpmEntries = names.map((name, index) => ({
      name: name.endsWith('/') ? name.slice(0, -1) : name,
      type: verbose[index]?.[0],
    })).filter(({ name }) => name === 'package/node_modules/pnpm'
      || name.startsWith('package/node_modules/pnpm/'))
    if (names.length !== verbose.length || names.length > 20_000
      || pnpmEntries.length === 0 || pnpmEntries.length > MAX_PACKED_PNPM_ENTRIES
      || new Set(pnpmEntries.map(({ name }) => name)).size !== pnpmEntries.length
      || pnpmEntries.some(({ name, type }) => !['-', 'd'].includes(type)
        || name.length > 1_024 || !/^[ -~]+$/u.test(name)
        || name.includes('\\') || name.includes('\0')
        || name.split('/').some(segment => segment === '' || segment === '.' || segment === '..'))) {
      fail(failureCode, 'release tarball has no unique path-safe bundled pnpm tree')
    }
    await runBuffered(
      'tar',
      ['-xzf', archivePath, '-C', unpackRoot, 'package/node_modules/pnpm'],
      MAX_ATTESTATION_BYTES,
      failureCode,
      60_000,
    )
    return await boundedPackedPnpmTreeDigest(
      join(unpackRoot, 'package', 'node_modules', 'pnpm'),
      failureCode,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function loadArtifactArchive(metadata, fetchImpl, token, packedPnpmTreeInspector) {
  const archiveBytes = await downloadArtifactArchive(metadata, fetchImpl, token)
  const root = await mkdtemp(join(tmpdir(), 'dsh-ci-pack-artifact-'))
  try {
    const archivePath = join(root, 'artifact.zip')
    await writeFile(archivePath, archiveBytes, { flag: 'wx', mode: 0o600 })
    const listBytes = await runBuffered('unzip', ['-Z1', archivePath], MAX_ATTESTATION_BYTES, 'P0-GITHUB-CI-PACK-ARCHIVE')
    const entries = listBytes.toString('utf8').split(/\r?\n/u).filter(Boolean)
    const tgzEntries = entries.filter(entry => entry.endsWith('.tgz'))
    if (entries.some(entry => entry.includes('/') || entry.includes('\\') || entry.includes('\0'))
      || tgzEntries.length !== 1) {
      fail('P0-GITHUB-CI-PACK-ARCHIVE', 'Actions artifact archive contains an unsafe or ambiguous entry set')
    }
    const [attestationBytes, sumsBytes, tgzBytes] = await Promise.all([
      runBuffered('unzip', ['-p', archivePath, 'pack-attestation.json'], MAX_ATTESTATION_BYTES, 'P0-GITHUB-CI-PACK-ARCHIVE'),
      runBuffered('unzip', ['-p', archivePath, 'SHA256SUMS'], MAX_ATTESTATION_BYTES, 'P0-GITHUB-CI-PACK-ARCHIVE'),
      runBuffered('unzip', ['-p', archivePath, tgzEntries[0]], MAX_ARTIFACT_ARCHIVE_BYTES, 'P0-GITHUB-CI-PACK-ARCHIVE'),
    ])
    let attestation
    try {
      attestation = JSON.parse(attestationBytes.toString('utf8'))
    } catch {
      fail('P0-GITHUB-CI-PACK-ATTESTATION', 'pack attestation is not JSON')
    }
    return Object.freeze({
      metadata,
      archiveBytesSha256: sha256(archiveBytes),
      archiveSizeBytes: archiveBytes.length,
      entries: Object.freeze(entries),
      attestation,
      attestationBytes,
      sumsText: sumsBytes.toString('utf8'),
      sumsBytes,
      tgzBytes,
      packedPnpmTreeSha256: await packedPnpmTreeInspector(tgzBytes),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function prepareReceiptDestination(path) {
  const requested = resolve(path)
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 })
  const destination = resolve(await realpath(dirname(requested)), basename(requested))
  try {
    await lstat(destination)
    fail('P0-GITHUB-CI-RECEIPT', 'CI receipt output already exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return destination
}

async function writeReceipt(destination, receipt) {
  const temporary = resolve(dirname(destination), `.github-ci-receipt-${randomUUID()}`)
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  try {
    await link(temporary, destination)
  } catch (error) {
    if (error?.code === 'EEXIST') fail('P0-GITHUB-CI-RECEIPT', 'CI receipt output appeared concurrently')
    throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** Fetch and persist exact-commit CI evidence from the fixed public repository. */
export async function runGitHubCiAcceptance(optionsValue) {
  const options = record(optionsValue, 'GitHub CI options')
  const commit = exactCommit(options.commit)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') fail('P0-GITHUB-CI-HTTP', 'HTTPS fetch is unavailable')
  const token = options.token === undefined || options.token === null || options.token === ''
    ? null
    : bounded(options.token, 'GitHub token', 4_096)
  const receiptPath = await prepareReceiptDestination(options.receiptPath ?? DEFAULT_RECEIPT_PATH)
  const runs = await fetchGitHubJson(workflowRunsUrl(commit), fetchImpl, token, 'workflow runs')
  const candidate = Array.isArray(runs?.workflow_runs)
    ? runs.workflow_runs.find(run => run?.head_sha === commit && run?.event === 'push'
      && run?.head_branch === GITHUB_BRANCH && run?.path === GITHUB_WORKFLOW_PATH)
    : null
  if (candidate === null || candidate === undefined) {
    fail('P0-GITHUB-CI-RUN', 'exact release commit has no main push CI run')
  }
  const jobs = await fetchGitHubJson(workflowJobsUrl({
    id: positiveInteger(candidate.id, 'workflow run id'),
    attempt: positiveInteger(candidate.run_attempt, 'workflow run attempt'),
  }), fetchImpl, token, 'workflow jobs')
  const artifacts = await fetchGitHubJson(workflowArtifactsUrl({
    id: positiveInteger(candidate.id, 'workflow run id'),
  }), fetchImpl, token, 'workflow artifacts')
  if (!Number.isSafeInteger(artifacts.total_count) || !Array.isArray(artifacts.artifacts)
    || artifacts.total_count !== artifacts.artifacts.length || artifacts.artifacts.length > 100) {
    fail('P0-GITHUB-CI-PACK-ARTIFACT', 'workflow artifact response is incomplete or excessive')
  }
  const artifactName = packArtifactName(commit, positiveInteger(candidate.run_attempt, 'workflow run attempt'))
  const matches = artifacts.artifacts.filter(artifact => artifact?.name === artifactName)
  if (matches.length !== 1) {
    fail('P0-GITHUB-CI-PACK-ARTIFACT', 'exact workflow attempt must contain one deterministic pack artifact')
  }
  const artifactArchiveLoader = options.artifactArchiveLoader ?? loadArtifactArchive
  const packArtifact = await artifactArchiveLoader(
    matches[0],
    fetchImpl,
    token,
    options.packedPnpmTreeInspector ?? inspectPackedPnpmTreeSha256,
  )
  const receipt = validateExactCommitCiEvidence({
    commit,
    runs,
    jobs,
    packArtifact,
    observedAt: options.observedAt,
  })
  await writeReceipt(receiptPath, receipt)
  return Object.freeze({ receipt, receiptPath })
}

export function parseGitHubCiArguments(arguments_) {
  if (!Array.isArray(arguments_)) fail('P0-GITHUB-CI-INPUT', 'CLI arguments must be an array')
  if (arguments_.length === 1 && arguments_[0] === '--help') return Object.freeze({ help: true })
  if (arguments_.length % 2 !== 0) fail('P0-GITHUB-CI-INPUT', 'CLI flags must be key/value pairs')
  const values = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (!['--commit', '--receipt'].includes(key) || values.has(key) || value === undefined) {
      fail('P0-GITHUB-CI-INPUT', 'CLI accepts only unique --commit and --receipt flags')
    }
    values.set(key, value)
  }
  if (!values.has('--commit')) fail('P0-GITHUB-CI-INPUT', '--commit is required')
  return Object.freeze({
    help: false,
    commit: exactCommit(values.get('--commit')),
    receiptPath: resolve(values.has('--receipt')
      ? bounded(values.get('--receipt'), 'receipt path')
      : DEFAULT_RECEIPT_PATH),
  })
}

async function main() {
  try {
    const parsed = parseGitHubCiArguments(process.argv.slice(2))
    if (parsed.help) {
      process.stdout.write(USAGE)
      return 0
    }
    const result = await runGitHubCiAcceptance({
      commit: parsed.commit,
      receiptPath: parsed.receiptPath,
      token: process.env.GITHUB_TOKEN,
    })
    process.stdout.write(`${result.receipt.p0Status}; receipt=${result.receiptPath}; digest=${result.receipt.receiptDigest}\n`)
    return 0
  } catch (error) {
    const code = error instanceof AcceptanceFailure ? error.code : 'P0-GITHUB-CI-HARNESS'
    process.stderr.write(`${code}: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
