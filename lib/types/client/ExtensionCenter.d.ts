import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import type { ExtensionCenterKey } from './locales.ts';
import type { ExtensionCatalogClient } from './catalog-api.ts';
import type { ExtensionManagementClient, ExtensionManagementContext } from './management-api.ts';
import type { ExtensionCenterStore } from './store.ts';
/** Locale namespace registered by the Extension Center Client plugin. */
export declare const EXTENSION_CENTER_LOCALE = "extension-center";
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Product copy for the independent Extension Center shell. */
        'extension-center': ExtensionCenterKey;
    }
}
/** Sidebar entry props composed from the owner, shared store, and locale seat. */
export type ExtensionCenterTriggerProps = PropsRuntime<'sidebar.footer.action'> & PropsStore<ExtensionCenterStore> & PropsLocale<typeof EXTENSION_CENTER_LOCALE>;
/** Overlay entry props composed from the shared store and locale seat. */
export type ExtensionCenterOverlaySlotProps = PropsRuntime<'shell.overlay'> & PropsStore<ExtensionCenterStore> & PropsLocale<typeof EXTENSION_CENTER_LOCALE>;
/** Overlay props used by direct source tests before the catalog client is captured. */
export type ExtensionCenterOverlayProps = ExtensionCenterOverlaySlotProps & {
    readonly catalog: ExtensionCatalogClient;
    readonly management?: ExtensionManagementClient;
    readonly managementContext?: ExtensionManagementContext;
};
/** Render the first-level sidebar action and restore focus after every dialog close path. */
export declare function ExtensionCenterTrigger({ wide, useStore, actions, t }: ExtensionCenterTriggerProps): import("react").JSX.Element;
/** Render the Store-default dialog from the additive shell overlay slot. */
export declare function ExtensionCenterOverlay({ useStore, actions, t, catalog, management, managementContext, }: ExtensionCenterOverlayProps): import("react").JSX.Element;
/** Bind private catalog and management clients without placing them in generic slot options. */
export declare function bindExtensionCenterOverlay(catalog: ExtensionCatalogClient, management: ExtensionManagementClient, managementContext?: ExtensionManagementContext): (props: ExtensionCenterOverlaySlotProps) => import("react").JSX.Element;
//# sourceMappingURL=ExtensionCenter.d.ts.map
