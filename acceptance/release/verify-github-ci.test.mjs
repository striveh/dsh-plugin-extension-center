import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AcceptanceFailure } from '../full-p0/support.mjs'
import { canonicalSha256 } from '../full-p0/receipt-binding.mjs'
import {
  REQUIRED_CI_JOBS,
  parseGitHubCiArguments,
  runBuffered,
  runGitHubCiAcceptance,
  validateExactCommitCiEvidence,
} from './verify-github-ci.mjs'

const COMMIT = 'a'.repeat(40)
const RUN_ID = 12_345
const ATTEMPT = 2
const RUN_URL = `https://github.com/striveh/dsh-plugin-extension-center/actions/runs/${String(RUN_ID)}`
const CREATED = '2026-08-27T00:00:00Z'

function runFixture(overrides = {}) {
  return {
    id: RUN_ID,
    run_attempt: ATTEMPT,
    run_number: 44,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    head_sha: COMMIT,
    status: 'completed',
    conclusion: 'success',
    html_url: RUN_URL,
    created_at: CREATED,
    updated_at: '2026-08-27T00:05:00.000Z',
    repository: { full_name: 'striveh/dsh-plugin-extension-center' },
    head_repository: { full_name: 'striveh/dsh-plugin-extension-center' },
    ...overrides,
  }
}

function jobFixture(requirement, index, overrides = {}) {
  const aggregate = requirement.key === 'aggregate'
  return {
    id: 100 + index,
    run_id: RUN_ID,
    run_attempt: ATTEMPT,
    head_sha: COMMIT,
    name: requirement.name,
    status: 'completed',
    conclusion: 'success',
    started_at: aggregate ? '2026-08-27T00:03:00.000Z' : '2026-08-27T00:01:00.000Z',
    completed_at: aggregate ? '2026-08-27T00:04:00.000Z' : '2026-08-27T00:02:00.000Z',
    html_url: `${RUN_URL}/job/${String(100 + index)}`,
    ...overrides,
  }
}

function evidence(overrides = {}) {
  const jobs = REQUIRED_CI_JOBS.map(jobFixture)
  return {
    commit: COMMIT,
    observedAt: '2026-08-27T00:06:00.000Z',
    runs: { total_count: 1, workflow_runs: [runFixture()] },
    jobs: { total_count: jobs.length, jobs },
    packArtifact: packArtifactFixture(),
    ...overrides,
  }
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function crc32(bytes) {
  let value = 0xffff_ffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = value >>> 1 ^ (value & 1 ? 0xedb8_8320 : 0)
  }
  return (value ^ 0xffff_ffff) >>> 0
}

