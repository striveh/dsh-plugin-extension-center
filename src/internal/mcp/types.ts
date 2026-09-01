/** Center-owned managed MCP connection records and mutation API. */

const CONNECTION_ID = /^[A-Za-z0-9_-]{1,32}$/
const MUTATION_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** Fully resolved reconnect policy passed to the official MCP client. */
export interface CenterMcpReconnectPolicy {
  readonly enabled: boolean
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly maxAttempts: number
}

/** Center-admitted stdio MCP transport. */
export interface CenterMcpStdioTransport {
  readonly transport: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly toolCallTimeoutMs: number
  readonly reconnect: CenterMcpReconnectPolicy
}

/** Center-admitted Streamable HTTP MCP transport. */
export interface CenterMcpHttpTransport {
  readonly transport: 'streamable-http'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly redirect: 'error' | 'follow' | 'manual'
  readonly toolCallTimeoutMs: number
  readonly reconnect: CenterMcpReconnectPolicy
}

/** Complete resolved transport accepted by the Center owner. */
export type CenterMcpTransport = CenterMcpStdioTransport | CenterMcpHttpTransport

/** Durable desired state for one Center-managed MCP connection. */
export interface CenterMcpConnectionDesired {
  readonly id: string
  readonly enabled: boolean
  readonly transport: CenterMcpTransport
}

/** Current process-local lifecycle observation. */
export interface CenterMcpConnectionObserved {
  readonly state: 'disabled' | 'connecting' | 'ready' | 'stopping' | 'error'
  readonly desiredRevision: number
  readonly generation: number
  readonly message?: string
}

/** Actual qualified tools registered by one managed child Fiber. */
export interface CenterMcpToolGeneration {
  readonly generation: number
  readonly digest: string
  readonly names: readonly string[]
}

/** Immutable active connection view. */
export interface CenterMcpConnectionView {
  readonly id: string
  readonly revision: number
  readonly desired: CenterMcpConnectionDesired
  readonly observed: CenterMcpConnectionObserved
  readonly tools: CenterMcpToolGeneration
}

/** Restorable removed connection view. */
export interface CenterRemovedMcpConnectionView {
  readonly id: string
  readonly revision: number
  readonly desired: CenterMcpConnectionDesired
  readonly removedAtRevision: number
}

/** Immutable active and removed inventory. */
export interface CenterMcpConnectionsSnapshot {
  readonly revision: number
  readonly connections: readonly CenterMcpConnectionView[]
  readonly removed: readonly CenterRemovedMcpConnectionView[]
}

/** New desired record request. */
export interface CenterConfigureMcpConnectionRequest {
  readonly desired: CenterMcpConnectionDesired
  readonly mutationId: string
  readonly expectedRevision: 0
}

/** Revision-checked request for one known record. */
export interface CenterMcpConnectionMutationRequest {
  readonly id: string
  readonly mutationId: string
  readonly expectedRevision: number
}

/** Revision-checked transport replacement. */
export interface CenterUpdateMcpConnectionRequest extends CenterMcpConnectionMutationRequest {
  readonly transport: CenterMcpTransport
}

/** Supported durable mutation name. */
export type CenterMcpConnectionOperation =
  | 'configure'
  | 'enable'
  | 'disable'
  | 'update'
  | 'remove'
  | 'restore'
  | 'purge'

/** Durable result returned for a new mutation or exact replay. */
export interface CenterMcpConnectionMutationReceipt {
  readonly mutationId: string
  readonly operation: CenterMcpConnectionOperation
  readonly id: string
  readonly previousRevision?: number
  readonly revision: number
  readonly snapshotRevision: number
  readonly changed: boolean
  readonly desiredDigest: string | null
}

/** Configuration accepted by the official `@deepseek-ai/dsh-mcp-client`. */
export type CenterMcpClientConfig =
  | Readonly<{
      transport: 'stdio'
      serverName: string
      command: string
      args: string[]
      env: Record<string, string>
      cwd: string
      toolCallTimeoutMs: number
      failOnStartupError: boolean
      reconnect: CenterMcpReconnectPolicy
    }>
  | Readonly<{
      transport: 'streamable-http'
      serverName: string
      url: string
      headers: Record<string, string>
      toolCallTimeoutMs: number
      failOnStartupError: boolean
      reconnect: CenterMcpReconnectPolicy
    }>

