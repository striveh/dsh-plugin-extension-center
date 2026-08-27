import { chmod, lstat, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalJson, canonicalSha256 } from '../../domain/index.ts'
import {
  cloneCenterMcpState,
  emptyCenterMcpState,
  envelopeForCenterMcpState,
  parseCenterMcpEnvelope,
  type StoredCenterMcpState,
} from './state.ts'
import { CenterMcpConnectionIdempotencyError, type CenterMcpConnectionMutationReceipt } from './types.ts'

const APPLICATION_ID = 0x45434d31
const SCHEMA_VERSION = 1
const DATABASE_FILE = 'connections.sqlite'
const BUSY_TIMEOUT_MS = 10_000

type DatabaseConstructor = typeof import('node:sqlite')['DatabaseSync']

/** Result of one durable mutation. */
export interface CenterMcpMutationResult {
  readonly state: StoredCenterMcpState
  readonly receipt: CenterMcpConnectionMutationReceipt
  readonly replayed: boolean
}

/** Stable refusal for an incompatible or malformed MCP database. */
export class CenterMcpConnectionStoreCorruptionError extends Error {
  readonly code = 'CENTER_MCP_STORE_CORRUPT'
}

/** SQLite store whose writer reservation covers load, CAS, and commit. */
export class CenterMcpConnectionStore {
  readonly statePath: string
  private readonly legacyPaths: readonly string[]
  private database: DatabaseSync | undefined
  private opening: Promise<void> | undefined

  constructor(root: string) {
    const managementRoot = resolve(root)
    if (dirname(managementRoot) === managementRoot) {
      throw new Error('Center MCP state root must not be a filesystem root')
    }
    const stateRoot = join(managementRoot, 'mcp')
    this.statePath = join(stateRoot, DATABASE_FILE)
    this.legacyPaths = Object.freeze([
      join(stateRoot, 'connections.json'),
      join(stateRoot, 'connections.last-good.json'),
    ])
  }

  /** Open and validate the private database, rejecting unreleased file-store formats. */
  initialize(): Promise<void> {
    return (this.opening ??= this.open())
  }

  /** Release this process's SQLite handle. */
  close(): void {
    this.database?.close()
    this.database = undefined
  }

