import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { VerifiedCatalog } from '../catalog.ts'
import { catalogListResponse } from '../catalog.ts'
import type { AdmittedCatalogSnapshot, CatalogAdmissionStatus } from '../catalog-refresh.ts'
import { readSha256Digest } from '../domain/codec.ts'
import { hostCapabilities, type HostOwners } from '../host/index.ts'
import type { OperationKind } from '../plans/index.ts'
import { FilePlanStore } from '../storage/index.ts'
import type { IntentPlanService } from './intent-plan-service.ts'
import type { CapabilityAcquisitionService } from './capability-service.ts'
import { IntentPolicyDeniedError } from './intent-plan-service.ts'
import type { HostInventoryService } from './inventory-service.ts'
import type { OperationRunner } from './operation-runner.ts'
import {
  HOST_RPC_PROTOCOL_VERSION,
  type HostCapabilityProjection,
  type IntentPreviewRequest,
  type RpcJson,
} from './rpc-contract.ts'

const OPERATIONS = new Set<OperationKind>([
  'install', 'configure', 'update', 'enable', 'disable', 'uninstall', 'restore', 'purge',
])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/
const CANDIDATE = /^(?:plugin|mcp|skill):[A-Za-z0-9@._:/-]{1,240}$/
const TASK_ATTEMPT = /^task-attempt:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request must be an object')
  const input = value as Record<string, unknown>
  const actual = Object.keys(input).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('request contains unexpected fields')
  }
  return input
}

function protocol(input: Record<string, unknown>): void {
  if (input.protocolVersion !== HOST_RPC_PROTOCOL_VERSION) throw new Error('unsupported Extension Center protocol')
}

function id(value: unknown, subject: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || !SAFE_ID.test(value)) {
    throw new Error(`${subject} is invalid`)
  }
  return value
}

function json(value: unknown, depth = 0, count = { value: 0 }): RpcJson {
  count.value += 1
  if (count.value > 4_096 || depth > 16) throw new Error('configuration JSON exceeds its structural bound')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('configuration JSON contains a non-finite number')
    return value
  }
  if (typeof value === 'string') {
    if (value.length > 16_384 || value.includes('\0')) throw new Error('configuration JSON string is invalid')
    return value
  }
  if (Array.isArray(value)) return Object.freeze(value.map(item => json(item, depth + 1, count)))
  if (typeof value !== 'object') throw new Error('configuration is not JSON')
  const output: Record<string, RpcJson> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key.length === 0 || key.length > 128 || key.includes('\0')) throw new Error('configuration JSON key is invalid')
    output[key] = json((value as Record<string, unknown>)[key], depth + 1, count)
  }
  return Object.freeze(output)
}

function listRequest(payload: unknown): void {
  const input = exact(payload, ['protocolVersion'])
  protocol(input)
}

function inventoryRequest(payload: unknown): Readonly<{ scopeKey: string; profileId: string }> {
  const input = exact(payload, ['profileId', 'protocolVersion', 'scopeKey'])
  protocol(input)
  return Object.freeze({ scopeKey: id(input.scopeKey, 'scopeKey', 128), profileId: id(input.profileId, 'profileId', 128) })
}

function inventoryVerifyRequest(payload: unknown): Readonly<{ scopeKey: string; profileId: string; targetKey: string }> {
  const input = exact(payload, ['profileId', 'protocolVersion', 'scopeKey', 'targetKey'])
  protocol(input)
  return Object.freeze({
    scopeKey: id(input.scopeKey, 'scopeKey', 128),
    profileId: id(input.profileId, 'profileId', 128),
    targetKey: id(input.targetKey, 'targetKey'),
  })
}

function configurationOptionsRequest(payload: unknown): Readonly<{
  candidateRef: string
  targetKey: string | null
  scopeKey: string
  profileId: string
}> {
  const input = exact(payload, ['candidateRef', 'profileId', 'protocolVersion', 'scopeKey', 'targetKey'])
  protocol(input)
  if (typeof input.candidateRef !== 'string' || !CANDIDATE.test(input.candidateRef)
    || (input.targetKey !== null && (typeof input.targetKey !== 'string' || !SAFE_ID.test(input.targetKey)))) {
    throw new Error('configuration candidateRef is invalid')
  }
  return Object.freeze({
    candidateRef: input.candidateRef,
    targetKey: input.targetKey as string | null,
    scopeKey: id(input.scopeKey, 'scopeKey', 128),
    profileId: id(input.profileId, 'profileId', 128),
  })
}

