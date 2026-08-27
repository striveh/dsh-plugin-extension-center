import type { CatalogEntry } from '../catalog-contract.ts';
import { type Sha256Digest } from '../domain/index.ts';
import type { ManagedTargetRecord } from '../host/index.ts';
import type { InventoryRow, InventorySnapshot } from '../inventory/index.ts';
import { type CandidatePolicyResult } from '../policy/index.ts';
import type { OperationKind } from '../plans/index.ts';
/** Management actions whose authority comes only from current center inventory. */
export type CenterManagementOperation = 'enable' | 'disable' | 'purge';
/** Return whether an operation uses current center inventory as its mutation authority. */
export declare function isCenterManagementOperation(operationKind: OperationKind): operationKind is CenterManagementOperation;
/**
 * Bind one admitted management action to its durable target and revision fences.
 * @param input Exact target, operation, target-owner, and inventory revisions observed at admission.
 * @returns Canonical management authority digest retained by the plan and authorization.
 */
export declare function centerManagementAuthorityDigest(input: Readonly<{
    operationKind: CenterManagementOperation;
    targetKey: string;
    managedRevision: string;
    ownerRevision: string;
    inventoryRevision: Sha256Digest;
}>): Sha256Digest;
/** Result of exact current-row management admission. */
export type ManagementAdmission = Readonly<{
    status: 'eligible';
    row: InventoryRow;
    record: ManagedTargetRecord;
    policy: Extract<CandidatePolicyResult, {
        status: 'eligible';
    }>;
}> | Readonly<{
    status: 'denied';
    policy: Extract<CandidatePolicyResult, {
        status: 'denied';
    }>;
}>;
/** Refuse installation over any currently observed target not exclusively owned by this center. */
export declare function admitInstallTarget(row: InventoryRow | undefined, managed: ManagedTargetRecord | undefined): Extract<CandidatePolicyResult, {
    status: 'denied';
}> | null;
/**
 * Admit enable, disable, or purge only from one exact center-owned current inventory row.
 * Catalog cards cannot supply a target identity and external ownership never becomes writable.
 */
export declare function admitCenterManagement(input: Readonly<{
    operationKind: OperationKind;
    targetKey: string | null;
    scopeKey: string;
    profileId: string;
    candidate: CatalogEntry | undefined;
    inventory: InventorySnapshot;
    managed: ManagedTargetRecord | undefined;
}>): ManagementAdmission;
//# sourceMappingURL=management-admission.d.ts.map
