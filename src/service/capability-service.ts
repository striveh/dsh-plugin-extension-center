import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { CatalogEntry } from '../catalog-contract.ts'
import type { VerifiedCatalog } from '../catalog.ts'
import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type { HostOwners, StoredResolution } from '../host/index.ts'
import { CenterStateStore, hostCapabilities } from '../host/index.ts'
import type { InventoryRow } from '../inventory/index.ts'
import {
  candidateAdmissionFacts,
  currentHostPlatform,
  evaluateCandidatePolicy,
  type CandidatePolicyResult,
} from '../policy/index.ts'
import {
  resolveCapability,
  type CapabilityNeed,
  type CapabilityResolution,
  type ExistingCapability,
} from '../resolution/index.ts'
import { FileOperationStore, FilePlanStore } from '../storage/index.ts'
import {
  FileTaskAttemptStore,
  type TaskAttempt,
  type TaskAttemptNeed,
  type TaskAttemptProjection,
  type TaskAttemptResult,
  type TaskRetryContinuation,
  type TaskRetryContinuationProjection,
  type TaskRetryContinuationState,
} from '../task-attempt/index.ts'
import type {
  IntentPreviewResponse,
  RpcJson,
  TaskAttemptResolutionResponse,
  TaskConfigurationRow,
} from './rpc-contract.ts'
import { HOST_RPC_PROTOCOL_VERSION } from './rpc-contract.ts'
import type { IntentPlanService, TaskIntentBinding } from './intent-plan-service.ts'
import { HostInventoryService } from './inventory-service.ts'

const VERIFIER_ID = 'extension-center-acquisition'
const RETRY_VERIFIER_ID = 'extension-center-management-retry'
const TAG = /^[a-z0-9]+(?:[./-][a-z0-9]+)*$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CANDIDATE_REF = /^(?:plugin|mcp|skill):[A-Za-z0-9@._:/-]{1,240}$/
const SHA256 = /^sha256:[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_CONTINUATION_ROUTE_BYTES = 256
const MAX_CONTINUATION_RESUME_TOKENS = 1_000_000
const MODALITIES = ['audio', 'file', 'image', 'structured-data', 'text', 'video'] as const
const ACCESS = ['filesystem-read', 'filesystem-write', 'network', 'subprocess'] as const
const RETRY_CONTINUATION_STATES = [
  'pending', 'ready', 'consumed', 'claimed', 'canceled', 'superseded', 'expired', 'invalid',
] as const satisfies readonly TaskRetryContinuationState[]

interface ObservedRetryContinuationClaim {
  readonly continuationId: string
  readonly callerId: string
  readonly mutationId: string
  readonly recordRevision: number
  readonly state: TaskRetryContinuationState
  readonly dispatchMessageId: string
  readonly sessionId: string
  readonly originalMessageId: string
  readonly needDigest: string
  readonly taskRevision: string
  readonly verifierId: string
  readonly verificationPayloadDigest: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly expiresAtMs: number
  readonly resumeAgentOptions: RestrictedAgentOptions
  readonly supersededByTaskRevision?: string
}

/** Strict model input for local existing-first capability retrieval. */
export interface ModelCapabilityNeed {
  readonly outcomeTags: readonly string[]
  readonly inputModalities: readonly (typeof MODALITIES)[number][]
  readonly outputModalities: readonly (typeof MODALITIES)[number][]
  readonly scopeKey: 'profile:web' | 'user' | 'project'
  readonly profileId: string
  readonly requiredDataAccess: readonly (typeof ACCESS)[number][]
  readonly maximumAuthority: readonly (typeof ACCESS)[number][]
}

/** Safe, prose-free result returned to the model. */
export interface ModelCapabilityResolution extends TaskAttemptResolutionResponse {}

/** Opaque-only request accepted by the acquisition tool. */
export interface ModelAcquisitionRequest {
  readonly resolutionId: string
  readonly candidateRef: string
  readonly continuationId: string
}

/** Safe immutable-plan projection; it never records a human decision. */
export interface ModelAcquisitionResult {
  readonly protocolVersion: typeof HOST_RPC_PROTOCOL_VERSION
  readonly resolutionId: string
  readonly continuationId: string
  readonly candidateRef: string
  readonly planId: string
  readonly planHash: string
  readonly operationKind: string
  readonly status: 'approval-required'
}

interface ResolutionCandidate {
  readonly candidateRef: string
  readonly operationKind: 'install' | 'configure' | 'enable' | 'update' | 'restore'
  readonly targetKey: string | null
  readonly configuration: RpcJson
}

interface ResolutionValue {
  readonly decision: CapabilityResolution['decision']
  readonly taskAttemptId: string
  readonly scopeKey: ModelCapabilityNeed['scopeKey']
  readonly profileId: string
  readonly catalogRevision: number
  readonly catalogEntriesDigest: string
  readonly inventoryRevision: string
  readonly continuationId: string | null
  readonly verificationPayloadDigest: string | null
  readonly intentId: string
  readonly planId: string
  readonly createdAtMs: number
  readonly expiresAtMs: number
  readonly sessionId: string
  readonly originalMessageId: string
  readonly resumeAgentOptions: RestrictedAgentOptions
  readonly candidates: readonly ResolutionCandidate[]
}

interface RestrictedAgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function stringSet<T extends string>(
  value: unknown,
  name: string,
  allowed?: readonly T[],
  allowEmpty = false,
): readonly T[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 16
    || value.some(item => typeof item !== 'string')) throw new Error(`${name} must be a bounded string set`)
  const values = value as string[]
  if (allowed === undefined) {
    if (values.some(item => !TAG.test(item))) throw new Error(`${name} contains an invalid tag`)
  } else if (values.some(item => !allowed.includes(item as T))) {
    throw new Error(`${name} contains an unsupported value`)
  }
  if (new Set(values).size !== values.length) throw new Error(`${name} contains duplicates`)
  return Object.freeze([...values].sort()) as readonly T[]
}

function modelNeed(value: unknown): ModelCapabilityNeed {
  const keys = ['inputModalities', 'maximumAuthority', 'outcomeTags', 'outputModalities', 'profileId', 'requiredDataAccess', 'scopeKey']
  if (!exactRecord(value, keys)
    || !['profile:web', 'project', 'user'].includes(String(value.scopeKey))
    || typeof value.profileId !== 'string'
    || !SAFE_ID.test(value.profileId)) throw new Error('capability need fields are invalid')
  return Object.freeze({
    outcomeTags: stringSet(value.outcomeTags, 'outcomeTags'),
    inputModalities: stringSet(value.inputModalities, 'inputModalities', MODALITIES),
    outputModalities: stringSet(value.outputModalities, 'outputModalities', MODALITIES),
    scopeKey: value.scopeKey as ModelCapabilityNeed['scopeKey'],
    profileId: value.profileId,
    requiredDataAccess: stringSet(value.requiredDataAccess, 'requiredDataAccess', ACCESS, true),
    maximumAuthority: stringSet(value.maximumAuthority, 'maximumAuthority', ACCESS, true),
  })
}

function acquisitionRequest(value: unknown): ModelAcquisitionRequest {
  if (!exactRecord(value, ['candidateRef', 'continuationId', 'resolutionId'])
    || typeof value.resolutionId !== 'string'
    || !/^resolution:[0-9a-f-]{36}$/.test(value.resolutionId)
    || typeof value.candidateRef !== 'string'
    || !CANDIDATE_REF.test(value.candidateRef)
    || typeof value.continuationId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(value.continuationId)) {
    throw new Error('acquisition request accepts only exact opaque identifiers')
  }
  return value as unknown as ModelAcquisitionRequest
}

function words(value: string): readonly string[] {
  return Object.freeze([...new Set(value.toLowerCase().split(/[^a-z0-9./-]+/u).filter(item => TAG.test(item)))].sort())
}

type CapabilityDataAccess = ModelCapabilityNeed['requiredDataAccess'][number]

type ToolCapabilityFacts = Readonly<{
  outcomeTags: readonly string[]
  dataAccess: readonly CapabilityDataAccess[]
}>

function capabilityFacts(
  outcomeTags: readonly string[],
  dataAccess: readonly CapabilityDataAccess[],
): ToolCapabilityFacts {
  return Object.freeze({ outcomeTags: Object.freeze([...outcomeTags]), dataAccess: Object.freeze([...dataAccess]) })
}

const TOOL_CAPABILITY_FACTS: Readonly<Record<string, ToolCapabilityFacts>> = Object.freeze({
  lsp: capabilityFacts(['code', 'language', 'lsp'], ['filesystem-read']),
  pwsh: capabilityFacts(['command', 'powershell', 'shell'], ['filesystem-read', 'filesystem-write', 'subprocess']),
  str_replace_editor: capabilityFacts(['edit', 'file', 'filesystem', 'read', 'write'], ['filesystem-read', 'filesystem-write']),
  terminal_close: capabilityFacts(['process', 'shell', 'terminal'], ['subprocess']),
  terminal_list: capabilityFacts(['process', 'shell', 'terminal'], ['subprocess']),
  terminal_open: capabilityFacts(['command', 'process', 'shell', 'terminal'], ['filesystem-read', 'filesystem-write', 'subprocess']),
  terminal_read: capabilityFacts(['process', 'read', 'shell', 'terminal'], ['subprocess']),
  terminal_send: capabilityFacts(['command', 'process', 'shell', 'terminal'], ['filesystem-read', 'filesystem-write', 'subprocess']),
  terminal_signal: capabilityFacts(['process', 'shell', 'terminal'], ['subprocess']),
  web_fetch: capabilityFacts(['fetch', 'http', 'network', 'url', 'web'], ['network']),
  web_search: capabilityFacts(['network', 'search', 'web'], ['network']),
})

function toolCapabilityFacts(name: string, description: unknown): Readonly<{
  outcomeTags: readonly string[]
  dataAccess: readonly CapabilityDataAccess[]
}> {
  const admitted = TOOL_CAPABILITY_FACTS[name]
  return Object.freeze({
    outcomeTags: Object.freeze([...new Set([
      ...words(name),
      ...typeof description === 'string' ? words(description) : [],
      ...(admitted?.outcomeTags ?? []),
    ])].sort()),
    dataAccess: Object.freeze([...(admitted?.dataAccess ?? [])].sort()),
  })
}

