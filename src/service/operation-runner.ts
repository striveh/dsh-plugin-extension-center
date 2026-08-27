import { randomUUID } from 'node:crypto'
import { readSha256Digest } from '../domain/codec.ts'
import { canonicalSha256 } from '../domain/json.ts'
import type { CenterStateStore, StoredOperationIndex } from '../host/index.ts'
import { ArtifactFetcher, FileTargetLock } from '../host/index.ts'
import {
  createOperationJournal,
  issueOperationReceipt,
  operationJournalCheckpoint,
  recordOperationMutation,
  recordOperationVerification,
  transitionOperation,
  verifyOperationJournal,
  type OperationJournal,
  type OperationOutcome,
  type OperationProjection,
  type OperationReceipt,
} from '../operations/index.ts'
import {
  isCurrentPnpmExecutionIdentity,
  type ConsumedPlanState,
  type ImmutablePlan,
  type OperationAuthorization,
  type PlanAuthorizationState,
} from '../plans/index.ts'
import { admittedAuthorityDigest, verificationRecipeDigest } from '../policy/index.ts'
import {
  isOfficialProfileAmbiguityError,
  OFFICIAL_PROFILE_AMBIGUITY_CODE,
} from '../internal/plugin/types.ts'
import type {
  AppliedProviderOperation,
  LifecycleProvider,
  PluginLifecycleProvider,
  PreparedProviderOperation,
  ProviderOperationRequest,
} from '../providers/index.ts'
import { managedStateDigest } from '../providers/records.ts'
import {
  FileOperationStore,
  FilePlanStore,
  type LoadedOperation,
  type OperationReservation,
  type StoredReceipt,
} from '../storage/index.ts'
import type { LifecycleResponse, OperationSummary } from './rpc-contract.ts'
import { HOST_RPC_PROTOCOL_VERSION } from './rpc-contract.ts'
import type { IntentPlanService } from './intent-plan-service.ts'
import { centerManagementAuthorityDigest, isCenterManagementOperation } from './management-admission.ts'

/** Registry of exactly one provider for each extension kind. */
export type LifecycleProviders = Readonly<Record<'plugin' | 'mcp' | 'skill', LifecycleProvider>>

function terminal(phase: OperationProjection['phase']): phase is OperationOutcome {
  return ['committed', 'rolled-back', 'failed'].includes(phase)
}

function reason(_error: unknown): string {
  return 'provider-failure'
}

const RETIRED_RUNTIME_QUARANTINE = 'retired-runtime-quarantined' as const

function currentRecoveryRuntime(authorization: OperationAuthorization): boolean {
  return isCurrentPnpmExecutionIdentity(authorization.recoveryExecutable.officialDsh.pnpm)
}

function planForReservation(
  reservation: OperationReservation,
  states: readonly PlanAuthorizationState[],
): ConsumedPlanState {
  const state = states.find(candidate => candidate.plan.hash === reservation.planHash)
  if (state?.status !== 'consumed'
    || state.authorization.operationId !== reservation.operationId
    || state.authorization.planHash !== reservation.planHash
    || state.authorization.targetKey !== reservation.targetKey
    || state.plan.content.targetKey !== reservation.targetKey) {
    throw new Error(`operation reservation has no exact consumed plan: ${reservation.operationId}`)
  }
  return state
}

function authorizationJournalBinding(authorization: OperationAuthorization): Readonly<Record<string, unknown>> {
  return Object.freeze({
    operationId: authorization.operationId,
    targetKey: authorization.targetKey,
    planId: authorization.planId,
    planHash: authorization.planHash,
    operationKind: authorization.operationKind,
    managedObject: authorization.managedObject,
    externalRuntimeAction: authorization.externalRuntimeAction,
    runtimeBinding: authorization.runtimeBinding,
    planEvidence: {
      origin: authorization.origin,
      candidateRef: authorization.candidateRef,
      extensionKind: authorization.extensionKind,
      extensionId: authorization.extensionId,
      artifactRevision: authorization.artifactRevision,
      artifactIntegrity: authorization.artifactIntegrity,
      artifactUrl: authorization.artifactUrl,
      artifactSizeBytes: authorization.artifactSizeBytes,
      desiredState: authorization.desiredState,
      ownerKey: authorization.ownerKey,
      scopeKey: authorization.scopeKey,
      profileId: authorization.profileId,
      idempotencyKey: authorization.idempotencyKey,
      authorityDigest: authorization.authorityDigest,
      configurationDigest: authorization.configurationDigest,
      retentionDigest: authorization.retentionDigest,
      mutationDigest: authorization.mutationDigest,
      verificationDigest: authorization.verificationDigest,
      reviewEvidence: authorization.reviewEvidence,
      restartRequired: authorization.restartRequired,
      fences: authorization.fences,
      recoveryExecutable: authorization.recoveryExecutable,
    },
  })
}

function projectionJournalBinding(projection: OperationProjection): Readonly<Record<string, unknown>> {
  return Object.freeze({
    operationId: projection.operationId,
    targetKey: projection.targetKey,
    planId: projection.planId,
    planHash: projection.planHash,
    operationKind: projection.operationKind,
    managedObject: projection.managedObject,
    externalRuntimeAction: projection.externalRuntimeAction,
    runtimeBinding: projection.runtimeBinding,
    planEvidence: projection.planEvidence,
  })
}

/** Durable single-use plan consumer and append-only lifecycle runner. */
export class OperationRunner {
  private readonly explicitRecoveryFlights = new Set<string>()

  constructor(
    private readonly state: CenterStateStore,
    private readonly plans: FilePlanStore,
    private readonly operations: FileOperationStore,
    private readonly locks: FileTargetLock,
    private readonly fetcher: ArtifactFetcher,
    private readonly intentPlans: IntentPlanService,
    private readonly providers: LifecycleProviders,
  ) {}

