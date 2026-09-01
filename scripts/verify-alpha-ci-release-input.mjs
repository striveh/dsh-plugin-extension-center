#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY = 'striveh/dsh-plugin-extension-center'
const WORKFLOW_PATH = '.github/workflows/ci.yml'
const REQUIRED_JOBS = Object.freeze([
  'Node 22.19.0 source, package, and committed artifacts',
  'Node 24 source, package, and committed artifacts',
  'Alpha package contract checkpoint',
])
const COMMIT = /^[0-9a-f]{40}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const ALPHA_VERSION = /^0\.2\.0-alpha\.(?:0|[1-9][0-9]*)$/u

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`alpha-ci-release: ${label} must be an object`)
  }
  return value
}

function positiveInteger(value, label) {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9][0-9]*$/u.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`alpha-ci-release: ${label} must be a positive integer`)
  }
  return parsed
}

function exactCommit(value) {
  if (typeof value !== 'string' || !COMMIT.test(value)) {
    throw new Error('alpha-ci-release: commit must be one lowercase 40-character SHA')
  }
  return value
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Validate the exact successful main-push CI attempt that produced the release input. */
export function validateAlphaCiRun(runValue, jobsValue, expectedValue) {
  const run = record(runValue, 'workflow run')
  const jobs = record(jobsValue, 'workflow jobs response')
  const expected = record(expectedValue, 'expected CI identity')
  const commit = exactCommit(expected.commit)
  const runId = positiveInteger(expected.runId, 'run id')
  const runAttempt = positiveInteger(expected.runAttempt, 'run attempt')
  if (run.id !== runId || run.run_attempt !== runAttempt || run.name !== 'CI'
    || run.path !== WORKFLOW_PATH || run.event !== 'push' || run.head_branch !== 'main'
    || run.head_sha !== commit || run.status !== 'completed' || run.conclusion !== 'success'
    || run.repository?.full_name !== REPOSITORY || run.head_repository?.full_name !== REPOSITORY) {
    throw new Error('alpha-ci-release: workflow run is not the exact successful protected-main CI attempt')
  }
  if (!Number.isSafeInteger(jobs.total_count) || !Array.isArray(jobs.jobs)
    || jobs.total_count !== jobs.jobs.length || jobs.jobs.length > 100) {
    throw new Error('alpha-ci-release: workflow jobs response is incomplete or excessive')
  }
  for (const name of REQUIRED_JOBS) {
    const matches = jobs.jobs.filter(job => job?.name === name)
    if (matches.length !== 1 || matches[0].run_id !== runId || matches[0].run_attempt !== runAttempt
      || matches[0].head_sha !== commit || matches[0].status !== 'completed'
      || matches[0].conclusion !== 'success') {
      throw new Error(`alpha-ci-release: required CI job did not pass exactly once: ${name}`)
    }
  }
  return Object.freeze({ commit, runId, runAttempt })
}

/** Validate the downloaded Actions payload and return its exact publishable archive name. */
export function validateAlphaPackArtifact(inputValue, expectedValue) {
  const input = record(inputValue, 'pack artifact')
  const expected = record(expectedValue, 'expected pack identity')
  const commit = exactCommit(expected.commit)
  const runId = positiveInteger(expected.runId, 'run id')
  const runAttempt = positiveInteger(expected.runAttempt, 'run attempt')
  if (!(input.manifestBytes instanceof Uint8Array) || !(input.tgzBytes instanceof Uint8Array)
    || typeof input.attestationText !== 'string' || typeof input.sumsText !== 'string') {
    throw new Error('alpha-ci-release: pack artifact inputs are incomplete')
  }
  let manifest
  let attestation
  try {
    manifest = JSON.parse(Buffer.from(input.manifestBytes).toString('utf8'))
    attestation = JSON.parse(input.attestationText)
  } catch (cause) {
    throw new Error('alpha-ci-release: manifest or pack attestation is not JSON', { cause })
  }
  if (manifest.name !== 'dsh-plugin-extension-center' || !ALPHA_VERSION.test(manifest.version ?? '')) {
    throw new Error('alpha-ci-release: source manifest is not one Center alpha release')
  }
  const filename = `dsh-plugin-extension-center-${manifest.version}.tgz`
  const entries = [...(input.entries ?? [])].sort()
  const expectedEntries = ['SHA256SUMS', filename, 'pack-attestation.json'].sort()
  if (entries.length !== expectedEntries.length
    || entries.some((entry, index) => entry !== expectedEntries[index])) {
    throw new Error('alpha-ci-release: artifact directory does not contain the exact three release inputs')
  }
  const { attestationDigest, ...body } = record(attestation, 'pack attestation')
  const artifact = record(attestation.artifact, 'attested artifact')
  const archiveSha256 = sha256(input.tgzBytes)
  if (attestationDigest !== sha256(Buffer.from(canonicalJson(body)))
    || attestation.schemaVersion !== 1 || attestation.attestationId !== 'DSH-CENTER-DETERMINISTIC-PACK'
    || attestation.repository !== REPOSITORY || attestation.workflow !== WORKFLOW_PATH
    || attestation.event !== 'push' || attestation.ref !== 'refs/heads/main'
    || attestation.commit !== commit || attestation.runId !== runId
    || attestation.runAttempt !== runAttempt || attestation.job !== 'verify'
    || artifact.packageName !== manifest.name || artifact.version !== manifest.version
    || artifact.filename !== filename || artifact.sizeBytes !== input.tgzBytes.byteLength
    || artifact.sha256 !== archiveSha256 || artifact.sourceManifestSha256 !== sha256(input.manifestBytes)
    || !SHA256.test(artifact.manifestSha256) || !SHA256.test(artifact.pnpmTreeSha256)) {
    throw new Error('alpha-ci-release: pack attestation does not bind the exact main CI archive')
  }
  if (input.attestationText !== `${JSON.stringify(attestation, null, 2)}\n`
    || input.sumsText !== `${archiveSha256.slice('sha256:'.length)}  ${filename}\n`) {
    throw new Error('alpha-ci-release: release sidecar bytes do not bind the exact archive')
  }
  return Object.freeze({ filename, version: manifest.version, sha256: archiveSha256 })
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--run-json', '--jobs-json', '--artifact-dir', '--commit', '--run-id', '--run-attempt'].includes(key)
      || value === undefined || values[key.slice(2)] !== undefined) {
      throw new Error('alpha-ci-release: expected run, jobs, artifact, commit, run id, and attempt arguments')
    }
    values[key.slice(2)] = value
  }
  if (Object.keys(values).length !== 6) {
    throw new Error('alpha-ci-release: expected each required argument exactly once')
  }
  return values
}