function currentPlatform(): CapabilityNeed['platform'] {
  const platform = currentHostPlatform()
  if (platform === 'unsupported') throw new Error('capability acquisition is unavailable on this Host platform')
  return platform
}

function rowCandidate(row: InventoryRow): ResolutionCandidate | undefined {
  if (row.candidateRef === null) return undefined
  const order = ['configure', 'enable', 'update', 'restore'] as const
  const operationKind = order.find(operation => row.actions[operation].status === 'available')
  if (operationKind === undefined) return undefined
  return Object.freeze({ candidateRef: row.candidateRef, operationKind, targetKey: row.targetKey, configuration: null })
}

function parseResolutionValue(value: RpcJson): ResolutionValue {
  if (!exactRecord(value, [
    'candidates', 'catalogEntriesDigest', 'catalogRevision', 'continuationId', 'createdAtMs', 'decision',
    'expiresAtMs', 'intentId', 'inventoryRevision', 'originalMessageId', 'planId', 'profileId',
    'resumeAgentOptions', 'scopeKey', 'sessionId', 'taskAttemptId', 'verificationPayloadDigest',
  ]) || !Array.isArray(value.candidates)) throw new Error('stored task resolution is invalid')
  const candidates = value.candidates.map((item): ResolutionCandidate => {
    if (!exactRecord(item, ['candidateRef', 'configuration', 'operationKind', 'targetKey'])
      || typeof item.candidateRef !== 'string'
      || !CANDIDATE_REF.test(item.candidateRef)
      || !['configure', 'enable', 'install', 'restore', 'update'].includes(String(item.operationKind))
      || (item.targetKey !== null && typeof item.targetKey !== 'string')) throw new Error('stored resolution candidate is invalid')
    return item as unknown as ResolutionCandidate
  })
  if (typeof value.decision !== 'string'
    || typeof value.taskAttemptId !== 'string'
    || !/^task-attempt:[0-9a-f-]{36}$/u.test(value.taskAttemptId)
    || typeof value.scopeKey !== 'string'
    || typeof value.profileId !== 'string'
    || !Number.isSafeInteger(value.catalogRevision)
    || (value.catalogRevision as number) < 1
    || typeof value.catalogEntriesDigest !== 'string'
    || !SHA256.test(value.catalogEntriesDigest)
    || typeof value.inventoryRevision !== 'string'
    || !SHA256.test(value.inventoryRevision)
    || (value.continuationId !== null && typeof value.continuationId !== 'string')
    || (value.verificationPayloadDigest !== null && (typeof value.verificationPayloadDigest !== 'string' || !SHA256.test(value.verificationPayloadDigest)))
    || typeof value.intentId !== 'string'
    || typeof value.planId !== 'string'
    || typeof value.sessionId !== 'string'
    || value.sessionId.length === 0
    || value.sessionId.length > 512
    || typeof value.originalMessageId !== 'string'
    || value.originalMessageId.length === 0
    || value.originalMessageId.length > 512
    || !Number.isSafeInteger(value.createdAtMs)
    || !Number.isSafeInteger(value.expiresAtMs)) throw new Error('stored resolution binding is invalid')
  restrictedAgentOptions(value.resumeAgentOptions)
  return value as unknown as ResolutionValue
}

function restrictedAgentOptions(value: unknown): RestrictedAgentOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Agent resume options are unavailable')
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['maxTokens', 'model', 'provider'].includes(key))
    || (input.provider !== undefined && (typeof input.provider !== 'string' || input.provider === ''
      || Buffer.byteLength(input.provider, 'utf8') > MAX_CONTINUATION_ROUTE_BYTES))
    || (input.model !== undefined && (typeof input.model !== 'string' || input.model === ''
      || Buffer.byteLength(input.model, 'utf8') > MAX_CONTINUATION_ROUTE_BYTES))
    || (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens)
      || (input.maxTokens as number) <= 0
      || (input.maxTokens as number) > MAX_CONTINUATION_RESUME_TOKENS))) {
    throw new Error('Agent resume options are outside the continuation allowlist')
  }
  return Object.freeze({
    ...(input.provider === undefined ? {} : { provider: input.provider as string }),
    ...(input.model === undefined ? {} : { model: input.model as string }),
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens as number }),
  })
}

function observedRetryContinuationClaim(value: unknown): ObservedRetryContinuationClaim {
  const baseKeys = [
    'callerId', 'continuationId', 'createdAtMs', 'dispatchMessageId', 'expiresAtMs', 'kind', 'mutationId',
    'needDigest', 'originalMessageId', 'recordRevision', 'resumeAgentOptions', 'sessionId', 'state',
    'taskRevision', 'updatedAtMs', 'verificationPayloadDigest', 'verifierId', 'version',
  ]
  const hasSupersededRevision = typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, 'supersededByTaskRevision')
  const keys = hasSupersededRevision ? [...baseKeys, 'supersededByTaskRevision'] : baseKeys
  if (!exactRecord(value, keys)) throw new Error('Retry original continuation owner returned an invalid claim')
  const state = value.state
  const createdAtMs = value.createdAtMs
  const updatedAtMs = value.updatedAtMs
  const expiresAtMs = value.expiresAtMs
  if (value.kind !== 'task-continuation'
    || value.version !== 1
    || typeof value.continuationId !== 'string'
    || !UUID.test(value.continuationId)
    || typeof value.dispatchMessageId !== 'string'
    || !UUID.test(value.dispatchMessageId)
    || typeof value.callerId !== 'string'
    || !SAFE_ID.test(value.callerId)
    || typeof value.mutationId !== 'string'
    || !SAFE_ID.test(value.mutationId)
    || typeof value.sessionId !== 'string'
    || value.sessionId.length === 0
    || value.sessionId.length > 512
    || typeof value.originalMessageId !== 'string'
    || value.originalMessageId.length === 0
    || value.originalMessageId.length > 512
    || typeof value.needDigest !== 'string'
    || !SHA256.test(value.needDigest)
    || typeof value.taskRevision !== 'string'
    || !SAFE_ID.test(value.taskRevision)
    || typeof value.verifierId !== 'string'
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.verifierId)
    || typeof value.verificationPayloadDigest !== 'string'
    || !SHA256.test(value.verificationPayloadDigest)
    || !Number.isSafeInteger(value.recordRevision)
    || (value.recordRevision as number) < 0
    || !Number.isSafeInteger(createdAtMs)
    || (createdAtMs as number) < 0
    || !Number.isSafeInteger(updatedAtMs)
    || (updatedAtMs as number) < (createdAtMs as number)
    || !Number.isSafeInteger(expiresAtMs)
    || (expiresAtMs as number) <= (createdAtMs as number)
    || typeof state !== 'string'
    || !RETRY_CONTINUATION_STATES.includes(state as TaskRetryContinuationState)
    || (state === 'superseded') !== hasSupersededRevision
    || (hasSupersededRevision
      && (typeof value.supersededByTaskRevision !== 'string'
        || !SAFE_ID.test(value.supersededByTaskRevision)))) {
    throw new Error('Retry original continuation owner returned an invalid claim')
  }
  return Object.freeze({
    continuationId: value.continuationId,
    callerId: value.callerId,
    mutationId: value.mutationId,
    recordRevision: value.recordRevision as number,
    state: state as TaskRetryContinuationState,
    dispatchMessageId: value.dispatchMessageId,
    sessionId: value.sessionId,
    originalMessageId: value.originalMessageId,
    needDigest: value.needDigest,
    taskRevision: value.taskRevision,
    verifierId: value.verifierId,
    verificationPayloadDigest: value.verificationPayloadDigest,
    createdAtMs: createdAtMs as number,
    updatedAtMs: updatedAtMs as number,
    expiresAtMs: expiresAtMs as number,
    resumeAgentOptions: restrictedAgentOptions(value.resumeAgentOptions),
    ...(hasSupersededRevision
      ? { supersededByTaskRevision: value.supersededByTaskRevision as string }
      : {}),
  })
}

function agentExecution(agent: unknown): Readonly<{
  sessionId: string
  messageId: string
  cwd: string
  resumeAgentOptions: RestrictedAgentOptions
}> {
  if (typeof agent !== 'object' || agent === null) throw new Error('capability resolution requires an Agent-scoped execution')
  const view = agent as {
    id?: unknown
    options?: unknown
    session?: { events?: readonly unknown[]; header?: { cwd?: unknown } }
  }
  if (typeof view.id !== 'string' || !Array.isArray(view.session?.events)
    || typeof view.session.header?.cwd !== 'string') throw new Error('Agent session identity and cwd are unavailable')
  const events = [...view.session.events].reverse()
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const item = event as { type?: unknown; data?: { id?: unknown; source?: { kind?: unknown } } }
    if (item.type === 'user/message' && item.data?.source?.kind === 'user' && typeof item.data.id === 'string') {
      return Object.freeze({
        sessionId: view.id,
        messageId: item.data.id,
        cwd: view.session.header.cwd,
        resumeAgentOptions: restrictedAgentOptions(view.options),
      })
    }
  }
  throw new Error('capability resolution has no direct-user task message')
}

/** Existing-first local retrieval, opaque acquisition planning, and continuation verification. */
export class CapabilityAcquisitionService {
  private readonly volatileResolutions = new Map<string, StoredResolution>()
  private taskAttemptInitialization: Promise<void> | undefined

  constructor(
    private readonly state: CenterStateStore,
    private readonly inventory: HostInventoryService,
    private readonly intentPlans: IntentPlanService,
    private readonly plans: FilePlanStore,
    private readonly operations: FileOperationStore,
    private readonly owners: HostOwners,
    private readonly catalog: () => VerifiedCatalog,
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly taskAttempts = new FileTaskAttemptStore(state.root),
  ) {}

