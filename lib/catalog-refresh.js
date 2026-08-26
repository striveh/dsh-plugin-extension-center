import { lstat, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, canonicalSha256, verifyCatalog, verifyBootstrapCatalog, } from "./catalog.js";
import { BOOTSTRAP_CATALOG_ENVELOPE, BOOTSTRAP_CATALOG_ROOT, BOOTSTRAP_CATALOG_SIGNATURES, } from "./catalog-data.js";
import { ensurePrivateDirectory, openRegularNoFollow, safeChild, writeCanonicalExclusive, } from "./host/files.js";
const CACHE_SCHEMA_VERSION = 1;
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_CHAIN_LENGTH = 128;
const MAX_CACHE_BYTES = MAX_CATALOG_BYTES * MAX_CHAIN_LENGTH + 64 * 1024;
const CATALOG_PATH = '/plugins.json';
function record(value, subject, fields) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${subject} must be an object`);
    }
    const input = value;
    const actual = Object.keys(input).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
        throw new Error(`${subject} fields are invalid`);
    }
    return input;
}
function decodeSignedDocument(value) {
    const input = record(value, 'catalog document', ['envelope', 'signatures']);
    const envelope = record(input.envelope, 'catalog envelope', [
        'catalogId', 'entries', 'entriesDigest', 'expiresAt', 'issuedAt', 'previousRevisionDigest', 'revision',
    ]);
    if (!Array.isArray(envelope.entries) || envelope.entries.length > 100) {
        throw new Error('catalog envelope entries exceed their bound');
    }
    const signatures = input.signatures;
    if (!Array.isArray(signatures) || signatures.length === 0 || signatures.length > 16) {
        throw new Error('catalog signature set exceeds its bound');
    }
    const decodedSignatures = signatures.map((value, index) => {
        const signature = record(value, `catalog signature ${String(index)}`, ['algorithm', 'keyId', 'value']);
        if (signature.algorithm !== 'ed25519'
            || typeof signature.keyId !== 'string' || signature.keyId.length === 0 || signature.keyId.length > 128
            || typeof signature.value !== 'string' || signature.value.length === 0 || signature.value.length > 512) {
            throw new Error(`catalog signature ${String(index)} fields are invalid`);
        }
        return Object.freeze({
            algorithm: 'ed25519',
            keyId: signature.keyId,
            value: signature.value,
        });
    });
    return Object.freeze({
        envelope: envelope,
        signatures: Object.freeze(decodedSignatures),
    });
}
function decodeCache(value) {
    const input = record(value, 'catalog last-good cache', [
        'acceptedAtMs', 'catalogId', 'chain', 'schemaVersion',
    ]);
    if (input.schemaVersion !== CACHE_SCHEMA_VERSION
        || input.catalogId !== BOOTSTRAP_CATALOG_ROOT.catalogId
        || !Number.isSafeInteger(input.acceptedAtMs) || input.acceptedAtMs < 0
        || !Array.isArray(input.chain) || input.chain.length === 0 || input.chain.length > MAX_CHAIN_LENGTH) {
        throw new Error('catalog last-good cache values are invalid');
    }
    return Object.freeze({
        schemaVersion: CACHE_SCHEMA_VERSION,
        catalogId: input.catalogId,
        chain: Object.freeze(input.chain.map(decodeSignedDocument)),
        acceptedAtMs: input.acceptedAtMs,
    });
}
function sameEnvelope(left, right) {
    return canonicalSha256(left) === canonicalSha256(right);
}
/** Verify one same-or-next revision without allowing rollback, gaps, or a broken predecessor link. */
export function verifyCatalogAdvance(root, current, document, now = Date.now()) {
    const next = verifyCatalog(root, document.envelope, document.signatures, now);
    if (next.envelope.revision < current.envelope.revision)
        throw new Error('catalog revision rollback is forbidden');
    if (next.envelope.revision === current.envelope.revision) {
        if (!sameEnvelope(next.envelope, current.envelope)) {
            throw new Error('catalog revision is already bound to different content');
        }
        return next;
    }
    if (next.envelope.revision !== current.envelope.revision + 1) {
        throw new Error('catalog revision chain contains a gap');
    }
    if (next.envelope.previousRevisionDigest !== canonicalSha256(current.envelope)) {
        throw new Error('catalog previous revision digest does not match last-good');
    }
    return next;
}
function bootstrapDocument() {
    return Object.freeze({
        envelope: BOOTSTRAP_CATALOG_ENVELOPE,
        signatures: BOOTSTRAP_CATALOG_SIGNATURES,
    });
}
function verifyCache(cache, now) {
    const [first, ...rest] = cache.chain;
    if (first === undefined || !sameEnvelope(first.envelope, BOOTSTRAP_CATALOG_ENVELOPE)
        || canonicalSha256(first.signatures) !== canonicalSha256(BOOTSTRAP_CATALOG_SIGNATURES)) {
        throw new Error('catalog cache does not begin at the packaged bootstrap');
    }
    let current = verifyCatalog(BOOTSTRAP_CATALOG_ROOT, first.envelope, first.signatures, Date.parse(first.envelope.issuedAt) + 1);
    for (const document of rest) {
        current = verifyCatalogAdvance(BOOTSTRAP_CATALOG_ROOT, current, document, Date.parse(document.envelope.issuedAt) + 1);
    }
    return verifyCatalog(BOOTSTRAP_CATALOG_ROOT, current.envelope, cache.chain.at(-1).signatures, now);
}
async function readCache(path) {
    let handle;
    try {
        handle = await openRegularNoFollow(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    try {
        const info = await handle.stat();
        if (info.size > MAX_CACHE_BYTES)
            throw new Error('catalog last-good cache exceeds its bound');
        const text = await handle.readFile('utf8');
        if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
            throw new Error('catalog last-good cache is incomplete');
        }
        const value = JSON.parse(text);
        if (`${canonicalJson(value)}\n` !== text)
            throw new Error('catalog last-good cache is not canonical');
        return decodeCache(value);
    }
    finally {
        await handle.close();
    }
}
async function replaceCache(path, value) {
    const directory = dirname(path);
    await ensurePrivateDirectory(directory);
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error('catalog last-good cache is not a regular file');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const temporary = safeChild(directory, `.catalog-${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await rename(temporary, path);
        const directoryHandle = await open(directory, 'r');
        try {
            await directoryHandle.sync();
        }
        finally {
            await directoryHandle.close();
        }
    }
    catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}
