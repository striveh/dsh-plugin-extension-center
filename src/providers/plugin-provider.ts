import { createHash } from 'node:crypto'
import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type { LoaderOwner, ManagedTargetRecord, ManagedVersion } from '../host/index.ts'
import { CenterStateStore, openRegularNoFollow } from '../host/index.ts'
import {
  ManagedPluginOwner,
  type ManagedPluginActivation,
  type ManagedPluginLoader,
  type ManagedPluginOwnerOptions,
  type ManagedPluginSnapshot,
} from '../internal/plugin/index.ts'
import type { RpcJson } from '../service/rpc-contract.ts'
import {
  decodeProfileMetadataCacheBinding,
  prepareProfileMetadataCache,
  type ProfileMetadataCacheBinding,
} from '../recovery/profile-metadata-cache.ts'
import { inspectNpmArchive } from './npm-archive.ts'
import { validateCapabilityResolverConfiguration } from './plugin-config-adapter.ts'
import { managedStateDigest, nextManagedRecord } from './records.ts'
import type {
  AppliedProviderOperation,
  LifecycleProvider,
  PreparedProviderOperation,
  ProviderOperationRequest,
  ProviderVerification,
} from './types.ts'

export type { ManagedPluginLoader, ManagedPluginOwnerOptions, ManagedPluginSnapshot } from '../internal/plugin/index.ts'

interface PreparedPlugin {
  readonly snapshot: ManagedPluginSnapshot
  readonly materialPath: string | null
  readonly activation: ManagedPluginActivation | null
  readonly metadataCache: ProfileMetadataCacheBinding | null
}

interface PluginRecoveryPoint {
  readonly snapshot: ManagedPluginSnapshot
  readonly artifactPath: string | null
  readonly metadataCache: ProfileMetadataCacheBinding | null
}

/** Loader evidence derived inside the Host after the exact owner row settles. */
export interface PluginRuntimeEvidence {
  readonly entryId: string
  readonly moduleName: string
  readonly fiberPhase: 'active' | 'absent'
}

/** Compatibility observer retained for callers that only need read-only Loader evidence. */
export interface PluginRuntimeProbe {
  observe(packageName: string, operation: ProviderOperationRequest['plan']['operationKind']): Promise<PluginRuntimeEvidence>
}

/** Direct official Loader observer; row ids are Loader-generated and never package identities. */
export class LoaderPluginRuntimeProbe implements PluginRuntimeProbe {
  constructor(private readonly loader: Pick<LoaderOwner, 'entries'>) {}

  async observe(packageName: string, operation: ProviderOperationRequest['plan']['operationKind']): Promise<PluginRuntimeEvidence> {
    const matches = [...this.loader.entries()].filter(entry => !entry.options.group && entry.options.name === packageName)
    if (operation === 'uninstall') {
      if (matches.length !== 0) throw new Error('uninstalled Plugin remains in the settled Loader tree')
      return Object.freeze({ entryId: packageName, moduleName: packageName, fiberPhase: 'absent' })
    }
    if (matches.length !== 1 || matches[0]!.disabled) {
      throw new Error('Plugin target has no unique enabled Loader row')
    }
    const expectedId = matches[0]!.id
    await matches[0]!.refresh()
    const started = [...this.loader.entries()].find(entry => entry.id === expectedId
      && !entry.options.group && entry.options.name === packageName)
    if (started === undefined || started.disabled || started.fiber === undefined) {
      throw new Error('Plugin target did not start in its exact Loader row')
    }
    await started.fiber.await()
    const settled = [...this.loader.entries()].filter(entry => !entry.options.group && entry.options.name === packageName)
    if (settled.length !== 1 || settled[0]!.id !== expectedId
      || settled[0]!.disabled || settled[0]!.fiber?.state !== 2) {
      throw new Error('Plugin target is not ACTIVE in its exact Loader row')
    }
    return Object.freeze({ entryId: settled[0]!.id, moduleName: settled[0]!.options.name, fiberPhase: 'active' })
  }
}

