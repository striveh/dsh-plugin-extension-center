/** Plugin-owned durable continuation values and official DSH runtime ports. */

/** Restricted Agent route retained for an exact cold resume. */
export interface ContinuationAgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
}

/**
 * Durable lifecycle of one single-use continuation claim.
 *
 * `consumed` means verification authority was used but no Agent call began.
 * `dispatching` owns a fenced lease; `dispatchStartedAtMs` distinguishes a
 * safely reclaimable pre-call lease from an at-most-once call attempt.
 * `dispatched` requires a successful Session flush, while `claimed` requires
 * the exact model-visible user message. `delivery-unknown` never retries and
 * can advance only when the exact durable Session evidence appears later.
 */
export type TaskContinuationState =
  | 'pending'
  | 'ready'
  | 'consumed'
  | 'dispatching'
  | 'dispatched'
  | 'claimed'
  | 'delivery-unknown'
  | 'canceled'
  | 'superseded'
  | 'expired'
  | 'invalid'

/** Secret-free reason why one at-most-once dispatch could not be confirmed. */
export type TaskContinuationDeliveryUnknownReason =
  | 'followup-error'
  | 'session-flush-error'
  | 'owner-lease-expired'
  | 'legacy-consumed'

/** Fixed, secret-free diagnoses for an invalid terminal claim. */
export const TASK_CONTINUATION_INVALID_REASONS = [
  'agent-settled-before-continuation-message',
  'dispatch-evidence-before-owned-call',
  'dispatch-evidence-content-mismatch',
  'dispatch-lease-missing',
  'dispatched-inbox-evidence-missing',
  'duplicate-dispatch-evidence-before-claim',
  'newer-direct-user-message-after-dispatch',
  'original-user-message-missing',
  'verifier-echo-mismatch',
] as const

/** One allowlisted invalid-claim diagnosis retained across restart. */
export type TaskContinuationInvalidReason = typeof TASK_CONTINUATION_INVALID_REASONS[number]

/** Complete immutable projection returned through the Center owner interface. */
export interface TaskContinuationClaim {
  readonly kind: 'task-continuation'
  readonly version: 3
  readonly continuationId: string
  readonly callerId: string
  readonly mutationId: string
  readonly recordRevision: number
  readonly state: TaskContinuationState
  readonly dispatchMessageId: string
  /** Monotonic token invalidating every prior dispatch owner. */
  readonly dispatchFence: number
  /** Current or last dispatch owner; absent before dispatch ownership. */
  readonly dispatchOwnerId?: string
  /** Pre-call claim deadline and post-call uncertainty deadline. */
  readonly dispatchLeaseExpiresAtMs?: number
  /** Irreversible durable marker written immediately before `Agent.followup()`. */
  readonly dispatchStartedAtMs?: number
  /** At-most-once terminal diagnosis that contains no thrown error text. */
  readonly deliveryUnknownReason?: TaskContinuationDeliveryUnknownReason
  /** Exact allowlisted diagnosis, present only for the invalid terminal state. */
  readonly invalidReason?: TaskContinuationInvalidReason
  readonly resumeAgentOptions: Readonly<ContinuationAgentOptions>
  readonly sessionId: string
  readonly originalMessageId: string
  readonly needDigest: string
  readonly taskRevision: string
  readonly verifierId: string
  readonly verificationPayloadDigest: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly expiresAtMs: number
  readonly supersededByTaskRevision?: string
}

/** Fields whose acceptance reserves one caller-scoped continuation. */
export interface CreateTaskContinuationRequest {
  readonly callerId: string
  readonly mutationId: string
  readonly sessionId: string
  readonly originalMessageId: string
  readonly needDigest: string
  readonly taskRevision: string
  readonly verifierId: string
  readonly verificationPayloadDigest: string
  readonly expiresAtMs: number
}

/** Cold-safe reservation input containing the exact model route. */
export interface ReserveTaskContinuationRequest extends CreateTaskContinuationRequest {
  readonly resumeAgentOptions: Readonly<ContinuationAgentOptions>
}

/** Exact claim fence accepted by cancel. */
export interface TaskContinuationRef {
  readonly id: string
  readonly sessionId: string
  readonly taskRevision: string
}

/** Exact claim fence accepted by supersede. */
export interface SupersedeTaskContinuationRequest extends TaskContinuationRef {
  readonly replacementTaskRevision: string
}

/** Optional exact filters for durable reconciliation. */
export interface ListTaskContinuationsRequest {
  readonly sessionId?: string
  readonly callerId?: string
  readonly mutationId?: string
}

/** Decision that keeps a claim parked. */
export interface TaskContinuationNotReady {
  readonly kind: 'not-ready'
}

/** Positive decision echoing every authority-bearing claim field. */
export interface TaskContinuationReady {
  readonly kind: 'ready'
  readonly continuationId: string
  readonly sessionId: string
  readonly originalMessageId: string
  readonly needDigest: string
  readonly taskRevision: string
  readonly verificationPayloadDigest: string
}

/** Result returned by an extension-owned verifier. */
export type TaskContinuationVerification = TaskContinuationNotReady | TaskContinuationReady

