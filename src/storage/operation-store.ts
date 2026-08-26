import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  link,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  canonicalJson,
  ExtensionDomainError,
  immutableJsonClone,
  type Sha256Digest,
} from '../domain/index.ts'
import {
  operationJournalCheckpoint,
  verifyOperationJournal,
  type JournalCheckpoint,
  type OperationJournal,
  type OperationJournalEvent,
  type OperationProjection,
  type OperationReceipt,
} from '../operations/index.ts'

const STORE_SCHEMA_VERSION = 1 as const
const CURRENT_FILENAME = 'CURRENT.json'
const EVENT_FILENAME = /^(\d{10})-([0-9a-f]{64})\.json$/

interface CurrentPointer {
  readonly schemaVersion: typeof STORE_SCHEMA_VERSION
  readonly operationId: string
  readonly targetKey: string
  readonly eventCount: number
  readonly headDigest: Sha256Digest
}

/** Durable zero-mutation reservation spanning plan consumption and the first journal event. */
export interface OperationReservation {
  readonly schemaVersion: typeof STORE_SCHEMA_VERSION
  readonly operationId: string
  readonly planHash: Sha256Digest
  readonly targetKey: string
  readonly beforeDigest: Sha256Digest
  readonly reservedAtMs: number
}

/** Loaded durable operation plus whether an interrupted pointer advance was repaired. */
export interface LoadedOperation {
  readonly journal: OperationJournal
  readonly projection: OperationProjection
  readonly recovered: boolean
}

/** Receipt projected from a verified durable operation. */
export interface StoredReceipt {
  readonly operationId: string
  readonly targetKey: string
  readonly receipt: OperationReceipt
}

function operationDirectoryName(operationId: string): string {
  return createHash('sha256').update(operationId).digest('hex')
}

function eventFilename(event: OperationJournalEvent): string {
  return `${String(event.sequence).padStart(10, '0')}-${event.digest.slice('sha256:'.length)}.json`
}

function storageFailure(code: 'journal-corrupt' | 'journal-truncated', message: string, _cause?: unknown): never {
  throw new ExtensionDomainError(code, message)
}

function parseJson(text: string, subject: string): unknown {
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
    storageFailure('journal-corrupt', `${subject} is not one complete JSON record`)
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (`${canonicalJson(parsed)}\n` !== text) {
      storageFailure('journal-corrupt', `${subject} is not canonical JSON`)
    }
    return parsed
  } catch (error: unknown) {
    if (error instanceof ExtensionDomainError) throw error
    storageFailure('journal-corrupt', `${subject} is not valid JSON`, error)
  }
}

function decodePointer(value: unknown): CurrentPointer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    storageFailure('journal-corrupt', 'operation pointer must be an object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const expected = ['eventCount', 'headDigest', 'operationId', 'schemaVersion', 'targetKey']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    storageFailure('journal-corrupt', 'operation pointer fields are invalid')
  }
  if (
    record.schemaVersion !== STORE_SCHEMA_VERSION
    || typeof record.operationId !== 'string'
    || record.operationId.length === 0
    || typeof record.targetKey !== 'string'
    || record.targetKey.length === 0
    || !Number.isSafeInteger(record.eventCount)
    || (record.eventCount as number) < 1
    || typeof record.headDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(record.headDigest)
  ) {
    storageFailure('journal-corrupt', 'operation pointer values are invalid')
  }
  return immutableJsonClone(record) as unknown as CurrentPointer
}