  /** Resolve current capabilities first, then the verified local catalog without exposing catalog prose. */
  async resolve(value: unknown, agent: unknown, signal: AbortSignal): Promise<ModelCapabilityResolution> {
    if (signal.aborted) throw signal.reason
    const input = modelNeed(value)
    const execution = agentExecution(agent)
    const cwd = await realpath(execution.cwd)
    const host = hostCapabilities(this.owners)
    if (!host.acquisition) throw new Error('capability acquisition is unavailable on this Host')
    const need: TaskAttemptNeed = {
      schemaVersion: 1,
      outcomeTags: input.outcomeTags,
      inputModalities: input.inputModalities,
      outputModalities: input.outputModalities,
      scopeKey: input.scopeKey,
      platform: currentPlatform(),
      requiredDataAccess: input.requiredDataAccess,
      maximumAuthority: input.maximumAuthority,
    }
    await this.ensureTaskAttempts()
    const nowMs = Date.now()
    const active = (await this.taskAttempts.list()).filter(attempt => attempt.outcome === null
      && attempt.sessionId === execution.sessionId && attempt.originalMessageId === execution.messageId)
    const attempt = await this.taskAttempts.create({
      sessionId: execution.sessionId,
      originalMessageId: execution.messageId,
      profileId: input.profileId,
      projectRoot: cwd,
      need,
      resumeAgentOptions: execution.resumeAgentOptions,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + Math.max(1, this.ttlMs),
    })
    for (const superseded of active) {
      await this.supersedeContinuation(superseded, attempt.taskAttemptId)
    }
    return this.evaluateAttempt(attempt, agent, signal, null)
  }

  /** Turn one terminal human choice into a new candidate-bound attempt without granting approval. */
  async selectTaskCandidate(
    taskAttemptId: string,
    candidateRef: string,
    signal: AbortSignal,
  ): Promise<ModelCapabilityResolution> {
    if (!CANDIDATE_REF.test(candidateRef)) throw new Error('task candidate selection is invalid')
    await this.ensureTaskAttempts()
    const source = await this.taskAttempts.get(taskAttemptId)
    const nowMs = Date.now()
    if (source === undefined || source.expiresAtMs <= nowMs) throw new Error('task choice is absent or expired')
    const attempt = await this.taskAttempts.derive({
      sourceAttemptId: taskAttemptId,
      kind: 'choice-selection',
      candidateRef,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    })
    return this.evaluateAttempt(attempt, this.agentForAttempt(attempt), signal, candidateRef)
  }

  /** Retry a terminal management handoff as a new existing-first attempt for the original message. */
  async retryOriginalTask(taskAttemptId: string, signal: AbortSignal): Promise<ModelCapabilityResolution> {
    await this.ensureTaskAttempts()
    const source = await this.taskAttempts.get(taskAttemptId)
    const nowMs = Date.now()
    if (source === undefined || source.expiresAtMs <= nowMs) throw new Error('task management handoff is absent or expired')
    const attempt = await this.taskAttempts.derive({
      sourceAttemptId: taskAttemptId,
      kind: 'retry-original',
      candidateRef: null,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    })
    if (attempt.outcome !== null && attempt.outcome !== 'use-existing') {
      throw new Error('Retry original derived attempt did not become usable')
    }
    const resolution = attempt.outcome === null
      ? await this.evaluateAttempt(attempt, this.agentForAttempt(attempt), signal, null)
      : this.modelProjection(attempt, 'use-existing')
    const current = await this.taskAttempts.get(resolution.taskAttemptId)
    if (current?.trigger === 'retry-original' && current.outcome === 'use-existing') {
      await this.ensureRetryContinuation(current)
    }
    return resolution
  }

  /** Cancel one mutable task attempt without changing an already committed extension operation. */
  async cancelTaskAttempt(taskAttemptId: string): Promise<TaskAttemptProjection> {
    await this.ensureTaskAttempts()
    const prior = await this.taskAttempts.get(taskAttemptId)
    if (prior === undefined) throw new Error('task attempt is absent')
    if (prior.outcome === 'canceled') return await this.projectAttempt(prior)
    if (prior.trigger === 'retry-original'
      && prior.outcome === 'use-existing'
      && prior.result?.kind === 'use-existing') {
      await this.taskAttempts.cancelRetryContinuation(prior.taskAttemptId, Date.now())
      await this.ensureRetryContinuation(prior)
      const projection = await this.projectAttempt(prior)
      if (projection.retryContinuation?.state !== 'canceled') {
        throw new Error('Retry original continuation is no longer cancelable')
      }
      return projection
    }
    if (prior.outcome !== null) throw new Error('task attempt outcome is already terminal')
    const closed = await this.taskAttempts.close(
      prior.taskAttemptId,
      prior.revision,
      'canceled',
      'canceled-by-user',
      prior.result,
      Date.now(),
    )
    await this.cancelContinuation(closed)
    return await this.projectAttempt(closed)
  }

  /** List durable task attempts, expiring mutable records before projection. */
  async listTaskAttempts(nowMs = Date.now()): Promise<readonly TaskAttemptProjection[]> {
    await this.ensureTaskAttempts()
    const output: TaskAttemptProjection[] = []
    for (const attempt of await this.taskAttempts.list()) {
      const current = attempt.outcome === null && attempt.expiresAtMs <= nowMs
        ? await this.taskAttempts.expire(attempt.taskAttemptId, nowMs)
        : attempt
      output.push(await this.projectAttempt(current))
    }
    return Object.freeze(output)
  }

