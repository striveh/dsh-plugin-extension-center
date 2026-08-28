import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

/** Public npm registry admitted by the ordinary-user production lane. */
export const NPM_REGISTRY = 'https://registry.npmjs.org/'

/** Newest official DSH source release targeted while its npm publication is pending. */
export const DEFAULT_DSH_VERSION = '0.1.2-alpha.1'

/** Package manager version required by the official DSH Plugin CLI. */
export const PNPM_VERSION = '11.21.0'

/** First immutable registry release used to prove a real upgrade. */
export const DEFAULT_CENTER_INITIAL_SPEC = 'dsh-plugin-extension-center@0.2.0-alpha.0'

/** Exact alpha target users will update to after Extension Center publication. */
export const DEFAULT_CENTER_TARGET_SPEC = 'dsh-plugin-extension-center@next'

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const SELECTOR = /^[A-Za-z0-9*^~<>=|._+ -]+$/u
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const COMMIT = /^[0-9a-f]{40}$/u
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u
export const WIKI_SKILL_V1 = 'skill:microsoft-skills/wiki-page-writer@6142f8e60ac58372845c0fcdd2dbf043cd1bb698'
export const WIKI_SKILL_V2 = 'skill:microsoft-skills/wiki-page-writer@67ae723a23ba880e3e5c8a3e5e2320092024476e'
const GITHUB_SPEC = /^github:(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/(?<repo>[A-Za-z0-9][A-Za-z0-9._-]*)#(?<commit>[0-9a-f]{40})$/u
const FORBIDDEN_RECEIPT_KEY = /(?:authorization|cookie|credential|home|password|path|secret|stderr|stdout|token|workspace)/iu
const MANAGEMENT_OPERATION_KINDS = Object.freeze([
  'install', 'configure', 'update', 'uninstall', 'restore', 'uninstall', 'purge',
])
const MANAGEMENT_WRITE_METHODS = Object.freeze(MANAGEMENT_OPERATION_KINDS.flatMap(() => [
  'intent/preview', 'plan/decide', 'lifecycle/request',
]))
const MANAGEMENT_VERIFICATION_METHODS = Object.freeze([
  ...MANAGEMENT_OPERATION_KINDS.map(() => 'inventory/verify'),
  'inventory/list',
])
const GITHUB_NUMBER = /^[1-9][0-9]{0,19}$/u
const ACTIONS_REPOSITORY = 'striveh/dsh-plugin-extension-center'
const ACTIONS_WORKFLOWS = Object.freeze([
  '.github/workflows/npm-publish.yml',
  '.github/workflows/ordinary-user.yml',
])
const ACTIONS_ENVIRONMENT_KEYS = Object.freeze([
  'GITHUB_ACTIONS',
  'GITHUB_EVENT_NAME',
  'GITHUB_REF',
  'GITHUB_REF_PROTECTED',
  'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID',
  'GITHUB_SERVER_URL',
  'GITHUB_SHA',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA',
])

/** Stable input error raised before the lane performs external work. */
export class OrdinaryUserInputError extends Error {
  /**
   * @param {string} code Stable validation code.
   * @param {string} message Public validation message.
   */
  constructor(code, message) {
    super(`[${code}] ${message}`)
    this.name = 'OrdinaryUserInputError'
    this.code = code
  }
}

/** Stable runtime failure carrying only receipt-safe public fields. */
export class OrdinaryUserLaneFailure extends Error {
  /**
   * @param {string} code Stable failure code.
   * @param {string} stage Acceptance stage.
   * @param {string} message Receipt-safe failure message.
   * @param {unknown} [cause] Underlying diagnostic, never persisted in the receipt.
   */
  constructor(code, stage, message, cause) {
    super(`[${code}] ${message}`, cause === undefined ? undefined : { cause })
    this.name = 'OrdinaryUserLaneFailure'
    this.code = code
    this.stage = stage
  }
}

/**
 * Parse a strict registry package spec or immutable GitHub development spec.
 * @param {string} value User-provided package spec.
 * @param {'development' | 'registry'} mode Lane mode.
 * @param {string | undefined} explicitName Package identity for a GitHub spec.
 * @returns {{kind: 'github' | 'registry', packageName: string, spec: string, commit: string | null, selector: string | null}}
 */
export function parseCenterSpec(value, mode, explicitName) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new OrdinaryUserInputError('ORDINARY-USER-CENTER-SPEC', 'Center package spec must be one non-empty argument')
  }
  const github = GITHUB_SPEC.exec(value)
  if (github !== null) {
    if (mode !== 'development') {
      throw new OrdinaryUserInputError(
        'ORDINARY-USER-REGISTRY-ONLY',
        'registry mode accepts only an npm registry package spec',
      )
    }
    const packageName = explicitName ?? 'dsh-plugin-extension-center'
    assertPackageName(packageName, 'Center package name')
    return Object.freeze({
      kind: 'github',
      packageName,
      spec: value,
      commit: github.groups?.commit ?? null,
      selector: null,
    })
  }
  if (/^(?:file|git|git\+|http|https|link|workspace):/iu.test(value)
    || value.startsWith('.') || value.startsWith('/') || value.startsWith('~')
    || value.includes('\\') || value.toLowerCase().endsWith('.tgz')) {
    throw new OrdinaryUserInputError(
      'ORDINARY-USER-LOCAL-SPEC-FORBIDDEN',
      'file, path, URL, git, workspace, and tarball Center specs are forbidden',
    )
  }
  const parsed = splitRegistrySpec(value)
  if (parsed === null) {
    throw new OrdinaryUserInputError('ORDINARY-USER-CENTER-SPEC', 'Center spec is not a canonical npm registry package spec')
  }
  if (explicitName !== undefined && explicitName !== parsed.packageName) {
    throw new OrdinaryUserInputError(
      'ORDINARY-USER-CENTER-NAME',
      'explicit Center package name does not match the registry spec',
    )
  }
  return Object.freeze({
    kind: 'registry',
    packageName: parsed.packageName,
    spec: value,
    commit: null,
    selector: parsed.selector ?? null,
  })
}