/** A desired record changed after the caller read it. */
export class CenterMcpConnectionConflictError extends Error {
  readonly code = 'MCP_CONNECTION_CONFLICT'

  constructor(
    readonly id: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`MCP connection "${id}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`)
    this.name = 'CenterMcpConnectionConflictError'
  }
}

/** A mutation addressed an absent active or removed record. */
export class CenterMcpConnectionNotFoundError extends Error {
  readonly code = 'MCP_CONNECTION_NOT_FOUND'

  constructor(id: string, inventory: 'active' | 'removed') {
    super(`MCP connection "${id}" does not exist in the ${inventory} inventory`)
    this.name = 'CenterMcpConnectionNotFoundError'
  }
}

/** One idempotency key was reused with different request fields. */
export class CenterMcpConnectionIdempotencyError extends Error {
  readonly code = 'MCP_CONNECTION_IDEMPOTENCY_MISMATCH'

  constructor(mutationId: string) {
    super(`MCP connection mutation id "${mutationId}" was already used for a different request`)
    this.name = 'CenterMcpConnectionIdempotencyError'
  }
}

/** The official MCP Client does not expose a redirect-forbidden HTTP policy. */
export class CenterMcpHttpUnsupportedError extends Error {
  readonly code = 'MCP_HTTP_REDIRECT_GUARD_UNAVAILABLE'

  constructor() {
    super('Streamable HTTP MCP is unavailable because the official MCP Client cannot enforce the required redirect-forbidden policy')
    this.name = 'CenterMcpHttpUnsupportedError'
  }
}

/** Parse and detach a complete desired record at the wire or durable boundary. */
export function parseCenterMcpConnectionDesired(value: unknown, path = '$'): CenterMcpConnectionDesired {
  const object = exactObject(value, ['id', 'enabled', 'transport'], path)
  const id = connectionId(object.id, `${path}.id`)
  if (typeof object.enabled !== 'boolean') throw new TypeError(`${path}.enabled must be a boolean`)
  return deepFreeze({ id, enabled: object.enabled, transport: parseCenterMcpTransport(object.transport, `${path}.transport`) })
}

/** Parse and detach one complete resolved transport. */
export function parseCenterMcpTransport(value: unknown, path = '$'): CenterMcpTransport {
  if (!isPlainObject(value)) throw new TypeError(`${path} must be an object`)
  if (value.transport === 'stdio') {
    const object = exactObject(value, ['transport', 'command', 'args', 'env', 'cwd', 'toolCallTimeoutMs', 'reconnect'], path)
    const command = nonEmptyString(object.command, `${path}.command`)
    const cwd = stringValue(object.cwd, `${path}.cwd`)
    rejectNul(command, `${path}.command`)
    rejectNul(cwd, `${path}.cwd`)
    return deepFreeze({
      transport: 'stdio',
      command,
      args: stringArray(object.args, `${path}.args`),
      env: stringRecord(object.env, `${path}.env`),
      cwd,
      toolCallTimeoutMs: positiveInteger(object.toolCallTimeoutMs, `${path}.toolCallTimeoutMs`),
      reconnect: parseReconnect(object.reconnect, `${path}.reconnect`),
    })
  }
  if (value.transport === 'streamable-http') {
    const object = exactObject(value, ['transport', 'url', 'headers', 'redirect', 'toolCallTimeoutMs', 'reconnect'], path)
    const text = nonEmptyString(object.url, `${path}.url`)
    let url: URL
    try {
      url = new URL(text)
    } catch (cause) {
      throw new TypeError(`${path}.url must be an absolute HTTP or HTTPS URL`, { cause })
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError(`${path}.url must use HTTP or HTTPS`)
    }
    if (object.redirect !== 'error' && object.redirect !== 'follow' && object.redirect !== 'manual') {
      throw new TypeError(`${path}.redirect is invalid`)
    }
    return deepFreeze({
      transport: 'streamable-http',
      url: url.toString(),
      headers: stringRecord(object.headers, `${path}.headers`),
      redirect: object.redirect,
      toolCallTimeoutMs: positiveInteger(object.toolCallTimeoutMs, `${path}.toolCallTimeoutMs`),
      reconnect: parseReconnect(object.reconnect, `${path}.reconnect`),
    })
  }
  throw new TypeError(`${path}.transport must be "stdio" or "streamable-http"`)
}