function pending(record: ManagedTargetRecord): Readonly<{
  operationId: string
  activationId: string
  operationKind: ProviderOperationRequest['plan']['operationKind'] | 'rollback'
}> | null {
  const value = record.pending
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('pending managed Plugin mutation is invalid')
  const item = value as Readonly<Record<string, RpcJson>>
  if (typeof item.operationId !== 'string' || typeof item.generation !== 'string'
    || typeof item.operationKind !== 'string'
    || !['install', 'configure', 'update', 'uninstall', 'restore', 'rollback'].includes(item.operationKind)) {
    throw new Error('pending managed Plugin mutation fields are invalid')
  }
  return Object.freeze({
    operationId: item.operationId,
    activationId: item.generation,
    operationKind: item.operationKind as ProviderOperationRequest['plan']['operationKind'] | 'rollback',
  })
}

function pluginState(version: ManagedVersion): Record<string, RpcJson> {
  if (typeof version.kindState !== 'object' || version.kindState === null || Array.isArray(version.kindState)) {
    throw new Error('managed Plugin state is invalid')
  }
  return version.kindState as Record<string, RpcJson>
}

const RUNTIME_STATE_FIELDS = Object.freeze([
  'consumerObserved', 'loaderPhase', 'restartObserved', 'restartToken', 'runtimeEvidence', 'treeDigest',
] as const)

function withoutSettlementEvidence(version: ManagedVersion | null): Readonly<Record<string, unknown>> | null {
  if (version === null) return null
  const kindState = { ...pluginState(version) }
  for (const field of RUNTIME_STATE_FIELDS) delete kindState[field]
  delete kindState.rollbackOperationId
  return immutableJsonClone({ ...version, kindState })
}

function restoredCore(record: ManagedTargetRecord): Readonly<Record<string, unknown>> {
  return immutableJsonClone({
    kind: record.kind,
    extensionId: record.extensionId,
    targetKey: record.targetKey,
    scopeKey: record.scopeKey,
    profileId: record.profileId,
    current: withoutSettlementEvidence(record.current),
    lastGood: withoutSettlementEvidence(record.lastGood),
    removed: withoutSettlementEvidence(record.removed),
    pending: record.pending,
  })
}

function rollbackOperation(record: ManagedTargetRecord, operationId: string): boolean {
  return [record.current, record.removed, record.lastGood].some((version) => {
    if (version === null) return false
    return pluginState(version).rollbackOperationId === operationId
  })
}

function plannedPackageName(request: ProviderOperationRequest): string {
  const review = request.plan.reviewEvidence
  if (review.kind !== 'plugin'
    || review.activation.packageName !== review.manifest.packageName
    || review.managedMaterial.packageName !== review.manifest.packageName) {
    throw new Error('Plugin package identity does not bind the immutable review evidence')
  }
  return review.manifest.packageName
}

function packageName(record: ManagedTargetRecord | null, request: ProviderOperationRequest): string {
  const expected = plannedPackageName(request)
  const version = record?.current ?? record?.removed ?? record?.lastGood
  if (version === null || version === undefined) return expected
  const value = pluginState(version).packageName
  if (typeof value !== 'string' || value !== expected) {
    throw new Error('managed Plugin package identity does not match the immutable plan')
  }
  return value
}