/** Select the only immutable Skill successor pair admitted by the alpha ordinary-user lane. */
export function selectAlphaWikiPair(entries, dshVersion) {
  const expected = [
    {
      candidateRef: WIKI_SKILL_V1,
      version: '6142f8e60ac58372845c0fcdd2dbf043cd1bb698',
      integrity: 'sha256:7929f8adf896dbbf1fd744493f643c55a6812f0418d6cd89b3284f8f924d0c8f',
      sizeBytes: 5_807,
    },
    {
      candidateRef: WIKI_SKILL_V2,
      version: '67ae723a23ba880e3e5c8a3e5e2320092024476e',
      integrity: 'sha256:f1270ea4123116e846bf2dc7a53a9e396ed43d694cdb7be22b9a35da9a40feb6',
      sizeBytes: 5_869,
    },
  ]
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const selected = expected.map(identity => entries.find(entry => (
    entry?.candidateRef === identity.candidateRef
      && entry.kind === 'skill'
      && entry.name === 'wiki-page-writer'
      && entry.artifact?.version === identity.version
      && entry.artifact?.integrity === identity.integrity
      && entry.artifact?.sizeBytes === identity.sizeBytes
      && entry.source?.revision === identity.version
      && entry.compatibility?.status === 'compatible'
      && entry.compatibility?.dsh === dshVersion
      && Array.isArray(entry.compatibility?.platforms)
      && entry.compatibility.platforms.includes(platform)
      && entry.scopes?.includes('user')
      && entry.configuration?.credentials === 'none'
      && ['install', 'configure', 'update', 'uninstall', 'restore']
        .every(operation => entry.lifecycle?.[operation]?.status === 'available')
  )))
  if (selected.some(entry => entry === undefined)) return null
  return Object.freeze({ initial: selected[0], update: selected[1] })
}

/**
 * Parse the ordinary-user lane CLI without performing external work.
 * @param {readonly string[]} argv CLI arguments after the script name.
 * @param {string} [cwd] Invoking directory used for the receipt default.
 * @returns {Readonly<Record<string, unknown>>} Validated lane configuration.
 */
