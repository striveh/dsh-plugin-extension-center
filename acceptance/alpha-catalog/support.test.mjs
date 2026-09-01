import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'
import { canonicalJson, canonicalSha256 } from '../full-p0/receipt-binding.mjs'
import { assertPackagedAlphaPredecessor } from './preflight.mjs'
import {
  ACCEPTANCE_ID,
  CENTER_REPOSITORY,
  DSH_COMMIT,
  DSH_TAG,
  DSH_VERSION,
  LIFECYCLE_WORKFLOW,
  WIKI_V1_REF,
  WIKI_V1_INTEGRITY,
  WIKI_V2_REF,
  WIKI_V2_INTEGRITY,
  assertSecretFreeAlphaLifecycleReceipt,
  createAlphaLifecycleReceipt,
  parseAlphaLifecycleArguments,
  writeAlphaLifecycleReceipt,
} from './support.mjs'

const CENTER_COMMIT = 'c'.repeat(40)
const DIGEST = value => `sha256:${createHash('sha256').update(value).digest('hex')}`

function operations() {
  const rows = [
    ['install', WIKI_V1_REF, false, true],
    ['configure', WIKI_V1_REF, false, false],
    ['update', WIKI_V2_REF, true, false],
    ['uninstall', WIKI_V2_REF, false, null],
    ['restore', WIKI_V2_REF, true, false],
    ['uninstall', WIKI_V2_REF, false, null],
  ]
  return rows.map(([action, candidateRef, configurationPreserved, userInvocable], index) => ({
    sequence: index + 1,
    action,
    candidateRef,
    status: 'committed',
    planHash: DIGEST(`plan-${String(index + 1)}`),
    receiptDigest: DIGEST(`receipt-${String(index + 1)}`),
    operationId: `operation:12345678-1234-4${String(index).padStart(3, '0')}-8123-123456789abc`,
    externalRuntimeAction: ['install', 'update'].includes(action) ? 'download' : 'none',
    beforeDigest: DIGEST(`before-${String(index + 1)}`),
    afterDigest: DIGEST(`after-${String(index + 1)}`),
    mutationDigests: [DIGEST(`mutation-${String(index + 1)}`)],
    verificationDigests: [DIGEST(`verification-${String(index + 1)}`)],
    journalEventCount: 7,
    journalHeadDigest: DIGEST(`journal-${String(index + 1)}`),
    inventoryRevision: DIGEST(`inventory-${String(index + 1)}`),
    managedRevision: `center:${String(index + 1)}`,
    configurationRevision: action === 'install'
      ? DIGEST(JSON.stringify({ modelInvocable: true, projectRoot: null, userInvocable: true }))
      : ['configure', 'update', 'restore'].includes(action)
        ? DIGEST(JSON.stringify({ modelInvocable: true, projectRoot: null, userInvocable: false }))
        : null,
    observedCandidateRef: candidateRef,
    ownerRevisionDigest: DIGEST(`owner-revision-${String(index + 1)}`),
    ownerEvidenceDigest: DIGEST(`owner-evidence-${String(index + 1)}`),
    materialIntegrity: candidateRef === WIKI_V1_REF
      ? WIKI_V1_INTEGRITY
      : WIKI_V2_INTEGRITY,
    ownerStateVerified: true,
    configurationPreserved,
    userInvocable,
  }))
}

function receipt() {
  return createAlphaLifecycleReceipt({
    centerCommit: CENTER_COMMIT,
    runId: 123_456,
    runAttempt: 2,
    officialDshSourceUnmodified: true,
    officialDshSourceTreeDigest: DIGEST('official-source-tree'),
    officialDshEntrypointDigest: DIGEST('official-cli-entrypoint'),
    centerPackageDigest: DIGEST('center-package'),
    activeCandidateAbsent: true,
    catalog: {
      revision: 12,
      documentDigest: DIGEST('catalog-document'),
      entriesDigest: DIGEST('catalog-entries'),
      observedAt: '2026-08-28T00:00:00.000Z',
      issuedAt: '2026-08-28T00:00:00.000Z',
      expiresAt: '2026-08-29T00:00:00.000Z',
    },
    operations: operations(),
  })
}