  /** Consume one approved plan once, then perform its provider operation. */
  async run(planHashValue: unknown, signal: AbortSignal): Promise<LifecycleResponse> {
    signal.throwIfAborted()
    const planHash = readSha256Digest(planHashValue, 'lifecycle.planHash')
    const state = await this.plans.load(planHash)
    if (state?.status !== 'approved') throw new Error('lifecycle plan is absent or not approved')
    const plan = state.plan
    if (plan.content.origin === 'task') {
      const intent = await this.state.getIntent(plan.content.intentId)
      const reservationId = intent?.payload.continuationId
      if (intent === undefined || intent.planHash !== plan.hash || reservationId == null) {
        throw new Error('approved task plan has no exact continuation reservation')
      }
      const activation = await this.state.getContinuationActivation(reservationId)
      if (activation === undefined
        || activation.planHash !== plan.hash
        || activation.resolutionId !== intent.payload.resolutionId
        || activation.verificationPayloadDigest !== intent.payload.verificationPayloadDigest) {
        throw new Error('approved task plan has no exact activated continuation claim')
      }
    }
    const operationId = `operation:${randomUUID()}`
    await this.locks.acquire(plan.content.targetKey, operationId)
    let authorization: OperationAuthorization
    let reservation!: OperationReservation
    try {
      reservation = {
        schemaVersion: 1,
        operationId,
        planHash,
        targetKey: plan.content.targetKey,
        beforeDigest: managedStateDigest(await this.state.getManaged(plan.content.targetKey) ?? null),
        reservedAtMs: Date.now(),
      }
      await this.operations.reserve(reservation)
      const consumed = await this.plans.consume(
        planHash,
        operationId,
        await this.intentPlans.context(plan),
        Date.now(),
      )
      authorization = consumed.authorization
    } catch (error: unknown) {
      let durable: PlanAuthorizationState | undefined
      try {
        durable = await this.plans.load(planHash)
      } catch {
        // An unreadable consumption result is ambiguous. The reservation and
        // lock remain the only safe startup-recovery authority.
        throw error
      }
      if (durable?.status === 'consumed') {
        if (durable.authorization.operationId !== operationId
          || durable.authorization.planHash !== planHash
          || durable.authorization.targetKey !== plan.content.targetKey) {
          throw error
        }
        authorization = durable.authorization
      } else {
        if (durable === undefined) throw error
        try {
          await this.operations.deleteReservation(operationId)
          await this.release(plan.content.targetKey, operationId)
        } catch {
          // A durable reservation or lock that could not be removed remains
          // the sole recovery authority; releasing only one would permit overlap.
        }
        throw error
      }
    }
    return await this.execute(plan, authorization, reservation, signal)
  }

  /** Read one verified operation. */
  async get(operationId: string): Promise<LoadedOperation | null> {
    return await this.operations.load(operationId) ?? null
  }

  /** List authoritative operation projections through the durable lookup index. */
  async list(): Promise<readonly OperationSummary[]> {
    const output: OperationSummary[] = []
    const loadedOperations = await this.operations.list()
    for (const loaded of loadedOperations) {
      const consumed = await this.planForProjection(loaded.projection)
      const retired = !currentRecoveryRuntime(consumed.authorization)
      const quarantined = retired && (!terminal(loaded.projection.phase)
        || loaded.projection.phase === 'rolled-back' && consumed.plan.content.extensionKind === 'plugin'
        || await this.retiredFailedPluginReferencesMutation(loaded, consumed))
      output.push({
        operationId: loaded.projection.operationId,
        targetKey: loaded.projection.targetKey,
        phase: loaded.projection.phase,
        operationKind: loaded.projection.operationKind,
        lastAtMs: loaded.projection.lastAtMs,
        recoveryCommand: !retired && loaded.projection.phase === 'recovery-required'
          && loaded.projection.planEvidence.extensionKind === 'plugin'
          ? Object.freeze([
              loaded.projection.planEvidence.recoveryExecutable.executablePath,
              this.operations.centerRoot(),
              loaded.projection.operationId,
            ])
          : null,
        recoveryNotice: quarantined
          ? RETIRED_RUNTIME_QUARANTINE
          : loaded.projection.phase === 'recovery-required'
          && loaded.projection.planEvidence.extensionKind === 'plugin'
          ? 'journal-reconciliation-pending'
          : null,
      })
    }
    const operationIds = new Set(loadedOperations.map(loaded => loaded.projection.operationId))
    const [reservations, plans, locks] = await Promise.all([
      this.operations.listReservations(),
      this.plans.list(),
      this.locks.list(),
    ])
    for (const reservation of reservations) {
      if (operationIds.has(reservation.operationId)) continue
      const state = plans.find(candidate => candidate.plan.hash === reservation.planHash)
      if (state?.status === 'approved') continue
      const consumed = planForReservation(reservation, plans)
      if (currentRecoveryRuntime(consumed.authorization)) continue
      this.assertExactRetiredTargetQuarantine(locks, reservation.targetKey, reservation.operationId)
      output.push({
        operationId: reservation.operationId,
        targetKey: reservation.targetKey,
        phase: 'authorized',
        operationKind: consumed.plan.content.operationKind,
        lastAtMs: reservation.reservedAtMs,
        recoveryCommand: null,
        recoveryNotice: RETIRED_RUNTIME_QUARANTINE,
      })
    }
    return Object.freeze(output.sort((left, right) => right.lastAtMs - left.lastAtMs
      || left.operationId.localeCompare(right.operationId)))
  }

  /** List content-addressed terminal receipts. */
  listReceipts(): Promise<readonly StoredReceipt[]> {
    return this.operations.listReceipts()
  }

  /** Identify retired Plugin obligations before owner startup can reconcile official Profile state. */
  async retiredPluginObligations(signal: AbortSignal): Promise<readonly Readonly<{
    operationId: string
    targetKey: string
    profileId: string
  }>[]> {
    const obligations: Array<Readonly<{ operationId: string; targetKey: string; profileId: string }>> = []
    const obligationIds = new Set<string>()
    await this.locks.resumeTakeovers()
    signal.throwIfAborted()
    const locks = await this.locks.list()
    const operations = await this.operations.list()
    for (const loaded of operations) {
      signal.throwIfAborted()
      const consumed = await this.planForProjection(loaded.projection)
      if (currentRecoveryRuntime(consumed.authorization)) continue
      const quarantined = !terminal(loaded.projection.phase)
        || loaded.projection.phase === 'rolled-back' && consumed.plan.content.extensionKind === 'plugin'
        || await this.retiredFailedPluginReferencesMutation(loaded, consumed)
      if (quarantined) this.assertExactRetiredTargetQuarantine(
        locks,
        loaded.projection.targetKey,
        loaded.projection.operationId,
      )
      if (consumed.plan.content.extensionKind !== 'plugin' || !quarantined) continue
      obligationIds.add(consumed.authorization.operationId)
      obligations.push(Object.freeze({
        operationId: consumed.authorization.operationId,
        targetKey: consumed.plan.content.targetKey,
        profileId: consumed.plan.content.profileId,
      }))
    }
    const plans = await this.plans.list()
    for (const reservation of await this.operations.listReservations()) {
      signal.throwIfAborted()
      const loaded = operations.find(candidate => candidate.projection.operationId === reservation.operationId)
      if (loaded !== undefined) {
        if (loaded.projection.planHash !== reservation.planHash
          || loaded.projection.targetKey !== reservation.targetKey
          || loaded.projection.beforeDigest !== reservation.beforeDigest) {
          throw new Error(`operation reservation does not bind its journal: ${reservation.operationId}`)
        }
        continue
      }
      const state = plans.find(candidate => candidate.plan.hash === reservation.planHash)
      if (state?.status === 'approved') continue
      const consumed = planForReservation(reservation, plans)
      if (currentRecoveryRuntime(consumed.authorization)) continue
      this.assertExactRetiredTargetQuarantine(locks, reservation.targetKey, reservation.operationId)
      if (consumed.plan.content.extensionKind !== 'plugin'
        || obligationIds.has(consumed.authorization.operationId)) continue
      obligationIds.add(consumed.authorization.operationId)
      obligations.push(Object.freeze({
        operationId: consumed.authorization.operationId,
        targetKey: consumed.plan.content.targetKey,
        profileId: consumed.plan.content.profileId,
      }))
    }
    return Object.freeze(obligations.sort((left, right) => left.targetKey.localeCompare(right.targetKey)
      || left.operationId.localeCompare(right.operationId)))
  }

