import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

/** Exact latest tagged, unmodified Host package used by compatibility acceptance. */
export const TARGET_DSH_VERSION = '0.1.2-alpha.3'

/** Registry integrity of the exact published Host package admitted by both packed lanes. */
export const TARGET_DSH_REGISTRY_INTEGRITY = 'sha512-VvATzYmQ4LMJREJ9e2POKksSHRfqP3y9pghplLBaQBuw2BqfbC0mQUVsaPwxe4wlcpj+riEgn8OJB01YnpF+3A=='

/** Registry used to resolve the independently installed official Host. */
export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/'

/** Source commit from which the exact published Host contract was audited. */
export const TARGET_DSH_COMMIT = 'dd6322d604e00eec1ba5e0c8541159906a21094a'

/** Stable failure when the packed Client does not expose the Store entry. */
export const STORE_UI_SURFACE_MISSING = 'STORE-UI-SURFACE-MISSING'

/** Stable failure when the Store entry does not provide its ordinary-user shell. */
export const STORE_UI_SHELL_MISSING = 'STORE-UI-SHELL-MISSING'

/** Stable failure for a browser or Host request that leaves loopback. */
export const STORE_UI_EXTERNAL_NETWORK_OBSERVED = 'STORE-UI-EXTERNAL-NETWORK'

/** Error with a stable acceptance code. */
export class AcceptanceFailure extends Error {
  /**
   * @param {string} code Stable acceptance failure code.
   * @param {string} message Human-readable evidence.
   */
  constructor(code, message) {
    super(`[${code}] ${message}`)
    this.name = 'AcceptanceFailure'
    this.code = code
  }
}

/**
 * Extract one exact package integrity from a pnpm lockfile.
 * @param {string} lockfile Generated pnpm lockfile text.
 * @param {string} packageName Exact package name.
 * @param {string} version Exact package version.
 * @returns {string} Registry integrity bound to the package snapshot.
 */
export function parsePnpmRegistryIntegrity(lockfile, packageName, version) {
  if (typeof lockfile !== 'string' || typeof packageName !== 'string' || typeof version !== 'string'
    || packageName.length === 0 || version.length === 0) {
    throw new TypeError('pnpm registry integrity lookup requires non-empty strings')
  }
  const escaped = `${packageName}@${version}`.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const matches = [...lockfile.matchAll(
    new RegExp(`^  ['"]?${escaped}['"]?:\\r?\\n(?: {4}[^\\r\\n]*\\r?\\n){0,8}? {4}resolution: \\{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\\}$`, 'gmu'),
  )]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new AcceptanceFailure(
      'OFFICIAL-HOST-LOCK-INTEGRITY',
      `pnpm lockfile did not contain exactly one registry integrity for ${packageName}@${version}`,
    )
  }
  return matches[0][1]
}

/**
 * Require the Host executable and package to resolve inside the isolated root and outside the source project.
 * @param {{hostRoot: string, projectRoot: string, dshBin: string, packageRoot: string}} paths Candidate paths.
 */
export function assertIsolatedOfficialHostPaths(paths) {
  const hostRoot = resolve(paths.hostRoot)
  const projectRoot = resolve(paths.projectRoot)
  for (const [label, path] of [['DSH executable', paths.dshBin], ['DSH package', paths.packageRoot]]) {
    const resolved = resolve(path)
    if (!isInside(hostRoot, resolved) || isInside(projectRoot, resolved)) {
      throw new AcceptanceFailure(
        'OFFICIAL-HOST-NOT-ISOLATED',
        `${label} did not resolve inside the independent temporary Host root`,
      )
    }
  }
}

/**
 * Install and identify the exact official DSH package in an independent temporary project.
 * @param {{hostRoot: string, projectRoot: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number}} options Installation options.
 * @returns {Promise<{dshBin: string, packageRoot: string, registry: string, registryIntegrity: string, packageTreeDigest: string, version: string}>} Bound Host identity.
 */