async function boundedFile(path, maximum, label) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
    throw new Error(`alpha-ci-release: ${label} is not one bounded regular file`)
  }
  return await readFile(path)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const expected = {
    commit: options.commit,
    runId: options['run-id'],
    runAttempt: options['run-attempt'],
  }
  const [runBytes, jobsBytes, manifestBytes] = await Promise.all([
    boundedFile(resolve(options['run-json']), 2 * 1024 * 1024, 'workflow run JSON'),
    boundedFile(resolve(options['jobs-json']), 4 * 1024 * 1024, 'workflow jobs JSON'),
    boundedFile(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 1024 * 1024, 'source manifest'),
  ])
  let run
  let jobs
  try {
    run = JSON.parse(runBytes.toString('utf8'))
    jobs = JSON.parse(jobsBytes.toString('utf8'))
  } catch (cause) {
    throw new Error('alpha-ci-release: workflow metadata is not JSON', { cause })
  }
  validateAlphaCiRun(run, jobs, expected)
  const artifactDirectory = resolve(options['artifact-dir'])
  const entries = await readdir(artifactDirectory)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const filename = `dsh-plugin-extension-center-${manifest.version}.tgz`
  const [attestationBytes, sumsBytes, tgzBytes] = await Promise.all([
    boundedFile(join(artifactDirectory, 'pack-attestation.json'), 1024 * 1024, 'pack attestation'),
    boundedFile(join(artifactDirectory, 'SHA256SUMS'), 1024, 'SHA256SUMS'),
    boundedFile(join(artifactDirectory, filename), 64 * 1024 * 1024, 'package archive'),
  ])
  const result = validateAlphaPackArtifact({
    entries,
    manifestBytes,
    attestationText: attestationBytes.toString('utf8'),
    sumsText: sumsBytes.toString('utf8'),
    tgzBytes,
  }, expected)
  process.stdout.write(`alpha-ci-release: ${basename(artifactDirectory)}/${result.filename} ${result.sha256}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
