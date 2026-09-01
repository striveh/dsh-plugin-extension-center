import { createHash } from 'node:crypto'
import { canonicalJson, canonicalSha256 } from '../full-p0/receipt-binding.mjs'
import {
  DEFAULT_DSH_VERSION,
  NPM_REGISTRY,
  PNPM_VERSION,
  assertSecretFreeReceipt,
  markPassed,
  verifyOrdinaryUserReceiptDigest,
} from '../ordinary-user/support.mjs'
import {
  createActionsArtifactEvidence,
  verifyActionsArtifactEvidence,
} from '../ordinary-user/actions-evidence.mjs'
import { verifyAlphaNpmProvenanceReceipt } from '../../scripts/verify-alpha-npm-publication.mjs'
import { assertSecretFreeAlphaLifecycleReceipt } from '../alpha-catalog/support.mjs'
import { verifyCatalog } from '../../lib/catalog.js'
import { BOOTSTRAP_CATALOG_ROOT } from '../../lib/catalog-data.js'

export const ALPHA_P0_ACCEPTANCE_ID = 'P0-ALPHA-EXTENSION-CENTER-COMPOSITE'
export const ALPHA_P0_DSH_COMMIT = 'dd6322d604e00eec1ba5e0c8541159906a21094a'
export const ALPHA_P0_CENTER_VERSION = '0.2.0-alpha.1'
export const ALPHA_P0_CATALOG_ID = 'dsh-extension-center-public'

const CENTER_PACKAGE = 'dsh-plugin-extension-center'
const REPOSITORY = 'striveh/dsh-plugin-extension-center'
const SRI = /^sha512-[A-Za-z0-9+/]+={0,2}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const GITHUB_NUMBER = /^[1-9][0-9]{0,19}$/u
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9:._/@+-]{0,511}$/u
const LIFECYCLE_SEQUENCE = Object.freeze([
  'install', 'configure', 'update', 'uninstall', 'restore', 'uninstall', 'purge',
])
const LANE_NAMES = Object.freeze([
  'officialDshRegistryInstall',
  'centerPackageProvenance',
  'signedCatalog',
  'pluginLifecycle',
  'mcpLifecycle',
  'skillUiLifecycle',
  'agentAcquisitionContinuation',
])
const BINDING_NAMES = Object.freeze([
  'officialDshIdentity', 'centerPackageIdentity', 'catalogIdentity', 'protectedEvidenceCoordinates',
])
const CUSTOM_WORKFLOWS = Object.freeze({
  catalog: '.github/workflows/alpha-catalog-activation.yml',
  plugin: '.github/workflows/alpha-plugin-lifecycle.yml',
  mcp: '.github/workflows/alpha-mcp-lifecycle.yml',
  agent: '.github/workflows/alpha-agent-acquisition.yml',
})

