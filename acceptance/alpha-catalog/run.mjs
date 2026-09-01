#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:https'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { verifyCatalog } from '../../lib/catalog.js'
import { BOOTSTRAP_CATALOG_ROOT } from '../../lib/catalog-data.js'
import {
  canonicalSha256,
  verifyImmutablePlanDigest,
  verifyOperationReceiptJournal,
  verifyTerminalReceiptPlanBinding,
} from '../full-p0/receipt-binding.mjs'
import { parseCatalogListEnvelope } from '../full-p0/support.mjs'
import { selectAlphaWikiPair } from '../ordinary-user/support.mjs'
import { isAdmittedBrowserRequest, isAdmittedBrowserWebSocket, stopChild } from '../store-only/support.mjs'
import {
  AlphaLifecycleFailure,
  CENTER_REPOSITORY,
  DSH_COMMIT,
  DSH_TAG,
  DSH_VERSION,
  LIFECYCLE_WORKFLOW,
  WIKI_V1_REF,
  WIKI_V2_REF,
  createAlphaLifecycleReceipt,
  parseAlphaLifecycleArguments,
  writeAlphaLifecycleReceipt,
} from './support.mjs'

const PROFILE_ID = 'web'
const PACKAGE_NAME = 'dsh-plugin-extension-center'
const CONFIGURATION_INITIAL = Object.freeze({ modelInvocable: true, userInvocable: true, projectRoot: null })
const CONFIGURATION_CONFIGURED = Object.freeze({ modelInvocable: true, userInvocable: false, projectRoot: null })
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const BLOCKED_ENVIRONMENT_KEY = /(?:^|_)(?:ACCESS_KEY|API_KEY|AUTH|COOKIE|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/iu

/** Run the exact official-alpha development lifecycle and write a receipt only after every observation passes. */
export async function runAlphaCatalogLifecycle(config) {
  let temporaryRoot
  let host
  let catalogServer
  let browserSession
  try {
    assertGithubInvocation(config)
    const dshSourceRoot = await realpath(config.dshSourceRoot)
    const centerSourceRoot = await realpath(config.centerSourceRoot)
    await assertCenterSource(centerSourceRoot, config.centerCommit)
    const officialTreeBefore = await assertOfficialDshSource(dshSourceRoot)
    const catalogInput = await readLifecycleCatalog(config.catalogPath, config.catalogEvidencePath)

    temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-alpha-wiki-lifecycle-')))
    const dshHome = join(temporaryRoot, 'dsh-home')
    const agentsHome = join(temporaryRoot, 'agents-home')
    const workspace = join(temporaryRoot, 'workspace')
    const packageRoot = join(temporaryRoot, 'center-package')
    const npmConfig = join(temporaryRoot, 'npmrc')
    await Promise.all([
      mkdir(dshHome, { mode: 0o700 }),
      mkdir(agentsHome, { mode: 0o700 }),
      mkdir(workspace, { mode: 0o700 }),
      mkdir(packageRoot, { mode: 0o700 }),
      writeFile(npmConfig, 'registry=https://registry.npmjs.org/\nignore-scripts=true\n', { flag: 'wx', mode: 0o600 }),
    ])
    const environment = isolatedEnvironment({
      dshHome,
      agentsHome,
      npmConfig,
      tlsCertificatePath: config.tlsCertificatePath,
    })
    const archive = await packExactCenter(centerSourceRoot, packageRoot, environment)
    const centerPackageDigest = `sha256:${createHash('sha256').update(
      await boundedRegularFile(archive, 64 * 1024 * 1024, 'Center package archive'),
    ).digest('hex')}`
    await runDsh(
      dshSourceRoot,
      ['plugin', '--profile', PROFILE_ID, 'add', archive, '--ignore-scripts', '--save-exact'],
      workspace,
      environment,
      240_000,
      'ALPHA-LIFECYCLE-CENTER-INSTALL',
    )
    await assertInstalledCenter(join(dshHome, 'profiles', PROFILE_ID), config.centerCommit)

    const catalogBytes = await boundedRegularFile(config.catalogPath, 32 * 1024 * 1024, 'catalog document')
    catalogServer = await startCatalogServer(
      catalogBytes,
      config.tlsCertificatePath,
      config.tlsPrivateKeyPath,
    )
    const overlay = join(temporaryRoot, 'development-catalog.patch.yml')
    const officialCliEntrypoint = join(dshSourceRoot, 'apps', 'cli', 'lib', 'bin.js')
    const officialDshEntrypointDigest = `sha256:${createHash('sha256').update(
      await boundedRegularFile(officialCliEntrypoint, 8 * 1024 * 1024, 'built official DSH CLI entrypoint'),
    ).digest('hex')}`
    await writeFile(overlay, developmentOverlay(catalogServer.url, officialCliEntrypoint), { flag: 'wx', mode: 0o600 })
    host = await startOfficialWeb(dshSourceRoot, workspace, environment, overlay)
    browserSession = await openAuthenticatedBrowserSession(host.launchUrl)
    const lifecycle = await runWikiLifecycle(host.origin, browserSession.page, dshHome, catalogInput)
    requireCondition(host.child.exitCode === null && host.child.signalCode === null,
      'ALPHA-LIFECYCLE-HOST-EXIT', 'official Web Host exited during the lifecycle')
    requireCondition(catalogServer.requests === 1,
      'ALPHA-LIFECYCLE-CATALOG-FETCH', 'Host did not fetch the one exact temporary catalog resource once')
    await closeBrowserSession(browserSession)
    browserSession = undefined
    await stopChild(host.child)
    host = undefined
    await stopCatalogServer(catalogServer)
    catalogServer = undefined

    const officialTreeAfter = await trackedSourceTreeDigest(dshSourceRoot)
    await assertTrackedTreeClean(dshSourceRoot, 'official DSH')
    requireCondition(officialTreeAfter === officialTreeBefore,
      'ALPHA-LIFECYCLE-DSH-MODIFIED', 'official DSH tracked source tree changed during the lifecycle')
    await assertCenterSource(centerSourceRoot, config.centerCommit)
    const receipt = createAlphaLifecycleReceipt({
      centerCommit: config.centerCommit,
      runId: config.runId,
      runAttempt: config.runAttempt,
      officialDshSourceUnmodified: true,
      officialDshSourceTreeDigest: officialTreeBefore,
      officialDshEntrypointDigest,
      centerPackageDigest,
      activeCandidateAbsent: lifecycle.activeCandidateAbsent,
      catalog: catalogInput.coordinates,
      operations: lifecycle.operations,
    })
    await writeAlphaLifecycleReceipt(config.receiptPath, receipt)
    process.stdout.write(`passed: ${receipt.acceptanceId}; p0Status=${receipt.p0Status}; receiptDigest=${receipt.receiptDigest}\n`)
    return receipt
  } finally {
    await closeBrowserSession(browserSession).catch(() => undefined)
    await stopChild(host?.child).catch(() => undefined)
    await stopCatalogServer(catalogServer).catch(() => undefined)
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function readLifecycleCatalog(catalogPath, evidencePath) {
  const [catalogBytes, evidenceBytes] = await Promise.all([
    boundedRegularFile(catalogPath, 32 * 1024 * 1024, 'catalog document'),
    boundedRegularFile(evidencePath, 4 * 1024 * 1024, 'catalog evidence'),
  ])
  const catalog = parseJson(catalogBytes, 'catalog document')
  const evidence = parseJson(evidenceBytes, 'catalog evidence')
  let verified
  try {
    verified = verifyCatalog(BOOTSTRAP_CATALOG_ROOT, catalog.envelope, catalog.signatures, Date.now())
  } catch (cause) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-CATALOG', 'temporary catalog signature or validity failed', cause)
  }
  const documentDigest = canonicalSha256(catalog)
  const entriesDigest = catalog.envelope?.entriesDigest
  const pair = selectAlphaWikiPair(catalog.envelope?.entries, DSH_VERSION)
  requireCondition(catalog.envelope?.revision === 12 && verified.envelope.revision === 12
    && Array.isArray(catalog.envelope.entries) && catalog.envelope.entries.length === 2
    && pair?.initial.candidateRef === WIKI_V1_REF && pair.update.candidateRef === WIKI_V2_REF,
  'ALPHA-LIFECYCLE-CATALOG', 'temporary catalog did not contain the exact alpha Wiki successor pair')
  requireCondition(evidence?.schemaVersion === 1
    && evidence.kind === 'official-dsh-alpha-ephemeral-lifecycle-catalog'
    && evidence.status === 'development-only'
    && sameList(evidence.notProven, [
      'catalog-admission',
      'public-github-artifact-installation',
      'public-catalog-deployment',
    ])
    && evidence.targetDsh?.version === DSH_VERSION
    && evidence.targetDsh?.tag === DSH_TAG
    && evidence.targetDsh?.commit === DSH_COMMIT
    && evidence.revision === 12
    && evidence.documentDigest === documentDigest
    && evidence.entriesDigest === entriesDigest
    && typeof evidence.observedAt === 'string'
    && evidence.issuedAt === catalog.envelope.issuedAt
    && evidence.expiresAt === catalog.envelope.expiresAt,
  'ALPHA-LIFECYCLE-CATALOG-EVIDENCE', 'temporary catalog evidence did not bind its exact development-only document')
  return Object.freeze({
    catalog,
    pair,
    coordinates: Object.freeze({
      revision: 12,
      documentDigest,
      entriesDigest,
      observedAt: evidence.observedAt,
      issuedAt: catalog.envelope.issuedAt,
      expiresAt: catalog.envelope.expiresAt,
    }),
  })
}

async function runWikiLifecycle(origin, page, dshHome, catalogInput) {
  const rpc = createRpc(origin, page)
  const envelope = await rpc.raw('catalog/list', { protocolVersion: 1 }, 'alpha-lifecycle-catalog')
  const projected = parseCatalogListEnvelope(envelope, 'alpha-lifecycle-catalog')
  const pair = selectAlphaWikiPair(projected.value.entries, DSH_VERSION)
  requireCondition(projected.catalog.id === 'dsh-extension-center-public'
    && projected.catalog.revision === catalogInput.coordinates.revision
    && projected.catalog.entriesDigest === catalogInput.coordinates.entriesDigest
    && projected.catalog.signatureStatus === 'verified'
    && projected.catalog.source === 'remote'
    && projected.catalog.freshness === 'fresh'
    && projected.catalog.degraded === false
    && pair?.initial.candidateRef === WIKI_V1_REF && pair.update.candidateRef === WIKI_V2_REF,
  'ALPHA-LIFECYCLE-CATALOG-PROJECTION', 'Host did not admit the exact signed temporary catalog')
  const targetKey = `skill:${PROFILE_ID}:user:${pair.initial.name}`
  const initialInventory = await rpc.call('inventory/list', {
    protocolVersion: 1,
    scopeKey: 'user',
    profileId: PROFILE_ID,
  })
  assertInventoryEnvelope(initialInventory)
  requireCondition(initialInventory.inventory.rows.every(row => row?.targetKey !== targetKey),
    'ALPHA-LIFECYCLE-DIRTY-TARGET', 'isolated Host already contained the Wiki Skill target')

  const materialRoot = join(dshHome, 'extension-center', 'material')
  const operations = []
  const install = await executeLifecycle(rpc, {
    sequence: 1,
    operationKind: 'install',
    candidateRef: pair.initial.candidateRef,
    requestTargetKey: null,
    targetKey,
    configuration: CONFIGURATION_INITIAL,
    expected: activeExpectation(pair.initial.candidateRef, true, 'unavailable'),
  })
  const initialMaterial = await assertManagedArtifact(install.row, materialRoot, pair.initial.artifact)
  requireCondition(install.row.updateObservation?.status === 'available'
    && install.row.updateObservation.candidateRef === pair.update.candidateRef,
  'ALPHA-LIFECYCLE-UPDATE-DISCOVERY', 'installed Wiki Skill did not expose its exact successor')
  operations.push(operationProjection(install, false, true, pair.initial.artifact.integrity))

  const configure = await executeLifecycle(rpc, {
    sequence: 2,
    operationKind: 'configure',
    candidateRef: pair.initial.candidateRef,
    requestTargetKey: targetKey,
    targetKey,
    configuration: CONFIGURATION_CONFIGURED,
    expected: activeExpectation(pair.initial.candidateRef, false),
  })
  await assertManagedArtifact(configure.row, materialRoot, pair.initial.artifact)
  requireCondition(configure.row.configurationRevision !== install.row.configurationRevision,
    'ALPHA-LIFECYCLE-CONFIGURE', 'configuration revision did not change')
  operations.push(operationProjection(configure, false, false, pair.initial.artifact.integrity))

  const update = await executeLifecycle(rpc, {
    sequence: 3,
    operationKind: 'update',
    candidateRef: pair.update.candidateRef,
    requestTargetKey: targetKey,
    targetKey,
    configuration: CONFIGURATION_CONFIGURED,
    expected: activeExpectation(pair.update.candidateRef, false),
  })
  const updatedMaterial = await assertManagedArtifact(update.row, materialRoot, pair.update.artifact)
  requireCondition(update.row.configurationRevision === configure.row.configurationRevision
    && update.row.candidateRef !== install.row.candidateRef,
  'ALPHA-LIFECYCLE-UPDATE', 'update did not preserve configuration while changing exact material')
  operations.push(operationProjection(update, true, false, pair.update.artifact.integrity))

  const uninstall = await executeLifecycle(rpc, {
    sequence: 4,
    operationKind: 'uninstall',
    candidateRef: pair.update.candidateRef,
    requestTargetKey: targetKey,
    targetKey,
    configuration: CONFIGURATION_CONFIGURED,
    expected: removedExpectation(pair.update.candidateRef),
  })
  await assertRetainedArtifact(updatedMaterial, pair.update.artifact)
  requireCondition(uninstall.row.actions?.restore?.status === 'available',
    'ALPHA-LIFECYCLE-UNINSTALL', 'uninstall did not retain an exact restore action')
  operations.push(operationProjection(uninstall, false, null, pair.update.artifact.integrity))

  const restore = await executeLifecycle(rpc, {
    sequence: 5,
    operationKind: 'restore',
    candidateRef: pair.update.candidateRef,
    requestTargetKey: targetKey,
    targetKey,
    configuration: CONFIGURATION_CONFIGURED,
    expected: activeExpectation(pair.update.candidateRef, false),
  })
  await assertManagedArtifact(restore.row, materialRoot, pair.update.artifact)
  requireCondition(restore.row.configurationRevision === configure.row.configurationRevision,
    'ALPHA-LIFECYCLE-RESTORE', 'restore did not preserve the configured invocation state')
  operations.push(operationProjection(restore, true, false, pair.update.artifact.integrity))

  const finalUninstall = await executeLifecycle(rpc, {
    sequence: 6,
    operationKind: 'uninstall',
    candidateRef: pair.update.candidateRef,
    requestTargetKey: targetKey,
    targetKey,
    configuration: CONFIGURATION_CONFIGURED,
    expected: removedExpectation(pair.update.candidateRef),
  })
  await Promise.all([
    assertRetainedArtifact(initialMaterial, pair.initial.artifact),
    assertRetainedArtifact(updatedMaterial, pair.update.artifact),
  ])
  operations.push(operationProjection(finalUninstall, false, null, pair.update.artifact.integrity))
  const finalInventory = await rpc.call('inventory/list', {
    protocolVersion: 1,
    scopeKey: 'user',
    profileId: PROFILE_ID,
  })
  const finalRow = assertInventoryRow(finalInventory, targetKey, removedExpectation(pair.update.candidateRef))
  requireCondition(finalRow.current === undefined
    && finalRow.effective === 'inactive'
    && finalRow.materialized === 'absent'
    && finalRow.agentVisibility === 'not-visible',
  'ALPHA-LIFECYCLE-FINAL-INVENTORY', 'final inventory retained an active managed candidate')
  return Object.freeze({ operations: Object.freeze(operations), activeCandidateAbsent: true })
}

async function executeLifecycle(rpc, input) {
  const externalRuntimeAction = ['install', 'update'].includes(input.operationKind) ? 'download' : 'none'
  const preview = await rpc.call('intent/preview', {
    protocolVersion: 1,
    origin: 'store',
    candidateRef: input.candidateRef,
    operationKind: input.operationKind,
    scopeKey: 'user',
    profileId: PROFILE_ID,
    continuationId: null,
    targetKey: input.requestTargetKey,
    configuration: input.configuration,
  })
  const plan = assertPlan(preview, input, externalRuntimeAction)
  const approval = await rpc.call('plan/decide', {
    protocolVersion: 1,
    planId: plan.content.planId,
    planHash: plan.hash,
    operationKind: plan.content.operationKind,
    decision: 'approve',
  })
  requireCondition(approval.state?.status === 'approved'
    && approval.state.plan?.hash === plan.hash
    && approval.state.decision?.planId === plan.content.planId
    && approval.state.decision?.planHash === plan.hash
    && approval.state.decision?.operationKind === input.operationKind
    && approval.state.decision?.decision === 'approve',
  'ALPHA-LIFECYCLE-APPROVAL', `${input.operationKind} approval did not bind the immutable plan`)
  const lifecycle = await rpc.call('lifecycle/request', { protocolVersion: 1, planHash: plan.hash }, 90_000)
  const terminalReceipt = assertCommittedLifecycle(lifecycle, plan, externalRuntimeAction)
  const operation = await rpc.call('operation/get', {
    protocolVersion: 1,
    operationId: lifecycle.operationId,
  })
  try {
    verifyOperationReceiptJournal(operation.operation, terminalReceipt)
  } catch (cause) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-JOURNAL', `${input.operationKind} operation journal is invalid`, cause)
  }
  const inventory = await rpc.call('inventory/verify', {
    protocolVersion: 1,
    scopeKey: 'user',
    profileId: PROFILE_ID,
    targetKey: input.targetKey,
  })
  const row = assertInventoryRow(inventory, input.targetKey, input.expected)
  return Object.freeze({ input, inventory, plan, terminalReceipt, row })
}

function assertPlan(response, input, externalRuntimeAction) {
  requireCondition(response.policy?.status === 'eligible' && isRecord(response.plan),
    'ALPHA-LIFECYCLE-PLAN', `${input.operationKind} did not produce an eligible plan`)
  try {
    verifyImmutablePlanDigest(response.plan)
  } catch (cause) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-PLAN', `${input.operationKind} plan digest is invalid`, cause)
  }
  const plan = response.plan
  const content = plan.content
  requireCondition(typeof response.intentId === 'string' && content.intentId === response.intentId
    && content.origin === 'store' && content.singleUse === true
    && content.candidateRef === input.candidateRef && content.extensionKind === 'skill'
    && content.managedObject === 'artifact' && content.targetKey === input.targetKey
    && content.scopeKey === 'user' && content.profileId === PROFILE_ID
    && content.operationKind === input.operationKind && content.desiredState === input.expected.desired
    && content.externalRuntimeAction === externalRuntimeAction
    && content.runtimeBinding === null && content.restartRequired === false,
  'ALPHA-LIFECYCLE-PLAN', `${input.operationKind} plan did not bind the exact Skill write`)
  return plan
}

