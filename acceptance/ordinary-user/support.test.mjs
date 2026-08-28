import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse as parseYaml } from 'yaml'
import {
  OrdinaryUserLaneFailure,
  actionsProvenanceFromEnvironment,
  assertExpectedCenterTarget,
  assertSecretFreeReceipt,
  compareExactVersions,
  createOrdinaryUserReceipt,
  markFailed,
  markManagementPending,
  markPassed,
  markPending,
  markUpdatePending,
  parseCenterSpec,
  parseOrdinaryUserArguments,
  selectAlphaWikiPair,
  verifyOrdinaryUserReceiptDigest,
  writeOrdinaryUserReceipt,
} from './support.mjs'
import { createManagementRpc, parseAuthenticatedLaunchUrl } from './run.mjs'
import {
  createActionsArtifactEvidence,
  verifyActionsArtifactEvidence,
  verifyActionsRunBinding,
} from './actions-evidence.mjs'

const alphaCommit = 'c'.repeat(40)
const initialCenterCommit = 'd'.repeat(40)
const targetCenterCommit = 'e'.repeat(40)
const targetIntegrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`
const initialSkillRef = 'skill:microsoft-skills/wiki-page-writer@6142f8e60ac58372845c0fcdd2dbf043cd1bb698'
const updateSkillRef = 'skill:microsoft-skills/wiki-page-writer@67ae723a23ba880e3e5c8a3e5e2320092024476e'
const skillTargetKey = 'skill:web:user:wiki-page-writer'

function actionsEnvironment(workflowFile = '.github/workflows/ordinary-user.yml') {
  const commit = 'f'.repeat(40)
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_PROTECTED: 'true',
    GITHUB_REPOSITORY: 'striveh/dsh-plugin-extension-center',
    GITHUB_REPOSITORY_ID: '123456789',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_RUN_ID: '987654321',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_SHA: commit,
    GITHUB_WORKFLOW_REF: `striveh/dsh-plugin-extension-center/${workflowFile}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: commit,
  }
}