  /** Retry an exact fenced rollback while retaining the target lock until owner state is reconciled. */
  async recoverOperation(operationId: string, signal: AbortSignal): Promise<LifecycleResponse> {
    if (this.explicitRecoveryFlights.has(operationId)) throw new Error('operation recovery is already in progress')
    this.explicitRecoveryFlights.add(operationId)
    try {
      signal.throwIfAborted()
      const loaded = await this.operations.load(operationId)
      signal.throwIfAborted()
      if (loaded === undefined || loaded.projection.phase !== 'recovery-required') {
        throw new Error('operation is not awaiting explicit recovery')
      }
      const initialState = await this.planForProjection(loaded.projection)
      signal.throwIfAborted()
      if (!currentRecoveryRuntime(initialState.authorization)) {
        throw new Error('retired recovery runtime is quarantined and cannot execute')
      }
      await this.claimExactRecoveryLease(loaded.projection.targetKey, operationId)
      signal.throwIfAborted()
      const current = await this.operations.load(operationId)
      if (current === undefined || current.projection.phase !== 'recovery-required'
        || current.projection.targetKey !== loaded.projection.targetKey) {
        throw new Error('operation changed while its recovery lease was claimed')
      }
      const state = await this.planForProjection(current.projection)
      signal.throwIfAborted()
      if (!currentRecoveryRuntime(state.authorization)) {
        throw new Error('operation recovery runtime changed while its lease was claimed')
      }
      const request = await this.providerRequest(state.plan, state.authorization, null, signal)
      signal.throwIfAborted()
      const provider = this.providers[request.plan.extensionKind]
      const applied = await provider.recover(request)
      signal.throwIfAborted()
      if (applied === null) throw new Error('provider recovery point is unavailable')
      const journal = await this.append(request, transitionOperation(current.journal, 'rolling-back', null, null, Date.now()))
      signal.throwIfAborted()
      await this.recoverRollback(request, journal, applied)
      signal.throwIfAborted()
      const recovered = await this.operations.load(operationId)
      if (recovered === undefined) throw new Error('recovered operation disappeared')
      return this.response(operationId, recovered.projection, recovered.projection.receipt)
    } finally {
      this.explicitRecoveryFlights.delete(operationId)
    }
  }

  /** Reconcile a managed Plugin only from this process's startup and Loader evidence. */
  private async settleManagedPluginRestart(
    request: ProviderOperationRequest,
    loaded: LoadedOperation,
    applied: AppliedProviderOperation,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    if (!['verifying', 'rolling-back'].includes(loaded.projection.phase)) {
      throw new Error('Plugin operation is not awaiting restart verification')
    }
    if (request.plan.extensionKind !== 'plugin') throw new Error('operation is not a managed Plugin mutation')
    if (loaded.projection.phase === 'rolling-back') this.assertRollbackRestartBinding(request, applied)
    else this.assertForwardRestartBinding(request, applied)
    const provider = this.providers.plugin as PluginLifecycleProvider
    if (applied.restartToken === null) throw new Error('Plugin operation has no exact restart token')
    let journal = loaded.journal
    const bootReady = await provider.bootReady({
      profileId: request.plan.profileId,
      restartToken: applied.restartToken,
    })
    signal.throwIfAborted()
    if (!bootReady) return
    let cleanupFailed = false
    try {
      await provider.acknowledgeBoot({
        operationId: request.authorization.operationId,
        targetKey: request.plan.targetKey,
        profileId: request.plan.profileId,
        restartToken: applied.restartToken,
      })
      signal.throwIfAborted()
      const verification = await provider.verify(applied)
      signal.throwIfAborted()
      if (verification === null) return
      journal = await this.append(request, recordOperationVerification(journal, verification.digest, Date.now()))
      signal.throwIfAborted()
      if (loaded.projection.phase === 'rolling-back') {
        try {
          await (provider as LifecycleProvider).cleanup(applied.prepared)
        } catch (error: unknown) {
          cleanupFailed = true
          throw error
        }
        signal.throwIfAborted()
        journal = await this.append(request, transitionOperation(journal, 'rolled-back', applied.prepared.beforeDigest, null, Date.now()))
        signal.throwIfAborted()
        await provider.verifyRollbackFinalization(applied)
        signal.throwIfAborted()
      } else {
        try {
          await (provider as LifecycleProvider).cleanup(applied.prepared)
        } catch (error: unknown) {
          cleanupFailed = true
          throw error
        }
        signal.throwIfAborted()
        journal = await this.append(request, transitionOperation(journal, 'committed', applied.afterDigest, null, Date.now()))
        signal.throwIfAborted()
      }
      await this.finishTerminal(
        request,
        journal,
        loaded.projection.phase === 'rolling-back' ? () => provider.finalizeRollback(applied) : undefined,
      )
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      if (terminal(verifyOperationJournal(journal).phase)) throw error
      if (loaded.projection.phase === 'rolling-back') {
        await this.append(request, transitionOperation(
          journal,
          'recovery-required',
          null,
          cleanupFailed ? 'cleanup-failed' : 'rollback-verification-failed',
          Date.now(),
        ))
        return
      }
      journal = await this.append(request, transitionOperation(
        journal,
        'rolling-back',
        null,
        cleanupFailed ? 'cleanup-failed' : null,
        Date.now(),
      ))
      try {
        await this.rollbackManagedPlugin(request, journal, applied, signal)
      } catch (rollbackError: unknown) {
        if (signal.aborted) throw signal.reason
        await this.toRecoveryRequired(request, journal, 'rollback-failed')
      }
    }
  }

  /** Reject provider restart evidence that does not match the consumed plan. */
  private assertForwardRestartBinding(
    request: ProviderOperationRequest,
    applied: AppliedProviderOperation,
  ): void {
    const expectedToken = request.plan.extensionKind === 'plugin' && request.plan.restartRequired
      ? `managed:${request.authorization.operationId}`
      : null
    if (applied.rollbackRestartRequired
      || applied.restartRequired !== request.plan.restartRequired
      || applied.restartToken !== expectedToken) {
      throw new Error('provider restart result does not bind the immutable plan')
    }
  }

  /** Reject Plugin rollback evidence that invents or omits the approved restart class. */
  private assertRollbackRestartBinding(
    request: ProviderOperationRequest,
    applied: AppliedProviderOperation,
  ): void {
    if (request.plan.extensionKind !== 'plugin') throw new Error('operation is not a managed Plugin mutation')
    const expectedToken = request.plan.restartRequired
      ? `managed-rollback:${request.authorization.operationId}`
      : null
    if (applied.restartRequired
      || applied.rollbackRestartRequired !== request.plan.restartRequired
      || applied.restartToken !== expectedToken) {
      throw new Error('Plugin rollback restart result does not bind the immutable plan')
    }
  }