export async function installOfficialDshHost(options) {
  await mkdir(options.hostRoot, { recursive: false, mode: 0o700 })
  await writeFile(join(options.hostRoot, 'package.json'), `${JSON.stringify({ private: true }, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  await runChecked('pnpm', [
    '--dir', options.hostRoot,
    'add', `@deepseek-ai/dsh@${TARGET_DSH_VERSION}`,
    '--save-exact', '--ignore-scripts',
    '--config.enable-global-virtual-store=false',
    `--registry=${OFFICIAL_NPM_REGISTRY}`,
  ], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? 240_000,
  })
  const lockfile = await readFile(join(options.hostRoot, 'pnpm-lock.yaml'), 'utf8')
  const registryIntegrity = parsePnpmRegistryIntegrity(lockfile, '@deepseek-ai/dsh', TARGET_DSH_VERSION)
  if (registryIntegrity !== TARGET_DSH_REGISTRY_INTEGRITY) {
    throw new AcceptanceFailure(
      'OFFICIAL-HOST-REGISTRY-INTEGRITY',
      `official DSH registry integrity changed: ${registryIntegrity}`,
    )
  }
  const packageRoot = await realpath(join(options.hostRoot, 'node_modules', '@deepseek-ai', 'dsh'))
  const dshBin = await realpath(join(options.hostRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'))
  assertIsolatedOfficialHostPaths({
    hostRoot: await realpath(options.hostRoot),
    projectRoot: await realpath(options.projectRoot),
    dshBin,
    packageRoot,
    registry: OFFICIAL_NPM_REGISTRY,
  })
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== TARGET_DSH_VERSION || manifest.bin?.dsh !== 'lib/bin.js') {
    throw new AcceptanceFailure(
      'OFFICIAL-HOST-PACKAGE-IDENTITY',
      'installed Host manifest did not match the admitted official DSH package identity',
    )
  }
  return Object.freeze({
    dshBin,
    packageRoot,
    registry: OFFICIAL_NPM_REGISTRY,
    registryIntegrity,
    packageTreeDigest: await immutablePackageTreeDigest(packageRoot),
    version: manifest.version,
  })
}

/**
 * Hash one package tree without following nested symbolic links.
 * @param {string} packageRoot Real package directory.
 * @returns {Promise<string>} SHA-256 content-tree digest.
 */
export async function immutablePackageTreeDigest(packageRoot) {
  const root = await realpath(packageRoot)
  const hash = createHash('sha256')
  await hashImmutableTree(root, root, hash)
  return `sha256:${hash.digest('hex')}`
}

/**
 * Return whether a browser request stays on the exact Web origin or uses a non-network URL.
 * @param {string} requestUrl Browser request URL.
 * @param {string} webOrigin Exact loopback Web origin.
 * @returns {boolean} Whether the request is admitted by the Store-only lane.
 */
export function isAdmittedBrowserRequest(requestUrl, webOrigin) {
  const request = new URL(requestUrl)
  if (request.protocol === 'data:' || request.protocol === 'blob:') return true
  return request.origin === webOrigin
}

/**
 * Return whether a browser WebSocket stays on the Web server's loopback endpoint.
 * @param {string} requestUrl Browser WebSocket URL.
 * @param {string} webOrigin Exact loopback HTTP Web origin.
 * @returns {boolean} Whether the WebSocket is admitted by the Store-only lane.
 */
export function isAdmittedBrowserWebSocket(requestUrl, webOrigin) {
  const expected = new URL(webOrigin)
  expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:'
  return new URL(requestUrl).origin === expected.origin
}

/** Return whether one initial combo-script request contains the exact client bundle. */
export function comboUrlContainsClientBundle(requestUrl, packageName) {
  const url = new URL(requestUrl)
  if (url.pathname !== '/plugins/' || !url.search.startsWith('??')) return false
  const resources = url.search.slice(2).split('&', 1)[0]?.split(',') ?? []
  return resources.includes(`${packageName}/client.js`)
}

/**
 * Parse the only browser-to-Host WebSocket messages admitted during read-only Store acceptance.
 * @param {string | Buffer} payload Playwright frame payload.
 * @returns {{type: 'open', streamId: string, endpoint: string} | {type: 'cancel', streamId: string} | null} Exact official Connection frame, or null.
 */
export function parseAdmittedConnectionFrame(payload) {
  if (typeof payload !== 'string') return null
  let value
  try {
    value = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  if (value.type === 'cancel'
    && keys.length === 2
    && keys[0] === 'streamId'
    && keys[1] === 'type'
    && typeof value.streamId === 'string'
    && value.streamId.length > 0) {
    return { type: 'cancel', streamId: value.streamId }
  }
  if (value.type !== 'open'
    || keys.length !== 4
    || keys[0] !== 'endpoint'
    || keys[1] !== 'payload'
    || keys[2] !== 'streamId'
    || keys[3] !== 'type'
    || typeof value.streamId !== 'string'
    || value.streamId.length === 0
    || !['$events', 'workspace/follow', 'session/control'].includes(value.endpoint)
    || typeof value.payload !== 'object'
    || value.payload === null
    || Array.isArray(value.payload)
    || Object.keys(value.payload).length !== 1
    || typeof value.payload.args !== 'object'
    || value.payload.args === null
    || Array.isArray(value.payload.args)
    || Object.keys(value.payload.args).length !== 0) {
    return null
  }
  return { type: 'open', streamId: value.streamId, endpoint: value.endpoint }
}

/** Describe only the closed wire category of a rejected frame without retaining ids or payload data. */
export function describeUnadmittedConnectionFrame(payload) {
  if (typeof payload !== 'string') return 'binary-frame'
  let value
  try {
    value = JSON.parse(payload)
  } catch {
    return 'non-json-text-frame'
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'non-object-json-frame'
  if (value.type === 'open') return value.endpoint === '$events' ? 'invalid-events-open-frame' : 'other-stream-open-frame'
  if (value.type === 'cancel') return 'invalid-or-unowned-cancel-frame'
  return 'unknown-json-frame'
}

/**
 * Reduce a network target to a value-free destination for persisted evidence.
 * @param {string} target URL or CONNECT authority.
 * @returns {string} Scheme and authority, or a hash for an unparseable target.
 */
export function describeNetworkDestination(target) {
  try {
    const url = new URL(target)
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return url.origin
    if (target.includes('://')) return `${url.protocol}[redacted]`
  } catch {
    // A CONNECT authority is intentionally parsed below without URL values.
  }
  try {
    const authority = new URL(`http://${target}`)
    if (authority.hostname !== '') return `authority://${authority.host}`
  } catch {
    // The opaque fallback below cannot expose userinfo, paths, or query values.
  }
  return `opaque-sha256:${createHash('sha256').update(target).digest('hex')}`
}