export function parseOrdinaryUserArguments(argv, cwd = process.cwd(), environment = process.env) {
  const values = {
    mode: 'registry',
    dshVersion: DEFAULT_DSH_VERSION,
    centerInitialSpec: DEFAULT_CENTER_INITIAL_SPEC,
    centerTargetSpec: DEFAULT_CENTER_TARGET_SPEC,
    centerPackageName: undefined,
    expectedCenterTargetVersion: undefined,
    expectedCenterTargetIntegrity: undefined,
    dshCommand: undefined,
    dshArguments: [],
    dshSourceRoot: undefined,
    dshCommit: undefined,
    receiptPath: resolve(cwd, '.artifacts/acceptance/ordinary-user/receipt.json'),
    keepTemporaryRoot: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') {
      values.help = true
      continue
    }
    if (argument === '--keep-temp') {
      values.keepTemporaryRoot = true
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || argument !== '--dsh-arg' && next.startsWith('--')) {
      throw new OrdinaryUserInputError('ORDINARY-USER-ARGUMENT', `${argument} requires one value`)
    }
    index += 1
    switch (argument) {
      case '--mode': values.mode = next; break
      case '--dsh-version': values.dshVersion = next; break
      case '--center-initial-spec': values.centerInitialSpec = next; break
      case '--center-target-spec': values.centerTargetSpec = next; break
      case '--center-package-name': values.centerPackageName = next; break
      case '--expected-center-target-version': values.expectedCenterTargetVersion = next; break
      case '--expected-center-target-integrity': values.expectedCenterTargetIntegrity = next; break
      case '--dsh-command': values.dshCommand = next; break
      case '--dsh-arg': values.dshArguments.push(next); break
      case '--dsh-source-root': values.dshSourceRoot = next; break
      case '--dsh-commit': values.dshCommit = next; break
      case '--receipt': values.receiptPath = resolve(cwd, next); break
      default: throw new OrdinaryUserInputError('ORDINARY-USER-ARGUMENT', `unknown argument ${argument}`)
    }
  }
  if (!['development', 'registry'].includes(values.mode)) {
    throw new OrdinaryUserInputError('ORDINARY-USER-MODE', 'mode must be registry or development')
  }
  if (!VERSION.test(values.dshVersion)) {
    throw new OrdinaryUserInputError('ORDINARY-USER-DSH-VERSION', 'DSH version must be one canonical exact version')
  }
  if (values.dshCommand === undefined && values.dshArguments.length > 0) {
    throw new OrdinaryUserInputError('ORDINARY-USER-DSH-COMMAND', '--dsh-arg requires --dsh-command')
  }
  if (values.dshSourceRoot !== undefined && !isAbsolute(values.dshSourceRoot)) {
    throw new OrdinaryUserInputError('ORDINARY-USER-DSH-SOURCE', 'DSH source root must be absolute')
  }
  if (values.mode === 'registry' && (values.dshSourceRoot !== undefined || values.dshCommit !== undefined)) {
    throw new OrdinaryUserInputError('ORDINARY-USER-REGISTRY-ONLY', 'registry mode cannot use a DSH source launcher')
  }
  if (values.dshSourceRoot !== undefined && values.dshCommand !== undefined) {
    throw new OrdinaryUserInputError('ORDINARY-USER-DSH-COMMAND', 'choose either a DSH source root or a DSH command')
  }
  if (values.dshSourceRoot !== undefined && !COMMIT.test(values.dshCommit ?? '')) {
    throw new OrdinaryUserInputError(
      'ORDINARY-USER-DSH-COMMIT',
      'a DSH source launcher requires one lowercase 40-character commit',
    )
  }
  if (values.dshSourceRoot === undefined && values.dshCommit !== undefined) {
    throw new OrdinaryUserInputError('ORDINARY-USER-DSH-COMMIT', '--dsh-commit requires --dsh-source-root')
  }
  const centerInitial = parseCenterSpec(values.centerInitialSpec, values.mode, values.centerPackageName)
  const centerTarget = parseCenterSpec(values.centerTargetSpec, values.mode, values.centerPackageName)
  if (centerInitial.packageName !== centerTarget.packageName) {
    throw new OrdinaryUserInputError(
      'ORDINARY-USER-CENTER-NAME',
      'initial and target Center specs must address the same package',
    )
  }
  if (centerInitial.kind === 'registry' && !VERSION.test(centerInitial.selector ?? '')) {
    throw new OrdinaryUserInputError(
      'ORDINARY-USER-INITIAL-IMMUTABLE',
      'initial Center registry spec must select one exact version',
    )
  }
  if (centerInitial.spec === centerTarget.spec) {
    throw new OrdinaryUserInputError(
      'ORDINARY-USER-UPDATE-TARGET',
      'initial and target Center specs must differ',
    )
  }
  if ((values.expectedCenterTargetVersion === undefined) !== (values.expectedCenterTargetIntegrity === undefined)) {
    throw new OrdinaryUserInputError(
      'ORDINARY-USER-TARGET-BINDING',
      'expected Center target version and integrity must be supplied together',
    )
  }
  let expectedCenterTarget = null
  if (values.expectedCenterTargetVersion !== undefined) {
    if (values.mode !== 'registry' || centerTarget.kind !== 'registry') {
      throw new OrdinaryUserInputError(
        'ORDINARY-USER-TARGET-BINDING',
        'an expected Center target binding is available only in registry mode',
      )
    }
    if (!VERSION.test(values.expectedCenterTargetVersion)
      || !isCanonicalSha512Integrity(values.expectedCenterTargetIntegrity)) {
      throw new OrdinaryUserInputError(
        'ORDINARY-USER-TARGET-BINDING',
        'expected Center target must contain one exact version and canonical SHA-512 integrity',
      )
    }
    expectedCenterTarget = Object.freeze({
      version: values.expectedCenterTargetVersion,
      integrity: values.expectedCenterTargetIntegrity,
    })
  }
  const launcherKind = values.dshSourceRoot !== undefined
    ? 'development-source'
    : values.dshCommand !== undefined ? 'external-command' : 'registry-installed'
  return Object.freeze({
    mode: values.mode,
    dshPackage: '@deepseek-ai/dsh',
    dshVersion: values.dshVersion,
    center: Object.freeze({ initial: centerInitial, target: centerTarget }),
    expectedCenterTarget,
    actionsProvenance: actionsProvenanceFromEnvironment(environment),
    launcher: Object.freeze({
      kind: launcherKind,
      command: values.dshCommand,
      arguments: Object.freeze([...values.dshArguments]),
      sourceRoot: values.dshSourceRoot,
      sourceCommit: values.dshCommit,
    }),
    receiptPath: values.receiptPath,
    keepTemporaryRoot: values.keepTemporaryRoot,
    help: values.help,
  })
}

/**
 * Construct the running receipt. It intentionally contains no local paths or process output.
 * @param {ReturnType<typeof parseOrdinaryUserArguments>} config Validated configuration.
 * @returns {Record<string, unknown>} Mutable receipt owned by the runner.
 */
