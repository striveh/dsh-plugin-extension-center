import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, watch } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AcceptanceFailure } from './support.mjs'
import { canonicalSha256 } from './receipt-binding.mjs'

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const MAX_OUTPUT_BYTES = 64 * 1024

function fail(code, message) {
  throw new AcceptanceFailure(code, message)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('P0-CONTROLLED-ABA-INPUT', `${label} must be an object`)
  }
  return value
}

function bounded(value, label, maximum = 4_096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    fail('P0-CONTROLLED-ABA-INPUT', `${label} must be a bounded non-empty string`)
  }
  return value
}

function safePackageName(value) {
  const name = bounded(value, 'managed child Plugin package name', 214)
  if (!PACKAGE_NAME.test(name) || name === '.' || name === '..' || name === 'dsh-plugin-extension-center') {
    fail('P0-CONTROLLED-ABA-INPUT', 'managed child Plugin package name is unsafe')
  }
  return name
}

function safeProfileId(value) {
  const profileId = bounded(value, 'Profile id', 256)
  if (profileId.includes('/') || profileId.includes('\\') || profileId.includes(':') || profileId.startsWith('-')
    || /[\u0000-\u001f\u007f]/u.test(profileId) || ['.', '..', 'node_modules'].includes(profileId)) {
    fail('P0-CONTROLLED-ABA-INPUT', 'Profile id is unsafe')
  }
  return profileId
}

function storageKey(value) {
  return createHash('sha256').update(value).digest('hex')
}

function appendBounded(current, chunk) {
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current)
  return remaining <= 0 ? current : current + chunk.subarray(0, remaining).toString()
}

function requirePosix() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    fail('P0-CONTROLLED-ABA-UNSUPPORTED', 'controlled SIGSTOP/SIGCONT acceptance is POSIX-only')
  }
}

function psPath() {
  return process.platform === 'darwin' ? '/bin/ps' : '/usr/bin/ps'
}

/**
 * Decode a Center execution lease without trusting its file name or caller.
 * @param {unknown} ownerValue Parsed owner.json.
 * @param {unknown} executionValue Parsed execution.json.
 * @param {{profileId: string, hostPid: number}} expected Expected live Host identity.
 * @returns {{ownerId: string, leaseId: string, hostPid: number, hostProcessIdentityDigest: string, processGroupPid: number, supervisorSha256: string, startedAtMs: number, executionDigest: string}} Bound execution identity.
 */
export function decodeControlledAbaLease(ownerValue, executionValue, expected) {
  const owner = record(ownerValue, 'Center Profile lease owner')
  const execution = record(executionValue, 'Center Profile execution lease')
  const identity = record(owner.processIdentity, 'Center Profile lease process identity')
  const expectedOwnerKeys = [
    'acquiredAtMs', 'leaseId', 'ownerId', 'processIdentity', 'profileId', 'schemaVersion',
  ]
  const expectedIdentityKeys = [
    'birthDigest', 'bootDigest', 'machineDigest', 'pid', 'platform', 'schemaVersion',
  ]
  const expectedExecutionKeys = [
    'ownerId', 'parentPid', 'processGroupPid', 'profileId', 'schemaVersion', 'startedAtMs', 'supervisorSha256',
  ]
  if (Object.keys(owner).sort().join(',') !== expectedOwnerKeys.sort().join(',')
    || Object.keys(identity).sort().join(',') !== expectedIdentityKeys.sort().join(',')
    || Object.keys(execution).sort().join(',') !== expectedExecutionKeys.sort().join(',')) {
    fail('P0-CONTROLLED-ABA-LEASE', 'Center execution lease fields are invalid')
  }
  const validIdentityDigest = value => value === null || typeof value === 'string' && SHA256.test(value)
  if (owner.schemaVersion !== 2 || owner.profileId !== expected.profileId
    || typeof owner.ownerId !== 'string' || owner.ownerId.length === 0 || !Number.isSafeInteger(owner.acquiredAtMs)
    || typeof owner.leaseId !== 'string' || !/^lease:[0-9a-f-]{36}$/u.test(owner.leaseId)
    || identity.schemaVersion !== 1 || identity.pid !== expected.hostPid || identity.platform !== process.platform
    || !validIdentityDigest(identity.machineDigest) || !validIdentityDigest(identity.bootDigest)
    || !validIdentityDigest(identity.birthDigest)
    || execution.schemaVersion !== 1 || execution.profileId !== expected.profileId
    || execution.ownerId !== owner.ownerId || execution.parentPid !== expected.hostPid
    || !Number.isSafeInteger(execution.processGroupPid) || execution.processGroupPid < 1
    || !Number.isSafeInteger(execution.startedAtMs) || typeof execution.supervisorSha256 !== 'string'
    || !SHA256.test(execution.supervisorSha256)) {
    fail('P0-CONTROLLED-ABA-LEASE', 'Center execution lease does not bind the selected live Host and Profile')
  }
  const hostProcessIdentityDigest = `sha256:${createHash('sha256').update(JSON.stringify({
    schemaVersion: identity.schemaVersion,
    pid: identity.pid,
    platform: identity.platform,
    machineDigest: identity.machineDigest,
    bootDigest: identity.bootDigest,
    birthDigest: identity.birthDigest,
  })).digest('hex')}`
  return Object.freeze({
    ownerId: owner.ownerId,
    leaseId: owner.leaseId,
    hostPid: expected.hostPid,
    hostProcessIdentityDigest,
    processGroupPid: execution.processGroupPid,
    supervisorSha256: execution.supervisorSha256,
    startedAtMs: execution.startedAtMs,
    executionDigest: canonicalSha256(execution),
  })
}

