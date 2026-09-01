import { createHash } from 'node:crypto'
import {
  canonicalJson,
  canonicalSha256,
  catalogReviewEvidenceSupport,
  verifyCatalog,
} from '../lib/catalog.js'
import { SKILL_CANDIDATES } from '../lib/kind-candidates.js'
import {
  createSignedCatalogDocument,
  discoverGithubSkillRepositories,
} from './catalog-pipeline-core.mjs'

const SHA256 = /^sha256:[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const OPERATION_ID = /^operation:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MANAGED_REVISION = /^center:[1-9][0-9]*$/u
const CONFIGURATION_INITIAL_DIGEST = canonicalSha256({ modelInvocable: true, userInvocable: true, projectRoot: null })
const CONFIGURATION_CONFIGURED_DIGEST = canonicalSha256({ modelInvocable: true, userInvocable: false, projectRoot: null })
const TARGET_DSH_VERSION = '0.1.2-alpha.3'
const TARGET_DSH_TAG = 'dsh-v0.1.2-alpha.3'
const TARGET_DSH_COMMIT = 'dd6322d604e00eec1ba5e0c8541159906a21094a'
const REPOSITORY = 'microsoft/skills'
const REPOSITORY_URL = 'https://github.com/microsoft/skills'
const SKILL_DIRECTORY = '.github/plugins/deep-wiki/skills/wiki-page-writer'
const SKILL_PATH = `${SKILL_DIRECTORY}/SKILL.md`
const SEARCH_SOURCE_ID = 'github-alpha-wiki-skill-search'
const SEARCH_URL = 'https://api.github.com/search/repositories?q=repo%3Amicrosoft%2Fskills+topic%3Aagent-skills&per_page=1&page=1'
const LIFECYCLE_WORKFLOW = '.github/workflows/official-alpha-wiki-lifecycle.yml'
const NOT_PROVEN = Object.freeze([
  'public-github-artifact-installation',
  'public-catalog-deployment',
])

function reviewedSkill(index, treeSha, blobSha) {
  const candidate = SKILL_CANDIDATES[index]
  if (candidate === undefined || candidate.reviewBody === null) {
    throw new Error('alpha-catalog-admission: packaged Wiki Skill review identity is absent')
  }
  return Object.freeze({
    ...candidate,
    treeSha,
    blobSha,
    rawUrl: `https://raw.githubusercontent.com/microsoft/skills/${candidate.version}/${candidate.artifactId}`,
  })
}

/** Exact external Wiki Skill artifacts admitted by the alpha proposal. */
export const ALPHA_WIKI_CANDIDATES = Object.freeze([
  reviewedSkill(1, '1bf2d3ac292f9f0b3838a473d13eb2205ddde7d7', '7088aa9c1add0ac3378eb7993dc65b4047267a59'),
  reviewedSkill(2, '77cca28c2a3a3c8de48faea36ed1067a41403b08', 'bb203da412a56c38cd457612bc0f46b91f046216'),
])

/** Fixed production coordinates for the one adjacent alpha admission proposal. */
export const PRODUCTION_ALPHA_ADMISSION_POLICY = Object.freeze({
  targetDshVersion: TARGET_DSH_VERSION,
  targetDshTag: TARGET_DSH_TAG,
  targetDshCommit: TARGET_DSH_COMMIT,
  previousRevision: 11,
  nextRevision: 12,
  previousDocumentDigest: 'sha256:e44452094f3067bbca5672ab2d6052ea60dfcdd877ee0842f91803ae66bcd8e5',
  previousEntriesDigest: 'sha256:da9f5a4f703462cb27de0df26e265c3461dd85a51f0b5a2deecb76ee22d9de86',
  previousFileSha256: 'sha256:38a5414c2da581bf0014a2769c9842375b0d0822b77f89e5159b27b3042fc58e',
  repository: REPOSITORY,
  repositoryUrl: REPOSITORY_URL,
  searchSourceId: SEARCH_SOURCE_ID,
  searchUrl: SEARCH_URL,
  lifecycleWorkflow: LIFECYCLE_WORKFLOW,
})

function fail(message) {
  throw new Error(`alpha-catalog-admission: ${message}`)
}

function record(value, subject) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${subject} must be an object`)
  return value
}

function exact(value, subject, fields) {
  const item = record(value, subject)
  const actual = Object.keys(item).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(`${subject} fields are invalid`)
  }
  return item
}

function text(value, subject, maximum = 2_048) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    fail(`${subject} must be a bounded non-blank string`)
  }
  return value
}

function positiveInteger(value, subject) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${subject} must be a positive safe integer`)
  return value
}