export function createOrdinaryUserReceipt(config) {
  return {
    schemaVersion: 3,
    acceptanceId: 'P0-ALPHA-ORDINARY-USER-REGISTRY-HOST-CLIENT-SKILL-LIFECYCLE',
    status: 'running',
    laneStatus: 'not-proven',
    p0Status: 'red',
    receiptDigest: null,
    mode: config.mode,
    productCoverage: {
      pluginLifecycle: 'pending',
      mcpLifecycle: 'pending',
      skillLifecycle: 'running',
      agentAcquisitionContinuation: 'pending',
    },
    actionsProvenance: config.actionsProvenance,
    target: {
      registry: NPM_REGISTRY,
      profileId: 'web',
      dshPackage: `${config.dshPackage}@${config.dshVersion}`,
      pnpmPackage: `pnpm@${PNPM_VERSION}`,
      expectedDshVersion: config.dshVersion,
      centerPackageName: config.center.initial.packageName,
      centerInitialSpec: config.center.initial.spec,
      centerInitialSourceKind: config.center.initial.kind,
      centerTargetSpec: config.center.target.spec,
      centerTargetSourceKind: config.center.target.kind,
      expectedCenterTargetVersion: config.expectedCenterTarget?.version ?? null,
      expectedCenterTargetIntegrity: config.expectedCenterTarget?.integrity ?? null,
      launcherKind: config.launcher.kind,
      sourceCommit: config.launcher.sourceCommit ?? null,
    },
    observations: {
      registry: { dsh: null, centerInitial: null, centerTarget: null, centerTargetAfterInstall: null },
      cli: {
        pnpmVersionMatched: false,
        versionMatched: false,
        initialAddPassed: false,
        initialListPassed: false,
        initialDumpContainedBundle: false,
        updatePassed: false,
        updatedListPassed: false,
        updatedDumpContainedBundle: false,
        removePassed: false,
        removedListAbsent: false,
        removedDumpAbsent: false,
      },
      profile: {
        initialExactDependency: false,
        initialArtifactBound: false,
        initialBundleCount: 0,
        initialInstalledVersion: null,
        targetExactDependency: false,
        targetArtifactBound: false,
        targetBundleCount: 0,
        targetInstalledVersion: null,
        updateAdvanced: false,
        removedDependencyAbsent: false,
        removedBundleAbsent: false,
        removedPackageAbsent: false,
      },
      host: { ready: false, remainedLive: false },
      client: {
        bootEntryObserved: false,
        bundleRequestObserved: false,
        extensionsButtonObserved: false,
        storeDialogObserved: false,
        storeTabsObserved: false,
        configurationFilterObserved: false,
        configurationReadyEntryObserved: false,
        consoleFailures: 0,
      },
      management: {
        authentication: {
          browserSessionEstablished: false,
          missingSessionRejected: false,
          invalidSessionRejected: false,
          crossOriginRejected: false,
        },
        userInterface: {
          driver: null,
          scopeKey: null,
          operationKinds: [],
          planReviewsObserved: 0,
          approvalsClicked: 0,
          lifecycleCompletionsObserved: 0,
          directMutationRpcCalls: 0,
        },
        discovery: {
          methods: [],
          catalogId: null,
          catalogRevision: null,
          catalogEntriesDigest: null,
          catalogSignatureStatus: null,
          catalogKeyIds: [],
          catalogSource: null,
          catalogFreshness: null,
          catalogDegraded: null,
          extensionKind: null,
          extensionName: null,
          targetKey: null,
          initialCandidateRef: null,
          updateCandidateRef: null,
          initialArtifactRevision: null,
          initialArtifactIntegrity: null,
          initialArtifactSizeBytes: null,
          updateArtifactRevision: null,
          updateArtifactIntegrity: null,
          updateArtifactSizeBytes: null,
          initialCompatibilityDsh: null,
          updateCompatibilityDsh: null,
          initialEligible: false,
          updateEligible: false,
        },
        configurationMethods: [],
        writeMethods: [],
        receiptMethods: [],
        verificationMethods: [],
        hostProcessStable: false,
        install: emptyManagementOperation('install'),
        configure: emptyManagementOperation('configure'),
        update: emptyManagementOperation('update'),
        uninstallForRestore: emptyManagementOperation('uninstall'),
        restore: emptyManagementOperation('restore'),
        finalUninstall: emptyManagementOperation('uninstall'),
        purge: emptyManagementOperation('purge'),
        finalCleanup: {
          inventoryRevision: null,
          targetRowCount: null,
          tombstoneRetained: null,
          candidateRef: null,
          desired: null,
          materialized: null,
          effective: null,
          agentVisibility: null,
          rollback: null,
          managedBytesAbsent: null,
          installActionAvailable: null,
        },
      },
      officialDshPackageTreeUnchanged: null,
    },
    failure: null,
  }
}

function emptyManagementOperation(operationKind) {
  return {
    sequence: null,
    operationKind,
    candidateRef: null,
    targetKey: null,
    planId: null,
    planHash: null,
    singleUse: null,
    decision: null,
    operationId: null,
    receiptDigest: null,
    outcome: null,
    externalRuntimeAction: null,
    inventoryRevision: null,
    inventoryRowPresent: null,
    managedRevision: null,
    configurationRevision: null,
    observedCandidateRef: null,
    rollback: null,
    restoreActionAvailable: null,
    installActionAvailable: null,
    managedBytesAbsent: null,
    desired: null,
    materialized: null,
    effective: null,
    agentVisibility: null,
    verification: null,
    userInvocable: null,
    ownerStateVerified: false,
  }
}

/** Mark a registry publication prerequisite as pending and therefore RED. */
export function markPending(receipt, subject) {
  receipt.status = 'pending'
  receipt.laneStatus = 'red'
  receipt.p0Status = 'red'
  receipt.productCoverage.skillLifecycle = 'pending'
  receipt.failure = {
    code: 'ORDINARY-USER-REGISTRY-PENDING',
    stage: 'registry-preflight',
    subject,
    message: `required ${subject} registry package is not published`,
  }
  return receipt
}

/** Mark a missing strictly newer update target as pending and therefore RED. */
export function markUpdatePending(receipt) {
  receipt.status = 'pending'
  receipt.laneStatus = 'red'
  receipt.p0Status = 'red'
  receipt.productCoverage.skillLifecycle = 'pending'
  receipt.failure = {
    code: 'ORDINARY-USER-UPDATE-PENDING',
    stage: 'registry-preflight',
    subject: 'Extension Center update',
    message: 'a published immutable previous version and strictly newer target are required',
  }
  return receipt
}

