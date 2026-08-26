import { randomUUID } from 'node:crypto'
import type { VerifiedCatalog } from '../catalog.ts'
import { readSha256Digest } from '../domain/codec.ts'
import { canonicalSha256 } from '../domain/json.ts'
import type { CenterStateStore, StoredOperationIndex } from '../host/index.ts'
import { ArtifactFetcher, FileTargetLock } from '../host/index.ts'
import {
  createOperationJournal,
  issueOperationReceipt,
  recordOperationMutation,
  recordOperationVerification,
  transitionOperation,
  verifyOperationJournal,
  type OperationJournal,
  type OperationOutcome,
  type OperationProjection,
  type OperationReceipt,
} from '../operations/index.ts'
import type { ImmutablePlan, OperationAuthorization, PlanAuthorizationState } from '../plans/index.ts'
import { verificationRecipeDigest } from '../policy/index.ts'
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

/** Registry of exactly one provider for each extension kind. */
export type LifecycleProviders = Readonly<Record<'plugin' | 'mcp' | 'skill', LifecycleProvider>>

function terminal(phase: OperationProjection['phase']): phase is OperationOutcome {
  return ['committed', 'rolled-back', 'failed'].includes(phase)
}

function reason(_error: unknown): string {
  return 'provider-failure'
}

/** Durable single-use plan consumer and append-only lifecycle runner. */
export class OperationRunner {
  constructor(
    private readonly state: CenterStateStore,
    private readonly plans: FilePlanStore,
    private readonly operations: FileOperationStore,
    private readonly locks: FileTargetLock,
    private readonly fetcher: ArtifactFetcher,
    private readonly intentPlans: IntentPlanService,
    private readonly providers: LifecycleProviders,
    private readonly catalog: () => VerifiedCatalog,
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
    let reservation: OperationReservation
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
      try {
        await this.operations.deleteReservation(operationId)
        await this.release(plan.content.targetKey, operationId)
      } catch {
        // A durable reservation or lock that could not be removed remains the
        // sole recovery authority; releasing only one would permit overlap.
      }
      throw error
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
    for (const loaded of await this.operations.list()) {
      output.push({
        operationId: loaded.projection.operationId,
        targetKey: loaded.projection.targetKey,
        phase: loaded.projection.phase,
        operationKind: loaded.projection.operationKind,
        lastAtMs: loaded.projection.lastAtMs,
        recoveryCommand: loaded.projection.phase === 'recovery-required'
          && loaded.projection.planEvidence.extensionKind === 'plugin'
          ? Object.freeze([
              loaded.projection.planEvidence.recoveryExecutable.executablePath,
              this.operations.centerRoot(),
              loaded.projection.operationId,
            ])
          : null,
        recoveryNotice: loaded.projection.phase === 'recovery-required'
          && loaded.projection.planEvidence.extensionKind === 'plugin'
          ? 'journal-reconciliation-pending'
          : null,
      })
    }
    return Object.freeze(output.sort((left, right) => right.lastAtMs - left.lastAtMs
      || left.operationId.localeCompare(right.operationId)))
  }

  /** List content-addressed terminal receipts. */
  listReceipts(): Promise<readonly StoredReceipt[]> {
    return this.operations.listReceipts()
  }

  /** Retry an exact fenced rollback while retaining the target lock until owner state is reconciled. */
  async recoverOperation(operationId: string, signal: AbortSignal): Promise<LifecycleResponse> {
    signal.throwIfAborted()
    const loaded = await this.operations.load(operationId)
    signal.throwIfAborted()
    if (loaded === undefined || loaded.projection.phase !== 'recovery-required') {
      throw new Error('operation is not awaiting explicit recovery')
    }
    const state = await this.planForProjection(loaded.projection)
    signal.throwIfAborted()
    const request = await this.providerRequest(state.plan, state.authorization, null, signal)
    signal.throwIfAborted()
    const provider = this.providers[request.plan.extensionKind]
    const applied = await provider.recover(request)
    signal.throwIfAborted()
    if (applied === null) throw new Error('provider recovery point is unavailable')
    let journal = await this.append(request, transitionOperation(loaded.journal, 'rolling-back', null, null, Date.now()))
    signal.throwIfAborted()
    if (request.plan.extensionKind === 'plugin' && applied.rollbackRestart && applied.profileGeneration !== null) {
      return this.response(operationId, verifyOperationJournal(journal), null)
    }
    try {
      const restored = await provider.rollback(applied)
      signal.throwIfAborted()
      if (request.plan.extensionKind === 'plugin') {
        const rollback = await provider.recover(request)
        signal.throwIfAborted()
        if (rollback === null || !rollback.rollbackRestart || rollback.profileGeneration === null) {
          throw new Error('Plugin recovery did not publish an exact rollback generation')
        }
        return this.response(operationId, verifyOperationJournal(journal), null)
      }
      journal = await this.append(request, transitionOperation(journal, 'rolled-back', restored, null, Date.now()))
      signal.throwIfAborted()
      const issued = await this.finishTerminal(request, journal)
      return this.response(operationId, verifyOperationJournal(issued.journal), issued.receipt)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      journal = await this.append(request, transitionOperation(journal, 'recovery-required', null, 'rollback-failed', Date.now()))
      return this.response(operationId, verifyOperationJournal(journal), null)
    }
  }

