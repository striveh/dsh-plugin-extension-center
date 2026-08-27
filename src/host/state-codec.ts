import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  readArtifactIntegrity,
  readBoundedString,
  readLiteral,
  readNonNegativeInteger,
  readSha256Digest,
  readStrictRecord,
} from '../domain/codec.ts'
import { failDomain } from '../domain/errors.ts'
import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type { AcquisitionIntent, AcquisitionIntentCore } from '../policy/index.ts'
import type { DesiredState, ManagedExtensionKind, OperationKind } from '../plans/index.ts'
import type { OperationPhase } from '../operations/index.ts'
import { decodeProfileMetadataCacheBinding } from '../recovery/profile-metadata-cache.ts'
import type { RpcJson } from '../service/rpc-contract.ts'
import { storageKey } from './files.ts'
import type {
  LifecyclePayload,
  ManagedTargetRecord,
  ManagedVersion,
  StoredContinuationActivation,
  StoredContinuationActivationIntent,
  StoredIntent,
  StoredOperationIndex,
  StoredProviderSnapshot,
  StoredResolution,
  StoredTaskReceipt,
} from './state-store.ts'

const KINDS = ['mcp', 'plugin', 'skill'] as const
const OPERATIONS = ['configure', 'disable', 'enable', 'install', 'purge', 'restore', 'uninstall', 'update'] as const
const DESIRED_STATES = ['disabled', 'enabled', 'removed'] as const
const PHASES = [
  'applying',
  'authorized',
  'committed',
  'failed',
  'recovery-required',
  'rolled-back',
  'rolling-back',
  'staging',
  'verifying',
] as const
const RESOLUTION_DECISIONS = [
  'acquisition-candidate',
  'choice-required',
  'discovery-unavailable',
  'management-required',
  'no-eligible-candidate',
  'use-existing',
] as const
const CANDIDATE_REF = /^(?:mcp|plugin|skill):[A-Za-z0-9@._:/-]{1,240}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_RPC_DEPTH = 16
const MAX_RPC_NODES = 4096
const MAX_CONTINUATION_ROUTE_BYTES = 256
const MAX_CONTINUATION_RESUME_TOKENS = 1_000_000

interface CenterManifest {
  readonly schemaVersion: 1
  readonly centerId: string
  readonly createdAtMs: number
}

interface RpcBudget {
  nodes: number
}

function fail(path: string, reason: string): never {
  return failDomain('invalid-data', `${path} ${reason}`)
}

function schema(record: Readonly<Record<string, unknown>>, path: string): void {
  if (record.schemaVersion !== 1) fail(path, 'has an unsupported schemaVersion')
}

function positiveInteger(value: unknown, path: string): number {
  const output = readNonNegativeInteger(value, path)
  if (output === 0) fail(path, 'must be a positive safe integer')
  return output
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be boolean')
  return value
}

function nullableString(value: unknown, path: string, maximumLength = 512): string | null {
  return value === null ? null : readBoundedString(value, path, maximumLength)
}

function exactOptionalRecord(
  value: unknown,
  permitted: readonly string[],
  path: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
  const object = value as object
  const prototype = Object.getPrototypeOf(object)
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain object')
  const keys = Reflect.ownKeys(object)
  if (keys.some(key => typeof key !== 'string' || !permitted.includes(key))) {
    fail(path, `fields may only be ${[...permitted].sort().join(', ')}`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(object)
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
      fail(`${path}.${key}`, 'must be an enumerable data field')
    }
  }
  return value as Readonly<Record<string, unknown>>
}

function rpcJson(value: unknown, path: string, depth = 0, budget: RpcBudget = { nodes: 0 }): RpcJson {
  budget.nodes += 1
  if (budget.nodes > MAX_RPC_NODES) fail(path, 'exceeds the durable JSON node bound')
  if (depth > MAX_RPC_DEPTH) fail(path, 'exceeds the durable JSON depth bound')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return readBoundedString(value, path, 16_384)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must be a finite JSON number')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 256) fail(path, 'exceeds the durable JSON array bound')
    return Object.freeze(value.map((item, index) => rpcJson(item, `${path}[${String(index)}]`, depth + 1, budget)))
  }
  if (typeof value !== 'object' || value === null) fail(path, 'must contain only JSON values')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain JSON object')
  const keys = Reflect.ownKeys(value)
  if (keys.length > 128 || keys.some(key => typeof key !== 'string')) fail(path, 'has invalid or excessive JSON fields')
  const output: Record<string, RpcJson> = {}
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of (keys as string[]).sort()) {
    readBoundedString(key, `${path} key`, 128)
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
      fail(`${path}.${key}`, 'must be an enumerable JSON data field')
    }
    output[key] = rpcJson(descriptor.value, `${path}.${key}`, depth + 1, budget)
  }
  return Object.freeze(output)
}

function uniqueStrings(value: unknown, path: string, maximum = 64, sorted = false): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path, 'must be a bounded string array')
  const output = value.map((item, index) => readBoundedString(item, `${path}[${String(index)}]`, 512))
  if (new Set(output).size !== output.length) fail(path, 'must not contain duplicates')
  if (sorted && output.some((item, index) => item !== [...output].sort()[index])) fail(path, 'must be sorted')
  return Object.freeze(output)
}

function boundedStrings(value: unknown, path: string, maximum = 64): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path, 'must be a bounded string array')
  return Object.freeze(value.map((item, index) => readBoundedString(item, `${path}[${String(index)}]`, 512)))
}

function candidateRef(value: unknown, path: string, kind?: ManagedExtensionKind): string {
  const output = readBoundedString(value, path, 256)
  if (!CANDIDATE_REF.test(output) || (kind !== undefined && !output.startsWith(`${kind}:`))) {
    fail(path, 'must be a kind-bound candidateRef')
  }
  return output
}

function absolutePath(value: unknown, path: string): string {
  const output = readBoundedString(value, path, 4096)
  if (!isAbsolute(output) || resolve(output) !== output) fail(path, 'must be a canonical absolute path')
  return output
}

function mcpHttpCoordinates(originValue: unknown, endpointValue: unknown, path: string): Readonly<{ origin: string; endpoint: string }> {
  const origin = readBoundedString(originValue, `${path}.origin`, 2048)
  const endpoint = readBoundedString(endpointValue, `${path}.endpoint`, 2048)
  let parsedOrigin: URL
  let parsedEndpoint: URL
  try {
    parsedOrigin = new URL(origin)
    parsedEndpoint = new URL(endpoint)
  } catch {
    fail(path, 'must contain absolute HTTPS coordinates')
  }
  if (parsedOrigin!.protocol !== 'https:' || parsedEndpoint!.protocol !== 'https:'
    || parsedOrigin!.username !== '' || parsedOrigin!.password !== ''
    || parsedEndpoint!.username !== '' || parsedEndpoint!.password !== ''
    || parsedOrigin!.pathname !== '/' || parsedOrigin!.search !== '' || parsedOrigin!.hash !== ''
    || parsedEndpoint!.hash !== ''
    || parsedOrigin!.origin !== origin || parsedEndpoint!.toString() !== endpoint
    || parsedEndpoint!.origin !== origin) fail(path, 'must contain canonical credential-free HTTPS coordinates')
  return Object.freeze({ origin, endpoint })
}

