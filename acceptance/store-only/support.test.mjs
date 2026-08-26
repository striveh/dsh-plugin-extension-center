import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import {
  AcceptanceFailure,
  describeNetworkDestination,
  isAdmittedBrowserRequest,
  isAdmittedBrowserWebSocket,
  parseReadyUrl,
  runChecked,
  sanitizeDiagnostic,
  stopChild,
} from './support.mjs'

test('ready URL accepts only the canonical loopback Web origin', () => {
  assert.equal(parseReadyUrl('booting\ndsh web: http://127.0.0.1:43127\n'), 'http://127.0.0.1:43127')
  assert.throws(
    () => parseReadyUrl('dsh web: http://0.0.0.0:43127'),
    error => error instanceof AcceptanceFailure && error.code === 'RED-B-NON-LOOPBACK-WEB',
  )
})

test('persisted network evidence drops URL values and credential assignments', () => {
  assert.equal(
    describeNetworkDestination('https://user:token@example.com:8443/private/canary?secret=value#fragment'),
    'https://example.com:8443',
  )
  assert.equal(describeNetworkDestination('user:token@example.com:443'), 'authority://example.com:443')
  const diagnostic = sanitizeDiagnostic('GET https://user:token@example.com/private?secret=value DEEPSEEK_API_KEY=canary Authorization: Bearer token')
  assert.equal(diagnostic, 'GET https://example.com DEEPSEEK_API_KEY=[redacted] Authorization: [redacted]')
})

test('browser network admission is exact-origin only', () => {
  const origin = 'http://127.0.0.1:43127'
  assert.equal(isAdmittedBrowserRequest(`${origin}/plugins/example/client.js`, origin), true)
  assert.equal(isAdmittedBrowserRequest('data:text/plain,fixture', origin), true)
  assert.equal(isAdmittedBrowserRequest('https://example.com/catalog.json', origin), false)
  assert.equal(isAdmittedBrowserRequest('http://127.0.0.1:43128/other', origin), false)
  assert.equal(isAdmittedBrowserWebSocket('ws://127.0.0.1:43127/rpc', origin), true)
  assert.equal(isAdmittedBrowserWebSocket('wss://example.com/rpc', origin), false)
  assert.equal(isAdmittedBrowserWebSocket('ws://127.0.0.1:43128/rpc', origin), false)
})

test('subprocess timeouts and child teardown are bounded', async () => {
  await assert.rejects(
    runChecked(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 25,
      terminationGraceMs: 25,
      killCloseMs: 100,
    }),
    /timed out/u,
  )

  const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(running, 'spawn')
  await stopChild(running)
  assert.notEqual(running.signalCode ?? running.exitCode, null)

  const exited = spawn(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], { stdio: 'ignore' })
  await once(exited, 'close')
  await stopChild(exited)
  assert.notEqual(exited.signalCode ?? exited.exitCode, null)
})