function sha256(value, subject) {
  const digest = text(value, subject, 80)
  if (!SHA256.test(digest)) fail(`${subject} must be a canonical SHA-256 digest`)
  return digest
}

function commit(value, subject) {
  const revision = text(value, subject, 40)
  if (!COMMIT.test(revision)) fail(`${subject} must be a lowercase forty-character commit`)
  return revision
}

function timestamp(value, subject) {
  const source = text(value, subject, 64)
  const parsed = Date.parse(source)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== source) fail(`${subject} must be a canonical timestamp`)
  return source
}

function byteSha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function gitBlobSha(bytes) {
  return createHash('sha1').update(`blob ${String(bytes.byteLength)}\0`).update(bytes).digest('hex')
}

function sameList(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
}

function verifyPrevious(previous, previousFileSha256, packagedPrevious, root, policy) {
  if (previousFileSha256 !== policy.previousFileSha256
    || canonicalSha256(previous) !== policy.previousDocumentDigest
    || previous?.envelope?.revision !== policy.previousRevision
    || previous?.envelope?.entriesDigest !== policy.previousEntriesDigest) {
    fail('previous catalog is not the exact committed signed revision 11 input')
  }
  const issuedAt = Date.parse(previous.envelope.issuedAt)
  verifyCatalog(root, previous.envelope, previous.signatures, issuedAt + 1)
  if (canonicalJson(packagedPrevious) !== canonicalJson(previous)) {
    fail('packaged bootstrap has not promoted the exact signed revision 11 predecessor')
  }
  for (const candidate of ALPHA_WIKI_CANDIDATES) {
    const entry = previous.envelope.entries.find(value => value.candidateRef === candidate.candidateRef)
    if (entry === undefined
      || entry.kind !== 'skill'
      || entry.name !== candidate.name
      || entry.source?.upstreamUrl !== policy.repositoryUrl
      || entry.source?.revision !== candidate.version
      || entry.artifact?.id !== candidate.artifactId
      || entry.artifact?.version !== candidate.version
      || entry.artifact?.integrity !== candidate.integrity
      || entry.artifact?.sizeBytes !== candidate.sizeBytes) {
      fail(`${candidate.candidateRef} is absent from the exact signed predecessor`)
    }
  }
}

function verifySearch(document, observedAt, policy) {
  const root = record(document, 'GitHub search document')
  if (root.total_count !== 1 || !Array.isArray(root.items) || root.items.length !== 1) {
    fail('fixed GitHub Wiki Skill search did not resolve exactly one repository')
  }
  const repository = record(root.items[0], 'GitHub search repository')
  if (repository.full_name !== policy.repository
    || repository.html_url !== policy.repositoryUrl
    || repository.archived !== false
    || repository.disabled !== false
    || repository.visibility !== 'public'
    || !Array.isArray(repository.topics)
    || !repository.topics.includes('agent-skills')) {
    fail('fixed GitHub Wiki Skill repository metadata is not eligible')
  }
  const report = discoverGithubSkillRepositories(
    document,
    policy.searchUrl,
    observedAt,
    policy.searchSourceId,
  )
  if (report.leads.length !== 1 || report.rejections.length !== 0
    || report.leads[0].externalId !== policy.repository) {
    fail('fixed GitHub Wiki Skill search did not produce its one provenance lead')
  }
  return report
}

