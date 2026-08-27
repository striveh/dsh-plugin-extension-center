#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import {
  assertAscendingReleaseTransition,
  assertPackedManifestIdentity,
  assertProfileBaselineRestored,
  parseReleaseVersion,
  validateArchiveEntries,
} from './verify-public-release.mjs'
import { loadGitHubCiArtifactReceipt } from './verify-github-ci.mjs'
import {
  AcceptanceFailure,
  TARGET_DSH_COMMIT,
  TARGET_DSH_VERSION,
  delay,
  hasBlockedCredentialEnvironment,
  hasProviderEndpointOverride,
  immutablePackageTreeDigest,
  installOfficialDshHost,
  keylessEnvironment,
  parseCatalogListEnvelope,
  runChecked,
  sanitizeDiagnostic,
  sha256,
  stopChild,
  waitForReadyUrl,
} from '../full-p0/support.mjs'
import {
  OFFICIAL_NPM_REGISTRY,
  TARGET_DSH_REGISTRY_INTEGRITY,
  isAdmittedBrowserRequest,
  isAdmittedBrowserWebSocket,
} from '../store-only/support.mjs'

const CENTER_PACKAGE = 'dsh-plugin-extension-center'
const PROFILE_ID = 'web'
const RUNTIME_ACCEPTANCE_ID = 'P0-CENTER-HOST-CLIENT-BOOT'
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
const SHA256 = /^(?:sha256:)?([0-9a-f]{64})$/u
const COMMIT = /^[0-9a-f]{40}$/u
const USAGE = `usage: node acceptance/release/verify-runtime-release.mjs \\
  --current <local-tgz> --current-version <version> \\
  --current-sha256 <sha256> --current-size <bytes> --current-commit <sha> \\
  --current-manifest-sha256 <sha256> \\
  [--previous <local-tgz> --previous-version <version> \\
   --previous-sha256 <sha256> --previous-size <bytes> --previous-commit <sha> \\
   --previous-manifest-sha256 <sha256>] \\
  --ci-receipt <path> --ci-receipt-sha256 <sha256> \\
  --receipt <path>
`
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function fail(code, message) {
  throw new AcceptanceFailure(code, message)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('P0-RUNTIME-INPUT', `${label} must be an object`)
  }
  return value
}

function bounded(value, label, maximum = 4_096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || value.includes('\0')) {
    fail('P0-RUNTIME-INPUT', `${label} must be a bounded non-empty string`)
  }
  return value
}

function digest(value, label) {
  const match = SHA256.exec(bounded(value, label, 80))
  if (match === null) fail('P0-RUNTIME-INPUT', `${label} must be a lowercase SHA-256 digest`)
  return `sha256:${match[1]}`
}

function commit(value, label) {
  const decoded = bounded(value, label, 40)
  if (!COMMIT.test(decoded)) fail('P0-RUNTIME-INPUT', `${label} must be a lowercase 40-character commit`)
  return decoded
}

function positiveSize(value, label) {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_ARTIFACT_BYTES) {
    fail('P0-RUNTIME-INPUT', `${label} must be between 1 and ${String(MAX_ARTIFACT_BYTES)} bytes`)
  }
  return parsed
}

function localPath(value, label) {
  const decoded = bounded(value, label)
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded)) {
    fail('P0-RUNTIME-INPUT', `${label} must be one local artifact path`)
  }
  return resolve(decoded)
}

function artifactFrom(values, prefix) {
  const keys = [
    `--${prefix}`,
    `--${prefix}-version`,
    `--${prefix}-sha256`,
    `--${prefix}-size`,
    `--${prefix}-commit`,
    `--${prefix}-manifest-sha256`,
  ]
  const present = keys.filter(key => values.has(key))
  if (prefix === 'previous' && present.length === 0) return null
  if (present.length !== keys.length) fail('P0-RUNTIME-INPUT', `${prefix} artifact coordinates must be complete`)
  const version = bounded(values.get(keys[1]), `${prefix} version`, 128)
  parseReleaseVersion(version, `${prefix} version`)
  return Object.freeze({
    source: localPath(values.get(keys[0]), `${prefix} artifact`),
    version,
    sha256: digest(values.get(keys[2]), `${prefix} artifact sha256`),
    sizeBytes: positiveSize(values.get(keys[3]), `${prefix} artifact size`),
    commit: commit(values.get(keys[4]), `${prefix} artifact commit`),
    manifestSha256: digest(values.get(keys[5]), `${prefix} manifest sha256`),
  })
}

