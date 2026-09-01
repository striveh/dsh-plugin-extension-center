import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import {
  immutablePackageTreeDigest,
  isAdmittedBrowserRequest,
  isAdmittedBrowserWebSocket,
  sanitizeDiagnostic,
  stopChild,
  waitForReadyUrl,
} from '../store-only/support.mjs'
import { parseCatalogListEnvelope } from '../full-p0/support.mjs'
import {
  canonicalSha256,
  verifyImmutablePlanDigest,
  verifyOperationReceiptJournal,
  verifyTerminalReceiptPlanBinding,
} from '../full-p0/receipt-binding.mjs'
import {
  NPM_REGISTRY,
  PNPM_VERSION,
  OrdinaryUserInputError,
  OrdinaryUserLaneFailure,
  WIKI_SKILL_V1,
  assertExpectedCenterTarget,
  compareExactVersions,
  createOrdinaryUserReceipt,
  markFailed,
  markManagementPending,
  markPassed,
  markPending,
  markUpdatePending,
  parseOrdinaryUserArguments,
  selectAlphaWikiPair,
  writeOrdinaryUserReceipt,
} from './support.mjs'

const PROFILE_ID = 'web'
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024
const BLOCKED_ENVIRONMENT_KEY = /(?:^|_)(?:ACCESS_KEY|API_KEY|AUTH|COOKIE|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/iu
const SKILL_CONFIGURATION_INITIAL = Object.freeze({ modelInvocable: true, userInvocable: true, projectRoot: null })
const SKILL_CONFIGURATION_CONFIGURED = Object.freeze({ modelInvocable: true, userInvocable: false, projectRoot: null })
const READ_ONLY_MANAGEMENT_METHODS = new Set([
  'catalog/list',
  'configuration/options',
  'inventory/list',
  'inventory/verify',
  'operation/get',
])

/**
 * Run the independent ordinary-user acceptance lane.
 * @param {ReturnType<typeof parseOrdinaryUserArguments>} config Validated lane configuration.
 * @returns {Promise<{exitCode: 0 | 1 | 2, receipt: Record<string, unknown>} >} Receipt and process status.
 */
export async function runOrdinaryUserAcceptance(config) {
  const receipt = createOrdinaryUserReceipt(config)
  let stage = 'registry-preflight'
  let temporaryRoot
  let webChild
  let browserSession
  let officialPackageRoot
  let officialTreeBefore
  let managementPendingSubject
  try {
    stage = 'toolchain-preflight'
    const pnpmVersion = await runRequired(
      'pnpm',
      ['--version'],
      { cwd: process.cwd(), env: isolatedEnvironment({}), timeoutMs: 30_000 },
      'ORDINARY-USER-PNPM',
      stage,
    )
    if (pnpmVersion.stdout.trim() !== PNPM_VERSION) {
      throw new OrdinaryUserLaneFailure(
        'ORDINARY-USER-PNPM',
        stage,
        'pnpm command version does not match the official DSH Plugin CLI prerequisite',
      )
    }
    receipt.observations.cli.pnpmVersionMatched = true
    stage = 'registry-preflight'
    if (config.launcher.kind !== 'development-source') {
      const dshRegistry = await inspectRegistryPackage(`${config.dshPackage}@${config.dshVersion}`)
      if (dshRegistry === null) {
        markPending(receipt, 'official DSH')
        return await finish(config, receipt, 2)
      }
      receipt.observations.registry.dsh = dshRegistry
    } else {
      receipt.observations.registry.dsh = {
        status: 'development-source',
        version: config.dshVersion,
        integrity: null,
      }
    }

    const centerInitialRegistry = await inspectCenterSource(config.center.initial)
    if (centerInitialRegistry === null) {
      markPending(receipt, 'initial Extension Center')
      return await finish(config, receipt, 2)
    }
    receipt.observations.registry.centerInitial = centerInitialRegistry
    const centerTargetRegistry = await inspectCenterSource(config.center.target)
    if (centerTargetRegistry === null) {
      markPending(receipt, 'target Extension Center')
      return await finish(config, receipt, 2)
    }
    receipt.observations.registry.centerTarget = centerTargetRegistry
    assertExpectedCenterTarget(config, centerTargetRegistry)
    if (!updateAdvances(config, centerInitialRegistry, centerTargetRegistry)) {
      markUpdatePending(receipt)
      return await finish(config, receipt, 2)
    }

    temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ordinary-user-')))
    const dshHome = join(temporaryRoot, 'dsh-home')
    const agentsHome = join(temporaryRoot, 'agents-home')
    const workspace = join(temporaryRoot, 'workspace')
    const npmConfig = join(temporaryRoot, 'npmrc')
    await Promise.all([
      mkdir(dshHome, { mode: 0o700 }),
      mkdir(agentsHome, { mode: 0o700 }),
      mkdir(workspace, { mode: 0o700 }),
      writeFile(npmConfig, `registry=${NPM_REGISTRY}\nignore-scripts=true\n`, { flag: 'wx', mode: 0o600 }),
    ])
    const environment = isolatedEnvironment({ dshHome, agentsHome, npmConfig })

    stage = 'dsh-launcher'
    const launcher = await resolveLauncher(config, temporaryRoot, workspace, environment)
    officialPackageRoot = launcher.officialPackageRoot
    if (officialPackageRoot !== undefined) {
      officialTreeBefore = await immutablePackageTreeDigest(officialPackageRoot)
    }
    const runDsh = async (arguments_, code, commandStage, timeoutMs = 180_000) => await runRequired(
      launcher.command,
      [...launcher.arguments, ...arguments_],
      { cwd: workspace, env: environment, timeoutMs },
      code,
      commandStage,
    )
    const version = await runDsh(['--version'], 'ORDINARY-USER-DSH-VERSION', 'dsh-version', 30_000)
    if (version.stdout.trim() !== config.dshVersion) {
      throw new OrdinaryUserLaneFailure(
        'ORDINARY-USER-DSH-VERSION',
        'dsh-version',
        'DSH command version does not match the requested official version',
      )
    }
    receipt.observations.cli.versionMatched = true

    stage = 'profile-add'
    await runDsh(
      ['plugin', '--profile', PROFILE_ID, 'add', config.center.initial.spec, '--ignore-scripts', '--save-exact'],
      'ORDINARY-USER-ADD',
      stage,
    )
    receipt.observations.cli.initialAddPassed = true
    const profileRoot = join(dshHome, 'profiles', PROFILE_ID)
    await inspectInstalledProfile(
      profileRoot,
      config.center.initial,
      centerInitialRegistry,
      receipt,
      'initial',
    )

    stage = 'profile-list'
    const list = await runDsh(
      ['plugin', '--profile', PROFILE_ID, 'list', '--depth', '0'],
      'ORDINARY-USER-LIST',
      stage,
      60_000,
    )
    if (!list.stdout.includes(config.center.initial.packageName)) {
      throw new OrdinaryUserLaneFailure('ORDINARY-USER-LIST', stage, 'installed Center is absent from the standard plugin list')
    }
    receipt.observations.cli.initialListPassed = true

    stage = 'profile-dump'
    const dump = await runDsh(
      ['--profile', PROFILE_ID, '--dump-config'],
      'ORDINARY-USER-DUMP',
      stage,
      60_000,
    )
    if (!dumpHasBundle(dump.stdout, config.center.initial.packageName)) {
      throw new OrdinaryUserLaneFailure('ORDINARY-USER-DUMP', stage, 'composed Web Profile omitted the Center Bundle layer')
    }
    receipt.observations.cli.initialDumpContainedBundle = true

    stage = 'profile-update'
    await runDsh(
      [
        'plugin', '--profile', PROFILE_ID, 'add',
        config.center.target.spec,
        '--ignore-scripts', '--save-exact',
      ],
      'ORDINARY-USER-UPDATE',
      stage,
    )
    receipt.observations.cli.updatePassed = true
    await inspectInstalledProfile(
      profileRoot,
      config.center.target,
      centerTargetRegistry,
      receipt,
      'target',
    )
    receipt.observations.profile.updateAdvanced = true
    stage = 'target-reresolution'
    const centerTargetAfterInstall = await inspectCenterSource(config.center.target)
    if (!sameCenterObservation(centerTargetRegistry, centerTargetAfterInstall)) {
      throw new OrdinaryUserLaneFailure(
        'ORDINARY-USER-TARGET-MOVED',
        stage,
        'Center target selector moved while the official Plugin CLI installed it',
      )
    }
    receipt.observations.registry.centerTargetAfterInstall = centerTargetAfterInstall

    stage = 'updated-profile-list'
    const updatedList = await runDsh(
      ['plugin', '--profile', PROFILE_ID, 'list', '--depth', '0'],
      'ORDINARY-USER-UPDATED-LIST',
      stage,
      60_000,
    )
    if (!updatedList.stdout.includes(config.center.target.packageName)) {
      throw new OrdinaryUserLaneFailure('ORDINARY-USER-UPDATED-LIST', stage, 'updated Center is absent from the standard plugin list')
    }
    receipt.observations.cli.updatedListPassed = true

    stage = 'updated-profile-dump'
    const updatedDump = await runDsh(
      ['--profile', PROFILE_ID, '--dump-config'],
      'ORDINARY-USER-UPDATED-DUMP',
      stage,
      60_000,
    )
    if (!dumpHasBundle(updatedDump.stdout, config.center.target.packageName)) {
      throw new OrdinaryUserLaneFailure('ORDINARY-USER-UPDATED-DUMP', stage, 'updated Web Profile omitted the Center Bundle layer')
    }
    receipt.observations.cli.updatedDumpContainedBundle = true

    stage = 'host-start'
    const started = await startWeb(launcher, workspace, environment)
    webChild = started.child
    receipt.observations.host.ready = true

    stage = 'client-entry'
    browserSession = await observeClient(started.launchUrl, config.center.target.packageName)
    Object.assign(receipt.observations.client, browserSession.observation)
    if (webChild.exitCode !== null || webChild.signalCode !== null) {
      throw new OrdinaryUserLaneFailure('ORDINARY-USER-HOST-EXIT', stage, 'DSH Web exited during the Client observation')
    }

    stage = 'extension-management'
    const managementResult = await runManagementLifecycle({
      origin: started.origin,
      page: browserSession.page,
      context: browserSession.context,
      dshVersion: config.dshVersion,
      dshHome,
      receipt,
      webChild,
    })
    managementPendingSubject = managementResult.pendingSubject
    receipt.observations.host.remainedLive = true
    await closeBrowserSession(browserSession)
    browserSession = undefined
    await stopChild(webChild)
    webChild = undefined

    stage = 'profile-remove'
    await runDsh(
      ['plugin', '--profile', PROFILE_ID, 'remove', config.center.target.packageName],
      'ORDINARY-USER-REMOVE',
      stage,
    )
    receipt.observations.cli.removePassed = true
    await inspectRemovedProfile(profileRoot, config, runDsh, receipt)

    if (officialPackageRoot !== undefined && officialTreeBefore !== undefined) {
      receipt.observations.officialDshPackageTreeUnchanged =
        await immutablePackageTreeDigest(officialPackageRoot) === officialTreeBefore
      if (receipt.observations.officialDshPackageTreeUnchanged !== true) {
        throw new OrdinaryUserLaneFailure(
          'ORDINARY-USER-OFFICIAL-DSH-MODIFIED',
          'finalize',
          'plugin lifecycle changed the independently installed official DSH package tree',
        )
      }
    }
    if (managementPendingSubject !== null && managementPendingSubject !== undefined) {
      markManagementPending(receipt, managementPendingSubject)
      return await finish(config, receipt, 2)
    }
    markPassed(receipt, config)
    return await finish(config, receipt, 0)
  } catch (error) {
    await closeBrowserSession(browserSession).catch(() => undefined)
    await stopChild(webChild).catch(() => undefined)
    markFailed(receipt, error, stage)
    process.stderr.write(`${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`)
    return await finish(config, receipt, 1)
  } finally {
    await closeBrowserSession(browserSession).catch(() => undefined)
    if (temporaryRoot !== undefined && !config.keepTemporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

async function inspectRegistryPackage(spec) {
  const result = await runCapture(
    'pnpm',
    ['view', spec, 'version', 'dist.integrity', '--json', `--registry=${NPM_REGISTRY}`],
    { cwd: process.cwd(), env: isolatedEnvironment({}), timeoutMs: 60_000 },
  )
  if (result.code !== 0) {
    let failure
    try {
      failure = JSON.parse(result.stdout)
    } catch {
      failure = null
    }
    if (['ERR_PNPM_FETCH_404', 'ERR_PNPM_PACKAGE_NOT_FOUND'].includes(failure?.error?.code)) return null
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-REGISTRY-LOOKUP',
      'registry-preflight',
      'registry lookup failed without a package-not-found response',
      result,
    )
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-REGISTRY-RESPONSE',
      'registry-preflight',
      'registry returned a non-JSON package response',
      error,
    )
  }
  const integrity = parsed?.['dist.integrity'] ?? parsed?.dist?.integrity
  if (typeof parsed?.version !== 'string' || typeof integrity !== 'string'
    || !integrity.startsWith('sha512-')) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-REGISTRY-RESPONSE',
      'registry-preflight',
      'registry package response omitted version or integrity',
    )
  }
  return Object.freeze({ status: 'published', version: parsed.version, integrity })
}