function verifyCommitAndTree(candidate, commitDocument, treeDocument) {
  const gitCommit = record(commitDocument, `${candidate.candidateRef} Git commit`)
  if (gitCommit.sha !== candidate.version || record(gitCommit.tree, 'Git commit tree').sha !== candidate.treeSha) {
    fail(`${candidate.candidateRef} commit metadata changed`)
  }
  const tree = record(treeDocument, `${candidate.candidateRef} Git tree`)
  if (tree.sha !== candidate.treeSha || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 100_000) {
    fail(`${candidate.candidateRef} Git tree is incomplete or changed`)
  }
  const ancestors = SKILL_PATH.split('/').slice(0, -1)
  for (let index = 1; index <= ancestors.length; index += 1) {
    const path = ancestors.slice(0, index).join('/')
    const node = tree.tree.find(value => value?.path === path)
    if (node === undefined || node.mode !== '040000' || node.type !== 'tree') {
      fail(`${candidate.candidateRef} artifact path has a missing or non-directory ancestor`)
    }
  }
  const subtree = tree.tree.filter(value => value?.path === SKILL_DIRECTORY
    || (typeof value?.path === 'string' && value.path.startsWith(`${SKILL_DIRECTORY}/`)))
  if (subtree.length < 2) fail(`${candidate.candidateRef} Skill subtree is absent`)
  for (const node of subtree) {
    const path = text(node.path, `${candidate.candidateRef} tree path`)
    if (path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
      fail(`${candidate.candidateRef} tree contains an unsafe path`)
    }
    const lower = path.toLowerCase()
    const regularNode = node.type === 'tree' && node.mode === '040000'
      || node.type === 'blob' && node.mode === '100644'
    if (!regularNode || node.mode === '120000' || node.type === 'commit'
      || /\/(?:package|package-lock|npm-shrinkwrap|pnpm-lock)\.(?:json|yaml)$/u.test(lower)
      || lower.includes('/scripts/')
      || /\.(?:cmd|exe|js|mjs|cjs|ps1|sh)$/u.test(lower)) {
      fail(`${candidate.candidateRef} subtree contains a symlink, submodule, or lifecycle script`)
    }
  }
  const artifact = subtree.find(value => value.path === SKILL_PATH)
  if (artifact === undefined || artifact.mode !== '100644' || artifact.type !== 'blob'
    || artifact.sha !== candidate.blobSha || artifact.size !== candidate.sizeBytes) {
    fail(`${candidate.candidateRef} exact SKILL.md blob metadata changed`)
  }
}

function verifyArtifact(candidate, value) {
  if (!ArrayBuffer.isView(value) || value.BYTES_PER_ELEMENT !== 1 || value.byteLength !== candidate.sizeBytes
    || byteSha256(value) !== candidate.integrity
    || gitBlobSha(value) !== candidate.blobSha) {
    fail(`${candidate.candidateRef} artifact bytes do not match SHA-256, size, and Git blob identity`)
  }
  let body
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    fail(`${candidate.candidateRef} artifact is not strict UTF-8`)
  }
  if (body !== candidate.reviewBody) fail(`${candidate.candidateRef} artifact differs from the packaged authority-review body`)
}