/** Parse complete local release coordinates and an exclusive receipt destination. */
export function parseRuntimeReleaseArguments(arguments_) {
  if (!Array.isArray(arguments_)) fail('P0-RUNTIME-INPUT', 'CLI arguments must be an array')
  if (arguments_.length === 1 && arguments_[0] === '--help') return Object.freeze({ help: true })
  if (arguments_.length % 2 !== 0) fail('P0-RUNTIME-INPUT', 'CLI flags must be key/value pairs')
  const values = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (typeof key !== 'string' || !key.startsWith('--') || value === undefined || values.has(key)) {
      fail('P0-RUNTIME-INPUT', 'CLI flags must be unique key/value pairs')
    }
    values.set(key, value)
  }
  const admitted = new Set([
    '--current', '--current-version', '--current-sha256', '--current-size', '--current-commit',
    '--current-manifest-sha256', '--previous', '--previous-version', '--previous-sha256',
    '--previous-size', '--previous-commit', '--previous-manifest-sha256', '--ci-receipt',
    '--ci-receipt-sha256', '--receipt',
  ])
  for (const key of values.keys()) if (!admitted.has(key)) fail('P0-RUNTIME-INPUT', `unknown CLI flag ${key}`)
  for (const key of ['--receipt', '--ci-receipt', '--ci-receipt-sha256']) {
    if (!values.has(key)) fail('P0-RUNTIME-INPUT', `${key} is required`)
  }
  const current = artifactFrom(values, 'current')
  const previous = artifactFrom(values, 'previous')
  if (current === null) fail('P0-RUNTIME-INPUT', 'current artifact coordinates are required')
  if (previous !== null) {
    assertAscendingReleaseTransition(previous.version, current.version)
    if (previous.source === current.source || previous.sha256 === current.sha256
      || previous.manifestSha256 === current.manifestSha256 || previous.commit === current.commit) {
      fail('P0-RUNTIME-INPUT', 'previous and current artifacts must have distinct path, digest, manifest, and commit identities')
    }
  }
  return Object.freeze({
    help: false,
    previous,
    current,
    ciReceipt: Object.freeze({
      path: resolve(bounded(values.get('--ci-receipt'), 'GitHub CI receipt path')),
      sha256: digest(values.get('--ci-receipt-sha256'), 'GitHub CI receipt sha256'),
    }),
    receiptPath: resolve(bounded(values.get('--receipt'), 'receipt path')),
  })
}

function sameCoordinate(specification, observation) {
  return observation.version === specification.version
    && observation.sha256 === specification.sha256
    && observation.sizeBytes === specification.sizeBytes
    && observation.manifestSha256 === specification.manifestSha256
    && observation.sourceCommit === specification.commit
}

function runtimeArtifact(specification, observationValue, label) {
  const observation = record(observationValue, `${label} observation`)
  if (!sameCoordinate(specification, observation)
    || observation.hostReady !== true
    || observation.clientEntryObserved !== true
    || observation.clientBundleRequested !== true
    || observation.rpcCatalogListRegistered !== true
    || !Number.isSafeInteger(observation.catalogRevision) || observation.catalogRevision < 1
    || typeof observation.catalogEntriesDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(observation.catalogEntriesDigest)) {
    fail('P0-RUNTIME-OBSERVATION', `${label} did not bind its exact artifact to Host, Client, and catalog/list observations`)
  }
  for (const field of ['browserExternalRequests', 'browserExternalWebSockets', 'browserConsoleFailures']) {
    if (!Array.isArray(observation[field]) || observation[field].length !== 0) {
      fail('P0-RUNTIME-BROWSER-NETWORK', `${label} retained a browser network or console failure`)
    }
  }
  return Object.freeze({
    version: specification.version,
    sha256: specification.sha256,
    sizeBytes: specification.sizeBytes,
    filename: basename(specification.source),
    manifestSha256: specification.manifestSha256,
    sourceCommit: specification.commit,
    hostBoot: true,
    clientBoot: true,
    rpcRegistration: true,
  })
}

