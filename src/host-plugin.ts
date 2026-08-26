/** Independent Extension Center Host lifecycle and dynamic owner activation. */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { EXTENSION_CENTER_RPC_CHANNEL } from './catalog-contract.ts'
import { CatalogSnapshotManager, catalogEndpoint } from './catalog-refresh.ts'
import {
  ArtifactFetcher,
  CenterStateStore,
  FileTargetLock,
  hostCapabilities,
  loadHostOwnerDefinitions,
  probeHostOwners,
  type HostOwnerDefinitions,
  type HostOwners,
} from './host/index.ts'
import type { LifecycleProvider, PreparedProviderOperation } from './providers/index.ts'
import {
  LoaderPluginRuntimeProbe,
  McpLifecycleProvider,
  PluginLifecycleProvider,
  SkillLifecycleProvider,
  type AdmittedMcpRuntime,
} from './providers/index.ts'
import { installPackagedRecoveryExecutable } from './recovery/install.ts'
import { CapabilityAcquisitionService, capabilityToolDefinitions } from './service/capability-service.ts'
import { IntentPlanService } from './service/intent-plan-service.ts'
import { HostInventoryService } from './service/inventory-service.ts'
import { OperationRunner, type LifecycleProviders } from './service/operation-runner.ts'
import {
  createHostRpcHandler,
  type HostRpcGeneration,
  type HostRpcServices,
} from './service/rpc-service.ts'
import type { HostCapabilityProjection } from './service/rpc-contract.ts'
import { FileOperationStore, FilePlanStore } from './storage/index.ts'

/** Cordis identity for the independent Extension Center Host half. */
export const name = 'extension-center'

/** Connection is the only hard dependency; writable owners activate dynamically. */
export const inject = ['connection']

const WRITABLE_OWNER_SERVICES = Object.freeze([
  'profileTransactions',
  'mcpConnections',
  'taskContinuations',
  'skills',
  'tools',
  'loader',
])

type HostOwner = HostOwners[keyof HostOwners]

function originalOwner(owner: HostOwner): HostOwner {
  if (owner === null) return null
  const original = (owner as unknown as Readonly<Record<symbol, unknown>>)[symbols.original]
  return original === undefined ? owner : original as HostOwner
}

function sameOwnerGeneration(captured: HostOwners, current: HostOwners): boolean {
  return originalOwner(captured.profileTransactions) === originalOwner(current.profileTransactions)
    && originalOwner(captured.mcpConnections) === originalOwner(current.mcpConnections)
    && originalOwner(captured.taskContinuations) === originalOwner(current.taskContinuations)
    && originalOwner(captured.skills) === originalOwner(current.skills)
    && originalOwner(captured.tools) === originalOwner(current.tools)
    && originalOwner(captured.loader) === originalOwner(current.loader)
}

type GenerationDisposer = () => void | Promise<void>

class RetiredOwnerGenerationError extends Error {
  constructor() {
    super('Extension Center Host owner generation retired')
    this.name = 'RetiredOwnerGenerationError'
  }
}

/** Own one writable Host generation until every request and registration is quiescent. */
class WritableOwnerGeneration implements HostRpcGeneration {
  private readonly controller = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly resources: GenerationDisposer[] = []
  private accepting = false
  private cleanup: Promise<void> | undefined

  constructor(
    private readonly withdraw: () => void,
    private readonly report: (error: unknown) => void,
  ) {}

  /** Signal shared by setup, recovery, and every request in this generation. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Start setup without keeping the Cordis injection callback pending. */
  start(work: (signal: AbortSignal) => Promise<void>): void {
    const task = this.track(Promise.resolve().then(async () => {
      this.throwIfRetired()
      await work(this.signal)
    }))
    void task.catch((error: unknown) => {
      const expectedRetirement = this.signal.aborted || error instanceof RetiredOwnerGenerationError
      const cleanup = this.retire(error)
      if (!expectedRetirement) this.report(error)
      void cleanup.catch(this.report)
    })
  }

  /** Keep a registration under the generation's explicitly ordered disposer. */
  addResource(disposer: GenerationDisposer): void {
    this.resources.push(disposer)
    this.throwIfRetired()
  }

  /** Publish the generation only after setup and durable recovery finish. */
  activate(publish: () => void): void {
    this.throwIfRetired()
    this.accepting = true
    publish()
  }

  /** Reject a stale owner identity before publishing any later setup stage. */
  requireCurrent(current: boolean): void {
    if (!current && !this.signal.aborted) {
      void this.retire(new RetiredOwnerGenerationError()).catch(this.report)
    }
    this.throwIfRetired()
  }