function zipArchive(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const bytes = Buffer.from(entry.bytes)
    const checksum = crc32(bytes)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x0403_4b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(bytes.length, 18)
    localHeader.writeUInt32LE(bytes.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    local.push(localHeader, name, bytes)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x0201_4b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(bytes.length, 20)
    centralHeader.writeUInt32LE(bytes.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)
    offset += localHeader.length + name.length + bytes.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x0605_4b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

function exactPackZip(pack, extraEntries = []) {
  return zipArchive([
    { name: 'SHA256SUMS', bytes: pack.sumsText },
    { name: pack.attestation.artifact.filename, bytes: pack.tgzBytes },
    { name: 'pack-attestation.json', bytes: `${JSON.stringify(pack.attestation, null, 2)}\n` },
    ...extraEntries,
  ])
}

function packArtifactFixture() {
  const tgzBytes = Buffer.from('exact deterministic pack bytes')
  const archiveBytes = Buffer.from('exact Actions artifact zip bytes')
  const artifact = {
    packageName: 'dsh-plugin-extension-center',
    version: '0.1.0-rc.0',
    filename: 'dsh-plugin-extension-center-0.1.0-rc.0.tgz',
    sizeBytes: tgzBytes.length,
    sha256: sha256(tgzBytes),
    manifestSha256: `sha256:${'b'.repeat(64)}`,
    sourceManifestSha256: `sha256:${'c'.repeat(64)}`,
    pnpmTreeSha256: `sha256:${'d'.repeat(64)}`,
  }
  const body = {
    schemaVersion: 1,
    attestationId: 'DSH-CENTER-DETERMINISTIC-PACK',
    repository: 'striveh/dsh-plugin-extension-center',
    workflow: '.github/workflows/ci.yml',
    event: 'push',
    ref: 'refs/heads/main',
    commit: COMMIT,
    runId: RUN_ID,
    runAttempt: ATTEMPT,
    job: 'verify',
    artifact,
  }
  const id = 777
  const attestation = { ...body, attestationDigest: canonicalSha256(body) }
  const sumsText = `${artifact.sha256.slice('sha256:'.length)}  ${artifact.filename}\n`
  return {
    metadata: {
      id,
      name: `release-candidate-${COMMIT}-attempt-${String(ATTEMPT)}`,
      expired: false,
      size_in_bytes: archiveBytes.length,
      digest: sha256(archiveBytes),
      url: `https://api.github.com/repos/striveh/dsh-plugin-extension-center/actions/artifacts/${String(id)}`,
      archive_download_url: `https://api.github.com/repos/striveh/dsh-plugin-extension-center/actions/artifacts/${String(id)}/zip`,
      workflow_run: { id: RUN_ID, head_branch: 'main', head_sha: COMMIT },
    },
    archiveBytesSha256: sha256(archiveBytes),
    archiveSizeBytes: archiveBytes.length,
    entries: ['SHA256SUMS', artifact.filename, 'pack-attestation.json'],
    attestation,
    attestationBytes: Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`),
    sumsText,
    sumsBytes: Buffer.from(sumsText),
    tgzBytes,
  }
}

function acceptanceCode(code) {
  return error => error instanceof AcceptanceFailure && error.code === code
}

function jsonResponse(value, status = 200) {
  const body = JSON.stringify(value)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
    },
  })
}

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), 'github-ci-acceptance-test-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('binds the exact successful main push and every current required job', () => {
  const receipt = validateExactCommitCiEvidence(evidence())
  assert.equal(receipt.acceptanceId, 'P0-GITHUB-CI-EXACT-COMMIT')
  assert.equal(receipt.target.commit, COMMIT)
  assert.equal(receipt.run.attempt, ATTEMPT)
  assert.equal(receipt.packAttestation.sha256, evidence().packArtifact.attestation.artifact.sha256)
  assert.equal(receipt.packAttestation.actionsArtifactId, 777)
  assert.deepEqual(receipt.packAttestation.releaseAssets.map(asset => asset.name), [
    'dsh-plugin-extension-center-0.1.0-rc.0.tgz',
    'SHA256SUMS',
    'pack-attestation.json',
  ])
  assert.deepEqual(receipt.packAttestation.releaseAssets.map(asset => asset.sha256), [
    evidence().packArtifact.attestation.artifact.sha256,
    sha256(evidence().packArtifact.sumsBytes),
    sha256(evidence().packArtifact.attestationBytes),
  ])
  assert.deepEqual(Object.keys(receipt.requiredJobs), [
    'node22',
    'node24',
    'linuxLifecycle',
    'macosLifecycle',
    'aggregate',
  ])
  const { receiptDigest, ...body } = receipt
  assert.equal(receiptDigest, canonicalSha256(body))
})

test('rejects a parsed-equivalent attestation whose original CI bytes are not deterministic', () => {
  const input = evidence()
  input.packArtifact.attestationBytes = Buffer.from(`${JSON.stringify(input.packArtifact.attestation)}\n`)
  assert.throws(
    () => validateExactCommitCiEvidence(input),
    acceptanceCode('P0-GITHUB-CI-PACK-ARCHIVE'),
  )
})

test('rejects a PR, non-main, failed, or different-commit workflow run', () => {
  for (const [field, value] of [
    ['event', 'pull_request'],
    ['head_branch', 'feature'],
    ['conclusion', 'failure'],
    ['head_sha', 'b'.repeat(40)],
    ['path', '.github/workflows/legacy.yml'],
  ]) {
    const input = evidence()
    input.runs.workflow_runs[0][field] = value
    assert.throws(() => validateExactCommitCiEvidence(input), acceptanceCode('P0-GITHUB-CI-RUN'))
  }
})

test('rejects missing, duplicate, stale-name, failed, or cross-attempt required jobs', () => {
  const cases = [
    jobs => jobs.filter(job => !job.name.startsWith('Node 24 ')),
    jobs => [...jobs, { ...jobs[0], id: 999, html_url: `${RUN_URL}/job/999` }],
    jobs => jobs.map(job => job.name === 'Official rc.2 plugin-only release gate'
      ? { ...job, name: 'Published rc.2 Store and Host-owner lanes' }
      : job),
    jobs => jobs.map(job => job.name.startsWith('Official rc.2 Store and plugin-only lifecycle (macos')
      ? { ...job, conclusion: 'failure' }
      : job),
    jobs => jobs.map(job => job.name.startsWith('Node 22.19.0')
      ? { ...job, run_attempt: ATTEMPT - 1 }
      : job),
  ]
  for (const mutate of cases) {
    const input = evidence()
    input.jobs.jobs = mutate(input.jobs.jobs)
    input.jobs.total_count = input.jobs.jobs.length
    assert.throws(() => validateExactCommitCiEvidence(input), acceptanceCode('P0-GITHUB-CI-JOB'))
  }
})

test('rejects an aggregate that did not wait for every matrix dependency', () => {
  const input = evidence()
  const aggregate = input.jobs.jobs.find(job => job.name === 'Official rc.2 plugin-only release gate')
  aggregate.started_at = '2026-08-27T00:01:30.000Z'
  assert.throws(() => validateExactCommitCiEvidence(input), acceptanceCode('P0-GITHUB-CI-JOB'))
})

test('rejects a tampered tgz, attestation, Actions digest, or cross-run artifact', () => {
  const cases = [
    input => { input.packArtifact.tgzBytes = Buffer.from('tampered') },
    input => { input.packArtifact.attestation.artifact.manifestSha256 = `sha256:${'0'.repeat(64)}` },
    input => { input.packArtifact.metadata.digest = `sha256:${'0'.repeat(64)}` },
    input => { input.packArtifact.metadata.workflow_run.head_sha = '0'.repeat(40) },
  ]
  for (const mutate of cases) {
    const input = evidence()
    mutate(input)
    assert.throws(
      () => validateExactCommitCiEvidence(input),
      error => error instanceof AcceptanceFailure && error.code.startsWith('P0-GITHUB-CI-PACK-'),
    )
  }
})

test('fetches only the exact workflow and attempt endpoints and writes an immutable receipt', async () => {
  await withTemporaryDirectory(async root => {
    const input = evidence()
    const responses = [
      jsonResponse(input.runs),
      jsonResponse(input.jobs),
      jsonResponse({ total_count: 1, artifacts: [input.packArtifact.metadata] }),
    ]
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init })
      return responses.shift()
    }
    const receiptPath = join(root, 'receipt.json')
    const result = await runGitHubCiAcceptance({
      commit: COMMIT,
      observedAt: input.observedAt,
      receiptPath,
      fetchImpl,
      token: 'test-token',
      artifactArchiveLoader: async metadata => ({ ...input.packArtifact, metadata }),
    })
    assert.equal(result.receipt.target.commit, COMMIT)
    assert.equal((await stat(receiptPath)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), result.receipt)
    assert.equal(calls.length, 3)
    assert.equal(calls[0].url, `https://api.github.com/repos/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${COMMIT}&status=completed&per_page=100`)
    assert.equal(calls[1].url, `https://api.github.com/repos/striveh/dsh-plugin-extension-center/actions/runs/${String(RUN_ID)}/attempts/${String(ATTEMPT)}/jobs?per_page=100`)
    assert.equal(calls[2].url, `https://api.github.com/repos/striveh/dsh-plugin-extension-center/actions/runs/${String(RUN_ID)}/artifacts?per_page=100`)
    assert.equal(calls[0].init.redirect, 'manual')
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-token')
  })
})