  private async evaluateAttempt(
    initial: TaskAttempt,
    agent: unknown,
    signal: AbortSignal,
    selectedCandidateRef: string | null,
  ): Promise<ModelCapabilityResolution> {
    let attempt = initial
    try {
      if (signal.aborted) {
        attempt = await this.taskAttempts.close(attempt.taskAttemptId, attempt.revision, 'canceled', 'request-canceled', null, Date.now())
        throw signal.reason
      }
      attempt = await this.taskAttempts.transition(attempt.taskAttemptId, attempt.revision, 'resolving', null, Date.now())
      const input: ModelCapabilityNeed = {
        outcomeTags: attempt.need.outcomeTags,
        inputModalities: attempt.need.inputModalities,
        outputModalities: attempt.need.outputModalities,
        scopeKey: attempt.need.scopeKey,
        profileId: attempt.profileId,
        requiredDataAccess: attempt.need.requiredDataAccess,
        maximumAuthority: attempt.need.maximumAuthority,
      }
      const host = hostCapabilities(this.owners)
      let inventory: Awaited<ReturnType<HostInventoryService['list']>>
      let existing: readonly ExistingCapability[]
      try {
        inventory = await this.inventory.list(
          input.scopeKey,
          input.profileId,
          input.scopeKey === 'project' ? attempt.projectRoot : null,
        )
        existing = await this.existing(input, agent, attempt.projectRoot)
      } catch {
        attempt = await this.taskAttempts.close(
          attempt.taskAttemptId,
          attempt.revision,
          'discovery-unavailable',
          'runtime-observation-unavailable',
          null,
          Date.now(),
        )
        return this.modelProjection(attempt, 'discovery-unavailable')
      }
      const need: CapabilityNeed = attempt.need
      const existingResolution = resolveCapability({
        need,
        existing,
        inventory: inventory.rows,
        inventoryComplete: inventory.complete,
        catalog: [],
        catalogComplete: false,
        policy: new Map(),
        maximumCandidates: 3,
      })
      if (existingResolution.decision === 'use-existing') {
        attempt = await this.taskAttempts.close(
          attempt.taskAttemptId,
          attempt.revision,
          'use-existing',
          'existing-capability-visible',
          { kind: 'use-existing', capabilityId: existingResolution.capabilityId },
          Date.now(),
        )
        return this.modelProjection(attempt, 'use-existing')
      }
      let catalog: VerifiedCatalog
      try {
        catalog = this.catalog()
      } catch {
        attempt = await this.taskAttempts.close(
          attempt.taskAttemptId,
          attempt.revision,
          'discovery-unavailable',
          'verified-catalog-unavailable',
          null,
          Date.now(),
        )
        return this.modelProjection(attempt, 'discovery-unavailable')
      }
      const eligibleEntries = selectedCandidateRef === null
        ? catalog.envelope.entries
        : catalog.envelope.entries.filter(entry => entry.candidateRef === selectedCandidateRef)
      const policy = new Map<string, CandidatePolicyResult>()
      for (const entry of eligibleEntries) {
      if (!entry.scopes.includes(input.scopeKey)
        || !input.outcomeTags.some(tag => entry.tags.includes(tag))) continue
      if (entry.kind === 'skill' && input.scopeKey === 'project') {
        // Project discovery remains observable, but P0 has no published
        // workspace/Agent selector that can authorize a project-root write.
        continue
      }
      const runtimeOptions = entry.kind === 'mcp'
        ? await this.intentPlans.configurationOptions({
            candidateRef: entry.candidateRef,
            targetKey: null,
            scopeKey: input.scopeKey,
            profileId: input.profileId,
          })
        : null
      const admission = candidateAdmissionFacts(entry, 'install')
        policy.set(entry.candidateRef, evaluateCandidatePolicy({
        entry,
        catalogVerified: true,
        catalogComplete: inventory.complete,
        hostCapabilities: host,
        operationKind: 'install',
        desiredState: 'enabled',
        selectedScope: input.scopeKey,
        currentPlatform: currentHostPlatform(),
        completeLifecycle: admission.completeLifecycle,
        authorityKnown: admission.authorityKnown,
        authorityDigest: canonicalSha256({ candidateRef: entry.candidateRef, permissions: entry.permissions, dependencies: entry.dependencies }),
        lifecycleScriptControl: admission.lifecycleScriptControl,
        externalRuntimeResolved: entry.kind !== 'mcp' || runtimeOptions!.options.length > 0,
        reviewEvidenceAvailable: admission.reviewEvidenceAvailable,
        verificationRecipeComplete: admission.verificationRecipeComplete,
        taskOneClick: false,
        unresolvedUserChoices: 0,
        }))
      }
      const resolved = resolveCapability({
      need,
      existing,
      inventory: inventory.rows,
      inventoryComplete: inventory.complete,
        catalog: eligibleEntries,
      catalogComplete: true,
      policy,
      maximumCandidates: 3,
      })
      if (resolved.decision === 'management-required') {
        const result: TaskAttemptResult = {
          kind: 'management-required',
          extensionRef: `extension-ref:${randomUUID()}`,
          targetKey: resolved.extensionRef,
          action: resolved.action,
        }
        attempt = await this.taskAttempts.close(
          attempt.taskAttemptId,
          attempt.revision,
          'management-required',
          `managed-extension-requires-${resolved.action}`,
          result,
          Date.now(),
        )
        return this.modelProjection(attempt, resolved.decision)
      }
      if (resolved.decision === 'choice-required') {
        const refs = Object.freeze(resolved.candidates.map(candidate => candidate.candidateRef).sort())
        attempt = await this.taskAttempts.close(
          attempt.taskAttemptId,
          attempt.revision,
          'choice-required',
          'material-candidate-choice-required',
          { kind: 'choice-required', candidateRefs: refs },
          Date.now(),
        )
        return this.modelProjection(attempt, resolved.decision)
      }
      if (resolved.decision === 'no-eligible-candidate' || resolved.decision === 'discovery-unavailable') {
        attempt = await this.taskAttempts.close(
          attempt.taskAttemptId,
          attempt.revision,
          resolved.decision,
          resolved.decision,
          null,
          Date.now(),
        )
        return this.modelProjection(attempt, resolved.decision)
      }
      if (resolved.decision !== 'acquisition-candidate') throw new Error('task capability decision is unsupported')
      const candidates = await this.resolutionCandidates(resolved, inventory.rows, catalog.envelope.entries, input, attempt.projectRoot)
      if (candidates.length !== 1 || candidates[0]?.candidateRef !== resolved.candidate.candidateRef) {
        throw new Error('candidate-bound task resolution is incomplete')
      }
      const resolutionId = `resolution:${randomUUID()}`
      const createdAtMs = attempt.createdAtMs
      const expiresAtMs = attempt.expiresAtMs
      const verificationPayloadDigest = canonicalSha256({
        resolutionId,
        taskAttemptId: attempt.taskAttemptId,
        needDigest: resolved.needDigest,
        catalogRevision: catalog.envelope.revision,
        catalogEntriesDigest: catalog.envelope.entriesDigest,
        inventoryRevision: inventory.revision,
        candidates: candidates.map(candidate => ({
          candidateRef: candidate.candidateRef,
          operationKind: candidate.operationKind,
          targetKey: candidate.targetKey,
        })),
      })
      const continuationId = randomUUID()
      const valueRecord: ResolutionValue = {
        decision: resolved.decision,
        taskAttemptId: attempt.taskAttemptId,
        scopeKey: input.scopeKey,
        profileId: input.profileId,
        catalogRevision: catalog.envelope.revision,
        catalogEntriesDigest: catalog.envelope.entriesDigest,
        inventoryRevision: inventory.revision,
        continuationId,
        verificationPayloadDigest,
        intentId: `intent:${randomUUID()}`,
        planId: `plan:${randomUUID()}`,
        createdAtMs,
        expiresAtMs,
        sessionId: attempt.sessionId,
        originalMessageId: attempt.originalMessageId,
        resumeAgentOptions: attempt.resumeAgentOptions,
        candidates,
      }
      const stored: StoredResolution = {
      schemaVersion: 1,
      resolutionId,
      createdAtMs,
      expiresAtMs,
      needDigest: resolved.needDigest,
      decision: resolved.decision,
      candidateRefs: candidates.map(candidate => candidate.candidateRef),
        value: immutableJsonClone(valueRecord) as unknown as RpcJson,
      }
      this.pruneVolatileResolutions(createdAtMs)
      this.volatileResolutions.set(resolutionId, stored)
      await this.state.putResolution(stored)
      attempt = await this.taskAttempts.transition(
        attempt.taskAttemptId,
        attempt.revision,
        'awaiting-approval',
        {
          kind: 'acquisition-candidate',
          resolutionId,
          candidateRef: resolved.candidate.candidateRef,
          continuationId,
          verificationPayloadDigest,
        },
        Date.now(),
      )
      return this.modelProjection(attempt, resolved.decision, candidates[0]!.configuration === null)
    } catch (error: unknown) {
      const current = await this.taskAttempts.get(attempt.taskAttemptId)
      if (current?.outcome === null) {
        await this.taskAttempts.close(
          current.taskAttemptId,
          current.revision,
          signal.aborted ? 'canceled' : 'failed',
          signal.aborted ? 'request-canceled' : 'resolution-failed',
          current.result,
          Date.now(),
        )
      }
      throw error
    }
  }

  /** Mint a task-origin immutable plan from three opaque bindings; never approve or execute it. */
  async request(value: unknown, agent: unknown, signal: AbortSignal): Promise<ModelAcquisitionResult> {
    if (signal.aborted) throw signal.reason
    const input = acquisitionRequest(value)
    await this.ensureTaskAttempts()
    let attempt = await this.taskAttempts.getByResolution(input.resolutionId)
    if (attempt === undefined || attempt.result?.kind !== 'acquisition-candidate') {
      throw new Error('acquisition request does not bind an acquisition-candidate task attempt')
    }
    const nowMs = Date.now()
    if (attempt.outcome !== null) throw new Error('acquisition task attempt is terminal')
    if (attempt.expiresAtMs <= nowMs) {
      attempt = await this.taskAttempts.expire(attempt.taskAttemptId, nowMs)
      this.volatileResolutions.delete(input.resolutionId)
      throw new Error('acquisition task attempt expired')
    }
    const resolution = this.volatileResolutions.get(input.resolutionId)
      ?? await this.state.getResolution(input.resolutionId)
    if (resolution === undefined || resolution.expiresAtMs <= nowMs) {
      await this.rejectAttempt(attempt, 'resolution-absent-or-expired')
      throw new Error('resolution is absent or expired')
    }
    const detail = parseResolutionValue(resolution.value)
    if (detail.decision !== 'acquisition-candidate') {
      await this.rejectAttempt(attempt, 'resolution-is-not-acquisition-candidate')
      throw new Error('resolution does not bind an acquisition-candidate attempt')
    }
    if (detail.taskAttemptId !== attempt.taskAttemptId
      || resolution.needDigest !== attempt.needDigest
      || !await this.resolutionObservationIsCurrent(detail, attempt)) {
      await this.rejectAttempt(attempt, 'resolution-observation-stale')
      throw new Error('resolution observation is stale')
    }
    if (detail.scopeKey === 'project') {
      await this.rejectAttempt(attempt, 'project-scope-unavailable')
      throw new Error('project-scoped acquisition requires a published workspace and Agent selector')
    }
    const candidate = detail.candidates.find(item => item.candidateRef === input.candidateRef)
    if (candidate === undefined || detail.continuationId !== input.continuationId
      || detail.verificationPayloadDigest === null
      || attempt.result.resolutionId !== input.resolutionId
      || attempt.result.candidateRef !== input.candidateRef
      || attempt.result.continuationId !== input.continuationId
      || attempt.result.verificationPayloadDigest !== detail.verificationPayloadDigest) {
      await this.rejectAttempt(attempt, 'opaque-binding-mismatch')
      throw new Error('opaque acquisition bindings do not match')
    }
    const identity = agentExecution(agent)
    if (identity.sessionId !== detail.sessionId || identity.messageId !== detail.originalMessageId) {
      await this.rejectAttempt(attempt, 'agent-task-binding-mismatch')
      throw new Error('opaque acquisition request does not belong to the resolving Agent task')
    }
    if (candidate.configuration === null) throw new Error('task candidate requires trusted human configuration')
    if ((await this.plans.list()).some(state => state.plan.content.intentId === detail.intentId)) {
      await this.rejectAttempt(attempt, 'acquisition-request-replayed')
      throw new Error('acquisition request was already consumed')
    }
    const durableDetail: ResolutionValue = detail
    const durableResolution: StoredResolution = Object.freeze({
      ...resolution,
      value: immutableJsonClone(durableDetail) as unknown as RpcJson,
    })
    await this.state.putResolution(durableResolution)
    const binding: TaskIntentBinding = {
      resolutionId: input.resolutionId,
      verificationPayloadDigest: detail.verificationPayloadDigest,
      intentId: detail.intentId,
      planId: detail.planId,
      createdAtMs: detail.createdAtMs,
      expiresAtMs: detail.expiresAtMs,
      sessionId: detail.sessionId,
      originalMessageId: detail.originalMessageId,
    }
    const response = await this.intentPlans.preview({
      protocolVersion: HOST_RPC_PROTOCOL_VERSION,
      origin: 'task',
      candidateRef: input.candidateRef,
      operationKind: candidate.operationKind,
      scopeKey: detail.scopeKey,
      profileId: detail.profileId,
      continuationId: input.continuationId,
      targetKey: candidate.targetKey,
      configuration: candidate.configuration,
    }, 'model-resolution', nowMs, binding)
    this.volatileResolutions.delete(input.resolutionId)
    return Object.freeze({
      protocolVersion: HOST_RPC_PROTOCOL_VERSION,
      resolutionId: input.resolutionId,
      continuationId: input.continuationId,
      candidateRef: input.candidateRef,
      planId: response.plan.content.planId,
      planHash: response.plan.hash,
      operationKind: response.plan.content.operationKind,
      status: 'approval-required',
    })
  }

