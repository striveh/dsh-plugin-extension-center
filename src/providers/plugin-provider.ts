import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type { LoaderOwner, ManagedTargetRecord, ManagedVersion, ProfileTransactionsOwner } from '../host/index.ts'
import { CenterStateStore, openRegularNoFollow } from '../host/index.ts'
import type { RpcJson } from '../service/rpc-contract.ts'
import { inspectNpmArchive } from './npm-archive.ts'
import {
  buildCapabilityResolverPatch,
  hasPluginConfigurationAdapter,
  type PluginConfigurationPatch,
} from './plugin-config-adapter.ts'
import { managedStateDigest, nextManagedRecord } from './records.ts'
import type {
  AppliedProviderOperation,
  LifecycleProvider,
  PreparedProviderOperation,
  ProviderOperationRequest,
  ProviderVerification,
} from './types.ts'

interface ProfileSnapshotView {
  readonly profile: string
  readonly revision: number
  readonly treeDigest: string
  readonly effectivePath: string
  readonly activeGeneration: string | null
  readonly lastGoodGeneration: string | null
  readonly rollbackGeneration: string | null
  readonly bootStatus: 'live' | 'pending-restart' | 'verified'
}

interface PreparedPlugin {
  readonly snapshot: ProfileSnapshotView
  readonly configurationPatch: PluginConfigurationPatch | null
}

interface PluginRecoveryPoint {
  readonly snapshot: ProfileSnapshotView
  readonly configurationPatch: PluginConfigurationPatch | null
  readonly artifactPath: string | null
}

interface PendingProfileMutation {
  readonly operationId: string
  readonly generation: string
  readonly treeDigest: string
  readonly revision: number
  readonly profileId: string
  readonly packageName: string
  readonly operationKind: ProviderOperationRequest['plan']['operationKind'] | 'rollback'
}

/** Loader evidence derived inside the Host after the complete tree settles. */
export interface PluginRuntimeEvidence {
  readonly entryId: string
  readonly moduleName: string
  readonly fiberPhase: 'active' | 'absent'
}

/** Host-only observer; browser payloads never supply consumer evidence. */
export interface PluginRuntimeProbe {
  observe(packageName: string, operation: ProviderOperationRequest['plan']['operationKind']): Promise<PluginRuntimeEvidence>
}

/** Direct Loader observer used after app-boot has acknowledged the active generation. */
export class LoaderPluginRuntimeProbe implements PluginRuntimeProbe {
  constructor(private readonly loader: LoaderOwner) {}

  async observe(packageName: string, operation: ProviderOperationRequest['plan']['operationKind']): Promise<PluginRuntimeEvidence> {
    await this.loader.await()
    const matches = [...this.loader.entries()].filter(entry => !entry.options.group
      && (entry.options.id === packageName || entry.options.name === packageName))
    if (operation === 'uninstall') {
      if (matches.length !== 0) throw new Error('uninstalled Plugin remains in the settled Loader tree')
      return Object.freeze({ entryId: packageName, moduleName: packageName, fiberPhase: 'absent' })
    }
    const active = matches.find(entry => entry.options.id === packageName
      && entry.options.name === packageName
      && !entry.disabled
      && entry.fiber?.state === 2)
    if (active === undefined) throw new Error('Plugin target is not ACTIVE in the settled Loader tree')
    return Object.freeze({ entryId: packageName, moduleName: packageName, fiberPhase: 'active' })
  }
}

function snapshot(value: unknown): ProfileSnapshotView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Profile snapshot is invalid')
  const item = value as Record<string, unknown>
  if (
    typeof item.profile !== 'string'
    || !Number.isSafeInteger(item.revision)
    || typeof item.treeDigest !== 'string'
    || !Number.isSafeInteger(item.revision)
    || typeof item.effectivePath !== 'string'
    || (item.activeGeneration !== null && typeof item.activeGeneration !== 'string')
    || (item.lastGoodGeneration !== null && typeof item.lastGoodGeneration !== 'string')
    || (item.rollbackGeneration !== null && typeof item.rollbackGeneration !== 'string')
    || !['live', 'pending-restart', 'verified'].includes(item.bootStatus as string)
  ) throw new Error('Profile snapshot fields are invalid')
  return item as unknown as ProfileSnapshotView
}

