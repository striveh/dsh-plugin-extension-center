import type { RpcJson } from '../service/rpc-contract.ts';
declare const RANGES: Readonly<{
    readonly freshCacheMs: readonly [1000, 86400000];
    readonly staleCacheMs: readonly [1000, 604800000];
    readonly fetchTimeoutMs: readonly [100, 60000];
    readonly maxCatalogBytes: readonly [65536, 33554432];
    readonly maxCatalogEntries: readonly [1, 20000];
    readonly maxTaskChars: readonly [64, 16000];
    readonly maxResults: readonly [1, 50];
    readonly maxCurrentMatches: readonly [1, 50];
    readonly maxDescriptionChars: readonly [80, 4000];
    readonly maxMatchedTerms: readonly [1, 50];
}>;
/** Secret-free exact settings schema and candidate-bound adapter identity shown in review evidence. */
export declare function pluginConfigurationReview(candidateRef: string, version: string): Readonly<{
    adapterVersion: string;
    adapterDigest: `sha256:${string}`;
    schemaDigest: `sha256:${string}`;
    schema: readonly Readonly<{
        field: string;
        type: 'integer';
        minimum: number;
        maximum: number;
    }>[];
}>;
/** Strict product-owned configuration accepted for the single P0 Plugin candidate. */
export type CapabilityResolverConfiguration = Readonly<Record<keyof typeof RANGES, number>>;
/** Validate the complete typed configuration accepted by the exact Plugin adapter. */
export declare function validateCapabilityResolverConfiguration(value: RpcJson): CapabilityResolverConfiguration;
/** Whether this exact candidate/version has a typed safe configuration adapter. */
export declare function hasPluginConfigurationAdapter(candidateRef: string, version: string): boolean;
export {};
//# sourceMappingURL=plugin-config-adapter.d.ts.map