/**
 * Remove credential-like assignments and URL values from persisted diagnostics.
 * @param {string} diagnostic Untrusted process or browser diagnostic.
 * @returns {string} Value-free diagnostic text.
 */
export function sanitizeDiagnostic(diagnostic) {
  return diagnostic
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gu, match => describeNetworkDestination(match))
    .replace(
      /(\b(?:(?:[a-z0-9]+_)*(?:api_key|access_token|auth_token|password|secret)|api[-_]?key|access[-_]?token|auth[-_]?token)\b\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1[redacted]',
    )
    .replace(/(\b(?:authorization|proxy-authorization)\s*:\s*)(?:bearer\s+)?[^\s,;]+/giu, '$1[redacted]')
    .replace(/(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/giu, '$1[redacted]')
}

/**
 * Parse the canonical loopback URL printed after the Web Loader tree settles.
 * @param {string} output Combined DSH stdout and stderr.
 * @returns {string | undefined} Ready URL when present.
 */
export function parseReadyUrl(output) {
  const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
  if (match?.[1] === undefined) return undefined
  const url = new URL(match[1])
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '') {
    throw new AcceptanceFailure('STORE-UI-NON-LOOPBACK-WEB', `DSH Web announced a non-loopback URL: ${url.href}`)
  }
  return url.origin
}

/**
 * Parse the one-time authenticated launch URL announced by current official DSH Web.
 * @param {string} output Combined DSH stdout and stderr.
 * @returns {string} Exact in-memory launch URL, including its one-time token.
 */
