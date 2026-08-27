import { canonicalSha256 } from "../domain/index.js";
import { POLICY_REVISION } from "../policy/index.js";
/** Return whether an operation uses current center inventory as its mutation authority. */
export function isCenterManagementOperation(operationKind) {
    return ['enable', 'disable', 'purge'].includes(operationKind);
}
/**
 * Bind one admitted management action to its durable target and revision fences.
 * @param input Exact target, operation, target-owner, and inventory revisions observed at admission.
 * @returns Canonical management authority digest retained by the plan and authorization.
 */
export function centerManagementAuthorityDigest(input) {
    return canonicalSha256({
        operationKind: input.operationKind,
        targetKey: input.targetKey,
        managedRevision: input.managedRevision,
        ownerRevision: input.ownerRevision,
        inventoryRevision: input.inventoryRevision,
        action: { status: 'available' },
    });
}
function denied(reason) {
    return Object.freeze({ status: 'denied', policyRevision: POLICY_REVISION, code: 'action-unavailable', reason });
}
/** Refuse installation over any currently observed target not exclusively owned by this center. */
export function admitInstallTarget(row, managed) {
    if (row === undefined)
        return managed === undefined ? null : denied('install-target-stale');
    if (row.ownership !== 'center')
        return denied(`install-target-${row.ownership}-owned`);
    if (managed === undefined || `center:${String(managed.revision)}` !== row.managedRevision) {
        return denied('install-target-stale');
    }
    if (managed.current !== null || row.materialized !== 'absent')
        return denied('install-target-already-materialized');
    return denied('install-target-retained-use-restore-or-purge');
}
/**
 * Admit enable, disable, or purge only from one exact center-owned current inventory row.
 * Catalog cards cannot supply a target identity and external ownership never becomes writable.
 */
export function admitCenterManagement(input) {
    if (!isCenterManagementOperation(input.operationKind)) {
        return Object.freeze({ status: 'denied', policy: denied('management-operation-kind') });
    }
    if (input.targetKey === null)
        return Object.freeze({ status: 'denied', policy: denied('management-target-required') });
    if (input.inventory.scopeKey !== input.scopeKey || input.inventory.profileId !== input.profileId || !input.inventory.complete) {
        return Object.freeze({ status: 'denied', policy: denied('management-inventory-incomplete') });
    }
    const row = input.inventory.rows.find(item => item.targetKey === input.targetKey);
    if (row === undefined)
        return Object.freeze({ status: 'denied', policy: denied('management-target-absent') });
    if (row.ownership !== 'center') {
        return Object.freeze({ status: 'denied', policy: denied(`management-owner-${row.ownership}`) });
    }
    if (row.scopeKey !== input.scopeKey || row.profileId !== input.profileId) {
        return Object.freeze({ status: 'denied', policy: denied('management-scope-mismatch') });
    }
    const candidate = input.candidate;
    if (candidate === undefined || row.candidateRef !== candidate.candidateRef || row.kind !== candidate.kind) {
        return Object.freeze({ status: 'denied', policy: denied('management-kind-or-candidate-mismatch') });
    }
    const managed = input.managed;
    if (managed === undefined
        || managed.targetKey !== row.targetKey
        || managed.kind !== row.kind
        || managed.scopeKey !== row.scopeKey
        || managed.profileId !== row.profileId
        || `center:${String(managed.revision)}` !== row.managedRevision) {
        return Object.freeze({ status: 'denied', policy: denied('management-target-stale') });
    }
    const action = row.actions[input.operationKind];
    if (action.status !== 'available') {
        return Object.freeze({ status: 'denied', policy: denied(`management-action-${action.status}:${action.reason ?? 'unavailable'}`) });
    }
    const policy = Object.freeze({
        status: 'eligible',
        policyRevision: POLICY_REVISION,
        authorityDigest: centerManagementAuthorityDigest({
            operationKind: input.operationKind,
            targetKey: row.targetKey,
            managedRevision: row.managedRevision,
            ownerRevision: row.ownerRevision,
            inventoryRevision: input.inventory.revision,
        }),
    });
    return Object.freeze({ status: 'eligible', row, record: managed, policy });
}
//# sourceMappingURL=management-admission.js.map
