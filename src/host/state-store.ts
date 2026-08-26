import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { canonicalJson } from '../domain/index.ts'
import type { AcquisitionIntent } from '../policy/index.ts'
import type { ManagedExtensionKind, OperationKind } from '../plans/index.ts'
import type { OperationPhase } from '../operations/index.ts'
import type { RpcJson } from '../service/rpc-contract.ts'
import {
  ensurePrivateDirectory,
  openRegularNoFollow,
  storageKey,
  writeCanonicalAtomic,
  writeCanonicalExclusive,
} from './files.ts'
import {
  assertStateFileIdentity,
  decodeCenterManifest,
  decodeContinuationActivation,
  decodeContinuationActivationIntent,
  decodeManagedTarget,
  decodeOperationIndex,
  decodeProfileBootAck,
  decodeProviderSnapshot,
  decodeStoredIntent,
  decodeStoredResolution,
  decodeTaskReceipt,
} from './state-codec.ts'

/** Exact materialized version controlled by the center. */
export interface ManagedVersion {
  readonly candidateRef: string
  readonly artifactRevision: string
  readonly artifactIntegrity: string
  readonly materialPath: string
  readonly configuration: RpcJson
  readonly enabled: boolean
  readonly ownerRevision: string
  readonly kindState: RpcJson
}

/** Durable center-owned target state with one named recovery point. */
export interface ManagedTargetRecord {
  readonly schemaVersion: 1
  readonly kind: ManagedExtensionKind
  readonly extensionId: string
  readonly targetKey: string
  readonly scopeKey: string
  readonly profileId: string
  readonly revision: number
  readonly lastOperationId: string | null
  readonly current: ManagedVersion | null
  readonly lastGood: ManagedVersion | null
  readonly removed: ManagedVersion | null
  readonly pending: RpcJson | null
  readonly updatedAtMs: number
}

/** Exact mutation payload kept outside the model-visible immutable plan. */
export interface LifecyclePayload {
  readonly configuration: RpcJson
  readonly continuationId: string | null
  readonly resolutionId: string | null
  readonly verificationPayloadDigest: string | null
  readonly taskSessionId: string | null
  readonly taskOriginalMessageId: string | null
}

/** Durable binding between an intent, its payload, and one immutable plan hash. */
export interface StoredIntent {
  readonly schemaVersion: 1
  readonly intent: AcquisitionIntent
  readonly payload: LifecyclePayload
  readonly planHash: string
}

/** Opaque model resolution retained only on the Host. */
export interface StoredResolution {
  readonly schemaVersion: 1
  readonly resolutionId: string
  readonly createdAtMs: number
  readonly expiresAtMs: number
  readonly needDigest: string
  readonly decision: string
  readonly candidateRefs: readonly string[]
  readonly value: RpcJson
}

/** Durable operation index used without weakening the journal's authority. */
export interface StoredOperationIndex {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly planHash: string
  readonly targetKey: string
  readonly extensionKind: ManagedExtensionKind
  readonly operationKind: OperationKind
  readonly phase: OperationPhase
  readonly lastAtMs: number
}

/** Exact pre-mutation provider state needed to rollback after process death. */
export interface StoredProviderSnapshot {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly targetKey: string
  readonly before: ManagedTargetRecord | null
  readonly beforeDigest: string
  readonly recoveryPoint: RpcJson
}

/** External boot acknowledgement bound to one Profile generation operation. */
export interface StoredProfileBootAck {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly profileId: string
  readonly generation: string
  readonly phase: 'candidate' | 'rollback'
  readonly revision: number
  readonly treeDigest: string
  readonly consumerObserved: true
  readonly acknowledgedAtMs: number
}

/** Separate task-completion receipt consumed only by the continuation verifier. */
export interface StoredTaskReceipt {
  readonly schemaVersion: 1
  readonly continuationId: string
  readonly resolutionId: string
  readonly verificationPayloadDigest: string
  readonly planHash: string
  readonly operationId: string
  readonly operationReceiptDigest: string
  readonly completedAtMs: number
}

/** Durable reservation-to-claim binding created only after a human approval. */
export interface StoredContinuationActivation {
  readonly schemaVersion: 1
  readonly reservationId: string
  readonly continuationId: string
  readonly resolutionId: string
  readonly planHash: string
  readonly sessionId: string
  readonly originalMessageId: string
  readonly needDigest: string
  readonly taskRevision: string
  readonly verificationPayloadDigest: string
  readonly createdAtMs: number
}