function verifyLifecycleReceipt(value, workflowRun, centerSourceCommit, policy, catalog) {
  const receipt = exact(value, 'lifecycle receipt', [
    'acceptanceId', 'activeCandidateAbsent', 'notProven', 'p0Status', 'receiptDigest',
    'run', 'schemaVersion', 'sequence', 'status', 'target',
  ])
  const { receiptDigest, ...body } = receipt
  if (receipt.schemaVersion !== 2
    || receipt.acceptanceId !== 'P0-OFFICIAL-ALPHA-WIKI-SKILL-LIFECYCLE'
    || receipt.status !== 'passed'
    || receipt.p0Status !== 'not-proven-development'
    || sha256(receiptDigest, 'lifecycle receipt digest') !== canonicalSha256(body)
    || !sameList(receipt.notProven, NOT_PROVEN)
    || receipt.activeCandidateAbsent !== true) {
    fail('lifecycle receipt is incomplete or not self-bound')
  }
  const target = exact(receipt.target, 'lifecycle target', [
    'catalogDocumentDigest', 'catalogEntriesDigest', 'catalogExpiresAt', 'catalogIssuedAt',
    'catalogObservedAt', 'catalogRevision', 'centerPackageDigest', 'centerSourceCommit', 'dshCommit',
    'dshTag', 'dshVersion', 'officialDshEntrypointDigest', 'officialDshSourceTreeDigest',
    'officialDshSourceUnmodified',
  ])
  if (target.dshVersion !== policy.targetDshVersion
    || target.dshTag !== policy.targetDshTag
    || target.dshCommit !== policy.targetDshCommit
    || target.officialDshSourceUnmodified !== true
    || !SHA256.test(target.officialDshSourceTreeDigest)
    || !SHA256.test(target.officialDshEntrypointDigest)
    || !SHA256.test(target.centerPackageDigest)
    || target.catalogRevision !== catalog.envelope.revision
    || target.catalogDocumentDigest !== canonicalSha256(catalog)
    || target.catalogEntriesDigest !== catalog.envelope.entriesDigest
    || Date.parse(timestamp(target.catalogObservedAt, 'lifecycle catalog observation time'))
      > Date.parse(catalog.envelope.issuedAt)
    || target.catalogIssuedAt !== catalog.envelope.issuedAt
    || target.catalogExpiresAt !== catalog.envelope.expiresAt) {
    fail('lifecycle receipt does not bind the unmodified official alpha source')
  }
  if (commit(target.centerSourceCommit, 'lifecycle Center source commit')
    !== commit(centerSourceCommit, 'admission Center source commit')) {
    fail('lifecycle receipt does not bind the admission source commit')
  }
  const run = exact(receipt.run, 'lifecycle run', [
    'commit', 'ref', 'repository', 'runAttempt', 'runId', 'workflow',
  ])
  if (run.repository !== 'striveh/dsh-plugin-extension-center'
    || run.workflow !== policy.lifecycleWorkflow
    || run.ref !== 'refs/heads/main'
    || commit(run.commit, 'lifecycle run commit') !== target.centerSourceCommit) {
    fail('lifecycle receipt does not bind the protected source workflow')
  }
  positiveInteger(run.runId, 'lifecycle run id')
  positiveInteger(run.runAttempt, 'lifecycle run attempt')
  const sourceRun = record(workflowRun, 'GitHub lifecycle workflow run')
  if (sourceRun.id !== run.runId
    || sourceRun.run_attempt !== run.runAttempt
    || sourceRun.path !== run.workflow
    || sourceRun.head_sha !== run.commit
    || sourceRun.head_branch !== 'main'
    || sourceRun.event !== 'workflow_dispatch'
    || sourceRun.status !== 'completed'
    || sourceRun.conclusion !== 'success'
    || record(sourceRun.repository, 'GitHub lifecycle run repository').full_name !== run.repository) {
    fail('GitHub workflow run does not authenticate the lifecycle receipt')
  }
  const expected = [
    ['install', ALPHA_WIKI_CANDIDATES[0], true],
    ['configure', ALPHA_WIKI_CANDIDATES[0], false],
    ['update', ALPHA_WIKI_CANDIDATES[1], false],
    ['uninstall', ALPHA_WIKI_CANDIDATES[1], null],
    ['restore', ALPHA_WIKI_CANDIDATES[1], false],
    ['uninstall', ALPHA_WIKI_CANDIDATES[1], null],
  ]
  if (!Array.isArray(receipt.sequence) || receipt.sequence.length !== expected.length) {
    fail('lifecycle receipt does not contain the exact write sequence')
  }
  receipt.sequence.forEach((value, index) => {
    const operation = exact(value, `lifecycle operation ${String(index + 1)}`, [
      'action', 'afterDigest', 'beforeDigest', 'candidateRef', 'configurationPreserved',
      'configurationRevision', 'externalRuntimeAction', 'inventoryRevision', 'journalEventCount',
      'journalHeadDigest', 'managedRevision', 'materialIntegrity', 'mutationDigests',
      'observedCandidateRef', 'operationId', 'ownerEvidenceDigest', 'ownerRevisionDigest',
      'ownerStateVerified', 'planHash', 'receiptDigest', 'sequence', 'status',
      'userInvocable', 'verificationDigests',
    ])
    const [action, candidate, userInvocable] = expected[index]
    const configurationPreserved = action === 'update' || action === 'restore'
    const expectedConfigurationRevision = action === 'install'
      ? CONFIGURATION_INITIAL_DIGEST
      : ['configure', 'update', 'restore'].includes(action)
        ? CONFIGURATION_CONFIGURED_DIGEST
        : null
    const expectedRuntimeAction = ['install', 'update'].includes(action) ? 'download' : 'none'
    if (operation.sequence !== index + 1
      || operation.action !== action
      || operation.candidateRef !== candidate.candidateRef
      || operation.observedCandidateRef !== candidate.candidateRef
      || operation.materialIntegrity !== candidate.integrity
      || operation.status !== 'committed'
      || operation.ownerStateVerified !== true
      || operation.userInvocable !== userInvocable
      || operation.configurationPreserved !== configurationPreserved
      || operation.configurationRevision !== expectedConfigurationRevision
      || operation.externalRuntimeAction !== expectedRuntimeAction
      || !OPERATION_ID.test(operation.operationId)
      || !MANAGED_REVISION.test(operation.managedRevision)
      || !Number.isSafeInteger(operation.journalEventCount) || operation.journalEventCount < 2
      || !SHA256.test(operation.planHash) || !SHA256.test(operation.receiptDigest)
      || !SHA256.test(operation.beforeDigest) || !SHA256.test(operation.afterDigest)
      || !SHA256.test(operation.journalHeadDigest) || !SHA256.test(operation.inventoryRevision)
      || !SHA256.test(operation.ownerRevisionDigest) || !SHA256.test(operation.ownerEvidenceDigest)
      || !digestList(operation.mutationDigests) || !digestList(operation.verificationDigests)) {
      fail(`lifecycle operation ${String(index + 1)} is incomplete`)
    }
  })
  if (new Set(receipt.sequence.map(operation => operation.operationId)).size !== expected.length
    || new Set(receipt.sequence.map(operation => operation.inventoryRevision)).size !== expected.length
    || new Set(receipt.sequence.map(operation => operation.managedRevision)).size !== expected.length) {
    fail('lifecycle operations do not expose six distinct durable state transitions')
  }
  return Object.freeze({ receiptDigest, run: Object.freeze({ ...run }) })
}