test('rejects an artifact download URL before forwarding the GitHub token', async () => {
  await withTemporaryDirectory(async root => {
    const input = evidence()
    input.packArtifact.metadata.archive_download_url = 'https://attacker.example.test/artifact.zip'
    const responses = [
      jsonResponse(input.runs),
      jsonResponse(input.jobs),
      jsonResponse({ total_count: 1, artifacts: [input.packArtifact.metadata] }),
    ]
    const calls = []
    await assert.rejects(
      runGitHubCiAcceptance({
        commit: COMMIT,
        receiptPath: join(root, 'receipt.json'),
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init })
          const response = responses.shift()
          if (response === undefined) throw new Error('token-bearing fetch escaped the GitHub API')
          return response
        },
        token: 'test-token',
      }),
      acceptanceCode('P0-GITHUB-CI-PACK-DOWNLOAD'),
    )
    assert.equal(calls.length, 3)
    assert(calls.every(call => new URL(call.url).hostname === 'api.github.com'))
  })
})

test('downloads one real GitHub-style 302 ZIP without forwarding the API token to storage', async () => {
  await withTemporaryDirectory(async root => {
    const input = evidence()
    const archive = exactPackZip(input.packArtifact)
    input.packArtifact.metadata.size_in_bytes = archive.length
    input.packArtifact.metadata.digest = sha256(archive)
    const responses = [
      jsonResponse(input.runs),
      jsonResponse(input.jobs),
      jsonResponse({ total_count: 1, artifacts: [input.packArtifact.metadata] }),
    ]
    const storageUrl = 'https://unit.blob.core.windows.net/github-actions/exact.zip'
    const calls = []
    const result = await runGitHubCiAcceptance({
      commit: COMMIT,
      observedAt: input.observedAt,
      receiptPath: join(root, 'receipt.json'),
      token: 'test-token',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init })
        if (responses.length > 0) return responses.shift()
        if (String(url).startsWith('https://api.github.com/')) {
          return new Response(null, { status: 302, headers: { location: storageUrl } })
        }
        assert.equal(String(url), storageUrl)
        return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } })
      },
    })
    assert.equal(result.receipt.packAttestation.actionsArchiveSha256, sha256(archive))
    assert.equal(calls.length, 5)
    assert.equal(calls[3].init.headers.authorization, 'Bearer test-token')
    assert.equal(calls[4].init.headers.authorization, undefined)
    assert.equal(calls[4].init.redirect, 'manual')
  })
})

