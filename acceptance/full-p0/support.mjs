import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  AcceptanceFailure,
  TARGET_DSH_COMMIT,
  TARGET_DSH_VERSION,
  describeNetworkDestination,
  immutablePackageTreeDigest,
  installOfficialDshHost,
  runChecked,
  sanitizeDiagnostic,
  stopChild,
  waitForReadyUrl,
} from '../store-only/support.mjs'

export {
  AcceptanceFailure,
  TARGET_DSH_COMMIT,
  TARGET_DSH_VERSION,
  describeNetworkDestination,
  immutablePackageTreeDigest,
  installOfficialDshHost,
  runChecked,
  sanitizeDiagnostic,
  stopChild,
  waitForReadyUrl,
}

/** Exact read-only Extension Center channel exercised by the owner preflight. */
export const EXTENSION_CENTER_CHANNEL = '/dsh-extension-center'

/** Profile paths whose package-manager or fixture bytes may change without changing the supported Profile surface. */
export const PROFILE_REMOVAL_MUTATION_WHITELIST = Object.freeze([
  'cordis.patch.yml',
  'cordis.yml (exact generated empty-profile bytes)',
  'pnpm-lock.yaml',
  'node_modules/.package-map.json (exact generated self-only bytes)',
  'node_modules/.modules.yaml',
  'node_modules/.bin/**',
  'node_modules/.pnpm/**',
  'node_modules/.pnpm-workspace-state-v1.json',
])

const GENERATED_EMPTY_PROFILE_CONFIG = [
  '# dsh profile root — an empty entry list. The tree is composed as patches:',
  '# each bundle in package.json\'s dsh.profile.bundles, then cordis.patch.yml, then any',
  '# --patch overlays. Edit cordis.patch.yml, not this file.',
  '[]',
  '',
].join('\n')

/**
 * Prove an observed child stayed live until the acceptance runner requested teardown.
 * @param {import('node:child_process').ChildProcess | undefined} child Observed child.
 */
export function requestLiveChildTeardown(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null || !child.kill('SIGTERM')) {
    throw new AcceptanceFailure(
      'P0-LOCAL-WEB-TERMINATED',
      'Web Host exited before the acceptance runner initiated teardown',
    )
  }
}

/** Exact read-only method exercised by the owner preflight. */
export const CATALOG_LIST_METHOD = 'catalog/list'

/** Stable owner checks in the order the complete P0 must satisfy them. */
export const REQUIRED_HOST_OWNERS = Object.freeze([
  Object.freeze({
    key: 'managedPluginLifecycle',
    label: 'managed Plugin lifecycle',
    failureCode: 'P0-RED-CENTER-MANAGED-PLUGIN-LIFECYCLE-MISSING',
  }),
  Object.freeze({
    key: 'dynamicMcpConnection',
    label: 'dynamic MCP connection',
    failureCode: 'P0-RED-HOST-DYNAMIC-MCP-CONNECTION-OWNER-MISSING',
  }),
  Object.freeze({
    key: 'durableContinuation',
    label: 'durable continuation',
    failureCode: 'P0-RED-HOST-DURABLE-CONTINUATION-OWNER-MISSING',
  }),
  Object.freeze({
    key: 'skillRegistry',
    label: 'Skill registry',
    failureCode: 'P0-RED-HOST-SKILL-REGISTRY-OWNER-MISSING',
  }),
  Object.freeze({
    key: 'toolRegistry',
    label: 'Tool registry',
    failureCode: 'P0-RED-HOST-TOOL-REGISTRY-OWNER-MISSING',
  }),
  Object.freeze({
    key: 'loaderMutation',
    label: 'Loader mutation',
    failureCode: 'P0-RED-HOST-LOADER-MUTATION-MISSING',
  }),
])

/** Stable failure codes that represent an expected product Red rather than an invalid harness. */
export const OWNER_MISSING_FAILURE_CODES = new Set(
  REQUIRED_HOST_OWNERS.map(requirement => requirement.failureCode),
)

const BLOCKED_CREDENTIAL_ENV_PATTERN = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET|TOKEN|ACCESS_KEY_ID|SECRET_ACCESS_KEY|APPLICATION_CREDENTIALS|PRIVATE_KEY|CREDENTIALS)$/u
const BASE_URL_ENV_PATTERN = /BASE_URL$/u
const ACQUISITION_OR_PLAN_PATTERN = /(?:^|\/)(?:acquire|acquisition|intent|plans?|confirm|install|configure|update|uninstall|restore)(?:\/|$)/u

