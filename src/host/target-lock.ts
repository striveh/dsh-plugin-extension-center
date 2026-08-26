import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readCanonicalOptional, storageKey, writeCanonicalExclusive } from './files.ts'

interface LockOwner {
  readonly schemaVersion: 1
  readonly targetKey: string
  readonly operationId: string
  readonly acquiredAtMs: number
}

/** Durable one-target lease built from atomic directory installation. */
export class FileTargetLock {
  constructor(private readonly root: string) {}

  /** Acquire one exact target, failing if any operation already owns it. */
  async acquire(targetKey: string, operationId: string, atMs = Date.now()): Promise<void> {
    const locks = join(this.root, 'locks')
    await mkdir(locks, { recursive: true, mode: 0o700 })
    const destination = join(locks, storageKey(targetKey))
    const temporary = join(locks, `.lock-${randomUUID()}`)
    await mkdir(temporary, { mode: 0o700 })
    const owner: LockOwner = { schemaVersion: 1, targetKey, operationId, acquiredAtMs: atMs }
    try {
      await writeCanonicalExclusive(join(temporary, 'owner.json'), owner)
      await rename(temporary, destination)
    } catch (error: unknown) {
      await rm(temporary, { recursive: true, force: true })
      if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new Error(`target is busy: ${targetKey}`)
      }
      throw error
    }
  }

  /** Release only the exact lease owner. */
  async release(targetKey: string, operationId: string): Promise<void> {
    const directory = join(this.root, 'locks', storageKey(targetKey))
    const owner = await this.readOwner(directory)
    if (owner === undefined || owner.targetKey !== targetKey || owner.operationId !== operationId) {
      throw new Error(`operation does not own target lock: ${operationId}`)
    }
    await rm(directory, { recursive: true })
  }

  /** Enumerate complete durable leases for startup recovery. */
  async list(): Promise<readonly LockOwner[]> {
    const locks = join(this.root, 'locks')
    let entries
    try {
      entries = await readdir(locks, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const values: LockOwner[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue
      const owner = await this.readOwner(join(locks, entry.name))
      if (owner === undefined || storageKey(owner.targetKey) !== entry.name) throw new Error('target lock owner is corrupt')
      values.push(owner)
    }
    return Object.freeze(values)
  }

  private async readOwner(directory: string): Promise<LockOwner | undefined> {
    const value = await readCanonicalOptional(join(directory, 'owner.json'))
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('target lock owner is invalid')
    const owner = value as Partial<LockOwner>
    if (
      owner.schemaVersion !== 1
      || typeof owner.targetKey !== 'string'
      || typeof owner.operationId !== 'string'
      || !Number.isSafeInteger(owner.acquiredAtMs)
    ) throw new Error('target lock owner fields are invalid')
    return owner as LockOwner
  }
}
