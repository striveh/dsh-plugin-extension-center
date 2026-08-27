import { chmod, lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensurePrivateDirectory, syncDirectory } from "./host/files.js";
const BUSY_TIMEOUT_MS = 10_000;
const DATABASE_FILE = 'cache-writer.sqlite';
const localQueues = new Map();
async function serialize(key, work) {
    const prior = localQueues.get(key) ?? Promise.resolve();
    let release;
    const turn = new Promise(resolveTurn => { release = resolveTurn; });
    const tail = prior.then(() => turn);
    localQueues.set(key, tail);
    await prior;
    try {
        return await work();
    }
    finally {
        release();
        if (localQueues.get(key) === tail)
            localQueues.delete(key);
    }
}
async function prepareDatabase(path, directory) {
    await ensurePrivateDirectory(directory);
    try {
        const handle = await open(path, 'wx', 0o600);
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await syncDirectory(directory);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('catalog cache writer reservation is not a regular file');
    }
    await chmod(path, 0o600);
}
/**
 * Hold the catalog's cross-process writer reservation while one callback re-reads and commits durable cache state.
 * @param directory Center-owned catalog storage directory.
 * @param work Short callback that performs no network access.
 * @returns The callback result after the SQLite writer transaction commits.
 */
export async function withCatalogCacheWriter(directory, work) {
    const canonicalDirectory = resolve(directory);
    const databasePath = join(canonicalDirectory, DATABASE_FILE);
    return await serialize(databasePath, async () => {
        await prepareDatabase(databasePath, canonicalDirectory);
        const Database = (await import('node:sqlite')).DatabaseSync;
        const database = new Database(databasePath);
        let transactionStarted = false;
        try {
            database.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
            database.exec('PRAGMA trusted_schema = OFF');
            database.exec('BEGIN IMMEDIATE');
            transactionStarted = true;
            const result = await work();
            database.exec('COMMIT');
            transactionStarted = false;
            return result;
        }
        catch (error) {
            if (transactionStarted) {
                try {
                    database.exec('ROLLBACK');
                }
                catch (rollbackError) {
                    throw new AggregateError([error, rollbackError], 'catalog cache writer rollback failed');
                }
            }
            throw error;
        }
        finally {
            database.close();
        }
    });
}
//# sourceMappingURL=catalog-cache-reservation.js.map