  /** List expired-filtered task candidates that still require trusted typed configuration. */
  async listConfigurationRequests(nowMs = Date.now(), maximum = 128): Promise<readonly TaskConfigurationRow[]> {
    await this.listTaskAttempts(nowMs)
    const plannedIntentIds = new Set((await this.plans.list()).map(state => state.plan.content.intentId))
    const output: TaskConfigurationRow[] = []
    this.pruneVolatileResolutions(nowMs)
    const resolutions = new Map((await this.state.listResolutions()).map(resolution => [resolution.resolutionId, resolution]))
    for (const resolution of this.volatileResolutions.values()) resolutions.set(resolution.resolutionId, resolution)
    for (const resolution of resolutions.values()) {
      if (resolution.expiresAtMs <= nowMs) continue
      const detail = parseResolutionValue(resolution.value)
      if (detail.continuationId === null
        || detail.verificationPayloadDigest === null
        || detail.decision !== 'acquisition-candidate'
        || plannedIntentIds.has(detail.intentId)) continue
      for (const candidate of detail.candidates) {
        const entry = this.catalog().envelope.entries.find(item => item.candidateRef === candidate.candidateRef)
        if (entry?.kind !== 'mcp' || candidate.configuration !== null) continue
        output.push(Object.freeze({
          resolutionId: resolution.resolutionId,
          candidateRef: candidate.candidateRef,
          continuationId: detail.continuationId,
          extensionKind: 'mcp',
          scopeKey: detail.scopeKey,
          profileId: detail.profileId,
          createdAtMs: detail.createdAtMs,
          expiresAtMs: detail.expiresAtMs,
        }))
        if (output.length > maximum) throw new Error('task configuration queue exceeds its P0 bound')
      }
    }
    return Object.freeze(output.sort((left, right) => left.createdAtMs - right.createdAtMs
      || left.resolutionId.localeCompare(right.resolutionId)
      || left.candidateRef.localeCompare(right.candidateRef)))
  }

  /** Mint one task plan after a trusted human supplies the exact typed MCP connection configuration. */
  async configureTaskCandidate(input: Readonly<{
    resolutionId: string
    candidateRef: string
    continuationId: string
    configuration: RpcJson
  }>, nowMs = Date.now()): Promise<IntentPreviewResponse> {
    await this.ensureTaskAttempts()
    const attempt = await this.taskAttempts.getByResolution(input.resolutionId)
    if (attempt === undefined || attempt.outcome !== null || attempt.expiresAtMs <= nowMs
      || attempt.result?.kind !== 'acquisition-candidate'
      || attempt.result.candidateRef !== input.candidateRef
      || attempt.result.continuationId !== input.continuationId) {
      throw new Error('task configuration does not bind a mutable acquisition-candidate attempt')
    }
    const resolution = this.volatileResolutions.get(input.resolutionId)
      ?? await this.state.getResolution(input.resolutionId)
    if (resolution === undefined || resolution.expiresAtMs <= nowMs) throw new Error('task configuration resolution is absent or expired')
    const detail = parseResolutionValue(resolution.value)
    const candidate = detail.candidates.find(item => item.candidateRef === input.candidateRef)
    const entry = this.catalog().envelope.entries.find(item => item.candidateRef === input.candidateRef)
    if (candidate === undefined
      || detail.decision !== 'acquisition-candidate'
      || detail.scopeKey === 'project'
      || entry?.kind !== 'mcp'
      || candidate.configuration !== null
      || detail.continuationId !== input.continuationId
      || detail.verificationPayloadDigest === null
      || detail.taskAttemptId !== attempt.taskAttemptId
      || resolution.needDigest !== attempt.needDigest
      || attempt.result.verificationPayloadDigest !== detail.verificationPayloadDigest
      || !await this.resolutionObservationIsCurrent(detail, attempt)) {
      throw new Error('task configuration opaque bindings do not match one pending MCP candidate')
    }
    if ((await this.plans.list()).some(state => state.plan.content.intentId === detail.intentId)) {
      throw new Error('task configuration already produced an immutable plan')
    }
    const binding: TaskIntentBinding = {
      resolutionId: input.resolutionId,
      verificationPayloadDigest: detail.verificationPayloadDigest,
      intentId: detail.intentId,
      planId: detail.planId,
      createdAtMs: detail.createdAtMs,
      expiresAtMs: detail.expiresAtMs,
      sessionId: detail.sessionId,
      originalMessageId: detail.originalMessageId,
    }
    await this.state.putResolution(resolution)
    const response = await this.intentPlans.preview({
      protocolVersion: HOST_RPC_PROTOCOL_VERSION,
      origin: 'task',
      candidateRef: input.candidateRef,
      operationKind: candidate.operationKind,
      scopeKey: detail.scopeKey,
      profileId: detail.profileId,
      continuationId: input.continuationId,
      targetKey: candidate.targetKey,
      configuration: input.configuration,
    }, 'model-resolution', nowMs, binding)
    this.volatileResolutions.delete(input.resolutionId)
    return response
  }

  /** Create the real Host continuation only after the trusted plan decision approved acquisition. */
  async activateApprovedPlan(planHash: string): Promise<void> {
    const plan = await this.plans.load(planHash as `sha256:${string}`)
    if (plan?.status !== 'approved' || plan.plan.content.origin !== 'task') return
    await this.recordPlanDecision(planHash, 'approve')
    const intent = await this.state.getIntent(plan.plan.content.intentId)
    const reservationId = intent?.payload.continuationId
    if (intent === undefined || intent.planHash !== plan.plan.hash || reservationId == null) {
      throw new Error('approved task plan has no exact continuation reservation')
    }
    const existing = await this.state.getContinuationActivation(reservationId)
    if (existing !== undefined) {
      if (existing.planHash !== plan.plan.hash
        || existing.resolutionId !== intent.payload.resolutionId
        || existing.verificationPayloadDigest !== intent.payload.verificationPayloadDigest) {
        throw new Error('continuation reservation conflicts with its approved plan')
      }
      return
    }
    const resolutionId = intent.payload.resolutionId
    const verificationPayloadDigest = intent.payload.verificationPayloadDigest
    const sessionId = intent.payload.taskSessionId
    const originalMessageId = intent.payload.taskOriginalMessageId
    if (resolutionId === null || verificationPayloadDigest === null
      || sessionId === null || originalMessageId === null) {
      throw new Error('approved task plan has no exact original-task binding')
    }
    const resolution = await this.state.getResolution(resolutionId)
    if (resolution === undefined || resolution.expiresAtMs <= Date.now()
      || !resolution.candidateRefs.includes(plan.plan.content.candidateRef)) {
      throw new Error('approved task resolution is absent or expired')
    }
    const resolutionDetail = parseResolutionValue(resolution.value)
    if (resolutionDetail.resumeAgentOptions === null) {
      throw new Error('approved task resolution has no exact Agent resume route')
    }
    const taskRevision = `extension-center-${resolutionId.slice('resolution:'.length)}`
    const callerId = 'extension-center' as const
    const mutationId = reservationId
    const activationIntent = {
      schemaVersion: 1 as const,
      reservationId,
      callerId,
      mutationId,
      resolutionId,
      planHash: plan.plan.hash,
      sessionId,
      originalMessageId,
      needDigest: resolution.needDigest,
      taskRevision,
      verificationPayloadDigest,
      resumeAgentOptions: resolutionDetail.resumeAgentOptions,
      expiresAtMs: resolution.expiresAtMs,
      createdAtMs: plan.decision.decidedAtMs,
    }
    const priorIntent = await this.state.getContinuationActivationIntent(reservationId)
    if (priorIntent === undefined) {
      await this.state.putContinuationActivationIntent(activationIntent)
    } else if (canonicalSha256(priorIntent) !== canonicalSha256(activationIntent)) {
      throw new Error('continuation activation intent conflicts with its approved plan')
    }
    const matches = (await this.owners.taskContinuations!.list({ callerId, mutationId })).filter((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      const claim = value as Record<string, unknown>
      return claim.callerId === callerId
        && claim.mutationId === mutationId
        && claim.sessionId === sessionId
        && claim.originalMessageId === originalMessageId
        && claim.needDigest === resolution.needDigest
        && claim.taskRevision === taskRevision
        && claim.verifierId === VERIFIER_ID
        && claim.verificationPayloadDigest === verificationPayloadDigest
        && canonicalSha256(claim.resumeAgentOptions) === canonicalSha256(resolutionDetail.resumeAgentOptions)
        && ['pending', 'ready', 'consumed'].includes(String(claim.state))
    })
    if (matches.length > 1) throw new Error('approved task plan has duplicate continuation claims')
    const created = matches[0] ?? await this.owners.taskContinuations!.reserve({
      callerId,
      mutationId,
      sessionId,
      originalMessageId,
      needDigest: resolution.needDigest,
      taskRevision,
      verifierId: VERIFIER_ID,
      verificationPayloadDigest,
      expiresAtMs: resolution.expiresAtMs,
      resumeAgentOptions: resolutionDetail.resumeAgentOptions,
    })
    if (typeof created !== 'object' || created === null || Array.isArray(created)) {
      throw new Error('continuation owner returned an invalid claim')
    }
    const claim = created as Record<string, unknown>
    if (typeof claim.continuationId !== 'string'
      || claim.callerId !== callerId
      || claim.mutationId !== mutationId
      || claim.sessionId !== sessionId
      || claim.originalMessageId !== originalMessageId
      || claim.needDigest !== resolution.needDigest
      || claim.taskRevision !== taskRevision
      || claim.verificationPayloadDigest !== verificationPayloadDigest
      || canonicalSha256(claim.resumeAgentOptions) !== canonicalSha256(resolutionDetail.resumeAgentOptions)) {
      throw new Error('continuation owner returned a claim that does not bind the approved plan')
    }
    await this.state.putContinuationActivation({
      schemaVersion: 1,
      reservationId,
      continuationId: claim.continuationId,
      resolutionId,
      planHash: plan.plan.hash,
      sessionId,
      originalMessageId,
      needDigest: resolution.needDigest,
      taskRevision,
      verificationPayloadDigest,
      createdAtMs: Date.now(),
    })
  }