  /** Run and drain one RPC against this exact Host owner generation. */
  async run<T>(outerSignal: AbortSignal, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) throw new RetiredOwnerGenerationError()
    this.throwIfRetired()
    const signal = AbortSignal.any([outerSignal, this.signal])
    const result = await this.track(request(signal))
    this.throwIfRetired()
    return result
  }

  /** Withdraw writes, abort work, await quiescence, then release registrations in reverse order. */
  retire(reason: unknown = new RetiredOwnerGenerationError()): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    this.accepting = false
    this.withdraw()
    this.controller.abort(reason)
    const tasks = [...this.tasks]
    this.cleanup = (async () => {
      await Promise.allSettled(tasks)
      const failures: unknown[] = []
      for (const dispose of this.resources.splice(0).reverse()) {
        try {
          await dispose()
        } catch (error: unknown) {
          failures.push(error)
        }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Extension Center owner generation cleanup failed')
    })()
    return this.cleanup
  }

  private throwIfRetired(): void {
    if (this.signal.aborted) throw this.signal.reason
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task)
    const release = () => { this.tasks.delete(task) }
    void task.then(release, release)
    return task
  }
}

/** Product-owned Host configuration; credentials and arbitrary commands are intentionally absent. */
export interface Config {
  readonly root?: string
  readonly maximumArtifactRedirects?: number
  readonly allowedArtifactRedirectHosts?: readonly string[]
  readonly mcpRuntimes?: readonly AdmittedMcpRuntime[]
  readonly catalogTrustedOrigin?: string
  readonly catalogFetchTimeoutMs?: number
  readonly catalogRefreshIntervalMs?: number
}

interface ResolvedConfig {
  readonly root: string
  readonly hostHome: string
  readonly maximumArtifactRedirects: number
  readonly allowedArtifactRedirectHosts: readonly string[]
  readonly mcpRuntimes: readonly AdmittedMcpRuntime[]
  readonly catalogTrustedOrigin: string | null
  readonly catalogFetchTimeoutMs: number
  readonly catalogRefreshIntervalMs: number
}

interface ConnectionContext {
  readonly connection: {
    readonly rpc: {
      handle(channel: string, handler: ConnectionRpcHandler, options: { authority: 'loopback' }): () => Promise<void>
    }
  }
  get(name: string): unknown
}

interface RuntimeResources {
  readonly owners: HostOwners
  readonly plans: FilePlanStore
  readonly inventory: HostInventoryService
  readonly intentPlans: IntentPlanService
  readonly runner: OperationRunner
  readonly skill: LifecycleProvider
  readonly mcp: LifecycleProvider
}

interface SharedResources {
  readonly resolved: ResolvedConfig
  readonly state: CenterStateStore
  readonly operations: FileOperationStore
  readonly locks: FileTargetLock
  readonly getCatalog: () => ReturnType<CatalogSnapshotManager['current']>['catalog']
}

function resolvedConfig(value: Config = {}): ResolvedConfig {
  const configuredRoot = value.root?.trim()
  const dshHome = process.env.DSH_HOME?.trim()
  const hostHome = resolve(dshHome && dshHome.length > 0 ? dshHome : join(homedir(), '.dsh'))
  const root = resolve(configuredRoot && configuredRoot.length > 0
    ? configuredRoot
    : join(hostHome, 'extension-center'))
  const maximumArtifactRedirects = value.maximumArtifactRedirects ?? 0
  if (!Number.isSafeInteger(maximumArtifactRedirects) || maximumArtifactRedirects < 0 || maximumArtifactRedirects > 5) {
    throw new Error('maximumArtifactRedirects must be an integer between zero and five')
  }
  const hosts = value.allowedArtifactRedirectHosts ?? []
  if (!Array.isArray(hosts) || hosts.length > 16 || hosts.some(host => typeof host !== 'string'
    || host !== host.toLowerCase() || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host))) {
    throw new Error('allowedArtifactRedirectHosts must contain canonical lower-case DNS names')
  }
  const mcpRuntimes = value.mcpRuntimes ?? []
  if (!Array.isArray(mcpRuntimes) || mcpRuntimes.length > 32) throw new Error('mcpRuntimes exceeds its Host allowlist bound')
  const catalogTrustedOrigin = value.catalogTrustedOrigin?.trim() ?? null
  if (catalogTrustedOrigin !== null) catalogEndpoint(catalogTrustedOrigin)
  const catalogFetchTimeoutMs = value.catalogFetchTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(catalogFetchTimeoutMs) || catalogFetchTimeoutMs < 1_000 || catalogFetchTimeoutMs > 60_000) {
    throw new Error('catalogFetchTimeoutMs must be an integer between 1000 and 60000')
  }
  const catalogRefreshIntervalMs = value.catalogRefreshIntervalMs ?? 300_000
  if (!Number.isSafeInteger(catalogRefreshIntervalMs)
    || catalogRefreshIntervalMs < 60_000 || catalogRefreshIntervalMs > 86_400_000) {
    throw new Error('catalogRefreshIntervalMs must be an integer between 60000 and 86400000')
  }
  return Object.freeze({
    root,
    hostHome,
    maximumArtifactRedirects,
    allowedArtifactRedirectHosts: Object.freeze([...new Set(hosts)].sort()),
    mcpRuntimes: Object.freeze(mcpRuntimes.map(runtime => runtime.transport === 'stdio'
      ? Object.freeze({ ...runtime, fixedArgs: Object.freeze([...runtime.fixedArgs]) })
      : Object.freeze({ ...runtime }))),
    catalogTrustedOrigin,
    catalogFetchTimeoutMs,
    catalogRefreshIntervalMs,
  })
}