/** Mark an absent signed alpha lifecycle candidate pair as pending and therefore RED. */
export function markManagementPending(receipt, subject) {
  receipt.status = 'pending'
  receipt.laneStatus = 'red'
  receipt.p0Status = 'red'
  receipt.productCoverage.skillLifecycle = 'pending'
  receipt.failure = {
    code: 'ORDINARY-USER-MANAGEMENT-CANDIDATE-PENDING',
    stage: 'extension-management',
    subject,
    message: `required ${subject} is absent from the verified catalog`,
  }
  return receipt
}

/** Mark a runtime failure without persisting its potentially sensitive cause. */
export function markFailed(receipt, failure, fallbackStage) {
  receipt.status = 'failed'
  receipt.laneStatus = 'red'
  receipt.p0Status = 'red'
  receipt.productCoverage.skillLifecycle = 'red'
  receipt.failure = {
    code: failure instanceof OrdinaryUserLaneFailure ? failure.code : 'ORDINARY-USER-UNEXPECTED',
    stage: failure instanceof OrdinaryUserLaneFailure ? failure.stage : fallbackStage,
    message: failure instanceof OrdinaryUserLaneFailure
      ? failure.message.replace(/^\[[^\]]+\]\s*/u, '')
      : 'ordinary-user lifecycle failed; inspect the ephemeral runner diagnostic',
  }
  return receipt
}

/** Mark a completed lane, distinguishing production registry proof from development evidence. */
export function markPassed(receipt, config) {
  const observations = receipt.observations
  const productionProof = config.mode === 'registry'
    && config.center.initial.kind === 'registry'
    && config.center.target.kind === 'registry'
    && config.launcher.kind === 'registry-installed'
  const required = [
    observations.cli.pnpmVersionMatched,
    observations.cli.versionMatched,
    observations.cli.initialAddPassed,
    observations.cli.initialListPassed,
    observations.cli.initialDumpContainedBundle,
    observations.cli.updatePassed,
    observations.cli.updatedListPassed,
    observations.cli.updatedDumpContainedBundle,
    observations.cli.removePassed,
    observations.cli.removedListAbsent,
    observations.cli.removedDumpAbsent,
    observations.profile.initialExactDependency,
    observations.profile.initialArtifactBound,
    observations.profile.initialBundleCount === 1,
    observations.profile.targetExactDependency,
    observations.profile.targetArtifactBound,
    observations.profile.targetBundleCount === 1,
    observations.profile.updateAdvanced,
    observations.profile.removedDependencyAbsent,
    observations.profile.removedBundleAbsent,
    observations.profile.removedPackageAbsent,
    observations.host.ready,
    observations.host.remainedLive,
    observations.client.bootEntryObserved,
    observations.client.bundleRequestObserved,
    observations.client.extensionsButtonObserved,
    observations.client.storeDialogObserved,
    observations.client.storeTabsObserved,
    observations.client.configurationFilterObserved,
    observations.client.configurationReadyEntryObserved,
    observations.client.consoleFailures === 0,
  ]
  if (required.some(value => value !== true)) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-INCOMPLETE',
      'finalize',
      'ordinary-user update, configuration, Host, Client, and removal evidence is incomplete',
    )
  }
  assertManagementLifecycleEvidence(observations.management, config.dshVersion)
  if (productionProof && (observations.registry.centerInitial?.status !== 'published'
    || observations.registry.centerTarget?.status !== 'published'
    || observations.registry.centerTargetAfterInstall?.status !== 'published'
    || observations.registry.centerTargetAfterInstall.version !== observations.registry.centerTarget.version
    || observations.registry.centerTargetAfterInstall.integrity !== observations.registry.centerTarget.integrity
    || compareExactVersions(
      observations.registry.centerTarget.version,
      observations.registry.centerInitial.version,
    ) <= 0)) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-UPDATE-PENDING',
      'finalize',
      'registry proof requires a published immutable previous version and strictly newer target',
    )
  }
  if (productionProof) {
    assertExpectedCenterTarget(config, observations.registry.centerTarget)
    assertExpectedCenterTarget(config, observations.registry.centerTargetAfterInstall)
  }
  if (productionProof && observations.officialDshPackageTreeUnchanged !== true) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-OFFICIAL-DSH-MODIFIED',
      'finalize',
      'registry proof requires the official DSH package tree to remain unchanged',
    )
  }
  receipt.status = 'passed'
  receipt.laneStatus = productionProof
    ? config.actionsProvenance === null ? 'not-proven-local' : 'proven'
    : 'not-proven-development'
  receipt.p0Status = 'red'
  receipt.productCoverage.skillLifecycle = receipt.laneStatus
  receipt.failure = null
  return receipt
}