test('parses only exact absolute producer coordinates', () => {
  const argumentsList = [
    '--dsh-source-root', '/tmp/official-dsh',
    '--center-source-root', '/tmp/center',
    '--center-commit', CENTER_COMMIT,
    '--catalog', '/tmp/catalog.json',
    '--catalog-evidence', '/tmp/evidence.json',
    '--tls-certificate', '/tmp/cert.pem',
    '--tls-private-key', '/tmp/key.pem',
    '--receipt', '/tmp/receipt.json',
    '--run-id', '123456',
    '--run-attempt', '2',
  ]
  const parsed = parseAlphaLifecycleArguments(argumentsList)
  assert.equal(parsed.centerCommit, CENTER_COMMIT)
  assert.equal(parsed.runId, 123_456)
  assert.equal(parsed.runAttempt, 2)
  const relativeArguments = [...argumentsList]
  relativeArguments[1] = 'relative'
  assert.throws(() => parseAlphaLifecycleArguments(relativeArguments), /must be absolute/u)
})

test('creates the exact secret-free six-operation admission receipt', () => {
  const value = receipt()
  assert.deepEqual(value, assertSecretFreeAlphaLifecycleReceipt(value))
  assert.equal(value.acceptanceId, ACCEPTANCE_ID)
  assert.equal(value.schemaVersion, 2)
  assert.deepEqual(value.target, {
    dshVersion: DSH_VERSION,
    dshTag: DSH_TAG,
    dshCommit: DSH_COMMIT,
    officialDshSourceUnmodified: true,
    officialDshSourceTreeDigest: DIGEST('official-source-tree'),
    officialDshEntrypointDigest: DIGEST('official-cli-entrypoint'),
    centerSourceCommit: CENTER_COMMIT,
    centerPackageDigest: DIGEST('center-package'),
    catalogRevision: 12,
    catalogDocumentDigest: DIGEST('catalog-document'),
    catalogEntriesDigest: DIGEST('catalog-entries'),
    catalogObservedAt: '2026-08-28T00:00:00.000Z',
    catalogIssuedAt: '2026-08-28T00:00:00.000Z',
    catalogExpiresAt: '2026-08-29T00:00:00.000Z',
  })
  assert.deepEqual(value.run, {
    repository: CENTER_REPOSITORY,
    workflow: LIFECYCLE_WORKFLOW,
    ref: 'refs/heads/main',
    commit: CENTER_COMMIT,
    runId: 123_456,
    runAttempt: 2,
  })
  const { receiptDigest, ...body } = value
  assert.equal(receiptDigest, canonicalSha256(body))
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.sequence) && Object.isFrozen(value.target))
})

test('rejects changed candidate coordinates, run identity, extra fields, and digest drift', () => {
  const changedCandidate = structuredClone(receipt())
  changedCandidate.sequence[0].candidateRef = `skill:microsoft-skills/wiki-page-writer@${'a'.repeat(40)}`
  changedCandidate.receiptDigest = canonicalSha256(Object.fromEntries(
    Object.entries(changedCandidate).filter(([key]) => key !== 'receiptDigest'),
  ))
  assert.throws(() => assertSecretFreeAlphaLifecycleReceipt(changedCandidate), /operation 1 is incomplete/u)

  const changedRun = structuredClone(receipt())
  changedRun.run.repository = 'attacker/example'
  changedRun.receiptDigest = canonicalSha256(Object.fromEntries(
    Object.entries(changedRun).filter(([key]) => key !== 'receiptDigest'),
  ))
  assert.throws(() => assertSecretFreeAlphaLifecycleReceipt(changedRun), /protected-main run identity/u)

  const extra = structuredClone(receipt())
  extra.token = 'github_pat_not-persisted'
  assert.throws(() => assertSecretFreeAlphaLifecycleReceipt(extra), /receipt fields are invalid/u)

  const changedDigest = structuredClone(receipt())
  changedDigest.receiptDigest = DIGEST('wrong')
  assert.throws(() => assertSecretFreeAlphaLifecycleReceipt(changedDigest), /self-digest is invalid/u)
})

