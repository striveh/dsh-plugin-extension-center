import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  bindControlledAbaSetupTransition,
  controlledAbaProcessGroupQuiescent,
  controlledAbaProcessGroupStopped,
  decodeControlledAbaDispatch,
  decodeControlledAbaLease,
  parseControlledAbaProcessTable,
  waitForControlledAbaLease,
  withGuaranteedHostResume,
} from './controlled-aba.mjs'
import { canonicalSha256 } from './receipt-binding.mjs'
import { AcceptanceFailure } from './support.mjs'

const digest = `sha256:${'a'.repeat(64)}`

test('binds the official restart-required B→A setup to the exact operation and Profile target', () => {
  const installed = Object.freeze({
    dependency: 'file:/retained/managed-plugin-0.1.0.tgz',
    bundleCount: 1,
    installed: true,
  })
  const absent = Object.freeze({ dependency: null, bundleCount: 0, installed: false })
  assert.deepEqual(bindControlledAbaSetupTransition({
    operationId: 'operation-install-1',
    profileId: 'web',
    packageName: 'dsh-plugin-managed-fixture',
    stateAfterRestartRequired: installed,
    stateAfterSetup: absent,
  }), {
    schemaVersion: 1,
    operationId: 'operation-install-1',
    profileId: 'web',
    packageName: 'dsh-plugin-managed-fixture',
    officialCliPackage: '@deepseek-ai/dsh@0.1.1-rc.2',
    action: 'official-cli-remove',
    transition: 'B-to-A',
    stateAfterRestartRequired: installed,
    stateAfterSetup: absent,
  })
  assert.throws(
    () => bindControlledAbaSetupTransition({
      operationId: 'operation-install-1',
      profileId: 'web',
      packageName: 'dsh-plugin-managed-fixture',
      stateAfterRestartRequired: absent,
      stateAfterSetup: absent,
    }),
    error => error instanceof AcceptanceFailure && error.code === 'P0-CONTROLLED-ABA-PRECONDITION',
  )
  assert.throws(
    () => bindControlledAbaSetupTransition({
      operationId: 'operation-install-1',
      profileId: 'web',
      packageName: 'dsh-plugin-managed-fixture',
      stateAfterRestartRequired: installed,
      stateAfterSetup: installed,
    }),
    error => error instanceof AcceptanceFailure && error.code === 'P0-CONTROLLED-ABA-SETUP-A-STATE',
  )
})

test('binds an execution lease to the exact live Host, Profile, owner, and process group', () => {
  const processIdentity = {
    schemaVersion: 1,
    pid: 1234,
    platform: process.platform,
    machineDigest: digest,
    bootDigest: digest,
    birthDigest: digest,
  }
  const processIdentityDigest = `sha256:${createHash('sha256').update(JSON.stringify(processIdentity)).digest('hex')}`
  const owner = {
    schemaVersion: 2,
    profileId: 'web',
    ownerId: 'center-owner',
    leaseId: 'lease:11111111-1111-4111-8111-111111111111',
    processIdentity,
    acquiredAtMs: 1000,
  }
  const execution = {
    schemaVersion: 1,
    profileId: 'web',
    ownerId: 'center-owner',
    parentPid: 1234,
    processGroupPid: 5678,
    supervisorSha256: digest,
    startedAtMs: 1001,
  }
  const executionDigest = canonicalSha256(execution)
  const decoded = decodeControlledAbaLease(owner, execution, {
    profileId: 'web',
    hostPid: 1234,
  })
  assert.deepEqual(decoded, {
    ownerId: 'center-owner',
    leaseId: 'lease:11111111-1111-4111-8111-111111111111',
    hostPid: 1234,
    hostProcessIdentityDigest: processIdentityDigest,
    processGroupPid: 5678,
    supervisorSha256: digest,
    startedAtMs: 1001,
    executionDigest,
  })

  assert.equal(decodeControlledAbaDispatch({
    schemaVersion: 1,
    profileId: 'web',
    ownerId: 'center-owner',
    leaseId: owner.leaseId,
    processGroupPid: 5678,
    executionDigest,
    dispatchedAtMs: 1002,
  }, {
    profileId: 'web',
    ownerId: 'center-owner',
    leaseId: owner.leaseId,
    processGroupPid: 5678,
    executionDigest,
  }), 1002)

  assert.throws(() => decodeControlledAbaDispatch({
    schemaVersion: 1,
    profileId: 'web',
    ownerId: 'center-owner',
    leaseId: owner.leaseId,
    processGroupPid: 5678,
    executionDigest: `sha256:${'b'.repeat(64)}`,
    dispatchedAtMs: 1002,
  }, {
    profileId: 'web',
    ownerId: 'center-owner',
    leaseId: owner.leaseId,
    processGroupPid: 5678,
    executionDigest,
  }), error => error instanceof AcceptanceFailure && error.code === 'P0-CONTROLLED-ABA-DISPATCH')

  assert.throws(
    () => decodeControlledAbaLease({
      schemaVersion: 2,
      profileId: 'web',
      ownerId: 'center-owner',
      leaseId: 'lease:11111111-1111-4111-8111-111111111111',
      processIdentity: { ...processIdentity, pid: 4321 },
      acquiredAtMs: 1000,
    }, {
      schemaVersion: 1,
      profileId: 'web',
      ownerId: 'center-owner',
      parentPid: 4321,
      processGroupPid: 5678,
      supervisorSha256: digest,
      startedAtMs: 1001,
    }, { profileId: 'web', hostPid: 1234 }),
    error => error instanceof AcceptanceFailure && error.code === 'P0-CONTROLLED-ABA-LEASE',
  )
})