function assertCommittedLifecycle(response, plan, externalRuntimeAction) {
  requireCondition(response.status === 'committed' && typeof response.operationId === 'string'
    && isRecord(response.receipt) && isRecord(response.receipt.body)
    && response.receipt.body.operationId === response.operationId
    && response.receipt.body.planId === plan.content.planId
    && response.receipt.body.planHash === plan.hash
    && response.receipt.body.operationKind === plan.content.operationKind
    && response.receipt.body.targetKey === plan.content.targetKey
    && response.receipt.body.outcome === 'committed'
    && response.receipt.body.externalRuntimeAction === externalRuntimeAction
    && Array.isArray(response.receipt.body.mutationDigests)
    && response.receipt.body.mutationDigests.length > 0
    && Array.isArray(response.receipt.body.verificationDigests)
    && response.receipt.body.verificationDigests.length > 0
    && /^sha256:[0-9a-f]{64}$/u.test(response.receipt.digest),
  'ALPHA-LIFECYCLE-TERMINAL-RECEIPT', `${plan.content.operationKind} did not return a committed receipt`)
  try {
    verifyTerminalReceiptPlanBinding(response.receipt, plan)
  } catch (cause) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-TERMINAL-RECEIPT', 'terminal receipt does not bind its plan', cause)
  }
  return response.receipt
}

