/** Independent Extension Center Host lifecycle and dynamic owner activation. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { symbols } from '@deepseek-ai/cordis';
import { EXTENSION_CENTER_RPC_CHANNEL } from "./catalog-contract.js";
import { CatalogSnapshotManager, catalogEndpoint } from "./catalog-refresh.js";
import { ArtifactFetcher, CenterStateStore, FileTargetLock, hostCapabilities, loadHostOwnerDefinitions, probeHostOwners, } from "./host/index.js";
import { LoaderPluginRuntimeProbe, McpLifecycleProvider, PluginLifecycleProvider, SkillLifecycleProvider, } from "./providers/index.js";
import { installPackagedRecoveryExecutable } from "./recovery/install.js";
import { CapabilityAcquisitionService, capabilityToolDefinitions } from "./service/capability-service.js";
import { IntentPlanService } from "./service/intent-plan-service.js";
import { HostInventoryService } from "./service/inventory-service.js";
import { OperationRunner } from "./service/operation-runner.js";
import { createHostRpcHandler, } from "./service/rpc-service.js";
import { FileOperationStore, FilePlanStore } from "./storage/index.js";
/** Cordis identity for the independent Extension Center Host half. */
export const name = 'extension-center';
/** Connection is the only hard dependency; writable owners activate dynamically. */
export const inject = ['connection'];
const WRITABLE_OWNER_SERVICES = Object.freeze([
    'profileTransactions',
    'mcpConnections',
    'taskContinuations',
    'skills',
    'tools',
    'loader',
]);
function originalOwner(owner) {
    if (owner === null)
        return null;
    const original = owner[symbols.original];
    return original === undefined ? owner : original;
}
function sameOwnerGeneration(captured, current) {
    return originalOwner(captured.profileTransactions) === originalOwner(current.profileTransactions)
        && originalOwner(captured.mcpConnections) === originalOwner(current.mcpConnections)
        && originalOwner(captured.taskContinuations) === originalOwner(current.taskContinuations)
        && originalOwner(captured.skills) === originalOwner(current.skills)
        && originalOwner(captured.tools) === originalOwner(current.tools)
        && originalOwner(captured.loader) === originalOwner(current.loader);
}
class RetiredOwnerGenerationError extends Error {
    constructor() {
        super('Extension Center Host owner generation retired');
        this.name = 'RetiredOwnerGenerationError';
    }
}
/** Own one writable Host generation until every request and registration is quiescent. */
class WritableOwnerGeneration {
    withdraw;
    report;
    controller = new AbortController();
    tasks = new Set();
    resources = [];
    accepting = false;
    cleanup;
    constructor(withdraw, report) {
        this.withdraw = withdraw;
        this.report = report;
    }
    /** Signal shared by setup, recovery, and every request in this generation. */
    get signal() {
        return this.controller.signal;
    }
    /** Start setup without keeping the Cordis injection callback pending. */
    start(work) {
        const task = this.track(Promise.resolve().then(async () => {
            this.throwIfRetired();
            await work(this.signal);
        }));
        void task.catch((error) => {
            const expectedRetirement = this.signal.aborted || error instanceof RetiredOwnerGenerationError;
            const cleanup = this.retire(error);
            if (!expectedRetirement)
                this.report(error);
            void cleanup.catch(this.report);
        });
    }
    /** Keep a registration under the generation's explicitly ordered disposer. */
    addResource(disposer) {
        this.resources.push(disposer);
        this.throwIfRetired();
    }
    /** Publish the generation only after setup and durable recovery finish. */
    activate(publish) {
        this.throwIfRetired();
        this.accepting = true;
        publish();
    }
    /** Reject a stale owner identity before publishing any later setup stage. */
    requireCurrent(current) {
        if (!current && !this.signal.aborted) {
            void this.retire(new RetiredOwnerGenerationError()).catch(this.report);
        }
        this.throwIfRetired();
    }
    /** Run and drain one RPC against this exact Host owner generation. */
    async run(outerSignal, request) {
        if (!this.accepting)
            throw new RetiredOwnerGenerationError();
        this.throwIfRetired();
        const signal = AbortSignal.any([outerSignal, this.signal]);
        const result = await this.track(request(signal));
        this.throwIfRetired();
        return result;
    }
    /** Withdraw writes, abort work, await quiescence, then release registrations in reverse order. */
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
                throw new AggregateError(failures, 'Extension Center owner generation cleanup failed');
        })();
        return this.cleanup;
    }
    throwIfRetired() {
        if (this.signal.aborted)
            throw this.signal.reason;
    }
    track(task) {
        this.tasks.add(task);
        const release = () => { this.tasks.delete(task); };
        void task.then(release, release);
        return task;
    }
}
function resolvedConfig(value = {}) {
    const configuredRoot = value.root?.trim();
    const dshHome = process.env.DSH_HOME?.trim();
    const hostHome = resolve(dshHome && dshHome.length > 0 ? dshHome : join(homedir(), '.dsh'));
    const root = resolve(configuredRoot && configuredRoot.length > 0
        ? configuredRoot
        : join(hostHome, 'extension-center'));
    const maximumArtifactRedirects = value.maximumArtifactRedirects ?? 0;
    if (!Number.isSafeInteger(maximumArtifactRedirects) || maximumArtifactRedirects < 0 || maximumArtifactRedirects > 5) {
        throw new Error('maximumArtifactRedirects must be an integer between zero and five');
    }
    const hosts = value.allowedArtifactRedirectHosts ?? [];
    if (!Array.isArray(hosts) || hosts.length > 16 || hosts.some(host => typeof host !== 'string'
        || host !== host.toLowerCase() || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host))) {
        throw new Error('allowedArtifactRedirectHosts must contain canonical lower-case DNS names');
    }
    const mcpRuntimes = value.mcpRuntimes ?? [];
    if (!Array.isArray(mcpRuntimes) || mcpRuntimes.length > 32)
        throw new Error('mcpRuntimes exceeds its Host allowlist bound');
    const catalogTrustedOrigin = value.catalogTrustedOrigin?.trim() ?? null;
    if (catalogTrustedOrigin !== null)
        catalogEndpoint(catalogTrustedOrigin);
    const catalogFetchTimeoutMs = value.catalogFetchTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(catalogFetchTimeoutMs) || catalogFetchTimeoutMs < 1_000 || catalogFetchTimeoutMs > 60_000) {
        throw new Error('catalogFetchTimeoutMs must be an integer between 1000 and 60000');
    }
    const catalogRefreshIntervalMs = value.catalogRefreshIntervalMs ?? 300_000;
    if (!Number.isSafeInteger(catalogRefreshIntervalMs)
        || catalogRefreshIntervalMs < 60_000 || catalogRefreshIntervalMs > 86_400_000) {
        throw new Error('catalogRefreshIntervalMs must be an integer between 60000 and 86400000');
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
    });
}
class UnavailableProvider {
    kind;
    constructor(kind) {
        this.kind = kind;
    }
    observe() { return Promise.resolve(null); }
    prepare() { return Promise.reject(new Error(`${this.kind} Host owner is unavailable`)); }
    recoveryPoint() { return null; }
    apply() { return Promise.reject(new Error(`${this.kind} Host owner is unavailable`)); }
    verify() { return Promise.reject(new Error(`${this.kind} Host owner is unavailable`)); }
    rollback() { return Promise.reject(new Error(`${this.kind} Host owner is unavailable`)); }
    recover() { return Promise.resolve(null); }
    cleanup() { return Promise.resolve(); }
}
function createRuntime(shared, owners, recoveryExecutable, capabilities) {
    const plans = new FilePlanStore(shared.resolved.root, recoveryExecutable);
    const skill = owners.skills === null
        ? new UnavailableProvider('skill')
        : new SkillLifecycleProvider(shared.resolved.root, shared.state, owners.skills);
    const mcp = owners.mcpConnections === null
        ? new UnavailableProvider('mcp')
        : new McpLifecycleProvider(shared.state, owners.mcpConnections, shared.resolved.mcpRuntimes);
    const plugin = owners.profileTransactions === null || owners.loader === null
        ? new UnavailableProvider('plugin')
        : new PluginLifecycleProvider(shared.state, owners.profileTransactions, new LoaderPluginRuntimeProbe(owners.loader));
    const inventory = new HostInventoryService(shared.state, owners, shared.getCatalog, mcp instanceof McpLifecycleProvider ? version => mcp.inspect(version) : null, capabilities === undefined ? undefined : () => capabilities);
    const providers = { plugin, mcp, skill };
    const intentPlans = new IntentPlanService(shared.state, plans, inventory, owners, shared.getCatalog, {
        mcpRuntime: (candidateRef, configuration) => mcp instanceof McpLifecycleProvider
            ? mcp.preflight(candidateRef, configuration)
            : Promise.resolve(null),
        mcpOptions: candidateRef => mcp instanceof McpLifecycleProvider
            ? mcp.options(candidateRef)
            : Promise.resolve([]),
    });
    const runner = new OperationRunner(shared.state, plans, shared.operations, shared.locks, new ArtifactFetcher(shared.resolved.root, {
        maximumRedirects: shared.resolved.maximumArtifactRedirects,
        allowedCrossOriginHosts: shared.resolved.allowedArtifactRedirectHosts,
    }), intentPlans, providers, shared.getCatalog);
    return Object.freeze({ owners, plans, inventory, intentPlans, runner, skill, mcp });
}
function rpcServices(runtime, catalogs, shared, acquisition, capabilities, generation) {
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
    });
}
/**
 * Register the Host using an already loaded owner-Definition set.
 *
 * This internal entrypoint lets the assembled lifecycle regression provide the
 * same Definition identities as its late owner services. Package consumers use
 * {@link apply}, which loads the installed official Definitions.
 */
