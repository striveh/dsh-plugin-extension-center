import { createHash } from 'node:crypto';
import { isMap, isSeq, parseDocument } from 'yaml';
import { canonicalSha256, immutableJsonClone } from "../domain/index.js";
const PACKAGE_NAME = 'dsh-capability-resolver';
const CANDIDATE_REF = 'plugin:dsh-capability-resolver@0.1.0';
const ADAPTER_SCHEMA = 'dsh-capability-resolver/config@0.1.0';
const OWNER_COMMENT = 'dsh-extension-center-owned: dsh-capability-resolver';
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
/** Secret-free exact settings schema and adapter identity shown in review evidence. */
export function pluginConfigurationReview() {
    const schema = Object.entries(RANGES).map(([field, range]) => Object.freeze({
        field,
        type: 'integer',
        minimum: range[0],
        maximum: range[1],
    }));
    return Object.freeze({
        adapterVersion: ADAPTER_SCHEMA,
        adapterDigest: canonicalSha256({ schema: ADAPTER_SCHEMA, candidateRef: CANDIDATE_REF, ranges: RANGES }),
        schemaDigest: canonicalSha256(schema),
        schema: Object.freeze(schema),
    });
}
function sha256Bytes(value) {
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
function strictConfiguration(value) {
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
    return candidateRef === CANDIDATE_REF && version === '0.1.0';
}
/** Build one complete normalized user patch while refusing unowned conflicting rows. */
export function buildCapabilityResolverPatch(currentUtf8, value) {
    if (Buffer.byteLength(currentUtf8, 'utf8') > 1024 * 1024)
        throw new Error('Profile patch exceeds the P0 size bound');
    const config = strictConfiguration(value);
    const document = parseDocument(currentUtf8, { schema: 'core', strict: true, uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0 || !isSeq(document.contents)) {
        throw new Error('Profile patch must be one strict YAML sequence');
    }
    try {
        document.toJS({ maxAliasCount: 0 });
    }
    catch (cause) {
        throw new Error('Profile patch aliases are forbidden', { cause });
    }
    const matches = document.contents.items.filter((item) => {
        if (!isMap(item))
            return false;
        const row = item.toJSON();
        return typeof row === 'object' && row !== null && !Array.isArray(row)
            && row.id === PACKAGE_NAME;
    });
    if (matches.length > 1)
        throw new Error('Profile patch contains duplicate Plugin overrides');
    const replacement = document.createNode({ id: PACKAGE_NAME, config });
    if (!isMap(replacement))
        throw new Error('typed Plugin configuration did not produce a YAML mapping');
    replacement.commentBefore = OWNER_COMMENT;
    if (matches.length === 1) {
        const prior = matches[0];
        if (!isMap(prior) || !prior.commentBefore?.split('\n').some(line => line.trim() === OWNER_COMMENT)) {
            throw new Error('Profile patch Plugin override is not owned by the Extension Center');
        }
        const index = document.contents.items.indexOf(prior);
        document.contents.items[index] = replacement;
    }
    else {
        document.contents.items.push(replacement);
    }
    const nextUtf8 = document.toString({ lineWidth: 0 });
    const adapterDigest = canonicalSha256({ schema: ADAPTER_SCHEMA, candidateRef: CANDIDATE_REF, ranges: RANGES });
    return Object.freeze({
        packageName: PACKAGE_NAME,
        candidateRef: CANDIDATE_REF,
        schema: ADAPTER_SCHEMA,
        adapterDigest,
        expectedDigest: sha256Bytes(currentUtf8),
        nextUtf8,
        nextDigest: sha256Bytes(nextUtf8),
        configuration: config,
    });
}
//# sourceMappingURL=plugin-config-adapter.js.map