/** Build the only RPC request admitted by this Acceptance Red. */
export function catalogListRequest(rpcId = 'p0-host-owner-preflight') {
  if (typeof rpcId !== 'string' || rpcId.length === 0) {
    throw new TypeError('catalog/list rpcId must be a non-empty string')
  }
  return Object.freeze({
    path: `${EXTENSION_CENTER_CHANNEL}/${CATALOG_LIST_METHOD}`,
    body: Object.freeze({
      type: 'client-request',
      rpcId,
      method: CATALOG_LIST_METHOD,
      payload: Object.freeze({ protocolVersion: 1 }),
    }),
  })
}

/** Return whether an RPC method could request acquisition, planning, confirmation, or lifecycle mutation. */
export function isAcquisitionOrPlanMethod(method) {
  return typeof method === 'string' && ACQUISITION_OR_PLAN_PATTERN.test(method)
}

/** Validate the generic Connection response enough to bind this Red to the signed catalog plugin. */
export function parseCatalogListEnvelope(body, expectedRpcId) {
  const envelope = expectRecord(body, 'catalog/list response envelope')
  if (envelope.type !== 'server-response' || envelope.rpcId !== expectedRpcId) {
    throw new AcceptanceFailure(
      'P0-RED-CATALOG-RPC-ENVELOPE',
      'catalog/list did not return the correlated generic Connection response envelope',
    )
  }
  const result = expectRecord(envelope.result, 'catalog/list result')
  if (result.ok !== true) {
    throw new AcceptanceFailure('P0-RED-CATALOG-RPC-FAILURE', 'catalog/list returned a business failure')
  }
  const value = expectRecord(result.value, 'catalog/list value')
  if (value.protocolVersion !== 1 || !Array.isArray(value.entries) || value.entries.length === 0) {
    throw new AcceptanceFailure(
      'P0-RED-CATALOG-RPC-VALUE',
      'catalog/list omitted its protocol version or admitted catalog entries',
    )
  }
  const catalog = expectRecord(value.catalog, 'catalog/list catalog evidence')
  if (
    catalog.signatureStatus !== 'verified'
    || !Number.isSafeInteger(catalog.revision)
    || catalog.revision < 1
    || typeof catalog.entriesDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(catalog.entriesDigest)
  ) {
    throw new AcceptanceFailure(
      'P0-RED-CATALOG-EVIDENCE',
      'catalog/list did not expose a verified positive revision and canonical entries digest',
    )
  }
  const capabilities = expectRecord(value.hostCapabilities, 'catalog/list Host capabilities')
  for (const requirement of REQUIRED_HOST_OWNERS) {
    if (typeof capabilities[requirement.key] !== 'boolean') {
      throw new AcceptanceFailure(
        'P0-RED-HOST-OWNER-PREFLIGHT-INVALID',
        `catalog/list omitted the ${requirement.label} capability boolean`,
      )
    }
  }
  return { catalog, capabilities, value }
}

/** Require every generic Host owner without treating their presence as full P0 evidence. */
export function assertRequiredHostOwners(capabilities) {
  const observed = {}
  for (const requirement of REQUIRED_HOST_OWNERS) {
    const available = capabilities[requirement.key]
    if (typeof available !== 'boolean') {
      throw new AcceptanceFailure(
        'P0-RED-HOST-OWNER-PREFLIGHT-INVALID',
        `${requirement.label} capability must be boolean`,
      )
    }
    observed[requirement.key] = available
    if (!available) {
      throw new AcceptanceFailure(
        requirement.failureCode,
        `${requirement.label} owner is unavailable on the exact packed Host`,
      )
    }
  }
  return Object.freeze(observed)
}

/**
 * Wait for the writable Host generation after every required owner is live.
 * The observer must validate the signed catalog envelope and owner booleans on
 * every attempt, so this wait admits only the documented activating state.
 */
export async function waitForAcquisitionAdmission(observe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 50
  if (typeof observe !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0
    || !Number.isSafeInteger(intervalMs) || intervalMs < 0) {
    throw new TypeError('acquisition admission wait requires an observer and non-negative integer timing')
  }
  const deadline = Date.now() + timeoutMs
  while (true) {
    const observed = await observe()
    if (observed?.value?.hostCapabilities?.acquisition === true
      && observed.value.hostCapabilities.reason === null) return observed
    const remaining = deadline - Date.now()
    if (remaining <= 0) return observed
    await delay(Math.min(intervalMs, remaining))
  }
}

