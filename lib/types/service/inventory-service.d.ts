import type { VerifiedCatalog } from '../catalog.ts';
import type { HostOwners, ManagedVersion } from '../host/index.ts';
import { CenterStateStore } from '../host/index.ts';
import { type InventorySnapshot } from '../inventory/index.ts';
import type { HostCapabilityProjection } from './rpc-contract.ts';
import type { ManagedPluginSnapshotPort } from './review-evidence.ts';
import type { McpManagedOwnerEvidence } from '../providers/mcp-provider.ts';
/** Normalize center-owned durable state against the actual Skill, MCP, and Loader consumers. */
export declare class HostInventoryService {
    private readonly store;
    private readonly owners;
    private readonly catalog;
    private readonly managedPlugins;
    private readonly inspectManagedMcp;
    private readonly capabilities;
    constructor(store: CenterStateStore, owners: HostOwners, catalog: () => VerifiedCatalog, managedPlugins: ManagedPluginSnapshotPort, inspectManagedMcp?: ((version: ManagedVersion) => Promise<McpManagedOwnerEvidence>) | null, capabilities?: () => HostCapabilityProjection);
    /** Observe one exact scope/profile without mutating desired state. */
    list(scopeKey: string, profileId: string, projectRoot?: string | null): Promise<InventorySnapshot>;
    /** Re-read every authoritative owner and require one exact target in the resulting projection. */
    verify(scopeKey: string, profileId: string, targetKey: string, projectRoot?: string | null): Promise<InventorySnapshot>;
    private externalRows;
    private centerRow;
    private skillEvidence;
    private mcpEvidence;
    private pluginEvidence;
}
//# sourceMappingURL=inventory-service.d.ts.map
