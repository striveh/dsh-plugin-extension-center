/** Plugin-owned verifier-gated continuation owner over official DSH rc.2 APIs. */

import { createHash, randomUUID } from 'node:crypto'
import type { TaskContinuationsOwner } from '../../host/owners.ts'
import {
  TaskContinuationInputError,
  agentOptions,
  assertSameReservation,
  continuationAgent,
  continuationId,
  continuationMessage,
  continuationRef,
  createRequest,
  isContinuationMessage,
  listRequest,
  readyDecision,
  reserveRequest,
  sameAgentOptions,
  supersedeRequest,
} from './codec.ts'
import {
  InternalTaskContinuationStore,
  type NewTaskContinuation,
} from './store.ts'
import type {
  ContinuationAgent,
  ContinuationAgentHandle,
  ContinuationMessage,
  ContinuationSessionEvent,
  CreateTaskContinuationRequest,
  InternalTaskContinuationConfig,
  InternalTaskContinuationsOwner,
  TaskContinuationClaim,
  TaskContinuationInvalidReason,
  TaskContinuationState,
  TaskContinuationVerification,
  TaskContinuationVerifier,
} from './types.ts'

const DEFAULT_BUSY_TIMEOUT_MS = 10_000
const DEFAULT_DISPATCH_CLAIM_LEASE_MS = 30_000
const DEFAULT_RETRY_INITIAL_DELAY_MS = 100
const DEFAULT_RETRY_MAX_DELAY_MS = 5_000
const MAX_BUSY_TIMEOUT_MS = 2_147_483_647
const CANCELABLE_STATES: readonly TaskContinuationState[] = ['pending', 'ready', 'consumed']
const RECONCILABLE_STATES: readonly TaskContinuationState[] = [
  'pending', 'ready', 'consumed', 'dispatching', 'dispatched', 'delivery-unknown',
]
const VERIFIER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

interface RegisteredVerifier {
  readonly verifier: TaskContinuationVerifier
  readonly cancellation: AbortController
}

/** SQLite-backed owner that never persists the original task text. */
export class InternalTaskContinuationOwner implements InternalTaskContinuationsOwner, TaskContinuationsOwner {
  readonly protocolVersion = 1 as const

  private readonly store: InternalTaskContinuationStore
  private readonly verifiers = new Map<string, RegisteredVerifier>()
  private readonly subscribers = new Set<() => void>()
  private readonly ownedHandles = new Map<string, ContinuationAgentHandle>()
  private readonly retiringHandles = new Map<string, Promise<void>>()
  private readonly settling = new Set<string>()
  private readonly settledDispatches = new Set<string>()
  private readonly retryDelays = new Map<string, number>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly leaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly stopSignal = new AbortController()
  private readonly ownerId = randomUUID()
  private readonly dispatchClaimLeaseMs: number
  private readonly retryInitialDelayMs: number
  private readonly retryMaxDelayMs: number
  private storeActivated = false
  private requested = false
  private running: Promise<void> | undefined
  private stopping = false
  private disposePromise: Promise<void> | undefined
  private disposeLifecycle: (() => void) | undefined