function pending(record: ManagedTargetRecord): PendingProfileMutation | null {
  const value = record.pending
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('pending Profile mutation is invalid')
  const item = value as Record<string, RpcJson>
  if (
    typeof item.operationId !== 'string'
    || typeof item.generation !== 'string'
    || typeof item.treeDigest !== 'string'
    || typeof item.profileId !== 'string'
    || typeof item.packageName !== 'string'
    || typeof item.operationKind !== 'string'
    || !['install', 'configure', 'update', 'uninstall', 'restore', 'rollback'].includes(item.operationKind)
  ) throw new Error('pending Profile mutation fields are invalid')
  return item as unknown as PendingProfileMutation
}

function pluginState(version: ManagedVersion): Record<string, RpcJson> {
  const value = version.kindState
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('managed Plugin state is invalid')
  return value as Record<string, RpcJson>
}

function profileFence(value: ProfileSnapshotView): string {
  return `profile:${String(value.revision)}:${value.treeDigest}`
}

function recoveryPoint(value: RpcJson): PluginRecoveryPoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Plugin recovery point is invalid')
  }
  const input = value as Record<string, RpcJson>
  if (input.kind !== 'plugin'
    || typeof input.snapshot !== 'object' || input.snapshot === null || Array.isArray(input.snapshot)
    || (input.artifactPath !== null && typeof input.artifactPath !== 'string')
    || (input.configurationPatch !== null
      && (typeof input.configurationPatch !== 'object' || Array.isArray(input.configurationPatch)))) {
    throw new Error('Plugin recovery point fields are invalid')
  }
  return Object.freeze({
    snapshot: snapshot(input.snapshot),
    configurationPatch: input.configurationPatch as unknown as PluginConfigurationPatch | null,
    artifactPath: input.artifactPath as string | null,
  })
}