function assertInventoryEnvelope(response) {
  requireCondition(response.hostCapabilities?.acquisition === true
    && isRecord(response.inventory) && response.inventory.scopeKey === 'user'
    && response.inventory.profileId === PROFILE_ID && response.inventory.complete === true
    && Array.isArray(response.inventory.rows)
    && /^sha256:[0-9a-f]{64}$/u.test(response.inventory.revision),
  'ALPHA-LIFECYCLE-INVENTORY', 'inventory response is incomplete')
}

function assertInventoryRow(response, targetKey, expected) {
  assertInventoryEnvelope(response)
  const rows = response.inventory.rows.filter(row => row?.targetKey === targetKey)
  requireCondition(rows.length === 1, 'ALPHA-LIFECYCLE-INVENTORY', 'inventory did not contain one exact target row')
  const row = rows[0]
  requireCondition(row.kind === 'skill' && row.ownership === 'center'
    && row.scopeKey === 'user' && row.profileId === PROFILE_ID
    && row.candidateRef === expected.candidateRef && row.desired === expected.desired
    && row.materialized === expected.materialized && row.effective === expected.effective
    && row.agentVisibility === expected.agentVisibility && row.verification === expected.verification
    && row.rollback === expected.rollback && typeof row.managedRevision === 'string'
    && (expected.configuration === null
      ? row.configurationRevision === null
      : row.configurationRevision === canonicalSha256(expected.configuration)),
  'ALPHA-LIFECYCLE-INVENTORY', 'inventory row did not expose the exact owner state')
  if (expected.effective === 'active') {
    requireCondition(row.evidence?.kind === 'skill'
      && row.evidence.winningProvider === 'extension-center'
      && row.evidence.definitionLoaded === true
      && row.evidence.invocation?.modelInvocable === true
      && row.evidence.invocation.userInvocable === expected.userInvocable,
    'ALPHA-LIFECYCLE-OWNER', 'active Wiki Skill is not the merged-registry winner')
  } else {
    requireCondition(row.evidence?.kind === 'skill'
      && row.evidence.winningProvider !== 'extension-center'
      && row.evidence.definitionLoaded === false,
    'ALPHA-LIFECYCLE-OWNER', 'removed Wiki Skill still wins the merged registry')
  }
  return row
}

