import type { StoreHandle } from '@deepseek-ai/dsh-client-ui-slots';
/** Extension Center top-level view identifiers. */
export type ExtensionCenterView = 'store' | 'installed' | 'updates' | 'activity';
/** Root-scoped viewing state shared by the sidebar trigger and shell overlay. */
export interface ExtensionCenterState {
    open: boolean;
    active: ExtensionCenterView;
}
/** Complete write set for transient Extension Center viewing state. */
export type ExtensionCenterActions = {
    openStore: (draft: ExtensionCenterState) => void;
    close: (draft: ExtensionCenterState) => void;
    select: (draft: ExtensionCenterState, view: ExtensionCenterView) => void;
};
/** Shared store handle type used by both additive slot entries. */
export type ExtensionCenterStore = StoreHandle<ExtensionCenterState, ExtensionCenterActions>;
/**
 * Create one transient root store for the two Extension Center entries.
 * @returns A fresh handle owned by one Client plugin application.
 */
export declare function createExtensionCenterStore(): ExtensionCenterStore;
//# sourceMappingURL=store.d.ts.map