export async function applyWithHostOwnerDefinitions(ctx, config, definitions) {
    const host = ctx;
    const resolved = resolvedConfig(config);
    const state = new CenterStateStore(resolved.root);
    await state.initialize();
    const catalogs = new CatalogSnapshotManager(resolved.root, {
        trustedOrigin: resolved.catalogTrustedOrigin,
        fetchTimeoutMs: resolved.catalogFetchTimeoutMs,
    });
    await catalogs.initialize();
    const getCatalog = () => catalogs.current().catalog;
    if (resolved.catalogTrustedOrigin !== null) {
        const timer = setInterval(() => { void catalogs.refresh(); }, resolved.catalogRefreshIntervalMs);
        timer.unref();
        ctx.effect(() => () => { clearInterval(timer); }, 'extension-center: catalog refresh');
    }
    const shared = Object.freeze({
        resolved,
        state,
        operations: new FileOperationStore(resolved.root),
        locks: new FileTargetLock(resolved.root),
        getCatalog,
    });
    let activeRpc = null;
    let activeGeneration = null;
    const writableOwners = ctx.inject(WRITABLE_OWNER_SERVICES, (ownerContext) => {
        const owners = probeHostOwners(ownerContext, definitions);
        if (!hostCapabilities(owners).acquisition)
            return;
        let generation;
        generation = new WritableOwnerGeneration(() => {
            if (activeGeneration !== generation)
                return;
            activeGeneration = null;
            activeRpc = null;
        }, error => ownerContext.logger.error(error));
        ownerContext.effect(() => () => generation.retire(), 'extension-center: writable Host owner generation');
        const generationIsCurrent = () => sameOwnerGeneration(owners, probeHostOwners(ownerContext, definitions));
        generation.start(async (signal) => {
            const recoveryExecutable = await installPackagedRecoveryExecutable(resolved.root, resolved.hostHome);
            generation.requireCurrent(generationIsCurrent());
            const runtime = createRuntime(shared, owners, recoveryExecutable);
            const skill = runtime.skill;
            if (skill instanceof SkillLifecycleProvider) {
                generation.addResource(skill.register());
            }
            await runtime.runner.recover(signal);
            generation.requireCurrent(generationIsCurrent());
            const acquisition = new CapabilityAcquisitionService(state, runtime.inventory, runtime.intentPlans, runtime.plans, shared.operations, owners, getCatalog);
            generation.addResource(acquisition.registerVerifier());
            await acquisition.recoverApprovedPlans(signal);
            generation.requireCurrent(generationIsCurrent());
            for (const definition of capabilityToolDefinitions(acquisition)) {
                generation.addResource(owners.tools.register(definition));
            }
            generation.requireCurrent(generationIsCurrent());
            const ready = rpcServices(runtime, catalogs, shared, acquisition, undefined, generation);
            generation.activate(() => {
                activeGeneration = generation;
                activeRpc = ready;
            });
        });
    });
    ctx.effect(() => () => writableOwners.dispose(), 'extension-center: writable owner binding');
    const handler = createHostRpcHandler(() => {
        if (activeRpc !== null)
            return activeRpc;
        const observed = probeHostOwners(host, definitions);
        const ownerCapabilities = hostCapabilities(observed);
        const readCapabilities = ownerCapabilities.acquisition
            ? Object.freeze({ ...ownerCapabilities, acquisition: false, reason: 'host-capability' })
            : ownerCapabilities;
        return rpcServices(createRuntime(shared, observed, null, readCapabilities), catalogs, shared, null, readCapabilities);
    });
    ctx.effect(() => host.connection.rpc.handle(EXTENSION_CENTER_RPC_CHANNEL, handler, { authority: 'loopback' }), 'extension-center: loopback RPC');
}
/** Register read-only Store access immediately and writable acquisition while all six owners are live. */
export async function apply(ctx, config = {}) {
    await applyWithHostOwnerDefinitions(ctx, config, await loadHostOwnerDefinitions());
}
//# sourceMappingURL=host-plugin.js.map