function activeExpectation(candidateRef, userInvocable, rollback = 'available') {
  return Object.freeze({
    candidateRef,
    desired: 'enabled',
    materialized: 'configured',
    effective: 'active',
    agentVisibility: 'visible',
    verification: 'runtime',
    rollback,
    configuration: userInvocable ? CONFIGURATION_INITIAL : CONFIGURATION_CONFIGURED,
    userInvocable,
  })
}

function removedExpectation(candidateRef) {
  return Object.freeze({
    candidateRef,
    desired: 'removed',
    materialized: 'absent',
    effective: 'inactive',
    agentVisibility: 'not-visible',
    verification: 'unverified',
    rollback: 'available',
    configuration: null,
    userInvocable: null,
  })
}

function operationProjection(result, configurationPreserved, userInvocable, materialIntegrity) {
  const receipt = result.terminalReceipt.body
  const ownerEvidence = result.row.evidence?.kind === 'skill'
    ? {
      kind: result.row.evidence.kind,
      contentRevision: result.row.evidence.contentRevision,
      catalogComplete: result.row.evidence.catalogComplete,
      winningProvider: result.row.evidence.winningProvider,
      definitionLoaded: result.row.evidence.definitionLoaded,
      invocation: result.row.evidence.invocation,
    }
    : result.row.evidence
  return Object.freeze({
    sequence: result.input.sequence,
    action: result.input.operationKind,
    candidateRef: result.input.candidateRef,
    status: 'committed',
    planHash: result.plan.hash,
    receiptDigest: result.terminalReceipt.digest,
    operationId: receipt.operationId,
    externalRuntimeAction: receipt.externalRuntimeAction,
    beforeDigest: receipt.beforeDigest,
    afterDigest: receipt.afterDigest,
    mutationDigests: receipt.mutationDigests,
    verificationDigests: receipt.verificationDigests,
    journalEventCount: receipt.journalEventCount,
    journalHeadDigest: receipt.journalHeadDigest,
    inventoryRevision: result.inventory.inventory.revision,
    managedRevision: result.row.managedRevision,
    configurationRevision: result.row.configurationRevision,
    observedCandidateRef: result.row.candidateRef,
    ownerRevisionDigest: canonicalSha256(result.row.ownerRevision),
    ownerEvidenceDigest: canonicalSha256(ownerEvidence),
    materialIntegrity,
    ownerStateVerified: true,
    configurationPreserved,
    userInvocable,
  })
}

