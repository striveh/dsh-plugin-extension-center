import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { canonicalJson, canonicalSha256 } from '../src/domain/index.ts'
import { CenterStateStore, storageKey } from '../src/host/index.ts'
import {
  decodeCenterManifest,
  decodeContinuationActivation,
  decodeContinuationActivationIntent,
  decodeManagedTarget,
  decodeOperationIndex,
  decodeProviderSnapshot,
  decodeStoredIntent,
  decodeStoredResolution,
  decodeTaskReceipt,
  durableManagedStateDigest,
} from '../src/host/state-codec.ts'
import type {
  ManagedTargetRecord,
  StoredContinuationActivation,
  StoredContinuationActivationIntent,
  StoredIntent,
  StoredOperationIndex,
  StoredProviderSnapshot,
  StoredResolution,
  StoredTaskReceipt,
} from '../src/host/state-store.ts'

const roots: string[] = []
const skill = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(entry => entry.kind === 'skill')!
const DIGEST = canonicalSha256({ fixture: 'state-codec' })
const OPERATION_ID = 'operation:state-codec'
const RESERVATION_ID = '00000000-0000-4000-8000-000000000010'
const RESOLUTION_ID = 'resolution:00000000-0000-4000-8000-000000000020'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'extension-state-codec-'))
  roots.push(value)
  return value
}

function managed(centerRoot: string): ManagedTargetRecord {
  const targetKey = `skill:web:user:${skill.name}`
  const version = {
    candidateRef: skill.candidateRef,
    artifactRevision: skill.artifact.version,
    artifactIntegrity: skill.artifact.integrity,
    materialPath: join(
      centerRoot,
      'material',
      'skills',
      storageKey(targetKey),
      storageKey(skill.artifact.integrity),
      'SKILL.md',
    ),
    configuration: { modelInvocable: true, projectRoot: null, userInvocable: true },
    enabled: true,
    ownerRevision: `skills:${DIGEST}`,
    kindState: {
      description: 'Strict durable Skill fixture',
      modelInvocable: true,
      skillName: skill.name,
      userInvocable: true,
    },
  }
  return {
    schemaVersion: 1,
    kind: 'skill',
    extensionId: skill.name,
    targetKey,
    scopeKey: 'user',
    profileId: 'web',
    revision: 1,
    lastOperationId: OPERATION_ID,
    current: version,
    lastGood: null,
    removed: null,
    pending: null,
    updatedAtMs: 10,
  }
}

function storedIntent(): StoredIntent {
  const core = {
    kind: 'skill' as const,
    extensionId: skill.name,
    candidateRef: skill.candidateRef,
    artifactRevision: skill.artifact.version,
    artifactIntegrity: skill.artifact.integrity,
    artifactUrl: skill.artifact.acquisitionUrl,
    artifactSizeBytes: skill.artifact.sizeBytes,
    scopeKey: 'user',
    profileId: 'web',
    operationKind: 'install' as const,
    desiredState: 'enabled' as const,
    admittedCapabilities: [...skill.tags].sort(),
    authorityDeltaDigest: DIGEST,
    policyRevision: 'extension-center-p0-policy-v2',
    catalogRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
    inventoryRevision: DIGEST,
  }
  return {
    schemaVersion: 1,
    intent: {
      schemaVersion: 1,
      intentId: 'intent:state-codec',
      origin: 'store',
      idempotencyKey: DIGEST,
      continuationId: null,
      createdAtMs: 10,
      expiresAtMs: 20,
      core,
      coreDigest: canonicalSha256(core),
    },
    payload: {
      configuration: {},
      continuationId: null,
      resolutionId: null,
      verificationPayloadDigest: null,
      taskSessionId: null,
      taskOriginalMessageId: null,
    },
    planHash: DIGEST,
  }
}