function below(root: string, path: string): boolean {
  const rel = relative(resolve(root), path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function kindFromTarget(targetKey: string, path: string): ManagedExtensionKind {
  const kind = targetKey.slice(0, targetKey.indexOf(':'))
  return readLiteral(kind, KINDS, path)
}

function targetIdentity(
  kind: ManagedExtensionKind,
  profileId: string,
  scopeKey: string,
  extensionId: string,
): string {
  return `${kind}:${profileId}:${scopeKey}:${extensionId}`
}

function skillConfiguration(value: unknown, path: string, scopeKey: string): RpcJson {
  const record = readStrictRecord(value, ['modelInvocable', 'projectRoot', 'userInvocable'], path)
  const projectRoot = record.projectRoot === null ? null : absolutePath(record.projectRoot, `${path}.projectRoot`)
  if (scopeKey === 'user' && projectRoot !== null) fail(path, 'must not bind projectRoot for user scope')
  if (scopeKey === 'project' && projectRoot === null) fail(path, 'must bind projectRoot for project scope')
  return Object.freeze({
    modelInvocable: boolean(record.modelInvocable, `${path}.modelInvocable`),
    projectRoot,
    userInvocable: boolean(record.userInvocable, `${path}.userInvocable`),
  })
}

function mcpConfiguration(value: unknown, path: string): RpcJson {
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
  const transport = readLiteral(raw?.transport, ['stdio', 'streamable-http'] as const, `${path}.transport`)
  const record = readStrictRecord(
    value,
    transport === 'stdio'
      ? ['connectionId', 'reconnect', 'roots', 'runtimeRef', 'toolCallTimeoutMs', 'transport']
      : ['connectionId', 'reconnect', 'runtimeRef', 'toolCallTimeoutMs', 'transport'],
    path,
  )
  const connectionId = readBoundedString(record.connectionId, `${path}.connectionId`, 32)
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(connectionId)) fail(`${path}.connectionId`, 'is invalid')
  const runtimeRef = readBoundedString(record.runtimeRef, `${path}.runtimeRef`, 128)
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(runtimeRef)) fail(`${path}.runtimeRef`, 'is invalid')
  const roots = transport === 'stdio'
    ? (() => {
        if (!Array.isArray(record.roots) || record.roots.length === 0 || record.roots.length > 16) {
          fail(`${path}.roots`, 'must contain between one and sixteen absolute paths')
        }
        return record.roots.map((item, index) => absolutePath(item, `${path}.roots[${String(index)}]`))
      })()
    : null
  const timeout = positiveInteger(record.toolCallTimeoutMs, `${path}.toolCallTimeoutMs`)
  if (timeout < 100 || timeout > 300_000) fail(`${path}.toolCallTimeoutMs`, 'is outside 100..300000')
  const reconnect = readStrictRecord(record.reconnect, ['enabled', 'initialDelayMs', 'maxAttempts', 'maxDelayMs'], `${path}.reconnect`)
  const initialDelayMs = positiveInteger(reconnect.initialDelayMs, `${path}.reconnect.initialDelayMs`)
  const maxDelayMs = positiveInteger(reconnect.maxDelayMs, `${path}.reconnect.maxDelayMs`)
  const maxAttempts = positiveInteger(reconnect.maxAttempts, `${path}.reconnect.maxAttempts`)
  if (initialDelayMs < 50 || initialDelayMs > 60_000 || maxDelayMs < 50 || maxDelayMs > 300_000
    || initialDelayMs > maxDelayMs || maxAttempts > 100) fail(`${path}.reconnect`, 'is outside the admitted bounds')
  const common = {
    connectionId,
    reconnect: Object.freeze({
      enabled: boolean(reconnect.enabled, `${path}.reconnect.enabled`),
      initialDelayMs,
      maxAttempts,
      maxDelayMs,
    }),
    runtimeRef,
    toolCallTimeoutMs: timeout,
  }
  return transport === 'stdio'
    ? Object.freeze({ ...common, roots: Object.freeze(roots!), transport: 'stdio' })
    : Object.freeze({ ...common, transport: 'streamable-http' })
}

function runtimeEvidence(value: unknown, path: string): RpcJson {
  const record = readStrictRecord(value, ['entryId', 'fiberPhase', 'moduleName'], path)
  return Object.freeze({
    entryId: readBoundedString(record.entryId, `${path}.entryId`),
    fiberPhase: readLiteral(record.fiberPhase, ['absent', 'active'] as const, `${path}.fiberPhase`),
    moduleName: readBoundedString(record.moduleName, `${path}.moduleName`),
  })
}

