import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import type { VerifiedCatalog } from '../catalog.ts';
import type { AdmittedCatalogSnapshot, CatalogAdmissionStatus } from '../catalog-refresh.ts';
import { type HostOwners } from '../host/index.ts';
import { FilePlanStore } from '../storage/index.ts';
import type { IntentPlanService } from './intent-plan-service.ts';
import type { CapabilityAcquisitionService } from './capability-service.ts';
import type { HostInventoryService } from './inventory-service.ts';
import type { OperationRunner } from './operation-runner.ts';
import { type HostCapabilityProjection } from './rpc-contract.ts';
/** Services used by one coherent Host RPC runtime generation. */
export interface HostRpcServices {
    readonly owners: HostOwners;
    readonly capabilities?: HostCapabilityProjection;
    readonly generation?: HostRpcGeneration;
    readonly catalog: () => VerifiedCatalog;
    readonly catalogStatus?: () => CatalogAdmissionStatus;
    readonly refreshCatalog?: () => Promise<AdmittedCatalogSnapshot>;
    readonly inventory: HostInventoryService;
    readonly intentPlans: IntentPlanService;
    readonly plans: FilePlanStore;
    readonly operations: OperationRunner;
    readonly acquisition: CapabilityAcquisitionService | null;
}
/** Generation owner that cancels and drains requests before its Host owners retire. */
export interface HostRpcGeneration {
    /** Run one request while this exact owner generation remains writable. */
    run<T>(signal: AbortSignal, request: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
/** Resolve either one fixed runtime or the currently active dynamic runtime. */
export type HostRpcServicesSource = HostRpcServices | (() => HostRpcServices);
/**
 * Create the strict authenticated management handler. Connection applies request trust and
 * browser-session authentication before dispatch; payloads cannot claim carrier authority.
 */
export declare function createHostRpcHandler(source: HostRpcServicesSource): ConnectionRpcHandler;
//# sourceMappingURL=rpc-service.d.ts.map
