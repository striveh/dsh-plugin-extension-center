import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { verifyBootstrapCatalog } from '../src/catalog.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import {
  ArtifactFetcher,
  CenterStateStore,
  FileTargetLock,
  storageKey,
  type ManagedTargetRecord,
} from '../src/host/index.ts'
import { OfficialProfileAmbiguityError } from '../src/internal/plugin/index.ts'
import {
  createOperationJournal,
  issueOperationReceipt,
  recordOperationMutation,
  recordOperationVerification,
  transitionOperation,
  type JournalCheckpoint,
  type OperationJournal,
} from '../src/operations/index.ts'
import {
  createImmutablePlan,
  type ImmutablePlan,
  type OperationAuthorization,
  type PlanUseContext,
} from '../src/plans/index.ts'
import {
  admittedAuthorityDigest,
  mintAcquisitionIntent,
  operationRestartRequired,
  verificationRecipeDigest,
} from '../src/policy/index.ts'
import type {
  AppliedProviderOperation,
  LifecycleProvider,
  PreparedProviderOperation,
  ProviderOperationRequest,
} from '../src/providers/index.ts'
import { managedStateDigest } from '../src/providers/records.ts'
import { centerManagementAuthorityDigest } from '../src/service/management-admission.ts'
import { OperationRunner } from '../src/service/operation-runner.ts'
import { FileOperationStore, FilePlanStore } from '../src/storage/index.ts'
import { TEST_RECOVERY_EXECUTABLE_BINDING } from './support/recovery-binding.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class RecoveryProvider implements LifecycleProvider {
  readonly kind = 'skill' as const
  readonly observedPhases: string[] = []
  recoverGate: Promise<void> | null = null
  recoverStarted: (() => void) | null = null
  recoverFailure = false
  rollbackGate: Promise<void> | null = null
  rollbackStarted: (() => void) | null = null
  rollbackMutations = 0
  rollbackFailures = 0
  recoveredRestartRequired = false
  recoveredRestartToken: string | null = null

  constructor(
    private readonly state: CenterStateStore,
    private readonly operations: FileOperationStore,
  ) {}

  observe(): Promise<null> { return Promise.resolve(null) }
  prepare(): Promise<PreparedProviderOperation> { throw new Error('not used') }
  recoveryPoint(): null { return null }
  apply(): Promise<AppliedProviderOperation> { throw new Error('not used') }

  async recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation | null> {
    this.recoverStarted?.()
    if (this.recoverGate !== null) await this.recoverGate
    request.signal.throwIfAborted()
    const loaded = await this.operations.load(request.authorization.operationId)
    this.observedPhases.push(loaded?.projection.phase ?? 'absent')
    if (this.recoverFailure) throw new Error('simulated recovery failure')
    const snapshot = await this.state.getProviderSnapshot(request.authorization.operationId)
    if (snapshot === undefined) return null
    const prepared: PreparedProviderOperation = {
      request,
      before: snapshot.before,
      beforeDigest: snapshot.beforeDigest as `sha256:${string}`,
      stagingPath: null,
      prepared: null,
    }
    return Object.freeze({
      prepared,
      mutationDigest: canonicalSha256({ operationId: request.authorization.operationId, mutation: true }),
      afterDigest: canonicalSha256({ operationId: request.authorization.operationId, after: true }),
      restartRequired: this.recoveredRestartRequired,
      restartToken: this.recoveredRestartToken,
      rollbackRestartRequired: false,
    })
  }

  verify(applied: AppliedProviderOperation) {
    return Promise.resolve({ digest: canonicalSha256({ verified: applied.afterDigest }) })
  }

  async rollback(applied: AppliedProviderOperation): Promise<`sha256:${string}`> {
    this.rollbackStarted?.()
    if (this.rollbackGate !== null) await this.rollbackGate
    applied.prepared.request.signal.throwIfAborted()
    this.rollbackMutations += 1
    if (this.rollbackFailures > 0) {
      this.rollbackFailures -= 1
      throw new Error('simulated rollback failure')
    }
    return applied.prepared.beforeDigest
  }

  cleanup(): Promise<void> { return Promise.resolve() }
}

class RestartingPluginProvider implements LifecycleProvider {
  readonly kind = 'plugin' as const
  restartToken = ''
  rollbackRestartRequired = false
  candidateConsumerAvailable = false
  readonly rehydrated = new Set<string>()
  rollbackCalls = 0
  centerStateRestored = false
  reconciliationCalls = 0
  finalized = 0
  finalizeFailures = 0
  recoverCalls = 0
  recoveryUnavailable = false
  proofReleased = false
  durableBeforeDigest = canonicalSha256(null)
  durableStateMatches = true

  observe(): Promise<null> { return Promise.resolve(null) }
  prepare(): Promise<PreparedProviderOperation> { throw new Error('not used') }
  recoveryPoint(): null { return null }
  apply(): Promise<AppliedProviderOperation> { throw new Error('not used') }

  recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation | null> {
    this.recoverCalls += 1
    if (this.recoveryUnavailable || this.proofReleased) return Promise.resolve(null)
    this.restartToken = `${this.rollbackRestartRequired ? 'managed-rollback' : 'managed'}:${request.authorization.operationId}`
    const prepared: PreparedProviderOperation = {
      request,
      before: null,
      beforeDigest: canonicalSha256(null),
      stagingPath: null,
      prepared: null,
    }
    return Promise.resolve(Object.freeze({
      prepared,
      mutationDigest: canonicalSha256({ operationId: request.authorization.operationId, restartToken: this.restartToken }),
      afterDigest: canonicalSha256({ restartToken: this.restartToken }),
      restartRequired: !this.rollbackRestartRequired,
      restartToken: this.restartToken,
      rollbackRestartRequired: this.rollbackRestartRequired,
    }))
  }

  reconcileBreakGlassRestore(
    request: ProviderOperationRequest,
    expectedBeforeDigest: `sha256:${string}`,
  ): Promise<AppliedProviderOperation | null> {
    this.reconciliationCalls += 1
    if (expectedBeforeDigest !== canonicalSha256(null)) throw new Error('unexpected journal before digest')
    if (!this.centerStateRestored) return Promise.resolve(null)
    const review = request.plan.reviewEvidence
    if (review.kind !== 'plugin' || review.rollbackPoint.digest !== expectedBeforeDigest) {
      throw new Error('missing Center before-state pin')
    }
    this.rollbackRestartRequired = true
    return this.recover(request)
  }

  async bootReady(input: Readonly<{ restartToken: string }>): Promise<boolean> {
    return this.rehydrated.has(input.restartToken)
  }

  async acknowledgeBoot(input: Readonly<{ restartToken: string }>): Promise<void> {
    if (input.restartToken.startsWith('managed:') && !this.candidateConsumerAvailable) {
      throw new Error('candidate Loader consumer is absent')
    }
  }

  verify(applied: AppliedProviderOperation) {
    return Promise.resolve({ digest: canonicalSha256({ verified: applied.restartToken }) })
  }

  rollback(applied: AppliedProviderOperation) {
    this.rollbackCalls += 1
    this.rollbackRestartRequired = true
    return Promise.resolve(applied.prepared.beforeDigest)
  }

  verifyRollbackFinalization(): Promise<void> {
    return Promise.resolve()
  }

  finalizeDurableRollback(input: Readonly<{ beforeDigest: `sha256:${string}` }>): Promise<boolean> {
    if (input.beforeDigest !== this.durableBeforeDigest || !this.durableStateMatches) return Promise.resolve(false)
    this.proofReleased = true
    return Promise.resolve(true)
  }

  finalizeRollback(): Promise<void> {
    this.finalized += 1
    this.proofReleased = true
    if (this.finalizeFailures > 0) {
      this.finalizeFailures -= 1
      return Promise.reject(new Error('simulated kill after rollback journal commit'))
    }
    return Promise.resolve()
  }

  cleanup(): Promise<void> { return Promise.resolve() }
}

class RunProvider implements LifecycleProvider {
  readonly kind = 'skill' as const
  observeFailures = 0
  applyError: unknown = null
  recoverCalls = 0
  rollbackCalls = 0
  cleanupCalls = 0
  cleanupFailures = 0
  appliedRestartRequired = false
  appliedRestartToken: string | null = null

  async observe(): Promise<null> {
    if (this.observeFailures > 0) {
      this.observeFailures -= 1
      throw new Error('simulated observe failure')
    }
    return null
  }

