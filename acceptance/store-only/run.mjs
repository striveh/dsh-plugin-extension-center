import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import {
  AcceptanceFailure,
  EXTERNAL_NETWORK_OBSERVED,
  STORE_SHELL_MISSING,
  STORE_SURFACE_MISSING,
  TARGET_DSH_COMMIT,
  TARGET_DSH_VERSION,
  describeNetworkDestination,
  isAdmittedBrowserRequest,
  isAdmittedBrowserWebSocket,
  runChecked,
  sanitizeDiagnostic,
  stopChild,
  waitForReadyUrl,
} from './support.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = join(projectRoot, '.artifacts', 'acceptance', 'store-only')
const originalRedRoot = join(projectRoot, '.artifacts', 'acceptance', 'store-only-original-red')
const dshBin = join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const BLOCKED_CREDENTIAL_ENV_PATTERN = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET|TOKEN|ACCESS_KEY_ID|SECRET_ACCESS_KEY|APPLICATION_CREDENTIALS|PRIVATE_KEY|CREDENTIALS)$/u
const BASE_URL_ENV_PATTERN = /BASE_URL$/u
const SECRET_CANARY = 'STORE_RED_SECRET_CANARY_8d3fbb2f7a6e4c18'
const receipt = {
  schemaVersion: 3,
  acceptanceId: 'STORE-RED-01',
  proofScope: 'rc2-signed-offline-store-slice',
  p0Status: 'not-proven',
  target: {
    dshPackage: `@deepseek-ai/dsh@${TARGET_DSH_VERSION}`,
    auditedSourceCommit: TARGET_DSH_COMMIT,
  },
  status: 'running',
  expectedFirstRed: STORE_SURFACE_MISSING,
  originalRedEvidence: '.artifacts/acceptance/store-only-original-red',
  notProven: [
    'live-catalog-ingestion-refresh',
    'normalized-installed-inventory',
    'install-configure-update-uninstall-restore',
    'task-driven-acquisition',
    'provider-e2e',
  ],
  inputs: {
    blockedCredentialVariablePassed: null,
    providerEndpointOverridePassed: null,
    telemetryModeRequested: null,
    isolatedHomesCreatedEmpty: false,
    secretCanaryInjectedBeforeFiltering: true,
    secretCanaryPassedToChild: null,
  },
  observations: {
    bundleLayerObserved: false,
    clientGraphEntryObserved: false,
    clientBundleRequestObserved: false,
    onboardingActions: [],
    browserExternalRequests: [],
    browserExternalWebSockets: [],
    hostProxyRequests: [],
    consoleFailures: [],
    readOnlyRpcRequestsDuringInteraction: [],
    sameOriginMutationRequestsDuringInteraction: [],
    acquisitionIntentOrPlanObserved: false,
    webSocketFramesSentDuringInteraction: 0,
    firstLevelButtonSemanticsObserved: false,
    namedDialogObserved: false,
    tabRelationshipsObserved: false,
    keyboardNavigationObserved: false,
    focusReturnObserved: false,
    catalogSignatureObserved: false,
    catalogRevisionObserved: null,
    catalogEntriesDigestObserved: null,
    candidateRefsObserved: [],
    threeKindsObserved: false,
    searchFilterObserved: false,
    comparisonObserved: false,
    detailsDisclosureObserved: false,
    detailComparisonOpeningFocusObserved: false,
    detailComparisonFocusReturnObserved: false,
    disabledMutationActions: [],
    hostStateUnchangedDuringStoreInteraction: false,
    secretCanaryAbsentFromEvidence: false,
  },
}

let tempRoot
let webChild
let browser
let context
let page
let proxy
let webOutput = { value: '' }
let interactionTrafficActive = false

