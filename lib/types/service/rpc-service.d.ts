import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import type { VerifiedCatalog } from '../catalog.ts';
import type { AdmittedCatalogSnapshot, CatalogAdmissionStatus } from '../catalog-refresh.ts';
import { type HostOwners } from '../host/index.ts';
import { FilePlanStore } from '../storage/index.ts';
import type { IntentPlanService } from './intent-plan-service.ts';
import type { CapabilityAcquisitionService } from './capability-service.ts';
import type { HostInventoryService } from './inventory-service.ts';
import type { OperationRunner } from './operation-runner.ts';
/** Create the strict loopback-only management handler; carrier authority is not accepted from payloads. */
export declare function createHostRpcHandler(input: Readonly<{
    owners: HostOwners;
    catalog: () => VerifiedCatalog;
    catalogStatus?: () => CatalogAdmissionStatus;
    refreshCatalog?: () => Promise<AdmittedCatalogSnapshot>;
    inventory: HostInventoryService;
    intentPlans: IntentPlanService;
    plans: FilePlanStore;
    operations: OperationRunner;
    acquisition: CapabilityAcquisitionService | null;
}>): ConnectionRpcHandler;
//# sourceMappingURL=rpc-service.d.ts.map
