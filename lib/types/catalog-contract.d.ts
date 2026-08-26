/** Wire and catalog contracts shared by the Extension Center Host and Web Client. */
/** Current private RPC protocol version. */
export declare const EXTENSION_CENTER_PROTOCOL_VERSION: 1;
/** Logical loopback-only Connection channel owned by this plugin. */
export declare const EXTENSION_CENTER_RPC_CHANNEL: "/dsh-extension-center";
/** Supported extension kinds. */
export type ExtensionKind = 'plugin' | 'mcp' | 'skill';
/** Catalog-authored copy that never becomes model instructions. */
export interface LocalizedText {
    readonly en: string;
    readonly zh: string;
}
/** One exact artifact admitted into the local Store snapshot. */
export interface CatalogArtifact {
    readonly id: string;
    readonly version: string;
    readonly integrity: `sha256:${string}` | `sha512:${string}`;
    readonly sizeBytes: number;
    readonly acquisitionUrl: string;
}
/** One upstream identity pinned by the ingestion plane. */
export interface CatalogSource {
    readonly type: 'github-release' | 'mcp-registry' | 'github-content';
    readonly label: string;
    readonly url: string;
    readonly upstreamUrl: string;
    readonly revision: string;
    readonly admittedAt: string;
}
/** Compatibility evidence for the exact supported Host. */
export interface CatalogCompatibility {
    readonly status: 'compatible' | 'review-required';
    readonly dsh: '0.1.1-rc.2';
    readonly platforms: readonly ('darwin' | 'linux' | 'windows')[];
    readonly detail: LocalizedText;
}
/** One permission or authority disclosed before acquisition. */
export interface CatalogPermission {
    readonly phase: 'acquisition' | 'runtime';
    readonly kind: 'network' | 'filesystem' | 'subprocess' | 'credentials' | 'model-context';
    readonly access: 'none' | 'read' | 'write' | 'execute' | 'send';
    readonly detail: LocalizedText;
}
/** One package, runtime, or capability dependency. */
export interface CatalogDependency {
    readonly kind: 'host' | 'runtime' | 'extension';
    readonly id: string;
    readonly version: string;
    readonly required: boolean;
}
/** Admission of one lifecycle action by the candidate's center-owned provider. */
export interface CatalogLifecycleAction {
    readonly status: 'available' | 'unavailable';
    readonly reason?: string;
}
/** Lifecycle availability stays per action instead of collapsing into installed. */
export interface CatalogLifecycle {
    readonly install: CatalogLifecycleAction;
    readonly configure: CatalogLifecycleAction;
    readonly update: CatalogLifecycleAction;
    readonly uninstall: CatalogLifecycleAction;
    readonly restore: CatalogLifecycleAction;
}
/** One bounded verification claim shown as evidence, not a safety badge. */
export interface CatalogVerification {
    readonly claim: LocalizedText;
    readonly status: 'verified' | 'declared' | 'unknown';
    readonly detail: LocalizedText;
}
/** One signed, normalized Store candidate. */
export interface CatalogEntry {
    readonly candidateRef: string;
    readonly kind: ExtensionKind;
    readonly name: string;
    readonly displayName: LocalizedText;
    readonly summary: LocalizedText;
    readonly publisher: {
        readonly name: string;
        readonly status: 'community' | 'upstream-registry';
    };
    readonly license: {
        readonly spdx: string | null;
        readonly status: 'verified' | 'publisher-declared' | 'unknown';
        readonly sourceUrl: string | null;
    };
    readonly source: CatalogSource;
    readonly artifact: CatalogArtifact;
    readonly compatibility: CatalogCompatibility;
    readonly components: readonly LocalizedText[];
    readonly permissions: readonly CatalogPermission[];
    readonly dependencies: readonly CatalogDependency[];
    readonly scopes: readonly ('profile:web' | 'user' | 'project')[];
    readonly configuration: {
        readonly required: boolean;
        readonly credentials: 'none' | 'optional' | 'required';
        readonly fields: readonly LocalizedText[];
    };
    readonly conflicts: readonly LocalizedText[];
    readonly restart: {
        readonly required: boolean;
        readonly detail: LocalizedText;
    };
    readonly lifecycle: CatalogLifecycle;
    readonly verification: readonly CatalogVerification[];
    readonly retainedData: LocalizedText;
    readonly tags: readonly string[];
}
/** Signed immutable catalog payload. */
export interface CatalogEnvelope {
    readonly catalogId: string;
    readonly revision: number;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly previousRevisionDigest: string | null;
    readonly entriesDigest: `sha256:${string}`;
    readonly entries: readonly CatalogEntry[];
}
/** Threshold signature attached to a catalog envelope. */
export interface CatalogSignature {
    readonly keyId: string;
    readonly algorithm: 'ed25519';
    readonly value: string;
}
/** Packaged catalog trust root; catalog payloads cannot add keys. */
export interface CatalogRoot {
    readonly catalogId: string;
    readonly minimumRevision: number;
    readonly maximumAgeMs: number;
    readonly threshold: number;
    readonly keys: readonly {
        readonly keyId: string;
        readonly algorithm: 'ed25519';
        readonly publicKeyPem: string;
    }[];
}
/** Runtime Host-owner preflight projected independently from catalog admission. */
export interface CatalogHostCapabilities {
    readonly profileTransaction: boolean;
    readonly dynamicMcpConnection: boolean;
    readonly durableContinuation: boolean;
    readonly skillRegistry: boolean;
    readonly toolRegistry: boolean;
    readonly loaderObservation: boolean;
    readonly acquisition: boolean;
    readonly reason: 'host-capability' | null;
}
/** Verified Host projection returned to the browser. */
export interface CatalogListResponse {
    readonly protocolVersion: typeof EXTENSION_CENTER_PROTOCOL_VERSION;
    readonly catalog: {
        readonly id: string;
        readonly revision: number;
        readonly issuedAt: string;
        readonly expiresAt: string;
        readonly entriesDigest: `sha256:${string}`;
        readonly signatureStatus: 'verified';
        readonly keyIds: readonly string[];
        readonly source: 'bootstrap' | 'remote' | 'last-good';
        readonly freshness: 'bootstrap' | 'fresh' | 'cached';
        readonly degraded: boolean;
        readonly degradedReason: string | null;
        readonly lastRefreshAtMs: number | null;
    };
    readonly hostCapabilities: CatalogHostCapabilities;
    readonly entries: readonly CatalogEntry[];
}
//# sourceMappingURL=catalog-contract.d.ts.map
