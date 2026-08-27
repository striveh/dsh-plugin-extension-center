/** Independent Extension Center Host lifecycle assembled on official DSH services. */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EXTENSION_CENTER_RPC_CHANNEL } from "./catalog-contract.js";
import { catalogListResponse } from "./catalog.js";
import { CatalogSnapshotManager, canonicalCatalogUrl } from "./catalog-refresh.js";
import { ArtifactFetcher, CenterStateStore, FileTargetLock, bindHostOwners, hostCapabilities, } from "./host/index.js";
import { InternalTaskContinuationOwner, createInternalTaskContinuations, } from "./internal/continuation/index.js";
import { CenterMcpConnections } from "./internal/mcp/index.js";
import { isOfficialProfileAmbiguityError } from "./internal/plugin/index.js";
import { McpLifecycleProvider, PluginLifecycleProvider, SkillLifecycleProvider, } from "./providers/index.js";
import { installPackagedRecoveryExecutable } from "./recovery/install.js";
import { CapabilityAcquisitionService, capabilityToolDefinitions } from "./service/capability-service.js";
import { IntentPlanService } from "./service/intent-plan-service.js";
import { HostInventoryService } from "./service/inventory-service.js";
import { OperationRunner } from "./service/operation-runner.js";
import { createHostRpcHandler, } from "./service/rpc-service.js";
import { FileOperationStore, FilePlanStore } from "./storage/index.js";
/** Cordis identity for the independent Extension Center Host half. */
export const name = 'extension-center';
/** Connection is the carrier; internal bindings track all other official services. */
export const inject = ['connection'];
class RetiredOwnerGenerationError extends Error {
    constructor() {
        super('Extension Center runtime retired');
        this.name = 'RetiredOwnerGenerationError';
    }
}
/** Drain management requests before releasing Center-owned registrations. */
class WritableOwnerGeneration {
    withdraw;
    reportFailure;
    controller = new AbortController();
    tasks = new Set();
    resources = [];
    accepting = false;
    cleanup;
    constructor(withdraw, reportFailure) {
        this.withdraw = withdraw;
        this.reportFailure = reportFailure;
    }
    /** Cancellation shared by startup recovery and management requests. */
    get signal() {
        return this.controller.signal;
    }
    /** Keep a registration under the generation's explicitly ordered disposer. */
    addResource(disposer) {
        this.resources.push(disposer);
        this.throwIfRetired();
    }
    /** Publish only after durable recovery and every internal owner are ready. */
    activate() {
        this.throwIfRetired();
        this.accepting = true;
    }
    /** Run startup after the owning Cordis callback returns, while retaining cleanup ownership. */
    start(startup) {
        const task = this.track(Promise.resolve().then(async () => {
            this.throwIfRetired();
            await startup(this.signal);
        }));
        void task.catch((error) => {
            const expectedRetirement = this.signal.aborted || error instanceof RetiredOwnerGenerationError;
            const cleanup = this.retire(error);
            if (!expectedRetirement)
                this.reportFailure(error);
            void cleanup.catch(this.reportFailure);
        });
    }
    /** Run and drain one RPC against this exact Center-owned runtime. */
    async run(outerSignal, request) {
        if (!this.accepting)
            throw new RetiredOwnerGenerationError();
        this.throwIfRetired();
        const signal = AbortSignal.any([outerSignal, this.controller.signal]);
        const result = await this.track(request(signal));
        this.throwIfRetired();
        return result;
    }
    /** Withdraw writes, abort work, await quiescence, then release registrations. */
    retire(reason = new RetiredOwnerGenerationError()) {
        if (this.cleanup !== undefined)
            return this.cleanup;
        this.accepting = false;
        this.withdraw();
        this.controller.abort(reason);
        const tasks = [...this.tasks];
        this.cleanup = (async () => {
            await Promise.allSettled(tasks);
            const failures = [];
            for (const dispose of this.resources.splice(0).reverse()) {
                try {
                    await dispose();
                }
                catch (error) {
                    failures.push(error);
                }
            }
            if (failures.length === 1)
                throw failures[0];
            if (failures.length > 1)
                throw new AggregateError(failures, 'Extension Center runtime cleanup failed');
        })();
        return this.cleanup;
    }
    throwIfRetired() {
        if (this.controller.signal.aborted)
            throw this.controller.signal.reason;
    }
    track(task) {
        this.tasks.add(task);
        const release = () => { this.tasks.delete(task); };
        void task.then(release, release);
        return task;
    }
}
function sameOrBelow(root, candidate) {
    const value = relative(resolve(root), resolve(candidate));
    return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
function resolvedConfig(value = {}) {
    const configuredRoot = value.root?.trim();
    const dshHome = process.env.DSH_HOME?.trim();
    const hostHome = resolve(dshHome && dshHome.length > 0 ? dshHome : join(homedir(), '.dsh'));
    const root = resolve(configuredRoot && configuredRoot.length > 0
        ? configuredRoot
        : join(hostHome, 'extension-center'));
    const profilesRoot = join(hostHome, 'profiles');
    if (root === hostHome || sameOrBelow(profilesRoot, root) || sameOrBelow(root, profilesRoot)) {
        throw new Error('Extension Center root must not overlap the official DSH home or Profile state');
    }
    const maximumArtifactRedirects = value.maximumArtifactRedirects ?? 1;
    if (!Number.isSafeInteger(maximumArtifactRedirects) || maximumArtifactRedirects < 0 || maximumArtifactRedirects > 5) {
        throw new Error('maximumArtifactRedirects must be an integer between zero and five');
    }
    const hosts = value.allowedArtifactRedirectHosts ?? [
        'objects.githubusercontent.com',
        'release-assets.githubusercontent.com',
    ];
    if (!Array.isArray(hosts) || hosts.length > 16 || hosts.some(host => typeof host !== 'string'
        || host !== host.toLowerCase() || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host))) {
        throw new Error('allowedArtifactRedirectHosts must contain canonical lower-case DNS names');
    }
    const mcpRuntimes = value.mcpRuntimes ?? [];
    if (!Array.isArray(mcpRuntimes) || mcpRuntimes.length > 32)
        throw new Error('mcpRuntimes exceeds its Host allowlist bound');
    const catalogTrustedUrl = value.catalogTrustedUrl ?? null;
    if (catalogTrustedUrl !== null)
        canonicalCatalogUrl(catalogTrustedUrl);
    const catalogFetchTimeoutMs = value.catalogFetchTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(catalogFetchTimeoutMs) || catalogFetchTimeoutMs < 1_000 || catalogFetchTimeoutMs > 60_000) {
        throw new Error('catalogFetchTimeoutMs must be an integer between 1000 and 60000');
    }
    const catalogRefreshIntervalMs = value.catalogRefreshIntervalMs ?? 300_000;
    if (!Number.isSafeInteger(catalogRefreshIntervalMs)
        || catalogRefreshIntervalMs < 60_000 || catalogRefreshIntervalMs > 86_400_000) {
        throw new Error('catalogRefreshIntervalMs must be an integer between 60000 and 86400000');
    }
    const configuredCli = value.dshCliEntrypoint?.trim();
    if (configuredCli !== undefined && (!isAbsolute(configuredCli) || configuredCli.length === 0)) {
        throw new Error('dshCliEntrypoint must be an absolute path');
    }
    const dshCliTimeoutMs = value.dshCliTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(dshCliTimeoutMs) || dshCliTimeoutMs < 1_000 || dshCliTimeoutMs > 600_000) {
        throw new Error('dshCliTimeoutMs must be an integer between 1000 and 600000');
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
    });
}
function requiredService(host, name, methods) {
    const value = host.get(name);
    if (typeof value !== 'object' || value === null
        || methods.some(method => typeof value[method] !== 'function')) {
        throw new Error(`official DSH service ${JSON.stringify(name)} is incompatible with the Extension Center`);
    }
    return value;
}
function createRuntime(resolved, state, operations, locks, getCatalog, owners, plugin, recoveryExecutable) {
    if (owners.skills === null || owners.mcpConnections === null || owners.loader === null) {
        throw new Error('official DSH registries are incomplete for Extension Center P0');
    }
    const plans = new FilePlanStore(resolved.root, recoveryExecutable);
    const skill = new SkillLifecycleProvider(resolved.root, state, owners.skills);
    const mcp = new McpLifecycleProvider(state, owners.mcpConnections, resolved.mcpRuntimes);
    const inventory = new HostInventoryService(state, owners, getCatalog, plugin, version => mcp.inspect(version));
    const providers = { plugin, mcp, skill };
    const intentPlans = new IntentPlanService(state, plans, inventory, owners, getCatalog, plugin, {
        mcpRuntime: (candidateRef, configuration) => mcp.preflight(candidateRef, configuration),
        mcpOptions: candidateRef => mcp.options(candidateRef),
    });
    const runner = new OperationRunner(state, plans, operations, locks, new ArtifactFetcher(resolved.root, {
        maximumRedirects: resolved.maximumArtifactRedirects,
        allowedCrossOriginHosts: resolved.allowedArtifactRedirectHosts,
    }), intentPlans, providers);
    return Object.freeze({ owners, plans, inventory, intentPlans, runner, skill, mcp, plugin });
}
function rpcServices(runtime, catalogs, getCatalog, acquisition, generation) {
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
    });
}
/** Assemble every managed lifecycle inside one independent plugin on official DSH rc.2. */
export async function apply(ctx, config = {}) {
    const host = ctx;
    const resolved = resolvedConfig(config);
    const state = new CenterStateStore(resolved.root);
    await state.initialize();
    const catalogs = new CatalogSnapshotManager(resolved.root, {
        trustedUrl: resolved.catalogTrustedUrl,
        fetchTimeoutMs: resolved.catalogFetchTimeoutMs,
    });
    await catalogs.initialize();
    const getCatalog = () => catalogs.current().catalog;
    if (resolved.catalogTrustedUrl !== null) {
        const timer = setInterval(() => { void catalogs.refresh(); }, resolved.catalogRefreshIntervalMs);
        timer.unref();
        ctx.effect(() => () => { clearInterval(timer); }, 'extension-center: catalog refresh');
    }
    const mcpFiber = ctx.plugin(CenterMcpConnections, { root: resolved.root });
    await mcpFiber;
    const continuationBinding = ctx.inject(['agentPresets', 'agents', 'sessions', 'sessionPersistence'], async (ownerContext) => {
        const ownerHost = ownerContext;
        const owner = await createInternalTaskContinuations({
            root: join(resolved.root, 'continuation'),
            agentPresets: requiredService(ownerHost, 'agentPresets', ['mount']),
            agents: requiredService(ownerHost, 'agents', ['get', 'resume']),
            sessions: requiredService(ownerHost, 'sessions', ['get', 'flush']),
            sessionPersistence: requiredService(ownerHost, 'sessionPersistence', ['load']),
            observeLifecycle: requestReconciliation => {
                const disposers = [
                    ownerContext.on('agent/created', requestReconciliation),
                    ownerContext.on('agent/status', requestReconciliation),
                    ownerContext.on('session/event', requestReconciliation),
                ];
                return () => { for (const dispose of disposers.reverse())
                    dispose(); };
            },
            logger: { warn: message => { ownerContext.logger.warn(message); } },
        });
        ownerContext.effect(() => () => owner.dispose(), 'extension-center: continuation owner');
        ownerContext.provide('taskContinuations', owner);
        await owner.reconcile();
    });
    await continuationBinding;
    const operations = new FileOperationStore(resolved.root);
    const locks = new FileTargetLock(resolved.root);
    let activeRpc = null;
    let activeOwnerGeneration = null;
    const writableBinding = ctx.inject(['mcpConnections', 'taskContinuations', 'skills', 'tools', 'loader'], async (ownerContext) => {
        const ownerHost = ownerContext;
        const mcpConnections = requiredService(ownerHost, 'mcpConnections', [
            'snapshot', 'get', 'getRemoved', 'configure', 'enable', 'disable', 'update', 'remove', 'restore', 'purge',
        ]);
        if (!(mcpConnections instanceof CenterMcpConnections)) {
            throw new Error('mcpConnections is not owned by this Extension Center');
        }
        const continuations = requiredService(ownerHost, 'taskContinuations', ['create', 'reserve', 'get', 'list', 'cancel', 'supersede', 'registerVerifier', 'reconcile', 'dispose']);
        if (!(continuations instanceof InternalTaskContinuationOwner)) {
            throw new Error('taskContinuations is not owned by this Extension Center');
        }
        const loader = requiredService(ownerHost, 'loader', ['create', 'update', 'remove', 'await', 'entries']);
        const recoveryEntrypoint = resolved.dshCliEntrypoint ?? process.argv[1];
        if (recoveryEntrypoint === undefined) {
            throw new Error('official DSH CLI entrypoint is unavailable for standalone recovery');
        }
        const recoveryExecutable = await installPackagedRecoveryExecutable(resolved.root, {
            entrypointPath: recoveryEntrypoint,
            hostHome: resolved.hostHome,
            timeoutMs: resolved.dshCliTimeoutMs,
        });
        const plugin = new PluginLifecycleProvider(state, loader, {
            hostHome: resolved.hostHome,
            centerPackageName: 'dsh-plugin-extension-center',
            officialDsh: recoveryExecutable.officialDsh,
        });
        const owners = bindHostOwners(ownerHost, {
            managedPlugins: plugin,
            mcpConnections,
            taskContinuations: continuations,
        });
        if (!hostCapabilities(owners).acquisition) {
            throw new Error('official DSH rc.2 does not expose every Extension Center service dependency');
        }
        let generation;
        generation = new WritableOwnerGeneration(() => {
            if (activeOwnerGeneration !== generation)
                return;
            activeOwnerGeneration = null;
            activeRpc = null;
        }, (error) => { ownerContext.logger.error(error); });
        ownerContext.effect(() => () => generation.retire(), 'extension-center: runtime generation');
        generation.start(async (signal) => {
            try {
                await plugin.initialize();
            }
            catch (error) {
                if (!isOfficialProfileAmbiguityError(error))
                    throw error;
            }
            const runtime = createRuntime(resolved, state, operations, locks, getCatalog, owners, plugin, recoveryExecutable);
            generation.addResource(runtime.skill.register());
            await runtime.runner.recover(signal);
            const acquisition = new CapabilityAcquisitionService(state, runtime.inventory, runtime.intentPlans, runtime.plans, operations, owners, getCatalog);
            generation.addResource(acquisition.registerVerifier());
            await acquisition.recoverApprovedPlans(signal);
            for (const definition of capabilityToolDefinitions(acquisition)) {
                generation.addResource(owners.tools.register(definition));
            }
            await continuations.reconcile(signal);
            generation.activate();
            activeOwnerGeneration = generation;
            activeRpc = rpcServices(runtime, catalogs, getCatalog, acquisition, generation);
        });
    });
    await writableBinding;
    const handler = async (endpoint, payload, signal) => {
        const services = activeRpc;
        if (services === null) {
            if (signal.aborted) {
                return { ok: false, error: { code: 'cancelled', message: 'request was cancelled', details: {} } };
            }
            if (endpoint === 'catalog/list' || endpoint === 'catalog/refresh') {
                try {
                    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)
                        || Object.keys(payload).length !== 1
                        || payload.protocolVersion !== 1) {
                        throw new Error('request contains unexpected fields');
                    }
                    const snapshot = endpoint === 'catalog/refresh' ? await catalogs.refresh() : catalogs.current();
                    return {
                        ok: true,
                        value: catalogListResponse(snapshot.catalog, undefined, snapshot.status),
                    };
                }
                catch (error) {
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: error instanceof Error ? error.message : 'catalog request was refused',
                            details: { issues: [] },
                        },
                    };
                }
            }
            return {
                ok: false,
                error: {
                    code: 'bad-request',
                    message: 'Extension Center lifecycle owners are not active',
                    details: { issues: [] },
                },
            };
        }
        return await createHostRpcHandler(services)(endpoint, payload, signal);
    };
    ctx.effect(() => host.connection.rpc.handle(EXTENSION_CENTER_RPC_CHANNEL, handler, { authority: 'loopback' }), 'extension-center: loopback RPC');
}
//# sourceMappingURL=host-plugin.js.map
