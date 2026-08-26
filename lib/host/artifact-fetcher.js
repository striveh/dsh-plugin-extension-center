import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rm, stat, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { openRegularNoFollow } from "./files.js";
function exactUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch (cause) {
        throw new Error('artifact URL must be absolute', { cause });
    }
    if (url.protocol !== 'https:'
        || url.username !== ''
        || url.password !== ''
        || url.hash !== ''
        || forbiddenHost(url.hostname))
        throw new Error('artifact URL is outside the admitted HTTPS acquisition policy');
    return url;
}
function forbiddenHost(hostname) {
    const lower = hostname.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local'))
        return true;
    const family = isIP(lower);
    if (family === 4) {
        const octets = lower.split('.').map(Number);
        return octets[0] === 10
            || octets[0] === 127
            || (octets[0] === 169 && octets[1] === 254)
            || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
            || (octets[0] === 192 && octets[1] === 168);
    }
    if (family === 6)
        return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
    return false;
}
function digestSpec(integrity) {
    const separator = integrity.indexOf(':');
    const algorithm = integrity.slice(0, separator);
    const encoded = integrity.slice(separator + 1);
    if (algorithm === 'sha256' && /^[0-9a-f]{64}$/.test(encoded)) {
        return { algorithm, expected: Buffer.from(encoded, 'hex') };
    }
    if (algorithm === 'sha512' && /^[0-9a-f]{128}$/.test(encoded)) {
        return { algorithm, expected: Buffer.from(encoded, 'hex') };
    }
    if (algorithm === 'sha512' && /^[A-Za-z0-9+/]{86}==$/.test(encoded)) {
        const expected = Buffer.from(encoded, 'base64');
        if (expected.length === 64 && expected.toString('base64') === encoded)
            return { algorithm, expected };
    }
    throw new Error('artifact integrity is not a canonical SHA-256 or SHA-512 digest');
}
async function verifyLocal(path, spec) {
    let info;
    try {
        info = await stat(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
    if (!info.isFile() || info.size !== spec.sizeBytes)
        throw new Error('existing artifact does not match its admitted size');
    const parsed = digestSpec(spec.integrity);
    const hash = createHash(parsed.algorithm);
    const handle = await openRegularNoFollow(path);
    try {
        for await (const chunk of handle.createReadStream({ autoClose: false }))
            hash.update(chunk);
    }
    finally {
        await handle.close();
    }
    if (!hash.digest().equals(parsed.expected))
        throw new Error('existing artifact does not match its admitted integrity');
    return true;
}
/** HTTPS-only integrity-pinned artifact acquisition with bounded explicit redirects. */
export class ArtifactFetcher {
    root;
    redirects;
    fetchImpl;
    constructor(root, redirects, fetchImpl = globalThis.fetch) {
        this.root = root;
        this.redirects = redirects;
        if (!Number.isSafeInteger(redirects.maximumRedirects) || redirects.maximumRedirects < 0 || redirects.maximumRedirects > 5) {
            throw new Error('maximumRedirects must be an integer between zero and five');
        }
        this.fetchImpl = fetchImpl;
    }
    /** Fetch only while carrying the single-use authorization returned by plan consumption. */
    async fetch(binding, signal) {
        const spec = boundSpec(binding);
        if (!Number.isSafeInteger(spec.sizeBytes) || spec.sizeBytes < 1 || spec.sizeBytes > 64 * 1024 * 1024) {
            throw new Error('artifact size is outside the P0 acquisition bound');
        }
        const initial = exactUrl(spec.url);
        const parsed = digestSpec(spec.integrity);
        const digestSegment = parsed.expected.toString('hex');
        const artifactDirectory = join(this.root, 'artifacts', parsed.algorithm);
        const temporaryDirectory = join(this.root, 'artifacts', 'temporary');
        await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
        await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
        const destination = join(artifactDirectory, `${digestSegment}${spec.fileSuffix}`);
        if (await verifyLocal(destination, spec)) {
            return Object.freeze({ path: destination, sizeBytes: spec.sizeBytes, integrity: spec.integrity, finalUrl: initial.toString() });
        }
        let current = initial;
        let response;
        for (let count = 0;; count += 1) {
            response = await this.fetchImpl(current.toString(), {
                method: 'GET',
                redirect: 'manual',
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                signal,
            });
            if (![301, 302, 303, 307, 308].includes(response.status))
                break;
            await response.body?.cancel();
            if (count >= this.redirects.maximumRedirects)
                throw new Error('artifact redirect limit exceeded');
            const location = response.headers.get('location');
            if (location === null)
                throw new Error('artifact redirect has no location');
            const next = exactUrl(new URL(location, current).toString());
            if (next.origin !== current.origin
                && !this.redirects.allowedCrossOriginHosts.includes(next.hostname.toLowerCase()))
                throw new Error('artifact redirect target is not admitted');
            current = next;
        }
        if (response === undefined || !response.ok || response.body === null)
            throw new Error(`artifact download failed with HTTP ${String(response?.status ?? 0)}`);
        const temporary = join(temporaryDirectory, `${randomUUID()}.partial`);
        const handle = await open(temporary, 'wx', 0o600);
        const hash = createHash(parsed.algorithm);
        let bytes = 0;
        try {
            const reader = response.body.getReader();
            while (true) {
                const item = await reader.read();
                if (item.done)
                    break;
                bytes += item.value.byteLength;
                if (bytes > spec.sizeBytes) {
                    await reader.cancel();
                    throw new Error('artifact body exceeds the admitted size');
                }
                hash.update(item.value);
                await handle.write(item.value);
            }
            if (bytes !== spec.sizeBytes)
                throw new Error('artifact body does not match the admitted size');
            if (!hash.digest().equals(parsed.expected))
                throw new Error('artifact body does not match the admitted integrity');
            await handle.sync();
        }
        catch (error) {
            await handle.close();
            await rm(temporary, { force: true });
            throw error;
        }
        await handle.close();
        try {
            await link(temporary, destination);
        }
        catch (error) {
            if (error.code !== 'EEXIST') {
                await rm(temporary, { force: true });
                throw error;
            }
            await verifyLocal(destination, spec);
        }
        finally {
            await unlink(temporary).catch((error) => {
                if (error.code !== 'ENOENT')
                    throw error;
            });
        }
        return Object.freeze({ path: destination, sizeBytes: bytes, integrity: spec.integrity, finalUrl: current.toString() });
    }
}
function boundSpec(binding) {
    const { authorization, plan, catalog } = binding;
    const content = plan.content;
    if (authorization.planId !== content.planId
        || authorization.planHash !== plan.hash
        || authorization.operationKind !== content.operationKind
        || authorization.managedObject !== content.managedObject
        || authorization.externalRuntimeAction !== content.externalRuntimeAction
        || JSON.stringify(authorization.runtimeBinding) !== JSON.stringify(content.runtimeBinding)
        || authorization.targetKey !== content.targetKey
        || authorization.ownerKey !== content.ownerKey
        || authorization.scopeKey !== content.scopeKey
        || authorization.profileId !== content.profileId)
        throw new Error('consumed authorization does not bind the exact immutable plan');
    if (content.managedObject !== 'artifact'
        || content.externalRuntimeAction !== 'download'
        || content.runtimeBinding !== null)
        throw new Error('consumed plan does not authorize artifact acquisition');
    if (catalog.envelope.revision !== content.fences.catalogRevision) {
        throw new Error('verified catalog revision no longer matches the plan fence');
    }
    const entry = catalog.envelope.entries.find(candidate => candidate.candidateRef === content.candidateRef);
    if (entry === undefined)
        throw new Error('plan candidate is absent from the verified catalog revision');
    if (entry.kind !== content.extensionKind
        || entry.name !== content.extensionId
        || entry.artifact.version !== content.artifactRevision
        || entry.artifact.integrity !== content.artifactIntegrity
        || entry.artifact.acquisitionUrl !== content.artifactUrl
        || entry.artifact.sizeBytes !== content.artifactSizeBytes)
        throw new Error('verified catalog candidate does not match the immutable plan');
    return Object.freeze({
        candidateRef: entry.candidateRef,
        revision: entry.artifact.version,
        url: entry.artifact.acquisitionUrl,
        sizeBytes: entry.artifact.sizeBytes,
        integrity: entry.artifact.integrity,
        fileSuffix: entry.kind === 'skill' ? '.md' : '.tgz',
    });
}
//# sourceMappingURL=artifact-fetcher.js.map