test('writes one canonical owner-only receipt atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpha-lifecycle-receipt-test-'))
  try {
    const path = join(root, 'only', 'receipt.json')
    const value = receipt()
    await writeAlphaLifecycleReceipt(path, value)
    const [bytes, info] = await Promise.all([readFile(path, 'utf8'), lstat(path)])
    assert.equal(bytes, `${canonicalJson(value)}\n`)
    assert.equal(info.isFile(), true)
    if (process.platform !== 'win32') assert.equal(info.mode & 0o077, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('preflight requires byte-exact committed and packaged predecessor equality', async () => {
  const document = {
    envelope: { revision: 11, entriesDigest: DIGEST('entries') },
    signatures: [{ keyId: 'test', value: 'test' }],
  }
  const bytes = Buffer.from(`${canonicalJson(document)}\n`)
  const policy = {
    previousRevision: 11,
    previousEntriesDigest: document.envelope.entriesDigest,
    previousDocumentDigest: canonicalSha256(document),
    previousFileSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  }
  await assert.doesNotReject(assertPackagedAlphaPredecessor({
    catalogBytes: bytes,
    packaged: structuredClone(document),
    policy,
  }))
  await assert.rejects(assertPackagedAlphaPredecessor({
    catalogBytes: bytes,
    packaged: { envelope: { revision: 10 }, signatures: [] },
    policy,
  }), /lifecycle receipt production remains RED/u)
})

test('workflow keeps the candidate projection temporary and uploads only receipt.json', async () => {
  const [workflowText, manifestText, runnerText] = await Promise.all([
    readFile('.github/workflows/official-alpha-wiki-lifecycle.yml', 'utf8'),
    readFile('package.json', 'utf8'),
    readFile('acceptance/alpha-catalog/run.mjs', 'utf8'),
  ])
  const workflow = parseYaml(workflowText)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(workflow.on.workflow_dispatch, {})
  assert.match(workflow.jobs.lifecycle.if, /github\.ref_protected == true/u)
  assert.equal(workflow.jobs.lifecycle.environment, 'catalog-release')
  const steps = workflow.jobs.lifecycle.steps
  const officialCheckout = steps.find(step => step.with?.repository === 'deepseek-ai/deepseek-harness')
  assert.equal(officialCheckout.with.ref, DSH_COMMIT)
  assert.equal(officialCheckout.with['fetch-tags'], true)
  const candidate = steps.find(step => step.name === 'Prepare development-only signed lifecycle catalog')
  assert.match(candidate.run, /prepare-alpha-catalog-admission\.mjs lifecycle-candidate/u)
  assert.match(candidate.run, /\$RUNNER_TEMP\/official-alpha-wiki-lifecycle-input/u)
  const upload = steps.find(step => step.name === 'Upload canonical lifecycle receipt')
  assert.equal(upload.with.name, 'official-alpha-wiki-lifecycle-${{ github.run_id }}-attempt-${{ github.run_attempt }}')
  assert.equal(upload.with.path, '${{ runner.temp }}/official-alpha-wiki-lifecycle-receipt/receipt.json')
  assert.doesNotMatch(upload.with.path, /plugins\.json|evidence\.json/u)
  assert.ok(steps.findIndex(step => step.name === 'Require exact packaged revision 11 predecessor')
    < steps.findIndex(step => step.name === 'Prepare development-only signed lifecycle catalog'))
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.files.some(path => path.startsWith('acceptance/alpha-catalog')), false)
  assert.match(runnerText, /chromium\.launch/u)
  assert.match(runnerText, /page\.evaluate/u)
  assert.match(runnerText, /missing === 401 && invalid === 401 && crossOrigin === 403/u)
  assert.doesNotMatch(workflowText, /git push|catalog\/public\/plugins\.json[^\n]*>/u)
  assert.doesNotMatch(workflowText, /inputs\.(?:issued_at|expires_at)|--(?:observed|issued|expires)-at/u)
})