function recoveryPoint(value: RpcJson): PluginRecoveryPoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Plugin recovery point is invalid')
  const input = value as Record<string, RpcJson>
  if (input.kind !== 'plugin' || typeof input.snapshot !== 'object' || input.snapshot === null || Array.isArray(input.snapshot)
    || Object.keys(input).sort().join('\0') !== ['artifactPath', 'kind', 'metadataCache', 'snapshot'].join('\0')
    || (input.artifactPath !== null && typeof input.artifactPath !== 'string')) {
    throw new Error('Plugin recovery point fields are invalid')
  }
  const held = input.snapshot as Record<string, RpcJson>
  const fields = ['bootStatus', 'digest', 'materialRoot', 'ownerRevision', 'profileId', 'revision']
  if (Object.keys(held).sort().join('\0') !== fields.join('\0')
    || typeof held.profileId !== 'string' || !Number.isSafeInteger(held.revision)
    || typeof held.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(held.digest)
    || typeof held.materialRoot !== 'string' || typeof held.ownerRevision !== 'string'
    || !['live', 'pending-restart', 'verified'].includes(held.bootStatus as string)) {
    throw new Error('Plugin owner snapshot fields are invalid')
  }
  const digest = held.digest as `sha256:${string}`
  const ownerRevision = `managed-plugin:${String(held.revision)}:${digest}`
  if (held.ownerRevision !== ownerRevision) throw new Error('Plugin owner snapshot revision is invalid')
  return Object.freeze({
    snapshot: Object.freeze({
      profileId: held.profileId,
      revision: held.revision as number,
      digest,
      materialRoot: held.materialRoot,
      bootStatus: held.bootStatus as ManagedPluginSnapshot['bootStatus'],
      ownerRevision,
    }),
    artifactPath: input.artifactPath as string | null,
    metadataCache: input.metadataCache === null
      ? null
      : decodeProfileMetadataCacheBinding(input.metadataCache, 'Plugin recovery point metadata cache'),
  })
}

async function verifyPackedArtifact(path: string, integrity: string): Promise<void> {
  const separator = integrity.indexOf(':')
  const algorithm = integrity.slice(0, separator)
  const encoded = integrity.slice(separator + 1)
  const hexadecimal = /^[0-9a-f]+$/.test(encoded)
  if (!['sha256', 'sha512'].includes(algorithm)
    || !(hexadecimal || algorithm === 'sha512' && /^[A-Za-z0-9+/]{86}==$/.test(encoded))) {
    throw new Error('Plugin artifact integrity is invalid')
  }
  const handle = await openRegularNoFollow(path)
  const hash = createHash(algorithm)
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
  } finally {
    await handle.close()
  }
  const observed = `${algorithm}:${hash.digest(hexadecimal ? 'hex' : 'base64')}`
  if (observed !== integrity) throw new Error('Plugin recovery artifact does not match the immutable plan integrity')
}

/** Exact Center-owned configuration digest; no official Profile patch is read or changed. */
export function pluginConfigurationMutationDigest(
  configuration: RpcJson,
  ownerRevision: string,
): `sha256:${string}` {
  const value = validateCapabilityResolverConfiguration(configuration)
  return canonicalSha256({ operation: 'configure', configuration: value, ownerRevision })
}

/** Center-owned lifecycle using the official Profile CLI for packages and Loader APIs for runtime configuration. */
export class PluginLifecycleProvider implements LifecycleProvider {
  readonly kind = 'plugin' as const
  private readonly owner: ManagedPluginOwner
  private readonly officialDsh: ManagedPluginOwnerOptions['officialDsh']

  constructor(
    private readonly store: CenterStateStore,
    loader: ManagedPluginLoader,
    options: ManagedPluginOwnerOptions,
  ) {
    this.officialDsh = options.officialDsh
    this.owner = new ManagedPluginOwner(store, loader, options)
  }

  /** Reconcile official Profile packages and Loader rows with Center-owned desired state. */
  initialize(): Promise<void> {
    return this.owner.initialize()
  }

  /** Project the exact Center-owned profile state used by planning fences. */
  snapshot(profileId: string): Promise<ManagedPluginSnapshot> {
    return this.owner.snapshot(profileId)
  }

  async observe(targetKey: string): Promise<ManagedTargetRecord | null> {
    await this.initialize()
    return await this.store.getManaged(targetKey) ?? null
  }

