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
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AcceptanceFailure,
  OWNER_MISSING_FAILURE_CODES,
  REQUIRED_HOST_OWNERS,
  assertNoPackageLifecycleScripts,
  assertRequiredHostOwners,
  delay,
  hasBlockedCredentialEnvironment,
  hasProviderEndpointOverride,
  keylessEnvironment,
  parseCatalogListEnvelope,
  sanitizeDiagnostic,
  sha256,
  stopChild,
  waitForReadyUrl,
} from './support.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const configuredDshRoot = process.env.DSH_LOCAL_HEAD_ROOT?.trim()
const dshRoot = resolve(configuredDshRoot && configuredDshRoot.length > 0
  ? configuredDshRoot
  : join(projectRoot, '..', 'deepseek-harness'))
const configuredDshBin = process.env.DSH_LOCAL_HEAD_BIN?.trim()
const dshBin = resolve(configuredDshBin && configuredDshBin.length > 0
  ? configuredDshBin
  : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js'))
const evidenceRoot = join(projectRoot, '.artifacts', 'acceptance', 'full-p0-local-head')
const expectedBuiltFiles = [
  'apps/cli/lib/bin.js',
  'packages/bundle/base/lib/index.js',
  'packages/bundle/web-app/lib/index.js',
  'packages/profile/profile-transactions/lib/index.js',
  'packages/profile/profile-transactions-local/lib/index.js',
  'packages/mcp/mcp-connections/lib/index.js',
  'packages/mcp/mcp-connections-local/lib/index.js',
  'packages/continuation/task-continuation/lib/index.js',
  'packages/continuation/task-continuation-driver/lib/index.js',
]
const skillConfiguration = Object.freeze({
  modelInvocable: true,
  userInvocable: true,
  projectRoot: null,
})
let stableGateAssertionsPassed = 0
let requiredOwnerAssertionsPassed = 0

const receipt = {
  schemaVersion: 1,
  acceptanceId: 'P0-LH-001-LOCAL-HEAD-SKILL-LIFECYCLE',
  proofScope: 'packed-extension-local-dsh-head-host-rpc-skill-full-lifecycle-except-update',
  status: 'running',
  p0Status: 'not-proven',
  releaseClaim: 'local-head-only',
  target: {
    dshRoot,
    dshBin,
    commit: null,
    dirty: null,
    dirtyEntryCount: null,
    dirtyStatusDigest: null,
    version: null,
  },
  inputs: {
    isolatedHomesCreatedEmpty: false,
    credentialVariablesPassed: null,
    providerEndpointOverridePassed: null,
    telemetryModeRequested: null,
    packedArtifactInstalledByProfileTransaction: false,
  },
  artifact: null,
  observations: {
    bundleLayerObserved: false,
    catalogRevision: null,
    catalogEntriesDigest: null,
    requiredOwners: REQUIRED_HOST_OWNERS.map(requirement => requirement.key),
    hostCapabilities: null,
    mergedSkillWinner: null,
    assertionAccounting: {
      definition: 'successful requireCondition gates plus successful required-owner availability predicates',
      stableGatesPassed: 0,
      requiredOwnerPredicatesPassed: 0,
      totalPassed: 0,
    },
    rpcMethods: [],
    materialUnchangedBeforeApproval: false,
    lifecycle: [],
    terminalReceiptDigests: [],
  },
  notProven: [
    'published-dsh-release-installation',
    'published-extension-center-release-installation',
    'plugin-restart-lifecycle',
    'mcp-live-runtime-lifecycle',
    'skill-update-with-distinct-signed-catalog-revision',
    'task-driven-continuation-with-real-model',
    'provider-e2e',
    'cross-platform-matrix',
  ],
}

let tempRoot
let webChild
const webOutput = { value: '' }

try {
  await rm(evidenceRoot, { recursive: true, force: true })
  await mkdir(evidenceRoot, { recursive: true })
  await assertLocalHeadBuilt()
  await observeDshHead()

  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-extension-center-local-head-'))
  const packRoot = join(evidenceRoot, 'packed')
  const workspace = join(tempRoot, 'workspace')
  const dshHome = join(tempRoot, 'dsh-home')
  const agentsHome = join(tempRoot, 'agents-home')
  const isolatedHome = join(tempRoot, 'home')
  const xdgRoot = join(tempRoot, 'xdg')
  await Promise.all([
    mkdir(packRoot, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(dshHome, { recursive: true }),
    mkdir(agentsHome, { recursive: true }),
    mkdir(isolatedHome, { recursive: true }),
    mkdir(xdgRoot, { recursive: true }),
  ])
  receipt.inputs.isolatedHomesCreatedEmpty = (await readdir(dshHome)).length === 0
    && (await readdir(agentsHome)).length === 0

  const runtimeEnv = keylessEnvironment({
    ...process.env,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
    DSH_TELEMETRY_MODE: 'DISABLED',
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CACHE_HOME: join(xdgRoot, 'cache'),
    XDG_CONFIG_HOME: join(xdgRoot, 'config'),
    XDG_DATA_HOME: join(xdgRoot, 'data'),
    XDG_STATE_HOME: join(xdgRoot, 'state'),
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
    'P0-LOCAL-ISOLATION',
    'isolated keyless local-HEAD preconditions were not enforced',
  )

  const sourceManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  assertNoPackageLifecycleScripts(sourceManifest, 'source')
  const version = await checkedStep(
    'P0-LOCAL-HOST-BUILD',
    process.execPath,
    [dshBin, '--version'],
    { cwd: workspace, env: runtimeEnv, timeoutMs: 30_000 },
  )
  receipt.target.version = version.stdout.trim()
  const dshManifest = JSON.parse(await readFile(join(dshRoot, 'apps', 'cli', 'package.json'), 'utf8'))
  requireCondition(
    receipt.target.version === dshManifest.version,
    'P0-LOCAL-HOST-BUILD',
    `built CLI version ${JSON.stringify(receipt.target.version)} does not match source manifest ${JSON.stringify(dshManifest.version)}`,
  )

  await checkedStep(
    'P0-LOCAL-PACK',
    'pnpm',
    ['pack', '--pack-destination', packRoot],
    { cwd: projectRoot, env: runtimeEnv, timeoutMs: 60_000 },
  )
  const archives = (await readdir(packRoot)).filter(file => file.endsWith('.tgz'))
  requireCondition(archives.length === 1, 'P0-LOCAL-ARTIFACT', `expected one packed artifact, observed ${String(archives.length)}`)
  const artifact = join(packRoot, archives[0])
  const artifactBytes = await readFile(artifact)
  const artifactDigest = `sha256:${sha256(artifactBytes)}`
  const packedManifestOutput = await checkedStep(
    'P0-LOCAL-ARTIFACT',
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
    'P0-LOCAL-ARTIFACT-ROLES',
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

  const installed = await checkedStep(
    'P0-LOCAL-PROFILE-INSTALL',
    process.execPath,
    [
      dshBin,
      'plugin', '--profile', 'web', 'install', artifact,
      '--package', packedManifest.name,
      '--version', packedManifest.version,
      '--digest', artifactDigest,
      '--kind', 'bundle',
    ],
    { cwd: workspace, env: runtimeEnv, timeoutMs: 120_000 },
  )
  await writeFile(
    join(evidenceRoot, 'profile-install.log'),
    sanitizeDiagnostic(`${installed.stdout}${installed.stderr}`),
  )
  receipt.inputs.packedArtifactInstalledByProfileTransaction = true
  const dump = await checkedStep(
    'P0-LOCAL-PROFILE-DUMP',
    process.execPath,
    [dshBin, '--profile', 'web', '--dump-config'],
    { cwd: workspace, env: runtimeEnv, timeoutMs: 60_000 },
  )
  await writeFile(join(evidenceRoot, 'dump-config.txt'), sanitizeDiagnostic(dump.stdout))
  receipt.observations.bundleLayerObserved = dump.stdout.includes('# == dsh-plugin-extension-center')
    && dump.stdout.includes('name: dsh-plugin-extension-center')
  requireCondition(
    receipt.observations.bundleLayerObserved,
    'P0-LOCAL-BUNDLE-LAYER',
    'packed Extension Center was absent from the composed local-HEAD Web Profile',
  )

  webChild = spawn(process.execPath, [dshBin, 'web', '--no-open', '--port', '0'], {
    cwd: workspace,
    env: runtimeEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const webOrigin = await waitForReadyUrl(webChild, webOutput, 120_000)
  const appendOutput = chunk => { webOutput.value += chunk.toString() }
  webChild.stdout?.on('data', appendOutput)
  webChild.stderr?.on('data', appendOutput)
  await delay(250)

  const rpc = createRpcClient(webOrigin, receipt.observations.rpcMethods)
  const catalogRpcId = 'local-head-catalog-list'
  const catalogBody = await rpc.raw('catalog/list', { protocolVersion: 1 }, catalogRpcId)
  const parsedCatalog = parseCatalogListEnvelope(catalogBody, catalogRpcId)
  receipt.observations.catalogRevision = parsedCatalog.catalog.revision
  receipt.observations.catalogEntriesDigest = parsedCatalog.catalog.entriesDigest
  receipt.observations.hostCapabilities = assertRequiredHostOwners(parsedCatalog.capabilities)
  requiredOwnerAssertionsPassed = REQUIRED_HOST_OWNERS.length
  requireCondition(
    parsedCatalog.value.hostCapabilities.acquisition === true
      && parsedCatalog.value.hostCapabilities.reason === null,
    'P0-LOCAL-HOST-ACQUISITION',
    'all six owner booleans were present but the Host did not admit acquisition',
  )
  const skill = parsedCatalog.value.entries.find(entry => entry?.kind === 'skill')
  requireCondition(
    isRecord(skill)
      && typeof skill.candidateRef === 'string'
      && typeof skill.name === 'string'
      && isRecord(skill.artifact)
      && typeof skill.artifact.integrity === 'string'
      && typeof skill.artifact.sizeBytes === 'number',
    'P0-LOCAL-SKILL-CANDIDATE',
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
    'P0-LOCAL-SKILL-TARGET-NOT-EMPTY',
    'isolated user scope already contains the catalog Skill target',
  )

  const materialRoot = join(dshHome, 'extension-center', 'material')
  const materialBeforePlan = await optionalTreeDigest(materialRoot)
  const installPreview = await rpc.call('intent/preview', {
    protocolVersion: 1,
    origin: 'store',
    candidateRef,
    operationKind: 'install',
    scopeKey: 'user',
    profileId: 'web',
    continuationId: null,
    targetKey: null,
    configuration: skillConfiguration,
  })
  const installPlan = assertPlan(installPreview, {
    candidateRef,
    targetKey,
    operationKind: 'install',
    externalRuntimeAction: 'download',
  })
  const materialAfterPlan = await optionalTreeDigest(materialRoot)
  const installApproval = await approvePlan(rpc, installPlan)
  const materialAfterApproval = await optionalTreeDigest(materialRoot)
  receipt.observations.materialUnchangedBeforeApproval = materialBeforePlan === materialAfterPlan
    && materialAfterPlan === materialAfterApproval
  requireCondition(
    receipt.observations.materialUnchangedBeforeApproval,
    'P0-LOCAL-PREAPPROVAL-MUTATION',
    'plan creation or approval materialized Skill bytes before lifecycle execution',
  )
  requireCondition(installApproval.state.status === 'approved', 'P0-LOCAL-APPROVAL', 'install plan was not approved exactly once')

  const installLifecycle = await rpc.call('lifecycle/request', {
    protocolVersion: 1,
    planHash: installPlan.hash,
  }, 90_000)
  const installReceipt = assertCommittedLifecycle(installLifecycle, installPlan, 'download')
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
    'P0-LOCAL-SKILL-WINNER',
    'installed Skill was not the exact merged-registry winner',
  )
  await assertManagedArtifact(winningPath, materialRoot, skill.artifact.integrity, skill.artifact.sizeBytes)
  receipt.observations.mergedSkillWinner = skillInventoryEvidence(installedRow)
  const terminalReceipts = [installReceipt]
  receipt.observations.lifecycle.push(lifecycleEvidence(installPlan, installLifecycle, installReceipt, installedRow))

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
    'P0-LOCAL-SKILL-CONFIGURE',
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
    'P0-LOCAL-SKILL-DISABLE',
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
    'P0-LOCAL-SKILL-ENABLE',
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
    'P0-LOCAL-SKILL-UNINSTALL',
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
    'P0-LOCAL-SKILL-RESTORE',
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
    'P0-LOCAL-SKILL-PURGE',
    'purged Skill retained managed material, rollback state, or blocked its future install action',
  )
  receipt.observations.lifecycle.push(purged.evidence)

  const receipts = await rpc.call('operation/receipts', { protocolVersion: 1 })
  requireCondition(Array.isArray(receipts.receipts), 'P0-LOCAL-RECEIPTS', 'operation/receipts omitted its receipt list')
  for (const expected of terminalReceipts) {
    requireCondition(
      receipts.receipts.some(stored => stored?.receipt?.digest === expected.digest
        && stored.operationId === expected.body.operationId),
      'P0-LOCAL-RECEIPTS',
      `terminal receipt ${expected.digest} was absent from durable receipt inventory`,
    )
  }
  receipt.observations.terminalReceiptDigests = terminalReceipts.map(item => item.digest)
  receipt.status = 'passed'
  receipt.p0Status = 'local-head-lifecycle-proven'
} catch (error) {
  const code = error instanceof AcceptanceFailure ? error.code : 'P0-LOCAL-HARNESS-FAILURE'
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
    ['dsh-web-process', async () => { await stopChild(webChild) }],
    ['web-log', async () => { await writeFile(join(evidenceRoot, 'web.log'), sanitizeDiagnostic(webOutput.value)) }],
    ['temporary-home', async () => { if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }) }],
  ]) {
    try {
      await finalize()
    } catch (finalizationError) {
      finalizationFailures.push(`${label}: ${sanitizeDiagnostic(finalizationError instanceof Error ? finalizationError.message : String(finalizationError))}`)
    }
  }
  if (finalizationFailures.length > 0) {
    receipt.status = 'invalid'
    receipt.p0Status = 'not-proven'
    receipt.failure = {
      code: 'P0-LOCAL-TEARDOWN',
      message: `[P0-LOCAL-TEARDOWN] ${finalizationFailures.join('; ')}`,
    }
    process.exitCode = 1
  }
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(join(evidenceRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}

if (receipt.status === 'passed') {
  process.stdout.write(`Local DSH HEAD Skill lifecycle passed; release P0 remains unproven; evidence: ${evidenceRoot}\n`)
} else {
  process.stderr.write(`${receipt.failure?.message ?? 'local DSH HEAD acceptance failed'}\n`)
  process.stderr.write(`status=${receipt.status}; evidence=${evidenceRoot}\n`)
}

async function assertLocalHeadBuilt() {
  for (const path of expectedBuiltFiles) {
    const fullPath = join(dshRoot, path)
    let info
    try {
      info = await lstat(fullPath)
    } catch {
      throw new AcceptanceFailure(
        'P0-LOCAL-HOST-NOT-BUILT',
        `required local-HEAD output is absent: ${path}; run the relevant DSH build before this acceptance`,
      )
    }
    requireCondition(info.isFile() && !info.isSymbolicLink(), 'P0-LOCAL-HOST-NOT-BUILT', `required local-HEAD output is not a regular file: ${path}`)
  }
}

async function observeDshHead() {
  const commit = await checkedStep(
    'P0-LOCAL-HOST-GIT',
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: dshRoot, env: process.env, timeoutMs: 30_000 },
  )
  const status = await checkedStep(
    'P0-LOCAL-HOST-GIT',
    'git',
    ['status', '--porcelain=v1', '-z'],
    { cwd: dshRoot, env: process.env, timeoutMs: 30_000 },
  )
  const entries = status.stdout === '' ? [] : status.stdout.split('\0').filter(Boolean)
  receipt.target.commit = commit.stdout.trim()
  receipt.target.dirty = entries.length > 0
  receipt.target.dirtyEntryCount = entries.length
  receipt.target.dirtyStatusDigest = `sha256:${sha256(Buffer.from(status.stdout))}`
}

function createRpcClient(webOrigin, ledger) {
  let sequence = 0
  const raw = async (method, payload, suppliedRpcId, timeoutMs = 30_000) => {
    const rpcId = suppliedRpcId ?? `local-head-${String(++sequence).padStart(2, '0')}-${method.replaceAll('/', '-')}`
    ledger.push(method)
    const response = await fetch(new URL(`/dsh-extension-center/${method}`, webOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new AcceptanceFailure('P0-LOCAL-RPC-HTTP', `${method} failed over HTTP ${String(response.status)}`)
    let body
    try {
      body = await response.json()
    } catch {
      throw new AcceptanceFailure('P0-LOCAL-RPC-ENVELOPE', `${method} did not return JSON`)
    }
    const envelope = expectRecord(body, `${method} envelope`)
    requireCondition(
      envelope.type === 'server-response' && envelope.rpcId === rpcId,
      'P0-LOCAL-RPC-ENVELOPE',
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
      throw new AcceptanceFailure('P0-LOCAL-RPC-REFUSED', `${method} was refused: ${error}`)
    }
    const value = expectRecord(result.value, `${method} value`)
    requireCondition(value.protocolVersion === 1, 'P0-LOCAL-RPC-VERSION', `${method} returned a different protocol version`)
    return value
  }
  return Object.freeze({ raw, call })
}

function assertPlan(response, expected) {
  requireCondition(response.policy?.status === 'eligible', 'P0-LOCAL-PLAN-POLICY', `${expected.operationKind} policy was not eligible`)
  const plan = expectRecord(response.plan, `${expected.operationKind} plan`)
  const content = expectRecord(plan.content, `${expected.operationKind} plan content`)
  const mismatches = [
    ['intentId', typeof response.intentId === 'string' && content.intentId === response.intentId, content.intentId],
    ['hash', typeof plan.hash === 'string' && /^sha256:[a-f0-9]{64}$/.test(plan.hash), plan.hash],
    ['origin', content.origin === 'store', content.origin],
    ['singleUse', content.singleUse === true, content.singleUse],
    ['candidateRef', content.candidateRef === expected.candidateRef, content.candidateRef],
    ['extensionKind', content.extensionKind === 'skill', content.extensionKind],
    ['managedObject', content.managedObject === 'artifact', content.managedObject],
    ['targetKey', content.targetKey === expected.targetKey, content.targetKey],
    ['scopeKey', content.scopeKey === 'user', content.scopeKey],
    ['profileId', content.profileId === 'web', content.profileId],
    ['operationKind', content.operationKind === expected.operationKind, content.operationKind],
    ['desiredState', expected.desiredState === undefined || content.desiredState === expected.desiredState, content.desiredState],
    ['externalRuntimeAction', content.externalRuntimeAction === expected.externalRuntimeAction, content.externalRuntimeAction],
    ['runtimeBinding', content.runtimeBinding === null, content.runtimeBinding],
  ].filter(([, matches]) => !matches)
  requireCondition(
    mismatches.length === 0,
    'P0-LOCAL-PLAN-BINDING',
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
    'P0-LOCAL-APPROVAL-BINDING',
    `${content.operationKind} approval did not bind the exact immutable plan`,
  )
  return response
}

async function runStoreLifecycle(rpc, input) {
  const preview = await rpc.call('intent/preview', {
    protocolVersion: 1,
    origin: 'store',
    candidateRef: input.candidateRef,
    operationKind: input.operationKind,
    scopeKey: 'user',
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
    externalRuntimeAction: 'none',
  })
  const approval = await approvePlan(rpc, plan)
  requireCondition(approval.state.status === 'approved', 'P0-LOCAL-APPROVAL', `${input.operationKind} plan was not approved exactly once`)
  const lifecycle = await rpc.call('lifecycle/request', {
    protocolVersion: 1,
    planHash: plan.hash,
  }, 60_000)
  const terminalReceipt = assertCommittedLifecycle(lifecycle, plan, 'none')
  const inventory = await rpc.call('inventory/list', {
    protocolVersion: 1,
    scopeKey: 'user',
    profileId: 'web',
  })
  const row = assertInventoryRow(inventory, input.targetKey, input.expected)
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

function assertCommittedLifecycle(response, plan, externalRuntimeAction) {
  const receiptValue = expectRecord(response.receipt, `${plan.content.operationKind} receipt`)
  const body = expectRecord(receiptValue.body, `${plan.content.operationKind} receipt body`)
  const mismatches = [
    ['status', response.status === 'committed', response.status],
    ['operationId', typeof response.operationId === 'string' && body.operationId === response.operationId, response.operationId],
    ['planId', body.planId === plan.content.planId, body.planId],
    ['planHash', body.planHash === plan.hash, body.planHash],
    ['operationKind', body.operationKind === plan.content.operationKind, body.operationKind],
    ['managedObject', body.managedObject === 'artifact', body.managedObject],
    ['externalRuntimeAction', body.externalRuntimeAction === externalRuntimeAction, body.externalRuntimeAction],
    ['runtimeBinding', body.runtimeBinding === null, body.runtimeBinding],
    ['targetKey', body.targetKey === plan.content.targetKey, body.targetKey],
    ['outcome', body.outcome === 'committed', body.outcome],
    ['mutationDigests', Array.isArray(body.mutationDigests) && body.mutationDigests.length > 0, Array.isArray(body.mutationDigests) ? body.mutationDigests.length : typeof body.mutationDigests],
    ['verificationDigests', Array.isArray(body.verificationDigests) && body.verificationDigests.length > 0, Array.isArray(body.verificationDigests) ? body.verificationDigests.length : typeof body.verificationDigests],
    ['receiptDigest', typeof receiptValue.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(receiptValue.digest), receiptValue.digest],
  ].filter(([, matches]) => !matches)
  requireCondition(
    mismatches.length === 0,
    'P0-LOCAL-LIFECYCLE-RECEIPT',
    `${plan.content.operationKind} did not return the exact committed terminal receipt; mismatches: ${mismatches.map(([field, , observed]) => `${field}=${JSON.stringify(observed)}`).join(', ')}`,
  )
  return receiptValue
}

function assertInventoryEnvelope(response, phase) {
  requireCondition(
    response.hostCapabilities?.acquisition === true
      && isRecord(response.inventory)
      && response.inventory.scopeKey === 'user'
      && response.inventory.profileId === 'web'
      && Array.isArray(response.inventory.rows)
      && typeof response.inventory.revision === 'string',
    'P0-LOCAL-INVENTORY',
    `${phase} inventory omitted its exact scope, rows, revision, or Host capability`,
  )
}

function assertInventoryRow(response, targetKey, expected) {
  assertInventoryEnvelope(response, expected.desired)
  const rows = response.inventory.rows.filter(row => row?.targetKey === targetKey)
  requireCondition(rows.length === 1, 'P0-LOCAL-INVENTORY-TARGET', `expected one exact ${targetKey} row, observed ${String(rows.length)}`)
  const row = rows[0]
  const candidateMatches = expected.candidateRef === null
    ? row.candidateRef === null
    : row.candidateRef?.startsWith('skill:')
  requireCondition(
    row.kind === 'skill'
      && candidateMatches
      && row.ownership === 'center'
      && row.scopeKey === 'user'
      && row.profileId === 'web'
      && row.desired === expected.desired
      && row.materialized === expected.materialized
      && row.effective === expected.effective
      && row.agentVisibility === expected.visibility
      && row.verification === expected.verification,
    'P0-LOCAL-INVENTORY-STATE',
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
    'P0-LOCAL-SKILL-MATERIAL',
    'winning Skill path escaped the isolated Extension Center material root',
  )
  const info = await lstat(canonicalPath)
  requireCondition(info.isFile() && !info.isSymbolicLink() && info.size === expectedSize, 'P0-LOCAL-SKILL-MATERIAL', 'winning Skill material is not the exact regular file')
  const bytes = await readFile(canonicalPath)
  const separator = expectedIntegrity.indexOf(':')
  const algorithm = expectedIntegrity.slice(0, separator)
  const encoded = expectedIntegrity.slice(separator + 1)
  const actual = `${algorithm}:${createHash(algorithm).update(bytes).digest(/^[a-f0-9]+$/.test(encoded) ? 'hex' : 'base64')}`
  requireCondition(actual === expectedIntegrity, 'P0-LOCAL-SKILL-MATERIAL', 'winning Skill material digest differs from the signed catalog')
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
  requireCondition(info.isDirectory(), 'P0-LOCAL-MATERIAL-TREE', `unsupported material node ${name}`)
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
  if (!isRecord(value)) throw new AcceptanceFailure('P0-LOCAL-RPC-PROTOCOL', `${subject} must be a JSON object`)
  return value
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireCondition(condition, code, message) {
  if (!condition) throw new AcceptanceFailure(code, message)
  stableGateAssertionsPassed += 1
}
