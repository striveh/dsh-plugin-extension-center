function functions(value, methods) {
    if (typeof value !== 'object' || value === null)
        return false;
    const record = value;
    return methods.every(method => typeof record[method] === 'function');
}
function service(lookup, name) {
    try {
        return lookup.get(name);
    }
    catch {
        return undefined;
    }
}
function protocolOwner(value, methods) {
    return functions(value, methods) && value.protocolVersion === 1;
}
/** Bind Center-owned lifecycles to the exact official rc.2 registries they use. */
export function bindHostOwners(lookup, internal) {
    const skills = service(lookup, 'skills');
    const tools = service(lookup, 'tools');
    const loader = service(lookup, 'loader');
    if (!functions(internal.managedPlugins, ['snapshot']))
        throw new Error('Center managed Plugin owner is invalid');
    if (!protocolOwner(internal.mcpConnections, [
        'snapshot', 'get', 'getRemoved', 'registeredToolNames', 'configure', 'enable', 'disable', 'update', 'remove', 'restore', 'purge',
    ])) {
        throw new Error('Center MCP owner is invalid');
    }
    if (!protocolOwner(internal.taskContinuations, [
        'create', 'reserve', 'get', 'list', 'cancel', 'supersede', 'reconcile', 'registerVerifier',
    ])) {
        throw new Error('Center continuation owner is invalid');
    }
    return Object.freeze({
        managedPlugins: internal.managedPlugins,
        mcpConnections: internal.mcpConnections,
        taskContinuations: internal.taskContinuations,
        skills: functions(skills, ['registerProvider', 'snapshot', 'list', 'get']) ? skills : null,
        tools: functions(tools, ['register']) ? tools : null,
        loader: functions(loader, ['create', 'update', 'remove', 'await', 'entries']) ? loader : null,
    });
}
/** Project truthful lifecycle capability without depending on non-official Host services. */
export function hostCapabilities(owners) {
    const managedPluginLifecycle = owners.managedPlugins !== null;
    const dynamicMcpConnection = owners.mcpConnections !== null;
    const durableContinuation = owners.taskContinuations !== null;
    const skillRegistry = owners.skills !== null;
    const toolRegistry = owners.tools !== null;
    const loaderMutation = owners.loader !== null;
    const acquisition = managedPluginLifecycle
        && dynamicMcpConnection
        && durableContinuation
        && skillRegistry
        && toolRegistry
        && loaderMutation;
    return Object.freeze({
        managedPluginLifecycle,
        dynamicMcpConnection,
        durableContinuation,
        skillRegistry,
        toolRegistry,
        loaderMutation,
        acquisition,
        reason: acquisition ? null : 'host-capability',
    });
}
//# sourceMappingURL=owners.js.map