  /** Reconcile a Profile operation only from Host-owned boot and Loader evidence. */
  async acknowledgeProfileBoot(input: Readonly<{
    operationId: string
    profileId: string
    generation: string
  }>, signal: AbortSignal): Promise<LifecycleResponse> {
    signal.throwIfAborted()
    const loaded = await this.operations.load(input.operationId)
    signal.throwIfAborted()
    if (loaded === undefined || !['verifying', 'rolling-back'].includes(loaded.projection.phase)) {
      throw new Error('Plugin operation is not awaiting restart verification')
    }
    const state = await this.planForProjection(loaded.projection)
    signal.throwIfAborted()
    const request = await this.providerRequest(state.plan, state.authorization, null, signal)
    signal.throwIfAborted()
    if (request.plan.extensionKind !== 'plugin') throw new Error('operation is not a Plugin Profile mutation')
    const provider = this.providers.plugin as PluginLifecycleProvider
    const applied = await provider.recover(request)
    signal.throwIfAborted()
    if (applied === null || applied.profileGeneration !== input.generation) throw new Error('Plugin operation has no exact pending generation')
    let journal = loaded.journal
    const bootReady = await provider.bootReady({ profileId: input.profileId, generation: input.generation })
    signal.throwIfAborted()
    if (!bootReady) {
      throw new Error('Profile generation has no successful app-boot acknowledgement')
    }
    try {
      await provider.acknowledgeBoot({
        operationId: input.operationId,
        targetKey: request.plan.targetKey,
        profileId: input.profileId,
        generation: input.generation,
      })
      signal.throwIfAborted()
      const verification = await provider.verify(applied)
      signal.throwIfAborted()
      if (verification === null) return this.response(input.operationId, loaded.projection, null)
      journal = await this.append(request, recordOperationVerification(journal, verification.digest, Date.now()))
      signal.throwIfAborted()
      if (loaded.projection.phase === 'rolling-back') {
        journal = await this.append(request, transitionOperation(journal, 'rolled-back', applied.prepared.beforeDigest, null, Date.now()))
        signal.throwIfAborted()
        await provider.finalizeRollback(applied)
        signal.throwIfAborted()
      } else {
        journal = await this.append(request, transitionOperation(journal, 'committed', applied.afterDigest, null, Date.now()))
        signal.throwIfAborted()
      }
      const issued = await this.finishTerminal(request, journal)
      return this.response(input.operationId, verifyOperationJournal(issued.journal), issued.receipt)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      if (terminal(verifyOperationJournal(journal).phase)) throw error
      if (loaded.projection.phase === 'rolling-back') {
        journal = await this.append(request, transitionOperation(journal, 'recovery-required', null, 'rollback-verification-failed', Date.now()))
        return this.response(input.operationId, verifyOperationJournal(journal), null)
      }
      journal = await this.append(request, transitionOperation(journal, 'rolling-back', null, null, Date.now()))
      try {
        await provider.rollback(applied)
        signal.throwIfAborted()
        const rollback = await provider.recover(request)
        signal.throwIfAborted()
        if (rollback === null || !rollback.rollbackRestart || rollback.profileGeneration === null) {
          throw new Error('Plugin rollback generation is unavailable')
        }
        return this.response(input.operationId, verifyOperationJournal(journal), null)
      } catch (rollbackError: unknown) {
        if (signal.aborted) throw signal.reason
        journal = await this.append(request, transitionOperation(journal, 'recovery-required', null, 'rollback-failed', Date.now()))
        return this.response(input.operationId, verifyOperationJournal(journal), null)
      }
    }
  }

