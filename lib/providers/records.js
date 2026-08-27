import { canonicalSha256, immutableJsonClone } from "../domain/index.js";
/** Digest only the restorable target state, excluding audit revisions and timestamps. */
export function managedStateDigest(record) {
    if (record === null)
        return canonicalSha256(null);
    return canonicalSha256({
        kind: record.kind,
        extensionId: record.extensionId,
        targetKey: record.targetKey,
        scopeKey: record.scopeKey,
        profileId: record.profileId,
        current: record.current,
        lastGood: record.lastGood,
        removed: record.removed,
        pending: record.pending,
    });
}
/** Derive the next center-owned record for one already-preflighted operation. */
export function nextManagedRecord(before, request, suppliedVersion, nowMs) {
    const { plan, authorization } = request;
    const operation = plan.operationKind;
    if (before !== null && (before.kind !== plan.extensionKind
        || before.extensionId !== plan.extensionId
        || before.scopeKey !== plan.scopeKey
        || before.profileId !== plan.profileId))
        throw new Error('managed target identity does not match the immutable plan');
    let current = before?.current ?? null;
    let lastGood = before?.lastGood ?? null;
    let removed = before?.removed ?? null;
    const assertRestoreTarget = (version) => {
        if (version.candidateRef !== plan.candidateRef
            || version.artifactRevision !== plan.artifactRevision
            || version.artifactIntegrity !== plan.artifactIntegrity) {
            throw new Error('restore plan does not bind the exact retained artifact');
        }
        if (canonicalSha256(version.configuration) !== canonicalSha256(request.payload.configuration)) {
            throw new Error('restore payload does not bind the exact retained configuration');
        }
    };
    switch (operation) {
        case 'install':
            if (current !== null || suppliedVersion === null)
                throw new Error('install requires an absent target and staged material');
            current = suppliedVersion;
            removed = null;
            break;
        case 'configure':
            if (current === null)
                throw new Error('configure requires installed material');
            lastGood = current;
            current = immutableJsonClone({ ...current, configuration: request.payload.configuration });
            break;
        case 'update':
            if (current === null || suppliedVersion === null)
                throw new Error('update requires current and staged material');
            lastGood = current;
            current = suppliedVersion;
            break;
        case 'enable':
        case 'disable':
            if (current === null)
                throw new Error(`${operation} requires installed material`);
            lastGood = current;
            current = immutableJsonClone({ ...current, enabled: operation === 'enable' });
            break;
        case 'uninstall':
            if (current === null)
                throw new Error('uninstall requires installed material');
            removed = current;
            current = null;
            break;
        case 'restore':
            if (current === null) {
                if (removed === null)
                    throw new Error('restore has no removed material');
                assertRestoreTarget(removed);
                current = removed;
                removed = null;
            }
            else {
                if (lastGood === null)
                    throw new Error('restore has no last-good material');
                assertRestoreTarget(lastGood);
                const replacement = lastGood;
                lastGood = current;
                current = replacement;
            }
            break;
        case 'purge':
            if (current !== null || (removed === null && lastGood === null))
                throw new Error('purge requires retained removed material');
            removed = null;
            lastGood = null;
            break;
    }
    return immutableJsonClone({
        schemaVersion: 1,
        kind: plan.extensionKind,
        extensionId: plan.extensionId,
        targetKey: plan.targetKey,
        scopeKey: plan.scopeKey,
        profileId: plan.profileId,
        revision: (before?.revision ?? 0) + 1,
        lastOperationId: authorization.operationId,
        current,
        lastGood,
        removed,
        pending: null,
        updatedAtMs: nowMs,
    });
}
//# sourceMappingURL=records.js.map
