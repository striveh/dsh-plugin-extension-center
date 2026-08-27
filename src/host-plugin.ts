/** Independent Extension Center Host lifecycle assembled on official DSH services. */

import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { EXTENSION_CENTER_RPC_CHANNEL } from './catalog-contract.ts'
import { catalogListResponse } from './catalog.ts'
import { CatalogSnapshotManager, canonicalCatalogUrl } from './catalog-refresh.ts'
import {
  ArtifactFetcher,
  CenterStateStore,
  FileTargetLock,
  bindHostOwners,
  hostCapabilities,
  type HostOwners,
  type LoaderOwner,
} from './host/index.ts'
import {
  InternalTaskContinuationOwner,
  createInternalTaskContinuations,
  type ContinuationAgentPresets,
  type ContinuationAgents,
  type ContinuationSessionPersistence,
  type ContinuationSessions,
} from './internal/continuation/index.ts'
import { CenterMcpConnections } from './internal/mcp/index.ts'
import { isOfficialProfileAmbiguityError } from './internal/plugin/index.ts'
import {
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
import { FileOperationStore, FilePlanStore } from './storage/index.ts'

/** Cordis identity for the independent Extension Center Host half. */
export const name = 'extension-center'

/** Connection is the carrier; internal bindings track all other official services. */
export const inject = ['connection']

type GenerationDisposer = () => void | Promise<void>

class RetiredOwnerGenerationError extends Error {
  constructor() {
    super('Extension Center runtime retired')
    this.name = 'RetiredOwnerGenerationError'
  }
}

/** Drain management requests before releasing Center-owned registrations. */
class WritableOwnerGeneration implements HostRpcGeneration {
  private readonly controller = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly resources: GenerationDisposer[] = []
  private accepting = false
  private cleanup: Promise<void> | undefined

  constructor(
    private readonly withdraw: () => void,
    private readonly reportFailure: (error: unknown) => void,
  ) {}

  /** Cancellation shared by startup recovery and management requests. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Keep a registration under the generation's explicitly ordered disposer. */
  addResource(disposer: GenerationDisposer): void {
    this.resources.push(disposer)
    this.throwIfRetired()
  }

  /** Publish only after durable recovery and every internal owner are ready. */
  activate(): void {
    this.throwIfRetired()
    this.accepting = true
  }

  /** Run startup after the owning Cordis callback returns, while retaining cleanup ownership. */
  start(startup: (signal: AbortSignal) => Promise<void>): void {
    const task = this.track(Promise.resolve().then(async () => {
      this.throwIfRetired()
      await startup(this.signal)
    }))
    void task.catch((error: unknown) => {
      const expectedRetirement = this.signal.aborted || error instanceof RetiredOwnerGenerationError
      const cleanup = this.retire(error)
      if (!expectedRetirement) this.reportFailure(error)
      void cleanup.catch(this.reportFailure)
    })
  }

  /** Run and drain one RPC against this exact Center-owned runtime. */
  async run<T>(outerSignal: AbortSignal, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) throw new RetiredOwnerGenerationError()
    this.throwIfRetired()
    const signal = AbortSignal.any([outerSignal, this.controller.signal])
    const result = await this.track(request(signal))
    this.throwIfRetired()
    return result
  }

  /** Withdraw writes, abort work, await quiescence, then release registrations. */
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
      if (failures.length > 1) throw new AggregateError(failures, 'Extension Center runtime cleanup failed')
    })()
    return this.cleanup
  }

  private throwIfRetired(): void {
    if (this.controller.signal.aborted) throw this.controller.signal.reason
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task)
    const release = () => { this.tasks.delete(task) }
    void task.then(release, release)
    return task
  }
}

/** Product-owned Host configuration; credentials and arbitrary commands are absent. */
export interface Config {
  readonly root?: string
  readonly maximumArtifactRedirects?: number
  readonly allowedArtifactRedirectHosts?: readonly string[]
  readonly mcpRuntimes?: readonly AdmittedMcpRuntime[]
  readonly catalogTrustedUrl?: string
  readonly catalogFetchTimeoutMs?: number
  readonly catalogRefreshIntervalMs?: number
  /** Absolute current `@deepseek-ai/dsh` CLI entrypoint; defaults to this Host's startup entrypoint. */
  readonly dshCliEntrypoint?: string
  readonly dshCliTimeoutMs?: number
}