  async prepare(request: ProviderOperationRequest): Promise<PreparedProviderOperation> {
    if (request.plan.operationKind === 'purge') {
      throw new Error('Plugin purge is unavailable while Center recovery material is retained')
    }
    if (['enable', 'disable'].includes(request.plan.operationKind)) {
      throw new Error(`Plugin ${request.plan.operationKind} is unsupported in P0`)
    }
    const expectedPackageName = plannedPackageName(request)
    if (expectedPackageName === 'dsh-plugin-extension-center') {
      throw new Error('the Extension Center cannot manage its own Plugin package')
    }
    const before = await this.observe(request.plan.targetKey)
    const held = await this.snapshot(request.plan.profileId)
    if (request.plan.fences.ownerRevision !== held.ownerRevision
      || request.plan.fences.profileRevision !== held.ownerRevision) {
      throw new Error('managed Plugin owner fence is stale')
    }
    let materialPath: string | null = null
    let activation: ManagedPluginActivation | null = null
    if (request.plan.operationKind === 'install' || request.plan.operationKind === 'update') {
      if (request.artifactPath === null) throw new Error('Plugin install or update requires an acquired archive')
      const inspection = await inspectNpmArchive(request.artifactPath, null)
      if (inspection.name !== expectedPackageName || inspection.version !== request.plan.artifactRevision) {
        throw new Error('Plugin package identity does not match the consumed immutable plan')
      }
      const review = request.plan.reviewEvidence
      if (review.kind !== 'plugin') throw new Error('Plugin plan has no Plugin review evidence')
      const peers = Object.fromEntries(review.dependencies
        .filter(dependency => dependency.kind === 'peer' && dependency.afterVersion !== null)
        .map(dependency => [dependency.id, dependency.afterVersion]))
      const bundle = review.packageMetadata.bundlePatch
      if (inspection.manifestBody !== review.manifest.body
        || inspection.manifestDigest !== review.manifest.manifestDigest
        || inspection.fileManifestDigest !== review.manifest.fileManifestDigest
        || canonicalSha256(inspection.files) !== canonicalSha256(review.manifest.files)
        || canonicalSha256(inspection.scripts) !== canonicalSha256(review.scripts.after)
        || canonicalSha256(inspection.peerDependencies) !== canonicalSha256(peers)
        || inspection.bundlePatch === null || bundle === null
        || inspection.bundlePatch.body !== bundle.patchBody || inspection.bundlePatch.digest !== bundle.patchDigest) {
        throw new Error('Plugin archive does not match the immutable review evidence')
      }
      activation = await this.owner.materialize({
        targetKey: request.plan.targetKey,
        profileId: request.plan.profileId,
        packageName: inspection.name,
        version: inspection.version,
        integrity: request.plan.artifactIntegrity,
        archivePath: request.artifactPath,
        inspection,
      })
      materialPath = activation.materialPath
    } else if (request.plan.operationKind === 'configure') {
      if (before?.current === null || before === null || before.current.candidateRef !== request.plan.candidateRef) {
        throw new Error('Plugin configure requires the exact installed candidate')
      }
      if (pluginConfigurationMutationDigest(request.payload.configuration, held.ownerRevision) !== request.plan.mutationDigest) {
        throw new Error('Plugin configuration mutation does not match the immutable plan digest')
      }
    } else if (request.artifactPath !== null) {
      throw new Error('Plugin operation received an unneeded artifact')
    }
    const metadataCache = this.officialDsh === undefined
      ? null
      : await prepareProfileMetadataCache(this.officialDsh, request.plan.profileId)
    return Object.freeze({
      request,
      before,
      beforeDigest: managedStateDigest(before),
      stagingPath: materialPath,
      prepared: Object.freeze({ snapshot: held, materialPath, activation, metadataCache } satisfies PreparedPlugin),
    })
  }

  recoveryPoint(prepared: PreparedProviderOperation): RpcJson {
    const detail = prepared.prepared as PreparedPlugin
    return immutableJsonClone({
      kind: 'plugin',
      snapshot: detail.snapshot,
      artifactPath: prepared.request.artifactPath,
      metadataCache: detail.metadataCache,
    }) as unknown as RpcJson
  }