function versionKindState(
  value: unknown,
  path: string,
  kind: ManagedExtensionKind,
  extensionId: string,
  materialPath: string,
  root: string,
): RpcJson {
  if (kind === 'skill') {
    const record = readStrictRecord(value, ['description', 'modelInvocable', 'skillName', 'userInvocable'], path)
    const skillName = readBoundedString(record.skillName, `${path}.skillName`, 128)
    if (skillName !== extensionId) fail(`${path}.skillName`, 'does not bind the managed extension')
    return Object.freeze({
      description: readBoundedString(record.description, `${path}.description`, 4096),
      modelInvocable: boolean(record.modelInvocable, `${path}.modelInvocable`),
      skillName,
      userInvocable: boolean(record.userInvocable, `${path}.userInvocable`),
    })
  }
  if (kind === 'mcp') {
    const raw = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>>
      : undefined
    const transport = readLiteral(raw?.transport, ['stdio', 'streamable-http'] as const, `${path}.transport`)
    const record = readStrictRecord(value, transport === 'stdio'
      ? ['configured', 'connectionId', 'descriptorDigest', 'executablePath', 'runtimeRef', 'runtimeVersion', 'transport']
      : ['configured', 'connectionId', 'dataEgressDisclosure', 'descriptorDigest', 'endpoint', 'origin', 'runtimeRef', 'runtimeVersion', 'transport'], path)
    const common = {
      configured: boolean(record.configured, `${path}.configured`),
      connectionId: readBoundedString(record.connectionId, `${path}.connectionId`, 32),
      descriptorDigest: readSha256Digest(record.descriptorDigest, `${path}.descriptorDigest`),
      runtimeRef: readBoundedString(record.runtimeRef, `${path}.runtimeRef`, 128),
      runtimeVersion: readBoundedString(record.runtimeVersion, `${path}.runtimeVersion`, 128),
    }
    if (transport === 'stdio') {
      const executablePath = absolutePath(record.executablePath, `${path}.executablePath`)
      if (executablePath !== materialPath) fail(`${path}.executablePath`, 'does not bind materialPath')
      return Object.freeze({ ...common, executablePath, transport: 'stdio' })
    }
    if (materialPath !== resolve(root)) fail(`${path}.materialPath`, 'does not bind the Center management root')
    const coordinates = mcpHttpCoordinates(record.origin, record.endpoint, path)
    return Object.freeze({
      ...common,
      ...coordinates,
      dataEgressDisclosure: readBoundedString(record.dataEgressDisclosure, `${path}.dataEgressDisclosure`, 2048),
      transport: 'streamable-http',
    })
  }
  const baseFields = ['consumerObserved', 'restartObserved', 'loaderPhase', 'packageName', 'restartToken', 'treeDigest']
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
  const hasEvidence = raw !== undefined && Object.prototype.hasOwnProperty.call(raw, 'runtimeEvidence')
  const hasRollback = raw !== undefined && Object.prototype.hasOwnProperty.call(raw, 'rollbackOperationId')
  const record = readStrictRecord(value, [
    ...baseFields,
    ...(hasRollback ? ['rollbackOperationId'] : []),
    ...(hasEvidence ? ['runtimeEvidence'] : []),
  ], path)
  const loaderPhase = readLiteral(record.loaderPhase, ['absent', 'active', 'pending-restart'] as const, `${path}.loaderPhase`)
  const consumerObserved = boolean(record.consumerObserved, `${path}.consumerObserved`)
  const restartObserved = boolean(record.restartObserved, `${path}.restartObserved`)
  if (loaderPhase === 'pending-restart') {
    if (consumerObserved || restartObserved || hasEvidence) fail(path, 'has contradictory pending-restart evidence')
  } else if (!consumerObserved || !restartObserved || !hasEvidence) {
    fail(path, 'has incomplete settled Loader evidence')
  }
  const evidence = hasEvidence ? runtimeEvidence(record.runtimeEvidence, `${path}.runtimeEvidence`) : undefined
  if (evidence !== undefined && (evidence as Readonly<Record<string, RpcJson>>).fiberPhase !== loaderPhase) {
    fail(`${path}.runtimeEvidence.fiberPhase`, 'does not bind loaderPhase')
  }
  return Object.freeze({
    consumerObserved,
    restartObserved,
    loaderPhase,
    packageName: readBoundedString(record.packageName, `${path}.packageName`, 214),
    restartToken: readBoundedString(record.restartToken, `${path}.restartToken`, 512),
    ...(hasRollback
      ? { rollbackOperationId: readBoundedString(record.rollbackOperationId, `${path}.rollbackOperationId`, 512) }
      : {}),
    ...(evidence === undefined ? {} : { runtimeEvidence: evidence }),
    treeDigest: readBoundedString(record.treeDigest, `${path}.treeDigest`, 512),
  })
}

function managedVersion(
  value: unknown,
  path: string,
  root: string,
  identity: Readonly<{
    kind: ManagedExtensionKind
    extensionId: string
    targetKey: string
    scopeKey: string
  }>,
): ManagedVersion {
  const record = readStrictRecord(
    value,
    ['artifactIntegrity', 'artifactRevision', 'candidateRef', 'configuration', 'enabled', 'kindState', 'materialPath', 'ownerRevision'],
    path,
  )
  const artifactIntegrity = readArtifactIntegrity(record.artifactIntegrity, `${path}.artifactIntegrity`)
  const materialPath = absolutePath(record.materialPath, `${path}.materialPath`)
  if (identity.kind === 'skill') {
    const expected = join(
      resolve(root),
      'material',
      'skills',
      storageKey(identity.targetKey),
      storageKey(artifactIntegrity),
      'SKILL.md',
    )
    if (materialPath !== expected) fail(`${path}.materialPath`, 'does not bind the target and artifact integrity')
  }
  const configuration = identity.kind === 'skill'
    ? skillConfiguration(record.configuration, `${path}.configuration`, identity.scopeKey)
    : identity.kind === 'mcp'
      ? mcpConfiguration(record.configuration, `${path}.configuration`)
      : rpcJson(record.configuration, `${path}.configuration`)
  const ownerRevision = readBoundedString(record.ownerRevision, `${path}.ownerRevision`, 1024)
  const ownerPrefix = identity.kind === 'plugin' ? 'managed-plugin:' : identity.kind === 'mcp' ? 'mcp:' : 'skills:'
  if (!ownerRevision.startsWith(ownerPrefix)) fail(`${path}.ownerRevision`, 'does not bind the extension owner')
  return immutableJsonClone({
    artifactIntegrity,
    artifactRevision: readBoundedString(record.artifactRevision, `${path}.artifactRevision`, 256),
    candidateRef: candidateRef(record.candidateRef, `${path}.candidateRef`, identity.kind),
    configuration,
    enabled: boolean(record.enabled, `${path}.enabled`),
    kindState: versionKindState(record.kindState, `${path}.kindState`, identity.kind, identity.extensionId, materialPath, root),
    materialPath,
    ownerRevision,
  }) as unknown as ManagedVersion
}

function nullableManagedVersion(
  value: unknown,
  path: string,
  root: string,
  identity: Readonly<{ kind: ManagedExtensionKind; extensionId: string; targetKey: string; scopeKey: string }>,
): ManagedVersion | null {
  return value === null ? null : managedVersion(value, path, root, identity)
}

function pendingMutation(
  value: unknown,
  path: string,
  kind: ManagedExtensionKind,
  profileId: string,
  operationId: string,
): RpcJson | null {
  if (value === null) return null
  if (kind !== 'plugin') fail(path, 'is only valid for managed Plugin mutations')
  const record = readStrictRecord(
    value,
    ['generation', 'operationId', 'operationKind', 'packageName', 'profileId', 'revision', 'treeDigest'],
    path,
  )
  const heldOperation = readBoundedString(record.operationId, `${path}.operationId`)
  if (heldOperation !== operationId) fail(`${path}.operationId`, 'does not bind lastOperationId')
  const heldProfile = readBoundedString(record.profileId, `${path}.profileId`)
  if (heldProfile !== profileId) fail(`${path}.profileId`, 'does not bind the managed target')
  return Object.freeze({
    generation: readBoundedString(record.generation, `${path}.generation`, 512),
    operationId: heldOperation,
    operationKind: readLiteral(record.operationKind, [...OPERATIONS, 'rollback'] as const, `${path}.operationKind`),
    packageName: readBoundedString(record.packageName, `${path}.packageName`, 214),
    profileId: heldProfile,
    revision: positiveInteger(record.revision, `${path}.revision`),
    treeDigest: readBoundedString(record.treeDigest, `${path}.treeDigest`, 512),
  })
}

/** Recompute the exact provider before-state digest without importing provider code. */
export function durableManagedStateDigest(record: ManagedTargetRecord | null): `sha256:${string}` {
  if (record === null) return canonicalSha256(null)
  return canonicalSha256({
    kind: record.kind,
    extensionId: record.extensionId,
    targetKey: record.targetKey,
    scopeKey: record.scopeKey,
    profileId: record.profileId,
    current: record.current,
    lastGood: record.lastGood,
    removed: record.removed,
    pending: record.pending,
  })
}