async function assertManagedArtifact(row, materialRoot, artifact) {
  const path = row.evidence?.winningPath
  requireCondition(typeof path === 'string', 'ALPHA-LIFECYCLE-MATERIAL', 'active inventory omitted its material path')
  const canonicalRoot = await realpath(materialRoot)
  const canonicalPath = await realpath(path)
  requireCondition(inside(canonicalRoot, canonicalPath),
    'ALPHA-LIFECYCLE-MATERIAL', 'managed Skill material escaped the Center root')
  await assertRetainedArtifact(canonicalPath, artifact)
  return canonicalPath
}

async function assertRetainedArtifact(path, artifact) {
  const bytes = await boundedRegularFile(path, 1024 * 1024, 'managed Skill artifact')
  requireCondition(bytes.byteLength === artifact.sizeBytes
    && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === artifact.integrity,
  'ALPHA-LIFECYCLE-MATERIAL', 'managed Skill bytes do not match the admitted artifact')
}

function createRpc(origin, page) {
  let sequence = 0
  const raw = async (method, payload, suppliedRpcId, timeoutMs = 30_000) => {
    const rpcId = suppliedRpcId ?? `alpha-lifecycle-${String(++sequence).padStart(2, '0')}-${method.replaceAll('/', '-')}`
    const response = await page.evaluate(async input => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), input.timeoutMs)
      try {
        const result = await fetch(input.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: input.body,
          redirect: 'error',
          signal: controller.signal,
        })
        return Object.freeze({ ok: result.ok, status: result.status, body: await result.text() })
      } finally {
        clearTimeout(timer)
      }
    }, {
      url: new URL(`/dsh-extension-center/${method}`, origin).href,
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      timeoutMs,
    })
    requireCondition(response.ok && response.status === 200,
      'ALPHA-LIFECYCLE-RPC', `${method} did not return authenticated HTTP success`)
    const envelope = parseJson(Buffer.from(response.body, 'utf8'), `${method} response`)
    requireCondition(isRecord(envelope) && envelope.type === 'server-response' && envelope.rpcId === rpcId,
      'ALPHA-LIFECYCLE-RPC', `${method} response did not correlate to its request`)
    return envelope
  }
  const call = async (method, payload, timeoutMs) => {
    const envelope = await raw(method, payload, undefined, timeoutMs)
    requireCondition(isRecord(envelope.result), 'ALPHA-LIFECYCLE-RPC', `${method} omitted its result`)
    if (envelope.result.ok !== true) {
      throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-RPC-REFUSED', `${method} was refused by the authenticated Host`)
    }
    requireCondition(isRecord(envelope.result.value) && envelope.result.value.protocolVersion === 1,
      'ALPHA-LIFECYCLE-RPC', `${method} returned an incompatible value`)
    return envelope.result.value
  }
  return Object.freeze({ raw, call })
}