function previewRequest(payload: unknown): IntentPreviewRequest {
  const input = exact(payload, [
    'candidateRef', 'configuration', 'continuationId', 'operationKind', 'origin', 'profileId',
    'protocolVersion', 'scopeKey', 'targetKey',
  ])
  protocol(input)
  if (input.origin !== 'store' || input.continuationId !== null
    || typeof input.candidateRef !== 'string' || !CANDIDATE.test(input.candidateRef)
    || typeof input.operationKind !== 'string' || !OPERATIONS.has(input.operationKind as OperationKind)
    || (input.targetKey !== null && (typeof input.targetKey !== 'string' || !SAFE_ID.test(input.targetKey)))) {
    throw new Error('Store preview identity fields are invalid')
  }
  return Object.freeze({
    protocolVersion: HOST_RPC_PROTOCOL_VERSION,
    origin: 'store',
    candidateRef: input.candidateRef,
    operationKind: input.operationKind as OperationKind,
    scopeKey: id(input.scopeKey, 'scopeKey', 128),
    profileId: id(input.profileId, 'profileId', 128),
    continuationId: null,
    targetKey: input.targetKey as string | null,
    configuration: json(input.configuration),
  })
}

function taskConfigurationRequest(payload: unknown): Readonly<{
  resolutionId: string
  candidateRef: string
  continuationId: string
  configuration: RpcJson
}> {
  const input = exact(payload, ['candidateRef', 'configuration', 'continuationId', 'protocolVersion', 'resolutionId'])
  protocol(input)
  if (typeof input.resolutionId !== 'string'
    || !/^resolution:[0-9a-f-]{36}$/u.test(input.resolutionId)
    || typeof input.candidateRef !== 'string'
    || !CANDIDATE.test(input.candidateRef)
    || typeof input.continuationId !== 'string'
    || !/^[0-9a-f-]{36}$/u.test(input.continuationId)) {
    throw new Error('task configuration opaque bindings are invalid')
  }
  return Object.freeze({
    resolutionId: input.resolutionId,
    candidateRef: input.candidateRef,
    continuationId: input.continuationId,
    configuration: json(input.configuration),
  })
}

function planGet(payload: unknown): string {
  const input = exact(payload, ['planHash', 'protocolVersion'])
  protocol(input)
  return readSha256Digest(input.planHash, 'planHash')
}

function decideRequest(payload: unknown): Readonly<{
  planId: string
  planHash: `sha256:${string}`
  operationKind: OperationKind
  decision: 'approve' | 'reject'
}> {
  const input = exact(payload, ['decision', 'operationKind', 'planHash', 'planId', 'protocolVersion'])
  protocol(input)
  if (typeof input.operationKind !== 'string' || !OPERATIONS.has(input.operationKind as OperationKind)
    || !['approve', 'reject'].includes(String(input.decision))) throw new Error('plan decision fields are invalid')
  return Object.freeze({
    planId: id(input.planId, 'planId'),
    planHash: readSha256Digest(input.planHash, 'planHash'),
    operationKind: input.operationKind as OperationKind,
    decision: input.decision as 'approve' | 'reject',
  })
}

function operationId(payload: unknown): string {
  const input = exact(payload, ['operationId', 'protocolVersion'])
  protocol(input)
  return id(input.operationId, 'operationId')
}

function taskAttemptRequest(payload: unknown): string {
  const input = exact(payload, ['protocolVersion', 'taskAttemptId'])
  protocol(input)
  if (typeof input.taskAttemptId !== 'string' || !TASK_ATTEMPT.test(input.taskAttemptId)) {
    throw new Error('taskAttemptId is invalid')
  }
  return input.taskAttemptId
}

function taskChoiceRequest(payload: unknown): Readonly<{ taskAttemptId: string; candidateRef: string }> {
  const input = exact(payload, ['candidateRef', 'protocolVersion', 'taskAttemptId'])
  protocol(input)
  if (typeof input.taskAttemptId !== 'string' || !TASK_ATTEMPT.test(input.taskAttemptId)
    || typeof input.candidateRef !== 'string' || !CANDIDATE.test(input.candidateRef)) {
    throw new Error('task choice binding is invalid')
  }
  return Object.freeze({ taskAttemptId: input.taskAttemptId, candidateRef: input.candidateRef })
}

function bootAck(payload: unknown): Readonly<{ operationId: string; profileId: string; generation: string }> {
  const input = exact(payload, ['generation', 'operationId', 'profileId', 'protocolVersion'])
  protocol(input)
  return Object.freeze({
    operationId: id(input.operationId, 'operationId'),
    profileId: id(input.profileId, 'profileId', 128),
    generation: id(input.generation, 'generation'),
  })
}

function badRequest(message: string) {
  return { ok: false as const, error: { code: 'bad-request' as const, message, details: { issues: [] } } }
}

function cancelled() {
  return { ok: false as const, error: { code: 'cancelled' as const, message: 'request was cancelled', details: {} } }
}

function internal() {
  return { ok: false as const, error: { code: 'internal' as const, message: 'Extension Center operation failed', details: {} } }
}

