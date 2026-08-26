import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { verifyBootstrapCatalog } from '../src/catalog.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { ArtifactFetcher, CenterStateStore, FileTargetLock } from '../src/host/index.ts'
import {
  createOperationJournal,
  recordOperationMutation,
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
import { mintAcquisitionIntent, verificationRecipeDigest } from '../src/policy/index.ts'
import type {
  AppliedProviderOperation,
  LifecycleProvider,
  PreparedProviderOperation,
  ProviderOperationRequest,
} from '../src/providers/index.ts'
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
      restartRequired: false,
      profileGeneration: null,
      rollbackRestart: false,
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
  generation = 'generation:candidate'
  rollbackRestart = false
  candidateConsumerAvailable = false
  readonly booted = new Set<string>(['generation:candidate'])
  rollbackCalls = 0
  breakGlassRestored = false
  reconciliationCalls = 0
  finalized = 0
  finalizeFailures = 0

  observe(): Promise<null> { return Promise.resolve(null) }
  prepare(): Promise<PreparedProviderOperation> { throw new Error('not used') }
  recoveryPoint(): null { return null }
  apply(): Promise<AppliedProviderOperation> { throw new Error('not used') }

  recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation> {
    const prepared: PreparedProviderOperation = {
      request,
      before: null,
      beforeDigest: canonicalSha256(null),
      stagingPath: null,
      prepared: null,
    }
    return Promise.resolve(Object.freeze({
      prepared,
      mutationDigest: canonicalSha256({ operationId: request.authorization.operationId, generation: this.generation }),
      afterDigest: canonicalSha256({ generation: this.generation }),
      restartRequired: true,
      profileGeneration: this.generation,
      rollbackRestart: this.rollbackRestart,
    }))
  }

  reconcileBreakGlassRestore(
    request: ProviderOperationRequest,
    expectedBeforeDigest: `sha256:${string}`,
  ): Promise<AppliedProviderOperation | null> {
    this.reconciliationCalls += 1
    if (expectedBeforeDigest !== canonicalSha256(null)) throw new Error('unexpected journal before digest')
    if (!this.breakGlassRestored) return Promise.resolve(null)
    const review = request.plan.reviewEvidence
    if (review.kind !== 'plugin' || review.rollbackPoint.kind !== 'profile-generation') {
      throw new Error('missing recovery pin')
    }
    this.generation = review.rollbackPoint.id
    this.rollbackRestart = true
    return this.recover(request)
  }

  async bootReady(input: Readonly<{ generation: string }>): Promise<boolean> {
    return this.booted.has(input.generation)
  }

  async acknowledgeBoot(input: Readonly<{ generation: string }>): Promise<void> {
    if (input.generation === 'generation:candidate' && !this.candidateConsumerAvailable) {
      throw new Error('candidate Loader consumer is absent')
    }
  }

  verify(applied: AppliedProviderOperation) {
    return Promise.resolve({ digest: canonicalSha256({ verified: applied.profileGeneration }) })
  }

  rollback(applied: AppliedProviderOperation) {
    this.rollbackCalls += 1
    this.generation = 'generation:rollback'
    this.rollbackRestart = true
    return Promise.resolve(applied.prepared.beforeDigest)
  }

  finalizeRollback(): Promise<void> {
    this.finalized += 1
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
    return Promise.resolve(Object.freeze({
      prepared,
      mutationDigest: canonicalSha256({ operationId: prepared.request.authorization.operationId, mutation: true }),
      afterDigest: canonicalSha256({ operationId: prepared.request.authorization.operationId, after: true }),
      restartRequired: false,
      profileGeneration: null,
      rollbackRestart: false,
    }))
  }

  verify(applied: AppliedProviderOperation) {
    return Promise.resolve({ digest: canonicalSha256({ verified: applied.afterDigest }) })
  }

  rollback(applied: AppliedProviderOperation) { return Promise.resolve(applied.prepared.beforeDigest) }
  recover(): Promise<null> { return Promise.resolve(null) }
  cleanup(): Promise<void> { return Promise.resolve() }
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

interface Fixture {
  readonly state: CenterStateStore
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
    authorityDigest: canonicalSha256({ root, authority: true }),
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
    authorityDeltaDigest: plan.content.authorityDigest,
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
    () => catalog,
  )
  const journal = createOperationJournal(consumed.authorization, canonicalSha256(null), createdAtMs + 3)
  await operations.persist(journal)
  return { state, operations, locks, provider, runner, plan, authorization: consumed.authorization, journal }
}