/** Decode the exact center identity manifest. */
export function decodeCenterManifest(value: unknown): CenterManifest {
  const path = 'center manifest'
  const record = readStrictRecord(value, ['centerId', 'createdAtMs', 'schemaVersion'], path)
  schema(record, path)
  const centerId = readBoundedString(record.centerId, `${path}.centerId`, 36)
  if (!UUID.test(centerId)) fail(`${path}.centerId`, 'must be a UUID')
  return Object.freeze({
    schemaVersion: 1,
    centerId,
    createdAtMs: readNonNegativeInteger(record.createdAtMs, `${path}.createdAtMs`),
  })
}

/** Decode one exact center-owned target and all retained versions. */
export function decodeManagedTarget(
  value: unknown,
  root: string,
  expectedTargetKey?: string,
): ManagedTargetRecord {
  const path = expectedTargetKey === undefined ? 'managed target' : `managed target ${expectedTargetKey}`
  const record = readStrictRecord(value, [
    'current', 'extensionId', 'kind', 'lastGood', 'lastOperationId', 'pending', 'profileId', 'removed',
    'revision', 'schemaVersion', 'scopeKey', 'targetKey', 'updatedAtMs',
  ], path)
  schema(record, path)
  const kind = readLiteral(record.kind, KINDS, `${path}.kind`)
  const extensionId = readBoundedString(record.extensionId, `${path}.extensionId`, 256)
  const scopeKey = readBoundedString(record.scopeKey, `${path}.scopeKey`, 512)
  const profileId = readBoundedString(record.profileId, `${path}.profileId`, 256)
  const targetKey = readBoundedString(record.targetKey, `${path}.targetKey`, 1024)
  if (targetKey !== targetIdentity(kind, profileId, scopeKey, extensionId)) fail(`${path}.targetKey`, 'does not bind kind/profile/scope/extension')
  if (expectedTargetKey !== undefined && targetKey !== expectedTargetKey) fail(`${path}.targetKey`, 'does not bind its storage identity')
  const lastOperationId = readBoundedString(record.lastOperationId, `${path}.lastOperationId`, 512)
  const identity = { kind, extensionId, targetKey, scopeKey }
  const output: ManagedTargetRecord = {
    schemaVersion: 1,
    kind,
    extensionId,
    targetKey,
    scopeKey,
    profileId,
    revision: positiveInteger(record.revision, `${path}.revision`),
    lastOperationId,
    current: nullableManagedVersion(record.current, `${path}.current`, root, identity),
    lastGood: nullableManagedVersion(record.lastGood, `${path}.lastGood`, root, identity),
    removed: nullableManagedVersion(record.removed, `${path}.removed`, root, identity),
    pending: pendingMutation(record.pending, `${path}.pending`, kind, profileId, lastOperationId),
    updatedAtMs: readNonNegativeInteger(record.updatedAtMs, `${path}.updatedAtMs`),
  }
  return immutableJsonClone(output) as unknown as ManagedTargetRecord
}

