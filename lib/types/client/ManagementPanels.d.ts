import type { CatalogEntry } from '../catalog-contract.ts';
import type { OperationKind } from '../plans/types.ts';
import type { RpcJson } from '../service/rpc-contract.ts';
import type { ExtensionCenterKey } from './locales.ts';
import type { ExtensionManagementClient, ExtensionManagementContext } from './management-api.ts';
type Translate = (key: ExtensionCenterKey) => string;
interface MutationRequest {
    readonly id: string;
    readonly candidateRef: string;
    readonly operationKind: OperationKind;
    readonly scopeKey: string;
    readonly profileId: string;
    readonly targetKey: string | null;
    readonly configuration: RpcJson;
    readonly returnFocus?: HTMLElement;
}
interface ManagementPanelProps {
    readonly management?: ExtensionManagementClient;
    readonly context: ExtensionManagementContext;
    readonly candidates: ReadonlyMap<string, CatalogEntry>;
    readonly t: Translate;
}
/** Preview one exact mutation before exposing the separate human decision. */
export declare function MutationFlow({ request: input, candidate, management, t, onClose, onCommitted }: {
    readonly request: MutationRequest;
    readonly candidate?: CatalogEntry;
    readonly management: ExtensionManagementClient;
    readonly t: Translate;
    readonly onClose: () => void;
    readonly onCommitted?: () => void;
}): import("react").JSX.Element;
/** Managed inventory with independent lifecycle dimensions and staged configuration. */
export declare function InstalledPanel({ management, context, candidates, t }: ManagementPanelProps): import("react").JSX.Element;
/** Exact observed update targets; updates never apply automatically. */
export declare function UpdatesPanel({ management, context, candidates, t }: ManagementPanelProps): import("react").JSX.Element;
/** Verified operation phases, receipts, and exact fenced recovery retry. */
export declare function ActivityPanel({ management, context, candidates, t }: ManagementPanelProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=ManagementPanels.d.ts.map