  /** Repair interrupted journals without replaying a consumed plan or a committed mutation. */
  async recover(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.recoverReservations(signal)
    signal.throwIfAborted()
    const loadedOperations = await this.operations.list()
    signal.throwIfAborted()
    const journalIds = new Set(loadedOperations.map(loaded => loaded.projection.operationId))
    const reservationIds = new Set((await this.operations.listReservations()).map(reservation => reservation.operationId))
    for (const held of await this.locks.list()) {
      signal.throwIfAborted()
      if (journalIds.has(held.operationId) || reservationIds.has(held.operationId)) continue
      const consumed = (await this.plans.list()).find((state): state is Extract<PlanAuthorizationState, { status: 'consumed' }> => state.status === 'consumed'
        && state.authorization.operationId === held.operationId
        && state.plan.content.targetKey === held.targetKey)
      if (consumed !== undefined) continue
      signal.throwIfAborted()
      await this.release(held.targetKey, held.operationId)
    }
    for (const loaded of await this.operations.list()) {
      signal.throwIfAborted()
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
    if (terminal(loaded.projection.phase)) {
      const request = await this.providerRequest(consumed.plan, consumed.authorization, null, signal)
      signal.throwIfAborted()
      let journal = loaded.journal
      let receipt = loaded.projection.receipt
      if (loaded.projection.phase === 'rolled-back' && request.plan.extensionKind === 'plugin') {
        const managed = await this.state.getManaged(request.plan.targetKey)
        signal.throwIfAborted()
        if (managed?.lastOperationId === request.authorization.operationId) {
          const provider = this.providers.plugin as PluginLifecycleProvider
          const applied = await provider.recover(request)
          signal.throwIfAborted()
          if (applied === null || !applied.rollbackRestart) {
            throw new Error('terminal Plugin rollback has no exact recovery evidence')
          }
          await provider.finalizeRollback(applied)
          signal.throwIfAborted()
        }
      }
      if (receipt === null) {
        const issued = issueOperationReceipt(journal, Date.now())
        journal = await this.append(request, issued.journal)
        signal.throwIfAborted()
        receipt = issued.receipt
      }
      await this.persistTaskReceipt(request, receipt)
      signal.throwIfAborted()
      await this.release(request.plan.targetKey, request.authorization.operationId)
      return
    }
    if (loaded.projection.phase === 'recovery-required') {
      if (consumed.plan.content.extensionKind !== 'plugin') return
      const request = await this.providerRequest(consumed.plan, consumed.authorization, null, signal)
      signal.throwIfAborted()
      const plugin = this.providers.plugin as PluginLifecycleProvider
      const applied = await plugin.reconcileBreakGlassRestore(request, loaded.projection.beforeDigest)
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

    if (request.plan.extensionKind === 'plugin' && applied.profileGeneration !== null) {
      const plugin = provider as PluginLifecycleProvider
      try {
        if (!await plugin.bootReady({
          profileId: request.plan.profileId,
          generation: applied.profileGeneration,
        })) return
        signal.throwIfAborted()
        await this.acknowledgeProfileBoot({
          operationId: request.authorization.operationId,
          profileId: request.plan.profileId,
          generation: applied.profileGeneration,
        }, signal)
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason
        // acknowledgeProfileBoot owns the rollback transition when Host boot or
        // Loader evidence rejects the candidate. A transient probe leaves the
        // operation verifying and the target lock held for the next recovery.
      }
      return
    }

    try {
      const verification = await provider.verify(applied)
      signal.throwIfAborted()
      if (verification === null) return
      journal = await this.append(request, recordOperationVerification(journal, verification.digest, Date.now()))
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

    if (request.plan.extensionKind === 'plugin' && applied.rollbackRestart && applied.profileGeneration !== null) {
      const plugin = provider as PluginLifecycleProvider
      try {
        if (!await plugin.bootReady({ profileId: request.plan.profileId, generation: applied.profileGeneration })) return
        request.signal.throwIfAborted()
        await this.acknowledgeProfileBoot({
          operationId: request.authorization.operationId,
          profileId: request.plan.profileId,
          generation: applied.profileGeneration,
        }, request.signal)
      } catch (error: unknown) {
        if (request.signal.aborted) throw request.signal.reason
        // Exact rollback generation remains pending and locked until either its
        // Host proof succeeds or acknowledgeProfileBoot fences explicit recovery.
      }
      return
    }

    try {
      const restored = await provider.rollback(applied)
      request.signal.throwIfAborted()
      if (request.plan.extensionKind === 'plugin') {
        const rollback = await provider.recover(request)
        request.signal.throwIfAborted()
        if (rollback === null || !rollback.rollbackRestart || rollback.profileGeneration === null) {
          throw new Error('Plugin recovery did not publish an exact rollback generation')
        }
        return
      }
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
    try {
      journal = await this.append(request, transitionOperation(journal, 'staging', null, null, Date.now()))
      signal.throwIfAborted()
      const artifact = this.needsArtifact(plan)
        ? await this.fetcher.fetch({ authorization, plan, catalog: this.catalog() }, signal)
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
      applied = await provider.apply(prepared)
      signal.throwIfAborted()
      journal = await this.append(request, recordOperationMutation(journal, applied.mutationDigest, Date.now()))
      signal.throwIfAborted()
      journal = await this.append(request, transitionOperation(journal, 'verifying', null, null, Date.now()))
      signal.throwIfAborted()
      const verification = await provider.verify(applied)
      signal.throwIfAborted()
      if (verification === null) {
        await provider.cleanup(prepared)
        signal.throwIfAborted()
        return this.response(authorization.operationId, verifyOperationJournal(journal), null)
      }
      journal = await this.append(request, recordOperationVerification(journal, verification.digest, Date.now()))
      signal.throwIfAborted()
      journal = await this.append(request, transitionOperation(journal, 'committed', applied.afterDigest, null, Date.now()))
      signal.throwIfAborted()
      const receipt = await this.finishTerminal(request, journal)
      signal.throwIfAborted()
      await provider.cleanup(prepared)
      signal.throwIfAborted()
      return this.response(authorization.operationId, verifyOperationJournal(receipt.journal), receipt.receipt)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      if (prepared !== undefined) await provider.cleanup(prepared).catch(() => undefined)
      signal.throwIfAborted()
      if (applied === undefined) {
        try {
          applied = await provider.recover(request) ?? undefined
          signal.throwIfAborted()
        } catch (recoveryError: unknown) {
          if (signal.aborted) throw signal.reason
          applied = undefined
        }
      }
      if (applied === undefined && verifyOperationJournal(journal).mutationDigests.length === 0) {
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
        journal = await this.append(request, transitionOperation(journal, 'rolling-back', null, null, Date.now()))
        signal.throwIfAborted()
      }
      try {
        if (applied === undefined) throw new Error('mutation recovery unavailable')
        const restored = await provider.rollback(applied)
        signal.throwIfAborted()
        if (request.plan.extensionKind === 'plugin') {
          const rollback = await provider.recover(request)
          signal.throwIfAborted()
          if (rollback === null || !rollback.rollbackRestart || rollback.profileGeneration === null) {
            throw new Error('Plugin rollback generation is unavailable')
          }
          return this.response(authorization.operationId, verifyOperationJournal(journal), null)
        }
        journal = await this.append(request, transitionOperation(journal, 'rolled-back', restored, null, Date.now()))
        signal.throwIfAborted()
      } catch (rollbackError: unknown) {
        if (signal.aborted) throw signal.reason
        journal = await this.append(request, transitionOperation(journal, 'recovery-required', null, 'rollback-failed', Date.now()))
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

  private async recoverReservations(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const locks = await this.locks.list()
    signal.throwIfAborted()
    const plans = await this.plans.list()
    for (const reservation of await this.operations.listReservations()) {
      signal.throwIfAborted()
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
    const catalog = this.catalog()
    if (catalog.envelope.revision !== plan.content.fences.catalogRevision) throw new Error('operation catalog fence is stale')
    const entry = catalog.envelope.entries.find(candidate => candidate.candidateRef === plan.content.candidateRef)
    if (entry === undefined) throw new Error('operation candidate is absent from the verified catalog')
    if (plan.content.configurationDigest !== canonicalSha256(intent.payload.configuration)) {
      throw new Error('operation configuration digest does not bind the durable typed payload')
    }
    if (plan.content.retentionDigest !== canonicalSha256({ candidateRef: entry.candidateRef, retainedData: entry.retainedData })) {
      throw new Error('operation retention digest does not bind the verified catalog')
    }
    if (plan.content.restartRequired !== entry.restart.required) {
      throw new Error('operation restart requirement does not bind the verified catalog')
    }
    if (plan.content.verificationDigest !== verificationRecipeDigest(
      entry.kind,
      plan.content.operationKind,
      plan.content.desiredState,
    )) throw new Error('operation verification recipe does not match the provider contract')
    return Object.freeze({ authorization, plan: plan.content, entry, payload: intent.payload, artifactPath, signal })
  }

  private async planForProjection(projection: OperationProjection): Promise<Extract<PlanAuthorizationState, { status: 'consumed' }>> {
    const state = await this.plans.load(projection.planHash)
    if (state?.status !== 'consumed'
      || state.authorization.operationId !== projection.operationId
      || state.plan.content.planId !== projection.planId) {
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
  ): Promise<Readonly<{ journal: OperationJournal; receipt: OperationReceipt }>> {
    const issued = issueOperationReceipt(journal, Date.now())
    await this.append(request, issued.journal)
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
  ): Promise<OperationJournal> {
    const phase = verifyOperationJournal(journal).phase
    if (phase !== 'rolling-back') journal = await this.append(request, transitionOperation(journal, 'rolling-back', null, null, Date.now()))
    return await this.append(request, transitionOperation(journal, 'recovery-required', null, failure, Date.now()))
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
