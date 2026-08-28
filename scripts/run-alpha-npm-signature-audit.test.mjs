import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  classifyNpmAuditAttempt,
  classifyNpmInstallAttempt,
  runAlphaNpmSignatureAudit,
} from './run-alpha-npm-signature-audit.mjs'

const version = '0.2.0-alpha.1'
const networkArguments = [
  '--fetch-timeout=20000',
  '--fetch-retries=1',
  '--fetch-retry-mintimeout=1000',
  '--fetch-retry-maxtimeout=5000',
]

test('classifies only bounded network and propagation failures as retryable', () => {
  assert.deepEqual(classifyNpmInstallAttempt(commandResult({ exitCode: 0 })), {
    disposition: 'ready', reason: 'installed',
  })
  assert.deepEqual(classifyNpmInstallAttempt(commandResult({
    exitCode: 1,
    stderr: 'npm error code E503\n',
  })), { disposition: 'retry', reason: 'registry-e503' })
  assert.deepEqual(classifyNpmInstallAttempt(commandResult({
    exitCode: 1,
    stderr: 'npm error code ERESOLVE\n',
  })), { disposition: 'terminal', reason: 'npm-eresolve' })

  assert.deepEqual(classifyNpmAuditAttempt(commandResult({
    exitCode: 0,
    stdout: JSON.stringify(auditResult()),
  }), version).disposition, 'ready')
  assert.deepEqual(classifyNpmAuditAttempt(commandResult({
    exitCode: 0,
    stdout: JSON.stringify(auditResult({ verified: [] })),
  }), version), { disposition: 'retry', reason: 'attestation-propagation' })
  const pending = auditResult()
  pending.verified[0].attestationBundles = []
  assert.deepEqual(classifyNpmAuditAttempt(commandResult({
    exitCode: 0,
    stdout: JSON.stringify(pending),
  }), version), { disposition: 'retry', reason: 'attestation-propagation' })
  assert.deepEqual(classifyNpmAuditAttempt(commandResult({
    exitCode: 1,
    stdout: JSON.stringify({ error: { code: 'ETIMEDOUT' } }),
  }), version), { disposition: 'retry', reason: 'registry-etimedout' })
  assert.deepEqual(classifyNpmAuditAttempt(commandResult({
    exitCode: 1,
    stdout: JSON.stringify(auditResult({ verified: [] })),
    stderr: 'npm error code ETIMEDOUT\n',
  }), version), { disposition: 'retry', reason: 'registry-etimedout' })
  assert.deepEqual(classifyNpmAuditAttempt(commandResult({
    exitCode: null,
    stdout: JSON.stringify(auditResult({ verified: [] })),
    timedOut: true,
  }), version), { disposition: 'retry', reason: 'network-timeout' })
})

test('invalid or missing audit entries are terminal and never retryable', () => {
  for (const key of ['invalid', 'missing']) {
    const value = auditResult()
    value[key].push({ name: 'dsh-plugin-extension-center', version })
    assert.deepEqual(classifyNpmAuditAttempt(commandResult({
      exitCode: 1,
      stdout: JSON.stringify(value),
      stderr: 'npm error code ETIMEDOUT\n',
      timedOut: true,
    }), version), { disposition: 'terminal', reason: 'invalid-or-missing-signature' })
  }
  assert.deepEqual(classifyNpmAuditAttempt(commandResult({
    exitCode: 1,
    stdout: JSON.stringify(auditResult()),
  }), version), { disposition: 'terminal', reason: 'audit-exit-disagrees-with-verdict' })
  const duplicate = auditResult()
  duplicate.verified.push(duplicate.verified[0])
  assert.deepEqual(classifyNpmAuditAttempt(commandResult({
    exitCode: 0,
    stdout: JSON.stringify(duplicate),
  }), version), { disposition: 'terminal', reason: 'ambiguous-target-audit' })
  const duplicateProvenance = auditResult()
  duplicateProvenance.verified[0].attestationBundles.push(
    duplicateProvenance.verified[0].attestationBundles[0],
  )
  assert.deepEqual(classifyNpmAuditAttempt(commandResult({
    exitCode: 0,
    stdout: JSON.stringify(duplicateProvenance),
  }), version), { disposition: 'terminal', reason: 'ambiguous-provenance-audit' })
  const malformed = auditResult()
  delete malformed.verified[0].attestationBundles
  assert.deepEqual(classifyNpmAuditAttempt(commandResult({
    exitCode: 0,
    stdout: JSON.stringify(malformed),
  }), version), { disposition: 'terminal', reason: 'malformed-audit-verdict' })
  const unexpected = auditResult()
  unexpected.verified[0].attestationBundles[0].predicateType = 'https://example.invalid/other'
  assert.deepEqual(classifyNpmAuditAttempt(commandResult({
    exitCode: 0,
    stdout: JSON.stringify(unexpected),
  }), version), { disposition: 'terminal', reason: 'unexpected-attestation-audit' })
})