  /** Finish a restored Plugin state either in this Host or after the required package restart. */
  private async settleManagedPluginRollback(
    request: ProviderOperationRequest,
    journal: OperationJournal,
    rollback: AppliedProviderOperation,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertRollbackRestartBinding(request, rollback)
    const provider = this.providers.plugin as PluginLifecycleProvider
    if (rollback.rollbackRestartRequired) {
      const current = await this.operations.load(request.authorization.operationId)
      if (current === undefined) throw new Error('managed Plugin rollback operation disappeared')
      await this.settleManagedPluginRestart(request, current, rollback, signal)
      return
    }
    const verification = await provider.verify(rollback)
    signal.throwIfAborted()
    if (verification === null) throw new Error('Plugin live rollback verification is unavailable')
    journal = await this.append(request, recordOperationVerification(journal, verification.digest, Date.now()))
    signal.throwIfAborted()
    await (provider as LifecycleProvider).cleanup(rollback.prepared)
    signal.throwIfAborted()
    journal = await this.append(request, transitionOperation(
      journal,
      'rolled-back',
      rollback.prepared.beforeDigest,
      null,
      Date.now(),
    ))
    signal.throwIfAborted()
    await provider.verifyRollbackFinalization(rollback)
    signal.throwIfAborted()
    await this.finishTerminal(request, journal, () => provider.finalizeRollback(rollback))
  }

  /** Restore one Plugin operation and then consume the exact rollback evidence it publishes. */
  private async rollbackManagedPlugin(
    request: ProviderOperationRequest,
    journal: OperationJournal,
    applied: AppliedProviderOperation,
    signal: AbortSignal,
  ): Promise<void> {
    const provider = this.providers.plugin as PluginLifecycleProvider
    const restored = await provider.rollback(applied)
    signal.throwIfAborted()
    if (restored !== applied.prepared.beforeDigest) {
      throw new Error('Plugin rollback did not restore the exact provider before-state')
    }
    const rollback = await provider.recover(request)
    signal.throwIfAborted()
    if (rollback === null) throw new Error('Plugin rollback evidence is unavailable')
    await this.settleManagedPluginRollback(request, journal, rollback, signal)
  }

  /** Repair interrupted journals without replaying a consumed plan or a committed mutation. */
  async recover(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.locks.resumeTakeovers()
    signal.throwIfAborted()
    const recoverable = new Set<string>()
    const heldByOperation = new Map<string, Awaited<ReturnType<FileTargetLock['list']>>[number]>()
    for (const held of await this.locks.list()) {
      signal.throwIfAborted()
      if (heldByOperation.has(held.operationId)) {
        throw new Error(`operation owns more than one target lock: ${held.operationId}`)
      }
      heldByOperation.set(held.operationId, held)
      const claim = await this.locks.claimRecovery(held)
      if (claim !== 'claimed' && claim !== 'owned') continue
      const [operations, reservations, plans] = await Promise.all([
        this.operations.list(),
        this.operations.listReservations(),
        this.plans.list(),
      ])
      signal.throwIfAborted()
      const journal = operations.find(loaded => loaded.projection.operationId === held.operationId)
      const reservation = reservations.find(candidate => candidate.operationId === held.operationId)
      const consumed = plans.find((state): state is Extract<PlanAuthorizationState, { status: 'consumed' }> => state.status === 'consumed'
        && state.authorization.operationId === held.operationId)
      if (journal !== undefined && journal.projection.targetKey !== held.targetKey
        || reservation !== undefined && reservation.targetKey !== held.targetKey
        || consumed !== undefined && (consumed.authorization.targetKey !== held.targetKey
          || consumed.plan.content.targetKey !== held.targetKey)) {
        throw new Error(`operation authority does not bind its target lock: ${held.operationId}`)
      }
      if (journal === undefined && reservation === undefined && consumed === undefined) {
        await this.locks.release(held.targetKey, held.operationId)
        continue
      }
      recoverable.add(held.operationId)
    }
    signal.throwIfAborted()
    await this.recoverReservations(signal, recoverable)
    signal.throwIfAborted()
    for (const loaded of await this.operations.list()) {
      signal.throwIfAborted()
      const held = heldByOperation.get(loaded.projection.operationId)
      if (held !== undefined && !recoverable.has(loaded.projection.operationId)) continue
      if (held === undefined && !terminal(loaded.projection.phase)) {
        throw new Error(`nonterminal operation has no exact target lock: ${loaded.projection.operationId}`)
      }
      try {
        await this.recoverLoaded(loaded, signal)
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason
        // One corrupt or temporarily unavailable owner must not prevent other
        // durable operations from being recovered during Host startup.
      }
    }
  }

