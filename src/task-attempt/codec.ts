import { isAbsolute, resolve } from 'node:path'
import {
  readBoundedString,
  readLiteral,
  readNonNegativeInteger,
  readSha256Digest,
  readStrictRecord,
} from '../domain/codec.ts'
import { failDomain } from '../domain/errors.ts'
import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type {
  TaskAttempt,
  TaskAttemptAgentRoute,
  TaskAttemptDerivation,
  TaskAttemptNeed,
  TaskAttemptOutcome,
  TaskAttemptPhase,
  TaskAttemptResult,
  TaskRetryContinuation,
} from './types.ts'

const PHASES = [
  'checking-existing', 'resolving', 'awaiting-approval', 'acquiring', 'verifying-visibility',
  'restart-required', 'ready-to-resume', 'resuming',
] as const satisfies readonly TaskAttemptPhase[]
const OUTCOMES = [
  'use-existing', 'continued', 'choice-required', 'management-required', 'no-eligible-candidate',
  'discovery-unavailable', 'external-only', 'rejected', 'canceled', 'recovery-required',
  'resume-conflict', 'failed',
] as const satisfies readonly TaskAttemptOutcome[]
const TRIGGERS = ['model', 'choice-selection', 'retry-original'] as const
const DERIVATIONS = ['choice-selection', 'retry-original'] as const
const ACTIONS = ['configure', 'enable', 'restore', 'update'] as const
const MODALITIES = ['audio', 'file', 'image', 'structured-data', 'text', 'video'] as const
const ACCESS = ['filesystem-read', 'filesystem-write', 'network', 'subprocess'] as const
const SCOPES = ['profile:web', 'project', 'user'] as const
const PLATFORMS = ['darwin', 'linux', 'windows'] as const
const TAG = /^[a-z0-9]+(?:[./-][a-z0-9]+)*$/
const ATTEMPT_ID = /^task-attempt:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RESOLUTION_ID = /^resolution:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CANDIDATE_REF = /^(?:mcp|plugin|skill):[A-Za-z0-9@._:/-]{1,240}$/
const EXTENSION_REF = /^extension-ref:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_ROUTE_BYTES = 256
const MAX_RESUME_TOKENS = 1_000_000

function fail(path: string, reason: string): never {
  return failDomain('invalid-data', `${path} ${reason}`)
}

function nullableString(value: unknown, path: string, maximum = 512): string | null {
  return value === null ? null : readBoundedString(value, path, maximum)
}

function identifier(value: unknown, path: string, pattern: RegExp): string {
  const output = readBoundedString(value, path, 512)
  if (!pattern.test(output)) fail(path, 'is invalid')
  return output
}

function sortedUnique<T extends string>(
  value: unknown,
  path: string,
  maximum: number,
  allowed?: readonly T[],
): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path, 'must be a bounded array')
  const output = value.map((item, index) => {
    const text = readBoundedString(item, `${path}[${String(index)}]`, 256)
    if (allowed === undefined ? !TAG.test(text) : !allowed.includes(text as T)) fail(`${path}[${String(index)}]`, 'is invalid')
    return text as T
  })
  if (new Set(output).size !== output.length || output.some((item, index) => item !== [...output].sort()[index])) {
    fail(path, 'must be sorted and unique')
  }
  return Object.freeze(output)
}