/** Remove inherited provider credentials and provider endpoint overrides from a child environment. */
export function keylessEnvironment(environment) {
  const result = { ...environment }
  for (const key of Object.keys(result)) {
    if (BLOCKED_CREDENTIAL_ENV_PATTERN.test(key) || BASE_URL_ENV_PATTERN.test(key)) delete result[key]
  }
  return result
}

/** Return whether a child environment still carries a blocked provider credential variable. */
export function hasBlockedCredentialEnvironment(environment) {
  return Object.keys(environment).some(key => BLOCKED_CREDENTIAL_ENV_PATTERN.test(key))
}

/** Return whether a child environment still carries a provider endpoint override. */
export function hasProviderEndpointOverride(environment) {
  return Object.keys(environment).some(key => BASE_URL_ENV_PATTERN.test(key))
}

/** Route proxy-aware non-loopback Host traffic through the rejecting proxy ledger. */
export function denyProxyEnvironment(environment, proxyUrl) {
  const result = {
    ...environment,
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  }
  delete result.ALL_PROXY
  delete result.all_proxy
  return result
}

/** Start a loopback proxy that records and rejects every external Host attempt. */
export async function startDenyProxy(ledger) {
  const server = createServer((request, response) => {
    ledger.push(`${request.method ?? 'UNKNOWN'} ${describeNetworkDestination(request.url ?? '')}`)
    response.writeHead(502, { 'content-type': 'text/plain' })
    response.end('external network denied by P0-R-001')
  })
  server.on('connect', (request, socket) => {
    ledger.push(`CONNECT ${describeNetworkDestination(request.url ?? '')}`)
    socket.destroy()
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('deny proxy did not bind a TCP port')
  }
  return { server, url: `http://127.0.0.1:${String(address.port)}` }
}

/** Stop the deny proxy after every Host process has reached quiescence. */
export async function stopDenyProxy(proxy) {
  if (proxy === undefined) return
  proxy.server.closeAllConnections?.()
  await new Promise((resolveClose, rejectClose) => {
    proxy.server.close((error) => {
      if (error !== undefined) rejectClose(error)
      else resolveClose()
    })
  })
}

/** Hash mutable Host, Agents, workspace, and Profile state while excluding dependency trees. */
export async function mutableHostStateDigest(roots) {
  const hash = createHash('sha256')
  for (const [index, root] of roots.entries()) {
    hash.update(`root:${String(index)}\0`)
    await hashMutableTree(root, root, hash)
  }
  return hash.digest('hex')
}

/**
 * Hash the Profile surface outside the exact package-manager and fixture mutation whitelist.
 * @param {string} profileRoot Exact initialized Profile root.
 * @returns {Promise<string>} SHA-256 surface digest.
 */
export async function profileRemovalSurfaceDigest(profileRoot) {
  const root = resolve(profileRoot)
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (!isRecord(manifest) || typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new AcceptanceFailure('P0-LATEST-DSH-PROFILE-MANIFEST', 'Profile package.json must name the Profile package')
  }
  const hash = createHash('sha256')
  await hashProfileRemovalSurface(root, root, hash, manifest.name)
  return `sha256:${hash.digest('hex')}`
}

/**
 * Reject direct or indirect Center-managed resolution links after child and Center removal.
 * @param {string} profileRoot Exact Profile root.
 * @param {string} centerRoot Canonical Center state root.
 * @param {readonly string[]} packageNames Center and managed child package names.
 * @returns {Promise<void>} Completion after the resolution surface is clean.
 */
export async function assertNoManagedResolutionLinks(profileRoot, centerRoot, packageNames) {
  const modules = join(resolve(profileRoot), 'node_modules')
  const ownedRoot = resolve(centerRoot)
  for (const packageName of packageNames) {
    const invalidSegment = typeof packageName === 'string'
      && packageName.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
    if (typeof packageName !== 'string' || packageName.length === 0 || invalidSegment) {
      throw new TypeError('managed resolution-link audit requires canonical package names')
    }
    const direct = join(modules, ...packageName.split('/'))
    const info = await optionalLstat(direct)
    if (info !== null) {
      throw new AcceptanceFailure(
        'P0-LATEST-DSH-PROFILE-RESOLUTION-RESIDUE',
        `removed package retained a direct Profile resolution entry: ${packageName}`,
      )
    }
  }
  if (await optionalLstat(modules) === null) return
  const inspect = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (path === modules && entry.name === '.pnpm') continue
      const child = join(path, entry.name)
      if (entry.name.startsWith('.dsh-center-link-') || entry.name.startsWith('.dsh-center-unlink-')) {
        throw new AcceptanceFailure(
          'P0-LATEST-DSH-PROFILE-RESOLUTION-RESIDUE',
          'removed Plugin retained a Center resolution transaction entry',
        )
      }
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(child), await readlink(child))
        if (isInside(ownedRoot, target)) {
          throw new AcceptanceFailure(
            'P0-LATEST-DSH-PROFILE-RESOLUTION-RESIDUE',
            'removed Plugin retained a Profile link into Center-owned material',
          )
        }
      } else if (entry.isDirectory()) {
        await inspect(child)
      }
    }
  }
  await inspect(modules)
}