  async apply(prepared: PreparedProviderOperation): Promise<AppliedProviderOperation> {
    const detail = prepared.prepared as PreparedPlugin
    const { request } = prepared
    let supplied: ManagedVersion | null = null
    if (request.plan.operationKind === 'install' || request.plan.operationKind === 'update') {
      if (detail.materialPath === null || detail.activation === null) throw new Error('Plugin prepared material is absent')
      supplied = immutableJsonClone({
        candidateRef: request.plan.candidateRef,
        artifactRevision: request.plan.artifactRevision,
        artifactIntegrity: request.plan.artifactIntegrity,
        materialPath: detail.materialPath,
        configuration: request.payload.configuration,
        enabled: true,
        ownerRevision: detail.snapshot.ownerRevision,
        kindState: this.pendingState(request),
      }) as ManagedVersion
    }
    let desired = nextManagedRecord(prepared.before, request, supplied, Date.now())
    if (desired.current !== null && ['configure', 'restore'].includes(request.plan.operationKind)) {
      desired = immutableJsonClone({
        ...desired,
        current: {
          ...desired.current,
          ownerRevision: detail.snapshot.ownerRevision,
          configuration: request.plan.operationKind === 'configure'
            ? request.payload.configuration
            : desired.current.configuration,
          kindState: this.pendingState(request),
        },
      }) as ManagedTargetRecord
    }
    const activationId = `managed:${request.authorization.operationId}`
    desired = immutableJsonClone({
      ...desired,
      pending: {
        operationId: request.authorization.operationId,
        generation: activationId,
        treeDigest: canonicalSha256({ targetKey: request.plan.targetKey, activationId }),
        revision: Math.max(1, detail.snapshot.revision),
        profileId: request.plan.profileId,
        packageName: plannedPackageName(request),
        operationKind: request.plan.operationKind,
      },
    }) as ManagedTargetRecord
    const committed = await this.owner.commit(
      prepared.before,
      desired,
      plannedPackageName(request),
      detail.metadataCache,
    )
    await this.store.putManaged(committed.sidecar.managed, prepared.before?.revision ?? 0)
    return this.applied(prepared, committed.sidecar.managed, committed.restartRequired, false)
  }

  async verify(applied: AppliedProviderOperation): Promise<ProviderVerification | null> {
    const record = await this.store.getManaged(applied.prepared.request.plan.targetKey)
    if (record === undefined) {
      if (!applied.rollbackRestartRequired || applied.prepared.before !== null) {
        throw new Error('managed Plugin disappeared before verification')
      }
      const receipt = await this.owner.verifyAbsentRollback({
        operationId: applied.prepared.request.authorization.operationId,
        targetKey: applied.prepared.request.plan.targetKey,
        profileId: applied.prepared.request.plan.profileId,
      })
      return Object.freeze({ digest: canonicalSha256({ state: managedStateDigest(null), absentRollback: receipt }) })
    }
    if (pending(record) !== null) return null
    const evidence = await this.owner.verify(record)
    return Object.freeze({ digest: canonicalSha256({ state: managedStateDigest(record), runtimeEvidence: evidence }) })
  }

  /** A process restart token is acknowledged only after a new Host rehydrates the managed Plugin. */
  async acknowledgeBoot(input: Readonly<{
    operationId: string
    targetKey: string
    profileId: string
    restartToken?: string
  }>): Promise<void> {
    await this.initialize()
    const record = await this.store.getManaged(input.targetKey)
    if (record === undefined) {
      await this.owner.verifyAbsentRollback({
        operationId: input.operationId,
        targetKey: input.targetKey,
        profileId: input.profileId,
      })
      return
    }
    if (record.profileId !== input.profileId || record.lastOperationId !== input.operationId) {
      throw new Error('managed Plugin restart acknowledgement does not bind the operation')
    }
    if (pending(record) !== null) throw new Error('managed Plugin has not been rehydrated by a new Host process')
    await this.owner.verify(record)
  }

