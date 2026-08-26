import type { HostCapabilityProjection } from '../service/rpc-contract.ts'

/** Narrow Profile generation owner used until its package becomes a published peer. */
export interface ProfileTransactionsOwner {
  readonly protocolVersion: 1
  snapshot(profile: string): Promise<Readonly<{
    profile: string
    revision: number
    treeDigest: string
    effectivePath: string
    activeGeneration: string | null
    lastGoodGeneration: string | null
    rollbackGeneration: string | null
    bootStatus: 'live' | 'pending-restart' | 'verified'
  }>>
  stage(request: unknown): Promise<Readonly<{
    profile: string
    generation: string
    basedOnRevision: number
    basedOnTreeDigest: string
    treeDigest: string
    mutation: unknown
  }>>
  commit(request: unknown): Promise<Readonly<{ before: unknown; after: unknown }>>
  abort(request: unknown): Promise<boolean>
  restoreLastGood(request: unknown): Promise<Readonly<{ before: unknown; after: unknown }>>
  getRestoreReceipt(request: unknown): Promise<Readonly<{
    mutationId: string
    status: 'committed'
    operation: 'restore'
    before: unknown
    after: unknown
    restartRequired: true
  }> | null>
  acknowledgeBoot(request: unknown): Promise<Readonly<{ before: unknown; after: unknown; restartRequired: boolean }>>
  list(profile: string): Promise<unknown>
}

/** Narrow dynamic MCP desired-state owner. */
export interface McpConnectionsOwner {
  readonly protocolVersion: 1
  snapshot(): Readonly<{ revision: number; connections: readonly unknown[]; removed: readonly unknown[] }>
  get(id: string): unknown
  getRemoved(id: string): unknown
  configure(request: unknown): Promise<unknown>
  enable(request: unknown): Promise<unknown>
  disable(request: unknown): Promise<unknown>
  update(request: unknown): Promise<unknown>
  remove(request: unknown): Promise<unknown>
  restore(request: unknown): Promise<unknown>
  purge(request: unknown): Promise<unknown>
}

/** Narrow durable continuation owner used for claim binding and verifier registration. */
export interface TaskContinuationsOwner {
  readonly protocolVersion: 1
  create(agent: unknown, request: unknown): Promise<unknown>
  reserve(request: unknown): Promise<unknown>
  get(id: string): Promise<unknown>
  list(request?: unknown): Promise<readonly unknown[]>
  cancel(ref: unknown): Promise<boolean>
  supersede(request: unknown): Promise<boolean>
  registerVerifier(verifier: Readonly<{
    id: string
    verify(claim: unknown, signal: AbortSignal): Promise<unknown>
  }>): () => void
}

/** Minimal merged Skill registry needed to publish and prove a winning definition. */
export interface SkillsOwner {
  registerProvider(create: (control: Readonly<{ signal: AbortSignal; invalidate(): void }>) => unknown): () => void
  snapshot(options?: unknown): Promise<Readonly<{ skills: readonly unknown[]; complete: boolean }>>
  list(options?: unknown): Promise<readonly unknown[]>
  get(name: string, options?: unknown): Promise<unknown>
}

/** Minimal Tool registry used only after every required Host owner is present. */
export interface ToolsOwner {
  register(definition: unknown): () => void
  schemas?(agent?: unknown): readonly unknown[]
}

/** Current Loader tree used to prove a Plugin consumer after a real boot. */
export interface LoaderOwner {
  await(): Promise<void>
  entries(): Iterable<Readonly<{
    id: string
    options: Readonly<{ id?: string; name: string; group?: boolean }>
    disabled: boolean
    fiber?: Readonly<{ state: number }>
  }>>
}

/** Live owner set captured from one Cordis service view. */
export interface HostOwners {
  readonly profileTransactions: ProfileTransactionsOwner | null
  readonly mcpConnections: McpConnectionsOwner | null
  readonly taskContinuations: TaskContinuationsOwner | null
  readonly skills: SkillsOwner | null
  readonly tools: ToolsOwner | null
  readonly loader: LoaderOwner | null
}

interface ServiceLookup {
  get(name: string): unknown
}