  constructor(private readonly config: InternalTaskContinuationConfig) {
    const timeout = config.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_BUSY_TIMEOUT_MS) {
      throw new TaskContinuationInputError(`task continuation busyTimeoutMs must be 0-${String(MAX_BUSY_TIMEOUT_MS)}`)
    }
    const retryInitialDelayMs = config.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS
    const retryMaxDelayMs = config.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS
    if (!Number.isSafeInteger(retryInitialDelayMs) || retryInitialDelayMs < 1
      || !Number.isSafeInteger(retryMaxDelayMs) || retryMaxDelayMs < retryInitialDelayMs
      || retryMaxDelayMs > MAX_BUSY_TIMEOUT_MS) {
      throw new TaskContinuationInputError(
        `task continuation retry delays must satisfy 1 <= initial <= maximum <= ${String(MAX_BUSY_TIMEOUT_MS)}`,
      )
    }
    this.retryInitialDelayMs = retryInitialDelayMs
    this.retryMaxDelayMs = retryMaxDelayMs
    const dispatchClaimLeaseMs = config.dispatchClaimLeaseMs ?? DEFAULT_DISPATCH_CLAIM_LEASE_MS
    if (!Number.isSafeInteger(dispatchClaimLeaseMs) || dispatchClaimLeaseMs < 1
      || dispatchClaimLeaseMs > MAX_BUSY_TIMEOUT_MS) {
      throw new TaskContinuationInputError(
        `task continuation dispatchClaimLeaseMs must be 1-${String(MAX_BUSY_TIMEOUT_MS)}`,
      )
    }
    this.dispatchClaimLeaseMs = dispatchClaimLeaseMs
    this.store = new InternalTaskContinuationStore(config.root, timeout)
  }

  /** Open prior durable state without creating a database for an unused owner. */
  async initialize(): Promise<void> {
    this.assertActive()
    this.storeActivated = await this.store.initializeIfPresent()
    if (this.config.observeLifecycle !== undefined) {
      const dispose = this.config.observeLifecycle(() => { this.wakeRetries() })
      if (typeof dispose !== 'function') throw new Error('task continuation lifecycle observer returned no disposer')
      this.disposeLifecycle = dispose
    }
  }

  async create(agentValue: unknown, requestValue: unknown): Promise<TaskContinuationClaim> {
    this.assertActive()
    const agent = continuationAgent(agentValue)
    const request = createRequest(requestValue)
    const options = agentOptions(agent.options)
    await this.activateStore()
    const existing = await this.store.getByMutation(request.callerId, request.mutationId)
    if (existing !== undefined) {
      assertSameReservation(existing, request, options)
      this.schedule()
      return existing
    }
    this.assertFuture(request.expiresAtMs)
    this.assertExactLiveAgent(agent, request.sessionId)
    this.assertOriginalTask(agent.session.events, request)
    const claim = await this.reserveRecord(request, options)
    this.schedule()
    return claim
  }

  async reserve(requestValue: unknown): Promise<TaskContinuationClaim> {
    this.assertActive()
    const request = reserveRequest(requestValue)
    await this.activateStore()
    const existing = await this.store.getByMutation(request.callerId, request.mutationId)
    if (existing !== undefined) {
      assertSameReservation(existing, request, request.resumeAgentOptions)
      this.schedule()
      return existing
    }
    this.assertFuture(request.expiresAtMs)
    const live = this.config.agents.get(request.sessionId)
    if (live !== undefined) {
      this.assertExactLiveAgent(live, request.sessionId)
      if (!sameAgentOptions(agentOptions(live.options), request.resumeAgentOptions)) {
        throw new Error(`task continuation resume options do not match live session "${request.sessionId}"`)
      }
      this.assertOriginalTask(live.session.events, request)
    } else {
      if (this.config.sessions.get(request.sessionId) !== undefined) {
        throw new Error(`task continuation cannot reserve session "${request.sessionId}" without its live Agent`)
      }
      const persisted = await this.config.sessionPersistence.load(request.sessionId)
      this.assertOriginalTask(persisted.events, request)
    }
    const claim = await this.reserveRecord(request, request.resumeAgentOptions)
    this.schedule()
    return claim
  }

  async get(id: string): Promise<TaskContinuationClaim | undefined> {
    if (!await this.activateExistingStore()) return undefined
    return this.store.get(continuationId(id))
  }

  async list(requestValue: unknown = {}): Promise<readonly TaskContinuationClaim[]> {
    const request = listRequest(requestValue)
    if (!await this.activateExistingStore()) return []
    return (await this.store.list()).filter(claim =>
      (request.sessionId === undefined || claim.sessionId === request.sessionId)
      && (request.callerId === undefined || claim.callerId === request.callerId)
      && (request.mutationId === undefined || claim.mutationId === request.mutationId))
  }

  async cancel(refValue: unknown): Promise<boolean> {
    const ref = continuationRef(refValue)
    if (!await this.activateExistingStore()) return false
    const changed = await this.store.transition({
      id: ref.id,
      from: CANCELABLE_STATES,
      to: 'canceled',
      expectedSessionId: ref.sessionId,
      expectedTaskRevision: ref.taskRevision,
      updatedAtMs: Date.now(),
    })
    if (changed === undefined) return false
    this.claimChanged(changed)
    await this.removeLiveMarker(changed)
    await this.releaseOwnedHandle(changed.sessionId)
    return true
  }

  async supersede(requestValue: unknown): Promise<boolean> {
    const request = supersedeRequest(requestValue)
    if (!await this.activateExistingStore()) return false
    const changed = await this.store.transition({
      id: request.id,
      from: CANCELABLE_STATES,
      to: 'superseded',
      expectedSessionId: request.sessionId,
      expectedTaskRevision: request.taskRevision,
      supersededByTaskRevision: request.replacementTaskRevision,
      updatedAtMs: Date.now(),
    })
    if (changed === undefined) return false
    this.claimChanged(changed)
    await this.removeLiveMarker(changed)
    await this.releaseOwnedHandle(changed.sessionId)
    return true
  }

  registerVerifier(verifierValue: Readonly<{
    id: string
    verify(claim: unknown, signal: AbortSignal): Promise<unknown>
  }>): () => void {
    this.assertActive()
    if (!VERIFIER_ID.test(verifierValue.id) || verifierValue.id.length > 128) {
      throw new TaskContinuationInputError('task continuation verifier id must be 1-128 lower-kebab characters')
    }
    if (this.verifiers.has(verifierValue.id)) {
      throw new Error(`task continuation verifier "${verifierValue.id}" is already registered`)
    }
    const verifier: TaskContinuationVerifier = {
      id: verifierValue.id,
      verify: async (claim, signal) => await verifierValue.verify(claim, signal) as TaskContinuationVerification,
    }
    const registered: RegisteredVerifier = { verifier, cancellation: new AbortController() }
    this.verifiers.set(verifier.id, registered)
    this.schedule()
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.verifiers.get(verifier.id) !== registered) return
      this.verifiers.delete(verifier.id)
      registered.cancellation.abort(new Error(`task continuation verifier "${verifier.id}" unregistered`))
    }
  }

  /** Observe durable claim changes as invalidation signals without receiving claim authority. */
  subscribe(listener: () => void): () => void {
    this.assertActive()
    if (typeof listener !== 'function') throw new TaskContinuationInputError('task continuation subscriber must be a function')
    this.subscribers.add(listener)
    queueMicrotask(() => { this.notifySubscriber(listener) })
    let active = true
    return () => {
      if (!active) return
      active = false
      this.subscribers.delete(listener)
    }
  }

  /** Reconcile every active record and queue at most one exact follow-up identity. */
  async reconcile(signal?: AbortSignal): Promise<void> {
    if (this.stopping || !this.storeActivated) return
    this.requested = true
    if (this.running === undefined) {
      const operation = (): Promise<void> => this.runRequested()
      const run = this.config.agents.withoutInitiator?.(operation) ?? operation()
      this.running = run
      void run.finally(() => {
        if (this.running === run) this.running = undefined
        if (this.requested && !this.stopping) this.schedule()
      }).catch(() => {})
    }
    if (signal === undefined) {
      await this.running
      return
    }
    signal.throwIfAborted()
    let rejectAbort!: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const abort = () => { rejectAbort(signal.reason ?? new Error('task continuation reconciliation cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      await Promise.race([this.running, aborted])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  /** Stop recovery, close cold-resumed handles, and release SQLite state. */
  dispose(): Promise<void> {
    return (this.disposePromise ??= this.disposeOwner())
  }

  private async disposeOwner(): Promise<void> {
    this.stopping = true
    this.requested = false
    const disposeLifecycle = this.disposeLifecycle
    this.disposeLifecycle = undefined
    try {
      disposeLifecycle?.()
    } catch (error: unknown) {
      this.config.logger?.warn(`extension-center continuation lifecycle disposer failed: ${renderThrown(error)}`)
    }
    this.stopSignal.abort(new Error('task continuation owner disposed'))
    for (const registered of this.verifiers.values()) {
      registered.cancellation.abort(new Error('task continuation owner disposed'))
    }
    this.verifiers.clear()
    this.subscribers.clear()
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    for (const timer of this.leaseTimers.values()) clearTimeout(timer)
    this.leaseTimers.clear()
    this.settledDispatches.clear()
    this.retryDelays.clear()
    if (this.running !== undefined) await this.running.catch(() => {})
    const handles = [...this.ownedHandles.values()]
    this.ownedHandles.clear()
    this.retiringHandles.clear()
    await Promise.allSettled(handles.map(async handle => { await handle.dispose() }))
    this.store.close()
  }

  private async reserveRecord(
    request: CreateTaskContinuationRequest,
    options: Readonly<ReturnType<typeof agentOptions>>,
  ): Promise<TaskContinuationClaim> {
    const now = Date.now()
    this.assertFuture(request.expiresAtMs, now)
    const input: NewTaskContinuation = {
      kind: 'task-continuation',
      version: 3,
      continuationId: randomUUID(),
      callerId: request.callerId,
      mutationId: request.mutationId,
      dispatchMessageId: randomUUID(),
      resumeAgentOptions: options,
      sessionId: request.sessionId,
      originalMessageId: request.originalMessageId,
      needDigest: request.needDigest,
      taskRevision: request.taskRevision,
      verifierId: request.verifierId,
      verificationPayloadDigest: request.verificationPayloadDigest,
      createdAtMs: now,
      expiresAtMs: request.expiresAtMs,
    }
    const reserved = await this.store.createOrGet(input)
    assertSameReservation(reserved.claim, request, options)
    if (reserved.created) this.notifySubscribers()
    return reserved.claim
  }

  private async runRequested(): Promise<void> {
    while (this.requested && !this.stopping) {
      this.requested = false
      for (const claim of await this.store.list()) {
        if (this.stopping) return
        try {
          await this.processClaim(claim)
        } catch (error: unknown) {
          this.config.logger?.warn(`extension-center continuation "${claim.continuationId}" reconciliation failed: ${renderThrown(error)}`)
          const current = await this.store.get(claim.continuationId).catch(() => undefined)
          if (current?.state === 'consumed') this.scheduleRetry(current.continuationId)
          if (current?.state === 'dispatching') this.scheduleLeaseRecovery(current)
        }
      }
    }
  }

  private async processClaim(captured: TaskContinuationClaim): Promise<void> {
    let claim = await this.store.get(captured.continuationId)
    if (claim === undefined) return
    if (claim.state === 'consumed' && this.retryTimers.has(claim.continuationId)) return
    if (!RECONCILABLE_STATES.includes(claim.state)) {
      this.clearRetry(claim.continuationId)
      this.clearLeaseRecovery(claim.continuationId)
      await this.removeLiveMarker(claim)
      await this.releaseOwnedHandle(claim.sessionId)
      return
    }

    const dispatchOwned = claim.state === 'dispatching'
      || claim.state === 'dispatched'
      || claim.state === 'delivery-unknown'
    const events = claim.state === 'dispatched'
      ? await this.readDispatchedEvents(claim.sessionId)
      : dispatchOwned
        ? await this.readPersistedEvents(claim.sessionId)
      : await this.readEvents(claim.sessionId)
    const evidence = classifyDispatchEvidence(events, claim)
    if (evidence !== 'none') {
      if (!dispatchOwned || claim.dispatchStartedAtMs === undefined) {
        await this.invalidate(claim, 'dispatch-evidence-before-owned-call')
        return
      }
      const target = evidence === 'message' ? 'claimed'
        : evidence === 'inbox' ? 'dispatched'
          : 'invalid'
      if (claim.state !== target) {
        const observed = target === 'invalid'
          ? await this.store.observeDispatch(
              claim,
              target,
              Date.now(),
              'dispatch-evidence-content-mismatch',
            )
          : await this.store.observeDispatch(claim, target, Date.now())
        if (observed !== undefined) {
          this.claimChanged(observed)
          claim = observed
          if (observed.state === 'invalid') {
            this.logInvalid(observed, observed.invalidReason!)
          }
        } else {
          return
        }
      }
      if (claim.state === 'claimed' || claim.state === 'invalid') {
        await this.releaseOwnedHandle(claim.sessionId)
        return
      }
    }

    const replacement = laterDirectUserMessage(events, claim.originalMessageId)
    if (replacement !== undefined) {
      if (dispatchOwned) {
        await this.invalidate(claim, 'newer-direct-user-message-after-dispatch')
        return
      }
      const superseded = await this.store.transition({
        id: claim.continuationId,
        from: [claim.state],
        to: 'superseded',
        expectedRecordRevision: claim.recordRevision,
        expectedSessionId: claim.sessionId,
        expectedTaskRevision: claim.taskRevision,
        supersededByTaskRevision: `message:${sha256Identity(replacement)}`,
        updatedAtMs: Date.now(),
      })
      if (superseded !== undefined) {
        this.claimChanged(superseded)
        await this.removeLiveMarker(superseded)
        await this.releaseOwnedHandle(superseded.sessionId)
      }
      return
    }

    if (!dispatchOwned && claim.expiresAtMs <= Date.now()) {
      const expired = await this.transition(claim, 'expired')
      if (expired !== undefined) {
        await this.removeLiveMarker(expired)
        await this.releaseOwnedHandle(expired.sessionId)
      }
      return
    }

    if (claim.state === 'dispatching' && claim.dispatchStartedAtMs === undefined
      && claim.expiresAtMs <= Date.now()) {
      const expired = await this.transition(claim, 'expired')
      if (expired !== undefined) await this.releaseOwnedHandle(expired.sessionId)
      return
    }

    if (claim.state === 'delivery-unknown') {
      this.clearLeaseRecovery(claim.continuationId)
      await this.releaseOwnedHandle(claim.sessionId)
      return
    }

    if (claim.state === 'dispatching' && claim.dispatchStartedAtMs !== undefined) {
      const leaseExpiresAtMs = claim.dispatchLeaseExpiresAtMs
      if (leaseExpiresAtMs === undefined) {
        await this.invalidate(claim, 'dispatch-lease-missing')
        return
      }
      if (leaseExpiresAtMs > Date.now()) {
        this.scheduleLeaseRecovery(claim)
        return
      }
      const unknown = await this.store.expireDispatch(claim.continuationId, Date.now())
      if (unknown !== undefined) this.claimChanged(unknown)
      await this.releaseOwnedHandle(claim.sessionId)
      return
    }

    if (claim.state === 'dispatched') {
      if (evidence !== 'inbox') {
        if (claim.dispatchStartedAtMs !== undefined
          && claim.dispatchStartedAtMs + this.retryInitialDelayMs > Date.now()) {
          this.scheduleRetry(claim.continuationId)
          return
        }
        await this.invalidate(claim, 'dispatched-inbox-evidence-missing')
        return
      }
      const agent = await this.resolveAgent(claim)
      if (agent === undefined || this.stopping) return
      if (this.settledDispatches.has(claim.continuationId)) {
        const settledEvidence = classifyDispatchEvidence(
          await this.readPersistedEvents(claim.sessionId),
          claim,
        )
        if (settledEvidence === 'message') {
          const observed = await this.store.observeDispatch(claim, 'claimed', Date.now())
          if (observed !== undefined) {
            this.claimChanged(observed)
            await this.releaseOwnedHandle(observed.sessionId)
          }
          return
        }
        if (claim.dispatchStartedAtMs !== undefined
          && claim.dispatchStartedAtMs + this.retryInitialDelayMs > Date.now()) {
          this.scheduleRetry(claim.continuationId)
          return
        }
        await this.invalidate(claim, 'agent-settled-before-continuation-message')
        await this.releaseOwnedHandle(claim.sessionId)
        return
      }
      this.watchSettlement(agent, claim.continuationId)
      return
    }

    if (claim.state === 'pending') {
      const registered = this.verifiers.get(claim.verifierId)
      if (registered === undefined) return
      const { verifier } = registered
      const signal = AbortSignal.any([this.stopSignal.signal, registered.cancellation.signal])
      let decision: TaskContinuationVerification | undefined
      try {
        decision = await verifierDecision(verifier.verify(claim, signal), signal)
      } catch (error: unknown) {
        if (!this.stopping) this.config.logger?.warn(`extension-center continuation verifier "${verifier.id}" failed: ${renderThrown(error)}`)
        return
      }
      if (decision === undefined || this.stopping || this.verifiers.get(verifier.id) !== registered) return
      const normalized = readyDecision(decision, claim)
      if (normalized === 'not-ready') return
      const next = normalized === 'invalid'
        ? await this.invalidate(claim, 'verifier-echo-mismatch')
        : await this.transition(claim, 'ready')
      if (next === undefined || next.state === 'invalid') return
      claim = next
    }

    if (claim.state === 'ready') {
      const consumed = await this.transition(claim, 'consumed')
      if (consumed === undefined) return
      claim = consumed
    }
    if (claim.state !== 'consumed' && claim.state !== 'dispatching') return

    const agent = await this.resolveAgent(claim)
    if (agent === undefined || this.stopping) {
      if (!this.stopping) this.scheduleRetry(claim.continuationId)
      return
    }
    const currentEvents = agent.session.events
    if (!hasDirectUserMessage(currentEvents, claim.originalMessageId)) {
      await this.invalidate(claim, 'original-user-message-missing')
      return
    }
    const currentReplacement = laterDirectUserMessage(currentEvents, claim.originalMessageId)
    if (currentReplacement !== undefined) {
      const superseded = await this.store.transition({
        id: claim.continuationId,
        from: ['consumed'],
        to: 'superseded',
        expectedRecordRevision: claim.recordRevision,
        expectedSessionId: claim.sessionId,
        expectedTaskRevision: claim.taskRevision,
        supersededByTaskRevision: `message:${sha256Identity(currentReplacement)}`,
        updatedAtMs: Date.now(),
      })
      if (superseded !== undefined) {
        this.claimChanged(superseded)
        await this.removeLiveMarker(superseded)
        await this.releaseOwnedHandle(superseded.sessionId)
      }
      return
    }
    const queued = agent.inbox === undefined ? [] : [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .filter(message => messageId(message) === claim.dispatchMessageId)
    if (queued.length > 0 || classifyDispatchEvidence(currentEvents, claim) !== 'none') {
      await this.invalidate(claim, 'duplicate-dispatch-evidence-before-claim')
      return
    }

    const now = Date.now()
    const owned = await this.store.claimDispatch({
      id: claim.continuationId,
      ownerId: this.ownerId,
      nowMs: now,
      leaseExpiresAtMs: now + this.dispatchClaimLeaseMs,
      expectedSessionId: claim.sessionId,
      expectedTaskRevision: claim.taskRevision,
    })
    if (owned === undefined) {
      const current = await this.store.get(claim.continuationId)
      if (current?.state === 'dispatching') this.scheduleLeaseRecovery(current)
      await this.releaseOwnedHandle(claim.sessionId)
      return
    }
    this.claimChanged(owned)
    const dispatching = await this.store.beginDispatch({
      id: owned.continuationId,
      ownerId: this.ownerId,
      fence: owned.dispatchFence,
      expectedRecordRevision: owned.recordRevision,
      updatedAtMs: Date.now(),
    })
    if (dispatching === undefined) {
      const current = await this.store.get(claim.continuationId)
      if (current?.state === 'dispatching') this.scheduleLeaseRecovery(current)
      await this.releaseOwnedHandle(claim.sessionId)
      return
    }
    this.claimChanged(dispatching)
    try {
      agent.followup(continuationMessage(claim))
    } catch (error: unknown) {
      const unknown = await this.failDispatch(dispatching, 'followup-error')
      this.config.logger?.warn(
        `extension-center continuation "${claim.continuationId}" follow-up was not confirmed: ${renderThrown(error)}`,
      )
      if (unknown !== undefined) this.watchSettlement(agent, claim.continuationId)
      return
    }
    try {
      if (!await this.config.sessions.flush(agent.session)) {
        throw new Error(`session "${claim.sessionId}" has no persistence participant`)
      }
    } catch (error: unknown) {
      const unknown = await this.failDispatch(dispatching, 'session-flush-error')
      this.config.logger?.warn(
        `extension-center continuation "${claim.continuationId}" Session flush was not confirmed: ${renderThrown(error)}`,
      )
      if (unknown !== undefined) this.watchSettlement(agent, claim.continuationId)
      return
    }
    const delivered = classifyDispatchEvidence(agent.session.events, claim)
    const target = delivered === 'message' ? 'claimed'
      : delivered === 'inbox' ? 'dispatched'
        : undefined
    if (target === undefined) {
      await this.failDispatch(dispatching, 'followup-error')
      return
    }
    const finished = await this.store.finishDispatch({
      id: dispatching.continuationId,
      ownerId: this.ownerId,
      fence: dispatching.dispatchFence,
      expectedRecordRevision: dispatching.recordRevision,
      updatedAtMs: Date.now(),
      to: target,
    })
    if (finished === undefined) return
    this.claimChanged(finished)
    if (finished.state === 'claimed') await this.releaseOwnedHandle(claim.sessionId)
    else this.watchSettlement(agent, claim.continuationId)
  }

  private async resolveAgent(claim: TaskContinuationClaim): Promise<ContinuationAgent | undefined> {
    const live = this.config.agents.get(claim.sessionId)
    if (live !== undefined) return live
    const owned = this.ownedHandles.get(claim.sessionId)
    if (owned !== undefined) return owned.agent
    if (this.config.sessions.get(claim.sessionId) !== undefined || this.stopping) return undefined
    try {
      const persisted = await this.config.sessionPersistence.load(claim.sessionId)
      const presetId = persistedPresetId(persisted)
      const agentPresets = this.config.agentPresets
      if (agentPresets === undefined) {
        throw new Error('the official Agent Presets service is unavailable')
      }
      const handle = await this.config.agents.resume({
        resumeSessionId: claim.sessionId,
        agentOptions: claim.resumeAgentOptions,
        setup: async (agentContext: unknown) => {
          const mounted = await agentPresets.mount(agentContext, presetId)
          if (mounted.id !== presetId) {
            throw new Error(`Agent Presets mounted "${mounted.id}" instead of persisted preset "${presetId}"`)
          }
          await this.config.resumeSetup?.(agentContext, claim)
        },
        signal: this.stopSignal.signal,
      })
      if (this.stopping) {
        await handle.dispose()
        return undefined
      }
      if (handle.agent.id !== claim.sessionId || handle.agent.session.id !== claim.sessionId) {
        await handle.dispose()
        throw new Error(`cold resume returned the wrong session for "${claim.sessionId}"`)
      }
      this.ownedHandles.set(claim.sessionId, handle)
      return handle.agent
    } catch (error: unknown) {
      if (!this.stopping) this.config.logger?.warn(`extension-center could not cold-resume session "${claim.sessionId}": ${renderThrown(error)}`)
      return undefined
    }
  }

  private async readEvents(sessionId: string): Promise<readonly ContinuationSessionEvent[]> {
    const live = this.config.agents.get(sessionId)
    if (live !== undefined) return live.session.events
    const owned = this.ownedHandles.get(sessionId)
    if (owned !== undefined) return owned.agent.session.events
    try {
      return (await this.config.sessionPersistence.load(sessionId)).events
    } catch {
      return []
    }
  }

  private async readPersistedEvents(sessionId: string): Promise<readonly ContinuationSessionEvent[]> {
    try {
      return (await this.config.sessionPersistence.load(sessionId)).events
    } catch {
      return []
    }
  }

  private async readDispatchedEvents(sessionId: string): Promise<readonly ContinuationSessionEvent[]> {
    const agent = this.config.agents.get(sessionId) ?? this.ownedHandles.get(sessionId)?.agent
    if (agent === undefined) return this.readPersistedEvents(sessionId)
    if (!await this.config.sessions.flush(agent.session)) {
      throw new Error(`session "${sessionId}" has no persistence participant`)
    }
    return agent.session.events
  }

  private async failDispatch(
    claim: TaskContinuationClaim,
    reason: 'followup-error' | 'session-flush-error',
  ): Promise<TaskContinuationClaim | undefined> {
    const failed = await this.store.failDispatch({
      id: claim.continuationId,
      ownerId: this.ownerId,
      fence: claim.dispatchFence,
      expectedRecordRevision: claim.recordRevision,
      updatedAtMs: Date.now(),
      reason,
    })
    if (failed !== undefined) this.claimChanged(failed)
    return failed
  }

  private watchSettlement(agent: ContinuationAgent, continuationId: string): void {
    if (this.settling.has(agent.id)) return
    this.settling.add(agent.id)
    void agent.whenIdle().then(
      async () => {
        try {
          if (!await this.config.sessions.flush(agent.session) && !this.stopping) {
            this.config.logger?.warn(`extension-center continuation Session "${agent.id}" has no persistence participant`)
          }
        } catch (error: unknown) {
          if (!this.stopping) {
            this.config.logger?.warn(
              `extension-center continuation Session "${agent.id}" settlement flush failed: ${renderThrown(error)}`,
            )
          }
        } finally {
          this.settling.delete(agent.id)
          this.settledDispatches.add(continuationId)
          this.schedule()
        }
      },
      () => {
        this.settling.delete(agent.id)
        this.scheduleRetry(continuationId)
      },
    )
  }

  private async transition(
    claim: TaskContinuationClaim,
    to: Exclude<TaskContinuationState, 'pending' | 'invalid'>,
  ): Promise<TaskContinuationClaim | undefined> {
    const changed = await this.store.transition({
      id: claim.continuationId,
      from: [claim.state],
      to,
      expectedRecordRevision: claim.recordRevision,
      expectedSessionId: claim.sessionId,
      expectedTaskRevision: claim.taskRevision,
      updatedAtMs: Date.now(),
    })
    if (changed !== undefined) this.claimChanged(changed)
    return changed
  }

  private async invalidate(
    claim: TaskContinuationClaim,
    reason: TaskContinuationInvalidReason,
  ): Promise<TaskContinuationClaim | undefined> {
    const changed = await this.store.transition({
      id: claim.continuationId,
      from: [claim.state],
      to: 'invalid',
      expectedRecordRevision: claim.recordRevision,
      expectedSessionId: claim.sessionId,
      expectedTaskRevision: claim.taskRevision,
      invalidReason: reason,
      updatedAtMs: Date.now(),
    })
    if (changed !== undefined) {
      this.claimChanged(changed)
      this.logInvalid(changed, reason)
    }
    return changed
  }

  private logInvalid(claim: TaskContinuationClaim, reason: TaskContinuationInvalidReason): void {
    this.config.logger?.warn(`extension-center continuation "${claim.continuationId}" invalid: ${reason}`)
  }

  private async removeLiveMarker(claim: TaskContinuationClaim): Promise<void> {
    const agent = this.config.agents.get(claim.sessionId) ?? this.ownedHandles.get(claim.sessionId)?.agent
    if (agent?.inbox?.remove(claim.dispatchMessageId) !== true) return
    await this.config.sessions.flush(agent.session)
  }

  private async releaseOwnedHandle(sessionId: string): Promise<void> {
    const handle = this.ownedHandles.get(sessionId)
    if (handle === undefined || this.retiringHandles.has(sessionId)) return
    const retirement = handle.agent.whenIdle().then(async () => {
      if (this.ownedHandles.get(sessionId) !== handle) return
      this.ownedHandles.delete(sessionId)
      await handle.dispose()
    }).finally(() => {
      if (this.retiringHandles.get(sessionId) === retirement) this.retiringHandles.delete(sessionId)
    })
    this.retiringHandles.set(sessionId, retirement)
    void retirement.catch(error => {
      if (!this.stopping) this.config.logger?.warn(`extension-center could not retire session "${sessionId}": ${renderThrown(error)}`)
    })
  }

  private assertExactLiveAgent(agent: ContinuationAgent, sessionId: string): void {
    if (agent.id !== sessionId || agent.session.id !== sessionId
      || this.config.agents.get(sessionId) !== agent || this.config.sessions.get(sessionId) !== agent.session) {
      throw new Error(`task continuation requires exact live session "${sessionId}"`)
    }
  }

  private assertOriginalTask(events: readonly ContinuationSessionEvent[], request: CreateTaskContinuationRequest): void {
    if (!hasDirectUserMessage(events, request.originalMessageId)) {
      throw new Error(`original direct-user message "${request.originalMessageId}" is not in session "${request.sessionId}"`)
    }
  }

  private assertFuture(expiresAtMs: number, now = Date.now()): void {
    if (expiresAtMs <= now) throw new TaskContinuationInputError('task continuation expiry must be in the future')
  }

  private async activateStore(): Promise<void> {
    await this.store.initialize()
    this.storeActivated = true
  }

  private async activateExistingStore(): Promise<boolean> {
    if (this.storeActivated) return true
    this.storeActivated = await this.store.initializeIfPresent()
    return this.storeActivated
  }

  private schedule(): void {
    if (this.stopping || !this.storeActivated) return
    queueMicrotask(() => { void this.reconcile().catch(error => {
      this.config.logger?.warn(`extension-center continuation scan failed: ${renderThrown(error)}`)
    }) })
  }

  private scheduleRetry(continuationId: string): void {
    if (this.stopping || this.retryTimers.has(continuationId)) return
    const delay = this.retryDelays.get(continuationId) ?? this.retryInitialDelayMs
    this.retryDelays.set(continuationId, Math.min(delay * 2, this.retryMaxDelayMs))
    const timer = setTimeout(() => {
      this.retryTimers.delete(continuationId)
      this.schedule()
    }, delay)
    timer.unref()
    this.retryTimers.set(continuationId, timer)
  }

  private scheduleLeaseRecovery(claim: TaskContinuationClaim): void {
    const leaseExpiresAtMs = claim.dispatchLeaseExpiresAtMs
    if (this.stopping || claim.state !== 'dispatching' || leaseExpiresAtMs === undefined) return
    this.clearLeaseRecovery(claim.continuationId)
    const delay = Math.min(MAX_BUSY_TIMEOUT_MS, Math.max(1, leaseExpiresAtMs - Date.now() + 1))
    const timer = setTimeout(() => {
      this.leaseTimers.delete(claim.continuationId)
      this.schedule()
    }, delay)
    timer.unref()
    this.leaseTimers.set(claim.continuationId, timer)
  }

  private clearLeaseRecovery(continuationId: string): void {
    const timer = this.leaseTimers.get(continuationId)
    if (timer !== undefined) clearTimeout(timer)
    this.leaseTimers.delete(continuationId)
  }

  private clearRetry(continuationId: string): void {
    const timer = this.retryTimers.get(continuationId)
    if (timer !== undefined) clearTimeout(timer)
    this.retryTimers.delete(continuationId)
    this.retryDelays.delete(continuationId)
  }

  private wakeRetries(): void {
    if (this.stopping) return
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    this.schedule()
  }

  private claimChanged(claim: TaskContinuationClaim): void {
    if (claim.state !== 'consumed') this.clearRetry(claim.continuationId)
    if (claim.state !== 'dispatching') this.clearLeaseRecovery(claim.continuationId)
    if (claim.state !== 'dispatched') this.settledDispatches.delete(claim.continuationId)
    this.notifySubscribers()
  }

  private notifySubscribers(): void {
    for (const listener of this.subscribers) queueMicrotask(() => { this.notifySubscriber(listener) })
  }

  private notifySubscriber(listener: () => void): void {
    if (this.stopping || !this.subscribers.has(listener)) return
    try {
      listener()
    } catch (error: unknown) {
      this.config.logger?.warn(`extension-center continuation subscriber failed: ${renderThrown(error)}`)
    }
  }

  private assertActive(): void {
    if (this.stopping) throw new Error('task continuation owner is disposed')
  }
}

/** Construct and initialize the plugin-owned durable owner. */
export async function createInternalTaskContinuations(
  config: InternalTaskContinuationConfig,
): Promise<InternalTaskContinuationOwner> {
  const owner = new InternalTaskContinuationOwner(config)
  await owner.initialize()
  return owner
}

function persistedPresetId(value: Readonly<{
  readonly meta: Readonly<{ readonly agentPreset?: string }>
  readonly events: readonly ContinuationSessionEvent[]
}>): string {
  let presetId = exactPresetId(value.meta.agentPreset, 'session header')
  for (const event of value.events) {
    if (event.type !== 'agent-preset/selected') continue
    if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) {
      throw new Error('persisted agent-preset/selected event has invalid data')
    }
    presetId = exactPresetId((event.data as Record<string, unknown>)['agentPreset'], 'agent-preset/selected event')
  }
  if (presetId === undefined) {
    throw new Error('persisted session does not identify its exact Agent preset')
  }
  return presetId
}

function exactPresetId(value: unknown, subject: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 128 || !/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    throw new Error(`${subject} has an invalid Agent preset id`)
  }
  return value
}

function hasDirectUserMessage(events: readonly ContinuationSessionEvent[], messageId: string): boolean {
  return events.some(event => isUserMessageEvent(event, messageId) && sourceKind(event.data) === 'user')
}

function laterDirectUserMessage(
  events: readonly ContinuationSessionEvent[],
  originalMessageId: string,
): string | undefined {
  const original = events.findIndex(event => isUserMessageEvent(event, originalMessageId) && sourceKind(event.data) === 'user')
  if (original < 0) return undefined
  for (let index = original + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event !== undefined && event.type === 'user/message' && sourceKind(event.data) === 'user') {
      const id = messageId(event.data)
      if (id !== undefined) return id
    }
  }
  return undefined
}

function isUserMessageEvent(event: ContinuationSessionEvent | undefined, id: string): boolean {
  return event?.type === 'user/message' && messageId(event.data) === id
}

function messageId(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
    ? value.id
    : undefined
}

function durableInboxInsertions(
  events: readonly ContinuationSessionEvent[],
  dispatchMessageId: string,
): readonly unknown[] {
  const output: unknown[] = []
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced'
      || typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) continue
    const inserted = (event.data as Record<string, unknown>)['inserted']
    if (!Array.isArray(inserted)) continue
    for (const message of inserted) {
      if (messageId(message) === dispatchMessageId) output.push(message)
    }
  }
  return output
}