function digestList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(digest => SHA256.test(digest))
}

function alphaEntry(previous, candidate, issuedAt, policy) {
  const source = previous.envelope.entries.find(value => value.candidateRef === candidate.candidateRef)
  const entry = structuredClone(source)
  entry.source.admittedAt = issuedAt
  entry.compatibility = {
    ...entry.compatibility,
    status: 'compatible',
    dsh: policy.targetDshVersion,
    detail: {
      en: 'The exact commit-pinned SKILL.md uses the Skill format exercised by the protected unmodified-official-alpha lifecycle gate.',
      zh: '固定到准确 commit 的 SKILL.md 使用受保护的未修改官方 alpha 生命周期门禁所验证的 Skill 格式。',
    },
  }
  entry.dependencies = entry.dependencies.map(dependency => dependency.kind === 'host' && dependency.id === '@deepseek-ai/dsh'
    ? { ...dependency, version: policy.targetDshVersion }
    : dependency)
  if (!entry.dependencies.some(dependency => dependency.kind === 'host'
      && dependency.id === '@deepseek-ai/dsh'
      && dependency.version === policy.targetDshVersion)
    || catalogReviewEvidenceSupport(entry) !== 'package-pinned') {
    fail(`${candidate.candidateRef} alpha entry is not bound to its package-pinned review identity`)
  }
  return Object.freeze(entry)
}

function prepareCandidate(input, policy) {
  const observedAt = Date.parse(timestamp(input.observedAt, 'external observation time'))
  const issuedAt = Date.parse(timestamp(input.issuedAt, 'catalog issue time'))
  const expiresAt = Date.parse(timestamp(input.expiresAt, 'catalog expiry time'))
  const previousIssuedAt = Date.parse(input.previous?.envelope?.issuedAt)
  if (observedAt > issuedAt || issuedAt >= expiresAt
    || !Number.isFinite(previousIssuedAt) || issuedAt <= previousIssuedAt
    || !Number.isSafeInteger(input.root?.maximumAgeMs) || expiresAt - issuedAt > input.root.maximumAgeMs) {
    fail('observation, adjacent issue, and expiry times are not ordered within the signed root lifetime')
  }
  verifyPrevious(input.previous, input.previousFileSha256, input.packagedPrevious, input.root, policy)
  const leadReport = verifySearch(input.searchDocument, input.observedAt, policy)
  for (const candidate of ALPHA_WIKI_CANDIDATES) {
    verifyCommitAndTree(candidate, input.commitDocuments[candidate.version], input.treeDocuments[candidate.version])
    verifyArtifact(candidate, input.artifacts[candidate.version])
  }
  const entries = ALPHA_WIKI_CANDIDATES.map(candidate => alphaEntry(input.previous, candidate, input.issuedAt, policy))
  const signed = createSignedCatalogDocument({
    root: input.root,
    previous: input.previous,
    entries,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    signers: input.signers,
  })
  if (signed.document.envelope.revision !== policy.nextRevision
    || signed.document.envelope.previousRevisionDigest !== canonicalSha256(input.previous.envelope)) {
    fail('signed output is not the exact adjacent revision 12 successor')
  }
  const candidates = Object.freeze(ALPHA_WIKI_CANDIDATES.map(candidate => Object.freeze({
    candidateRef: candidate.candidateRef,
    sourceRevision: candidate.version,
    treeSha: candidate.treeSha,
    blobSha: candidate.blobSha,
    artifactUrl: candidate.rawUrl,
    artifactIntegrity: candidate.integrity,
    artifactSizeBytes: candidate.sizeBytes,
    artifactPath: candidate.artifactId,
    pathSafety: 'regular-blob-no-symlink-submodule-or-lifecycle-script',
  })))
  return Object.freeze({ signed, leadReport, candidates })
}