class UnavailableProvider implements LifecycleProvider {
  constructor(readonly kind: LifecycleProvider['kind']) {}
  observe(): Promise<null> { return Promise.resolve(null) }
  prepare(): Promise<PreparedProviderOperation> { return Promise.reject(new Error(`${this.kind} Host owner is unavailable`)) }
  recoveryPoint(): null { return null }
  apply(): Promise<never> { return Promise.reject(new Error(`${this.kind} Host owner is unavailable`)) }
  verify(): Promise<never> { return Promise.reject(new Error(`${this.kind} Host owner is unavailable`)) }
  rollback(): Promise<never> { return Promise.reject(new Error(`${this.kind} Host owner is unavailable`)) }
  recover(): Promise<null> { return Promise.resolve(null) }
  cleanup(): Promise<void> { return Promise.resolve() }
}

function createRuntime(
  shared: SharedResources,
  owners: HostOwners,
  recoveryExecutable: Awaited<ReturnType<typeof installPackagedRecoveryExecutable>> | null,
  capabilities?: HostCapabilityProjection,
): RuntimeResources {
  const plans = new FilePlanStore(shared.resolved.root, recoveryExecutable)
  const skill = owners.skills === null
    ? new UnavailableProvider('skill')
    : new SkillLifecycleProvider(shared.resolved.root, shared.state, owners.skills)
  const mcp = owners.mcpConnections === null
    ? new UnavailableProvider('mcp')
    : new McpLifecycleProvider(shared.state, owners.mcpConnections, shared.resolved.mcpRuntimes)
  const plugin = owners.profileTransactions === null || owners.loader === null
    ? new UnavailableProvider('plugin')
    : new PluginLifecycleProvider(
      shared.state,
      owners.profileTransactions,
      new LoaderPluginRuntimeProbe(owners.loader),
    )
  const inventory = new HostInventoryService(
    shared.state,
    owners,
    shared.getCatalog,
    mcp instanceof McpLifecycleProvider ? version => mcp.inspect(version) : null,
    capabilities === undefined ? undefined : () => capabilities,
  )
  const providers: LifecycleProviders = { plugin, mcp, skill }
  const intentPlans = new IntentPlanService(
    shared.state,
    plans,
    inventory,
    owners,
    shared.getCatalog,
    {
      mcpRuntime: (candidateRef, configuration) => mcp instanceof McpLifecycleProvider
        ? mcp.preflight(candidateRef, configuration)
        : Promise.resolve(null),
      mcpOptions: candidateRef => mcp instanceof McpLifecycleProvider
        ? mcp.options(candidateRef)
        : Promise.resolve([]),
    },
  )
  const runner = new OperationRunner(
    shared.state,
    plans,
    shared.operations,
    shared.locks,
    new ArtifactFetcher(shared.resolved.root, {
      maximumRedirects: shared.resolved.maximumArtifactRedirects,
      allowedCrossOriginHosts: shared.resolved.allowedArtifactRedirectHosts,
    }),
    intentPlans,
    providers,
    shared.getCatalog,
  )
  return Object.freeze({ owners, plans, inventory, intentPlans, runner, skill, mcp })
}

function rpcServices(
  runtime: RuntimeResources,
  catalogs: CatalogSnapshotManager,
  shared: SharedResources,
  acquisition: CapabilityAcquisitionService | null,
  capabilities?: HostCapabilityProjection,
  generation?: HostRpcGeneration,
): HostRpcServices {
  return Object.freeze({
    owners: runtime.owners,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(generation === undefined ? {} : { generation }),
    catalog: shared.getCatalog,
    catalogStatus: () => catalogs.current().status,
    refreshCatalog: () => catalogs.refresh(),
    inventory: runtime.inventory,
    intentPlans: runtime.intentPlans,
    plans: runtime.plans,
    operations: runtime.runner,
    acquisition,
  })
}

