import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DOCUMENTATION_SKILL_CANDIDATE,
  installKeylessAgentReplayBundle,
  runKeylessAgentAcquisition,
} from './agent-acquisition.mjs'
import { runPackedBreakGlassE2e } from './break-glass-e2e.mjs'
import { approveTaskPlanThroughBrowser, installSkillThroughBrowser } from './browser-lifecycle.mjs'
import { induceControlledPluginInstallAba } from './controlled-aba.mjs'
import { assertExactFaultMatrix, runCenterOwnedFaultMatrix } from './fault-matrix.mjs'
import {
  verifyImmutablePlanDigest,
  verifyOperationReceiptJournal,
  verifyReceiptInventory,
  verifyTerminalReceiptPlanBinding,
} from './receipt-binding.mjs'
import {
  AcceptanceFailure,
  OWNER_MISSING_FAILURE_CODES,
  PROFILE_REMOVAL_MUTATION_WHITELIST,
  REQUIRED_HOST_OWNERS,
  TARGET_DSH_COMMIT,
  TARGET_DSH_VERSION,
  assertNoPackageLifecycleScripts,
  assertNoManagedResolutionLinks,
  assertRequiredHostOwners,
  delay,
  hasBlockedCredentialEnvironment,
  hasProviderEndpointOverride,
  keylessEnvironment,
  immutablePackageTreeDigest,
  installOfficialDshHost,
  parseCatalogListEnvelope,
  profileRemovalSurfaceDigest,
  requestLiveChildTeardown,
  sanitizeDiagnostic,
  sha256,
  stopChild,
  waitForAcquisitionAdmission,
  waitForReadyUrl,
} from './support.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = join(projectRoot, '.artifacts', 'acceptance', 'full-p0-official-rc2')
const skillConfiguration = Object.freeze({
  modelInvocable: true,
  userInvocable: true,
  projectRoot: null,
})
let stableGateAssertionsPassed = 0
let requiredOwnerAssertionsPassed = 0

const receipt = {
  schemaVersion: 1,
  acceptanceId: 'P0-RC2-001-OFFICIAL-HOST-EXTENSION-LIFECYCLES',
  proofScope: 'packed-extension-unmodified-official-rc2-host-rpc-plugin-mcp-skill-lifecycles',
  status: 'running',
  p0Status: 'not-proven',
  releaseClaim: 'official-dsh-rc2-compatible',
  target: {
    dshPackage: `@deepseek-ai/dsh@${TARGET_DSH_VERSION}`,
    auditedSourceCommit: TARGET_DSH_COMMIT,
    version: null,
    registry: null,
    registryIntegrity: null,
    packageTreeDigest: null,
    os: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  },
  inputs: {
    isolatedHomesCreatedEmpty: false,
    credentialVariablesPassed: null,
    providerEndpointOverridePassed: null,
    telemetryModeRequested: null,
    packedArtifactInstalledByOfficialPluginCli: false,
    exactMcpRuntimePreprovisioned: false,
    keylessOfficialReplayBundleInstalled: false,
    keylessOfficialReplayBundleRemoved: false,
    officialCliRemovalProven: false,
    distinctCenterArtifactUpdateProven: false,
    breakGlassRecoveryProven: false,
  },
  artifact: null,
  observations: {
    bundleLayerObserved: false,
    catalogRevision: null,
    catalogEntriesDigest: null,
    requiredOwners: REQUIRED_HOST_OWNERS.map(requirement => requirement.key),
    hostCapabilities: null,
    mcpRuntime: null,
    mergedSkillWinner: null,
    assertionAccounting: {
      definition: 'successful requireCondition gates plus successful required-owner availability predicates',
      stableGatesPassed: 0,
      requiredOwnerPredicatesPassed: 0,
      totalPassed: 0,
    },
    rpcMethods: [],
    browserLifecycleRpcMethods: [],
    browserStoreLifecycleRpcMethods: [],
    agentAcquisition: null,
    keylessReplayBundle: null,
    controlledAba: null,
    breakGlassRecovery: null,
    faultMatrix: null,
    materialUnchangedBeforeApproval: false,
    storeMaterialUnchangedBeforeApproval: false,
    officialDshPackageTreeUnchanged: false,
    profileRemovalMutationWhitelist: PROFILE_REMOVAL_MUTATION_WHITELIST,
    profileRemovalBaselineDigest: null,
    profileRemovalFinalDigest: null,
    centerAndChildResolutionLinksAbsent: false,
    lifecycle: [],
    terminalReceiptDigests: [],
    terminalJournalHeadDigests: [],
  },
  notProven: [
    'published-extension-center-release-installation',
    'center-update-with-distinct-artifact-version-and-digest',
    'update-with-distinct-signed-catalog-revision',
    'cross-platform-matrix',
    'break-glass-managed-plugin-restore-receipt',
  ],
  compatibilitySmokes: {
    liveProvider: {
      status: 'not-run',
      blocking: false,
      reason: 'P0 deterministically replays only the model edge through the official Agent; live provider behavior is advisory.',
    },
  },
}

let tempRoot
let webChild
const webOutput = { value: '' }