interface ResolvedConfig {
  readonly root: string
  readonly hostHome: string
  readonly maximumArtifactRedirects: number
  readonly allowedArtifactRedirectHosts: readonly string[]
  readonly mcpRuntimes: readonly AdmittedMcpRuntime[]
  readonly catalogTrustedUrl: string | null
  readonly catalogFetchTimeoutMs: number
  readonly catalogRefreshIntervalMs: number
  readonly dshCliEntrypoint: string | undefined
  readonly dshCliTimeoutMs: number
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
  readonly skill: SkillLifecycleProvider
  readonly mcp: McpLifecycleProvider
  readonly plugin: PluginLifecycleProvider
}

function sameOrBelow(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate))
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

function resolvedConfig(value: Config = {}): ResolvedConfig {
  const configuredRoot = value.root?.trim()
  const dshHome = process.env.DSH_HOME?.trim()
  const hostHome = resolve(dshHome && dshHome.length > 0 ? dshHome : join(homedir(), '.dsh'))
  const root = resolve(configuredRoot && configuredRoot.length > 0
    ? configuredRoot
    : join(hostHome, 'extension-center'))
  const profilesRoot = join(hostHome, 'profiles')
  if (root === hostHome || sameOrBelow(profilesRoot, root) || sameOrBelow(root, profilesRoot)) {
    throw new Error('Extension Center root must not overlap the official DSH home or Profile state')
  }
  const maximumArtifactRedirects = value.maximumArtifactRedirects ?? 1
  if (!Number.isSafeInteger(maximumArtifactRedirects) || maximumArtifactRedirects < 0 || maximumArtifactRedirects > 5) {
    throw new Error('maximumArtifactRedirects must be an integer between zero and five')
  }
  const hosts = value.allowedArtifactRedirectHosts ?? [
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ]
  if (!Array.isArray(hosts) || hosts.length > 16 || hosts.some(host => typeof host !== 'string'
    || host !== host.toLowerCase() || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host))) {
    throw new Error('allowedArtifactRedirectHosts must contain canonical lower-case DNS names')
  }
  const mcpRuntimes = value.mcpRuntimes ?? []
  if (!Array.isArray(mcpRuntimes) || mcpRuntimes.length > 32) throw new Error('mcpRuntimes exceeds its Host allowlist bound')
  const catalogTrustedUrl = value.catalogTrustedUrl ?? null
  if (catalogTrustedUrl !== null) canonicalCatalogUrl(catalogTrustedUrl)
  const catalogFetchTimeoutMs = value.catalogFetchTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(catalogFetchTimeoutMs) || catalogFetchTimeoutMs < 1_000 || catalogFetchTimeoutMs > 60_000) {
    throw new Error('catalogFetchTimeoutMs must be an integer between 1000 and 60000')
  }
  const catalogRefreshIntervalMs = value.catalogRefreshIntervalMs ?? 300_000
  if (!Number.isSafeInteger(catalogRefreshIntervalMs)
    || catalogRefreshIntervalMs < 60_000 || catalogRefreshIntervalMs > 86_400_000) {
    throw new Error('catalogRefreshIntervalMs must be an integer between 60000 and 86400000')
  }
  const configuredCli = value.dshCliEntrypoint?.trim()
  if (configuredCli !== undefined && (!isAbsolute(configuredCli) || configuredCli.length === 0)) {
    throw new Error('dshCliEntrypoint must be an absolute path')
  }
  const dshCliTimeoutMs = value.dshCliTimeoutMs ?? 120_000
  if (!Number.isSafeInteger(dshCliTimeoutMs) || dshCliTimeoutMs < 1_000 || dshCliTimeoutMs > 600_000) {
    throw new Error('dshCliTimeoutMs must be an integer between 1000 and 600000')
  }
  return Object.freeze({
    root,
    hostHome,
    maximumArtifactRedirects,
    allowedArtifactRedirectHosts: Object.freeze([...new Set(hosts)].sort()),
    mcpRuntimes: Object.freeze(mcpRuntimes.map(runtime => runtime.transport === 'stdio'
      ? Object.freeze({ ...runtime, fixedArgs: Object.freeze([...runtime.fixedArgs]) })
      : Object.freeze({ ...runtime }))),
    catalogTrustedUrl,
    catalogFetchTimeoutMs,
    catalogRefreshIntervalMs,
    dshCliEntrypoint: configuredCli === undefined ? undefined : resolve(configuredCli),
    dshCliTimeoutMs,
  })
}

