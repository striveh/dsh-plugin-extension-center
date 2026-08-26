import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readCanonicalOptional, storageKey, writeCanonicalExclusive } from "./files.js";
/** Durable one-target lease built from atomic directory installation. */
export class FileTargetLock {
    root;
    constructor(root) {
        this.root = root;
    }
    /** Acquire one exact target, failing if any operation already owns it. */
    async acquire(targetKey, operationId, atMs = Date.now()) {
        const locks = join(this.root, 'locks');
        await mkdir(locks, { recursive: true, mode: 0o700 });
        const destination = join(locks, storageKey(targetKey));
        const temporary = join(locks, `.lock-${randomUUID()}`);
        await mkdir(temporary, { mode: 0o700 });
        const owner = { schemaVersion: 1, targetKey, operationId, acquiredAtMs: atMs };
        try {
            await writeCanonicalExclusive(join(temporary, 'owner.json'), owner);
            await rename(temporary, destination);
        }
        catch (error) {
            await rm(temporary, { recursive: true, force: true });
            if (['EEXIST', 'ENOTEMPTY'].includes(error.code ?? '')) {
                throw new Error(`target is busy: ${targetKey}`);
            }
            throw error;
        }
    }
    /** Release only the exact lease owner. */
    async release(targetKey, operationId) {
        const directory = join(this.root, 'locks', storageKey(targetKey));
        const owner = await this.readOwner(directory);
        if (owner === undefined || owner.targetKey !== targetKey || owner.operationId !== operationId) {
            throw new Error(`operation does not own target lock: ${operationId}`);
        }
        await rm(directory, { recursive: true });
    }
    /** Enumerate complete durable leases for startup recovery. */
    async list() {
        const locks = join(this.root, 'locks');
        let entries;
        try {
            entries = await readdir(locks, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        }
        const values = [];
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name))
                continue;
            const owner = await this.readOwner(join(locks, entry.name));
            if (owner === undefined || storageKey(owner.targetKey) !== entry.name)
                throw new Error('target lock owner is corrupt');
            values.push(owner);
        }
        return Object.freeze(values);
    }
    async readOwner(directory) {
        const value = await readCanonicalOptional(join(directory, 'owner.json'));
        if (value === undefined)
            return undefined;
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            throw new Error('target lock owner is invalid');
        const owner = value;
        if (owner.schemaVersion !== 1
            || typeof owner.targetKey !== 'string'
            || typeof owner.operationId !== 'string'
            || !Number.isSafeInteger(owner.acquiredAtMs))
            throw new Error('target lock owner fields are invalid');
        return owner;
    }
}
//# sourceMappingURL=target-lock.js.map
