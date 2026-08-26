import type { CatalogEntry } from '../catalog-contract.ts';
import type { ManagedTargetRecord } from '../host/index.ts';
import type { InventoryRow, InventorySnapshot } from '../inventory/index.ts';
import { type CandidatePolicyResult } from '../policy/index.ts';
import type { OperationKind } from '../plans/index.ts';
/** Management actions whose authority comes only from current center inventory. */
export type CenterManagementOperation = 'enable' | 'disable' | 'purge';
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
