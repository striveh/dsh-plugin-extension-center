import type { InventoryHostCapabilities, InventoryRow, InventorySnapshot, LifecycleActions } from './types.ts';
/**
 * Derive truthful action availability from ownership, material state, and published Host owners.
 * @param row Inventory row without trusting any precomputed action flags.
 * @param host Published generic Host owner availability.
 * @returns Independent availability for every lifecycle operation.
 */
export declare function lifecycleActions(row: Omit<InventoryRow, 'actions'>, host: InventoryHostCapabilities): LifecycleActions;
/**
 * Build a deterministic normalized inventory snapshot.
 * @param input Observation scope, time, completeness, and owner-derived rows.
 * @param host Published generic Host owner availability used to derive actions.
 * @returns Sorted immutable rows and their canonical inventory revision.
 */
export declare function createInventorySnapshot(input: Readonly<{
    scopeKey: string;
    profileId: string;
    complete: boolean;
    observedAtMs: number;
    rows: readonly Omit<InventoryRow, 'actions'>[];
}>, host: InventoryHostCapabilities): InventorySnapshot;
//# sourceMappingURL=state.d.ts.map