  async rollback(applied: AppliedProviderOperation): Promise<`sha256:${string}`> {
    const current = await this.store.getManaged(applied.prepared.request.plan.targetKey)
    const before = applied.prepared.before
    if (current === undefined) {
      if (before === null && await this.owner.absentRollbackReceipt({
        operationId: applied.prepared.request.authorization.operationId,
        targetKey: applied.prepared.request.plan.targetKey,
        profileId: applied.prepared.request.plan.profileId,
      }) !== null) {
        return applied.prepared.beforeDigest
      }
      throw new Error('managed Plugin disappeared before rollback')
    }
    if (rollbackOperation(current, applied.prepared.request.authorization.operationId)) {
      return applied.prepared.beforeDigest
    }
    if (before === null) {
      const receipt = await this.owner.rollbackToAbsent(
        current,
        packageName(current, applied.prepared.request),
        applied.prepared.request.authorization.operationId,
        (applied.prepared.prepared as PreparedPlugin | null)?.metadataCache ?? null,
      )
      if (receipt.restartRequired !== applied.prepared.request.plan.restartRequired) {
        throw new Error('managed Plugin absent rollback restart result does not bind the immutable plan')
      }
      return applied.prepared.beforeDigest
    }
    let restored: ManagedTargetRecord
    restored = immutableJsonClone({
      ...before,
      revision: current.revision + 1,
      lastOperationId: applied.prepared.request.authorization.operationId,
      current: before.current === null ? null : this.markRollback(before.current, applied.prepared.request),
      lastGood: before.lastGood === null ? null : this.markRollback(before.lastGood, applied.prepared.request),
      removed: before.removed === null ? null : this.markRollback(before.removed, applied.prepared.request),
      pending: this.rollbackPending(applied.prepared.request),
      updatedAtMs: Date.now(),
    }) as ManagedTargetRecord
    const committed = await this.owner.commit(
      current,
      restored,
      packageName(before ?? current, applied.prepared.request),
      (applied.prepared.prepared as PreparedPlugin | null)?.metadataCache ?? null,
    )
    if (committed.restartRequired !== applied.prepared.request.plan.restartRequired) {
      throw new Error('managed Plugin rollback restart result does not bind the immutable plan')
    }
    await this.store.putManaged(committed.sidecar.managed, current.revision)
    return applied.prepared.beforeDigest
  }

  /** Runtime repair is complete only when the Center owner has no pending restart. */
  async bootReady(input: Readonly<{ profileId: string; restartToken?: string }>): Promise<boolean> {
    const prefix = 'managed-rollback:'
    if (input.restartToken?.startsWith(prefix)) {
      const operationId = input.restartToken.slice(prefix.length)
      const ready = await this.owner.absentRollbackBootReady(operationId, input.profileId)
      if (ready !== null) return ready
    }
    return (await this.snapshot(input.profileId)).bootStatus !== 'pending-restart'
  }

  /** Verify the exact restored state before the operation publishes its terminal receipt. */
  async verifyRollbackFinalization(applied: AppliedProviderOperation): Promise<void> {
    if (applied.prepared.before === null) {
      await this.owner.verifyAbsentRollback({
        operationId: applied.prepared.request.authorization.operationId,
        targetKey: applied.prepared.request.plan.targetKey,
        profileId: applied.prepared.request.plan.profileId,
      })
      return
    }
    const current = await this.store.getManaged(applied.prepared.request.plan.targetKey)
    if (current === undefined
      || current.lastOperationId !== applied.prepared.request.authorization.operationId
      || pending(current) !== null
      || !rollbackOperation(current, applied.prepared.request.authorization.operationId)
      || canonicalSha256(restoredCore(current)) !== canonicalSha256(restoredCore(applied.prepared.before))) {
      throw new Error('managed Plugin rollback finalization has no exact restored state')
    }
  }