/** Parse common mutation fields without accepting surplus authority. */
export function parseCenterMcpMutationRequest(value: unknown, path = '$'): CenterMcpConnectionMutationRequest {
  const object = exactObject(value, ['id', 'mutationId', 'expectedRevision'], path)
  return deepFreeze({
    id: connectionId(object.id, `${path}.id`),
    mutationId: mutationId(object.mutationId, `${path}.mutationId`),
    expectedRevision: nonNegativeInteger(object.expectedRevision, `${path}.expectedRevision`),
  })
}

/** Parse a configure request. */
export function parseCenterConfigureMcpRequest(value: unknown, path = '$'): CenterConfigureMcpConnectionRequest {
  const object = exactObject(value, ['desired', 'mutationId', 'expectedRevision'], path)
  if (object.expectedRevision !== 0) throw new TypeError(`${path}.expectedRevision must be zero`)
  return deepFreeze({
    desired: parseCenterMcpConnectionDesired(object.desired, `${path}.desired`),
    mutationId: mutationId(object.mutationId, `${path}.mutationId`),
    expectedRevision: 0,
  })
}

/** Parse an update request. */
export function parseCenterUpdateMcpRequest(value: unknown, path = '$'): CenterUpdateMcpConnectionRequest {
  const object = exactObject(value, ['id', 'mutationId', 'expectedRevision', 'transport'], path)
  return deepFreeze({
    id: connectionId(object.id, `${path}.id`),
    mutationId: mutationId(object.mutationId, `${path}.mutationId`),
    expectedRevision: nonNegativeInteger(object.expectedRevision, `${path}.expectedRevision`),
    transport: parseCenterMcpTransport(object.transport, `${path}.transport`),
  })
}

function parseReconnect(value: unknown, path: string): CenterMcpReconnectPolicy {
  const object = exactObject(value, ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'], path)
  if (typeof object.enabled !== 'boolean') throw new TypeError(`${path}.enabled must be a boolean`)
  const initialDelayMs = positiveInteger(object.initialDelayMs, `${path}.initialDelayMs`)
  const maxDelayMs = positiveInteger(object.maxDelayMs, `${path}.maxDelayMs`)
  if (initialDelayMs > maxDelayMs) throw new TypeError(`${path}.initialDelayMs must not exceed maxDelayMs`)
  return deepFreeze({
    enabled: object.enabled,
    initialDelayMs,
    maxDelayMs,
    maxAttempts: positiveInteger(object.maxAttempts, `${path}.maxAttempts`),
  })
}

function connectionId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !CONNECTION_ID.test(value)) {
    throw new TypeError(`${path} must match ${String(CONNECTION_ID)}`)
  }
  return value
}

function mutationId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !MUTATION_ID.test(value)) {
    throw new TypeError(`${path} must match ${String(MUTATION_ID)}`)
  }
  return value
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  return value.map((entry, index) => {
    const item = stringValue(entry, `${path}[${String(index)}]`)
    rejectNul(item, `${path}[${String(index)}]`)
    return item
  })
}

function stringRecord(value: unknown, path: string): Readonly<Record<string, string>> {
  if (!isPlainObject(value)) throw new TypeError(`${path} must be an object`)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    rejectNul(key, `${path} key`)
    const item = stringValue(entry, `${path}.${key}`)
    rejectNul(item, `${path}.${key}`)
    result[key] = item
  }
  return result
}

function nonEmptyString(value: unknown, path: string): string {
  const result = stringValue(value, path)
  if (result.length === 0) throw new TypeError(`${path} must not be empty`)
  return result
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new TypeError(`${path} must be a string`)
  return value
}

function positiveInteger(value: unknown, path: string): number {
  const result = nonNegativeInteger(value, path)
  if (result === 0) throw new TypeError(`${path} must be positive`)
  return result
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${path} must be a non-negative integer`)
  return value as number
}

function rejectNul(value: string, path: string): void {
  if (value.includes('\0')) throw new TypeError(`${path} must not contain NUL`)
}

function exactObject(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError(`${path} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${path} contains unsupported or missing fields`)
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