  /** Load current durable state, repairing a corrupt current payload only from its transactionally paired last-good value. */
  async load(): Promise<StoredCenterMcpState> {
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const state = readState(database)
      database.exec('COMMIT')
      return state
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Commit one exact idempotent mutation while retaining the cross-process writer reservation. */
  async mutate(
    mutationId: string,
    requestValue: unknown,
    transform: (state: StoredCenterMcpState) => CenterMcpConnectionMutationReceipt,
    validateCommit?: () => void,
  ): Promise<CenterMcpMutationResult> {
    const requestDigest = canonicalSha256(requestValue)
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const state = readState(database)
      const prior = state.mutations.find(entry => entry.mutationId === mutationId)
      if (prior !== undefined) {
        if (prior.requestDigest !== requestDigest) throw new CenterMcpConnectionIdempotencyError(mutationId)
        database.exec('COMMIT')
        return { state, receipt: prior.receipt, replayed: true }
      }
      const next = cloneCenterMcpState(state)
      const receipt = transform(next)
      validateCommit?.()
      next.mutations.push({ mutationId, requestDigest, receipt })
      const serialized = `${canonicalJson(envelopeForCenterMcpState(next))}\n`
      const result = database.prepare(`UPDATE desired_state
        SET current_json = ?, last_good_json = ?
        WHERE singleton = 1`).run(serialized, serialized)
      if (result.changes !== 1) throw new CenterMcpConnectionStoreCorruptionError('Center MCP singleton row disappeared')
      database.exec('COMMIT')
      return { state: next, receipt, replayed: false }
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  private async ready(): Promise<DatabaseSync> {
    await this.initialize()
    if (this.database === undefined) throw new Error('Center MCP connection store is closed')
    return this.database
  }

  private async open(): Promise<void> {
    const parentPath = dirname(this.statePath)
    await mkdir(parentPath, { recursive: true, mode: 0o700 })
    const parent = await lstat(parentPath)
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new CenterMcpConnectionStoreCorruptionError('Center MCP state root must be a real directory')
    }
    for (const legacyPath of this.legacyPaths) {
      try {
        await lstat(legacyPath)
        throw new CenterMcpConnectionStoreCorruptionError(
          `unsupported pre-release MCP file-store state remains at ${legacyPath}`,
        )
      } catch (error: unknown) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
    }
    try {
      const file = await lstat(this.statePath)
      if (!file.isFile() || file.isSymbolicLink()) {
        throw new CenterMcpConnectionStoreCorruptionError('Center MCP database must be a regular file')
      }
    } catch (error: unknown) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    const Database = await loadDatabase()
    const database = new Database(this.statePath)
    try {
      await chmod(this.statePath, 0o600)
      database.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`)
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = FULL')
      database.exec('PRAGMA trusted_schema = OFF')
      initializeSchema(database)
      this.database = database
    } catch (error: unknown) {
      database.close()
      throw error
    }
  }
}

async function loadDatabase(): Promise<DatabaseConstructor> {
  return (await import('node:sqlite')).DatabaseSync
}

function initializeSchema(database: DatabaseSync): void {
  const applicationId = pragmaNumber(database, 'application_id')
  const version = pragmaNumber(database, 'user_version')
  const objects = database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
  if (applicationId === 0 && version === 0 && objects.length === 0) {
    database.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`)
    database.exec(`CREATE TABLE desired_state (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      current_json TEXT NOT NULL,
      last_good_json TEXT NOT NULL
    ) STRICT`)
    const serialized = `${canonicalJson(envelopeForCenterMcpState(emptyCenterMcpState()))}\n`
    database.prepare('INSERT INTO desired_state (singleton, current_json, last_good_json) VALUES (1, ?, ?)')
      .run(serialized, serialized)
    database.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
    return
  }
  if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION) {
    throw new CenterMcpConnectionStoreCorruptionError(
      `Center MCP database has application id ${String(applicationId)} and version ${String(version)}`,
    )
  }
  const names = objects.map(value => readString(record(value), 'name'))
  if (names.length !== 1 || names[0] !== 'desired_state') {
    throw new CenterMcpConnectionStoreCorruptionError('Center MCP database has unexpected schema objects')
  }
  const columns = database.prepare('PRAGMA table_info(desired_state)').all().map(value => {
    const row = record(value)
    return `${readString(row, 'name')}:${readString(row, 'type')}:${readNumber(row, 'notnull')}:${readNumber(row, 'pk')}`
  })
  if (columns.join(',') !== 'singleton:INTEGER:1:1,current_json:TEXT:1:0,last_good_json:TEXT:1:0') {
    throw new CenterMcpConnectionStoreCorruptionError('Center MCP database columns are incompatible')
  }
}

function readState(database: DatabaseSync): StoredCenterMcpState {
  const value = database.prepare('SELECT current_json, last_good_json FROM desired_state WHERE singleton = 1').get()
  if (value === undefined) throw new CenterMcpConnectionStoreCorruptionError('Center MCP singleton row is missing')
  const row = record(value)
  const current = readString(row, 'current_json')
  const lastGood = readString(row, 'last_good_json')
  try {
    return parseSerializedState(current)
  } catch (currentError: unknown) {
    try {
      const recovered = parseSerializedState(lastGood)
      database.prepare('UPDATE desired_state SET current_json = ? WHERE singleton = 1').run(lastGood)
      return recovered
    } catch (lastGoodError: unknown) {
      throw new AggregateError(
        [currentError, lastGoodError],
        'Center MCP current and last-good payloads are both corrupt',
      )
    }
  }
}

function parseSerializedState(value: string): StoredCenterMcpState {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error: unknown) {
    throw new CenterMcpConnectionStoreCorruptionError('Center MCP state payload is not JSON', { cause: error })
  }
  if (`${canonicalJson(parsed)}\n` !== value) {
    throw new CenterMcpConnectionStoreCorruptionError('Center MCP state payload is not canonical JSON')
  }
  return parseCenterMcpEnvelope(parsed)
}

function pragmaNumber(database: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const value = database.prepare(`PRAGMA ${name}`).get()
  if (value === undefined) throw new CenterMcpConnectionStoreCorruptionError(`Center MCP PRAGMA ${name} is unavailable`)
  return readNumber(record(value), name)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CenterMcpConnectionStoreCorruptionError('Center MCP SQLite row is invalid')
  }
  return value as Record<string, unknown>
}

function readString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw new CenterMcpConnectionStoreCorruptionError(`Center MCP SQLite ${key} is invalid`)
  return field
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (!Number.isSafeInteger(field)) throw new CenterMcpConnectionStoreCorruptionError(`Center MCP SQLite ${key} is invalid`)
  return field as number
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}