function decodeReservation(value: unknown, expectedOperationId?: string): OperationReservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    storageFailure('journal-corrupt', 'operation reservation must be an object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const expected = ['beforeDigest', 'operationId', 'planHash', 'reservedAtMs', 'schemaVersion', 'targetKey']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    storageFailure('journal-corrupt', 'operation reservation fields are invalid')
  }
  if (
    record.schemaVersion !== STORE_SCHEMA_VERSION
    || typeof record.operationId !== 'string'
    || record.operationId.length === 0
    || record.operationId.length > 512
    || (expectedOperationId !== undefined && record.operationId !== expectedOperationId)
    || typeof record.planHash !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(record.planHash)
    || typeof record.targetKey !== 'string'
    || record.targetKey.length === 0
    || record.targetKey.length > 1_024
    || typeof record.beforeDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(record.beforeDigest)
    || !Number.isSafeInteger(record.reservedAtMs)
    || (record.reservedAtMs as number) < 0
  ) {
    storageFailure('journal-corrupt', 'operation reservation values are invalid')
  }
  return immutableJsonClone(record) as unknown as OperationReservation
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.tmp-${randomUUID()}`)
  try {
    await writeExclusive(temporary, content)
    await rename(temporary, path)
    await syncDirectory(directory)
  } catch (error: unknown) {
    try {
      await unlink(temporary)
    } catch (cleanupError: unknown) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
    }
    throw error
  }
}

function pointerFor(journal: OperationJournal): CurrentPointer {
  const checkpoint = operationJournalCheckpoint(journal)
  return immutableJsonClone({
    schemaVersion: STORE_SCHEMA_VERSION,
    operationId: journal.operationId,
    targetKey: journal.targetKey,
    eventCount: checkpoint.eventCount,
    headDigest: checkpoint.headDigest,
  }) as unknown as CurrentPointer
}

function journalPrefixMatches(left: OperationJournal, right: OperationJournal): boolean {
  if (left.operationId !== right.operationId || left.targetKey !== right.targetKey) return false
  if (left.events.length > right.events.length) return false
  return left.events.every((event, index) => event.digest === right.events[index]?.digest)
}

/**
 * Durable content-addressed operation journal store.
 *
 * Every event is installed once under its sequence and digest. `CURRENT.json`
 * advances atomically after the event reaches disk. A valid event left beyond
 * the pointer by process death is recovered on the next load; a missing,
 * reordered, or altered event is rejected.
 */
export class FileOperationStore {
  private readonly queues = new Map<string, Promise<void>>()

  /**
   * Create a store below one center-owned data directory.
   * @param root Exact durable data directory.
   */
  constructor(private readonly root: string) {}

  /** Exact Center root passed to the pinned standalone recovery executable. */
  centerRoot(): string {
    return this.root
  }

  /** Persist the exact pre-consumption reservation before the plan becomes single-use. */
  async reserve(value: OperationReservation): Promise<void> {
    const reservation = decodeReservation(value, value.operationId)
    const directory = join(this.root, 'operation-reservations')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = this.reservationPath(reservation.operationId)
    const content = `${canonicalJson(reservation)}\n`
    const temporary = join(directory, `.reservation-${randomUUID()}`)
    try {
      await writeExclusive(temporary, content)
      try {
        await link(temporary, path)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const prior = await readFile(path, 'utf8')
        if (prior !== content) storageFailure('journal-corrupt', 'operation reservation identity was reused')
      }
      await unlink(temporary)
      await syncDirectory(directory)
    } catch (error: unknown) {
      try {
        await unlink(temporary)
      } catch (cleanupError: unknown) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
      }
      throw error
    }
  }

  /** Load one exact reservation, if plan consumption has not yet crossed into a journal. */
  async loadReservation(operationId: string): Promise<OperationReservation | undefined> {
    const text = await readOptional(this.reservationPath(operationId))
    return text === undefined
      ? undefined
      : decodeReservation(parseJson(text, `operation ${operationId} reservation`), operationId)
  }

  /** Enumerate every strict reservation in deterministic operation-id order. */
  async listReservations(): Promise<readonly OperationReservation[]> {
    const directory = join(this.root, 'operation-reservations')
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const output: OperationReservation[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && /^\.reservation-[0-9a-f-]{36}$/.test(entry.name)) continue
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
        storageFailure('journal-corrupt', 'operation reservation directory contains an unexpected record')
      }
      const parsed = parseJson(await readFile(join(directory, entry.name), 'utf8'), `operation reservation ${entry.name}`)
      const reservation = decodeReservation(parsed)
      if (`${operationDirectoryName(reservation.operationId)}.json` !== entry.name) {
        storageFailure('journal-corrupt', 'operation reservation path does not bind its identity')
      }
      output.push(reservation)
    }
    return Object.freeze(output.sort((left, right) => left.operationId.localeCompare(right.operationId)))
  }

  /** Delete only the exact durable reservation after a journal or safe cancellation is durable. */
  async deleteReservation(operationId: string): Promise<void> {
    const path = this.reservationPath(operationId)
    const current = await this.loadReservation(operationId)
    if (current === undefined) return
    await rm(path)
    await syncDirectory(dirname(path))
  }

  /**
   * Persist exactly one new logical journal event.
   * @param journal Verified journal whose prior prefix is already durable, or its opening event.
   * @returns Durable head checkpoint after the pointer advance.
   */
  persist(journal: OperationJournal): Promise<JournalCheckpoint> {
    verifyOperationJournal(journal)
    return this.serialize(journal.operationId, async () => {
      const directory = this.operationDirectory(journal.operationId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const existing = await this.loadUnlocked(journal.operationId, false)
      const durableLength = existing?.journal.events.length ?? 0
      if (journal.events.length !== durableLength + 1) {
        storageFailure(
          'journal-corrupt',
          `operation ${journal.operationId} must append exactly one event to its durable prefix`,
        )
      }
      if (existing !== undefined && !journalPrefixMatches(existing.journal, journal)) {
        storageFailure('journal-corrupt', `operation ${journal.operationId} does not extend its durable prefix`)
      }
      const event = journal.events.at(-1)!
      const destination = join(directory, eventFilename(event))
      const temporary = join(directory, `.event-${randomUUID()}`)
      try {
        await writeExclusive(temporary, `${canonicalJson(event)}\n`)
        try {
          await link(temporary, destination)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const existing = await readFile(destination, 'utf8')
          if (existing !== `${canonicalJson(event)}\n`) {
            storageFailure('journal-corrupt', `operation ${journal.operationId} event path already contains different data`)
          }
        }
        await unlink(temporary)
        await syncDirectory(directory)
      } catch (error: unknown) {
        try {
          await unlink(temporary)
        } catch (cleanupError: unknown) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
        }
        throw error
      }
      await this.writePointer(directory, pointerFor(journal))
      return operationJournalCheckpoint(journal)
    })
  }

  /**
   * Load and verify one operation, repairing a valid event-ahead-of-pointer crash.
   * @param operationId Exact operation identity.
   * @returns Verified operation, or `undefined` when it was never persisted.
   */
  load(operationId: string): Promise<LoadedOperation | undefined> {
    return this.serialize(operationId, () => this.loadUnlocked(operationId, true))
  }

  /**
   * Enumerate only terminal operations that contain a verified receipt.
   * @returns Receipts sorted by operation id.
   */
  async listReceipts(): Promise<readonly StoredReceipt[]> {
    const operationsRoot = join(this.root, 'operations')
    let entries
    try {
      entries = await readdir(operationsRoot, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const receipts: StoredReceipt[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue
      const pointerText = await readOptional(join(operationsRoot, entry.name, CURRENT_FILENAME))
      if (pointerText === undefined) continue
      const pointer = decodePointer(parseJson(pointerText, `operation ${entry.name} pointer`))
      const loaded = await this.load(pointer.operationId)
      if (loaded !== undefined && loaded.projection.receipt !== null) {
        receipts.push({
          operationId: loaded.journal.operationId,
          targetKey: loaded.journal.targetKey,
          receipt: loaded.projection.receipt,
        })
      }
    }
    return Object.freeze(receipts.sort((left, right) => left.operationId.localeCompare(right.operationId)))
  }

  /** Enumerate every verified operation journal, including rows missing an advisory index after a crash. */
  async list(): Promise<readonly LoadedOperation[]> {
    const operationsRoot = join(this.root, 'operations')
    let entries
    try {
      entries = await readdir(operationsRoot, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const output: LoadedOperation[] = []
    const identities = new Set<string>()
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue
      const pointerText = await readOptional(join(operationsRoot, entry.name, CURRENT_FILENAME))
      if (pointerText === undefined) continue
      const pointer = decodePointer(parseJson(pointerText, `operation ${entry.name} pointer`))
      if (identities.has(pointer.operationId)) storageFailure('journal-corrupt', `duplicate operation identity ${pointer.operationId}`)
      identities.add(pointer.operationId)
      const loaded = await this.load(pointer.operationId)
      if (loaded !== undefined) output.push(loaded)
    }
    return Object.freeze(output.sort((left, right) => left.journal.operationId.localeCompare(right.journal.operationId)))
  }

  private operationDirectory(operationId: string): string {
    return join(this.root, 'operations', operationDirectoryName(operationId))
  }

  private reservationPath(operationId: string): string {
    return join(this.root, 'operation-reservations', `${operationDirectoryName(operationId)}.json`)
  }

  private async loadUnlocked(operationId: string, repair: boolean): Promise<LoadedOperation | undefined> {
    const directory = this.operationDirectory(operationId)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const eventNames = names.filter(name => EVENT_FILENAME.test(name)).sort()
    const unexpected = names.filter(name =>
      name !== CURRENT_FILENAME && !EVENT_FILENAME.test(name) && !name.startsWith('.tmp-') && !name.startsWith('.event-'))
    if (unexpected.length > 0) {
      storageFailure('journal-corrupt', `operation ${operationId} contains unexpected durable records`)
    }
    if (eventNames.length === 0) {
      if (await readOptional(join(directory, CURRENT_FILENAME)) !== undefined) {
        storageFailure('journal-truncated', `operation ${operationId} lost every anchored event`)
      }
      return undefined
    }

    const events: OperationJournalEvent[] = []
    for (let index = 0; index < eventNames.length; index += 1) {
      const name = eventNames[index]!
      const match = EVENT_FILENAME.exec(name)!
      const expectedSequence = index + 1
      if (Number(match[1]) !== expectedSequence) {
        storageFailure('journal-truncated', `operation ${operationId} event sequence is not contiguous`)
      }
      const parsed = parseJson(await readFile(join(directory, name), 'utf8'), `operation ${operationId} event ${expectedSequence}`)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        storageFailure('journal-corrupt', `operation ${operationId} event ${expectedSequence} is invalid`)
      }
      const event = parsed as OperationJournalEvent
      if (event.sequence !== expectedSequence || event.digest !== `sha256:${match[2]}`) {
        storageFailure('journal-corrupt', `operation ${operationId} event filename does not match its content`)
      }
      events.push(event)
    }
    const first = events[0]!
    const journal = immutableJsonClone({
      schemaVersion: STORE_SCHEMA_VERSION,
      operationId,
      targetKey: first.targetKey,
      events,
    }) as unknown as OperationJournal
    const projection = verifyOperationJournal(journal)

    const pointerPath = join(directory, CURRENT_FILENAME)
    const pointerText = await readOptional(pointerPath)
    let recovered = false
    if (pointerText !== undefined) {
      const pointer = decodePointer(parseJson(pointerText, `operation ${operationId} pointer`))
      if (pointer.operationId !== operationId || pointer.targetKey !== journal.targetKey) {
        storageFailure('journal-corrupt', `operation ${operationId} pointer identity does not match its events`)
      }
      if (pointer.eventCount > journal.events.length) {
        storageFailure('journal-truncated', `operation ${operationId} is shorter than its pointer`)
      }
      if (journal.events[pointer.eventCount - 1]?.digest !== pointer.headDigest) {
        storageFailure('journal-corrupt', `operation ${operationId} pointer does not name its durable prefix`)
      }
      recovered = pointer.eventCount < journal.events.length
    } else {
      recovered = true
    }
    if (recovered && repair) await this.writePointer(directory, pointerFor(journal))
    return Object.freeze({ journal, projection, recovered })
  }

  private async writePointer(directory: string, pointer: CurrentPointer): Promise<void> {
    await writeAtomic(join(directory, CURRENT_FILENAME), `${canonicalJson(pointer)}\n`)
  }

  private serialize<T>(operationId: string, action: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(operationId) ?? Promise.resolve()
    const run = prior.then(action, action)
    const settled = run.then(() => undefined, () => undefined)
    this.queues.set(operationId, settled)
    void settled.then(() => {
      if (this.queues.get(operationId) === settled) this.queues.delete(operationId)
    })
    return run
  }
}

/** Test-only durable path helper retained outside the store's public protocol. */
export async function operationStoreStat(root: string, operationId: string): Promise<Readonly<{ files: readonly string[] }>> {
  const directory = join(root, 'operations', operationDirectoryName(operationId))
  await stat(directory)
  return Object.freeze({ files: Object.freeze((await readdir(directory)).sort()) })
}
