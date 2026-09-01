import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'
import {
  validateAlphaCiRun,
  validateAlphaPackArtifact,
} from './verify-alpha-ci-release-input.mjs'

const commit = 'a'.repeat(40)
const expected = { commit, runId: 42, runAttempt: 2 }
const requiredJobs = [
  'Node 22.19.0 source, package, and committed artifacts',
  'Node 24 source, package, and committed artifacts',
  'Alpha package contract checkpoint',
]

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

function run() {
  return {
    id: 42,
    run_attempt: 2,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    head_sha: commit,
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: 'striveh/dsh-plugin-extension-center' },
    head_repository: { full_name: 'striveh/dsh-plugin-extension-center' },
  }
}

function jobs() {
  return {
    total_count: requiredJobs.length,
    jobs: requiredJobs.map(name => ({
      name,
      run_id: 42,
      run_attempt: 2,
      head_sha: commit,
      status: 'completed',
      conclusion: 'success',
    })),
  }
}

function artifact() {
  const manifestBytes = Buffer.from(`${JSON.stringify({
    name: 'dsh-plugin-extension-center',
    version: '0.2.0-alpha.1',
  }, null, 2)}\n`)
  const tgzBytes = Buffer.from('exact alpha archive')
  const filename = 'dsh-plugin-extension-center-0.2.0-alpha.1.tgz'
  const body = {
    schemaVersion: 1,
    attestationId: 'DSH-CENTER-DETERMINISTIC-PACK',
    repository: 'striveh/dsh-plugin-extension-center',
    workflow: '.github/workflows/ci.yml',
    event: 'push',
    ref: 'refs/heads/main',
    commit,
    runId: 42,
    runAttempt: 2,
    job: 'verify',
    artifact: {
      packageName: 'dsh-plugin-extension-center',
      version: '0.2.0-alpha.1',
      filename,
      sizeBytes: tgzBytes.byteLength,
      sha256: sha256(tgzBytes),
      manifestSha256: `sha256:${'1'.repeat(64)}`,
      sourceManifestSha256: sha256(manifestBytes),
      pnpmTreeSha256: `sha256:${'2'.repeat(64)}`,
    },
  }
  const attestation = { ...body, attestationDigest: sha256(Buffer.from(canonicalJson(body))) }
  return {
    entries: ['pack-attestation.json', filename, 'SHA256SUMS'],
    manifestBytes,
    tgzBytes,
    attestationText: `${JSON.stringify(attestation, null, 2)}\n`,
    sumsText: `${sha256(tgzBytes).slice('sha256:'.length)}  ${filename}\n`,
  }
}

test('accepts one exact successful main CI attempt and its three-file alpha artifact', () => {
  assert.deepEqual(validateAlphaCiRun(run(), jobs(), expected), expected)
  assert.deepEqual(validateAlphaPackArtifact(artifact(), expected), {
    filename: 'dsh-plugin-extension-center-0.2.0-alpha.1.tgz',
    version: '0.2.0-alpha.1',
    sha256: sha256(Buffer.from('exact alpha archive')),
  })
})

test('rejects a failed or substituted CI attempt', () => {
  assert.throws(() => validateAlphaCiRun({ ...run(), conclusion: 'failure' }, jobs(), expected), /successful/u)
  const substituted = jobs()
  substituted.jobs[0].head_sha = 'b'.repeat(40)
  assert.throws(() => validateAlphaCiRun(run(), substituted, expected), /did not pass/u)
})

test('rejects archive, source manifest, sidecar, and prerelease-prefix drift', () => {
  const changedArchive = artifact()
  changedArchive.tgzBytes = Buffer.from('different archive')
  assert.throws(() => validateAlphaPackArtifact(changedArchive, expected), /does not bind/u)

  const changedManifest = artifact()
  changedManifest.manifestBytes = Buffer.from('{"name":"dsh-plugin-extension-center","version":"0.2.0-alpha.10"}\n')
  assert.throws(() => validateAlphaPackArtifact(changedManifest, expected), /(?:does not bind|exact three)/u)

  const changedSidecar = artifact()
  changedSidecar.sumsText = changedSidecar.sumsText.toUpperCase()
  assert.throws(() => validateAlphaPackArtifact(changedSidecar, expected), /sidecar/u)
})

test('keeps OIDC authority in the sole minimal publish job and remains RED without alpha.0 receipt', async () => {
  const workflowText = await readFile('.github/workflows/npm-publish.yml', 'utf8')
  const workflow = parseYaml(workflowText)
  assert.deepEqual(workflow.permissions, { actions: 'read', contents: 'read' })
  assert.deepEqual(Object.keys(workflow.jobs), ['prepare', 'publish', 'postverify'])
  assert.equal(workflow.jobs.prepare.permissions, undefined)
  assert.deepEqual(workflow.jobs.publish.permissions, {
    actions: 'read',
    contents: 'read',
    'id-token': 'write',
  })
  assert.deepEqual(workflow.jobs.postverify.permissions, { actions: 'read', contents: 'read' })
  assert.equal(workflow.jobs.publish.environment, 'npm-alpha-publication')
  assert.equal(workflow.jobs.publish['timeout-minutes'], 5)

  const publishText = workflow.jobs.publish.steps.map(step => `${step.name}\n${step.run ?? ''}`).join('\n')
  assert.match(publishText, /npm publish/u)
  assert.match(publishText, /--ignore-scripts/u)
  assert.match(publishText, /sole archive without repository code/u)
  assert.doesNotMatch(publishText, /pnpm install|playwright|acceptance\/|node scripts\//iu)
  assert.equal(workflow.jobs.publish.steps.some(step => step.uses?.startsWith('actions/checkout@')), false)

  const prepareSteps = workflow.jobs.prepare.steps
  const inputGate = prepareSteps.find(step => step.name === 'Validate exact CI coordinates before network use')
  assert.match(inputGate.run, /ci_run_id must be a positive integer/u)
  assert.match(inputGate.run, /ci_run_attempt must be a positive integer/u)
  assert.ok(prepareSteps.indexOf(inputGate)
    < prepareSteps.findIndex(step => step.name === 'Fetch exact CI attempt metadata'))
  assert.ok(prepareSteps.indexOf(inputGate)
    < prepareSteps.findIndex(step => step.name === 'Download exact main CI release candidate'))
  const bootstrapGate = prepareSteps.find(step => step.name === 'Require exact controlled alpha.0 first-publication receipt')
  assert.match(bootstrapGate.run, /RED \[ALPHA-NPM-BOOTSTRAP-RECEIPT-MISSING\]/u)
  assert.match(bootstrapGate.run, /reviewed CI archive digest, trusted-publishing provenance, or controlled first-publication receipt/u)
  assert.ok(prepareSteps.indexOf(bootstrapGate)
    < prepareSteps.findIndex(step => step.name === 'Upload the sole verified publish input'))
  const bridgeUpload = prepareSteps.find(step => step.name === 'Upload the sole verified publish input')
  assert.equal(bridgeUpload.with.path, '.artifacts/npm-publish/bridge/${{ steps.candidate.outputs.archive_filename }}')

  const postverifyText = workflow.jobs.postverify.steps.map(step => `${step.name}\n${step.run ?? ''}`).join('\n')
  assert.match(postverifyText, /receipt\.laneStatus !== "proven"/u)
  assert.match(postverifyText, /receipt\.p0Status !== "red"/u)
  assert.match(postverifyText, /productCoverage\?\.skillLifecycle !== "proven"/u)
})
