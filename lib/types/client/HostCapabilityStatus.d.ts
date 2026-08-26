import type { CatalogHostCapabilities } from '../catalog-contract.ts';
import type { ExtensionCenterKey } from './locales.ts';
type Translate = (key: ExtensionCenterKey) => string;
type HostCapabilityEvidence = Pick<CatalogHostCapabilities, 'profileTransaction' | 'dynamicMcpConnection' | 'durableContinuation' | 'skillRegistry' | 'toolRegistry' | 'loaderObservation'>;
/** Render every independent writable-Host preflight fact. */
export declare function HostCapabilityStatus({ capabilities, t }: {
    readonly capabilities: HostCapabilityEvidence;
    readonly t: Translate;
}): import("react").JSX.Element;
export {};
//# sourceMappingURL=HostCapabilityStatus.d.ts.map
