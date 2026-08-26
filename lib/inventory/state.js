import { readBoundedString, readNonNegativeInteger } from "../domain/codec.js";
import { failDomain } from "../domain/errors.js";
import { canonicalSha256, immutableJsonClone } from "../domain/index.js";
const OPERATIONS = [
    'install',
    'configure',
    'update',
    'enable',
    'disable',
    'uninstall',
    'restore',
    'purge',
];
function unavailable(reason) {
    return Object.freeze({ status: 'unavailable', reason });
}
function external(reason) {
    return Object.freeze({ status: 'external', reason });
}
function available() {
    return Object.freeze({ status: 'available' });
}
/**
 * Derive truthful action availability from ownership, material state, and published Host owners.
 * @param row Inventory row without trusting any precomputed action flags.
 * @param host Published generic Host owner availability.
 * @returns Independent availability for every lifecycle operation.
 */
export function lifecycleActions(row, host) {
    if (row.ownership !== 'center') {
        return immutableJsonClone(Object.fromEntries(OPERATIONS.map(operation => [
            operation,
            external(`${row.ownership}-owned`),
        ])));
    }
    if (row.kind === 'skill' && row.scopeKey === 'project') {
        return immutableJsonClone(Object.fromEntries(OPERATIONS.map(operation => [
            operation,
            unavailable('workspace-agent-selector-unavailable'),
        ])));
    }
    if (!host.acquisition) {
        return immutableJsonClone(Object.fromEntries(OPERATIONS.map(operation => [
            operation,
            unavailable('host-capability'),
        ])));
    }
    const ownerAvailable = row.kind === 'plugin'
        ? host.profileTransaction
        : row.kind === 'mcp'
            ? host.profileTransaction && host.dynamicMcpConnection
            : true;
    if (!ownerAvailable) {
        return immutableJsonClone(Object.fromEntries(OPERATIONS.map(operation => [
            operation,
            unavailable('host-capability'),
        ])));
    }
    const installed = row.materialized !== 'absent';
    const enabled = row.desired === 'enabled';
    const actions = {
        install: installed ? unavailable('already-materialized') : available(),
        configure: installed ? available() : unavailable('not-installed'),
        update: installed && row.updateObservation.status === 'available'
            ? available()
            : unavailable(installed ? 'no-exact-update' : 'not-installed'),
        enable: installed && !enabled ? available() : unavailable(installed ? 'already-enabled' : 'not-installed'),
        disable: installed && enabled ? available() : unavailable(installed ? 'already-disabled' : 'not-installed'),
        uninstall: installed ? available() : unavailable('not-installed'),
        restore: row.rollback === 'available' || row.rollback === 'used'
            ? available()
            : unavailable('no-recovery-point'),
        purge: row.materialized === 'absent' && row.rollback === 'available'
            ? available()
            : unavailable('no-center-owned-retained-data'),
    };
    if (row.kind === 'plugin') {
        actions.enable = unavailable('plugin-enable-disable-unsupported');
        actions.disable = unavailable('plugin-enable-disable-unsupported');
        actions.purge = unavailable('profile-retained-generations-not-purgeable');
    }
    return immutableJsonClone(actions);
}
function assertEvidenceKind(row) {
    const evidence = row.evidence;
    if (evidence.kind !== row.kind) {
        failDomain('invalid-data', `inventory evidence kind does not match ${row.extensionId}`);
    }
    switch (evidence.kind) {
        case 'skill':
            if (row.effective === 'active' && (!evidence.catalogComplete || !evidence.definitionLoaded)) {
                failDomain('invalid-data', `active skill ${row.extensionId} lacks complete registry evidence`);
            }
            if (row.agentVisibility === 'visible' && (!evidence.catalogComplete || !evidence.definitionLoaded)) {
                failDomain('invalid-data', `visible ${row.extensionId} lacks owner evidence`);
            }
            break;
        case 'mcp':
            if (row.effective === 'active'
                && (!evidence.descriptorMatches || (row.ownership === 'center' && evidence.descriptorDigest === null)
                    || evidence.observedLifecycle !== 'ready' || evidence.toolGeneration === null)) {
                failDomain('invalid-data', `active MCP ${row.extensionId} lacks ready tool-generation evidence`);
            }
            if (row.agentVisibility === 'visible'
                && (!evidence.descriptorMatches || (row.ownership === 'center' && evidence.descriptorDigest === null)
                    || evidence.observedLifecycle !== 'ready' || evidence.qualifiedTools.length === 0)) {
                failDomain('invalid-data', `visible ${row.extensionId} lacks owner evidence`);
            }
            break;
        case 'plugin':
            if (row.effective === 'active' && (!evidence.externalRestartObserved || !evidence.consumerObserved)) {
                failDomain('invalid-data', `active Plugin ${row.extensionId} lacks restart and consumer evidence`);
            }
            if (row.agentVisibility === 'visible' && !evidence.consumerObserved) {
                failDomain('invalid-data', `visible ${row.extensionId} lacks owner evidence`);
            }
            break;
    }
}
/**
 * Build a deterministic normalized inventory snapshot.
 * @param input Observation scope, time, completeness, and owner-derived rows.
 * @param host Published generic Host owner availability used to derive actions.
 * @returns Sorted immutable rows and their canonical inventory revision.
 */
export function createInventorySnapshot(input, host) {
    const scopeKey = readBoundedString(input.scopeKey, 'inventory.scopeKey');
    const profileId = readBoundedString(input.profileId, 'inventory.profileId');
    const observedAtMs = readNonNegativeInteger(input.observedAtMs, 'inventory.observedAtMs');
    if (typeof input.complete !== 'boolean' || !Array.isArray(input.rows)) {
        failDomain('invalid-data', 'inventory completeness or rows are invalid');
    }
    const rows = input.rows.map((source) => {
        const row = immutableJsonClone({
            ...source,
            actions: lifecycleActions(source, host),
        });
        if (row.schemaVersion !== 1 || row.scopeKey !== scopeKey || row.profileId !== profileId) {
            failDomain('invalid-data', `inventory row ${row.extensionId} scope or schema does not match snapshot`);
        }
        if (!Number.isSafeInteger(row.observedAtMs) || row.observedAtMs < 0 || row.observedAtMs > observedAtMs) {
            failDomain('invalid-data', `inventory row ${row.extensionId} observation time is invalid`);
        }
        assertEvidenceKind(row);
        return row;
    }).sort((left, right) => left.kind.localeCompare(right.kind)
        || left.extensionId.localeCompare(right.extensionId)
        || left.targetKey.localeCompare(right.targetKey));
    const identities = new Set();
    for (const row of rows) {
        const identity = `${row.kind}\u0000${row.targetKey}`;
        if (identities.has(identity))
            failDomain('invalid-data', `duplicate inventory target ${row.targetKey}`);
        identities.add(identity);
    }
    const body = {
        schemaVersion: 1,
        scopeKey,
        profileId,
        complete: input.complete,
        observedAtMs,
        rows,
    };
    return immutableJsonClone({ ...body, revision: canonicalSha256(body) });
}
//# sourceMappingURL=state.js.map
