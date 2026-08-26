import type { Context } from '@deepseek-ai/cordis';
/** Required browser services. */
export declare const inject: string[];
/** Register bilingual copy, effect-owned styles, and the two additive shell entries. */
export declare function apply(ctx: Context): void;
export { ExtensionCenterOverlay, ExtensionCenterTrigger } from './ExtensionCenter.tsx';
export { createExtensionCatalogClient, parseCatalogListResponse } from './catalog-api.ts';
export { createExtensionManagementClient, parseConfigurationDraft, parseIntentPreviewResponse, parseInventoryListResponse, parseOperationListResponse, parseOperationReceiptsResponse, } from './management-api.ts';
export { createExtensionCenterStore } from './store.ts';
//# sourceMappingURL=index.d.ts.map