  /** Reconcile every approved task plan after Host restart without consuming it. */
  async recoverApprovedPlans(): Promise<void> {
    await this.ensureTaskAttempts()
    for (const attempt of await this.taskAttempts.list()) {
      if (attempt.trigger === 'retry-original'
        && attempt.outcome === 'use-existing'
        && attempt.result?.kind === 'use-existing') {
        await this.ensureRetryContinuation(attempt)
      }
    }
    for (const state of await this.plans.list()) {
      if (state.plan.content.origin !== 'task') continue
      try {
        if (state.status === 'rejected') {
          await this.recordPlanDecision(state.plan.hash, 'reject')
        } else if (state.status === 'approved') {
          await this.activateApprovedPlan(state.plan.hash)
        } else if (state.status === 'consumed') {
          const operation = await this.operations.load(state.authorization.operationId)
          const phase = operation?.projection.phase
          if (phase === 'committed' || phase === 'failed' || phase === 'rolled-back' || phase === 'recovery-required') {
            await this.recordLifecycleResult(state.plan.hash, phase)
          }
        }
      } catch {
        // A later trusted request retries exact plan/attempt reconciliation.
      }
    }
  }

  /** Register the non-mutating verifier that releases only exact committed task receipts. */
  registerVerifier(): () => void {
    const acquisition = this.owners.taskContinuations!.registerVerifier({
      id: VERIFIER_ID,
      verify: async (claim: unknown, signal: AbortSignal): Promise<unknown> => {
        if (signal.aborted) throw signal.reason
        if (typeof claim !== 'object' || claim === null || Array.isArray(claim)) return { kind: 'not-ready' }
        const view = claim as Record<string, unknown>
        if (typeof view.continuationId !== 'string'
          || typeof view.needDigest !== 'string'
          || typeof view.verificationPayloadDigest !== 'string') return { kind: 'not-ready' }
        const receipt = await this.state.getTaskReceipt(view.continuationId)
        if (receipt === undefined
          || receipt.verificationPayloadDigest !== view.verificationPayloadDigest) return { kind: 'not-ready' }
        const resolution = await this.state.getResolution(receipt.resolutionId)
        const detail = resolution === undefined ? undefined : parseResolutionValue(resolution.value)
        const activation = detail === undefined || detail.continuationId === null
          ? undefined
          : await this.state.getContinuationActivation(detail.continuationId)
        const plan = await this.plans.load(receipt.planHash as `sha256:${string}`)
        const operation = await this.operations.load(receipt.operationId)
        const attempt = await this.taskAttempts.getByResolution(receipt.resolutionId)
        if (resolution === undefined
          || activation === undefined
          || attempt === undefined
          || attempt.outcome !== null
          || !['acquiring', 'verifying-visibility', 'restart-required', 'ready-to-resume', 'resuming'].includes(attempt.phase)
          || activation.continuationId !== view.continuationId
          || activation.planHash !== receipt.planHash
          || activation.sessionId !== view.sessionId
          || activation.originalMessageId !== view.originalMessageId
          || activation.taskRevision !== view.taskRevision
          || resolution.needDigest !== view.needDigest
          || plan?.status !== 'consumed'
          || plan.authorization.operationId !== receipt.operationId
          || !resolution.candidateRefs.includes(plan.plan.content.candidateRef)
          || operation?.projection.phase !== 'committed'
          || operation.projection.receipt?.digest !== receipt.operationReceiptDigest) return { kind: 'not-ready' }
        let inventory: Awaited<ReturnType<HostInventoryService['list']>>
        try {
          inventory = await this.inventory.list(
            detail!.scopeKey,
            detail!.profileId,
            detail!.scopeKey === 'project' ? attempt.projectRoot : null,
          )
        } catch {
          return { kind: 'not-ready' }
        }
        if (signal.aborted) throw signal.reason
        const row = inventory.rows.find(item => item.targetKey === plan.plan.content.targetKey)
        if (!inventory.complete
          || row === undefined
          || row.candidateRef !== plan.plan.content.candidateRef
          || row.ownership !== 'center'
          || row.effective !== 'active'
          || row.agentVisibility !== 'visible'
          || !['runtime', 'task'].includes(row.verification)
          || (row.evidence.kind === 'skill' && !row.evidence.definitionLoaded)
          || (row.evidence.kind === 'mcp' && (!row.evidence.descriptorMatches
            || row.evidence.observedLifecycle !== 'ready' || row.evidence.qualifiedTools.length === 0))
          || (row.evidence.kind === 'plugin' && (!row.evidence.consumerObserved
            || !row.evidence.externalRestartObserved || row.evidence.loaderPhase !== 'active'))) {
          return { kind: 'not-ready' }
        }
        if (!await this.markTaskVisibilityReady(attempt.taskAttemptId)) return { kind: 'not-ready' }
        return Object.freeze({
          kind: 'ready',
          continuationId: view.continuationId,
          sessionId: view.sessionId,
          originalMessageId: view.originalMessageId,
          needDigest: view.needDigest,
          taskRevision: view.taskRevision,
          verificationPayloadDigest: view.verificationPayloadDigest,
        })
      },
    })
    const retry = this.owners.taskContinuations!.registerVerifier({
      id: RETRY_VERIFIER_ID,
      verify: (claim: unknown, signal: AbortSignal) => this.verifyRetryContinuation(claim, signal),
    })
    return () => {
      retry()
      acquisition()
    }
  }

  /** Bind a loopback plan decision to its independent task attempt. */
  async assertPlanDecisionAllowed(planHash: string, decision: 'approve' | 'reject'): Promise<void> {
    await this.ensureTaskAttempts()
    const state = await this.plans.load(planHash as `sha256:${string}`)
    if (state === undefined || state.plan.content.origin !== 'task') return
    const intent = await this.state.getIntent(state.plan.content.intentId)
    const resolutionId = intent?.payload.resolutionId
    if (resolutionId === null || resolutionId === undefined) throw new Error('task plan has no resolution binding')
    const attempt = await this.taskAttempts.getByResolution(resolutionId)
    if (attempt === undefined || attempt.result?.kind !== 'acquisition-candidate') {
      throw new Error('task plan has no acquisition-candidate attempt')
    }
    if (attempt.outcome !== null) throw new Error('task plan belongs to a terminal attempt')
    if (attempt.expiresAtMs <= Date.now()) {
      await this.taskAttempts.expire(attempt.taskAttemptId, Date.now())
      throw new Error('task plan belongs to an expired attempt')
    }
    if (attempt.phase !== 'awaiting-approval' && !(decision === 'approve' && attempt.phase === 'acquiring')) {
      throw new Error('task attempt is not awaiting this decision')
    }
  }

  /** Bind a loopback plan decision to its independent task attempt. */
  async recordPlanDecision(planHash: string, decision: 'approve' | 'reject'): Promise<void> {
    await this.ensureTaskAttempts()
    const state = await this.plans.load(planHash as `sha256:${string}`)
    if (state === undefined || state.plan.content.origin !== 'task') return
    const intent = await this.state.getIntent(state.plan.content.intentId)
    const resolutionId = intent?.payload.resolutionId
    if (resolutionId === null || resolutionId === undefined) throw new Error('task plan has no resolution binding')
    let attempt = await this.taskAttempts.getByResolution(resolutionId)
    if (attempt === undefined || attempt.result?.kind !== 'acquisition-candidate') {
      throw new Error('task plan has no acquisition-candidate attempt')
    }
    const nowMs = Date.now()
    if (attempt.outcome !== null) {
      if (decision === 'reject' && attempt.outcome === 'rejected') return
      throw new Error('task plan belongs to a terminal attempt')
    }
    if (attempt.expiresAtMs <= nowMs) {
      await this.taskAttempts.expire(attempt.taskAttemptId, nowMs)
      throw new Error('task plan belongs to an expired attempt')
    }
    if (decision === 'reject') {
      await this.taskAttempts.close(
        attempt.taskAttemptId,
        attempt.revision,
        'rejected',
        'human-rejected-plan',
        attempt.result,
        nowMs,
      )
      return
    }
    if (attempt.phase === 'acquiring') return
    if (attempt.phase !== 'awaiting-approval') throw new Error('task attempt is not awaiting approval')
    attempt = await this.taskAttempts.transition(
      attempt.taskAttemptId,
      attempt.revision,
      'acquiring',
      attempt.result,
      nowMs,
    )
  }

  /** Project operation progress without using it as the task's terminal outcome. */
  async recordLifecycleResult(
    planHash: string,
    status: 'committed' | 'failed' | 'recovery-required' | 'restart-required' | 'rolled-back',
  ): Promise<void> {
    await this.ensureTaskAttempts()
    const state = await this.plans.load(planHash as `sha256:${string}`)
    if (state === undefined || state.plan.content.origin !== 'task') return
    const intent = await this.state.getIntent(state.plan.content.intentId)
    const resolutionId = intent?.payload.resolutionId
    if (resolutionId === null || resolutionId === undefined) return
    const attempt = await this.taskAttempts.getByResolution(resolutionId)
    if (attempt === undefined || attempt.outcome !== null) return
    const nowMs = Date.now()
    if (status === 'failed' || status === 'rolled-back' || status === 'recovery-required') {
      await this.taskAttempts.close(
        attempt.taskAttemptId,
        attempt.revision,
        status === 'recovery-required' ? 'recovery-required' : 'failed',
        `extension-operation-${status}`,
        attempt.result,
        nowMs,
      )
      return
    }
    if (status === 'restart-required') {
      if (attempt.phase === 'acquiring') {
        await this.taskAttempts.transition(attempt.taskAttemptId, attempt.revision, 'restart-required', attempt.result, nowMs)
      }
      return
    }
    let current = attempt
    if (current.phase === 'acquiring') {
      current = await this.taskAttempts.transition(
        current.taskAttemptId,
        current.revision,
        'verifying-visibility',
        current.result,
        nowMs,
      )
    }
  }

  private async ensureTaskAttempts(): Promise<void> {
    this.taskAttemptInitialization ??= this.taskAttempts.initialize()
    await this.taskAttemptInitialization
  }

  private agentForAttempt(attempt: TaskAttempt): unknown {
    return Object.freeze({
      id: attempt.sessionId,
      options: attempt.resumeAgentOptions,
      session: Object.freeze({
        header: Object.freeze({ cwd: attempt.projectRoot }),
        events: Object.freeze([Object.freeze({
          type: 'user/message',
          data: Object.freeze({ id: attempt.originalMessageId, source: Object.freeze({ kind: 'user' }) }),
        })]),
      }),
    })
  }