try {
  await preserveOriginalRedEvidence(evidenceRoot, originalRedRoot)
  await rm(evidenceRoot, { recursive: true, force: true })
  await mkdir(evidenceRoot, { recursive: true })
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-extension-store-red-'))
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

  const baseEnv = keylessEnvironment({
    ...process.env,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
    DSH_TELEMETRY_MODE: 'DISABLED',
    DEEPSEEK_API_KEY: SECRET_CANARY,
    DEEPSEEK_BASE_URL: `https://provider.invalid/${SECRET_CANARY}`,
  })
  receipt.inputs.blockedCredentialVariablePassed = Object.keys(baseEnv).some(key => BLOCKED_CREDENTIAL_ENV_PATTERN.test(key))
  receipt.inputs.providerEndpointOverridePassed = Object.keys(baseEnv).some(key => BASE_URL_ENV_PATTERN.test(key))
  receipt.inputs.telemetryModeRequested = baseEnv.DSH_TELEMETRY_MODE ?? null
  receipt.inputs.secretCanaryPassedToChild = Object.values(baseEnv).some(value => value?.includes(SECRET_CANARY))
  receipt.inputs.isolatedHomesCreatedEmpty = (await readdir(dshHome)).length === 0
    && (await readdir(agentsHome)).length === 0
  if (
    receipt.inputs.blockedCredentialVariablePassed
    || receipt.inputs.providerEndpointOverridePassed
    || receipt.inputs.secretCanaryPassedToChild
    || !receipt.inputs.isolatedHomesCreatedEmpty
    || receipt.inputs.telemetryModeRequested !== 'DISABLED'
  ) {
    throw new AcceptanceFailure('RED-B-KEYLESS-ENV', 'credential, endpoint, telemetry, canary, or isolated-home preconditions were not enforced')
  }
  const sourceManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  assertNoPackageLifecycleScripts(sourceManifest, 'source')
  proxy = await startDenyProxy(receipt.observations.hostProxyRequests)
  const runtimeEnv = denyProxyEnvironment(baseEnv, proxy.url)

  const version = await runChecked(dshBin, ['--version'], { cwd: workspace, env: runtimeEnv, timeoutMs: 30_000 })
  if (version.stdout.trim() !== TARGET_DSH_VERSION) {
    throw new AcceptanceFailure('RED-B-HOST-VERSION', `expected ${TARGET_DSH_VERSION}, got ${JSON.stringify(version.stdout.trim())}`)
  }

  await runChecked('pnpm', ['pack', '--pack-destination', packRoot], {
    cwd: projectRoot,
    env: runtimeEnv,
    timeoutMs: 60_000,
  })
  const archives = (await readdir(packRoot)).filter(file => file.endsWith('.tgz'))
  if (archives.length !== 1) {
    throw new AcceptanceFailure('RED-B-ARTIFACT', `expected one packed artifact, observed ${String(archives.length)}`)
  }
  const artifact = join(packRoot, archives[0])
  const artifactBytes = await readFile(artifact)
  receipt.artifact = {
    filename: basename(artifact),
    evidencePath: `packed/${basename(artifact)}`,
    bytes: (await stat(artifact)).size,
    sha256: createHash('sha256').update(artifactBytes).digest('hex'),
  }
  const packedManifestOutput = await runChecked('tar', ['-xOf', artifact, 'package/package.json'], {
    cwd: projectRoot,
    env: runtimeEnv,
    timeoutMs: 30_000,
  })
  const packedManifest = JSON.parse(packedManifestOutput.stdout)
  await writeFile(join(evidenceRoot, 'artifact-manifest.json'), `${JSON.stringify(packedManifest, null, 2)}\n`)
  assertNoPackageLifecycleScripts(packedManifest, 'packed')
  for (const requiredPath of ['.', './client', './package.json']) {
    if (packedManifest.exports?.[requiredPath] === undefined) {
      throw new AcceptanceFailure('RED-B-ARTIFACT-EXPORT', `packed artifact omitted the ${requiredPath} export`)
    }
  }
  if (packedManifest.dsh?.bundle?.patch !== './cordis.patch.yml' || packedManifest.dsh?.client?.platform !== 'web') {
    throw new AcceptanceFailure('RED-B-ARTIFACT-ROLES', 'packed artifact did not declare the exact Bundle patch and Web Client roles')
  }

  await runChecked(dshBin, ['plugin', '--profile', 'web', 'add', artifact, '--offline', '--ignore-scripts', '--save-exact'], {
    cwd: workspace,
    env: runtimeEnv,
    timeoutMs: 120_000,
  })
  const dump = await runChecked(dshBin, ['--profile', 'web', '--dump-config'], {
    cwd: workspace,
    env: runtimeEnv,
    timeoutMs: 60_000,
  })
  await writeFile(join(evidenceRoot, 'dump-config.txt'), sanitizeDiagnostic(dump.stdout))
  receipt.observations.bundleLayerObserved = dump.stdout.includes('# == dsh-plugin-extension-center')
    && dump.stdout.includes('name: dsh-plugin-extension-center')
  if (!receipt.observations.bundleLayerObserved) {
    throw new AcceptanceFailure('RED-B-BUNDLE-LAYER', 'the packed bundle did not appear in the composed Web profile')
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

  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({
    locale: 'en-US',
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 1000 },
  })
  await context.route('**/*', async route => {
    const request = route.request()
    const requestUrl = request.url()
    if (isAdmittedBrowserRequest(requestUrl, webOrigin)) {
      const url = new URL(requestUrl)
      if (interactionTrafficActive && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        const label = `${request.method()} ${url.pathname}`
        if (await isExactReadOnlyRpcRequest(request, url)) {
          receipt.observations.readOnlyRpcRequestsDuringInteraction.push(label)
        } else {
          receipt.observations.sameOriginMutationRequestsDuringInteraction.push(label)
          if (isAcquisitionOrPlanRequest(request, url)) {
            receipt.observations.acquisitionIntentOrPlanObserved = true
          }
        }
      }
      if (url.pathname === '/plugins/dsh-plugin-extension-center/client.js') {
        receipt.observations.clientBundleRequestObserved = true
      }
      await route.continue()
      return
    }
    receipt.observations.browserExternalRequests.push(describeNetworkDestination(requestUrl))
    await route.abort('blockedbyclient')
  })
  await context.routeWebSocket('**/*', async websocket => {
    const requestUrl = websocket.url()
    if (isAdmittedBrowserWebSocket(requestUrl, webOrigin)) {
      websocket.connectToServer()
      return
    }
    receipt.observations.browserExternalWebSockets.push(describeNetworkDestination(requestUrl))
    await websocket.close({ code: 1008, reason: 'external network denied by STORE-RED-01' })
  })
  page = await context.newPage()
  page.on('websocket', websocket => {
    websocket.on('framesent', () => {
      if (interactionTrafficActive) receipt.observations.webSocketFramesSentDuringInteraction += 1
    })
  })
  page.on('pageerror', error => receipt.observations.consoleFailures.push(sanitizeDiagnostic(`pageerror: ${error.message}`)))
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      receipt.observations.consoleFailures.push(sanitizeDiagnostic(`${message.type()}: ${message.text()}`))
    }
  })
  await page.goto(webOrigin, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForFunction(
    pluginId => globalThis.__DSH_BOOT__?.entries?.some(entry => entry.id === pluginId) === true,
    'dsh-plugin-extension-center',
    { timeout: 30_000 },
  )
  receipt.observations.clientGraphEntryObserved = true
  if (!receipt.observations.clientBundleRequestObserved) {
    throw new AcceptanceFailure('RED-B-CLIENT-BUNDLE-REQUEST', 'the real browser did not request the packed Extension Center client bundle')
  }
  await dismissHostOnboarding(page, receipt.observations.onboardingActions)
  await captureBrowserEvidence(page)

  assertCleanRuntimeObservations(receipt.observations)

  const extensions = page.locator('button[data-extension-center-entry="true"]')
  const extensionCount = await extensions.count()
  const semanticExtensionCount = await page.getByRole('button', { name: 'Extensions', exact: true }).count()
  if (
    extensionCount !== 1
    || semanticExtensionCount !== 1
    || !(await extensions.first().isVisible())
    || await extensions.first().getAttribute('aria-haspopup') !== 'dialog'
    || await extensions.first().getAttribute('aria-expanded') !== 'false'
  ) {
    throw new AcceptanceFailure(
      STORE_SURFACE_MISSING,
      `packed Client loaded, but the first-level Extensions button contract was not unique and closed (marker=${String(extensionCount)}, semantic=${String(semanticExtensionCount)})`,
    )
  }
  receipt.observations.firstLevelButtonSemanticsObserved = true
  const mutableStateBefore = await mutableHostStateDigest([dshHome, agentsHome, workspace])
  interactionTrafficActive = true
  await extensions.first().click()
  const shell = await assertStoreDefaultShell(page, receipt.observations)
  receipt.observations.namedDialogObserved = true
  receipt.observations.tabRelationshipsObserved = true

  await shell.tabs.get('Installed').click()
  await assertSelectedTab(shell.tabs, 'Installed')
  await shell.dialog.getByRole('tabpanel', { name: 'Installed', exact: true }).waitFor({ state: 'visible' })
  await shell.tabs.get('Installed').focus()
  await page.keyboard.press('ArrowRight')
  await assertSelectedTab(shell.tabs, 'Updates')
  if (!(await shell.tabs.get('Updates').evaluate(element => element === document.activeElement))) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'ArrowRight did not move focus to Updates')
  }
  await page.keyboard.press('End')
  await assertSelectedTab(shell.tabs, 'Activity & Recovery')
  await page.keyboard.press('Tab')
  const closeButton = shell.dialog.getByRole('button', { name: 'Close Extension Store', exact: true })
  if (!(await closeButton.evaluate(element => element === document.activeElement))) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'dialog focus did not wrap from the final tab to Close Extension Store')
  }
  await shell.tabs.get('Activity & Recovery').focus()
  await page.keyboard.press('Home')
  await assertSelectedTab(shell.tabs, 'Store')
  receipt.observations.keyboardNavigationObserved = true

  await page.keyboard.press('Escape')
  await shell.dialog.waitFor({ state: 'hidden', timeout: 5_000 })
  if (!(await extensions.first().evaluate(element => element === document.activeElement))) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'Escape did not return focus to the Extensions button')
  }
  if (await extensions.first().getAttribute('aria-expanded') !== 'false') {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'Extensions remained expanded after Escape')
  }
  receipt.observations.focusReturnObserved = true

  await extensions.first().click()
  const reopened = await assertStoreDefaultShell(page, receipt.observations)
  if (!(await reopened.tabs.get('Store').evaluate(element => element === document.activeElement))) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'reopened Extension Store did not focus the default Store tab')
  }
  await page.waitForTimeout(300)
  interactionTrafficActive = false
  const mutableStateAfter = await mutableHostStateDigest([dshHome, agentsHome, workspace])
  receipt.observations.hostStateUnchangedDuringStoreInteraction = mutableStateBefore === mutableStateAfter
  if (!receipt.observations.hostStateUnchangedDuringStoreInteraction) {
    throw new AcceptanceFailure('RED-B-HOST-STATE-MUTATED', 'opening and navigating the read-only Store changed mutable Host state')
  }
  if (receipt.observations.readOnlyRpcRequestsDuringInteraction.length === 0) {
    throw new AcceptanceFailure('RED-B-CATALOG-RPC', 'the packed Store did not read its catalog through the exact loopback RPC')
  }
  assertCleanRuntimeObservations(receipt.observations)
  await captureBrowserEvidence(page)
  receipt.status = 'passed'
} catch (error) {
  if (page !== undefined) {
    await page.waitForTimeout(300).catch(() => {})
    await captureBrowserEvidence(page).catch(() => {})
  }
  let reportedError = error
  try {
    assertCleanRuntimeObservations(receipt.observations)
  } catch (runtimeError) {
    reportedError = runtimeError
  }
  const code = reportedError instanceof AcceptanceFailure ? reportedError.code : 'RED-B-HARNESS-FAILURE'
  receipt.status = code === STORE_SURFACE_MISSING || code === STORE_SHELL_MISSING
    ? 'failed'
    : 'invalid'
  receipt.failure = {
    code,
    message: sanitizeDiagnostic(reportedError instanceof Error ? reportedError.message : String(reportedError)),
  }
  process.exitCode = 1
} finally {
  const finalizationFailures = []
  const finalizers = [
    ['browser-context', async () => { if (context !== undefined) await context.close() }],
    ['browser', async () => { if (browser !== undefined && browser.isConnected()) await browser.close() }],
    ['dsh-web-process', async () => { await stopChild(webChild) }],
    ['deny-proxy', async () => { await stopProxy(proxy) }],
    ['web-log', async () => { await writeFile(join(evidenceRoot, 'web.log'), sanitizeDiagnostic(webOutput.value)) }],
    ['temporary-home', async () => {
      if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true })
    }],
  ]
  for (const [label, finalize] of finalizers) {
    try {
      await withTimeout(finalize(), 15_000, label)
    } catch (finalizationError) {
      finalizationFailures.push(`${label}: ${sanitizeDiagnostic(finalizationError instanceof Error ? finalizationError.message : String(finalizationError))}`)
    }
  }
  let postShutdownFailure
  try {
    assertCleanRuntimeObservations(receipt.observations)
    await assertCanaryAbsentFromEvidence(evidenceRoot, SECRET_CANARY)
    receipt.observations.secretCanaryAbsentFromEvidence = true
  } catch (finalEvidenceError) {
    postShutdownFailure = finalEvidenceError
  }
  if (finalizationFailures.length > 0) {
    receipt.status = 'invalid'
    receipt.failure = {
      code: 'RED-B-TEARDOWN',
      message: `[RED-B-TEARDOWN] ${finalizationFailures.join('; ')}`,
    }
    process.exitCode = 1
  } else if (postShutdownFailure !== undefined) {
    const code = postShutdownFailure instanceof AcceptanceFailure
      ? postShutdownFailure.code
      : 'RED-B-FINAL-EVIDENCE'
    receipt.status = 'invalid'
    receipt.failure = {
      code,
      message: sanitizeDiagnostic(postShutdownFailure instanceof Error ? postShutdownFailure.message : String(postShutdownFailure)),
    }
    process.exitCode = 1
  }
  await writeFile(join(evidenceRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}

if (receipt.status === 'passed') {
  process.stdout.write(`STORE-RED-01 rc.2 signed offline Store slice passed; evidence: ${evidenceRoot}\n`)
} else {
  process.stderr.write(`${receipt.failure?.message ?? 'Store acceptance failed'}\n`)
  process.stderr.write(`status=${receipt.status}; evidence=${evidenceRoot}\n`)
}

/** Remove inherited provider credentials without changing the parent process. */
function keylessEnvironment(environment) {
  const result = { ...environment }
  for (const key of Object.keys(result)) {
    if (BLOCKED_CREDENTIAL_ENV_PATTERN.test(key) || BASE_URL_ENV_PATTERN.test(key)) delete result[key]
  }
  return result
}

/** Route proxy-aware non-loopback HTTP through the rejecting acceptance ledger. */
function denyProxyEnvironment(environment, proxyUrl) {
  const result = {
    ...environment,
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  }
  delete result.ALL_PROXY
  delete result.all_proxy
  return result
}

/** Start a loopback proxy that records and rejects every external attempt. */
async function startDenyProxy(ledger) {
  const server = createServer((request, response) => {
    ledger.push(`${request.method ?? 'UNKNOWN'} ${describeNetworkDestination(request.url ?? '')}`)
    response.writeHead(502, { 'content-type': 'text/plain' })
    response.end('external network denied by STORE-RED-01')
  })
  server.on('connect', (request, socket) => {
    ledger.push(`CONNECT ${describeNetworkDestination(request.url ?? '')}`)
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('deny proxy did not bind a TCP port')
  return { server, url: `http://127.0.0.1:${String(address.port)}` }
}

/** Stop the deny proxy. */
async function stopProxy(activeProxy) {
  if (activeProxy === undefined) return
  activeProxy.server.closeAllConnections()
  await new Promise((resolveClose, rejectClose) => {
    activeProxy.server.close(error => {
      if (error === undefined) resolveClose()
      else rejectClose(error)
    })
  })
}

/** Capture the reviewable browser state without treating a screenshot as acceptance. */
async function captureBrowserEvidence(activePage) {
  await Promise.all([
    activePage.screenshot({ path: join(evidenceRoot, 'browser.png'), fullPage: true }),
    activePage.locator('body').ariaSnapshot().then(snapshot => writeFile(join(evidenceRoot, 'browser.aria.txt'), sanitizeDiagnostic(snapshot))),
  ])
}

/** Complete rc.2's public keyless onboarding until both ordered dialogs stay closed. */
async function dismissHostOnboarding(activePage, actions) {
  const testingNotice = activePage.getByRole('dialog', { name: 'Internal Testing Notice', exact: true })
  const providerSetup = activePage.getByRole('dialog', { name: 'Add an API key to get started', exact: true })
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await testingNotice.isVisible()) {
      await testingNotice.getByRole('button', { name: 'Continue', exact: true }).click()
      actions.push('continue-internal-testing-notice')
      await testingNotice.waitFor({ state: 'hidden' })
    } else if (await providerSetup.isVisible()) {
      await providerSetup.getByRole('button', { name: 'Configure later', exact: true }).click()
      actions.push('configure-provider-later')
      await providerSetup.waitFor({ state: 'hidden' })
    }
    await activePage.waitForTimeout(300)
    if (!(await testingNotice.isVisible()) && !(await providerSetup.isVisible())) {
      await activePage.waitForTimeout(500)
      if (!(await testingNotice.isVisible()) && !(await providerSetup.isVisible())) return
    }
  }
  throw new AcceptanceFailure('RED-B-HOST-ONBOARDING', 'rc.2 keyless onboarding did not settle after public Continue and Configure later actions')
}

/** Fail closed when the Host or browser observed external activity or browser errors. */
function assertCleanRuntimeObservations(observations) {
  if (
    observations.hostProxyRequests.length > 0
    || observations.browserExternalRequests.length > 0
    || observations.browserExternalWebSockets.length > 0
    || observations.sameOriginMutationRequestsDuringInteraction.length > 0
    || observations.acquisitionIntentOrPlanObserved
    || observations.webSocketFramesSentDuringInteraction > 0
  ) {
    throw new AcceptanceFailure(
      EXTERNAL_NETWORK_OBSERVED,
      `offline read-only lane observed ${String(observations.hostProxyRequests.length)} Host proxy requests, ${String(observations.browserExternalRequests.length)} external browser requests, ${String(observations.browserExternalWebSockets.length)} external browser WebSockets, ${String(observations.sameOriginMutationRequestsDuringInteraction.length)} same-origin mutation requests, acquisition intent or plan=${String(observations.acquisitionIntentOrPlanObserved)}, and ${String(observations.webSocketFramesSentDuringInteraction)} interaction WebSocket frames`,
    )
  }
  if (observations.consoleFailures.length > 0) {
    throw new AcceptanceFailure('RED-B-BROWSER-CONSOLE', observations.consoleFailures.join('\n'))
  }
}

/** Admit only exact read-only RPC envelopes used by the Store on the fixed rc.2 lane. */
function isExactReadOnlyRpcRequest(request, url) {
  if (
    request.method() !== 'POST'
    || url.search !== ''
    || url.hash !== ''
    || request.headers()['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) return false
  let body
  try {
    body = request.postDataJSON()
  } catch {
    return false
  }
  if (!hasExactKeys(body, ['method', 'payload', 'rpcId', 'type'])) return false
  if (body.type !== 'client-request'
    || typeof body.method !== 'string'
    || url.pathname !== `/dsh-extension-center/${body.method}`
    || typeof body.rpcId !== 'string'
    || body.rpcId.length === 0) {
    return false
  }
  if (body.method === 'catalog/list') {
    return hasExactKeys(body.payload, ['protocolVersion']) && body.payload.protocolVersion === 1
  }
  if (['operation/list', 'operation/receipts', 'approval/list', 'task-attempt/list'].includes(body.method)) {
    return hasExactKeys(body.payload, ['protocolVersion']) && body.payload.protocolVersion === 1
  }
  if (body.method === 'inventory/list') {
    return hasExactKeys(body.payload, ['profileId', 'protocolVersion', 'scopeKey'])
      && body.payload.protocolVersion === 1
      && body.payload.profileId === 'web'
      && body.payload.scopeKey === 'profile:web'
  }
  if (body.method === 'configuration/options') {
    return hasExactKeys(body.payload, ['candidateRef', 'profileId', 'protocolVersion', 'scopeKey', 'targetKey'])
      && body.payload.protocolVersion === 1
      && body.payload.candidateRef === 'mcp:io.github.domdomegg/filesystem-mcp@1.3.0'
      && body.payload.profileId === 'web'
      && body.payload.scopeKey === 'profile:web'
      && body.payload.targetKey === null
  }
  return false
}

/** Identify forbidden acquisition or lifecycle intent on either route or RPC method. */
function isAcquisitionOrPlanRequest(request, url) {
  const pattern = /(?:^|\/)(?:acquire|acquisition|intent|plans?|confirm|install|configure|update|uninstall|restore)(?:\/|$)/u
  if (pattern.test(url.pathname)) return true
  try {
    const body = request.postDataJSON()
    return typeof body?.method === 'string' && pattern.test(body.method)
  } catch {
    return false
  }
}

/** Return whether an untrusted JSON value has exactly the admitted own keys. */
function hasExactKeys(value, expected) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

/** Settle an asynchronous finalizer within a fixed evidence-writing deadline. */
async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    await Promise.race([
      promise,
      new Promise((resolveTimeout, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error(`${label} cleanup timed out`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Require the signed Store journey and truthful rc.2 capability states. */
async function assertStoreDefaultShell(activePage, observations) {
  const dialog = activePage.getByRole('dialog', { name: 'Extension Store', exact: true })
  await waitForVisibleOrProductFailure(dialog, 'Extensions did not open one visible Extension Store dialog')
  if (await dialog.count() !== 1) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'Extensions opened a non-unique Extension Store dialog')
  }
  const heading = dialog.getByRole('heading', { name: 'Extension Store', exact: true })
  await waitForVisibleOrProductFailure(heading, 'Extension Store dialog did not expose its visible heading')
  const tablist = dialog.getByRole('tablist', { name: 'Extension Center views', exact: true })
  await waitForVisibleOrProductFailure(tablist, 'Extension Store did not expose one named tablist')
  if (await tablist.count() !== 1) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'Extension Store exposed a non-unique tablist')
  }
  const tabs = new Map()
  for (const label of ['Store', 'Installed', 'Updates', 'Activity & Recovery']) {
    const tab = tablist.getByRole('tab', { name: label, exact: true })
    await waitForVisibleOrProductFailure(tab, `Extension Store did not expose the ${label} tab`)
    if (await tab.count() !== 1) {
      throw new AcceptanceFailure(STORE_SHELL_MISSING, `Extension Store exposed a non-unique ${label} tab`)
    }
    const tabId = await tab.getAttribute('id')
    const panelId = await tab.getAttribute('aria-controls')
    if (tabId === null || panelId === null) {
      throw new AcceptanceFailure(STORE_SHELL_MISSING, `${label} did not identify and control one tabpanel`)
    }
    const panel = dialog.locator(`[id=${JSON.stringify(panelId)}]`)
    if (await panel.count() !== 1 || await panel.getAttribute('role') !== 'tabpanel') {
      throw new AcceptanceFailure(STORE_SHELL_MISSING, `${label} did not control one dialog-local tabpanel`)
    }
    if (await panel.getAttribute('aria-labelledby') !== tabId) {
      throw new AcceptanceFailure(STORE_SHELL_MISSING, `${label} tabpanel did not point back to its tab`)
    }
    tabs.set(label, tab)
  }
  await assertSelectedTab(tabs, 'Store')
  const visiblePanels = dialog.getByRole('tabpanel')
  if (await visiblePanels.count() !== 1 || await visiblePanels.getAttribute('aria-labelledby') !== await tabs.get('Store').getAttribute('id')) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'Extension Store did not expose only the Store panel by default')
  }
  const storePanel = dialog.getByRole('tabpanel', { name: 'Store', exact: true })
  await waitForVisibleOrProductFailure(storePanel, 'Store default panel was not visible')
  await waitForVisibleOrProductFailure(dialog.getByText('Read-only catalog preview', { exact: true }), 'read-only catalog preview status was not visible')
  await waitForVisibleOrProductFailure(storePanel.getByText('Signed catalog verified', { exact: true }), 'signed catalog status was not visible')
  const catalogStatus = storePanel.locator('[data-catalog-signature="verified"]')
  const revision = await catalogStatus.getAttribute('data-catalog-revision')
  const digest = await catalogStatus.locator('[data-catalog-digest]').getAttribute('data-catalog-digest')
  if (revision !== '6' || digest === null || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'signed catalog did not expose its exact revision and entries digest')
  }
  observations.catalogSignatureObserved = true
  observations.catalogRevisionObserved = Number(revision)
  observations.catalogEntriesDigestObserved = digest
  if (!(await tabs.get('Store').evaluate(element => element === document.activeElement))) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'opening Extension Store did not focus the Store tab')
  }

  const candidateNames = ['DSH Capability Resolver', 'Filesystem MCP', 'Documentation Writer']
  for (const name of candidateNames) {
    await waitForVisibleOrProductFailure(storePanel.getByRole('heading', { name, exact: true }), `${name} was missing from the signed catalog`)
  }
  for (const kind of ['plugin', 'mcp', 'skill']) {
    if (await storePanel.locator(`[data-kind=${JSON.stringify(kind)}]`).count() !== 1) {
      throw new AcceptanceFailure(STORE_SHELL_MISSING, `signed catalog did not expose exactly one ${kind} candidate`)
    }
  }
  observations.candidateRefsObserved = await storePanel.locator('[data-candidate-ref]').evaluateAll(elements =>
    elements.map(element => element.getAttribute('data-candidate-ref')).filter(value => value !== null),
  )
  if (new Set(observations.candidateRefsObserved).size !== 3) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'signed catalog did not expose three unique candidate references')
  }
  observations.threeKindsObserved = true

  const search = storePanel.getByRole('searchbox', { name: 'Search extensions', exact: true })
  await search.fill('documentation')
  await storePanel.getByRole('heading', { name: 'Filesystem MCP', exact: true }).waitFor({ state: 'detached' })
  await waitForVisibleOrProductFailure(storePanel.getByRole('heading', { name: 'Documentation Writer', exact: true }), 'local search did not retain Documentation Writer')
  await search.fill('')
  const typeFilter = storePanel.getByRole('combobox', { name: 'Type', exact: true })
  await typeFilter.selectOption('mcp')
  await storePanel.getByRole('heading', { name: 'Documentation Writer', exact: true }).waitFor({ state: 'detached' })
  await waitForVisibleOrProductFailure(storePanel.getByRole('heading', { name: 'Filesystem MCP', exact: true }), 'type filter did not retain Filesystem MCP')
  await typeFilter.selectOption('all')
  await waitForVisibleOrProductFailure(storePanel.getByRole('heading', { name: 'Documentation Writer', exact: true }), 'resetting type filter did not restore the catalog')
  const scopeFilter = storePanel.getByRole('combobox', { name: 'Scope', exact: true })
  await scopeFilter.selectOption('project')
  await storePanel.getByRole('heading', { name: 'Filesystem MCP', exact: true }).waitFor({ state: 'detached' })
  await waitForVisibleOrProductFailure(storePanel.getByRole('heading', { name: 'Documentation Writer', exact: true }), 'scope filter did not retain Documentation Writer')
  await scopeFilter.selectOption('all')
  await waitForVisibleOrProductFailure(storePanel.getByRole('heading', { name: 'Filesystem MCP', exact: true }), 'resetting scope filter did not restore the catalog')
  const configurationFilter = storePanel.getByRole('combobox', { name: 'Configuration', exact: true })
  await configurationFilter.selectOption('required')
  await storePanel.getByRole('heading', { name: 'DSH Capability Resolver', exact: true }).waitFor({ state: 'detached' })
  await waitForVisibleOrProductFailure(storePanel.getByRole('heading', { name: 'Filesystem MCP', exact: true }), 'configuration filter did not retain Filesystem MCP')
  await configurationFilter.selectOption('all')
  const authorityFilter = storePanel.getByRole('combobox', { name: 'Authority', exact: true })
  await authorityFilter.selectOption('model-context')
  await storePanel.getByRole('heading', { name: 'Filesystem MCP', exact: true }).waitFor({ state: 'detached' })
  await waitForVisibleOrProductFailure(storePanel.getByRole('heading', { name: 'DSH Capability Resolver', exact: true }), 'authority filter did not retain DSH Capability Resolver')
  await authorityFilter.selectOption('all')
  const lifecycleFilter = storePanel.getByRole('combobox', { name: 'Lifecycle', exact: true })
  await lifecycleFilter.selectOption('complete')
  await waitForVisibleOrProductFailure(storePanel.getByRole('heading', { name: 'No admitted candidate matches', exact: true }), 'complete-lifecycle filter did not fail closed on rc.2')
  await lifecycleFilter.selectOption('blocked')
  for (const name of candidateNames) {
    await waitForVisibleOrProductFailure(storePanel.getByRole('heading', { name, exact: true }), `blocked-lifecycle filter did not restore ${name}`)
  }
  await lifecycleFilter.selectOption('all')
  observations.searchFilterObserved = true

  for (let index = 0; index < 3; index += 1) {
    await storePanel.getByRole('button', { name: 'Add to compare', exact: true }).first().click()
  }
  const comparisonTrigger = storePanel.getByRole('button', { name: 'Compare selected (3/3)', exact: true })
  await comparisonTrigger.click()
  const comparisonHeading = storePanel.getByRole('heading', { name: 'Candidate comparison', exact: true })
  await waitForVisibleOrProductFailure(comparisonHeading, 'three-candidate comparison did not open')
  const comparison = comparisonHeading.locator('xpath=ancestor::section[1]')
  if (!(await comparison.evaluate(element => element === document.activeElement))) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'opening comparison did not focus the newly revealed comparison region')
  }
  if (!(await comparisonHeading.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return rect.top >= 0 && rect.top < window.innerHeight
  }))) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'opening comparison did not bring its heading into the viewport')
  }
  for (const name of candidateNames) {
    await waitForVisibleOrProductFailure(comparison.getByRole('columnheader', { name, exact: true }), `${name} was missing from comparison`)
  }
  for (const field of [
    'Publisher', 'Catalog admission channel', 'Admitted source', 'Artifact', 'License', 'Integrity', 'Components',
    'Compatibility evidence', 'Dependencies', 'Target scopes', 'Configuration', 'Acquisition authority',
    'Runtime authority', 'Conflicts', 'Activation / restart', 'Install availability', 'Configure availability',
    'Update availability', 'Uninstall availability', 'Restore availability', 'Verification evidence',
    'Retained data and rollback limit',
  ]) {
    await waitForVisibleOrProductFailure(comparison.getByRole('rowheader', { name: field, exact: true }), `${field} was missing from comparison`)
  }
  await assertComparisonRowContains(comparison, 'Admitted source', [
    ['Pinned GitHub content', 'github-content', 'github.com/github/awesome-copilot', '2026-08-25T07:00:00.000Z'],
    ['GitHub Release v0.1.0', 'github-release', 'github.com/striveh/dsh-capability-resolver', '2026-08-25T07:00:00.000Z'],
    ['Official MCP Registry metadata', 'mcp-registry', 'github.com/domdomegg/filesystem-mcp', '2026-08-25T07:00:00.000Z'],
  ])
  await assertComparisonRowContains(comparison, 'Publisher', [['github/awesome-copilot'], ['striveh'], ['domdomegg']])
  await assertComparisonRowContains(comparison, 'Catalog admission channel', [
    ['Community catalog admission'], ['Community catalog admission'], ['Upstream registry admission'],
  ])
  await assertComparisonRowContains(comparison, 'Artifact', [
    ['skills/documentation-writer/SKILL.md', '2748 bytes', 'raw.githubusercontent.com/github/awesome-copilot'],
    ['dsh-capability-resolver@0.1.0', '92128 bytes', 'releases/download/v0.1.0'],
    ['filesystem-mcp@1.3.0', '7223 bytes', 'registry.npmjs.org/filesystem-mcp'],
  ])
  await assertComparisonRowContains(comparison, 'License', [
    ['MIT', 'Verified at pinned revision'],
    ['MIT', 'Verified at pinned revision'],
    ['MIT', 'Publisher-declared'],
  ])
  await assertComparisonRowContains(comparison, 'Integrity', [
    ['sha256:7e8244988c9f4eb63bf8c0edf160578544621eb96e5e51e2d848f1401c5de8f1'],
    ['sha256:895e1e44ee9edaff0c4982c671379bbc3122e2c0189250e9870ee70102f2c27e'],
    ['sha512:xL84LD46WmZUGGWdU2Rf6i/oDtMMdwiJ3k3I5bkku51khl7cS88SLKfkUFNa9478GtHjT46wTqTyly7aoNmneQ=='],
  ])
  await assertComparisonRowContains(comparison, 'Dependencies', [
    ['Host dependency', '@deepseek-ai/dsh 0.1.1-rc.2', 'Required'],
    ['Host dependency', '@deepseek-ai/dsh 0.1.1-rc.2', 'Required'],
    ['Host dependency', 'Runtime dependency', 'node >=18', 'Required'],
  ])
  await assertComparisonRowContains(comparison, 'Compatibility evidence', [
    ['Compatible with rc.2', 'DSH 0.1.1-rc.2', 'darwin/linux/windows', 'one bounded SKILL.md'],
    ['Compatible with rc.2', 'DSH 0.1.1-rc.2', 'darwin/linux/windows', 'release declares and tests the exact DSH'],
    ['Compatible with rc.2', 'DSH 0.1.1-rc.2', 'darwin/linux/windows', 'exposes stdio'],
  ])
  await assertComparisonRowContains(comparison, 'Target scopes', [
    ['User', 'Project'], ['Web Profile'], ['Web Profile'],
  ])
  await assertComparisonRowContains(comparison, 'Configuration', [
    ['No initial configuration', 'Credentials: None', 'Not declared'],
    ['No initial configuration', 'Credentials: None', 'Fresh catalog cache lifetime', 'Maximum matched terms'],
    ['Configuration required', 'Credentials: None', 'Allowed filesystem roots'],
  ])
  await assertComparisonRowContains(comparison, 'Acquisition authority', [
    ['Network (read)', 'one exact content-addressed SKILL.md'],
    ['Network (send)', 'integrity-pinned asset', 'Filesystem (write)', 'Real Loader validation', 'Subprocess (execute)', 'Credentials (read)'],
    ['None'],
  ])
  await assertComparisonRowContains(comparison, 'Runtime authority', [
    ['Model context (send)', 'instructions enter model context'],
    ['Network (send)', 'Filesystem (write)', 'Subprocess (execute)', 'Credentials (read)', 'Model context (send)'],
    ['Filesystem (write)', 'Subprocess (execute)', 'roots selected during configuration'],
  ])
  await assertComparisonRowContains(comparison, 'Conflicts', [
    ['same name and different content'],
    ['None declared'],
    ['server name must not collide'],
  ])
  await assertComparisonRowContains(comparison, 'Activation / restart', [
    ['No restart declared', 'future owner must prove the merged Skill winner'],
    ['External restart required', 'Profile Bundle membership changes'],
    ['No restart declared', 'dynamic MCP owner applies and verifies the connection'],
  ])
  for (const field of [
    'Install availability', 'Configure availability', 'Update availability', 'Uninstall availability', 'Restore availability',
  ]) {
    await assertComparisonRowContains(comparison, field, [
      ['Unavailable', 'unavailable(host-capability)'],
      ['Unavailable', 'unavailable(host-capability)'],
      ['Unavailable', 'unavailable(host-capability)'],
    ])
  }
  await assertComparisonRowContains(comparison, 'Verification evidence', [
    ['Pinned content digest and file set', 'Verified', 'Target Agent visibility', 'Unknown'],
    ['Release artifact integrity', 'Verified', 'Runtime task result', 'Unknown'],
    ['Registry and npm coordinates', 'Verified', 'MCP handshake and tool generation', 'Unknown'],
  ])
  await assertComparisonRowContains(comparison, 'Retained data and rollback limit', [
    ['retain the pinned Skill file until uninstall or purge'],
    ['in-memory last-good catalog cache', 'no installation database'],
    ['external runtime remains Host-owned', 'file changes inside configured roots are not undone'],
  ])
  await activePage.screenshot({ path: join(evidenceRoot, 'browser-comparison.png'), fullPage: true })
  await comparison.getByRole('button', { name: 'Close comparison', exact: true }).click()
  if (!(await comparisonTrigger.evaluate(element => element === document.activeElement))) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'closing comparison did not return focus to its trigger')
  }
  observations.comparisonObserved = true

  const filesystemCard = storePanel.getByRole('heading', { name: 'Filesystem MCP', exact: true }).locator('xpath=ancestor::article[1]')
  const detailTrigger = filesystemCard.getByRole('button', { name: 'View details', exact: true })
  await detailTrigger.click()
  const detailHeading = storePanel.getByRole('heading', { level: 3, name: 'Filesystem MCP', exact: true })
  await waitForVisibleOrProductFailure(detailHeading, 'Filesystem MCP details did not open')
  const details = detailHeading.locator('xpath=ancestor::section[1]')
  if (!(await details.evaluate(element => element === document.activeElement))) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'opening details did not focus the newly revealed detail region')
  }
  if (!(await detailHeading.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return rect.top >= 0 && rect.top < window.innerHeight
  }))) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'opening details did not bring its heading into the viewport')
  }
  await waitForVisibleOrProductFailure(
    details.getByText('sha512:xL84LD46WmZUGGWdU2Rf6i/oDtMMdwiJ3k3I5bkku51khl7cS88SLKfkUFNa9478GtHjT46wTqTyly7aoNmneQ==', { exact: true }),
    'Filesystem MCP details did not disclose exact artifact integrity',
  )
  await waitForVisibleOrProductFailure(details.getByRole('link', { name: 'MIT · Publisher-declared', exact: true }), 'Filesystem MCP details did not disclose license evidence')
  await waitForVisibleOrProductFailure(details.getByText('Allowed filesystem roots', { exact: false }), 'Filesystem MCP details did not disclose configuration')
  await waitForVisibleOrProductFailure(details.getByText('The dynamic MCP owner applies and verifies the connection in the current Host.', { exact: true }), 'Filesystem MCP details did not disclose activation behavior')
  for (const label of ['Install', 'Configure', 'Update', 'Uninstall', 'Restore']) {
    await waitForVisibleOrProductFailure(
      details.getByText(`${label} availability · Unavailable · unavailable(host-capability)`, { exact: true }),
      `Filesystem MCP details did not disclose ${label.toLowerCase()} status and reason`,
    )
  }
  await activePage.screenshot({ path: join(evidenceRoot, 'browser-details.png'), fullPage: true })
  await details.getByRole('button', { name: 'Close details', exact: true }).click()
  if (!(await detailTrigger.evaluate(element => element === document.activeElement))) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'closing details did not return focus to its originating card')
  }
  observations.detailsDisclosureObserved = true
  observations.detailComparisonOpeningFocusObserved = true
  observations.detailComparisonFocusReturnObserved = true

  const acquisitionActions = storePanel.getByRole('button', { name: 'Acquire unavailable', exact: true })
  if (await acquisitionActions.count() !== 3) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, 'the three candidates did not expose disabled acquisition actions')
  }
  for (const action of await acquisitionActions.all()) {
    if (!(await action.isDisabled()) || await action.getAttribute('title') !== 'unavailable(host-capability)') {
      throw new AcceptanceFailure(STORE_SHELL_MISSING, 'a candidate acquisition action was enabled or omitted its Host capability reason')
    }
  }
  await waitForVisibleOrProductFailure(storePanel.getByText('unavailable(host-capability)', { exact: true }), 'Host capability failure code was not visible')
  observations.disabledMutationActions = []
  for (const label of ['Install', 'Configure', 'Update', 'Uninstall', 'Restore']) {
    const action = storePanel.getByRole('button', { name: label, exact: true })
    if (await action.count() !== 1 || !(await action.isDisabled())) {
      throw new AcceptanceFailure(STORE_SHELL_MISSING, `${label} was missing or enabled on the read-only rc.2 Host`)
    }
    if (await action.getAttribute('title') !== 'unavailable(host-capability)') {
      throw new AcceptanceFailure(STORE_SHELL_MISSING, `${label} did not expose its Host capability reason`)
    }
    observations.disabledMutationActions.push(label)
  }
  await storePanel.evaluate(element => { element.scrollTop = 0 })
  await tabs.get('Store').focus()
  return { dialog, tabs }
}