  async prepare(request: ProviderOperationRequest): Promise<PreparedProviderOperation> {
    const before = await this.observe()
    return Object.freeze({
      request,
      before,
      beforeDigest: canonicalSha256(before),
      stagingPath: null,
      prepared: null,
    })
  }

  recoveryPoint(prepared: PreparedProviderOperation) {
    return {
      kind: 'skill' as const,
      parsed: null,
      configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
      destination: null,
      stagingPath: null,
      contentIntegrity: prepared.request.plan.artifactIntegrity,
    }
  }

  apply(prepared: PreparedProviderOperation): Promise<AppliedProviderOperation> {
    if (this.applyError !== null) return Promise.reject(this.applyError)
    return Promise.resolve(Object.freeze({
      prepared,
      mutationDigest: canonicalSha256({ operationId: prepared.request.authorization.operationId, mutation: true }),
      afterDigest: canonicalSha256({ operationId: prepared.request.authorization.operationId, after: true }),
      restartRequired: this.appliedRestartRequired,
      restartToken: this.appliedRestartToken,
      rollbackRestartRequired: false,
    }))
  }

  verify(applied: AppliedProviderOperation) {
    return Promise.resolve({ digest: canonicalSha256({ verified: applied.afterDigest }) })
  }

  rollback(applied: AppliedProviderOperation) {
    this.rollbackCalls += 1
    return Promise.resolve(applied.prepared.beforeDigest)
  }
  recover(): Promise<null> {
    this.recoverCalls += 1
    return Promise.resolve(null)
  }
  cleanup(): Promise<void> {
    this.cleanupCalls += 1
    if (this.cleanupFailures > 0) {
      this.cleanupFailures -= 1
      return Promise.reject(new Error('simulated cleanup failure'))
    }
    return Promise.resolve()
  }
}

class LiveRollbackPluginProvider implements LifecycleProvider {
  readonly kind = 'plugin' as const
  private centerRoot = ''
  private prepared: PreparedProviderOperation | null = null
  private mutated = false
  private rolledBack = false
  rollbackCalls = 0
  finalizeCalls = 0
  finalizeFailures = 0
  proofReleased = false
  recoverCalls = 0
  readonly restartTokens: Array<string | null> = []

  bindRoot(root: string): void { this.centerRoot = root }

  observe(): Promise<null> { return Promise.resolve(null) }

  prepare(request: ProviderOperationRequest): Promise<PreparedProviderOperation> {
    this.prepared = Object.freeze({
      request,
      before: null,
      beforeDigest: canonicalSha256(null),
      stagingPath: null,
      prepared: null,
    })
    return Promise.resolve(this.prepared)
  }

  recoveryPoint(): ProviderOperationRequest['payload']['configuration'] {
    const digest = canonicalSha256({ provider: 'live-configure-rollback' })
    return {
      kind: 'plugin',
      artifactPath: null,
      metadataCache: null,
      snapshot: {
        profileId: 'web',
        revision: 0,
        digest,
        materialRoot: join(this.centerRoot, 'material', 'plugins'),
        bootStatus: 'live',
        ownerRevision: `managed-plugin:0:${digest}`,
      },
    }
  }

  apply(prepared: PreparedProviderOperation): Promise<AppliedProviderOperation> {
    this.prepared = prepared
    this.mutated = true
    return Promise.resolve(this.applied(prepared))
  }

  verify(applied: AppliedProviderOperation) {
    this.restartTokens.push(applied.restartToken)
    if (!this.rolledBack) return Promise.reject(new Error('simulated live configure verification failure'))
    return Promise.resolve({ digest: canonicalSha256({ restored: applied.prepared.beforeDigest }) })
  }

  rollback(applied: AppliedProviderOperation): Promise<`sha256:${string}`> {
    this.rollbackCalls += 1
    this.rolledBack = true
    return Promise.resolve(applied.prepared.beforeDigest)
  }

  recover(): Promise<AppliedProviderOperation | null> {
    this.recoverCalls += 1
    return Promise.resolve(this.prepared === null || !this.mutated || this.proofReleased
      ? null
      : this.applied(this.prepared))
  }

  cleanup(): Promise<void> { return Promise.resolve() }

  verifyRollbackFinalization(): Promise<void> {
    return Promise.resolve()
  }

  finalizeDurableRollback(input: Readonly<{ beforeDigest: `sha256:${string}` }>): Promise<boolean> {
    if (input.beforeDigest !== canonicalSha256(null)) return Promise.resolve(false)
    this.proofReleased = true
    return Promise.resolve(true)
  }

  finalizeRollback(): Promise<void> {
    this.finalizeCalls += 1
    this.proofReleased = true
    if (this.finalizeFailures > 0) {
      this.finalizeFailures -= 1
      return Promise.reject(new Error('simulated Plugin rollback finalization failure'))
    }
    return Promise.resolve()
  }

  private applied(prepared: PreparedProviderOperation): AppliedProviderOperation {
    return Object.freeze({
      prepared,
      mutationDigest: canonicalSha256({ rolledBack: this.rolledBack, operationId: prepared.request.authorization.operationId }),
      afterDigest: this.rolledBack
        ? prepared.beforeDigest
        : canonicalSha256({ configuration: 'candidate' }),
      restartRequired: false,
      restartToken: null,
      rollbackRestartRequired: false,
    })
  }
}

class FailOnceInitialOperationStore extends FileOperationStore {
  failInitialWrites = 0

  override persist(journal: OperationJournal): Promise<JournalCheckpoint> {
    if (journal.events.length === 1 && this.failInitialWrites > 0) {
      this.failInitialWrites -= 1
      return Promise.reject(new Error('simulated initial journal failure'))
    }
    return super.persist(journal)
  }
}

class AmbiguousConsumePlanStore extends FilePlanStore {
  failAfterDurableConsumption = 0

  override async consume(...input: Parameters<FilePlanStore['consume']>): Promise<Awaited<ReturnType<FilePlanStore['consume']>>> {
    const consumed = await super.consume(...input)
    if (this.failAfterDurableConsumption > 0) {
      this.failAfterDurableConsumption -= 1
      throw new Error('simulated consumption directory fsync failure')
    }
    return consumed
  }
}

class FailOnceReleaseTargetLock extends FileTargetLock {
  failReleases = 0

  override release(targetKey: string, operationId: string): Promise<void> {
    if (this.failReleases > 0) {
      this.failReleases -= 1
      return Promise.reject(new Error('simulated crash before target lock release'))
    }
    return super.release(targetKey, operationId)
  }
}

