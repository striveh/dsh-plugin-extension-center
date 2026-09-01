import type { HostCapabilityProjection } from '../service/rpc-contract.ts'

/** Center-owned Plugin lifecycle snapshot used for planning and recovery fences. */
export interface ManagedPluginsOwner {
  snapshot(profileId: string): Promise<Readonly<{
    profileId: string
    revision: number
    digest: `sha256:${string}`
    materialRoot: string
    bootStatus: 'live' | 'pending-restart' | 'verified'
    ownerRevision: string
  }>>
}

/** Center-owned dynamic MCP desired-state lifecycle. */
export interface McpConnectionsOwner {
  readonly protocolVersion: 1
  snapshot(): Readonly<{ revision: number; connections: readonly unknown[]; removed: readonly unknown[] }>
  get(id: string): unknown
  getRemoved(id: string): unknown
  /** Query the real official Tool registry for one namespace and exact prior names. */
  registeredToolNames(id: string, exactNames?: readonly string[]): readonly string[]
  configure(request: unknown): Promise<unknown>
  enable(request: unknown): Promise<unknown>
  disable(request: unknown): Promise<unknown>
  update(request: unknown): Promise<unknown>
  remove(request: unknown): Promise<unknown>
  restore(request: unknown): Promise<unknown>
  purge(request: unknown): Promise<unknown>
}

/** Center-owned durable continuation lifecycle over official Agent and Session services. */
export interface TaskContinuationsOwner {
  readonly protocolVersion: 1
  create(agent: unknown, request: unknown): Promise<unknown>
  reserve(request: unknown): Promise<unknown>
  get(id: string): Promise<unknown>
  list(request?: unknown): Promise<readonly unknown[]>
  cancel(ref: unknown): Promise<boolean>
  supersede(request: unknown): Promise<boolean>
  reconcile(signal?: AbortSignal): Promise<void>
  registerVerifier(verifier: Readonly<{
    id: string
    verify(claim: unknown, signal: AbortSignal): Promise<unknown>
  }>): () => void
}

/** Official merged Skill registry used to publish and prove a winning definition. */
export interface SkillsOwner {
  registerProvider(create: (control: Readonly<{ signal: AbortSignal; invalidate(): void }>) => unknown): () => void
  snapshot(options?: unknown): Promise<Readonly<{ skills: readonly unknown[]; complete: boolean }>>
  list(options?: unknown): Promise<readonly unknown[]>
  get(name: string, options?: unknown): Promise<unknown>
}

/** Official Tool registry receiving Center tools and managed MCP tools. */
export interface ToolsOwner {
  register(definition: unknown): () => void
  schemas?(agent?: unknown): readonly unknown[]
}

/** Official Loader mutation and observation surface used by managed Plugins. */
export interface LoaderOwner {
  create(
    options: Readonly<{
      name: string
      config?: unknown
      group?: boolean | null
      disabled?: boolean | null
      inject?: unknown
    }>,
    parent?: string | null,
    position?: number,
  ): Promise<string>
  update(
    id: string,
    options: Readonly<{
      config?: unknown
      group?: boolean | null
      disabled?: boolean | null
      inject?: unknown
    }>,
    parent?: string | null,
    position?: number,
  ): Promise<void>
  remove(id: string): Promise<void>
  await(): Promise<void>
  entries(): Iterable<Readonly<{
    id: string
    options: Readonly<{ id?: string; name: string; group?: boolean }>
    disabled: boolean
    refresh(): Promise<void>
    fiber?: Readonly<{ state: number; await(): Promise<unknown> }>
  }>>
}

/** One coherent owner set assembled entirely inside the Extension Center plugin. */
export interface HostOwners {
  readonly managedPlugins: ManagedPluginsOwner | null
  readonly mcpConnections: McpConnectionsOwner | null
  readonly taskContinuations: TaskContinuationsOwner | null
  readonly skills: SkillsOwner | null
  readonly tools: ToolsOwner | null
  readonly loader: LoaderOwner | null
}

interface ServiceLookup {
  get(name: string): unknown
}

function functions(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return methods.every(method => typeof record[method] === 'function')
}

function service(lookup: ServiceLookup, name: string): unknown {
  try {
    return lookup.get(name)
  } catch {
    return undefined
  }
}

function protocolOwner(value: unknown, methods: readonly string[]): boolean {
  return functions(value, methods) && (value as Readonly<Record<string, unknown>>).protocolVersion === 1
}

/** Bind Center-owned lifecycles to the exact official DSH registries they use. */
export function bindHostOwners(
  lookup: ServiceLookup,
  internal: Readonly<{
    managedPlugins: ManagedPluginsOwner
    mcpConnections: McpConnectionsOwner
    taskContinuations: TaskContinuationsOwner
  }>,
): HostOwners {
  const skills = service(lookup, 'skills')
  const tools = service(lookup, 'tools')
  const loader = service(lookup, 'loader')
  if (!functions(internal.managedPlugins, ['snapshot'])) throw new Error('Center managed Plugin owner is invalid')
  if (!protocolOwner(internal.mcpConnections, [
    'snapshot', 'get', 'getRemoved', 'registeredToolNames', 'configure', 'enable', 'disable', 'update', 'remove', 'restore', 'purge',
  ])) {
    throw new Error('Center MCP owner is invalid')
  }
  if (!protocolOwner(internal.taskContinuations, [
    'create', 'reserve', 'get', 'list', 'cancel', 'supersede', 'reconcile', 'registerVerifier',
  ])) {
    throw new Error('Center continuation owner is invalid')
  }
  return Object.freeze({
    managedPlugins: internal.managedPlugins,
    mcpConnections: internal.mcpConnections,
    taskContinuations: internal.taskContinuations,
    skills: functions(skills, ['registerProvider', 'snapshot', 'list', 'get']) ? skills as SkillsOwner : null,
    tools: functions(tools, ['register']) ? tools as ToolsOwner : null,
    loader: functions(loader, ['create', 'update', 'remove', 'await', 'entries']) ? loader as LoaderOwner : null,
  })
}

/** Project truthful lifecycle capability without depending on non-official Host services. */
export function hostCapabilities(owners: HostOwners): HostCapabilityProjection {
  const managedPluginLifecycle = owners.managedPlugins !== null
  const dynamicMcpConnection = owners.mcpConnections !== null
  const durableContinuation = owners.taskContinuations !== null
  const skillRegistry = owners.skills !== null
  const toolRegistry = owners.tools !== null
  const loaderMutation = owners.loader !== null
  const acquisition = managedPluginLifecycle
    && dynamicMcpConnection
    && durableContinuation
    && skillRegistry
    && toolRegistry
    && loaderMutation
  return Object.freeze({
    managedPluginLifecycle,
    dynamicMcpConnection,
    durableContinuation,
    skillRegistry,
    toolRegistry,
    loaderMutation,
    acquisition,
    reason: acquisition ? null : 'host-capability',
  })
}
