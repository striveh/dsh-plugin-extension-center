import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AcceptanceFailure,
  CATALOG_LIST_METHOD,
  REQUIRED_HOST_OWNERS,
  assertRequiredHostOwners,
  catalogListRequest,
  hasBlockedCredentialEnvironment,
  hasProviderEndpointOverride,
  isAcquisitionOrPlanMethod,
  keylessEnvironment,
  mutableHostStateDigest,
  parseCatalogListEnvelope,
  requestLiveChildTeardown,
  stopChild,
  waitForAcquisitionAdmission,
} from './support.mjs'

function response(capabilities) {
  return {
    type: 'server-response',
    rpcId: 'owner-preflight',
    result: {
      ok: true,
      value: {
        protocolVersion: 1,
        catalog: {
          revision: 1,
          entriesDigest: `sha256:${'a'.repeat(64)}`,
          signatureStatus: 'verified',
        },
        hostCapabilities: capabilities,
        entries: [{ candidateRef: 'skill:fixture@v1' }],
      },
    },
  }
}

const allMissing = {
  profileTransaction: false,
  dynamicMcpConnection: false,
  durableContinuation: false,
  skillRegistry: false,
  toolRegistry: false,
  loaderObservation: false,
}

const allAvailable = Object.fromEntries(
  REQUIRED_HOST_OWNERS.map(requirement => [requirement.key, true]),
)

test('the preflight emits only the exact read-only catalog/list request', () => {
  const request = catalogListRequest('owner-preflight')
  assert.equal(request.path, '/dsh-extension-center/catalog/list')
  assert.deepEqual(request.body, {
    type: 'client-request',
    rpcId: 'owner-preflight',
    method: CATALOG_LIST_METHOD,
    payload: { protocolVersion: 1 },
  })
  assert.equal(isAcquisitionOrPlanMethod(request.body.method), false)
  for (const method of ['acquisition/request', 'plans/create', 'confirm', 'install', 'configure', 'update', 'uninstall', 'restore']) {
    assert.equal(isAcquisitionOrPlanMethod(method), true, method)
  }
})

test('owner failures are stable and ordered', () => {
  const parsed = parseCatalogListEnvelope(response(allMissing), 'owner-preflight')
  assert.throws(
    () => assertRequiredHostOwners(parsed.capabilities),
    error => error instanceof AcceptanceFailure
      && error.code === 'P0-RED-HOST-PROFILE-TRANSACTION-OWNER-MISSING',
  )
  assert.throws(
    () => assertRequiredHostOwners({ ...allMissing, profileTransaction: true }),
    error => error instanceof AcceptanceFailure
      && error.code === 'P0-RED-HOST-DYNAMIC-MCP-CONNECTION-OWNER-MISSING',
  )
  assert.throws(
    () => assertRequiredHostOwners({ ...allMissing, profileTransaction: true, dynamicMcpConnection: true }),
    error => error instanceof AcceptanceFailure
      && error.code === 'P0-RED-HOST-DURABLE-CONTINUATION-OWNER-MISSING',
  )
  assert.throws(
    () => assertRequiredHostOwners({
      ...allMissing,
      profileTransaction: true,
      dynamicMcpConnection: true,
      durableContinuation: true,
    }),
    error => error instanceof AcceptanceFailure
      && error.code === 'P0-RED-HOST-SKILL-REGISTRY-OWNER-MISSING',
  )
  assert.deepEqual(
    assertRequiredHostOwners(allAvailable),
    allAvailable,
  )
  assert.equal(REQUIRED_HOST_OWNERS.length, 6)
})

test('acquisition admission waits only for a live-owner generation to activate', async () => {
  let attempts = 0
  const admitted = await waitForAcquisitionAdmission(async () => {
    attempts += 1
    const parsed = parseCatalogListEnvelope(response({
      ...allAvailable,
      acquisition: attempts === 2,
      reason: attempts === 2 ? null : 'host-capability',
    }), 'owner-preflight')
    assertRequiredHostOwners(parsed.capabilities)
    return parsed
  }, { timeoutMs: 100, intervalMs: 0 })
  assert.equal(attempts, 2)
  assert.equal(admitted.value.hostCapabilities.acquisition, true)

  const activating = await waitForAcquisitionAdmission(async () => {
    const parsed = parseCatalogListEnvelope(response({
      ...allAvailable,
      acquisition: false,
      reason: 'host-capability',
    }), 'owner-preflight')
    assertRequiredHostOwners(parsed.capabilities)
    return parsed
  }, { timeoutMs: 0 })
  assert.equal(activating.value.hostCapabilities.acquisition, false)
})

test('the response must carry correlated signed-catalog evidence', () => {
  assert.throws(
    () => parseCatalogListEnvelope({ ...response({}), rpcId: 'other' }, 'owner-preflight'),
    error => error instanceof AcceptanceFailure && error.code === 'P0-RED-CATALOG-RPC-ENVELOPE',
  )
  const invalid = response(allMissing)
  invalid.result.value.catalog.signatureStatus = 'unknown'
  assert.throws(
    () => parseCatalogListEnvelope(invalid, 'owner-preflight'),
    error => error instanceof AcceptanceFailure && error.code === 'P0-RED-CATALOG-EVIDENCE',
  )
})

test('keyless children receive no provider credential or endpoint override', () => {
  const environment = keylessEnvironment({
    PATH: '/bin',
    DEEPSEEK_API_KEY: 'canary',
    DEEPSEEK_BASE_URL: 'https://provider.invalid/canary',
    SOME_ACCESS_TOKEN: 'canary',
  })
  assert.deepEqual(environment, { PATH: '/bin' })
  assert.equal(hasBlockedCredentialEnvironment(environment), false)
  assert.equal(hasProviderEndpointOverride(environment), false)
})

test('mutable state digest detects target writes and ignores dependency-tree noise', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-center-owner-gate-support-'))
  try {
    await writeFile(join(root, 'state.json'), '{}\n')
    const before = await mutableHostStateDigest([root])
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'ignored'), 'noise')
    assert.equal(await mutableHostStateDigest([root]), before)
    await writeFile(join(root, 'state.json'), '{"changed":true}\n')
    assert.notEqual(await mutableHostStateDigest([root]), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a passed lane accepts only a Web child still live at runner-owned teardown', async () => {
  const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(running, 'spawn')
  requestLiveChildTeardown(running)
  await stopChild(running)

  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await once(exited, 'close')
  assert.throws(
    () => requestLiveChildTeardown(exited),
    error => error instanceof AcceptanceFailure && error.code === 'P0-LOCAL-WEB-TERMINATED',
  )
})