interface Fixture {
  readonly root: string
  readonly state: CenterStateStore
  readonly plans: FilePlanStore
  readonly operations: FileOperationStore
  readonly locks: FileTargetLock
  readonly provider: RecoveryProvider
  readonly runner: OperationRunner
  readonly plan: ImmutablePlan
  readonly authorization: OperationAuthorization
  journal: OperationJournal
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'extension-runner-recovery-'))
  roots.push(root)
  const state = new CenterStateStore(root)
  await state.initialize()
  const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
  const operations = new FileOperationStore(root)
  const locks = new FileTargetLock(root)
  const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
  const entry = catalog.envelope.entries.find(candidate => candidate.kind === 'skill')!
  const createdAtMs = Date.now() - 1_000
  const authorityDeltaDigest = canonicalSha256({ root, authority: true })
  const authorityDigest = admittedAuthorityDigest({
    candidateRef: entry.candidateRef,
    authorityDeltaDigest,
    operationKind: 'install',
    desiredState: 'enabled',
    selectedScope: 'user',
  })
  const plan = createImmutablePlan({
    schemaVersion: 1,
    singleUse: true,
    planId: `plan:${canonicalSha256({ root }).slice(7, 23)}`,
    intentId: `intent:${canonicalSha256({ root, intent: true }).slice(7, 23)}`,
    origin: 'store',
    candidateRef: entry.candidateRef,
    extensionKind: 'skill',
    extensionId: entry.name,
    managedObject: 'artifact',
    externalRuntimeAction: 'download',
    runtimeBinding: null,
    artifactRevision: entry.artifact.version,
    artifactIntegrity: entry.artifact.integrity,
    artifactUrl: entry.artifact.acquisitionUrl,
    artifactSizeBytes: entry.artifact.sizeBytes,
    operationKind: 'install',
    desiredState: 'enabled',
    targetKey: `skill:web:user:${entry.name}`,
    ownerKey: 'skills',
    scopeKey: 'user',
    profileId: 'web',
    idempotencyKey: canonicalSha256({ root, idempotency: true }),
    authorityDigest,
    configurationDigest: canonicalSha256({}),
    retentionDigest: canonicalSha256({ candidateRef: entry.candidateRef, retainedData: entry.retainedData }),
    reviewEvidence: testReviewEvidence('skill', 'install'),
    mutationDigest: canonicalSha256({ root, mutation: true }),
    verificationDigest: verificationRecipeDigest('skill', 'install', 'enabled'),
    restartRequired: entry.restart.required,
    createdAtMs,
    expiresAtMs: createdAtMs + 60_000,
    fences: {
      catalogRevision: catalog.envelope.revision,
      inventoryRevision: canonicalSha256({ root, inventory: true }),
      targetRevision: 'absent',
      ownerRevision: 'skills:empty',
      scopeRevision: canonicalSha256({ root, scope: true }),
      profileRevision: 'profile:0:tree',
    },
  })
  const context: PlanUseContext = {
    operationKind: plan.content.operationKind,
    targetKey: plan.content.targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    fences: plan.content.fences,
  }
  await plans.put(plan)
  await plans.decide(plan.hash, {
    planId: plan.content.planId,
    planHash: plan.hash,
    operationKind: plan.content.operationKind,
    decision: 'approve',
  }, context, createdAtMs + 1)
  const operationId = `operation:${canonicalSha256({ root, operation: true }).slice(7, 23)}`
  const consumed = await plans.consume(plan.hash, operationId, context, createdAtMs + 2)
  const intentCore = {
    kind: plan.content.extensionKind,
    extensionId: plan.content.extensionId,
    candidateRef: plan.content.candidateRef,
    artifactRevision: plan.content.artifactRevision,
    artifactIntegrity: plan.content.artifactIntegrity,
    artifactUrl: plan.content.artifactUrl,
    artifactSizeBytes: plan.content.artifactSizeBytes,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    operationKind: plan.content.operationKind,
    desiredState: plan.content.desiredState,
    admittedCapabilities: [...entry.tags].sort(),
    authorityDeltaDigest,
    policyRevision: 'extension-center-p0-policy-v2',
    catalogRevision: plan.content.fences.catalogRevision,
    inventoryRevision: plan.content.fences.inventoryRevision,
  }
  await state.putIntent({
    schemaVersion: 1,
    intent: {
      schemaVersion: 1,
      intentId: plan.content.intentId,
      origin: 'store',
      idempotencyKey: plan.content.idempotencyKey,
      continuationId: null,
      createdAtMs: plan.content.createdAtMs,
      expiresAtMs: plan.content.expiresAtMs,
      core: intentCore,
      coreDigest: canonicalSha256(intentCore),
    },
    payload: {
      configuration: {},
      continuationId: null,
      resolutionId: null,
      verificationPayloadDigest: null,
      taskSessionId: null,
      taskOriginalMessageId: null,
    },
    planHash: plan.hash,
  })
  await locks.acquire(plan.content.targetKey, operationId, createdAtMs + 2)
  const provider = new RecoveryProvider(state, operations)
  const runner = new OperationRunner(
    state,
    plans,
    operations,
    locks,
    new ArtifactFetcher(root, { maximumRedirects: 0, allowedCrossOriginHosts: [] }),
    { context: () => Promise.resolve(context) } as never,
    { plugin: provider, mcp: provider, skill: provider },
  )
  const journal = createOperationJournal(consumed.authorization, canonicalSha256(null), createdAtMs + 3)
  await operations.persist(journal)
  return { root, state, plans, operations, locks, provider, runner, plan, authorization: consumed.authorization, journal }
}

function alternateRecoveryRunner(
  value: Fixture,
  locks: FileTargetLock,
  contextOverride?: () => Promise<PlanUseContext>,
): OperationRunner {
  const context: PlanUseContext = {
    operationKind: value.plan.content.operationKind,
    targetKey: value.plan.content.targetKey,
    ownerKey: value.plan.content.ownerKey,
    scopeKey: value.plan.content.scopeKey,
    profileId: value.plan.content.profileId,
    fences: value.plan.content.fences,
  }
  return new OperationRunner(
    value.state,
    value.plans,
    value.operations,
    locks,
    new ArtifactFetcher(value.root, { maximumRedirects: 0, allowedCrossOriginHosts: [] }),
    { context: contextOverride ?? (() => Promise.resolve(context)) } as never,
    { plugin: value.provider, mcp: value.provider, skill: value.provider },
  )
}

async function append(value: Fixture, next: OperationJournal): Promise<void> {
  await value.operations.persist(next)
  value.journal = next
}

async function persistRolledBackReceipt(
  operations: FileOperationStore,
  operationId: string,
  beforeDigest: `sha256:${string}`,
): Promise<void> {
  let journal = (await operations.load(operationId))!.journal
  const atMs = Date.now()
  journal = transitionOperation(journal, 'rolling-back', null, 'verification-failed', atMs)
  await operations.persist(journal)
  journal = transitionOperation(journal, 'rolled-back', beforeDigest, null, atMs + 1)
  await operations.persist(journal)
  await operations.persist(issueOperationReceipt(journal, atMs + 2).journal)
}

async function snapshot(value: Fixture): Promise<void> {
  await value.state.putProviderSnapshot({
    schemaVersion: 1,
    operationId: value.authorization.operationId,
    targetKey: value.plan.content.targetKey,
    before: null,
    beforeDigest: canonicalSha256(null),
    recoveryPoint: {
      kind: 'skill',
      parsed: null,
      configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
      destination: null,
      stagingPath: null,
      contentIntegrity: value.plan.content.artifactIntegrity,
    },
  })
}

