import type { ClientConnectionRpc, RpcError } from '@deepseek-ai/dsh-client-connection/client'
import {
  EXTENSION_CENTER_PROTOCOL_VERSION,
  EXTENSION_CENTER_RPC_CHANNEL,
  type CatalogEntry,
  type CatalogListResponse,
  type CatalogLifecycleAction,
  type LocalizedText,
} from '../catalog-contract.ts'

const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_ENTRIES = 100
const MAX_STRING = 4_096
const EXTENSION_KINDS = new Set(['plugin', 'mcp', 'skill'])
const SOURCE_TYPES = new Set(['github-release', 'mcp-registry', 'github-content'])
const PUBLISHER_STATUSES = new Set(['community', 'upstream-registry'])
const LICENSE_STATUSES = new Set(['verified', 'publisher-declared', 'unknown'])
const COMPATIBILITY_STATUSES = new Set(['compatible', 'review-required'])
const PLATFORMS = new Set(['darwin', 'linux', 'windows'])
const PERMISSION_PHASES = new Set(['acquisition', 'runtime'])
const PERMISSION_KINDS = new Set(['network', 'filesystem', 'subprocess', 'credentials', 'model-context'])
const PERMISSION_ACCESS = new Set(['none', 'read', 'write', 'execute', 'send'])
const DEPENDENCY_KINDS = new Set(['host', 'runtime', 'extension'])
const SCOPES = new Set(['profile:web', 'user', 'project'])
const CREDENTIAL_STATES = new Set(['none', 'optional', 'required'])
const VERIFICATION_STATES = new Set(['verified', 'declared', 'unknown'])

/** Error returned through a valid Connection RPC business-failure envelope. */
export class ExtensionCenterRpcError extends Error {
  readonly code: RpcError['code']

  /** @param error - Connection RPC error already validated by the carrier. */
  constructor(error: RpcError) {
    super(error.message)
    this.name = 'ExtensionCenterRpcError'
    this.code = error.code
  }
}

/** Browser client for the verified Store catalog projection. */
export interface ExtensionCatalogClient {
  /** Read the current verified snapshot projection. */
  list(signal?: AbortSignal): Promise<CatalogListResponse>
  /** Explicitly ask the loopback Host to refresh its fixed signed catalog endpoint. */
  refresh?(signal?: AbortSignal): Promise<CatalogListResponse>
}

function expectRecord(value: unknown, subject: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`extension-center: invalid ${subject}`)
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`extension-center: unexpected fields in ${subject}`)
  }
  return record
}

function expectString(value: unknown, subject: string, maxLength = MAX_STRING): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`extension-center: invalid ${subject}`)
  }
  return value
}

function expectBoolean(value: unknown, subject: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`extension-center: invalid ${subject}`)
  return value
}

function expectSafeInteger(value: unknown, subject: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`extension-center: invalid ${subject}`)
  }
  return value as number
}

function expectArray(value: unknown, subject: string, maxItems: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`extension-center: invalid ${subject}`)
  }
  return value
}

function expectEnum(value: unknown, subject: string, allowed: ReadonlySet<string>): string {
  const result = expectString(value, subject, 128)
  if (!allowed.has(result)) throw new Error(`extension-center: invalid ${subject}`)
  return result
}

function expectHttpsUrl(value: unknown, subject: string): string {
  const result = expectString(value, subject, 2_048)
  let url: URL
  try {
    url = new URL(result)
  } catch {
    throw new Error(`extension-center: invalid ${subject}`)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error(`extension-center: invalid ${subject}`)
  }
  return result
}

function expectIntegrity(value: unknown, subject: string): string {
  const result = expectString(value, subject, 512)
  const validSha256 = /^sha256:[a-f0-9]{64}$/.test(result)
  const validSha512 = /^sha512:[A-Za-z0-9+/]{86}==$/.test(result)
  if (!validSha256 && !validSha512) throw new Error(`extension-center: invalid ${subject}`)
  return result
}

function validateLocalized(value: unknown, subject: string): LocalizedText {
  const input = expectRecord(value, subject, ['en', 'zh'])
  expectString(input.en, `${subject}.en`, 1_500)
  expectString(input.zh, `${subject}.zh`, 1_500)
  return input as unknown as LocalizedText
}

function validateLifecycleAction(value: unknown, subject: string): CatalogLifecycleAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`extension-center: invalid ${subject}`)
  }
  const raw = value as Record<string, unknown>
  const status = expectEnum(raw.status, `${subject}.status`, new Set(['available', 'unavailable']))
  const input = expectRecord(value, subject, status === 'available' ? ['status'] : ['reason', 'status'])
  if (status === 'unavailable') expectString(input.reason, `${subject}.reason`, 128)
  return input as unknown as CatalogLifecycleAction
}