async function openAuthenticatedBrowserSession(launchUrl) {
  const origin = new URL(launchUrl).origin
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    locale: 'en-US',
    serviceWorkers: 'block',
    viewport: { width: 1280, height: 900 },
  })
  try {
    await context.route('**/*', async route => {
      if (isAdmittedBrowserRequest(route.request().url(), origin)) await route.continue()
      else await route.abort('blockedbyclient')
    })
    await context.routeWebSocket('**/*', async websocket => {
      if (isAdmittedBrowserWebSocket(websocket.url(), origin)) websocket.connectToServer()
      else await websocket.close({ code: 1008, reason: 'alpha lifecycle admits only the local official Web Host' })
    })
    const page = await context.newPage()
    await page.goto(launchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const settledUrl = new URL(page.url())
    requireCondition(settledUrl.origin === origin && settledUrl.pathname === '/'
      && settledUrl.search === '' && settledUrl.hash === '',
    'ALPHA-LIFECYCLE-AUTH-SESSION', 'official Web login did not remove its one-time launch credential')
    await verifyManagementAuthentication(origin, context)
    return Object.freeze({ browser, context, page })
  } catch (error) {
    await context.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    throw error
  }
}

async function closeBrowserSession(session) {
  if (session === undefined) return
  await session.context.close().catch(() => undefined)
  await session.browser.close().catch(() => undefined)
}

async function verifyManagementAuthentication(origin, context) {
  const cookies = (await context.cookies(origin)).filter(cookie => cookie.name.startsWith('dsh-auth-'))
  requireCondition(cookies.length === 1 && cookies[0].httpOnly === true
    && cookies[0].sameSite === 'Strict' && cookies[0].path === '/',
  'ALPHA-LIFECYCLE-AUTH-SESSION', 'official Web login did not mint one HttpOnly authority-bound session')
  const cookie = cookies[0]
  const endpoint = new URL('/dsh-extension-center/catalog/list', origin)
  const request = async headers => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'alpha-lifecycle-auth-negative',
        method: 'catalog/list',
        payload: { protocolVersion: 1 },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    await response.text()
    return response.status
  }
  const [missing, invalid, crossOrigin] = await Promise.all([
    request({ origin, 'sec-fetch-site': 'same-origin' }),
    request({ origin, 'sec-fetch-site': 'same-origin', cookie: `${cookie.name}=invalid` }),
    request({
      origin: 'http://alpha-lifecycle-cross-origin.invalid',
      'sec-fetch-site': 'cross-site',
      cookie: `${cookie.name}=${cookie.value}`,
    }),
  ])
  requireCondition(missing === 401 && invalid === 401 && crossOrigin === 403,
    'ALPHA-LIFECYCLE-AUTH-REJECTION', 'official Connection accepted missing, invalid, or cross-origin authority')
}

async function startCatalogServer(catalogBytes, certificatePath, privateKeyPath) {
  const [certificate, privateKey] = await Promise.all([
    boundedRegularFile(certificatePath, 64 * 1024, 'TLS certificate'),
    boundedRegularFile(privateKeyPath, 64 * 1024, 'TLS private key', true),
  ])
  let requests = 0
  const server = createServer({ cert: certificate, key: privateKey }, (request, response) => {
    if (request.method !== 'GET' || request.url !== '/plugins.json' || requests !== 0) {
      response.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      response.end('not found')
      return
    }
    requests += 1
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(catalogBytes.byteLength),
      'cache-control': 'no-store',
    })
    response.end(catalogBytes)
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-CATALOG-SERVER', 'temporary HTTPS server did not bind')
  }
  return {
    server,
    get requests() { return requests },
    url: `https://127.0.0.1:${String(address.port)}/plugins.json`,
  }
}

async function stopCatalogServer(value) {
  if (value === undefined) return
  value.server.closeAllConnections?.()
  await new Promise((resolveClose, rejectClose) => {
    value.server.close(error => error === undefined ? resolveClose() : rejectClose(error))
  })
}

async function startOfficialWeb(dshSourceRoot, cwd, environment, overlay) {
  const child = spawn('pnpm', [
    '--dir', dshSourceRoot, 'dsh', 'web', '--no-open', '--port', '0', '--patch', overlay,
  ], {
    cwd,
    env: environment,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let ready = false
  const append = chunk => {
    output += chunk.toString()
    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) child.kill('SIGKILL')
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  try {
    const launchUrl = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        cleanup()
        rejectReady(new AlphaLifecycleFailure('ALPHA-LIFECYCLE-HOST-START', 'official Web Host readiness timed out'))
      }, 120_000)
      const observe = () => {
        let launchUrl
        try {
          launchUrl = parseAuthenticatedLaunchUrl(output)
        } catch (cause) {
          cleanup()
          rejectReady(new AlphaLifecycleFailure('ALPHA-LIFECYCLE-HOST-START', 'official Web Host printed an invalid URL', cause))
          return
        }
        if (launchUrl === undefined) return
        cleanup()
        ready = true
        resolveReady(launchUrl)
      }
      const exited = () => {
        cleanup()
        rejectReady(new AlphaLifecycleFailure('ALPHA-LIFECYCLE-HOST-START', 'official Web Host exited before readiness'))
      }
      const cleanup = () => {
        clearTimeout(timer)
        child.stdout.off('data', observe)
        child.stderr.off('data', observe)
        child.off('exit', exited)
      }
      child.stdout.on('data', observe)
      child.stderr.on('data', observe)
      child.once('exit', exited)
      observe()
    })
    return Object.freeze({ child, origin: new URL(launchUrl).origin, launchUrl })
  } catch (error) {
    await stopChild(child).catch(() => undefined)
    throw error
  } finally {
    if (!ready) {
      child.stdout.off('data', append)
      child.stderr.off('data', append)
    }
  }
}