function assertManagementLifecycleEvidence(management, dshVersion) {
  const discovery = management?.discovery
  const sourceIsFresh = discovery?.catalogSource === 'bootstrap' && discovery.catalogFreshness === 'bootstrap'
    || discovery?.catalogSource === 'remote' && discovery.catalogFreshness === 'fresh'
    || discovery?.catalogSource === 'last-good' && discovery.catalogFreshness === 'cached'
  const initialCandidateRef = discovery?.initialCandidateRef
  const updateCandidateRef = discovery?.updateCandidateRef
  const targetKey = discovery?.targetKey
  const operations = [
    management?.install,
    management?.configure,
    management?.update,
    management?.uninstallForRestore,
    management?.restore,
    management?.finalUninstall,
    management?.purge,
  ]
  const operationExpectations = [
    ['install', initialCandidateRef, 'download', 'enabled', 'configured', 'active', 'visible', 'runtime', true, initialCandidateRef],
    ['configure', initialCandidateRef, 'none', 'enabled', 'configured', 'active', 'visible', 'runtime', false, initialCandidateRef],
    ['update', updateCandidateRef, 'download', 'enabled', 'configured', 'active', 'visible', 'runtime', false, updateCandidateRef],
    ['uninstall', updateCandidateRef, 'none', 'removed', 'absent', 'inactive', 'not-visible', 'unverified', null, updateCandidateRef],
    ['restore', updateCandidateRef, 'none', 'enabled', 'configured', 'active', 'visible', 'runtime', false, updateCandidateRef],
    ['uninstall', updateCandidateRef, 'none', 'removed', 'absent', 'inactive', 'not-visible', 'unverified', null, updateCandidateRef],
    ['purge', updateCandidateRef, 'none', 'removed', 'absent', 'inactive', 'not-visible', 'unverified', null, null],
  ]
  const managedRevisions = operations.map(operation => operation?.managedRevision)
  const inventoryRevisions = operations.map(operation => operation?.inventoryRevision)
  const initialConfigurationRevision = operations[0]?.configurationRevision
  const configuredRevision = operations[1]?.configurationRevision
  const required = [
    management?.authentication?.browserSessionEstablished === true,
    management?.authentication?.missingSessionRejected === true,
    management?.authentication?.invalidSessionRejected === true,
    management?.authentication?.crossOriginRejected === true,
    management?.userInterface?.driver === 'playwright-accessible-ui',
    management?.userInterface?.scopeKey === 'user',
    sameTextList(management?.userInterface?.operationKinds, MANAGEMENT_OPERATION_KINDS),
    management?.userInterface?.planReviewsObserved === MANAGEMENT_OPERATION_KINDS.length,
    management?.userInterface?.approvalsClicked === MANAGEMENT_OPERATION_KINDS.length,
    management?.userInterface?.lifecycleCompletionsObserved === MANAGEMENT_OPERATION_KINDS.length,
    management?.userInterface?.directMutationRpcCalls === 0,
    sameTextList(discovery?.methods, ['catalog/list', 'inventory/list', 'configuration/options']),
    discovery?.catalogId === 'dsh-extension-center-public',
    Number.isSafeInteger(discovery?.catalogRevision) && discovery.catalogRevision > 0,
    SHA256_DIGEST.test(discovery?.catalogEntriesDigest ?? ''),
    discovery?.catalogSignatureStatus === 'verified',
    Array.isArray(discovery?.catalogKeyIds)
      && discovery.catalogKeyIds.length > 0
      && discovery.catalogKeyIds.length <= 10
      && discovery.catalogKeyIds.every(boundedReceiptText)
      && new Set(discovery.catalogKeyIds).size === discovery.catalogKeyIds.length,
    sourceIsFresh,
    discovery?.catalogDegraded === false,
    discovery?.extensionKind === 'skill',
    boundedReceiptText(discovery?.extensionName),
    targetKey === `skill:web:user:${discovery?.extensionName ?? ''}`,
    boundedReceiptText(initialCandidateRef) && initialCandidateRef.startsWith('skill:'),
    boundedReceiptText(updateCandidateRef) && updateCandidateRef.startsWith('skill:'),
    initialCandidateRef !== updateCandidateRef,
    boundedReceiptText(discovery?.initialArtifactRevision),
    boundedReceiptText(discovery?.updateArtifactRevision),
    discovery?.initialArtifactRevision !== discovery?.updateArtifactRevision,
    initialCandidateRef?.endsWith(`@${discovery?.initialArtifactRevision ?? ''}`) === true,
    updateCandidateRef?.endsWith(`@${discovery?.updateArtifactRevision ?? ''}`) === true,
    initialCandidateRef?.includes(`/${discovery?.extensionName ?? ''}@`) === true,
    updateCandidateRef?.includes(`/${discovery?.extensionName ?? ''}@`) === true,
    SHA256_DIGEST.test(discovery?.initialArtifactIntegrity ?? ''),
    SHA256_DIGEST.test(discovery?.updateArtifactIntegrity ?? ''),
    discovery?.initialArtifactIntegrity !== discovery?.updateArtifactIntegrity,
    Number.isSafeInteger(discovery?.initialArtifactSizeBytes) && discovery.initialArtifactSizeBytes > 0,
    Number.isSafeInteger(discovery?.updateArtifactSizeBytes) && discovery.updateArtifactSizeBytes > 0,
    discovery?.initialCompatibilityDsh === dshVersion,
    discovery?.updateCompatibilityDsh === dshVersion,
    discovery?.initialEligible === true,
    discovery?.updateEligible === true,
    sameTextList(management?.configurationMethods, Array.from({ length: 4 }, () => 'configuration/options')),
    sameTextList(management?.writeMethods, MANAGEMENT_WRITE_METHODS),
    sameTextList(management?.receiptMethods, MANAGEMENT_OPERATION_KINDS.map(() => 'operation/get')),
    sameTextList(management?.verificationMethods, MANAGEMENT_VERIFICATION_METHODS),
    management?.hostProcessStable === true,
    operations.every((operation, index) => managementOperationMatches(
      operation,
      targetKey,
      operationExpectations[index],
      index + 1,
    )),
    managedRevisions.every(boundedReceiptText),
    new Set(managedRevisions).size === managedRevisions.length,
    inventoryRevisions.every(revision => SHA256_DIGEST.test(revision ?? '')),
    new Set(inventoryRevisions).size === inventoryRevisions.length,
    SHA256_DIGEST.test(initialConfigurationRevision ?? ''),
    SHA256_DIGEST.test(configuredRevision ?? ''),
    initialConfigurationRevision !== configuredRevision,
    operations[2]?.configurationRevision === configuredRevision,
    operations[4]?.configurationRevision === configuredRevision,
    operations[3]?.configurationRevision === null,
    operations[5]?.configurationRevision === null,
    operations[6]?.configurationRevision === null,
    operations[3]?.restoreActionAvailable === true,
    operations[5]?.restoreActionAvailable === true,
    operations[6]?.rollback === 'unavailable',
    operations[6]?.managedBytesAbsent === true,
    operations[6]?.installActionAvailable === true,
    finalCleanupMatches(management?.finalCleanup, operations[6]),
  ]
  if (required.some(value => value !== true)) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-MANAGEMENT-LIFECYCLE-MISSING',
      'finalize',
      'ordinary-user discovery, install, configure, update, verification, uninstall, restore, and final cleanup evidence is incomplete',
    )
  }
}

