import { catalogReviewEvidenceSupport } from "../catalog.js";
import { canonicalSha256 } from "../domain/index.js";
const REQUIRED_PERMISSION_ROWS = {
    plugin: [
        'acquisition/network', 'acquisition/filesystem', 'acquisition/subprocess', 'acquisition/credentials',
        'runtime/network', 'runtime/filesystem', 'runtime/subprocess', 'runtime/credentials', 'runtime/model-context',
    ],
    mcp: ['acquisition/network', 'runtime/filesystem', 'runtime/subprocess', 'runtime/credentials'],
    skill: ['acquisition/network', 'runtime/model-context', 'runtime/subprocess'],
};
const ACTIVE_VERIFICATION_STEPS = {
    plugin: ['center-plugin-material', 'managed-owner-revision', 'loader-consumer'],
    mcp: ['runtime-binding', 'desired-observed-state', 'mcp-handshake', 'qualified-tool-generation'],
    skill: ['artifact-rehash', 'complete-scope-snapshot', 'winning-provider', 'winning-path-and-invocation'],
};
const PLUGIN_RESTART_OPERATIONS = ['install', 'update', 'restore', 'uninstall'];
function isPluginRestartOperation(operationKind) {
    return PLUGIN_RESTART_OPERATIONS.includes(operationKind);
}
/** Platform key used by both Store and task admission. */
export function currentHostPlatform() {
    if (process.platform === 'darwin' || process.platform === 'linux')
        return process.platform;
    if (process.platform === 'win32')
        return 'windows';
    return 'unsupported';
}
/** Derive catalog facts instead of accepting optimistic booleans from either product entrance. */
export function candidateAdmissionFacts(entry, operationKind) {
    const permissionRows = entry.permissions.map(permission => `${permission.phase}/${permission.kind}`);
    const uniqueRows = new Set(permissionRows);
    const authorityKnown = uniqueRows.size === permissionRows.length
        && REQUIRED_PERMISSION_ROWS[entry.kind].every(row => uniqueRows.has(row));
    const downloadsPluginPackage = entry.kind === 'plugin' && ['install', 'update'].includes(operationKind);
    return Object.freeze({
        completeLifecycle: Object.values(entry.lifecycle).every(action => action.status === 'available'),
        authorityKnown,
        lifecycleScriptControl: downloadsPluginPackage ? 'inspect-before-mutation' : 'not-applicable',
        reviewEvidenceAvailable: catalogReviewEvidenceSupport(entry) !== 'unavailable',
        verificationRecipeComplete: ACTIVE_VERIFICATION_STEPS[entry.kind].length > 0,
    });
}
/** Derive whether this exact operation needs a later Host boot before verification can finish. */
export function operationRestartRequired(entry, operationKind) {
    return entry.kind === 'plugin' && entry.restart.required && isPluginRestartOperation(operationKind);
}
/** Digest of the owner-specific observation recipe enforced by the selected provider implementation. */
export function verificationRecipeDigest(kind, operationKind, desiredState) {
    const baseSteps = desiredState === 'removed'
        ? [`${kind}-owner-absence`, 'center-inventory-absence']
        : ACTIVE_VERIFICATION_STEPS[kind];
    const steps = kind === 'plugin' && isPluginRestartOperation(operationKind)
        ? [...baseSteps, 'host-restart-observation']
        : baseSteps;
    return canonicalSha256({ recipeRevision: 2, kind, operationKind, desiredState, steps });
}
//# sourceMappingURL=facts.js.map
