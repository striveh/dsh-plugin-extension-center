import { canonicalSha256, immutableJsonClone } from "../domain/index.js";
import { capabilityResolverCandidate } from "../resolver-candidates.js";
const RANGES = Object.freeze({
    freshCacheMs: [1_000, 86_400_000],
    staleCacheMs: [1_000, 604_800_000],
    fetchTimeoutMs: [100, 60_000],
    maxCatalogBytes: [65_536, 33_554_432],
    maxCatalogEntries: [1, 20_000],
    maxTaskChars: [64, 16_000],
    maxResults: [1, 50],
    maxCurrentMatches: [1, 50],
    maxDescriptionChars: [80, 4_000],
    maxMatchedTerms: [1, 50],
});
/** Secret-free exact settings schema and candidate-bound adapter identity shown in review evidence. */
export function pluginConfigurationReview(candidateRef, version) {
    const candidate = capabilityResolverCandidate(candidateRef, version);
    if (candidate === null)
        throw new Error('Plugin version has no exact typed configuration adapter');
    const schema = Object.entries(RANGES).map(([field, range]) => Object.freeze({
        field,
        type: 'integer',
        minimum: range[0],
        maximum: range[1],
    }));
    return Object.freeze({
        adapterVersion: candidate.configurationSchema,
        adapterDigest: canonicalSha256({
            schema: candidate.configurationSchema,
            candidateRef: candidate.candidateRef,
            ranges: RANGES,
        }),
        schemaDigest: canonicalSha256(schema),
        schema: Object.freeze(schema),
    });
}
/** Validate the complete typed configuration accepted by the exact Plugin adapter. */
export function validateCapabilityResolverConfiguration(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Plugin configuration must be an object');
    }
    const record = value;
    const keys = Object.keys(RANGES);
    const actual = Object.keys(record).sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index])) {
        throw new Error('Plugin configuration must contain exactly the product-owned fields');
    }
    const output = {};
    for (const key of keys) {
        const number = record[key];
        const [minimum, maximum] = RANGES[key];
        if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
            throw new Error(`Plugin configuration ${key} is outside ${String(minimum)}..${String(maximum)}`);
        }
        output[key] = number;
    }
    if (output.staleCacheMs < output.freshCacheMs) {
        throw new Error('Plugin staleCacheMs must be greater than or equal to freshCacheMs');
    }
    return immutableJsonClone(output);
}
/** Whether this exact candidate/version has a typed safe configuration adapter. */
export function hasPluginConfigurationAdapter(candidateRef, version) {
    return capabilityResolverCandidate(candidateRef, version) !== null;
}
//# sourceMappingURL=plugin-config-adapter.js.map