function managementOperationMatches(operation, targetKey, expectation, sequence) {
  const [
    operationKind,
    candidateRef,
    externalRuntimeAction,
    desired,
    materialized,
    effective,
    agentVisibility,
    verification,
    userInvocable,
    observedCandidateRef,
  ] = expectation
  return operation?.sequence === sequence
    && operation.operationKind === operationKind
    && operation.candidateRef === candidateRef
    && operation.targetKey === targetKey
    && boundedReceiptText(operation.planId)
    && operation.planId.startsWith('plan:')
    && SHA256_DIGEST.test(operation.planHash ?? '')
    && operation.singleUse === true
    && operation.decision === 'approve'
    && boundedReceiptText(operation.operationId)
    && operation.operationId.startsWith('operation:')
    && SHA256_DIGEST.test(operation.receiptDigest ?? '')
    && operation.outcome === 'committed'
    && operation.externalRuntimeAction === externalRuntimeAction
    && SHA256_DIGEST.test(operation.inventoryRevision ?? '')
    && operation.inventoryRowPresent === true
    && operation.desired === desired
    && operation.materialized === materialized
    && operation.effective === effective
    && operation.agentVisibility === agentVisibility
    && operation.verification === verification
    && operation.userInvocable === userInvocable
    && operation.observedCandidateRef === observedCandidateRef
    && ['available', 'running', 'used', 'unavailable', 'failed'].includes(operation.rollback)
    && operation.ownerStateVerified === true
}

function finalCleanupMatches(cleanup, purge) {
  return cleanup?.inventoryRevision === purge?.inventoryRevision
    && cleanup?.targetRowCount === 1
    && cleanup?.tombstoneRetained === true
    && cleanup?.candidateRef === null
    && cleanup?.desired === 'removed'
    && cleanup?.materialized === 'absent'
    && cleanup?.effective === 'inactive'
    && cleanup?.agentVisibility === 'not-visible'
    && cleanup?.rollback === 'unavailable'
    && cleanup?.managedBytesAbsent === true
    && cleanup?.installActionAvailable === true
}

function boundedReceiptText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value
}

function sameTextList(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
}

/** Require a mutable registry selector to retain the publication workflow's exact target binding. */
export function assertExpectedCenterTarget(config, observation) {
  const expected = config.expectedCenterTarget
  if (expected === null) return
  if (observation?.status !== 'published' || observation.version !== expected.version
    || observation.integrity !== expected.integrity) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-TARGET-BINDING',
      'registry-preflight',
      'resolved Center target does not match the publication workflow binding',
    )
  }
}

/**
 * Reject accidental receipt fields that could carry credentials, process output, or local paths.
 * @param {unknown} value Receipt candidate.
 */
export function assertSecretFreeReceipt(value) {
  visitReceipt(value, '$')
}