/** Same-process evidence verifier registered by the Center acquisition service. */
export interface TaskContinuationVerifier {
  readonly id: string
  verify(claim: TaskContinuationClaim, signal: AbortSignal): Promise<TaskContinuationVerification>
}

/** Standard DSH plugin-sourced user message used by `Agent.followup()`. */
export interface ContinuationMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
  readonly source: Readonly<{ kind: 'plugin'; plugin: 'dsh-plugin-extension-center' }>
}

/** Minimal official Session event projection needed for reconciliation. */
export interface ContinuationSessionEvent {
  readonly type: string
  readonly time?: number
  readonly data: unknown
}

/** Persisted Session metadata needed to reconstruct its exact Agent preset. */
export interface ContinuationSessionHeader {
  readonly agentPreset?: string
}

/** Minimal official live or persisted Session projection. */
export interface ContinuationSession {
  readonly id: string
  readonly events: readonly ContinuationSessionEvent[]
}

/** Optional official Agent inbox surface used to recover a crash before dispatch. */
export interface ContinuationInbox {
  readonly nextTurn: readonly unknown[]
  readonly nextStep: readonly unknown[]
  remove(id: string): boolean
}

/** Minimal official DSH Agent surface used by the internal owner. */
export interface ContinuationAgent {
  readonly id: string
  readonly options: Readonly<ContinuationAgentOptions>
  readonly session: ContinuationSession
  readonly inbox?: ContinuationInbox
  followup(message: ContinuationMessage): void
  whenIdle(): Promise<void>
}

/** Owned handle returned by the official Agent registry's cold-resume API. */
export interface ContinuationAgentHandle {
  readonly agent: ContinuationAgent
  dispose(): Promise<void>
}

/** Composition callback accepted by official `agents.resume()`. */
export type ContinuationAgentSetup = (agentContext: unknown) => unknown | Promise<unknown>

/** Optional provider that rebuilds claim-specific scoped composition on cold resume. */
export type ContinuationResumeSetup = (
  agentContext: unknown,
  claim: TaskContinuationClaim,
) => unknown | Promise<unknown>

/** Minimal official DSH Agent registry surface. */
export interface ContinuationAgents {
  get(sessionId: string): ContinuationAgent | undefined
  resume(options: Readonly<{
    resumeSessionId: string
    agentOptions: Readonly<ContinuationAgentOptions>
    setup?: ContinuationAgentSetup
    signal?: AbortSignal
  }>): Promise<ContinuationAgentHandle>
  withoutInitiator?<Value>(operation: () => Value): Value
}

/** Minimal official DSH Session registry surface. */
export interface ContinuationSessions {
  get(sessionId: string): ContinuationSession | undefined
  flush(session: ContinuationSession): Promise<boolean>
}

/** Minimal official DSH session-persistence read surface. */
export interface ContinuationSessionPersistence {
  load(sessionId: string): Promise<Readonly<{
    readonly meta: ContinuationSessionHeader
    readonly events: readonly ContinuationSessionEvent[]
  }>>
}

/** Minimal official DSH Agent Presets surface used during replay setup. */
export interface ContinuationAgentPresets {
  mount(agentContext: unknown, presetId: string): Promise<Readonly<{ readonly id: string }>>
}

/** Adapter from official Host lifecycle events to a non-authorizing reconciliation signal. */
export type ContinuationLifecycleObserver = (requestReconciliation: () => void) => () => void

/** Diagnostics sink; failures never gain mutation authority. */
export interface ContinuationLogger {
  warn(message: string): void
}

/** Explicit runtime dependencies and durable storage location. */
export interface InternalTaskContinuationConfig {
  readonly root: string
  readonly agents: ContinuationAgents
  readonly sessions: ContinuationSessions
  readonly sessionPersistence: ContinuationSessionPersistence
  readonly agentPresets?: ContinuationAgentPresets
  readonly observeLifecycle?: ContinuationLifecycleObserver
  readonly resumeSetup?: ContinuationResumeSetup
  readonly busyTimeoutMs?: number
  /** Short pre-call ownership lease; it becomes an uncertainty deadline after dispatch starts. */
  readonly dispatchClaimLeaseMs?: number
  readonly retryInitialDelayMs?: number
  readonly retryMaxDelayMs?: number
  readonly logger?: ContinuationLogger
}

/** Public owner plus lifecycle hooks used by the composing Center plugin. */
export interface InternalTaskContinuationsOwner {
  readonly protocolVersion: 1
  create(agent: unknown, request: unknown): Promise<unknown>
  reserve(request: unknown): Promise<unknown>
  get(id: string): Promise<unknown>
  list(request?: unknown): Promise<readonly unknown[]>
  cancel(ref: unknown): Promise<boolean>
  supersede(request: unknown): Promise<boolean>
  registerVerifier(verifier: Readonly<{
    id: string
    verify(claim: unknown, signal: AbortSignal): Promise<unknown>
  }>): () => void
  subscribe(listener: () => void): () => void
  reconcile(signal?: AbortSignal): Promise<void>
  dispose(): Promise<void>
}