/** Services used by one coherent Host RPC runtime generation. */
export interface HostRpcServices {
  readonly owners: HostOwners
  readonly capabilities?: HostCapabilityProjection
  readonly generation?: HostRpcGeneration
  readonly catalog: () => VerifiedCatalog
  readonly catalogStatus?: () => CatalogAdmissionStatus
  readonly refreshCatalog?: () => Promise<AdmittedCatalogSnapshot>
  readonly inventory: HostInventoryService
  readonly intentPlans: IntentPlanService
  readonly plans: FilePlanStore
  readonly operations: OperationRunner
  readonly acquisition: CapabilityAcquisitionService | null
}

/** Generation owner that cancels and drains requests before its Host owners retire. */
export interface HostRpcGeneration {
  /** Run one request while this exact owner generation remains writable. */
  run<T>(signal: AbortSignal, request: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** Resolve either one fixed runtime or the currently active dynamic runtime. */
export type HostRpcServicesSource = HostRpcServices | (() => HostRpcServices)

function currentCapabilities(input: HostRpcServices): HostCapabilityProjection {
  return input.capabilities ?? hostCapabilities(input.owners)
}

/** Create the strict loopback-only management handler; carrier authority is not accepted from payloads. */
export function createHostRpcHandler(source: HostRpcServicesSource): ConnectionRpcHandler {
  return async (endpoint, payload, outerSignal) => {
    const input = typeof source === 'function' ? source() : source
    const execute = async (signal: AbortSignal): ReturnType<ConnectionRpcHandler> => {
      if (signal.aborted) return cancelled()
      try {
        if (['intent/preview', 'approval/configure', 'plan/decide', 'lifecycle/request', 'operation/recover', 'operation/ack-profile-boot'].includes(endpoint)
          && !currentCapabilities(input).acquisition) {
          return badRequest('Extension Center writes are unavailable because a required Host capability is absent')
        }
        switch (endpoint) {
        case 'catalog/list':
          listRequest(payload)
          return {
            ok: true,
            value: catalogListResponse(input.catalog(), currentCapabilities(input), input.catalogStatus?.()),
          }
        case 'catalog/refresh': {
          listRequest(payload)
          if (input.refreshCatalog === undefined) throw new Error('catalog live refresh is unavailable')
          const snapshot = await input.refreshCatalog()
          return {
            ok: true,
            value: catalogListResponse(snapshot.catalog, currentCapabilities(input), snapshot.status),
          }
        }
        case 'inventory/list': {
          const request = inventoryRequest(payload)
          return { ok: true, value: {
            protocolVersion: HOST_RPC_PROTOCOL_VERSION,
            hostCapabilities: currentCapabilities(input),
            inventory: await input.inventory.list(request.scopeKey, request.profileId),
          } }
        }
        case 'inventory/verify': {
          const request = inventoryVerifyRequest(payload)
          return { ok: true, value: {
            protocolVersion: HOST_RPC_PROTOCOL_VERSION,
            hostCapabilities: currentCapabilities(input),
            inventory: await input.inventory.verify(request.scopeKey, request.profileId, request.targetKey),
          } }
        }
        case 'intent/preview':
          return { ok: true, value: await input.intentPlans.preview(previewRequest(payload), 'loopback-browser') }
        case 'plan/get': {
          const state = await input.plans.load(planGet(payload) as `sha256:${string}`) ?? null
          return { ok: true, value: { protocolVersion: HOST_RPC_PROTOCOL_VERSION, state } }
        }
        case 'plan/list':
          listRequest(payload)
          return { ok: true, value: { protocolVersion: HOST_RPC_PROTOCOL_VERSION, states: await input.plans.list() } }
        case 'approval/list':
          listRequest(payload)
          return { ok: true, value: {
            protocolVersion: HOST_RPC_PROTOCOL_VERSION,
            approvals: await input.intentPlans.listTaskApprovals(),
            configurations: input.acquisition === null ? [] : await input.acquisition.listConfigurationRequests(),
          } }
        case 'approval/configure': {
          if (input.acquisition === null) throw new Error('task acquisition service is unavailable')
          const request = taskConfigurationRequest(payload)
          const response = await input.acquisition.configureTaskCandidate(request)
          return { ok: true, value: { ...response, resolutionId: request.resolutionId } }
        }
        case 'task-attempt/list':
          listRequest(payload)
          if (input.acquisition === null) throw new Error('task acquisition service is unavailable')
          return { ok: true, value: {
            protocolVersion: HOST_RPC_PROTOCOL_VERSION,
            attempts: await input.acquisition.listTaskAttempts(),
          } }
        case 'task-attempt/select': {
          if (input.acquisition === null) throw new Error('task acquisition service is unavailable')
          const request = taskChoiceRequest(payload)
          return { ok: true, value: await input.acquisition.selectTaskCandidate(
            request.taskAttemptId,
            request.candidateRef,
            signal,
          ) }
        }
        case 'task-attempt/retry':
          if (input.acquisition === null) throw new Error('task acquisition service is unavailable')
          return { ok: true, value: await input.acquisition.retryOriginalTask(taskAttemptRequest(payload), signal) }
        case 'task-attempt/cancel':
          if (input.acquisition === null) throw new Error('task acquisition service is unavailable')
          return { ok: true, value: {
            protocolVersion: HOST_RPC_PROTOCOL_VERSION,
            attempt: await input.acquisition.cancelTaskAttempt(taskAttemptRequest(payload)),
          } }
        case 'configuration/options': {
          const request = configurationOptionsRequest(payload)
          const options = await input.intentPlans.configurationOptions(request)
          return { ok: true, value: {
            protocolVersion: HOST_RPC_PROTOCOL_VERSION,
            ...options,
          } }
        }
        case 'plan/decide': {
          const request = decideRequest(payload)
          const state = await input.plans.load(request.planHash)
          if (state === undefined) throw new Error('plan is absent')
          if (state.plan.content.origin === 'task') {
            if (input.acquisition === null) throw new Error('task acquisition service is unavailable')
            await input.acquisition.assertPlanDecisionAllowed(request.planHash, request.decision)
          }
          const decided = state.status === 'approved'
            && request.decision === 'approve'
            && state.decision.planId === request.planId
            && state.decision.planHash === request.planHash
            && state.decision.operationKind === request.operationKind
            ? state
            : await input.plans.decide(
              request.planHash,
              request,
              await input.intentPlans.context(state.plan),
              Date.now(),
            )
          if (decided.status === 'approved' && decided.plan.content.origin === 'task') {
            if (input.acquisition === null) throw new Error('task acquisition service is unavailable')
            await input.acquisition.activateApprovedPlan(request.planHash)
          } else if (decided.status === 'rejected' && decided.plan.content.origin === 'task') {
            if (input.acquisition === null) throw new Error('task acquisition service is unavailable')
            await input.acquisition.recordPlanDecision(request.planHash, 'reject')
          }
          return { ok: true, value: { protocolVersion: HOST_RPC_PROTOCOL_VERSION, state: decided } }
        }
        case 'lifecycle/request': {
          const planHash = planGet(payload)
          const state = await input.plans.load(planHash as `sha256:${string}`)
          if (state?.plan.content.origin === 'task') {
            if (input.acquisition === null) throw new Error('task acquisition service is unavailable')
            await input.acquisition.activateApprovedPlan(planHash)
          }
          const response = await input.operations.run(planHash, signal)
          if (state?.plan.content.origin === 'task') await input.acquisition!.recordLifecycleResult(planHash, response.status)
          return { ok: true, value: response }
        }
        case 'operation/get':
          return { ok: true, value: {
            protocolVersion: HOST_RPC_PROTOCOL_VERSION,
            operation: await input.operations.get(operationId(payload)),
          } }
        case 'operation/list':
          listRequest(payload)
          return { ok: true, value: { protocolVersion: HOST_RPC_PROTOCOL_VERSION, operations: await input.operations.list() } }
        case 'operation/receipts':
          listRequest(payload)
          return { ok: true, value: { protocolVersion: HOST_RPC_PROTOCOL_VERSION, receipts: await input.operations.listReceipts() } }
        case 'operation/recover': {
          const requested = operationId(payload)
          const prior = await input.operations.get(requested)
          const response = await input.operations.recoverOperation(requested, signal)
          if (prior !== null) await input.acquisition?.recordLifecycleResult(prior.projection.planHash, response.status)
          return { ok: true, value: response }
        }
        case 'operation/ack-profile-boot': {
          const request = bootAck(payload)
          const prior = await input.operations.get(request.operationId)
          const response = await input.operations.acknowledgeProfileBoot(request, signal)
          if (prior !== null) await input.acquisition?.recordLifecycleResult(prior.projection.planHash, response.status)
          return { ok: true, value: response }
        }
        default:
          return badRequest(`unknown Extension Center endpoint: ${endpoint}`)
        }
      } catch (error: unknown) {
        if (signal.aborted) return cancelled()
        if (error instanceof IntentPolicyDeniedError
          || error instanceof TypeError
          || (error instanceof Error && /(?:invalid|absent|already|expired|stale|terminal|conflict|unavailable|unexpected|unsupported|does not|not |requires|cannot)/iu.test(error.message))) {
          return badRequest(error instanceof Error ? error.message : 'request was refused')
        }
        return internal()
      }
    }
    if (input.generation === undefined) return await execute(outerSignal)
    try {
      return await input.generation.run(outerSignal, execute)
    } catch {
      return cancelled()
    }
  }
}