function classifyDispatchEvidence(
  events: readonly ContinuationSessionEvent[],
  claim: TaskContinuationClaim,
): 'none' | 'inbox' | 'message' | 'invalid' {
  const messages = events.filter(event => isUserMessageEvent(event, claim.dispatchMessageId))
  if (messages.length > 0) {
    return messages.length === 1 && isContinuationMessage(messages[0]?.data, claim) ? 'message' : 'invalid'
  }
  const insertions = durableInboxInsertions(events, claim.dispatchMessageId)
  if (insertions.length === 0) return 'none'
  return insertions.length === 1 && isContinuationMessage(insertions[0], claim) ? 'inbox' : 'invalid'
}

function sourceKind(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('source' in value)
    || typeof value.source !== 'object' || value.source === null || !('kind' in value.source)) return undefined
  return typeof value.source.kind === 'string' ? value.source.kind : undefined
}

function sha256Identity(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function verifierDecision(
  verification: Promise<TaskContinuationVerification>,
  signal: AbortSignal,
): Promise<TaskContinuationVerification | undefined> {
  if (signal.aborted) return undefined
  let resolveAbort: (value: undefined) => void = () => {}
  const aborted = new Promise<undefined>(resolve => { resolveAbort = resolve })
  const onAbort = (): void => { resolveAbort(undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([verification, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { ContinuationMessage }