  private async recoverLoaded(loaded: LoadedOperation, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const consumed = await this.planForProjection(loaded.projection)
    signal.throwIfAborted()
    await this.indexPlan(consumed.plan, consumed.authorization, loaded.projection).catch(() => undefined)
    signal.throwIfAborted()
    if (!currentRecoveryRuntime(consumed.authorization)) {
      await this.recoverRetiredLoaded(loaded, consumed, signal)
      return
    }
    if (terminal(loaded.projection.phase)) {
      let journal = loaded.journal
      let receipt = loaded.projection.receipt
      if (receipt !== null
        && loaded.projection.phase === 'rolled-back'
        && consumed.plan.content.extensionKind === 'plugin') {
        const provider = this.providers.plugin as PluginLifecycleProvider
        const finalized = await provider.finalizeDurableRollback({
          operationId: consumed.authorization.operationId,
          targetKey: loaded.projection.targetKey,
          beforeDigest: loaded.projection.beforeDigest,
        })
        signal.throwIfAborted()
        if (!finalized) return
        await this.recoverTaskReceipt(consumed.plan, consumed.authorization, receipt, signal)
        signal.throwIfAborted()
        await this.release(consumed.plan.content.targetKey, consumed.authorization.operationId)
        return
      }
      let finalizeRollback: (() => Promise<void>) | undefined
      if (receipt === null
        && loaded.projection.phase === 'rolled-back'
        && consumed.plan.content.extensionKind === 'plugin') {
        const request = await this.providerRequest(consumed.plan, consumed.authorization, null, signal)
        signal.throwIfAborted()
        const provider = this.providers.plugin as PluginLifecycleProvider
        const applied = await provider.recover(request)
        signal.throwIfAborted()
        if (applied === null) return
        this.assertRollbackRestartBinding(request, applied)
        await provider.verifyRollbackFinalization(applied)
        signal.throwIfAborted()
        finalizeRollback = () => provider.finalizeRollback(applied)
      }
      if (receipt === null) {
        const issued = issueOperationReceipt(journal, Date.now())
        await this.operations.persist(issued.journal)
        await this.indexPlan(consumed.plan, consumed.authorization, verifyOperationJournal(issued.journal)).catch(() => undefined)
        signal.throwIfAborted()
        journal = issued.journal
        receipt = issued.receipt
      }
      await finalizeRollback?.()
      signal.throwIfAborted()
      await this.recoverTaskReceipt(consumed.plan, consumed.authorization, receipt, signal)
      signal.throwIfAborted()
      await this.release(consumed.plan.content.targetKey, consumed.authorization.operationId)
      return
    }
    if (loaded.projection.phase === 'recovery-required') {
      if (consumed.plan.content.extensionKind !== 'plugin') return
      const request = await this.providerRequest(consumed.plan, consumed.authorization, null, signal)
      signal.throwIfAborted()
      const plugin = this.providers.plugin as PluginLifecycleProvider
      const applied = await plugin.reconcileBreakGlassRestore(
        request,
        loaded.projection.beforeDigest,
        operationJournalCheckpoint(loaded.journal).headDigest,
      )
      signal.throwIfAborted()
      if (applied === null) return
      const journal = await this.append(request, transitionOperation(
        loaded.journal,
        'rolling-back',
        null,
        null,
        Date.now(),
      ))
      signal.throwIfAborted()
      await this.recoverRollback(request, journal, applied)
      return
    }

    const request = await this.providerRequest(consumed.plan, consumed.authorization, null, signal)
    signal.throwIfAborted()
    let journal = loaded.journal
    let projection = verifyOperationJournal(journal)
    const snapshot = await this.state.getProviderSnapshot(request.authorization.operationId)
    signal.throwIfAborted()

    if (projection.phase === 'authorized' || (projection.phase === 'staging' && snapshot === undefined)) {
      journal = await this.append(request, transitionOperation(
        journal,
        'failed',
        projection.beforeDigest,
        'interrupted-before-mutation',
        Date.now(),
      ))
      signal.throwIfAborted()
      await this.finishTerminal(request, journal)
      return
    }

    if (projection.phase === 'staging') {
      journal = await this.append(request, transitionOperation(journal, 'applying', null, null, Date.now()))
      signal.throwIfAborted()
      projection = verifyOperationJournal(journal)
    }

    if (projection.phase === 'rolling-back') {
      await this.recoverRollback(request, journal)
      return
    }

    if (snapshot === undefined) {
      await this.toRecoveryRequired(request, journal, 'mutation-recovery-unavailable')
      return
    }

    const provider = this.providers[request.plan.extensionKind]
    let applied: AppliedProviderOperation | null
    try {
      applied = await provider.recover(request)
      signal.throwIfAborted()
      if (applied !== null) this.assertForwardRestartBinding(request, applied)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      await this.toRecoveryRequired(request, journal, 'mutation-recovery-failed')
      return
    }
    if (applied === null) {
      await this.toRecoveryRequired(request, journal, 'mutation-recovery-unavailable')
      return
    }
    if (projection.mutationDigests.length === 0) {
      journal = await this.append(request, recordOperationMutation(journal, applied.mutationDigest, Date.now()))
      signal.throwIfAborted()
    }
    if (verifyOperationJournal(journal).phase === 'applying') {
      journal = await this.append(request, transitionOperation(journal, 'verifying', null, null, Date.now()))
      signal.throwIfAborted()
    }

    if (request.plan.extensionKind === 'plugin' && applied.restartToken !== null) {
      try {
        const current = await this.operations.load(request.authorization.operationId)
        if (current === undefined) throw new Error('managed Plugin operation disappeared')
        await this.settleManagedPluginRestart(request, current, applied, signal)
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason
        // Startup reconciliation owns rollback when Loader evidence rejects the
        // candidate. A transient probe leaves the operation and lock durable.
      }
      return
    }

    try {
      const verification = await provider.verify(applied)
      signal.throwIfAborted()
      if (verification === null) return
      journal = await this.append(request, recordOperationVerification(journal, verification.digest, Date.now()))
      signal.throwIfAborted()
      try {
        await provider.cleanup(applied.prepared)
      } catch (error: unknown) {
        journal = await this.append(request, transitionOperation(journal, 'rolling-back', null, 'cleanup-failed', Date.now()))
        await this.recoverRollback(request, journal, applied)
        return
      }
      signal.throwIfAborted()
      journal = await this.append(request, transitionOperation(journal, 'committed', applied.afterDigest, null, Date.now()))
      signal.throwIfAborted()
      await this.finishTerminal(request, journal)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      journal = await this.append(request, transitionOperation(journal, 'rolling-back', null, null, Date.now()))
      await this.recoverRollback(request, journal, applied)
    }
  }

  private async recoverRetiredLoaded(
    loaded: LoadedOperation,
    consumed: Extract<PlanAuthorizationState, { status: 'consumed' }>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    const pluginRollback = loaded.projection.phase === 'rolled-back'
      && consumed.plan.content.extensionKind === 'plugin'
    const failedPluginMutation = await this.retiredFailedPluginReferencesMutation(loaded, consumed)
    if (pluginRollback || failedPluginMutation) {
      await this.ensureRetiredTargetQuarantine(loaded.projection.targetKey, loaded.projection.operationId)
      return
    }
    if (terminal(loaded.projection.phase)) {
      let receipt = loaded.projection.receipt
      if (receipt === null) {
        const issued = issueOperationReceipt(loaded.journal, Date.now())
        await this.operations.persist(issued.journal)
        await this.indexPlan(consumed.plan, consumed.authorization, verifyOperationJournal(issued.journal)).catch(() => undefined)
        signal.throwIfAborted()
        receipt = issued.receipt
      }
      await this.recoverTaskReceipt(consumed.plan, consumed.authorization, receipt, signal)
      signal.throwIfAborted()
      await this.release(consumed.plan.content.targetKey, consumed.authorization.operationId)
      return
    }
    await this.ensureRetiredTargetQuarantine(consumed.plan.content.targetKey, consumed.authorization.operationId)
  }

  private async ensureRetiredTargetQuarantine(targetKey: string, operationId: string): Promise<void> {
    this.assertExactRetiredTargetQuarantine(await this.locks.list(), targetKey, operationId)
  }

  private assertExactRetiredTargetQuarantine(
    locks: Awaited<ReturnType<FileTargetLock['list']>>,
    targetKey: string,
    operationId: string,
  ): void {
    const matches = locks.filter(lock => lock.operationId === operationId)
    if (matches.length !== 1 || matches[0]!.targetKey !== targetKey) {
      throw new Error('retired operation does not have one exact durable target quarantine')
    }
  }

  /** Identify a retired Plugin mutation hidden behind an invalid failed terminal journal. */
  private async retiredFailedPluginReferencesMutation(
    loaded: LoadedOperation,
    consumed: Extract<PlanAuthorizationState, { status: 'consumed' }>,
  ): Promise<boolean> {
    if (loaded.projection.phase !== 'failed'
      || consumed.plan.content.extensionKind !== 'plugin'
      || loaded.projection.mutationDigests.length !== 0
      || !loaded.journal.events.some(event => (
        event.entry.type === 'phase-transition' && event.entry.to === 'applying'
      ))) {
      return false
    }
    const snapshot = await this.state.getProviderSnapshot(consumed.authorization.operationId)
    if (snapshot === undefined) {
      throw new Error('retired failed Plugin provider snapshot is missing')
    }
    if (snapshot.operationId !== consumed.authorization.operationId
      || snapshot.targetKey !== consumed.plan.content.targetKey
      || snapshot.beforeDigest !== loaded.projection.beforeDigest) {
      throw new Error('retired failed Plugin provider snapshot does not bind its journal')
    }
    const provider = this.providers.plugin as Partial<PluginLifecycleProvider>
    if (typeof provider.referencesDurableOperation !== 'function') {
      throw new Error('retired failed Plugin owner state cannot be inspected safely')
    }
    return await provider.referencesDurableOperation(
      consumed.authorization.operationId,
      consumed.plan.content.targetKey,
      consumed.plan.content.profileId,
    )
  }