function intentCore(value: unknown, path: string): AcquisitionIntentCore {
  const record = readStrictRecord(value, [
    'admittedCapabilities', 'artifactIntegrity', 'artifactRevision', 'artifactSizeBytes', 'artifactUrl',
    'authorityDeltaDigest', 'candidateRef', 'catalogRevision', 'desiredState', 'extensionId', 'inventoryRevision',
    'kind', 'operationKind', 'policyRevision', 'profileId', 'scopeKey',
  ], path)
  const kind = readLiteral(record.kind, KINDS, `${path}.kind`)
  const urlText = readBoundedString(record.artifactUrl, `${path}.artifactUrl`, 2048)
  let url: URL
  try {
    url = new URL(urlText)
  } catch {
    fail(`${path}.artifactUrl`, 'must be an absolute URL')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') fail(`${path}.artifactUrl`, 'must be credential-free HTTPS')
  return immutableJsonClone({
    kind,
    extensionId: readBoundedString(record.extensionId, `${path}.extensionId`, 256),
    candidateRef: candidateRef(record.candidateRef, `${path}.candidateRef`, kind),
    artifactRevision: readBoundedString(record.artifactRevision, `${path}.artifactRevision`, 256),
    artifactIntegrity: readArtifactIntegrity(record.artifactIntegrity, `${path}.artifactIntegrity`),
    artifactUrl: url.toString(),
    artifactSizeBytes: positiveInteger(record.artifactSizeBytes, `${path}.artifactSizeBytes`),
    scopeKey: readBoundedString(record.scopeKey, `${path}.scopeKey`, 512),
    profileId: readBoundedString(record.profileId, `${path}.profileId`, 256),
    operationKind: readLiteral(record.operationKind, OPERATIONS, `${path}.operationKind`),
    desiredState: readLiteral(record.desiredState, DESIRED_STATES, `${path}.desiredState`),
    admittedCapabilities: uniqueStrings(record.admittedCapabilities, `${path}.admittedCapabilities`, 64, true),
    authorityDeltaDigest: readSha256Digest(record.authorityDeltaDigest, `${path}.authorityDeltaDigest`),
    policyRevision: readBoundedString(record.policyRevision, `${path}.policyRevision`, 256),
    catalogRevision: readNonNegativeInteger(record.catalogRevision, `${path}.catalogRevision`),
    inventoryRevision: readSha256Digest(record.inventoryRevision, `${path}.inventoryRevision`),
  }) as unknown as AcquisitionIntentCore
}

function acquisitionIntent(value: unknown, path: string): AcquisitionIntent {
  const record = readStrictRecord(
    value,
    ['continuationId', 'core', 'coreDigest', 'createdAtMs', 'expiresAtMs', 'idempotencyKey', 'intentId', 'origin', 'schemaVersion'],
    path,
  )
  schema(record, path)
  const origin = readLiteral(record.origin, ['store', 'task'] as const, `${path}.origin`)
  const continuationId = nullableString(record.continuationId, `${path}.continuationId`)
  if ((origin === 'store') !== (continuationId === null)) fail(`${path}.continuationId`, 'does not bind intent origin')
  const createdAtMs = readNonNegativeInteger(record.createdAtMs, `${path}.createdAtMs`)
  const expiresAtMs = readNonNegativeInteger(record.expiresAtMs, `${path}.expiresAtMs`)
  if (createdAtMs >= expiresAtMs) fail(path, 'has an invalid validity interval')
  const core = intentCore(record.core, `${path}.core`)
  const coreDigest = readSha256Digest(record.coreDigest, `${path}.coreDigest`)
  if (coreDigest !== canonicalSha256(core)) fail(`${path}.coreDigest`, 'does not match core')
  return immutableJsonClone({
    schemaVersion: 1,
    intentId: readBoundedString(record.intentId, `${path}.intentId`, 512),
    origin,
    idempotencyKey: readBoundedString(record.idempotencyKey, `${path}.idempotencyKey`, 512),
    continuationId,
    createdAtMs,
    expiresAtMs,
    core,
    coreDigest,
  }) as unknown as AcquisitionIntent
}

function lifecyclePayload(value: unknown, path: string, intent: AcquisitionIntent): LifecyclePayload {
  const record = readStrictRecord(value, [
    'configuration', 'continuationId', 'resolutionId', 'taskOriginalMessageId', 'taskSessionId', 'verificationPayloadDigest',
  ], path)
  const continuationId = nullableString(record.continuationId, `${path}.continuationId`)
  const resolutionId = nullableString(record.resolutionId, `${path}.resolutionId`)
  const verificationPayloadDigest = record.verificationPayloadDigest === null
    ? null
    : readSha256Digest(record.verificationPayloadDigest, `${path}.verificationPayloadDigest`)
  const taskSessionId = nullableString(record.taskSessionId, `${path}.taskSessionId`)
  const taskOriginalMessageId = nullableString(record.taskOriginalMessageId, `${path}.taskOriginalMessageId`)
  if (continuationId !== intent.continuationId) fail(`${path}.continuationId`, 'does not bind intent continuationId')
  const taskFields = [continuationId, resolutionId, verificationPayloadDigest, taskSessionId, taskOriginalMessageId]
  if (intent.origin === 'store' && taskFields.some(item => item !== null)) fail(path, 'carries task-only fields for a Store intent')
  if (intent.origin === 'task' && taskFields.some(item => item === null)) fail(path, 'has an incomplete task binding')
  return immutableJsonClone({
    configuration: rpcJson(record.configuration, `${path}.configuration`),
    continuationId,
    resolutionId,
    verificationPayloadDigest,
    taskSessionId,
    taskOriginalMessageId,
  }) as unknown as LifecyclePayload
}

/** Decode one immutable intent/payload/plan-hash binding. */
export function decodeStoredIntent(value: unknown, expectedIntentId?: string): StoredIntent {
  const path = expectedIntentId === undefined ? 'stored intent' : `stored intent ${expectedIntentId}`
  const record = readStrictRecord(value, ['intent', 'payload', 'planHash', 'schemaVersion'], path)
  schema(record, path)
  const intent = acquisitionIntent(record.intent, `${path}.intent`)
  if (expectedIntentId !== undefined && intent.intentId !== expectedIntentId) fail(`${path}.intent.intentId`, 'does not bind its storage identity')
  return immutableJsonClone({
    schemaVersion: 1,
    intent,
    payload: lifecyclePayload(record.payload, `${path}.payload`, intent),
    planHash: readSha256Digest(record.planHash, `${path}.planHash`),
  }) as unknown as StoredIntent
}

function resumeAgentOptions(value: unknown, path: string): RpcJson {
  const record = exactOptionalRecord(value, ['maxTokens', 'model', 'provider'], path)
  const provider = record.provider === undefined ? undefined : readBoundedString(record.provider, `${path}.provider`, 256)
  const model = record.model === undefined ? undefined : readBoundedString(record.model, `${path}.model`, 256)
  const maxTokens = record.maxTokens === undefined ? undefined : positiveInteger(record.maxTokens, `${path}.maxTokens`)
  if (provider !== undefined && Buffer.byteLength(provider, 'utf8') > MAX_CONTINUATION_ROUTE_BYTES) {
    fail(`${path}.provider`, `must contain at most ${String(MAX_CONTINUATION_ROUTE_BYTES)} UTF-8 bytes`)
  }
  if (model !== undefined && Buffer.byteLength(model, 'utf8') > MAX_CONTINUATION_ROUTE_BYTES) {
    fail(`${path}.model`, `must contain at most ${String(MAX_CONTINUATION_ROUTE_BYTES)} UTF-8 bytes`)
  }
  if (maxTokens !== undefined && maxTokens > MAX_CONTINUATION_RESUME_TOKENS) {
    fail(`${path}.maxTokens`, `must be at most ${String(MAX_CONTINUATION_RESUME_TOKENS)}`)
  }
  return Object.freeze({
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
  })
}

function resolutionValue(value: unknown, path: string): RpcJson {
  const record = readStrictRecord(value, [
    'candidates', 'catalogEntriesDigest', 'catalogRevision', 'continuationId', 'createdAtMs', 'decision',
    'expiresAtMs', 'intentId', 'inventoryRevision', 'originalMessageId', 'planId', 'profileId',
    'resumeAgentOptions', 'scopeKey', 'sessionId', 'taskAttemptId', 'verificationPayloadDigest',
  ], path)
  if (!Array.isArray(record.candidates) || record.candidates.length > 16) fail(`${path}.candidates`, 'must be a bounded array')
  const candidates = record.candidates.map((candidate, index) => {
    const itemPath = `${path}.candidates[${String(index)}]`
    const item = readStrictRecord(candidate, ['candidateRef', 'configuration', 'operationKind', 'targetKey'], itemPath)
    return Object.freeze({
      candidateRef: candidateRef(item.candidateRef, `${itemPath}.candidateRef`),
      configuration: rpcJson(item.configuration, `${itemPath}.configuration`),
      operationKind: readLiteral(item.operationKind, ['configure', 'enable', 'install', 'restore', 'update'] as const, `${itemPath}.operationKind`),
      targetKey: nullableString(item.targetKey, `${itemPath}.targetKey`, 1024),
    })
  })
  if (new Set(candidates.map(item => item.candidateRef)).size !== candidates.length) fail(`${path}.candidates`, 'must not repeat candidateRef')
  const continuationId = nullableString(record.continuationId, `${path}.continuationId`)
  const verificationPayloadDigest = record.verificationPayloadDigest === null
    ? null
    : readSha256Digest(record.verificationPayloadDigest, `${path}.verificationPayloadDigest`)
  if ((candidates.length === 0) !== (continuationId === null && verificationPayloadDigest === null)) {
    fail(path, 'has contradictory candidate continuation fields')
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    catalogEntriesDigest: readSha256Digest(record.catalogEntriesDigest, `${path}.catalogEntriesDigest`),
    catalogRevision: positiveInteger(record.catalogRevision, `${path}.catalogRevision`),
    continuationId,
    createdAtMs: readNonNegativeInteger(record.createdAtMs, `${path}.createdAtMs`),
    decision: readLiteral(record.decision, RESOLUTION_DECISIONS, `${path}.decision`),
    expiresAtMs: readNonNegativeInteger(record.expiresAtMs, `${path}.expiresAtMs`),
    intentId: readBoundedString(record.intentId, `${path}.intentId`, 512),
    inventoryRevision: readSha256Digest(record.inventoryRevision, `${path}.inventoryRevision`),
    originalMessageId: readBoundedString(record.originalMessageId, `${path}.originalMessageId`, 512),
    planId: readBoundedString(record.planId, `${path}.planId`, 512),
    profileId: readBoundedString(record.profileId, `${path}.profileId`, 256),
    resumeAgentOptions: resumeAgentOptions(record.resumeAgentOptions, `${path}.resumeAgentOptions`),
    scopeKey: readBoundedString(record.scopeKey, `${path}.scopeKey`, 512),
    sessionId: readBoundedString(record.sessionId, `${path}.sessionId`, 512),
    taskAttemptId: (() => {
      const value = readBoundedString(record.taskAttemptId, `${path}.taskAttemptId`, 64)
      if (!/^task-attempt:[0-9a-f-]{36}$/u.test(value)) fail(`${path}.taskAttemptId`, 'is invalid')
      return value
    })(),
    verificationPayloadDigest,
  })
}