test('parses POSIX process groups and rejects ambiguous rows', () => {
  const rows = parseControlledAbaProcessTable(`
  123  1  123 Ss
  124 123 123 S
`)
  assert.deepEqual(rows, [
    { pid: 123, ppid: 1, pgid: 123, state: 'Ss' },
    { pid: 124, ppid: 123, pgid: 123, state: 'S' },
  ])
  assert.equal(controlledAbaProcessGroupQuiescent(rows, 123), false)
  assert.equal(controlledAbaProcessGroupStopped(rows, 123), false)
  assert.equal(controlledAbaProcessGroupStopped([
    { pid: 123, ppid: 1, pgid: 123, state: 'Ts' },
    { pid: 124, ppid: 123, pgid: 123, state: 'Z' },
  ], 123), true)
  assert.equal(controlledAbaProcessGroupStopped([
    { pid: 123, ppid: 1, pgid: 123, state: 'Ts' },
    { pid: 124, ppid: 123, pgid: 123, state: 'S' },
  ], 123), false, 'one running member makes a partially stopped group unsafe')
  assert.equal(controlledAbaProcessGroupQuiescent([
    { pid: 123, ppid: 1, pgid: 123, state: 'Z' },
  ], 123), true, 'an exited supervisor may remain a zombie until the stopped Host resumes')
  assert.equal(controlledAbaProcessGroupQuiescent([], 123), true)
  assert.throws(
    () => parseControlledAbaProcessTable('123 missing-fields\n'),
    error => error instanceof AcceptanceFailure && error.code === 'P0-CONTROLLED-ABA-PROCESS',
  )
})

test('SIGCONT is guaranteed when the paused action throws', async () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  await once(child, 'spawn')
  const marker = new Error('expected paused action failure')
  try {
    await assert.rejects(
      withGuaranteedHostResume(child.pid, async () => { throw marker }, {
        timeoutMs: 5_000,
        intervalMs: 5,
      }),
      error => error === marker,
    )
    const closePromise = new Promise(resolveClose => {
      const timer = setTimeout(() => resolveClose(false), 2_000)
      child.once('close', () => {
        clearTimeout(timer)
        resolveClose(true)
      })
    })
    child.kill('SIGTERM')
    const closed = await closePromise
    assert.equal(closed, true, 'child remained stopped after the helper finally block')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, 'SIGCONT') } catch { /* child may already be gone */ }
      child.kill('SIGKILL')
      await once(child, 'close').catch(() => undefined)
    }
  }
})