/** Build the strict runtime receipt only from exact, successful direct observations. */
export function buildRuntimeAcceptanceReceipt(inputValue) {
  const input = record(inputValue, 'runtime receipt input')
  const current = record(input.current, 'current artifact')
  const previous = input.previous === null ? null : record(input.previous, 'previous artifact')
  const official = record(input.official, 'official DSH observation')
  const profile = record(input.profile, 'Profile lifecycle observation')
  const ci = record(input.ciAcceptance, 'GitHub CI pack acceptance')
  if (official.version !== TARGET_DSH_VERSION
    || official.registry !== OFFICIAL_NPM_REGISTRY
    || official.registryIntegrity !== TARGET_DSH_REGISTRY_INTEGRITY
    || typeof official.packageTreeDigestBefore !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(official.packageTreeDigestBefore)
    || official.packageTreeDigestAfter !== official.packageTreeDigestBefore) {
    fail('P0-RUNTIME-OFFICIAL-HOST', 'official DSH identity or immutable package tree observation is invalid')
  }
  if (profile.profileId !== PROFILE_ID || profile.sameProfile !== true
    || profile.removalExactBaselineRestored !== true
    || (previous === null && profile.officialCliUpdate !== null)
    || (previous !== null && profile.officialCliUpdate !== true)) {
    fail('P0-RUNTIME-PROFILE', 'Profile lifecycle did not prove one exact official CLI install/update/remove path')
  }
  const previousArtifact = previous === null
    ? null
    : runtimeArtifact(previous, input.previousObservation, 'previous artifact')
  if (previous === null && input.previousObservation !== null) {
    fail('P0-RUNTIME-OBSERVATION', 'current-only receipt included a previous observation')
  }
  const currentArtifact = runtimeArtifact(current, input.currentObservation, 'current artifact')
  const ciArtifact = record(ci.artifact, 'GitHub CI attested artifact')
  if (ci.acceptanceId !== 'P0-GITHUB-CI-EXACT-COMMIT'
    || typeof ci.fileSha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(ci.fileSha256)
    || ciArtifact.version !== currentArtifact.version || ciArtifact.sha256 !== currentArtifact.sha256
    || ciArtifact.sizeBytes !== currentArtifact.sizeBytes
    || ciArtifact.manifestSha256 !== currentArtifact.manifestSha256
    || ciArtifact.sourceCommit !== currentArtifact.sourceCommit) {
    fail('P0-RUNTIME-CI-ATTESTATION', 'runtime artifact is not the exact CI-attested deterministic pack')
  }
  return Object.freeze({
    schemaVersion: 2,
    acceptanceId: RUNTIME_ACCEPTANCE_ID,
    status: 'passed',
    profileId: PROFILE_ID,
    target: Object.freeze({
      dshPackage: `@deepseek-ai/dsh@${TARGET_DSH_VERSION}`,
      auditedSourceCommit: TARGET_DSH_COMMIT,
      registry: official.registry,
      registryIntegrity: official.registryIntegrity,
      packageTreeDigest: official.packageTreeDigestBefore,
    }),
    officialDshPackageTreeUnchanged: true,
    artifacts: Object.freeze({
      previous: previousArtifact,
      current: currentArtifact,
    }),
    ciPackAttestation: Object.freeze({
      acceptanceId: ci.acceptanceId,
      fileSha256: ci.fileSha256,
      receiptDigest: ci.receiptDigest,
      runId: ci.runId,
      runAttempt: ci.runAttempt,
      artifact: Object.freeze({ ...ciArtifact }),
    }),
    observations: Object.freeze({
      officialDsh: Object.freeze({ ...official }),
      profile: Object.freeze({ ...profile }),
      previous: input.previousObservation === null ? null : Object.freeze({ ...input.previousObservation }),
      current: Object.freeze({ ...input.currentObservation }),
      keyless: true,
      telemetryDisabled: true,
    }),
  })
}