/** Decode one Host-only task capability resolution. */
export function decodeStoredResolution(value: unknown, expectedResolutionId?: string): StoredResolution {
  const path = expectedResolutionId === undefined ? 'stored resolution' : `stored resolution ${expectedResolutionId}`
  const record = readStrictRecord(value, [
    'candidateRefs', 'createdAtMs', 'decision', 'expiresAtMs', 'needDigest', 'resolutionId', 'schemaVersion', 'value',
  ], path)
  schema(record, path)
  const resolutionId = readBoundedString(record.resolutionId, `${path}.resolutionId`, 512)
  if (!/^resolution:[0-9a-f-]{36}$/.test(resolutionId)) fail(`${path}.resolutionId`, 'is invalid')
  if (expectedResolutionId !== undefined && resolutionId !== expectedResolutionId) fail(`${path}.resolutionId`, 'does not bind its storage identity')
  const createdAtMs = readNonNegativeInteger(record.createdAtMs, `${path}.createdAtMs`)
  const expiresAtMs = readNonNegativeInteger(record.expiresAtMs, `${path}.expiresAtMs`)
  if (createdAtMs >= expiresAtMs) fail(path, 'has an invalid validity interval')
  const decision = readLiteral(record.decision, RESOLUTION_DECISIONS, `${path}.decision`)
  const candidateRefs = uniqueStrings(record.candidateRefs, `${path}.candidateRefs`, 16).map((item, index) => candidateRef(item, `${path}.candidateRefs[${String(index)}]`))
  const detail = resolutionValue(record.value, `${path}.value`) as Readonly<Record<string, RpcJson>>
  const detailCandidates = detail.candidates as readonly Readonly<Record<string, RpcJson>>[]
  if (detail.createdAtMs !== createdAtMs || detail.expiresAtMs !== expiresAtMs || detail.decision !== decision
    || JSON.stringify(detailCandidates.map(item => item.candidateRef)) !== JSON.stringify(candidateRefs)) {
    fail(`${path}.value`, 'does not bind the outer resolution fields')
  }
  return immutableJsonClone({
    schemaVersion: 1,
    resolutionId,
    createdAtMs,
    expiresAtMs,
    needDigest: readSha256Digest(record.needDigest, `${path}.needDigest`),
    decision,
    candidateRefs,
    value: detail,
  }) as unknown as StoredResolution
}

/** Decode one non-authoritative journal lookup row. */
export function decodeOperationIndex(value: unknown, expectedOperationId?: string): StoredOperationIndex {
  const path = expectedOperationId === undefined ? 'operation index' : `operation index ${expectedOperationId}`
  const record = readStrictRecord(value, [
    'extensionKind', 'lastAtMs', 'operationId', 'operationKind', 'phase', 'planHash', 'schemaVersion', 'targetKey',
  ], path)
  schema(record, path)
  const operationId = readBoundedString(record.operationId, `${path}.operationId`, 512)
  if (expectedOperationId !== undefined && operationId !== expectedOperationId) fail(`${path}.operationId`, 'does not bind its storage identity')
  const extensionKind = readLiteral(record.extensionKind, KINDS, `${path}.extensionKind`)
  const targetKey = readBoundedString(record.targetKey, `${path}.targetKey`, 1024)
  if (kindFromTarget(targetKey, `${path}.targetKey`) !== extensionKind) fail(`${path}.targetKey`, 'does not bind extensionKind')
  return Object.freeze({
    schemaVersion: 1,
    operationId,
    planHash: readSha256Digest(record.planHash, `${path}.planHash`),
    targetKey,
    extensionKind,
    operationKind: readLiteral(record.operationKind, OPERATIONS, `${path}.operationKind`),
    phase: readLiteral(record.phase, PHASES, `${path}.phase`),
    lastAtMs: readNonNegativeInteger(record.lastAtMs, `${path}.lastAtMs`),
  })
}

function nullableRevision(value: unknown, path: string): number | null {
  return value === null ? null : readNonNegativeInteger(value, path)
}

function skillRecoveryPoint(value: unknown, path: string, root: string, operationId: string, targetKey: string): RpcJson {
  const record = readStrictRecord(value, ['configuration', 'contentIntegrity', 'destination', 'kind', 'parsed', 'stagingPath'], path)
  const contentIntegrity = readArtifactIntegrity(record.contentIntegrity, `${path}.contentIntegrity`)
  const configuration = skillConfiguration(record.configuration, `${path}.configuration`, targetKey.split(':', 4)[2] ?? '')
  let parsed: RpcJson = null
  if (record.parsed !== null) {
    const detail = readStrictRecord(record.parsed, ['description', 'name'], `${path}.parsed`)
    parsed = Object.freeze({
      description: readBoundedString(detail.description, `${path}.parsed.description`, 4096),
      name: readBoundedString(detail.name, `${path}.parsed.name`, 128),
    })
  }
  const destination = record.destination === null ? null : absolutePath(record.destination, `${path}.destination`)
  const stagingPath = record.stagingPath === null ? null : absolutePath(record.stagingPath, `${path}.stagingPath`)
  if ((parsed === null) !== (destination === null && stagingPath === null)) fail(path, 'has incomplete Skill staging fields')
  if (destination !== null) {
    const expected = join(resolve(root), 'material', 'skills', storageKey(targetKey), storageKey(contentIntegrity))
    if (destination !== expected || stagingPath !== `${expected}.stage-${storageKey(operationId)}`) {
      fail(path, 'does not bind the operation target and content integrity paths')
    }
  }
  return Object.freeze({ configuration, contentIntegrity, destination, kind: 'skill', parsed, stagingPath })
}

