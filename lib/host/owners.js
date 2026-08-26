var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
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
async function serviceIdentity(moduleName, exportName) {
    try {
        const exports = await import(__rewriteRelativeImportExtension(moduleName));
        const value = exports[exportName];
        return typeof value === 'function' ? value : null;
    }
    catch {
        // A missing or unloadable optional owner package makes only writable acquisition unavailable.
        return null;
    }
}
/** Load the exact optional peer Definitions without making the rc.2 read-only lane fail to boot. */
export async function loadHostOwnerDefinitions() {
    const [profileTransactions, mcpConnections, taskContinuations] = await Promise.all([
        serviceIdentity('@deepseek-ai/dsh-profile-transactions', 'ProfileTransactions'),
        serviceIdentity('@deepseek-ai/dsh-mcp-connections', 'McpConnections'),
        serviceIdentity('@deepseek-ai/dsh-task-continuation', 'TaskContinuationService'),
    ]);
    return Object.freeze({ profileTransactions, mcpConnections, taskContinuations });
}
function exactOwner(value, identity, methods) {
    if (identity === null || !identity[Symbol.hasInstance](value) || !functions(value, methods))
        return false;
    return value.protocolVersion === 1;
}
/** Probe exact live services without declaring hard Cordis injection requirements. */
export function probeHostOwners(lookup, definitions) {
    const profile = service(lookup, 'profileTransactions');
    const mcp = service(lookup, 'mcpConnections');
    const continuations = service(lookup, 'taskContinuations');
    const skills = service(lookup, 'skills');
    const tools = service(lookup, 'tools');
    const loader = service(lookup, 'loader');
    return Object.freeze({
        profileTransactions: exactOwner(profile, definitions.profileTransactions, ['snapshot', 'stage', 'commit', 'abort', 'restoreLastGood', 'getRestoreReceipt', 'acknowledgeBoot', 'list'])
            ? profile
            : null,
        mcpConnections: exactOwner(mcp, definitions.mcpConnections, ['snapshot', 'get', 'getRemoved', 'configure', 'enable', 'disable', 'update', 'remove', 'restore', 'purge'])
            ? mcp
            : null,
        taskContinuations: exactOwner(continuations, definitions.taskContinuations, ['create', 'reserve', 'get', 'list', 'cancel', 'supersede', 'registerVerifier'])
            ? continuations
            : null,
        skills: functions(skills, ['registerProvider', 'snapshot', 'list', 'get']) ? skills : null,
        tools: functions(tools, ['register']) ? tools : null,
        loader: functions(loader, ['await', 'entries']) ? loader : null,
    });
}
/** Project truthful management capability without collapsing individual owner evidence. */
export function hostCapabilities(owners) {
    const profileTransaction = owners.profileTransactions !== null;
    const dynamicMcpConnection = owners.mcpConnections !== null;
    const durableContinuation = owners.taskContinuations !== null;
    const skillRegistry = owners.skills !== null;
    const toolRegistry = owners.tools !== null;
    const loaderObservation = owners.loader !== null;
    const acquisition = profileTransaction
        && dynamicMcpConnection
        && durableContinuation
        && skillRegistry
        && toolRegistry
        && loaderObservation;
    return Object.freeze({
        profileTransaction,
        dynamicMcpConnection,
        durableContinuation,
        skillRegistry,
        toolRegistry,
        loaderObservation,
        acquisition,
        reason: acquisition ? null : 'host-capability',
    });
}
//# sourceMappingURL=owners.js.map
