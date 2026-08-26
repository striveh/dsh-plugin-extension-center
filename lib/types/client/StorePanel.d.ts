import type { ExtensionCatalogClient } from './catalog-api.ts';
import type { ExtensionCenterKey } from './locales.ts';
import type { ExtensionManagementClient, ExtensionManagementContext } from './management-api.ts';
type Translate = (key: ExtensionCenterKey) => string;
/** Store props kept outside the slot contract and captured by the registered wrapper. */
export interface StorePanelProps {
    readonly catalog: ExtensionCatalogClient;
    readonly management?: ExtensionManagementClient;
    readonly context: ExtensionManagementContext;
    readonly t: Translate;
}
/** Signed offline Store with local search, filters, details, and bounded comparison. */
export declare function StorePanel({ catalog, management, context, t }: StorePanelProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=StorePanel.d.ts.map
