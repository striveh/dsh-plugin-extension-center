/** Strict codecs for plugin-owned continuation inputs and durable records. */

import { TASK_CONTINUATION_INVALID_REASONS } from './types.ts'
import type {
  ContinuationAgent,
  ContinuationAgentOptions,
  ContinuationMessage,
  CreateTaskContinuationRequest,
  ListTaskContinuationsRequest,
  ReserveTaskContinuationRequest,
  SupersedeTaskContinuationRequest,
  TaskContinuationClaim,
  TaskContinuationInvalidReason,
  TaskContinuationRef,
  TaskContinuationReady,
} from './types.ts'

/** Fixed prompt that asks the existing Agent to re-check the now-visible capability. */
export const TASK_CONTINUATION_PROMPT = 'The requested capability is now verified for the existing task. Re-check it and continue that task.'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_ROUTE_BYTES = 256
const MAX_RESUME_TOKENS = 1_000_000

/** Stable rejection for malformed continuation input. */
export class TaskContinuationInputError extends Error {
  readonly code = 'TASK_CONTINUATION_INVALID_INPUT'
}

/** Stable rejection for replay of one caller key with different immutable fields. */
export class TaskContinuationMutationConflictError extends Error {
  readonly code = 'TASK_CONTINUATION_MUTATION_CONFLICT'

  constructor(callerId: string, mutationId: string) {
    super(`task continuation mutation "${callerId}/${mutationId}" is already bound to different input`)
  }
}

/** Parse one fixed invalid-claim diagnosis without admitting free-form text. */
export function invalidReason(value: unknown): TaskContinuationInvalidReason {
  if (typeof value !== 'string'
    || !TASK_CONTINUATION_INVALID_REASONS.includes(value as TaskContinuationInvalidReason)) {
    throw new TaskContinuationInputError('task continuation invalid reason is unsupported')
  }
  return value as TaskContinuationInvalidReason
}

/** Parse the exact fields shared by live and cold reservations. */
export function createRequest(value: unknown): CreateTaskContinuationRequest {
  const record = exactRecord(value, [
    'callerId', 'expiresAtMs', 'mutationId', 'needDigest', 'originalMessageId', 'sessionId',
    'taskRevision', 'verificationPayloadDigest', 'verifierId',
  ], 'task continuation request')
  return Object.freeze({
    callerId: kebab(record['callerId'], 'continuation caller id'),
    mutationId: safeId(record['mutationId'], 'continuation mutation id'),
    sessionId: boundedIdentity(record['sessionId'], 'continuation session id'),
    originalMessageId: boundedIdentity(record['originalMessageId'], 'continuation original message id'),
    needDigest: digest(record['needDigest'], 'continuation need digest'),
    taskRevision: safeId(record['taskRevision'], 'continuation task revision'),
    verifierId: kebab(record['verifierId'], 'continuation verifier id'),
    verificationPayloadDigest: digest(record['verificationPayloadDigest'], 'continuation verification payload digest'),
    expiresAtMs: epoch(record['expiresAtMs'], 'continuation expiry'),
  })
}

/** Parse a cold-safe reservation including its restricted Agent route. */
export function reserveRequest(value: unknown): ReserveTaskContinuationRequest {
  const record = exactRecord(value, [
    'callerId', 'expiresAtMs', 'mutationId', 'needDigest', 'originalMessageId', 'resumeAgentOptions',
    'sessionId', 'taskRevision', 'verificationPayloadDigest', 'verifierId',
  ], 'task continuation reservation')
  const base = createRequest(Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== 'resumeAgentOptions')))
  return Object.freeze({ ...base, resumeAgentOptions: agentOptions(record['resumeAgentOptions']) })
}

