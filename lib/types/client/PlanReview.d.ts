import type { CatalogEntry } from '../catalog-contract.ts';
import type { PlanAuthorizationState } from '../plans/types.ts';
import type { PlanReviewEvidence } from '../plans/types.ts';
import type { IntentPreviewResponse, LifecycleResponse, RpcJson } from '../service/rpc-contract.ts';
import type { ExtensionCenterKey } from './locales.ts';
import { type ExtensionManagementClient } from './management-api.ts';
type Translate = (key: ExtensionCenterKey) => string;
/** Ordinary-user projection of the exact kind-specific facts protected by the plan hash. */
export declare function ReviewEvidenceDetails({ evidence, t }: Readonly<{
    evidence: PlanReviewEvidence;
    t: Translate;
}>): import("react").JSX.Element;
/** Props for one exact, single-use human plan decision. */
export interface PlanReviewProps {
    readonly preview: IntentPreviewResponse;
    readonly candidate?: CatalogEntry;
    readonly management: ExtensionManagementClient;
    readonly configuration?: RpcJson;
    readonly initialState?: Extract<PlanAuthorizationState, {
        status: 'pending' | 'approved';
    }>;
    readonly t: Translate;
    readonly onClose: () => void;
    readonly onCommitted?: (result: LifecycleResponse) => void;
}
/** Render the immutable plan and keep decision separate from lifecycle execution. */
export declare function PlanReview({ preview, candidate, management, configuration, initialState, t, onClose, onCommitted }: PlanReviewProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=PlanReview.d.ts.map