  /** Complete post-receipt rollback cleanup from durable operation authority without an intent payload. */
  async finalizeDurableRollback(input: Readonly<{
    operationId: string
    targetKey: string
    beforeDigest: `sha256:${string}`
  }>): Promise<boolean> {
    await this.initialize()
    const durable = await this.store.getProviderSnapshot(input.operationId)
    if (durable === undefined) return false
    if (durable.targetKey !== input.targetKey
      || durable.beforeDigest !== input.beforeDigest
      || managedStateDigest(durable.before) !== input.beforeDigest) {
      throw new Error('managed Plugin durable rollback finalization does not bind the provider snapshot')
    }
    if (durable.before === null) {
      await this.owner.finalizeAbsentRollback(input.operationId)
      return true
    }
    const current = await this.store.getManaged(input.targetKey)
    return current !== undefined
      && current.lastOperationId === input.operationId
      && pending(current) === null
      && rollbackOperation(current, input.operationId)
      && canonicalSha256(restoredCore(current)) === canonicalSha256(restoredCore(durable.before))
  }

  /** Remove transient absent-state proof only after the terminal receipt is durable. */
  async finalizeRollback(applied: AppliedProviderOperation): Promise<void> {
    await this.verifyRollbackFinalization(applied)
    if (applied.prepared.before === null) {
      await this.owner.finalizeAbsentRollback(applied.prepared.request.authorization.operationId)
    }
  }

  /** Consume only exact evidence produced after the pinned executable restored official and Center state. */
  async reconcileBreakGlassRestore(
    request: ProviderOperationRequest,
    expectedBeforeDigest: `sha256:${string}`,
    journalHeadDigest: `sha256:${string}`,
  ): Promise<AppliedProviderOperation | null> {
    const durable = await this.store.getProviderSnapshot(request.authorization.operationId)
    if (durable === undefined || durable.targetKey !== request.plan.targetKey
      || durable.beforeDigest !== managedStateDigest(durable.before)
      || durable.beforeDigest !== expectedBeforeDigest) {
      throw new Error('managed Plugin recovery snapshot does not bind the journal')
    }
    const providerSnapshotDigest = canonicalSha256(durable)
    const marker = await this.owner.breakGlassRestore({
      operationId: request.authorization.operationId,
      targetKey: request.plan.targetKey,
      profileId: request.plan.profileId,
      packageName: plannedPackageName(request),
      journalHeadDigest,
      providerSnapshotDigest,
      beforeDigest: expectedBeforeDigest,
    })
    if (marker === null) return null
    const current = await this.store.getManaged(request.plan.targetKey) ?? null
    if (marker.restoredManagedDigest !== expectedBeforeDigest) {
      throw new Error('managed Plugin break-glass marker does not restore the provider before-state')
    }
    if (durable.before === null) {
      if (current !== null || marker.restoredRevision !== null
        || managedStateDigest(current) !== marker.restoredManagedDigest) {
        throw new Error('managed Plugin break-glass restore retained an absent before-state')
      }
    } else {
      if (current === null || marker.restoredRevision === null
        || current.lastOperationId !== request.authorization.operationId || current.pending !== null) {
        throw new Error('managed Plugin break-glass restore does not match the durable before-state')
      }
      const exactRestored = current.revision === marker.restoredRevision
        && managedStateDigest(current) === marker.restoredManagedDigest
      const settledRestored = current.revision === marker.restoredRevision + 1
        && canonicalSha256(restoredCore(current)) === canonicalSha256(restoredCore(durable.before))
      if (!exactRestored && !settledRestored) {
        throw new Error('managed Plugin break-glass marker does not bind current Center state')
      }
      if (settledRestored) await this.owner.verify(current)
    }
    const prepared: PreparedProviderOperation = Object.freeze({
      request,
      before: durable.before,
      beforeDigest: expectedBeforeDigest,
      stagingPath: null,
      prepared: null,
    })
    return this.applied(prepared, current, false, request.plan.restartRequired)
  }

