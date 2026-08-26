import { readBoundedString, readStrictRecord } from "../domain/codec.js";
import { failDomain } from "../domain/errors.js";
import { immutableJsonClone } from "../domain/json.js";
function decodeLockState(value) {
    const record = readStrictRecord(value, ['leases'], 'targetLocks');
    if (!Array.isArray(record.leases))
        failDomain('invalid-data', 'targetLocks.leases must be an array');
    const leases = record.leases.map((lease, index) => {
        const item = readStrictRecord(lease, ['targetKey', 'operationId'], `targetLocks.leases[${index}]`);
        return {
            targetKey: readBoundedString(item.targetKey, `targetLocks.leases[${index}].targetKey`),
            operationId: readBoundedString(item.operationId, `targetLocks.leases[${index}].operationId`),
        };
    });
    const targets = new Set();
    const operations = new Set();
    for (const lease of leases) {
        if (targets.has(lease.targetKey) || operations.has(lease.operationId)) {
            failDomain('invalid-data', 'targetLocks contains duplicate target or operation ownership');
        }
        targets.add(lease.targetKey);
        operations.add(lease.operationId);
    }
    return immutableJsonClone({
        leases: leases.sort((left, right) => left.targetKey < right.targetKey ? -1 : left.targetKey > right.targetKey ? 1 : 0),
    });
}
/** Create an empty immutable per-target serialization state. */
export function createTargetLockState() {
    return Object.freeze({ leases: Object.freeze([]) });
}
/**
 * Acquire one target for an operation without mutating the prior lock state.
 *
 * @param value Current target lock state.
 * @param targetKeyValue Exact target identity.
 * @param operationIdValue Exact operation identity.
 * @returns New immutable lock state.
 */
export function acquireTarget(value, targetKeyValue, operationIdValue) {
    const state = decodeLockState(value);
    const targetKey = readBoundedString(targetKeyValue, 'targetKey');
    const operationId = readBoundedString(operationIdValue, 'operationId');
    const targetLease = state.leases.find(lease => lease.targetKey === targetKey);
    if (targetLease !== undefined) {
        if (targetLease.operationId === operationId)
            return state;
        failDomain('target-busy', `target ${targetKey} is already held`);
    }
    const operationLease = state.leases.find(lease => lease.operationId === operationId);
    if (operationLease !== undefined) {
        failDomain('target-lock-mismatch', `operation ${operationId} already holds another target`);
    }
    return decodeLockState({ leases: [...state.leases, { targetKey, operationId }] });
}
/**
 * Release one target only for the operation that owns it.
 *
 * @param value Current target lock state.
 * @param targetKeyValue Exact target identity.
 * @param operationIdValue Exact operation identity.
 * @returns New immutable lock state.
 */
export function releaseTarget(value, targetKeyValue, operationIdValue) {
    const state = decodeLockState(value);
    const targetKey = readBoundedString(targetKeyValue, 'targetKey');
    const operationId = readBoundedString(operationIdValue, 'operationId');
    const lease = state.leases.find(item => item.targetKey === targetKey);
    if (lease === undefined || lease.operationId !== operationId) {
        failDomain('target-lock-mismatch', `operation ${operationId} does not own target ${targetKey}`);
    }
    return decodeLockState({ leases: state.leases.filter(item => item !== lease) });
}
//# sourceMappingURL=locks.js.map