function requiredService<T>(host: ConnectionContext, name: string, methods: readonly string[]): T {
  const value = host.get(name)
  if (typeof value !== 'object' || value === null
    || methods.some(method => typeof (value as Readonly<Record<string, unknown>>)[method] !== 'function')) {
    throw new Error(`official DSH service ${JSON.stringify(name)} is incompatible with the Extension Center`)
  }
  return value as T
}

function createRuntime(
  resolved: ResolvedConfig,
  state: CenterStateStore,
  operations: FileOperationStore,
  locks: FileTargetLock,
  getCatalog: () => ReturnType<CatalogSnapshotManager['current']>['catalog'],
  owners: HostOwners,
  plugin: PluginLifecycleProvider,
  recoveryExecutable: Awaited<ReturnType<typeof installPackagedRecoveryExecutable>>,
): RuntimeResources {
  if (owners.skills === null || owners.mcpConnections === null || owners.loader === null) {
    throw new Error('official DSH registries are incomplete for Extension Center P0')
  }
  const plans = new FilePlanStore(resolved.root, recoveryExecutable)
  const skill = new SkillLifecycleProvider(resolved.root, state, owners.skills)
  const mcp = new McpLifecycleProvider(state, owners.mcpConnections, resolved.mcpRuntimes)
  const inventory = new HostInventoryService(
    state,
    owners,
    getCatalog,
    plugin,
    version => mcp.inspect(version),
  )
  const providers: LifecycleProviders = { plugin, mcp, skill }
  const intentPlans = new IntentPlanService(
    state,
    plans,
    inventory,
    owners,
    getCatalog,
    plugin,
    {
      mcpRuntime: (candidateRef, configuration) => mcp.preflight(candidateRef, configuration),
      mcpOptions: candidateRef => mcp.options(candidateRef),
    },
  )
  const runner = new OperationRunner(
    state,
    plans,
    operations,
    locks,
    new ArtifactFetcher(resolved.root, {
      maximumRedirects: resolved.maximumArtifactRedirects,
      allowedCrossOriginHosts: resolved.allowedArtifactRedirectHosts,
    }),
    intentPlans,
    providers,
  )
  return Object.freeze({ owners, plans, inventory, intentPlans, runner, skill, mcp, plugin })
}

function rpcServices(
  runtime: RuntimeResources,
  catalogs: CatalogSnapshotManager,
  getCatalog: () => ReturnType<CatalogSnapshotManager['current']>['catalog'],
  acquisition: CapabilityAcquisitionService,
  generation: HostRpcGeneration,
): HostRpcServices {
  return Object.freeze({
    owners: runtime.owners,
    capabilities: hostCapabilities(runtime.owners),
    generation,
    catalog: getCatalog,
    catalogStatus: () => catalogs.current().status,
    refreshCatalog: () => catalogs.refresh(),
    inventory: runtime.inventory,
    intentPlans: runtime.intentPlans,
    plans: runtime.plans,
    operations: runtime.runner,
    acquisition,
  })
}