function mcpRecoveryPoint(value: unknown, path: string): RpcJson {
  const record = readStrictRecord(value, [
    'configuration', 'kind', 'ownerActiveRevision', 'ownerRemovedRevision', 'ownerToolGeneration', 'ownerToolNames', 'runtime',
  ], path)
  const rawRuntime = record.runtime !== null && typeof record.runtime === 'object' && !Array.isArray(record.runtime)
    ? record.runtime as Readonly<Record<string, unknown>>
    : undefined
  const transport = readLiteral(rawRuntime?.transport, ['stdio', 'streamable-http'] as const, `${path}.runtime.transport`)
  const runtime = readStrictRecord(record.runtime, transport === 'stdio'
    ? ['candidateRef', 'executablePath', 'executableSha256', 'fixedArgs', 'runtimeRef', 'transport', 'version', 'workingDirectory']
    : ['authentication', 'candidateRef', 'dataEgressDisclosure', 'endpoint', 'origin', 'redirects', 'runtimeRef', 'transport', 'version'], `${path}.runtime`)
  const common = {
    candidateRef: candidateRef(runtime.candidateRef, `${path}.runtime.candidateRef`, 'mcp'),
    runtimeRef: readBoundedString(runtime.runtimeRef, `${path}.runtime.runtimeRef`, 128),
    version: readBoundedString(runtime.version, `${path}.runtime.version`, 128),
  }
  let admittedRuntime: RpcJson
  if (transport === 'stdio') {
    admittedRuntime = Object.freeze({
      ...common,
      executablePath: absolutePath(runtime.executablePath, `${path}.runtime.executablePath`),
      executableSha256: readSha256Digest(runtime.executableSha256, `${path}.runtime.executableSha256`),
      fixedArgs: boundedStrings(runtime.fixedArgs, `${path}.runtime.fixedArgs`, 64),
      transport: 'stdio',
      workingDirectory: absolutePath(runtime.workingDirectory, `${path}.runtime.workingDirectory`),
    })
  } else {
    if (runtime.authentication !== 'none' || runtime.redirects !== 'forbidden') {
      fail(`${path}.runtime`, 'must bind unauthenticated no-redirect HTTP policy')
    }
    admittedRuntime = Object.freeze({
      ...common,
      ...mcpHttpCoordinates(runtime.origin, runtime.endpoint, `${path}.runtime`),
      authentication: 'none',
      dataEgressDisclosure: readBoundedString(runtime.dataEgressDisclosure, `${path}.runtime.dataEgressDisclosure`, 2048),
      redirects: 'forbidden',
      transport: 'streamable-http',
    })
  }
  return Object.freeze({
    configuration: mcpConfiguration(record.configuration, `${path}.configuration`),
    kind: 'mcp',
    ownerActiveRevision: nullableRevision(record.ownerActiveRevision, `${path}.ownerActiveRevision`),
    ownerRemovedRevision: nullableRevision(record.ownerRemovedRevision, `${path}.ownerRemovedRevision`),
    ownerToolGeneration: nullableRevision(record.ownerToolGeneration, `${path}.ownerToolGeneration`),
    ownerToolNames: uniqueStrings(record.ownerToolNames, `${path}.ownerToolNames`, 4_096, true),
    runtime: admittedRuntime,
  })
}

function pluginRecoveryPoint(value: unknown, path: string, root: string, targetKey: string): RpcJson {
  const record = readStrictRecord(value, ['artifactPath', 'kind', 'metadataCache', 'snapshot'], path)
  const snapshot = readStrictRecord(record.snapshot, [
    'bootStatus', 'digest', 'materialRoot', 'ownerRevision', 'profileId', 'revision',
  ], `${path}.snapshot`)
  const targetParts = targetKey.split(':')
  const profileId = readBoundedString(snapshot.profileId, `${path}.snapshot.profileId`, 256)
  if (profileId !== targetParts[1]) fail(`${path}.snapshot.profileId`, 'does not bind targetKey')
  const revision = readNonNegativeInteger(snapshot.revision, `${path}.snapshot.revision`)
  const digest = readSha256Digest(snapshot.digest, `${path}.snapshot.digest`)
  const materialRoot = absolutePath(snapshot.materialRoot, `${path}.snapshot.materialRoot`)
  if (materialRoot !== join(resolve(root), 'material', 'plugins')) {
    fail(`${path}.snapshot.materialRoot`, 'does not bind Center-owned Plugin material')
  }
  const ownerRevision = readBoundedString(snapshot.ownerRevision, `${path}.snapshot.ownerRevision`, 512)
  if (ownerRevision !== `managed-plugin:${String(revision)}:${digest}`) {
    fail(`${path}.snapshot.ownerRevision`, 'does not bind the managed Plugin snapshot')
  }
  const artifactPath = record.artifactPath === null ? null : absolutePath(record.artifactPath, `${path}.artifactPath`)
  if (artifactPath !== null && (!below(join(resolve(root), 'artifacts'), artifactPath) || !artifactPath.endsWith('.tgz'))) {
    fail(`${path}.artifactPath`, 'must be a center-owned packed artifact')
  }
  const metadataCache = record.metadataCache === null
    ? null
    : decodeProfileMetadataCacheBinding(record.metadataCache, `${path}.metadataCache`)
  if (metadataCache !== null && metadataCache.profileId !== profileId) {
    fail(`${path}.metadataCache.profileId`, 'does not bind the Plugin snapshot')
  }
  return Object.freeze({
    artifactPath,
    kind: 'plugin',
    metadataCache: immutableJsonClone(metadataCache) as unknown as RpcJson,
    snapshot: Object.freeze({
      bootStatus: readLiteral(snapshot.bootStatus, ['live', 'pending-restart', 'verified'] as const, `${path}.snapshot.bootStatus`),
      digest,
      materialRoot,
      ownerRevision,
      profileId,
      revision,
    }),
  })
}

function recoveryPoint(
  value: unknown,
  path: string,
  root: string,
  operationId: string,
  targetKey: string,
  kind: ManagedExtensionKind,
): RpcJson {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an owner recovery object')
  const heldKind = (value as Readonly<Record<string, unknown>>).kind
  if (heldKind !== kind) fail(`${path}.kind`, 'does not bind targetKey')
  if (kind === 'skill') return skillRecoveryPoint(value, path, root, operationId, targetKey)
  if (kind === 'mcp') return mcpRecoveryPoint(value, path)
  return pluginRecoveryPoint(value, path, root, targetKey)
}

/** Decode one pre-mutation owner snapshot and recompute its before-state digest. */
export function decodeProviderSnapshot(
  value: unknown,
  root: string,
  expectedOperationId?: string,
): StoredProviderSnapshot {
  const path = expectedOperationId === undefined ? 'provider snapshot' : `provider snapshot ${expectedOperationId}`
  const record = readStrictRecord(value, ['before', 'beforeDigest', 'operationId', 'recoveryPoint', 'schemaVersion', 'targetKey'], path)
  schema(record, path)
  const operationId = readBoundedString(record.operationId, `${path}.operationId`, 512)
  if (expectedOperationId !== undefined && operationId !== expectedOperationId) fail(`${path}.operationId`, 'does not bind its storage identity')
  const targetKey = readBoundedString(record.targetKey, `${path}.targetKey`, 1024)
  const kind = kindFromTarget(targetKey, `${path}.targetKey`)
  const before = record.before === null ? null : decodeManagedTarget(record.before, root, targetKey)
  const beforeDigest = readSha256Digest(record.beforeDigest, `${path}.beforeDigest`)
  if (beforeDigest !== durableManagedStateDigest(before)) fail(`${path}.beforeDigest`, 'does not match before')
  return immutableJsonClone({
    schemaVersion: 1,
    operationId,
    targetKey,
    before,
    beforeDigest,
    recoveryPoint: recoveryPoint(record.recoveryPoint, `${path}.recoveryPoint`, root, operationId, targetKey, kind),
  }) as unknown as StoredProviderSnapshot
}