/** Require exactly one selected tab in the four-view set. */
async function assertSelectedTab(tabs, selected) {
  for (const [label, tab] of tabs) {
    const expected = label === selected ? 'true' : 'false'
    if (await tab.getAttribute('aria-selected') !== expected) {
      throw new AcceptanceFailure(STORE_SHELL_MISSING, `${selected} selection left ${label} aria-selected in the wrong state`)
    }
  }
}

/** Require one comparison row to retain every decision-critical substring in candidate-column order. */
async function assertComparisonRowContains(comparison, label, expectedByCandidate) {
  const rowHeader = comparison.getByRole('rowheader', { name: label, exact: true })
  const row = rowHeader.locator('xpath=ancestor::tr[1]')
  const cells = row.getByRole('cell')
  if (await cells.count() !== expectedByCandidate.length) {
    throw new AcceptanceFailure(STORE_SHELL_MISSING, `${label} comparison row had the wrong candidate count`)
  }
  for (const [index, expectedParts] of expectedByCandidate.entries()) {
    const value = await cells.nth(index).innerText()
    for (const expected of expectedParts) {
      if (!value.includes(expected)) {
        throw new AcceptanceFailure(STORE_SHELL_MISSING, `${label} candidate ${String(index + 1)} omitted ${JSON.stringify(expected)}`)
      }
    }
  }
}