async function pluginRestartFixture(beforePresent = false): Promise<Readonly<{
  root: string
  state: CenterStateStore
  runner: OperationRunner
  provider: RestartingPluginProvider
  operations: FileOperationStore
  locks: FileTargetLock
  intentId: string
  operationId: string
  profileId: string
  restartToken: string
  targetKey: string
  beforeDigest: `sha256:${string}`
}>> {
  const root = await mkdtemp(join(tmpdir(), 'extension-plugin-restart-'))
  roots.push(root)
  const state = new CenterStateStore(root)
  await state.initialize()
  const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
  const operations = new FileOperationStore(root)
  const locks = new FileTargetLock(root)
  const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
  const entry = catalog.envelope.entries.find(candidate => candidate.kind === 'plugin')!
  const createdAtMs = Date.now() - 1_000
  const profileId = 'web'
  const targetKey = `plugin:${profileId}:profile:web:${entry.name}`
  const beforeVersion = {
    candidateRef: entry.candidateRef,
    artifactRevision: entry.artifact.version,
    artifactIntegrity: entry.artifact.integrity,
    materialPath: join(root, 'material', 'plugins', storageKey(targetKey), storageKey(entry.artifact.integrity)),
    configuration: {},
    enabled: true,
    ownerRevision: 'managed-plugin:1:prior',
    kindState: {
      packageName: entry.artifact.id,
      restartToken: 'managed:prior',
      treeDigest: canonicalSha256({ prior: true }),
      loaderPhase: 'active',
      consumerObserved: true,
      restartObserved: true,
      runtimeEvidence: {
        entryId: entry.artifact.id,
        moduleName: entry.artifact.id,
        fiberPhase: 'active',
      },
    },
  } as const
  const before: ManagedTargetRecord | null = beforePresent ? {
    schemaVersion: 1,
    kind: 'plugin',
    extensionId: entry.name,
    targetKey,
    scopeKey: 'profile:web',
    profileId,
    revision: 1,
    lastOperationId: 'operation:prior',
    current: beforeVersion,
    lastGood: null,
    removed: null,
    pending: null,
    updatedAtMs: createdAtMs - 1,
  } : null
  const authorityDeltaDigest = canonicalSha256({ root, pluginAuthority: true })
  const authorityDigest = admittedAuthorityDigest({
    candidateRef: entry.candidateRef,
    authorityDeltaDigest,
    operationKind: 'install',
    desiredState: 'enabled',
    selectedScope: 'profile:web',
  })
  const plan = createImmutablePlan({
    schemaVersion: 1,
    singleUse: true,
    planId: `plan:${canonicalSha256({ root, plugin: true }).slice(7, 23)}`,
    intentId: `intent:${canonicalSha256({ root, pluginIntent: true }).slice(7, 23)}`,
    origin: 'store',
    candidateRef: entry.candidateRef,
    extensionKind: 'plugin',
    extensionId: entry.name,
    managedObject: 'artifact',
    externalRuntimeAction: 'download',
    runtimeBinding: null,
    artifactRevision: entry.artifact.version,
    artifactIntegrity: entry.artifact.integrity,
    artifactUrl: entry.artifact.acquisitionUrl,
    artifactSizeBytes: entry.artifact.sizeBytes,
    operationKind: 'install',
    desiredState: 'enabled',
    targetKey,
    ownerKey: 'managedPlugins',
    scopeKey: 'profile:web',
    profileId,
    idempotencyKey: canonicalSha256({ root, pluginIdempotency: true }),
    authorityDigest,
    configurationDigest: canonicalSha256({}),
    retentionDigest: canonicalSha256({ candidateRef: entry.candidateRef, retainedData: entry.retainedData }),
    reviewEvidence: testReviewEvidence('plugin', 'install'),
    mutationDigest: canonicalSha256({ root, pluginMutation: true }),
    verificationDigest: verificationRecipeDigest('plugin', 'install', 'enabled'),
    restartRequired: entry.restart.required,
    createdAtMs,
    expiresAtMs: createdAtMs + 60_000,
    fences: {
      catalogRevision: catalog.envelope.revision,
      inventoryRevision: canonicalSha256({ root, pluginInventory: true }),
      targetRevision: 'absent',
      ownerRevision: 'managed-plugin:0:live',
      scopeRevision: canonicalSha256({ root, pluginScope: true }),
      profileRevision: 'managed-plugin:0:live',
    },
  })
  const context: PlanUseContext = {
    operationKind: plan.content.operationKind,
    targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId,
    fences: plan.content.fences,
  }
  const intent = mintAcquisitionIntent({
    intentId: plan.content.intentId,
    origin: 'store',
    idempotencyKey: plan.content.idempotencyKey,
    createdAtMs,
    expiresAtMs: plan.content.expiresAtMs,
    candidate: {
      kind: 'plugin',
      extensionId: entry.name,
      candidateRef: entry.candidateRef,
      artifactRevision: entry.artifact.version,
      artifactIntegrity: entry.artifact.integrity,
      artifactUrl: entry.artifact.acquisitionUrl,
      artifactSizeBytes: entry.artifact.sizeBytes,
      scopeKey: 'profile:web',
      profileId,
      operationKind: 'install',
      desiredState: 'enabled',
      admittedCapabilities: [],
      authorityDeltaDigest,
      policyResult: {
        status: 'eligible',
        policyRevision: 'extension-center-p0-policy-v2',
        authorityDigest: plan.content.authorityDigest,
      },
      catalogRevision: plan.content.fences.catalogRevision,
      inventoryRevision: plan.content.fences.inventoryRevision,
    },
  })
  await state.putIntent({
    schemaVersion: 1,
    intent,
    payload: {
      configuration: {}, continuationId: null, resolutionId: null, verificationPayloadDigest: null,
      taskSessionId: null, taskOriginalMessageId: null,
    },
    planHash: plan.hash,
  })
  await plans.put(plan)
  await plans.decide(plan.hash, {
    planId: plan.content.planId,
    planHash: plan.hash,
    operationKind: 'install',
    decision: 'approve',
  }, context, createdAtMs + 1)
  const operationId = `operation:${canonicalSha256({ root, pluginOperation: true }).slice(7, 23)}`
  const consumed = await plans.consume(plan.hash, operationId, context, createdAtMs + 2)
  await locks.acquire(targetKey, operationId, createdAtMs + 2)
  const beforeDigest = managedStateDigest(before)
  let journal = createOperationJournal(consumed.authorization, beforeDigest, createdAtMs + 3)
  await operations.persist(journal)
  journal = transitionOperation(journal, 'staging', null, null, createdAtMs + 4)
  await operations.persist(journal)
  await state.putProviderSnapshot({
    schemaVersion: 1,
    operationId,
    targetKey,
    before,
    beforeDigest,
    recoveryPoint: {
      kind: 'plugin',
      snapshot: {
        profileId,
        revision: 0,
        digest: canonicalSha256({ root, managedPlugins: 'live' }),
        materialRoot: join(root, 'material', 'plugins'),
        bootStatus: 'live',
        ownerRevision: `managed-plugin:0:${canonicalSha256({ root, managedPlugins: 'live' })}`,
      },
      artifactPath: null,
      metadataCache: null,
    },
  })
  journal = transitionOperation(journal, 'applying', null, null, createdAtMs + 5)
  await operations.persist(journal)
  journal = recordOperationMutation(journal, canonicalSha256({ restartToken: 'managed:candidate' }), createdAtMs + 6)
  await operations.persist(journal)
  journal = transitionOperation(journal, 'verifying', null, null, createdAtMs + 7)
  await operations.persist(journal)
  const provider = new RestartingPluginProvider()
  provider.durableBeforeDigest = beforeDigest
  provider.rehydrated.add(`managed:${operationId}`)
  const runner = new OperationRunner(
    state,
    plans,
    operations,
    locks,
    new ArtifactFetcher(root, { maximumRedirects: 0, allowedCrossOriginHosts: [] }),
    { context: () => Promise.resolve(context) } as never,
    { plugin: provider, mcp: provider, skill: provider },
  )
  return {
    root,
    state,
    runner,
    provider,
    operations,
    locks,
    operationId,
    intentId: plan.content.intentId,
    profileId,
    restartToken: provider.restartToken,
    targetKey,
    beforeDigest,
  }
}

async function approvedRunPlan(input: Readonly<{
  root: string
  state: CenterStateStore
  plans: FilePlanStore
  suffix: string
  persistIntent: boolean
  kind?: 'plugin' | 'skill'
  configuration?: Record<string, unknown>
  operationKind?: 'configure' | 'disable'
}>): Promise<Readonly<{ plan: ImmutablePlan; context: PlanUseContext }>> {
  const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
  const kind = input.kind ?? 'skill'
  const entry = catalog.envelope.entries.find(candidate => candidate.kind === kind)!
  const configuration = input.configuration ?? { modelInvocable: true, userInvocable: true, projectRoot: null }
  const createdAtMs = Date.now() - 1_000
  const scopeKey = kind === 'plugin' ? 'profile:web' : 'user'
  const ownerKey = kind === 'plugin' ? 'managedPlugins' : 'skills'
  const targetKey = `${kind}:web:${scopeKey}:${entry.name}`
  const operationKind = input.operationKind ?? 'configure'
  const desiredState = operationKind === 'disable' ? 'disabled' : 'enabled'
  const inventoryRevision = canonicalSha256({ root: input.root, inventory: 'run' })
  const pluginOwnerRevision = `managed-plugin:0:${canonicalSha256({ root: input.root, pluginOwner: true })}`
  const ownerRevision = kind === 'plugin' ? pluginOwnerRevision : 'skills:empty'
  const targetRevision = operationKind === 'disable' ? 'center:1' : 'absent'
  const authorityDeltaDigest = canonicalSha256({ root: input.root, authority: input.suffix })
  const authorityDigest = operationKind === 'disable'
    ? centerManagementAuthorityDigest({
        operationKind,
        targetKey,
        managedRevision: targetRevision,
        ownerRevision,
        inventoryRevision,
      })
    : admittedAuthorityDigest({
        candidateRef: entry.candidateRef,
        authorityDeltaDigest,
        operationKind,
        desiredState,
        selectedScope: scopeKey,
      })
  const plan = createImmutablePlan({
    schemaVersion: 1,
    singleUse: true,
    planId: `plan:run-${input.suffix}`,
    intentId: `intent:run-${input.suffix}`,
    origin: 'store',
    candidateRef: entry.candidateRef,
    extensionKind: kind,
    extensionId: entry.name,
    managedObject: 'artifact',
    externalRuntimeAction: 'none',
    runtimeBinding: null,
    artifactRevision: entry.artifact.version,
    artifactIntegrity: entry.artifact.integrity,
    artifactUrl: entry.artifact.acquisitionUrl,
    artifactSizeBytes: entry.artifact.sizeBytes,
    operationKind,
    desiredState,
    targetKey,
    ownerKey,
    scopeKey,
    profileId: 'web',
    idempotencyKey: canonicalSha256({ root: input.root, idempotency: input.suffix }),
    authorityDigest,
    configurationDigest: canonicalSha256(configuration),
    retentionDigest: canonicalSha256({ candidateRef: entry.candidateRef, retainedData: entry.retainedData }),
    reviewEvidence: testReviewEvidence(kind, operationKind),
    mutationDigest: canonicalSha256({ root: input.root, mutation: input.suffix }),
    verificationDigest: verificationRecipeDigest(kind, operationKind, desiredState),
    restartRequired: operationRestartRequired(entry, operationKind),
    createdAtMs,
    expiresAtMs: createdAtMs + 60_000,
    fences: {
      catalogRevision: catalog.envelope.revision,
      inventoryRevision,
      targetRevision,
      ownerRevision,
      scopeRevision: canonicalSha256({ root: input.root, scope: 'run' }),
      profileRevision: kind === 'plugin' ? pluginOwnerRevision : 'profile:0:tree',
    },
  })
  const context: PlanUseContext = {
    operationKind: plan.content.operationKind,
    targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    fences: plan.content.fences,
  }
  if (input.persistIntent) {
    const intent = mintAcquisitionIntent({
      intentId: plan.content.intentId,
      origin: 'store',
      idempotencyKey: plan.content.idempotencyKey,
      createdAtMs,
      expiresAtMs: plan.content.expiresAtMs,
      candidate: {
        kind,
        extensionId: entry.name,
        candidateRef: entry.candidateRef,
        artifactRevision: entry.artifact.version,
        artifactIntegrity: entry.artifact.integrity,
        artifactUrl: entry.artifact.acquisitionUrl,
        artifactSizeBytes: entry.artifact.sizeBytes,
        scopeKey,
        profileId: 'web',
        operationKind,
        desiredState,
        admittedCapabilities: [],
        authorityDeltaDigest,
        policyResult: {
          status: 'eligible',
          policyRevision: 'extension-center-p0-policy-v2',
          authorityDigest: plan.content.authorityDigest,
        },
        catalogRevision: plan.content.fences.catalogRevision,
        inventoryRevision,
      },
    })
    await input.state.putIntent({
      schemaVersion: 1,
      intent,
      payload: {
        configuration,
        continuationId: null,
        resolutionId: null,
        verificationPayloadDigest: null,
        taskSessionId: null,
        taskOriginalMessageId: null,
      },
      planHash: plan.hash,
    })
  }
  await input.plans.put(plan)
  await input.plans.decide(plan.hash, {
    planId: plan.content.planId,
    planHash: plan.hash,
    operationKind: plan.content.operationKind,
    decision: 'approve',
  }, context, createdAtMs + 1)
  return { plan, context }
}

