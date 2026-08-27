import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { AcceptanceFailure } from '../full-p0/support.mjs'
import { canonicalSha256 } from '../full-p0/receipt-binding.mjs'
import { REQUIRED_CI_JOBS } from './verify-github-ci.mjs'
import {
  FAILED_ARTIFACT_ENTRIES,
  FAILED_JOB_NAME,
  FAILED_STEP_NAME,
  PREVIOUS_ARTIFACT_ENTRIES,
  parsePublicationIncidentArguments,
  validatePublicationIncidentEvidence,
  validatePublicationIncidentReceipt,
} from './assert-publication-incident.mjs'

const repository = 'striveh/dsh-plugin-extension-center'
const targetCommit = 'a'.repeat(40)
const previousCommit = 'b'.repeat(40)
const previousVerifierCommit = 'c'.repeat(40)
const incidentVerifierCommit = 'd'.repeat(40)
const failedRunId = 101
const previousRunId = 202
const failedRunAttempt = 1
const previousRunAttempt = 1
const failedRunUrl = `https://github.com/${repository}/actions/runs/${String(failedRunId)}`
const previousRunUrl = `https://github.com/${repository}/actions/runs/${String(previousRunId)}`

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)
}

function acceptanceCode(code) {
  return error => error instanceof AcceptanceFailure && error.code === code
}

