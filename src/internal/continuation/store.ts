/** Strict SQLite persistence for plugin-owned continuation claims. */

import { chmod, lstat, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  TaskContinuationInputError,
  TaskContinuationMutationConflictError,
  agentOptions,
  continuationId,
  createRequest,
  invalidReason,
  sameAgentOptions,
  taskRevision,
} from './codec.ts'
import type {
  ContinuationAgentOptions,
  CreateTaskContinuationRequest,
  TaskContinuationClaim,
  TaskContinuationDeliveryUnknownReason,
  TaskContinuationInvalidReason,
  TaskContinuationState,
} from './types.ts'

const APPLICATION_ID = 0x45434331
const SCHEMA_VERSION = 3
const DATABASE_FILE = 'continuations.sqlite'
const ALL_STATES: readonly TaskContinuationState[] = [
  'pending', 'ready', 'consumed', 'dispatching', 'dispatched', 'claimed', 'delivery-unknown',
  'canceled', 'superseded', 'expired', 'invalid',
]
const DELIVERY_UNKNOWN_REASONS: readonly TaskContinuationDeliveryUnknownReason[] = [
  'followup-error', 'session-flush-error', 'owner-lease-expired', 'legacy-consumed',
]

type DatabaseConstructor = typeof import('node:sqlite')['DatabaseSync']

/** Durable fields supplied for a new pending record. */
export type NewTaskContinuation = Omit<
  TaskContinuationClaim,
  | 'recordRevision'
  | 'state'
  | 'updatedAtMs'
  | 'dispatchFence'
  | 'dispatchOwnerId'
  | 'dispatchLeaseExpiresAtMs'
  | 'dispatchStartedAtMs'
  | 'deliveryUnknownReason'
  | 'invalidReason'
>

/** Compare-and-set lifecycle transition. */
export interface TaskContinuationTransition {
  readonly id: string
  readonly from: readonly TaskContinuationState[]
  readonly to: TaskContinuationState
  readonly updatedAtMs: number
  readonly expectedRecordRevision?: number
  readonly expectedSessionId?: string
  readonly expectedTaskRevision?: string
  readonly supersededByTaskRevision?: string
  readonly invalidReason?: TaskContinuationInvalidReason
}

/** Atomic ownership request before the at-most-once Agent call begins. */
export interface TaskContinuationDispatchClaimRequest {
  readonly id: string
  readonly ownerId: string
  readonly nowMs: number
  readonly leaseExpiresAtMs: number
  readonly expectedSessionId: string
  readonly expectedTaskRevision: string
}

/** Exact owner/fence required to cross the irreversible Agent-call boundary. */
export interface TaskContinuationDispatchFence {
  readonly id: string
  readonly ownerId: string
  readonly fence: number
  readonly expectedRecordRevision: number
  readonly updatedAtMs: number
}

/** Confirmed result of one owner-fenced Agent dispatch attempt. */
export interface TaskContinuationDispatchFinish extends TaskContinuationDispatchFence {
  readonly to: 'dispatched' | 'claimed'
}

/** Secret-free uncertain outcome of one owner-fenced Agent dispatch attempt. */
export interface TaskContinuationDispatchFailure extends TaskContinuationDispatchFence {
  readonly reason: Exclude<TaskContinuationDeliveryUnknownReason, 'owner-lease-expired' | 'legacy-consumed'>
}

/** Stable refusal for an incompatible or malformed claims database. */
export class TaskContinuationStoreCorruptionError extends Error {
  readonly code = 'TASK_CONTINUATION_STORE_CORRUPT'
}

/** One-process connection using SQLite writer reservations for every mutation. */
export class InternalTaskContinuationStore {
  private readonly path: string
  private database: DatabaseSync | undefined
  private opening: Promise<void> | undefined

  constructor(root: string, private readonly busyTimeoutMs: number) {
    this.path = join(resolve(root), DATABASE_FILE)
  }

  /** Open and validate storage, creating the exact schema when absent. */
  initialize(): Promise<void> {
    return (this.opening ??= this.open())
  }

  /** Open storage only when a prior process materialized it. */
  async initializeIfPresent(): Promise<boolean> {
    try {
      const value = await lstat(this.path)
      if (!value.isFile() || value.isSymbolicLink()) {
        throw new TaskContinuationStoreCorruptionError('task continuation database is not a regular file')
      }
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return false
      throw error
    }
    await this.initialize()
    return true
  }

  /** Release the process-owned SQLite connection. */
  close(): void {
    this.database?.close()
    this.database = undefined
  }