function need(value: unknown, path: string): TaskAttemptNeed {
  const record = readStrictRecord(value, [
    'inputModalities', 'maximumAuthority', 'outcomeTags', 'outputModalities', 'platform',
    'requiredDataAccess', 'schemaVersion', 'scopeKey',
  ], path)
  if (record.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must be 1')
  const outcomeTags = sortedUnique(record.outcomeTags, `${path}.outcomeTags`, 16)
  if (outcomeTags.length === 0) fail(`${path}.outcomeTags`, 'must not be empty')
  const inputModalities = sortedUnique(record.inputModalities, `${path}.inputModalities`, 6, MODALITIES)
  const outputModalities = sortedUnique(record.outputModalities, `${path}.outputModalities`, 6, MODALITIES)
  if (inputModalities.length === 0 || outputModalities.length === 0) fail(path, 'must retain input and output modalities')
  return Object.freeze({
    schemaVersion: 1,
    outcomeTags,
    inputModalities,
    outputModalities,
    scopeKey: readLiteral(record.scopeKey, SCOPES, `${path}.scopeKey`),
    platform: readLiteral(record.platform, PLATFORMS, `${path}.platform`),
    requiredDataAccess: sortedUnique(record.requiredDataAccess, `${path}.requiredDataAccess`, 4, ACCESS),
    maximumAuthority: sortedUnique(record.maximumAuthority, `${path}.maximumAuthority`, 4, ACCESS),
  })
}

function route(value: unknown, path: string): TaskAttemptAgentRoute {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
  const keys = Object.keys(value as Record<string, unknown>).sort()
  if (keys.some(key => !['maxTokens', 'model', 'provider'].includes(key))) fail(path, 'contains an unsupported field')
  const input = value as Record<string, unknown>
  const provider = input.provider === undefined ? undefined : readBoundedString(input.provider, `${path}.provider`, 256)
  const model = input.model === undefined ? undefined : readBoundedString(input.model, `${path}.model`, 256)
  const maxTokens = input.maxTokens === undefined ? undefined : readNonNegativeInteger(input.maxTokens, `${path}.maxTokens`)
  if ((provider !== undefined && Buffer.byteLength(provider, 'utf8') > MAX_ROUTE_BYTES)
    || (model !== undefined && Buffer.byteLength(model, 'utf8') > MAX_ROUTE_BYTES)
    || maxTokens === 0 || (maxTokens !== undefined && maxTokens > MAX_RESUME_TOKENS)) {
    fail(path, 'is outside the continuation allowlist')
  }
  return Object.freeze({
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  })
}

function candidateRefs(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) fail(path, 'must contain one to three candidates')
  const output = value.map((item, index) => identifier(item, `${path}[${String(index)}]`, CANDIDATE_REF))
  if (new Set(output).size !== output.length || output.some((item, index) => item !== [...output].sort()[index])) {
    fail(path, 'must be sorted and unique')
  }
  return Object.freeze(output)
}

function result(value: unknown, path: string): TaskAttemptResult {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be null or an object')
  const kind = (value as Record<string, unknown>).kind
  if (kind === 'use-existing') {
    const record = readStrictRecord(value, ['capabilityId', 'kind'], path)
    return Object.freeze({ kind, capabilityId: readBoundedString(record.capabilityId, `${path}.capabilityId`, 512) })
  }
  if (kind === 'choice-required') {
    const record = readStrictRecord(value, ['candidateRefs', 'kind'], path)
    return Object.freeze({ kind, candidateRefs: candidateRefs(record.candidateRefs, `${path}.candidateRefs`) })
  }
  if (kind === 'management-required') {
    const record = readStrictRecord(value, ['action', 'extensionRef', 'kind', 'targetKey'], path)
    return Object.freeze({
      kind,
      extensionRef: identifier(record.extensionRef, `${path}.extensionRef`, EXTENSION_REF),
      targetKey: readBoundedString(record.targetKey, `${path}.targetKey`, 1024),
      action: readLiteral(record.action, ACTIONS, `${path}.action`),
    })
  }
  if (kind === 'acquisition-candidate') {
    const record = readStrictRecord(value, [
      'candidateRef', 'continuationId', 'kind', 'resolutionId', 'verificationPayloadDigest',
    ], path)
    return Object.freeze({
      kind,
      resolutionId: identifier(record.resolutionId, `${path}.resolutionId`, RESOLUTION_ID),
      candidateRef: identifier(record.candidateRef, `${path}.candidateRef`, CANDIDATE_REF),
      continuationId: identifier(record.continuationId, `${path}.continuationId`, UUID),
      verificationPayloadDigest: readSha256Digest(record.verificationPayloadDigest, `${path}.verificationPayloadDigest`),
    })
  }
  return fail(`${path}.kind`, 'is invalid')
}