  /** Retry task bookkeeping without making an already terminal target depend on its intent payload. */
  private async recoverTaskReceipt(
    plan: ImmutablePlan,
    authorization: OperationAuthorization,
    receipt: OperationReceipt,
    signal: AbortSignal,
  ): Promise<void> {
    if (plan.content.origin !== 'task') return
    try {
      const request = await this.providerRequest(plan, authorization, null, signal)
      signal.throwIfAborted()
      await this.persistTaskReceipt(request, receipt)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      // Terminal journal recovery retries this bookkeeping on later startups;
      // a missing task payload must not retain the mutation target lock.
    }
  }

  private async recoverRollback(
    request: ProviderOperationRequest,
    journal: OperationJournal,
    knownApplied?: AppliedProviderOperation,
  ): Promise<void> {
    request.signal.throwIfAborted()
    const provider = this.providers[request.plan.extensionKind]
    let applied = knownApplied
    if (applied === undefined) {
      try {
        applied = await provider.recover(request) ?? undefined
        request.signal.throwIfAborted()
      } catch (error: unknown) {
        if (request.signal.aborted) throw request.signal.reason
        applied = undefined
      }
    }
    if (applied === undefined) {
      await this.toRecoveryRequired(request, journal, 'rollback-recovery-unavailable')
      return
    }

    try {
      if (request.plan.extensionKind === 'plugin') {
        if (applied.rollbackRestartRequired) {
          await this.settleManagedPluginRollback(request, journal, applied, request.signal)
        } else {
          await this.rollbackManagedPlugin(request, journal, applied, request.signal)
        }
        return
      }
      const restored = await provider.rollback(applied)
      request.signal.throwIfAborted()
      try {
        await provider.cleanup(applied.prepared)
      } catch (error: unknown) {
        await this.toRecoveryRequired(request, journal, 'cleanup-failed')
        return
      }
      request.signal.throwIfAborted()
      journal = await this.append(request, transitionOperation(journal, 'rolled-back', restored, null, Date.now()))
      request.signal.throwIfAborted()
      await this.finishTerminal(request, journal)
    } catch (error: unknown) {
      if (request.signal.aborted) throw request.signal.reason
      await this.toRecoveryRequired(request, journal, 'rollback-failed')
    }
  }

  private async execute(
    plan: ImmutablePlan,
    authorization: OperationAuthorization,
    reservation: OperationReservation,
    signal: AbortSignal,
  ): Promise<LifecycleResponse> {
    const provider = this.providers[plan.content.extensionKind]
    let journal: OperationJournal
    try {
      journal = createOperationJournal(authorization, reservation.beforeDigest, Date.now())
      await this.operations.persist(journal)
      await this.operations.deleteReservation(authorization.operationId)
      await this.indexPlan(plan, authorization, verifyOperationJournal(journal)).catch(() => undefined)
      signal.throwIfAborted()
    } catch (error: unknown) {
      throw error
    }
    let request: ProviderOperationRequest
    try {
      request = await this.providerRequest(plan, authorization, null, signal)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      journal = transitionOperation(journal, 'failed', verifyOperationJournal(journal).beforeDigest, reason(error), Date.now())
      await this.operations.persist(journal)
      await this.indexPlan(plan, authorization, verifyOperationJournal(journal)).catch(() => undefined)
      const issued = issueOperationReceipt(journal, Date.now())
      await this.operations.persist(issued.journal)
      await this.indexPlan(plan, authorization, verifyOperationJournal(issued.journal)).catch(() => undefined)
      await this.release(plan.content.targetKey, authorization.operationId)
      return this.response(authorization.operationId, verifyOperationJournal(issued.journal), issued.receipt)
    }
    let prepared: PreparedProviderOperation | undefined
    let applied: AppliedProviderOperation | undefined
    let applyAttempted = false
    let cleanupAttempted = false
    let cleanupCompleted = false
    let cleanupFailed = false
    try {
      journal = await this.append(request, transitionOperation(journal, 'staging', null, null, Date.now()))
      signal.throwIfAborted()
      const artifact = this.needsArtifact(plan)
        ? await this.fetcher.fetch({ authorization, plan }, signal)
        : null
      signal.throwIfAborted()
      request = await this.providerRequest(plan, authorization, artifact?.path ?? null, signal)
      signal.throwIfAborted()
      prepared = await provider.prepare(request)
      signal.throwIfAborted()
      await this.state.putProviderSnapshot({
        schemaVersion: 1,
        operationId: authorization.operationId,
        targetKey: plan.content.targetKey,
        before: prepared.before,
        beforeDigest: prepared.beforeDigest,
        recoveryPoint: provider.recoveryPoint(prepared),
      })
      signal.throwIfAborted()
      journal = await this.append(request, transitionOperation(journal, 'applying', null, null, Date.now()))
      signal.throwIfAborted()
      applyAttempted = true
      applied = await provider.apply(prepared)
      signal.throwIfAborted()
      this.assertForwardRestartBinding(request, applied)
      journal = await this.append(request, recordOperationMutation(journal, applied.mutationDigest, Date.now()))
      signal.throwIfAborted()
      journal = await this.append(request, transitionOperation(journal, 'verifying', null, null, Date.now()))
      signal.throwIfAborted()
      const verification = await provider.verify(applied)
      signal.throwIfAborted()
      if (verification === null) {
        cleanupAttempted = true
        await provider.cleanup(prepared)
        cleanupCompleted = true
        signal.throwIfAborted()
        return this.response(authorization.operationId, verifyOperationJournal(journal), null)
      }
      journal = await this.append(request, recordOperationVerification(journal, verification.digest, Date.now()))
      signal.throwIfAborted()
      cleanupAttempted = true
      await provider.cleanup(prepared)
      cleanupCompleted = true
      signal.throwIfAborted()
      journal = await this.append(request, transitionOperation(journal, 'committed', applied.afterDigest, null, Date.now()))
      signal.throwIfAborted()
      const receipt = await this.finishTerminal(request, journal)
      signal.throwIfAborted()
      return this.response(authorization.operationId, verifyOperationJournal(receipt.journal), receipt.receipt)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      if (cleanupAttempted && !cleanupCompleted) {
        cleanupFailed = true
      } else if (!cleanupAttempted && prepared !== undefined) {
        cleanupAttempted = true
        try {
          await provider.cleanup(prepared)
          cleanupCompleted = true
        } catch {
          cleanupFailed = true
        }
      }
      signal.throwIfAborted()
      if (isOfficialProfileAmbiguityError(error)) {
        journal = await this.toRecoveryRequired(
          request,
          journal,
          OFFICIAL_PROFILE_AMBIGUITY_CODE,
          cleanupFailed ? 'cleanup-failed' : null,
        )
        return this.response(authorization.operationId, verifyOperationJournal(journal), null)
      }
      if (applied === undefined) {
        try {
          applied = await provider.recover(request) ?? undefined
          signal.throwIfAborted()
          if (applied !== undefined) this.assertForwardRestartBinding(request, applied)
        } catch (recoveryError: unknown) {
          if (signal.aborted) throw signal.reason
          applied = undefined
        }
      }
      if (applied === undefined && verifyOperationJournal(journal).mutationDigests.length === 0 && !cleanupFailed) {
        if (applyAttempted) {
          journal = await this.toRecoveryRequired(request, journal, 'mutation-recovery-unavailable')
          return this.response(authorization.operationId, verifyOperationJournal(journal), null)
        }
        journal = await this.append(request, transitionOperation(journal, 'failed', verifyOperationJournal(journal).beforeDigest, reason(error), Date.now()))
        signal.throwIfAborted()
        const receipt = await this.finishTerminal(request, journal)
        return this.response(authorization.operationId, verifyOperationJournal(receipt.journal), receipt.receipt)
      }
      if (applied !== undefined && verifyOperationJournal(journal).mutationDigests.length === 0) {
        journal = await this.append(request, recordOperationMutation(journal, applied.mutationDigest, Date.now()))
        signal.throwIfAborted()
      }
      const phase = verifyOperationJournal(journal).phase
      if (phase !== 'rolling-back') {
        journal = await this.append(request, transitionOperation(
          journal,
          'rolling-back',
          null,
          cleanupFailed ? 'cleanup-failed' : null,
          Date.now(),
        ))
        signal.throwIfAborted()
      }
      try {
        if (applied === undefined) throw new Error('mutation recovery unavailable')
        if (request.plan.extensionKind === 'plugin') {
          await this.rollbackManagedPlugin(request, journal, applied, signal)
          const settled = await this.operations.load(authorization.operationId)
          if (settled === undefined) throw new Error('managed Plugin rollback operation disappeared')
          return this.response(authorization.operationId, settled.projection, settled.projection.receipt)
        }
        const restored = await provider.rollback(applied)
        signal.throwIfAborted()
        journal = await this.append(request, transitionOperation(journal, 'rolled-back', restored, null, Date.now()))
        signal.throwIfAborted()
      } catch (rollbackError: unknown) {
        if (signal.aborted) throw signal.reason
        const latest = await this.operations.load(authorization.operationId)
        if (latest !== undefined && terminal(latest.projection.phase)) {
          if (latest.projection.receipt !== null) {
            return this.response(authorization.operationId, latest.projection, latest.projection.receipt)
          }
          throw rollbackError
        }
        journal = await this.toRecoveryRequired(request, journal, 'rollback-failed')
      }
      if (verifyOperationJournal(journal).phase === 'recovery-required') {
        return this.response(authorization.operationId, verifyOperationJournal(journal), null)
      }
      const receipt = await this.finishTerminal(request, journal)
      return this.response(authorization.operationId, verifyOperationJournal(receipt.journal), receipt.receipt)
    }
  }