async function append(value: Fixture, next: OperationJournal): Promise<void> {
  await value.operations.persist(next)
  value.journal = next
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

async function pluginRestartFixture(): Promise<Readonly<{
  root: string
  state: CenterStateStore
  runner: OperationRunner
  provider: RestartingPluginProvider
  operations: FileOperationStore
  locks: FileTargetLock
  operationId: string
  profileId: string
  generation: string
  targetKey: string
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
    ownerKey: 'profileTransactions',
    scopeKey: 'profile:web',
    profileId,
    idempotencyKey: canonicalSha256({ root, pluginIdempotency: true }),
    authorityDigest: canonicalSha256({ root, pluginAuthority: true }),
    configurationDigest: canonicalSha256({}),
    retentionDigest: canonicalSha256({ candidateRef: entry.candidateRef, retainedData: entry.retainedData }),
    reviewEvidence: testReviewEvidence('plugin', 'install', {
      generation: 'generation:rollback',
      treeDigest: canonicalSha256({ root, pluginRollbackTree: true }),
    }),
    mutationDigest: canonicalSha256({ root, pluginMutation: true }),
    verificationDigest: verificationRecipeDigest('plugin', 'install', 'enabled'),
    restartRequired: entry.restart.required,
    createdAtMs,
    expiresAtMs: createdAtMs + 60_000,
    fences: {
      catalogRevision: catalog.envelope.revision,
      inventoryRevision: canonicalSha256({ root, pluginInventory: true }),
      targetRevision: 'absent',
      ownerRevision: 'profile:0:tree:live',
      scopeRevision: canonicalSha256({ root, pluginScope: true }),
      profileRevision: 'profile:0:tree:live',
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
      authorityDeltaDigest: plan.content.authorityDigest,
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
  let journal = createOperationJournal(consumed.authorization, canonicalSha256(null), createdAtMs + 3)
  await operations.persist(journal)
  journal = transitionOperation(journal, 'staging', null, null, createdAtMs + 4)
  await operations.persist(journal)
  await state.putProviderSnapshot({
    schemaVersion: 1,
    operationId,
    targetKey,
    before: null,
    beforeDigest: canonicalSha256(null),
    recoveryPoint: {
      kind: 'plugin',
      snapshot: {
        profile: profileId,
        revision: 0,
        treeDigest: 'tree:live',
        effectivePath: root,
        activeGeneration: null,
        lastGoodGeneration: 'generation:rollback',
        rollbackGeneration: null,
        bootStatus: 'live',
      },
      configurationPatch: null,
      artifactPath: null,
    },
  })
  journal = transitionOperation(journal, 'applying', null, null, createdAtMs + 5)
  await operations.persist(journal)
  journal = recordOperationMutation(journal, canonicalSha256({ generation: 'generation:candidate' }), createdAtMs + 6)
  await operations.persist(journal)
  journal = transitionOperation(journal, 'verifying', null, null, createdAtMs + 7)
  await operations.persist(journal)
  const provider = new RestartingPluginProvider()
  const runner = new OperationRunner(
    state,
    plans,
    operations,
    locks,
    new ArtifactFetcher(root, { maximumRedirects: 0, allowedCrossOriginHosts: [] }),
    { context: () => Promise.resolve(context) } as never,
    { plugin: provider, mcp: provider, skill: provider },
    () => catalog,
  )
  return { root, state, runner, provider, operations, locks, operationId, profileId, generation: provider.generation, targetKey }
}

async function approvedRunPlan(input: Readonly<{
  root: string
  state: CenterStateStore
  plans: FilePlanStore
  suffix: string
  persistIntent: boolean
}>): Promise<Readonly<{ plan: ImmutablePlan; context: PlanUseContext }>> {
  const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
  const entry = catalog.envelope.entries.find(candidate => candidate.kind === 'skill')!
  const createdAtMs = Date.now() - 1_000
  const targetKey = `skill:web:user:${entry.name}`
  const inventoryRevision = canonicalSha256({ root: input.root, inventory: 'run' })
  const plan = createImmutablePlan({
    schemaVersion: 1,
    singleUse: true,
    planId: `plan:run-${input.suffix}`,
    intentId: `intent:run-${input.suffix}`,
    origin: 'store',
    candidateRef: entry.candidateRef,
    extensionKind: 'skill',
    extensionId: entry.name,
    managedObject: 'artifact',
    externalRuntimeAction: 'none',
    runtimeBinding: null,
    artifactRevision: entry.artifact.version,
    artifactIntegrity: entry.artifact.integrity,
    artifactUrl: entry.artifact.acquisitionUrl,
    artifactSizeBytes: entry.artifact.sizeBytes,
    operationKind: 'configure',
    desiredState: 'enabled',
    targetKey,
    ownerKey: 'skills',
    scopeKey: 'user',
    profileId: 'web',
    idempotencyKey: canonicalSha256({ root: input.root, idempotency: input.suffix }),
    authorityDigest: canonicalSha256({ root: input.root, authority: input.suffix }),
    configurationDigest: canonicalSha256({ modelInvocable: true, userInvocable: true, projectRoot: null }),
    retentionDigest: canonicalSha256({ candidateRef: entry.candidateRef, retainedData: entry.retainedData }),
    reviewEvidence: testReviewEvidence('skill', 'configure'),
    mutationDigest: canonicalSha256({ root: input.root, mutation: input.suffix }),
    verificationDigest: verificationRecipeDigest('skill', 'configure', 'enabled'),
    restartRequired: entry.restart.required,
    createdAtMs,
    expiresAtMs: createdAtMs + 60_000,
    fences: {
      catalogRevision: catalog.envelope.revision,
      inventoryRevision,
      targetRevision: 'absent',
      ownerRevision: 'skills:empty',
      scopeRevision: canonicalSha256({ root: input.root, scope: 'run' }),
      profileRevision: 'profile:0:tree',
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
        kind: 'skill',
        extensionId: entry.name,
        candidateRef: entry.candidateRef,
        artifactRevision: entry.artifact.version,
        artifactIntegrity: entry.artifact.integrity,
        artifactUrl: entry.artifact.acquisitionUrl,
        artifactSizeBytes: entry.artifact.sizeBytes,
        scopeKey: 'user',
        profileId: 'web',
        operationKind: 'configure',
        desiredState: 'enabled',
        admittedCapabilities: [],
        authorityDeltaDigest: plan.content.authorityDigest,
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
        configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
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

async function runFixture(operationStore?: FileOperationStore): Promise<Readonly<{
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
  const plans = new FilePlanStore(root, TEST_RECOVERY_EXECUTABLE_BINDING)
  const operations = operationStore ?? new FileOperationStore(root)
  const locks = new FileTargetLock(root)
  const provider = new RunProvider()
  const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
  let activeContext: PlanUseContext | undefined
  const runner = new OperationRunner(
    state,
    plans,
    operations,
    locks,
    new ArtifactFetcher(root, { maximumRedirects: 0, allowedCrossOriginHosts: [] }),
    { context: () => activeContext === undefined ? Promise.reject(new Error('missing context')) : Promise.resolve(activeContext) } as never,
    { plugin: provider, mcp: provider, skill: provider },
    () => catalog,
  )
  Object.defineProperty(runner, '__setContext', { value: (value: PlanUseContext) => { activeContext = value } })
  return { root, state, plans, operations, locks, provider, runner }
}

function setRunContext(runner: OperationRunner, context: PlanUseContext): void {
  ;(runner as unknown as { __setContext(value: PlanUseContext): void }).__setContext(context)
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

    await value.runner.recover(new AbortController().signal)

    const loaded = await value.operations.load(value.authorization.operationId)
    expect(value.provider.observedPhases).toEqual(['applying'])
    expect(loaded?.projection).toMatchObject({ phase: 'committed', receipt: { body: { outcome: 'committed' } } })
    expect(await value.locks.list()).toEqual([])
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

  it('keeps a Plugin rollback generation locked until the next boot proves the prior consumer', async () => {
    const value = await pluginRestartFixture()

    await value.runner.recover(new AbortController().signal)

    expect(value.provider.rollbackCalls).toBe(1)
    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolling-back',
      receipt: null,
    })
    expect(await value.locks.list()).toHaveLength(1)

    value.provider.booted.add('generation:rollback')
    await value.runner.recover(new AbortController().signal)

    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })
    expect(value.provider.finalized).toBe(1)
    expect(await value.locks.list()).toEqual([])
  })

  it('reconciles an exact break-glass Profile pin into the journal without replaying restore', async () => {
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

    value.provider.breakGlassRestored = true
    await value.runner.recover(new AbortController().signal)
    expect((await value.operations.load(value.operationId))?.projection.phase).toBe('rolling-back')
    expect((await value.runner.list()).find(item => item.operationId === value.operationId)).toMatchObject({
      recoveryCommand: null,
      recoveryNotice: null,
    })
    expect(value.provider.rollbackCalls).toBe(0)

    value.provider.booted.add('generation:rollback')
    await value.runner.recover(new AbortController().signal)
    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })
    expect(value.provider.reconciliationCalls).toBe(2)
    expect(await value.locks.list()).toEqual([])
  })

  it('retries Plugin rollback finalization after the rolled-back journal survives a kill', async () => {
    const value = await pluginRestartFixture()
    await value.runner.recover(new AbortController().signal)
    value.provider.booted.add('generation:rollback')
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
        materialPath: value.root,
        configuration: {},
        enabled: true,
        ownerRevision: 'profile:1:tree:rollback',
        kindState: {
          packageName: entry.artifact.id,
          profileGeneration: 'generation:rollback',
          treeDigest: 'tree:rollback',
          loaderPhase: 'absent',
          consumerObserved: true,
          externalRestartObserved: true,
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
      receipt: null,
    })
    expect(value.provider.finalized).toBe(1)
    expect(await value.locks.list()).toHaveLength(1)

    await expect(value.runner.recover(new AbortController().signal)).resolves.toBeUndefined()
    expect((await value.operations.load(value.operationId))?.projection).toMatchObject({
      phase: 'rolled-back',
      receipt: { body: { outcome: 'rolled-back' } },
    })
    expect(value.provider.finalized).toBe(2)
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
})
