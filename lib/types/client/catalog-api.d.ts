import type { ClientConnectionRpc, RpcError } from '@deepseek-ai/dsh-client-connection/client';
import { type CatalogListResponse } from '../catalog-contract.ts';
/** Error returned through a valid Connection RPC business-failure envelope. */
export declare class ExtensionCenterRpcError extends Error {
    readonly code: RpcError['code'];
    /** @param error - Connection RPC error already validated by the carrier. */
    constructor(error: RpcError);
}
/** Browser client for the verified Store catalog projection. */
export interface ExtensionCatalogClient {
    /** Read the current verified snapshot projection. */
    list(signal?: AbortSignal): Promise<CatalogListResponse>;
    /** Explicitly ask the authenticated Host to refresh its fixed signed catalog endpoint. */
    refresh?(signal?: AbortSignal): Promise<CatalogListResponse>;
}
/** Deeply validate a Host catalog response before rendering any field. */
export declare function parseCatalogListResponse(value: unknown): CatalogListResponse;
/** Create a stateless Store catalog client over the generic Connection carrier. */
export declare function createExtensionCatalogClient(rpc: ClientConnectionRpc): ExtensionCatalogClient;
//# sourceMappingURL=catalog-api.d.ts.map