async function inspectArtifact(specification, environment) {
  const opened = await lstat(specification.source)
  if (!opened.isFile() || opened.isSymbolicLink() || opened.size !== specification.sizeBytes
    || opened.size > MAX_ARTIFACT_BYTES) {
    fail('P0-RUNTIME-ARTIFACT', `${basename(specification.source)} is not the exact bounded regular artifact`)
  }
  const path = await realpath(specification.source)
  const bytes = await readFile(path)
  if (`sha256:${sha256(bytes)}` !== specification.sha256) {
    fail('P0-RUNTIME-ARTIFACT', `${basename(path)} bytes do not match the supplied SHA-256`)
  }
  const [list, verbose, manifestOutput, commitOutput, commitManifestOutput] = await Promise.all([
    runChecked('tar', ['-tzf', path], { cwd: projectRoot, env: environment, timeoutMs: 30_000 }),
    runChecked('tar', ['-tvzf', path], { cwd: projectRoot, env: environment, timeoutMs: 30_000 }),
    runChecked('tar', ['-xOf', path, 'package/package.json'], { cwd: projectRoot, env: environment, timeoutMs: 30_000 }),
    runChecked('git', ['rev-parse', `${specification.commit}^{commit}`], { cwd: projectRoot, env: environment, timeoutMs: 30_000 }),
    runChecked('git', ['show', `${specification.commit}:package.json`], { cwd: projectRoot, env: environment, timeoutMs: 30_000 }),
  ])
  if (commitOutput.stdout.trim() !== specification.commit) {
    fail('P0-RUNTIME-COMMIT', `${basename(path)} source commit did not resolve exactly`)
  }
  validateArchiveEntries(list.stdout, verbose.stdout)
  let authorityManifest
  try {
    authorityManifest = JSON.parse(commitManifestOutput.stdout)
  } catch {
    fail('P0-RUNTIME-COMMIT', `${basename(path)} source commit package.json is not JSON`)
  }
  if (authorityManifest.name !== CENTER_PACKAGE || authorityManifest.version !== specification.version) {
    fail('P0-RUNTIME-COMMIT', `${basename(path)} source commit did not declare the supplied package version`)
  }
  const manifestBytes = Buffer.from(manifestOutput.stdout)
  assertPackedManifestIdentity(manifestBytes, {
    ...specification,
    source: path,
  }, authorityManifest)
  return Object.freeze({ ...specification, source: path })
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizedProfileManifest(manifest) {
  const value = record(manifest, 'Profile package.json')
  return { ...value, dependencies: value.dependencies ?? {} }
}

async function treeDigest(root, excluded) {
  const canonicalRoot = await realpath(root)
  const hash = createHash('sha256')
  const visit = async path => {
    const name = relative(canonicalRoot, path).split(sep).join('/') || '.'
    if (excluded(name)) return
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      hash.update(`link:${name}:${await readlink(path)}\0`)
      return
    }
    if (info.isFile()) {
      hash.update(`file:${name}:${String(info.size)}\0`)
      hash.update(await readFile(path))
      return
    }
    if (!info.isDirectory()) fail('P0-RUNTIME-PROFILE', `Profile contains unsupported entry ${name}`)
    hash.update(`directory:${name}\0`)
    for (const entry of (await readdir(path)).sort()) await visit(join(path, entry))
  }
  await visit(canonicalRoot)
  return `sha256:${hash.digest('hex')}`
}

async function profileBaseline(dshBin, profileRoot, cwd, environment) {
  const [manifestText, lockfile, dump] = await Promise.all([
    readFile(join(profileRoot, 'package.json'), 'utf8'),
    readFile(join(profileRoot, 'pnpm-lock.yaml'), 'utf8'),
    runChecked(dshBin, ['--profile', PROFILE_ID, '--dump-config'], { cwd, env: environment, timeoutMs: 60_000 }),
  ])
  const manifest = normalizedProfileManifest(JSON.parse(manifestText))
  assertCenterAbsent(manifest, lockfile, dump.stdout)
  return Object.freeze({
    manifest: canonicalJson(manifest),
    lockSha256: `sha256:${sha256(Buffer.from(lockfile))}`,
    treeWithoutManifestSha256: await treeDigest(profileRoot, name => name === 'package.json'),
    dumpSha256: `sha256:${sha256(Buffer.from(dump.stdout))}`,
  })
}

async function assertRemoved(dshBin, profileRoot, baseline, cwd, environment) {
  const observed = await profileBaseline(dshBin, profileRoot, cwd, environment)
  assertProfileBaselineRestored(baseline, observed)
  return true
}

async function profileIdentity(profileRoot) {
  const path = await realpath(profileRoot)
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('P0-RUNTIME-PROFILE', 'official Profile root is not one real directory')
  }
  return Object.freeze({ path, device: info.dev, inode: info.ino })
}

function sameProfileIdentity(before, after) {
  return before.path === after.path && before.device === after.device && before.inode === after.inode
}