/** Parse the protected GitHub Actions invocation identity, or null outside Actions. */
export function actionsProvenanceFromEnvironment(environment) {
  const present = ACTIONS_ENVIRONMENT_KEYS.filter(key => environment[key] !== undefined)
  if (present.length === 0) return null
  if (present.length !== ACTIONS_ENVIRONMENT_KEYS.length) {
    throw new OrdinaryUserInputError(
      'ORDINARY-USER-ACTIONS-PROVENANCE',
      'GitHub Actions provenance environment is incomplete',
    )
  }
  const workflowPrefix = `${ACTIONS_REPOSITORY}/`
  const workflowRef = environment.GITHUB_WORKFLOW_REF
  const workflowSuffix = '@refs/heads/main'
  const workflowFile = workflowRef?.startsWith(workflowPrefix) === true
    && workflowRef.endsWith(workflowSuffix)
    ? workflowRef.slice(workflowPrefix.length, -workflowSuffix.length)
    : null
  if (environment.GITHUB_ACTIONS !== 'true'
    || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_REF_PROTECTED !== 'true'
    || environment.GITHUB_REPOSITORY !== ACTIONS_REPOSITORY
    || environment.GITHUB_SERVER_URL !== 'https://github.com'
    || workflowFile === null
    || !ACTIONS_WORKFLOWS.includes(workflowFile)
    || !COMMIT.test(environment.GITHUB_SHA ?? '')
    || environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA
    || !GITHUB_NUMBER.test(environment.GITHUB_REPOSITORY_ID ?? '')
    || !GITHUB_NUMBER.test(environment.GITHUB_RUN_ID ?? '')
    || !GITHUB_NUMBER.test(environment.GITHUB_RUN_ATTEMPT ?? '')) {
    throw new OrdinaryUserInputError(
      'ORDINARY-USER-ACTIONS-PROVENANCE',
      'GitHub Actions provenance does not name one protected main workflow dispatch',
    )
  }
  return Object.freeze({
    repository: ACTIONS_REPOSITORY,
    repositoryId: environment.GITHUB_REPOSITORY_ID,
    workflowFile,
    workflowRef,
    ref: 'refs/heads/main',
    commit: environment.GITHUB_SHA,
    eventName: 'workflow_dispatch',
    refProtected: true,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
  })
}

/** Verify the canonical self-digest of one ordinary-user receipt. */
export function verifyOrdinaryUserReceiptDigest(receipt) {
  if (!isPlainObject(receipt) || !SHA256_DIGEST.test(receipt.receiptDigest ?? '')) return false
  const { receiptDigest: _receiptDigest, ...body } = receipt
  return receipt.receiptDigest === canonicalReceiptDigest(body)
}

/**
 * Compare two validated exact semantic versions, ignoring build metadata.
 * @param {string} left First version.
 * @param {string} right Second version.
 * @returns {-1 | 0 | 1} Semantic precedence comparison.
 */
export function compareExactVersions(left, right) {
  if (!VERSION.test(left) || !VERSION.test(right)) {
    throw new OrdinaryUserInputError('ORDINARY-USER-CENTER-VERSION', 'registry returned a non-canonical exact version')
  }
  const parsedLeft = parseExactVersion(left)
  const parsedRight = parseExactVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft.core[index] > parsedRight.core[index]) return 1
    if (parsedLeft.core[index] < parsedRight.core[index]) return -1
  }
  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length > 0) return 1
  if (parsedLeft.prerelease.length > 0 && parsedRight.prerelease.length === 0) return -1
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index]
    const rightIdentifier = parsedRight.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumber = /^\d+$/u.test(leftIdentifier) ? Number(leftIdentifier) : null
    const rightNumber = /^\d+$/u.test(rightIdentifier) ? Number(rightIdentifier) : null
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1
    if (leftNumber !== null) return -1
    if (rightNumber !== null) return 1
    return leftIdentifier > rightIdentifier ? 1 : -1
  }
  return 0
}

/** Atomically write one validated JSON receipt with owner-only permissions. */
export async function writeOrdinaryUserReceipt(path, receipt) {
  if (!isPlainObject(receipt)) throw new TypeError('ordinary-user receipt must be an object')
  const { receiptDigest, ...body } = receipt
  const expectedDigest = canonicalReceiptDigest(body)
  if (receiptDigest !== null && receiptDigest !== expectedDigest) {
    throw new TypeError('ordinary-user receipt digest does not match its canonical body')
  }
  receipt.receiptDigest = expectedDigest
  assertSecretFreeReceipt(receipt)
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = resolve(directory, `.ordinary-user-${randomUUID()}.json`)
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

function canonicalReceiptDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new TypeError('ordinary-user receipt contains a non-canonical value')
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function splitRegistrySpec(value) {
  let packageName
  let selector
  if (value.startsWith('@')) {
    const slash = value.indexOf('/')
    if (slash < 2) return null
    const separator = value.indexOf('@', slash + 1)
    packageName = separator < 0 ? value : value.slice(0, separator)
    selector = separator < 0 ? undefined : value.slice(separator + 1)
  } else {
    const separator = value.indexOf('@')
    packageName = separator < 0 ? value : value.slice(0, separator)
    selector = separator < 0 ? undefined : value.slice(separator + 1)
  }
  if (!PACKAGE_NAME.test(packageName) || selector !== undefined && (selector.length === 0 || !SELECTOR.test(selector))) {
    return null
  }
  return { packageName, selector }
}

function parseExactVersion(value) {
  const withoutBuild = value.split('+', 1)[0]
  const [core, ...prereleaseParts] = withoutBuild.split('-')
  return {
    core: core.split('.').map(Number),
    prerelease: prereleaseParts.length === 0 ? [] : prereleaseParts.join('-').split('.'),
  }
}

function assertPackageName(value, label) {
  if (!PACKAGE_NAME.test(value)) {
    throw new OrdinaryUserInputError('ORDINARY-USER-CENTER-NAME', `${label} is not a canonical npm package name`)
  }
}

function isCanonicalSha512Integrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false
  const encoded = value.slice('sha512-'.length)
  const decoded = Buffer.from(encoded, 'base64')
  return decoded.byteLength === 64 && decoded.toString('base64') === encoded
}

function visitReceipt(value, location) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitReceipt(item, `${location}[${String(index)}]`))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RECEIPT_KEY.test(key)) {
      throw new TypeError(`ordinary-user receipt contains forbidden field ${location}.${key}`)
    }
    visitReceipt(child, `${location}.${key}`)
  }
}
