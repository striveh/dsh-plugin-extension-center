import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalSha256 } from '../domain/index.ts'
import {
  readCanonicalOptional,
  storageKey,
  syncDirectory,
  writeCanonicalExclusive,
} from './files.ts'
import {
  captureCurrentProcessIdentity,
  decodeProcessIdentity,
  inspectProcessIdentity,
  type ProcessIdentity,
} from './process-identity.ts'

/** Immutable durable owner installed with one exact target lock. */
export interface TargetLockOwner {
  readonly schemaVersion: 2
  readonly targetKey: string
  readonly operationId: string
  readonly leaseId: string
  readonly hostInstanceId: string
  readonly processIdentity: ProcessIdentity
  readonly acquiredAtMs: number
}

interface HeldClaim {
  readonly owner: TargetLockOwner
}

interface TakeoverRecord {
  readonly schemaVersion: 1
  readonly targetKey: string
  readonly operationId: string
  readonly sourceLeaseId: string
  readonly sourceOwnerDigest: `sha256:${string}`
  readonly quarantineId: string
  readonly takeoverId: string
  readonly claimantInstanceId: string
  readonly claimantProcessIdentity: ProcessIdentity
  readonly claimedAtMs: number
}

interface TakeoverEntry {
  readonly path: string
  readonly canonical: boolean
  readonly record: TakeoverRecord
}

/** Durable one-target lease built from atomic directory installation. */
export class FileTargetLock {
  private readonly hostInstanceId = `host:${randomUUID()}`
  private processIdentity: Promise<ProcessIdentity> | null = null
  private readonly claims = new Map<string, HeldClaim>()

  constructor(private readonly root: string) {}