async function runFixture(
  operationStore?: FileOperationStore,
  pluginProvider?: LiveRollbackPluginProvider,
  planStoreFactory?: (root: string) => FilePlanStore,
  targetLockFactory?: (root: string) => FileTargetLock,
): Promise<Readonly<{
  root: string
  state: CenterStateStore
  plans: FilePlanStore
  operations: FileOperationStore
  locks: FileTargetLock
  provider: RunProvider
  runner: OperationRunner
}>> {
  const root = operationStore === undefined
    ? await mkdtemp(join(tmpdir(), 'extension-run-setup-'))
    : (operationStore as unknown as { root: string }).root
  if (operationStore === undefined) roots.push(root)
  const state = new CenterStateStore(root)
  await state.initialize()
  const plans = planStoreFactory?.(root) ?? new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
  const operations = operationStore ?? new FileOperationStore(root)
  const locks = targetLockFactory?.(root) ?? new FileTargetLock(root)
  const provider = new RunProvider()
  pluginProvider?.bindRoot(root)
  let activeContext: PlanUseContext | undefined
  const runner = new OperationRunner(
    state,
    plans,
    operations,
    locks,
    new ArtifactFetcher(root, { maximumRedirects: 0, allowedCrossOriginHosts: [] }),
    { context: () => activeContext === undefined ? Promise.reject(new Error('missing context')) : Promise.resolve(activeContext) } as never,
    { plugin: pluginProvider ?? provider, mcp: provider, skill: provider },
  )
  Object.defineProperty(runner, '__setContext', { value: (value: PlanUseContext) => { activeContext = value } })
  return { root, state, plans, operations, locks, provider, runner }
}

function setRunContext(runner: OperationRunner, context: PlanUseContext | undefined): void {
  ;(runner as unknown as { __setContext(value: PlanUseContext | undefined): void }).__setContext(context)
}