async function inspectCenterSource(center) {
  if (center.kind === 'registry') return await inspectRegistryPackage(center.spec)
  return Object.freeze({
    status: 'immutable-github',
    version: null,
    integrity: null,
    commit: center.commit,
  })
}

function updateAdvances(config, initial, target) {
  if (config.center.initial.kind === 'registry' && config.center.target.kind === 'registry') {
    return compareExactVersions(target.version, initial.version) > 0
  }
  if (config.center.initial.kind === 'github' && config.center.target.kind === 'github') {
    return config.center.initial.commit !== config.center.target.commit
  }
  return config.center.initial.spec !== config.center.target.spec
}

function sameCenterObservation(before, after) {
  if (before?.status !== after?.status) return false
  if (before.status === 'published') {
    return before.version === after.version && before.integrity === after.integrity
  }
  return before.status === 'immutable-github' && before.commit === after.commit
}

async function resolveLauncher(config, temporaryRoot, workspace, environment) {
  if (config.launcher.kind === 'development-source') {
    const sourceRoot = await realpath(config.launcher.sourceRoot)
    const manifest = JSON.parse(await readFile(join(sourceRoot, 'apps', 'cli', 'package.json'), 'utf8'))
    if (manifest.name !== config.dshPackage || manifest.version !== config.dshVersion) {
      throw new OrdinaryUserLaneFailure(
        'ORDINARY-USER-DSH-SOURCE',
        'dsh-launcher',
        'DSH source manifest does not match the requested official package and version',
      )
    }
    const revision = await runRequired(
      'git', ['-C', sourceRoot, 'rev-parse', 'HEAD'],
      { cwd: workspace, env: environment, timeoutMs: 30_000 },
      'ORDINARY-USER-DSH-SOURCE', 'dsh-launcher',
    )
    if (revision.stdout.trim() !== config.launcher.sourceCommit) {
      throw new OrdinaryUserLaneFailure(
        'ORDINARY-USER-DSH-SOURCE',
        'dsh-launcher',
        'DSH source checkout does not match the requested immutable commit',
      )
    }
    return Object.freeze({ command: 'pnpm', arguments: ['--dir', sourceRoot, 'dsh'] })
  }
  if (config.launcher.kind === 'external-command') {
    return Object.freeze({ command: config.launcher.command, arguments: [...config.launcher.arguments] })
  }
  const hostRoot = join(temporaryRoot, 'official-host')
  await mkdir(hostRoot, { mode: 0o700 })
  await writeFile(join(hostRoot, 'package.json'), `${JSON.stringify({ private: true }, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  await runRequired(
    'pnpm',
    [
      '--dir', hostRoot, 'add', `${config.dshPackage}@${config.dshVersion}`,
      '--save-exact', '--ignore-scripts', '--config.enable-global-virtual-store=false',
      `--registry=${NPM_REGISTRY}`,
    ],
    { cwd: workspace, env: environment, timeoutMs: 300_000 },
    'ORDINARY-USER-DSH-INSTALL',
    'dsh-launcher',
  )
  const packageRoot = await realpath(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh'))
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== config.dshPackage || manifest.version !== config.dshVersion || manifest.bin?.dsh !== 'lib/bin.js') {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-DSH-INSTALL',
      'dsh-launcher',
      'independently installed DSH manifest does not match the requested official package',
    )
  }
  const executable = await realpath(join(hostRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'))
  return Object.freeze({ command: executable, arguments: [], officialPackageRoot: packageRoot })
}

async function inspectInstalledProfile(profileRoot, center, sourceObservation, receipt, phase) {
  const manifest = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
  const dependency = manifest.dependencies?.[center.packageName]
  const bundles = manifest.dsh?.profile?.bundles
  const installedRoot = join(profileRoot, 'node_modules', ...center.packageName.split('/'))
  const installedManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
  const exactDependency = center.kind === 'registry'
    ? dependency === sourceObservation?.version
    : typeof dependency === 'string' && dependency.includes(center.commit)
  const bundleCount = Array.isArray(bundles)
    ? bundles.filter(value => value === center.packageName).length
    : 0
  const lockfile = await readFile(join(profileRoot, 'pnpm-lock.yaml'), 'utf8')
  const artifactBound = center.kind === 'registry'
    ? typeof sourceObservation?.integrity === 'string' && lockfile.includes(sourceObservation.integrity)
    : lockfile.includes(center.commit)
  const installedVersionMatches = center.kind !== 'registry'
    || installedManifest.version === sourceObservation.version
  if (phase === 'initial') {
    Object.assign(receipt.observations.profile, {
      initialExactDependency: exactDependency,
      initialArtifactBound: artifactBound,
      initialBundleCount: bundleCount,
      initialInstalledVersion: installedManifest.version,
    })
  } else {
    Object.assign(receipt.observations.profile, {
      targetExactDependency: exactDependency,
      targetArtifactBound: artifactBound,
      targetBundleCount: bundleCount,
      targetInstalledVersion: installedManifest.version,
    })
  }
  if (!exactDependency || !artifactBound || bundleCount !== 1 || !installedVersionMatches
    || installedManifest.name !== center.packageName
    || installedManifest.dsh?.bundle?.patch === undefined
    || installedManifest.dsh?.client?.platform !== 'web') {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-PROFILE',
      phase === 'initial' ? 'profile-add' : 'profile-update',
      `${phase} Profile state did not bind one exact installable Host and Web Client Bundle`,
    )
  }
}

async function startWeb(launcher, cwd, environment) {
  const output = { value: '' }
  const child = spawn(launcher.command, [...launcher.arguments, 'web', '--no-open', '--port', '0'], {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForReadyUrl(child, output, 120_000)
    const launchUrl = parseAuthenticatedLaunchUrl(output.value)
    return Object.freeze({ child, origin: new URL(launchUrl).origin, launchUrl })
  } catch (error) {
    await stopChild(child).catch(() => undefined)
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-HOST-START',
      'host-start',
      'installed Center prevented the official Web Host from reaching readiness',
      error,
    )
  }
}

export function parseAuthenticatedLaunchUrl(output) {
  const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
  if (match?.[1] === undefined) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-HOST-AUTH-URL',
      'host-start',
      'official Web Host did not announce its authenticated launch URL',
    )
  }
  const url = new URL(match[1])
  const tokens = url.searchParams.getAll('token')
  if (url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.port === ''
    || url.pathname !== '/'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || [...url.searchParams.keys()].some(name => name !== 'token')
    || tokens.length !== 1
    || !/^[A-Za-z0-9_-]{43}$/u.test(tokens[0])) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-HOST-AUTH-URL',
      'host-start',
      'official Web Host announced an invalid authenticated loopback launch URL',
    )
  }
  return url.href
}

async function closeBrowserSession(session) {
  if (session === undefined) return
  await session.context.close().catch(() => undefined)
  await session.browser.close().catch(() => undefined)
}

async function observeClient(launchUrl, packageName) {
  const origin = new URL(launchUrl).origin
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    locale: 'en-US',
    serviceWorkers: 'block',
    viewport: { width: 1280, height: 900 },
  })
  let bundleRequestObserved = false
  const consoleFailures = []
  try {
    await context.route('**/*', async route => {
      const request = route.request()
      if (!isAdmittedBrowserRequest(request.url(), origin)) {
        await route.abort('blockedbyclient')
        return
      }
      if (new URL(request.url()).pathname === `/plugins/${packageName}/client.js`) {
        bundleRequestObserved = true
      }
      await route.continue()
    })
    await context.routeWebSocket('**/*', async websocket => {
      if (isAdmittedBrowserWebSocket(websocket.url(), origin)) websocket.connectToServer()
      else await websocket.close({ code: 1008, reason: 'ordinary-user acceptance admits only the local Web Host' })
    })
    const page = await context.newPage()
    page.on('pageerror', error => consoleFailures.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') consoleFailures.push(message.text())
    })
    await page.goto(launchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(
      pluginId => globalThis.__DSH_BOOT__?.entries?.some(entry => entry.id === pluginId) === true,
      packageName,
      { timeout: 30_000 },
    )
    await dismissOnboarding(page)
    const button = page.getByRole('button', { name: 'Extensions', exact: true })
    await button.waitFor({ state: 'visible', timeout: 10_000 })
    await button.click()
    const dialog = page.getByRole('dialog', { name: 'Extension Store', exact: true })
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })
    for (const label of ['Store', 'Installed', 'Updates', 'Activity & Recovery']) {
      if (await dialog.getByRole('tab', { name: label, exact: true }).count() !== 1) {
        throw new OrdinaryUserLaneFailure(
          'ORDINARY-USER-CLIENT-ENTRY',
          'client-entry',
          'Extension Store omitted an ordinary-user lifecycle tab',
        )
      }
    }
    const configurationFilter = dialog.getByRole('combobox', { name: 'Configuration', exact: true })
    await configurationFilter.waitFor({ state: 'visible', timeout: 30_000 })
    const configurationOptions = await configurationFilter.locator('option').allTextContents()
    if (!configurationOptions.includes('No initial configuration')
      || !configurationOptions.includes('Configuration required')) {
      throw new OrdinaryUserLaneFailure(
        'ORDINARY-USER-CLIENT-CONFIGURATION',
        'client-entry',
        'Extension Store omitted its configuration discovery choices',
      )
    }
    await configurationFilter.selectOption('ready')
    const configurationEntry = dialog.locator(`article[data-candidate-ref="${WIKI_SKILL_V1}"]`)
    await configurationEntry.waitFor({ state: 'visible', timeout: 30_000 })
    await configurationEntry.getByRole('button', { name: 'Details', exact: true }).click()
    const configurationDetail = dialog.locator('#extension-center-detail')
    await configurationDetail.waitFor({ state: 'visible', timeout: 10_000 })
    try {
      await configurationDetail.getByText(/^No initial configuration/u).first()
        .waitFor({ state: 'visible', timeout: 10_000 })
      await configurationDetail.getByText(/^Configure ·/u).first()
        .waitFor({ state: 'visible', timeout: 10_000 })
    } catch (error) {
      throw new OrdinaryUserLaneFailure(
        'ORDINARY-USER-CLIENT-CONFIGURATION',
        'client-entry',
        'Extension Store did not expose the exact no-initial-configuration alpha lifecycle candidate',
        error,
      )
    }
    if (!bundleRequestObserved || consoleFailures.length > 0) {
      throw new OrdinaryUserLaneFailure(
        'ORDINARY-USER-CLIENT-ENTRY',
        'client-entry',
        'Extension Center Client bundle or browser console observation failed',
      )
    }
    return Object.freeze({
      browser,
      context,
      page,
      observation: Object.freeze({
        bootEntryObserved: true,
        bundleRequestObserved,
        extensionsButtonObserved: true,
        storeDialogObserved: true,
        storeTabsObserved: true,
        configurationFilterObserved: true,
        configurationReadyEntryObserved: true,
        consoleFailures: 0,
      }),
    })
  } catch (error) {
    await context.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    throw error
  }
}

async function verifyManagementAuthentication(origin, context) {
  const cookies = (await context.cookies(origin)).filter(cookie => cookie.name.startsWith('dsh-auth-'))
  requireManagement(
    cookies.length === 1
      && cookies[0].httpOnly === true
      && cookies[0].sameSite === 'Strict'
      && cookies[0].path === '/',
    'ORDINARY-USER-MANAGEMENT-AUTH-SESSION',
    'official Web login did not mint one HttpOnly authority-bound browser session',
  )
  const cookie = cookies[0]
  const endpoint = new URL('/dsh-extension-center/catalog/list', origin)
  const request = async headers => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'ordinary-user-auth-negative',
        method: 'catalog/list',
        payload: { protocolVersion: 1 },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    await response.text()
    return response.status
  }
  const missingSessionStatus = await request({
    origin,
    'sec-fetch-site': 'same-origin',
  })
  const invalidSessionStatus = await request({
    origin,
    'sec-fetch-site': 'same-origin',
    cookie: `${cookie.name}=invalid`,
  })
  const crossOriginStatus = await request({
    origin: 'http://ordinary-user-cross-origin.invalid',
    'sec-fetch-site': 'same-origin',
    cookie: `${cookie.name}=${cookie.value}`,
  })
  requireManagement(
    missingSessionStatus === 401 && invalidSessionStatus === 401 && crossOriginStatus === 403,
    'ORDINARY-USER-MANAGEMENT-AUTH-REJECTION',
    'official Connection did not reject missing, invalid, and cross-origin browser authority',
  )
  return Object.freeze({
    browserSessionEstablished: false,
    missingSessionRejected: true,
    invalidSessionRejected: true,
    crossOriginRejected: true,
  })
}

async function runManagementLifecycle({ origin, page, context, dshVersion, dshHome, receipt, webChild }) {
  const management = receipt.observations.management
  const discovery = management.discovery
  Object.assign(management.authentication, await verifyManagementAuthentication(origin, context))
  Object.assign(management.userInterface, {
    driver: 'playwright-accessible-ui',
    scopeKey: 'user',
    directMutationRpcCalls: 0,
  })
  const rpc = createManagementRpc(origin, page, management.userInterface)
  let parsedCatalog
  try {
    const envelope = await rpc.raw('catalog/list', { protocolVersion: 1 }, 'ordinary-user-management-catalog')
    parsedCatalog = parseCatalogListEnvelope(envelope, 'ordinary-user-management-catalog')
    management.authentication.browserSessionEstablished = true
  } catch (error) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-MANAGEMENT-CATALOG',
      'extension-management',
      'Extension Center did not return one correlated verified catalog response',
      error,
    )
  }
  assertCatalogTrust(parsedCatalog.catalog)
  Object.assign(discovery, {
    catalogId: parsedCatalog.catalog.id,
    catalogRevision: parsedCatalog.catalog.revision,
    catalogEntriesDigest: parsedCatalog.catalog.entriesDigest,
    catalogSignatureStatus: parsedCatalog.catalog.signatureStatus,
    catalogKeyIds: [...parsedCatalog.catalog.keyIds],
    catalogSource: parsedCatalog.catalog.source,
    catalogFreshness: parsedCatalog.catalog.freshness,
    catalogDegraded: parsedCatalog.catalog.degraded,
  })

  const pair = selectAlphaWikiPair(parsedCatalog.value.entries, dshVersion)
  if (pair === null) {
    return Object.freeze({ pendingSubject: 'signed alpha-compatible Skill successor pair' })
  }
  const targetKey = `skill:web:user:${pair.initial.name}`
  const dialog = page.getByRole('dialog', { name: 'Extension Store', exact: true })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  const ui = Object.freeze({ page, dialog })
  Object.assign(discovery, {
    extensionKind: 'skill',
    extensionName: pair.initial.name,
    targetKey,
    initialCandidateRef: pair.initial.candidateRef,
    updateCandidateRef: pair.update.candidateRef,
    initialArtifactRevision: pair.initial.artifact.version,
    initialArtifactIntegrity: pair.initial.artifact.integrity,
    initialArtifactSizeBytes: pair.initial.artifact.sizeBytes,
    updateArtifactRevision: pair.update.artifact.version,
    updateArtifactIntegrity: pair.update.artifact.integrity,
    updateArtifactSizeBytes: pair.update.artifact.sizeBytes,
    initialCompatibilityDsh: pair.initial.compatibility.dsh,
    updateCompatibilityDsh: pair.update.compatibility.dsh,
  })

  const initialInventory = await rpc.call('inventory/list', {
    protocolVersion: 1,
    scopeKey: 'user',
    profileId: PROFILE_ID,
  })
  assertInventoryEnvelope(initialInventory)
  requireManagement(
    initialInventory.inventory.complete === true
      && initialInventory.inventory.rows.every(row => row?.targetKey !== targetKey),
    'ORDINARY-USER-MANAGEMENT-DIRTY-TARGET',
    'isolated ordinary-user scope already contained the selected Skill target',
  )
  await assertConfigurationOptions(rpc, management, pair.initial.candidateRef, 'install', null, null)
  discovery.methods = ['catalog/list', 'inventory/list', 'configuration/options']

  const materialRoot = join(dshHome, 'extension-center', 'material')
  const install = await executeSkillLifecycle({
    ui,
    rpc,
    management,
    sequence: 1,
    operationKind: 'install',
    candidateRef: pair.initial.candidateRef,
    requestTargetKey: null,
    targetKey,
    configuration: SKILL_CONFIGURATION_INITIAL,
    expected: activeSkillExpectation(pair.initial.candidateRef, true, 'unavailable'),
  })
  discovery.initialEligible = install.policyEligible
  requireManagement(
    install.row.updateObservation?.status === 'available'
      && install.row.updateObservation.candidateRef === pair.update.candidateRef
      && install.row.updateObservation.revision === pair.update.artifact.version
      && install.row.updateObservation.integrity === pair.update.artifact.integrity,
    'ORDINARY-USER-MANAGEMENT-UPDATE-DISCOVERY',
    'installed Skill did not expose the exact signed successor',
  )
  const initialMaterial = await assertManagedSkillArtifact(install.row, materialRoot, pair.initial.artifact)
  management.install = install.evidence

  await assertConfigurationOptions(
    rpc,
    management,
    pair.initial.candidateRef,
    'configure',
    targetKey,
    SKILL_CONFIGURATION_INITIAL,
  )
  const configure = await executeSkillLifecycle({
    ui,
    rpc,
    management,
    sequence: 2,
    operationKind: 'configure',
    candidateRef: pair.initial.candidateRef,
    requestTargetKey: targetKey,
    targetKey,
    configuration: SKILL_CONFIGURATION_CONFIGURED,
    expected: activeSkillExpectation(pair.initial.candidateRef, false),
  })
  requireManagement(
    configure.row.configurationRevision !== install.row.configurationRevision,
    'ORDINARY-USER-MANAGEMENT-CONFIGURE',
    'Skill configuration did not change the exact inventory configuration revision',
  )
  management.configure = configure.evidence

  await assertConfigurationOptions(
    rpc,
    management,
    pair.update.candidateRef,
    'update',
    targetKey,
    SKILL_CONFIGURATION_CONFIGURED,
  )
  const update = await executeSkillLifecycle({
    ui,
    rpc,
    management,
    sequence: 3,
    operationKind: 'update',
    candidateRef: pair.update.candidateRef,
    requestTargetKey: targetKey,
    targetKey,
    configuration: SKILL_CONFIGURATION_CONFIGURED,
    expected: activeSkillExpectation(pair.update.candidateRef, false),
  })
  discovery.updateEligible = update.policyEligible
  const updatedMaterial = await assertManagedSkillArtifact(update.row, materialRoot, pair.update.artifact)
  management.update = update.evidence

  const uninstallForRestore = await executeSkillLifecycle({
    ui,
    rpc,
    management,
    sequence: 4,
    operationKind: 'uninstall',
    candidateRef: pair.update.candidateRef,
    requestTargetKey: targetKey,
    targetKey,
    configuration: SKILL_CONFIGURATION_CONFIGURED,
    expected: removedSkillExpectation(pair.update.candidateRef, 'available'),
  })
  requireManagement(
    uninstallForRestore.row.actions?.restore?.status === 'available'
      && uninstallForRestore.row.restoreObservation?.status === 'available'
      && uninstallForRestore.row.restoreObservation.candidateRef === pair.update.candidateRef,
    'ORDINARY-USER-MANAGEMENT-RESTORE-DISCOVERY',
    'uninstalled Skill did not retain the exact recoverable successor state',
  )
  management.uninstallForRestore = uninstallForRestore.evidence

  await assertConfigurationOptions(
    rpc,
    management,
    pair.update.candidateRef,
    'restore',
    targetKey,
    SKILL_CONFIGURATION_CONFIGURED,
  )
  const restore = await executeSkillLifecycle({
    ui,
    rpc,
    management,
    sequence: 5,
    operationKind: 'restore',
    candidateRef: pair.update.candidateRef,
    requestTargetKey: targetKey,
    targetKey,
    configuration: SKILL_CONFIGURATION_CONFIGURED,
    expected: activeSkillExpectation(pair.update.candidateRef, false),
  })
  management.restore = restore.evidence

  const finalUninstall = await executeSkillLifecycle({
    ui,
    rpc,
    management,
    sequence: 6,
    operationKind: 'uninstall',
    candidateRef: pair.update.candidateRef,
    requestTargetKey: targetKey,
    targetKey,
    configuration: SKILL_CONFIGURATION_CONFIGURED,
    expected: removedSkillExpectation(pair.update.candidateRef, 'available'),
  })
  management.finalUninstall = finalUninstall.evidence

  const purge = await executeSkillLifecycle({
    ui,
    rpc,
    management,
    sequence: 7,
    operationKind: 'purge',
    candidateRef: pair.update.candidateRef,
    requestTargetKey: targetKey,
    targetKey,
    configuration: SKILL_CONFIGURATION_CONFIGURED,
    expected: removedSkillExpectation(null, 'unavailable'),
  })
  const managedBytesAbsent = !await exists(initialMaterial) && !await exists(updatedMaterial)
  requireManagement(
    purge.row.actions?.install?.status === 'available' && managedBytesAbsent,
    'ORDINARY-USER-MANAGEMENT-PURGE',
    'purge retained managed Skill bytes, rollback state, or blocked a future install',
  )
  purge.evidence.managedBytesAbsent = true
  management.purge = purge.evidence

  const finalInventory = await rpc.call('inventory/list', {
    protocolVersion: 1,
    scopeKey: 'user',
    profileId: PROFILE_ID,
  })
  management.verificationMethods.push('inventory/list')
  const finalRow = assertInventoryRow(finalInventory, targetKey, removedSkillExpectation(null, 'unavailable'))
  requireManagement(
    finalRow.managedRevision === purge.row.managedRevision
      && finalRow.actions?.install?.status === 'available',
    'ORDINARY-USER-MANAGEMENT-FINAL-CLEANUP',
    'final inventory did not retain only the non-recoverable installable history row',
  )
  management.finalCleanup = {
    inventoryRevision: finalInventory.inventory.revision,
    targetRowCount: 1,
    tombstoneRetained: true,
    candidateRef: null,
    desired: finalRow.desired,
    materialized: finalRow.materialized,
    effective: finalRow.effective,
    agentVisibility: finalRow.agentVisibility,
    rollback: finalRow.rollback,
    managedBytesAbsent: true,
    installActionAvailable: true,
  }
  requireManagement(
    webChild.pid !== undefined && webChild.exitCode === null && webChild.signalCode === null,
    'ORDINARY-USER-MANAGEMENT-HOST-EXIT',
    'official Web Host exited during the Skill management lifecycle',
  )
  management.hostProcessStable = true
  return Object.freeze({ pendingSubject: null })
}

export function createManagementRpc(origin, page, audit) {
  let sequence = 0
  const raw = async (method, payload, suppliedRpcId, timeoutMs = 30_000) => {
    if (!READ_ONLY_MANAGEMENT_METHODS.has(method)) {
      audit.directMutationRpcCalls += 1
      throw new OrdinaryUserLaneFailure(
        'ORDINARY-USER-MANAGEMENT-DIRECT-MUTATION',
        'extension-management',
        `${method} is not an admitted read-only verification method`,
      )
    }
    const rpcId = suppliedRpcId ?? `ordinary-user-${String(++sequence).padStart(2, '0')}-${method.replaceAll('/', '-')}`
    const response = await page.evaluate(async (input) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), input.timeoutMs)
      try {
        const result = await fetch(input.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: input.body,
          signal: controller.signal,
        })
        return {
          ok: result.ok,
          status: result.status,
          body: await result.text(),
        }
      } finally {
        clearTimeout(timer)
      }
    }, {
      url: new URL(`/dsh-extension-center/${method}`, origin).href,
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      timeoutMs,
    })
    requireManagement(
      response.ok && response.status === 200,
      'ORDINARY-USER-MANAGEMENT-RPC-HTTP',
      `${method} did not return authenticated HTTP success`,
    )
    let envelope
    try {
      envelope = JSON.parse(response.body)
    } catch (error) {
      throw new OrdinaryUserLaneFailure(
        'ORDINARY-USER-MANAGEMENT-RPC-ENVELOPE',
        'extension-management',
        `${method} did not return JSON`,
        error,
      )
    }
    requireManagement(
      isRecord(envelope) && envelope.type === 'server-response' && envelope.rpcId === rpcId,
      'ORDINARY-USER-MANAGEMENT-RPC-ENVELOPE',
      `${method} response did not correlate to its exact request`,
    )
    return envelope
  }
  const call = async (method, payload, timeoutMs) => {
    const envelope = await raw(method, payload, undefined, timeoutMs)
    requireManagement(isRecord(envelope.result), 'ORDINARY-USER-MANAGEMENT-RPC-PROTOCOL', `${method} omitted its result`)
    if (envelope.result.ok !== true) {
      throw new OrdinaryUserLaneFailure(
        'ORDINARY-USER-MANAGEMENT-RPC-REFUSED',
        'extension-management',
        `${method} was refused by the authenticated Extension Center Host`,
      )
    }
    requireManagement(
      isRecord(envelope.result.value) && envelope.result.value.protocolVersion === 1,
      'ORDINARY-USER-MANAGEMENT-RPC-PROTOCOL',
      `${method} returned an incompatible value`,
    )
    return envelope.result.value
  }
  return Object.freeze({ raw, call })
}

function assertCatalogTrust(catalog) {
  const issuedAt = Date.parse(catalog.issuedAt)
  const expiresAt = Date.parse(catalog.expiresAt)
  const sourcePair = catalog.source === 'bootstrap' && catalog.freshness === 'bootstrap'
    || catalog.source === 'remote' && catalog.freshness === 'fresh'
    || catalog.source === 'last-good' && catalog.freshness === 'cached'
  requireManagement(
    catalog.id === 'dsh-extension-center-public'
      && catalog.signatureStatus === 'verified'
      && Array.isArray(catalog.keyIds)
      && catalog.keyIds.length > 0
      && catalog.keyIds.every(value => typeof value === 'string' && value.length > 0)
      && sourcePair
      && catalog.degraded === false
      && Number.isFinite(issuedAt)
      && Number.isFinite(expiresAt)
      && issuedAt < expiresAt
      && Date.now() >= issuedAt
      && Date.now() < expiresAt,
    'ORDINARY-USER-MANAGEMENT-CATALOG-TRUST',
    'catalog signature, trust-root identity, freshness, or validity interval was not acceptable',
  )
}

async function assertConfigurationOptions(rpc, management, candidateRef, operationKind, targetKey, expectedCurrent) {
  const response = await rpc.call('configuration/options', {
    protocolVersion: 1,
    candidateRef,
    operationKind,
    targetKey,
    scopeKey: 'user',
    profileId: PROFILE_ID,
  })
  management.configurationMethods.push('configuration/options')
  requireManagement(
    Array.isArray(response.options)
      && response.options.length === 0
      && (expectedCurrent === null
        ? response.currentConfiguration === null
        : canonicalSha256(response.currentConfiguration) === canonicalSha256(expectedCurrent)),
    'ORDINARY-USER-MANAGEMENT-CONFIGURATION-OPTIONS',
    `${operationKind} did not return the exact Skill configuration state`,
  )
}

async function executeSkillLifecycle(input) {
  const externalRuntimeAction = ['install', 'update'].includes(input.operationKind) ? 'download' : 'none'
  const expectedPreviewRequest = {
    protocolVersion: 1,
    origin: 'store',
    candidateRef: input.candidateRef,
    operationKind: input.operationKind,
    scopeKey: 'user',
    profileId: PROFILE_ID,
    continuationId: null,
    targetKey: input.requestTargetKey,
    configuration: input.configuration,
  }
  const previewCall = waitForUiRpc(input.ui.page, 'intent/preview')
  await beginSkillLifecycleInUi(input)
  const previewExchange = await previewCall
  requireManagement(
    canonicalSha256(previewExchange.payload) === canonicalSha256(expectedPreviewRequest),
    'ORDINARY-USER-MANAGEMENT-UI-PREVIEW',
    `${input.operationKind} UI did not request the exact expected lifecycle preview`,
  )
  const preview = previewExchange.value
  input.management.writeMethods.push('intent/preview')
  const plan = assertManagementPlan(preview, {
    candidateRef: input.candidateRef,
    targetKey: input.targetKey,
    operationKind: input.operationKind,
    desired: input.expected.desired,
    externalRuntimeAction,
  })
  const planSurface = input.ui.dialog.locator('section[data-plan-hash]').filter({
    has: input.ui.dialog.getByRole('heading', { name: 'Review exact lifecycle plan', exact: true }),
  })
  await planSurface.waitFor({ state: 'visible', timeout: 30_000 })
  requireManagement(
    await planSurface.getAttribute('data-plan-hash') === plan.hash,
    'ORDINARY-USER-MANAGEMENT-UI-PLAN',
    `${input.operationKind} UI did not render the exact immutable plan hash`,
  )
  await planSurface.getByText(plan.content.candidateRef, { exact: true }).first()
    .waitFor({ state: 'visible', timeout: 10_000 })
  input.management.userInterface.planReviewsObserved += 1

  const expectedApprovalRequest = {
    protocolVersion: 1,
    planId: plan.content.planId,
    planHash: plan.hash,
    operationKind: plan.content.operationKind,
    decision: 'approve',
  }
  const expectedLifecycleRequest = { protocolVersion: 1, planHash: plan.hash }
  const approvalCall = waitForUiRpc(input.ui.page, 'plan/decide')
  const lifecycleCall = waitForUiRpc(input.ui.page, 'lifecycle/request', 90_000)
  await planSurface.getByRole('button', { name: 'Approve exact plan', exact: true }).click()
  input.management.userInterface.approvalsClicked += 1
  const [approvalExchange, lifecycleExchange] = await Promise.all([approvalCall, lifecycleCall])
  requireManagement(
    canonicalSha256(approvalExchange.payload) === canonicalSha256(expectedApprovalRequest)
      && canonicalSha256(lifecycleExchange.payload) === canonicalSha256(expectedLifecycleRequest),
    'ORDINARY-USER-MANAGEMENT-UI-DECISION',
    `${input.operationKind} UI did not bind approval and execution to the exact immutable plan`,
  )
  const approval = approvalExchange.value
  input.management.writeMethods.push('plan/decide')
  requireManagement(
    approval.state?.status === 'approved'
      && approval.state.plan?.hash === plan.hash
      && approval.state.decision?.planId === plan.content.planId
      && approval.state.decision?.planHash === plan.hash
      && approval.state.decision?.operationKind === input.operationKind
      && approval.state.decision?.decision === 'approve',
    'ORDINARY-USER-MANAGEMENT-APPROVAL',
    `${input.operationKind} approval did not bind the exact immutable plan`,
  )
  const lifecycle = lifecycleExchange.value
  input.management.writeMethods.push('lifecycle/request')
  const terminalReceipt = assertCommittedLifecycle(lifecycle, plan, externalRuntimeAction)
  await planSurface.getByText('Lifecycle operation finished', { exact: true })
    .waitFor({ state: 'visible', timeout: 30_000 })
  input.management.userInterface.lifecycleCompletionsObserved += 1
  const operation = await input.rpc.call('operation/get', {
    protocolVersion: 1,
    operationId: lifecycle.operationId,
  })
  input.management.receiptMethods.push('operation/get')
  try {
    verifyOperationReceiptJournal(operation.operation, terminalReceipt)
  } catch (error) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-MANAGEMENT-JOURNAL',
      'extension-management',
      `${input.operationKind} operation journal did not bind its terminal receipt`,
      error,
    )
  }
  const inventory = await input.rpc.call('inventory/verify', {
    protocolVersion: 1,
    scopeKey: 'user',
    profileId: PROFILE_ID,
    targetKey: input.targetKey,
  })
  input.management.verificationMethods.push('inventory/verify')
  const row = assertInventoryRow(inventory, input.targetKey, input.expected)
  input.management.userInterface.operationKinds.push(input.operationKind)
  await planSurface.getByRole('button', { name: 'Close plan review', exact: true }).click()
  await planSurface.waitFor({ state: 'hidden', timeout: 10_000 })
  return Object.freeze({
    policyEligible: preview.policy?.status === 'eligible',
    plan,
    row,
    evidence: {
      sequence: input.sequence,
      operationKind: input.operationKind,
      candidateRef: input.candidateRef,
      targetKey: input.targetKey,
      planId: plan.content.planId,
      planHash: plan.hash,
      singleUse: plan.content.singleUse,
      decision: approval.state.decision.decision,
      operationId: lifecycle.operationId,
      receiptDigest: terminalReceipt.digest,
      outcome: lifecycle.status,
      externalRuntimeAction,
      inventoryRevision: inventory.inventory.revision,
      inventoryRowPresent: true,
      managedRevision: row.managedRevision,
      configurationRevision: row.configurationRevision,
      observedCandidateRef: row.candidateRef,
      rollback: row.rollback,
      restoreActionAvailable: row.actions?.restore?.status === 'available',
      installActionAvailable: row.actions?.install?.status === 'available',
      managedBytesAbsent: null,
      desired: row.desired,
      materialized: row.materialized,
      effective: row.effective,
      agentVisibility: row.agentVisibility,
      verification: row.verification,
      userInvocable: row.evidence?.kind === 'skill' ? row.evidence.invocation?.userInvocable ?? null : null,
      ownerStateVerified: true,
    },
  })
}

async function beginSkillLifecycleInUi(input) {
  const { dialog } = input.ui
  if (input.sequence === 1) {
    await selectLifecycleTab(dialog, 'Store')
    const detailClose = dialog.getByRole('button', { name: 'Close details', exact: true })
    if (await detailClose.isVisible()) await detailClose.click()
    const store = dialog.getByRole('tabpanel', { name: 'Store', exact: true })
    const card = store.locator(`article[data-candidate-ref="${input.candidateRef}"]`)
    await card.waitFor({ state: 'visible', timeout: 30_000 })
    await card.getByRole('combobox', { name: 'Target scope', exact: true }).selectOption('user')
    await card.getByRole('button', { name: 'Review install', exact: true }).click()
    await saveSkillConfigurationDraft(store, input.configuration)
    return
  }
  if (input.sequence === 3) {
    const updates = await selectLifecycleTab(dialog, 'Updates')
    await selectManagementScope(updates, 'user')
    const card = updates.locator('article').filter({
      has: updates.getByText(input.candidateRef, { exact: true }),
    })
    await card.waitFor({ state: 'visible', timeout: 30_000 })
    await card.getByRole('button', { name: 'Update', exact: true }).click()
    return
  }

  const installed = await selectLifecycleTab(dialog, 'Installed')
  await selectManagementScope(installed, 'user')
  const card = installed.locator(`article[data-target-key="${input.targetKey}"]`)
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  const action = operationButtonName(input.operationKind)
  await card.getByRole('button', { name: action, exact: true }).click()
  if (input.operationKind === 'configure') {
    await saveSkillConfigurationDraft(card, input.configuration)
  }
}

async function selectLifecycleTab(dialog, name) {
  const tab = dialog.getByRole('tab', { name, exact: true })
  await tab.click()
  const panel = dialog.getByRole('tabpanel', { name, exact: true })
  await panel.waitFor({ state: 'visible', timeout: 10_000 })
  return panel
}

async function selectManagementScope(panel, scopeKey) {
  const picker = panel.getByRole('combobox', { name: 'Scope', exact: true })
  await picker.waitFor({ state: 'visible', timeout: 30_000 })
  await picker.selectOption(scopeKey)
}

async function saveSkillConfigurationDraft(surface, configuration) {
  const heading = surface.getByRole('heading', { name: 'Skill target settings', exact: true })
  await heading.waitFor({ state: 'visible', timeout: 30_000 })
  const draft = heading.locator('xpath=ancestor::section[1]')
  const model = draft.getByRole('checkbox', { name: 'Model may invoke this Skill', exact: true })
  const user = draft.getByRole('checkbox', { name: 'User may invoke this Skill', exact: true })
  await model.setChecked(configuration.modelInvocable === true)
  await user.setChecked(configuration.userInvocable === true)
  await draft.getByRole('button', { name: 'Save and review', exact: true }).click()
}

function operationButtonName(operationKind) {
  const names = {
    configure: 'Configure',
    uninstall: 'Uninstall',
    restore: 'Restore',
    purge: 'Purge retained data',
  }
  const name = names[operationKind]
  requireManagement(
    typeof name === 'string',
    'ORDINARY-USER-MANAGEMENT-UI-ACTION',
    `ordinary-user UI has no admitted action for ${operationKind}`,
  )
  return name
}

async function waitForUiRpc(page, method, timeoutMs = 30_000) {
  const response = await page.waitForResponse(candidate => {
    const url = new URL(candidate.url())
    return candidate.request().method() === 'POST'
      && url.pathname === `/dsh-extension-center/${method}`
  }, { timeout: timeoutMs })
  let requestEnvelope
  let responseEnvelope
  try {
    requestEnvelope = response.request().postDataJSON()
    responseEnvelope = await response.json()
  } catch (error) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-MANAGEMENT-UI-RPC',
      'extension-management',
      `${method} UI exchange was not valid JSON`,
      error,
    )
  }
  requireManagement(
    response.status() === 200
      && isRecord(requestEnvelope)
      && requestEnvelope.type === 'client-request'
      && typeof requestEnvelope.rpcId === 'string'
      && requestEnvelope.method === method
      && isRecord(requestEnvelope.payload)
      && isRecord(responseEnvelope)
      && responseEnvelope.type === 'server-response'
      && responseEnvelope.rpcId === requestEnvelope.rpcId
      && isRecord(responseEnvelope.result)
      && responseEnvelope.result.ok === true
      && isRecord(responseEnvelope.result.value)
      && responseEnvelope.result.value.protocolVersion === 1,
    'ORDINARY-USER-MANAGEMENT-UI-RPC',
    `${method} UI exchange did not return one correlated authenticated result`,
  )
  return Object.freeze({ payload: requestEnvelope.payload, value: responseEnvelope.result.value })
}

function assertManagementPlan(response, expected) {
  requireManagement(
    response.policy?.status === 'eligible',
    'ORDINARY-USER-MANAGEMENT-POLICY',
    `${expected.operationKind} candidate was not eligible under the signed alpha policy`,
  )
  requireManagement(isRecord(response.plan), 'ORDINARY-USER-MANAGEMENT-PLAN', `${expected.operationKind} omitted its plan`)
  try {
    verifyImmutablePlanDigest(response.plan)
  } catch (error) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-MANAGEMENT-PLAN',
      'extension-management',
      `${expected.operationKind} plan hash did not match its canonical content`,
      error,
    )
  }
  const plan = response.plan
  const content = plan.content
  requireManagement(
    typeof response.intentId === 'string'
      && content.intentId === response.intentId
      && content.origin === 'store'
      && content.singleUse === true
      && content.candidateRef === expected.candidateRef
      && content.extensionKind === 'skill'
      && content.managedObject === 'artifact'
      && content.targetKey === expected.targetKey
      && content.scopeKey === 'user'
      && content.profileId === PROFILE_ID
      && content.operationKind === expected.operationKind
      && content.desiredState === expected.desired
      && content.externalRuntimeAction === expected.externalRuntimeAction
      && content.runtimeBinding === null
      && content.restartRequired === false,
    'ORDINARY-USER-MANAGEMENT-PLAN-BINDING',
    `${expected.operationKind} plan did not bind the exact Skill candidate, target, state, and runtime action`,
  )
  return plan
}

function assertCommittedLifecycle(response, plan, externalRuntimeAction) {
  requireManagement(
    response.status === 'committed'
      && typeof response.operationId === 'string'
      && isRecord(response.receipt)
      && isRecord(response.receipt.body)
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
      && /^sha256:[a-f0-9]{64}$/u.test(response.receipt.digest),
    'ORDINARY-USER-MANAGEMENT-RECEIPT',
    `${plan.content.operationKind} did not return one exact committed terminal receipt`,
  )
  try {
    verifyTerminalReceiptPlanBinding(response.receipt, plan)
  } catch (error) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-MANAGEMENT-RECEIPT',
      'extension-management',
      `${plan.content.operationKind} receipt did not bind the immutable plan`,
      error,
    )
  }
  return response.receipt
}

function assertInventoryEnvelope(response) {
  requireManagement(
    response.hostCapabilities?.acquisition === true
      && isRecord(response.inventory)
      && response.inventory.scopeKey === 'user'
      && response.inventory.profileId === PROFILE_ID
      && response.inventory.complete === true
      && Array.isArray(response.inventory.rows)
      && /^sha256:[a-f0-9]{64}$/u.test(response.inventory.revision),
    'ORDINARY-USER-MANAGEMENT-INVENTORY',
    'inventory response omitted the exact complete user scope or canonical revision',
  )
}

function assertInventoryRow(response, targetKey, expected) {
  assertInventoryEnvelope(response)
  const rows = response.inventory.rows.filter(row => row?.targetKey === targetKey)
  requireManagement(
    rows.length === 1,
    'ORDINARY-USER-MANAGEMENT-INVENTORY-TARGET',
    'inventory did not contain one exact selected Skill target',
  )
  const row = rows[0]
  requireManagement(
    row.kind === 'skill'
      && row.ownership === 'center'
      && row.scopeKey === 'user'
      && row.profileId === PROFILE_ID
      && row.candidateRef === expected.candidateRef
      && row.desired === expected.desired
      && row.materialized === expected.materialized
      && row.effective === expected.effective
      && row.agentVisibility === expected.agentVisibility
      && row.verification === expected.verification
      && row.rollback === expected.rollback
      && typeof row.managedRevision === 'string'
      && row.managedRevision.length > 0
      && (expected.configuration === null
        ? row.configurationRevision === null
        : row.configurationRevision === canonicalSha256(expected.configuration)),
    'ORDINARY-USER-MANAGEMENT-INVENTORY-STATE',
    'inventory row did not expose the exact candidate and independent lifecycle dimensions',
  )
  if (expected.effective === 'active') {
    requireManagement(
      row.evidence?.kind === 'skill'
        && row.evidence.winningProvider === 'extension-center'
        && row.evidence.definitionLoaded === true
        && row.evidence.invocation?.modelInvocable === true
        && row.evidence.invocation.userInvocable === expected.userInvocable,
      'ORDINARY-USER-MANAGEMENT-SKILL-OWNER',
      'active Skill was not the exact merged-registry winner with its configured invocation state',
    )
  } else {
    requireManagement(
      row.evidence?.kind === 'skill'
        && row.evidence.winningProvider !== 'extension-center'
        && row.evidence.definitionLoaded === false,
      'ORDINARY-USER-MANAGEMENT-SKILL-OWNER',
      'removed Skill still contributed to the live Skill registry',
    )
  }
  return row
}

function activeSkillExpectation(candidateRef, userInvocable, rollback = 'available') {
  return Object.freeze({
    candidateRef,
    desired: 'enabled',
    materialized: 'configured',
    effective: 'active',
    agentVisibility: 'visible',
    verification: 'runtime',
    rollback,
    configuration: userInvocable ? SKILL_CONFIGURATION_INITIAL : SKILL_CONFIGURATION_CONFIGURED,
    userInvocable,
  })
}

function removedSkillExpectation(candidateRef, rollback) {
  return Object.freeze({
    candidateRef,
    desired: 'removed',
    materialized: 'absent',
    effective: 'inactive',
    agentVisibility: 'not-visible',
    verification: 'unverified',
    rollback,
    configuration: null,
    userInvocable: null,
  })
}

async function assertManagedSkillArtifact(row, materialRoot, artifact) {
  const path = row.evidence?.winningPath
  requireManagement(
    typeof path === 'string' && path.length > 0,
    'ORDINARY-USER-MANAGEMENT-SKILL-MATERIAL',
    'active Skill inventory omitted its winning material path',
  )
  const canonicalRoot = await realpath(materialRoot)
  const canonicalPath = await realpath(path)
  const rel = relative(canonicalRoot, canonicalPath)
  const info = await lstat(canonicalPath)
  requireManagement(
    rel !== ''
      && rel !== '..'
      && !rel.startsWith(`..${sep}`)
      && info.isFile()
      && !info.isSymbolicLink()
      && info.size === artifact.sizeBytes,
    'ORDINARY-USER-MANAGEMENT-SKILL-MATERIAL',
    'managed Skill material escaped its owner root or did not match the signed byte size',
  )
  const actual = `sha256:${createHash('sha256').update(await readFile(canonicalPath)).digest('hex')}`
  requireManagement(
    actual === artifact.integrity,
    'ORDINARY-USER-MANAGEMENT-SKILL-MATERIAL',
    'managed Skill bytes did not match the signed catalog integrity',
  )
  return canonicalPath
}

function requireManagement(condition, code, message) {
  if (!condition) throw new OrdinaryUserLaneFailure(code, 'extension-management', message)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function dismissOnboarding(page) {
  const dialogs = [
    ['Internal Testing Notice', 'Continue'],
    ['Add an API key to get started', 'Configure later'],
  ]
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let changed = false
    for (const [dialogName, buttonName] of dialogs) {
      const dialog = page.getByRole('dialog', { name: dialogName, exact: true })
      if (await dialog.isVisible()) {
        await dialog.getByRole('button', { name: buttonName, exact: true }).click()
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
        changed = true
      }
    }
    if (!changed) return
    await page.waitForTimeout(250)
  }
  throw new OrdinaryUserLaneFailure(
    'ORDINARY-USER-ONBOARDING',
    'client-entry',
    'official DSH onboarding did not settle for the keyless Client check',
  )
}

async function inspectRemovedProfile(profileRoot, config, runDsh, receipt) {
  const list = await runDsh(
    ['plugin', '--profile', PROFILE_ID, 'list', '--depth', '0'],
    'ORDINARY-USER-REMOVE-LIST',
    'profile-remove',
    60_000,
  )
  const dump = await runDsh(
    ['--profile', PROFILE_ID, '--dump-config'],
    'ORDINARY-USER-REMOVE-DUMP',
    'profile-remove',
    60_000,
  )
  const manifest = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
  const packageName = config.center.target.packageName
  const dependencyAbsent = manifest.dependencies?.[packageName] === undefined
  const bundleAbsent = !manifest.dsh?.profile?.bundles?.includes(packageName)
  const installedRoot = join(profileRoot, 'node_modules', ...packageName.split('/'))
  const packageAbsent = !await exists(installedRoot)
  const listAbsent = !list.stdout.includes(packageName)
  const dumpAbsent = !dumpHasBundle(dump.stdout, packageName)
  Object.assign(receipt.observations.cli, { removedListAbsent: listAbsent, removedDumpAbsent: dumpAbsent })
  Object.assign(receipt.observations.profile, {
    removedDependencyAbsent: dependencyAbsent,
    removedBundleAbsent: bundleAbsent,
    removedPackageAbsent: packageAbsent,
  })
  if (!dependencyAbsent || !bundleAbsent || !packageAbsent || !listAbsent || !dumpAbsent) {
    throw new OrdinaryUserLaneFailure(
      'ORDINARY-USER-REMOVE',
      'profile-remove',
      'standard remove retained Center dependency, Bundle, package, list, or dump state',
    )
  }
}

function dumpHasBundle(dump, packageName) {
  return dump.includes(`# == ${packageName}`)
    && (dump.includes(`name: ${packageName}`) || dump.includes(`name: '${packageName}'`))
}

function isolatedEnvironment(overrides) {
  const environment = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENVIRONMENT_KEY.test(key) && !key.endsWith('_BASE_URL')) {
      environment[key] = value
    }
  }
  return {
    ...environment,
    ...overrides.dshHome === undefined ? {} : { DSH_HOME: overrides.dshHome },
    ...overrides.agentsHome === undefined ? {} : { DSH_AGENTS_HOME: overrides.agentsHome },
    ...overrides.npmConfig === undefined ? {} : { NPM_CONFIG_USERCONFIG: overrides.npmConfig },
    DSH_TELEMETRY_MODE: 'DISABLED',
    NO_COLOR: '1',
    LC_ALL: 'C',
  }
}

