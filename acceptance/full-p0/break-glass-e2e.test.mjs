import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { canonicalSha256 } from './receipt-binding.mjs'
import { AcceptanceFailure } from './support.mjs'
import { validatePackedBreakGlassPrecondition } from './break-glass-e2e.mjs'

const operationId = 'operation:packed-break-glass:1'
const packageName = 'dsh-capability-resolver'
const profileId = 'web'
const scopeKey = 'profile:web'
const targetKey = `plugin:${profileId}:${scopeKey}:${packageName}`
const centerRoot = resolve('/tmp', 'packed-break-glass-center')
const recoveryPath = resolve(
  centerRoot,
  'recovery',
  '1.0.0',
  `${process.platform}-${process.arch}`,
  'break-glass.mjs',
)
const digest = `sha256:${'a'.repeat(64)}`

function binding() {
  const toolchain = resolve(centerRoot, 'recovery', 'toolchains', 'fixed')
  return {
    schemaVersion: 5,
    executablePath: recoveryPath,
    executableSha256: digest,
    centerRoot,
    packageVersion: '1.0.0',
    platform: process.platform,
    arch: process.arch,
    officialDsh: {
      schemaVersion: 2,
      packageName: '@deepseek-ai/dsh',
      packageVersion: '0.1.1-rc.2',
      packageRoot: resolve('/tmp', 'official-host', 'node_modules', '@deepseek-ai', 'dsh'),
      packageTreeSha256: digest,
      productionDependencies: [],
      entrypointPath: resolve('/tmp', 'official-host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      entrypointSha256: digest,
      hostHome: resolve('/tmp', 'dsh-home'),
      timeoutMs: 120_000,
      node: {
        schemaVersion: 1,
        executablePath: process.execPath,
        executableSha256: digest,
        version: process.version,
      },
      supervisorPath: resolve(toolchain, 'supervisor.mjs'),
      supervisorSha256: digest,
      pnpm: {
        schemaVersion: 1,
        packageName: 'pnpm',
        packageVersion: '11.21.0',
        registryIntegrity: 'sha512-fixture',
        packageRoot: resolve(toolchain, 'pnpm'),
        packageTreeSha256: digest,
        entrypointPath: resolve(toolchain, 'pnpm', 'bin', 'pnpm.mjs'),
        entrypointSha256: digest,
        shimPath: resolve(toolchain, 'bin', 'pnpm'),
        shimSha256: digest,
        shellPath: '/bin/sh',
        shellSha256: digest,
        runtimeRoot: resolve(toolchain, 'runtime'),
      },
    },
  }
}

function event(sequence, previousDigest, entry) {
  const unsigned = {
    schemaVersion: 1,
    operationId,
    targetKey,
    sequence,
    previousDigest,
    atMs: 1_000 + sequence,
    entry,
  }
  return { ...unsigned, digest: canonicalSha256(unsigned) }
}

function operation() {
  const events = []
  const add = entry => {
    const previous = events.at(-1)?.digest ?? null
    events.push(event(events.length + 1, previous, entry))
  }
  add({
    type: 'operation-opened',
    planId: 'plan:packed-break-glass:1',
    planHash: digest,
    operationKind: 'update',
    managedObject: 'artifact',
    externalRuntimeAction: 'download',
    runtimeBinding: null,
    planEvidence: {
      extensionKind: 'plugin',
      ownerKey: 'managedPlugins',
      extensionId: packageName,
      profileId,
      scopeKey,
      recoveryExecutable: binding(),
    },
    beforeDigest: digest,
  })
  add({ type: 'phase-transition', from: 'authorized', to: 'staging', evidenceDigest: null, reason: null })
  add({ type: 'phase-transition', from: 'staging', to: 'applying', evidenceDigest: null, reason: null })
  add({ type: 'phase-transition', from: 'applying', to: 'rolling-back', evidenceDigest: null, reason: null })
  add({ type: 'phase-transition', from: 'rolling-back', to: 'recovery-required', evidenceDigest: null, reason: 'rollback-failed' })
  return {
    journal: { schemaVersion: 1, operationId, targetKey, events },
    projection: {
      operationId,
      targetKey,
      operationKind: 'update',
      phase: 'recovery-required',
      beforeDigest: digest,
      receipt: null,
    },
    recovered: false,
  }
}

function input() {
  return {
    centerRoot,
    stoppedHostProcess: { exitCode: null, signalCode: 'SIGTERM' },
    loadedOperation: operation(),
    operationSummary: {
      operationId,
      targetKey,
      phase: 'recovery-required',
      operationKind: 'update',
      lastAtMs: 1_005,
      recoveryCommand: [recoveryPath, centerRoot, operationId],
      recoveryNotice: 'journal-reconciliation-pending',
    },
  }
}

test('accepts only a stopped Host and an exact schema 5 managed-Plugin recovery projection', () => {
  const value = validatePackedBreakGlassPrecondition(input())
  assert.equal(value.operationId, operationId)
  assert.equal(value.packageName, packageName)
  assert.equal(value.binding.schemaVersion, 5)
  assert.equal(value.official.packageVersion, '0.1.1-rc.2')
  assert.equal(value.pnpm.packageVersion, '11.21.0')
  assert.deepEqual(value.command, [recoveryPath, centerRoot, operationId])
})

test('rejects a live Host before admitting standalone recovery', () => {
  const value = input()
  value.stoppedHostProcess = { exitCode: null, signalCode: null }
  assert.throws(
    () => validatePackedBreakGlassPrecondition(value),
    error => error instanceof AcceptanceFailure && error.code === 'P0-BREAK-GLASS-HOST-LIVE',
  )
})

test('rejects a recovery command that is not the exact journal-bound argv', () => {
  const value = input()
  value.operationSummary.recoveryCommand = [process.execPath, recoveryPath, operationId]
  assert.throws(
    () => validatePackedBreakGlassPrecondition(value),
    error => error instanceof AcceptanceFailure && error.code === 'P0-BREAK-GLASS-SUMMARY',
  )
})

test('rejects journal tampering and non-schema-5 recovery bindings', () => {
  const tampered = input()
  tampered.loadedOperation.journal.events[2].entry.to = 'verifying'
  assert.throws(
    () => validatePackedBreakGlassPrecondition(tampered),
    error => error instanceof AcceptanceFailure && error.code === 'P0-BREAK-GLASS-JOURNAL',
  )

  const oldBinding = input()
  oldBinding.loadedOperation.journal.events[0].entry.planEvidence.recoveryExecutable.schemaVersion = 4
  const first = oldBinding.loadedOperation.journal.events[0]
  const unsigned = {
    schemaVersion: first.schemaVersion,
    operationId: first.operationId,
    targetKey: first.targetKey,
    sequence: first.sequence,
    previousDigest: first.previousDigest,
    atMs: first.atMs,
    entry: first.entry,
  }
  first.digest = canonicalSha256(unsigned)
  for (let index = 1; index < oldBinding.loadedOperation.journal.events.length; index += 1) {
    const current = oldBinding.loadedOperation.journal.events[index]
    current.previousDigest = oldBinding.loadedOperation.journal.events[index - 1].digest
    const body = {
      schemaVersion: current.schemaVersion,
      operationId: current.operationId,
      targetKey: current.targetKey,
      sequence: current.sequence,
      previousDigest: current.previousDigest,
      atMs: current.atMs,
      entry: current.entry,
    }
    current.digest = canonicalSha256(body)
  }
  assert.throws(
    () => validatePackedBreakGlassPrecondition(oldBinding),
    error => error instanceof AcceptanceFailure && error.code === 'P0-BREAK-GLASS-BINDING',
  )
})