/** Assemble every managed lifecycle inside one independent plugin on official DSH rc.2. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const host = ctx as unknown as ConnectionContext
  const resolved = resolvedConfig(config)
  const state = new CenterStateStore(resolved.root)
  await state.initialize()
  const catalogs = new CatalogSnapshotManager(resolved.root, {
    trustedUrl: resolved.catalogTrustedUrl,
    fetchTimeoutMs: resolved.catalogFetchTimeoutMs,
  })
  await catalogs.initialize()
  const getCatalog = () => catalogs.current().catalog
  if (resolved.catalogTrustedUrl !== null) {
    const timer = setInterval(() => { void catalogs.refresh() }, resolved.catalogRefreshIntervalMs)
    timer.unref()
    ctx.effect(() => () => { clearInterval(timer) }, 'extension-center: catalog refresh')
  }

  const mcpFiber = ctx.plugin(CenterMcpConnections, { root: resolved.root })
  await mcpFiber

  const continuationBinding = ctx.inject(
    ['agentPresets', 'agents', 'sessions', 'sessionPersistence'],
    async (ownerContext: Context) => {
      const ownerHost = ownerContext as unknown as ConnectionContext
      const owner = await createInternalTaskContinuations({
        root: join(resolved.root, 'continuation'),
        agentPresets: requiredService<ContinuationAgentPresets>(ownerHost, 'agentPresets', ['mount']),
        agents: requiredService<ContinuationAgents>(ownerHost, 'agents', ['get', 'resume']),
        sessions: requiredService<ContinuationSessions>(ownerHost, 'sessions', ['get', 'flush']),
        sessionPersistence: requiredService<ContinuationSessionPersistence>(ownerHost, 'sessionPersistence', ['load']),
        observeLifecycle: requestReconciliation => {
          const disposers = [
            ownerContext.on('agent/created', requestReconciliation),
            ownerContext.on('agent/status', requestReconciliation),
            ownerContext.on('session/event', requestReconciliation),
          ]
          return () => { for (const dispose of disposers.reverse()) dispose() }
        },
        logger: { warn: message => { ownerContext.logger.warn(message) } },
      })
      ownerContext.effect(() => () => owner.dispose(), 'extension-center: continuation owner')
      ownerContext.provide('taskContinuations', owner)
      await owner.reconcile()
    },
  )
  await continuationBinding

  const operations = new FileOperationStore(resolved.root)
  const locks = new FileTargetLock(resolved.root)
  let activeRpc: HostRpcServices | null = null
  let activeOwnerGeneration: WritableOwnerGeneration | null = null
  const writableBinding = ctx.inject(
    ['mcpConnections', 'taskContinuations', 'skills', 'tools', 'loader'],
    async (ownerContext: Context) => {
      const ownerHost = ownerContext as unknown as ConnectionContext
      const mcpConnections = requiredService<CenterMcpConnections>(ownerHost, 'mcpConnections', [
        'snapshot', 'get', 'getRemoved', 'configure', 'enable', 'disable', 'update', 'remove', 'restore', 'purge',
      ])
      if (!(mcpConnections instanceof CenterMcpConnections)) {
        throw new Error('mcpConnections is not owned by this Extension Center')
      }
      const continuations = requiredService<Awaited<ReturnType<typeof createInternalTaskContinuations>>>(
        ownerHost,
        'taskContinuations',
        ['create', 'reserve', 'get', 'list', 'cancel', 'supersede', 'registerVerifier', 'reconcile', 'dispose'],
      )
      if (!(continuations instanceof InternalTaskContinuationOwner)) {
        throw new Error('taskContinuations is not owned by this Extension Center')
      }
      const loader = requiredService<LoaderOwner>(ownerHost, 'loader', ['create', 'update', 'remove', 'await', 'entries'])
      const recoveryEntrypoint = resolved.dshCliEntrypoint ?? process.argv[1]
      if (recoveryEntrypoint === undefined) {
        throw new Error('official DSH CLI entrypoint is unavailable for standalone recovery')
      }
      const recoveryExecutable = await installPackagedRecoveryExecutable(resolved.root, {
        entrypointPath: recoveryEntrypoint,
        hostHome: resolved.hostHome,
        timeoutMs: resolved.dshCliTimeoutMs,
      })
      const retiredPluginObligations = new Set<string>()
      const retiredPluginTargets = new Set<string>()
      const obligationKey = (operationId: string, targetKey: string, profileId: string): string => (
        `${operationId}\0${targetKey}\0${profileId}`
      )
      const targetObligationKey = (targetKey: string, profileId: string): string => `${targetKey}\0${profileId}`
      const plugin = new PluginLifecycleProvider(state, loader, {
        hostHome: resolved.hostHome,
        centerPackageName: 'dsh-plugin-extension-center',
        officialDsh: recoveryExecutable.officialDsh,
        isOperationQuarantined: (operationId, targetKey, profileId) => (
          retiredPluginObligations.has(obligationKey(operationId, targetKey, profileId))
        ),
        isTargetQuarantined: (targetKey, profileId) => (
          retiredPluginTargets.has(targetObligationKey(targetKey, profileId))
        ),
      })
      const owners = bindHostOwners(ownerHost, {
        managedPlugins: plugin,
        mcpConnections,
        taskContinuations: continuations,
      })
      if (!hostCapabilities(owners).acquisition) {
        throw new Error('official DSH rc.2 does not expose every Extension Center service dependency')
      }
      let generation!: WritableOwnerGeneration
      generation = new WritableOwnerGeneration(
        () => {
          if (activeOwnerGeneration !== generation) return
          activeOwnerGeneration = null
          activeRpc = null
        },
        (error: unknown) => { ownerContext.logger.error(error) },
      )
      ownerContext.effect(() => () => generation.retire(), 'extension-center: runtime generation')
      generation.start(async (signal) => {
        const runtime = createRuntime(
          resolved,
          state,
          operations,
          locks,
          getCatalog,
          owners,
          plugin,
          recoveryExecutable,
        )
        for (const obligation of await runtime.runner.retiredPluginObligations(signal)) {
          retiredPluginObligations.add(obligationKey(
            obligation.operationId,
            obligation.targetKey,
            obligation.profileId,
          ))
          retiredPluginTargets.add(targetObligationKey(obligation.targetKey, obligation.profileId))
        }
        try {
          await plugin.initialize()
        } catch (error: unknown) {
          if (!isOfficialProfileAmbiguityError(error)) throw error
        }
        generation.addResource(runtime.skill.register())
        await runtime.runner.recover(signal)
        const acquisition = new CapabilityAcquisitionService(
          state,
          runtime.inventory,
          runtime.intentPlans,
          runtime.plans,
          operations,
          owners,
          getCatalog,
        )
        generation.addResource(acquisition.registerVerifier())
        await acquisition.recoverApprovedPlans(signal)
        for (const definition of capabilityToolDefinitions(acquisition)) {
          generation.addResource(owners.tools!.register(definition))
        }
        await continuations.reconcile(signal)
        generation.activate()
        activeOwnerGeneration = generation
        activeRpc = rpcServices(runtime, catalogs, getCatalog, acquisition, generation)
      })
    },
  )
  await writableBinding

  const handler: ConnectionRpcHandler = async (endpoint, payload, signal) => {
    const services = activeRpc
    if (services === null) {
      if (signal.aborted) {
        return { ok: false, error: { code: 'cancelled', message: 'request was cancelled', details: {} } }
      }
      if (endpoint === 'catalog/list' || endpoint === 'catalog/refresh') {
        try {
          if (typeof payload !== 'object' || payload === null || Array.isArray(payload)
            || Object.keys(payload).length !== 1
            || (payload as Readonly<Record<string, unknown>>).protocolVersion !== 1) {
            throw new Error('request contains unexpected fields')
          }
          const snapshot = endpoint === 'catalog/refresh' ? await catalogs.refresh() : catalogs.current()
          return {
            ok: true,
            value: catalogListResponse(snapshot.catalog, undefined, snapshot.status),
          }
        } catch (error: unknown) {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: error instanceof Error ? error.message : 'catalog request was refused',
              details: { issues: [] },
            },
          }
        }
      }
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: 'Extension Center lifecycle owners are not active',
          details: { issues: [] },
        },
      }
    }
    return await createHostRpcHandler(services)(endpoint, payload, signal)
  }
  ctx.effect(
    () => host.connection.rpc.handle(EXTENSION_CENTER_RPC_CHANNEL, handler, { authority: 'loopback' }),
    'extension-center: loopback RPC',
  )
}