/** Reject package-manager lifecycle code before packing and from the final tarball manifest. */
export function assertNoPackageLifecycleScripts(manifest, phase) {
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {}
  const lifecycleScripts = Object.keys(scripts).filter(script => (
    /^(?:pre|post)?(?:install|uninstall)$/u.test(script)
    || ['prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack'].includes(script)
  ))
  if (lifecycleScripts.length > 0) {
    throw new AcceptanceFailure(
      'P0-RED-ARTIFACT-LIFECYCLE',
      `${phase} manifest declared lifecycle scripts: ${lifecycleScripts.join(', ')}`,
    )
  }
}

/** Return a lowercase SHA-256 digest for one immutable artifact. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Settle after a short observation window without blocking a process thread. */
export function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

function expectRecord(value, subject) {
  if (!isRecord(value)) {
    throw new AcceptanceFailure('P0-RED-PREFLIGHT-PROTOCOL', `${subject} must be a JSON object`)
  }
  return value
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function hashMutableTree(root, path, hash) {
  const info = await lstat(path)
  const name = relative(root, path).replaceAll('\\', '/') || '.'
  if (info.isSymbolicLink()) {
    hash.update(`link:${name}:${await readlink(path)}\0`)
    return
  }
  if (info.isFile()) {
    hash.update(`file:${name}:${String(info.mode)}:${String(info.size)}\0`)
    hash.update(await readFile(path))
    return
  }
  if (!info.isDirectory()) {
    hash.update(`other:${name}:${String(info.mode)}\0`)
    return
  }
  hash.update(`dir:${name}:${String(info.mode)}\0`)
  const entries = (await readdir(path, { withFileTypes: true }))
    .filter(entry => entry.name !== 'node_modules')
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) await hashMutableTree(root, join(path, entry.name), hash)
}

async function hashProfileRemovalSurface(root, path, hash, profilePackageName) {
  const name = relative(root, path).replaceAll('\\', '/') || '.'
  if (profileRemovalPathWhitelisted(name)) return
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    hash.update(`link:${name}:${await readlink(path)}\0`)
    return
  }
  if (info.isFile()) {
    const source = await readFile(path)
    if (name === 'cordis.yml' && source.equals(Buffer.from(GENERATED_EMPTY_PROFILE_CONFIG))) return
    if (name === 'node_modules/.package-map.json'
      && source.equals(generatedSelfOnlyPackageMap(profilePackageName))) return
    const bytes = name === 'package.json'
      ? Buffer.from(`${canonicalJson(normalizedProfileManifest(JSON.parse(await readFile(path, 'utf8'))))}\n`)
      : source
    hash.update(`file:${name}:${String(bytes.length)}\0`)
    hash.update(bytes)
    return
  }
  if (!info.isDirectory()) {
    hash.update(`other:${name}\0`)
    return
  }
  const entries = (await readdir(path, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    await hashProfileRemovalSurface(root, join(path, entry.name), hash, profilePackageName)
  }
}

function profileRemovalPathWhitelisted(path) {
  return path === 'cordis.patch.yml'
    || path === 'pnpm-lock.yaml'
    || path === 'node_modules/.modules.yaml'
    || path === 'node_modules/.pnpm-workspace-state-v1.json'
    || path === 'node_modules/.bin'
    || path.startsWith('node_modules/.bin/')
    || path === 'node_modules/.pnpm'
    || path.startsWith('node_modules/.pnpm/')
}

function generatedSelfOnlyPackageMap(profilePackageName) {
  return Buffer.from(`${JSON.stringify({
    packages: {
      '.': {
        url: '..',
        dependencies: { [profilePackageName]: '.' },
      },
    },
  })}\n`)
}

async function optionalLstat(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function isInside(root, path) {
  const offset = relative(root, path)
  return offset === '' || offset !== '..' && !offset.startsWith(`..${sep}`)
}

function normalizedProfileManifest(manifest) {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new AcceptanceFailure('P0-LATEST-DSH-PROFILE-MANIFEST', 'Profile package.json must be an object')
  }
  return { ...manifest, dependencies: manifest.dependencies ?? {} }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