function assertCenterAbsent(manifest, lockfile, dump) {
  const dependencies = record(manifest.dependencies, 'Profile dependencies')
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || dependencies[CENTER_PACKAGE] !== undefined
    || bundles.includes(CENTER_PACKAGE) || lockfile.includes(CENTER_PACKAGE)
    || dump.includes('# == dsh-plugin-extension-center') || dump.includes('name: dsh-plugin-extension-center')) {
    fail('P0-RUNTIME-REMOVE', 'official CLI removal retained Center Profile state')
  }
}

async function installedProfile(dshBin, profileRoot, artifact, forbidden, cwd, environment) {
  const [manifestText, lockfile, dump] = await Promise.all([
    readFile(join(profileRoot, 'package.json'), 'utf8'),
    readFile(join(profileRoot, 'pnpm-lock.yaml'), 'utf8'),
    runChecked(dshBin, ['--profile', PROFILE_ID, '--dump-config'], { cwd, env: environment, timeoutMs: 60_000 }),
  ])
  const manifest = normalizedProfileManifest(JSON.parse(manifestText))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const dependency = manifest.dependencies[CENTER_PACKAGE]
  const installedRoot = await realpath(join(profileRoot, 'node_modules', CENTER_PACKAGE))
  const installedManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
  if (dependency !== `file:${artifact.source}` || !Array.isArray(bundles)
    || bundles.filter(value => value === CENTER_PACKAGE).length !== 1
    || installedManifest.name !== CENTER_PACKAGE || installedManifest.version !== artifact.version
    || !lockfile.includes(`specifier: file:${artifact.source}`)
    || !dump.includes('# == dsh-plugin-extension-center') || !dump.includes('name: dsh-plugin-extension-center')
    || forbidden !== null && (lockfile.includes(`file:${forbidden.source}`)
      || lockfile.includes(basename(forbidden.source)))) {
    fail('P0-RUNTIME-PROFILE', `official Profile did not select only ${CENTER_PACKAGE}@${artifact.version}`)
  }
  return Object.freeze({ dependency, installedVersion: installedManifest.version })
}

async function addCenter(dshBin, profileRoot, artifact, forbidden, cwd, environment) {
  await runChecked(dshBin, [
    'plugin', '--profile', PROFILE_ID, 'add', artifact.source,
    '--offline', '--ignore-scripts', '--save-exact',
  ], { cwd, env: environment, timeoutMs: 180_000 })
  return await installedProfile(dshBin, profileRoot, artifact, forbidden, cwd, environment)
}

