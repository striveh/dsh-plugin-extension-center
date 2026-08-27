import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { syncDirectory } from './files.ts'

/** Filesystem operations injected only to verify durable unlink ordering and failures. */
export interface DurableUnlinkOperations {
  /** Remove the exact path before its parent directory is synchronized. */
  readonly remove: (path: string, options: Readonly<{ force: boolean }>) => Promise<void>
  /** Synchronize the directory entry update that removed the path. */
  readonly synchronize: (directory: string) => Promise<void>
}

const defaultOperations: DurableUnlinkOperations = Object.freeze({
  remove: (path: string, options: Readonly<{ force: boolean }>) => rm(path, options),
  synchronize: syncDirectory,
})

/** Remove one file and durably persist the directory entry update. */
export async function durableUnlink(
  path: string,
  options: Readonly<{ force?: boolean }> = {},
  operations: DurableUnlinkOperations = defaultOperations,
): Promise<void> {
  await operations.remove(path, { force: options.force ?? false })
  await operations.synchronize(dirname(path))
}