/** Durable claim-creation intent written only after the exact plan is approved. */
export interface StoredContinuationActivationIntent {
  readonly schemaVersion: 1
  readonly reservationId: string
  readonly callerId: 'extension-center'
  readonly mutationId: string
  readonly resolutionId: string
  readonly planHash: string
  readonly sessionId: string
  readonly originalMessageId: string
  readonly needDigest: string
  readonly taskRevision: string
  readonly verificationPayloadDigest: string
  readonly resumeAgentOptions: Readonly<{
    readonly provider?: string
    readonly model?: string
    readonly maxTokens?: number
  }>
  readonly expiresAtMs: number
  readonly createdAtMs: number
}

async function readDurableOptional(path: string): Promise<unknown | undefined> {
  let handle
  try {
    handle = await openRegularNoFollow(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let text: string
  try {
    text = await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) throw new Error(`durable record is incomplete: ${path}`)
  const value: unknown = JSON.parse(text)
  if (`${canonicalJson(value)}\n` !== text) throw new Error(`durable record is not canonical: ${path}`)
  return value
}

/** File-backed center manifest and per-identity durable records. */
export class CenterStateStore {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  /** Initialize the private root and its single-assignment identity manifest. */
  async initialize(nowMs = Date.now()): Promise<void> {
    await ensurePrivateDirectory(this.root)
    const path = join(this.root, 'manifest.json')
    const existing = await readDurableOptional(path)
    if (existing === undefined) {
      const manifest = decodeCenterManifest({ schemaVersion: 1, centerId: randomUUID(), createdAtMs: nowMs })
      try {
        await writeCanonicalExclusive(path, manifest)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    decodeCenterManifest(await readDurableOptional(path))
    await this.auditDurableState()
  }

  /** Load one managed target. */
  async getManaged(targetKey: string): Promise<ManagedTargetRecord | undefined> {
    const value = await readDurableOptional(this.path('managed', targetKey))
    return value === undefined ? undefined : decodeManagedTarget(value, this.root, targetKey)
  }

  /** Replace one target after checking its center revision. */
  async putManaged(record: ManagedTargetRecord, expectedRevision: number): Promise<void> {
    const decoded = decodeManagedTarget(record, this.root, record.targetKey)
    const prior = await this.getManaged(decoded.targetKey)
    const actual = prior?.revision ?? 0
    if (actual !== expectedRevision || decoded.revision !== expectedRevision + 1) {
      throw new Error(`managed target revision conflict: expected ${String(expectedRevision)}, actual ${String(actual)}`)
    }
    await writeCanonicalAtomic(this.path('managed', decoded.targetKey), decoded)
  }

  /** Remove an exact managed record only when its revision still matches. */
  async deleteManaged(targetKey: string, expectedRevision: number): Promise<void> {
    const prior = await this.getManaged(targetKey)
    if (prior === undefined || prior.revision !== expectedRevision) {
      throw new Error(`managed target revision conflict while deleting ${targetKey}`)
    }
    await rm(this.path('managed', targetKey))
  }

  /** Enumerate center-owned target records deterministically. */
  async listManaged(): Promise<readonly ManagedTargetRecord[]> {
    return this.listDirectory('managed', (value, name) => {
      const decoded = decodeManagedTarget(value, this.root)
      assertStateFileIdentity(name, decoded.targetKey, 'managed target')
      return decoded
    })
  }

  /** Persist one immutable intent binding exactly once. */
  async putIntent(value: StoredIntent): Promise<void> {
    const decoded = decodeStoredIntent(value, value.intent.intentId)
    await this.putExclusive(this.path('intents', decoded.intent.intentId), decoded)
  }

  /** Read an intent by identity. */
  async getIntent(intentId: string): Promise<StoredIntent | undefined> {
    const value = await readDurableOptional(this.path('intents', intentId))
    return value === undefined ? undefined : decodeStoredIntent(value, intentId)
  }

  /** Persist one opaque resolution exactly once. */
  async putResolution(value: StoredResolution): Promise<void> {
    const decoded = decodeStoredResolution(value, value.resolutionId)
    await this.putExclusive(this.path('resolutions', decoded.resolutionId), decoded)
  }

  /** Read one opaque resolution. */
  async getResolution(resolutionId: string): Promise<StoredResolution | undefined> {
    const value = await readDurableOptional(this.path('resolutions', resolutionId))
    return value === undefined ? undefined : decodeStoredResolution(value, resolutionId)
  }

  /** List Host-only task resolutions deterministically. */
  async listResolutions(): Promise<readonly StoredResolution[]> {
    const values = await this.listDirectory('resolutions', (value, name) => {
      const decoded = decodeStoredResolution(value)
      assertStateFileIdentity(name, decoded.resolutionId, 'stored resolution')
      return decoded
    })
    return Object.freeze([...values].sort((left, right) => left.createdAtMs - right.createdAtMs
      || left.resolutionId.localeCompare(right.resolutionId)))
  }

  /** Replace the non-authoritative operation lookup row. */
  async putOperationIndex(value: StoredOperationIndex): Promise<void> {
    const decoded = decodeOperationIndex(value, value.operationId)
    await writeCanonicalAtomic(this.path('operation-index', decoded.operationId), decoded)
  }

  /** List operation lookup rows; callers re-read journals before trusting phase fields. */
  async listOperationIndexes(): Promise<readonly StoredOperationIndex[]> {
    return this.listDirectory('operation-index', (value, name) => {
      const decoded = decodeOperationIndex(value)
      assertStateFileIdentity(name, decoded.operationId, 'operation index')
      return decoded
    })
  }

  /** Persist the exact provider recovery point before entering applying. */
  async putProviderSnapshot(value: StoredProviderSnapshot): Promise<void> {
    const decoded = decodeProviderSnapshot(value, this.root, value.operationId)
    await this.putExclusive(this.path('provider-snapshots', decoded.operationId), decoded)
  }

  /** Read one exact provider recovery point. */
  async getProviderSnapshot(operationId: string): Promise<StoredProviderSnapshot | undefined> {
    const value = await readDurableOptional(this.path('provider-snapshots', operationId))
    return value === undefined ? undefined : decodeProviderSnapshot(value, this.root, operationId)
  }

  /** Persist or idempotently replace an exact external boot acknowledgement. */
  async putBootAck(value: StoredProfileBootAck): Promise<void> {
    const next = decodeProfileBootAck(value, value.operationId)
    const path = this.path('boot-acks', next.operationId)
    const prior = await readDurableOptional(path)
    if (prior !== undefined) {
      const decoded = decodeProfileBootAck(prior, next.operationId)
      const same = decoded.profileId === next.profileId
        && decoded.generation === next.generation
        && decoded.phase === next.phase
        && decoded.revision === next.revision
        && decoded.treeDigest === next.treeDigest
      const forwardRollback = decoded.profileId === next.profileId
        && decoded.phase === 'candidate'
        && next.phase === 'rollback'
      if (!same && !forwardRollback) {
        throw new Error('boot acknowledgement conflicts with its prior binding')
      }
    }
    await writeCanonicalAtomic(path, next)
  }

  /** Read one external boot acknowledgement. */
  async getBootAck(operationId: string): Promise<StoredProfileBootAck | undefined> {
    const value = await readDurableOptional(this.path('boot-acks', operationId))
    return value === undefined ? undefined : decodeProfileBootAck(value, operationId)
  }

  /** Persist the single verified lifecycle result that may release one parked task. */
  async putTaskReceipt(value: StoredTaskReceipt): Promise<void> {
    const decoded = decodeTaskReceipt(value, value.continuationId)
    await this.putExclusive(this.path('task-receipts', decoded.continuationId), decoded)
  }

  /** Read the verified lifecycle result for one continuation claim. */
  async getTaskReceipt(continuationId: string): Promise<StoredTaskReceipt | undefined> {
    const value = await readDurableOptional(this.path('task-receipts', continuationId))
    return value === undefined ? undefined : decodeTaskReceipt(value, continuationId)
  }

  /** Persist the actual continuation claim bound to an approved plan reservation. */
  async putContinuationActivation(value: StoredContinuationActivation): Promise<void> {
    const decoded = decodeContinuationActivation(value, value.reservationId)
    await this.putExclusive(this.path('continuation-activations', decoded.reservationId), decoded)
  }

  /** Read an approved plan's reservation-to-claim binding. */
  async getContinuationActivation(reservationId: string): Promise<StoredContinuationActivation | undefined> {
    const value = await readDurableOptional(this.path('continuation-activations', reservationId))
    return value === undefined
      ? undefined
      : decodeContinuationActivation(value, reservationId)
  }

  /** Persist the approved claim-creation intent before touching the continuation owner. */
  async putContinuationActivationIntent(value: StoredContinuationActivationIntent): Promise<void> {
    const decoded = decodeContinuationActivationIntent(value, value.reservationId)
    await this.putExclusive(this.path('continuation-activation-intents', decoded.reservationId), decoded)
  }

  /** Read an approved claim-creation intent during cold reconciliation. */
  async getContinuationActivationIntent(reservationId: string): Promise<StoredContinuationActivationIntent | undefined> {
    const value = await readDurableOptional(this.path('continuation-activation-intents', reservationId))
    return value === undefined
      ? undefined
      : decodeContinuationActivationIntent(value, reservationId)
  }

  private path(group: string, id: string): string {
    return join(this.root, 'state', group, `${storageKey(id)}.json`)
  }

  private async putExclusive(path: string, value: unknown): Promise<void> {
    const prior = await readDurableOptional(path)
    if (prior !== undefined) {
      if (JSON.stringify(prior) !== JSON.stringify(value)) throw new Error('single-assignment record already exists')
      return
    }
    try {
      await writeCanonicalExclusive(path, value)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const raced = await readDurableOptional(path)
      if (JSON.stringify(raced) !== JSON.stringify(value)) throw new Error('single-assignment record raced with different content')
    }
  }

  private async auditDurableState(): Promise<void> {
    const stateRoot = join(this.root, 'state')
    let entries: Dirent[]
    try {
      entries = await readdir(stateRoot, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      entries = []
    }
    const groups = new Set([
      'boot-acks',
      'continuation-activation-intents',
      'continuation-activations',
      'intents',
      'managed',
      'operation-index',
      'provider-snapshots',
      'resolutions',
      'task-receipts',
      'task-attempt-derivations',
      'task-attempts',
      'task-retry-continuations',
    ])
    for (const entry of entries) {
      if (!groups.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`unexpected durable state entry: ${join(stateRoot, entry.name)}`)
      }
    }
    await this.listManaged()
    await this.listResolutions()
    await this.listOperationIndexes()
    await this.listDirectory('intents', (value, name) => {
      const decoded = decodeStoredIntent(value)
      assertStateFileIdentity(name, decoded.intent.intentId, 'stored intent')
    })
    await this.listDirectory('provider-snapshots', (value, name) => {
      const decoded = decodeProviderSnapshot(value, this.root)
      assertStateFileIdentity(name, decoded.operationId, 'provider snapshot')
    })
    await this.listDirectory('boot-acks', (value, name) => {
      const decoded = decodeProfileBootAck(value)
      assertStateFileIdentity(name, decoded.operationId, 'profile boot acknowledgement')
    })
    await this.listDirectory('task-receipts', (value, name) => {
      const decoded = decodeTaskReceipt(value)
      assertStateFileIdentity(name, decoded.continuationId, 'task receipt')
    })
    await this.listDirectory('continuation-activations', (value, name) => {
      const decoded = decodeContinuationActivation(value)
      assertStateFileIdentity(name, decoded.reservationId, 'continuation activation')
    })
    await this.listDirectory('continuation-activation-intents', (value, name) => {
      const decoded = decodeContinuationActivationIntent(value)
      assertStateFileIdentity(name, decoded.reservationId, 'continuation activation intent')
    })
  }

  private async listDirectory<T>(group: string, decode: (value: unknown, name: string) => T): Promise<readonly T[]> {
    const directory = join(this.root, 'state', group)
    let names: string[]
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`durable state group is not a real directory: ${directory}`)
      names = await readdir(directory)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const output: T[] = []
    for (const name of names.sort()) {
      if (/^\.tmp-[0-9a-f-]{36}$/.test(name)) continue
      if (!/^[0-9a-f]{64}\.json$/.test(name)) throw new Error(`unexpected durable record entry: ${join(directory, name)}`)
      const value = await readDurableOptional(join(directory, name))
      if (value !== undefined) output.push(decode(value, name))
    }
    return Object.freeze(output)
  }
}
