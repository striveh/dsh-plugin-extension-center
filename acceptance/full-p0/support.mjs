import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  AcceptanceFailure,
  TARGET_DSH_COMMIT,
  TARGET_DSH_VERSION,
  describeNetworkDestination,
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
  runChecked,
  sanitizeDiagnostic,
  stopChild,
  waitForReadyUrl,
}

/** Exact read-only Extension Center channel exercised by the owner preflight. */
export const EXTENSION_CENTER_CHANNEL = '/dsh-extension-center'

/** Exact read-only method exercised by the owner preflight. */
export const CATALOG_LIST_METHOD = 'catalog/list'

/** Stable owner checks in the order the complete P0 must satisfy them. */
export const REQUIRED_HOST_OWNERS = Object.freeze([
  Object.freeze({
    key: 'profileTransaction',
    label: 'Profile transaction',
    failureCode: 'P0-RED-HOST-PROFILE-TRANSACTION-OWNER-MISSING',
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
    key: 'loaderObservation',
    label: 'Loader observation',
    failureCode: 'P0-RED-HOST-LOADER-OBSERVATION-OWNER-MISSING',
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