/** Parse optional exact list filters. */
export function listRequest(value: unknown = {}): ListTaskContinuationsRequest {
  const record = exactRecord(value, Object.keys(recordValue(value, 'task continuation list')).sort(), 'task continuation list')
  if (Object.keys(record).some(key => !['callerId', 'mutationId', 'sessionId'].includes(key))) {
    throw new TaskContinuationInputError('task continuation list contains unsupported fields')
  }
  const callerId = record['callerId'] === undefined ? undefined : kebab(record['callerId'], 'continuation caller id')
  const mutationId = record['mutationId'] === undefined ? undefined : safeId(record['mutationId'], 'continuation mutation id')
  if (mutationId !== undefined && callerId === undefined) {
    throw new TaskContinuationInputError('task continuation mutation filter requires callerId')
  }
  return Object.freeze({
    ...(record['sessionId'] === undefined ? {} : { sessionId: boundedIdentity(record['sessionId'], 'continuation session id') }),
    ...(callerId === undefined ? {} : { callerId }),
    ...(mutationId === undefined ? {} : { mutationId }),
  })
}

/** Parse an exact cancel fence. */
export function continuationRef(value: unknown): TaskContinuationRef {
  const record = exactRecord(value, ['id', 'sessionId', 'taskRevision'], 'task continuation ref')
  return Object.freeze({
    id: uuid(record['id'], 'continuation id'),
    sessionId: boundedIdentity(record['sessionId'], 'continuation session id'),
    taskRevision: safeId(record['taskRevision'], 'continuation task revision'),
  })
}

/** Parse an exact supersede fence and replacement revision. */
export function supersedeRequest(value: unknown): SupersedeTaskContinuationRequest {
  const record = exactRecord(value, ['id', 'replacementTaskRevision', 'sessionId', 'taskRevision'], 'task continuation supersede')
  return Object.freeze({
    id: uuid(record['id'], 'continuation id'),
    sessionId: boundedIdentity(record['sessionId'], 'continuation session id'),
    taskRevision: safeId(record['taskRevision'], 'continuation task revision'),
    replacementTaskRevision: safeId(record['replacementTaskRevision'], 'continuation replacement task revision'),
  })
}

/** Validate and snapshot a bounded cold-resume route. */
export function agentOptions(value: unknown): Readonly<ContinuationAgentOptions> {
  const record = recordValue(value, 'task continuation Agent options')
  if (Object.keys(record).some(key => !['maxTokens', 'model', 'provider'].includes(key))) {
    throw new TaskContinuationInputError('task continuation Agent options contain unsupported fields')
  }
  const output: ContinuationAgentOptions = {}
  for (const key of ['provider', 'model'] as const) {
    const field = record[key]
    if (field === undefined) continue
    if (typeof field !== 'string' || field === '' || Buffer.byteLength(field, 'utf8') > MAX_ROUTE_BYTES) {
      throw new TaskContinuationInputError(`task continuation Agent ${key} must be 1-${String(MAX_ROUTE_BYTES)} UTF-8 bytes`)
    }
    ;(output as Record<typeof key, string>)[key] = field
  }
  const maxTokens = record['maxTokens']
  if (maxTokens !== undefined) {
    if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) <= 0 || (maxTokens as number) > MAX_RESUME_TOKENS) {
      throw new TaskContinuationInputError(`task continuation Agent maxTokens must be 1-${String(MAX_RESUME_TOKENS)}`)
    }
    ;(output as { maxTokens?: number }).maxTokens = maxTokens as number
  }
  return Object.freeze(output)
}

/** Parse an unknown live Agent at the official same-process boundary. */
export function continuationAgent(value: unknown): ContinuationAgent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskContinuationInputError('task continuation requires an official live Agent')
  }
  const record = value as Record<string, unknown>
  const session = record['session']
  if (typeof record['id'] !== 'string' || typeof session !== 'object' || session === null || Array.isArray(session)
    || !Array.isArray((session as Record<string, unknown>)['events']) || typeof record['followup'] !== 'function'
    || typeof record['whenIdle'] !== 'function') {
    throw new TaskContinuationInputError('task continuation requires an official live Agent')
  }
  return value as unknown as ContinuationAgent
}

/** Create the ordinary plugin-sourced follow-up without original task text. */
export function continuationMessage(claim: TaskContinuationClaim): ContinuationMessage {
  return Object.freeze({
    id: claim.dispatchMessageId,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text' as const, text: TASK_CONTINUATION_PROMPT })]) as readonly [Readonly<{ type: 'text'; text: string }>],
    source: Object.freeze({ kind: 'plugin' as const, plugin: 'dsh-plugin-extension-center' as const }),
  })
}