describe('phase-aware operation recovery', () => {
  it('fails an interrupted staging phase with no provider snapshot without invoking recovery', async () => {
    const value = await fixture()
    expect(await value.state.listOperationIndexes()).toEqual([])
    await append(value, transitionOperation(value.journal, 'staging', null, null, Date.now()))

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()

    const loaded = await value.operations.load(value.authorization.operationId)
    expect(loaded?.projection).toMatchObject({ phase: 'failed', receipt: { body: { outcome: 'failed' } } })
    expect(value.provider.observedPhases).toEqual([])
    expect(await value.state.listOperationIndexes()).toMatchObject([{
      operationId: value.authorization.operationId,
      phase: 'failed',
    }])
    expect(await value.locks.list()).toEqual([])
  })

  it('moves staging with a durable snapshot to applying before provider recovery', async () => {
    const value = await fixture()
    await append(value, transitionOperation(value.journal, 'staging', null, null, Date.now()))
    await snapshot(value)
    await append(value, transitionOperation(value.journal, 'applying', null, null, Date.now()))
    let admissionCalls = 0
    const recovery = alternateRecoveryRunner(value, value.locks, () => {
      admissionCalls += 1
      return Promise.reject(new Error('fresh catalog candidate disappeared'))
    })

    await recovery.recover(new AbortController().signal)

    const loaded = await value.operations.load(value.authorization.operationId)
    expect(value.provider.observedPhases).toEqual(['applying'])
    expect(admissionCalls).toBe(0)
    expect(loaded?.projection).toMatchObject({ phase: 'committed', receipt: { body: { outcome: 'committed' } } })
    expect(await value.locks.list()).toEqual([])
  })

  it('finishes a terminal receipt from only the consumed plan and durable intent', async () => {
    const value = await fixture()
    await append(value, transitionOperation(value.journal, 'staging', null, null, Date.now()))
    await snapshot(value)
    await append(value, transitionOperation(value.journal, 'applying', null, null, Date.now()))
    await append(value, recordOperationMutation(value.journal, canonicalSha256({ terminal: 'mutation' }), Date.now()))
    await append(value, transitionOperation(value.journal, 'verifying', null, null, Date.now()))
    await append(value, recordOperationVerification(value.journal, canonicalSha256({ terminal: 'verification' }), Date.now()))
    await append(value, transitionOperation(
      value.journal,
      'committed',
      canonicalSha256({ terminal: 'after' }),
      null,
      Date.now(),
    ))
    let admissionCalls = 0
    const recovery = alternateRecoveryRunner(value, value.locks, () => {
      admissionCalls += 1
      return Promise.reject(new Error('fresh catalog revision is stale'))
    })

    await expect(recovery.recover(new AbortController().signal)).resolves.toBeUndefined()

    expect((await value.operations.load(value.authorization.operationId))?.projection).toMatchObject({
      phase: 'committed',
      receipt: { body: { outcome: 'committed' } },
    })
    expect(value.provider.observedPhases).toEqual([])
    expect(admissionCalls).toBe(0)
    expect(await value.locks.list()).toEqual([])
  })

  it('repairs a failed terminal receipt and releases its lock without the missing intent that caused the failure', async () => {
    const value = await fixture()
    await append(value, transitionOperation(
      value.journal,
      'failed',
      canonicalSha256(null),
      'provider-failure',
      Date.now(),
    ))
    await rm(join(value.root, 'state', 'intents', `${storageKey(value.plan.content.intentId)}.json`))

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()

    expect((await value.operations.load(value.authorization.operationId))?.projection).toMatchObject({
      phase: 'failed',
      receipt: { body: { outcome: 'failed' } },
    })
    expect(value.provider.observedPhases).toEqual([])
    expect(await value.locks.list()).toEqual([])
  })

  it('parks a recovered mutation when provider restart evidence contradicts the consumed plan', async () => {
    const value = await fixture()
    await append(value, transitionOperation(value.journal, 'staging', null, null, Date.now()))
    await snapshot(value)
    await append(value, transitionOperation(value.journal, 'applying', null, null, Date.now()))
    value.provider.recoveredRestartRequired = true
    value.provider.recoveredRestartToken = 'invented-restart'

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()

    expect((await value.operations.load(value.authorization.operationId))?.projection).toMatchObject({
      phase: 'recovery-required',
      receipt: null,
    })
    expect(value.provider.rollbackMutations).toBe(0)
    expect(await value.locks.list()).toHaveLength(1)
  })

  it('does not translate owner-generation cancellation into a durable recovery mutation', async () => {
    const value = await fixture()
    await append(value, transitionOperation(value.journal, 'staging', null, null, Date.now()))
    await snapshot(value)
    await append(value, transitionOperation(value.journal, 'applying', null, null, Date.now()))
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    value.provider.recoverStarted = () => { started.resolve() }
    value.provider.recoverGate = gate.promise
    const controller = new AbortController()

    const recovery = value.runner.recover(controller.signal)
    await started.promise
    controller.abort(new Error('Host owner generation retired'))
    gate.resolve()

    await expect(recovery).rejects.toThrow('Host owner generation retired')
    expect((await value.operations.load(value.authorization.operationId))?.projection).toMatchObject({
      phase: 'applying',
      receipt: null,
    })
    expect(value.provider.observedPhases).toEqual([])
    expect(await value.locks.list()).toHaveLength(1)
  })

  it('keeps an applying mutation fenced through failed rollback and explicit recovery', async () => {
    const value = await fixture()
    await append(value, transitionOperation(value.journal, 'staging', null, null, Date.now()))
    await snapshot(value)
    await append(value, transitionOperation(value.journal, 'applying', null, null, Date.now()))
    value.provider.recoverFailure = true

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()
    expect((await value.operations.load(value.authorization.operationId))?.projection).toMatchObject({
      phase: 'recovery-required',
      receipt: null,
    })
    await expect(value.locks.acquire(value.plan.content.targetKey, 'operation:competing')).rejects.toThrow('target is busy')

    value.provider.recoverFailure = false
    value.provider.rollbackFailures = 1
    await expect(value.runner.recoverOperation(value.authorization.operationId, new AbortController().signal))
      .resolves.toMatchObject({ status: 'recovery-required', receipt: null })
    expect((await value.operations.load(value.authorization.operationId))?.projection.phase).toBe('recovery-required')
    expect(await value.locks.list()).toHaveLength(1)

    await expect(value.runner.recoverOperation(value.authorization.operationId, new AbortController().signal))
      .resolves.toMatchObject({ status: 'rolled-back', receipt: { body: { outcome: 'rolled-back' } } })
    expect((await value.operations.load(value.authorization.operationId))?.projection.phase).toBe('rolled-back')
    expect(await value.locks.list()).toEqual([])
  })

  it('rejects explicit recovery from a second Host before provider or journal mutation', async () => {
    const value = await fixture()
    await append(value, transitionOperation(value.journal, 'staging', null, null, Date.now()))
    await snapshot(value)
    await append(value, transitionOperation(value.journal, 'applying', null, null, Date.now()))
    await append(value, transitionOperation(value.journal, 'rolling-back', null, null, Date.now()))
    await append(value, transitionOperation(value.journal, 'recovery-required', null, 'rollback-failed', Date.now()))
    const beforeOwner = (await value.locks.list())[0]!
    const beforeEvents = value.journal.events.length
    const foreign = alternateRecoveryRunner(value, new FileTargetLock(value.root))

    await expect(foreign.recoverOperation(value.authorization.operationId, new AbortController().signal))
      .rejects.toThrow('operation target lease is owned by a live Host')

    expect((await value.operations.load(value.authorization.operationId))?.journal.events).toHaveLength(beforeEvents)
    expect(value.provider.observedPhases).toEqual([])
    expect(value.provider.rollbackMutations).toBe(0)
    expect(await value.locks.list()).toEqual([beforeOwner])
  })

  it('single-flights explicit recovery before the first provider call completes', async () => {
    const value = await fixture()
    await append(value, transitionOperation(value.journal, 'staging', null, null, Date.now()))
    await snapshot(value)
    await append(value, transitionOperation(value.journal, 'applying', null, null, Date.now()))
    await append(value, transitionOperation(value.journal, 'rolling-back', null, null, Date.now()))
    await append(value, transitionOperation(value.journal, 'recovery-required', null, 'rollback-failed', Date.now()))
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    value.provider.recoverStarted = () => { started.resolve() }
    value.provider.recoverGate = gate.promise

    const first = value.runner.recoverOperation(value.authorization.operationId, new AbortController().signal)
    await started.promise
    await expect(value.runner.recoverOperation(value.authorization.operationId, new AbortController().signal))
      .rejects.toThrow('operation recovery is already in progress')
    gate.resolve()

    await expect(first).resolves.toMatchObject({ status: 'rolled-back' })
    expect(value.provider.observedPhases).toEqual(['recovery-required'])
    expect(value.provider.rollbackMutations).toBe(1)
    expect(await value.locks.list()).toEqual([])
  })

  it('stops an explicit lifecycle recovery before a retired owner can mutate', async () => {
    const value = await fixture()
    await append(value, transitionOperation(value.journal, 'staging', null, null, Date.now()))
    await snapshot(value)
    await append(value, transitionOperation(value.journal, 'applying', null, null, Date.now()))
    await append(value, transitionOperation(value.journal, 'rolling-back', null, null, Date.now()))
    await append(value, transitionOperation(value.journal, 'recovery-required', null, 'rollback-failed', Date.now()))
    const initialEvents = value.journal.events.length
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    value.provider.rollbackStarted = () => { started.resolve() }
    value.provider.rollbackGate = gate.promise
    const controller = new AbortController()

    const recovery = value.runner.recoverOperation(value.authorization.operationId, controller.signal)
    await started.promise
    controller.abort(new Error('Host owner generation retired'))
    gate.resolve()

    await expect(recovery).rejects.toThrow('Host owner generation retired')
    const loaded = await value.operations.load(value.authorization.operationId)
    expect(loaded?.projection.phase).toBe('rolling-back')
    expect(loaded?.journal.events).toHaveLength(initialEvents + 1)
    expect(value.provider.rollbackMutations).toBe(0)
    expect(await value.locks.list()).toHaveLength(1)
  })

  it('resumes an interrupted rolling-back journal without replaying verification or commit', async () => {
    const value = await fixture()
    await append(value, transitionOperation(value.journal, 'staging', null, null, Date.now()))
    await snapshot(value)
    await append(value, transitionOperation(value.journal, 'applying', null, null, Date.now()))
    await append(value, recordOperationMutation(value.journal, canonicalSha256({ observed: true }), Date.now()))
    await append(value, transitionOperation(value.journal, 'rolling-back', null, null, Date.now()))

    await value.runner.recover(new AbortController().signal)

    const loaded = await value.operations.load(value.authorization.operationId)
    expect(loaded?.projection).toMatchObject({ phase: 'rolled-back', receipt: { body: { outcome: 'rolled-back' } } })
    expect(loaded?.projection.verificationDigests).toEqual([])
    expect(await value.locks.list()).toEqual([])
  })

  it('keeps a managed Plugin rollback locked until Host rehydration proves the restored Loader state', async () => {
    const value = await pluginRestartFixture()

    await value.runner.recover(new AbortController().signal)

    expect(value.provider.rollbackCalls).toBe(1)
    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolling-back',
      receipt: null,
    })
    expect(await value.locks.list()).toHaveLength(1)

    value.provider.rehydrated.add(`managed-rollback:${value.operationId}`)
    await value.runner.recover(new AbortController().signal)

    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })
    expect(value.provider.finalized).toBe(1)
    expect(await value.locks.list()).toEqual([])
  })

  it('reconciles an exact break-glass Center before-state into the journal without replaying mutation', async () => {
    const value = await pluginRestartFixture()
    let journal = (await value.operations.load(value.operationId))!.journal
    journal = transitionOperation(journal, 'rolling-back', null, null, Date.now())
    await value.operations.persist(journal)
    journal = transitionOperation(journal, 'recovery-required', null, 'rollback-failed', Date.now())
    await value.operations.persist(journal)

    await value.runner.recover(new AbortController().signal)
    expect((await value.operations.load(value.operationId))?.projection.phase).toBe('recovery-required')
    expect((await value.runner.list()).find(item => item.operationId === value.operationId)).toMatchObject({
      recoveryCommand: [TEST_RECOVERY_EXECUTABLE_BINDING.executablePath, value.root, value.operationId],
      recoveryNotice: 'journal-reconciliation-pending',
    })

    value.provider.centerStateRestored = true
    await value.runner.recover(new AbortController().signal)
    expect((await value.operations.load(value.operationId))?.projection.phase).toBe('rolling-back')
    expect((await value.runner.list()).find(item => item.operationId === value.operationId)).toMatchObject({
      recoveryCommand: null,
      recoveryNotice: null,
    })
    expect(value.provider.rollbackCalls).toBe(0)

    value.provider.rehydrated.add(`managed-rollback:${value.operationId}`)
    await value.runner.recover(new AbortController().signal)
    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })
    expect(value.provider.reconciliationCalls).toBe(2)
    expect(await value.locks.list()).toEqual([])
  })

  it('releases a rolled-back Plugin after proof deletion crashes behind a durable receipt', async () => {
    const value = await pluginRestartFixture()
    await value.runner.recover(new AbortController().signal)
    value.provider.rehydrated.add(`managed-rollback:${value.operationId}`)
    value.provider.finalizeFailures = 1
    const entry = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'plugin')!
    await value.state.putManaged({
      schemaVersion: 1,
      kind: 'plugin',
      extensionId: entry.name,
      targetKey: value.targetKey,
      scopeKey: 'profile:web',
      profileId: value.profileId,
      revision: 1,
      lastOperationId: value.operationId,
      current: null,
      lastGood: null,
      removed: {
        candidateRef: entry.candidateRef,
        artifactRevision: entry.artifact.version,
        artifactIntegrity: entry.artifact.integrity,
        materialPath: join(
          value.root,
          'material',
          'plugins',
          createHash('sha256').update(value.targetKey).digest('hex'),
          createHash('sha256').update(entry.artifact.integrity).digest('hex'),
        ),
        configuration: {},
        enabled: true,
        ownerRevision: 'managed-plugin:1:managed-restored-absent',
        kindState: {
          packageName: entry.artifact.id,
          restartToken: 'managed:restored-absent',
          treeDigest: canonicalSha256({ managed: 'restored-absent' }),
          loaderPhase: 'absent',
          consumerObserved: true,
          restartObserved: true,
          runtimeEvidence: {
            entryId: entry.artifact.id,
            moduleName: entry.artifact.id,
            fiberPhase: 'absent',
          },
        },
      },
      pending: null,
      updatedAtMs: Date.now(),
    }, 0)

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()
    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })
    expect(value.provider.finalized).toBe(1)
    expect(value.provider.proofReleased).toBe(true)
    expect(await value.locks.list()).toHaveLength(1)

    await rm(join(value.root, 'state', 'intents', `${storageKey(value.intentId)}.json`))

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()
    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })
    expect(value.provider.finalized).toBe(1)
    expect(await value.locks.list()).toEqual([])
  })

  it('releases a durable non-null Plugin rollback without its intent or provider replay', async () => {
    const value = await pluginRestartFixture(true)
    await persistRolledBackReceipt(value.operations, value.operationId, value.beforeDigest)
    await rm(join(value.root, 'state', 'intents', `${storageKey(value.intentId)}.json`))

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()

    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back', beforeDigest: value.beforeDigest } },
    })
    expect(value.provider.recoverCalls).toBe(0)
    expect(value.provider.proofReleased).toBe(true)
    expect(await value.locks.list()).toEqual([])
  })

  it('retains the Plugin target lock when durable snapshot and managed state do not match', async () => {
    const value = await pluginRestartFixture(true)
    await persistRolledBackReceipt(value.operations, value.operationId, value.beforeDigest)
    value.provider.durableStateMatches = false

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()

    expect(value.provider.recoverCalls).toBe(0)
    expect(value.provider.proofReleased).toBe(false)
    expect(await value.locks.list()).toEqual([expect.objectContaining({
      operationId: value.operationId,
      targetKey: value.targetKey,
    })])
  })

  it('keeps a receipt-less rolled-back Plugin locked while restored provider proof is unavailable', async () => {
    const value = await pluginRestartFixture()
    let journal = (await value.operations.load(value.operationId))!.journal
    journal = transitionOperation(journal, 'rolling-back', null, null, Date.now())
    await value.operations.persist(journal)
    journal = transitionOperation(journal, 'rolled-back', canonicalSha256(null), null, Date.now())
    await value.operations.persist(journal)
    value.provider.rollbackRestartRequired = true
    value.provider.recoveryUnavailable = true

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()

    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: null,
    })
    expect(value.provider.finalized).toBe(0)
    expect(await value.locks.list()).toHaveLength(1)

    value.provider.recoveryUnavailable = false
    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()

    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back', beforeDigest: canonicalSha256(null) } },
    })
    expect(value.provider.finalized).toBe(1)
    expect(await value.locks.list()).toEqual([])
  })

  it('terminates a pre-mutation provider-request failure and permits the next exact target plan', async () => {
    const value = await runFixture()
    const first = await approvedRunPlan({ root: value.root, state: value.state, plans: value.plans, suffix: 'missing-intent', persistIntent: false })
    setRunContext(value.runner, first.context)

    await expect(value.runner.run(first.plan.hash, new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      receipt: { body: { outcome: 'failed' } },
    })
    expect(await value.locks.list()).toEqual([])

    const second = await approvedRunPlan({ root: value.root, state: value.state, plans: value.plans, suffix: 'after-request-failure', persistIntent: true })
    setRunContext(value.runner, second.context)
    await expect(value.runner.run(second.plan.hash, new AbortController().signal)).resolves.toMatchObject({
      status: 'committed',
      receipt: { body: { outcome: 'committed' } },
    })
    expect(await value.locks.list()).toEqual([])
  })

  it('executes a consumed management plan from its inventory-bound authority digest', async () => {
    const value = await runFixture()
    const approved = await approvedRunPlan({
      root: value.root,
      state: value.state,
      plans: value.plans,
      suffix: 'inventory-authority-disable',
      persistIntent: true,
      operationKind: 'disable',
    })
    setRunContext(value.runner, approved.context)

    await expect(value.runner.run(approved.plan.hash, new AbortController().signal)).resolves.toMatchObject({
      status: 'committed',
      receipt: { body: { outcome: 'committed', operationKind: 'disable' } },
    })
    expect(await value.locks.list()).toEqual([])
  })

  it('terminates an observe failure before mutation and permits the next exact target plan', async () => {
    const value = await runFixture()
    const first = await approvedRunPlan({ root: value.root, state: value.state, plans: value.plans, suffix: 'observe-failure', persistIntent: true })
    setRunContext(value.runner, first.context)
    value.provider.observeFailures = 1

    await expect(value.runner.run(first.plan.hash, new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      receipt: { body: { outcome: 'failed' } },
    })
    expect(await value.locks.list()).toEqual([])

    const second = await approvedRunPlan({ root: value.root, state: value.state, plans: value.plans, suffix: 'after-observe-failure', persistIntent: true })
    setRunContext(value.runner, second.context)
    await expect(value.runner.run(second.plan.hash, new AbortController().signal)).resolves.toMatchObject({ status: 'committed' })
    expect(await value.locks.list()).toEqual([])
  })

  it('cleans staged state before commit and rolls back without a committed receipt when cleanup fails', async () => {
    const value = await runFixture()
    const approved = await approvedRunPlan({
      root: value.root,
      state: value.state,
      plans: value.plans,
      suffix: 'cleanup-before-commit',
      persistIntent: true,
    })
    setRunContext(value.runner, approved.context)
    value.provider.cleanupFailures = 1

    await expect(value.runner.run(approved.plan.hash, new AbortController().signal)).resolves.toMatchObject({
      status: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })

    const [loaded] = await value.operations.list()
    expect(loaded?.journal.events.some(event => (
      event.entry.type === 'phase-transition' && event.entry.to === 'committed'
    ))).toBe(false)
    expect(loaded?.journal.events).toContainEqual(expect.objectContaining({
      entry: expect.objectContaining({
        type: 'phase-transition',
        to: 'rolling-back',
        reason: 'cleanup-failed',
      }),
    }))
    expect(value.provider.cleanupCalls).toBe(1)
    expect(value.provider.rollbackCalls).toBe(1)
    expect(await value.locks.list()).toEqual([])
  })

  it('rolls back an applied result that invents restart authority absent from the plan', async () => {
    const value = await runFixture()
    const approved = await approvedRunPlan({
      root: value.root,
      state: value.state,
      plans: value.plans,
      suffix: 'provider-restart-drift',
      persistIntent: true,
    })
    setRunContext(value.runner, approved.context)
    value.provider.appliedRestartRequired = true
    value.provider.appliedRestartToken = 'invented-restart'

    await expect(value.runner.run(approved.plan.hash, new AbortController().signal)).resolves.toMatchObject({
      status: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })
    expect(value.provider.rollbackCalls).toBe(1)
    const [loaded] = await value.operations.list()
    expect(loaded?.projection.completedReviewPhases).not.toContain('external-restart')
    expect(await value.locks.list()).toEqual([])
  })

  it('finishes a failed Plugin configure by verified same-Host rollback without restart evidence', async () => {
    const plugin = new LiveRollbackPluginProvider()
    const value = await runFixture(undefined, plugin)
    const approved = await approvedRunPlan({
      root: value.root,
      state: value.state,
      plans: value.plans,
      suffix: 'plugin-configure-live-rollback',
      persistIntent: true,
      kind: 'plugin',
      configuration: { maxResults: 4 },
    })
    setRunContext(value.runner, approved.context)

    await expect(value.runner.run(approved.plan.hash, new AbortController().signal)).resolves.toMatchObject({
      status: 'rolled-back',
      receipt: {
        body: {
          outcome: 'rolled-back',
          planEvidence: { restartRequired: false },
        },
      },
    })
    expect(plugin.rollbackCalls).toBe(1)
    expect(plugin.finalizeCalls).toBe(1)
    expect(plugin.restartTokens).toEqual([null, null])
    const [loaded] = await value.operations.list()
    expect(loaded?.projection.completedReviewPhases).not.toContain('external-restart')
    expect(await value.locks.list()).toEqual([])
  })

  it('keeps a direct Plugin rollback locked when proof deletion crashes after the terminal receipt', async () => {
    const plugin = new LiveRollbackPluginProvider()
    const value = await runFixture(undefined, plugin)
    const approved = await approvedRunPlan({
      root: value.root,
      state: value.state,
      plans: value.plans,
      suffix: 'plugin-configure-finalize-failure',
      persistIntent: true,
      kind: 'plugin',
      configuration: { maxResults: 4 },
    })
    setRunContext(value.runner, approved.context)
    plugin.finalizeFailures = 1

    await expect(value.runner.run(approved.plan.hash, new AbortController().signal)).resolves.toMatchObject({
      status: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })

    const [interrupted] = await value.operations.list()
    expect(interrupted?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })
    expect(await value.operations.listReceipts()).toHaveLength(1)
    expect(plugin.finalizeCalls).toBe(1)
    expect(plugin.rollbackCalls).toBe(1)
    expect(await value.locks.list()).toEqual([expect.objectContaining({
      operationId: interrupted!.projection.operationId,
      targetKey: interrupted!.projection.targetKey,
    })])

    setRunContext(value.runner, undefined)
    const recoverCallsBeforeTerminalRepair = plugin.recoverCalls
    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()
    const [recovered] = await value.operations.list()
    expect(recovered?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })
    expect(plugin.finalizeCalls).toBe(1)
    expect(plugin.rollbackCalls).toBe(1)
    expect(plugin.recoverCalls).toBe(recoverCallsBeforeTerminalRepair)
    expect(await value.locks.list()).toEqual([])
  })

  it('keeps an error-path cleanup failure durable and fenced when mutation recovery is unavailable', async () => {
    const value = await runFixture()
    const approved = await approvedRunPlan({
      root: value.root,
      state: value.state,
      plans: value.plans,
      suffix: 'error-cleanup-failure',
      persistIntent: true,
    })
    setRunContext(value.runner, approved.context)
    value.provider.applyError = new Error('simulated apply failure')
    value.provider.cleanupFailures = 1

    await expect(value.runner.run(approved.plan.hash, new AbortController().signal)).resolves.toMatchObject({
      status: 'recovery-required',
      receipt: null,
    })

    const [loaded] = await value.operations.list()
    expect(loaded?.projection).toMatchObject({ phase: 'recovery-required', receipt: null })
    expect(loaded?.journal.events).toContainEqual(expect.objectContaining({
      entry: expect.objectContaining({
        type: 'phase-transition',
        to: 'rolling-back',
        reason: 'cleanup-failed',
      }),
    }))
    expect(loaded?.journal.events.some(event => (
      event.entry.type === 'phase-transition' && event.entry.to === 'committed'
    ))).toBe(false)
    expect(value.provider.cleanupCalls).toBe(1)
    expect(value.provider.recoverCalls).toBe(1)
    expect(await value.locks.list()).toHaveLength(1)
  })

  it('parks an ambiguous official Profile mutation without provider recovery or rollback', async () => {
    const value = await runFixture()
    const approved = await approvedRunPlan({
      root: value.root,
      state: value.state,
      plans: value.plans,
      suffix: 'profile-ambiguity',
      persistIntent: true,
    })
    setRunContext(value.runner, approved.context)
    value.provider.applyError = new OfficialProfileAmbiguityError('simulated official Profile ambiguity')

    await expect(value.runner.run(approved.plan.hash, new AbortController().signal)).resolves.toMatchObject({
      status: 'recovery-required',
      receipt: null,
    })

    const [loaded] = await value.operations.list()
    expect(loaded?.projection.phase).toBe('recovery-required')
    expect(loaded?.journal.events.at(-1)?.entry).toMatchObject({
      type: 'phase-transition',
      to: 'recovery-required',
      reason: 'profile-state-ambiguous',
    })
    expect(value.provider.recoverCalls).toBe(0)
    expect(value.provider.rollbackCalls).toBe(0)
    expect(await value.locks.list()).toHaveLength(1)
  })

  it('recovers a consumed plan from its durable reservation after the initial journal write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-initial-journal-'))
    roots.push(root)
    const operations = new FailOnceInitialOperationStore(root)
    const value = await runFixture(operations)
    const first = await approvedRunPlan({ root, state: value.state, plans: value.plans, suffix: 'journal-failure', persistIntent: true })
    setRunContext(value.runner, first.context)
    operations.failInitialWrites = 1

    await expect(value.runner.run(first.plan.hash, new AbortController().signal)).rejects.toThrow('simulated initial journal failure')
    const [reservation] = await operations.listReservations()
    expect(reservation).toMatchObject({ planHash: first.plan.hash, targetKey: first.plan.content.targetKey })
    expect(await value.locks.list()).toMatchObject([{ operationId: reservation!.operationId }])

    const second = await approvedRunPlan({ root, state: value.state, plans: value.plans, suffix: 'after-journal-failure', persistIntent: true })
    setRunContext(value.runner, second.context)
    await expect(value.runner.run(second.plan.hash, new AbortController().signal)).rejects.toThrow('target is busy')

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()
    expect(await operations.listReservations()).toEqual([])
    expect((await operations.load(reservation!.operationId))?.projection).toMatchObject({
      phase: 'failed',
      receipt: { body: { outcome: 'failed', evidence: { mutation: 'not-required', verification: 'not-required' } } },
    })
    expect(await value.locks.list()).toEqual([])

    await expect(value.runner.run(second.plan.hash, new AbortController().signal)).resolves.toMatchObject({ status: 'committed' })
    expect(await value.locks.list()).toEqual([])
  })

  it('continues from an exact durable consumption when the final consumption fsync reports an ambiguous failure', async () => {
    let plans!: AmbiguousConsumePlanStore
    const value = await runFixture(undefined, undefined, (root) => {
      plans = new AmbiguousConsumePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
      return plans
    })
    const approved = await approvedRunPlan({
      root: value.root,
      state: value.state,
      plans: value.plans,
      suffix: 'ambiguous-consumption',
      persistIntent: true,
    })
    setRunContext(value.runner, approved.context)
    plans.failAfterDurableConsumption = 1

    await expect(value.runner.run(approved.plan.hash, new AbortController().signal)).resolves.toMatchObject({
      status: 'committed',
      receipt: { body: { outcome: 'committed' } },
    })

    expect(await plans.load(approved.plan.hash)).toMatchObject({ status: 'consumed' })
    expect(await value.operations.listReservations()).toEqual([])
    expect(await value.locks.list()).toEqual([])
  })

  it('releases a failed receipt after a crash even when its durable intent remains absent', async () => {
    let locks!: FailOnceReleaseTargetLock
    const value = await runFixture(undefined, undefined, undefined, (root) => {
      locks = new FailOnceReleaseTargetLock(root)
      return locks
    })
    const approved = await approvedRunPlan({
      root: value.root,
      state: value.state,
      plans: value.plans,
      suffix: 'missing-intent-terminal-release',
      persistIntent: false,
    })
    setRunContext(value.runner, approved.context)
    locks.failReleases = 1

    await expect(value.runner.run(approved.plan.hash, new AbortController().signal)).rejects.toThrow(
      'simulated crash before target lock release',
    )
    const [beforeRecovery] = await value.operations.list()
    expect(beforeRecovery?.projection).toMatchObject({
      phase: 'failed',
      receipt: { body: { outcome: 'failed' } },
    })
    expect(await locks.list()).toHaveLength(1)

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()

    expect((await value.operations.load(beforeRecovery!.projection.operationId))?.projection.receipt?.digest)
      .toBe(beforeRecovery!.projection.receipt?.digest)
    expect(value.provider.recoverCalls).toBe(0)
    expect(await locks.list()).toEqual([])
  })
})
