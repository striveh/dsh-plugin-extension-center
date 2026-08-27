import {
  Context,
  Service,
  symbols,
  type Fiber,
  type Plugin,
} from '@deepseek-ai/cordis'
import * as OfficialMcpClient from '@deepseek-ai/dsh-mcp-client'
import { canonicalSha256 } from '../../domain/index.ts'
import {
  immutableCenterMcpValue,
  type StoredCenterMcpConnection,
  type StoredCenterMcpState,
  type StoredCenterRemovedMcpConnection,
} from './state.ts'
import { CenterMcpConnectionStore } from './store.ts'
import {
  CenterMcpConnectionConflictError,
  CenterMcpHttpUnsupportedError,
  CenterMcpConnectionNotFoundError,
  parseCenterConfigureMcpRequest,
  parseCenterMcpMutationRequest,
  parseCenterUpdateMcpRequest,
  type CenterConfigureMcpConnectionRequest,
  type CenterMcpClientConfig,
  type CenterMcpConnectionDesired,
  type CenterMcpConnectionMutationReceipt,
  type CenterMcpConnectionMutationRequest,
  type CenterMcpConnectionObserved,
  type CenterMcpConnectionOperation,
  type CenterMcpConnectionsSnapshot,
  type CenterMcpConnectionView,
  type CenterMcpToolGeneration,
  type CenterRemovedMcpConnectionView,
  type CenterUpdateMcpConnectionRequest,
} from './types.ts'

interface ToolDefinitionLike {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
}

interface ToolSchemaLike {
  readonly name: string
  readonly [key: string]: unknown
}

interface ToolRuntimeLike {
  register(definition: ToolDefinitionLike): () => void
  get?(name: string): unknown
  schemas?(agent?: unknown): readonly ToolSchemaLike[]
}

interface LiveConnection {
  readonly fiber: Fiber
  readonly desiredRevision: number
  readonly tools: Map<string, ToolDefinitionLike>
}

interface ManagedToolsConfig {
  readonly upstream: ToolRuntimeLike
  readonly namespacePrefix: string
  readonly tools: Map<string, ToolDefinitionLike>
  readonly onChange: () => void
}

/** Runtime configuration for the Center's internal MCP owner. */
export interface CenterMcpConnectionsConfig {
  /** Private Extension Center management root. */
  readonly root: string
  /** Deterministic test seam; production always omits this and loads the official MCP client. */
  readonly clientPlugin?: Plugin<CenterMcpClientConfig>
}

const EMPTY_TOOL_DIGEST = canonicalSha256([])
const MAX_DIAGNOSTIC_CODE_UNITS = 512
const DEFAULT_CLIENT_PLUGIN = OfficialMcpClient as Plugin<CenterMcpClientConfig>

/** Per-child `tools` facade that retains exact registration provenance. */
class CenterManagedMcpTools extends Service {
  private readonly upstream: ToolRuntimeLike
  private readonly namespacePrefix: string
  private readonly tools: Map<string, ToolDefinitionLike>
  private readonly onChange: () => void

  constructor(ctx: Context, config: ManagedToolsConfig) {
    super(ctx, 'tools')
    this.upstream = config.upstream
    this.namespacePrefix = config.namespacePrefix
    this.tools = config.tools
    this.onChange = config.onChange
  }

  /** Delegate one qualified tool registration and bind its cleanup to the child Fiber. */
  register(definition: ToolDefinitionLike): () => void {
    if (!definition.name.startsWith(this.namespacePrefix)) {
      throw new Error(
        `Extension Center MCP tool ${JSON.stringify(definition.name)} is outside namespace ${JSON.stringify(this.namespacePrefix)}`,
      )
    }
    const upstream = this.ctx.reflect.trace(this.upstream)
    return this.ctx.effect(function* (this: CenterManagedMcpTools) {
      const dispose = upstream.register(definition)
      this.tools.set(definition.name, definition)
      this.onChange()
      yield dispose
      yield () => {
        if (this.tools.get(definition.name) === definition) this.tools.delete(definition.name)
        this.onChange()
      }
    }.bind(this), 'extension-center.mcpTool()')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpConnections: CenterMcpConnections
  }
}

/** Center-owned durable MCP desired-state service and dynamic child-Fiber owner. */
export class CenterMcpConnections extends Service {
  static inject = ['tools']

  readonly protocolVersion = 1 as const

