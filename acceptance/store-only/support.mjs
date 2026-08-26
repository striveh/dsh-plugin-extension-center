import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

/** Exact published Host package used by the first Store Acceptance Red. */
export const TARGET_DSH_VERSION = '0.1.1-rc.2'

/** Source commit from which the exact published Host contract was audited. */
export const TARGET_DSH_COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'

/** Stable first failure expected before the Extension Store is implemented. */
export const STORE_SURFACE_MISSING = 'RED-B-STORE-SURFACE-MISSING'

/** Stable product failure after an entry exists without the Store-default shell. */
export const STORE_SHELL_MISSING = 'RED-B-STORE-SHELL-MISSING'

/** Stable failure for a browser or Host request that leaves loopback. */
export const EXTERNAL_NETWORK_OBSERVED = 'RED-B-EXTERNAL-NETWORK'

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
    throw new AcceptanceFailure('RED-B-NON-LOOPBACK-WEB', `DSH Web announced a non-loopback URL: ${url.href}`)
  }
  return url.origin
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
      if (error?.code === 'ESRCH') return
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
 * @returns {Promise<void>} Completion after graceful or forced termination.
 */
export async function stopChild(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  const gracefulClose = waitForChildClose(child, 8_000)
  child.kill('SIGTERM')
  if (await gracefulClose) return
  if (child.exitCode !== null || child.signalCode !== null) return
  const forcedClose = waitForChildClose(child, 2_000)
  child.kill('SIGKILL')
  if (await forcedClose || child.exitCode !== null || child.signalCode !== null) return
  throw new Error('spawned DSH Web process did not terminate after SIGKILL')
}

/** Wait a bounded interval for a child close event without losing an already terminal state. */
function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
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
