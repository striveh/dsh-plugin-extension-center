import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { syncDirectory } from "./files.js";
const defaultOperations = Object.freeze({
    remove: (path, options) => rm(path, options),
    synchronize: syncDirectory,
});
/** Remove one file and durably persist the directory entry update. */
export async function durableUnlink(path, options = {}, operations = defaultOperations) {
    await operations.remove(path, { force: options.force ?? false });
    await operations.synchronize(dirname(path));
}
//# sourceMappingURL=durable-unlink.js.map