/** Decode one exact lifecycle result consumed by a continuation verifier. */
export function decodeTaskReceipt(value: unknown, expectedContinuationId?: string): StoredTaskReceipt {
  const path = expectedContinuationId === undefined ? 'task receipt' : `task receipt ${expectedContinuationId}`
  const record = readStrictRecord(value, [
    'completedAtMs', 'continuationId', 'operationId', 'operationReceiptDigest', 'planHash', 'resolutionId',
    'schemaVersion', 'verificationPayloadDigest',
  ], path)
  schema(record, path)
  const continuationId = readBoundedString(record.continuationId, `${path}.continuationId`, 512)
  if (expectedContinuationId !== undefined && continuationId !== expectedContinuationId) fail(`${path}.continuationId`, 'does not bind its storage identity')
  return Object.freeze({
    schemaVersion: 1,
    continuationId,
    resolutionId: readBoundedString(record.resolutionId, `${path}.resolutionId`, 512),
    verificationPayloadDigest: readSha256Digest(record.verificationPayloadDigest, `${path}.verificationPayloadDigest`),
    planHash: readSha256Digest(record.planHash, `${path}.planHash`),
    operationId: readBoundedString(record.operationId, `${path}.operationId`, 512),
    operationReceiptDigest: readSha256Digest(record.operationReceiptDigest, `${path}.operationReceiptDigest`),
    completedAtMs: readNonNegativeInteger(record.completedAtMs, `${path}.completedAtMs`),
  })
}

/** Decode one reservation-to-continuation claim binding. */
export function decodeContinuationActivation(value: unknown, expectedReservationId?: string): StoredContinuationActivation {
  const path = expectedReservationId === undefined ? 'continuation activation' : `continuation activation ${expectedReservationId}`
  const record = readStrictRecord(value, [
    'continuationId', 'createdAtMs', 'needDigest', 'originalMessageId', 'planHash', 'reservationId', 'resolutionId',
    'schemaVersion', 'sessionId', 'taskRevision', 'verificationPayloadDigest',
  ], path)
  schema(record, path)
  const reservationId = readBoundedString(record.reservationId, `${path}.reservationId`, 512)
  if (expectedReservationId !== undefined && reservationId !== expectedReservationId) fail(`${path}.reservationId`, 'does not bind its storage identity')
  return Object.freeze({
    schemaVersion: 1,
    reservationId,
    continuationId: readBoundedString(record.continuationId, `${path}.continuationId`, 512),
    resolutionId: readBoundedString(record.resolutionId, `${path}.resolutionId`, 512),
    planHash: readSha256Digest(record.planHash, `${path}.planHash`),
    sessionId: readBoundedString(record.sessionId, `${path}.sessionId`, 512),
    originalMessageId: readBoundedString(record.originalMessageId, `${path}.originalMessageId`, 512),
    needDigest: readSha256Digest(record.needDigest, `${path}.needDigest`),
    taskRevision: readBoundedString(record.taskRevision, `${path}.taskRevision`, 512),
    verificationPayloadDigest: readSha256Digest(record.verificationPayloadDigest, `${path}.verificationPayloadDigest`),
    createdAtMs: readNonNegativeInteger(record.createdAtMs, `${path}.createdAtMs`),
  })
}

/** Decode one write-ahead continuation claim creation intent. */
export function decodeContinuationActivationIntent(
  value: unknown,
  expectedReservationId?: string,
): StoredContinuationActivationIntent {
  const path = expectedReservationId === undefined
    ? 'continuation activation intent'
    : `continuation activation intent ${expectedReservationId}`
  const record = readStrictRecord(value, [
    'callerId', 'createdAtMs', 'expiresAtMs', 'mutationId', 'needDigest', 'originalMessageId', 'planHash',
    'reservationId', 'resolutionId', 'resumeAgentOptions', 'schemaVersion', 'sessionId', 'taskRevision',
    'verificationPayloadDigest',
  ], path)
  schema(record, path)
  const reservationId = readBoundedString(record.reservationId, `${path}.reservationId`, 512)
  if (expectedReservationId !== undefined && reservationId !== expectedReservationId) fail(`${path}.reservationId`, 'does not bind its storage identity')
  const mutationId = readBoundedString(record.mutationId, `${path}.mutationId`, 512)
  if (mutationId !== reservationId) fail(`${path}.mutationId`, 'does not bind reservationId')
  if (record.callerId !== 'extension-center') fail(`${path}.callerId`, 'must be extension-center')
  const createdAtMs = readNonNegativeInteger(record.createdAtMs, `${path}.createdAtMs`)
  const expiresAtMs = readNonNegativeInteger(record.expiresAtMs, `${path}.expiresAtMs`)
  if (createdAtMs >= expiresAtMs) fail(path, 'has an invalid validity interval')
  return immutableJsonClone({
    schemaVersion: 1,
    reservationId,
    callerId: 'extension-center',
    mutationId,
    resolutionId: readBoundedString(record.resolutionId, `${path}.resolutionId`, 512),
    planHash: readSha256Digest(record.planHash, `${path}.planHash`),
    sessionId: readBoundedString(record.sessionId, `${path}.sessionId`, 512),
    originalMessageId: readBoundedString(record.originalMessageId, `${path}.originalMessageId`, 512),
    needDigest: readSha256Digest(record.needDigest, `${path}.needDigest`),
    taskRevision: readBoundedString(record.taskRevision, `${path}.taskRevision`, 512),
    verificationPayloadDigest: readSha256Digest(record.verificationPayloadDigest, `${path}.verificationPayloadDigest`),
    resumeAgentOptions: resumeAgentOptions(record.resumeAgentOptions, `${path}.resumeAgentOptions`),
    expiresAtMs,
    createdAtMs,
  }) as unknown as StoredContinuationActivationIntent
}

/** Assert that a decoded record identity hashes to its durable filename. */
export function assertStateFileIdentity(fileName: string, identity: string, path: string): void {
  if (fileName !== `${storageKey(identity)}.json`) fail(path, 'filename does not bind the record identity')
}

// Keep the closed union imports checked against the durable literal tables.
const _operationKindCheck: readonly OperationKind[] = OPERATIONS
const _desiredStateCheck: readonly DesiredState[] = DESIRED_STATES
const _phaseCheck: readonly OperationPhase[] = PHASES
void _operationKindCheck
void _desiredStateCheck
void _phaseCheck