async function runRequired(command, args, options, code, stage) {
  const result = await runCapture(command, args, options)
  if (result.code !== 0) {
    throw new OrdinaryUserLaneFailure(code, stage, `${stage} command failed`, result)
  }
  return result
}

function runCapture(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let timedOut = false
    const append = (current, chunk) => {
      outputBytes += chunk.length
      if (outputBytes > OUTPUT_LIMIT_BYTES) {
        signalTree(child, 'SIGTERM')
        rejectRun(new OrdinaryUserLaneFailure(
          'ORDINARY-USER-OUTPUT-LIMIT',
          'subprocess',
          'subprocess exceeded the bounded diagnostic output limit',
        ))
        return current
      }
      return current + chunk.toString()
    }
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      signalTree(child, 'SIGTERM')
      setTimeout(() => signalTree(child, 'SIGKILL'), 5_000).unref()
    }, options.timeoutMs ?? 120_000)
    child.once('error', error => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        rejectRun(new OrdinaryUserLaneFailure(
          'ORDINARY-USER-TIMEOUT',
          'subprocess',
          'subprocess exceeded its acceptance timeout',
        ))
        return
      }
      resolveRun({ code: code ?? 1, signal, stdout, stderr })
    })
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

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function finish(config, receipt, exitCode) {
  await writeOrdinaryUserReceipt(config.receiptPath, receipt)
  process.stdout.write(`${receipt.status}: ${receipt.acceptanceId}; receipt=${basename(config.receiptPath)}\n`)
  return { exitCode, receipt }
}

