import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalJson } from "../domain/index.js";
/** Map an opaque identity to one attacker-independent path segment. */
export function storageKey(value) {
    return createHash('sha256').update(value).digest('hex');
}
/** Require one existing directory path that is not a symbolic link. */
export async function ensurePrivateDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`managed path is not a private directory: ${path}`);
}
/** Ensure a derived child stays below an exact center-owned root. */
export function safeChild(root, ...segments) {
    const base = resolve(root);
    const child = resolve(base, ...segments);
    const rel = relative(base, child);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error('managed path escapes its center-owned root');
    }
    return child;
}
/** Flush one directory entry update where the platform exposes directory fsync. */
export async function syncDirectory(path) {
    let handle;
    try {
        handle = await open(path, 'r');
        await handle.sync();
    }
    catch (error) {
        const code = error.code;
        if (process.platform !== 'win32' || !['EACCES', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(code ?? ''))
            throw error;
    }
    finally {
        await handle?.close();
    }
}
/** Durably replace one canonical JSON record through a private temporary file. */
export async function writeCanonicalAtomic(path, value) {
    const directory = dirname(path);
    await ensurePrivateDirectory(directory);
    const temporary = safeChild(directory, `.tmp-${randomUUID()}`);
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
        await syncDirectory(directory);
    }
    catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}
/** Install one canonical JSON record exactly once. */
export async function writeCanonicalExclusive(path, value) {
    const directory = dirname(path);
    await ensurePrivateDirectory(directory);
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await syncDirectory(directory);
}
/** Read one complete canonical JSON record, or return undefined when absent. */
export async function readCanonicalOptional(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    if (!text.endsWith('\n') || text.slice(0, -1).includes('\n'))
        throw new Error(`durable record is incomplete: ${path}`);
    const value = JSON.parse(text);
    if (`${canonicalJson(value)}\n` !== text)
        throw new Error(`durable record is not canonical: ${path}`);
    return value;
}
/** Open one existing regular file without following its final symbolic link. */
export async function openRegularNoFollow(path) {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) {
        await handle.close();
        throw new Error(`artifact is not a regular file: ${path}`);
    }
    return handle;
}
//# sourceMappingURL=files.js.map