test('fails closed on unsafe redirects, invalid ZIPs, ambiguous entries, and response bounds', async () => {
  await withTemporaryDirectory(async root => {
    const cases = [
      {
        name: 'external redirect',
        archive: exactPackZip(packArtifactFixture()),
        apiResponse: () => new Response(null, { status: 302, headers: { location: 'https://attacker.example.test/a.zip' } }),
        code: 'P0-GITHUB-CI-PACK-DOWNLOAD',
      },
      {
        name: 'second redirect',
        archive: exactPackZip(packArtifactFixture()),
        storageResponse: () => new Response(null, { status: 302, headers: { location: 'https://other.blob.core.windows.net/a.zip' } }),
        code: 'P0-GITHUB-CI-PACK-DOWNLOAD',
      },
      {
        name: 'invalid zip',
        archive: Buffer.from('not a ZIP archive'),
        code: 'P0-GITHUB-CI-PACK-ARCHIVE',
      },
      {
        name: 'extra entry',
        archive: exactPackZip(packArtifactFixture(), [{ name: 'extra.txt', bytes: 'extra' }]),
        code: 'P0-GITHUB-CI-PACK-ARCHIVE',
      },
      {
        name: 'traversal entry',
        archive: exactPackZip(packArtifactFixture(), [{ name: '../escape', bytes: 'escape' }]),
        code: 'P0-GITHUB-CI-PACK-ARCHIVE',
      },
      {
        name: 'duplicate entry',
        archive: exactPackZip(packArtifactFixture(), [{ name: 'SHA256SUMS', bytes: 'duplicate' }]),
        code: 'P0-GITHUB-CI-PACK-ARCHIVE',
      },
      {
        name: 'declared length over bound',
        archive: exactPackZip(packArtifactFixture()),
        storageResponse: archive => new Response(archive, {
          status: 200,
          headers: { 'content-length': String(256 * 1024 * 1024 + 1) },
        }),
        code: 'P0-GITHUB-CI-PACK-DOWNLOAD',
      },
    ]
    for (const [index, item] of cases.entries()) {
      const input = evidence()
      input.packArtifact.metadata.size_in_bytes = item.archive.length
      input.packArtifact.metadata.digest = sha256(item.archive)
      const responses = [
        jsonResponse(input.runs),
        jsonResponse(input.jobs),
        jsonResponse({ total_count: 1, artifacts: [input.packArtifact.metadata] }),
      ]
      const storageUrl = 'https://unit.blob.core.windows.net/github-actions/exact.zip'
      await assert.rejects(
        runGitHubCiAcceptance({
          commit: COMMIT,
          receiptPath: join(root, `receipt-${String(index)}.json`),
          token: 'test-token',
          fetchImpl: async (url) => {
            if (responses.length > 0) return responses.shift()
            if (String(url).startsWith('https://api.github.com/')) {
              return item.apiResponse?.() ?? new Response(null, { status: 302, headers: { location: storageUrl } })
            }
            return item.storageResponse?.(item.archive) ?? new Response(item.archive, {
              status: 200,
              headers: { 'content-length': String(item.archive.length) },
            })
          },
        }),
        error => error instanceof AcceptanceFailure && error.code === item.code,
        item.name,
      )
    }
  })
})