  private readonly ownerContext: Context
  private readonly store: CenterMcpConnectionStore
  private readonly clientPlugin: Plugin<CenterMcpClientConfig> | undefined
  private state: StoredCenterMcpState = {
    schemaVersion: 1,
    revision: 0,
    connections: [],
    removed: [],
    mutations: [],
  }
  private readonly live = new Map<string, LiveConnection>()
  private readonly observed = new Map<string, CenterMcpConnectionObserved>()
  private readonly toolGenerations = new Map<string, CenterMcpToolGeneration>()
  private readonly runtimeGenerations = new Map<string, number>()
  private operations: Promise<void> = Promise.resolve()
  private toolRefreshQueued = false
  private stopped = false

  constructor(ctx: Context, config: CenterMcpConnectionsConfig) {
    super(ctx, 'mcpConnections')
    if (typeof config?.root !== 'string' || config.root.length === 0) {
      throw new TypeError('Extension Center MCP owner root must be a non-empty path')
    }
    this.ownerContext = ctx
    this.store = new CenterMcpConnectionStore(config.root)
    this.clientPlugin = config.clientPlugin
  }

  /** Load state and remount enabled child Fibers before the service becomes injectable. */
  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield async () => {
      this.stopped = true
      await this.operations
      const live = [...this.live.values()]
      this.live.clear()
      await Promise.allSettled(live.map(connection => connection.fiber.dispose()))
      this.refreshAllToolGenerations(false)
      this.store.close()
    }
    this.state = await this.store.load()
    await this.reconcileAll()
  }

  /** Return an immutable inventory snapshot. */
  snapshot(): CenterMcpConnectionsSnapshot {
    return immutableCenterMcpValue({
      revision: this.state.revision,
      connections: this.state.connections.map(record => this.viewOf(record)),
      removed: this.state.removed.map(record => this.removedViewOf(record)),
    }) as CenterMcpConnectionsSnapshot
  }

  /** Return one immutable active connection. */
  get(id: string): CenterMcpConnectionView | undefined {
    const record = this.state.connections.find(entry => entry.desired.id === id)
    return record === undefined ? undefined : this.viewOf(record)
  }

  /** Return one immutable restorable removed connection. */
  getRemoved(id: string): CenterRemovedMcpConnectionView | undefined {
    const record = this.state.removed.find(entry => entry.desired.id === id)
    return record === undefined ? undefined : this.removedViewOf(record)
  }

  /** Read the official Tool registry for this namespace and any exact names captured before teardown. */
  registeredToolNames(id: string, exactNames: readonly string[] = []): readonly string[] {
    const prefix = namespacePrefix(id)
    if (exactNames.some(name => typeof name !== 'string' || !name.startsWith(prefix))) {
      throw new Error('MCP teardown Tool names do not match their connection namespace')
    }
    const runtime = this.toolsRuntime()
    if (runtime.schemas === undefined || runtime.get === undefined) {
      throw new Error('official Tool registry cannot prove MCP teardown')
    }
    const names = new Set(runtime.schemas()
      .map(schema => schema.name)
      .filter(name => name.startsWith(prefix)))
    for (const name of exactNames) {
      if (runtime.get(name) !== undefined) names.add(name)
    }
    return Object.freeze([...names].sort((left, right) => left.localeCompare(right)))
  }

  /** Persist one new desired record and reconcile its enabled state. */
  configure(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt> {
    const request = parseCenterConfigureMcpRequest(requestValue)
    if (request.desired.transport.transport === 'streamable-http') {
      return Promise.reject(new CenterMcpHttpUnsupportedError())
    }
    const operation = 'configure' as const
    return this.runMutation(operation, request.mutationId, { operation, ...request }, (state) => {
      const active = findConnection(state, request.desired.id)
      const removed = findRemoved(state, request.desired.id)
      if (active !== undefined || removed !== undefined) {
        throw new CenterMcpConnectionConflictError(
          request.desired.id,
          request.expectedRevision,
          active?.revision ?? removed?.revision ?? 0,
        )
      }
      state.revision += 1
      const record: StoredCenterMcpConnection = { desired: request.desired, revision: 1 }
      state.connections.push(record)
      return receiptFor(operation, request.mutationId, record, state.revision, true)
    }, () => { this.assertNamespaceAvailable(request.desired.id) })
  }

  /** Enable and mount one active desired record. */
  enable(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt> {
    return this.setEnabled('enable', parseCenterMcpMutationRequest(requestValue), true)
  }

  /** Disable one record and await complete child-Fiber teardown. */
  disable(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt> {
    return this.setEnabled('disable', parseCenterMcpMutationRequest(requestValue), false)
  }

  /** Replace the transport and restart an enabled child Fiber. */
  update(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt> {
    const request = parseCenterUpdateMcpRequest(requestValue)
    if (request.transport.transport === 'streamable-http') {
      return Promise.reject(new CenterMcpHttpUnsupportedError())
    }
    const operation = 'update' as const
    return this.runMutation(operation, request.mutationId, { operation, ...request }, (state) => {
      const record = requireActive(state, request.id)
      assertExpected(record, request.expectedRevision)
      const changed = canonicalSha256(record.desired.transport) !== canonicalSha256(request.transport)
      const previousRevision = record.revision
      if (changed) {
        record.desired = { ...record.desired, transport: request.transport }
        record.revision += 1
      }
      state.revision += 1
      return receiptFor(operation, request.mutationId, record, state.revision, changed, previousRevision)
    })
  }

  /** Move one active record to the restorable removed inventory. */
  remove(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt> {
    const request = parseCenterMcpMutationRequest(requestValue)
    const operation = 'remove' as const
    return this.runMutation(operation, request.mutationId, { operation, ...request }, (state) => {
      const record = requireActive(state, request.id)
      assertExpected(record, request.expectedRevision)
      const previousRevision = record.revision
      state.revision += 1
      const removed: StoredCenterRemovedMcpConnection = {
        desired: record.desired,
        revision: record.revision + 1,
        removedAtRevision: state.revision,
      }
      state.connections = state.connections.filter(entry => entry.desired.id !== request.id)
      state.removed.push(removed)
      return receiptFor(operation, request.mutationId, removed, state.revision, true, previousRevision)
    })
  }

  /** Restore one removed record and reconcile its retained enabled state. */
  restore(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt> {
    const request = parseCenterMcpMutationRequest(requestValue)
    const operation = 'restore' as const
    return this.runMutation(operation, request.mutationId, { operation, ...request }, (state) => {
      const removed = requireRemoved(state, request.id)
      assertExpected(removed, request.expectedRevision)
      const active = findConnection(state, request.id)
      if (active !== undefined) throw new CenterMcpConnectionConflictError(request.id, request.expectedRevision, active.revision)
      const previousRevision = removed.revision
      state.revision += 1
      const restored: StoredCenterMcpConnection = { desired: removed.desired, revision: removed.revision + 1 }
      state.removed = state.removed.filter(entry => entry.desired.id !== request.id)
      state.connections.push(restored)
      return receiptFor(operation, request.mutationId, restored, state.revision, true, previousRevision)
    })
  }

  /** Permanently delete one revision-matched removed record. */
  purge(requestValue: unknown): Promise<CenterMcpConnectionMutationReceipt> {
    const request = parseCenterMcpMutationRequest(requestValue)
    const operation = 'purge' as const
    return this.runMutation(operation, request.mutationId, { operation, ...request }, (state) => {
      const removed = requireRemoved(state, request.id)
      assertExpected(removed, request.expectedRevision)
      const previousRevision = removed.revision
      state.revision += 1
      state.removed = state.removed.filter(entry => entry.desired.id !== request.id)
      return {
        mutationId: request.mutationId,
        operation,
        id: request.id,
        previousRevision,
        revision: previousRevision + 1,
        snapshotRevision: state.revision,
        changed: true,
        desiredDigest: null,
      }
    })
  }

  private setEnabled(
    operation: 'enable' | 'disable',
    request: CenterMcpConnectionMutationRequest,
    enabled: boolean,
  ): Promise<CenterMcpConnectionMutationReceipt> {
    return this.runMutation(operation, request.mutationId, { operation, ...request }, (state) => {
      const record = requireActive(state, request.id)
      assertExpected(record, request.expectedRevision)
      const changed = record.desired.enabled !== enabled
      const previousRevision = record.revision
      if (changed) {
        record.desired = { ...record.desired, enabled }
        record.revision += 1
      }
      state.revision += 1
      return receiptFor(operation, request.mutationId, record, state.revision, changed, previousRevision)
    })
  }

  private runMutation(
    operation: CenterMcpConnectionOperation,
    mutationId: string,
    requestValue: unknown,
    transform: (state: StoredCenterMcpState) => CenterMcpConnectionMutationReceipt,
    validateCommit?: () => void,
  ): Promise<CenterMcpConnectionMutationReceipt> {
    return this.enqueue(async () => {
      const result = await this.store.mutate(mutationId, requestValue, transform, validateCommit)
      this.state = result.state
      await this.reconcileAll()
      return result.receipt
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Extension Center MCP owner is disposed'))
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  private async reconcileAll(): Promise<void> {
    const desiredById = new Map(this.state.connections.map(record => [record.desired.id, record] as const))
    for (const [id, live] of [...this.live]) {
      const record = desiredById.get(id)
      if (record === undefined || !record.desired.enabled || record.revision !== live.desiredRevision) {
        await this.deactivate(id, record)
      }
    }
    for (const record of this.state.connections) {
      if (record.desired.enabled && !this.live.has(record.desired.id)) await this.activate(record)
      if (!record.desired.enabled && !this.live.has(record.desired.id)) {
        this.observed.set(record.desired.id, {
          state: 'disabled',
          desiredRevision: record.revision,
          generation: this.runtimeGenerations.get(record.desired.id) ?? 0,
        })
      }
    }
    this.refreshAllToolGenerations(false)
  }

  private async activate(record: StoredCenterMcpConnection): Promise<void> {
    const id = record.desired.id
    const generation = (this.runtimeGenerations.get(id) ?? 0) + 1
    this.runtimeGenerations.set(id, generation)
    this.observed.set(id, { state: 'connecting', desiredRevision: record.revision, generation })
    const tools = new Map<string, ToolDefinitionLike>()
    const managedContext = this.ownerContext.isolate('tools')
    const fiber = managedContext.plugin(CenterManagedMcpTools, {
      upstream: originalService(this.toolsRuntime()),
      namespacePrefix: namespacePrefix(id),
      tools,
      onChange: () => { this.queueToolRefresh() },
    })
    try {
      await fiber
      const client = this.clientPlugin ?? DEFAULT_CLIENT_PLUGIN
      await fiber.ctx.plugin(client, toClientConfig(record.desired))
      this.live.set(id, { fiber, desiredRevision: record.revision, tools })
      this.refreshToolGeneration(id)
      this.observed.set(id, { state: 'ready', desiredRevision: record.revision, generation })
    } catch (error) {
      await fiber.dispose().catch(() => undefined)
      this.live.delete(id)
      this.refreshToolGeneration(id)
      this.observed.set(id, {
        state: 'error',
        desiredRevision: record.revision,
        generation,
        message: sanitizeDiagnostic(error),
      })
    }
  }

  private async deactivate(id: string, activeRecord: StoredCenterMcpConnection | undefined): Promise<void> {
    const live = this.live.get(id)
    if (live === undefined) return
    const generation = this.runtimeGenerations.get(id) ?? 0
    if (activeRecord !== undefined) {
      this.observed.set(id, { state: 'stopping', desiredRevision: activeRecord.revision, generation })
    }
    let disposeError: unknown
    try {
      await live.fiber.dispose()
    } catch (error) {
      disposeError = error
    }
    this.live.delete(id)
    this.refreshToolGeneration(id)
    if (activeRecord !== undefined) {
      this.observed.set(id, disposeError === undefined
        ? { state: 'disabled', desiredRevision: activeRecord.revision, generation }
        : {
            state: 'error',
            desiredRevision: activeRecord.revision,
            generation,
            message: sanitizeDiagnostic(disposeError),
          })
    }
  }

  private queueToolRefresh(): void {
    if (this.toolRefreshQueued || this.stopped) return
    this.toolRefreshQueued = true
    queueMicrotask(() => {
      this.toolRefreshQueued = false
      if (this.stopped) return
      void this.enqueue(async () => { this.refreshAllToolGenerations(false) }).catch((error: unknown) => {
        this.ownerContext.logger.error('Extension Center MCP tool-generation refresh failed')
        this.ownerContext.logger.error(error)
      })
    })
  }

  private refreshAllToolGenerations(onlyActive: boolean): void {
    const ids = onlyActive
      ? new Set(this.live.keys())
      : new Set([...this.state.connections.map(record => record.desired.id), ...this.toolGenerations.keys()])
    for (const id of ids) this.refreshToolGeneration(id)
  }

  private refreshToolGeneration(id: string): void {
    const live = this.live.get(id)
    const runtime = this.toolsRuntime()
    const names = live === undefined ? [] : [...live.tools]
      .filter(([name, definition]) => runtime.get === undefined || runtime.get(name) === definition)
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right))
    const schemaByName = new Map((runtime.schemas?.() ?? []).map(schema => [schema.name, schema] as const))
    const digestInput = names.map(name => schemaByName.get(name) ?? { name })
    const digest = canonicalSha256(digestInput)
    const previous = this.toolGenerations.get(id)
    if (previous?.digest === digest) return
    this.toolGenerations.set(id, immutableCenterMcpValue({
      generation: (previous?.generation ?? 0) + 1,
      digest,
      names,
    }) as CenterMcpToolGeneration)
  }

  private viewOf(record: StoredCenterMcpConnection): CenterMcpConnectionView {
    const id = record.desired.id
    return immutableCenterMcpValue({
      id,
      revision: record.revision,
      desired: record.desired,
      observed: this.observed.get(id) ?? {
        state: record.desired.enabled ? 'connecting' : 'disabled',
        desiredRevision: record.revision,
        generation: this.runtimeGenerations.get(id) ?? 0,
      },
      tools: this.toolGenerations.get(id) ?? { generation: 0, digest: EMPTY_TOOL_DIGEST, names: [] },
    }) as CenterMcpConnectionView
  }

  private removedViewOf(record: StoredCenterRemovedMcpConnection): CenterRemovedMcpConnectionView {
    return immutableCenterMcpValue({
      id: record.desired.id,
      revision: record.revision,
      desired: record.desired,
      removedAtRevision: record.removedAtRevision,
    }) as CenterRemovedMcpConnectionView
  }

  private assertNamespaceAvailable(id: string): void {
    const prefix = namespacePrefix(id)
    const collisions = (this.toolsRuntime().schemas?.() ?? [])
      .map(schema => schema.name)
      .filter(name => name.startsWith(prefix))
      .sort((left, right) => left.localeCompare(right))
    if (collisions.length > 0) {
      throw new Error(
        `Cannot configure MCP connection ${JSON.stringify(id)} because namespace ${JSON.stringify(prefix)} is occupied: ${collisions.map(value => JSON.stringify(value)).join(', ')}`,
      )
    }
  }

  private toolsRuntime(): ToolRuntimeLike {
    const value: unknown = this.ownerContext.get('tools')
    if (typeof value !== 'object' || value === null || typeof (value as Partial<ToolRuntimeLike>).register !== 'function') {
      throw new Error('Extension Center MCP owner requires the official tools service')
    }
    return value as ToolRuntimeLike
  }
}

function toClientConfig(desired: CenterMcpConnectionDesired): CenterMcpClientConfig {
  const common = {
    serverName: desired.id,
    toolCallTimeoutMs: desired.transport.toolCallTimeoutMs,
    failOnStartupError: true,
    reconnect: { ...desired.transport.reconnect },
  }
  if (desired.transport.transport !== 'stdio') throw new CenterMcpHttpUnsupportedError()
  return {
    ...common,
    transport: 'stdio',
    command: desired.transport.command,
    args: [...desired.transport.args],
    env: { ...desired.transport.env },
    cwd: desired.transport.cwd,
  }
}

function namespacePrefix(id: string): string {
  return `mcp__${id}__`
}

function originalService<T extends object>(receiver: T): T {
  return (receiver as T & { [symbols.original]?: T })[symbols.original] ?? receiver
}

function receiptFor(
  operation: CenterMcpConnectionOperation,
  mutationId: string,
  record: StoredCenterMcpConnection,
  snapshotRevision: number,
  changed: boolean,
  previousRevision?: number,
): CenterMcpConnectionMutationReceipt {
  return {
    mutationId,
    operation,
    id: record.desired.id,
    ...previousRevision === undefined ? {} : { previousRevision },
    revision: record.revision,
    snapshotRevision,
    changed,
    desiredDigest: canonicalSha256(record.desired),
  }
}

function requireActive(state: StoredCenterMcpState, id: string): StoredCenterMcpConnection {
  const record = findConnection(state, id)
  if (record === undefined) throw new CenterMcpConnectionNotFoundError(id, 'active')
  return record
}

function requireRemoved(state: StoredCenterMcpState, id: string): StoredCenterRemovedMcpConnection {
  const record = findRemoved(state, id)
  if (record === undefined) throw new CenterMcpConnectionNotFoundError(id, 'removed')
  return record
}

function findConnection(state: StoredCenterMcpState, id: string): StoredCenterMcpConnection | undefined {
  return state.connections.find(record => record.desired.id === id)
}

function findRemoved(state: StoredCenterMcpState, id: string): StoredCenterRemovedMcpConnection | undefined {
  return state.removed.find(record => record.desired.id === id)
}

function assertExpected(record: StoredCenterMcpConnection, expected: number): void {
  if (record.revision !== expected) {
    throw new CenterMcpConnectionConflictError(record.desired.id, expected, record.revision)
  }
}

function sanitizeDiagnostic(error: unknown): string {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}${error.cause instanceof Error ? `; cause: ${error.cause.name}: ${error.cause.message}` : ''}`
    : String(error)
  return message.replaceAll(/[\r\n\t]+/g, ' ').slice(0, MAX_DIAGNOSTIC_CODE_UNITS)
}

export default CenterMcpConnections