function validateEntry(value: unknown, index: number): CatalogEntry {
  const subject = `catalog entry ${index}`
  const input = expectRecord(value, subject, [
    'artifact', 'candidateRef', 'compatibility', 'components', 'configuration', 'conflicts',
    'dependencies', 'displayName', 'kind', 'license', 'lifecycle', 'name', 'permissions', 'publisher',
    'restart', 'retainedData', 'scopes', 'source', 'summary', 'tags', 'verification',
  ])
  const kind = expectEnum(input.kind, `${subject}.kind`, EXTENSION_KINDS)
  const candidateRef = expectString(input.candidateRef, `${subject}.candidateRef`, 512)
  if (!candidateRef.startsWith(`${kind}:`)) throw new Error(`extension-center: invalid ${subject}.candidateRef`)
  expectString(input.name, `${subject}.name`, 256)
  validateLocalized(input.displayName, `${subject}.displayName`)
  validateLocalized(input.summary, `${subject}.summary`)

  const publisher = expectRecord(input.publisher, `${subject}.publisher`, ['name', 'status'])
  expectString(publisher.name, `${subject}.publisher.name`, 256)
  expectEnum(publisher.status, `${subject}.publisher.status`, PUBLISHER_STATUSES)

  const license = expectRecord(input.license, `${subject}.license`, ['sourceUrl', 'spdx', 'status'])
  const licenseStatus = expectEnum(license.status, `${subject}.license.status`, LICENSE_STATUSES)
  if (licenseStatus === 'unknown') {
    if (license.spdx !== null || license.sourceUrl !== null) throw new Error(`extension-center: invalid ${subject}.license evidence`)
  } else {
    expectString(license.spdx, `${subject}.license.spdx`, 256)
    expectHttpsUrl(license.sourceUrl, `${subject}.license.sourceUrl`)
  }

  const source = expectRecord(input.source, `${subject}.source`, [
    'admittedAt', 'label', 'revision', 'type', 'upstreamUrl', 'url',
  ])
  expectEnum(source.type, `${subject}.source.type`, SOURCE_TYPES)
  expectString(source.label, `${subject}.source.label`, 256)
  expectHttpsUrl(source.url, `${subject}.source.url`)
  expectHttpsUrl(source.upstreamUrl, `${subject}.source.upstreamUrl`)
  const revision = expectString(source.revision, `${subject}.source.revision`, 256)
  if (revision === 'main' || revision === 'master' || revision === 'latest') {
    throw new Error(`extension-center: moving ${subject}.source.revision`)
  }
  if (!Number.isFinite(Date.parse(expectString(source.admittedAt, `${subject}.source.admittedAt`, 64)))) {
    throw new Error(`extension-center: invalid ${subject}.source.admittedAt`)
  }

  const artifact = expectRecord(input.artifact, `${subject}.artifact`, [
    'acquisitionUrl', 'id', 'integrity', 'sizeBytes', 'version',
  ])
  expectString(artifact.id, `${subject}.artifact.id`, 512)
  const version = expectString(artifact.version, `${subject}.artifact.version`, 256)
  if (version === 'latest' || version === 'main' || version === 'master') {
    throw new Error(`extension-center: moving ${subject}.artifact.version`)
  }
  expectIntegrity(artifact.integrity, `${subject}.artifact.integrity`)
  expectSafeInteger(artifact.sizeBytes, `${subject}.artifact.sizeBytes`, 1)
  expectHttpsUrl(artifact.acquisitionUrl, `${subject}.artifact.acquisitionUrl`)

  const compatibility = expectRecord(input.compatibility, `${subject}.compatibility`, [
    'detail', 'dsh', 'platforms', 'status',
  ])
  expectEnum(compatibility.status, `${subject}.compatibility.status`, COMPATIBILITY_STATUSES)
  if (compatibility.dsh !== '0.1.1-rc.2') throw new Error(`extension-center: invalid ${subject}.compatibility.dsh`)
  const platforms = expectArray(compatibility.platforms, `${subject}.compatibility.platforms`, 3)
  if (platforms.length === 0) throw new Error(`extension-center: empty ${subject}.compatibility.platforms`)
  platforms.forEach((platform, at) => { expectEnum(platform, `${subject}.compatibility.platforms[${at}]`, PLATFORMS) })
  validateLocalized(compatibility.detail, `${subject}.compatibility.detail`)

  expectArray(input.components, `${subject}.components`, 30)
    .forEach((component, at) => { validateLocalized(component, `${subject}.components[${at}]`) })
  expectArray(input.permissions, `${subject}.permissions`, 30).forEach((permission, at) => {
    const row = expectRecord(permission, `${subject}.permissions[${at}]`, ['access', 'detail', 'kind', 'phase'])
    expectEnum(row.phase, `${subject}.permissions[${at}].phase`, PERMISSION_PHASES)
    expectEnum(row.kind, `${subject}.permissions[${at}].kind`, PERMISSION_KINDS)
    expectEnum(row.access, `${subject}.permissions[${at}].access`, PERMISSION_ACCESS)
    validateLocalized(row.detail, `${subject}.permissions[${at}].detail`)
  })
  expectArray(input.dependencies, `${subject}.dependencies`, 30).forEach((dependency, at) => {
    const row = expectRecord(dependency, `${subject}.dependencies[${at}]`, ['id', 'kind', 'required', 'version'])
    expectEnum(row.kind, `${subject}.dependencies[${at}].kind`, DEPENDENCY_KINDS)
    expectString(row.id, `${subject}.dependencies[${at}].id`, 512)
    expectString(row.version, `${subject}.dependencies[${at}].version`, 256)
    expectBoolean(row.required, `${subject}.dependencies[${at}].required`)
  })
  const scopes = expectArray(input.scopes, `${subject}.scopes`, 3)
  if (scopes.length === 0) throw new Error(`extension-center: empty ${subject}.scopes`)
  scopes.forEach((scope, at) => { expectEnum(scope, `${subject}.scopes[${at}]`, SCOPES) })

  const configuration = expectRecord(input.configuration, `${subject}.configuration`, ['credentials', 'fields', 'required'])
  expectBoolean(configuration.required, `${subject}.configuration.required`)
  expectEnum(configuration.credentials, `${subject}.configuration.credentials`, CREDENTIAL_STATES)
  expectArray(configuration.fields, `${subject}.configuration.fields`, 30)
    .forEach((field, at) => { validateLocalized(field, `${subject}.configuration.fields[${at}]`) })
  expectArray(input.conflicts, `${subject}.conflicts`, 30)
    .forEach((conflict, at) => { validateLocalized(conflict, `${subject}.conflicts[${at}]`) })
  const restart = expectRecord(input.restart, `${subject}.restart`, ['detail', 'required'])
  expectBoolean(restart.required, `${subject}.restart.required`)
  validateLocalized(restart.detail, `${subject}.restart.detail`)

  const lifecycle = expectRecord(input.lifecycle, `${subject}.lifecycle`, [
    'configure', 'install', 'restore', 'uninstall', 'update',
  ])
  for (const action of ['install', 'configure', 'update', 'uninstall', 'restore'] as const) {
    validateLifecycleAction(lifecycle[action], `${subject}.lifecycle.${action}`)
  }
  expectArray(input.verification, `${subject}.verification`, 30).forEach((verification, at) => {
    const row = expectRecord(verification, `${subject}.verification[${at}]`, ['claim', 'detail', 'status'])
    validateLocalized(row.claim, `${subject}.verification[${at}].claim`)
    expectEnum(row.status, `${subject}.verification[${at}].status`, VERIFICATION_STATES)
    validateLocalized(row.detail, `${subject}.verification[${at}].detail`)
  })
  validateLocalized(input.retainedData, `${subject}.retainedData`)
  expectArray(input.tags, `${subject}.tags`, 30)
    .forEach((tag, at) => { expectString(tag, `${subject}.tags[${at}]`, 80) })
  return input as unknown as CatalogEntry
}