function ciReceipt(commit, version, runId) {
  const filename = `dsh-plugin-extension-center-${version}.tgz`
  const tgzSha256 = `sha256:${commit[0].repeat(64)}`
  const releaseAssets = [
    { name: filename, sizeBytes: 42, sha256: tgzSha256 },
    { name: 'SHA256SUMS', sizeBytes: 109, sha256: `sha256:${commit[1].repeat(64)}` },
    { name: 'pack-attestation.json', sizeBytes: 1_010, sha256: `sha256:${commit[2].repeat(64)}` },
  ]
  const requiredJobs = Object.fromEntries(REQUIRED_CI_JOBS.map(requirement => [
    requirement.key,
    {
      id: runId + requiredJobsOffset(requirement.key),
      name: requirement.name,
      status: 'completed',
      conclusion: 'success',
    },
  ]))
  const body = {
    schemaVersion: 1,
    acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
    status: 'passed',
    p0Status: 'exact-commit-ci-proven',
    observedAt: '2026-08-27T00:10:00.000Z',
    target: {
      repository,
      branch: 'main',
      workflowPath: '.github/workflows/ci.yml',
      commit,
    },
    run: {
      id: runId,
      attempt: 1,
      event: 'push',
      headBranch: 'main',
      headSha: commit,
      status: 'completed',
      conclusion: 'success',
    },
    requiredJobs,
    packAttestation: {
      actionsArtifactId: runId + 50,
      actionsArtifactName: `release-candidate-${commit}-attempt-1`,
      actionsArchiveSha256: `sha256:${commit[3].repeat(64)}`,
      attestationDigest: `sha256:${commit[4].repeat(64)}`,
      version,
      filename,
      sizeBytes: 42,
      sha256: tgzSha256,
      manifestSha256: `sha256:${commit[5].repeat(64)}`,
      sourceManifestSha256: `sha256:${commit[6].repeat(64)}`,
      pnpmTreeSha256: `sha256:${commit[7].repeat(64)}`,
      sourceCommit: commit,
      releaseAssets,
    },
    notProven: [],
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function requiredJobsOffset(key) {
  return REQUIRED_CI_JOBS.findIndex(requirement => requirement.key === key) + 1
}

function workflowRun(overrides = {}) {
  return {
    id: failedRunId,
    run_attempt: failedRunAttempt,
    run_number: 7,
    name: 'Post-publication evidence',
    path: '.github/workflows/post-publication-evidence.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: targetCommit,
    status: 'completed',
    conclusion: 'failure',
    html_url: failedRunUrl,
    created_at: '2026-08-27T18:31:21Z',
    updated_at: '2026-08-27T18:33:21Z',
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    ...overrides,
  }
}

function previousWorkflowRun(overrides = {}) {
  return workflowRun({
    id: previousRunId,
    run_attempt: previousRunAttempt,
    run_number: 6,
    head_sha: previousVerifierCommit,
    conclusion: 'success',
    html_url: previousRunUrl,
    created_at: '2026-08-27T17:34:09Z',
    updated_at: '2026-08-27T17:36:15Z',
    ...overrides,
  })
}

function step(number, name, conclusion) {
  return {
    number,
    name,
    status: 'completed',
    conclusion,
    started_at: '2026-08-27T18:32:00Z',
    completed_at: '2026-08-27T18:32:01Z',
  }
}

function failedJobs() {
  const steps = [
    step(10, 'Verify current and previous exact main CI', 'success'),
    step(11, 'Resolve attested release coordinates', 'success'),
    step(12, 'Download previous exact release-ready receipt', 'success'),
    step(13, 'Download exact public Release assets', 'success'),
    step(14, 'Download exact full lifecycle receipt from current CI attempt', 'success'),
    step(15, FAILED_STEP_NAME, 'failure'),
    step(16, 'Resolve immutable pnpm binding', 'skipped'),
    step(17, 'Verify public GitHub Release install, update, and removal', 'skipped'),
    step(18, 'Verify signed public catalog deployment', 'skipped'),
    step(19, 'Re-fetch every signed catalog source and artifact', 'skipped'),
    step(20, 'Compose one cross-bound release-ready receipt', 'skipped'),
    step(21, 'Upload bounded post-publication receipts', 'success'),
  ]
  return {
    total_count: 1,
    jobs: [{
      id: 303,
      name: FAILED_JOB_NAME,
      run_id: failedRunId,
      run_attempt: failedRunAttempt,
      head_sha: targetCommit,
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-08-27T18:31:25Z',
      completed_at: '2026-08-27T18:33:21Z',
      html_url: `${failedRunUrl}/job/303`,
      steps,
    }],
  }
}

function artifactResponse(id, name, runId, headSha, archive) {
  return {
    total_count: 1,
    artifacts: [{
      id,
      name,
      size_in_bytes: archive.archiveSizeBytes,
      digest: archive.archiveSha256,
      expired: false,
      url: `https://api.github.com/repos/${repository}/actions/artifacts/${String(id)}`,
      archive_download_url: `https://api.github.com/repos/${repository}/actions/artifacts/${String(id)}/zip`,
      workflow_run: { id: runId, head_branch: 'main', head_sha: headSha },
    }],
  }
}

function archive(entries, files, marker) {
  return {
    archiveSha256: `sha256:${marker.repeat(64)}`,
    archiveSizeBytes: 10_000 + marker.charCodeAt(0),
    entries: [...entries],
    files: { ...files },
  }
}

function releaseReadyReceipt(previousCurrent, previousVerifier) {
  const body = {
    schemaVersion: 2,
    acceptanceId: 'P0-EXTENSION-CENTER-RELEASE-READY',
    status: 'passed',
    p0Status: 'rc0-bootstrap-release-ready',
    target: {
      repository,
      sourceCommit: previousCommit,
      version: '0.1.0-rc.0',
    },
    verifier: {
      repository,
      workflowPath: '.github/workflows/post-publication-evidence.yml',
      ref: 'refs/heads/main',
      refProtected: true,
      commit: previousVerifierCommit,
      runId: previousRunId,
      runAttempt: previousRunAttempt,
    },
    evidence: {
      githubCi: {
        acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
        sha256: digest(previousCurrent.bytes),
        receiptDigest: previousCurrent.receipt.receiptDigest,
        runId: previousCurrent.receipt.run.id,
      },
      verifierGithubCi: {
        acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
        sha256: digest(previousVerifier.bytes),
        receiptDigest: previousVerifier.receipt.receiptDigest,
        commit: previousVerifierCommit,
        runId: previousVerifier.receipt.run.id,
        runAttempt: previousVerifier.receipt.run.attempt,
      },
    },
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function release(currentReceipt) {
  const version = currentReceipt.packAttestation.version
  const tag = `v${version}`
  return {
    id: 404,
    tag_name: tag,
    target_commitish: targetCommit,
    name: tag,
    draft: false,
    prerelease: true,
    immutable: true,
    created_at: '2026-08-27T18:13:43Z',
    published_at: '2026-08-27T18:28:51Z',
    html_url: `https://github.com/${repository}/releases/tag/${tag}`,
    assets: currentReceipt.packAttestation.releaseAssets.map((expected, index) => {
      const id = 500 + index
      return {
        id,
        name: expected.name,
        size: expected.sizeBytes,
        digest: expected.sha256,
        state: 'uploaded',
        url: `https://api.github.com/repos/${repository}/releases/assets/${String(id)}`,
        browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${expected.name}`,
      }
    }),
  }
}

function tagRef(version = '0.1.0-rc.1') {
  const tag = `v${version}`
  return {
    ref: `refs/tags/${tag}`,
    url: `https://api.github.com/repos/${repository}/git/refs/tags/${tag}`,
    object: {
      type: 'commit',
      sha: targetCommit,
      url: `https://api.github.com/repos/${repository}/git/commits/${targetCommit}`,
    },
  }
}

function evidence() {
  const currentReceipt = ciReceipt(targetCommit, '0.1.0-rc.1', 601)
  const previousReceipt = ciReceipt(previousCommit, '0.1.0-rc.0', 602)
  const failedVerifierReceipt = ciReceipt(targetCommit, '0.1.0-rc.1', 601)
  const currentBytes = receiptBytes(currentReceipt)
  const previousBytes = receiptBytes(previousReceipt)
  const failedVerifierBytes = receiptBytes(failedVerifierReceipt)
  const failedArchive = archive(FAILED_ARTIFACT_ENTRIES, {
    'acceptance/github-ci/current.json': currentBytes,
    'acceptance/github-ci/previous.json': previousBytes,
    'acceptance/github-ci/verifier.json': failedVerifierBytes,
  }, '1')

  const previousVerifierReceipt = ciReceipt(previousVerifierCommit, '0.1.0-rc.0', 603)
  const previousVerifierBytes = receiptBytes(previousVerifierReceipt)
  const releaseReady = releaseReadyReceipt(
    { receipt: previousReceipt, bytes: previousBytes },
    { receipt: previousVerifierReceipt, bytes: previousVerifierBytes },
  )
  const previousArchive = archive(PREVIOUS_ARTIFACT_ENTRIES, {
    'acceptance/github-ci/current.json': previousBytes,
    'acceptance/github-ci/verifier.json': previousVerifierBytes,
    'acceptance/release-ready/receipt.json': receiptBytes(releaseReady),
  }, '2')
  const incidentVerifierReceipt = ciReceipt(incidentVerifierCommit, '0.1.0-rc.2', 604)

  return {
    commit: targetCommit,
    previousCommit,
    failedRunId,
    failedRunAttempt,
    previousEvidenceRunId: previousRunId,
    previousEvidenceRunAttempt: previousRunAttempt,
    verifierCommit: incidentVerifierCommit,
    verifierRunId: 707,
    verifierRunAttempt: 1,
    verifierRefProtected: true,
    incidentVerifierCiReceipt: receiptBytes(incidentVerifierReceipt),
    observedAt: '2026-08-28T00:00:00.000Z',
    failedRun: workflowRun(),
    failedJobs: failedJobs(),
    failedArtifacts: artifactResponse(
      808,
      `post-publication-evidence-${targetCommit}-${String(failedRunAttempt)}`,
      failedRunId,
      targetCommit,
      failedArchive,
    ),
    failedArtifactArchive: failedArchive,
    release: release(currentReceipt),
    tagRef: tagRef(),
    previousEvidenceRun: previousWorkflowRun(),
    previousEvidenceArtifacts: artifactResponse(
      809,
      `post-publication-evidence-${previousCommit}-${String(previousRunAttempt)}`,
      previousRunId,
      previousVerifierCommit,
      previousArchive,
    ),
    previousEvidenceArtifactArchive: previousArchive,
  }
}

test('builds a self-digested terminal not-release-ready incident receipt', () => {
  const receipt = validatePublicationIncidentEvidence(evidence())
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.acceptanceId, 'P0-EXTENSION-CENTER-PUBLICATION-INCIDENT')
  assert.equal(receipt.status, 'failed')
  assert.equal(receipt.p0Status, 'not-release-ready')
  assert.equal(receipt.failure.job.failedStep.name, FAILED_STEP_NAME)
  assert.equal(receipt.failure.releaseReadyReceiptPresent, false)
  assert.equal(receipt.failure.releaseReadyCompositeConclusion, 'skipped')
  assert.equal(receipt.releaseReadyAcceptanceId, null)
  assert.equal(receipt.target.release.immutable, true)
  const normalized = validatePublicationIncidentReceipt(receipt)
  assert.equal(normalized.receiptDigest, receipt.receiptDigest)
  assert.equal(normalized.verifier.githubCi.runId, 604)
})

test('rejects a successful or rerun target workflow instead of recording an incident', () => {
  const successful = evidence()
  successful.failedRun.conclusion = 'success'
  assert.throws(
    () => validatePublicationIncidentEvidence(successful),
    acceptanceCode('P0-PUBLICATION-INCIDENT-RUN'),
  )

  const rerun = evidence()
  rerun.failedRun.run_attempt = 2
  assert.throws(
    () => validatePublicationIncidentEvidence(rerun),
    acceptanceCode('P0-PUBLICATION-INCIDENT-RUN'),
  )
})

test('rejects failure at any step other than exact runtime Release verification', () => {
  const input = evidence()
  const failed = input.failedJobs.jobs[0].steps.find(candidate => candidate.name === FAILED_STEP_NAME)
  failed.name = 'Compose one cross-bound release-ready receipt'
  assert.throws(
    () => validatePublicationIncidentEvidence(input),
    acceptanceCode('P0-PUBLICATION-INCIDENT-JOB'),
  )
})

test('rejects an extra failed-artifact entry that could conceal a release-ready receipt', () => {
  const input = evidence()
  input.failedArtifactArchive.entries.push('acceptance/release-ready/receipt.json')
  assert.throws(
    () => validatePublicationIncidentEvidence(input),
    acceptanceCode('P0-PUBLICATION-INCIDENT-ARTIFACT'),
  )
})

test('rejects tampered CI receipt bytes and self-digests', () => {
  const input = evidence()
  const receipt = JSON.parse(
    input.failedArtifactArchive.files['acceptance/github-ci/current.json'].toString('utf8'),
  )
  receipt.status = 'failed'
  input.failedArtifactArchive.files['acceptance/github-ci/current.json'] = receiptBytes(receipt)
  assert.throws(
    () => validatePublicationIncidentEvidence(input),
    acceptanceCode('P0-PUBLICATION-INCIDENT-RECEIPT'),
  )
})

test('rejects a mutable Release, asset drift, and tag movement', () => {
  const mutable = evidence()
  mutable.release.immutable = false
  assert.throws(
    () => validatePublicationIncidentEvidence(mutable),
    acceptanceCode('P0-PUBLICATION-INCIDENT-RELEASE'),
  )

  const assetDrift = evidence()
  assetDrift.release.assets[0].digest = `sha256:${'f'.repeat(64)}`
  assert.throws(
    () => validatePublicationIncidentEvidence(assetDrift),
    acceptanceCode('P0-PUBLICATION-INCIDENT-RELEASE'),
  )

  const movedTag = evidence()
  movedTag.tagRef.object.sha = previousCommit
  assert.throws(
    () => validatePublicationIncidentEvidence(movedTag),
    acceptanceCode('P0-PUBLICATION-INCIDENT-RELEASE'),
  )
})

test('rejects previous-success evidence that does not bind the retained CI bytes', () => {
  const input = evidence()
  const path = 'acceptance/release-ready/receipt.json'
  const previousReady = JSON.parse(input.previousEvidenceArtifactArchive.files[path].toString('utf8'))
  previousReady.evidence.githubCi.sha256 = `sha256:${'e'.repeat(64)}`
  const { receiptDigest: _removed, ...body } = previousReady
  input.previousEvidenceArtifactArchive.files[path] = receiptBytes({
    ...body,
    receiptDigest: canonicalSha256(body),
  })
  assert.throws(
    () => validatePublicationIncidentEvidence(input),
    acceptanceCode('P0-PUBLICATION-INCIDENT-PREVIOUS'),
  )
})

test('incident receipt validator rejects status and digest tampering', () => {
  const receipt = validatePublicationIncidentEvidence(evidence())
  assert.throws(
    () => validatePublicationIncidentReceipt({ ...receipt, status: 'passed' }),
    acceptanceCode('P0-PUBLICATION-INCIDENT-RECEIPT'),
  )
  assert.throws(
    () => validatePublicationIncidentReceipt({ ...receipt, receiptDigest: `sha256:${'0'.repeat(64)}` }),
    acceptanceCode('P0-PUBLICATION-INCIDENT-RECEIPT'),
  )
  const forged = structuredClone(receipt)
  forged.verifier.githubCi.runId = 0
  const { receiptDigest: _removed, ...body } = forged
  forged.receiptDigest = canonicalSha256(body)
  assert.throws(
    () => validatePublicationIncidentReceipt(forged),
    acceptanceCode('P0-PUBLICATION-INCIDENT-RECEIPT'),
  )
})

test('CLI requires every exact run attempt and a protected verifier ref', () => {
  const parsed = parsePublicationIncidentArguments([
    '--commit', targetCommit,
    '--failed-run-id', String(failedRunId),
    '--failed-run-attempt', String(failedRunAttempt),
    '--previous-commit', previousCommit,
    '--previous-evidence-run-id', String(previousRunId),
    '--previous-evidence-run-attempt', String(previousRunAttempt),
    '--verifier-commit', incidentVerifierCommit,
    '--verifier-run-id', '707',
    '--verifier-run-attempt', '1',
    '--verifier-ref-protected', 'true',
    '--verifier-ci-receipt', '/tmp/verifier-ci.json',
    '--verifier-ci-receipt-sha256', `sha256:${'f'.repeat(64)}`,
    '--receipt', '/tmp/publication-incident.json',
  ])
  assert.equal(parsed.failedRunAttempt, 1)
  assert.equal(parsed.previousEvidenceRunId, previousRunId)
  assert.equal(parsed.verifierRefProtected, true)

  assert.throws(
    () => parsePublicationIncidentArguments([
      '--commit', targetCommit,
      '--failed-run-id', String(failedRunId),
      '--failed-run-attempt', '2',
      '--previous-commit', previousCommit,
      '--previous-evidence-run-id', String(previousRunId),
      '--previous-evidence-run-attempt', String(previousRunAttempt),
      '--verifier-commit', incidentVerifierCommit,
      '--verifier-run-id', '707',
      '--verifier-run-attempt', '1',
      '--verifier-ref-protected', 'false',
      '--verifier-ci-receipt', '/tmp/verifier-ci.json',
      '--verifier-ci-receipt-sha256', `sha256:${'f'.repeat(64)}`,
    ]),
    acceptanceCode('P0-PUBLICATION-INCIDENT-INPUT'),
  )
})