function parseAuthenticatedLaunchUrl(output) {
  const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
  if (match?.[1] === undefined) return undefined
  const url = new URL(match[1])
  const tokens = url.searchParams.getAll('token')
  requireCondition(url.protocol === 'http:' && url.hostname === '127.0.0.1'
    && url.port !== '' && url.pathname === '/' && url.username === '' && url.password === ''
    && url.hash === '' && [...url.searchParams.keys()].every(key => key === 'token')
    && tokens.length === 1 && /^[A-Za-z0-9_-]{43}$/u.test(tokens[0]),
  'ALPHA-LIFECYCLE-HOST-AUTH-URL', 'official Web Host announced an invalid authenticated loopback URL')
  return url.href
}

async function packExactCenter(centerSourceRoot, packageRoot, environment) {
  const manifest = parseJson(await boundedRegularFile(join(centerSourceRoot, 'package.json'), 1024 * 1024, 'Center manifest'), 'Center manifest')
  requireCondition(manifest.name === PACKAGE_NAME && manifest.version === '0.2.0-alpha.1'
    && manifest.engines?.dsh === DSH_VERSION && manifest.dsh?.bundle?.patch === './cordis.patch.yml',
  'ALPHA-LIFECYCLE-CENTER-PACKAGE', 'Center manifest does not match the exact alpha Bundle')
  await runRequired('pnpm', ['--dir', centerSourceRoot, 'pack', '--pack-destination', packageRoot, '--ignore-scripts'], {
    cwd: centerSourceRoot,
    env: environment,
    timeoutMs: 120_000,
  }, 'ALPHA-LIFECYCLE-CENTER-PACKAGE')
  const archive = join(packageRoot, `${PACKAGE_NAME}-${manifest.version}.tgz`)
  await boundedRegularFile(archive, 64 * 1024 * 1024, 'Center package archive')
  return archive
}

async function assertInstalledCenter(profileRoot, centerCommit) {
  const manifest = parseJson(await boundedRegularFile(
    join(profileRoot, 'node_modules', PACKAGE_NAME, 'package.json'),
    1024 * 1024,
    'installed Center manifest',
  ), 'installed Center manifest')
  const profile = parseJson(await boundedRegularFile(join(profileRoot, 'package.json'), 1024 * 1024, 'Profile manifest'), 'Profile manifest')
  const bundles = profile.dsh?.profile?.bundles
  requireCondition(manifest.name === PACKAGE_NAME && manifest.version === '0.2.0-alpha.1'
    && manifest.engines?.dsh === DSH_VERSION && manifest.dsh?.bundle?.patch === './cordis.patch.yml'
    && Array.isArray(bundles) && bundles.filter(name => name === PACKAGE_NAME).length === 1
    && typeof profile.dependencies?.[PACKAGE_NAME] === 'string'
    && /^[0-9a-f]{40}$/u.test(centerCommit),
  'ALPHA-LIFECYCLE-CENTER-INSTALL', 'official Profile did not contain one exact Center Bundle')
}

async function assertOfficialDshSource(root) {
  const [revision, tags, version] = await Promise.all([
    gitOutput(root, ['rev-parse', 'HEAD']),
    gitOutput(root, ['tag', '--points-at', 'HEAD']),
    boundedRegularFile(join(root, 'apps', 'cli', 'package.json'), 1024 * 1024, 'official DSH CLI manifest')
      .then(bytes => parseJson(bytes, 'official DSH CLI manifest').version),
  ])
  requireCondition(revision === DSH_COMMIT && tags.split('\n').includes(DSH_TAG) && version === DSH_VERSION,
    'ALPHA-LIFECYCLE-DSH-SOURCE', 'official DSH source tag, commit, or version is not exact')
  await assertTrackedTreeClean(root, 'official DSH')
  return await trackedSourceTreeDigest(root)
}

async function assertCenterSource(root, expectedCommit) {
  const [revision, remote] = await Promise.all([
    gitOutput(root, ['rev-parse', 'HEAD']),
    gitOutput(root, ['remote', 'get-url', 'origin']),
  ])
  requireCondition(revision === expectedCommit
    && /github\.com[/:]striveh\/dsh-plugin-extension-center(?:\.git)?$/u.test(remote),
  'ALPHA-LIFECYCLE-CENTER-SOURCE', 'Center source does not match the protected repository commit')
  await assertTrackedTreeClean(root, 'Center')
}

async function trackedSourceTreeDigest(root) {
  const files = (await gitOutputBuffer(root, ['ls-files', '-z'])).toString('utf8').split('\0').filter(Boolean)
  const hash = createHash('sha256')
  for (const path of files) {
    requireCondition(path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith('/') && !path.includes('\0'),
      'ALPHA-LIFECYCLE-SOURCE-TREE', 'Git returned an unsafe tracked path')
    const absolute = join(root, path)
    const info = await lstat(absolute)
    hash.update(`${path}\0${String(info.mode & 0o777)}\0`)
    if (info.isSymbolicLink()) hash.update(`link\0${await readlink(absolute)}\0`)
    else if (info.isFile()) hash.update('file\0').update(await readFile(absolute)).update('\0')
    else throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-SOURCE-TREE', 'tracked source entry is not a file or symlink')
  }
  return `sha256:${hash.digest('hex')}`
}

async function assertTrackedTreeClean(root, label) {
  const status = await gitOutput(root, ['status', '--porcelain=v1', '--untracked-files=no'])
  requireCondition(status === '', 'ALPHA-LIFECYCLE-SOURCE-TREE', `${label} tracked source tree is modified`)
}