  private modelProjection(
    attempt: TaskAttempt,
    decision: CapabilityResolution['decision'],
    humanConfiguration = false,
  ): ModelCapabilityResolution {
    const acquisition = attempt.result?.kind === 'acquisition-candidate' ? attempt.result : null
    const choice = attempt.result?.kind === 'choice-required' ? attempt.result : null
    const management = attempt.result?.kind === 'management-required' ? attempt.result : null
    const existing = attempt.result?.kind === 'use-existing' ? attempt.result : null
    return Object.freeze({
      protocolVersion: HOST_RPC_PROTOCOL_VERSION,
      taskAttemptId: attempt.taskAttemptId,
      resolutionId: acquisition?.resolutionId ?? null,
      decision,
      needDigest: attempt.needDigest,
      existingCapabilityId: existing?.capabilityId ?? null,
      candidateRefs: acquisition === null ? choice?.candidateRefs ?? [] : [acquisition.candidateRef],
      continuationId: acquisition?.continuationId ?? null,
      extensionRef: management?.extensionRef ?? null,
      managementAction: management?.action ?? null,
      next: decision === 'use-existing' ? 'use-existing'
        : decision === 'acquisition-candidate' ? humanConfiguration ? 'human-choice' : 'request-acquisition'
          : decision === 'choice-required' ? 'human-choice' : 'unavailable',
    })
  }

  private async projectAttempt(attempt: TaskAttempt): Promise<TaskAttemptProjection> {
    const result = attempt.result
    return Object.freeze({
      taskAttemptId: attempt.taskAttemptId,
      parentAttemptId: attempt.parentAttemptId,
      trigger: attempt.trigger,
      sessionId: attempt.sessionId,
      originalMessageId: attempt.originalMessageId,
      createdAtMs: attempt.createdAtMs,
      expiresAtMs: attempt.expiresAtMs,
      updatedAtMs: attempt.updatedAtMs,
      phase: attempt.phase,
      outcome: attempt.outcome,
      reason: attempt.reason,
      choice: result?.kind === 'choice-required' ? Object.freeze({ candidateRefs: result.candidateRefs }) : null,
      management: result?.kind === 'management-required'
        ? Object.freeze({ extensionRef: result.extensionRef, action: result.action }) : null,
      acquisition: result?.kind === 'acquisition-candidate'
        ? Object.freeze({
            resolutionId: result.resolutionId,
            candidateRef: result.candidateRef,
            continuationId: result.continuationId,
          })
        : null,
      retryContinuation: await this.projectRetryContinuation(attempt),
    })
  }

  private async rejectAttempt(attempt: TaskAttempt, reason: string): Promise<void> {
    const current = await this.taskAttempts.get(attempt.taskAttemptId)
    if (current?.outcome !== null) return
    await this.taskAttempts.close(current.taskAttemptId, current.revision, 'rejected', reason, current.result, Date.now())
  }

  private async resolutionObservationIsCurrent(detail: ResolutionValue, attempt: TaskAttempt): Promise<boolean> {
    let catalog: VerifiedCatalog
    let inventory: Awaited<ReturnType<HostInventoryService['list']>>
    try {
      catalog = this.catalog()
      inventory = await this.inventory.list(
        detail.scopeKey,
        detail.profileId,
        detail.scopeKey === 'project' ? attempt.projectRoot : null,
      )
    } catch {
      return false
    }
    return inventory.complete
      && inventory.revision === detail.inventoryRevision
      && catalog.envelope.revision === detail.catalogRevision
      && catalog.envelope.entriesDigest === detail.catalogEntriesDigest
  }

  private async markTaskVisibilityReady(taskAttemptId: string): Promise<boolean> {
    try {
      let current = await this.taskAttempts.get(taskAttemptId)
      if (current === undefined || current.outcome !== null) return false
      if (current.phase === 'acquiring') {
        current = await this.taskAttempts.transition(
          current.taskAttemptId,
          current.revision,
          'verifying-visibility',
          current.result,
          Date.now(),
        )
      }
      if (current.phase === 'verifying-visibility' || current.phase === 'restart-required') {
        current = await this.taskAttempts.transition(
          current.taskAttemptId,
          current.revision,
          'ready-to-resume',
          current.result,
          Date.now(),
        )
      }
      return current.phase === 'ready-to-resume' || current.phase === 'resuming'
    } catch {
      return false
    }
  }

  private async projectRetryContinuation(
    attempt: TaskAttempt,
  ): Promise<TaskRetryContinuationProjection | null> {
    const binding = await this.taskAttempts.getRetryContinuation(attempt.taskAttemptId)
    if (binding === undefined) return null
    if (this.owners.taskContinuations === null) {
      return Object.freeze({ continuationId: binding.continuationId, state: 'unavailable' })
    }
    const claim = await this.observeRetryContinuationClaim(attempt, binding)
    if (claim === undefined) {
      return Object.freeze({
        continuationId: binding.continuationId,
        state: binding.canceledAtMs === null ? 'reconciling' : 'canceled',
      })
    }
    return Object.freeze({ continuationId: claim.continuationId, state: claim.state })
  }

  private async observeRetryContinuationClaim(
    attempt: TaskAttempt,
    binding: TaskRetryContinuation,
  ): Promise<ObservedRetryContinuationClaim | undefined> {
    const callerId = 'extension-center'
    const mutationId = attempt.taskAttemptId.slice('task-attempt:'.length)
    const values = await this.owners.taskContinuations!.list({ callerId, mutationId })
    if (!Array.isArray(values)) throw new Error('Retry original continuation owner returned an invalid list')
    const matches = values.map(observedRetryContinuationClaim)
    if (matches.some(claim => claim.callerId !== callerId || claim.mutationId !== mutationId)) {
      throw new Error('Retry original continuation owner ignored its exact list filter')
    }
    if (matches.length > 1) throw new Error('Retry original has duplicate continuation claims')
    const claim = matches[0]
    if (claim === undefined) return undefined
    if (claim.sessionId !== attempt.sessionId
      || claim.originalMessageId !== attempt.originalMessageId
      || claim.needDigest !== attempt.needDigest
      || claim.taskRevision !== attempt.taskAttemptId
      || claim.verifierId !== RETRY_VERIFIER_ID
      || claim.verificationPayloadDigest !== binding.verificationPayloadDigest
      || claim.expiresAtMs !== attempt.expiresAtMs
      || canonicalSha256(claim.resumeAgentOptions) !== canonicalSha256(attempt.resumeAgentOptions)
      || (binding.continuationId !== null && claim.continuationId !== binding.continuationId)) {
      throw new Error('Retry original continuation claim does not bind the exact task')
    }
    return claim
  }

  private async ensureRetryContinuation(attempt: TaskAttempt): Promise<void> {
    if (attempt.trigger !== 'retry-original'
      || attempt.parentAttemptId === null
      || attempt.outcome !== 'use-existing'
      || attempt.result?.kind !== 'use-existing') {
      throw new Error('Retry continuation requires a terminal use-existing attempt')
    }
    const parent = await this.taskAttempts.get(attempt.parentAttemptId)
    if (parent?.outcome !== 'management-required' || parent.result?.kind !== 'management-required') {
      throw new Error('Retry continuation has no exact management parent')
    }
    const verificationPayloadDigest = canonicalSha256({
      taskAttemptId: attempt.taskAttemptId,
      parentAttemptId: parent.taskAttemptId,
      targetKey: parent.result.targetKey,
      action: parent.result.action,
      needDigest: attempt.needDigest,
      existingCapabilityId: attempt.result.capabilityId,
    })
    let binding = await this.taskAttempts.putRetryContinuation({
      schemaVersion: 1,
      taskAttemptId: attempt.taskAttemptId,
      parentAttemptId: parent.taskAttemptId,
      sessionId: attempt.sessionId,
      originalMessageId: attempt.originalMessageId,
      needDigest: attempt.needDigest,
      targetKey: parent.result.targetKey,
      action: parent.result.action,
      existingCapabilityId: attempt.result.capabilityId,
      verificationPayloadDigest,
      continuationId: null,
      canceledAtMs: null,
      createdAtMs: attempt.updatedAtMs,
      expiresAtMs: attempt.expiresAtMs,
    })
    const callerId = 'extension-center' as const
    const mutationId = attempt.taskAttemptId.slice('task-attempt:'.length)
    const found = await this.observeRetryContinuationClaim(attempt, binding)
    if (binding.continuationId !== null && found === undefined) {
      throw new Error('Retry original continuation claim is absent')
    }
    if (binding.canceledAtMs !== null && found === undefined) return
    const claim = found ?? observedRetryContinuationClaim(await this.owners.taskContinuations!.reserve({
        callerId,
        mutationId,
        sessionId: attempt.sessionId,
        originalMessageId: attempt.originalMessageId,
        needDigest: attempt.needDigest,
        taskRevision: attempt.taskAttemptId,
        verifierId: RETRY_VERIFIER_ID,
        verificationPayloadDigest,
        expiresAtMs: attempt.expiresAtMs,
        resumeAgentOptions: attempt.resumeAgentOptions,
      }))
    if (claim.callerId !== callerId
      || claim.mutationId !== mutationId
      || claim.sessionId !== attempt.sessionId
      || claim.originalMessageId !== attempt.originalMessageId
      || claim.needDigest !== attempt.needDigest
      || claim.taskRevision !== attempt.taskAttemptId
      || claim.verifierId !== RETRY_VERIFIER_ID
      || claim.verificationPayloadDigest !== verificationPayloadDigest
      || claim.expiresAtMs !== attempt.expiresAtMs
      || canonicalSha256(claim.resumeAgentOptions) !== canonicalSha256(attempt.resumeAgentOptions)) {
      throw new Error('Retry original continuation claim does not bind the exact task')
    }
    binding = await this.taskAttempts.bindRetryContinuation(attempt.taskAttemptId, claim.continuationId)
    if (binding.continuationId !== claim.continuationId) throw new Error('Retry original continuation binding failed')
    if (binding.canceledAtMs !== null && ['pending', 'ready', 'consumed'].includes(claim.state)) {
      await this.owners.taskContinuations!.cancel({
        id: claim.continuationId,
        sessionId: attempt.sessionId,
        taskRevision: attempt.taskAttemptId,
      })
    }
  }