function resolution(
  resolutionId = RESOLUTION_ID,
  createdAtMs = 10,
): StoredResolution {
  const expiresAtMs = createdAtMs + 100
  return {
    schemaVersion: 1,
    resolutionId,
    createdAtMs,
    expiresAtMs,
    needDigest: DIGEST,
    decision: 'use-existing',
    candidateRefs: [],
    value: {
      candidates: [],
      catalogEntriesDigest: DIGEST,
      catalogRevision: 1,
      continuationId: null,
      createdAtMs,
      decision: 'use-existing',
      expiresAtMs,
      intentId: 'intent:resolution',
      inventoryRevision: DIGEST,
      originalMessageId: 'message:resolution',
      planId: 'plan:resolution',
      profileId: 'web',
      resumeAgentOptions: {},
      scopeKey: 'user',
      sessionId: 'session:resolution',
      taskAttemptId: 'task-attempt:00000000-0000-4000-8000-000000000001',
      verificationPayloadDigest: null,
    },
  }
}

function operationIndex(targetKey: string): StoredOperationIndex {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    planHash: DIGEST,
    targetKey,
    extensionKind: 'skill',
    operationKind: 'install',
    phase: 'authorized',
    lastAtMs: 10,
  }
}

function providerSnapshot(centerRoot: string, before: ManagedTargetRecord): StoredProviderSnapshot {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    targetKey: before.targetKey,
    before,
    beforeDigest: durableManagedStateDigest(before),
    recoveryPoint: {
      kind: 'skill',
      parsed: null,
      configuration: before.current!.configuration,
      destination: null,
      stagingPath: null,
      contentIntegrity: skill.artifact.integrity,
    },
  }
}

function taskReceipt(): StoredTaskReceipt {
  return {
    schemaVersion: 1,
    continuationId: 'continuation:state-codec',
    resolutionId: RESOLUTION_ID,
    verificationPayloadDigest: DIGEST,
    planHash: DIGEST,
    operationId: OPERATION_ID,
    operationReceiptDigest: DIGEST,
    completedAtMs: 10,
  }
}

function activation(): StoredContinuationActivation {
  return {
    schemaVersion: 1,
    reservationId: RESERVATION_ID,
    continuationId: 'continuation:state-codec',
    resolutionId: RESOLUTION_ID,
    planHash: DIGEST,
    sessionId: 'session:state-codec',
    originalMessageId: 'message:state-codec',
    needDigest: DIGEST,
    taskRevision: 'extension-center-state-codec',
    verificationPayloadDigest: DIGEST,
    createdAtMs: 10,
  }
}

function activationIntent(): StoredContinuationActivationIntent {
  return {
    schemaVersion: 1,
    reservationId: RESERVATION_ID,
    callerId: 'extension-center',
    mutationId: RESERVATION_ID,
    resolutionId: RESOLUTION_ID,
    planHash: DIGEST,
    sessionId: 'session:state-codec',
    originalMessageId: 'message:state-codec',
    needDigest: DIGEST,
    taskRevision: 'extension-center-state-codec',
    verificationPayloadDigest: DIGEST,
    resumeAgentOptions: { maxTokens: 1024, model: 'model', provider: 'provider' },
    expiresAtMs: 20,
    createdAtMs: 10,
  }
}

function withExtra(value: object): object {
  return { ...value, unexpected: true }
}