  /** Atomically reserve a caller key or return its exact idempotent binding. */
  async createOrGet(input: NewTaskContinuation): Promise<Readonly<{ claim: TaskContinuationClaim; created: boolean }>> {
    const database = await this.ready()
    const claim: TaskContinuationClaim = Object.freeze({
      ...input,
      recordRevision: 0,
      state: 'pending',
      dispatchFence: 0,
      updatedAtMs: input.createdAtMs,
    })
    database.exec('BEGIN IMMEDIATE')
    try {
      const prior = database.prepare('SELECT * FROM claims WHERE caller_id = ? AND mutation_id = ?')
        .get(input.callerId, input.mutationId)
      if (prior !== undefined) {
        const existing = decodeRow(prior)
        assertSameStoredReservation(existing, input)
        database.exec('COMMIT')
        return Object.freeze({ claim: existing, created: false })
      }
      database.prepare(`INSERT INTO claims (
        continuation_id, caller_id, mutation_id, record_revision, state, dispatch_message_id,
        dispatch_owner_id, dispatch_fence, dispatch_lease_expires_at_ms, dispatch_started_at_ms,
        delivery_unknown_reason, invalid_reason,
        session_id, original_message_id, need_digest, task_revision, verifier_id,
        verification_payload_digest, created_at_ms, updated_at_ms, expires_at_ms,
        agent_provider, agent_model, agent_max_tokens, superseded_by_task_revision
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        claim.continuationId,
        claim.callerId,
        claim.mutationId,
        claim.recordRevision,
        claim.state,
        claim.dispatchMessageId,
        claim.sessionId,
        claim.originalMessageId,
        claim.needDigest,
        claim.taskRevision,
        claim.verifierId,
        claim.verificationPayloadDigest,
        claim.createdAtMs,
        claim.updatedAtMs,
        claim.expiresAtMs,
        claim.resumeAgentOptions.provider ?? null,
        claim.resumeAgentOptions.model ?? null,
        claim.resumeAgentOptions.maxTokens ?? null,
      )
      database.exec('COMMIT')
      return Object.freeze({ claim, created: true })
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Find one exact claim identity. */
  async get(id: string): Promise<TaskContinuationClaim | undefined> {
    const row = (await this.ready()).prepare('SELECT * FROM claims WHERE continuation_id = ?').get(id)
    return row === undefined ? undefined : decodeRow(row)
  }

  /** Find a caller-scoped idempotency binding. */
  async getByMutation(callerId: string, mutationId: string): Promise<TaskContinuationClaim | undefined> {
    const row = (await this.ready()).prepare('SELECT * FROM claims WHERE caller_id = ? AND mutation_id = ?')
      .get(callerId, mutationId)
    return row === undefined ? undefined : decodeRow(row)
  }

  /** List every claim in deterministic creation order. */
  async list(): Promise<readonly TaskContinuationClaim[]> {
    return (await this.ready()).prepare('SELECT * FROM claims ORDER BY created_at_ms, continuation_id')
      .all().map(decodeRow)
  }

  /** Apply one record-revision-fenced lifecycle transition. */
  async transition(request: TaskContinuationTransition): Promise<TaskContinuationClaim | undefined> {
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare('SELECT * FROM claims WHERE continuation_id = ?').get(request.id)
      if (row === undefined) {
        database.exec('ROLLBACK')
        return undefined
      }
      const current = decodeRow(row)
      if (!request.from.includes(current.state)
        || (request.expectedRecordRevision !== undefined && current.recordRevision !== request.expectedRecordRevision)
        || (request.expectedSessionId !== undefined && current.sessionId !== request.expectedSessionId)
        || (request.expectedTaskRevision !== undefined && current.taskRevision !== request.expectedTaskRevision)) {
        database.exec('ROLLBACK')
        return undefined
      }
      assertTransition(current.state, request.to)
      const exactInvalidReason = request.to === 'invalid'
        ? invalidReason(request.invalidReason)
        : undefined
      if (request.to !== 'invalid' && request.invalidReason !== undefined) {
        throw new TaskContinuationInputError('task continuation invalid reason requires invalid state')
      }
      const replacement = request.to === 'superseded'
        ? taskRevision(request.supersededByTaskRevision)
        : undefined
      const clearsDispatch = request.to === 'canceled' || request.to === 'superseded' || request.to === 'expired'
      const result = database.prepare(`UPDATE claims SET
        record_revision = ?, state = ?, updated_at_ms = ?, superseded_by_task_revision = ?,
        dispatch_owner_id = ?, dispatch_fence = ?, dispatch_lease_expires_at_ms = ?,
        dispatch_started_at_ms = ?, delivery_unknown_reason = ?, invalid_reason = ?
        WHERE continuation_id = ? AND record_revision = ?`).run(
        current.recordRevision + 1,
        request.to,
        request.updatedAtMs,
        replacement ?? null,
        clearsDispatch ? null : current.dispatchOwnerId ?? null,
        clearsDispatch ? 0 : current.dispatchFence,
        clearsDispatch ? null : current.dispatchLeaseExpiresAtMs ?? null,
        clearsDispatch ? null : current.dispatchStartedAtMs ?? null,
        clearsDispatch || request.to === 'invalid' ? null : current.deliveryUnknownReason ?? null,
        exactInvalidReason ?? null,
        request.id,
        current.recordRevision,
      )
      if (Number(result.changes) !== 1) {
        database.exec('ROLLBACK')
        return undefined
      }
      database.exec('COMMIT')
      const changed: TaskContinuationClaim = {
        ...current,
        recordRevision: current.recordRevision + 1,
        state: request.to,
        updatedAtMs: request.updatedAtMs,
        ...(replacement === undefined ? {} : { supersededByTaskRevision: replacement }),
        ...(exactInvalidReason === undefined ? {} : { invalidReason: exactInvalidReason }),
      }
      if (!clearsDispatch) {
        if (request.to !== 'invalid') return Object.freeze(changed)
        const invalid = { ...changed }
        delete invalid.deliveryUnknownReason
        return Object.freeze(invalid)
      }
      const cleared = { ...changed, dispatchFence: 0 }
      delete cleared.dispatchOwnerId
      delete cleared.dispatchLeaseExpiresAtMs
      delete cleared.dispatchStartedAtMs
      delete cleared.deliveryUnknownReason
      delete cleared.invalidReason
      return Object.freeze(cleared)
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Claim or safely reclaim a pre-call dispatch lease, incrementing its fence. */
  async claimDispatch(request: TaskContinuationDispatchClaimRequest): Promise<TaskContinuationClaim | undefined> {
    assertOwnerId(request.ownerId)
    assertTimestamp(request.nowMs, 'dispatch claim time')
    assertTimestamp(request.leaseExpiresAtMs, 'dispatch claim lease')
    if (request.leaseExpiresAtMs <= request.nowMs) throw new Error('task continuation dispatch lease must be in the future')
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare('SELECT * FROM claims WHERE continuation_id = ?').get(request.id)
      if (row === undefined) {
        database.exec('ROLLBACK')
        return undefined
      }
      const current = decodeRow(row)
      const safelyReclaimable = current.state === 'dispatching'
        && current.dispatchStartedAtMs === undefined
        && current.dispatchLeaseExpiresAtMs !== undefined
        && current.dispatchLeaseExpiresAtMs <= request.nowMs
      if ((current.state !== 'consumed' && !safelyReclaimable)
        || current.sessionId !== request.expectedSessionId
        || current.taskRevision !== request.expectedTaskRevision
        || current.expiresAtMs <= request.nowMs) {
        database.exec('ROLLBACK')
        return undefined
      }
      const fence = current.dispatchFence + 1
      if (!Number.isSafeInteger(fence)) throw new Error('task continuation dispatch fence overflow')
      const result = database.prepare(`UPDATE claims SET
        record_revision = ?, state = 'dispatching', updated_at_ms = ?, dispatch_owner_id = ?,
        dispatch_fence = ?, dispatch_lease_expires_at_ms = ?, dispatch_started_at_ms = NULL,
        delivery_unknown_reason = NULL, invalid_reason = NULL
        WHERE continuation_id = ? AND record_revision = ?`).run(
        current.recordRevision + 1,
        request.nowMs,
        request.ownerId,
        fence,
        request.leaseExpiresAtMs,
        request.id,
        current.recordRevision,
      )
      if (Number(result.changes) !== 1) {
        database.exec('ROLLBACK')
        return undefined
      }
      database.exec('COMMIT')
      return Object.freeze({
        ...current,
        recordRevision: current.recordRevision + 1,
        state: 'dispatching',
        updatedAtMs: request.nowMs,
        dispatchOwnerId: request.ownerId,
        dispatchFence: fence,
        dispatchLeaseExpiresAtMs: request.leaseExpiresAtMs,
      })
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Persist the irreversible boundary immediately before `Agent.followup()`. */
  async beginDispatch(request: TaskContinuationDispatchFence): Promise<TaskContinuationClaim | undefined> {
    assertDispatchFence(request)
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const current = rowClaim(database, request.id)
      if (current === undefined || current.state !== 'dispatching'
        || current.recordRevision !== request.expectedRecordRevision
        || current.dispatchOwnerId !== request.ownerId
        || current.dispatchFence !== request.fence
        || current.dispatchStartedAtMs !== undefined
        || current.dispatchLeaseExpiresAtMs === undefined
        || current.dispatchLeaseExpiresAtMs <= request.updatedAtMs) {
        database.exec('ROLLBACK')
        return undefined
      }
      updateDispatch(database, current, request.updatedAtMs, `
        dispatch_started_at_ms = ?`, [request.updatedAtMs])
      database.exec('COMMIT')
      return Object.freeze({
        ...current,
        recordRevision: current.recordRevision + 1,
        updatedAtMs: request.updatedAtMs,
        dispatchStartedAtMs: request.updatedAtMs,
      })
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Record a flush-confirmed dispatch without permitting a second Agent call. */
  async finishDispatch(request: TaskContinuationDispatchFinish): Promise<TaskContinuationClaim | undefined> {
    assertDispatchFence(request)
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const current = rowClaim(database, request.id)
      if (!matchesStartedDispatch(current, request)) {
        database.exec('ROLLBACK')
        return undefined
      }
      updateDispatch(database, current, request.updatedAtMs, `
        state = ?, dispatch_lease_expires_at_ms = NULL`, [request.to])
      database.exec('COMMIT')
      const finished = {
        ...current,
        recordRevision: current.recordRevision + 1,
        state: request.to,
        updatedAtMs: request.updatedAtMs,
      }
      delete finished.dispatchLeaseExpiresAtMs
      return Object.freeze(finished)
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Terminalize an ambiguous owner-observed call result without retrying it. */
  async failDispatch(request: TaskContinuationDispatchFailure): Promise<TaskContinuationClaim | undefined> {
    assertDispatchFence(request)
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const current = rowClaim(database, request.id)
      if (!matchesStartedDispatch(current, request)) {
        database.exec('ROLLBACK')
        return undefined
      }
      updateDispatch(database, current, request.updatedAtMs, `
        state = 'delivery-unknown', dispatch_lease_expires_at_ms = NULL,
        delivery_unknown_reason = ?`, [request.reason])
      database.exec('COMMIT')
      const failed = {
        ...current,
        recordRevision: current.recordRevision + 1,
        state: 'delivery-unknown' as const,
        updatedAtMs: request.updatedAtMs,
        deliveryUnknownReason: request.reason,
      }
      delete failed.dispatchLeaseExpiresAtMs
      return Object.freeze(failed)
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Resolve a crashed post-boundary owner to a non-retrying diagnostic state. */
  async expireDispatch(id: string, nowMs: number): Promise<TaskContinuationClaim | undefined> {
    assertTimestamp(nowMs, 'dispatch recovery time')
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const current = rowClaim(database, id)
      if (current === undefined || current.state !== 'dispatching'
        || current.dispatchStartedAtMs === undefined
        || current.dispatchLeaseExpiresAtMs === undefined
        || current.dispatchLeaseExpiresAtMs > nowMs) {
        database.exec('ROLLBACK')
        return undefined
      }
      updateDispatch(database, current, nowMs, `
        state = 'delivery-unknown', dispatch_lease_expires_at_ms = NULL,
        delivery_unknown_reason = 'owner-lease-expired'`, [])
      database.exec('COMMIT')
      const expired = {
        ...current,
        recordRevision: current.recordRevision + 1,
        state: 'delivery-unknown' as const,
        updatedAtMs: nowMs,
        deliveryUnknownReason: 'owner-lease-expired' as const,
      }
      delete expired.dispatchLeaseExpiresAtMs
      return Object.freeze(expired)
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Repair an uncertain or queued dispatch only from exact durable Session evidence. */
  async observeDispatch(
    claim: TaskContinuationClaim,
    to: 'dispatched' | 'claimed' | 'invalid',
    updatedAtMs: number,
    reason?: TaskContinuationInvalidReason,
  ): Promise<TaskContinuationClaim | undefined> {
    assertTimestamp(updatedAtMs, 'dispatch observation time')
    const exactInvalidReason = to === 'invalid' ? invalidReason(reason) : undefined
    if (to !== 'invalid' && reason !== undefined) {
      throw new TaskContinuationInputError('task continuation invalid reason requires invalid state')
    }
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const current = rowClaim(database, claim.continuationId)
      const allowed = current !== undefined
        && current.recordRevision === claim.recordRevision
        && current.sessionId === claim.sessionId
        && current.taskRevision === claim.taskRevision
        && current.dispatchStartedAtMs !== undefined
        && (current.state === 'dispatching' || current.state === 'dispatched' || current.state === 'delivery-unknown')
        && !(current.state === 'dispatched' && to === 'dispatched')
      if (!allowed || current === undefined) {
        database.exec('ROLLBACK')
        return undefined
      }
      updateDispatch(database, current, updatedAtMs, `
        state = ?, dispatch_lease_expires_at_ms = NULL, delivery_unknown_reason = NULL,
        invalid_reason = ?`, [to, exactInvalidReason ?? null])
      database.exec('COMMIT')
      const observed = {
        ...current,
        recordRevision: current.recordRevision + 1,
        state: to,
        updatedAtMs,
        ...(exactInvalidReason === undefined ? {} : { invalidReason: exactInvalidReason }),
      }
      delete observed.dispatchLeaseExpiresAtMs
      delete observed.deliveryUnknownReason
      if (exactInvalidReason === undefined) delete observed.invalidReason
      return Object.freeze(observed)
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  private async ready(): Promise<DatabaseSync> {
    await this.initialize()
    if (this.database === undefined) throw new Error('task continuation store is closed')
    return this.database
  }

  private async open(): Promise<void> {
    const parentPath = dirname(this.path)
    await mkdir(parentPath, { recursive: true, mode: 0o700 })
    const parent = await lstat(parentPath)
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new TaskContinuationStoreCorruptionError('task continuation root must be a real directory')
    }
    try {
      const file = await lstat(this.path)
      if (!file.isFile() || file.isSymbolicLink()) {
        throw new TaskContinuationStoreCorruptionError('task continuation database must be a regular file')
      }
    } catch (error: unknown) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    const Database = await loadDatabase()
    const database = new Database(this.path)
    try {
      await chmod(this.path, 0o600)
      database.exec(`PRAGMA busy_timeout = ${String(this.busyTimeoutMs)}`)
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = FULL')
      database.exec('PRAGMA foreign_keys = ON')
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
    createClaimsTable(database, 'claims')
    database.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
    return
  }
  if (applicationId === APPLICATION_ID && version === 1) {
    const names = objects.map(row => readString(record(row), 'name'))
    if (names.length !== 1 || names[0] !== 'claims') {
      throw new TaskContinuationStoreCorruptionError('task continuation database has unexpected schema objects')
    }
    migrateVersionOne(database)
    return
  }
  if (applicationId === APPLICATION_ID && version === 2) {
    const names = objects.map(row => readString(record(row), 'name'))
    if (names.length !== 1 || names[0] !== 'claims') {
      throw new TaskContinuationStoreCorruptionError('task continuation database has unexpected schema objects')
    }
    migrateVersionTwo(database)
    return
  }
  if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION) {
    throw new TaskContinuationStoreCorruptionError(
      `task continuation database has application id ${String(applicationId)} and version ${String(version)}`,
    )
  }
  const names = objects.map(row => readString(record(row), 'name'))
  if (names.length !== 1 || names[0] !== 'claims') {
    throw new TaskContinuationStoreCorruptionError('task continuation database has unexpected schema objects')
  }
}

function createClaimsTable(database: DatabaseSync, table: 'claims' | 'claims_next'): void {
  database.exec(`CREATE TABLE ${table} (
    continuation_id TEXT PRIMARY KEY NOT NULL,
    caller_id TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
    state TEXT NOT NULL CHECK (state IN (
      'pending','ready','consumed','dispatching','dispatched','claimed','delivery-unknown',
      'canceled','superseded','expired','invalid'
    )),
    dispatch_message_id TEXT NOT NULL UNIQUE,
    dispatch_owner_id TEXT CHECK (dispatch_owner_id IS NULL OR length(dispatch_owner_id) BETWEEN 1 AND 128),
    dispatch_fence INTEGER NOT NULL CHECK (dispatch_fence >= 0),
    dispatch_lease_expires_at_ms INTEGER CHECK (
      dispatch_lease_expires_at_ms IS NULL OR dispatch_lease_expires_at_ms >= created_at_ms
    ),
    dispatch_started_at_ms INTEGER CHECK (dispatch_started_at_ms IS NULL OR dispatch_started_at_ms >= created_at_ms),
    delivery_unknown_reason TEXT CHECK (delivery_unknown_reason IS NULL OR delivery_unknown_reason IN (
      'followup-error','session-flush-error','owner-lease-expired','legacy-consumed'
    )),
    invalid_reason TEXT CHECK (invalid_reason IS NULL OR invalid_reason IN (
      'agent-settled-before-continuation-message',
      'dispatch-evidence-before-owned-call',
      'dispatch-evidence-content-mismatch',
      'dispatch-lease-missing',
      'dispatched-inbox-evidence-missing',
      'duplicate-dispatch-evidence-before-claim',
      'newer-direct-user-message-after-dispatch',
      'original-user-message-missing',
      'verifier-echo-mismatch'
    )),
    session_id TEXT NOT NULL,
    original_message_id TEXT NOT NULL,
    need_digest TEXT NOT NULL,
    task_revision TEXT NOT NULL,
    verifier_id TEXT NOT NULL,
    verification_payload_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
    agent_provider TEXT,
    agent_model TEXT,
    agent_max_tokens INTEGER CHECK (agent_max_tokens IS NULL OR agent_max_tokens > 0),
    superseded_by_task_revision TEXT,
    UNIQUE (caller_id, mutation_id),
    CHECK ((state = 'superseded') = (superseded_by_task_revision IS NOT NULL)),
    CHECK ((state = 'invalid') = (invalid_reason IS NOT NULL)),
    CHECK (
      (dispatch_owner_id IS NULL AND dispatch_fence = 0 AND dispatch_lease_expires_at_ms IS NULL
        AND dispatch_started_at_ms IS NULL AND delivery_unknown_reason IS NULL
        AND state NOT IN ('dispatching','dispatched','claimed','delivery-unknown'))
      OR
      (dispatch_owner_id IS NOT NULL AND dispatch_fence > 0 AND (
        (state = 'dispatching' AND dispatch_lease_expires_at_ms IS NOT NULL AND delivery_unknown_reason IS NULL)
        OR (state IN ('dispatched','claimed') AND dispatch_lease_expires_at_ms IS NULL
          AND dispatch_started_at_ms IS NOT NULL AND delivery_unknown_reason IS NULL)
        OR (state = 'delivery-unknown' AND dispatch_lease_expires_at_ms IS NULL
          AND dispatch_started_at_ms IS NOT NULL AND delivery_unknown_reason IS NOT NULL)
        OR (state = 'invalid' AND delivery_unknown_reason IS NULL)
      ))
    )
  ) STRICT`)
}

function migrateVersionOne(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    assertNoLegacyInvalidClaims(database)
    createClaimsTable(database, 'claims_next')
    database.exec(`INSERT INTO claims_next (
      continuation_id, caller_id, mutation_id, record_revision, state, dispatch_message_id,
      dispatch_owner_id, dispatch_fence, dispatch_lease_expires_at_ms, dispatch_started_at_ms,
      delivery_unknown_reason, invalid_reason, session_id, original_message_id, need_digest, task_revision,
      verifier_id, verification_payload_digest, created_at_ms, updated_at_ms, expires_at_ms,
      agent_provider, agent_model, agent_max_tokens, superseded_by_task_revision
    ) SELECT
      continuation_id, caller_id, mutation_id, record_revision + CASE WHEN state = 'consumed' THEN 1 ELSE 0 END,
      CASE WHEN state = 'consumed' THEN 'delivery-unknown' ELSE state END,
      dispatch_message_id,
      CASE WHEN state IN ('consumed','claimed') THEN 'legacy-v1' ELSE NULL END,
      CASE WHEN state IN ('consumed','claimed') THEN 1 ELSE 0 END,
      NULL,
      CASE WHEN state IN ('consumed','claimed') THEN updated_at_ms ELSE NULL END,
      CASE WHEN state = 'consumed' THEN 'legacy-consumed' ELSE NULL END,
      NULL,
      session_id, original_message_id, need_digest, task_revision, verifier_id,
      verification_payload_digest, created_at_ms, updated_at_ms, expires_at_ms,
      agent_provider, agent_model, agent_max_tokens, superseded_by_task_revision
      FROM claims`)
    database.exec('DROP TABLE claims')
    database.exec('ALTER TABLE claims_next RENAME TO claims')
    database.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
    database.exec('COMMIT')
  } catch (error: unknown) {
    database.exec('ROLLBACK')
    throw error
  }
}

function migrateVersionTwo(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    assertNoLegacyInvalidClaims(database)
    createClaimsTable(database, 'claims_next')
    database.exec(`INSERT INTO claims_next (
      continuation_id, caller_id, mutation_id, record_revision, state, dispatch_message_id,
      dispatch_owner_id, dispatch_fence, dispatch_lease_expires_at_ms, dispatch_started_at_ms,
      delivery_unknown_reason, invalid_reason, session_id, original_message_id, need_digest, task_revision,
      verifier_id, verification_payload_digest, created_at_ms, updated_at_ms, expires_at_ms,
      agent_provider, agent_model, agent_max_tokens, superseded_by_task_revision
    ) SELECT
      continuation_id, caller_id, mutation_id, record_revision, state, dispatch_message_id,
      dispatch_owner_id, dispatch_fence, dispatch_lease_expires_at_ms, dispatch_started_at_ms,
      delivery_unknown_reason, NULL, session_id, original_message_id, need_digest, task_revision,
      verifier_id, verification_payload_digest, created_at_ms, updated_at_ms, expires_at_ms,
      agent_provider, agent_model, agent_max_tokens, superseded_by_task_revision
      FROM claims`)
    database.exec('DROP TABLE claims')
    database.exec('ALTER TABLE claims_next RENAME TO claims')
    database.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
    database.exec('COMMIT')
  } catch (error: unknown) {
    database.exec('ROLLBACK')
    throw error
  }
}

function assertNoLegacyInvalidClaims(database: DatabaseSync): void {
  if (database.prepare("SELECT continuation_id FROM claims WHERE state = 'invalid' LIMIT 1").get() !== undefined) {
    throw new TaskContinuationStoreCorruptionError(
      'task continuation database contains a legacy invalid claim without an exact invalid reason and cannot migrate',
    )
  }
}

function decodeRow(value: unknown): TaskContinuationClaim {
  try {
    const row = record(value)
    const state = readString(row, 'state') as TaskContinuationState
    if (!ALL_STATES.includes(state)) throw new Error('invalid state')
    const superseded = row['superseded_by_task_revision']
    if ((state === 'superseded') !== (typeof superseded === 'string')) throw new Error('invalid superseded revision')
    const dispatchOwnerId = readNullableString(row, 'dispatch_owner_id')
    const dispatchFence = readInteger(row, 'dispatch_fence')
    const dispatchLeaseExpiresAtMs = readNullableInteger(row, 'dispatch_lease_expires_at_ms')
    const dispatchStartedAtMs = readNullableInteger(row, 'dispatch_started_at_ms')
    const deliveryUnknownReason = readNullableString(row, 'delivery_unknown_reason') as
      TaskContinuationDeliveryUnknownReason | undefined
    const invalidReasonValue = readNullableString(row, 'invalid_reason')
    const exactInvalidReason = invalidReasonValue === undefined ? undefined : invalidReason(invalidReasonValue)
    assertDispatchProjection(
      state,
      dispatchOwnerId,
      dispatchFence,
      dispatchLeaseExpiresAtMs,
      dispatchStartedAtMs,
      deliveryUnknownReason,
      exactInvalidReason,
    )
    const request = createRequest({
      callerId: readString(row, 'caller_id'),
      mutationId: readString(row, 'mutation_id'),
      sessionId: readNonEmptyString(row, 'session_id'),
      originalMessageId: readNonEmptyString(row, 'original_message_id'),
      needDigest: readString(row, 'need_digest'),
      taskRevision: readString(row, 'task_revision'),
      verifierId: readString(row, 'verifier_id'),
      verificationPayloadDigest: readString(row, 'verification_payload_digest'),
      expiresAtMs: readInteger(row, 'expires_at_ms'),
    })
    const claim: TaskContinuationClaim = {
      kind: 'task-continuation',
      version: 3,
      continuationId: continuationId(readString(row, 'continuation_id')),
      callerId: request.callerId,
      mutationId: request.mutationId,
      recordRevision: readInteger(row, 'record_revision'),
      state,
      dispatchMessageId: continuationId(readString(row, 'dispatch_message_id')),
      dispatchFence,
      ...(dispatchOwnerId === undefined ? {} : { dispatchOwnerId }),
      ...(dispatchLeaseExpiresAtMs === undefined ? {} : { dispatchLeaseExpiresAtMs }),
      ...(dispatchStartedAtMs === undefined ? {} : { dispatchStartedAtMs }),
      ...(deliveryUnknownReason === undefined ? {} : { deliveryUnknownReason }),
      ...(exactInvalidReason === undefined ? {} : { invalidReason: exactInvalidReason }),
      resumeAgentOptions: agentOptions({
        ...(row['agent_provider'] === null ? {} : { provider: readString(row, 'agent_provider') }),
        ...(row['agent_model'] === null ? {} : { model: readString(row, 'agent_model') }),
        ...(row['agent_max_tokens'] === null ? {} : { maxTokens: readInteger(row, 'agent_max_tokens') }),
      }),
      sessionId: request.sessionId,
      originalMessageId: request.originalMessageId,
      needDigest: request.needDigest,
      taskRevision: request.taskRevision,
      verifierId: request.verifierId,
      verificationPayloadDigest: request.verificationPayloadDigest,
      createdAtMs: readInteger(row, 'created_at_ms'),
      updatedAtMs: readInteger(row, 'updated_at_ms'),
      expiresAtMs: request.expiresAtMs,
      ...(typeof superseded === 'string' ? { supersededByTaskRevision: taskRevision(superseded) } : {}),
    }
    if (claim.updatedAtMs < claim.createdAtMs || claim.expiresAtMs <= claim.createdAtMs) {
      throw new Error('invalid claim times')
    }
    return Object.freeze(claim)
  } catch (error: unknown) {
    if (error instanceof TaskContinuationStoreCorruptionError) throw error
    throw new TaskContinuationStoreCorruptionError('invalid task continuation claim row', { cause: error })
  }
}

function assertSameStoredReservation(existing: TaskContinuationClaim, input: NewTaskContinuation): void {
  const request: CreateTaskContinuationRequest = input
  if (existing.callerId !== request.callerId || existing.mutationId !== request.mutationId
    || existing.sessionId !== request.sessionId || existing.originalMessageId !== request.originalMessageId
    || existing.needDigest !== request.needDigest || existing.taskRevision !== request.taskRevision
    || existing.verifierId !== request.verifierId
    || existing.verificationPayloadDigest !== request.verificationPayloadDigest
    || existing.expiresAtMs !== request.expiresAtMs
    || !sameAgentOptions(existing.resumeAgentOptions, input.resumeAgentOptions)) {
    throw new TaskContinuationMutationConflictError(existing.callerId, existing.mutationId)
  }
}

function assertTransition(from: TaskContinuationState, to: TaskContinuationState): void {
  const valid = (from === 'pending' && ['ready', 'canceled', 'superseded', 'expired', 'invalid'].includes(to))
    || (from === 'ready' && ['consumed', 'canceled', 'superseded', 'expired', 'invalid'].includes(to))
    || (from === 'consumed' && ['canceled', 'superseded', 'expired', 'invalid'].includes(to))
    || (from === 'dispatching' && ['expired', 'invalid'].includes(to))
    || (from === 'dispatched' && ['expired', 'invalid'].includes(to))
    || (from === 'delivery-unknown' && to === 'invalid')
  if (!valid) throw new Error(`invalid task continuation transition ${from} -> ${to}`)
}

function rowClaim(database: DatabaseSync, id: string): TaskContinuationClaim | undefined {
  const row = database.prepare('SELECT * FROM claims WHERE continuation_id = ?').get(id)
  return row === undefined ? undefined : decodeRow(row)
}

function updateDispatch(
  database: DatabaseSync,
  current: TaskContinuationClaim,
  updatedAtMs: number,
  assignments: string,
  values: readonly (string | number | null)[],
): void {
  const result = database.prepare(`UPDATE claims SET ${assignments},
    record_revision = ?, updated_at_ms = ?
    WHERE continuation_id = ? AND record_revision = ?`).run(
    ...values,
    current.recordRevision + 1,
    updatedAtMs,
    current.continuationId,
    current.recordRevision,
  )
  if (Number(result.changes) !== 1) throw new Error('task continuation dispatch compare-and-set failed')
}

function matchesStartedDispatch(
  current: TaskContinuationClaim | undefined,
  request: TaskContinuationDispatchFence,
): current is TaskContinuationClaim {
  return current !== undefined
    && current.state === 'dispatching'
    && current.recordRevision === request.expectedRecordRevision
    && current.dispatchOwnerId === request.ownerId
    && current.dispatchFence === request.fence
    && current.dispatchStartedAtMs !== undefined
}

function assertDispatchFence(request: TaskContinuationDispatchFence): void {
  assertOwnerId(request.ownerId)
  assertTimestamp(request.updatedAtMs, 'dispatch update time')
  if (!Number.isSafeInteger(request.fence) || request.fence < 1) {
    throw new Error('task continuation dispatch fence must be a positive integer')
  }
  if (!Number.isSafeInteger(request.expectedRecordRevision) || request.expectedRecordRevision < 0) {
    throw new Error('task continuation dispatch record revision must be a non-negative integer')
  }
}

function assertOwnerId(value: string): void {
  if (value.length < 1 || value.length > 128) throw new Error('task continuation dispatch owner id is invalid')
}

function assertTimestamp(value: number, subject: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${subject} must be a non-negative integer`)
}

function assertDispatchProjection(
  state: TaskContinuationState,
  ownerId: string | undefined,
  fence: number,
  leaseExpiresAtMs: number | undefined,
  startedAtMs: number | undefined,
  unknownReason: TaskContinuationDeliveryUnknownReason | undefined,
  exactInvalidReason: TaskContinuationInvalidReason | undefined,
): void {
  if (unknownReason !== undefined && !DELIVERY_UNKNOWN_REASONS.includes(unknownReason)) {
    throw new Error('invalid delivery unknown reason')
  }
  if ((state === 'invalid') !== (exactInvalidReason !== undefined)) {
    throw new Error('invalid terminal reason projection')
  }
  if (ownerId === undefined) {
    if (fence !== 0 || leaseExpiresAtMs !== undefined || startedAtMs !== undefined || unknownReason !== undefined
      || ['dispatching', 'dispatched', 'claimed', 'delivery-unknown'].includes(state)) {
      throw new Error('invalid unowned dispatch projection')
    }
    return
  }
  if (fence < 1) throw new Error('invalid owned dispatch fence')
  if (state === 'dispatching') {
    if (leaseExpiresAtMs === undefined || unknownReason !== undefined) throw new Error('invalid dispatching projection')
    return
  }
  if (state === 'dispatched' || state === 'claimed') {
    if (leaseExpiresAtMs !== undefined || startedAtMs === undefined || unknownReason !== undefined) {
      throw new Error('invalid confirmed dispatch projection')
    }
    return
  }
  if (state === 'delivery-unknown') {
    if (leaseExpiresAtMs !== undefined || startedAtMs === undefined || unknownReason === undefined) {
      throw new Error('invalid uncertain dispatch projection')
    }
    return
  }
  if (state !== 'invalid' || unknownReason !== undefined) throw new Error('invalid owned dispatch state')
}

function pragmaNumber(database: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = record(database.prepare(`PRAGMA ${name}`).get())
  const value = Object.values(row)[0]
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new TaskContinuationStoreCorruptionError(`invalid ${name}`)
  }
  return Number(value)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskContinuationStoreCorruptionError('database row is not a record')
  }
  return value as Record<string, unknown>
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TaskContinuationStoreCorruptionError(`invalid ${key}`)
  return value
}

function readNonEmptyString(row: Record<string, unknown>, key: string): string {
  const value = readString(row, key)
  if (value === '') throw new TaskContinuationStoreCorruptionError(`invalid ${key}`)
  return value
}

function readNullableString(row: Record<string, unknown>, key: string): string | undefined {
  return row[key] === null ? undefined : readNonEmptyString(row, key)
}

function readInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  const number = typeof value === 'bigint' ? Number(value) : value
  if (!Number.isSafeInteger(number) || (number as number) < 0) {
    throw new TaskContinuationStoreCorruptionError(`invalid ${key}`)
  }
  return number as number
}

function readNullableInteger(row: Record<string, unknown>, key: string): number | undefined {
  return row[key] === null ? undefined : readInteger(row, key)
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code
}
