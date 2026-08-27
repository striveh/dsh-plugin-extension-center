import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import {
  collectFailClosedMcpCardEvidence,
  createStoreJourneyWindow,
  failClosedMcpCardEvidenceError,
} from './journey-evidence.mjs'
import {
  AcceptanceFailure,
  TARGET_DSH_REGISTRY_INTEGRITY,
  assertIsolatedOfficialHostPaths,
  describeNetworkDestination,
  immutablePackageTreeDigest,
  isAdmittedBrowserRequest,
  isAdmittedBrowserWebSocket,
  parsePnpmRegistryIntegrity,
  parseReadyUrl,
  runChecked,
  sanitizeDiagnostic,
  stopChild,
} from './support.mjs'

test('official Host identity binds one exact registry integrity and isolated root', () => {
  const fixtureRoot = join(process.cwd(), '.official-host-fixture')
  const sourceRoot = join(process.cwd(), '.source-fixture')
  const lockfile = [
    "  '@deepseek-ai/dsh@0.1.1-rc.2':",
    `    resolution: {integrity: ${TARGET_DSH_REGISTRY_INTEGRITY}}`,
    '    hasBin: true',
    '',
  ].join('\n')
  assert.equal(
    parsePnpmRegistryIntegrity(lockfile, '@deepseek-ai/dsh', '0.1.1-rc.2'),
    TARGET_DSH_REGISTRY_INTEGRITY,
  )
  assert.throws(
    () => parsePnpmRegistryIntegrity(`${lockfile}${lockfile}`, '@deepseek-ai/dsh', '0.1.1-rc.2'),
    error => error instanceof AcceptanceFailure && error.code === 'OFFICIAL-HOST-LOCK-INTEGRITY',
  )
  assert.doesNotThrow(() => assertIsolatedOfficialHostPaths({
    hostRoot: fixtureRoot,
    projectRoot: sourceRoot,
    dshBin: join(fixtureRoot, 'node_modules', '.bin', 'dsh'),
    packageRoot: join(fixtureRoot, 'node_modules', '.pnpm', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'),
  }))
  assert.throws(
    () => assertIsolatedOfficialHostPaths({
      hostRoot: fixtureRoot,
      projectRoot: sourceRoot,
      dshBin: join(sourceRoot, 'node_modules', '.bin', 'dsh'),
      packageRoot: join(fixtureRoot, 'node_modules', '@deepseek-ai', 'dsh'),
    }),
    error => error instanceof AcceptanceFailure && error.code === 'OFFICIAL-HOST-NOT-ISOLATED',
  )
})

test('official package tree digest is deterministic and detects byte changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-center-official-host-tree-'))
  try {
    await mkdir(join(root, 'lib'))
    await writeFile(join(root, 'package.json'), '{"name":"@deepseek-ai/dsh"}\n')
    await writeFile(join(root, 'lib', 'bin.js'), 'console.log("rc.2")\n')
    const before = await immutablePackageTreeDigest(root)
    assert.equal(await immutablePackageTreeDigest(root), before)
    await writeFile(join(root, 'lib', 'bin.js'), 'console.log("modified")\n')
    assert.notEqual(await immutablePackageTreeDigest(root), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ready URL accepts only the canonical loopback Web origin', () => {
  assert.equal(parseReadyUrl('booting\ndsh web: http://127.0.0.1:43127\n'), 'http://127.0.0.1:43127')
  assert.throws(
    () => parseReadyUrl('dsh web: http://0.0.0.0:43127'),
    error => error instanceof AcceptanceFailure && error.code === 'STORE-UI-NON-LOOPBACK-WEB',
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

test('Store journey evidence classifies Center RPC from navigation start through context close', () => {
  const journey = createStoreJourneyWindow()
  assert.equal(journey.shouldClassifyRpc('POST', '/dsh-extension-center/lifecycle/request'), false)
  journey.start()
  assert.equal(journey.shouldClassifyRpc('POST', '/dsh-extension-center/lifecycle/request'), true)
  assert.equal(journey.shouldClassifyRpc('POST', '/dsh-extension-center/intent/preview'), true)
  assert.equal(journey.shouldClassifyRpc('GET', '/dsh-extension-center/catalog/list'), false)
  assert.equal(journey.shouldClassifyRpc('POST', '/dsh-host/onboarding'), false)
  assert.equal(journey.isActive(), true)
  assert.throws(() => journey.start(), /already active/u)
  journey.finish()
  assert.equal(journey.shouldClassifyRpc('POST', '/dsh-extension-center/lifecycle/request'), false)
  assert.equal(journey.isActive(), false)
})

test('MCP fail-closed evidence binds each button to its exact candidate card', () => {
  const refs = ['mcp:example/filesystem@1.2.2', 'mcp:example/filesystem@1.3.0']
  const compromised = new JSDOM(`
    <section id="store">
      <article data-candidate-ref="mcp:example/filesystem@1.2.2"><span data-kind="mcp"></span><button>Add connection</button></article>
      <article data-candidate-ref="mcp:example/filesystem@1.3.0"><span data-kind="mcp"></span><button disabled title="No admitted runtime is provisioned">Acquire unavailable</button></article>
      <article data-candidate-ref="skill:example/unrelated@1"><span data-kind="skill"></span><button disabled title="No admitted runtime is provisioned">Acquire unavailable</button></article>
    </section>
  `).window.document.querySelector('#store')
  assert.notEqual(compromised, null)
  const compromisedEvidence = collectFailClosedMcpCardEvidence(compromised, refs)
  assert.equal(compromised.querySelectorAll('button[disabled]').length, 2)
  assert.match(failClosedMcpCardEvidenceError(compromisedEvidence) ?? '', /filesystem@1\.2\.2/u)

  const failClosed = new JSDOM(`
    <section id="store">
      ${refs.map(ref => `<article data-candidate-ref="${ref}"><span data-kind="mcp"></span><button disabled title="No admitted runtime is provisioned">Acquire unavailable</button></article>`).join('')}
    </section>
  `).window.document.querySelector('#store')
  assert.notEqual(failClosed, null)
  const evidence = collectFailClosedMcpCardEvidence(failClosed, refs)
  assert.equal(failClosedMcpCardEvidenceError(evidence), null)
  assert.deepEqual(evidence.map(entry => entry.observedCandidateRef), refs)
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
