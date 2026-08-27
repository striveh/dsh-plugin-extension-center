import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AcceptanceFailure,
  CATALOG_LIST_METHOD,
  REQUIRED_HOST_OWNERS,
  PROFILE_REMOVAL_MUTATION_WHITELIST,
  assertNoManagedResolutionLinks,
  assertRequiredHostOwners,
  catalogListRequest,
  hasBlockedCredentialEnvironment,
  hasProviderEndpointOverride,
  isAcquisitionOrPlanMethod,
  keylessEnvironment,
  mutableHostStateDigest,
  parseCatalogListEnvelope,
  profileRemovalSurfaceDigest,
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
  managedPluginLifecycle: false,
  dynamicMcpConnection: false,
  durableContinuation: false,
  skillRegistry: false,
  toolRegistry: false,
  loaderMutation: false,
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
      && error.code === 'P0-RED-CENTER-MANAGED-PLUGIN-LIFECYCLE-MISSING',
  )
  assert.throws(
    () => assertRequiredHostOwners({ ...allMissing, managedPluginLifecycle: true }),
    error => error instanceof AcceptanceFailure
      && error.code === 'P0-RED-HOST-DYNAMIC-MCP-CONNECTION-OWNER-MISSING',
  )
  assert.throws(
    () => assertRequiredHostOwners({ ...allMissing, managedPluginLifecycle: true, dynamicMcpConnection: true }),
    error => error instanceof AcceptanceFailure
      && error.code === 'P0-RED-HOST-DURABLE-CONTINUATION-OWNER-MISSING',
  )
  assert.throws(
    () => assertRequiredHostOwners({
      ...allMissing,
      managedPluginLifecycle: true,
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

test('acquisition admission waits only for every lifecycle capability to become ready', async () => {
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

  attempts = 0
  const deferredOwners = await waitForAcquisitionAdmission(async () => {
    attempts += 1
    return parseCatalogListEnvelope(response(attempts === 1
      ? { ...allMissing, acquisition: false, reason: 'host-capability' }
      : { ...allAvailable, acquisition: true, reason: null }), 'owner-preflight')
  }, { timeoutMs: 100, intervalMs: 0 })
  assert.equal(attempts, 2)
  assert.deepEqual(assertRequiredHostOwners(deferredOwners.capabilities), allAvailable)

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

test('Profile removal digest ignores only declared package-manager paths and the exact generated empty Profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-center-profile-removal-surface-'))
  try {
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"name":"dsh-profile-web","private":true,"dependencies":{}}\n')
    const before = await profileRemovalSurfaceDigest(root)
    await writeFile(join(root, 'cordis.patch.yml'), '- id: fixture\n')
    await writeFile(join(root, 'cordis.yml'), [
      '# dsh profile root — an empty entry list. The tree is composed as patches:',
      '# each bundle in package.json\'s dsh.profile.bundles, then cordis.patch.yml, then any',
      '# --patch overlays. Edit cordis.patch.yml, not this file.',
      '[]',
      '',
    ].join('\n'))
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await writeFile(
      join(root, 'node_modules', '.package-map.json'),
      '{"packages":{".":{"url":"..","dependencies":{"dsh-profile-web":"."}}}}\n',
    )
    await writeFile(join(root, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n')
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
    await writeFile(join(root, 'node_modules', '.bin', 'package-manager-shim'), 'allowed')
    await mkdir(join(root, 'node_modules', '.pnpm'), { recursive: true })
    await writeFile(join(root, 'node_modules', '.pnpm', 'retained-cache'), 'allowed')
    await writeFile(
      join(root, 'node_modules', '.pnpm-workspace-state-v1.json'),
      '{"lastValidatedTimestamp":42}\n',
    )
    await writeFile(join(root, 'package.json'), '{"name":"dsh-profile-web","private":true}\n')
    assert.equal(await profileRemovalSurfaceDigest(root), before)
    assert.deepEqual(PROFILE_REMOVAL_MUTATION_WHITELIST, [
      'cordis.patch.yml',
      'cordis.yml (exact generated empty-profile bytes)',
      'pnpm-lock.yaml',
      'node_modules/.package-map.json (exact generated self-only bytes)',
      'node_modules/.modules.yaml',
      'node_modules/.bin/**',
      'node_modules/.pnpm/**',
      'node_modules/.pnpm-workspace-state-v1.json',
    ])
    await writeFile(join(root, 'cordis.yml'), '- id: unexpected\n')
    assert.notEqual(await profileRemovalSurfaceDigest(root), before)
    await writeFile(join(root, 'cordis.yml'), [
      '# dsh profile root — an empty entry list. The tree is composed as patches:',
      '# each bundle in package.json\'s dsh.profile.bundles, then cordis.patch.yml, then any',
      '# --patch overlays. Edit cordis.patch.yml, not this file.',
      '[]',
      '',
    ].join('\n'))
    await writeFile(
      join(root, 'node_modules', '.package-map.json'),
      '{"packages":{".":{"url":"..","dependencies":{"dsh-profile-web":".","stale-plugin":"1.0.0"}}}}\n',
    )
    assert.notEqual(await profileRemovalSurfaceDigest(root), before)
    await writeFile(
      join(root, 'node_modules', '.package-map.json'),
      '{"packages":{".":{"url":"..","dependencies":{"dsh-profile-web":"."}}}}\n',
    )
    await writeFile(join(root, 'unexpected.json'), '{}\n')
    assert.notEqual(await profileRemovalSurfaceDigest(root), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Profile removal rejects direct packages and indirect links into Center material', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-center-profile-resolution-links-'))
  const profileRoot = join(root, 'profile')
  const centerRoot = join(root, 'center')
  const material = join(centerRoot, 'material', 'plugins', 'fixture')
  try {
    await mkdir(join(profileRoot, 'node_modules'), { recursive: true })
    await mkdir(material, { recursive: true })
    await assertNoManagedResolutionLinks(profileRoot, centerRoot, ['dsh-plugin-extension-center', 'fixture-plugin'])
    const direct = join(profileRoot, 'node_modules', 'fixture-plugin')
    await symlink(material, direct, 'junction')
    await assert.rejects(
      assertNoManagedResolutionLinks(profileRoot, centerRoot, ['dsh-plugin-extension-center', 'fixture-plugin']),
      error => error instanceof AcceptanceFailure && error.code === 'P0-RC2-PROFILE-RESOLUTION-RESIDUE',
    )
    await rm(direct, { force: true })
    const indirect = join(profileRoot, 'node_modules', 'indirect')
    await symlink(material, indirect, 'junction')
    await assert.rejects(
      assertNoManagedResolutionLinks(profileRoot, centerRoot, ['dsh-plugin-extension-center', 'fixture-plugin']),
      error => error instanceof AcceptanceFailure && error.code === 'P0-RC2-PROFILE-RESOLUTION-RESIDUE',
    )
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