describe('Host durable state codec faults', () => {
  it('rejects continuation routes that exceed the published Host limits', () => {
    const oversizedRoute = resolution()
    ;(oversizedRoute.value as Record<string, unknown>).resumeAgentOptions = { provider: '界'.repeat(100) }
    expect(() => decodeStoredResolution(oversizedRoute)).toThrow(/at most 256 UTF-8 bytes/)

    const oversizedBudget = resolution()
    ;(oversizedBudget.value as Record<string, unknown>).resumeAgentOptions = { maxTokens: 1_000_001 }
    expect(() => decodeStoredResolution(oversizedBudget)).toThrow(/must be at most 1000000/)
  })

  it('rejects extra fields for every durable record type', async () => {
    const centerRoot = await root()
    const target = managed(centerRoot)
    const cases: readonly Readonly<{ name: string; decode(): unknown }>[] = [
      { name: 'manifest', decode: () => decodeCenterManifest(withExtra({ schemaVersion: 1, centerId: RESERVATION_ID, createdAtMs: 1 })) },
      { name: 'managed', decode: () => decodeManagedTarget(withExtra(target), centerRoot) },
      { name: 'intent', decode: () => decodeStoredIntent(withExtra(storedIntent())) },
      { name: 'resolution', decode: () => decodeStoredResolution(withExtra(resolution())) },
      { name: 'operation index', decode: () => decodeOperationIndex(withExtra(operationIndex(target.targetKey))) },
      { name: 'provider snapshot', decode: () => decodeProviderSnapshot(withExtra(providerSnapshot(centerRoot, target)), centerRoot) },
      { name: 'task receipt', decode: () => decodeTaskReceipt(withExtra(taskReceipt())) },
      { name: 'continuation activation', decode: () => decodeContinuationActivation(withExtra(activation())) },
      { name: 'continuation activation intent', decode: () => decodeContinuationActivationIntent(withExtra(activationIntent())) },
    ]
    for (const item of cases) expect(item.decode, item.name).toThrow(/fields must be exactly/)
  })

  it('binds managed paths and provider snapshots to exact targets, operations, and before digests', async () => {
    const centerRoot = await root()
    const state = new CenterStateStore(centerRoot)
    await state.initialize()
    const target = managed(centerRoot)
    await state.putManaged(target, 0)

    const escaped = {
      ...target,
      revision: 2,
      current: { ...target.current!, materialPath: join(centerRoot, 'outside', 'SKILL.md') },
    }
    await expect(state.putManaged(escaped, 1)).rejects.toThrow(/materialPath does not bind/)

    const snapshot = providerSnapshot(centerRoot, target)
    await expect(state.putProviderSnapshot({ ...snapshot, beforeDigest: canonicalSha256({ wrong: true }) }))
      .rejects.toThrow(/beforeDigest does not match before/)
    await state.putProviderSnapshot(snapshot)

    const path = join(centerRoot, 'state', 'provider-snapshots', `${storageKey(OPERATION_ID)}.json`)
    const substituted = { ...snapshot, operationId: 'operation:substituted' }
    await writeFile(path, `${canonicalJson(substituted)}\n`, 'utf8')
    await expect(new CenterStateStore(centerRoot).initialize()).rejects.toThrow(/filename does not bind/)
  })

  it('fails closed on partial cold-start state before any owner mutation', async () => {
    const centerRoot = await root()
    const state = new CenterStateStore(centerRoot)
    await state.initialize()
    const target = managed(centerRoot)
    await state.putManaged(target, 0)
    const path = join(centerRoot, 'state', 'managed', `${storageKey(target.targetKey)}.json`)
    await writeFile(path, '{"schemaVersion":1', 'utf8')

    let ownerMutations = 0
    await expect((async () => {
      await new CenterStateStore(centerRoot).initialize()
      ownerMutations += 1
    })()).rejects.toThrow(/durable record is incomplete/)
    expect(ownerMutations).toBe(0)
  })

  it('lists resolutions deterministically and rejects corrupt resolution records during list and cold start', async () => {
    const centerRoot = await root()
    const state = new CenterStateStore(centerRoot)
    await state.initialize()
    const later = resolution('resolution:00000000-0000-4000-8000-000000000022', 20)
    const earlier = resolution('resolution:00000000-0000-4000-8000-000000000021', 10)
    await state.putResolution(later)
    await state.putResolution(earlier)
    await expect(state.listResolutions()).resolves.toMatchObject([
      { resolutionId: earlier.resolutionId },
      { resolutionId: later.resolutionId },
    ])

    const path = join(centerRoot, 'state', 'resolutions', `${storageKey(later.resolutionId)}.json`)
    await mkdir(join(centerRoot, 'state', 'resolutions'), { recursive: true })
    await writeFile(path, `${canonicalJson(withExtra(later))}\n`, 'utf8')
    await expect(state.listResolutions()).rejects.toThrow(/fields must be exactly/)
    await expect(new CenterStateStore(centerRoot).initialize()).rejects.toThrow(/fields must be exactly/)
  })
})