export function parseAuthenticatedLaunchUrl(output) {
  const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
  if (match?.[1] === undefined) {
    throw new AcceptanceFailure(
      'STORE-UI-HOST-AUTH-URL',
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
    throw new AcceptanceFailure(
      'STORE-UI-HOST-AUTH-URL',
      'official Web Host announced an invalid authenticated loopback launch URL',
    )
  }
  return url.href
}

/**
 * Derive every independent post-remove absence check from persisted CLI and Profile state.
 * @param {{manifest: object, packageName: string, packagePresent: boolean, listStdout: string, dumpStdout: string, dumpStderr: string}} input Observed post-remove state.
 * @returns {{profileDependencyAbsent: boolean, profileBundleAbsent: boolean, profilePackageAbsent: boolean, pluginListAbsent: boolean, bundleLayerAbsent: boolean, dumpHasNoPatchResidue: boolean}} Closed evidence fields.
 */
export function removedProfileEvidence(input) {
  const manifest = input.manifest
  return Object.freeze({
    profileDependencyAbsent: manifest.dependencies?.[input.packageName] === undefined,
    profileBundleAbsent: !manifest.dsh?.profile?.bundles?.includes(input.packageName),
    profilePackageAbsent: !input.packagePresent,
    pluginListAbsent: !input.listStdout.includes(input.packageName),
    bundleLayerAbsent: !input.dumpStdout.includes(`# == ${input.packageName}`)
      && !input.dumpStdout.includes(`name: ${input.packageName}`)
      && !input.dumpStdout.includes(`name: '${input.packageName}'`),
    dumpHasNoPatchResidue: !input.dumpStderr.includes(input.packageName)
      && !input.dumpStderr.includes('patch: entry'),
  })
}

/** Return the first retained post-remove state, or null when all independent checks pass. */
export function removedProfileEvidenceError(evidence) {
  for (const [field, absent] of Object.entries(evidence)) {
    if (absent !== true) return `official Plugin CLI did not prove ${field}`
  }
  return null
}

/**
 * Run a bounded subprocess and retain both output streams.
 * @param {string} command Executable path.
 * @param {string[]} args Exact argv.
 * @param {{cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number, terminationGraceMs?: number, killCloseMs?: number}} options Process options.
 * @returns {Promise<{stdout: string, stderr: string}>} Captured output.
 */
export function runChecked(command, args, options) {
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
    let rejectTimer
    const settle = callback => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(forceTimer)
      clearTimeout(rejectTimer)
      callback()
    }
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      signalChildTree(child, 'SIGTERM')
      forceTimer = setTimeout(() => {
        signalChildTree(child, 'SIGKILL')
        rejectTimer = setTimeout(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          settle(() => rejectRun(new Error(`${command} timed out and did not close after SIGKILL (stdoutBytes=${String(Buffer.byteLength(stdout))}, stderrBytes=${String(Buffer.byteLength(stderr))})`)))
        }, options.killCloseMs ?? 2_000)
      }, options.terminationGraceMs ?? 5_000)
    }, options.timeoutMs ?? 120_000)
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', error => {
      settle(() => rejectRun(error))
    })
    child.once('close', (code, signal) => {
      if (timedOut) {
        settle(() => rejectRun(new Error(`${command} timed out (stdoutBytes=${String(Buffer.byteLength(stdout))}, stderrBytes=${String(Buffer.byteLength(stderr))})`)))
        return
      }
      if (code !== 0) {
        settle(() => rejectRun(new Error(`${command} exited with ${signal ?? String(code)} (stdoutBytes=${String(Buffer.byteLength(stdout))}, stderrBytes=${String(Buffer.byteLength(stderr))})`)))
        return
      }
      settle(() => resolveRun({ stdout, stderr }))
    })
  })
}

/** Signal the exact spawned process group on POSIX, or the child on Windows. */
function signalChildTree(child, signal) {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  child.kill(signal)
}

/**
 * Wait until a spawned Web process announces its settled loopback URL.
 * @param {import('node:child_process').ChildProcess} child Spawned DSH Web process.
 * @param {{value: string}} output Mutable combined-output holder.
 * @param {number} timeoutMs Maximum wait.
 * @returns {Promise<string>} Exact Web origin.
 */