export class AlphaP0CompositeFailure extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`)
    this.name = 'AlphaP0CompositeFailure'
    this.code = code
  }
}

/**
 * Evaluate all required alpha product lanes and return a self-digested RED
 * receipt. Schema 1 retains valid producer coordinates for diagnostics but
 * cannot authenticate external Actions, registry, or deployment facts.
 */
export function evaluateAlphaP0Composite(input) {
  const evidence = exactRecord(input, 'composite input', [
    'agent', 'catalog', 'mcp', 'npmProvenance', 'ordinaryActions', 'ordinaryUser', 'plugin',
  ])
  const ordinary = lane('ALPHA-P0-ORDINARY', [evidence.ordinaryUser, evidence.ordinaryActions], () => (
    verifyOrdinaryLane(evidence.ordinaryUser, evidence.ordinaryActions)
  ))
  const provenance = lane('ALPHA-P0-NPM-PROVENANCE', [evidence.npmProvenance], () => (
    verifyNpmLane(evidence.npmProvenance)
  ))
  const catalog = lane('ALPHA-P0-CATALOG', [evidence.catalog], () => verifyCatalogLane(evidence.catalog))
  const plugin = lane('ALPHA-P0-PLUGIN', [evidence.plugin], () => verifyLifecycleLane(evidence.plugin, 'plugin'))
  const mcp = lane('ALPHA-P0-MCP', [evidence.mcp], () => verifyLifecycleLane(evidence.mcp, 'mcp'))
  const agent = lane('ALPHA-P0-AGENT', [evidence.agent], () => verifyAgentLane(evidence.agent))

  const lanes = {
    officialDshRegistryInstall: publicLane(ordinary),
    centerPackageProvenance: publicLane(provenance),
    signedCatalog: publicLane(catalog),
    pluginLifecycle: publicLane(plugin),
    mcpLifecycle: publicLane(mcp),
    skillUiLifecycle: publicLane(ordinary),
    agentAcquisitionContinuation: publicLane(agent),
  }
  const product = productProjection(ordinary, provenance, catalog, plugin, mcp, agent)
  const bindings = {
    officialDshIdentity: binding(
      ordinary,
      ordinary.value?.dsh.version === DEFAULT_DSH_VERSION
        && ordinary.value.dsh.sourceCommit === ALPHA_P0_DSH_COMMIT
        && ordinary.value.dsh.registry === NPM_REGISTRY,
    ),
    centerPackageIdentity: binding(
      ordinary,
      provenance,
      ordinary.value?.center.version === provenance.value?.center.version
        && ordinary.value?.center.integrity === provenance.value?.center.integrity,
    ),
    catalogIdentity: binding(
      ordinary,
      catalog,
      ordinary.value?.catalog.revision === catalog.value?.product?.catalog.revision
        && ordinary.value?.catalog.entriesDigest === catalog.value?.product?.catalog.entriesDigest,
    ),
    protectedEvidenceCoordinates: binding(
      ordinary,
      catalog,
      plugin,
      mcp,
      agent,
      [ordinary, catalog, plugin, mcp, agent].every(item => protectedCoordinates(item.value)),
    ),
  }

  const productLanes = [catalog, plugin, mcp, agent]
  for (const item of productLanes) {
    if (item.status === 'proven' && !sameProduct(item.value.product, product)) {
      item.status = 'unbound'
      item.code = `${item.code}-PRODUCT-BINDING`
      const laneName = item.value.extensionKind === 'plugin'
        ? 'pluginLifecycle'
        : item.value.extensionKind === 'mcp'
          ? 'mcpLifecycle'
          : item.value.acceptanceId === 'P0-ALPHA-SIGNED-CATALOG-ACTIVATION'
            ? 'signedCatalog'
            : 'agentAcquisitionContinuation'
      lanes[laneName] = publicLane(item)
    }
  }

  const allLanesProven = LANE_NAMES.every(name => lanes[name].status === 'proven')
  const allBindingsProven = BINDING_NAMES.every(name => bindings[name] === true)
  const p0Proven = allLanesProven && allBindingsProven
  const notProven = [
    ...LANE_NAMES.filter(name => lanes[name].status !== 'proven').map(name => `lane:${name}`),
    ...BINDING_NAMES.filter(name => bindings[name] !== true).map(name => `binding:${name}`),
  ]
  const body = {
    schemaVersion: 1,
    acceptanceId: ALPHA_P0_ACCEPTANCE_ID,
    status: p0Proven ? 'passed' : 'not-proven',
    p0Status: p0Proven ? 'proven' : 'red',
    target: product,
    lanes,
    bindings,
    notProven,
  }
  return deepFreeze({ ...body, receiptDigest: canonicalSha256(body) })
}

/** Verify the exact public composite schema and its RED/proven semantics. */
export function verifyAlphaP0CompositeReceipt(value) {
  const receipt = exactRecord(value, 'composite receipt', [
    'acceptanceId', 'bindings', 'lanes', 'notProven', 'p0Status', 'receiptDigest',
    'schemaVersion', 'status', 'target',
  ])
  const { receiptDigest, ...body } = receipt
  if (receipt.schemaVersion !== 1 || receipt.acceptanceId !== ALPHA_P0_ACCEPTANCE_ID
    || !SHA256.test(receiptDigest ?? '') || receiptDigest !== canonicalSha256(body)) {
    fail('ALPHA-P0-COMPOSITE-DIGEST', 'composite receipt identity or canonical digest is invalid')
  }
  const lanes = exactRecord(receipt.lanes, 'composite lanes', LANE_NAMES)
  for (const name of LANE_NAMES) verifyPublicLane(lanes[name], `composite lane ${name}`)
  const bindings = exactRecord(receipt.bindings, 'composite bindings', BINDING_NAMES)
  for (const name of BINDING_NAMES) {
    if (typeof bindings[name] !== 'boolean') fail('ALPHA-P0-COMPOSITE-SCHEMA', `${name} must be boolean`)
  }
  verifyProduct(receipt.target, true)
  const expectedNotProven = [
    ...LANE_NAMES.filter(name => lanes[name].status !== 'proven').map(name => `lane:${name}`),
    ...BINDING_NAMES.filter(name => bindings[name] !== true).map(name => `binding:${name}`),
  ]
  if (!sameList(receipt.notProven, expectedNotProven)) {
    fail('ALPHA-P0-COMPOSITE-CLAIM', 'notProven does not enumerate every failed lane and binding')
  }
  const proven = expectedNotProven.length === 0
  if (proven) {
    fail(
      'ALPHA-P0-COMPOSITE-EXTERNAL-EVIDENCE',
      'schema 1 cannot prove P0 without independent external evidence verification',
    )
  }
  if (receipt.status !== (proven ? 'passed' : 'not-proven')
    || receipt.p0Status !== (proven ? 'proven' : 'red')) {
    fail('ALPHA-P0-COMPOSITE-CLAIM', 'overall status does not fail closed over every lane and binding')
  }
  return receipt
}

function verifyOrdinaryLane(receipt, actionsEvidence) {
  exactRecord(receipt, 'ordinary-user receipt', [
    'acceptanceId', 'actionsProvenance', 'failure', 'laneStatus', 'mode', 'observations',
    'p0Status', 'productCoverage', 'receiptDigest', 'schemaVersion', 'status', 'target',
  ])
  assertSecretFreeReceipt(receipt)
  if (!verifyOrdinaryUserReceiptDigest(receipt) || receipt.schemaVersion !== 3
    || receipt.acceptanceId !== 'P0-ALPHA-ORDINARY-USER-REGISTRY-HOST-CLIENT-SKILL-LIFECYCLE'
    || receipt.status !== 'passed' || receipt.laneStatus !== 'proven' || receipt.p0Status !== 'red'
    || receipt.mode !== 'registry' || receipt.failure !== null
    || canonicalJson(receipt.productCoverage) !== canonicalJson({
      pluginLifecycle: 'pending',
      mcpLifecycle: 'pending',
      skillLifecycle: 'proven',
      agentAcquisitionContinuation: 'pending',
    })) {
    fail('ALPHA-P0-ORDINARY-CLAIM', 'ordinary-user receipt is not the protected production Skill lane')
  }
  const target = exactRecord(receipt.target, 'ordinary-user target', [
    'centerInitialSourceKind', 'centerInitialSpec', 'centerPackageName', 'centerTargetSourceKind',
    'centerTargetSpec', 'dshPackage', 'expectedCenterTargetIntegrity', 'expectedCenterTargetVersion',
    'expectedDshVersion', 'launcherKind', 'pnpmPackage', 'profileId', 'registry', 'sourceCommit',
  ])
  if (target.registry !== NPM_REGISTRY || target.profileId !== 'web'
    || target.dshPackage !== `@deepseek-ai/dsh@${DEFAULT_DSH_VERSION}`
    || target.expectedDshVersion !== DEFAULT_DSH_VERSION || target.pnpmPackage !== `pnpm@${PNPM_VERSION}`
    || target.centerPackageName !== CENTER_PACKAGE || target.centerInitialSourceKind !== 'registry'
    || target.centerTargetSourceKind !== 'registry' || target.centerTargetSpec !== `${CENTER_PACKAGE}@next`
    || target.launcherKind !== 'registry-installed' || target.sourceCommit !== null) {
    fail('ALPHA-P0-ORDINARY-TARGET', 'ordinary-user receipt does not bind the standard registry installation path')
  }
  const provenance = protectedRun(receipt.actionsProvenance, null)
  const cloned = structuredClone(receipt)
  cloned.status = 'running'
  cloned.laneStatus = 'not-proven'
  cloned.productCoverage.skillLifecycle = 'running'
  cloned.receiptDigest = null
  markPassed(cloned, {
    mode: 'registry',
    dshVersion: DEFAULT_DSH_VERSION,
    center: { initial: { kind: 'registry' }, target: { kind: 'registry' } },
    expectedCenterTarget: null,
    launcher: { kind: 'registry-installed' },
    actionsProvenance: receipt.actionsProvenance,
  })
  if (!verifyActionsArtifactEvidence(receipt, actionsEvidence)) {
    fail('ALPHA-P0-ORDINARY-ARTIFACT', 'ordinary-user receipt is not bound to its Actions artifact')
  }
  const expectedActions = createActionsArtifactEvidence(receipt, actionsEvidence.artifact)
  if (canonicalJson(expectedActions) !== canonicalJson(actionsEvidence)) {
    fail('ALPHA-P0-ORDINARY-ARTIFACT', 'ordinary-user Actions evidence has extra or changed fields')
  }
  const dsh = exactPublishedPackage(receipt.observations?.registry?.dsh, '@deepseek-ai/dsh')
  const center = exactPublishedPackage(receipt.observations?.registry?.centerTarget, CENTER_PACKAGE)
  const afterInstall = exactPublishedPackage(
    receipt.observations?.registry?.centerTargetAfterInstall,
    CENTER_PACKAGE,
  )
  if (dsh.version !== DEFAULT_DSH_VERSION || center.version !== ALPHA_P0_CENTER_VERSION
    || canonicalJson(center) !== canonicalJson(afterInstall)
    || target.expectedCenterTargetVersion !== null && target.expectedCenterTargetVersion !== center.version
    || target.expectedCenterTargetIntegrity !== null && target.expectedCenterTargetIntegrity !== center.integrity) {
    fail('ALPHA-P0-ORDINARY-REGISTRY', 'ordinary-user registry observations do not bind the exact target packages')
  }
  const discovery = receipt.observations?.management?.discovery
  if (!Number.isSafeInteger(discovery?.catalogRevision) || discovery.catalogRevision < 1
    || !SHA256.test(discovery.catalogEntriesDigest ?? '')) {
    fail('ALPHA-P0-ORDINARY-CATALOG', 'ordinary-user Skill lane omitted its signed catalog revision')
  }
  return {
    proofStatus: 'externally-unverified',
    acceptanceId: receipt.acceptanceId,
    schemaVersion: receipt.schemaVersion,
    receiptDigest: receipt.receiptDigest,
    run: provenance,
    artifactDigest: actionsEvidence.artifact.digest,
    dsh: {
      packageName: '@deepseek-ai/dsh',
      version: dsh.version,
      sourceCommit: ALPHA_P0_DSH_COMMIT,
      registry: NPM_REGISTRY,
      integrity: dsh.integrity,
    },
    center: { packageName: CENTER_PACKAGE, version: center.version, integrity: center.integrity },
    catalog: { revision: discovery.catalogRevision, entriesDigest: discovery.catalogEntriesDigest },
  }
}

function verifyNpmLane(receipt) {
  const verified = verifyAlphaNpmProvenanceReceipt(receipt)
  if (verified.package.version !== ALPHA_P0_CENTER_VERSION) {
    fail('ALPHA-P0-NPM-VERSION', 'npm provenance receipt does not select the exact Center alpha')
  }
  return {
    proofStatus: 'externally-unverified',
    acceptanceId: 'DSH-CENTER-NPM-PROVENANCE',
    schemaVersion: 1,
    receiptDigest: verified.receiptDigest,
    run: {
      repository: REPOSITORY,
      workflow: '.github/workflows/npm-publish.yml',
      ref: 'refs/heads/main',
      commit: verified.sourceCommit,
      runId: verified.verification.runId,
      runAttempt: verified.verification.runAttempt,
    },
    artifactDigest: verified.package.tarballSha256,
    center: {
      packageName: verified.package.name,
      version: verified.package.version,
      integrity: verified.package.integrity,
      tarballSha256: verified.package.tarballSha256,
      sourceCommit: verified.sourceCommit,
      provenanceBundleDigest: verified.provenanceBundleDigest,
    },
  }
}

function verifyCatalogLane(receipt) {
  if (receipt?.acceptanceId === 'P0-OFFICIAL-ALPHA-WIKI-SKILL-LIFECYCLE') {
    const value = assertSecretFreeAlphaLifecycleReceipt(receipt)
    return {
      proofStatus: 'development-only',
      acceptanceId: value.acceptanceId,
      schemaVersion: value.schemaVersion,
      receiptDigest: value.receiptDigest,
      run: {
        repository: value.run.repository,
        workflow: value.run.workflow,
        ref: value.run.ref,
        commit: value.run.commit,
        runId: String(value.run.runId),
        runAttempt: String(value.run.runAttempt),
      },
      artifactDigest: null,
      developmentCatalog: {
        revision: value.target.catalogRevision,
        documentDigest: value.target.catalogDocumentDigest,
        entriesDigest: value.target.catalogEntriesDigest,
      },
    }
  }
  const value = exactReceipt(receipt, 'P0-ALPHA-SIGNED-CATALOG-ACTIVATION', [
    'artifact', 'deployment', 'document', 'product', 'run',
  ])
  const product = verifyProduct(value.product, false)
  const run = protectedRun(value.run, CUSTOM_WORKFLOWS.catalog)
  const artifact = actionsArtifact(value.artifact, run, 'alpha-catalog-activation')
  const document = exactRecord(value.document, 'signed catalog document', ['envelope', 'signatures'])
  const deployment = exactRecord(value.deployment, 'catalog deployment', [
    'bytesSha256', 'candidateKinds', 'contentType', 'documentDigest', 'entriesDigest',
    'httpStatus', 'keyIds', 'observedAt', 'redirected', 'revision', 'runtimeRefresh',
    'signatureSetDigest', 'signatureThresholdVerified', 'sizeBytes', 'successorKinds', 'url',
  ])
  const observedAt = canonicalTimestamp(deployment.observedAt, 'catalog deployment observation')
  const verified = verifyCatalog(
    BOOTSTRAP_CATALOG_ROOT,
    document.envelope,
    document.signatures,
    Date.parse(observedAt),
  )
  const bytes = Buffer.from(`${canonicalJson(document)}\n`, 'utf8')
  const candidateKinds = [...new Set(document.envelope.entries.map(entry => entry.kind))].sort()
  const successorKinds = successorKindsForAlpha(document.envelope.entries)
  if (deployment.url !== 'https://striveh.github.io/dsh-plugin-extension-center/plugins.json'
    || deployment.httpStatus !== 200 || deployment.redirected !== false
    || deployment.contentType !== 'application/json'
    || deployment.bytesSha256 !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    || deployment.signatureSetDigest !== canonicalSha256(document.signatures)
    || deployment.sizeBytes !== bytes.byteLength || deployment.revision < 12
    || deployment.signatureThresholdVerified !== true
    || canonicalJson(candidateKinds) !== canonicalJson(['mcp', 'plugin', 'skill'])
    || canonicalJson(deployment.candidateKinds) !== canonicalJson(['plugin', 'mcp', 'skill'])
    || canonicalJson(successorKinds) !== canonicalJson(['plugin', 'mcp', 'skill'])
    || canonicalJson(deployment.successorKinds) !== canonicalJson(successorKinds)
    || deployment.revision !== product.catalog.revision
    || deployment.revision !== document.envelope.revision
    || deployment.documentDigest !== product.catalog.documentDigest
    || deployment.documentDigest !== canonicalSha256(document)
    || deployment.entriesDigest !== product.catalog.entriesDigest
    || deployment.entriesDigest !== document.envelope.entriesDigest
    || canonicalJson(deployment.keyIds) !== canonicalJson(verified.keyIds)) {
    fail('ALPHA-P0-CATALOG-DEPLOYMENT', 'signed catalog deployment does not cover all three successor lanes')
  }
  const refresh = exactRecord(deployment.runtimeRefresh, 'catalog runtime refresh', [
    'degraded', 'entriesDigest', 'freshness', 'revision', 'signatureStatus', 'source',
  ])
  if (refresh.source !== 'remote' || refresh.freshness !== 'fresh' || refresh.degraded !== false
    || refresh.signatureStatus !== 'verified' || refresh.revision !== product.catalog.revision
    || refresh.entriesDigest !== product.catalog.entriesDigest) {
    fail('ALPHA-P0-CATALOG-REFRESH', 'official runtime did not consume the exact signed catalog deployment')
  }
  return {
    ...value,
    proofStatus: 'externally-unverified',
    run,
    artifactDigest: artifact.digest,
    product,
  }
}

function verifyLifecycleLane(receipt, kind) {
  const acceptanceId = kind === 'plugin' ? 'P0-ALPHA-PLUGIN-UI-LIFECYCLE' : 'P0-ALPHA-MCP-UI-LIFECYCLE'
  const value = exactReceipt(receipt, acceptanceId, [
    'artifact', 'extensionKind', 'finalState', 'product', 'providerEvidence', 'run', 'sequence',
  ])
  if (value.extensionKind !== kind) fail(`ALPHA-P0-${kind.toUpperCase()}-KIND`, 'lifecycle kind changed')
  const product = verifyProduct(value.product, false)
  const run = protectedRun(value.run, CUSTOM_WORKFLOWS[kind])
  const artifact = actionsArtifact(value.artifact, run, `alpha-${kind}-lifecycle`)
  verifyProviderEvidence(value.providerEvidence, kind)
  const operations = verifyLifecycleSequence(value.sequence, kind)
  const finalState = exactRecord(value.finalState, `${kind} final state`, [
    'installActionAvailable', 'inventoryRevision', 'managedBytesAbsent', 'ownerStateDigest',
    'rollback', 'targetKey', 'tombstoneRetained',
  ])
  const last = operations.at(-1)
  if (finalState.installActionAvailable !== true || finalState.managedBytesAbsent !== true
    || finalState.rollback !== 'unavailable' || finalState.tombstoneRetained !== true
    || finalState.inventoryRevision !== last.inventoryRevision || finalState.ownerStateDigest !== last.ownerStateDigest
    || finalState.targetKey !== last.targetKey) {
    fail(`ALPHA-P0-${kind.toUpperCase()}-FINAL`, 'lifecycle final state is not a purged recoverability tombstone')
  }
  return {
    ...value,
    proofStatus: 'externally-unverified',
    run,
    artifactDigest: artifact.digest,
    product,
  }
}

function verifyAgentLane(receipt) {
  const value = exactReceipt(receipt, 'P0-ALPHA-AGENT-CAPABILITY-ACQUISITION-CONTINUATION', [
    'artifact', 'product', 'run', 'session',
  ])
  const product = verifyProduct(value.product, false)
  const run = protectedRun(value.run, CUSTOM_WORKFLOWS.agent)
  const artifact = actionsArtifact(value.artifact, run, 'alpha-agent-acquisition')
  const session = exactRecord(value.session, 'Agent acquisition session', [
    'acquiredRuntimeEvidenceDigest', 'approvalDriver', 'continuationClaimDigest',
    'continuationCount', 'continuationIdDigest', 'historyDigest', 'humanApprovalObserved',
    'needDigest', 'operationReceiptDigest', 'originalMessageCount', 'originalMessageDigest',
    'originalTaskCompleted', 'planHash', 'sameSession', 'selectedCandidateRef', 'sessionIdDigest',
    'skillResultDigest', 'toolNames', 'usedExtensionKind',
  ])
  for (const field of [
    'acquiredRuntimeEvidenceDigest', 'continuationClaimDigest', 'continuationIdDigest', 'historyDigest',
    'needDigest', 'operationReceiptDigest', 'originalMessageDigest', 'planHash', 'sessionIdDigest',
    'skillResultDigest',
  ]) requireSha256(session[field], `Agent ${field}`)
  if (session.approvalDriver !== 'playwright-accessible-ui' || session.humanApprovalObserved !== true
    || session.sameSession !== true || session.originalMessageCount !== 1 || session.continuationCount !== 1
    || session.originalTaskCompleted !== true || session.usedExtensionKind !== 'skill'
    || !BOUNDED_ID.test(session.selectedCandidateRef ?? '') || !session.selectedCandidateRef.startsWith('skill:')
    || canonicalJson(session.toolNames) !== canonicalJson([
      'extension_center_resolve', 'extension_center_request_acquisition', 'skill',
    ])) {
    fail('ALPHA-P0-AGENT-SEQUENCE', 'Agent lane omitted capability gap, authorization, use, or same-task continuation')
  }
  return {
    ...value,
    proofStatus: 'externally-unverified',
    run,
    artifactDigest: artifact.digest,
    product,
  }
}

function verifyLifecycleSequence(value, kind) {
  if (!Array.isArray(value) || value.length !== LIFECYCLE_SEQUENCE.length) {
    fail(`ALPHA-P0-${kind.toUpperCase()}-SEQUENCE`, 'lifecycle must contain the exact seven operations')
  }
  const operations = value.map((entry, index) => {
    const operation = exactRecord(entry, `${kind} operation ${String(index + 1)}`, [
      'candidateRef', 'configurationRevision', 'decision', 'inventoryRevision', 'journalHeadDigest',
      'materialDigest', 'operationId', 'operationKind', 'ownerRevision', 'ownerStateDigest',
      'ownerStateVerified', 'planHash', 'receiptDigest', 'sequence', 'targetKey', 'terminalStatus',
      'userInterface',
    ])
    const ui = exactRecord(operation.userInterface, `${kind} operation UI`, [
      'actionObserved', 'approvalObserved', 'completionObserved', 'planReviewObserved',
    ])
    if (operation.sequence !== index + 1 || operation.operationKind !== LIFECYCLE_SEQUENCE[index]
      || operation.decision !== 'approve' || operation.terminalStatus !== 'committed'
      || operation.ownerStateVerified !== true || Object.values(ui).some(item => item !== true)
      || !BOUNDED_ID.test(operation.candidateRef ?? '') || !operation.candidateRef.startsWith(`${kind}:`)
      || !BOUNDED_ID.test(operation.targetKey ?? '') || !BOUNDED_ID.test(operation.operationId ?? '')
      || !BOUNDED_ID.test(operation.ownerRevision ?? '')) {
      fail(`ALPHA-P0-${kind.toUpperCase()}-SEQUENCE`, `operation ${String(index + 1)} is incomplete`)
    }
    for (const field of [
      'inventoryRevision', 'journalHeadDigest', 'materialDigest', 'ownerStateDigest', 'planHash', 'receiptDigest',
    ]) requireSha256(operation[field], `${kind} operation ${field}`)
    if (operation.configurationRevision !== null) {
      requireSha256(operation.configurationRevision, `${kind} operation configurationRevision`)
    }
    return operation
  })
  const initialRef = operations[0].candidateRef
  const updateRef = operations[2].candidateRef
  const configuration = operations[1].configurationRevision
  if (operations[1].candidateRef !== initialRef || updateRef === initialRef
    || operations.slice(2).some(item => item.candidateRef !== updateRef)
    || operations.some(item => item.targetKey !== operations[0].targetKey)
    || operations[0].configurationRevision === null || configuration === null
    || operations[0].configurationRevision === configuration
    || operations[2].configurationRevision !== configuration
    || operations[4].configurationRevision !== configuration
    || [3, 5, 6].some(index => operations[index].configurationRevision !== null)
    || new Set(operations.map(item => item.operationId)).size !== operations.length
    || new Set(operations.map(item => item.receiptDigest)).size !== operations.length
    || new Set(operations.map(item => item.inventoryRevision)).size !== operations.length) {
    fail(`ALPHA-P0-${kind.toUpperCase()}-SEQUENCE`, 'lifecycle successor, configuration, or durable identity binding is invalid')
  }
  return operations
}

function verifyProviderEvidence(value, kind) {
  if (kind === 'plugin') {
    const evidence = exactRecord(value, 'Plugin provider evidence', [
      'loaderConsumerVerified', 'officialCliWritesProfile', 'officialDshPackageTreeUnchanged',
      'recoveryReceiptDigest', 'restartObserved',
    ])
    requireSha256(evidence.recoveryReceiptDigest, 'Plugin recovery receipt digest')
    if (evidence.officialCliWritesProfile !== true || evidence.loaderConsumerVerified !== true
      || evidence.restartObserved !== true || evidence.officialDshPackageTreeUnchanged !== true) {
      fail('ALPHA-P0-PLUGIN-PROVIDER', 'Plugin lifecycle omitted official CLI, restart, or recovery proof')
    }
    return
  }
  const evidence = exactRecord(value, 'MCP provider evidence', [
    'descriptorDigest', 'executableDigest', 'externalPackageManagedByCenter', 'generationDigest',
    'initializeDigest', 'runtimePreprovisioned', 'secretsAbsent', 'toolsListDigest',
  ])
  for (const field of [
    'descriptorDigest', 'executableDigest', 'generationDigest', 'initializeDigest', 'toolsListDigest',
  ]) requireSha256(evidence[field], `MCP ${field}`)
  if (evidence.runtimePreprovisioned !== true || evidence.secretsAbsent !== true
    || evidence.externalPackageManagedByCenter !== false) {
    fail('ALPHA-P0-MCP-PROVIDER', 'MCP lifecycle changed the preprovisioned-runtime ownership limit')
  }
}

function successorKindsForAlpha(entries) {
  const result = []
  for (const kind of ['plugin', 'mcp', 'skill']) {
    const groups = new Map()
    for (const entry of entries.filter(candidate => candidate.kind === kind)) {
      const group = groups.get(entry.name) ?? []
      group.push(entry)
      groups.set(entry.name, group)
    }
    const hasSuccessor = [...groups.values()].some(group => group.length >= 2
      && new Set(group.map(entry => entry.candidateRef)).size === group.length
      && new Set(group.map(entry => entry.artifact.version)).size === group.length
      && group.every(entry => entry.compatibility?.status === 'compatible'
        && entry.compatibility?.dsh === DEFAULT_DSH_VERSION
        && ['install', 'configure', 'update', 'uninstall', 'restore']
          .every(action => entry.lifecycle?.[action]?.status === 'available')))
    if (hasSuccessor) result.push(kind)
  }
  return result
}

function exactReceipt(value, acceptanceId, bodyFields) {
  const receipt = exactRecord(value, acceptanceId, [
    'acceptanceId', ...bodyFields, 'laneStatus', 'receiptDigest', 'schemaVersion', 'status',
  ])
  const { receiptDigest, ...body } = receipt
  if (receipt.schemaVersion !== 1 || receipt.acceptanceId !== acceptanceId
    || receipt.status !== 'passed' || receipt.laneStatus !== 'proven'
    || !SHA256.test(receiptDigest ?? '') || receiptDigest !== canonicalSha256(body)) {
    fail('ALPHA-P0-LANE-RECEIPT', `${acceptanceId} identity or self-digest is invalid`)
  }
  return receipt
}

function verifyProduct(value, nullable) {
  const product = exactRecord(value, 'alpha product identity', ['catalog', 'center', 'officialDsh'])
  const dsh = exactRecord(product.officialDsh, 'official DSH identity', [
    'integrity', 'packageName', 'registry', 'sourceCommit', 'version',
  ])
  const center = exactRecord(product.center, 'Center package identity', [
    'integrity', 'packageName', 'sourceCommit', 'tarballSha256', 'version',
  ])
  const catalog = exactRecord(product.catalog, 'catalog identity', [
    'catalogId', 'documentDigest', 'entriesDigest', 'revision',
  ])
  if (dsh.packageName !== '@deepseek-ai/dsh' || dsh.version !== DEFAULT_DSH_VERSION
    || dsh.sourceCommit !== ALPHA_P0_DSH_COMMIT || dsh.registry !== NPM_REGISTRY
    || center.packageName !== CENTER_PACKAGE || center.version !== ALPHA_P0_CENTER_VERSION
    || catalog.catalogId !== ALPHA_P0_CATALOG_ID) {
    fail('ALPHA-P0-PRODUCT-IDENTITY', 'product identity does not select the exact alpha target')
  }
  for (const [candidate, label] of [
    [dsh.integrity, 'official DSH integrity'],
    [center.integrity, 'Center integrity'],
  ]) {
    if (candidate !== null && !SRI.test(candidate ?? '') || candidate === null && !nullable) {
      fail('ALPHA-P0-PRODUCT-IDENTITY', `${label} is invalid`)
    }
  }
  if (center.sourceCommit !== null && !COMMIT.test(center.sourceCommit ?? '')
    || center.sourceCommit === null && !nullable
    || center.tarballSha256 !== null && !SHA256.test(center.tarballSha256 ?? '')
    || center.tarballSha256 === null && !nullable
    || catalog.revision !== null && (!Number.isSafeInteger(catalog.revision) || catalog.revision < 1)
    || catalog.revision === null && !nullable
    || catalog.documentDigest !== null && !SHA256.test(catalog.documentDigest ?? '')
    || catalog.documentDigest === null && !nullable
    || catalog.entriesDigest !== null && !SHA256.test(catalog.entriesDigest ?? '')
    || catalog.entriesDigest === null && !nullable) {
    fail('ALPHA-P0-PRODUCT-IDENTITY', 'Center or catalog immutable identity is invalid')
  }
  return product
}

function productProjection(ordinary, provenance, catalog, plugin, mcp, agent) {
  const productEvidence = [catalog, plugin, mcp, agent]
    .find(item => item.status === 'proven' && item.value?.product !== undefined)?.value.product
  const product = {
    officialDsh: {
      packageName: '@deepseek-ai/dsh',
      version: DEFAULT_DSH_VERSION,
      sourceCommit: ALPHA_P0_DSH_COMMIT,
      registry: NPM_REGISTRY,
      integrity: ordinary.value?.dsh.integrity ?? productEvidence?.officialDsh.integrity ?? null,
    },
    center: {
      packageName: CENTER_PACKAGE,
      version: ALPHA_P0_CENTER_VERSION,
      integrity: provenance.value?.center.integrity
        ?? ordinary.value?.center.integrity
        ?? productEvidence?.center.integrity
        ?? null,
      tarballSha256: provenance.value?.center.tarballSha256 ?? productEvidence?.center.tarballSha256 ?? null,
      sourceCommit: provenance.value?.center.sourceCommit ?? productEvidence?.center.sourceCommit ?? null,
    },
    catalog: {
      catalogId: ALPHA_P0_CATALOG_ID,
      revision: catalog.status === 'proven'
        ? catalog.value.product.catalog.revision
        : productEvidence?.catalog.revision ?? ordinary.value?.catalog.revision ?? null,
      documentDigest: catalog.status === 'proven'
        ? catalog.value.product.catalog.documentDigest
        : productEvidence?.catalog.documentDigest ?? null,
      entriesDigest: catalog.status === 'proven'
        ? catalog.value.product.catalog.entriesDigest
        : productEvidence?.catalog.entriesDigest ?? ordinary.value?.catalog.entriesDigest ?? null,
    },
  }
  verifyProduct(product, true)
  return product
}

function protectedRun(value, workflow) {
  const run = exactRecord(value, 'protected workflow run', [
    'commit', 'eventName', 'ref', 'refProtected', 'repository', 'repositoryId', 'runAttempt',
    'runId', 'workflowFile', 'workflowRef',
  ])
  if (run.repository !== REPOSITORY || run.ref !== 'refs/heads/main' || run.refProtected !== true
    || run.eventName !== 'workflow_dispatch' || workflow !== null && run.workflowFile !== workflow
    || run.workflowRef !== `${REPOSITORY}/${run.workflowFile}@refs/heads/main`
    || !COMMIT.test(run.commit ?? '') || !GITHUB_NUMBER.test(run.runId ?? '')
    || !GITHUB_NUMBER.test(run.runAttempt ?? '') || !GITHUB_NUMBER.test(run.repositoryId ?? '')) {
    fail('ALPHA-P0-PROTECTED-RUN', 'evidence does not name one exact protected-main workflow dispatch')
  }
  return {
    repository: run.repository,
    workflow: run.workflowFile,
    ref: run.ref,
    commit: run.commit,
    runId: run.runId,
    runAttempt: run.runAttempt,
  }
}

function actionsArtifact(value, run, prefix) {
  const artifact = exactRecord(value, 'Actions artifact', ['digest', 'id', 'name'])
  const expectedName = `${prefix}-${run.commit}-attempt-${run.runAttempt}`
  if (!ARTIFACT_NAME.test(artifact.name ?? '') || artifact.name !== expectedName
    || !GITHUB_NUMBER.test(artifact.id ?? '') || !SHA256.test(artifact.digest ?? '')) {
    fail('ALPHA-P0-ACTIONS-ARTIFACT', 'Actions artifact does not bind the workflow invocation')
  }
  return artifact
}

function exactPublishedPackage(value, label) {
  const item = exactRecord(value, `${label} registry observation`, ['integrity', 'status', 'version'])
  if (item.status !== 'published' || !SRI.test(item.integrity ?? '')) {
    fail('ALPHA-P0-REGISTRY-PACKAGE', `${label} is not an immutable public registry package`)
  }
  return item
}

function protectedCoordinates(value) {
  return value !== undefined && value !== null && COMMIT.test(value.run?.commit ?? '')
    && GITHUB_NUMBER.test(value.run?.runId ?? '') && GITHUB_NUMBER.test(value.run?.runAttempt ?? '')
    && SHA256.test(value.artifactDigest ?? '')
}

function sameProduct(left, right) {
  try {
    return canonicalJson(verifyProduct(left, false)) === canonicalJson(verifyProduct(right, false))
  } catch {
    return false
  }
}

function lane(code, inputs, verifier) {
  if (inputs.some(value => value === null || value === undefined)) {
    return { status: 'missing', code: `${code}-MISSING`, value: null }
  }
  try {
    const value = verifier()
    const status = value.proofStatus ?? 'proven'
    return {
      status,
      code: status === 'development-only'
        ? `${code}-DEVELOPMENT-ONLY-SCHEMA-${String(value.schemaVersion)}`
        : status === 'externally-unverified'
          ? `${code}-EXTERNALLY-UNVERIFIED`
          : `${code}-PROVEN`,
      value,
    }
  } catch {
    return { status: 'invalid', code: `${code}-INVALID`, value: null }
  }
}

function publicLane(item) {
  const proven = item.status === 'proven'
  const identified = proven
    || item.status === 'development-only'
    || item.status === 'externally-unverified'
  return {
    status: item.status,
    code: item.code,
    schemaVersion: identified ? item.value?.schemaVersion ?? null : null,
    acceptanceId: identified ? item.value?.acceptanceId ?? null : null,
    receiptDigest: identified ? item.value?.receiptDigest ?? null : null,
    workflow: identified ? item.value?.run?.workflow ?? null : null,
    commit: identified ? item.value?.run?.commit ?? null : null,
    runId: identified ? item.value?.run?.runId ?? null : null,
    runAttempt: identified ? item.value?.run?.runAttempt ?? null : null,
    artifactDigest: proven ? item.value?.artifactDigest ?? null : null,
  }
}

function verifyPublicLane(value, label) {
  const lane = exactRecord(value, label, [
    'acceptanceId', 'artifactDigest', 'code', 'commit', 'receiptDigest', 'runAttempt',
    'runId', 'schemaVersion', 'status', 'workflow',
  ])
  if (![
    'proven', 'development-only', 'externally-unverified', 'missing', 'invalid', 'unbound',
  ].includes(lane.status)
    || !BOUNDED_ID.test(lane.code ?? '')) {
    fail('ALPHA-P0-COMPOSITE-SCHEMA', `${label} status or code is invalid`)
  }
  const coordinates = [
    lane.acceptanceId, lane.artifactDigest, lane.commit, lane.receiptDigest,
    lane.runAttempt, lane.runId, lane.schemaVersion, lane.workflow,
  ]
  if (lane.status === 'proven') {
    if (!Number.isSafeInteger(lane.schemaVersion) || lane.schemaVersion < 1
      || !BOUNDED_ID.test(lane.acceptanceId ?? '') || !SHA256.test(lane.artifactDigest ?? '')
      || !COMMIT.test(lane.commit ?? '') || !SHA256.test(lane.receiptDigest ?? '')
      || !GITHUB_NUMBER.test(lane.runAttempt ?? '') || !GITHUB_NUMBER.test(lane.runId ?? '')
      || typeof lane.workflow !== 'string' || !lane.workflow.startsWith('.github/workflows/')) {
      fail('ALPHA-P0-COMPOSITE-SCHEMA', `${label} proven coordinates are incomplete`)
    }
  } else if (lane.status === 'development-only') {
    if (lane.schemaVersion !== 2 || lane.acceptanceId !== 'P0-OFFICIAL-ALPHA-WIKI-SKILL-LIFECYCLE'
      || lane.artifactDigest !== null || !COMMIT.test(lane.commit ?? '')
      || !SHA256.test(lane.receiptDigest ?? '') || !GITHUB_NUMBER.test(lane.runAttempt ?? '')
      || !GITHUB_NUMBER.test(lane.runId ?? '')
      || lane.workflow !== '.github/workflows/official-alpha-wiki-lifecycle.yml') {
      fail('ALPHA-P0-COMPOSITE-SCHEMA', `${label} development evidence is invalid`)
    }
  } else if (lane.status === 'externally-unverified') {
    if (!Number.isSafeInteger(lane.schemaVersion) || lane.schemaVersion < 1
      || !BOUNDED_ID.test(lane.acceptanceId ?? '') || lane.artifactDigest !== null
      || !COMMIT.test(lane.commit ?? '') || !SHA256.test(lane.receiptDigest ?? '')
      || !GITHUB_NUMBER.test(lane.runAttempt ?? '') || !GITHUB_NUMBER.test(lane.runId ?? '')
      || typeof lane.workflow !== 'string' || !lane.workflow.startsWith('.github/workflows/')) {
      fail('ALPHA-P0-COMPOSITE-SCHEMA', `${label} externally unverified coordinates are invalid`)
    }
  } else if (coordinates.some(value => value !== null)) {
    fail('ALPHA-P0-COMPOSITE-SCHEMA', `${label} unproven coordinates must remain null`)
  }
  return lane
}

function binding(...values) {
  const result = values.at(-1)
  const lanes = values.slice(0, -1)
  return lanes.every(item => item.status === 'proven') && result === true
}

function exactRecord(value, label, fields) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('ALPHA-P0-SCHEMA', `${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail('ALPHA-P0-SCHEMA', `${label} fields are not its exact schema`)
  }
  return value
}

function requireSha256(value, label) {
  if (!SHA256.test(value ?? '')) fail('ALPHA-P0-DIGEST', `${label} is not canonical SHA-256`)
  return value
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    fail('ALPHA-P0-TIMESTAMP', `${label} is not canonical`)
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail('ALPHA-P0-TIMESTAMP', `${label} is not canonical`)
  }
  return value
}

function sameList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
}

function fail(code, message) {
  throw new AlphaP0CompositeFailure(code, message)
}

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