/** Convert only a genuine locator timeout into the stable product-shell failure. */
async function waitForVisibleOrProductFailure(locator, message) {
  try {
    await locator.waitFor({ state: 'visible', timeout: 5_000 })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new AcceptanceFailure(STORE_SHELL_MISSING, message)
    }
    throw error
  }
}

/** Preserve the first expected-red artifact set once, before current evidence is refreshed. */
async function preserveOriginalRedEvidence(current, baseline) {
  if (await pathExists(baseline) || !(await pathExists(join(current, 'receipt.json')))) return
  const previous = JSON.parse(await readFile(join(current, 'receipt.json'), 'utf8'))
  if (previous.status !== 'expected-red' || previous.failure?.code !== STORE_SURFACE_MISSING) return
  await cp(current, baseline, { recursive: true, errorOnExist: true })
}

/** Return whether a path exists without widening any caller failure. */
async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/** Hash mutable Host and Profile state while excluding the immutable dependency tree. */
async function mutableHostStateDigest(roots) {
  const hash = createHash('sha256')
  for (const [index, root] of roots.entries()) {
    hash.update(`root:${String(index)}\0`)
    await hashMutableTree(root, root, hash)
  }
  return hash.digest('hex')
}

/** Feed one deterministic filesystem tree into a digest. */
async function hashMutableTree(root, path, hash) {
  const info = await lstat(path)
  const name = relative(root, path).replaceAll('\\', '/') || '.'
  if (info.isSymbolicLink()) {
    hash.update(`link:${name}:${await readlink(path)}\0`)
    return
  }
  if (info.isFile()) {
    hash.update(`file:${name}:${String(info.mode)}:${String(info.size)}\0`)
    hash.update(await readFile(path))
    return
  }
  if (!info.isDirectory()) {
    hash.update(`other:${name}:${String(info.mode)}\0`)
    return
  }
  hash.update(`dir:${name}:${String(info.mode)}\0`)
  const entries = (await readdir(path, { withFileTypes: true }))
    .filter(entry => entry.name !== 'node_modules')
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) await hashMutableTree(root, join(path, entry.name), hash)
}

/** Prove the fixed input canary is absent from every persisted evidence byte. */
async function assertCanaryAbsentFromEvidence(directory, canary) {
  const canaryBytes = Buffer.from(canary)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await assertCanaryAbsentFromEvidence(path, canary)
      continue
    }
    if ((await readFile(path)).includes(canaryBytes)) {
      throw new AcceptanceFailure('RED-B-SECRET-EVIDENCE', `secret canary reached persisted evidence file ${entry.name}`)
    }
  }
}

/** Reject package-manager lifecycle code before packing and again from the tarball. */
function assertNoPackageLifecycleScripts(manifest, phase) {
  const lifecycleScripts = Object.keys(manifest.scripts ?? {}).filter(script => (
    /^(?:pre|post)?(?:install|uninstall)$/u.test(script)
    || ['prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack'].includes(script)
  ))
  if (lifecycleScripts.length > 0) {
    throw new AcceptanceFailure(
      'RED-B-ARTIFACT-LIFECYCLE',
      `${phase} manifest declared lifecycle scripts: ${lifecycleScripts.join(', ')}`,
    )
  }
}