interface ServiceIdentity {
  [Symbol.hasInstance](value: unknown): boolean
}

/** Exact Definition constructors for the three independently released writable owners. */
export interface HostOwnerDefinitions {
  readonly profileTransactions: ServiceIdentity | null
  readonly mcpConnections: ServiceIdentity | null
  readonly taskContinuations: ServiceIdentity | null
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

async function serviceIdentity(moduleName: string, exportName: string): Promise<ServiceIdentity | null> {
  try {
    const exports = await import(moduleName) as Readonly<Record<string, unknown>>
    const value = exports[exportName]
    return typeof value === 'function' ? value as unknown as ServiceIdentity : null
  } catch {
    // A missing or unloadable optional owner package makes only writable acquisition unavailable.
    return null
  }
}

/** Load the exact optional peer Definitions without making the rc.2 read-only lane fail to boot. */
export async function loadHostOwnerDefinitions(): Promise<HostOwnerDefinitions> {
  const [profileTransactions, mcpConnections, taskContinuations] = await Promise.all([
    serviceIdentity('@deepseek-ai/dsh-profile-transactions', 'ProfileTransactions'),
    serviceIdentity('@deepseek-ai/dsh-mcp-connections', 'McpConnections'),
    serviceIdentity('@deepseek-ai/dsh-task-continuation', 'TaskContinuationService'),
  ])
  return Object.freeze({ profileTransactions, mcpConnections, taskContinuations })
}

function exactOwner(
  value: unknown,
  identity: ServiceIdentity | null,
  methods: readonly string[],
): boolean {
  if (identity === null || !identity[Symbol.hasInstance](value) || !functions(value, methods)) return false
  return (value as Readonly<Record<string, unknown>>).protocolVersion === 1
}

/** Probe exact live services without declaring hard Cordis injection requirements. */
export function probeHostOwners(lookup: ServiceLookup, definitions: HostOwnerDefinitions): HostOwners {
  const profile = service(lookup, 'profileTransactions')
  const mcp = service(lookup, 'mcpConnections')
  const continuations = service(lookup, 'taskContinuations')
  const skills = service(lookup, 'skills')
  const tools = service(lookup, 'tools')
  const loader = service(lookup, 'loader')
  return Object.freeze({
    profileTransactions: exactOwner(profile, definitions.profileTransactions, ['snapshot', 'stage', 'commit', 'abort', 'restoreLastGood', 'getRestoreReceipt', 'acknowledgeBoot', 'list'])
      ? profile as ProfileTransactionsOwner
      : null,
    mcpConnections: exactOwner(mcp, definitions.mcpConnections, ['snapshot', 'get', 'getRemoved', 'configure', 'enable', 'disable', 'update', 'remove', 'restore', 'purge'])
      ? mcp as McpConnectionsOwner
      : null,
    taskContinuations: exactOwner(continuations, definitions.taskContinuations, ['create', 'reserve', 'get', 'list', 'cancel', 'supersede', 'registerVerifier'])
      ? continuations as TaskContinuationsOwner
      : null,
    skills: functions(skills, ['registerProvider', 'snapshot', 'list', 'get']) ? skills as SkillsOwner : null,
    tools: functions(tools, ['register']) ? tools as ToolsOwner : null,
    loader: functions(loader, ['await', 'entries']) ? loader as LoaderOwner : null,
  })
}

/** Project truthful management capability without collapsing individual owner evidence. */
export function hostCapabilities(owners: HostOwners): HostCapabilityProjection {
  const profileTransaction = owners.profileTransactions !== null
  const dynamicMcpConnection = owners.mcpConnections !== null
  const durableContinuation = owners.taskContinuations !== null
  const skillRegistry = owners.skills !== null
  const toolRegistry = owners.tools !== null
  const loaderObservation = owners.loader !== null
  const acquisition = profileTransaction
    && dynamicMcpConnection
    && durableContinuation
    && skillRegistry
    && toolRegistry
    && loaderObservation
  return Object.freeze({
    profileTransaction,
    dynamicMcpConnection,
    durableContinuation,
    skillRegistry,
    toolRegistry,
    loaderObservation,
    acquisition,
    reason: acquisition ? null : 'host-capability',
  })
}