try {
  await rm(evidenceRoot, { recursive: true, force: true })
  await mkdir(evidenceRoot, { recursive: true })
  tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-extension-center-official-rc2-')))
  const packRoot = join(evidenceRoot, 'packed')
  const workspace = join(tempRoot, 'workspace')
  const hostRoot = join(tempRoot, 'official-host')
  const dshHome = join(tempRoot, 'dsh-home')
  const agentsHome = join(tempRoot, 'agents-home')
  const attackerHome = join(tempRoot, 'attacker-home')
  const runtimeRoot = join(tempRoot, 'mcp-runtimes')
  await Promise.all([
    mkdir(packRoot, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(dshHome, { recursive: true }),
    mkdir(agentsHome, { recursive: true }),
    mkdir(attackerHome, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
  ])
  receipt.inputs.isolatedHomesCreatedEmpty = (await readdir(dshHome)).length === 0
    && (await readdir(agentsHome)).length === 0

  const runtimeEnv = keylessEnvironment({
    ...process.env,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
    DSH_TELEMETRY_MODE: 'DISABLED',
    NO_COLOR: '1',
  })
  receipt.inputs.credentialVariablesPassed = hasBlockedCredentialEnvironment(runtimeEnv)
  receipt.inputs.providerEndpointOverridePassed = hasProviderEndpointOverride(runtimeEnv)
  receipt.inputs.telemetryModeRequested = runtimeEnv.DSH_TELEMETRY_MODE ?? null
  requireCondition(
    receipt.inputs.isolatedHomesCreatedEmpty
      && !receipt.inputs.credentialVariablesPassed
      && !receipt.inputs.providerEndpointOverridePassed
      && receipt.inputs.telemetryModeRequested === 'DISABLED',
    'P0-RC2-ISOLATION',
    'isolated keyless official rc.2 preconditions were not enforced',
  )

  const officialHost = await installOfficialDshHost({
    hostRoot,
    projectRoot,
    cwd: workspace,
    env: runtimeEnv,
  })
  const dshBin = officialHost.dshBin
  receipt.target.version = officialHost.version
  receipt.target.registry = officialHost.registry
  receipt.target.registryIntegrity = officialHost.registryIntegrity
  receipt.target.packageTreeDigest = officialHost.packageTreeDigest

  const provisionMcpRuntime = async (version) => {
    const root = join(runtimeRoot, version)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'package.json'), `${JSON.stringify({ private: true }, null, 2)}\n`)
    await checkedStep(
      'P0-RC2-MCP-RUNTIME-PROVISION',
      'pnpm',
      ['--dir', root, 'add', `filesystem-mcp@${version}`, '--ignore-scripts', '--save-exact'],
      { cwd: workspace, env: runtimeEnv, timeoutMs: 120_000 },
    )
    const packageRoot = join(root, 'node_modules', 'filesystem-mcp')
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    requireCondition(
      manifest.name === 'filesystem-mcp' && manifest.version === version && manifest.bin === 'dist/main.js',
      'P0-RC2-MCP-RUNTIME-PROVISION',
      `preprovisioned MCP package did not expose the admitted ${version} executable`,
    )
    const executablePath = await realpath(join(packageRoot, manifest.bin))
    const executableInfo = await lstat(executablePath)
    requireCondition(
      executableInfo.isFile() && !executableInfo.isSymbolicLink()
        && (process.platform === 'win32' || (executableInfo.mode & 0o111) !== 0),
      'P0-RC2-MCP-RUNTIME-PROVISION',
      `preprovisioned MCP ${version} executable is not a real executable file`,
    )
    return Object.freeze({
      version,
      runtimeRef: `runtime:filesystem-mcp-${version}`,
      executablePath,
      executableSha256: `sha256:${sha256(await readFile(executablePath))}`,
    })
  }
  const [mcpRuntimeV122, mcpRuntimeV130] = await Promise.all([
    provisionMcpRuntime('1.2.2'),
    provisionMcpRuntime('1.3.0'),
  ])
  const mcpWorkingDirectory = await realpath(workspace)
  receipt.inputs.exactMcpRuntimePreprovisioned = true
  receipt.observations.mcpRuntime = [mcpRuntimeV122, mcpRuntimeV130].map(runtime => ({
    package: `filesystem-mcp@${runtime.version}`,
    runtimeRef: runtime.runtimeRef,
    executableSha256: runtime.executableSha256,
  }))

  const sourceManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  assertNoPackageLifecycleScripts(sourceManifest, 'source')
  const version = await checkedStep(
    'P0-RC2-HOST-BUILD',
    dshBin,
    ['--version'],
    { cwd: workspace, env: runtimeEnv, timeoutMs: 30_000 },
  )
  receipt.target.version = version.stdout.trim()
  requireCondition(
    receipt.target.version === TARGET_DSH_VERSION,
    'P0-RC2-HOST-BUILD',
    `official CLI version ${JSON.stringify(receipt.target.version)} does not match ${JSON.stringify(TARGET_DSH_VERSION)}`,
  )

  await checkedStep(
    'P0-RC2-PROFILE-BASELINE',
    dshBin,
    ['plugin', '--profile', 'web', 'install', '--offline', '--ignore-scripts'],
    { cwd: workspace, env: runtimeEnv, timeoutMs: 120_000 },
  )
  const profileRoot = join(dshHome, 'profiles', 'web')
  receipt.observations.profileRemovalBaselineDigest = await profileRemovalSurfaceDigest(profileRoot)

  await checkedStep(
    'P0-RC2-PACK',
    'pnpm',
    ['pack', '--pack-destination', packRoot],
    { cwd: projectRoot, env: runtimeEnv, timeoutMs: 60_000 },
  )
  const archives = (await readdir(packRoot)).filter(file => file.endsWith('.tgz'))
  requireCondition(archives.length === 1, 'P0-RC2-ARTIFACT', `expected one packed artifact, observed ${String(archives.length)}`)
  const artifact = join(packRoot, archives[0])
  const artifactBytes = await readFile(artifact)
  const artifactDigest = `sha256:${sha256(artifactBytes)}`
  const packedManifestOutput = await checkedStep(
    'P0-RC2-ARTIFACT',
    'tar',
    ['-xOf', artifact, 'package/package.json'],
    { cwd: projectRoot, env: runtimeEnv, timeoutMs: 30_000 },
  )
  const packedManifest = JSON.parse(packedManifestOutput.stdout)
  assertNoPackageLifecycleScripts(packedManifest, 'packed')
  requireCondition(
    packedManifest.name === 'dsh-plugin-extension-center'
      && packedManifest.version === sourceManifest.version
      && packedManifest.bin === undefined
      && packedManifest.exports?.['.'] !== undefined
      && packedManifest.exports?.['./client'] !== undefined
      && packedManifest.dsh?.bundle?.patch === './cordis.patch.yml'
      && packedManifest.dsh?.client?.platform === 'web',
    'P0-RC2-ARTIFACT-ROLES',
    'packed artifact omitted its exact package identity, declared a forbidden package bin, or omitted its Host role, Web Client role, or Bundle patch',
  )
  receipt.artifact = {
    filename: basename(artifact),
    evidencePath: `packed/${basename(artifact)}`,
    bytes: (await stat(artifact)).size,
    digest: artifactDigest,
    version: packedManifest.version,
  }
  await writeFile(join(evidenceRoot, 'artifact-manifest.json'), `${JSON.stringify(packedManifest, null, 2)}\n`)

  const faultPackageRoot = join(tempRoot, 'fault-package')
  await mkdir(faultPackageRoot, { recursive: true, mode: 0o700 })
  await checkedStep(
    'P0-RC2-FAULT-MATRIX-ARTIFACT',
    'tar',
    ['-xzf', artifact, '-C', faultPackageRoot],
    { cwd: workspace, env: runtimeEnv, timeoutMs: 30_000 },
  )
  receipt.observations.faultMatrix = await runCenterOwnedFaultMatrix({
    moduleRoot: join(faultPackageRoot, 'package', 'lib'),
    root: join(tempRoot, 'fault-matrix'),
    artifactDigest,
  })
  requireCondition(
    assertExactFaultMatrix(receipt.observations.faultMatrix, artifactDigest) === receipt.observations.faultMatrix,
    'P0-RC2-FAULT-MATRIX',
    'packed Extension Center did not pass the exact fixed Center-owned journal fault matrix',
  )

  const installed = await checkedStep(
    'P0-RC2-PROFILE-INSTALL',
    dshBin,
    [
      'plugin', '--profile', 'web', 'add', artifact,
      '--offline', '--ignore-scripts', '--save-exact',
    ],
    { cwd: workspace, env: runtimeEnv, timeoutMs: 120_000 },
  )
  await writeFile(
    join(evidenceRoot, 'profile-install.log'),
    sanitizeDiagnostic(`${installed.stdout}${installed.stderr}`),
  )
  receipt.inputs.packedArtifactInstalledByOfficialPluginCli = true
  await writeFile(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: dsh-plugin-extension-center',
    '  config:',
    '    maximumArtifactRedirects: 1',
    '    allowedArtifactRedirectHosts:',
    '      - objects.githubusercontent.com',
    '      - release-assets.githubusercontent.com',
    '    mcpRuntimes:',
    ...[mcpRuntimeV122, mcpRuntimeV130].flatMap(runtime => [
      '      - transport: stdio',
      `        runtimeRef: ${runtime.runtimeRef}`,
      `        candidateRef: mcp:io.github.domdomegg/filesystem-mcp@${runtime.version}`,
      `        executablePath: ${JSON.stringify(runtime.executablePath)}`,
      `        version: ${runtime.version}`,
      `        executableSha256: ${runtime.executableSha256}`,
      '        fixedArgs: []',
      `        workingDirectory: ${JSON.stringify(mcpWorkingDirectory)}`,
    ]),
    '',
  ].join('\n'))
  const replayInstallation = await installKeylessAgentReplayBundle({
    root: join(tempRoot, 'keyless-agent-replay'),
    dshBin,
    cwd: workspace,
    dshHome,
    env: runtimeEnv,
    profileId: 'web',
  })
  receipt.inputs.keylessOfficialReplayBundleInstalled = true
  receipt.observations.keylessReplayBundle = {
    packageName: replayInstallation.packageName,
    artifactDigest: replayInstallation.archiveDigest,
    profileDependencySpec: replayInstallation.profileDependencySpec,
    replayPackage: replayInstallation.replayPackage,
    replayVersion: replayInstallation.replayVersion,
  }
  const dump = await checkedStep(
    'P0-RC2-PROFILE-DUMP',
    dshBin,
    ['--profile', 'web', '--dump-config'],
    { cwd: workspace, env: runtimeEnv, timeoutMs: 60_000 },
  )
  await writeFile(join(evidenceRoot, 'dump-config.txt'), sanitizeDiagnostic(dump.stdout))
  receipt.observations.bundleLayerObserved = dump.stdout.includes('# == dsh-plugin-extension-center')
    && dump.stdout.includes('name: dsh-plugin-extension-center')
  requireCondition(
    receipt.observations.bundleLayerObserved,
    'P0-RC2-BUNDLE-LAYER',
    'packed Extension Center was absent from the composed official Web Profile',
  )

  let startedWeb = await startOfficialWeb(dshBin, workspace, runtimeEnv, webOutput)
  webChild = startedWeb.child
  let rpc = createRpcClient(startedWeb.origin, receipt.observations.rpcMethods)
  let catalogAttempt = 0
  const parsedCatalog = await waitForAcquisitionAdmission(async () => {
    catalogAttempt += 1
    const catalogRpcId = `official-rc2-catalog-list-${String(catalogAttempt)}`
    const catalogBody = await rpc.raw('catalog/list', { protocolVersion: 1 }, catalogRpcId)
    return parseCatalogListEnvelope(catalogBody, catalogRpcId)
  })
  receipt.observations.catalogRevision = parsedCatalog.catalog.revision
  receipt.observations.catalogEntriesDigest = parsedCatalog.catalog.entriesDigest
  receipt.observations.hostCapabilities = assertRequiredHostOwners(parsedCatalog.capabilities)
  requiredOwnerAssertionsPassed = REQUIRED_HOST_OWNERS.length
  requireCondition(
    parsedCatalog.value.hostCapabilities.acquisition === true
      && parsedCatalog.value.hostCapabilities.reason === null,
    'P0-RC2-HOST-ACQUISITION',
    'all Center-owned lifecycle services were present but acquisition was not admitted',
  )
  const skill = parsedCatalog.value.entries.find(entry => entry?.candidateRef === DOCUMENTATION_SKILL_CANDIDATE)
  requireCondition(
    isRecord(skill)
      && typeof skill.candidateRef === 'string'
      && typeof skill.name === 'string'
      && isRecord(skill.artifact)
      && typeof skill.artifact.integrity === 'string'
      && typeof skill.artifact.sizeBytes === 'number',
    'P0-RC2-SKILL-CANDIDATE',
    'verified catalog omitted the exact Skill artifact coordinates',
  )
  const candidateRef = skill.candidateRef
  const targetKey = `skill:web:user:${skill.name}`

  const initialInventory = await rpc.call('inventory/list', {
    protocolVersion: 1,
    scopeKey: 'user',
    profileId: 'web',
  })
  assertInventoryEnvelope(initialInventory, 'initial')
  requireCondition(
    initialInventory.inventory.complete === true
      && !initialInventory.inventory.rows.some(row => row?.targetKey === targetKey),
    'P0-RC2-SKILL-TARGET-NOT-EMPTY',
    'isolated user scope already contains the catalog Skill target',
  )

  const materialRoot = join(dshHome, 'extension-center', 'material')
  const materialBeforePlan = await optionalTreeDigest(materialRoot)
  let materialAfterPlan = null
  let materialAfterApproval = null
  let browserApproval
  const agentAcquisition = await runKeylessAgentAcquisition({
    origin: startedWeb.origin,
    cwd: workspace,
    agentPreset: 'standard',
    authorize: async authorization => {
      requireCondition(
        authorization.acquisition.candidateRef === candidateRef
          && authorization.approval.state?.plan?.hash === authorization.acquisition.planHash,
        'P0-RC2-AGENT-AUTHORIZATION-BINDING',
        'Agent acquisition callback did not bind the exact pending catalog candidate and immutable plan',
      )
      browserApproval = await approveTaskPlanThroughBrowser({
        origin: startedWeb.origin,
        candidateRef,
        taskAttemptId: authorization.taskAttempt.taskAttemptId,
        planHash: authorization.acquisition.planHash,
        reviewScreenshotPath: join(evidenceRoot, 'browser-agent-skill-plan.png'),
        committedScreenshotPath: join(evidenceRoot, 'browser-agent-skill-committed.png'),
        ariaPath: join(evidenceRoot, 'browser-agent-skill-committed.aria.txt'),
        afterPlan: async () => { materialAfterPlan = await optionalTreeDigest(materialRoot) },
        beforeLifecycle: async () => { materialAfterApproval = await optionalTreeDigest(materialRoot) },
      })
    },
  })
  requireCondition(
    isRecord(browserApproval)
      && browserApproval.lifecycle?.operationId === agentAcquisition.operationId,
    'P0-RC2-AGENT-BROWSER-LIFECYCLE',
    'Activity approval did not execute the Agent-created acquisition operation',
  )
  receipt.observations.browserLifecycleRpcMethods = browserApproval.methods
  receipt.observations.agentAcquisition = agentAcquisition
  receipt.observations.materialUnchangedBeforeApproval = materialBeforePlan === materialAfterPlan
    && materialAfterPlan === materialAfterApproval
  requireCondition(
    receipt.observations.materialUnchangedBeforeApproval,
    'P0-RC2-PREAPPROVAL-MUTATION',
    'plan creation or approval materialized Skill bytes before lifecycle execution',
  )
  const installedInventory = await rpc.call('inventory/list', {
    protocolVersion: 1,
    scopeKey: 'user',
    profileId: 'web',
  })
  const installedRow = assertInventoryRow(installedInventory, targetKey, {
    desired: 'enabled',
    materialized: 'configured',
    effective: 'active',
    visibility: 'visible',
    verification: 'runtime',
  })
  const winningPath = installedRow.evidence?.winningPath
  requireCondition(
    installedRow.evidence?.kind === 'skill'
      && installedRow.evidence.winningProvider === 'extension-center'
      && installedRow.evidence.definitionLoaded === true
      && typeof winningPath === 'string',
    'P0-RC2-SKILL-WINNER',
    'installed Skill was not the exact merged-registry winner',
  )
  await assertManagedArtifact(winningPath, materialRoot, skill.artifact.integrity, skill.artifact.sizeBytes)
  receipt.observations.mergedSkillWinner = skillInventoryEvidence(installedRow)
  const [agentPlanValue, agentOperationValue] = await Promise.all([
    rpc.call('plan/get', { protocolVersion: 1, planHash: agentAcquisition.planHash }),
    rpc.call('operation/get', { protocolVersion: 1, operationId: agentAcquisition.operationId }),
  ])
  const agentPlanState = expectRecord(agentPlanValue.state, 'consumed Agent acquisition plan state')
  const agentPlan = expectRecord(agentPlanState.plan, 'consumed Agent acquisition plan')
  const agentOperation = expectRecord(agentOperationValue.operation, 'committed Agent acquisition operation')
  const agentOperationProjection = expectRecord(agentOperation.projection, 'committed Agent acquisition projection')
  const agentReceipt = expectRecord(agentOperationProjection.receipt, 'committed Agent acquisition receipt')
  requireCondition(
    agentPlanState.status === 'consumed'
      && agentPlan.hash === agentAcquisition.planHash
      && agentOperationProjection.phase === 'committed'
      && agentReceipt.digest === agentAcquisition.receiptDigest,
    'P0-RC2-AGENT-COMMITTED-BINDING',
    'Agent acquisition proof did not bind the consumed task plan to its committed receipt',
  )
  const terminalReceipts = [agentReceipt]
  receipt.observations.lifecycle.push({
    ...lifecycleEvidence(agentPlan, browserApproval.lifecycle, agentReceipt, installedRow),
    origin: 'task',
    agentProofKind: agentAcquisition.proofKind,
    modelEvidence: agentAcquisition.modelEvidence,
    taskAttemptId: agentAcquisition.taskAttemptId,
    taskAttemptOutcome: agentAcquisition.taskAttemptOutcome,
  })

  const configuredSkill = Object.freeze({ ...skillConfiguration, userInvocable: false })
  const configured = await runStoreLifecycle(rpc, {
    candidateRef, targetKey, operationKind: 'configure', configuration: configuredSkill,
    expected: activeSkillState(),
  })
  terminalReceipts.push(configured.receipt)
  requireCondition(
    configured.row.configurationRevision !== installedRow.configurationRevision
      && configured.row.evidence?.kind === 'skill'
      && configured.row.evidence.invocation?.modelInvocable === true
      && configured.row.evidence.invocation?.userInvocable === false,
    'P0-RC2-SKILL-CONFIGURE',
    'configured Skill did not publish the exact changed invocation flags',
  )
  receipt.observations.lifecycle.push(configured.evidence)

  const disabled = await runStoreLifecycle(rpc, {
    candidateRef, targetKey, operationKind: 'disable', configuration: configuredSkill,
    expected: {
      desired: 'disabled', materialized: 'configured', effective: 'inactive',
      visibility: 'not-visible', verification: 'structural',
    },
  })
  terminalReceipts.push(disabled.receipt)
  requireCondition(
    disabled.row.evidence?.kind === 'skill'
      && disabled.row.evidence.winningProvider !== 'extension-center'
      && disabled.row.evidence.definitionLoaded === false
      && disabled.row.actions?.enable?.status === 'available',
    'P0-RC2-SKILL-DISABLE',
    'disabled Skill still contributes or cannot be enabled',
  )
  receipt.observations.lifecycle.push(disabled.evidence)

  const enabled = await runStoreLifecycle(rpc, {
    candidateRef, targetKey, operationKind: 'enable', configuration: configuredSkill,
    expected: activeSkillState(),
  })
  terminalReceipts.push(enabled.receipt)
  requireCondition(
    enabled.row.evidence?.kind === 'skill'
      && enabled.row.evidence.winningProvider === 'extension-center'
      && enabled.row.evidence.definitionLoaded === true
      && enabled.row.evidence.invocation?.userInvocable === false,
    'P0-RC2-SKILL-ENABLE',
    'enabled Skill did not restore the configured merged-registry contribution',
  )
  receipt.observations.lifecycle.push(enabled.evidence)

  const uninstalled = await runStoreLifecycle(rpc, {
    candidateRef, targetKey, operationKind: 'uninstall', configuration: configuredSkill,
    expected: removedSkillState(),
  })
  terminalReceipts.push(uninstalled.receipt)
  requireCondition(
    uninstalled.row.evidence?.kind === 'skill'
      && uninstalled.row.evidence.winningProvider !== 'extension-center'
      && uninstalled.row.evidence.definitionLoaded === false
      && uninstalled.row.actions?.restore?.status === 'available',
    'P0-RC2-SKILL-UNINSTALL',
    'uninstalled Skill still contributes or has no exact restore path',
  )
  receipt.observations.lifecycle.push(uninstalled.evidence)

  const restored = await runStoreLifecycle(rpc, {
    candidateRef, targetKey, operationKind: 'restore', configuration: configuredSkill,
    expected: activeSkillState(),
  })
  terminalReceipts.push(restored.receipt)
  requireCondition(
    restored.row.evidence?.kind === 'skill'
      && restored.row.evidence.winningProvider === 'extension-center'
      && restored.row.evidence.definitionLoaded === true
      && restored.row.evidence.invocation?.userInvocable === false,
    'P0-RC2-SKILL-RESTORE',
    'restored Skill did not recover the exact configured merged-registry winner',
  )
  receipt.observations.lifecycle.push(restored.evidence)

  const removedAgain = await runStoreLifecycle(rpc, {
    candidateRef, targetKey, operationKind: 'uninstall', configuration: configuredSkill,
    expected: removedSkillState(),
  })
  terminalReceipts.push(removedAgain.receipt)
  receipt.observations.lifecycle.push({ ...removedAgain.evidence, stage: 'uninstall-after-restore' })

  const purged = await runStoreLifecycle(rpc, {
    candidateRef, targetKey, operationKind: 'purge', configuration: configuredSkill,
    expected: { ...removedSkillState(), candidateRef: null },
  })
  terminalReceipts.push(purged.receipt)
  requireCondition(
    purged.row.rollback === 'unavailable'
      && purged.row.evidence?.kind === 'skill'
      && purged.row.evidence.contentRevision === null
      && purged.row.actions?.install?.status === 'available'
      && await pathIsAbsent(winningPath),
    'P0-RC2-SKILL-PURGE',
    'purged Skill retained managed material, rollback state, or blocked its future install action',
  )
  receipt.observations.lifecycle.push(purged.evidence)

  const wikiSkillV1 = parsedCatalog.value.entries.find(entry => (
    entry?.kind === 'skill'
      && entry.name === 'wiki-page-writer'
      && entry.artifact?.version === '6142f8e60ac58372845c0fcdd2dbf043cd1bb698'
  ))
  const wikiSkillV2 = parsedCatalog.value.entries.find(entry => (
    entry?.kind === 'skill'
      && entry.name === 'wiki-page-writer'
      && entry.artifact?.version === '67ae723a23ba880e3e5c8a3e5e2320092024476e'
  ))
  requireCondition(
    isRecord(wikiSkillV1) && isRecord(wikiSkillV1.artifact)
      && isRecord(wikiSkillV2) && isRecord(wikiSkillV2.artifact)
      && isRecord(wikiSkillV1.displayName) && typeof wikiSkillV1.displayName.en === 'string'
      && typeof wikiSkillV1.candidateRef === 'string'
      && typeof wikiSkillV2.candidateRef === 'string',
    'P0-RC2-SKILL-UPDATE-CANDIDATES',
    'verified catalog omitted the two exact wiki-page-writer revisions',
  )
  const wikiTargetKey = 'skill:web:user:wiki-page-writer'
  const materialBeforeStorePlan = await optionalTreeDigest(materialRoot)
  let materialAfterStorePlan = null
  let materialAfterStoreApproval = null
  const browserStoreInstall = await installSkillThroughBrowser({
    origin: startedWeb.origin,
    skillName: wikiSkillV1.displayName.en,
    reviewScreenshotPath: join(evidenceRoot, 'browser-store-skill-plan.png'),
    committedScreenshotPath: join(evidenceRoot, 'browser-store-skill-committed.png'),
    ariaPath: join(evidenceRoot, 'browser-store-skill-committed.aria.txt'),
    afterPlan: async () => { materialAfterStorePlan = await optionalTreeDigest(materialRoot) },
    beforeLifecycle: async () => { materialAfterStoreApproval = await optionalTreeDigest(materialRoot) },
  })
  receipt.observations.browserStoreLifecycleRpcMethods = browserStoreInstall.methods
  receipt.observations.storeMaterialUnchangedBeforeApproval = materialBeforeStorePlan === materialAfterStorePlan
    && materialAfterStorePlan === materialAfterStoreApproval
  requireCondition(
    receipt.observations.storeMaterialUnchangedBeforeApproval,
    'P0-RC2-STORE-PREAPPROVAL-MUTATION',
    'Store plan creation or approval materialized Skill bytes before lifecycle execution',
  )
  const wikiInstallPlan = assertPlan(browserStoreInstall.preview, {
    candidateRef: wikiSkillV1.candidateRef,
    targetKey: wikiTargetKey,
    operationKind: 'install',
    desiredState: 'enabled',
    externalRuntimeAction: 'download',
    extensionKind: 'skill',
    managedObject: 'artifact',
    scopeKey: 'user',
  })
  requireCondition(
    browserStoreInstall.decision.state?.status === 'approved'
      && browserStoreInstall.decision.state?.plan?.hash === wikiInstallPlan.hash,
    'P0-RC2-STORE-APPROVAL',
    'Store approval did not bind the exact immutable Skill plan',
  )
  const wikiInstallReceipt = assertCommittedLifecycle(
    browserStoreInstall.lifecycle,
    wikiInstallPlan,
    'download',
  )
  const wikiInstallInventory = await rpc.call('inventory/list', {
    protocolVersion: 1,
    scopeKey: 'user',
    profileId: 'web',
  })
  const wikiInstallRow = assertInventoryRow(wikiInstallInventory, wikiTargetKey, {
    ...activeSkillState(),
    candidateRef: wikiSkillV1.candidateRef,
    extensionKind: 'skill',
    scopeKey: 'user',
  })
  const wikiInstalled = Object.freeze({
    plan: wikiInstallPlan,
    lifecycle: browserStoreInstall.lifecycle,
    receipt: wikiInstallReceipt,
    row: wikiInstallRow,
    evidence: lifecycleEvidence(wikiInstallPlan, browserStoreInstall.lifecycle, wikiInstallReceipt, wikiInstallRow),
  })
  terminalReceipts.push(wikiInstalled.receipt)
  requireCondition(
    wikiInstalled.row.targetKey === wikiTargetKey
      && wikiInstalled.row.updateObservation?.status === 'available'
      && wikiInstalled.row.updateObservation.candidateRef === wikiSkillV2.candidateRef
      && wikiInstalled.row.updateObservation.integrity === wikiSkillV2.artifact.integrity,
    'P0-RC2-SKILL-UPDATE-DISCOVERY',
    'installed Skill did not expose the exact newer signed revision',
  )
  await assertManagedArtifact(
    wikiInstalled.row.evidence?.winningPath,
    materialRoot,
    wikiSkillV1.artifact.integrity,
    wikiSkillV1.artifact.sizeBytes,
  )
  receipt.observations.lifecycle.push(wikiInstalled.evidence)

  const wikiUpdated = await runStoreLifecycle(rpc, {
    candidateRef: wikiSkillV2.candidateRef,
    targetKey: wikiTargetKey,
    operationKind: 'update',
    configuration: skillConfiguration,
    expected: { ...activeSkillState(), candidateRef: wikiSkillV2.candidateRef },
  })
  terminalReceipts.push(wikiUpdated.receipt)
  await assertManagedArtifact(
    wikiUpdated.row.evidence?.winningPath,
    materialRoot,
    wikiSkillV2.artifact.integrity,
    wikiSkillV2.artifact.sizeBytes,
  )
  receipt.observations.lifecycle.push(wikiUpdated.evidence)

  const wikiRolledBack = await runStoreLifecycle(rpc, {
    candidateRef: wikiSkillV1.candidateRef,
    targetKey: wikiTargetKey,
    operationKind: 'restore',
    configuration: skillConfiguration,
    expected: { ...activeSkillState(), candidateRef: wikiSkillV1.candidateRef },
  })
  terminalReceipts.push(wikiRolledBack.receipt)
  await assertManagedArtifact(
    wikiRolledBack.row.evidence?.winningPath,
    materialRoot,
    wikiSkillV1.artifact.integrity,
    wikiSkillV1.artifact.sizeBytes,
  )
  receipt.observations.lifecycle.push({ ...wikiRolledBack.evidence, stage: 'rollback-after-update' })

  const wikiUninstalled = await runStoreLifecycle(rpc, {
    candidateRef: wikiSkillV1.candidateRef,
    targetKey: wikiTargetKey,
    operationKind: 'uninstall',
    configuration: skillConfiguration,
    expected: { ...removedSkillState(), candidateRef: wikiSkillV1.candidateRef },
  })
  terminalReceipts.push(wikiUninstalled.receipt)
  receipt.observations.lifecycle.push(wikiUninstalled.evidence)

  const wikiPurged = await runStoreLifecycle(rpc, {
    candidateRef: wikiSkillV1.candidateRef,
    targetKey: wikiTargetKey,
    operationKind: 'purge',
    configuration: skillConfiguration,
    expected: { ...removedSkillState(), candidateRef: null },
  })
  terminalReceipts.push(wikiPurged.receipt)
  receipt.observations.lifecycle.push(wikiPurged.evidence)

  const mcpV122 = parsedCatalog.value.entries.find(entry => (
    entry?.kind === 'mcp' && entry.artifact?.version === '1.2.2'
  ))
  const mcpV130 = parsedCatalog.value.entries.find(entry => (
    entry?.kind === 'mcp' && entry.artifact?.version === '1.3.0'
  ))
  requireCondition(
    isRecord(mcpV122) && typeof mcpV122.candidateRef === 'string' && typeof mcpV122.name === 'string'
      && isRecord(mcpV130) && typeof mcpV130.candidateRef === 'string' && mcpV130.name === mcpV122.name,
    'P0-RC2-MCP-CANDIDATE',
    'verified catalog omitted the two exact MCP update candidates',
  )
  const mcpScopeKey = 'profile:web'
  const mcpTargetKey = `mcp:web:${mcpScopeKey}:${mcpV122.name}`
  const assertMcpOption = async (candidate, runtime, operationKind, targetKey = null) => {
    const value = await rpc.call('configuration/options', {
      protocolVersion: 1,
      candidateRef: candidate.candidateRef,
      operationKind,
      targetKey,
      scopeKey: mcpScopeKey,
      profileId: 'web',
    })
    requireCondition(
      Array.isArray(value.options) && value.options.length === 1
        && value.options[0]?.candidateRef === candidate.candidateRef
        && value.options[0]?.runtimeRef === runtime.runtimeRef
        && value.options[0]?.version === runtime.version
        && value.options[0]?.transport === 'stdio'
        && value.options[0]?.executablePath === runtime.executablePath,
      'P0-RC2-MCP-RUNTIME-OPTION',
      `typed MCP configuration did not expose the exact ${runtime.version} runtime selector`,
    )
  }
  await Promise.all([
    assertMcpOption(mcpV122, mcpRuntimeV122, 'install'),
    assertMcpOption(mcpV130, mcpRuntimeV130, 'install'),
  ])
  const mcpReconnect = Object.freeze({ enabled: true, initialDelayMs: 250, maxDelayMs: 5_000, maxAttempts: 8 })
  const mcpConfiguration = (runtime, toolCallTimeoutMs) => Object.freeze({
    transport: 'stdio', connectionId: 'filesystem_e2e', runtimeRef: runtime.runtimeRef,
    roots: Object.freeze([mcpWorkingDirectory]), toolCallTimeoutMs, reconnect: mcpReconnect,
  })
  const mcpBase = (candidate, runtime, configuration) => Object.freeze({
    candidateRef: candidate.candidateRef, targetKey: mcpTargetKey, configuration,
    extensionKind: 'mcp', scopeKey: mcpScopeKey, runtimeRef: runtime.runtimeRef,
  })
  const mcpConfigurationV122 = mcpConfiguration(mcpRuntimeV122, 10_000)
  const mcpConfigurationV122Configured = mcpConfiguration(mcpRuntimeV122, 12_000)
  const mcpConfigurationV130 = mcpConfiguration(mcpRuntimeV130, 12_000)
  const mcpBaseV122 = mcpBase(mcpV122, mcpRuntimeV122, mcpConfigurationV122)
  const mcpBaseV130 = mcpBase(mcpV130, mcpRuntimeV130, mcpConfigurationV130)
  const mcpInstalled = await runStoreLifecycle(rpc, {
    ...mcpBaseV122,
    operationKind: 'install',
    expected: { ...disabledMcpState(), candidateRef: mcpV122.candidateRef },
  })
  terminalReceipts.push(mcpInstalled.receipt)
  requireCondition(
    mcpInstalled.row.evidence?.kind === 'mcp'
      && mcpInstalled.row.evidence.descriptorMatches === true
      && mcpInstalled.row.evidence.observedLifecycle === 'disabled'
      && mcpInstalled.row.evidence.qualifiedTools.length === 0,
    'P0-RC2-MCP-INSTALL',
    'installed MCP connection was not durably configured and disabled',
  )
  receipt.observations.lifecycle.push(mcpInstalled.evidence)

  const mcpConfigured = await runStoreLifecycle(rpc, {
    ...mcpBaseV122,
    configuration: mcpConfigurationV122Configured,
    operationKind: 'configure',
    expected: { ...disabledMcpState(), candidateRef: mcpV122.candidateRef },
  })
  terminalReceipts.push(mcpConfigured.receipt)
  receipt.observations.lifecycle.push(mcpConfigured.evidence)

  const mcpEnabled = await runStoreLifecycle(rpc, {
    ...mcpBaseV122,
    configuration: mcpConfigurationV122Configured,
    operationKind: 'enable',
    expected: { ...activeMcpState(), candidateRef: mcpV122.candidateRef },
  })
  terminalReceipts.push(mcpEnabled.receipt)
  requireCondition(
    mcpEnabled.row.evidence?.kind === 'mcp'
      && mcpEnabled.row.evidence.observedLifecycle === 'ready'
      && mcpEnabled.row.evidence.liveDetailAvailable === true
      && mcpEnabled.row.evidence.qualifiedTools.length > 0
      && mcpEnabled.row.evidence.qualifiedTools.every(name => name.startsWith('mcp__filesystem_e2e__')),
    'P0-RC2-MCP-HANDSHAKE',
    'enabled MCP runtime did not complete the official client handshake and publish qualified tools',
  )
  receipt.observations.lifecycle.push(mcpEnabled.evidence)

  requireCondition(
    mcpEnabled.row.updateObservation?.status === 'available'
      && mcpEnabled.row.updateObservation.candidateRef === mcpV130.candidateRef
      && mcpEnabled.row.updateObservation.integrity === mcpV130.artifact.integrity,
    'P0-RC2-MCP-UPDATE-DISCOVERY',
    'active MCP connection did not expose the exact newer signed runtime revision',
  )
  await assertMcpOption(mcpV130, mcpRuntimeV130, 'update', mcpTargetKey)
  const mcpUpdated = await runStoreLifecycle(rpc, {
    ...mcpBaseV130,
    operationKind: 'update',
    expected: { ...activeMcpState(), candidateRef: mcpV130.candidateRef },
  })
  terminalReceipts.push(mcpUpdated.receipt)
  requireCondition(
    mcpUpdated.row.evidence?.kind === 'mcp'
      && mcpUpdated.row.evidence.descriptorMatches === true
      && mcpUpdated.row.evidence.observedLifecycle === 'ready'
      && mcpUpdated.row.evidence.qualifiedTools.every(name => name.startsWith('mcp__filesystem_e2e__')),
    'P0-RC2-MCP-UPDATE',
    'MCP update did not switch to and verify the exact 1.3.0 runtime descriptor',
  )
  receipt.observations.lifecycle.push(mcpUpdated.evidence)

  const mcpRolledBack = await runStoreLifecycle(rpc, {
    ...mcpBaseV122,
    configuration: mcpConfigurationV122Configured,
    operationKind: 'restore',
    expected: { ...activeMcpState(), candidateRef: mcpV122.candidateRef },
  })
  terminalReceipts.push(mcpRolledBack.receipt)
  receipt.observations.lifecycle.push({ ...mcpRolledBack.evidence, stage: 'rollback-after-update' })

  const mcpUpdatedAgain = await runStoreLifecycle(rpc, {
    ...mcpBaseV130,
    operationKind: 'update',
    expected: { ...activeMcpState(), candidateRef: mcpV130.candidateRef },
  })
  terminalReceipts.push(mcpUpdatedAgain.receipt)
  receipt.observations.lifecycle.push({ ...mcpUpdatedAgain.evidence, stage: 'update-after-rollback' })

  const mcpDisabled = await runStoreLifecycle(rpc, {
    ...mcpBaseV130,
    operationKind: 'disable',
    expected: { ...disabledMcpState(), candidateRef: mcpV130.candidateRef },
  })
  terminalReceipts.push(mcpDisabled.receipt)
  receipt.observations.lifecycle.push(mcpDisabled.evidence)

  const mcpReenabled = await runStoreLifecycle(rpc, {
    ...mcpBaseV130,
    operationKind: 'enable',
    expected: { ...activeMcpState(), candidateRef: mcpV130.candidateRef },
  })
  terminalReceipts.push(mcpReenabled.receipt)
  receipt.observations.lifecycle.push(mcpReenabled.evidence)

  const mcpUninstalled = await runStoreLifecycle(rpc, {
    ...mcpBaseV130,
    operationKind: 'uninstall',
    expected: { ...removedMcpState(), candidateRef: mcpV130.candidateRef },
  })
  terminalReceipts.push(mcpUninstalled.receipt)
  receipt.observations.lifecycle.push(mcpUninstalled.evidence)

  const mcpRestored = await runStoreLifecycle(rpc, {
    ...mcpBaseV130,
    operationKind: 'restore',
    expected: { ...activeMcpState(), candidateRef: mcpV130.candidateRef },
  })
  terminalReceipts.push(mcpRestored.receipt)
  receipt.observations.lifecycle.push(mcpRestored.evidence)

  const mcpRemovedAgain = await runStoreLifecycle(rpc, {
    ...mcpBaseV130,
    operationKind: 'uninstall',
    expected: { ...removedMcpState(), candidateRef: mcpV130.candidateRef },
  })
  terminalReceipts.push(mcpRemovedAgain.receipt)
  receipt.observations.lifecycle.push({ ...mcpRemovedAgain.evidence, stage: 'uninstall-after-restore' })

  const mcpPurged = await runStoreLifecycle(rpc, {
    ...mcpBaseV130,
    operationKind: 'purge',
    expected: { ...removedMcpState(), candidateRef: null },
  })
  terminalReceipts.push(mcpPurged.receipt)
  requireCondition(
    mcpPurged.row.rollback === 'unavailable'
      && mcpPurged.row.evidence?.kind === 'mcp'
      && mcpPurged.row.evidence.observedLifecycle === 'absent'
      && mcpPurged.row.actions?.install?.status === 'available',
    'P0-RC2-MCP-PURGE',
    'purged MCP connection retained runtime state, rollback material, or blocked reinstall',
  )
  receipt.observations.lifecycle.push(mcpPurged.evidence)

  const pluginV010 = parsedCatalog.value.entries.find(entry => (
    entry?.kind === 'plugin' && entry.artifact?.version === '0.1.0'
  ))
  const pluginV011 = parsedCatalog.value.entries.find(entry => (
    entry?.kind === 'plugin' && entry.artifact?.version === '0.1.1'
  ))
  requireCondition(
    isRecord(pluginV010) && typeof pluginV010.candidateRef === 'string' && typeof pluginV010.name === 'string'
      && isRecord(pluginV011) && typeof pluginV011.candidateRef === 'string' && pluginV011.name === pluginV010.name,
    'P0-RC2-PLUGIN-CANDIDATE',
    'verified catalog omitted the two exact Plugin update candidates',
  )
  const pluginScopeKey = 'profile:web'
  const pluginTargetKey = `plugin:web:${pluginScopeKey}:${pluginV010.name}`
  const pluginConfiguration = Object.freeze({
    freshCacheMs: 5_000,
    staleCacheMs: 30_000,
    fetchTimeoutMs: 10_000,
    maxCatalogBytes: 1_048_576,
    maxCatalogEntries: 2_000,
    maxTaskChars: 4_000,
    maxResults: 5,
    maxCurrentMatches: 10,
    maxDescriptionChars: 500,
    maxMatchedTerms: 10,
  })
  const runPluginLifecycle = async (candidate, operationKind, expected, configuration) => {
    const restartRequired = operationKind !== 'configure'
    const originalHostPid = webChild.pid
    const preview = await rpc.call('intent/preview', {
      protocolVersion: 1,
      origin: 'store',
      candidateRef: candidate.candidateRef,
      operationKind,
      scopeKey: pluginScopeKey,
      profileId: 'web',
      continuationId: null,
      targetKey: operationKind === 'install' ? null : pluginTargetKey,
      configuration,
    })
    const externalRuntimeAction = operationKind === 'install' || operationKind === 'update' ? 'download' : 'none'
    const plan = assertPlan(preview, {
      candidateRef: candidate.candidateRef,
      targetKey: pluginTargetKey,
      operationKind,
      desiredState: expected.desired,
      externalRuntimeAction,
      extensionKind: 'plugin',
      managedObject: 'artifact',
      scopeKey: pluginScopeKey,
      restartRequired,
    })
    const approval = await approvePlan(rpc, plan)
    requireCondition(
      approval.state.status === 'approved',
      'P0-RC2-PLUGIN-APPROVAL',
      `${operationKind} Plugin plan was not approved exactly once`,
    )
    const lifecycle = await rpc.call('lifecycle/request', {
      protocolVersion: 1,
      planHash: plan.hash,
    }, 120_000)
    if (!restartRequired) {
      const terminalReceipt = assertCommittedLifecycle(lifecycle, plan, externalRuntimeAction)
      requireCondition(
        webChild.pid === originalHostPid && webChild.exitCode === null,
        'P0-RC2-PLUGIN-CONFIGURE-LIVE-HOST',
        'Plugin configuration did not commit on the same official Host process',
      )
      const operation = await rpc.call('operation/get', {
        protocolVersion: 1,
        operationId: lifecycle.operationId,
      })
      try {
        verifyOperationReceiptJournal(operation.operation, terminalReceipt)
      } catch (error) {
        throw new AcceptanceFailure(
          'P0-RC2-PLUGIN-CONFIGURE-JOURNAL',
          error instanceof Error ? error.message : String(error),
        )
      }
      const liveCatalogId = 'official-rc2-plugin-configure-live-catalog'
      const liveCatalog = parseCatalogListEnvelope(
        await rpc.raw('catalog/list', { protocolVersion: 1 }, liveCatalogId),
        liveCatalogId,
      )
      assertRequiredHostOwners(liveCatalog.capabilities)
      const inventory = await rpc.call('inventory/list', {
        protocolVersion: 1,
        scopeKey: pluginScopeKey,
        profileId: 'web',
      })
      const row = assertInventoryRow(inventory, pluginTargetKey, {
        ...expected,
        candidateRef: expected.candidateRef,
        extensionKind: 'plugin',
        scopeKey: pluginScopeKey,
      })
      return Object.freeze({
        plan,
        operationId: lifecycle.operationId,
        receipt: terminalReceipt,
        row,
        evidence: lifecycleEvidence(plan, lifecycle, terminalReceipt, row),
      })
    }
    const operationId = await assertRestartRequiredLifecycle(rpc, lifecycle, plan)

    requestLiveChildTeardown(webChild)
    await stopChild(webChild)
    webOutput.value += `\nExtension Center acceptance restart after ${operationKind}\n`
    startedWeb = await startOfficialWeb(dshBin, workspace, runtimeEnv, webOutput)
    webChild = startedWeb.child
    rpc = createRpcClient(startedWeb.origin, receipt.observations.rpcMethods)
    let restartCatalogAttempt = 0
    const restartedCatalog = await waitForAcquisitionAdmission(async () => {
      restartCatalogAttempt += 1
      const rpcId = `official-rc2-plugin-${operationKind}-catalog-${String(restartCatalogAttempt)}`
      const catalogBody = await rpc.raw('catalog/list', { protocolVersion: 1 }, rpcId)
      return parseCatalogListEnvelope(catalogBody, rpcId)
    })
    assertRequiredHostOwners(restartedCatalog.capabilities)
    const terminal = await waitForCommittedOperation(rpc, operationId, plan, externalRuntimeAction)
    const inventory = await rpc.call('inventory/list', {
      protocolVersion: 1,
      scopeKey: pluginScopeKey,
      profileId: 'web',
    })
    const row = assertInventoryRow(inventory, pluginTargetKey, {
      ...expected,
      candidateRef: expected.candidateRef,
      extensionKind: 'plugin',
      scopeKey: pluginScopeKey,
    })
    return Object.freeze({ plan, operationId, receipt: terminal.receipt, row,
      evidence: lifecycleEvidence(plan, { operationId, status: 'committed' }, terminal.receipt, row) })
  }

  const abaPreview = await rpc.call('intent/preview', {
    protocolVersion: 1,
    origin: 'store',
    candidateRef: pluginV010.candidateRef,
    operationKind: 'install',
    scopeKey: pluginScopeKey,
    profileId: 'web',
    continuationId: null,
    targetKey: null,
    configuration: {},
  })
  const abaPlan = assertPlan(abaPreview, {
    candidateRef: pluginV010.candidateRef,
    targetKey: pluginTargetKey,
    operationKind: 'install',
    desiredState: 'enabled',
    externalRuntimeAction: 'download',
    extensionKind: 'plugin',
    managedObject: 'artifact',
    scopeKey: pluginScopeKey,
    restartRequired: true,
  })
  await approvePlan(rpc, abaPlan)
  const abaLifecycle = await rpc.call('lifecycle/request', {
    protocolVersion: 1,
    planHash: abaPlan.hash,
  }, 120_000)
  await assertRestartRequiredLifecycle(rpc, abaLifecycle, abaPlan)
  const oldAbaHost = webChild
  requestLiveChildTeardown(oldAbaHost)
  await stopChild(oldAbaHost)
  webChild = undefined
  webOutput.value += '\nExtension Center controlled ABA replacement launch\n'
  const controlledAba = await induceControlledPluginInstallAba({
    restartRequiredLifecycle: abaLifecycle,
    stoppedHostProcess: oldAbaHost,
    dshHome,
    dshBin,
    officialDshPackageRoot: officialHost.packageRoot,
    cwd: workspace,
    env: runtimeEnv,
    profileId: 'web',
    packageName: pluginV010.name,
    leaseTimeoutMs: 120_000,
    cliTimeoutMs: 300_000,
    startReplacementHost: () => {
      const launched = launchOfficialWeb(dshBin, workspace, runtimeEnv, webOutput)
      webChild = launched.child
      return Object.freeze({
        hostProcess: launched.child,
        ready: launched.ready.then(next => {
          startedWeb = next
          rpc = createRpcClient(next.origin, receipt.observations.rpcMethods)
          return next
        }),
      })
    },
    observeOperation: async operationId => {
      const [operation, operations] = await Promise.all([
        rpc.call('operation/get', { protocolVersion: 1, operationId }),
        rpc.call('operation/list', { protocolVersion: 1 }),
      ])
      return Object.freeze({
        loadedOperation: operation.operation,
        operationSummary: operations.operations.find(item => item?.operationId === operationId),
      })
    },
  })
  receipt.observations.controlledAba = controlledAba.evidence

  const stoppedForBreakGlass = webChild
  requestLiveChildTeardown(stoppedForBreakGlass)
  await stopChild(stoppedForBreakGlass)
  webChild = undefined
  const breakGlassRecovery = await runPackedBreakGlassE2e({
    packedArtifactPath: artifact,
    centerRoot: await realpath(join(dshHome, 'extension-center')),
    attackerHome: await realpath(attackerHome),
    loadedOperation: controlledAba.loadedOperation,
    operationSummary: controlledAba.operationSummary,
    stoppedHostProcess: Object.freeze({
      exitCode: stoppedForBreakGlass.exitCode,
      signalCode: stoppedForBreakGlass.signalCode,
    }),
    receiptPath: join(evidenceRoot, 'break-glass-receipt.json'),
  })
  receipt.observations.breakGlassRecovery = breakGlassRecovery

  webOutput.value += '\nExtension Center acceptance restart after packed break-glass recovery\n'
  startedWeb = await startOfficialWeb(dshBin, workspace, runtimeEnv, webOutput)
  webChild = startedWeb.child
  rpc = createRpcClient(startedWeb.origin, receipt.observations.rpcMethods)
  let recoveryCatalogAttempt = 0
  const recoveredCatalog = await waitForAcquisitionAdmission(async () => {
    recoveryCatalogAttempt += 1
    const rpcId = `official-rc2-break-glass-catalog-${String(recoveryCatalogAttempt)}`
    const catalogBody = await rpc.raw('catalog/list', { protocolVersion: 1 }, rpcId)
    return parseCatalogListEnvelope(catalogBody, rpcId)
  })
  assertRequiredHostOwners(recoveredCatalog.capabilities)
  const recoveredAba = await waitForRolledBackOperation(rpc, controlledAba.operationId, abaPlan, 'download')
  terminalReceipts.push(recoveredAba.receipt)
  const inventoryAfterBreakGlass = await rpc.call('inventory/list', {
    protocolVersion: 1,
    scopeKey: pluginScopeKey,
    profileId: 'web',
  })
  assertInventoryEnvelope(inventoryAfterBreakGlass, 'break-glass-reconciled', pluginScopeKey)
  requireCondition(
    !inventoryAfterBreakGlass.inventory.rows.some(row => row?.targetKey === pluginTargetKey),
    'P0-RC2-BREAK-GLASS-BEFORE-STATE',
    'break-glass recovery did not restore the exact absent pre-install Plugin state',
  )
  receipt.observations.lifecycle.push({
    origin: 'controlled-official-cli-aba',
    operationKind: 'install',
    operationId: controlledAba.operationId,
    outcome: 'rolled-back',
    planId: abaPlan.content.planId,
    planHash: abaPlan.hash,
    receiptDigest: recoveredAba.receipt.digest,
    externalRuntimeAction: 'download',
    targetKey: pluginTargetKey,
    breakGlassReceiptPath: 'break-glass-receipt.json',
  })
  receipt.inputs.breakGlassRecoveryProven = true
  receipt.notProven = receipt.notProven.filter(item => item !== 'break-glass-managed-plugin-restore-receipt')

  const pluginInstalled = await runPluginLifecycle(
    pluginV010,
    'install',
    { ...activePluginState(), candidateRef: pluginV010.candidateRef },
    {},
  )
  terminalReceipts.push(pluginInstalled.receipt)
  requireCondition(
    pluginInstalled.row.evidence?.kind === 'plugin'
      && pluginInstalled.row.evidence.loaderPhase === 'active'
      && pluginInstalled.row.evidence.consumerObserved === true
      && pluginInstalled.row.evidence.restartObserved === true,
    'P0-RC2-PLUGIN-INSTALL',
    'managed Host+Client Plugin was not active after the exact official Host restart',
  )
  receipt.observations.lifecycle.push(pluginInstalled.evidence)

  requireCondition(
    pluginInstalled.row.updateObservation?.status === 'available'
      && pluginInstalled.row.updateObservation.candidateRef === pluginV011.candidateRef
      && pluginInstalled.row.updateObservation.integrity === pluginV011.artifact.integrity,
    'P0-RC2-PLUGIN-UPDATE-DISCOVERY',
    'installed Plugin did not expose the exact newer signed release',
  )
  const pluginConfigured = await runPluginLifecycle(
    pluginV010,
    'configure',
    { ...activePluginState(), candidateRef: pluginV010.candidateRef },
    pluginConfiguration,
  )
  terminalReceipts.push(pluginConfigured.receipt)
  receipt.observations.lifecycle.push(pluginConfigured.evidence)

  const pluginUpdated = await runPluginLifecycle(
    pluginV011,
    'update',
    { ...activePluginState(), candidateRef: pluginV011.candidateRef },
    pluginConfiguration,
  )
  terminalReceipts.push(pluginUpdated.receipt)
  requireCondition(
    pluginUpdated.row.evidence?.kind === 'plugin'
      && pluginUpdated.row.evidence.loaderPhase === 'active'
      && pluginUpdated.row.evidence.consumerObserved === true
      && pluginUpdated.row.evidence.restartObserved === true,
    'P0-RC2-PLUGIN-UPDATE',
    'managed Plugin update did not activate and verify the exact public 0.1.1 release',
  )
  receipt.observations.lifecycle.push(pluginUpdated.evidence)

  const pluginRolledBack = await runPluginLifecycle(
    pluginV010,
    'restore',
    { ...activePluginState(), candidateRef: pluginV010.candidateRef },
    pluginConfiguration,
  )
  terminalReceipts.push(pluginRolledBack.receipt)
  receipt.observations.lifecycle.push({ ...pluginRolledBack.evidence, stage: 'rollback-after-update' })

  const pluginUpdatedAgain = await runPluginLifecycle(
    pluginV011,
    'update',
    { ...activePluginState(), candidateRef: pluginV011.candidateRef },
    pluginConfiguration,
  )
  terminalReceipts.push(pluginUpdatedAgain.receipt)
  receipt.observations.lifecycle.push({ ...pluginUpdatedAgain.evidence, stage: 'update-after-rollback' })

  const pluginUninstalled = await runPluginLifecycle(
    pluginV011,
    'uninstall',
    { ...removedPluginState(), candidateRef: pluginV011.candidateRef },
    pluginConfiguration,
  )
  terminalReceipts.push(pluginUninstalled.receipt)
  requireCondition(
    pluginUninstalled.row.evidence?.kind === 'plugin'
      && pluginUninstalled.row.evidence.loaderPhase === 'absent'
      && pluginUninstalled.row.actions?.restore?.status === 'available',
    'P0-RC2-PLUGIN-UNINSTALL',
    'uninstalled Plugin retained an active Loader row or lost its restore path',
  )
  receipt.observations.lifecycle.push(pluginUninstalled.evidence)

  const pluginRestored = await runPluginLifecycle(
    pluginV011,
    'restore',
    { ...activePluginState(), candidateRef: pluginV011.candidateRef },
    pluginConfiguration,
  )
  terminalReceipts.push(pluginRestored.receipt)
  receipt.observations.lifecycle.push(pluginRestored.evidence)

  const pluginRemovedAgain = await runPluginLifecycle(
    pluginV011,
    'uninstall',
    { ...removedPluginState(), candidateRef: pluginV011.candidateRef },
    pluginConfiguration,
  )
  terminalReceipts.push(pluginRemovedAgain.receipt)
  receipt.observations.lifecycle.push({ ...pluginRemovedAgain.evidence, stage: 'uninstall-after-restore' })

  const receipts = await rpc.call('operation/receipts', { protocolVersion: 1 })
  requireCondition(Array.isArray(receipts.receipts), 'P0-RC2-RECEIPTS', 'operation/receipts omitted its receipt list')
  try {
    verifyReceiptInventory(receipts.receipts, terminalReceipts)
  } catch (error) {
    throw new AcceptanceFailure(
      'P0-RC2-RECEIPTS',
      error instanceof Error ? error.message : String(error),
    )
  }
  requireCondition(true, 'P0-RC2-RECEIPTS', 'durable receipt inventory was not independently verified')
  for (const expected of terminalReceipts) {
    const operation = await rpc.call('operation/get', {
      protocolVersion: 1,
      operationId: expected.body.operationId,
    })
    try {
      verifyOperationReceiptJournal(operation.operation, expected)
    } catch (error) {
      throw new AcceptanceFailure(
        'P0-RC2-JOURNAL-RECEIPT-BINDING',
        error instanceof Error ? error.message : String(error),
      )
    }
    requireCondition(true, 'P0-RC2-JOURNAL-RECEIPT-BINDING', `operation ${expected.body.operationId} journal was not independently verified`)
  }
  receipt.observations.terminalReceiptDigests = terminalReceipts.map(item => item.digest)
  receipt.observations.terminalJournalHeadDigests = terminalReceipts.map(item => item.body.journalHeadDigest)

  requestLiveChildTeardown(webChild)
  await stopChild(webChild)
  webChild = undefined
  await checkedStep(
    'P0-RC2-AGENT-REPLAY-REMOVE',
    dshBin,
    ['plugin', '--profile', 'web', 'remove', replayInstallation.packageName],
    { cwd: workspace, env: runtimeEnv, timeoutMs: 120_000 },
  )
  receipt.inputs.keylessOfficialReplayBundleRemoved = true
  await checkedStep(
    'P0-RC2-CENTER-SELF-REMOVE',
    dshBin,
    ['plugin', '--profile', 'web', 'remove', 'dsh-plugin-extension-center'],
    { cwd: workspace, env: runtimeEnv, timeoutMs: 120_000 },
  )
  const removedDump = await checkedStep(
    'P0-RC2-CENTER-SELF-REMOVE',
    dshBin,
    ['--profile', 'web', '--dump-config'],
    { cwd: workspace, env: runtimeEnv, timeoutMs: 60_000 },
  )
  requireCondition(
    !removedDump.stdout.includes('# == dsh-plugin-extension-center')
      && !removedDump.stdout.includes('name: dsh-plugin-extension-center'),
    'P0-RC2-CENTER-SELF-REMOVE',
    'official CLI remove retained the Center bundle layer',
  )
  receipt.observations.profileRemovalFinalDigest = await profileRemovalSurfaceDigest(profileRoot)
  requireCondition(
    receipt.observations.profileRemovalFinalDigest === receipt.observations.profileRemovalBaselineDigest,
    'P0-RC2-PROFILE-REMOVAL-RESIDUE',
    'official CLI remove changed a Profile path outside the declared fixture and package-manager whitelist',
  )
  await assertNoManagedResolutionLinks(
    profileRoot,
    join(dshHome, 'extension-center'),
    ['dsh-plugin-extension-center', replayInstallation.packageName, pluginV010.name],
  )
  receipt.observations.centerAndChildResolutionLinksAbsent = true
  receipt.observations.officialDshPackageTreeUnchanged = await immutablePackageTreeDigest(officialHost.packageRoot)
    === officialHost.packageTreeDigest
  requireCondition(
    receipt.observations.officialDshPackageTreeUnchanged,
    'P0-RC2-OFFICIAL-HOST-MODIFIED',
    'packed lifecycle or removal changed the official DSH package tree',
  )
  receipt.inputs.officialCliRemovalProven = true
  receipt.status = 'passed'
  receipt.p0Status = 'official-rc2-lifecycle-proven'
} catch (error) {
  const code = error instanceof AcceptanceFailure ? error.code : 'P0-RC2-HARNESS-FAILURE'
  receipt.status = OWNER_MISSING_FAILURE_CODES.has(code) ? 'failed' : 'invalid'
  receipt.failure = {
    code,
    message: sanitizeDiagnostic(error instanceof Error ? error.message : String(error)),
  }
  process.exitCode = 1
} finally {
  receipt.observations.assertionAccounting.stableGatesPassed = stableGateAssertionsPassed
  receipt.observations.assertionAccounting.requiredOwnerPredicatesPassed = requiredOwnerAssertionsPassed
  receipt.observations.assertionAccounting.totalPassed = stableGateAssertionsPassed + requiredOwnerAssertionsPassed
  const finalizationFailures = []
  for (const [label, finalize] of [
    ['dsh-web-process', async () => {
      if (receipt.status === 'passed' && webChild !== undefined) requestLiveChildTeardown(webChild)
      await stopChild(webChild)
    }],
    ['web-log', async () => { await writeFile(join(evidenceRoot, 'web.log'), sanitizeDiagnostic(webOutput.value)) }],
    ['temporary-home', async () => { if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }) }],
  ]) {
    try {
      await finalize()
    } catch (finalizationError) {
      finalizationFailures.push({
        code: finalizationError instanceof AcceptanceFailure ? finalizationError.code : 'P0-RC2-TEARDOWN',
        message: `${label}: ${sanitizeDiagnostic(finalizationError instanceof Error ? finalizationError.message : String(finalizationError))}`,
      })
    }
  }
  if (finalizationFailures.length > 0) {
    receipt.status = 'invalid'
    receipt.p0Status = 'not-proven'
    receipt.failure = {
      code: finalizationFailures[0].code,
      message: `[${finalizationFailures[0].code}] ${finalizationFailures.map(failure => failure.message).join('; ')}`,
    }
    process.exitCode = 1
  }
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(join(evidenceRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}

if (receipt.status === 'passed') {
  process.stdout.write(`Unmodified official DSH rc.2 lifecycle lane passed; release and matrix evidence remain separate gates: ${evidenceRoot}\n`)
} else {
  process.stderr.write(`${receipt.failure?.message ?? 'official DSH rc.2 acceptance failed'}\n`)
  process.stderr.write(`status=${receipt.status}; evidence=${evidenceRoot}\n`)
}

function launchOfficialWeb(command, cwd, env, output) {
  const child = spawn(command, ['web', '--no-open', '--port', '0'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const launchOutput = { value: '' }
  let launchCopied = false
  const copyLaunchOutput = () => {
    if (launchCopied) return
    launchCopied = true
    output.value += launchOutput.value
  }
  const ready = (async () => {
    try {
      const origin = await waitForReadyUrl(child, launchOutput, 120_000)
      copyLaunchOutput()
      const appendOutput = chunk => { output.value += chunk.toString() }
      child.stdout?.on('data', appendOutput)
      child.stderr?.on('data', appendOutput)
      await delay(250)
      return Object.freeze({ child, origin })
    } catch (error) {
      copyLaunchOutput()
      try {
        await stopChild(child)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'dsh web readiness failed and the unready Host could not be stopped',
        )
      }
      throw error
    }
  })()
  return Object.freeze({ child, ready })
}

async function startOfficialWeb(command, cwd, env, output) {
  return await launchOfficialWeb(command, cwd, env, output).ready
}

function createRpcClient(webOrigin, ledger) {
  let sequence = 0
  const raw = async (method, payload, suppliedRpcId, timeoutMs = 30_000) => {
    const rpcId = suppliedRpcId ?? `official-rc2-${String(++sequence).padStart(2, '0')}-${method.replaceAll('/', '-')}`
    ledger.push(method)
    const response = await fetch(new URL(`/dsh-extension-center/${method}`, webOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new AcceptanceFailure('P0-RC2-RPC-HTTP', `${method} failed over HTTP ${String(response.status)}`)
    let body
    try {
      body = await response.json()
    } catch {
      throw new AcceptanceFailure('P0-RC2-RPC-ENVELOPE', `${method} did not return JSON`)
    }
    const envelope = expectRecord(body, `${method} envelope`)
    requireCondition(
      envelope.type === 'server-response' && envelope.rpcId === rpcId,
      'P0-RC2-RPC-ENVELOPE',
      `${method} response did not correlate to its request`,
    )
    return envelope
  }
  const call = async (method, payload, timeoutMs) => {
    const envelope = await raw(method, payload, undefined, timeoutMs)
    const result = expectRecord(envelope.result, `${method} result`)
    if (result.ok !== true) {
      const error = isRecord(result.error) && typeof result.error.message === 'string'
        ? result.error.message
        : 'business failure without a safe message'
      throw new AcceptanceFailure('P0-RC2-RPC-REFUSED', `${method} was refused: ${error}`)
    }
    const value = expectRecord(result.value, `${method} value`)
    requireCondition(value.protocolVersion === 1, 'P0-RC2-RPC-VERSION', `${method} returned a different protocol version`)
    return value
  }
  return Object.freeze({ raw, call })
}

function assertPlan(response, expected) {
  requireCondition(response.policy?.status === 'eligible', 'P0-RC2-PLAN-POLICY', `${expected.operationKind} policy was not eligible`)
  const plan = expectRecord(response.plan, `${expected.operationKind} plan`)
  const content = expectRecord(plan.content, `${expected.operationKind} plan content`)
  let planIntegrityFailure = null
  try {
    verifyImmutablePlanDigest(plan)
  } catch (error) {
    planIntegrityFailure = error instanceof Error ? error.message : String(error)
  }
  const mismatches = [
    ['intentId', typeof response.intentId === 'string' && content.intentId === response.intentId, content.intentId],
    ['hash', planIntegrityFailure === null, planIntegrityFailure ?? plan.hash],
    ['origin', content.origin === 'store', content.origin],
    ['singleUse', content.singleUse === true, content.singleUse],
    ['candidateRef', content.candidateRef === expected.candidateRef, content.candidateRef],
    ['extensionKind', content.extensionKind === (expected.extensionKind ?? 'skill'), content.extensionKind],
    ['managedObject', content.managedObject === (expected.managedObject ?? 'artifact'), content.managedObject],
    ['targetKey', content.targetKey === expected.targetKey, content.targetKey],
    ['scopeKey', content.scopeKey === (expected.scopeKey ?? 'user'), content.scopeKey],
    ['profileId', content.profileId === 'web', content.profileId],
    ['operationKind', content.operationKind === expected.operationKind, content.operationKind],
    ['desiredState', expected.desiredState === undefined || content.desiredState === expected.desiredState, content.desiredState],
    ['externalRuntimeAction', content.externalRuntimeAction === expected.externalRuntimeAction, content.externalRuntimeAction],
    ['runtimeBinding', expected.runtimeRef === undefined
      ? content.runtimeBinding === null
      : isRecord(content.runtimeBinding)
        && content.runtimeBinding.runtimeRef === expected.runtimeRef
        && typeof content.runtimeBinding.descriptorDigest === 'string', content.runtimeBinding],
    ['restartRequired', expected.restartRequired === undefined
      || content.restartRequired === expected.restartRequired, content.restartRequired],
  ].filter(([, matches]) => !matches)
  requireCondition(
    mismatches.length === 0,
    'P0-RC2-PLAN-BINDING',
    `${expected.operationKind} plan did not bind its exact candidate, target, scope, operation, and runtime action; mismatches: ${mismatches.map(([field, , observed]) => `${field}=${JSON.stringify(observed)}`).join(', ')}`,
  )
  return plan
}

async function approvePlan(rpc, plan) {
  const content = plan.content
  const response = await rpc.call('plan/decide', {
    protocolVersion: 1,
    planId: content.planId,
    planHash: plan.hash,
    operationKind: content.operationKind,
    decision: 'approve',
  })
  const state = expectRecord(response.state, `${content.operationKind} decision state`)
  requireCondition(
    state.status === 'approved'
      && state.plan?.hash === plan.hash
      && state.decision?.planId === content.planId
      && state.decision?.planHash === plan.hash
      && state.decision?.operationKind === content.operationKind
      && state.decision?.decision === 'approve',
    'P0-RC2-APPROVAL-BINDING',
    `${content.operationKind} approval did not bind the exact immutable plan`,
  )
  return response
}

async function assertRestartRequiredLifecycle(rpc, response, plan) {
  let journalReasons = []
  if (response.status !== 'restart-required' && typeof response.operationId === 'string') {
    const value = await rpc.call('operation/get', {
      protocolVersion: 1,
      operationId: response.operationId,
    })
    const events = Array.isArray(value?.operation?.journal?.events)
      ? value.operation.journal.events
      : []
    journalReasons = events
      .map(event => event?.entry)
      .filter(entry => entry?.type === 'phase-transition' && typeof entry.reason === 'string')
      .map(entry => `${String(entry.from)}->${String(entry.to)}:${entry.reason}`)
  }
  requireCondition(
    response.status === 'restart-required'
      && typeof response.operationId === 'string'
      && response.receipt === null,
    'P0-RC2-PLUGIN-RESTART-REQUIRED',
    `${plan.content.operationKind} did not stop at an exact restart-required checkpoint `
      + `(status=${JSON.stringify(response?.status)}, receipt=${response?.receipt === null ? 'null' : 'present'}, operationId=${typeof response?.operationId}, `
      + `journalReasons=${JSON.stringify(journalReasons)})`,
  )
  return response.operationId
}

async function waitForCommittedOperation(rpc, operationId, plan, externalRuntimeAction, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await rpc.call('operation/get', { protocolVersion: 1, operationId })
    const loaded = value.operation
    if (isRecord(loaded) && isRecord(loaded.projection) && loaded.projection.phase === 'committed') {
      const terminalReceipt = assertCommittedLifecycle({
        operationId,
        status: loaded.projection.phase,
        receipt: loaded.projection.receipt,
      }, plan, externalRuntimeAction)
      try {
        verifyOperationReceiptJournal(loaded, terminalReceipt)
      } catch (error) {
        throw new AcceptanceFailure(
          'P0-RC2-PLUGIN-RESTART-JOURNAL',
          error instanceof Error ? error.message : String(error),
        )
      }
      return Object.freeze({ loaded, receipt: terminalReceipt })
    }
    if (isRecord(loaded) && isRecord(loaded.projection)
      && ['failed', 'rolled-back', 'recovery-required'].includes(loaded.projection.phase)) {
      throw new AcceptanceFailure(
        'P0-RC2-PLUGIN-RESTART-TERMINAL',
        `managed Plugin operation stopped in ${String(loaded.projection.phase)}`,
      )
    }
    if (Date.now() >= deadline) {
      throw new AcceptanceFailure('P0-RC2-PLUGIN-RESTART-TIMEOUT', 'managed Plugin operation did not settle after Host restart')
    }
    await delay(250)
  }
}

async function waitForRolledBackOperation(rpc, operationId, plan, externalRuntimeAction, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await rpc.call('operation/get', { protocolVersion: 1, operationId })
    const loaded = value.operation
    if (isRecord(loaded) && isRecord(loaded.projection) && loaded.projection.phase === 'rolled-back') {
      const terminalReceipt = assertTerminalLifecycle({
        operationId,
        status: loaded.projection.phase,
        receipt: loaded.projection.receipt,
      }, plan, externalRuntimeAction, 'rolled-back')
      try {
        verifyOperationReceiptJournal(loaded, terminalReceipt)
      } catch (error) {
        throw new AcceptanceFailure(
          'P0-RC2-BREAK-GLASS-JOURNAL',
          error instanceof Error ? error.message : String(error),
        )
      }
      return Object.freeze({ loaded, receipt: terminalReceipt })
    }
    if (isRecord(loaded) && isRecord(loaded.projection)
      && ['committed', 'failed'].includes(loaded.projection.phase)) {
      throw new AcceptanceFailure(
        'P0-RC2-BREAK-GLASS-TERMINAL',
        `break-glass reconciliation stopped in ${String(loaded.projection.phase)}`,
      )
    }
    if (Date.now() >= deadline) {
      throw new AcceptanceFailure('P0-RC2-BREAK-GLASS-TIMEOUT', 'break-glass operation did not reach rolled-back after Host restart')
    }
    await delay(250)
  }
}

async function runStoreLifecycle(rpc, input) {
  const scopeKey = input.scopeKey ?? 'user'
  const extensionKind = input.extensionKind ?? 'skill'
  const managedObject = extensionKind === 'mcp' ? 'connection' : 'artifact'
  const externalRuntimeAction = extensionKind !== 'mcp'
    && (input.operationKind === 'install' || input.operationKind === 'update')
    ? 'download'
    : 'none'
  const preview = await rpc.call('intent/preview', {
    protocolVersion: 1,
    origin: 'store',
    candidateRef: input.candidateRef,
    operationKind: input.operationKind,
    scopeKey,
    profileId: 'web',
    continuationId: null,
    targetKey: input.targetKey,
    configuration: input.configuration,
  })
  const plan = assertPlan(preview, {
    candidateRef: input.candidateRef,
    targetKey: input.targetKey,
    operationKind: input.operationKind,
    desiredState: input.expected.desired,
    externalRuntimeAction,
    extensionKind,
    managedObject,
    scopeKey,
    ...(input.runtimeRef === undefined ? {} : { runtimeRef: input.runtimeRef }),
  })
  const approval = await approvePlan(rpc, plan)
  requireCondition(approval.state.status === 'approved', 'P0-RC2-APPROVAL', `${input.operationKind} plan was not approved exactly once`)
  const lifecycle = await rpc.call('lifecycle/request', {
    protocolVersion: 1,
    planHash: plan.hash,
  }, 60_000)
  const terminalReceipt = assertCommittedLifecycle(lifecycle, plan, externalRuntimeAction)
  const inventory = await rpc.call('inventory/list', {
    protocolVersion: 1,
    scopeKey,
    profileId: 'web',
  })
  const row = assertInventoryRow(inventory, input.targetKey, {
    ...input.expected,
    extensionKind,
    scopeKey,
  })
  return Object.freeze({
    plan,
    lifecycle,
    receipt: terminalReceipt,
    row,
    evidence: lifecycleEvidence(plan, lifecycle, terminalReceipt, row),
  })
}

function activeSkillState() {
  return Object.freeze({
    desired: 'enabled',
    materialized: 'configured',
    effective: 'active',
    visibility: 'visible',
    verification: 'runtime',
  })
}

function removedSkillState() {
  return Object.freeze({
    desired: 'removed',
    materialized: 'absent',
    effective: 'inactive',
    visibility: 'not-visible',
    verification: 'unverified',
  })
}

function disabledMcpState() {
  return Object.freeze({
    desired: 'disabled',
    materialized: 'configured',
    effective: 'inactive',
    visibility: 'not-visible',
    verification: 'structural',
  })
}

function activeMcpState() {
  return Object.freeze({
    desired: 'enabled',
    materialized: 'configured',
    effective: 'active',
    visibility: 'visible',
    verification: 'runtime',
  })
}

function removedMcpState() {
  return Object.freeze({
    desired: 'removed',
    materialized: 'absent',
    effective: 'inactive',
    visibility: 'not-visible',
    verification: 'unverified',
  })
}

function activePluginState() {
  return Object.freeze({
    desired: 'enabled',
    materialized: 'configured',
    effective: 'active',
    visibility: 'visible',
    verification: 'runtime',
  })
}

function removedPluginState() {
  return Object.freeze({
    desired: 'removed',
    materialized: 'absent',
    effective: 'inactive',
    visibility: 'not-visible',
    verification: 'unverified',
  })
}

function assertCommittedLifecycle(response, plan, externalRuntimeAction) {
  return assertTerminalLifecycle(response, plan, externalRuntimeAction, 'committed')
}

function assertTerminalLifecycle(response, plan, externalRuntimeAction, outcome) {
  const receiptValue = expectRecord(response.receipt, `${plan.content.operationKind} receipt`)
  const body = expectRecord(receiptValue.body, `${plan.content.operationKind} receipt body`)
  const mismatches = [
    ['status', response.status === outcome, response.status],
    ['operationId', typeof response.operationId === 'string' && body.operationId === response.operationId, response.operationId],
    ['planId', body.planId === plan.content.planId, body.planId],
    ['planHash', body.planHash === plan.hash, body.planHash],
    ['operationKind', body.operationKind === plan.content.operationKind, body.operationKind],
    ['managedObject', body.managedObject === plan.content.managedObject, body.managedObject],
    ['externalRuntimeAction', body.externalRuntimeAction === externalRuntimeAction, body.externalRuntimeAction],
    ['runtimeBinding', JSON.stringify(body.runtimeBinding) === JSON.stringify(plan.content.runtimeBinding), body.runtimeBinding],
    ['targetKey', body.targetKey === plan.content.targetKey, body.targetKey],
    ['outcome', body.outcome === outcome, body.outcome],
    ['mutationDigests', Array.isArray(body.mutationDigests) && body.mutationDigests.length > 0, Array.isArray(body.mutationDigests) ? body.mutationDigests.length : typeof body.mutationDigests],
    ['verificationDigests', Array.isArray(body.verificationDigests) && body.verificationDigests.length > 0, Array.isArray(body.verificationDigests) ? body.verificationDigests.length : typeof body.verificationDigests],
    ['receiptDigest', typeof receiptValue.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(receiptValue.digest), receiptValue.digest],
  ].filter(([, matches]) => !matches)
  try {
    verifyTerminalReceiptPlanBinding(receiptValue, plan)
  } catch (error) {
    mismatches.push(['receiptCanonicalBinding', false, error instanceof Error ? error.message : String(error)])
  }
  requireCondition(
    mismatches.length === 0,
    'P0-RC2-LIFECYCLE-RECEIPT',
    `${plan.content.operationKind} did not return the exact ${outcome} terminal receipt; mismatches: ${mismatches.map(([field, , observed]) => `${field}=${JSON.stringify(observed)}`).join(', ')}`,
  )
  return receiptValue
}

function assertInventoryEnvelope(response, phase, scopeKey = 'user') {
  requireCondition(
    response.hostCapabilities?.acquisition === true
      && isRecord(response.inventory)
      && response.inventory.scopeKey === scopeKey
      && response.inventory.profileId === 'web'
      && Array.isArray(response.inventory.rows)
      && typeof response.inventory.revision === 'string',
    'P0-RC2-INVENTORY',
    `${phase} inventory omitted its exact scope, rows, revision, or Host capability`,
  )
}

function assertInventoryRow(response, targetKey, expected) {
  const extensionKind = expected.extensionKind ?? 'skill'
  const scopeKey = expected.scopeKey ?? 'user'
  assertInventoryEnvelope(response, expected.desired, scopeKey)
  const rows = response.inventory.rows.filter(row => row?.targetKey === targetKey)
  requireCondition(rows.length === 1, 'P0-RC2-INVENTORY-TARGET', `expected one exact ${targetKey} row, observed ${String(rows.length)}`)
  const row = rows[0]
  const candidateMatches = expected.candidateRef === null
    ? row.candidateRef === null
    : typeof expected.candidateRef === 'string'
      ? row.candidateRef === expected.candidateRef
      : row.candidateRef?.startsWith(`${extensionKind}:`)
  requireCondition(
    row.kind === extensionKind
      && candidateMatches
      && row.ownership === 'center'
      && row.scopeKey === scopeKey
      && row.profileId === 'web'
      && row.desired === expected.desired
      && row.materialized === expected.materialized
      && row.effective === expected.effective
      && row.agentVisibility === expected.visibility
      && row.verification === expected.verification,
    'P0-RC2-INVENTORY-STATE',
    `inventory row ${targetKey} did not expose the expected independent lifecycle dimensions`,
  )
  return row
}

async function assertManagedArtifact(path, materialRoot, expectedIntegrity, expectedSize) {
  const canonicalRoot = await realpath(materialRoot)
  const canonicalPath = await realpath(path)
  const rel = relative(canonicalRoot, canonicalPath)
  requireCondition(
    rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`),
    'P0-RC2-SKILL-MATERIAL',
    'winning Skill path escaped the isolated Extension Center material root',
  )
  const info = await lstat(canonicalPath)
  requireCondition(info.isFile() && !info.isSymbolicLink() && info.size === expectedSize, 'P0-RC2-SKILL-MATERIAL', 'winning Skill material is not the exact regular file')
  const bytes = await readFile(canonicalPath)
  const separator = expectedIntegrity.indexOf(':')
  const algorithm = expectedIntegrity.slice(0, separator)
  const encoded = expectedIntegrity.slice(separator + 1)
  const actual = `${algorithm}:${createHash(algorithm).update(bytes).digest(/^[a-f0-9]+$/.test(encoded) ? 'hex' : 'base64')}`
  requireCondition(actual === expectedIntegrity, 'P0-RC2-SKILL-MATERIAL', 'winning Skill material digest differs from the signed catalog')
}

async function pathIsAbsent(path) {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
}

function lifecycleEvidence(plan, lifecycle, terminalReceipt, row) {
  return {
    planId: plan.content.planId,
    planHash: plan.hash,
    singleUse: plan.content.singleUse,
    operationKind: plan.content.operationKind,
    operationId: lifecycle.operationId,
    outcome: lifecycle.status,
    receiptDigest: terminalReceipt.digest,
    externalRuntimeAction: terminalReceipt.body.externalRuntimeAction,
    targetKey: row.targetKey,
    desired: row.desired,
    materialized: row.materialized,
    effective: row.effective,
    agentVisibility: row.agentVisibility,
    verification: row.verification,
    managedRevision: row.managedRevision,
    ownerRevision: row.ownerRevision,
    ...(row.evidence?.kind === 'skill' ? { skillOwnerEvidence: skillInventoryEvidence(row) } : {}),
  }
}

function skillInventoryEvidence(row) {
  const evidence = row.evidence?.kind === 'skill' ? row.evidence : null
  return {
    mergedWinnerProvider: evidence?.winningProvider ?? null,
    loadedDefinitionPath: evidence?.winningPath ?? null,
    definitionLoaded: evidence?.definitionLoaded ?? false,
    invocation: evidence?.invocation ?? null,
  }
}

async function optionalTreeDigest(root) {
  const hash = createHash('sha256')
  try {
    await hashTree(root, root, hash)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    hash.update('absent\0')
  }
  return hash.digest('hex')
}

async function hashTree(root, path, hash) {
  const info = await lstat(path)
  const name = relative(root, path).replaceAll('\\', '/') || '.'
  if (info.isSymbolicLink()) {
    hash.update(`link:${name}\0`)
    return
  }
  if (info.isFile()) {
    hash.update(`file:${name}:${String(info.mode)}:${String(info.size)}\0`)
    hash.update(await readFile(path))
    return
  }
  requireCondition(info.isDirectory(), 'P0-RC2-MATERIAL-TREE', `unsupported material node ${name}`)
  hash.update(`dir:${name}:${String(info.mode)}\0`)
  const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) await hashTree(root, join(path, entry.name), hash)
}

async function checkedStep(code, command, args, options) {
  try {
    return await runObserved(command, args, options)
  } catch (cause) {
    throw new AcceptanceFailure(code, `${basename(command)} failed; ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

function runObserved(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let forceTimer
    const append = (current, chunk) => {
      const combined = current + chunk.toString()
      return combined.length <= 65_536 ? combined : combined.slice(-65_536)
    }
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    const settle = callback => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(forceTimer)
      callback()
    }
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      signalObservedTree(child, 'SIGTERM')
      forceTimer = setTimeout(() => signalObservedTree(child, 'SIGKILL'), 5_000)
    }, options.timeoutMs ?? 120_000)
    child.once('error', error => settle(() => rejectRun(error)))
    child.once('close', (exitCode, signal) => {
      if (timedOut) {
        settle(() => rejectRun(new Error(`${command} timed out\n${sanitizeDiagnostic(`${stdout}\n${stderr}`)}`)))
        return
      }
      if (exitCode !== 0) {
        settle(() => rejectRun(new Error(
          `${command} exited with ${signal ?? String(exitCode)}\n${sanitizeDiagnostic(`${stdout}\n${stderr}`)}`,
        )))
        return
      }
      settle(() => resolveRun({ stdout, stderr }))
    })
  })
}

function signalObservedTree(child, signal) {
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

function expectRecord(value, subject) {
  if (!isRecord(value)) throw new AcceptanceFailure('P0-RC2-RPC-PROTOCOL', `${subject} must be a JSON object`)
  return value
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireCondition(condition, code, message) {
  if (!condition) throw new AcceptanceFailure(code, message)
  stableGateAssertionsPassed += 1
}