  /** Acquire one exact target, failing if any operation or recovery gate already owns it. */
  async acquire(targetKey: string, operationId: string, atMs = Date.now()): Promise<void> {
    const locks = this.locksRoot()
    await mkdir(locks, { recursive: true, mode: 0o700 })
    await this.assertNoRecoveryGate(targetKey)
    const destination = this.lockPath(targetKey)
    const temporary = join(locks, `.lock-${randomUUID()}`)
    const owner = await this.newOwner(targetKey, operationId, atMs)
    await mkdir(temporary, { mode: 0o700 })
    let installed = false
    try {
      await writeCanonicalExclusive(join(temporary, 'owner.json'), owner)
      await rename(temporary, destination)
      installed = true
      await syncDirectory(locks)
      try {
        await this.assertNoRecoveryGate(targetKey)
      } catch (error: unknown) {
        const raced = await this.readOwner(destination)
        if (raced !== undefined && this.sameOwner(raced, owner)) {
          await rm(destination, { recursive: true })
          await syncDirectory(locks)
        }
        throw error
      }
      this.claims.set(operationId, Object.freeze({ owner }))
    } catch (error: unknown) {
      await rm(temporary, { recursive: true, force: true })
      if (installed) throw error
      if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new Error(`target is busy: ${targetKey}`)
      }
      throw error
    }
  }

  /** Release only the complete lease token held by this lock instance. */
  async release(targetKey: string, operationId: string): Promise<void> {
    const directory = this.lockPath(targetKey)
    const owner = await this.readOwner(directory)
    const claim = this.claims.get(operationId)
    if (owner === undefined || claim === undefined || owner.targetKey !== targetKey || owner.operationId !== operationId
      || !this.sameOwner(owner, claim.owner)) {
      throw new Error(`operation does not own target lock: ${operationId}`)
    }
    await this.assertNoRecoveryGate(targetKey)
    await rm(directory, { recursive: true })
    await syncDirectory(this.locksRoot())
    this.claims.delete(operationId)
  }

  /** Enumerate complete durable leases for startup recovery. */
  async list(): Promise<readonly TargetLockOwner[]> {
    const locks = this.locksRoot()
    let entries
    try {
      entries = await readdir(locks, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const values: TargetLockOwner[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/u.test(entry.name)) continue
      const owner = await this.readOwner(join(locks, entry.name))
      if (owner === undefined || storageKey(owner.targetKey) !== entry.name) throw new Error('target lock owner is corrupt')
      values.push(owner)
    }
    return Object.freeze(values)
  }

  /** Resume crash-interrupted takeovers before ordinary journal recovery enumerates locks. */
  async resumeTakeovers(): Promise<readonly TargetLockOwner[]> {
    const recovered: TargetLockOwner[] = []
    const entries = await this.listTakeovers()
    const blockedTargets = new Set<string>()
    for (const entry of entries) {
      if (await inspectProcessIdentity(entry.record.claimantProcessIdentity) !== 'dead') {
        blockedTargets.add(entry.record.targetKey)
      }
    }
    for (const entry of entries) {
      const record = entry.record
      if (blockedTargets.has(record.targetKey)) continue
      const destinationOwner = await this.readOwner(this.lockPath(record.targetKey))
      if (destinationOwner !== undefined) {
        const result = await this.claimRecovery(destinationOwner)
        const installed = this.claims.get(destinationOwner.operationId)?.owner
        if (result === 'claimed' && installed !== undefined) recovered.push(installed)
        continue
      }
      const quarantined = await this.quarantineOwnerForTakeover(record)
      if (quarantined === null) {
        await this.removeTakeoverEntry(entry)
        continue
      }
      const initialStatus = await inspectProcessIdentity(quarantined.owner.processIdentity)
      if (initialStatus !== 'dead') continue
      const gate = await this.acquireTakeoverGate(quarantined.owner)
      if (gate === null) continue
      const reread = await this.readOwner(quarantined.path)
      if (reread === undefined || !this.sameOwner(reread, quarantined.owner)) {
        throw new Error(`target lock quarantine changed during takeover: ${record.targetKey}`)
      }
      const secondStatus = await inspectProcessIdentity(reread.processIdentity)
      if (secondStatus !== 'dead') continue
      const finalOwner = await this.readOwner(quarantined.path)
      if (finalOwner === undefined || !this.sameOwner(finalOwner, reread)) {
        throw new Error(`target lock quarantine changed during takeover: ${record.targetKey}`)
      }
      const finalStatus = await inspectProcessIdentity(finalOwner.processIdentity)
      if (finalStatus !== 'dead') continue
      const transferred = await this.installTransferredOwner(quarantined.owner)
      await this.finishTakeover(gate, record.targetKey)
      this.claims.set(transferred.operationId, Object.freeze({ owner: transferred }))
      recovered.push(transferred)
    }
    return Object.freeze(recovered)
  }

  /** Claim one unchanged dead owner's operation by installing a new exact lease. */
  async claimRecovery(owner: TargetLockOwner): Promise<'claimed' | 'owned' | 'live' | 'unknown'> {
    const local = this.claims.get(owner.operationId)
    if (local !== undefined && this.sameOwner(local.owner, owner)) return 'owned'
    const initialStatus = await inspectProcessIdentity(owner.processIdentity)
    if (initialStatus !== 'dead') return initialStatus === 'alive' ? 'live' : 'unknown'
    const gate = await this.acquireTakeoverGate(owner)
    if (gate === null) return 'unknown'
    const current = await this.readOwner(this.lockPath(owner.targetKey))
    if (current === undefined || !this.sameOwner(current, owner)) return 'unknown'
    const secondStatus = await inspectProcessIdentity(current.processIdentity)
    if (secondStatus !== 'dead') {
      return secondStatus === 'alive' ? 'live' : 'unknown'
    }
    const quarantine = await this.quarantineOwner(gate, current)
    if (await inspectProcessIdentity(quarantine.owner.processIdentity) !== 'dead') return 'unknown'
    const transferred = await this.installTransferredOwner(quarantine.owner)
    await this.finishTakeover(gate, owner.targetKey)
    this.claims.set(owner.operationId, Object.freeze({ owner: transferred }))
    return 'claimed'
  }

  /** Reclaim only an unchanged orphan whose original process identity is proven dead. */
  async reclaimOrphan(owner: TargetLockOwner): Promise<'reclaimed' | 'live' | 'unknown'> {
    const claim = await this.claimRecovery(owner)
    if (claim === 'live' || claim === 'owned') return 'live'
    if (claim === 'unknown') return 'unknown'
    await this.release(owner.targetKey, owner.operationId)
    return 'reclaimed'
  }

  private async newOwner(targetKey: string, operationId: string, acquiredAtMs: number): Promise<TargetLockOwner> {
    return Object.freeze({
      schemaVersion: 2,
      targetKey,
      operationId,
      leaseId: `lease:${randomUUID()}`,
      hostInstanceId: this.hostInstanceId,
      processIdentity: await this.currentProcessIdentity(),
      acquiredAtMs,
    })
  }

  private async installTransferredOwner(source: TargetLockOwner): Promise<TargetLockOwner> {
    const locks = this.locksRoot()
    const temporary = join(locks, `.lock-${randomUUID()}`)
    const transferred = await this.newOwner(source.targetKey, source.operationId, Date.now())
    await mkdir(temporary, { mode: 0o700 })
    try {
      await writeCanonicalExclusive(join(temporary, 'owner.json'), transferred)
      await rename(temporary, this.lockPath(source.targetKey))
      await syncDirectory(locks)
    } catch (error: unknown) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
    const installed = await this.readOwner(this.lockPath(source.targetKey))
    if (installed === undefined || !this.sameOwner(installed, transferred)) {
      throw new Error(`target lock takeover is incomplete: ${source.targetKey}`)
    }
    return transferred
  }

  private async acquireTakeoverGate(owner: TargetLockOwner): Promise<TakeoverRecord | null> {
    const root = this.takeoversRoot()
    await mkdir(root, { recursive: true, mode: 0o700 })
    const destination = this.takeoverPath(owner.targetKey)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await this.readTakeover(destination)
      if (existing !== undefined) {
        const interrupted = existing.claimantInstanceId === owner.hostInstanceId
          && this.sameProcessIdentity(existing.claimantProcessIdentity, owner.processIdentity)
        const sourceMatches = existing.sourceLeaseId === owner.leaseId
          && existing.sourceOwnerDigest === canonicalSha256(owner)
        if (existing.targetKey !== owner.targetKey || existing.operationId !== owner.operationId
          || !sourceMatches && !interrupted) {
          throw new Error('target lock takeover gate does not bind its current owner')
        }
        if (await inspectProcessIdentity(existing.claimantProcessIdentity) !== 'dead') return null
        const retired = join(root, `.retired-${randomUUID()}`)
        try {
          await rename(destination, retired)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        await syncDirectory(root)
        try {
          const record = await this.installTakeoverGate(
            root,
            destination,
            owner,
            sourceMatches ? existing.quarantineId : undefined,
          )
          await this.removeExactTakeoverPath(retired, existing)
          return record
        } catch (error: unknown) {
          if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
          throw error
        }
      }
      try {
        return await this.installTakeoverGate(root, destination, owner)
      } catch (error: unknown) {
        if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
        throw error
      }
    }
    return null
  }

  private async quarantineOwner(
    gate: TakeoverRecord,
    owner: TargetLockOwner,
  ): Promise<Readonly<{ path: string; owner: TargetLockOwner }>> {
    const targetRoot = this.quarantineTargetRoot(owner.targetKey)
    await mkdir(targetRoot, { recursive: true, mode: 0o700 })
    const path = join(targetRoot, gate.quarantineId.slice('quarantine:'.length))
    try {
      await rename(this.lockPath(owner.targetKey), path)
      await syncDirectory(this.locksRoot())
      await syncDirectory(targetRoot)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`target lock changed during takeover: ${owner.targetKey}`)
      }
      throw error
    }
    const moved = await this.readOwner(path)
    if (moved === undefined || !this.sameOwner(moved, owner)) {
      throw new Error(`target lock quarantine does not bind its owner: ${owner.targetKey}`)
    }
    return Object.freeze({ path, owner: moved })
  }

  private async finishTakeover(gate: TakeoverRecord, targetKey: string): Promise<void> {
    const current = await this.readTakeover(this.takeoverPath(targetKey))
    if (current === undefined || !this.sameTakeover(current, gate)) {
      throw new Error(`target lock takeover ownership changed: ${targetKey}`)
    }
    await rm(this.quarantineTargetRoot(targetKey), { recursive: true, force: true })
    await mkdir(this.quarantineRoot(), { recursive: true, mode: 0o700 })
    await syncDirectory(this.quarantineRoot())
    await rm(this.takeoverPath(targetKey), { recursive: true })
    await this.removeRetiredTakeovers(targetKey)
    await syncDirectory(this.takeoversRoot())
  }

  private async assertNoRecoveryGate(targetKey: string): Promise<void> {
    if (await this.pathExists(this.takeoverPath(targetKey)) || await this.hasQuarantine(targetKey)) {
      throw new Error(`target is busy: ${targetKey}`)
    }
  }

  private async hasQuarantine(targetKey: string): Promise<boolean> {
    try {
      return (await readdir(this.quarantineTargetRoot(targetKey))).length > 0
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async quarantineOwnerForTakeover(
    takeover: TakeoverRecord,
  ): Promise<Readonly<{ path: string; owner: TargetLockOwner }> | null> {
    const path = join(
      this.quarantineTargetRoot(takeover.targetKey),
      takeover.quarantineId.slice('quarantine:'.length),
    )
    const owner = await this.readOwner(path)
    if (owner === undefined) return null
    if (owner.targetKey !== takeover.targetKey || owner.operationId !== takeover.operationId
      || owner.leaseId !== takeover.sourceLeaseId || canonicalSha256(owner) !== takeover.sourceOwnerDigest) {
      throw new Error(`target lock quarantine does not bind its takeover: ${takeover.targetKey}`)
    }
    return Object.freeze({ path, owner })
  }

  private async listTakeovers(): Promise<readonly TakeoverEntry[]> {
    const root = this.takeoversRoot()
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const output: TakeoverEntry[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const canonical = /^[0-9a-f]{64}$/u.test(entry.name)
      const retired = /^\.retired-[0-9a-f-]{36}$/u.test(entry.name)
      if (!entry.isDirectory() || !canonical && !retired) continue
      const path = join(root, entry.name)
      const record = await this.readTakeover(path)
      if (record === undefined || canonical && storageKey(record.targetKey) !== entry.name) {
        throw new Error('target lock takeover gate is corrupt')
      }
      output.push(Object.freeze({ path, canonical, record }))
    }
    return Object.freeze(output)
  }

  private async installTakeoverGate(
    root: string,
    destination: string,
    owner: TargetLockOwner,
    quarantineId = `quarantine:${randomUUID()}`,
  ): Promise<TakeoverRecord> {
    const temporary = join(root, `.takeover-${randomUUID()}`)
    const record: TakeoverRecord = Object.freeze({
      schemaVersion: 1,
      targetKey: owner.targetKey,
      operationId: owner.operationId,
      sourceLeaseId: owner.leaseId,
      sourceOwnerDigest: canonicalSha256(owner),
      quarantineId,
      takeoverId: `takeover:${randomUUID()}`,
      claimantInstanceId: this.hostInstanceId,
      claimantProcessIdentity: await this.currentProcessIdentity(),
      claimedAtMs: Date.now(),
    })
    await mkdir(temporary, { mode: 0o700 })
    try {
      await writeCanonicalExclusive(join(temporary, 'record.json'), record)
      await rename(temporary, destination)
      await syncDirectory(root)
      return record
    } catch (error: unknown) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }

  private async removeTakeoverEntry(entry: TakeoverEntry): Promise<void> {
    await this.removeExactTakeoverPath(entry.path, entry.record)
  }

  private async removeExactTakeoverPath(path: string, expected: TakeoverRecord): Promise<void> {
    const current = await this.readTakeover(path)
    if (current === undefined) return
    if (!this.sameTakeover(current, expected)) throw new Error('target lock retired takeover ownership changed')
    await rm(path, { recursive: true })
    await syncDirectory(this.takeoversRoot())
  }

  private async removeRetiredTakeovers(targetKey: string): Promise<void> {
    const root = this.takeoversRoot()
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\.retired-[0-9a-f-]{36}$/u.test(entry.name)) continue
      const path = join(root, entry.name)
      const record = await this.readTakeover(path)
      if (record?.targetKey === targetKey) await this.removeExactTakeoverPath(path, record)
    }
  }

  private async readTakeover(path: string): Promise<TakeoverRecord | undefined> {
    const value = await readCanonicalOptional(join(path, 'record.json'))
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [
        'claimantInstanceId', 'claimantProcessIdentity', 'claimedAtMs', 'operationId', 'quarantineId', 'schemaVersion',
        'sourceLeaseId', 'sourceOwnerDigest', 'takeoverId', 'targetKey',
      ].join(',')) throw new Error('target lock takeover record is invalid')
    const record = value as Partial<TakeoverRecord>
    if (record.schemaVersion !== 1 || typeof record.targetKey !== 'string' || typeof record.operationId !== 'string'
      || typeof record.sourceLeaseId !== 'string' || !/^lease:[0-9a-f-]{36}$/u.test(record.sourceLeaseId)
      || typeof record.sourceOwnerDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.sourceOwnerDigest)
      || typeof record.quarantineId !== 'string' || !/^quarantine:[0-9a-f-]{36}$/u.test(record.quarantineId)
      || typeof record.takeoverId !== 'string' || !/^takeover:[0-9a-f-]{36}$/u.test(record.takeoverId)
      || typeof record.claimantInstanceId !== 'string' || !/^host:[0-9a-f-]{36}$/u.test(record.claimantInstanceId)
      || !Number.isSafeInteger(record.claimedAtMs)) throw new Error('target lock takeover record fields are invalid')
    return Object.freeze({
      schemaVersion: 1,
      targetKey: record.targetKey,
      operationId: record.operationId,
      sourceLeaseId: record.sourceLeaseId,
      sourceOwnerDigest: record.sourceOwnerDigest as `sha256:${string}`,
      quarantineId: record.quarantineId,
      takeoverId: record.takeoverId,
      claimantInstanceId: record.claimantInstanceId,
      claimantProcessIdentity: decodeProcessIdentity(record.claimantProcessIdentity, 'target lock takeover claimant'),
      claimedAtMs: record.claimedAtMs as number,
    })
  }

  private currentProcessIdentity(): Promise<ProcessIdentity> {
    this.processIdentity ??= captureCurrentProcessIdentity()
    return this.processIdentity
  }

  private sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
    return left.schemaVersion === right.schemaVersion && left.pid === right.pid && left.platform === right.platform
      && left.machineDigest === right.machineDigest && left.bootDigest === right.bootDigest
      && left.birthDigest === right.birthDigest
  }

  private sameOwner(left: TargetLockOwner, right: TargetLockOwner): boolean {
    return left.schemaVersion === right.schemaVersion && left.targetKey === right.targetKey
      && left.operationId === right.operationId && left.leaseId === right.leaseId
      && left.hostInstanceId === right.hostInstanceId && left.acquiredAtMs === right.acquiredAtMs
      && this.sameProcessIdentity(left.processIdentity, right.processIdentity)
  }

  private sameTakeover(left: TakeoverRecord, right: TakeoverRecord): boolean {
    return left.takeoverId === right.takeoverId && canonicalSha256(left) === canonicalSha256(right)
  }

  private async readOwner(directory: string): Promise<TargetLockOwner | undefined> {
    const value = await readCanonicalOptional(join(directory, 'owner.json'))
    if (value === undefined) return undefined
    if (typeof value === 'object' && value !== null && !Array.isArray(value)
      && (value as { schemaVersion?: unknown }).schemaVersion === 1) {
      throw new Error('target lock has no process-birth evidence; manual recovery is required')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).sort().join(',')
        !== 'acquiredAtMs,hostInstanceId,leaseId,operationId,processIdentity,schemaVersion,targetKey') {
      throw new Error('target lock owner is invalid')
    }
    const owner = value as Partial<TargetLockOwner>
    if (owner.schemaVersion !== 2 || typeof owner.targetKey !== 'string' || typeof owner.operationId !== 'string'
      || typeof owner.leaseId !== 'string' || !/^lease:[0-9a-f-]{36}$/u.test(owner.leaseId)
      || typeof owner.hostInstanceId !== 'string' || !/^host:[0-9a-f-]{36}$/u.test(owner.hostInstanceId)
      || !Number.isSafeInteger(owner.acquiredAtMs)) throw new Error('target lock owner fields are invalid')
    return Object.freeze({
      schemaVersion: 2,
      targetKey: owner.targetKey,
      operationId: owner.operationId,
      leaseId: owner.leaseId,
      hostInstanceId: owner.hostInstanceId,
      processIdentity: decodeProcessIdentity(owner.processIdentity, 'target lock owner'),
      acquiredAtMs: owner.acquiredAtMs as number,
    })
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private locksRoot(): string { return join(this.root, 'locks') }
  private takeoversRoot(): string { return join(this.root, 'lock-takeovers') }
  private quarantineRoot(): string { return join(this.root, 'lock-quarantine') }
  private lockPath(targetKey: string): string { return join(this.locksRoot(), storageKey(targetKey)) }
  private takeoverPath(targetKey: string): string { return join(this.takeoversRoot(), storageKey(targetKey)) }
  private quarantineTargetRoot(targetKey: string): string { return join(this.quarantineRoot(), storageKey(targetKey)) }
}