function assertGithubInvocation(config) {
  const workflowRef = process.env.GITHUB_WORKFLOW_REF
  requireCondition(process.env.GITHUB_ACTIONS === 'true'
    && process.env.GITHUB_REPOSITORY === CENTER_REPOSITORY
    && process.env.GITHUB_REF === 'refs/heads/main'
    && process.env.GITHUB_REF_PROTECTED === 'true'
    && process.env.GITHUB_SHA === config.centerCommit
    && Number(process.env.GITHUB_RUN_ID) === config.runId
    && Number(process.env.GITHUB_RUN_ATTEMPT) === config.runAttempt
    && typeof workflowRef === 'string'
    && workflowRef.includes(`${CENTER_REPOSITORY}/${LIFECYCLE_WORKFLOW}@refs/heads/main`),
  'ALPHA-LIFECYCLE-WORKFLOW', 'producer must run only in its protected-main development workflow')
}

function developmentOverlay(catalogUrl, dshCliEntrypoint) {
  return `# Development-only alpha catalog projection. This file is created under the isolated runner root.\n\n- id: dsh-plugin-extension-center\n  config:\n    catalogTrustedUrl: ${catalogUrl}\n    catalogFetchTimeoutMs: 10000\n    catalogRefreshIntervalMs: 86400000\n    maximumArtifactRedirects: 1\n    allowedArtifactRedirectHosts:\n      - objects.githubusercontent.com\n      - release-assets.githubusercontent.com\n    mcpRuntimes: []\n    dshCliEntrypoint: ${JSON.stringify(dshCliEntrypoint)}\n    dshCliTimeoutMs: 120000\n`
}

function isolatedEnvironment({ dshHome, agentsHome, npmConfig, tlsCertificatePath }) {
  const environment = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENVIRONMENT_KEY.test(key) && !key.endsWith('_BASE_URL')
      && key !== 'NODE_TLS_REJECT_UNAUTHORIZED') environment[key] = value
  }
  return {
    ...environment,
    ...(dshHome === undefined ? {} : { DSH_HOME: dshHome }),
    ...(agentsHome === undefined ? {} : { DSH_AGENTS_HOME: agentsHome }),
    ...(npmConfig === undefined ? {} : { NPM_CONFIG_USERCONFIG: npmConfig }),
    ...(tlsCertificatePath === undefined ? {} : { NODE_EXTRA_CA_CERTS: tlsCertificatePath }),
    DSH_TELEMETRY_MODE: 'DISABLED',
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    NO_COLOR: '1',
    LC_ALL: 'C',
  }
}

async function runDsh(root, args, cwd, env, timeoutMs, code) {
  const result = await runRequired('pnpm', ['--dir', root, 'dsh', ...args], { cwd, env, timeoutMs }, code)
  return result
}

async function runRequired(command, args, options, code) {
  const result = await runCapture(command, args, options)
  if (result.exitCode !== 0) {
    throw new AlphaLifecycleFailure(code, `${command} command failed with ${String(result.exitCode)}`)
  }
  return result
}

function runCapture(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let bytes = 0
    let settled = false
    let timedOut = false
    let timer
    const settle = callback => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const append = (chunks, chunk) => {
      bytes += chunk.byteLength
      if (bytes > MAX_OUTPUT_BYTES) {
        signalTree(child, 'SIGKILL')
        settle(() => rejectRun(new AlphaLifecycleFailure('ALPHA-LIFECYCLE-SUBPROCESS', 'subprocess output exceeded its bound')))
        return
      }
      chunks.push(chunk)
    }
    child.stdout.on('data', chunk => { append(stdout, chunk) })
    child.stderr.on('data', chunk => { append(stderr, chunk) })
    timer = setTimeout(() => {
      timedOut = true
      signalTree(child, 'SIGTERM')
      setTimeout(() => signalTree(child, 'SIGKILL'), 5_000).unref()
    }, options.timeoutMs)
    child.once('error', error => settle(() => rejectRun(error)))
    child.once('close', exitCode => settle(() => {
      if (timedOut) {
        rejectRun(new AlphaLifecycleFailure('ALPHA-LIFECYCLE-SUBPROCESS', `${command} exceeded its timeout`))
      } else {
        resolveRun({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        })
      }
    }))
  })
}

function signalTree(child, signal) {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error?.code === 'ESRCH') return
    }
  }
  child.kill(signal)
}

async function gitOutput(root, args) {
  return (await gitOutputBuffer(root, args)).toString('utf8').trim()
}

async function gitOutputBuffer(root, args) {
  const result = await runRequired('git', ['-C', root, ...args], {
    cwd: root,
    env: isolatedEnvironment({}),
    timeoutMs: 30_000,
  }, 'ALPHA-LIFECYCLE-GIT')
  return Buffer.from(result.stdout, 'utf8')
}

async function boundedRegularFile(path, maximum, label, ownerOnly = false) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum
    || ownerOnly && process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-FILE', `${label} is not one bounded regular file`)
  }
  return await readFile(path)
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-JSON', `${label} is not strict UTF-8 JSON`, cause)
  }
}

function inside(root, candidate) {
  const value = relative(resolve(root), resolve(candidate))
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`)
}

function sameList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index])
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireCondition(condition, code, message) {
  if (!condition) throw new AlphaLifecycleFailure(code, message)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runAlphaCatalogLifecycle(parseAlphaLifecycleArguments(process.argv.slice(2)))
  } catch (error) {
    const code = error instanceof AlphaLifecycleFailure ? error.code : 'ALPHA-LIFECYCLE-UNEXPECTED'
    process.stderr.write(`RED [${code}]: ${error instanceof Error ? error.message.replace(/^\[[^\]]+\]\s*/u, '') : 'lifecycle failed'}\n`)
    process.exitCode = 1
  }
}