function deliveryOnlyReceipt(config) {
  const receipt = createOrdinaryUserReceipt(config)
  Object.assign(receipt.observations.cli, {
    pnpmVersionMatched: true,
    versionMatched: true,
    initialAddPassed: true,
    initialListPassed: true,
    initialDumpContainedBundle: true,
    updatePassed: true,
    updatedListPassed: true,
    updatedDumpContainedBundle: true,
    removePassed: true,
    removedListAbsent: true,
    removedDumpAbsent: true,
  })
  Object.assign(receipt.observations.profile, {
    initialExactDependency: true,
    initialArtifactBound: true,
    initialBundleCount: 1,
    initialInstalledVersion: '0.1.0',
    targetExactDependency: true,
    targetArtifactBound: true,
    targetBundleCount: 1,
    targetInstalledVersion: '0.1.1',
    updateAdvanced: true,
    removedDependencyAbsent: true,
    removedBundleAbsent: true,
    removedPackageAbsent: true,
  })
  Object.assign(receipt.observations.host, { ready: true, remainedLive: true })
  Object.assign(receipt.observations.client, {
    bootEntryObserved: true,
    bundleRequestObserved: true,
    extensionsButtonObserved: true,
    storeDialogObserved: true,
    storeTabsObserved: true,
    configurationFilterObserved: true,
    configurationReadyEntryObserved: true,
    consoleFailures: 0,
  })
  if (config.launcher.kind === 'registry-installed') {
    receipt.observations.registry.centerInitial = {
      status: 'published', version: '0.1.0', integrity: 'sha512-initial',
    }
    receipt.observations.registry.centerTarget = {
      status: 'published', version: '0.1.1', integrity: 'sha512-target',
    }
    receipt.observations.registry.centerTargetAfterInstall = {
      status: 'published', version: '0.1.1', integrity: 'sha512-target',
    }
    receipt.observations.officialDshPackageTreeUnchanged = true
  }
  return receipt
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function operationEvidence(index, operationKind, candidateRef, state) {
  return {
    sequence: index,
    operationKind,
    candidateRef,
    targetKey: skillTargetKey,
    planId: `plan:${String(index)}`,
    planHash: digest(`plan:${String(index)}`),
    singleUse: true,
    decision: 'approve',
    operationId: `operation:${String(index)}`,
    receiptDigest: digest(`receipt:${String(index)}`),
    outcome: 'committed',
    externalRuntimeAction: state.externalRuntimeAction,
    inventoryRevision: digest(`inventory:${String(index)}`),
    inventoryRowPresent: true,
    managedRevision: `center:${String(index)}`,
    configurationRevision: state.configurationRevision ?? null,
    observedCandidateRef: state.observedCandidateRef === undefined ? candidateRef : state.observedCandidateRef,
    rollback: state.rollback ?? 'available',
    restoreActionAvailable: state.restoreActionAvailable ?? null,
    installActionAvailable: state.installActionAvailable ?? null,
    managedBytesAbsent: state.managedBytesAbsent ?? null,
    desired: state.desired,
    materialized: state.materialized,
    effective: state.effective,
    agentVisibility: state.agentVisibility,
    verification: state.verification,
    userInvocable: state.userInvocable,
    ownerStateVerified: true,
  }
}

function completedReceipt(config) {
  const receipt = deliveryOnlyReceipt(config)
  const initialConfigurationRevision = digest('skill configuration userInvocable=true')
  const configuredRevision = digest('skill configuration userInvocable=false')
  const active = {
    desired: 'enabled',
    materialized: 'configured',
    effective: 'active',
    agentVisibility: 'visible',
    verification: 'runtime',
  }
  const removed = {
    desired: 'removed',
    materialized: 'absent',
    effective: 'inactive',
    agentVisibility: 'not-visible',
    verification: 'unverified',
    userInvocable: null,
    externalRuntimeAction: 'none',
  }
  Object.assign(receipt.observations.management.discovery, {
    methods: ['catalog/list', 'inventory/list', 'configuration/options'],
    catalogId: 'dsh-extension-center-public',
    catalogRevision: 12,
    catalogEntriesDigest: digest('alpha catalog entries'),
    catalogSignatureStatus: 'verified',
    catalogKeyIds: ['bootstrap-2026-08-26-8'],
    catalogSource: 'remote',
    catalogFreshness: 'fresh',
    catalogDegraded: false,
    extensionKind: 'skill',
    extensionName: 'wiki-page-writer',
    targetKey: skillTargetKey,
    initialCandidateRef: initialSkillRef,
    updateCandidateRef: updateSkillRef,
    initialArtifactRevision: '6142f8e60ac58372845c0fcdd2dbf043cd1bb698',
    initialArtifactIntegrity: 'sha256:7929f8adf896dbbf1fd744493f643c55a6812f0418d6cd89b3284f8f924d0c8f',
    initialArtifactSizeBytes: 5_807,
    updateArtifactRevision: '67ae723a23ba880e3e5c8a3e5e2320092024476e',
    updateArtifactIntegrity: 'sha256:f1270ea4123116e846bf2dc7a53a9e396ed43d694cdb7be22b9a35da9a40feb6',
    updateArtifactSizeBytes: 5_869,
    initialCompatibilityDsh: config.dshVersion,
    updateCompatibilityDsh: config.dshVersion,
    initialEligible: true,
    updateEligible: true,
  })
  Object.assign(receipt.observations.management, {
    authentication: {
      browserSessionEstablished: true,
      missingSessionRejected: true,
      invalidSessionRejected: true,
      crossOriginRejected: true,
    },
    userInterface: {
      driver: 'playwright-accessible-ui',
      scopeKey: 'user',
      operationKinds: ['install', 'configure', 'update', 'uninstall', 'restore', 'uninstall', 'purge'],
      planReviewsObserved: 7,
      approvalsClicked: 7,
      lifecycleCompletionsObserved: 7,
      directMutationRpcCalls: 0,
    },
    configurationMethods: Array.from({ length: 4 }, () => 'configuration/options'),
    writeMethods: Array.from({ length: 7 }, () => [
      'intent/preview', 'plan/decide', 'lifecycle/request',
    ]).flat(),
    receiptMethods: Array.from({ length: 7 }, () => 'operation/get'),
    verificationMethods: [
      'inventory/verify', 'inventory/verify', 'inventory/verify', 'inventory/verify',
      'inventory/verify', 'inventory/verify', 'inventory/verify', 'inventory/list',
    ],
    hostProcessStable: true,
    install: operationEvidence(1, 'install', initialSkillRef, {
      ...active, userInvocable: true, externalRuntimeAction: 'download',
      configurationRevision: initialConfigurationRevision,
    }),
    configure: operationEvidence(2, 'configure', initialSkillRef, {
      ...active, userInvocable: false, externalRuntimeAction: 'none',
      configurationRevision: configuredRevision,
    }),
    update: operationEvidence(3, 'update', updateSkillRef, {
      ...active, userInvocable: false, externalRuntimeAction: 'download',
      configurationRevision: configuredRevision,
    }),
    uninstallForRestore: operationEvidence(4, 'uninstall', updateSkillRef, {
      ...removed, restoreActionAvailable: true,
    }),
    restore: operationEvidence(5, 'restore', updateSkillRef, {
      ...active, userInvocable: false, externalRuntimeAction: 'none',
      configurationRevision: configuredRevision,
    }),
    finalUninstall: operationEvidence(6, 'uninstall', updateSkillRef, {
      ...removed, restoreActionAvailable: true,
    }),
    purge: operationEvidence(7, 'purge', updateSkillRef, {
      ...removed,
      userInvocable: null,
      externalRuntimeAction: 'none',
      observedCandidateRef: null,
      rollback: 'unavailable',
      installActionAvailable: true,
      managedBytesAbsent: true,
    }),
    finalCleanup: {
      inventoryRevision: digest('inventory:7'),
      targetRowCount: 1,
      tombstoneRetained: true,
      candidateRef: null,
      desired: 'removed',
      materialized: 'absent',
      effective: 'inactive',
      agentVisibility: 'not-visible',
      rollback: 'unavailable',
      managedBytesAbsent: true,
      installActionAvailable: true,
    },
  })
  return receipt
}

test('defaults to the unpublished alpha registry lane without a local artifact escape', () => {
  const parsed = parseOrdinaryUserArguments([], '/acceptance')
  assert.equal(parsed.mode, 'registry')
  assert.equal(parsed.dshVersion, '0.1.2-alpha.1')
  assert.deepEqual(parsed.center, {
    initial: {
      kind: 'registry',
      packageName: 'dsh-plugin-extension-center',
      spec: 'dsh-plugin-extension-center@0.2.0-alpha.0',
      commit: null,
      selector: '0.2.0-alpha.0',
    },
    target: {
      kind: 'registry',
      packageName: 'dsh-plugin-extension-center',
      spec: 'dsh-plugin-extension-center@next',
      commit: null,
      selector: 'next',
    },
  })
  assert.equal(parsed.launcher.kind, 'registry-installed')
  assert.equal(parsed.receiptPath, '/acceptance/.artifacts/acceptance/ordinary-user/receipt.json')
})

test('preserves only the official authenticated loopback launch URL', () => {
  const token = 'A'.repeat(43)
  const url = `http://127.0.0.1:43127/?token=${token}`
  assert.equal(parseAuthenticatedLaunchUrl(`booting\ndsh web: ${url}\n`), url)
  for (const rejected of [
    'http://127.0.0.1:43127/',
    `http://127.0.0.1:43127/?token=${token}&other=x`,
    `http://localhost:43127/?token=${token}`,
    `http://0.0.0.0:43127/?token=${token}`,
  ]) {
    assert.throws(
      () => parseAuthenticatedLaunchUrl(`dsh web: ${rejected}\n`),
      /authenticated/u,
      rejected,
    )
  }
})

test('accepts scoped registry packages and derives their exact installed identity', () => {
  assert.deepEqual(parseCenterSpec('@striveh/dsh-plugin-extension-center@next', 'registry'), {
    kind: 'registry',
    packageName: '@striveh/dsh-plugin-extension-center',
    spec: '@striveh/dsh-plugin-extension-center@next',
    commit: null,
    selector: 'next',
  })
})

test('admits only the exact signed Skill successor coordinates with alpha compatibility', () => {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const lifecycle = Object.fromEntries(
    ['install', 'configure', 'update', 'uninstall', 'restore'].map(operation => [operation, { status: 'available' }]),
  )
  const entry = (candidateRef, version, integrity, sizeBytes) => ({
    candidateRef,
    kind: 'skill',
    name: 'wiki-page-writer',
    artifact: { version, integrity, sizeBytes },
    source: { revision: version },
    compatibility: { status: 'compatible', dsh: '0.1.2-alpha.1', platforms: [platform] },
    scopes: ['user'],
    configuration: { credentials: 'none' },
    lifecycle,
  })
  const entries = [
    entry(
      initialSkillRef,
      '6142f8e60ac58372845c0fcdd2dbf043cd1bb698',
      'sha256:7929f8adf896dbbf1fd744493f643c55a6812f0418d6cd89b3284f8f924d0c8f',
      5_807,
    ),
    entry(
      updateSkillRef,
      '67ae723a23ba880e3e5c8a3e5e2320092024476e',
      'sha256:f1270ea4123116e846bf2dc7a53a9e396ed43d694cdb7be22b9a35da9a40feb6',
      5_869,
    ),
  ]
  assert.deepEqual(selectAlphaWikiPair(entries, '0.1.2-alpha.1'), {
    initial: entries[0],
    update: entries[1],
  })
  entries[1].compatibility.dsh = '0.1.1-rc.2'
  assert.equal(selectAlphaWikiPair(entries, '0.1.2-alpha.1'), null)
})

test('development mode admits only an immutable github shorthand and explicit package identity', () => {
  const parsed = parseOrdinaryUserArguments([
    '--mode', 'development',
    '--dsh-version', '0.1.2-alpha.1',
    '--dsh-source-root', '/official/deepseek-harness',
    '--dsh-commit', alphaCommit,
    '--center-initial-spec', `github:striveh/dsh-plugin-extension-center#${initialCenterCommit}`,
    '--center-target-spec', `github:striveh/dsh-plugin-extension-center#${targetCenterCommit}`,
    '--center-package-name', 'dsh-plugin-extension-center',
  ])
  assert.equal(parsed.launcher.kind, 'development-source')
  assert.equal(parsed.launcher.sourceCommit, alphaCommit)
  assert.deepEqual(parsed.center, {
    initial: {
      kind: 'github',
      packageName: 'dsh-plugin-extension-center',
      spec: `github:striveh/dsh-plugin-extension-center#${initialCenterCommit}`,
      commit: initialCenterCommit,
      selector: null,
    },
    target: {
      kind: 'github',
      packageName: 'dsh-plugin-extension-center',
      spec: `github:striveh/dsh-plugin-extension-center#${targetCenterCommit}`,
      commit: targetCenterCommit,
      selector: null,
    },
  })
})

test('requires an immutable previous release and a distinct update target', () => {
  assert.throws(
    () => parseOrdinaryUserArguments([
      '--center-initial-spec', 'dsh-plugin-extension-center@latest',
      '--center-target-spec', 'dsh-plugin-extension-center@next',
    ]),
    /initial Center registry spec must select one exact version/u,
  )
  assert.throws(
    () => parseOrdinaryUserArguments([
      '--center-initial-spec', 'dsh-plugin-extension-center@0.1.0',
      '--center-target-spec', 'dsh-plugin-extension-center@0.1.0',
    ]),
    /must differ/u,
  )
})

test('binds a mutable target selector to one workflow-verified version and integrity', () => {
  const config = parseOrdinaryUserArguments([
    '--expected-center-target-version', '0.2.0-alpha.1',
    '--expected-center-target-integrity', targetIntegrity,
  ])
  assert.deepEqual(config.expectedCenterTarget, {
    version: '0.2.0-alpha.1',
    integrity: targetIntegrity,
  })
  assert.doesNotThrow(() => assertExpectedCenterTarget(config, {
    status: 'published', version: '0.2.0-alpha.1', integrity: targetIntegrity,
  }))
  assert.throws(
    () => assertExpectedCenterTarget(config, {
      status: 'published', version: '0.2.0-alpha.2', integrity: targetIntegrity,
    }),
    /does not match the publication workflow binding/u,
  )
  assert.throws(
    () => parseOrdinaryUserArguments(['--expected-center-target-version', '0.2.0-alpha.1']),
    /must be supplied together/u,
  )
  assert.throws(
    () => parseOrdinaryUserArguments([
      '--expected-center-target-version', '0.2.0-alpha.1',
      '--expected-center-target-integrity', 'sha512-not-canonical',
    ]),
    /canonical SHA-512/u,
  )
})

test('admits only complete protected-main Actions provenance', () => {
  const environment = actionsEnvironment()
  assert.deepEqual(actionsProvenanceFromEnvironment(environment), {
    repository: 'striveh/dsh-plugin-extension-center',
    repositoryId: '123456789',
    workflowFile: '.github/workflows/ordinary-user.yml',
    workflowRef: 'striveh/dsh-plugin-extension-center/.github/workflows/ordinary-user.yml@refs/heads/main',
    ref: 'refs/heads/main',
    commit: 'f'.repeat(40),
    eventName: 'workflow_dispatch',
    refProtected: true,
    runId: '987654321',
    runAttempt: '2',
  })
  assert.equal(actionsProvenanceFromEnvironment({}), null)
  assert.throws(
    () => actionsProvenanceFromEnvironment({ GITHUB_ACTIONS: 'true' }),
    /incomplete/u,
  )
  assert.throws(
    () => actionsProvenanceFromEnvironment({ ...environment, GITHUB_REF_PROTECTED: 'false' }),
    /protected main/u,
  )
})

test('compares exact release and prerelease update targets by semantic precedence', () => {
  assert.equal(compareExactVersions('0.1.1', '0.1.0'), 1)
  assert.equal(compareExactVersions('0.1.2-alpha.1', '0.1.2-alpha.0'), 1)
  assert.equal(compareExactVersions('0.1.2', '0.1.2-alpha.1'), 1)
  assert.equal(compareExactVersions('0.1.0+target', '0.1.0+initial'), 0)
  assert.equal(compareExactVersions('0.1.0-alpha.1', '0.1.0-alpha.beta'), -1)
})

test('rejects every local, URL, mutable git, and tarball Center escape', () => {
  for (const spec of [
    './plugin',
    '../plugin',
    '/tmp/plugin',
    'file:./plugin',
    'link:../plugin',
    'workspace:*',
    'https://example.invalid/plugin.tgz',
    'plugin-1.0.0.tgz',
    'github:striveh/dsh-plugin-extension-center#main',
    `git+https://github.com/striveh/dsh-plugin-extension-center.git#${targetCenterCommit}`,
  ]) {
    assert.throws(
      () => parseCenterSpec(spec, 'development'),
      /(?:forbidden|canonical|immutable)/iu,
      spec,
    )
  }
})

test('registry mode rejects even an immutable github spec', () => {
  assert.throws(
    () => parseCenterSpec(`github:striveh/dsh-plugin-extension-center#${targetCenterCommit}`, 'registry'),
    /registry mode accepts only/u,
  )
})

test('validates source launcher coupling and supports command prefix flags', () => {
  assert.throws(
    () => parseOrdinaryUserArguments(['--mode', 'development', '--dsh-source-root', '/official']),
    /requires one lowercase 40-character commit/u,
  )
  assert.throws(
    () => parseOrdinaryUserArguments(['--dsh-source-root', '/official', '--dsh-commit', alphaCommit]),
    /registry mode cannot use/u,
  )
  const command = parseOrdinaryUserArguments([
    '--mode', 'development',
    '--dsh-command', 'node',
    '--dsh-arg', '--import',
    '--dsh-arg', 'tsx/esm',
    '--center-initial-spec', 'dsh-plugin-extension-center@0.1.0',
    '--center-target-spec', 'dsh-plugin-extension-center@next',
  ])
  assert.equal(command.launcher.kind, 'external-command')
  assert.deepEqual(command.launcher.arguments, ['--import', 'tsx/esm'])
})

test('pending and failed receipts stay RED and never retain an underlying diagnostic', () => {
  const config = parseOrdinaryUserArguments([], '/acceptance')
  const pending = markPending(createOrdinaryUserReceipt(config), 'official DSH')
  assert.equal(pending.status, 'pending')
  assert.equal(pending.laneStatus, 'red')
  assert.equal(pending.p0Status, 'red')
  assertSecretFreeReceipt(pending)

  const updatePending = markUpdatePending(createOrdinaryUserReceipt(config))
  assert.equal(updatePending.status, 'pending')
  assert.equal(updatePending.p0Status, 'red')
  assert.equal(updatePending.failure.code, 'ORDINARY-USER-UPDATE-PENDING')
  assertSecretFreeReceipt(updatePending)

  const managementPending = markManagementPending(
    createOrdinaryUserReceipt(config),
    'signed alpha-compatible Skill successor pair',
  )
  assert.equal(managementPending.status, 'pending')
  assert.equal(managementPending.p0Status, 'red')
  assert.equal(managementPending.failure.code, 'ORDINARY-USER-MANAGEMENT-CANDIDATE-PENDING')
  assertSecretFreeReceipt(managementPending)

  const failed = markFailed(
    createOrdinaryUserReceipt(config),
    new OrdinaryUserLaneFailure('ORDINARY-USER-HOST-START', 'host-start', 'Host did not become ready', new Error('API_KEY=do-not-persist')),
    'fallback',
  )
  assert.equal(failed.status, 'failed')
  assert.equal(failed.p0Status, 'red')
  assert.doesNotMatch(JSON.stringify(failed), /do-not-persist/u)
  assertSecretFreeReceipt(failed)
})

test('only a protected self-installed registry run can prove the alpha Skill lane without claiming product P0', () => {
  const localRegistry = parseOrdinaryUserArguments([])
  const local = markPassed(completedReceipt(localRegistry), localRegistry)
  assert.equal(local.laneStatus, 'not-proven-local')
  assert.equal(local.p0Status, 'red')
  const registry = parseOrdinaryUserArguments([], process.cwd(), actionsEnvironment())
  assert.throws(
    () => markPassed(createOrdinaryUserReceipt(registry), registry),
    /evidence is incomplete/u,
  )
  assert.throws(
    () => markPassed(deliveryOnlyReceipt(registry), registry),
    error => error instanceof OrdinaryUserLaneFailure
      && error.code === 'ORDINARY-USER-MANAGEMENT-LIFECYCLE-MISSING',
    'UI-only delivery evidence must not become proven management evidence',
  )
  const unchanged = completedReceipt(registry)
  unchanged.observations.registry.centerTarget.version = '0.1.0'
  assert.throws(
    () => markPassed(unchanged, registry),
    /strictly newer target/u,
  )
  const protectedReceipt = markPassed(completedReceipt(registry), registry)
  assert.equal(protectedReceipt.laneStatus, 'proven')
  assert.equal(protectedReceipt.p0Status, 'red')
  assert.deepEqual(protectedReceipt.productCoverage, {
    pluginLifecycle: 'pending',
    mcpLifecycle: 'pending',
    skillLifecycle: 'proven',
    agentAcquisitionContinuation: 'pending',
  })

  const moved = completedReceipt(registry)
  moved.observations.registry.centerTargetAfterInstall.integrity = 'sha512-moved'
  assert.throws(
    () => markPassed(moved, registry),
    /published immutable previous version and strictly newer target/u,
    'a mutable target selector must retain the same version and integrity across installation',
  )

  const unauthenticated = completedReceipt(registry)
  unauthenticated.observations.management.authentication.browserSessionEstablished = false
  assert.throws(
    () => markPassed(unauthenticated, registry),
    /evidence is incomplete/u,
    'a lifecycle reached outside the authenticated official browser session must not become proven',
  )

  const rpcOnly = completedReceipt(registry)
  rpcOnly.observations.management.userInterface.operationKinds = []
  rpcOnly.observations.management.userInterface.planReviewsObserved = 0
  rpcOnly.observations.management.userInterface.approvalsClicked = 0
  rpcOnly.observations.management.userInterface.lifecycleCompletionsObserved = 0
  rpcOnly.observations.management.userInterface.directMutationRpcCalls = 7
  assert.throws(
    () => markPassed(rpcOnly, registry),
    /evidence is incomplete/u,
    'direct authenticated RPC mutation must not substitute for the ordinary-user UI lifecycle',
  )

  const skippedRestore = completedReceipt(registry)
  skippedRestore.observations.management.restore.receiptDigest = null
  assert.throws(
    () => markPassed(skippedRestore, registry),
    /restore, and final cleanup evidence is incomplete/u,
  )

  const erasedHistory = completedReceipt(registry)
  erasedHistory.observations.management.finalCleanup.targetRowCount = 0
  assert.throws(
    () => markPassed(erasedHistory, registry),
    /final cleanup evidence is incomplete/u,
    'purge must prove absent managed state without erasing its non-recoverable history row',
  )

  const bound = parseOrdinaryUserArguments([
    '--expected-center-target-version', '0.2.0-alpha.1',
    '--expected-center-target-integrity', targetIntegrity,
  ])
  const drifted = completedReceipt(bound)
  drifted.observations.registry.centerTarget = {
    status: 'published', version: '0.2.0-alpha.2', integrity: targetIntegrity,
  }
  drifted.observations.registry.centerTargetAfterInstall = {
    status: 'published', version: '0.2.0-alpha.2', integrity: targetIntegrity,
  }
  assert.throws(() => markPassed(drifted, bound), /publication workflow binding/u)

  const development = parseOrdinaryUserArguments([
    '--mode', 'development',
    '--dsh-source-root', '/official/deepseek-harness',
    '--dsh-commit', alphaCommit,
    '--center-initial-spec', `github:striveh/dsh-plugin-extension-center#${initialCenterCommit}`,
    '--center-target-spec', `github:striveh/dsh-plugin-extension-center#${targetCenterCommit}`,
  ])
  const receipt = markPassed(completedReceipt(development), development)
  assert.equal(receipt.laneStatus, 'not-proven-development')
  assert.equal(receipt.p0Status, 'red')
  assert.doesNotMatch(JSON.stringify(receipt), /\/official\/deepseek-harness/u)
  assertSecretFreeReceipt(receipt)
})

test('ordinary-user lifecycle mutations are driven through the accessible browser UI', async () => {
  const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(
    source,
    /rpc\.call\(['"](?:intent\/preview|plan\/decide|lifecycle\/request)['"]/u,
    'the runner must not issue lifecycle mutations through its read-only verification RPC helper',
  )
  for (const label of [
    'Review install', 'Save and review', 'Configure', 'Update', 'Uninstall', 'Restore',
    'Purge retained data', 'Approve exact plan', 'Lifecycle operation finished',
  ]) {
    assert.match(source, new RegExp(label, 'u'))
  }
})

test('ordinary-user verification helper rejects and records every direct mutation attempt', async () => {
  let browserRequests = 0
  const page = {
    evaluate: async () => {
      browserRequests += 1
      throw new Error('unreachable browser request')
    },
  }
  const audit = { directMutationRpcCalls: 0 }
  const rpc = createManagementRpc('http://127.0.0.1:3000', page, audit)
  for (const method of ['intent/preview', 'plan/decide', 'lifecycle/request']) {
    await assert.rejects(
      rpc.call(method, { protocolVersion: 1 }),
      /is not an admitted read-only verification method/u,
    )
  }
  assert.equal(audit.directMutationRpcCalls, 3)
  assert.equal(browserRequests, 0)
})

test('ordinary-user contract workflow installs the locked test runtime before loading the runner', async () => {
  const workflow = parseYaml(await readFile(
    new URL('../../.github/workflows/ordinary-user.yml', import.meta.url),
    'utf8',
  ))
  const steps = workflow.jobs.contract.steps
  const installIndex = steps.findIndex(step => step.name === 'Install locked dependencies')
  const verifyIndex = steps.findIndex(step => step.name === 'Verify ordinary-user runner contract')
  assert.ok(steps.some(step => step.name === 'Install pnpm'))
  assert.ok(installIndex >= 0 && installIndex < verifyIndex)
  assert.equal(steps[installIndex].run, 'pnpm install --frozen-lockfile')
})

test('writes a receipt atomically without adding forbidden evidence fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ordinary-user-receipt-test-'))
  try {
    const config = parseOrdinaryUserArguments([], root)
    const receipt = markPending(createOrdinaryUserReceipt(config), 'Extension Center')
    const path = join(root, 'nested', 'receipt.json')
    await writeOrdinaryUserReceipt(path, receipt)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), receipt)
    assert.equal(verifyOrdinaryUserReceiptDigest(receipt), true)
    receipt.status = 'forged'
    assert.equal(verifyOrdinaryUserReceiptDigest(receipt), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cross-binds a protected receipt to GitHub run metadata and exact artifact archive bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ordinary-user-actions-evidence-test-'))
  try {
    const config = parseOrdinaryUserArguments([], root, actionsEnvironment())
    const receipt = markPassed(completedReceipt(config), config)
    await writeOrdinaryUserReceipt(join(root, 'receipt.json'), receipt)
    const archive = Buffer.from('exact GitHub Actions artifact archive bytes')
    const artifactDigest = `sha256:${createHash('sha256').update(archive).digest('hex')}`
    const artifactName = `ordinary-user-${'f'.repeat(40)}-attempt-2`
    const evidence = createActionsArtifactEvidence(receipt, {
      name: artifactName,
      id: '345678901',
      digest: artifactDigest,
    })
    assert.equal(verifyActionsArtifactEvidence(receipt, evidence), true)
    const run = {
      id: 987654321,
      run_attempt: 2,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      head_sha: 'f'.repeat(40),
      path: '.github/workflows/ordinary-user.yml',
      repository: { id: 123456789, full_name: 'striveh/dsh-plugin-extension-center' },
    }
    const artifacts = {
      artifacts: [{
        id: 345678901,
        name: artifactName,
        expired: false,
        digest: artifactDigest,
        workflow_run: {
          id: 987654321,
          repository_id: 123456789,
          head_branch: 'main',
          head_sha: 'f'.repeat(40),
        },
      }],
    }
    assert.equal(verifyActionsRunBinding(evidence, run, artifacts, archive), true)
    assert.equal(verifyActionsRunBinding(evidence, run, artifacts, Buffer.from('changed')), false)
    assert.equal(verifyActionsArtifactEvidence(receipt, { ...evidence, status: 'forged' }), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('forbidden receipt keys fail closed', () => {
  assert.throws(() => assertSecretFreeReceipt({ stdout: 'safe-looking' }), /forbidden field/u)
  assert.throws(() => assertSecretFreeReceipt({ nested: { apiToken: 'x' } }), /forbidden field/u)
})