  private needsArtifact(plan: ImmutablePlan): boolean {
    return plan.content.extensionKind !== 'mcp'
      && (plan.content.operationKind === 'install' || plan.content.operationKind === 'update')
  }

  private async recoverReservations(signal: AbortSignal, recoverable: ReadonlySet<string>): Promise<void> {
    signal.throwIfAborted()
    const locks = await this.locks.list()
    signal.throwIfAborted()
    const plans = await this.plans.list()
    for (const reservation of await this.operations.listReservations()) {
      signal.throwIfAborted()
      if (!recoverable.has(reservation.operationId)) continue
      const held = locks.find(lock => lock.operationId === reservation.operationId)
      if (held === undefined || held.targetKey !== reservation.targetKey) {
        throw new Error(`operation reservation has no exact target lock: ${reservation.operationId}`)
      }
      const loaded = await this.operations.load(reservation.operationId)
      if (loaded !== undefined) {
        if (loaded.projection.planHash !== reservation.planHash
          || loaded.projection.targetKey !== reservation.targetKey
          || loaded.projection.beforeDigest !== reservation.beforeDigest) {
          throw new Error(`operation reservation does not bind its journal: ${reservation.operationId}`)
        }
        const consumed = await this.planForProjection(loaded.projection)
        if (!currentRecoveryRuntime(consumed.authorization)) continue
        signal.throwIfAborted()
        await this.operations.deleteReservation(reservation.operationId)
        continue
      }
      const state = plans.find(candidate => candidate.plan.hash === reservation.planHash)
      if (state?.status === 'approved') {
        signal.throwIfAborted()
        await this.operations.deleteReservation(reservation.operationId)
        signal.throwIfAborted()
        await this.release(reservation.targetKey, reservation.operationId)
        continue
      }
      if (state?.status !== 'consumed'
        || state.authorization.operationId !== reservation.operationId
        || state.authorization.targetKey !== reservation.targetKey) {
        throw new Error(`operation reservation has no exact approved or consumed plan: ${reservation.operationId}`)
      }
      const consumed = planForReservation(reservation, plans)
      if (!currentRecoveryRuntime(consumed.authorization)) continue
      let journal = createOperationJournal(state.authorization, reservation.beforeDigest, Date.now())
      signal.throwIfAborted()
      await this.operations.persist(journal)
      signal.throwIfAborted()
      await this.operations.deleteReservation(reservation.operationId)
      signal.throwIfAborted()
      await this.indexPlan(state.plan, state.authorization, verifyOperationJournal(journal)).catch(() => undefined)
      journal = transitionOperation(
        journal,
        'failed',
        reservation.beforeDigest,
        'interrupted-before-mutation',
        Date.now(),
      )
      signal.throwIfAborted()
      await this.operations.persist(journal)
      signal.throwIfAborted()
      await this.indexPlan(state.plan, state.authorization, verifyOperationJournal(journal)).catch(() => undefined)
      const issued = issueOperationReceipt(journal, Date.now())
      signal.throwIfAborted()
      await this.operations.persist(issued.journal)
      signal.throwIfAborted()
      await this.indexPlan(state.plan, state.authorization, verifyOperationJournal(issued.journal)).catch(() => undefined)
      signal.throwIfAborted()
      await this.release(reservation.targetKey, reservation.operationId)
    }
  }

