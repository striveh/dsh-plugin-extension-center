import type { RpcJson } from '../service/rpc-contract.ts';
import type { ExtensionCenterKey } from './locales.ts';
type Translate = (key: ExtensionCenterKey) => string;
declare const FIELDS: readonly [readonly ["freshCacheMs", 1000, 86400000, 900000], readonly ["staleCacheMs", 1000, 604800000, 86400000], readonly ["fetchTimeoutMs", 100, 60000, 5000], readonly ["maxCatalogBytes", 65536, 33554432, 8388608], readonly ["maxCatalogEntries", 1, 20000, 5000], readonly ["maxTaskChars", 64, 16000, 2000], readonly ["maxResults", 1, 50, 8], readonly ["maxCurrentMatches", 1, 50, 8], readonly ["maxMatchedTerms", 1, 50, 12], readonly ["maxDescriptionChars", 80, 4000, 600]];
type ResolverField = typeof FIELDS[number][0];
type ResolverDraft = Readonly<Record<ResolverField, string>>;
/** Convert the exact typed draft into the only configuration keys accepted by this Client adapter. */
export declare function resolverConfiguration(draft: ResolverDraft): RpcJson;
/** Typed staged draft for the admitted capability-resolver configuration adapter. */
export declare function ResolverConfigDraft({ initial, t, onSave, onDiscard }: {
    readonly initial?: RpcJson;
    readonly t: Translate;
    readonly onSave: (configuration: RpcJson) => void;
    readonly onDiscard: () => void;
}): import("react").JSX.Element;
/** Read-only typed schema shown in candidate details before configuration begins. */
export declare function ResolverConfigDisclosure({ t }: {
    readonly t: Translate;
}): import("react").JSX.Element;
export {};
//# sourceMappingURL=ResolverConfigDraft.d.ts.map