async function responseBytes(response) {
    if (response.status !== 200)
        throw new Error(`catalog endpoint returned HTTP ${String(response.status)}`);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json')
        throw new Error('catalog endpoint did not return application/json');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_CATALOG_BYTES)) {
        throw new Error('catalog response exceeds its download bound');
    }
    if (response.body === null)
        throw new Error('catalog response has no body');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done)
                break;
            total += result.value.byteLength;
            if (total > MAX_CATALOG_BYTES) {
                await reader.cancel();
                throw new Error('catalog response exceeds its download bound');
            }
            chunks.push(result.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}
function parseDocument(bytes) {
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch (cause) {
        throw new Error('catalog response is not strict UTF-8 JSON', { cause });
    }
    return decodeSignedDocument(value);
}
/** Resolve a configured origin to the one fixed catalog path. */
export function catalogEndpoint(trustedOrigin) {
    let url;
    try {
        url = new URL(trustedOrigin);
    }
    catch {
        throw new Error('catalogTrustedOrigin must be a canonical HTTPS origin');
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
        || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.origin !== trustedOrigin) {
        throw new Error('catalogTrustedOrigin must be a canonical HTTPS origin');
    }
    return new URL(CATALOG_PATH, url).href;
}
/** Own the one admitted snapshot used by both Store RPC and local task retrieval. */
export class CatalogSnapshotManager {
    root;
    config;
    dependencies;
    snapshot = null;
    cache = null;
    refreshing = null;
    constructor(root, config, dependencies = {
        fetch: globalThis.fetch,
        now: Date.now,
    }) {
        this.root = root;
        this.config = config;
        this.dependencies = dependencies;
    }
    /** Establish the durable bootstrap anchor, verify the full last-good chain, then attempt one live refresh. */
    async initialize() {
        const now = this.dependencies.now();
        verifyBootstrapCatalog(now);
        const directory = join(this.root, 'catalog');
        const path = join(directory, 'last-good.json');
        await ensurePrivateDirectory(directory);
        let cache = await readCache(path);
        if (cache === undefined) {
            const initial = Object.freeze({
                schemaVersion: CACHE_SCHEMA_VERSION,
                catalogId: BOOTSTRAP_CATALOG_ROOT.catalogId,
                chain: Object.freeze([bootstrapDocument()]),
                acceptedAtMs: now,
            });
            try {
                await writeCanonicalExclusive(path, initial);
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
            }
            cache = await readCache(path);
            if (cache === undefined)
                throw new Error('catalog bootstrap cache disappeared during initialization');
        }
        const catalog = verifyCache(cache, now);
        this.cache = cache;
        this.snapshot = Object.freeze({
            catalog,
            status: Object.freeze({
                source: cache.chain.length === 1 ? 'bootstrap' : 'last-good',
                freshness: cache.chain.length === 1 ? 'bootstrap' : 'cached',
                degraded: false,
                degradedReason: null,
                lastRefreshAtMs: null,
            }),
        });
        if (this.config.trustedOrigin === null)
            return this.snapshot;
        return await this.refresh();
    }
    /** Return the exact current admitted snapshot without starting a second fetch. */
    current() {
        if (this.snapshot === null)
            throw new Error('catalog snapshot manager is not initialized');
        verifyCatalog(BOOTSTRAP_CATALOG_ROOT, this.snapshot.catalog.envelope, this.cache?.chain.at(-1)?.signatures ?? BOOTSTRAP_CATALOG_SIGNATURES, this.dependencies.now());
        return this.snapshot;
    }
    /** Fetch and admit one same-or-next signed revision, retaining unexpired last-good on failure. */
    refresh() {
        if (this.refreshing !== null)
            return this.refreshing;
        const refreshing = this.refreshOnce().finally(() => {
            if (this.refreshing === refreshing)
                this.refreshing = null;
        });
        this.refreshing = refreshing;
        return refreshing;
    }
    async refreshOnce() {
        if (this.snapshot === null || this.cache === null)
            throw new Error('catalog snapshot manager is not initialized');
        if (this.config.trustedOrigin === null)
            return this.snapshot;
        const attemptedAtMs = this.dependencies.now();
        try {
            const endpoint = catalogEndpoint(this.config.trustedOrigin);
            const response = await this.dependencies.fetch(endpoint, {
                method: 'GET',
                headers: { accept: 'application/json' },
                redirect: 'error',
                signal: AbortSignal.timeout(this.config.fetchTimeoutMs),
            });
            if (response.url !== '' && response.url !== endpoint)
                throw new Error('catalog endpoint redirected outside its fixed URL');
            const document = parseDocument(await responseBytes(response));
            const fetched = verifyCatalogAdvance(BOOTSTRAP_CATALOG_ROOT, this.snapshot.catalog, document, attemptedAtMs);
            const changed = fetched.envelope.revision > this.snapshot.catalog.envelope.revision;
            const chain = changed ? [...this.cache.chain, document] : this.cache.chain;
            if (chain.length > MAX_CHAIN_LENGTH)
                throw new Error('catalog revision chain exceeds the packaged bound');
            const cache = Object.freeze({
                schemaVersion: CACHE_SCHEMA_VERSION,
                catalogId: BOOTSTRAP_CATALOG_ROOT.catalogId,
                chain: Object.freeze(chain),
                acceptedAtMs: attemptedAtMs,
            });
            await replaceCache(join(this.root, 'catalog', 'last-good.json'), cache);
            this.cache = cache;
            this.snapshot = Object.freeze({
                catalog: changed ? fetched : this.snapshot.catalog,
                status: Object.freeze({
                    source: 'remote',
                    freshness: 'fresh',
                    degraded: false,
                    degradedReason: null,
                    lastRefreshAtMs: attemptedAtMs,
                }),
            });
            return this.snapshot;
        }
        catch (error) {
            const catalog = verifyCache(this.cache, attemptedAtMs);
            const reason = error instanceof Error && error.message.length > 0
                ? error.message.slice(0, 160)
                : 'catalog refresh failed';
            this.snapshot = Object.freeze({
                catalog,
                status: Object.freeze({
                    source: this.cache.chain.length === 1 ? 'bootstrap' : 'last-good',
                    freshness: this.cache.chain.length === 1 ? 'bootstrap' : 'cached',
                    degraded: true,
                    degradedReason: reason,
                    lastRefreshAtMs: attemptedAtMs,
                }),
            });
            return this.snapshot;
        }
    }
}
//# sourceMappingURL=catalog-refresh.js.map