export function waitForReadyUrl(child, output, timeoutMs = 90_000) {
  return new Promise((resolveReady, rejectReady) => {
    const existing = parseReadyUrl(output.value)
    if (existing !== undefined) {
      resolveReady(existing)
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      rejectReady(new Error(`dsh web did not become ready in ${String(timeoutMs)}ms\n${output.value}`))
    }, timeoutMs)
    const onData = chunk => {
      output.value += chunk.toString()
      let ready
      try {
        ready = parseReadyUrl(output.value)
      } catch (error) {
        cleanup()
        rejectReady(error)
        return
      }
      if (ready === undefined) return
      cleanup()
      resolveReady(ready)
    }
    const onExit = (code, signal) => {
      cleanup()
      rejectReady(new Error(`dsh web exited before readiness (${signal ?? String(code)})\n${output.value}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', onExit)
  })
}

/**
 * Stop a child process and wait for its close event.
 * @param {import('node:child_process').ChildProcess | undefined} child Process to stop.
 * @param {{requireRunning?: boolean, requireGraceful?: boolean, gracefulTimeoutMs?: number, killTimeoutMs?: number}} [options] Passing-lane shutdown requirements.
 * @returns {Promise<{wasRunning: boolean, forced: boolean, closeObserved: boolean, exitCode: number | null, signalCode: NodeJS.Signals | null}>} Terminal process evidence.
 */
export async function stopChild(child, options = {}) {
  if (child === undefined) {
    if (options.requireRunning === true) throw new Error('spawned DSH Web process was absent before shutdown')
    return { wasRunning: false, forced: false, closeObserved: false, exitCode: null, signalCode: null }
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    let forced = false
    if (!childCloseAlreadyObserved(child)) {
      const forcedClose = waitForChildClose(child, options.killTimeoutMs ?? 2_000)
      signalChildTree(child, 'SIGKILL')
      if (!await forcedClose) throw new Error('spawned DSH Web process did not close after SIGKILL')
      forced = true
    }
    if (options.requireRunning === true) throw new Error('spawned DSH Web process exited before runner-owned shutdown')
    return { wasRunning: false, forced, closeObserved: true, exitCode: child.exitCode, signalCode: child.signalCode }
  }
  const gracefulClose = waitForChildClose(child, options.gracefulTimeoutMs ?? 8_000)
  signalChildTree(child, 'SIGTERM')
  if (await gracefulClose) {
    const result = { wasRunning: true, forced: false, closeObserved: true, exitCode: child.exitCode, signalCode: child.signalCode }
    if (options.requireGraceful === true && (result.exitCode !== 0 || result.signalCode !== null)) {
      throw new Error(`spawned DSH Web process did not close gracefully (${result.signalCode ?? String(result.exitCode)})`)
    }
    return result
  }
  const forcedClose = waitForChildClose(child, options.killTimeoutMs ?? 2_000)
  signalChildTree(child, 'SIGKILL')
  if (!await forcedClose) throw new Error('spawned DSH Web process did not close after SIGKILL')
  if (options.requireGraceful === true) throw new Error('spawned DSH Web process required SIGKILL during runner-owned shutdown')
  return { wasRunning: true, forced: true, closeObserved: true, exitCode: child.exitCode, signalCode: child.signalCode }
}

/** Return whether the direct child and each owned stdio stream have reached terminal state. */
function childCloseAlreadyObserved(child) {
  return (child.exitCode !== null || child.signalCode !== null)
    && child.stdio.every(stream => stream === null || stream.closed === true)
}

/** Wait a bounded interval for the child and its inherited stdio handles to close. */
function waitForChildClose(child, timeoutMs) {
  if (childCloseAlreadyObserved(child)) return Promise.resolve(true)
  return new Promise(resolveClose => {
    const onClose = () => {
      clearTimeout(timer)
      resolveClose(true)
    }
    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolveClose(false)
    }, timeoutMs)
    child.once('close', onClose)
  })
}

function isInside(root, path) {
  const offset = relative(root, path)
  return offset === '' || offset !== '..' && !offset.startsWith(`..${sep}`)
}

async function hashImmutableTree(root, path, hash) {
  const info = await lstat(path)
  const name = relative(root, path).replaceAll('\\', '/') || '.'
  const mode = (info.mode & 0o7777).toString(8)
  if (info.isSymbolicLink()) {
    hash.update(`link:${name}:${mode}:${await readlink(path)}\0`)
    return
  }
  if (info.isFile()) {
    hash.update(`file:${name}:${mode}:${String(info.size)}\0`)
    hash.update(await readFile(path))
    return
  }
  if (!info.isDirectory()) {
    hash.update(`other:${name}:${mode}\0`)
    return
  }
  hash.update(`dir:${name}:${mode}\0`)
  const entries = (await readdir(path, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) await hashImmutableTree(root, join(path, entry.name), hash)
}