function mutationId(operationId: string, phase: 'apply' | 'rollback'): string {
  return `${operationId}:${phase}`
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

/** Exact plan mutation digest for the typed Profile patch adapter. */
export function pluginConfigurationMutationDigest(
  patch: PluginConfigurationPatch,
  ownerRevision: string,
): `sha256:${string}` {
  return canonicalSha256({
    operation: 'configure',
    schema: patch.schema,
    adapterDigest: patch.adapterDigest,
    expectedDigest: patch.expectedDigest,
    nextDigest: patch.nextDigest,
    configuration: patch.configuration,
    ownerRevision,
  })
}

/** Profile generation adapter for install, update, uninstall, restore, and boot acknowledgement. */
export class PluginLifecycleProvider implements LifecycleProvider {
  readonly kind = 'plugin' as const

  constructor(
    private readonly store: CenterStateStore,
    private readonly owner: ProfileTransactionsOwner,
    private readonly runtime: PluginRuntimeProbe,
  ) {}

  async observe(targetKey: string): Promise<ManagedTargetRecord | null> {
    return await this.store.getManaged(targetKey) ?? null
  }

  async prepare(request: ProviderOperationRequest): Promise<PreparedProviderOperation> {
    if (request.plan.operationKind === 'purge') {
      throw new Error('Plugin purge is unavailable while Profile recovery generations retain package data')
    }
    if (['enable', 'disable'].includes(request.plan.operationKind)) {
      throw new Error(`Plugin ${request.plan.operationKind} is unsupported in P0`)
    }
    const before = await this.observe(request.plan.targetKey)
    const held = snapshot(await this.owner.snapshot(request.plan.profileId))
    if (profileFence(held) !== request.plan.fences.profileRevision) throw new Error('Profile revision/tree fence is stale')
    let configurationPatch: PluginConfigurationPatch | null = null
    if (request.plan.operationKind === 'install' || request.plan.operationKind === 'update') {
      if (request.artifactPath === null) throw new Error('Plugin install or update requires an acquired archive')
      const inspection = await inspectNpmArchive(request.artifactPath, null)
      if (inspection.name !== request.entry.artifact.id || inspection.version !== request.entry.artifact.version) {
        throw new Error('Plugin package identity does not match the verified catalog entry')
      }
      const review = request.plan.reviewEvidence
      if (review.kind !== 'plugin') throw new Error('Plugin plan has no Plugin review evidence')
      const peers = Object.fromEntries(review.dependencies
        .filter(dependency => dependency.kind === 'peer' && dependency.afterVersion !== null)
        .map(dependency => [dependency.id, dependency.afterVersion]))
      const bundle = review.bundles.find(item => item.id === request.entry.artifact.id)
      if (inspection.manifestBody !== review.manifest.body
        || inspection.manifestDigest !== review.manifest.manifestDigest
        || inspection.fileManifestDigest !== review.manifest.fileManifestDigest
        || canonicalSha256(inspection.files) !== canonicalSha256(review.manifest.files)
        || canonicalSha256(inspection.scripts) !== canonicalSha256(review.scripts.after)
        || canonicalSha256(inspection.peerDependencies) !== canonicalSha256(peers)
        || inspection.bundlePatch === null
        || bundle === undefined
        || inspection.bundlePatch.body !== bundle.patchBody
        || inspection.bundlePatch.digest !== bundle.patchDigest) {
        throw new Error('Plugin archive does not match the immutable review evidence')
      }
    } else if (request.plan.operationKind === 'configure') {
      const current = before?.current
      if (current === null || current === undefined
        || current.candidateRef !== request.plan.candidateRef
        || !hasPluginConfigurationAdapter(current.candidateRef, request.entry.artifact.version)) {
        throw new Error('Plugin has no exact typed configuration adapter')
      }
      const patchPath = join(held.effectivePath, 'cordis.patch.yml')
      configurationPatch = buildCapabilityResolverPatch(await readFile(patchPath, 'utf8'), request.payload.configuration)
      if (configurationPatch.candidateRef !== request.plan.candidateRef) {
        throw new Error('typed Plugin configuration adapter does not match the immutable plan')
      }
      if (pluginConfigurationMutationDigest(configurationPatch, profileFence(held)) !== request.plan.mutationDigest) {
        throw new Error('typed Plugin configuration mutation does not match the immutable plan digest')
      }
    } else if (request.artifactPath !== null) {
      throw new Error('Plugin operation received an unneeded artifact')
    }
    return Object.freeze({
      request,
      before,
      beforeDigest: managedStateDigest(before),
      stagingPath: null,
      prepared: Object.freeze({ snapshot: held, configurationPatch } satisfies PreparedPlugin),
    })
  }

  recoveryPoint(prepared: PreparedProviderOperation): RpcJson {
    const detail = prepared.prepared as PreparedPlugin
    return immutableJsonClone({
      kind: 'plugin',
      snapshot: detail.snapshot,
      configurationPatch: detail.configurationPatch,
      artifactPath: prepared.request.artifactPath,
    }) as unknown as RpcJson
  }

  async apply(prepared: PreparedProviderOperation): Promise<AppliedProviderOperation> {
    const detail = prepared.prepared as PreparedPlugin
    const { request } = prepared
    let afterSnapshot: ProfileSnapshotView
    let generation: string | null = null
    if (request.plan.operationKind === 'restore') {
      const receipt = await this.owner.restoreLastGood({
        profile: request.plan.profileId,
        mutationId: mutationId(request.authorization.operationId, 'apply'),
        expectedRevision: detail.snapshot.revision,
        expectedTreeDigest: detail.snapshot.treeDigest,
      }) as { after?: unknown }
      afterSnapshot = snapshot(receipt.after)
      generation = afterSnapshot.activeGeneration
    } else {
      const mutation = request.plan.operationKind === 'uninstall'
        ? { operation: 'uninstall', packageName: request.entry.artifact.id }
        : request.plan.operationKind === 'configure'
          ? {
              operation: 'configure',
              packageName: request.entry.artifact.id,
              patch: {
                expectedDigest: detail.configurationPatch!.expectedDigest,
                nextUtf8: detail.configurationPatch!.nextUtf8,
                nextDigest: detail.configurationPatch!.nextDigest,
              },
            }
          : {
            operation: request.plan.operationKind,
            kind: 'bundle',
            packageName: request.entry.artifact.id,
            version: request.entry.artifact.version,
            artifact: { path: request.artifactPath, digest: request.plan.artifactIntegrity },
          }
      const staged = await this.owner.stage({
        profile: request.plan.profileId,
        mutationId: mutationId(request.authorization.operationId, 'apply'),
        expectedRevision: detail.snapshot.revision,
        expectedTreeDigest: detail.snapshot.treeDigest,
        mutation,
      })
      generation = staged.generation
      try {
        const receipt = await this.owner.commit({
          profile: request.plan.profileId,
          expectedRevision: detail.snapshot.revision,
          expectedTreeDigest: detail.snapshot.treeDigest,
          generation,
        }) as { after?: unknown }
        afterSnapshot = snapshot(receipt.after)
      } catch (error: unknown) {
        await this.owner.abort({ profile: request.plan.profileId, generation })
        throw error
      }
    }
    if (generation === null) throw new Error('Profile mutation did not publish a generation')
    let supplied: ManagedVersion | null = null
    if (request.plan.operationKind === 'install' || request.plan.operationKind === 'update') {
      supplied = immutableJsonClone({
        candidateRef: request.plan.candidateRef,
        artifactRevision: request.plan.artifactRevision,
        artifactIntegrity: request.plan.artifactIntegrity,
        materialPath: afterSnapshot.effectivePath,
        configuration: request.payload.configuration,
        enabled: true,
        ownerRevision: profileFence(afterSnapshot),
        kindState: {
          packageName: request.entry.artifact.id,
          profileGeneration: generation,
          treeDigest: afterSnapshot.treeDigest,
          loaderPhase: 'pending-restart',
          consumerObserved: false,
          externalRestartObserved: false,
        },
      }) as unknown as ManagedVersion
    }
    let after = nextManagedRecord(prepared.before, request, supplied, Date.now())
    if (after.current !== null && (request.plan.operationKind === 'restore' || request.plan.operationKind === 'configure')) {
      const state = pluginState(after.current)
      after = immutableJsonClone({
        ...after,
        current: {
          ...after.current,
          materialPath: afterSnapshot.effectivePath,
          ownerRevision: profileFence(afterSnapshot),
          kindState: {
            packageName: state.packageName,
            profileGeneration: generation,
            treeDigest: afterSnapshot.treeDigest,
            loaderPhase: 'pending-restart',
            consumerObserved: false,
            externalRestartObserved: false,
          },
        },
      }) as ManagedTargetRecord
    }
    after = immutableJsonClone({
      ...after,
      pending: {
        operationId: request.authorization.operationId,
        generation,
        treeDigest: afterSnapshot.treeDigest,
        revision: afterSnapshot.revision,
        profileId: request.plan.profileId,
        packageName: request.entry.artifact.id,
        operationKind: request.plan.operationKind,
      },
    }) as ManagedTargetRecord
    await this.store.putManaged(after, prepared.before?.revision ?? 0)
    return this.applied(prepared, after, generation)
  }

  async verify(applied: AppliedProviderOperation): Promise<ProviderVerification | null> {
    if (!applied.restartRequired) return Object.freeze({ digest: canonicalSha256({ structural: applied.afterDigest }) })
    const record = await this.store.getManaged(applied.prepared.request.plan.targetKey)
    if (record === undefined) throw new Error('managed Plugin disappeared before boot verification')
    if (pending(record) !== null) return null
    const observed = snapshot(await this.owner.snapshot(applied.prepared.request.plan.profileId))
    if (observed.bootStatus !== 'verified' || observed.activeGeneration !== applied.profileGeneration) {
      throw new Error('Profile owner has no exact acknowledged boot evidence')
    }
    const removed = applied.rollbackRestart
      ? applied.prepared.before?.current == null
      : applied.prepared.request.plan.operationKind === 'uninstall'
    const evidenceVersion = removed ? record.removed : record.current
    if (evidenceVersion === null) throw new Error('Plugin boot evidence has no exact managed version')
    const state = pluginState(evidenceVersion)
    const expectedPhase = removed ? 'absent' : 'active'
    if (state.consumerObserved !== true || state.externalRestartObserved !== true || state.loaderPhase !== expectedPhase) {
      throw new Error('Plugin consumer evidence is incomplete after boot acknowledgement')
    }
    return Object.freeze({ digest: canonicalSha256({
      generation: observed.activeGeneration,
      treeDigest: observed.treeDigest,
      bootStatus: observed.bootStatus,
      runtimeEvidence: state.runtimeEvidence,
    }) })
  }

  /** Reconcile an already acknowledged Profile boot with exact settled Loader evidence. */
  async acknowledgeBoot(input: Readonly<{
    operationId: string
    targetKey: string
    profileId: string
    generation: string
  }>): Promise<void> {
    const record = await this.store.getManaged(input.targetKey)
    if (record === undefined) throw new Error('Plugin operation target does not exist')
    const staged = pending(record)
    if (
      staged === null
      || staged.operationId !== input.operationId
      || staged.profileId !== input.profileId
      || staged.generation !== input.generation
    ) throw new Error('boot acknowledgement does not bind the pending Profile generation')
    const held = snapshot(await this.owner.snapshot(input.profileId))
    if (held.activeGeneration !== input.generation
      || (held.revision !== staged.revision && held.revision !== staged.revision + 1)
      || held.treeDigest !== staged.treeDigest
      || held.bootStatus !== 'verified') {
      throw new Error('Profile generation has not been acknowledged by a successful app boot')
    }
    const runtimeOperation = staged.operationKind === 'rollback'
      ? (await this.store.getProviderSnapshot(input.operationId))?.before?.current == null ? 'uninstall' : 'restore'
      : staged.operationKind
    const evidence = await this.runtime.observe(staged.packageName, runtimeOperation)
    await this.store.putBootAck({
      schemaVersion: 1,
      operationId: input.operationId,
      profileId: input.profileId,
      generation: input.generation,
      phase: staged.operationKind === 'rollback' ? 'rollback' : 'candidate',
      revision: held.revision,
      treeDigest: held.treeDigest,
      consumerObserved: true,
      acknowledgedAtMs: Date.now(),
    })
    let current = record.current
    if (current !== null) {
      const state = pluginState(current)
      current = immutableJsonClone({
        ...current,
        ownerRevision: profileFence(held),
        materialPath: held.effectivePath,
        kindState: {
          ...state,
          profileGeneration: input.generation,
          treeDigest: held.treeDigest,
          loaderPhase: 'active',
          consumerObserved: true,
          externalRestartObserved: true,
          runtimeEvidence: evidence,
        },
      }) as unknown as ManagedVersion
    }
    let removed = record.removed
    if (current === null && removed !== null) {
      const state = pluginState(removed)
      removed = immutableJsonClone({
        ...removed,
        ownerRevision: profileFence(held),
        materialPath: held.effectivePath,
        kindState: {
          ...state,
          profileGeneration: input.generation,
          treeDigest: held.treeDigest,
          loaderPhase: 'absent',
          consumerObserved: true,
          externalRestartObserved: true,
          runtimeEvidence: evidence,
        },
      }) as unknown as ManagedVersion
    }
    await this.store.putManaged(immutableJsonClone({
      ...record,
      revision: record.revision + 1,
      current,
      removed,
      pending: null,
      updatedAtMs: Date.now(),
    }) as ManagedTargetRecord, record.revision)
  }

  async rollback(applied: AppliedProviderOperation) {
    const current = await this.store.getManaged(applied.prepared.request.plan.targetKey)
    if (current === undefined) throw new Error('managed Plugin disappeared before rollback')
    let staged = pending(current)
    if (staged === null) {
      const acknowledged = await this.store.getBootAck(applied.prepared.request.authorization.operationId)
      const evidence = current.current ?? current.removed
      if (acknowledged?.phase !== 'candidate'
        || acknowledged.profileId !== applied.prepared.request.plan.profileId
        || evidence === null
        || pluginState(evidence).profileGeneration !== acknowledged.generation) {
        throw new Error('Plugin rollback has no exact pending or acknowledged Profile mutation')
      }
      staged = {
        operationId: applied.prepared.request.authorization.operationId,
        generation: acknowledged.generation,
        treeDigest: acknowledged.treeDigest,
        revision: acknowledged.revision,
        profileId: applied.prepared.request.plan.profileId,
        packageName: applied.prepared.request.entry.artifact.id,
        operationKind: applied.prepared.request.plan.operationKind,
      }
    } else if (staged.operationId !== applied.prepared.request.authorization.operationId) {
      throw new Error('Plugin rollback has no exact pending Profile mutation')
    }
    const receipt = await this.owner.restoreLastGood({
      profile: staged.profileId,
      mutationId: mutationId(applied.prepared.request.authorization.operationId, 'rollback'),
      expectedRevision: staged.revision,
      expectedTreeDigest: staged.treeDigest,
    }) as { after?: unknown }
    const restored = snapshot(receipt.after)
    if (restored.activeGeneration === null) throw new Error('Profile rollback did not publish a generation')
    const before = applied.prepared.before
    const base = before ?? immutableJsonClone({
      ...current,
      current: null,
      lastGood: null,
      removed: current.current ?? current.removed,
    }) as ManagedTargetRecord
    await this.store.putManaged(immutableJsonClone({
      ...base,
      revision: current.revision + 1,
      lastOperationId: applied.prepared.request.authorization.operationId,
      pending: {
        operationId: applied.prepared.request.authorization.operationId,
        generation: restored.activeGeneration,
        treeDigest: restored.treeDigest,
        revision: restored.revision,
        profileId: applied.prepared.request.plan.profileId,
        packageName: applied.prepared.request.entry.artifact.id,
        operationKind: 'rollback',
      },
      updatedAtMs: Date.now(),
    }) as ManagedTargetRecord, current.revision)
    return applied.prepared.beforeDigest
  }

  /** Check app-boot evidence before the Loader probe can trigger rollback. */
  async bootReady(input: Readonly<{ profileId: string; generation: string }>): Promise<boolean> {
    const held = snapshot(await this.owner.snapshot(input.profileId))
    return held.activeGeneration === input.generation && held.bootStatus === 'verified'
  }

  /** Remove the temporary rollback tombstone used when the original target was absent. */
  async finalizeRollback(applied: AppliedProviderOperation): Promise<void> {
    if (!applied.rollbackRestart || applied.prepared.before !== null) return
    const record = await this.store.getManaged(applied.prepared.request.plan.targetKey)
    if (record === undefined || record.pending !== null
      || record.lastOperationId !== applied.prepared.request.authorization.operationId) {
      throw new Error('temporary Plugin rollback record is not ready for finalization')
    }
    await this.store.deleteManaged(record.targetKey, record.revision)
  }

  /**
   * Rebuild the Center rollback-pending record only after the Host exposes the
   * exact generation and tree digest pinned by the immutable approval.
   *
   * @param request Exact consumed Plugin operation.
   * @param expectedBeforeDigest Journal-authenticated pre-mutation Center state.
   * @returns Pending rollback evidence, or null while the pinned Host restore is absent.
   */
  async reconcileBreakGlassRestore(
    request: ProviderOperationRequest,
    expectedBeforeDigest: `sha256:${string}`,
  ): Promise<AppliedProviderOperation | null> {
    const review = request.plan.reviewEvidence
    if (review.kind !== 'plugin') {
      throw new Error('Plugin break-glass reconciliation has no immutable Profile recovery pin')
    }
    const recoveryPin = review.rollbackPoint
    if (recoveryPin === null || recoveryPin.kind !== 'profile-generation') {
      throw new Error('Plugin break-glass reconciliation has no immutable Profile recovery pin')
    }
    const held = snapshot(await this.owner.snapshot(request.plan.profileId))
    if (held.profile !== request.plan.profileId
      || held.activeGeneration !== recoveryPin.id
      || held.treeDigest !== recoveryPin.digest) return null
    if (held.bootStatus !== 'pending-restart' && held.bootStatus !== 'verified') {
      throw new Error('break-glass Profile restore has no restart-verifiable Host state')
    }
    const durable = await this.store.getProviderSnapshot(request.authorization.operationId)
    if (durable === undefined
      || durable.targetKey !== request.plan.targetKey
      || durable.beforeDigest !== expectedBeforeDigest
      || managedStateDigest(durable.before) !== expectedBeforeDigest) {
      throw new Error('Plugin break-glass reconciliation snapshot does not bind the journal')
    }
    const existing = await this.store.getManaged(request.plan.targetKey)
    if (existing !== undefined
      && existing.lastOperationId !== request.authorization.operationId
      && managedStateDigest(existing) !== expectedBeforeDigest) {
      throw new Error('Plugin Center state diverged before break-glass reconciliation')
    }
    const alreadyPending = existing === undefined ? null : pending(existing)
    if (existing !== undefined
      && alreadyPending?.operationId === request.authorization.operationId
      && alreadyPending.operationKind === 'rollback'
      && alreadyPending.generation === recoveryPin.id
      && alreadyPending.treeDigest === recoveryPin.digest
      && alreadyPending.revision === held.revision) {
      const prepared: PreparedProviderOperation = {
        request,
        before: durable.before,
        beforeDigest: durable.beforeDigest as `sha256:${string}`,
        stagingPath: null,
        prepared: null,
      }
      return this.applied(prepared, existing, recoveryPin.id, true)
    }

    const temporaryRemoved: ManagedVersion = immutableJsonClone({
      candidateRef: request.plan.candidateRef,
      artifactRevision: request.plan.artifactRevision,
      artifactIntegrity: request.plan.artifactIntegrity,
      materialPath: held.effectivePath,
      configuration: request.payload.configuration,
      enabled: true,
      ownerRevision: profileFence(held),
      kindState: {
        packageName: request.entry.artifact.id,
        profileGeneration: recoveryPin.id,
        treeDigest: recoveryPin.digest,
        loaderPhase: 'pending-restart',
        consumerObserved: false,
        externalRestartObserved: false,
      },
    }) as ManagedVersion
    const base = durable.before ?? immutableJsonClone({
      schemaVersion: 1,
      kind: 'plugin',
      extensionId: request.plan.extensionId,
      targetKey: request.plan.targetKey,
      scopeKey: request.plan.scopeKey,
      profileId: request.plan.profileId,
      revision: 0,
      lastOperationId: request.authorization.operationId,
      current: null,
      lastGood: null,
      removed: temporaryRemoved,
      pending: null,
      updatedAtMs: Date.now(),
    }) as ManagedTargetRecord
    const restored = immutableJsonClone({
      ...base,
      revision: (existing?.revision ?? 0) + 1,
      lastOperationId: request.authorization.operationId,
      pending: {
        operationId: request.authorization.operationId,
        generation: recoveryPin.id,
        treeDigest: recoveryPin.digest,
        revision: held.revision,
        profileId: request.plan.profileId,
        packageName: request.entry.artifact.id,
        operationKind: 'rollback',
      },
      updatedAtMs: Date.now(),
    }) as ManagedTargetRecord
    await this.store.putManaged(restored, existing?.revision ?? 0)
    const prepared: PreparedProviderOperation = {
      request,
      before: durable.before,
      beforeDigest: durable.beforeDigest as `sha256:${string}`,
      stagingPath: null,
      prepared: null,
    }
    return this.applied(prepared, restored, recoveryPin.id, true)
  }

  async recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation | null> {
    const snapshot = await this.store.getProviderSnapshot(request.authorization.operationId)
    if (snapshot === undefined || snapshot.targetKey !== request.plan.targetKey
      || snapshot.beforeDigest !== managedStateDigest(snapshot.before)) throw new Error('Plugin recovery snapshot is absent or corrupt')
    let record = await this.store.getManaged(request.plan.targetKey)
    if (record?.lastOperationId !== request.authorization.operationId) {
      if (managedStateDigest(record ?? null) !== snapshot.beforeDigest) {
        throw new Error('Plugin center state diverged after its Profile mutation')
      }
      const point = recoveryPoint(snapshot.recoveryPoint)
      if (point.snapshot.profile !== request.plan.profileId
        || profileFence(point.snapshot) !== request.plan.fences.profileRevision) {
        throw new Error('Plugin recovery snapshot does not bind the immutable Profile fence')
      }
      if (request.plan.operationKind === 'install' || request.plan.operationKind === 'update') {
        if (point.artifactPath === null || point.configurationPatch !== null) {
          throw new Error('Plugin recovery material does not bind the immutable operation')
        }
        await verifyPackedArtifact(point.artifactPath, request.plan.artifactIntegrity)
        const inspection = await inspectNpmArchive(point.artifactPath, null)
        if (inspection.name !== request.entry.artifact.id || inspection.version !== request.entry.artifact.version) {
          throw new Error('Plugin recovery package identity does not match the verified catalog entry')
        }
      } else if (request.plan.operationKind === 'configure') {
        if (point.artifactPath !== null || point.configurationPatch === null
          || point.configurationPatch.candidateRef !== request.plan.candidateRef
          || pluginConfigurationMutationDigest(point.configurationPatch, profileFence(point.snapshot)) !== request.plan.mutationDigest) {
          throw new Error('Plugin recovery configuration does not bind the immutable plan')
        }
      } else if (point.artifactPath !== null || point.configurationPatch !== null) {
        throw new Error('Plugin recovery point carries unneeded mutation material')
      }
      const prepared: PreparedProviderOperation = {
        request: Object.freeze({ ...request, artifactPath: point.artifactPath }),
        before: snapshot.before,
        beforeDigest: snapshot.beforeDigest as `sha256:${string}`,
        stagingPath: null,
        prepared: Object.freeze({ snapshot: point.snapshot, configurationPatch: point.configurationPatch } satisfies PreparedPlugin),
      }
      await this.apply(prepared)
      record = await this.store.getManaged(request.plan.targetKey)
    }
    if (record?.lastOperationId !== request.authorization.operationId) return null
    const staged = pending(record)
    const acknowledged = staged === null ? await this.store.getBootAck(request.authorization.operationId) : undefined
    const evidence = record.current ?? record.removed
    if (acknowledged !== undefined && (
      acknowledged.profileId !== request.plan.profileId
      || evidence === null
      || pluginState(evidence).profileGeneration !== acknowledged.generation
    )) throw new Error('Plugin acknowledged recovery evidence does not bind the managed generation')
    const generation = staged?.operationId === request.authorization.operationId
      ? staged.generation
      : acknowledged?.generation ?? null
    if (generation === null || generation === '') return null
    const prepared: PreparedProviderOperation = {
      request,
      before: snapshot.before,
      beforeDigest: snapshot.beforeDigest as `sha256:${string}`,
      stagingPath: null,
      prepared: null,
    }
    return this.applied(prepared, record, generation, staged?.operationKind === 'rollback' || acknowledged?.phase === 'rollback')
  }

  cleanup(): Promise<void> {
    return Promise.resolve()
  }

  private applied(
    prepared: PreparedProviderOperation,
    after: ManagedTargetRecord,
    generation: string | null,
    rollbackRestart = false,
  ): AppliedProviderOperation {
    return Object.freeze({
      prepared,
      mutationDigest: canonicalSha256({ operationId: prepared.request.authorization.operationId, after: managedStateDigest(after) }),
      afterDigest: managedStateDigest(after),
      restartRequired: generation !== null,
      profileGeneration: generation,
      rollbackRestart,
    })
  }
}