/**
 * Bind the durable supervisor dispatch marker to its exact execution lease.
 * @param {unknown} value Parsed execution-dispatch.json.
 * @param {{profileId: string, ownerId: string, leaseId: string, processGroupPid: number, executionDigest: string}} expected Bound execution identity.
 * @returns {number} Time at which the Host observed the completed START pipe write.
 */
export function decodeControlledAbaDispatch(value, expected) {
  const dispatch = record(value, 'Center Profile execution dispatch')
  const keys = [
    'dispatchedAtMs', 'executionDigest', 'leaseId', 'ownerId', 'processGroupPid', 'profileId', 'schemaVersion',
  ]
  if (Object.keys(dispatch).sort().join(',') !== keys.sort().join(',')
    || dispatch.schemaVersion !== 1 || dispatch.profileId !== expected.profileId
    || dispatch.ownerId !== expected.ownerId || dispatch.leaseId !== expected.leaseId
    || dispatch.processGroupPid !== expected.processGroupPid || dispatch.executionDigest !== expected.executionDigest
    || !Number.isSafeInteger(dispatch.dispatchedAtMs)) {
    fail('P0-CONTROLLED-ABA-DISPATCH', 'Center execution dispatch does not bind the stopped official CLI group')
  }
  return dispatch.dispatchedAtMs
}

/**
 * Parse the numeric fields from `ps -axo pid=,ppid=,pgid=,state=` output.
 * @param {string} output Process table output.
 * @returns {readonly {pid: number, ppid: number, pgid: number, state: string}[]} Parsed rows.
 */
export function parseControlledAbaProcessTable(output) {
  if (typeof output !== 'string') fail('P0-CONTROLLED-ABA-PROCESS', 'process table output must be text')
  const rows = []
  for (const [index, line] of output.split(/\r?\n/u).entries()) {
    if (line.trim() === '') continue
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line)
    if (match === null) fail('P0-CONTROLLED-ABA-PROCESS', `process table row ${String(index + 1)} is invalid`)
    rows.push(Object.freeze({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      state: match[4],
    }))
  }
  return Object.freeze(rows)
}

/** Return true when a detached group has exited or contains only unreaped zombies. */
export function controlledAbaProcessGroupQuiescent(rows, processGroupPid) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(processGroupPid) || processGroupPid < 1) {
    fail('P0-CONTROLLED-ABA-PROCESS', 'process-group quiescence input is invalid')
  }
  return rows.filter(row => row.pgid === processGroupPid).every(row => row.state.startsWith('Z'))
}

/** Return true only while a detached group still has a stopped, non-zombie process and no running process. */
export function controlledAbaProcessGroupStopped(rows, processGroupPid) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(processGroupPid) || processGroupPid < 1) {
    fail('P0-CONTROLLED-ABA-PROCESS', 'process-group stopped-state input is invalid')
  }
  const members = rows.filter(row => row.pgid === processGroupPid)
  return members.some(row => row.state.startsWith('T'))
    && members.every(row => row.state.startsWith('T') || row.state.startsWith('Z'))
}

async function runCommand(command, arguments_, options) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const settle = action => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk) })
    child.once('error', error => settle(() => rejectRun(error)))
    child.once('close', (code, signal) => settle(() => {
      if (timedOut) rejectRun(new Error(`${command} timed out`))
      else resolveRun(Object.freeze({ exitCode: code, signal, stdout, stderr }))
    }))
  })
}

async function processTable() {
  const result = await runCommand(psPath(), ['-axo', 'pid=,ppid=,pgid=,state='], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    timeoutMs: 10_000,
  })
  if (result.exitCode !== 0 || result.signal !== null || result.stderr !== '') {
    fail('P0-CONTROLLED-ABA-PROCESS', 'POSIX process table could not be observed')
  }
  return parseControlledAbaProcessTable(result.stdout)
}

async function waitUntil(observe, accept, options) {
  const deadline = Date.now() + options.timeoutMs
  let last
  for (;;) {
    options.signal?.throwIfAborted()
    last = await observe()
    if (accept(last)) return last
    if (Date.now() >= deadline) fail(options.code, options.message)
    await new Promise(resolveDelay => setTimeout(resolveDelay, options.intervalMs))
  }
}

async function readJson(path, label) {
  const canonical = await realpath(path)
  const info = await lstat(path)
  if (canonical !== path || !info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 1024 * 1024) {
    fail('P0-CONTROLLED-ABA-LEASE', `${label} is not a bounded real file`)
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    fail('P0-CONTROLLED-ABA-LEASE', `${label} is not valid JSON`)
  }
}