test('retries only transient install and attestation propagation with explicit npm network bounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpha-npm-audit-test-'))
  const outputPath = join(root, 'audit.json')
  const calls = []
  const delays = []
  const queue = [
    commandResult({ exitCode: 1, stderr: 'npm error code E503\n' }),
    commandResult({ exitCode: 0 }),
    commandResult({ exitCode: 0, stdout: JSON.stringify(auditResult({ verified: [] })) }),
    commandResult({ exitCode: 0, stdout: JSON.stringify(auditResult()) }),
  ]
  try {
    const result = await runAlphaNpmSignatureAudit({
      version,
      outputPath,
      commandRunner: async (args, options) => {
        calls.push({ args, options })
        return queue.shift()
      },
      delay: async () => { delays.push(true) },
    })
    assert.deepEqual(result, { installAttempts: 2, auditAttempts: 2 })
    assert.equal(queue.length, 0)
    assert.equal(delays.length, 2)
    assert.equal(calls.length, 4)
    for (const call of calls) {
      assert.equal(call.options.timeoutMs, 120_000)
      for (const argument of networkArguments) assert.ok(call.args.includes(argument))
    }
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), auditResult())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stops immediately when npm reports invalid or missing provenance', async () => {
  for (const key of ['invalid', 'missing']) {
    const root = await mkdtemp(join(tmpdir(), `alpha-npm-audit-${key}-test-`))
    const verdict = auditResult()
    verdict[key].push({ name: 'dsh-plugin-extension-center', version })
    const queue = [
      commandResult({ exitCode: 0 }),
      commandResult({ exitCode: 1, stdout: JSON.stringify(verdict) }),
    ]
    let delayCount = 0
    try {
      await assert.rejects(
        runAlphaNpmSignatureAudit({
          version,
          outputPath: join(root, 'audit.json'),
          commandRunner: async () => queue.shift(),
          delay: async () => { delayCount += 1 },
        }),
        /audit failed without retry \(invalid-or-missing-signature\)/u,
      )
      assert.equal(queue.length, 0)
      assert.equal(delayCount, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('exhausts a retryable install after exactly three admitted attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpha-npm-audit-exhaustion-test-'))
  let callCount = 0
  let delayCount = 0
  try {
    await assert.rejects(
      runAlphaNpmSignatureAudit({
        version,
        outputPath: join(root, 'audit.json'),
        commandRunner: async () => {
          callCount += 1
          return commandResult({ exitCode: 1, stderr: 'npm error code E503\n' })
        },
        delay: async () => { delayCount += 1 },
      }),
      /install exhausted 3 attempts \(registry-e503\)/u,
    )
    assert.equal(callCount, 3)
    assert.equal(delayCount, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function auditResult({ verified } = {}) {
  return {
    invalid: [],
    missing: [],
    verified: verified ?? [{
      name: 'dsh-plugin-extension-center',
      version,
      attestationBundles: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: {} }],
    }],
  }
}

function commandResult({ exitCode, stdout = '', stderr = '', timedOut = false, overflow = false, spawnError = null }) {
  return { exitCode, stdout, stderr, timedOut, overflow, spawnError }
}