async function startWeb(dshBin, cwd, environment) {
  const output = { value: '' }
  const child = spawn(dshBin, ['web', '--no-open', '--port', '0'], {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let origin
  try {
    origin = await waitForReadyUrl(child, output, 120_000)
  } catch (error) {
    await stopChild(child)
    throw error
  }
  const append = chunk => { output.value += chunk.toString() }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  await delay(250)
  return Object.freeze({ child, origin, output })
}

async function observeCatalogList(origin, child, label) {
  const deadline = Date.now() + 30_000
  let lastError
  for (let attempt = 1; ; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail('P0-RUNTIME-HOST-READY', `${label} Web Host exited before catalog/list registration was observed`)
    }
    const rpcId = `runtime-release-${label}-${String(attempt)}`
    try {
      const response = await fetch(new URL('/dsh-extension-center/catalog/list', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: 'catalog/list',
          payload: { protocolVersion: 1 },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok || response.redirected) throw new Error(`catalog/list returned HTTP ${String(response.status)}`)
      const parsed = parseCatalogListEnvelope(await response.json(), rpcId)
      return Object.freeze({
        rpcCatalogListRegistered: true,
        catalogRevision: parsed.catalog.revision,
        catalogEntriesDigest: parsed.catalog.entriesDigest,
      })
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      fail('P0-RUNTIME-RPC', `${label} catalog/list was not registered: ${sanitizeDiagnostic(lastError instanceof Error ? lastError.message : String(lastError))}`)
    }
    await delay(100)
  }
}

async function observeBrowser(origin, label) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    locale: 'en-US',
    serviceWorkers: 'block',
    viewport: { width: 1280, height: 900 },
  })
  const browserExternalRequests = []
  const browserExternalWebSockets = []
  const browserConsoleFailures = []
  let clientBundleRequested = false
  let clientEntryObserved = false
  try {
    await context.route('**/*', async route => {
      const request = route.request()
      if (!isAdmittedBrowserRequest(request.url(), origin)) {
        browserExternalRequests.push(request.url())
        await route.abort('blockedbyclient')
        return
      }
      if (new URL(request.url()).pathname === '/plugins/dsh-plugin-extension-center/client.js') {
        clientBundleRequested = true
      }
      await route.continue()
    })
    await context.routeWebSocket('**/*', async websocket => {
      if (isAdmittedBrowserWebSocket(websocket.url(), origin)) {
        websocket.connectToServer()
        return
      }
      browserExternalWebSockets.push(websocket.url())
      await websocket.close({ code: 1008, reason: 'external browser network denied by runtime release acceptance' })
    })
    const page = await context.newPage()
    page.on('pageerror', error => browserConsoleFailures.push(`pageerror: ${error.message}`))
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') {
        browserConsoleFailures.push(`${message.type()}: ${message.text()}`)
      }
    })
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(
      pluginId => globalThis.__DSH_BOOT__?.entries?.some(entry => entry.id === pluginId) === true,
      CENTER_PACKAGE,
      { timeout: 30_000 },
    )
    const entryCount = await page.evaluate(
      pluginId => globalThis.__DSH_BOOT__?.entries?.filter(entry => entry.id === pluginId).length ?? 0,
      CENTER_PACKAGE,
    )
    await page.waitForTimeout(250)
    if (entryCount !== 1 || !clientBundleRequested) {
      fail('P0-RUNTIME-CLIENT', `${label} did not load one exact __DSH_BOOT__ Client entry and bundle`)
    }
    clientEntryObserved = true
  } finally {
    await context.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
  if (browserExternalRequests.length > 0 || browserExternalWebSockets.length > 0) {
    fail('P0-RUNTIME-BROWSER-NETWORK', `${label} browser attempted non-loopback network traffic`)
  }
  if (browserConsoleFailures.length > 0) {
    fail('P0-RUNTIME-BROWSER-CONSOLE', `${label} browser reported console failures`)
  }
  return Object.freeze({
    clientEntryObserved,
    clientBundleRequested: true,
    browserExternalRequests: Object.freeze([]),
    browserExternalWebSockets: Object.freeze([]),
    browserConsoleFailures: Object.freeze([]),
  })
}

async function observeArtifactBoot(dshBin, artifact, cwd, environment, label) {
  let web
  try {
    web = await startWeb(dshBin, cwd, environment)
    const rpc = await observeCatalogList(web.origin, web.child, label)
    const browser = await observeBrowser(web.origin, label)
    if (web.child.exitCode !== null || web.child.signalCode !== null) {
      fail('P0-RUNTIME-HOST-READY', `${label} Web Host terminated before observation completed`)
    }
    return Object.freeze({
      version: artifact.version,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      manifestSha256: artifact.manifestSha256,
      sourceCommit: artifact.commit,
      hostReady: true,
      ...browser,
      ...rpc,
    })
  } finally {
    await stopChild(web?.child)
  }
}

