/** Independent Extension Center Host: verified Store, durable lifecycle, and task acquisition. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXTENSION_CENTER_RPC_CHANNEL } from "./catalog-contract.js";
import { CatalogSnapshotManager, catalogEndpoint } from "./catalog-refresh.js";
import { ArtifactFetcher, CenterStateStore, FileTargetLock, hostCapabilities, loadHostOwnerDefinitions, probeHostOwners, } from "./host/index.js";
import { LoaderPluginRuntimeProbe, McpLifecycleProvider, PluginLifecycleProvider, SkillLifecycleProvider, } from "./providers/index.js";
import { CapabilityAcquisitionService, capabilityToolDefinitions } from "./service/capability-service.js";
import { IntentPlanService } from "./service/intent-plan-service.js";
import { HostInventoryService } from "./service/inventory-service.js";
import { OperationRunner } from "./service/operation-runner.js";
import { createHostRpcHandler } from "./service/rpc-service.js";
import { installPackagedRecoveryExecutable } from "./recovery/install.js";
import { FileOperationStore, FilePlanStore } from "./storage/index.js";
/** Cordis identity for the independent Extension Center Host half. */
export const name = 'extension-center';
/** Connection is the only hard dependency; writable owners are probed at runtime. */
export const inject = ['connection'];
function resolvedConfig(value = {}) {
    const configuredRoot = value.root?.trim();
    const dshHome = process.env.DSH_HOME?.trim();
    const root = resolve(configuredRoot && configuredRoot.length > 0
        ? configuredRoot
        : join(dshHome && dshHome.length > 0 ? dshHome : join(homedir(), '.dsh'), 'extension-center'));
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
/** Register read-only Store access on every Host and acquisition only when all six owners exist. */
export async function apply(ctx, config = {}) {
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
    const operations = new FileOperationStore(resolved.root);
    const locks = new FileTargetLock(resolved.root);
    const owners = probeHostOwners(host, await loadHostOwnerDefinitions());
    const capabilities = hostCapabilities(owners);
    const recoveryExecutable = capabilities.acquisition
        ? await installPackagedRecoveryExecutable(resolved.root)
        : null;
    const plans = new FilePlanStore(resolved.root, recoveryExecutable);
    const skill = owners.skills === null
        ? new UnavailableProvider('skill')
        : new SkillLifecycleProvider(resolved.root, state, owners.skills);
    const mcp = owners.mcpConnections === null
        ? new UnavailableProvider('mcp')
        : new McpLifecycleProvider(state, owners.mcpConnections, resolved.mcpRuntimes);
    const plugin = owners.profileTransactions === null || owners.loader === null
        ? new UnavailableProvider('plugin')
        : new PluginLifecycleProvider(state, owners.profileTransactions, new LoaderPluginRuntimeProbe(owners.loader));
    const inventory = new HostInventoryService(state, owners, getCatalog, mcp instanceof McpLifecycleProvider ? version => mcp.inspect(version) : null);
    const providers = { plugin, mcp, skill };
    const intentPlans = new IntentPlanService(state, plans, inventory, owners, getCatalog, {
        mcpRuntime: (candidateRef, configuration) => mcp instanceof McpLifecycleProvider
            ? mcp.preflight(candidateRef, configuration)
            : Promise.resolve(null),
        mcpOptions: candidateRef => mcp instanceof McpLifecycleProvider
            ? mcp.options(candidateRef)
            : Promise.resolve([]),
    });
    const runner = new OperationRunner(state, plans, operations, locks, new ArtifactFetcher(resolved.root, {
        maximumRedirects: resolved.maximumArtifactRedirects,
        allowedCrossOriginHosts: resolved.allowedArtifactRedirectHosts,
    }), intentPlans, providers, getCatalog);
    if (skill instanceof SkillLifecycleProvider) {
        ctx.effect(() => skill.register(), 'extension-center: Skill provider');
    }
    let acquisition = null;
    if (capabilities.acquisition) {
        await runner.recover(new AbortController().signal);
        const readyAcquisition = new CapabilityAcquisitionService(state, inventory, intentPlans, plans, operations, owners, getCatalog);
        acquisition = readyAcquisition;
        ctx.effect(() => readyAcquisition.registerVerifier(), 'extension-center: task continuation verifier');
        await readyAcquisition.recoverApprovedPlans();
        for (const definition of capabilityToolDefinitions(readyAcquisition)) {
            ctx.effect(() => owners.tools.register(definition), 'extension-center: acquisition tool');
        }
    }
    const handler = createHostRpcHandler({
        owners,
        catalog: getCatalog,
        catalogStatus: () => catalogs.current().status,
        refreshCatalog: () => catalogs.refresh(),
        inventory,
        intentPlans,
        plans,
        operations: runner,
        acquisition,
    });
    ctx.effect(() => host.connection.rpc.handle(EXTENSION_CENTER_RPC_CHANNEL, handler, { authority: 'loopback' }), 'extension-center: loopback RPC');
}
export { catalogListResponse, verifyBootstrapCatalog } from "./catalog.js";
export { CatalogSnapshotManager, catalogEndpoint, verifyCatalogAdvance } from "./catalog-refresh.js";
export * from "./service/rpc-contract.js";
//# sourceMappingURL=index.js.map