/** Compare a message to the one canonical dispatch identity and content. */
export function isContinuationMessage(value: unknown, claim: TaskContinuationClaim): boolean {
  if (!isRecord(value) || value['id'] !== claim.dispatchMessageId || value['role'] !== 'user'
    || !Array.isArray(value['content']) || value['content'].length !== 1 || !isRecord(value['content'][0])
    || value['content'][0]['type'] !== 'text' || value['content'][0]['text'] !== TASK_CONTINUATION_PROMPT
    || !isRecord(value['source'])) return false
  return value['source']['kind'] === 'plugin' && value['source']['plugin'] === 'dsh-plugin-extension-center'
}

/** Require a fully echoed positive verifier result. */
export function readyDecision(value: unknown, claim: TaskContinuationClaim): TaskContinuationReady | 'not-ready' | 'invalid' {
  if (isRecord(value) && value['kind'] === 'not-ready' && Object.keys(value).length === 1) return 'not-ready'
  if (!isRecord(value) || value['kind'] !== 'ready') return 'invalid'
  const expected = {
    kind: 'ready',
    continuationId: claim.continuationId,
    sessionId: claim.sessionId,
    originalMessageId: claim.originalMessageId,
    needDigest: claim.needDigest,
    taskRevision: claim.taskRevision,
    verificationPayloadDigest: claim.verificationPayloadDigest,
  } as const
  if (Object.keys(value).sort().join('\0') !== Object.keys(expected).sort().join('\0')) return 'invalid'
  for (const [key, field] of Object.entries(expected)) {
    if (value[key] !== field) return 'invalid'
  }
  return expected
}

/** Compare restricted routes without depending on object key order. */
export function sameAgentOptions(left: Readonly<ContinuationAgentOptions>, right: Readonly<ContinuationAgentOptions>): boolean {
  return left.provider === right.provider && left.model === right.model && left.maxTokens === right.maxTokens
}

/** Compare one existing claim with an idempotent replay. */
export function assertSameReservation(
  existing: TaskContinuationClaim,
  request: CreateTaskContinuationRequest,
  options: Readonly<ContinuationAgentOptions>,
): void {
  if (existing.callerId !== request.callerId || existing.mutationId !== request.mutationId
    || existing.sessionId !== request.sessionId || existing.originalMessageId !== request.originalMessageId
    || existing.needDigest !== request.needDigest || existing.taskRevision !== request.taskRevision
    || existing.verifierId !== request.verifierId
    || existing.verificationPayloadDigest !== request.verificationPayloadDigest
    || existing.expiresAtMs !== request.expiresAtMs || !sameAgentOptions(existing.resumeAgentOptions, options)) {
    throw new TaskContinuationMutationConflictError(existing.callerId, existing.mutationId)
  }
}

/** Validate one database or API continuation identity. */
export function continuationId(value: unknown): string {
  return uuid(value, 'continuation id')
}

/** Validate one database state-machine revision. */
export function taskRevision(value: unknown): string {
  return safeId(value, 'continuation task revision')
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = recordValue(value, label)
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TaskContinuationInputError(`${label} has unexpected fields`)
  }
  return record
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TaskContinuationInputError(`${label} must be a plain object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function boundedIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > 512) {
    throw new TaskContinuationInputError(`${label} must be 1-512 UTF-8 bytes`)
  }
  return value
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TaskContinuationInputError(`${label} must be a 1-128 safe identifier`)
  }
  return value
}

function kebab(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 128 || !KEBAB.test(value)) {
    throw new TaskContinuationInputError(`${label} must be 1-128 lower-kebab characters`)
  }
  return value
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new TaskContinuationInputError(`${label} must use canonical lower-case SHA-256 syntax`)
  }
  return value
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TaskContinuationInputError(`${label} must be a UUID`)
  return value
}

function epoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TaskContinuationInputError(`${label} must be a non-negative epoch-millisecond integer`)
  }
  return value as number
}