async function prepareReceiptDestination(path, artifacts) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const destination = join(await realpath(dirname(path)), basename(path))
  for (const artifact of artifacts) {
    if (await realpath(artifact.source) === destination) fail('P0-RUNTIME-RECEIPT', 'receipt aliases an artifact input')
  }
  try {
    await lstat(destination)
    fail('P0-RUNTIME-RECEIPT', 'receipt output already exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return destination
}

async function writeReceipt(destination, receipt) {
  const temporary = join(dirname(destination), `.runtime-release-${randomUUID()}`)
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  try {
    await link(temporary, destination)
  } catch (error) {
    if (error?.code === 'EEXIST') fail('P0-RUNTIME-RECEIPT', 'receipt output appeared concurrently')
    throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** Run one same-Profile official rc.2 Host, Client, RPC, update, and removal acceptance. */
export async function runRuntimeReleaseAcceptance(inputValue) {
  if (process.platform === 'win32') fail('P0-RUNTIME-PLATFORM', 'runtime release acceptance currently requires POSIX')
  const input = record(inputValue, 'runtime release input')
  const baseEnv = keylessEnvironment({
    ...process.env,
    DSH_TELEMETRY_MODE: 'DISABLED',
    NO_COLOR: '1',
    LC_ALL: 'C',
  })
  if (hasBlockedCredentialEnvironment(baseEnv) || hasProviderEndpointOverride(baseEnv)) {
    fail('P0-RUNTIME-ISOLATION', 'runtime release acceptance inherited credentials or provider endpoint overrides')
  }
  const previous = input.previous === null ? null : await inspectArtifact(input.previous, baseEnv)
  const current = await inspectArtifact(input.current, baseEnv)
  const ciAcceptance = await loadGitHubCiArtifactReceipt(input.ciReceipt, current)
  const receiptPath = await prepareReceiptDestination(
    resolve(bounded(input.receiptPath, 'receipt path')),
    previous === null ? [current] : [previous, current],
  )
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-extension-center-runtime-release-')))
  let receipt
  try {
    const workspace = join(tempRoot, 'workspace')
    const hostRoot = join(tempRoot, 'official-host')
    const dshHome = join(tempRoot, 'dsh-home')
    const agentsHome = join(tempRoot, 'agents-home')
    await Promise.all([
      mkdir(workspace, { mode: 0o700 }),
      mkdir(dshHome, { mode: 0o700 }),
      mkdir(agentsHome, { mode: 0o700 }),
    ])
    const environment = Object.freeze({
      ...baseEnv,
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: agentsHome,
    })
    const official = await installOfficialDshHost({
      hostRoot,
      projectRoot,
      cwd: workspace,
      env: environment,
    })
    const packageTreeDigestBefore = official.packageTreeDigest
    await runChecked(official.dshBin, [
      'plugin', '--profile', PROFILE_ID, 'install', '--offline', '--ignore-scripts',
    ], { cwd: workspace, env: environment, timeoutMs: 180_000 })
    const profileRoot = await realpath(join(dshHome, 'profiles', PROFILE_ID))
    const profileBefore = await profileIdentity(profileRoot)
    const baseline = await profileBaseline(official.dshBin, profileRoot, workspace, environment)

    let previousObservation = null
    let previousInstallation = null
    if (previous !== null) {
      previousInstallation = await addCenter(
        official.dshBin, profileRoot, previous, null, workspace, environment,
      )
      previousObservation = await observeArtifactBoot(
        official.dshBin, previous, workspace, environment, 'previous',
      )
    }
    const currentInstallation = await addCenter(
      official.dshBin, profileRoot, current, previous, workspace, environment,
    )
    const officialCliUpdate = previous === null ? null
      : previousInstallation?.dependency !== currentInstallation.dependency
        && previousInstallation?.installedVersion === previous.version
        && currentInstallation.installedVersion === current.version
    if (previous !== null && officialCliUpdate !== true) {
      fail('P0-RUNTIME-PROFILE', 'official CLI did not update the same Profile from previous to current')
    }
    const sameProfile = sameProfileIdentity(profileBefore, await profileIdentity(profileRoot))
    if (!sameProfile) fail('P0-RUNTIME-PROFILE', 'official CLI replaced the selected Profile root during update')
    const currentObservation = await observeArtifactBoot(
      official.dshBin, current, workspace, environment, 'current',
    )
    await runChecked(official.dshBin, [
      'plugin', '--profile', PROFILE_ID, 'remove', CENTER_PACKAGE, '--ignore-scripts',
    ], { cwd: workspace, env: environment, timeoutMs: 180_000 })
    await assertRemoved(official.dshBin, profileRoot, baseline, workspace, environment)
    const packageTreeDigestAfter = await immutablePackageTreeDigest(official.packageRoot)
    receipt = buildRuntimeAcceptanceReceipt({
      previous,
      current,
      ciAcceptance,
      previousObservation,
      currentObservation,
      official: {
        version: official.version,
        registry: official.registry,
        registryIntegrity: official.registryIntegrity,
        packageTreeDigestBefore,
        packageTreeDigestAfter,
      },
      profile: {
        profileId: PROFILE_ID,
        sameProfile,
        officialCliUpdate,
        removalExactBaselineRestored: true,
      },
    })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
  await writeReceipt(receiptPath, receipt)
  return receipt
}

async function main() {
  try {
    const parsed = parseRuntimeReleaseArguments(process.argv.slice(2))
    if (parsed.help) {
      process.stdout.write(USAGE)
      return 0
    }
    await runRuntimeReleaseAcceptance(parsed)
    process.stdout.write(`runtime release acceptance passed; receipt=${parsed.receiptPath}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`)
    process.stderr.write(USAGE)
    return 1
  }
}

if (process.argv[1] !== undefined && await realpath(resolve(process.argv[1])).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  process.exitCode = await main()
}