test('bounds unzip output and terminates a stuck subprocess', async () => {
  await assert.rejects(
    runBuffered(process.execPath, ['-e', 'process.stdout.write("x".repeat(2048))'], 1024, 'P0-GITHUB-CI-PACK-ARCHIVE', 2_000),
    acceptanceCode('P0-GITHUB-CI-PACK-ARCHIVE'),
  )
  await assert.rejects(
    runBuffered(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 1024, 'P0-GITHUB-CI-PACK-ARCHIVE', 50),
    error => error instanceof AcceptanceFailure
      && error.code === 'P0-GITHUB-CI-PACK-ARCHIVE'
      && error.message.includes('timed out'),
  )
})

test('does not fetch or overwrite an existing or symlinked receipt destination', async () => {
  await withTemporaryDirectory(async root => {
    const target = join(root, 'existing.json')
    const symlinkPath = join(root, 'symlink.json')
    await writeFile(target, 'keep\n')
    await symlink(target, symlinkPath)
    for (const receiptPath of [target, symlinkPath]) {
      let calls = 0
      await assert.rejects(
        runGitHubCiAcceptance({
          commit: COMMIT,
          receiptPath,
          fetchImpl: async () => { calls += 1; throw new Error('must not fetch') },
        }),
        acceptanceCode('P0-GITHUB-CI-RECEIPT'),
      )
      assert.equal(calls, 0)
    }
    assert.equal(await readFile(target, 'utf8'), 'keep\n')
  })
})

test('parses only one exact commit and optional receipt destination', () => {
  assert.deepEqual(parseGitHubCiArguments(['--commit', COMMIT, '--receipt', '/tmp/ci.json']), {
    help: false,
    commit: COMMIT,
    receiptPath: '/tmp/ci.json',
  })
  assert.throws(() => parseGitHubCiArguments(['--commit', COMMIT.toUpperCase()]), acceptanceCode('P0-GITHUB-CI-INPUT'))
  assert.throws(() => parseGitHubCiArguments(['--commit', COMMIT, '--repository', 'fork/repo']), acceptanceCode('P0-GITHUB-CI-INPUT'))
})
