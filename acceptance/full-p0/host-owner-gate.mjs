import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AcceptanceFailure,
  CATALOG_LIST_METHOD,
  OWNER_MISSING_FAILURE_CODES,
  REQUIRED_HOST_OWNERS,
  TARGET_DSH_COMMIT,
  TARGET_DSH_VERSION,
  assertNoPackageLifecycleScripts,
  assertRequiredHostOwners,
  catalogListRequest,
  delay,
  denyProxyEnvironment,
  hasBlockedCredentialEnvironment,
  hasProviderEndpointOverride,
  isAcquisitionOrPlanMethod,
  keylessEnvironment,
  mutableHostStateDigest,
  parseCatalogListEnvelope,
  runChecked,
  sanitizeDiagnostic,
  sha256,
  startDenyProxy,
  stopChild,
  stopDenyProxy,
  waitForReadyUrl,
} from './support.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = join(projectRoot, '.artifacts', 'acceptance', 'full-p0-host-owner-gate')
const dshBin = join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const expectedFirstRed = REQUIRED_HOST_OWNERS[0].failureCode
const receipt = {
  schemaVersion: 1,
  acceptanceId: 'P0-R-001-HOST-OWNER-GATE',
  proofScope: 'packed-extension-read-only-host-owner-preflight',
  p0Status: 'not-proven',
  status: 'running',
  expectedFirstRed,
  target: {
    dshPackage: `@deepseek-ai/dsh@${TARGET_DSH_VERSION}`,
    auditedSourceCommit: TARGET_DSH_COMMIT,
  },
  notProven: [
    'profile-transaction-owner-behavior',
    'dynamic-mcp-connection-owner-behavior',
    'durable-continuation-owner-behavior',
    'skill-registry-owner-behavior',
    'tool-registry-owner-behavior',
    'loader-observation-owner-behavior',
    'install-configure-update-uninstall-restore',
    'task-driven-acquisition',
    'provider-e2e',
  ],
  inputs: {
    isolatedHomesCreatedEmpty: false,
    credentialVariablesPassed: null,
    providerEndpointOverridePassed: null,
    telemetryModeRequested: null,
    packedArtifactInstalledAsSetup: false,
  },
  observations: {
    hostVersion: null,
    bundleLayerObserved: false,
    catalogSignatureObserved: false,
    catalogRevisionObserved: null,
    catalogEntriesDigestObserved: null,
    rpcRequests: [],
    acquisitionIntentOrPlanObserved: false,
    hostCapabilities: null,
    requiredOwners: REQUIRED_HOST_OWNERS.map(requirement => requirement.key),
    hostStateUnchangedDuringPreflight: false,
    hostProxyRequests: [],
  },
}

let tempRoot
let webChild
let proxy
const webOutput = { value: '' }