  async recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation | null> {
    await this.initialize()
    const durable = await this.store.getProviderSnapshot(request.authorization.operationId)
    if (durable === undefined) return null
    const record = await this.store.getManaged(request.plan.targetKey)
    if (durable.targetKey !== request.plan.targetKey
      || durable.beforeDigest !== managedStateDigest(durable.before)) {
      throw new Error('Plugin recovery snapshot is absent or corrupt')
    }
    const point = recoveryPoint(durable.recoveryPoint)
    if (point.snapshot.profileId !== request.plan.profileId) throw new Error('Plugin recovery owner snapshot does not bind the plan')
    if (['install', 'update'].includes(request.plan.operationKind)) {
      if (point.artifactPath === null) {
        throw new Error('Plugin recovery material does not bind the immutable operation')
      }
      await verifyPackedArtifact(point.artifactPath, request.plan.artifactIntegrity)
    } else if (point.artifactPath !== null) {
      throw new Error('Plugin recovery point carries unneeded mutation material')
    }
    const prepared: PreparedProviderOperation = {
      request,
      before: durable.before,
      beforeDigest: durable.beforeDigest as `sha256:${string}`,
      stagingPath: null,
      prepared: Object.freeze({
        snapshot: point.snapshot,
        materialPath: null,
        activation: null,
        metadataCache: point.metadataCache,
      } satisfies PreparedPlugin),
    }
    if (record === undefined) {
      if (prepared.before !== null) return null
      const receipt = await this.owner.absentRollbackReceipt({
        operationId: request.authorization.operationId,
        targetKey: request.plan.targetKey,
        profileId: request.plan.profileId,
      })
      if (receipt === null) return null
      if (await this.owner.absentRollbackBootReady(request.authorization.operationId, request.plan.profileId)) {
        await this.owner.verifyAbsentRollback({
          operationId: request.authorization.operationId,
          targetKey: request.plan.targetKey,
          profileId: request.plan.profileId,
        })
      }
      return this.applied(prepared, null, false, request.plan.restartRequired)
    }
    if (record.lastOperationId !== request.authorization.operationId) return null
    const heldPending = pending(record)
    const rolledBack = rollbackOperation(record, request.authorization.operationId)
    if (heldPending !== null && heldPending.operationId !== request.authorization.operationId) {
      throw new Error('Plugin recovery pending state does not bind the operation')
    }
    return this.applied(
      prepared,
      record,
      !rolledBack && request.plan.restartRequired,
      rolledBack && request.plan.restartRequired,
    )
  }

  cleanup(): Promise<void> {
    return Promise.resolve()
  }

  private pendingState(request: ProviderOperationRequest): RpcJson {
    return {
      packageName: plannedPackageName(request),
      restartToken: `managed:${request.authorization.operationId}`,
      treeDigest: canonicalSha256({ targetKey: request.plan.targetKey, operationId: request.authorization.operationId }),
      loaderPhase: 'pending-restart',
      consumerObserved: false,
      restartObserved: false,
    }
  }

  private rollbackPending(request: ProviderOperationRequest): RpcJson {
    return {
      operationId: request.authorization.operationId,
      generation: `managed-rollback:${request.authorization.operationId}`,
      treeDigest: canonicalSha256({ targetKey: request.plan.targetKey, operationId: request.authorization.operationId, rollback: true }),
      revision: 1,
      profileId: request.plan.profileId,
      packageName: plannedPackageName(request),
      operationKind: request.plan.operationKind === 'configure' ? 'configure' : 'rollback',
    }
  }

  private markRollback(version: ManagedVersion, request: ProviderOperationRequest): ManagedVersion {
    return immutableJsonClone({
      ...version,
      kindState: {
        ...pluginState(version),
        rollbackOperationId: request.authorization.operationId,
      },
    }) as ManagedVersion
  }

  private applied(
    prepared: PreparedProviderOperation,
    after: ManagedTargetRecord | null,
    restartRequired: boolean,
    rollbackRestartRequired: boolean,
  ): AppliedProviderOperation {
    return Object.freeze({
      prepared,
      mutationDigest: canonicalSha256({ operationId: prepared.request.authorization.operationId, after: managedStateDigest(after) }),
      afterDigest: managedStateDigest(after),
      restartRequired,
      restartToken: restartRequired || rollbackRestartRequired
        ? `${rollbackRestartRequired ? 'managed-rollback' : 'managed'}:${prepared.request.authorization.operationId}`
        : null,
      rollbackRestartRequired,
    })
  }
}