/** Deeply validate a Host catalog response before rendering any field. */
export function parseCatalogListResponse(value: unknown): CatalogListResponse {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new Error('extension-center: catalog response is not JSON-compatible')
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('extension-center: catalog response is oversized')
  }
  const input = expectRecord(value, 'catalog response', ['catalog', 'entries', 'hostCapabilities', 'protocolVersion'])
  if (input.protocolVersion !== EXTENSION_CENTER_PROTOCOL_VERSION) {
    throw new Error('extension-center: incompatible protocol version')
  }
  const catalog = expectRecord(input.catalog, 'catalog response.catalog', [
    'degraded', 'degradedReason', 'entriesDigest', 'expiresAt', 'freshness', 'id', 'issuedAt', 'keyIds',
    'lastRefreshAtMs', 'revision', 'signatureStatus', 'source',
  ])
  expectString(catalog.id, 'catalog response.catalog.id', 256)
  expectSafeInteger(catalog.revision, 'catalog response.catalog.revision', 1)
  const issuedAt = Date.parse(expectString(catalog.issuedAt, 'catalog response.catalog.issuedAt', 64))
  const expiresAt = Date.parse(expectString(catalog.expiresAt, 'catalog response.catalog.expiresAt', 64))
  for (const [field, timestamp] of [['issuedAt', issuedAt], ['expiresAt', expiresAt]] as const) {
    if (!Number.isFinite(timestamp)) {
      throw new Error(`extension-center: invalid catalog response.catalog.${field}`)
    }
  }
  if (issuedAt >= expiresAt || Date.now() < issuedAt || Date.now() >= expiresAt) {
    throw new Error('extension-center: catalog response is outside its validity interval')
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(expectString(catalog.entriesDigest, 'catalog response.catalog.entriesDigest', 72))) {
    throw new Error('extension-center: invalid catalog response.catalog.entriesDigest')
  }
  if (catalog.signatureStatus !== 'verified') throw new Error('extension-center: catalog signature is not verified')
  expectEnum(catalog.source, 'catalog response.catalog.source', new Set(['bootstrap', 'remote', 'last-good']))
  expectEnum(catalog.freshness, 'catalog response.catalog.freshness', new Set(['bootstrap', 'fresh', 'cached']))
  const degraded = expectBoolean(catalog.degraded, 'catalog response.catalog.degraded')
  if (degraded) expectString(catalog.degradedReason, 'catalog response.catalog.degradedReason', 160)
  else if (catalog.degradedReason !== null) throw new Error('extension-center: invalid catalog degraded reason')
  if (catalog.lastRefreshAtMs !== null) {
    expectSafeInteger(catalog.lastRefreshAtMs, 'catalog response.catalog.lastRefreshAtMs')
  }
  const keyIds = expectArray(catalog.keyIds, 'catalog response.catalog.keyIds', 10)
  if (keyIds.length === 0) throw new Error('extension-center: catalog response has no verified signing key')
  keyIds.forEach((key, at) => { expectString(key, `catalog response.catalog.keyIds[${at}]`, 128) })

  const capabilities = expectRecord(input.hostCapabilities, 'catalog response.hostCapabilities', [
    'acquisition', 'durableContinuation', 'dynamicMcpConnection', 'loaderMutation', 'managedPluginLifecycle',
    'reason', 'skillRegistry', 'toolRegistry',
  ])
  const managedPluginLifecycle = expectBoolean(capabilities.managedPluginLifecycle, 'catalog response.hostCapabilities.managedPluginLifecycle')
  const dynamicMcpConnection = expectBoolean(capabilities.dynamicMcpConnection, 'catalog response.hostCapabilities.dynamicMcpConnection')
  const durableContinuation = expectBoolean(capabilities.durableContinuation, 'catalog response.hostCapabilities.durableContinuation')
  const skillRegistry = expectBoolean(capabilities.skillRegistry, 'catalog response.hostCapabilities.skillRegistry')
  const toolRegistry = expectBoolean(capabilities.toolRegistry, 'catalog response.hostCapabilities.toolRegistry')
  const loaderMutation = expectBoolean(capabilities.loaderMutation, 'catalog response.hostCapabilities.loaderMutation')
  const acquisition = expectBoolean(capabilities.acquisition, 'catalog response.hostCapabilities.acquisition')
  const ownersAvailable = managedPluginLifecycle
    && dynamicMcpConnection
    && durableContinuation
    && skillRegistry
    && toolRegistry
    && loaderMutation
  if (acquisition && !ownersAvailable) {
    throw new Error('extension-center: Host acquisition claim requires all owners and a ready writable runtime')
  }
  const expectedReason = acquisition ? null : 'host-capability'
  if (capabilities.reason !== expectedReason) {
    throw new Error('extension-center: invalid Host capability reason')
  }

  const entries = expectArray(input.entries, 'catalog response.entries', MAX_ENTRIES)
    .map((entry, index) => validateEntry(entry, index))
  const refs = new Set<string>()
  for (const entry of entries) {
    if (refs.has(entry.candidateRef)) throw new Error(`extension-center: duplicate candidateRef ${entry.candidateRef}`)
    refs.add(entry.candidateRef)
  }
  return input as unknown as CatalogListResponse
}

/** Create a stateless Store catalog client over the generic Connection carrier. */
export function createExtensionCatalogClient(rpc: ClientConnectionRpc): ExtensionCatalogClient {
  const call = async (endpoint: 'catalog/list' | 'catalog/refresh', signal?: AbortSignal) => {
    const result = await rpc.call(
      EXTENSION_CENTER_RPC_CHANNEL,
      endpoint,
      { protocolVersion: EXTENSION_CENTER_PROTOCOL_VERSION },
      signal,
    )
    if (!result.ok) throw new ExtensionCenterRpcError(result.error)
    return parseCatalogListResponse(result.value)
  }
  return {
    list: signal => call('catalog/list', signal),
    refresh: signal => call('catalog/refresh', signal),
  }
}
