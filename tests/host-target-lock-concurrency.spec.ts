import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalSha256 } from '../src/domain/index.ts'
import {
  FileTargetLock,
  captureCurrentProcessIdentity,
  storageKey,
  type TargetLockOwner,
  writeCanonicalAtomic,
  writeCanonicalExclusive,
} from '../src/host/index.ts'
import { OperationRunner } from '../src/service/operation-runner.ts'

interface ProcessMessage {
  readonly event: string
  readonly competingResult?: string
  readonly message?: string
}

interface ProcessHarness {
  readonly child: ChildProcess
  readonly stderr: () => string
  readonly message: (event: string) => Promise<ProcessMessage>
}

const helper = resolve('tests/support/target-lock-process.ts')
const roots: string[] = []
const children = new Set<ChildProcess>()

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'extension-target-lock-'))
  roots.push(root)
  return root
}

function start(mode: 'owner' | 'recover', root: string, targetKey: string, operationId?: string): ProcessHarness {
  const child = fork(helper, [mode, root, targetKey, ...(operationId === undefined ? [] : [operationId])], {
    execArgv: ['--experimental-transform-types', '--no-warnings'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  children.add(child)
  let stderr = ''
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const queued: ProcessMessage[] = []
  const waiters = new Map<string, Array<Readonly<{
    resolve: (value: ProcessMessage) => void
    reject: (error: Error) => void
  }>>>()
  child.on('message', (value: ProcessMessage) => {
    const waiter = waiters.get(value.event)?.shift()
    if (waiter === undefined) queued.push(value)
    else waiter.resolve(value)
  })
  child.on('exit', (code, signal) => {
    children.delete(child)
    for (const pending of waiters.values()) {
      for (const waiter of pending) {
        waiter.reject(new Error(`target-lock child exited before its barrier: ${String(code ?? signal)}\n${stderr}`))
      }
    }
    waiters.clear()
  })
  return {
    child,
    stderr: () => stderr,
    message: event => {
      const index = queued.findIndex(value => value.event === event)
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]!)
      return new Promise((resolve, reject) => {
        const pending = waiters.get(event) ?? []
        pending.push({ resolve, reject })
        waiters.set(event, pending)
      })
    },
  }
}

async function waitForExit(process: ProcessHarness): Promise<void> {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    process.child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`target-lock child failed with ${String(code)}\n${process.stderr()}`))
    })
    process.child.once('error', reject)
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('cross-process target lock recovery', () => {
  it('does not reclaim another Host paused between lock acquisition and reservation persistence', async () => {
    const root = await temporaryRoot()
    const targetKey = 'skill:web:user:barrier'
    const operationId = 'operation:acquire-reservation-barrier'
    const owner = start('owner', root, targetKey, operationId)
    await owner.message('acquired')

    const recovery = start('recover', root, targetKey)
    const result = await recovery.message('recovered')
    expect(result.competingResult).toBe(`target is busy: ${targetKey}`)
    await waitForExit(recovery)

    const [held] = await new FileTargetLock(root).list()
    expect(held).toMatchObject({ targetKey, operationId })
    expect(await exists(join(root, 'lock-takeovers', storageKey(targetKey)))).toBe(false)
    expect(await exists(join(root, 'lock-quarantine', storageKey(targetKey)))).toBe(false)

    owner.child.send({ command: 'release' })
    await owner.message('released')
    await waitForExit(owner)
    expect(await new FileTargetLock(root).list()).toEqual([])
  }, 15_000)

  it('distinguishes a reused PID and prevents an old lease token from releasing the transferred lease', async () => {
    const root = await temporaryRoot()
    const targetKey = 'mcp:web:profile:pid-reuse'
    const operationId = 'operation:pid-reuse'
    const originalLock = new FileTargetLock(root)
    await originalLock.acquire(targetKey, operationId)
    const [original] = await originalLock.list()
    expect(original).toBeDefined()
    const captured = await captureCurrentProcessIdentity()
    expect(captured.birthDigest).not.toBeNull()
    const differentDigest = captured.birthDigest === `sha256:${'0'.repeat(64)}`
      ? `sha256:${'1'.repeat(64)}` as const
      : `sha256:${'0'.repeat(64)}` as const
    const reused = Object.freeze({
      ...original!,
      processIdentity: Object.freeze({ ...captured, birthDigest: differentDigest }),
    })
    await writeCanonicalAtomic(join(root, 'locks', storageKey(targetKey), 'owner.json'), reused)

    const recovery = new FileTargetLock(root)
    await expect(recovery.claimRecovery(reused)).resolves.toBe('claimed')
    const [transferred] = await recovery.list()
    expect(transferred).toMatchObject({ targetKey, operationId })
    expect(transferred!.leaseId).not.toBe(reused.leaseId)
    await expect(originalLock.release(targetKey, operationId)).rejects.toThrow('operation does not own target lock')
    await expect(recovery.release(targetKey, operationId)).resolves.toBeUndefined()
  })

  it('performs no recovery write when process-birth evidence is unknown', async () => {
    const root = await temporaryRoot()
    const targetKey = 'plugin:web:profile:unknown-owner'
    const operationId = 'operation:unknown-owner'
    const original = new FileTargetLock(root)
    await original.acquire(targetKey, operationId)
    const [held] = await original.list()
    const unknown = Object.freeze({
      ...held!,
      processIdentity: Object.freeze({ ...held!.processIdentity, birthDigest: null }),
    })
    const ownerPath = join(root, 'locks', storageKey(targetKey), 'owner.json')
    await writeCanonicalAtomic(ownerPath, unknown)
    const before = await readFile(ownerPath)

    await expect(new FileTargetLock(root).claimRecovery(unknown)).resolves.toBe('unknown')

    expect(await readFile(ownerPath)).toEqual(before)
    expect(await exists(join(root, 'lock-takeovers', storageKey(targetKey)))).toBe(false)
    expect(await exists(join(root, 'lock-quarantine', storageKey(targetKey)))).toBe(false)
  })

  it.each(['reservation', 'journal', 'consumed-plan'] as const)(
    'does not mutate a live owner or its %s recovery state',
    async durableState => {
      const root = await temporaryRoot()
      const targetKey = `plugin:web:profile:live-${durableState}`
      const operationId = `operation:live-${durableState}`
      const owner = new FileTargetLock(root)
      await owner.acquire(targetKey, operationId)
      const ownerPath = join(root, 'locks', storageKey(targetKey), 'owner.json')
      const before = await readFile(ownerPath)
      let writes = 0
      const operations = {
        list: () => Promise.resolve(durableState === 'journal' ? [{
          projection: { operationId, targetKey, phase: 'applying' },
        }] : []),
        listReservations: () => Promise.resolve(durableState === 'reservation' ? [{
          schemaVersion: 1,
          operationId,
          planHash: `sha256:${'0'.repeat(64)}`,
          targetKey,
          beforeDigest: `sha256:${'1'.repeat(64)}`,
          reservedAtMs: 1,
        }] : []),
        deleteReservation: () => { writes += 1; return Promise.resolve() },
        persist: () => { writes += 1; return Promise.reject(new Error('live journal must not be persisted')) },
      }
      const plans = {
        list: () => Promise.resolve(durableState === 'consumed-plan' ? [{
          status: 'consumed',
          authorization: { operationId, targetKey },
          plan: { content: { targetKey } },
        }] : []),
      }
      const recoveryLocks = new FileTargetLock(root)
      const runner = new OperationRunner(
        {} as never,
        plans as never,
        operations as never,
        recoveryLocks,
        {} as never,
        {} as never,
        {} as never,
      )

      await expect(runner.recover(new AbortController().signal)).resolves.toBeUndefined()

      expect(writes).toBe(0)
      expect(await readFile(ownerPath)).toEqual(before)
      expect(await exists(join(root, 'lock-takeovers', storageKey(targetKey)))).toBe(false)
      expect(await exists(join(root, 'lock-quarantine', storageKey(targetKey)))).toBe(false)
      await owner.release(targetKey, operationId)
    },
  )

  it('re-reads durable operation authority only after transferring a dead target lease', async () => {
    const root = await temporaryRoot()
    const targetKey = 'skill:web:user:fresh-authority'
    const operationId = 'operation:fresh-authority'
    const originalLock = new FileTargetLock(root)
    await originalLock.acquire(targetKey, operationId)
    const [source] = await originalLock.list()
    expect(source?.processIdentity.birthDigest).not.toBeNull()
    const dead = Object.freeze({
      ...source!,
      processIdentity: Object.freeze({
        ...source!.processIdentity,
        birthDigest: source!.processIdentity.birthDigest === `sha256:${'0'.repeat(64)}`
          ? `sha256:${'1'.repeat(64)}` as const
          : `sha256:${'0'.repeat(64)}` as const,
      }),
    })
    await writeCanonicalAtomic(join(root, 'locks', storageKey(targetKey), 'owner.json'), dead)

    class ObservedRecoveryLock extends FileTargetLock {
      claimed = false

      override async claimRecovery(owner: TargetLockOwner) {
        const result = await super.claimRecovery(owner)
        if (result === 'claimed' || result === 'owned') this.claimed = true
        return result
      }
    }
    const locks = new ObservedRecoveryLock(root)
    let reservationReads = 0
    let writes = 0
    const reservation = Object.freeze({
      schemaVersion: 1,
      operationId,
      planHash: `sha256:${'2'.repeat(64)}`,
      targetKey,
      beforeDigest: `sha256:${'3'.repeat(64)}`,
      reservedAtMs: 1,
    })
    const operations = {
      list: () => Promise.resolve([]),
      listReservations: () => {
        if (!locks.claimed) return Promise.resolve([])
        reservationReads += 1
        return Promise.resolve(reservationReads === 1 ? [reservation] : [])
      },
      deleteReservation: () => { writes += 1; return Promise.resolve() },
      persist: () => { writes += 1; return Promise.resolve({}) },
    }
    const runner = new OperationRunner(
      {} as never,
      { list: () => Promise.resolve([]) } as never,
      operations as never,
      locks,
      {} as never,
      {} as never,
      {} as never,
    )

    await expect(runner.recover(new AbortController().signal)).resolves.toBeUndefined()

    const [transferred] = await locks.list()
    expect(reservationReads).toBe(2)
    expect(writes).toBe(0)
    expect(transferred).toMatchObject({ targetKey, operationId })
    expect(transferred!.leaseId).not.toBe(dead.leaseId)
    await locks.release(targetKey, operationId)
  })

  it.each(['canonical', 'retired'] as const)(
    'continues a dead claimant takeover from its exact quarantine directory with a %s gate',
    async gatePlacement => {
    const root = await temporaryRoot()
    const targetKey = 'skill:web:user:quarantine-continuation'
    const operationId = 'operation:quarantine-continuation'
    const ownerProcess = start('owner', root, targetKey, operationId)
    await ownerProcess.message('acquired')
    const [source] = await new FileTargetLock(root).list()
    expect(source).toBeDefined()
    const crashed = new Promise<void>(resolve => { ownerProcess.child.once('exit', () => resolve()) })
    ownerProcess.child.send({ command: 'crash' })
    await crashed

    const quarantineId = `quarantine:${randomUUID()}`
    const takeoverId = `takeover:${randomUUID()}`
    const takeoverRoot = join(root, 'lock-takeovers')
    const quarantineRoot = join(root, 'lock-quarantine', storageKey(targetKey))
    const quarantine = join(quarantineRoot, quarantineId.slice('quarantine:'.length))
    const gatePath = gatePlacement === 'canonical'
      ? join(takeoverRoot, storageKey(targetKey))
      : join(takeoverRoot, `.retired-${randomUUID()}`)
    await mkdir(gatePath, { recursive: true, mode: 0o700 })
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
    await rename(join(root, 'locks', storageKey(targetKey)), quarantine)
    await writeCanonicalExclusive(join(gatePath, 'record.json'), {
      schemaVersion: 1,
      targetKey,
      operationId,
      sourceLeaseId: source!.leaseId,
      sourceOwnerDigest: canonicalSha256(source),
      quarantineId,
      takeoverId,
      claimantInstanceId: source!.hostInstanceId,
      claimantProcessIdentity: source!.processIdentity,
      claimedAtMs: Date.now(),
    })

    const recovery = new FileTargetLock(root)
    await expect(recovery.resumeTakeovers()).resolves.toHaveLength(1)
    const [transferred] = await recovery.list()
    expect(transferred).toMatchObject({ targetKey, operationId })
    expect(transferred!.leaseId).not.toBe(source!.leaseId)
    expect(await exists(join(root, 'lock-takeovers', storageKey(targetKey)))).toBe(false)
    await expect(readdir(takeoverRoot)).resolves.toEqual([])
    expect(await exists(join(root, 'lock-quarantine', storageKey(targetKey)))).toBe(false)
    await recovery.release(targetKey, operationId)
    },
    15_000,
  )
})