/** Decode one task attempt and enforce its terminal/result invariants. */
export function decodeTaskAttempt(value: unknown, expectedTaskAttemptId?: string): TaskAttempt {
  const path = expectedTaskAttemptId === undefined ? 'task attempt' : `task attempt ${expectedTaskAttemptId}`
  const record = readStrictRecord(value, [
    'createdAtMs', 'expiresAtMs', 'need', 'needDigest', 'originalMessageId', 'outcome', 'parentAttemptId',
    'phase', 'profileId', 'projectRoot', 'reason', 'resumeAgentOptions', 'revision', 'schemaVersion', 'sessionId',
    'taskAttemptId', 'trigger', 'updatedAtMs', 'result',
  ], path)
  if (record.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must be 1')
  const taskAttemptId = identifier(record.taskAttemptId, `${path}.taskAttemptId`, ATTEMPT_ID)
  if (expectedTaskAttemptId !== undefined && taskAttemptId !== expectedTaskAttemptId) fail(`${path}.taskAttemptId`, 'does not bind storage identity')
  const parentAttemptId = record.parentAttemptId === null
    ? null
    : identifier(record.parentAttemptId, `${path}.parentAttemptId`, ATTEMPT_ID)
  const trigger = readLiteral(record.trigger, TRIGGERS, `${path}.trigger`)
  if ((trigger === 'model') !== (parentAttemptId === null)) fail(path, 'has contradictory trigger and parent')
  const projectRoot = readBoundedString(record.projectRoot, `${path}.projectRoot`, 4096)
  if (!isAbsolute(projectRoot) || resolve(projectRoot) !== projectRoot) fail(`${path}.projectRoot`, 'must be a canonical absolute path')
  const decodedNeed = need(record.need, `${path}.need`)
  const needDigest = readSha256Digest(record.needDigest, `${path}.needDigest`)
  if (needDigest !== canonicalSha256(decodedNeed)) fail(`${path}.needDigest`, 'does not bind need')
  const createdAtMs = readNonNegativeInteger(record.createdAtMs, `${path}.createdAtMs`)
  const expiresAtMs = readNonNegativeInteger(record.expiresAtMs, `${path}.expiresAtMs`)
  const updatedAtMs = readNonNegativeInteger(record.updatedAtMs, `${path}.updatedAtMs`)
  if (createdAtMs >= expiresAtMs || updatedAtMs < createdAtMs) fail(path, 'has an invalid time interval')
  const outcome = record.outcome === null ? null : readLiteral(record.outcome, OUTCOMES, `${path}.outcome`)
  const reason = nullableString(record.reason, `${path}.reason`, 256)
  if ((outcome === null) !== (reason === null)) fail(path, 'must assign outcome and bounded reason together')
  const decodedResult = result(record.result, `${path}.result`)
  const phase = readLiteral(record.phase, PHASES, `${path}.phase`)
  if (outcome === 'use-existing' && decodedResult?.kind !== 'use-existing') fail(path, 'has no existing-capability result')
  if (outcome === 'choice-required' && decodedResult?.kind !== 'choice-required') fail(path, 'has no choice result')
  if (outcome === 'management-required' && decodedResult?.kind !== 'management-required') fail(path, 'has no management result')
  if (outcome === null) {
    if (phase === 'checking-existing' || phase === 'resolving') {
      if (decodedResult !== null) fail(path, 'assigns a result before resolution')
    } else if (decodedResult?.kind !== 'acquisition-candidate') {
      fail(path, 'has no acquisition binding')
    }
  } else if (outcome === 'no-eligible-candidate' || outcome === 'discovery-unavailable' || outcome === 'external-only') {
    if (decodedResult !== null) fail(path, 'has an unexpected terminal result')
  } else if (!['use-existing', 'choice-required', 'management-required'].includes(outcome)
    && decodedResult !== null && decodedResult.kind !== 'acquisition-candidate') {
    fail(path, 'has an unrelated terminal result')
  }
  if (outcome === 'continued' && (phase !== 'resuming' || decodedResult?.kind !== 'acquisition-candidate')) {
    fail(path, 'does not bind a resumed acquisition')
  }
  return immutableJsonClone({
    schemaVersion: 1,
    taskAttemptId,
    parentAttemptId,
    trigger,
    revision: readNonNegativeInteger(record.revision, `${path}.revision`),
    sessionId: readBoundedString(record.sessionId, `${path}.sessionId`, 512),
    originalMessageId: readBoundedString(record.originalMessageId, `${path}.originalMessageId`, 512),
    profileId: readBoundedString(record.profileId, `${path}.profileId`, 128),
    projectRoot,
    need: decodedNeed,
    needDigest,
    resumeAgentOptions: route(record.resumeAgentOptions, `${path}.resumeAgentOptions`),
    createdAtMs,
    expiresAtMs,
    updatedAtMs,
    phase,
    outcome,
    reason,
    result: decodedResult,
  }) as unknown as TaskAttempt
}

/** Decode one durable one-shot task-attempt derivation claim. */
export function decodeTaskAttemptDerivation(value: unknown, expectedSourceAttemptId?: string): TaskAttemptDerivation {
  const path = expectedSourceAttemptId === undefined ? 'task attempt derivation' : `task attempt derivation ${expectedSourceAttemptId}`
  const record = readStrictRecord(value, ['attempt', 'candidateRef', 'createdAtMs', 'kind', 'schemaVersion', 'sourceAttemptId'], path)
  if (record.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must be 1')
  const sourceAttemptId = identifier(record.sourceAttemptId, `${path}.sourceAttemptId`, ATTEMPT_ID)
  if (expectedSourceAttemptId !== undefined && sourceAttemptId !== expectedSourceAttemptId) fail(`${path}.sourceAttemptId`, 'does not bind storage identity')
  const kind = readLiteral(record.kind, DERIVATIONS, `${path}.kind`)
  const candidateRef = record.candidateRef === null ? null : identifier(record.candidateRef, `${path}.candidateRef`, CANDIDATE_REF)
  if ((kind === 'choice-selection') !== (candidateRef !== null)) fail(path, 'has contradictory derivation input')
  const attempt = decodeTaskAttempt(record.attempt)
  if (attempt.parentAttemptId !== sourceAttemptId || attempt.trigger !== kind) fail(`${path}.attempt`, 'does not bind source and trigger')
  const createdAtMs = readNonNegativeInteger(record.createdAtMs, `${path}.createdAtMs`)
  if (createdAtMs !== attempt.createdAtMs) fail(`${path}.createdAtMs`, 'does not bind the derived attempt')
  return immutableJsonClone({
    schemaVersion: 1,
    sourceAttemptId,
    kind,
    candidateRef,
    createdAtMs,
    attempt,
  }) as unknown as TaskAttemptDerivation
}

/** Decode one durable verifier binding for management Retry original. */
export function decodeTaskRetryContinuation(value: unknown, expectedTaskAttemptId?: string): TaskRetryContinuation {
  const path = expectedTaskAttemptId === undefined ? 'task retry continuation' : `task retry continuation ${expectedTaskAttemptId}`
  const record = readStrictRecord(value, [
    'action', 'canceledAtMs', 'continuationId', 'createdAtMs', 'existingCapabilityId', 'expiresAtMs', 'needDigest',
    'originalMessageId', 'parentAttemptId', 'schemaVersion', 'sessionId', 'targetKey', 'taskAttemptId',
    'verificationPayloadDigest',
  ], path)
  if (record.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must be 1')
  const taskAttemptId = identifier(record.taskAttemptId, `${path}.taskAttemptId`, ATTEMPT_ID)
  if (expectedTaskAttemptId !== undefined && taskAttemptId !== expectedTaskAttemptId) {
    fail(`${path}.taskAttemptId`, 'does not bind storage identity')
  }
  const createdAtMs = readNonNegativeInteger(record.createdAtMs, `${path}.createdAtMs`)
  const expiresAtMs = readNonNegativeInteger(record.expiresAtMs, `${path}.expiresAtMs`)
  if (createdAtMs >= expiresAtMs) fail(path, 'has an invalid validity interval')
  const canceledAtMs = record.canceledAtMs === null
    ? null
    : readNonNegativeInteger(record.canceledAtMs, `${path}.canceledAtMs`)
  if (canceledAtMs !== null && canceledAtMs < createdAtMs) fail(`${path}.canceledAtMs`, 'precedes creation')
  return immutableJsonClone({
    schemaVersion: 1,
    taskAttemptId,
    parentAttemptId: identifier(record.parentAttemptId, `${path}.parentAttemptId`, ATTEMPT_ID),
    sessionId: readBoundedString(record.sessionId, `${path}.sessionId`, 512),
    originalMessageId: readBoundedString(record.originalMessageId, `${path}.originalMessageId`, 512),
    needDigest: readSha256Digest(record.needDigest, `${path}.needDigest`),
    targetKey: readBoundedString(record.targetKey, `${path}.targetKey`, 1024),
    action: readLiteral(record.action, ACTIONS, `${path}.action`),
    existingCapabilityId: readBoundedString(record.existingCapabilityId, `${path}.existingCapabilityId`, 512),
    verificationPayloadDigest: readSha256Digest(record.verificationPayloadDigest, `${path}.verificationPayloadDigest`),
    continuationId: record.continuationId === null
      ? null
      : identifier(record.continuationId, `${path}.continuationId`, UUID),
    canceledAtMs,
    createdAtMs,
    expiresAtMs,
  }) as unknown as TaskRetryContinuation
}