test('the controlled ABA helper has no filesystem mutation primitive for journal forgery', async () => {
  const source = await readFile(fileURLToPath(new URL('./controlled-aba.mjs', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /\b(?:writeFile|appendFile|rename|unlink|truncate)\b/u)
  assert.doesNotMatch(source, /operations\/|provider-snapshots|CURRENT\.json/u)
  assert.equal(source.match(/'plugin', '--profile', profileId, 'remove', packageName/gu)?.length, 2)
  assert.doesNotMatch(source, /DSH_CONTROLLED_ABA_DEBUG|startLifecycle/u)
  const restartRequiredState = source.indexOf('const stateAfterRestartRequired = await observeProfileTarget')
  const setupRemove = source.indexOf("const setupRemoved = await runCommand(officialCli, [", restartRequiredState)
  const stateA = source.indexOf('const stateA = await observeProfileTarget', setupRemove)
  const leaseCapture = source.indexOf('armExecutionLeaseCapture(dshHome, profileId', stateA)
  assert.ok(restartRequiredState >= 0 && restartRequiredState < setupRemove)
  assert.ok(setupRemove < stateA && stateA < leaseCapture)
  assert.ok(
    leaseCapture
      < source.indexOf('value.startReplacementHost()'),
    'the execution-lease observer must be armed before the replacement Host is spawned',
  )
  const captureProbe = source.indexOf('function armExecutionLeaseCapture')
  const leaseStop = source.indexOf("process.kill(-value.processGroupPid, 'SIGSTOP')", captureProbe)
  const dispatchProof = source.indexOf('const dispatchedAtMs = readExecutionDispatchSync', leaseStop)
  assert.ok(
    leaseStop >= 0 && leaseStop < dispatchProof,
    'the supervisor must stop before its durable START dispatch proof is accepted',
  )
  const groupStopped = source.indexOf('await waitForGroupStopped(lease.processGroupPid')
  const stateAtLeaseStop = source.indexOf('stateAtLeaseStop = await observeProfileTarget', groupStopped)
  const supervisorResume = source.indexOf('await resumeProcessGroup(lease.processGroupPid', stateAtLeaseStop)
  assert.ok(
    groupStopped >= 0 && groupStopped < stateAtLeaseStop && stateAtLeaseStop < supervisorResume,
    'the exact absent state must be re-observed after the process group stops and before it resumes',
  )
  assert.match(source, /finally \{[\s\S]*resumeProcessGroup\(heldProcessGroupPid/u)
})

test('Host readiness does not cancel the already-armed execution lease observer', async () => {
  let resolveLease
  const leaseOutcome = new Promise(resolve => { resolveLease = resolve })
  const waiting = waitForControlledAbaLease(
    leaseOutcome,
    Promise.resolve(Object.freeze({ type: 'ready', result: Object.freeze({ origin: 'http://127.0.0.1' }) })),
  )
  let settled = false
  void waiting.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'Web readiness must not settle lease capture')
  const lease = Object.freeze({ ownerId: 'center-owner', processGroupPid: 5678 })
  resolveLease(Object.freeze({ type: 'lease', result: lease }))
  assert.deepEqual(await waiting, {
    lease,
    readyObservedBeforeLease: true,
  })
})

test('lease-first and failed launch outcomes retain their exact semantics', async () => {
  const lease = Object.freeze({ ownerId: 'center-owner', processGroupPid: 5678 })
  assert.deepEqual(await waitForControlledAbaLease(
    Promise.resolve(Object.freeze({ type: 'lease', result: lease })),
    new Promise(() => {}),
  ), {
    lease,
    readyObservedBeforeLease: false,
  })

  const leaseError = new Error('lease failed after Web readiness')
  await assert.rejects(
    waitForControlledAbaLease(
      Promise.resolve(Object.freeze({ type: 'lease-error', error: leaseError })),
      Promise.resolve(Object.freeze({ type: 'ready', result: {} })),
    ),
    error => error === leaseError,
  )

  const readyError = new Error('Web launch failed')
  await assert.rejects(
    waitForControlledAbaLease(
      new Promise(() => {}),
      Promise.resolve(Object.freeze({ type: 'ready-error', error: readyError })),
    ),
    error => error === readyError,
  )
})

test('the official runner obtains restart-required, stops the old Host, then launches the controlled restart', async () => {
  const source = await readFile(fileURLToPath(new URL('./verify-official-rc2.mjs', import.meta.url)), 'utf8')
  const lifecycle = source.indexOf("const abaLifecycle = await rpc.call('lifecycle/request'")
  const restartRequired = source.indexOf('assertRestartRequiredLifecycle(rpc, abaLifecycle, abaPlan)', lifecycle)
  const stopped = source.indexOf('await stopChild(oldAbaHost)', restartRequired)
  const controlled = source.indexOf('await induceControlledPluginInstallAba({', stopped)
  const replacement = source.indexOf('startReplacementHost: () => {', controlled)
  assert.ok(lifecycle >= 0 && lifecycle < restartRequired)
  assert.ok(restartRequired < stopped && stopped < controlled && controlled < replacement)
  assert.match(source, /leaseTimeoutMs: 120_000,/u)
  assert.match(source, /cliTimeoutMs: 300_000,/u)
  assert.match(source, /const launchOutput = \{ value: '' \}/u)
  assert.doesNotMatch(source, /waitForReadyUrl\(child, output,/u)
  const launchHelper = source.indexOf('function launchOfficialWeb')
  const readinessCatch = source.indexOf('} catch (error) {', launchHelper)
  const unreadyCleanup = source.indexOf('await stopChild(child)', readinessCatch)
  const startHelper = source.indexOf('async function startOfficialWeb', unreadyCleanup)
  assert.ok(
    launchHelper >= 0 && launchHelper < readinessCatch && readinessCatch < unreadyCleanup && unreadyCleanup < startHelper,
    'an unready replacement Host must be stopped before its launch promise rejects',
  )
})