function printHelp() {
  process.stdout.write(`Usage: node acceptance/ordinary-user/run.mjs [options]\n\n`
    + `Production defaults:\n`
    + `  --mode registry\n`
    + `  --dsh-version 0.1.2-alpha.3\n`
    + `  --center-initial-spec dsh-plugin-extension-center@0.2.0-alpha.0\n`
    + `  --center-target-spec dsh-plugin-extension-center@next\n\n`
    + `Options:\n`
    + `  --dsh-command <executable>       Use a preinstalled command (not P0 registry proof)\n`
    + `  --dsh-arg <argument>             Prefix argument for --dsh-command; repeatable\n`
    + `  --dsh-source-root <absolute>     Development-only official DSH source launcher\n`
    + `  --dsh-commit <40-lowercase-sha>  Required with --dsh-source-root\n`
    + `  --center-initial-spec <spec>     Exact previous registry version or immutable GitHub spec\n`
    + `  --center-target-spec <spec>      Strictly newer registry target or immutable GitHub spec\n`
    + `  --expected-center-target-version <version>  Bind @next to a workflow-verified version\n`
    + `  --expected-center-target-integrity <SRI>     Bind @next to workflow-verified bytes\n`
    + `  --center-package-name <name>     Installed identity shared by immutable GitHub specs\n`
    + `  --receipt <file>                 Secret-free JSON receipt destination\n`
    + `  --keep-temp                      Retain ephemeral state for local diagnosis\n`)
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const config = parseOrdinaryUserArguments(process.argv.slice(2))
    if (config.help) {
      printHelp()
    } else {
      const result = await runOrdinaryUserAcceptance(config)
      process.exitCode = result.exitCode
    }
  } catch (error) {
    const message = error instanceof OrdinaryUserInputError ? error.message : 'ordinary-user runner initialization failed'
    process.stderr.write(`${sanitizeDiagnostic(message)}\n`)
    process.exitCode = error instanceof OrdinaryUserInputError ? 64 : 1
  }
}