/** Sign one isolated development catalog used only by the exact-alpha lifecycle producer. */
export function prepareAlphaLifecycleCatalog(input, policy = PRODUCTION_ALPHA_ADMISSION_POLICY) {
  const candidate = prepareCandidate(input, policy)
  const evidence = Object.freeze({
    schemaVersion: 1,
    kind: 'official-dsh-alpha-ephemeral-lifecycle-catalog',
    status: 'development-only',
    notProven: Object.freeze([
      'catalog-admission',
      'public-github-artifact-installation',
      'public-catalog-deployment',
    ]),
    targetDsh: Object.freeze({
      version: policy.targetDshVersion,
      tag: policy.targetDshTag,
      commit: policy.targetDshCommit,
    }),
    catalogId: candidate.signed.document.envelope.catalogId,
    previousRevision: policy.previousRevision,
    revision: policy.nextRevision,
    previousDocumentDigest: policy.previousDocumentDigest,
    previousFileSha256: policy.previousFileSha256,
    previousRevisionDigest: candidate.signed.document.envelope.previousRevisionDigest,
    entriesDigest: candidate.signed.document.envelope.entriesDigest,
    documentDigest: canonicalSha256(candidate.signed.document),
    signingKeyIds: candidate.signed.keyIds,
    observedAt: input.observedAt,
    issuedAt: candidate.signed.document.envelope.issuedAt,
    expiresAt: candidate.signed.document.envelope.expiresAt,
    discovery: Object.freeze({
      sourceId: candidate.leadReport.sourceId,
      sourceUrl: candidate.leadReport.sourceUrl,
      sourceDocumentDigest: candidate.leadReport.documentDigest,
      leadIds: Object.freeze(candidate.leadReport.leads.map(lead => lead.leadId)),
    }),
    candidates: candidate.candidates,
  })
  return Object.freeze({ document: candidate.signed.document, evidence })
}

/** Validate real external metadata and a real exact-alpha lifecycle receipt, then sign r11 to r12. */
export function prepareAlphaCatalogAdmission(input, policy = PRODUCTION_ALPHA_ADMISSION_POLICY) {
  const candidate = prepareCandidate(input, policy)
  if (!Number.isSafeInteger(input.admissionTimeMs) || input.admissionTimeMs < 0) {
    fail('admission verification time must be a non-negative safe integer')
  }
  verifyCatalog(
    input.root,
    candidate.signed.document.envelope,
    candidate.signed.document.signatures,
    input.admissionTimeMs,
  )
  const lifecycle = verifyLifecycleReceipt(
    input.lifecycleReceipt,
    input.workflowRun,
    input.centerSourceCommit,
    policy,
    candidate.signed.document,
  )
  const evidence = Object.freeze({
    schemaVersion: 1,
    kind: 'official-dsh-alpha-entry-changing-catalog-admission',
    status: 'prepared-for-review',
    notProven: NOT_PROVEN,
    targetDsh: Object.freeze({
      version: policy.targetDshVersion,
      tag: policy.targetDshTag,
      commit: policy.targetDshCommit,
    }),
    catalogId: candidate.signed.document.envelope.catalogId,
    previousRevision: policy.previousRevision,
    revision: policy.nextRevision,
    previousDocumentDigest: policy.previousDocumentDigest,
    previousFileSha256: policy.previousFileSha256,
    previousRevisionDigest: candidate.signed.document.envelope.previousRevisionDigest,
    entriesDigest: candidate.signed.document.envelope.entriesDigest,
    documentDigest: canonicalSha256(candidate.signed.document),
    signingKeyIds: candidate.signed.keyIds,
    observedAt: input.observedAt,
    issuedAt: candidate.signed.document.envelope.issuedAt,
    expiresAt: candidate.signed.document.envelope.expiresAt,
    discovery: Object.freeze({
      sourceId: candidate.leadReport.sourceId,
      sourceUrl: candidate.leadReport.sourceUrl,
      sourceDocumentDigest: candidate.leadReport.documentDigest,
      leadIds: Object.freeze(candidate.leadReport.leads.map(lead => lead.leadId)),
    }),
    lifecycleEvidence: lifecycle,
    candidates: candidate.candidates,
  })
  return Object.freeze({ document: candidate.signed.document, evidence })
}