try {
  await rm(evidenceRoot, { recursive: true, force: true })
  await mkdir(evidenceRoot, { recursive: true })
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-extension-center-owner-gate-'))
  const packRoot = join(evidenceRoot, 'packed')
  const workspace = join(tempRoot, 'workspace')
  const dshHome = join(tempRoot, 'dsh-home')
  const agentsHome = join(tempRoot, 'agents-home')
  await Promise.all([
    mkdir(packRoot, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(dshHome, { recursive: true }),
    mkdir(agentsHome, { recursive: true }),
  ])

  receipt.inputs.isolatedHomesCreatedEmpty = (await readdir(dshHome)).length === 0
    && (await readdir(agentsHome)).length === 0
  const baseEnv = keylessEnvironment({
    ...process.env,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
    DSH_TELEMETRY_MODE: 'DISABLED',
  })
  receipt.inputs.credentialVariablesPassed = hasBlockedCredentialEnvironment(baseEnv)
  receipt.inputs.providerEndpointOverridePassed = hasProviderEndpointOverride(baseEnv)
  receipt.inputs.telemetryModeRequested = baseEnv.DSH_TELEMETRY_MODE ?? null
  if (
    !receipt.inputs.isolatedHomesCreatedEmpty
    || receipt.inputs.credentialVariablesPassed
    || receipt.inputs.providerEndpointOverridePassed
    || receipt.inputs.telemetryModeRequested !== 'DISABLED'
  ) {
    throw new AcceptanceFailure('P0-RED-KEYLESS-ENV', 'isolated keyless Host preconditions were not enforced')
  }

  proxy = await startDenyProxy(receipt.observations.hostProxyRequests)
  const runtimeEnv = denyProxyEnvironment(baseEnv, proxy.url)
  const sourceManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  assertNoPackageLifecycleScripts(sourceManifest, 'source')

  const version = await runChecked(dshBin, ['--version'], {
    cwd: workspace,
    env: runtimeEnv,
    timeoutMs: 30_000,
  })
  receipt.observations.hostVersion = version.stdout.trim()
  if (receipt.observations.hostVersion !== TARGET_DSH_VERSION) {
    throw new AcceptanceFailure(
      'P0-RED-HOST-VERSION',
      `expected ${TARGET_DSH_VERSION}, got ${JSON.stringify(receipt.observations.hostVersion)}`,
    )
  }

  await runChecked('pnpm', ['pack', '--pack-destination', packRoot], {
    cwd: projectRoot,
    env: runtimeEnv,
    timeoutMs: 60_000,
  })
  const archives = (await readdir(packRoot)).filter(file => file.endsWith('.tgz'))
  if (archives.length !== 1) {
    throw new AcceptanceFailure('P0-RED-ARTIFACT', `expected one packed artifact, observed ${String(archives.length)}`)
  }
  const artifact = join(packRoot, archives[0])
  const artifactBytes = await readFile(artifact)
  receipt.artifact = {
    filename: basename(artifact),
    evidencePath: `packed/${basename(artifact)}`,
    bytes: (await stat(artifact)).size,
    sha256: sha256(artifactBytes),
  }
  const packedManifestOutput = await runChecked('tar', ['-xOf', artifact, 'package/package.json'], {
    cwd: projectRoot,
    env: runtimeEnv,
    timeoutMs: 30_000,
  })
  const packedManifest = JSON.parse(packedManifestOutput.stdout)
  assertNoPackageLifecycleScripts(packedManifest, 'packed')
  if (
    packedManifest.exports?.['.'] === undefined
    || packedManifest.exports?.['./client'] === undefined
    || packedManifest.dsh?.bundle?.patch !== './cordis.patch.yml'
    || packedManifest.dsh?.client?.platform !== 'web'
  ) {
    throw new AcceptanceFailure('P0-RED-ARTIFACT-ROLES', 'packed artifact omitted its Host or Web Client role')
  }
  await writeFile(join(evidenceRoot, 'artifact-manifest.json'), `${JSON.stringify(packedManifest, null, 2)}\n`)

  await runChecked(dshBin, ['plugin', '--profile', 'web', 'add', artifact, '--offline', '--ignore-scripts', '--save-exact'], {
    cwd: workspace,
    env: runtimeEnv,
    timeoutMs: 120_000,
  })
  receipt.inputs.packedArtifactInstalledAsSetup = true
  const dump = await runChecked(dshBin, ['--profile', 'web', '--dump-config'], {
    cwd: workspace,
    env: runtimeEnv,
    timeoutMs: 60_000,
  })
  await writeFile(join(evidenceRoot, 'dump-config.txt'), sanitizeDiagnostic(dump.stdout))
  receipt.observations.bundleLayerObserved = dump.stdout.includes('# == dsh-plugin-extension-center')
    && dump.stdout.includes('name: dsh-plugin-extension-center')
  if (!receipt.observations.bundleLayerObserved) {
    throw new AcceptanceFailure('P0-RED-BUNDLE-LAYER', 'packed Extension Center was absent from the composed Web Profile')
  }

  webChild = spawn(dshBin, ['web', '--no-open', '--port', '0'], {
    cwd: workspace,
    env: runtimeEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const webOrigin = await waitForReadyUrl(webChild, webOutput)
  const appendOutput = chunk => { webOutput.value += chunk.toString() }
  webChild.stdout?.on('data', appendOutput)
  webChild.stderr?.on('data', appendOutput)
  await delay(250)

  const mutableRoots = [dshHome, agentsHome, workspace]
  const stateBefore = await mutableHostStateDigest(mutableRoots)
  const request = catalogListRequest()
  receipt.observations.rpcRequests.push(`POST ${request.path} ${request.body.method}`)
  receipt.observations.acquisitionIntentOrPlanObserved = isAcquisitionOrPlanMethod(request.body.method)
  if (receipt.observations.acquisitionIntentOrPlanObserved || request.body.method !== CATALOG_LIST_METHOD) {
    throw new AcceptanceFailure('P0-RED-PREFLIGHT-MUTATION-RPC', 'owner preflight attempted an acquisition or lifecycle RPC')
  }
  const response = await fetch(new URL(request.path, webOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new AcceptanceFailure('P0-RED-CATALOG-RPC-HTTP', `catalog/list failed over HTTP ${String(response.status)}`)
  }
  const parsed = parseCatalogListEnvelope(await response.json(), request.body.rpcId)
  receipt.observations.catalogSignatureObserved = true
  receipt.observations.catalogRevisionObserved = parsed.catalog.revision
  receipt.observations.catalogEntriesDigestObserved = parsed.catalog.entriesDigest
  receipt.observations.hostCapabilities = Object.fromEntries(
    REQUIRED_HOST_OWNERS.map(requirement => [requirement.key, parsed.capabilities[requirement.key]]),
  )
  await delay(250)
  const stateAfter = await mutableHostStateDigest(mutableRoots)
  receipt.observations.hostStateUnchangedDuringPreflight = stateBefore === stateAfter
  if (!receipt.observations.hostStateUnchangedDuringPreflight) {
    throw new AcceptanceFailure('P0-RED-HOST-STATE-MUTATED', 'read-only owner preflight changed mutable Host or Profile state')
  }
  if (receipt.observations.hostProxyRequests.length > 0) {
    throw new AcceptanceFailure('P0-RED-EXTERNAL-NETWORK', 'read-only owner preflight observed external Host traffic')
  }

  assertRequiredHostOwners(parsed.capabilities)
  receipt.status = 'passed'
} catch (error) {
  const code = error instanceof AcceptanceFailure ? error.code : 'P0-RED-HARNESS-FAILURE'
  receipt.status = OWNER_MISSING_FAILURE_CODES.has(code) ? 'failed' : 'invalid'
  receipt.failure = {
    code,
    message: sanitizeDiagnostic(error instanceof Error ? error.message : String(error)),
  }
  process.exitCode = 1
} finally {
  const finalizationFailures = []
  for (const [label, finalize] of [
    ['dsh-web-process', async () => { await stopChild(webChild) }],
    ['deny-proxy', async () => { await stopDenyProxy(proxy) }],
    ['web-log', async () => { await writeFile(join(evidenceRoot, 'web.log'), sanitizeDiagnostic(webOutput.value)) }],
    ['temporary-home', async () => { if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }) }],
  ]) {
    try {
      await finalize()
    } catch (finalizationError) {
      finalizationFailures.push(`${label}: ${sanitizeDiagnostic(finalizationError instanceof Error ? finalizationError.message : String(finalizationError))}`)
    }
  }
  if (receipt.observations.hostProxyRequests.length > 0) {
    finalizationFailures.push('read-only owner preflight observed external Host traffic')
  }
  if (finalizationFailures.length > 0) {
    receipt.status = 'invalid'
    receipt.failure = {
      code: 'P0-RED-TEARDOWN',
      message: `[P0-RED-TEARDOWN] ${finalizationFailures.join('; ')}`,
    }
    process.exitCode = 1
  }
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(join(evidenceRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}

if (receipt.status === 'passed') {
  process.stdout.write(`P0-R-001 Host owner preflight passed; complete P0 remains unproven; evidence: ${evidenceRoot}\n`)
} else {
  process.stderr.write(`${receipt.failure?.message ?? 'P0 Host owner preflight failed'}\n`)
  process.stderr.write(`status=${receipt.status}; evidence=${evidenceRoot}\n`)
}