  private async verifyRetryContinuation(claim: unknown, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw signal.reason
    await this.ensureTaskAttempts()
    if (typeof claim !== 'object' || claim === null || Array.isArray(claim)) return { kind: 'not-ready' }
    const view = claim as Record<string, unknown>
    if (typeof view.continuationId !== 'string' || typeof view.taskRevision !== 'string'
      || typeof view.verificationPayloadDigest !== 'string') return { kind: 'not-ready' }
    const attempt = await this.taskAttempts.get(view.taskRevision)
    const binding = await this.taskAttempts.getRetryContinuation(view.taskRevision)
    if (attempt?.trigger !== 'retry-original'
      || attempt.outcome !== 'use-existing'
      || attempt.result?.kind !== 'use-existing'
      || binding === undefined
      || binding.continuationId !== view.continuationId
      || binding.sessionId !== view.sessionId
      || binding.originalMessageId !== view.originalMessageId
      || binding.needDigest !== view.needDigest
      || binding.verificationPayloadDigest !== view.verificationPayloadDigest
      || binding.existingCapabilityId !== attempt.result.capabilityId
      || binding.canceledAtMs !== null
      || binding.expiresAtMs <= Date.now()) return { kind: 'not-ready' }
    const attempts = await this.taskAttempts.list()
    if (attempts.some(other => other.taskAttemptId !== attempt.taskAttemptId
      && other.sessionId === attempt.sessionId
      && other.originalMessageId === attempt.originalMessageId
      && other.createdAtMs >= binding.createdAtMs)) return { kind: 'not-ready' }
    let inventory: Awaited<ReturnType<HostInventoryService['list']>>
    let existing: readonly ExistingCapability[]
    try {
      inventory = await this.inventory.list(
        attempt.need.scopeKey,
        attempt.profileId,
        attempt.need.scopeKey === 'project' ? attempt.projectRoot : null,
      )
      existing = await this.existing({
        outcomeTags: attempt.need.outcomeTags,
        inputModalities: attempt.need.inputModalities,
        outputModalities: attempt.need.outputModalities,
        scopeKey: attempt.need.scopeKey,
        profileId: attempt.profileId,
        requiredDataAccess: attempt.need.requiredDataAccess,
        maximumAuthority: attempt.need.maximumAuthority,
      }, this.agentForAttempt(attempt), attempt.projectRoot)
    } catch {
      return { kind: 'not-ready' }
    }
    if (signal.aborted) throw signal.reason
    const row = inventory.rows.find(item => item.targetKey === binding.targetKey)
    const resolved = resolveCapability({
      need: attempt.need,
      existing,
      inventory: inventory.rows,
      inventoryComplete: inventory.complete,
      catalog: [],
      catalogComplete: false,
      policy: new Map(),
      maximumCandidates: 3,
    })
    if (!inventory.complete
      || row === undefined
      || row.effective !== 'active'
      || row.agentVisibility !== 'visible'
      || resolved.decision !== 'use-existing'
      || resolved.capabilityId !== binding.existingCapabilityId) return { kind: 'not-ready' }
    return Object.freeze({
      kind: 'ready',
      continuationId: view.continuationId,
      sessionId: view.sessionId,
      originalMessageId: view.originalMessageId,
      needDigest: view.needDigest,
      taskRevision: view.taskRevision,
      verificationPayloadDigest: view.verificationPayloadDigest,
    })
  }

  private async cancelContinuation(attempt: TaskAttempt): Promise<void> {
    if (attempt.result?.kind !== 'acquisition-candidate') return
    const activation = await this.state.getContinuationActivation(attempt.result.continuationId)
    if (activation === undefined) return
    await this.owners.taskContinuations!.cancel({
      id: activation.continuationId,
      sessionId: activation.sessionId,
      taskRevision: activation.taskRevision,
    })
  }

  private async supersedeContinuation(attempt: TaskAttempt, replacementTaskAttemptId: string): Promise<void> {
    if (attempt.result?.kind !== 'acquisition-candidate') return
    const activation = await this.state.getContinuationActivation(attempt.result.continuationId)
    if (activation === undefined) return
    await this.owners.taskContinuations!.supersede({
      id: activation.continuationId,
      sessionId: activation.sessionId,
      taskRevision: activation.taskRevision,
      replacementTaskRevision: replacementTaskAttemptId,
    })
  }

  private async existing(input: ModelCapabilityNeed, agent: unknown, cwd: string): Promise<readonly ExistingCapability[]> {
    const output: ExistingCapability[] = []
    const visibleToolAccess = new Set<CapabilityDataAccess>()
    for (const schema of this.owners.tools!.schemas?.(agent) ?? []) {
      if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) continue
      const { name, description } = schema as { name?: unknown; description?: unknown }
      if (typeof name !== 'string' || ['capability_resolve', 'capability_request_acquisition'].includes(name)) continue
      const facts = toolCapabilityFacts(name, description)
      for (const item of facts.dataAccess) visibleToolAccess.add(item)
      output.push({
        capabilityId: `tool:${name}`,
        kind: 'tool',
        outcomeTags: facts.outcomeTags,
        dataAccess: facts.dataAccess,
        visible: true,
        observationComplete: true,
      })
    }
    const skills = await this.owners.skills!.snapshot({ cwd })
    for (const raw of skills.skills) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      const item = raw as { name?: unknown; description?: unknown; invocation?: { modelInvocable?: unknown } }
      if (typeof item.name !== 'string' || item.invocation?.modelInvocable !== true) continue
      output.push({
        capabilityId: `skill:${item.name}`,
        kind: 'skill',
        outcomeTags: words(`${item.name} ${typeof item.description === 'string' ? item.description : ''}`),
        // A visible Skill is usable together with the Tool schemas in the same
        // exact Agent view. Unknown Tool authority is never invented here.
        dataAccess: Object.freeze([...visibleToolAccess].sort()),
        visible: true,
        observationComplete: skills.complete,
      })
    }
    return Object.freeze(output.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)))
  }

  private pruneVolatileResolutions(nowMs: number): void {
    for (const [id, resolution] of this.volatileResolutions) {
      if (resolution.expiresAtMs <= nowMs) this.volatileResolutions.delete(id)
    }
  }

  private async resolutionCandidates(
    resolution: CapabilityResolution,
    rows: readonly InventoryRow[],
    entries: readonly CatalogEntry[],
    input: ModelCapabilityNeed,
    cwd: string,
  ): Promise<readonly ResolutionCandidate[]> {
    if (resolution.decision === 'management-required') {
      const row = rows.find(item => item.targetKey === resolution.extensionRef)
      const candidate = row === undefined ? undefined : rowCandidate(row)
      return candidate === undefined ? [] : Object.freeze([candidate])
    }
    const refs = resolution.decision === 'acquisition-candidate'
      ? [resolution.candidate.candidateRef]
      : resolution.decision === 'choice-required'
        ? resolution.candidates.map(candidate => candidate.candidateRef)
        : []
    const projectRoot = input.scopeKey === 'project' ? cwd : null
    const output: ResolutionCandidate[] = []
    for (const candidateRef of refs) {
      const entry = entries.find(candidate => candidate.candidateRef === candidateRef)
      if (entry === undefined) continue
      const configuration: RpcJson = entry.kind === 'mcp'
        ? null
        : entry.kind === 'skill'
          ? { modelInvocable: true, userInvocable: true, projectRoot }
          : {}
      output.push(Object.freeze({ candidateRef, operationKind: 'install', targetKey: null, configuration }))
    }
    return Object.freeze(output.sort((left, right) => left.candidateRef.localeCompare(right.candidateRef)))
  }
}

/** Create the two strict model tool definitions without importing a newer Host package. */
export function capabilityToolDefinitions(service: CapabilityAcquisitionService): readonly unknown[] {
  const text = (value: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: JSON.stringify(value) }]
  return Object.freeze([{
    name: 'capability_resolve',
    description: 'Resolve an existing capability first, or return opaque locally verified acquisition candidates. This tool never installs or approves anything.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['outcomeTags', 'inputModalities', 'outputModalities', 'scopeKey', 'profileId', 'requiredDataAccess', 'maximumAuthority'],
      properties: {
        outcomeTags: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: TAG.source } },
        inputModalities: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { type: 'string', enum: MODALITIES } },
        outputModalities: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { type: 'string', enum: MODALITIES } },
        scopeKey: { type: 'string', enum: ['profile:web', 'user', 'project'] },
        profileId: { type: 'string', pattern: SAFE_ID.source },
        requiredDataAccess: { type: 'array', minItems: 0, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: ACCESS } },
        maximumAuthority: { type: 'array', minItems: 0, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: ACCESS } },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: RpcJson) => text(value) },
    execute: (args: unknown, exec: { agent?: unknown; signal: AbortSignal }) => service.resolve(args, exec.agent, exec.signal),
    presentCall: () => ({ card: 'generic', title: 'Resolve capability', kind: 'search' }),
  }, {
    name: 'capability_request_acquisition',
    description: 'Request a human-reviewable immutable plan using only opaque ids returned by capability_resolve. This tool cannot approve or execute the plan.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['resolutionId', 'candidateRef', 'continuationId'],
      properties: {
        resolutionId: { type: 'string', pattern: '^resolution:[0-9a-f-]{36}$' },
        candidateRef: { type: 'string', pattern: CANDIDATE_REF.source },
        continuationId: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: RpcJson) => text(value) },
    execute: (args: unknown, exec: { agent?: unknown; signal: AbortSignal }) => service.request(args, exec.agent, exec.signal),
    presentCall: () => ({ card: 'generic', title: 'Request capability acquisition', kind: 'other' }),
  }])
}