/**
 * Register the Host using an already loaded owner-Definition set.
 *
 * This internal entrypoint lets the assembled lifecycle regression provide the
 * same Definition identities as its late owner services. Package consumers use
 * {@link apply}, which loads the installed official Definitions.
 */
export async function applyWithHostOwnerDefinitions(
  ctx: Context,
  config: Config,
  definitions: HostOwnerDefinitions,
): Promise<void> {
  const host = ctx as unknown as ConnectionContext
  const resolved = resolvedConfig(config)
  const state = new CenterStateStore(resolved.root)
  await state.initialize()
  const catalogs = new CatalogSnapshotManager(resolved.root, {
    trustedOrigin: resolved.catalogTrustedOrigin,
    fetchTimeoutMs: resolved.catalogFetchTimeoutMs,
  })
  await catalogs.initialize()
  const getCatalog = () => catalogs.current().catalog
  if (resolved.catalogTrustedOrigin !== null) {
    const timer = setInterval(() => { void catalogs.refresh() }, resolved.catalogRefreshIntervalMs)
    timer.unref()
    ctx.effect(() => () => { clearInterval(timer) }, 'extension-center: catalog refresh')
  }
  const shared: SharedResources = Object.freeze({
    resolved,
    state,
    operations: new FileOperationStore(resolved.root),
    locks: new FileTargetLock(resolved.root),
    getCatalog,
  })
  let activeRpc: HostRpcServices | null = null
  let activeGeneration: WritableOwnerGeneration | null = null

  const writableOwners = ctx.inject(WRITABLE_OWNER_SERVICES, (ownerContext: Context) => {
    const owners = probeHostOwners(ownerContext as unknown as ConnectionContext, definitions)
    if (!hostCapabilities(owners).acquisition) return
    let generation!: WritableOwnerGeneration
    generation = new WritableOwnerGeneration(
      () => {
        if (activeGeneration !== generation) return
        activeGeneration = null
        activeRpc = null
      },
      error => ownerContext.logger.error(error),
    )
    ownerContext.effect(
      () => () => generation.retire(),
      'extension-center: writable Host owner generation',
    )
    const generationIsCurrent = () => sameOwnerGeneration(
      owners,
      probeHostOwners(ownerContext as unknown as ConnectionContext, definitions),
    )
    generation.start(async (signal) => {
      const recoveryExecutable = await installPackagedRecoveryExecutable(resolved.root, resolved.hostHome)
      generation.requireCurrent(generationIsCurrent())
      const runtime = createRuntime(shared, owners, recoveryExecutable)
      const skill = runtime.skill
      if (skill instanceof SkillLifecycleProvider) {
        generation.addResource(skill.register())
      }
      await runtime.runner.recover(signal)
      generation.requireCurrent(generationIsCurrent())
      const acquisition = new CapabilityAcquisitionService(
        state,
        runtime.inventory,
        runtime.intentPlans,
        runtime.plans,
        shared.operations,
        owners,
        getCatalog,
      )
      generation.addResource(acquisition.registerVerifier())
      await acquisition.recoverApprovedPlans(signal)
      generation.requireCurrent(generationIsCurrent())
      for (const definition of capabilityToolDefinitions(acquisition)) {
        generation.addResource(owners.tools!.register(definition))
      }
      generation.requireCurrent(generationIsCurrent())
      const ready = rpcServices(runtime, catalogs, shared, acquisition, undefined, generation)
      generation.activate(() => {
        activeGeneration = generation
        activeRpc = ready
      })
    })
  })
  ctx.effect(() => () => writableOwners.dispose(), 'extension-center: writable owner binding')

  const handler = createHostRpcHandler(() => {
    if (activeRpc !== null) return activeRpc
    const observed = probeHostOwners(host, definitions)
    const ownerCapabilities = hostCapabilities(observed)
    const readCapabilities = ownerCapabilities.acquisition
      ? Object.freeze({ ...ownerCapabilities, acquisition: false as const, reason: 'host-capability' as const })
      : ownerCapabilities
    return rpcServices(
      createRuntime(shared, observed, null, readCapabilities),
      catalogs,
      shared,
      null,
      readCapabilities,
    )
  })
  ctx.effect(
    () => host.connection.rpc.handle(EXTENSION_CENTER_RPC_CHANNEL, handler, { authority: 'loopback' }),
    'extension-center: loopback RPC',
  )
}

/** Register read-only Store access immediately and writable acquisition while all six owners are live. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  await applyWithHostOwnerDefinitions(ctx, config, await loadHostOwnerDefinitions())
}