  private async providerRequest(
    plan: ImmutablePlan,
    authorization: OperationAuthorization,
    artifactPath: string | null,
    signal: AbortSignal,
  ): Promise<ProviderOperationRequest> {
    const intent = await this.state.getIntent(plan.content.intentId)
    if (intent === undefined || intent.planHash !== plan.hash) throw new Error('operation has no exact durable intent payload')
    const core = intent.intent.core
    const authorityDigest = isCenterManagementOperation(plan.content.operationKind)
      ? centerManagementAuthorityDigest({
          operationKind: plan.content.operationKind,
          targetKey: plan.content.targetKey,
          managedRevision: plan.content.fences.targetRevision,
          ownerRevision: plan.content.fences.ownerRevision,
          inventoryRevision: plan.content.fences.inventoryRevision,
        })
      : admittedAuthorityDigest({
          candidateRef: core.candidateRef,
          authorityDeltaDigest: core.authorityDeltaDigest,
          operationKind: core.operationKind,
          desiredState: core.desiredState,
          selectedScope: core.scopeKey,
        })
    if (intent.intent.intentId !== plan.content.intentId
      || intent.intent.origin !== plan.content.origin
      || intent.intent.idempotencyKey !== plan.content.idempotencyKey
      || core.kind !== plan.content.extensionKind
      || core.extensionId !== plan.content.extensionId
      || core.candidateRef !== plan.content.candidateRef
      || core.artifactRevision !== plan.content.artifactRevision
      || core.artifactIntegrity !== plan.content.artifactIntegrity
      || core.artifactUrl !== plan.content.artifactUrl
      || core.artifactSizeBytes !== plan.content.artifactSizeBytes
      || core.scopeKey !== plan.content.scopeKey
      || core.profileId !== plan.content.profileId
      || core.operationKind !== plan.content.operationKind
      || core.desiredState !== plan.content.desiredState
      || authorityDigest !== plan.content.authorityDigest
      || core.catalogRevision !== plan.content.fences.catalogRevision
      || core.inventoryRevision !== plan.content.fences.inventoryRevision) {
      throw new Error('operation plan does not bind the exact durable intent')
    }
    if (plan.content.configurationDigest !== canonicalSha256(intent.payload.configuration)) {
      throw new Error('operation configuration digest does not bind the durable typed payload')
    }
    if (plan.content.verificationDigest !== verificationRecipeDigest(
      plan.content.extensionKind,
      plan.content.operationKind,
      plan.content.desiredState,
    )) throw new Error('operation verification recipe does not match the provider contract')
    if (plan.content.reviewEvidence.kind === 'plugin') {
      const review = plan.content.reviewEvidence
      if (review.activation.restartRequired !== plan.content.restartRequired
        || review.activation.packageName !== review.manifest.packageName
        || review.managedMaterial.packageName !== review.manifest.packageName) {
        throw new Error('operation Plugin identity does not bind the immutable review evidence')
      }
    } else if (plan.content.restartRequired) {
      throw new Error('operation restart requirement does not match the provider contract')
    }
    return Object.freeze({ authorization, plan: plan.content, payload: intent.payload, artifactPath, signal })
  }

  private async planForProjection(projection: OperationProjection): Promise<Extract<PlanAuthorizationState, { status: 'consumed' }>> {
    const state = await this.plans.load(projection.planHash)
    if (state?.status !== 'consumed'
      || state.authorization.operationId !== projection.operationId
      || state.plan.content.planId !== projection.planId
      || canonicalSha256(authorizationJournalBinding(state.authorization))
        !== canonicalSha256(projectionJournalBinding(projection))) {
      throw new Error('operation journal has no exact consumed plan')
    }
    return state
  }

  private async append(request: ProviderOperationRequest, journal: OperationJournal): Promise<OperationJournal> {
    await this.operations.persist(journal)
    await this.index(request, verifyOperationJournal(journal)).catch(() => undefined)
    return journal
  }

  private async index(request: ProviderOperationRequest, projection: OperationProjection): Promise<void> {
    await this.indexPlan({ content: request.plan, hash: request.authorization.planHash }, request.authorization, projection)
  }

  private async indexPlan(
    plan: ImmutablePlan,
    authorization: OperationAuthorization,
    projection: OperationProjection,
  ): Promise<void> {
    const index: StoredOperationIndex = {
      schemaVersion: 1,
      operationId: projection.operationId,
      planHash: projection.planHash,
      targetKey: projection.targetKey,
      extensionKind: plan.content.extensionKind,
      operationKind: projection.operationKind,
      phase: projection.phase,
      lastAtMs: projection.lastAtMs,
    }
    await this.state.putOperationIndex(index)
  }

  private async finishTerminal(
    request: ProviderOperationRequest,
    journal: OperationJournal,
    afterReceipt?: () => Promise<void>,
  ): Promise<Readonly<{ journal: OperationJournal; receipt: OperationReceipt }>> {
    const issued = issueOperationReceipt(journal, Date.now())
    await this.append(request, issued.journal)
    await afterReceipt?.()
    await this.persistTaskReceipt(request, issued.receipt)
    await this.release(request.plan.targetKey, request.authorization.operationId)
    return issued
  }

  private async persistTaskReceipt(
    request: ProviderOperationRequest,
    receipt: OperationReceipt,
  ): Promise<void> {
    if (receipt.body.outcome !== 'committed' || request.payload.continuationId === null) return
    if (request.payload.resolutionId === null || request.payload.verificationPayloadDigest === null) {
      throw new Error('committed task operation has no exact resolution receipt binding')
    }
    const activation = await this.state.getContinuationActivation(request.payload.continuationId)
    if (activation === undefined
      || activation.planHash !== request.authorization.planHash
      || activation.resolutionId !== request.payload.resolutionId
      || activation.verificationPayloadDigest !== request.payload.verificationPayloadDigest) {
      throw new Error('committed task operation has no exact activated continuation claim')
    }
    await this.state.putTaskReceipt({
      schemaVersion: 1,
      continuationId: activation.continuationId,
      resolutionId: request.payload.resolutionId,
      verificationPayloadDigest: request.payload.verificationPayloadDigest,
      planHash: request.authorization.planHash,
      operationId: request.authorization.operationId,
      operationReceiptDigest: receipt.digest,
      completedAtMs: receipt.body.issuedAtMs,
    })
  }

  private async toRecoveryRequired(
    request: ProviderOperationRequest,
    journal: OperationJournal,
    failure: string,
    rollbackReason: string | null = null,
  ): Promise<OperationJournal> {
    const loaded = await this.operations.load(request.authorization.operationId)
    if (loaded !== undefined) journal = loaded.journal
    const phase = verifyOperationJournal(journal).phase
    if (terminal(phase) || phase === 'recovery-required') return journal
    if (phase !== 'rolling-back') {
      journal = await this.append(request, transitionOperation(journal, 'rolling-back', null, rollbackReason, Date.now()))
    }
    return await this.append(request, transitionOperation(journal, 'recovery-required', null, failure, Date.now()))
  }

  private async claimExactRecoveryLease(targetKey: string, operationId: string): Promise<void> {
    const matches = (await this.locks.list()).filter(lock => lock.operationId === operationId)
    if (matches.length !== 1 || matches[0]!.targetKey !== targetKey) {
      throw new Error('operation has no exact target recovery lease')
    }
    const claim = await this.locks.claimRecovery(matches[0]!)
    if (claim === 'live') throw new Error('operation target lease is owned by a live Host')
    if (claim === 'unknown') throw new Error('operation target lease identity cannot be verified')
  }

  private async release(targetKey: string, operationId: string): Promise<void> {
    const held = (await this.locks.list()).find(lock => lock.targetKey === targetKey)
    if (held?.operationId === operationId) await this.locks.release(targetKey, operationId)
  }

  private response(
    operationId: string,
    projection: OperationProjection,
    receipt: OperationReceipt | null,
  ): LifecycleResponse {
    return Object.freeze({
      protocolVersion: HOST_RPC_PROTOCOL_VERSION,
      operationId,
      status: terminal(projection.phase)
        ? projection.phase
        : projection.phase === 'recovery-required' ? 'recovery-required' : 'restart-required',
      receipt,
    })
  }
}
