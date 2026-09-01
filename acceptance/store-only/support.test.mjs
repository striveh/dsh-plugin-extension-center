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
  comboUrlContainsClientBundle,
  describeUnadmittedConnectionFrame,
  describeNetworkDestination,
  immutablePackageTreeDigest,
  isAdmittedBrowserRequest,
  isAdmittedBrowserWebSocket,
  parseAuthenticatedLaunchUrl,
  parseAdmittedConnectionFrame,
  parsePnpmRegistryIntegrity,
  parseReadyUrl,
  removedProfileEvidence,
  removedProfileEvidenceError,
  runChecked,
  sanitizeDiagnostic,
  stopChild,
} from './support.mjs'

test('official Host identity binds one exact registry integrity and isolated root', () => {
  const fixtureRoot = join(process.cwd(), '.official-host-fixture')
  const sourceRoot = join(process.cwd(), '.source-fixture')
  const lockfile = [
    "  '@deepseek-ai/dsh@0.1.2-alpha.3':",
    `    resolution: {integrity: ${TARGET_DSH_REGISTRY_INTEGRITY}}`,
    '    hasBin: true',
    '',
  ].join('\n')
  assert.equal(
    parsePnpmRegistryIntegrity(lockfile, '@deepseek-ai/dsh', '0.1.2-alpha.3'),
    TARGET_DSH_REGISTRY_INTEGRITY,
  )
  assert.throws(
    () => parsePnpmRegistryIntegrity(`${lockfile}${lockfile}`, '@deepseek-ai/dsh', '0.1.2-alpha.3'),
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

test('authenticated launch URL accepts only one canonical in-memory token', () => {
  const token = 'A'.repeat(43)
  const launchUrl = `http://127.0.0.1:43127/?token=${token}`
  assert.equal(parseAuthenticatedLaunchUrl(`booting\ndsh web: ${launchUrl}\n`), launchUrl)
  for (const candidate of [
    'http://127.0.0.1:43127/',
    `http://127.0.0.1:43127/?token=${token}&token=${token}`,
    `http://127.0.0.1:43127/?token=${token}&other=value`,
    `http://localhost:43127/?token=${token}`,
    `http://0.0.0.0:43127/?token=${token}`,
    `http://127.0.0.1:43127/index.html?token=${token}`,
    `http://user@127.0.0.1:43127/?token=${token}`,
    `http://127.0.0.1:43127/?token=${token}#fragment`,
    `http://127.0.0.1:43127/?token=${'A'.repeat(42)}`,
  ]) {
    assert.throws(
      () => parseAuthenticatedLaunchUrl(`dsh web: ${candidate}`),
      error => error instanceof AcceptanceFailure && error.code === 'STORE-UI-HOST-AUTH-URL',
      candidate,
    )
  }
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

test('client combo request binds the exact package entry', () => {
  const origin = 'http://127.0.0.1:43127'
  assert.equal(
    comboUrlContainsClientBundle(
      `${origin}/plugins/??a/client.js,dsh-plugin-extension-center/client.js,b/client.js&rev=nonce`,
      'dsh-plugin-extension-center',
    ),
    true,
  )
  assert.equal(
    comboUrlContainsClientBundle(
      `${origin}/plugins/??a/client.js,dsh-plugin-extension-center-other/client.js&rev=nonce`,
      'dsh-plugin-extension-center',
    ),
    false,
  )
  assert.equal(
    comboUrlContainsClientBundle(`${origin}/plugins/dsh-plugin-extension-center/client.js`, 'dsh-plugin-extension-center'),
    false,
  )
})

test('Connection frame parser admits only the official event stream', () => {
  assert.deepEqual(
    parseAdmittedConnectionFrame(JSON.stringify({
      type: 'open',
      streamId: 'stream-1',
      endpoint: '$events',
      payload: { args: {} },
    })),
    { type: 'open', streamId: 'stream-1', endpoint: '$events' },
  )
  assert.deepEqual(
    parseAdmittedConnectionFrame(JSON.stringify({ type: 'cancel', streamId: 'stream-1' })),
    { type: 'cancel', streamId: 'stream-1' },
  )
  for (const payload of [
    Buffer.from('{}'),
    'not-json',
    JSON.stringify({ type: 'open', streamId: 'stream-1', endpoint: 'lifecycle/request', payload: { args: {} } }),
    JSON.stringify({ type: 'open', streamId: 'stream-1', endpoint: '$events', payload: { args: { extra: true } } }),
    JSON.stringify({ type: 'cancel', streamId: 'stream-1', extra: true }),
  ]) {
    assert.equal(parseAdmittedConnectionFrame(payload), null)
  }
  for (const endpoint of ['workspace/follow', 'session/control']) {
    assert.deepEqual(
      parseAdmittedConnectionFrame(JSON.stringify({
        type: 'open', streamId: `stream-${endpoint}`, endpoint, payload: { args: {} },
      })),
      { type: 'open', streamId: `stream-${endpoint}`, endpoint },
    )
  }
  assert.equal(describeUnadmittedConnectionFrame(Buffer.from('{}')), 'binary-frame')
  assert.equal(
    describeUnadmittedConnectionFrame(JSON.stringify({
      type: 'open', streamId: 'stream-1', endpoint: 'lifecycle/request', payload: { args: {} },
    })),
    'other-stream-open-frame',
  )
})

test('post-remove evidence rejects retained Profile, package, list, dump, or patch state', () => {
  const packageName = 'dsh-plugin-extension-center'
  const clean = removedProfileEvidence({
    manifest: { dependencies: {}, dsh: { profile: { bundles: [] } } },
    packageName,
    packagePresent: false,
    listStdout: 'dsh-profile-web@0.0.0',
    dumpStdout: '# == @deepseek-ai/dsh-web-app',
    dumpStderr: '',
  })
  assert.equal(removedProfileEvidenceError(clean), null)
  for (const input of [
    { manifest: { dependencies: { [packageName]: 'file:artifact.tgz' }, dsh: { profile: { bundles: [] } } } },
    { manifest: { dependencies: {}, dsh: { profile: { bundles: [packageName] } } } },
    { packagePresent: true },
    { listStdout: `dsh-profile-web@0.0.0\n${packageName}@0.2.0-alpha.1` },
    { dumpStdout: `# == ${packageName}\n- id: center\n  name: ${packageName}` },
    { dumpStderr: `patch: entry "${packageName}" not found` },
  ]) {
    const retained = removedProfileEvidence({
      manifest: { dependencies: {}, dsh: { profile: { bundles: [] } } },
      packageName,
      packagePresent: false,
      listStdout: '',
      dumpStdout: '',
      dumpStderr: '',
      ...input,
    })
    assert.match(removedProfileEvidenceError(retained) ?? '', /did not prove/u)
  }
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

  const graceful = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  await once(graceful, 'spawn')
  await once(graceful.stdout, 'data')
  const gracefulResult = await stopChild(graceful, { requireRunning: true, requireGraceful: true })
  assert.deepEqual(gracefulResult, {
    wasRunning: true,
    forced: false,
    closeObserved: true,
    exitCode: 0,
    signalCode: null,
  })

  const crashed = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' })
  await once(crashed, 'close')
  await assert.rejects(
    stopChild(crashed, { requireRunning: true, requireGraceful: true }),
    /exited before runner-owned shutdown/u,
  )
})

test('strict child teardown kills a descendant that retains inherited stdout', {
  skip: process.platform === 'win32' ? 'POSIX process-group regression' : false,
}, async () => {
  const descendantCode = 'process.on("SIGTERM", () => {}); process.stdout.write("descendant-ready\\n"); setInterval(() => {}, 1000)'
  const parentCode = [
    'const { spawn } = require("node:child_process")',
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: ['ignore', 'inherit', 'ignore'] })`,
    'process.on("SIGTERM", () => process.exit(0))',
    'setInterval(() => {}, 1000)',
  ].join('; ')
  const parent = spawn(process.execPath, ['-e', parentCode], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  await once(parent, 'spawn')
  await once(parent.stdout, 'data')
  try {
    await assert.rejects(
      stopChild(parent, {
        requireRunning: true,
        requireGraceful: true,
        gracefulTimeoutMs: 50,
        killTimeoutMs: 1_000,
      }),
      /required SIGKILL during runner-owned shutdown/u,
    )
    assert.equal(parent.stdout.closed, true)
    assert.throws(
      () => process.kill(-parent.pid, 0),
      error => error?.code === 'ESRCH',
    )
  } finally {
    try {
      process.kill(-parent.pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
})