async function optionalLstat(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function observeProfileTarget(dshHome, profileId, packageName) {
  const profileRoot = join(dshHome, 'profiles', profileId)
  const manifest = record(JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8')), 'official Profile manifest')
  const dependencies = manifest.dependencies === undefined ? {} : record(manifest.dependencies, 'official Profile dependencies')
  const dsh = manifest.dsh === undefined ? {} : record(manifest.dsh, 'official Profile metadata')
  const profile = dsh.profile === undefined ? {} : record(dsh.profile, 'official Profile bundle metadata')
  const bundles = profile.bundles === undefined ? [] : profile.bundles
  if (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string')) {
    fail('P0-CONTROLLED-ABA-PROFILE', 'official Profile bundle list is invalid')
  }
  const packagePath = join(profileRoot, 'node_modules', ...packageName.split('/'))
  const installed = await optionalLstat(packagePath)
  return Object.freeze({
    dependency: dependencies[packageName] ?? null,
    bundleCount: bundles.filter(item => item === packageName).length,
    installed: installed !== null,
  })
}

function absentTarget(value) {
  return value.dependency === null && value.bundleCount === 0 && value.installed === false
}

function installedTarget(value) {
  return typeof value.dependency === 'string' && value.dependency.length > 0
    && value.bundleCount === 1 && value.installed === true
}

/** Bind the official-CLI B→A setup that makes the replacement Host reapply the approved install. */
export function bindControlledAbaSetupTransition(input) {
  const value = record(input, 'controlled ABA setup transition')
  const operationId = bounded(value.operationId, 'controlled ABA operation id')
  const profileId = safeProfileId(value.profileId)
  const packageName = safePackageName(value.packageName)
  const stateAfterRestartRequired = record(
    value.stateAfterRestartRequired,
    'Profile state after the restart-required checkpoint',
  )
  const stateAfterSetup = record(value.stateAfterSetup, 'Profile state after the controlled setup removal')
  if (!installedTarget(stateAfterRestartRequired)) {
    fail(
      'P0-CONTROLLED-ABA-PRECONDITION',
      'restart-required install did not leave the managed child Plugin in installed state B',
    )
  }
  if (!absentTarget(stateAfterSetup)) {
    fail(
      'P0-CONTROLLED-ABA-SETUP-A-STATE',
      'controlled official CLI setup did not move the installed target from B to absent state A',
    )
  }
  return Object.freeze({
    schemaVersion: 1,
    operationId,
    profileId,
    packageName,
    officialCliPackage: '@deepseek-ai/dsh@0.1.1-rc.2',
    action: 'official-cli-remove',
    transition: 'B-to-A',
    stateAfterRestartRequired: Object.freeze({
      dependency: stateAfterRestartRequired.dependency,
      bundleCount: stateAfterRestartRequired.bundleCount,
      installed: stateAfterRestartRequired.installed,
    }),
    stateAfterSetup: Object.freeze({
      dependency: stateAfterSetup.dependency,
      bundleCount: stateAfterSetup.bundleCount,
      installed: stateAfterSetup.installed,
    }),
  })
}

async function readExecutionLease(dshHome, profileId, hostPid) {
  const leaseRoot = join(
    dshHome,
    '.extension-center-plugin-coordination',
    'leases',
    storageKey(profileId),
  )
  const [owner, execution, dispatch] = await Promise.all([
    readJson(join(leaseRoot, 'owner.json'), 'Center Profile lease owner'),
    readJson(join(leaseRoot, 'execution.json'), 'Center Profile execution lease'),
    readJson(join(leaseRoot, 'execution-dispatch.json'), 'Center Profile execution dispatch'),
  ])
  const lease = decodeControlledAbaLease(owner, execution, { profileId, hostPid })
  return Object.freeze({
    path: leaseRoot,
    ...lease,
    dispatchedAtMs: decodeControlledAbaDispatch(dispatch, { profileId, ...lease }),
  })
}

function readJsonSync(path, label) {
  const canonical = realpathSync(path)
  const opened = lstatSync(path)
  if (canonical !== path || !opened.isFile() || opened.isSymbolicLink()
    || opened.size <= 0 || opened.size > 1024 * 1024) {
    fail('P0-CONTROLLED-ABA-LEASE', `${label} is not a bounded real file`)
  }
  const bytes = readFileSync(path)
  const current = lstatSync(path)
  if (bytes.length !== opened.size || current.dev !== opened.dev || current.ino !== opened.ino) {
    fail('P0-CONTROLLED-ABA-LEASE', `${label} changed while it was read`)
  }
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('P0-CONTROLLED-ABA-LEASE', `${label} is not valid JSON`)
  }
}

function readExecutionLeaseSync(dshHome, profileId, hostPid) {
  const leaseRoot = join(
    dshHome,
    '.extension-center-plugin-coordination',
    'leases',
    storageKey(profileId),
  )
  const owner = readJsonSync(join(leaseRoot, 'owner.json'), 'Center Profile lease owner')
  const execution = readJsonSync(join(leaseRoot, 'execution.json'), 'Center Profile execution lease')
  return Object.freeze({
    path: leaseRoot,
    ...decodeControlledAbaLease(owner, execution, { profileId, hostPid }),
  })
}

function readExecutionDispatchSync(lease) {
  const dispatch = readJsonSync(
    join(lease.path, 'execution-dispatch.json'),
    'Center Profile execution dispatch',
  )
  return decodeControlledAbaDispatch(dispatch, {
    profileId: lease.profileId,
    ownerId: lease.ownerId,
    leaseId: lease.leaseId,
    processGroupPid: lease.processGroupPid,
    executionDigest: lease.executionDigest,
  })
}

function armExecutionLeaseCapture(dshHome, profileId, options) {
  const leasesRoot = join(dshHome, '.extension-center-plugin-coordination', 'leases')
  const leaseRoot = join(leasesRoot, storageKey(profileId))
  let canonicalRoot
  let rootInfo
  try {
    canonicalRoot = realpathSync(leasesRoot)
    rootInfo = lstatSync(leasesRoot)
  } catch (error) {
    fail(
      'P0-CONTROLLED-ABA-LEASE',
      `Center execution lease directory cannot be observed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (canonicalRoot !== leasesRoot || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail('P0-CONTROLLED-ABA-LEASE', 'Center execution lease directory is not a canonical real directory')
  }
  let hostPid = null
  let rootWatcher
  try {
    rootWatcher = watch(leasesRoot, { encoding: 'utf8' })
  } catch (error) {
    fail('P0-CONTROLLED-ABA-LEASE', `Center execution lease directory cannot be observed: ${error instanceof Error ? error.message : String(error)}`)
  }
  let cancelCapture
  let probeCapture = () => {}
  const promise = new Promise((resolveLease, rejectLease) => {
    let settled = false
    let probing = false
    let leaseWatcher
    let lastReadError
    const finish = (action) => {
      if (settled) return
      settled = true
      clearInterval(interval)
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      leaseWatcher?.close()
      rootWatcher.close()
      action()
    }
    const probe = () => {
      if (settled || probing || hostPid === null) return
      probing = true
      try {
        const value = readExecutionLeaseSync(dshHome, profileId, hostPid)
        process.kill(-value.processGroupPid, 'SIGSTOP')
        options.onStopped?.(value)
        const dispatchedAtMs = readExecutionDispatchSync({ ...value, profileId })
        finish(() => resolveLease(Object.freeze({ ...value, dispatchedAtMs })))
      } catch (error) {
        if (error?.code !== 'ENOENT') lastReadError = error
      } finally {
        probing = false
      }
    }
    probeCapture = probe
    const attachLeaseWatcher = () => {
      if (settled || leaseWatcher !== undefined) return
      try {
        leaseWatcher = watch(leaseRoot, { encoding: 'utf8' })
      } catch (error) {
        if (error?.code !== 'ENOENT') finish(() => rejectLease(error))
        return
      }
      leaseWatcher.on('change', (_event, filename) => {
        if (filename === null || ['execution.json', 'execution-dispatch.json'].includes(String(filename))) probe()
      })
      leaseWatcher.once('error', error => finish(() => rejectLease(error)))
      probe()
    }
    const interval = setInterval(() => {
      attachLeaseWatcher()
      probe()
    }, options.intervalMs)
    const timeout = setTimeout(() => finish(() => rejectLease(new AcceptanceFailure(
      'P0-CONTROLLED-ABA-LEASE-TIMEOUT',
      lastReadError === undefined
        ? 'approved Plugin install never published a bound official CLI execution lease'
        : `approved Plugin install published no readable bound execution lease: ${lastReadError instanceof Error ? lastReadError.message : String(lastReadError)}`,
    ))), options.timeoutMs)
    const abort = () => finish(() => rejectLease(
      options.signal.reason ?? new Error('controlled ABA execution lease capture aborted'),
    ))
    options.signal?.addEventListener('abort', abort, { once: true })
    rootWatcher.on('change', () => {
      attachLeaseWatcher()
    })
    rootWatcher.once('error', error => finish(() => rejectLease(error)))
    attachLeaseWatcher()
    probe()
    cancelCapture = reason => finish(() => rejectLease(reason))
  })
  return Object.freeze({
    bindHostPid(value) {
      if (!Number.isSafeInteger(value) || value < 1 || hostPid !== null) {
        fail('P0-CONTROLLED-ABA-HOST', 'execution lease capture requires one exact replacement Host pid')
      }
      hostPid = value
      probeCapture()
    },
    cancel(reason = new Error('controlled ABA execution lease capture cancelled')) {
      cancelCapture?.(reason)
    },
    promise,
  })
}

async function waitForGroupStopped(processGroupPid, options) {
  await waitUntil(
    processTable,
    rows => controlledAbaProcessGroupStopped(rows, processGroupPid),
    {
      ...options,
      code: 'P0-CONTROLLED-ABA-SUPERVISOR-STOP-TIMEOUT',
      message: 'bound official DSH CLI process group did not enter a stopped state',
    },
  )
}

async function waitForGroupExit(processGroupPid, options) {
  await waitUntil(
    processTable,
    rows => controlledAbaProcessGroupQuiescent(rows, processGroupPid),
    {
      ...options,
      code: 'P0-CONTROLLED-ABA-CLI-TIMEOUT',
      message: 'detached official DSH CLI process group did not finish while Host was paused',
    },
  )
}

async function waitForHostState(hostPid, accept, options) {
  return await waitUntil(
    processTable,
    rows => {
      const host = rows.find(row => row.pid === hostPid)
      return host !== undefined && accept(host.state)
    },
    options,
  )
}

/**
 * Pause one live POSIX Host for an action and guarantee SIGCONT in `finally`.
 * @param {number} hostPid Exact official Web Host pid.
 * @param {() => Promise<unknown>} action Work that must run only while the Host is stopped.
 * @param {{timeoutMs?: number, intervalMs?: number, signal?: AbortSignal}} [options] Bounded process-observation options.
 * @returns {Promise<unknown>} Action result after the Host is confirmed running again.
 */
export async function withGuaranteedHostResume(hostPid, action, options = {}) {
  requirePosix()
  if (!Number.isSafeInteger(hostPid) || hostPid < 1 || typeof action !== 'function') {
    fail('P0-CONTROLLED-ABA-INPUT', 'Host pause requires a positive pid and action')
  }
  const timing = {
    timeoutMs: options.timeoutMs ?? 10_000,
    intervalMs: options.intervalMs ?? 10,
    signal: options.signal,
  }
  let paused = false
  let result
  let actionFailed = false
  let actionError
  let resumeFailed = false
  let resumeError
  try {
    process.kill(hostPid, 'SIGSTOP')
    paused = true
    await waitForHostState(hostPid, state => state.startsWith('T'), {
      ...timing,
      code: 'P0-CONTROLLED-ABA-STOP-TIMEOUT',
      message: 'official Web Host did not enter a stopped process state',
    })
    try {
      result = await action()
    } catch (error) {
      actionFailed = true
      actionError = error
    }
  } finally {
    if (paused) {
      try {
        process.kill(hostPid, 'SIGCONT')
        await waitForHostState(hostPid, state => !state.startsWith('T'), {
          ...timing,
          code: 'P0-CONTROLLED-ABA-CONTINUE-TIMEOUT',
          message: 'official Web Host did not resume after SIGCONT',
        })
      } catch (error) {
        resumeFailed = true
        resumeError = error
      }
    }
  }
  if (actionFailed && resumeFailed) {
    throw new AggregateError([actionError, resumeError], 'controlled ABA action failed and Host resume also failed')
  }
  if (resumeFailed) throw resumeError
  if (actionFailed) throw actionError
  return result
}

async function verifyOfficialCli(command, packageRoot, cwd, env, timeoutMs) {
  const canonicalCommand = await realpath(resolve(command))
  const commandInfo = await lstat(canonicalCommand)
  if (!commandInfo.isFile() || commandInfo.isSymbolicLink()) {
    fail('P0-CONTROLLED-ABA-OFFICIAL-CLI', 'official DSH CLI is not a real executable file')
  }
  const canonicalPackageRoot = await realpath(resolve(packageRoot))
  const manifest = JSON.parse(await readFile(join(canonicalPackageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.1.1-rc.2' || manifest.bin?.dsh !== 'lib/bin.js') {
    fail('P0-CONTROLLED-ABA-OFFICIAL-CLI', 'independent CLI does not belong to official DSH 0.1.1-rc.2')
  }
  const version = await runCommand(canonicalCommand, ['--version'], { cwd, env, timeoutMs })
  if (version.exitCode !== 0 || version.signal !== null || version.stdout.trim() !== '0.1.1-rc.2') {
    fail('P0-CONTROLLED-ABA-OFFICIAL-CLI', 'independent official DSH CLI version probe failed')
  }
  return canonicalCommand
}

async function waitForPromise(outcome, timeoutMs, code, message) {
  return await new Promise((resolveOutcome, rejectOutcome) => {
    let settled = false
    const finish = action => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const timer = setTimeout(() => finish(() => rejectOutcome(new AcceptanceFailure(code, message))), timeoutMs)
    void Promise.resolve(outcome).then(
      value => finish(() => resolveOutcome(value)),
      error => finish(() => rejectOutcome(error)),
    )
  })
}

/**
 * Wait for the bound execution lease after replacement Host launch.
 *
 * Web readiness only proves that the loopback origin was announced. Startup reconciliation may
 * publish its execution lease later, while the already-armed observer remains
 * responsible for stopping the exact process group.
 *
 * @param {Promise<Readonly<Record<string, unknown>>>} leaseOutcome Bound lease observer outcome.
 * @param {Promise<Readonly<Record<string, unknown>>>} replacementReadyOutcome Replacement Host readiness outcome.
 * @returns {Promise<Readonly<{lease: unknown, readyObservedBeforeLease: boolean}>>} Captured lease and observed outcome order.
 */
export async function waitForControlledAbaLease(leaseOutcome, replacementReadyOutcome) {
  const first = await Promise.race([leaseOutcome, replacementReadyOutcome])
  if (first?.type === 'lease-error' || first?.type === 'ready-error') throw first.error
  if (first?.type === 'lease') {
    return Object.freeze({ lease: first.result, readyObservedBeforeLease: false })
  }
  if (first?.type !== 'ready') {
    fail('P0-CONTROLLED-ABA-OUTCOME', 'controlled ABA launch outcome is invalid')
  }
  const observed = await leaseOutcome
  if (observed?.type === 'lease-error') throw observed.error
  if (observed?.type !== 'lease') {
    fail('P0-CONTROLLED-ABA-OUTCOME', 'controlled ABA lease outcome is invalid')
  }
  return Object.freeze({ lease: observed.result, readyObservedBeforeLease: true })
}

async function resumeProcessGroup(processGroupPid, options) {
  try {
    process.kill(-processGroupPid, 'SIGCONT')
  } catch (error) {
    if (error?.code === 'ESRCH') return
    throw error
  }
  await waitUntil(
    processTable,
    rows => rows.filter(row => row.pgid === processGroupPid).every(row => !row.state.startsWith('T')),
    {
      ...options,
      code: 'P0-CONTROLLED-ABA-SUPERVISOR-CONTINUE-TIMEOUT',
      message: 'bound official DSH CLI process group did not resume after SIGCONT',
    },
  )
}

async function waitForRecoveryRequired(observeOperation, operationId, options) {
  const deadline = Date.now() + options.timeoutMs
  let lastError
  for (;;) {
    options.signal?.throwIfAborted()
    let value
    try {
      value = await observeOperation(operationId)
      lastError = undefined
    } catch (error) {
      lastError = error
      if (Date.now() >= deadline) {
        fail(
          'P0-CONTROLLED-ABA-OPERATION-TIMEOUT',
          `replacement Host never exposed the recovery-required operation: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, options.intervalMs))
      continue
    }
    const observed = record(value, 'observed recovery-required operation')
    const loaded = record(observed.loadedOperation, 'loaded controlled ABA operation')
    const projection = record(loaded.projection, 'loaded controlled ABA projection')
    if (projection.operationId !== operationId || typeof projection.phase !== 'string') {
      fail('P0-CONTROLLED-ABA-OUTCOME', 'operation RPC returned a different or invalid controlled ABA projection')
    }
    if (projection.phase === 'recovery-required' && observed.operationSummary !== undefined) return observed
    if (['committed', 'failed', 'rolled-back'].includes(projection.phase)) {
      fail(
        'P0-CONTROLLED-ABA-OUTCOME',
        `real A→B→A race settled as ${projection.phase} instead of recovery-required`,
      )
    }
    if (!['authorized', 'staging', 'applying', 'verifying', 'rolling-back'].includes(projection.phase)) {
      fail('P0-CONTROLLED-ABA-OUTCOME', `controlled ABA operation has invalid phase ${projection.phase}`)
    }
    if (Date.now() >= deadline) {
      fail(
        'P0-CONTROLLED-ABA-OPERATION-TIMEOUT',
        lastError === undefined
          ? 'replacement Host did not reconcile the real ABA to recovery-required'
          : `replacement Host did not reconcile the real ABA: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      )
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, options.intervalMs))
  }
}

/**
 * Create a real A→B→A Plugin install race during the restart that applies an approved Plugin operation.
 *
 * Integration signature:
 * `restartRequiredLifecycle` is the already-settled response from the old Host;
 * `stoppedHostProcess` proves that Host was then stopped;
 * `startReplacementHost()` synchronously returns `{ hostProcess, ready }`, where `ready`
 * resolves only after the replacement Host is reachable and the runner has replaced its RPC client;
 * `observeOperation(operationId)` returns `{ loadedOperation, operationSummary }` through ordinary RPC.
 *
 * @param {Readonly<Record<string, unknown>>} input Official Host, Profile, callback, and timing identities.
 * @returns {Promise<Readonly<Record<string, unknown>>>} Recovery-required operation plus process/ABA evidence.
 */
export async function induceControlledPluginInstallAba(input) {
  requirePosix()
  const value = record(input, 'controlled ABA input')
  const lifecycle = record(value.restartRequiredLifecycle, 'restart-required Plugin lifecycle response')
  if (lifecycle.status !== 'restart-required' || lifecycle.receipt !== null
    || typeof lifecycle.operationId !== 'string' || lifecycle.operationId.length === 0) {
    fail('P0-CONTROLLED-ABA-LIFECYCLE', 'controlled ABA requires an exact restart-required operation checkpoint')
  }
  const stoppedHost = record(value.stoppedHostProcess, 'stopped old official Web Host process')
  if (!Number.isSafeInteger(stoppedHost.pid) || stoppedHost.pid < 1
    || stoppedHost.exitCode === null && stoppedHost.signalCode === null) {
    fail('P0-CONTROLLED-ABA-HOST', 'controlled ABA requires proof that the old official Web Host stopped')
  }
  const profileId = safeProfileId(value.profileId)
  const packageName = safePackageName(value.packageName)
  const dshHome = await realpath(resolve(bounded(value.dshHome, 'DSH home')))
  const cwd = await realpath(resolve(bounded(value.cwd, 'official CLI cwd')))
  const env = record(value.env, 'official CLI environment')
  if (env.DSH_HOME !== dshHome || typeof value.startReplacementHost !== 'function'
    || typeof value.observeOperation !== 'function') {
    fail('P0-CONTROLLED-ABA-INPUT', 'controlled ABA callbacks and bound DSH_HOME are required')
  }
  const leaseTimeoutMs = value.leaseTimeoutMs ?? 30_000
  const cliTimeoutMs = value.cliTimeoutMs ?? 125_000
  const hostReadyTimeoutMs = value.hostReadyTimeoutMs ?? 120_000
  const operationTimeoutMs = value.operationTimeoutMs ?? 120_000
  const intervalMs = value.intervalMs ?? 5
  for (const [label, timing, minimum, maximum] of [
    ['leaseTimeoutMs', leaseTimeoutMs, 1_000, 120_000],
    ['cliTimeoutMs', cliTimeoutMs, 1_000, 600_000],
    ['hostReadyTimeoutMs', hostReadyTimeoutMs, 1_000, 600_000],
    ['operationTimeoutMs', operationTimeoutMs, 1_000, 600_000],
    ['intervalMs', intervalMs, 1, 1_000],
  ]) {
    if (!Number.isSafeInteger(timing) || timing < minimum || timing > maximum) {
      fail('P0-CONTROLLED-ABA-INPUT', `${label} is outside its bound`)
    }
  }
  const signal = value.signal
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    fail('P0-CONTROLLED-ABA-INPUT', 'controlled ABA signal is invalid')
  }
  signal?.throwIfAborted()
  const officialCli = await verifyOfficialCli(
    bounded(value.dshBin, 'official DSH CLI path'),
    bounded(value.officialDshPackageRoot, 'official DSH package root'),
    cwd,
    env,
    30_000,
  )
  const stateAfterRestartRequired = await observeProfileTarget(dshHome, profileId, packageName)
  if (!installedTarget(stateAfterRestartRequired)) {
    fail(
      'P0-CONTROLLED-ABA-PRECONDITION',
      'restart-required install did not leave the managed child Plugin in installed state B',
    )
  }
  const setupRemoved = await runCommand(officialCli, [
    'plugin', '--profile', profileId, 'remove', packageName,
  ], {
    cwd,
    env,
    timeoutMs: cliTimeoutMs,
  })
  if (setupRemoved.exitCode !== 0 || setupRemoved.signal !== null) {
    fail('P0-CONTROLLED-ABA-SETUP-REMOVE', 'controlled official DSH CLI could not establish absent state A')
  }
  const stateA = await observeProfileTarget(dshHome, profileId, packageName)
  const setupTransition = bindControlledAbaSetupTransition({
    operationId: lifecycle.operationId,
    profileId,
    packageName,
    stateAfterRestartRequired,
    stateAfterSetup: stateA,
  })

  let lease
  let replacementHost
  let replacementReadyOutcome
  let stateB
  let stateAtLeaseStop
  let stateAfterAba
  let orchestrationError
  let heldProcessGroupPid = null
  let readyObservedBeforeLease = false
  const leaseAbort = new AbortController()
  const forwardAbort = () => { leaseAbort.abort(signal.reason) }
  signal?.addEventListener('abort', forwardAbort, { once: true })
  const leaseCapture = armExecutionLeaseCapture(dshHome, profileId, {
    timeoutMs: leaseTimeoutMs,
    intervalMs,
    signal: leaseAbort.signal,
    onStopped: value => { heldProcessGroupPid = value.processGroupPid },
  })
  const leaseOutcome = leaseCapture.promise.then(
    result => Object.freeze({ type: 'lease', result }),
    error => Object.freeze({ type: 'lease-error', error }),
  )
  try {
    const launched = record(value.startReplacementHost(), 'replacement official Web Host launch')
    replacementHost = record(launched.hostProcess, 'replacement official Web Host process')
    const hostPid = replacementHost.pid
    if (!Number.isSafeInteger(hostPid) || hostPid < 1 || hostPid === stoppedHost.pid
      || replacementHost.exitCode !== null || replacementHost.signalCode !== null
      || launched.ready === null || launched.ready === undefined || typeof launched.ready.then !== 'function') {
      fail('P0-CONTROLLED-ABA-HOST', 'replacement launch did not synchronously expose one distinct live Host and readiness promise')
    }
    leaseCapture.bindHostPid(hostPid)
    replacementReadyOutcome = Promise.resolve(launched.ready).then(
      result => Object.freeze({ type: 'ready', result }),
      error => Object.freeze({ type: 'ready-error', error }),
    )
    const captured = await waitForControlledAbaLease(leaseOutcome, replacementReadyOutcome)
    lease = captured.lease
    readyObservedBeforeLease = captured.readyObservedBeforeLease
    heldProcessGroupPid = lease.processGroupPid
    await waitForGroupStopped(lease.processGroupPid, {
      timeoutMs: 10_000,
      intervalMs,
      signal,
    })
    stateAtLeaseStop = await observeProfileTarget(dshHome, profileId, packageName)
    if (!absentTarget(stateAtLeaseStop)) {
      fail(
        'P0-CONTROLLED-ABA-LEASE-LATE',
        'bound official CLI changed the target before its observed process group was stopped',
      )
    }
    signal?.throwIfAborted()
    await withGuaranteedHostResume(hostPid, async () => {
      const held = await readExecutionLease(dshHome, profileId, hostPid)
      if (held.ownerId !== lease.ownerId || held.leaseId !== lease.leaseId
        || held.hostProcessIdentityDigest !== lease.hostProcessIdentityDigest
        || held.processGroupPid !== lease.processGroupPid || held.supervisorSha256 !== lease.supervisorSha256
        || held.startedAtMs !== lease.startedAtMs || held.executionDigest !== lease.executionDigest
        || held.dispatchedAtMs !== lease.dispatchedAtMs) {
        fail('P0-CONTROLLED-ABA-LEASE', 'Host pause did not retain the observed official CLI execution lease')
      }
      await resumeProcessGroup(lease.processGroupPid, {
        timeoutMs: 10_000,
        intervalMs,
        signal,
      })
      heldProcessGroupPid = null
      await waitForGroupExit(lease.processGroupPid, {
        timeoutMs: cliTimeoutMs,
        intervalMs,
        signal,
      })
      stateB = await observeProfileTarget(dshHome, profileId, packageName)
      if (!installedTarget(stateB)) {
        fail('P0-CONTROLLED-ABA-B-STATE', 'detached official CLI did not complete the approved Plugin install')
      }
      const removed = await runCommand(officialCli, [
        'plugin', '--profile', profileId, 'remove', packageName,
      ], {
        cwd,
        env,
        timeoutMs: cliTimeoutMs,
      })
      if (removed.exitCode !== 0 || removed.signal !== null) {
        fail('P0-CONTROLLED-ABA-INDEPENDENT-REMOVE', 'independent official DSH CLI did not remove the installed child Plugin')
      }
      stateAfterAba = await observeProfileTarget(dshHome, profileId, packageName)
      if (!absentTarget(stateAfterAba)) {
        fail('P0-CONTROLLED-ABA-A-STATE', 'independent official CLI did not return the target to exact absent state A')
      }
    }, {
      timeoutMs: 10_000,
      intervalMs: 5,
      signal,
    })
  } catch (error) {
    orchestrationError = error
  } finally {
    leaseAbort.abort(new Error('controlled ABA orchestration finished'))
    leaseCapture.cancel(new Error('controlled ABA orchestration finished'))
    signal?.removeEventListener('abort', forwardAbort)
    if (heldProcessGroupPid !== null) {
      try {
        await resumeProcessGroup(heldProcessGroupPid, {
          timeoutMs: 10_000,
          intervalMs,
        })
      } catch (error) {
        orchestrationError = orchestrationError === undefined
          ? error
          : new AggregateError([orchestrationError, error], 'controlled ABA failed and held supervisor could not resume')
      }
    }
  }

  if (orchestrationError !== undefined) throw orchestrationError
  if (replacementReadyOutcome === undefined) {
    fail('P0-CONTROLLED-ABA-HOST', 'replacement official Web Host was not launched')
  }
  const ready = await waitForPromise(
    replacementReadyOutcome,
    hostReadyTimeoutMs,
    'P0-CONTROLLED-ABA-HOST-READY-TIMEOUT',
    'replacement official Web Host did not become ready after the ABA was released',
  )
  if (ready.type === 'ready-error') throw ready.error
  if (ready.type !== 'ready') fail('P0-CONTROLLED-ABA-HOST', 'replacement Host readiness outcome is invalid')
  const observed = await waitForRecoveryRequired(value.observeOperation, lifecycle.operationId, {
    timeoutMs: operationTimeoutMs,
    intervalMs: Math.max(25, intervalMs),
    signal,
  })
  const loaded = record(observed.loadedOperation, 'loaded recovery-required operation')
  const projection = record(loaded.projection, 'loaded recovery-required projection')
  const summary = record(observed.operationSummary, 'recovery-required operation summary')
  const planEvidence = record(projection.planEvidence, 'recovery-required plan evidence')
  const recoveryBinding = record(planEvidence.recoveryExecutable, 'recovery-required schema 5 binding')
  if (projection.operationId !== lifecycle.operationId || projection.phase !== 'recovery-required'
    || projection.receipt !== null || projection.operationKind !== 'install'
    || planEvidence.extensionKind !== 'plugin' || planEvidence.ownerKey !== 'managedPlugins'
    || planEvidence.extensionId !== packageName || planEvidence.profileId !== profileId
    || summary.operationId !== lifecycle.operationId || summary.targetKey !== projection.targetKey
    || summary.phase !== 'recovery-required' || summary.operationKind !== 'install'
    || summary.recoveryNotice !== 'journal-reconciliation-pending'
    || recoveryBinding.schemaVersion !== 5 || typeof recoveryBinding.executablePath !== 'string'
    || typeof recoveryBinding.centerRoot !== 'string'
    || !Array.isArray(summary.recoveryCommand) || summary.recoveryCommand.length !== 3
    || summary.recoveryCommand[0] !== recoveryBinding.executablePath
    || summary.recoveryCommand[1] !== recoveryBinding.centerRoot
    || summary.recoveryCommand[2] !== lifecycle.operationId) {
    fail('P0-CONTROLLED-ABA-OUTCOME', 'operation RPC did not retain the exact break-glass recovery projection')
  }
  const quarantine = record(await readJson(join(
    dshHome,
    '.extension-center-plugin-coordination',
    'quarantine',
    `${storageKey(profileId)}.json`,
  ), 'operation-bound Profile quarantine'), 'operation-bound Profile quarantine')
  if (quarantine.schemaVersion !== 1 || quarantine.profileId !== profileId || quarantine.packageName !== packageName
    || quarantine.operationId !== lifecycle.operationId || quarantine.targetKey !== projection.targetKey
    || quarantine.centerRoot !== recoveryBinding.centerRoot
    || typeof quarantine.reason !== 'string' || quarantine.reason.length === 0
    || typeof quarantine.beforeDigest !== 'string' || !SHA256.test(quarantine.beforeDigest)
    || typeof quarantine.afterDigest !== 'string' || !SHA256.test(quarantine.afterDigest)) {
    fail('P0-CONTROLLED-ABA-OUTCOME', 'Profile quarantine does not bind the real controlled ABA operation')
  }
  return Object.freeze({
    operationId: lifecycle.operationId,
    lifecycle,
    loadedOperation: loaded,
    operationSummary: summary,
    evidence: Object.freeze({
      schemaVersion: 1,
      profileId,
      packageName,
      previousHostPid: stoppedHost.pid,
      hostPid: replacementHost.pid,
      hostLeaseId: lease.leaseId,
      hostProcessIdentityDigest: lease.hostProcessIdentityDigest,
      supervisorProcessGroupPid: lease.processGroupPid,
      supervisorSha256: lease.supervisorSha256,
      supervisorStartedAtMs: lease.startedAtMs,
      supervisorExecutionDigest: lease.executionDigest,
      supervisorDispatchedAtMs: lease.dispatchedAtMs,
      hostStoppedDuringIndependentRemove: true,
      officialCliPackage: '@deepseek-ai/dsh@0.1.1-rc.2',
      setupTransition,
      stateA,
      stateAtLeaseStop,
      stateB,
      stateAfterAba,
      quarantine: Object.freeze({
        beforeDigest: quarantine.beforeDigest,
        afterDigest: quarantine.afterDigest,
        reason: quarantine.reason,
      }),
      journalWritesByHelper: 0,
      productFaultInjectionUsed: false,
      restartRequiredBeforeReplacementLaunch: true,
      readyObservedBeforeLease,
      result: 'recovery-required',
    }),
  })
}
