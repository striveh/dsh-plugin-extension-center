import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { EXTENSION_CENTER_RPC_CHANNEL } from '../catalog-contract.ts'
import type { InventoryRow } from '../inventory/types.ts'
import type { OperationReceipt } from '../operations/types.ts'
import type { ImmutablePlan, OperationKind, PlanAuthorizationState } from '../plans/types.ts'
import type {
  HostCapabilityProjection,
  IntentPreviewRequest,
  IntentPreviewResponse,
  InventoryListResponse,
  LifecycleResponse,
  OperationListResponse,
  OperationReceiptsResponse,
  ConfigurationOptionsResponse,
  RpcJson,
  TaskApprovalListResponse,
  TaskAttemptCancelResponse,
  TaskAttemptListResponse,
  TaskAttemptResolutionResponse,
  TaskConfigurationResponse,
} from '../service/rpc-contract.ts'
import { ExtensionCenterRpcError } from './catalog-api.ts'

const PROTOCOL_VERSION = 1 as const
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_STRING = 4_096
const MAX_ROWS = 1_000
const MAX_OPERATIONS = 2_000
const MAX_TIMESTAMP = 8_640_000_000_000_000
const SHA256 = /^sha256:[0-9a-f]{64}$/
const ARTIFACT_INTEGRITY = /^(?:sha256:[0-9a-f]{64}|sha512:(?:[0-9a-f]{128}|[A-Za-z0-9+/]{86}==))$/
const OPERATIONS = new Set<OperationKind>([
  'install', 'configure', 'update', 'enable', 'disable', 'uninstall', 'restore', 'purge',
])
const MANAGED_OBJECTS = new Set(['artifact', 'connection'] as const)
const EXTERNAL_RUNTIME_ACTIONS = new Set(['download', 'none'] as const)
const TASK_ATTEMPT = /^task-attempt:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RESOLUTION = /^resolution:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CANDIDATE = /^(?:plugin|mcp|skill):[A-Za-z0-9@._:/-]{1,240}$/
const EXTENSION_REF = /^extension-ref:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Current Browser observation context supplied by the Host composition. */
export interface ExtensionManagementContext {
  readonly profileId: string
  readonly defaultScopeKey: string
}

/** Exact Browser preview input; existing targets remain opaque inventory values. */
export type StorePreviewInput = Omit<IntentPreviewRequest, 'protocolVersion' | 'origin' | 'continuationId'>

/** Browser client for loopback-only Extension Center management RPC. */
export interface ExtensionManagementClient {
  /** Read one normalized inventory observation. */
  inventory(scopeKey: string, profileId: string, signal?: AbortSignal): Promise<InventoryListResponse>
  /** Explicitly refresh authoritative evidence for one exact target without minting a plan or receipt. */
  verify(scopeKey: string, profileId: string, targetKey: string, signal?: AbortSignal): Promise<InventoryListResponse>
  /** Mint a non-authorizing Store plan preview. */
  preview(input: StorePreviewInput, signal?: AbortSignal): Promise<IntentPreviewResponse>
  /** Read safe typed configuration selectors for one exact candidate or managed target. */
  configurationOptions(input: Readonly<{
    candidateRef: string
    operationKind: OperationKind
    targetKey: string | null
    scopeKey: string
    profileId: string
  }>, signal?: AbortSignal): Promise<ConfigurationOptionsResponse>
  /** List task-origin plans awaiting review or exact approved-plan resumption. */
  taskApprovals(signal?: AbortSignal): Promise<TaskApprovalListResponse>
  /** Submit typed human configuration for one opaque task candidate; this creates but does not approve its plan. */
  configureTask(input: Readonly<{
    resolutionId: string
    candidateRef: string
    continuationId: string
    configuration: RpcJson
  }>, signal?: AbortSignal): Promise<TaskConfigurationResponse>
  /** List durable task attempts separately from extension operation history. */
  taskAttempts(signal?: AbortSignal): Promise<TaskAttemptListResponse>
  /** Turn one terminal human choice into a new, non-authorizing task attempt. */
  selectTaskCandidate(taskAttemptId: string, candidateRef: string, signal?: AbortSignal): Promise<TaskAttemptResolutionResponse>
  /** Retry the original message through existing-first resolution after management. */
  retryOriginalTask(taskAttemptId: string, signal?: AbortSignal): Promise<TaskAttemptResolutionResponse>
  /** Cancel one mutable task attempt without changing any extension operation. */
  cancelTaskAttempt(taskAttemptId: string, signal?: AbortSignal): Promise<TaskAttemptCancelResponse>
  /** Reconcile one exact immutable plan after an uncertain decision or lifecycle response. */
  plan(planHash: string, signal?: AbortSignal): Promise<PlanAuthorizationState | null>
  /** Record one explicit human decision for the exact plan. */
  decide(plan: ImmutablePlan, decision: 'approve' | 'reject', signal?: AbortSignal): Promise<PlanAuthorizationState>
  /** Consume one approved plan and start its lifecycle operation. */
  execute(planHash: string, signal?: AbortSignal): Promise<LifecycleResponse>
  /** Retry the fenced rollback for one exact recovery-required operation. */
  recover(operationId: string, signal?: AbortSignal): Promise<LifecycleResponse>
  /** List verified operation projections. */
  operations(signal?: AbortSignal): Promise<OperationListResponse>
  /** List verified terminal receipts. */
  receipts(signal?: AbortSignal): Promise<OperationReceiptsResponse>
}

function fail(subject: string): never {
  throw new Error(`extension-center: invalid ${subject}`)
}

function exactRecord(value: unknown, subject: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(subject)
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`extension-center: unexpected fields in ${subject}`)
  }
  return record
}

function string(value: unknown, subject: string, maximum = MAX_STRING): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) fail(subject)
  return value
}

function nullableString(value: unknown, subject: string): string | null {
  return value === null ? null : string(value, subject)
}

function bool(value: unknown, subject: string): boolean {
  if (typeof value !== 'boolean') fail(subject)
  return value
}

function integer(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(subject)
  return value as number
}

function timestamp(value: unknown, subject: string): number {
  const result = integer(value, subject)
  if (result > MAX_TIMESTAMP) fail(subject)
  return result
}

function literal<const T extends string>(value: unknown, values: ReadonlySet<T>, subject: string): T {
  const result = string(value, subject, 128)
  if (!values.has(result as T)) fail(subject)
  return result as T
}

function array(value: unknown, subject: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(subject)
  return value
}

function rpcJson(value: unknown, subject: string, depth = 0, count = { value: 0 }): RpcJson {
  count.value += 1
  if (count.value > 4_096 || depth > 16) fail(subject)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(subject)
    return value
  }
  if (typeof value === 'string') {
    if (value.length > 16_384 || value.includes('\0')) fail(subject)
    return value
  }
  if (Array.isArray(value)) return value.map(item => rpcJson(item, subject, depth + 1, count))
  if (typeof value !== 'object') fail(subject)
  const output: Record<string, RpcJson> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key.length === 0 || key.length > 128 || key.includes('\0')) fail(subject)
    output[key] = rpcJson((value as Record<string, unknown>)[key], subject, depth + 1, count)
  }
  return output
}

function digest(value: unknown, subject: string): string {
  const result = string(value, subject, 80)
  if (!SHA256.test(result)) fail(subject)
  return result
}

function absolutePath(value: unknown, subject: string): string {
  const path = string(value, subject, 4_096)
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(path) && !path.startsWith('\\\\')) fail(subject)
  return path
}

function integrity(value: unknown, subject: string): string {
  const result = string(value, subject, 180)
  if (!ARTIFACT_INTEGRITY.test(result)) fail(subject)
  return result
}

function runtimeBinding(value: unknown, subject: string): ImmutablePlan['content']['runtimeBinding'] {
  if (value === null) return null
  const input = exactRecord(value, subject, ['runtimeRef', 'version', 'descriptorDigest'])
  return {
    runtimeRef: string(input.runtimeRef, `${subject}.runtimeRef`, 256),
    version: string(input.version, `${subject}.version`, 128),
    descriptorDigest: digest(input.descriptorDigest, `${subject}.descriptorDigest`) as `sha256:${string}`,
  }
}

function managedObjectBinding(
  value: Readonly<Record<string, unknown>>,
  subject: string,
): Readonly<{
  managedObject: ImmutablePlan['content']['managedObject']
  externalRuntimeAction: ImmutablePlan['content']['externalRuntimeAction']
  runtimeBinding: ImmutablePlan['content']['runtimeBinding']
}> {
  const managedObject = literal(value.managedObject, MANAGED_OBJECTS, `${subject}.managedObject`)
  const externalRuntimeAction = literal(
    value.externalRuntimeAction,
    EXTERNAL_RUNTIME_ACTIONS,
    `${subject}.externalRuntimeAction`,
  )
  const binding = runtimeBinding(value.runtimeBinding, `${subject}.runtimeBinding`)
  const connection = managedObject === 'connection'
  if (connection) {
    if (externalRuntimeAction !== 'none' || binding === null) fail(subject)
  } else {
    const operationKind = literal(value.operationKind, OPERATIONS, `${subject}.operationKind`)
    const artifactDownload = operationKind === 'install' || operationKind === 'update'
    if (binding !== null || externalRuntimeAction !== (artifactDownload ? 'download' : 'none')) fail(subject)
  }
  return { managedObject, externalRuntimeAction, runtimeBinding: binding }
}

function reviewStringArray(value: unknown, subject: string, maximum = 512): void {
  const values = array(value, subject, maximum)
  values.forEach((item, index) => { string(item, `${subject}[${String(index)}]`, 4_096) })
  if (new Set(values).size !== values.length) fail(`${subject} duplicates`)
}

function reviewEvidence(value: unknown, subject: string): Readonly<{
  kind: string
  operationKind: OperationKind
  restartRequired: boolean | null
}> {
  const raw = value as Readonly<Record<string, unknown>>
  const kind = literal(raw?.kind, new Set(['plugin', 'mcp', 'skill'] as const), `${subject}.kind`)
  const base = [
    'schemaVersion', 'kind', 'operationKind', 'checks', 'removed', 'retained', 'credentialChoice',
    'rollbackPoint', 'rollbackLimits', 'notProven',
  ]
  const input = exactRecord(value, subject, kind === 'plugin'
    ? [...base, 'manifest', 'dependencies', 'managedMaterial', 'packageMetadata', 'activation', 'scripts', 'settings']
    : kind === 'skill' ? [...base, 'files', 'body', 'invocation']
      : [...base, 'descriptor', 'runtime', 'credentials', 'dataEgress'])
  if (input.schemaVersion !== 1) fail(`${subject}.schemaVersion`)
  const operationKind = literal(input.operationKind, OPERATIONS, `${subject}.operationKind`)
  let restartRequired: boolean | null = null
  literal(input.credentialChoice, new Set(['not-applicable', 'retain-local-record', 'delete-local-record']), `${subject}.credentialChoice`)
  const checkCodes = new Set([
    'catalog-admission', 'owner-revision', 'review-record', 'artifact-integrity', 'plugin-manifest',
    'plugin-dependencies', 'plugin-lifecycle-scripts', 'plugin-package-metadata', 'plugin-settings-schema',
    'center-plugin-material', 'official-profile-package', 'loader-consumer', 'host-restart-observation',
    'skill-file-manifest', 'skill-frontmatter',
    'skill-body', 'skill-links', 'skill-executables', 'invocation-policy', 'merged-skill-winner',
    'mcp-runtime-integrity', 'mcp-descriptor', 'mcp-secret-absence', 'mcp-initialize', 'mcp-tools-list',
    'mcp-tool-generation', 'owner-mutation', 'owner-absence', 'quiescent-disposal',
  ])
  const checkRows = array(input.checks, `${subject}.checks`, 64)
  checkRows.forEach((item, index) => {
    const row = exactRecord(item, `${subject}.checks[${String(index)}]`, ['code', 'phase'])
    literal(row.code, checkCodes, `${subject}.checks[${String(index)}].code`)
    literal(row.phase, new Set(['planning', 'prepare', 'apply', 'verify', 'external-restart']), `${subject}.checks[${String(index)}].phase`)
  })
  if (checkRows.length === 0) fail(`${subject}.checks`)
  for (const field of ['removed', 'retained'] as const) {
    array(input[field], `${subject}.${field}`, 128).forEach((item, index) => {
      const row = exactRecord(item, `${subject}.${field}[${String(index)}]`, ['kind', 'id', 'digest'])
      literal(row.kind, new Set([
        'center-plugin-material', 'profile-dependency', 'loader-entry', 'plugin-settings', 'skill-file',
        'connection-row', 'credential-record', 'external-runtime', 'remote-data', 'recovery-point',
      ]), `${subject}.${field}[${String(index)}].kind`)
      string(row.id, `${subject}.${field}[${String(index)}].id`)
      if (row.digest !== null) digest(row.digest, `${subject}.${field}[${String(index)}].digest`)
    })
  }
  if (input.rollbackPoint !== null) {
    const point = exactRecord(input.rollbackPoint, `${subject}.rollbackPoint`, ['kind', 'id', 'digest'])
    literal(point.kind, new Set(['absent-state', 'managed-version']), `${subject}.rollbackPoint.kind`)
    string(point.id, `${subject}.rollbackPoint.id`)
    digest(point.digest, `${subject}.rollbackPoint.digest`)
  }
  reviewStringArray(input.rollbackLimits, `${subject}.rollbackLimits`)
  reviewStringArray(input.notProven, `${subject}.notProven`)
  if (kind === 'plugin') {
    const manifest = exactRecord(input.manifest, `${subject}.manifest`, [
      'packageName', 'beforeVersion', 'afterVersion', 'body', 'manifestDigest', 'files', 'fileManifestDigest',
    ])
    string(manifest.packageName, `${subject}.manifest.packageName`)
    nullableString(manifest.beforeVersion, `${subject}.manifest.beforeVersion`)
    nullableString(manifest.afterVersion, `${subject}.manifest.afterVersion`)
    string(manifest.body, `${subject}.manifest.body`, 1024 * 1024)
    digest(manifest.manifestDigest, `${subject}.manifest.manifestDigest`)
    digest(manifest.fileManifestDigest, `${subject}.manifest.fileManifestDigest`)
    reviewStringArray(manifest.files, `${subject}.manifest.files`, 4_096)
    array(input.dependencies, `${subject}.dependencies`, 256).forEach((item, index) => {
      const row = exactRecord(item, `${subject}.dependencies[${String(index)}]`, [
        'kind', 'id', 'beforeVersion', 'afterVersion', 'required',
      ])
      literal(row.kind, new Set(['host', 'runtime', 'extension', 'peer']), `${subject}.dependencies[${String(index)}].kind`)
      string(row.id, `${subject}.dependencies[${String(index)}].id`)
      nullableString(row.beforeVersion, `${subject}.dependencies[${String(index)}].beforeVersion`)
      nullableString(row.afterVersion, `${subject}.dependencies[${String(index)}].afterVersion`)
      bool(row.required, `${subject}.dependencies[${String(index)}].required`)
    })
    const managedMaterial = exactRecord(input.managedMaterial, `${subject}.managedMaterial`, [
      'owner', 'packageName', 'beforeVersion', 'afterVersion', 'targetIntegrity',
    ])
    literal(managedMaterial.owner, new Set(['extension-center']), `${subject}.managedMaterial.owner`)
    string(managedMaterial.packageName, `${subject}.managedMaterial.packageName`)
    nullableString(managedMaterial.beforeVersion, `${subject}.managedMaterial.beforeVersion`)
    nullableString(managedMaterial.afterVersion, `${subject}.managedMaterial.afterVersion`)
    if (managedMaterial.targetIntegrity !== null) integrity(managedMaterial.targetIntegrity, `${subject}.managedMaterial.targetIntegrity`)
    const packageMetadata = exactRecord(input.packageMetadata, `${subject}.packageMetadata`, ['bundlePatch'])
    if (packageMetadata.bundlePatch !== null) {
      const patch = exactRecord(packageMetadata.bundlePatch, `${subject}.packageMetadata.bundlePatch`, ['path', 'patchDigest', 'patchBody'])
      if (patch.path !== 'cordis.patch.yml') fail(`${subject}.packageMetadata.bundlePatch.path`)
      digest(patch.patchDigest, `${subject}.packageMetadata.bundlePatch.patchDigest`)
      string(patch.patchBody, `${subject}.packageMetadata.bundlePatch.patchBody`, 1024 * 1024)
    }
    const activation = exactRecord(input.activation, `${subject}.activation`, [
      'mutationOwner', 'profileDependency', 'loaderEntry', 'restartRequired', 'packageName',
    ])
    literal(activation.mutationOwner, new Set(['official-dsh-cli', 'official-loader']), `${subject}.activation.mutationOwner`)
    literal(activation.profileDependency, new Set(['add', 'replace', 'remove', 'restore', 'retain']), `${subject}.activation.profileDependency`)
    literal(activation.loaderEntry, new Set(['create', 'replace', 'remove', 'restore', 'retain']), `${subject}.activation.loaderEntry`)
    const activationRestartRequired = bool(activation.restartRequired, `${subject}.activation.restartRequired`)
    string(activation.packageName, `${subject}.activation.packageName`)
    const expectedActivation = ({
      install: { mutationOwner: 'official-dsh-cli', profileDependency: 'add', loaderEntry: 'create', restartRequired: true },
      configure: { mutationOwner: 'official-loader', profileDependency: 'retain', loaderEntry: 'replace', restartRequired: false },
      update: { mutationOwner: 'official-dsh-cli', profileDependency: 'replace', loaderEntry: 'replace', restartRequired: true },
      uninstall: { mutationOwner: 'official-dsh-cli', profileDependency: 'remove', loaderEntry: 'remove', restartRequired: true },
      restore: { mutationOwner: 'official-dsh-cli', profileDependency: 'restore', loaderEntry: 'restore', restartRequired: true },
    } as const)[operationKind as 'install' | 'configure' | 'update' | 'uninstall' | 'restore']
    if (expectedActivation === undefined
      || activation.mutationOwner !== expectedActivation.mutationOwner
      || activation.profileDependency !== expectedActivation.profileDependency
      || activation.loaderEntry !== expectedActivation.loaderEntry
      || activationRestartRequired !== expectedActivation.restartRequired) {
      fail(`${subject}.activation operation binding`)
    }
    restartRequired = activationRestartRequired
    const scripts = exactRecord(input.scripts, `${subject}.scripts`, ['before', 'after', 'forbiddenLifecycle'])
    reviewStringArray(scripts.before, `${subject}.scripts.before`)
    reviewStringArray(scripts.after, `${subject}.scripts.after`)
    reviewStringArray(scripts.forbiddenLifecycle, `${subject}.scripts.forbiddenLifecycle`)
    const settings = exactRecord(input.settings, `${subject}.settings`, [
      'adapterVersion', 'adapterDigest', 'schemaDigest', 'ownerRevision', 'migration', 'schema',
      'migrationChanges', 'diffDigest',
    ])
    nullableString(settings.adapterVersion, `${subject}.settings.adapterVersion`)
    if (settings.adapterDigest !== null) digest(settings.adapterDigest, `${subject}.settings.adapterDigest`)
    if (settings.schemaDigest !== null) digest(settings.schemaDigest, `${subject}.settings.schemaDigest`)
    string(settings.ownerRevision, `${subject}.settings.ownerRevision`)
    literal(settings.migration, new Set(['not-required', 'validated', 'pending']), `${subject}.settings.migration`)
    array(settings.schema, `${subject}.settings.schema`, 128).forEach((item, index) => {
      const row = exactRecord(item, `${subject}.settings.schema[${String(index)}]`, ['field', 'type', 'minimum', 'maximum'])
      string(row.field, `${subject}.settings.schema[${String(index)}].field`)
      if (row.type !== 'integer') fail(`${subject}.settings.schema[${String(index)}].type`)
      const minimum = integer(row.minimum, `${subject}.settings.schema[${String(index)}].minimum`)
      if (minimum > integer(row.maximum, `${subject}.settings.schema[${String(index)}].maximum`)) fail(`${subject}.settings.schema`)
    })
    reviewStringArray(settings.migrationChanges, `${subject}.settings.migrationChanges`)
    digest(settings.diffDigest, `${subject}.settings.diffDigest`)
  } else if (kind === 'skill') {
    array(input.files, `${subject}.files`, 4_096).forEach((item, index) => {
      const row = exactRecord(item, `${subject}.files[${String(index)}]`, [
        'path', 'change', 'beforeDigest', 'afterDigest', 'sizeBytes', 'executableBefore', 'executableAfter',
        'linkBefore', 'linkAfter',
      ])
      string(row.path, `${subject}.files[${String(index)}].path`)
      literal(row.change, new Set(['add', 'retain', 'replace', 'remove', 'restore', 'purge']), `${subject}.files[${String(index)}].change`)
      if (row.beforeDigest !== null) digest(row.beforeDigest, `${subject}.files[${String(index)}].beforeDigest`)
      if (row.afterDigest !== null) digest(row.afterDigest, `${subject}.files[${String(index)}].afterDigest`)
      integer(row.sizeBytes, `${subject}.files[${String(index)}].sizeBytes`)
      bool(row.executableBefore, `${subject}.files[${String(index)}].executableBefore`)
      bool(row.executableAfter, `${subject}.files[${String(index)}].executableAfter`)
      nullableString(row.linkBefore, `${subject}.files[${String(index)}].linkBefore`)
      nullableString(row.linkAfter, `${subject}.files[${String(index)}].linkAfter`)
    })
    const body = exactRecord(input.body, `${subject}.body`, ['before', 'after', 'beforeDigest', 'afterDigest'])
    for (const field of ['before', 'after'] as const) {
      if (body[field] !== null && (typeof body[field] !== 'string' || (body[field] as string).length > 1024 * 1024)) fail(`${subject}.body.${field}`)
    }
    for (const field of ['beforeDigest', 'afterDigest'] as const) {
      if (body[field] !== null) digest(body[field], `${subject}.body.${field}`)
    }
    const invocation = exactRecord(input.invocation, `${subject}.invocation`, [
      'beforeModelInvocable', 'beforeUserInvocable', 'afterModelInvocable', 'afterUserInvocable',
    ])
    for (const field of Object.keys(invocation)) if (invocation[field] !== null) bool(invocation[field], `${subject}.invocation.${field}`)
  } else {
    const descriptor = input.descriptor as Readonly<Record<string, unknown>>
    const transport = literal(descriptor?.transport, new Set(['stdio', 'http'] as const), `${subject}.descriptor.transport`)
    const row = exactRecord(input.descriptor, `${subject}.descriptor`, transport === 'stdio'
      ? ['transport', 'serverName', 'executable', 'arguments', 'workingDirectory', 'toolCallTimeoutMs', 'reconnect']
      : ['transport', 'serverName', 'origin', 'endpoint', 'authentication', 'redirects', 'dataEgressDisclosure', 'toolCallTimeoutMs', 'reconnect'])
    string(row.serverName, `${subject}.descriptor.serverName`)
    if (transport === 'stdio') {
      string(row.executable, `${subject}.descriptor.executable`)
      reviewStringArray(row.arguments, `${subject}.descriptor.arguments`, 128)
      if (typeof row.workingDirectory !== 'string') fail(`${subject}.descriptor.workingDirectory`)
    } else {
      const origin = string(row.origin, `${subject}.descriptor.origin`, 2_048)
      const endpoint = string(row.endpoint, `${subject}.descriptor.endpoint`, 2_048)
      if (row.authentication !== 'none' || row.redirects !== 'forbidden') fail(`${subject}.descriptor.HTTP policy`)
      string(row.dataEgressDisclosure, `${subject}.descriptor.dataEgressDisclosure`, 2_048)
      const url = new URL(endpoint)
      if (url.origin !== origin || url.username !== '' || url.password !== '' || url.hash !== '') fail(`${subject}.descriptor.HTTP coordinates`)
    }
    integer(row.toolCallTimeoutMs, `${subject}.descriptor.toolCallTimeoutMs`)
    const reconnect = exactRecord(row.reconnect, `${subject}.descriptor.reconnect`, ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'])
    bool(reconnect.enabled, `${subject}.descriptor.reconnect.enabled`)
    for (const field of ['initialDelayMs', 'maxDelayMs', 'maxAttempts'] as const) integer(reconnect[field], `${subject}.descriptor.reconnect.${field}`)
    const runtime = exactRecord(input.runtime, `${subject}.runtime`, ['ownership', 'version', 'digest', 'action'])
    literal(runtime.ownership, new Set(['host', 'remote']), `${subject}.runtime.ownership`)
    string(runtime.version, `${subject}.runtime.version`)
    if (runtime.digest !== null) digest(runtime.digest, `${subject}.runtime.digest`)
    if (runtime.action !== 'none' || input.credentials !== 'none') fail(`${subject}.runtime authority`)
    literal(input.dataEgress, new Set(['local-process', 'remote-origin']), `${subject}.dataEgress`)
  }
  return { kind, operationKind, restartRequired }
}

function sameRuntimeBinding(
  left: ImmutablePlan['content']['runtimeBinding'],
  right: ImmutablePlan['content']['runtimeBinding'],
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.runtimeRef === right.runtimeRef
      && left.version === right.version
      && left.descriptorDigest === right.descriptorDigest
}

function responseSize(value: unknown, subject: string): void {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    fail(subject)
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) fail(subject)
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value !== 'object') fail('canonical JSON value')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => {
    if (record[key] === undefined) fail('canonical JSON field')
    return `${JSON.stringify(key)}:${canonical(record[key])}`
  }).join(',')}}`
}

async function canonicalDigest(value: unknown): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error('extension-center: Web Crypto is unavailable; plan integrity cannot be verified')
  }
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))
  return `sha256:${[...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Compute the canonical digest shown for one staged configuration payload. */
export function configurationDigest(value: RpcJson): Promise<string> {
  return canonicalDigest(value)
}

function capabilities(value: unknown, subject: string): HostCapabilityProjection {
  const input = exactRecord(value, subject, [
    'managedPluginLifecycle', 'dynamicMcpConnection', 'durableContinuation', 'skillRegistry', 'toolRegistry',
    'loaderMutation', 'acquisition', 'reason',
  ])
  const managedPluginLifecycle = bool(input.managedPluginLifecycle, `${subject}.managedPluginLifecycle`)
  const dynamicMcpConnection = bool(input.dynamicMcpConnection, `${subject}.dynamicMcpConnection`)
  const durableContinuation = bool(input.durableContinuation, `${subject}.durableContinuation`)
  const skillRegistry = bool(input.skillRegistry, `${subject}.skillRegistry`)
  const toolRegistry = bool(input.toolRegistry, `${subject}.toolRegistry`)
  const loaderMutation = bool(input.loaderMutation, `${subject}.loaderMutation`)
  const acquisition = bool(input.acquisition, `${subject}.acquisition`)
  const reason = input.reason === null ? null : literal(input.reason, new Set(['host-capability']), `${subject}.reason`)
  const ownersAvailable = managedPluginLifecycle
    && dynamicMcpConnection
    && durableContinuation
    && skillRegistry
    && toolRegistry
    && loaderMutation
  if ((acquisition && !ownersAvailable) || reason !== (acquisition ? null : 'host-capability')) fail(subject)
  return input as unknown as HostCapabilityProjection
}

function action(value: unknown, subject: string): InventoryRow['actions'][OperationKind] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(subject)
  const status = literal((value as Record<string, unknown>).status, new Set(['available', 'unavailable', 'external']), `${subject}.status`)
  const input = exactRecord(value, subject, status === 'available' ? ['status'] : ['status', 'reason'])
  if (status !== 'available') string(input.reason, `${subject}.reason`, 256)
  return input as unknown as InventoryRow['actions'][OperationKind]
}

function evidence(value: unknown, kind: InventoryRow['kind'], subject: string): InventoryRow['evidence'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(subject)
  const evidenceKind = literal((value as Record<string, unknown>).kind, new Set(['plugin', 'mcp', 'skill']), `${subject}.kind`)
  if (evidenceKind !== kind) fail(`${subject}.kind`)
  if (evidenceKind === 'plugin') {
    const input = exactRecord(value, subject, [
      'kind', 'restartToken', 'loaderPhase', 'consumerObserved', 'restartObserved',
    ])
    nullableString(input.restartToken, `${subject}.restartToken`)
    nullableString(input.loaderPhase, `${subject}.loaderPhase`)
    bool(input.consumerObserved, `${subject}.consumerObserved`)
    bool(input.restartObserved, `${subject}.restartObserved`)
    return input as unknown as InventoryRow['evidence']
  }
  if (evidenceKind === 'mcp') {
    const input = exactRecord(value, subject, [
      'kind', 'descriptorMatches', 'descriptorDigest', 'descriptorRevision', 'transport', 'desiredEnabled', 'observedLifecycle',
      'liveDetailAvailable', 'toolGeneration', 'qualifiedTools',
    ])
    bool(input.descriptorMatches, `${subject}.descriptorMatches`)
    if (input.descriptorDigest !== null) digest(input.descriptorDigest, `${subject}.descriptorDigest`)
    nullableString(input.descriptorRevision, `${subject}.descriptorRevision`)
    if (input.transport !== null) literal(input.transport, new Set(['stdio', 'http']), `${subject}.transport`)
    bool(input.desiredEnabled, `${subject}.desiredEnabled`)
    literal(input.observedLifecycle, new Set(['absent', 'disabled', 'starting', 'ready', 'degraded', 'unknown']), `${subject}.observedLifecycle`)
    bool(input.liveDetailAvailable, `${subject}.liveDetailAvailable`)
    if (input.toolGeneration !== null) integer(input.toolGeneration, `${subject}.toolGeneration`)
    array(input.qualifiedTools, `${subject}.qualifiedTools`, 500)
      .forEach((item, index) => { string(item, `${subject}.qualifiedTools[${index}]`) })
    return input as unknown as InventoryRow['evidence']
  }
  const input = exactRecord(value, subject, [
    'kind', 'contentRevision', 'catalogComplete', 'winningProvider', 'winningPath', 'definitionLoaded', 'invocation',
  ])
  nullableString(input.contentRevision, `${subject}.contentRevision`)
  bool(input.catalogComplete, `${subject}.catalogComplete`)
  nullableString(input.winningProvider, `${subject}.winningProvider`)
  nullableString(input.winningPath, `${subject}.winningPath`)
  bool(input.definitionLoaded, `${subject}.definitionLoaded`)
  if (input.invocation !== null) {
    const invocation = exactRecord(input.invocation, `${subject}.invocation`, ['modelInvocable', 'userInvocable'])
    bool(invocation.modelInvocable, `${subject}.invocation.modelInvocable`)
    bool(invocation.userInvocable, `${subject}.invocation.userInvocable`)
  }
  return input as unknown as InventoryRow['evidence']
}

function inventoryRow(value: unknown, snapshot: { scopeKey: string; profileId: string; observedAtMs: number }, index: number): InventoryRow {
  const subject = `inventory.rows[${index}]`
  const input = exactRecord(value, subject, [
    'schemaVersion', 'kind', 'extensionId', 'candidateRef', 'targetKey', 'scopeKey', 'profileId', 'ownership',
    'desired', 'materialized', 'effective', 'agentVisibility', 'verification', 'rollback', 'managedRevision',
    'ownerRevision', 'configurationRevision', 'observedAtMs', 'actions', 'updateObservation', 'restoreObservation', 'evidence',
  ])
  if (input.schemaVersion !== 1) fail(`${subject}.schemaVersion`)
  const kind = literal(input.kind, new Set(['plugin', 'mcp', 'skill']), `${subject}.kind`)
  string(input.extensionId, `${subject}.extensionId`)
  nullableString(input.candidateRef, `${subject}.candidateRef`)
  string(input.targetKey, `${subject}.targetKey`)
  if (input.scopeKey !== snapshot.scopeKey || input.profileId !== snapshot.profileId) fail(`${subject}.scope`)
  const ownership = literal(input.ownership, new Set(['center', 'external', 'system', 'parent-plugin']), `${subject}.ownership`)
  literal(input.desired, new Set(['enabled', 'disabled', 'removed']), `${subject}.desired`)
  literal(input.materialized, new Set(['absent', 'installed', 'configured']), `${subject}.materialized`)
  literal(input.effective, new Set([
    'inactive', 'restart-required', 'starting', 'active', 'degraded', 'activation-failed', 'unknown',
  ]), `${subject}.effective`)
  literal(input.agentVisibility, new Set(['visible', 'not-visible', 'unknown']), `${subject}.agentVisibility`)
  literal(input.verification, new Set(['unverified', 'structural', 'runtime', 'task']), `${subject}.verification`)
  const rollback = literal(input.rollback, new Set(['available', 'running', 'used', 'unavailable', 'failed']), `${subject}.rollback`)
  string(input.managedRevision, `${subject}.managedRevision`)
  string(input.ownerRevision, `${subject}.ownerRevision`)
  nullableString(input.configurationRevision, `${subject}.configurationRevision`)
  if (timestamp(input.observedAtMs, `${subject}.observedAtMs`) > snapshot.observedAtMs) fail(`${subject}.observedAtMs`)
  const actions = exactRecord(input.actions, `${subject}.actions`, [...OPERATIONS])
  const parsedActions = Object.fromEntries([...OPERATIONS].map(operation => [
    operation,
    action(actions[operation], `${subject}.actions.${operation}`),
  ])) as InventoryRow['actions']
  if (typeof input.updateObservation !== 'object' || input.updateObservation === null || Array.isArray(input.updateObservation)) {
    fail(`${subject}.updateObservation`)
  }
  const updateStatus = literal(
    (input.updateObservation as Record<string, unknown>).status,
    new Set(['unknown', 'none', 'available']),
    `${subject}.updateObservation.status`,
  )
  const update = exactRecord(
    input.updateObservation,
    `${subject}.updateObservation`,
    updateStatus === 'available' ? ['status', 'candidateRef', 'revision', 'integrity'] : ['status'],
  )
  if (updateStatus === 'available') {
    string(update.candidateRef, `${subject}.updateObservation.candidateRef`)
    string(update.revision, `${subject}.updateObservation.revision`)
    integrity(update.integrity, `${subject}.updateObservation.integrity`)
  }
  if (typeof input.restoreObservation !== 'object' || input.restoreObservation === null || Array.isArray(input.restoreObservation)) {
    fail(`${subject}.restoreObservation`)
  }
  const restoreStatus = literal(
    (input.restoreObservation as Record<string, unknown>).status,
    new Set(['unknown', 'none', 'available']),
    `${subject}.restoreObservation.status`,
  )
  const restore = exactRecord(
    input.restoreObservation,
    `${subject}.restoreObservation`,
    restoreStatus === 'available' ? ['status', 'candidateRef', 'revision', 'integrity'] : ['status'],
  )
  if (restoreStatus === 'available') {
    string(restore.candidateRef, `${subject}.restoreObservation.candidateRef`)
    string(restore.revision, `${subject}.restoreObservation.revision`)
    integrity(restore.integrity, `${subject}.restoreObservation.integrity`)
  }
  if (parsedActions.update.status === 'available' && updateStatus !== 'available') fail(`${subject}.updateObservation`)
  if (parsedActions.restore.status === 'available' && restoreStatus !== 'available') fail(`${subject}.restoreObservation`)
  if (restoreStatus === 'available' && (ownership !== 'center' || !['available', 'used'].includes(rollback))) {
    fail(`${subject}.restoreObservation`)
  }
  evidence(input.evidence, kind as InventoryRow['kind'], `${subject}.evidence`)
  return input as unknown as InventoryRow
}

/** Strictly validate an inventory/list response and recompute its canonical revision. */
export async function parseInventoryListResponse(value: unknown): Promise<InventoryListResponse> {
  responseSize(value, 'inventory response')
  const input = exactRecord(value, 'inventory response', ['protocolVersion', 'hostCapabilities', 'inventory'])
  if (input.protocolVersion !== PROTOCOL_VERSION) fail('inventory response.protocolVersion')
  capabilities(input.hostCapabilities, 'inventory response.hostCapabilities')
  const inventory = exactRecord(input.inventory, 'inventory response.inventory', [
    'schemaVersion', 'scopeKey', 'profileId', 'complete', 'observedAtMs', 'rows', 'revision',
  ])
  if (inventory.schemaVersion !== 1) fail('inventory response.inventory.schemaVersion')
  const scopeKey = string(inventory.scopeKey, 'inventory response.inventory.scopeKey')
  const profileId = string(inventory.profileId, 'inventory response.inventory.profileId')
  bool(inventory.complete, 'inventory response.inventory.complete')
  const observedAtMs = timestamp(inventory.observedAtMs, 'inventory response.inventory.observedAtMs')
  const revision = digest(inventory.revision, 'inventory response.inventory.revision')
  const rows = array(inventory.rows, 'inventory response.inventory.rows', MAX_ROWS)
    .map((row, index) => inventoryRow(row, { scopeKey, profileId, observedAtMs }, index))
  const identities = new Set<string>()
  for (const row of rows) {
    const identity = `${row.kind}\u0000${row.targetKey}`
    if (identities.has(identity)) fail('inventory response duplicate target')
    identities.add(identity)
  }
  if (await canonicalDigest({
    schemaVersion: 1,
    scopeKey,
    profileId,
    complete: inventory.complete,
    observedAtMs,
    rows,
  }) !== revision) throw new Error('extension-center: inventory revision mismatch')
  return input as unknown as InventoryListResponse
}

function planContent(value: unknown): ImmutablePlan['content'] {
  const subject = 'plan.content'
  const input = exactRecord(value, subject, [
    'schemaVersion', 'singleUse', 'planId', 'intentId', 'origin', 'candidateRef', 'extensionKind', 'extensionId',
    'managedObject', 'externalRuntimeAction', 'runtimeBinding',
    'artifactRevision', 'artifactIntegrity', 'artifactUrl', 'artifactSizeBytes', 'operationKind', 'desiredState', 'targetKey', 'ownerKey', 'scopeKey',
    'profileId', 'idempotencyKey', 'authorityDigest', 'configurationDigest', 'retentionDigest', 'mutationDigest', 'verificationDigest',
    'reviewEvidence', 'restartRequired', 'createdAtMs',
    'expiresAtMs', 'fences',
  ])
  if (input.schemaVersion !== 1 || input.singleUse !== true) fail(subject)
  string(input.planId, `${subject}.planId`)
  string(input.intentId, `${subject}.intentId`)
  literal(input.origin, new Set(['store', 'task']), `${subject}.origin`)
  string(input.candidateRef, `${subject}.candidateRef`)
  literal(input.extensionKind, new Set(['plugin', 'mcp', 'skill']), `${subject}.extensionKind`)
  string(input.extensionId, `${subject}.extensionId`)
  const objectBinding = managedObjectBinding(input, subject)
  if ((input.extensionKind === 'mcp') !== (objectBinding.managedObject === 'connection')) fail(`${subject}.managedObject`)
  string(input.artifactRevision, `${subject}.artifactRevision`)
  integrity(input.artifactIntegrity, `${subject}.artifactIntegrity`)
  const artifactUrl = string(input.artifactUrl, `${subject}.artifactUrl`, 2_048)
  try {
    const parsed = new URL(artifactUrl)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') fail(`${subject}.artifactUrl`)
  } catch {
    fail(`${subject}.artifactUrl`)
  }
  integer(input.artifactSizeBytes, `${subject}.artifactSizeBytes`)
  literal(input.operationKind, OPERATIONS, `${subject}.operationKind`)
  literal(input.desiredState, new Set(['enabled', 'disabled', 'removed']), `${subject}.desiredState`)
  for (const field of ['targetKey', 'ownerKey', 'scopeKey', 'profileId', 'idempotencyKey'] as const) {
    string(input[field], `${subject}.${field}`)
  }
  for (const field of ['authorityDigest', 'configurationDigest', 'retentionDigest', 'mutationDigest', 'verificationDigest'] as const) {
    digest(input[field], `${subject}.${field}`)
  }
  const review = reviewEvidence(input.reviewEvidence, `${subject}.reviewEvidence`)
  if (review.kind !== input.extensionKind || review.operationKind !== input.operationKind) fail(`${subject}.reviewEvidence binding`)
  const restartRequired = bool(input.restartRequired, `${subject}.restartRequired`)
  if (review.restartRequired !== null && review.restartRequired !== restartRequired) {
    fail(`${subject}.restartRequired binding`)
  }
  const createdAtMs = timestamp(input.createdAtMs, `${subject}.createdAtMs`)
  const expiresAtMs = timestamp(input.expiresAtMs, `${subject}.expiresAtMs`)
  if (createdAtMs >= expiresAtMs) fail(`${subject}.expiry`)
  const fences = exactRecord(input.fences, `${subject}.fences`, [
    'catalogRevision', 'inventoryRevision', 'targetRevision', 'ownerRevision', 'scopeRevision', 'profileRevision',
  ])
  if (integer(fences.catalogRevision, `${subject}.fences.catalogRevision`) < 1) fail(`${subject}.fences.catalogRevision`)
  digest(fences.inventoryRevision, `${subject}.fences.inventoryRevision`)
  for (const field of ['targetRevision', 'ownerRevision', 'scopeRevision', 'profileRevision'] as const) {
    string(fences[field], `${subject}.fences.${field}`)
  }
  return input as unknown as ImmutablePlan['content']
}

async function plan(value: unknown): Promise<ImmutablePlan> {
  const input = exactRecord(value, 'plan', ['content', 'hash'])
  const content = planContent(input.content)
  const hash = digest(input.hash, 'plan.hash')
  if (await canonicalDigest(content) !== hash) throw new Error('extension-center: plan hash mismatch')
  return input as unknown as ImmutablePlan
}

function policy(value: unknown): IntentPreviewResponse['policy'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('intent preview policy')
  const status = literal((value as Record<string, unknown>).status, new Set(['eligible', 'denied']), 'intent preview policy.status')
  const input = exactRecord(
    value,
    'intent preview policy',
    status === 'eligible'
      ? ['status', 'policyRevision', 'authorityDigest']
      : ['status', 'policyRevision', 'code', 'reason'],
  )
  string(input.policyRevision, 'intent preview policy.policyRevision')
  if (status === 'eligible') digest(input.authorityDigest, 'intent preview policy.authorityDigest')
  else {
    literal(input.code, new Set([
      'catalog-unavailable', 'catalog-incomplete', 'host-capability', 'compatibility-unavailable', 'platform-unavailable',
      'lifecycle-incomplete', 'action-unavailable',
      'moving-reference', 'scope-unavailable', 'authority-unknown', 'lifecycle-script', 'credential-unsupported',
      'external-runtime-unresolved', 'review-evidence-unavailable', 'verification-incomplete', 'task-choice-required',
    ]), 'intent preview policy.code')
    string(input.reason, 'intent preview policy.reason', 1_000)
  }
  return input as unknown as IntentPreviewResponse['policy']
}

/** Strictly validate an intent/preview response and recompute its plan hash. */
export async function parseIntentPreviewResponse(value: unknown): Promise<IntentPreviewResponse> {
  responseSize(value, 'intent preview response')
  const input = exactRecord(value, 'intent preview response', ['protocolVersion', 'intentId', 'plan', 'policy'])
  if (input.protocolVersion !== PROTOCOL_VERSION) fail('intent preview response.protocolVersion')
  const intentId = string(input.intentId, 'intent preview response.intentId')
  const verifiedPlan = await plan(input.plan)
  if (verifiedPlan.content.intentId !== intentId || verifiedPlan.content.origin !== 'store') {
    fail('intent preview response plan binding')
  }
  const verifiedPolicy = policy(input.policy)
  if (verifiedPolicy.status === 'eligible' && verifiedPolicy.authorityDigest !== verifiedPlan.content.authorityDigest) {
    fail('intent preview response authority binding')
  }
  return input as unknown as IntentPreviewResponse
}

async function planState(value: unknown): Promise<PlanAuthorizationState> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('plan state')
  const status = literal(
    (value as Record<string, unknown>).status,
    new Set(['pending', 'approved', 'rejected', 'expired', 'consumed']),
    'plan state.status',
  )
  const keys = status === 'pending' ? ['status', 'plan']
    : status === 'expired' ? ['status', 'plan', 'expiredAtMs']
      : status === 'consumed' ? ['status', 'plan', 'decision', 'authorization']
        : ['status', 'plan', 'decision']
  const input = exactRecord(value, 'plan state', keys)
  const verifiedPlan = await plan(input.plan)
  if (status === 'expired') {
    if (timestamp(input.expiredAtMs, 'plan state.expiredAtMs') < verifiedPlan.content.expiresAtMs) fail('plan state.expiredAtMs')
  } else if (status !== 'pending') {
    const decision = exactRecord(input.decision, 'plan state.decision', [
      'planId', 'planHash', 'operationKind', 'decision', 'decidedAtMs',
    ])
    const decisionValue = literal(decision.decision, new Set(['approve', 'reject']), 'plan state.decision.decision')
    const decidedAtMs = timestamp(decision.decidedAtMs, 'plan state.decision.decidedAtMs')
    if (
      decision.planId !== verifiedPlan.content.planId
      || decision.planHash !== verifiedPlan.hash
      || decision.operationKind !== verifiedPlan.content.operationKind
      || decidedAtMs < verifiedPlan.content.createdAtMs
      || decidedAtMs >= verifiedPlan.content.expiresAtMs
      || (status === 'approved' && decisionValue !== 'approve')
      || (status === 'rejected' && decisionValue !== 'reject')
      || (status === 'consumed' && decisionValue !== 'approve')
    ) fail('plan state decision binding')
    if (status === 'consumed') {
      const authorization = exactRecord(input.authorization, 'plan state.authorization', [
        'operationId', 'planId', 'planHash', 'operationKind', 'managedObject', 'externalRuntimeAction', 'runtimeBinding',
        'targetKey', 'ownerKey', 'scopeKey', 'profileId', 'authorizedAtMs',
      ])
      string(authorization.operationId, 'plan state.authorization.operationId')
      const objectBinding = managedObjectBinding(authorization, 'plan state.authorization')
      if (
        authorization.planId !== verifiedPlan.content.planId
        || authorization.planHash !== verifiedPlan.hash
        || authorization.operationKind !== verifiedPlan.content.operationKind
        || objectBinding.managedObject !== verifiedPlan.content.managedObject
        || objectBinding.externalRuntimeAction !== verifiedPlan.content.externalRuntimeAction
        || !sameRuntimeBinding(objectBinding.runtimeBinding, verifiedPlan.content.runtimeBinding)
        || authorization.targetKey !== verifiedPlan.content.targetKey
        || authorization.ownerKey !== verifiedPlan.content.ownerKey
        || authorization.scopeKey !== verifiedPlan.content.scopeKey
        || authorization.profileId !== verifiedPlan.content.profileId
      ) fail('plan state authorization binding')
      const authorizedAtMs = timestamp(authorization.authorizedAtMs, 'plan state.authorization.authorizedAtMs')
      if (authorizedAtMs < decidedAtMs || authorizedAtMs >= verifiedPlan.content.expiresAtMs) {
        fail('plan state authorization time binding')
      }
    }
  }
  return input as unknown as PlanAuthorizationState
}

/** Strictly validate task approval rows and their exact typed configuration. */
export async function parseTaskApprovalListResponse(value: unknown): Promise<TaskApprovalListResponse> {
  responseSize(value, 'task approval response')
  const input = exactRecord(value, 'task approval response', ['protocolVersion', 'approvals', 'configurations'])
  if (input.protocolVersion !== PROTOCOL_VERSION) fail('task approval response.protocolVersion')
  const hashes = new Set<string>()
  for (const [index, item] of array(input.approvals, 'task approval response.approvals', MAX_ROWS).entries()) {
    const subject = `task approval response.approvals[${index}]`
    const row = exactRecord(item, subject, ['configuration', 'state'])
    const state = await planState(row.state)
    if (state.plan.content.origin !== 'task' || !['pending', 'approved'].includes(state.status)) fail(`${subject}.state`)
    if (hashes.has(state.plan.hash)) fail('task approval response duplicate plan')
    hashes.add(state.plan.hash)
    rpcJson(row.configuration, `${subject}.configuration`)
  }
  const configurationIds = new Set<string>()
  for (const [index, item] of array(input.configurations, 'task approval response.configurations', MAX_ROWS).entries()) {
    const subject = `task approval response.configurations[${index}]`
    const row = exactRecord(item, subject, [
      'candidateRef', 'continuationId', 'createdAtMs', 'expiresAtMs', 'extensionKind', 'profileId', 'resolutionId', 'scopeKey',
    ])
    const resolutionId = string(row.resolutionId, `${subject}.resolutionId`, 64)
    if (!/^resolution:[0-9a-f-]{36}$/u.test(resolutionId)) fail(`${subject}.resolutionId`)
    const candidateRef = string(row.candidateRef, `${subject}.candidateRef`, 256)
    if (!candidateRef.startsWith('mcp:')) fail(`${subject}.candidateRef`)
    const continuationId = string(row.continuationId, `${subject}.continuationId`, 36)
    if (!/^[0-9a-f-]{36}$/u.test(continuationId)) fail(`${subject}.continuationId`)
    if (row.extensionKind !== 'mcp') fail(`${subject}.extensionKind`)
    string(row.scopeKey, `${subject}.scopeKey`, 128)
    string(row.profileId, `${subject}.profileId`, 128)
    const createdAtMs = timestamp(row.createdAtMs, `${subject}.createdAtMs`)
    const expiresAtMs = timestamp(row.expiresAtMs, `${subject}.expiresAtMs`)
    if (createdAtMs >= expiresAtMs) fail(`${subject}.expiry`)
    const identity = `${resolutionId}\u0000${candidateRef}`
    if (configurationIds.has(identity)) fail('task approval response duplicate configuration')
    configurationIds.add(identity)
  }
  return input as unknown as TaskApprovalListResponse
}

async function parseTaskConfigurationResponse(value: unknown): Promise<TaskConfigurationResponse> {
  responseSize(value, 'task configuration response')
  const input = exactRecord(value, 'task configuration response', [
    'protocolVersion', 'resolutionId', 'intentId', 'plan', 'policy',
  ])
  if (input.protocolVersion !== PROTOCOL_VERSION) fail('task configuration response.protocolVersion')
  const resolutionId = string(input.resolutionId, 'task configuration response.resolutionId', 64)
  if (!/^resolution:[0-9a-f-]{36}$/u.test(resolutionId)) fail('task configuration response.resolutionId')
  const intentId = string(input.intentId, 'task configuration response.intentId')
  const verifiedPlan = await plan(input.plan)
  const verifiedPolicy = policy(input.policy)
  if (verifiedPlan.content.origin !== 'task'
    || verifiedPlan.content.intentId !== intentId
    || verifiedPolicy.status !== 'eligible'
    || verifiedPolicy.authorityDigest !== verifiedPlan.content.authorityDigest) {
    fail('task configuration response plan binding')
  }
  return input as unknown as TaskConfigurationResponse
}

function taskAttemptId(value: unknown, subject: string): string {
  const result = string(value, subject, 64)
  if (!TASK_ATTEMPT.test(result)) fail(subject)
  return result
}

function candidateRef(value: unknown, subject: string): string {
  const result = string(value, subject, 256)
  if (!CANDIDATE.test(result)) fail(subject)
  return result
}

function taskCandidateRefs(value: unknown, subject: string, allowEmpty: boolean): readonly string[] {
  const values = array(value, subject, 3).map((item, index) => candidateRef(item, `${subject}[${String(index)}]`))
  if ((!allowEmpty && values.length === 0)
    || new Set(values).size !== values.length
    || values.some((item, index) => item !== [...values].sort()[index])) fail(subject)
  return values
}

function taskAttempt(value: unknown, subject: string): TaskAttemptListResponse['attempts'][number] {
  const input = exactRecord(value, subject, [
    'acquisition', 'choice', 'createdAtMs', 'expiresAtMs', 'management', 'originalMessageId', 'outcome',
    'parentAttemptId', 'phase', 'reason', 'retryContinuation', 'sessionId', 'taskAttemptId', 'trigger',
    'updatedAtMs',
  ])
  const attemptId = taskAttemptId(input.taskAttemptId, `${subject}.taskAttemptId`)
  const parentAttemptId = input.parentAttemptId === null
    ? null
    : taskAttemptId(input.parentAttemptId, `${subject}.parentAttemptId`)
  if (parentAttemptId === attemptId) fail(`${subject}.parentAttemptId`)
  const trigger = literal(input.trigger, new Set(['model', 'choice-selection', 'retry-original'] as const), `${subject}.trigger`)
  if ((trigger === 'model') !== (parentAttemptId === null)) fail(`${subject}.trigger`)
  string(input.sessionId, `${subject}.sessionId`, 512)
  string(input.originalMessageId, `${subject}.originalMessageId`, 512)
  const createdAtMs = timestamp(input.createdAtMs, `${subject}.createdAtMs`)
  const expiresAtMs = timestamp(input.expiresAtMs, `${subject}.expiresAtMs`)
  const updatedAtMs = timestamp(input.updatedAtMs, `${subject}.updatedAtMs`)
  if (createdAtMs >= expiresAtMs || updatedAtMs < createdAtMs) fail(`${subject}.time`)
  const phase = literal(input.phase, new Set([
    'checking-existing', 'resolving', 'awaiting-approval', 'acquiring', 'verifying-visibility',
    'restart-required', 'ready-to-resume', 'resuming',
  ] as const), `${subject}.phase`)
  const outcome = input.outcome === null ? null : literal(input.outcome, new Set([
    'use-existing', 'continued', 'choice-required', 'management-required', 'no-eligible-candidate',
    'discovery-unavailable', 'external-only', 'rejected', 'canceled', 'recovery-required',
    'resume-conflict', 'failed',
  ] as const), `${subject}.outcome`)
  const reason = input.reason === null ? null : string(input.reason, `${subject}.reason`, 256)
  if ((outcome === null) !== (reason === null)) fail(`${subject}.reason`)
  let choice: TaskAttemptListResponse['attempts'][number]['choice'] = null
  if (input.choice !== null) {
    const row = exactRecord(input.choice, `${subject}.choice`, ['candidateRefs'])
    choice = { candidateRefs: taskCandidateRefs(row.candidateRefs, `${subject}.choice.candidateRefs`, false) }
  }
  let management: TaskAttemptListResponse['attempts'][number]['management'] = null
  if (input.management !== null) {
    const row = exactRecord(input.management, `${subject}.management`, ['action', 'extensionRef'])
    const extensionRef = string(row.extensionRef, `${subject}.management.extensionRef`, 64)
    if (!EXTENSION_REF.test(extensionRef)) fail(`${subject}.management.extensionRef`)
    management = {
      extensionRef,
      action: literal(row.action, new Set(['configure', 'enable', 'restore', 'update'] as const), `${subject}.management.action`),
    }
  }
  let acquisition: TaskAttemptListResponse['attempts'][number]['acquisition'] = null
  if (input.acquisition !== null) {
    const row = exactRecord(input.acquisition, `${subject}.acquisition`, ['candidateRef', 'continuationId', 'resolutionId'])
    const resolutionId = string(row.resolutionId, `${subject}.acquisition.resolutionId`, 64)
    const continuationId = string(row.continuationId, `${subject}.acquisition.continuationId`, 36)
    if (!RESOLUTION.test(resolutionId) || !UUID.test(continuationId)) fail(`${subject}.acquisition`)
    acquisition = { resolutionId, candidateRef: candidateRef(row.candidateRef, `${subject}.acquisition.candidateRef`), continuationId }
  }
  let retryContinuation: TaskAttemptListResponse['attempts'][number]['retryContinuation'] = null
  if (input.retryContinuation !== null) {
    const row = exactRecord(input.retryContinuation, `${subject}.retryContinuation`, ['continuationId', 'state'])
    const continuationId = row.continuationId === null
      ? null
      : string(row.continuationId, `${subject}.retryContinuation.continuationId`, 36)
    if (continuationId !== null && !UUID.test(continuationId)) fail(`${subject}.retryContinuation.continuationId`)
    const state = literal(row.state, new Set([
      'pending', 'ready', 'consumed', 'dispatching', 'dispatched', 'claimed', 'delivery-unknown',
      'canceled', 'superseded', 'expired', 'invalid',
      'reconciling', 'unavailable',
    ] as const), `${subject}.retryContinuation.state`)
    if (continuationId === null && !['canceled', 'reconciling', 'unavailable'].includes(state)) {
      fail(`${subject}.retryContinuation`)
    }
    retryContinuation = { continuationId, state }
  }
  if ((outcome === 'choice-required') !== (choice !== null)
    || (outcome === 'management-required') !== (management !== null)
    || (choice !== null && management !== null)
    || (acquisition !== null && (choice !== null || management !== null))) fail(`${subject}.result`)
  if (outcome === null) {
    const resolvedPhase = !['checking-existing', 'resolving'].includes(phase)
    if (resolvedPhase !== (acquisition !== null)) fail(`${subject}.acquisition`)
  }
  if (['use-existing', 'no-eligible-candidate', 'discovery-unavailable', 'external-only'].includes(String(outcome))
    && (choice !== null || management !== null || acquisition !== null)) fail(`${subject}.result`)
  if (retryContinuation !== null && (trigger !== 'retry-original' || outcome !== 'use-existing')) {
    fail(`${subject}.retryContinuation`)
  }
  return input as unknown as TaskAttemptListResponse['attempts'][number]
}

/** Strictly validate the durable task-attempt activity projection. */
export function parseTaskAttemptListResponse(value: unknown): TaskAttemptListResponse {
  responseSize(value, 'task attempt list response')
  const input = exactRecord(value, 'task attempt list response', ['attempts', 'protocolVersion'])
  if (input.protocolVersion !== PROTOCOL_VERSION) fail('task attempt list response.protocolVersion')
  const attempts = array(input.attempts, 'task attempt list response.attempts', MAX_OPERATIONS)
    .map((item, index) => taskAttempt(item, `task attempt list response.attempts[${String(index)}]`))
  const ids = new Set<string>()
  for (const [index, attempt] of attempts.entries()) {
    if (ids.has(attempt.taskAttemptId)) fail('task attempt list response duplicate attempt')
    ids.add(attempt.taskAttemptId)
    if (index > 0) {
      const prior = attempts[index - 1]!
      if (prior.createdAtMs > attempt.createdAtMs
        || (prior.createdAtMs === attempt.createdAtMs && prior.taskAttemptId >= attempt.taskAttemptId)) {
        fail('task attempt list response ordering')
      }
    }
  }
  if (attempts.some(attempt => attempt.parentAttemptId !== null && !ids.has(attempt.parentAttemptId))) {
    fail('task attempt list response parent binding')
  }
  return input as unknown as TaskAttemptListResponse
}

/** Strictly validate a non-authorizing task choice or Retry-original resolution. */
export function parseTaskAttemptResolutionResponse(value: unknown): TaskAttemptResolutionResponse {
  responseSize(value, 'task attempt resolution response')
  const input = exactRecord(value, 'task attempt resolution response', [
    'candidateRefs', 'continuationId', 'decision', 'existingCapabilityId', 'extensionRef', 'managementAction',
    'needDigest', 'next', 'protocolVersion', 'resolutionId', 'taskAttemptId',
  ])
  if (input.protocolVersion !== PROTOCOL_VERSION) fail('task attempt resolution response.protocolVersion')
  taskAttemptId(input.taskAttemptId, 'task attempt resolution response.taskAttemptId')
  digest(input.needDigest, 'task attempt resolution response.needDigest')
  const decision = literal(input.decision, new Set([
    'use-existing', 'management-required', 'acquisition-candidate', 'choice-required',
    'no-eligible-candidate', 'discovery-unavailable',
  ] as const), 'task attempt resolution response.decision')
  const candidates = taskCandidateRefs(input.candidateRefs, 'task attempt resolution response.candidateRefs', true)
  const resolutionId = input.resolutionId === null ? null : string(input.resolutionId, 'task attempt resolution response.resolutionId', 64)
  const continuationId = input.continuationId === null ? null : string(input.continuationId, 'task attempt resolution response.continuationId', 36)
  if ((resolutionId !== null && !RESOLUTION.test(resolutionId)) || (continuationId !== null && !UUID.test(continuationId))) {
    fail('task attempt resolution response acquisition ids')
  }
  const existingCapabilityId = input.existingCapabilityId === null
    ? null
    : string(input.existingCapabilityId, 'task attempt resolution response.existingCapabilityId', 512)
  const extensionRef = input.extensionRef === null
    ? null
    : string(input.extensionRef, 'task attempt resolution response.extensionRef', 64)
  if (extensionRef !== null && !EXTENSION_REF.test(extensionRef)) fail('task attempt resolution response.extensionRef')
  const managementAction = input.managementAction === null
    ? null
    : literal(input.managementAction, new Set(['configure', 'enable', 'restore', 'update'] as const), 'task attempt resolution response.managementAction')
  const next = literal(input.next, new Set(['use-existing', 'request-acquisition', 'human-choice', 'unavailable'] as const), 'task attempt resolution response.next')
  const acquisition = decision === 'acquisition-candidate'
  const management = decision === 'management-required'
  if (acquisition !== (resolutionId !== null && continuationId !== null && candidates.length === 1)
    || management !== (extensionRef !== null && managementAction !== null)
    || (decision === 'use-existing') !== (existingCapabilityId !== null)
    || (decision === 'choice-required') !== (candidates.length > 0 && resolutionId === null)
    || (!acquisition && (resolutionId !== null || continuationId !== null))
    || (!management && (extensionRef !== null || managementAction !== null))
    || (decision !== 'use-existing' && existingCapabilityId !== null)
    || (decision === 'use-existing' && next !== 'use-existing')
    || (acquisition && next !== 'request-acquisition' && next !== 'human-choice')
    || (decision === 'choice-required' && next !== 'human-choice')
    || (!['use-existing', 'acquisition-candidate', 'choice-required'].includes(decision) && next !== 'unavailable')) {
    fail('task attempt resolution response decision binding')
  }
  return input as unknown as TaskAttemptResolutionResponse
}

function parseTaskAttemptCancelResponse(value: unknown): TaskAttemptCancelResponse {
  responseSize(value, 'task attempt cancel response')
  const input = exactRecord(value, 'task attempt cancel response', ['attempt', 'protocolVersion'])
  if (input.protocolVersion !== PROTOCOL_VERSION) fail('task attempt cancel response.protocolVersion')
  const attempt = taskAttempt(input.attempt, 'task attempt cancel response.attempt')
  if (attempt.outcome !== 'canceled'
    && !(attempt.outcome === 'use-existing' && attempt.retryContinuation?.state === 'canceled')) {
    fail('task attempt cancel response.attempt')
  }
  return input as unknown as TaskAttemptCancelResponse
}

/** Strictly validate safe MCP selectors and current Center-owned configuration. */
export function parseConfigurationOptionsResponse(value: unknown): ConfigurationOptionsResponse {
  responseSize(value, 'configuration options response')
  const input = exactRecord(value, 'configuration options response', ['protocolVersion', 'options', 'currentConfiguration'])
  if (input.protocolVersion !== PROTOCOL_VERSION) fail('configuration options response.protocolVersion')
  const identities = new Set<string>()
  for (const [index, item] of array(input.options, 'configuration options response.options', 32).entries()) {
    const subject = `configuration options response.options[${index}]`
    const raw = item as Readonly<Record<string, unknown>>
    const transport = literal(raw?.transport, new Set(['stdio', 'streamable-http'] as const), `${subject}.transport`)
    const option = exactRecord(item, subject, transport === 'stdio'
      ? ['candidateRef', 'executablePath', 'fixedArgs', 'runtimeRef', 'transport', 'version', 'workingDirectory']
      : ['authentication', 'candidateRef', 'dataEgressDisclosure', 'endpoint', 'origin', 'redirects', 'runtimeRef', 'transport', 'version'])
    string(option.candidateRef, `${subject}.candidateRef`, 256)
    const runtimeRef = string(option.runtimeRef, `${subject}.runtimeRef`, 128)
    string(option.version, `${subject}.version`, 128)
    if (transport === 'stdio') {
      string(option.executablePath, `${subject}.executablePath`, 4096)
      string(option.workingDirectory, `${subject}.workingDirectory`, 4096)
      for (const [argumentIndex, argument] of array(option.fixedArgs, `${subject}.fixedArgs`, 64).entries()) {
        if (typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0')) {
          fail(`${subject}.fixedArgs[${String(argumentIndex)}]`)
        }
      }
    } else {
      if (option.authentication !== 'none' || option.redirects !== 'forbidden') fail(`${subject}.HTTP policy`)
      const origin = string(option.origin, `${subject}.origin`, 2048)
      const endpoint = string(option.endpoint, `${subject}.endpoint`, 2048)
      string(option.dataEgressDisclosure, `${subject}.dataEgressDisclosure`, 2048)
      let parsedOrigin: URL
      let parsedEndpoint: URL
      try {
        parsedOrigin = new URL(origin)
        parsedEndpoint = new URL(endpoint)
      } catch {
        fail(`${subject}.HTTP coordinates`)
      }
      if (parsedOrigin!.protocol !== 'https:' || parsedEndpoint!.protocol !== 'https:'
        || parsedOrigin!.username !== '' || parsedOrigin!.password !== ''
        || parsedEndpoint!.username !== '' || parsedEndpoint!.password !== ''
        || parsedOrigin!.pathname !== '/' || parsedOrigin!.search !== '' || parsedOrigin!.hash !== ''
        || parsedEndpoint!.hash !== '' || parsedOrigin!.origin !== origin
        || parsedEndpoint!.toString() !== endpoint || parsedEndpoint!.origin !== origin) {
        fail(`${subject}.HTTP coordinates`)
      }
    }
    if (identities.has(runtimeRef)) fail('configuration options response duplicate runtimeRef')
    identities.add(runtimeRef)
  }
  if (input.currentConfiguration !== null) rpcJson(input.currentConfiguration, 'configuration options response.currentConfiguration')
  return input as unknown as ConfigurationOptionsResponse
}

function receiptBody(value: unknown, subject: string): OperationReceipt['body'] {
  const input = exactRecord(value, subject, [
    'schemaVersion', 'operationId', 'planId', 'planHash', 'operationKind', 'managedObject', 'externalRuntimeAction',
    'runtimeBinding', 'planEvidence', 'targetKey', 'outcome', 'beforeDigest',
    'afterDigest', 'mutationDigests', 'verificationDigests', 'evidence', 'journalEventCount', 'journalHeadDigest', 'issuedAtMs',
  ])
  if (input.schemaVersion !== 1) fail(`${subject}.schemaVersion`)
  for (const field of ['operationId', 'planId', 'targetKey'] as const) string(input[field], `${subject}.${field}`)
  digest(input.planHash, `${subject}.planHash`)
  literal(input.operationKind, OPERATIONS, `${subject}.operationKind`)
  managedObjectBinding(input, subject)
  const planEvidence = receiptPlanEvidence(input.planEvidence, `${subject}.planEvidence`)
  const outcome = literal(input.outcome, new Set(['committed', 'rolled-back', 'failed'] as const), `${subject}.outcome`)
  digest(input.beforeDigest, `${subject}.beforeDigest`)
  if (input.afterDigest !== null) digest(input.afterDigest, `${subject}.afterDigest`)
  for (const field of ['mutationDigests', 'verificationDigests'] as const) {
    array(input[field], `${subject}.${field}`, 2_000)
      .forEach((item, index) => { digest(item, `${subject}.${field}[${index}]`) })
  }
  receiptEvidence(input.evidence, {
    outcome,
    mutationCount: (input.mutationDigests as readonly unknown[]).length,
    verificationCount: (input.verificationDigests as readonly unknown[]).length,
    restartRequired: planEvidence.restartRequired,
  }, `${subject}.evidence`)
  if (integer(input.journalEventCount, `${subject}.journalEventCount`) < 1) fail(`${subject}.journalEventCount`)
  digest(input.journalHeadDigest, `${subject}.journalHeadDigest`)
  timestamp(input.issuedAtMs, `${subject}.issuedAtMs`)
  return input as unknown as OperationReceipt['body']
}

function receiptPlanEvidence(value: unknown, subject: string): OperationReceipt['body']['planEvidence'] {
  const input = exactRecord(value, subject, [
    'origin', 'candidateRef', 'extensionKind', 'extensionId', 'artifactRevision', 'artifactIntegrity', 'artifactUrl',
    'artifactSizeBytes', 'desiredState', 'ownerKey', 'scopeKey', 'profileId', 'idempotencyKey', 'authorityDigest',
    'configurationDigest', 'retentionDigest', 'mutationDigest', 'verificationDigest', 'reviewEvidence', 'restartRequired', 'fences',
    'recoveryExecutable',
  ])
  literal(input.origin, new Set(['store', 'task'] as const), `${subject}.origin`)
  for (const field of ['candidateRef', 'extensionId', 'artifactRevision', 'ownerKey', 'scopeKey', 'profileId', 'idempotencyKey'] as const) {
    string(input[field], `${subject}.${field}`)
  }
  literal(input.extensionKind, new Set(['plugin', 'mcp', 'skill'] as const), `${subject}.extensionKind`)
  integrity(input.artifactIntegrity, `${subject}.artifactIntegrity`)
  const artifactUrl = string(input.artifactUrl, `${subject}.artifactUrl`, 2_048)
  try {
    const parsed = new URL(artifactUrl)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') fail(`${subject}.artifactUrl`)
  } catch {
    fail(`${subject}.artifactUrl`)
  }
  integer(input.artifactSizeBytes, `${subject}.artifactSizeBytes`)
  literal(input.desiredState, new Set(['enabled', 'disabled', 'removed'] as const), `${subject}.desiredState`)
  for (const field of ['authorityDigest', 'configurationDigest', 'retentionDigest', 'mutationDigest', 'verificationDigest'] as const) {
    digest(input[field], `${subject}.${field}`)
  }
  const review = reviewEvidence(input.reviewEvidence, `${subject}.reviewEvidence`)
  if (review.kind !== input.extensionKind) fail(`${subject}.reviewEvidence binding`)
  const restartRequired = bool(input.restartRequired, `${subject}.restartRequired`)
  if (review.restartRequired !== null && review.restartRequired !== restartRequired) {
    fail(`${subject}.restartRequired binding`)
  }
  const fences = exactRecord(input.fences, `${subject}.fences`, [
    'catalogRevision', 'inventoryRevision', 'targetRevision', 'ownerRevision', 'scopeRevision', 'profileRevision',
  ])
  if (integer(fences.catalogRevision, `${subject}.fences.catalogRevision`) < 1) fail(`${subject}.fences.catalogRevision`)
  digest(fences.inventoryRevision, `${subject}.fences.inventoryRevision`)
  for (const field of ['targetRevision', 'ownerRevision', 'scopeRevision', 'profileRevision'] as const) {
    string(fences[field], `${subject}.fences.${field}`)
  }
  const recovery = exactRecord(input.recoveryExecutable, `${subject}.recoveryExecutable`, [
    'arch', 'centerRoot', 'executablePath', 'executableSha256', 'officialDsh', 'packageVersion', 'platform', 'schemaVersion',
  ])
  if (recovery.schemaVersion !== 5) fail(`${subject}.recoveryExecutable.schemaVersion`)
  literal(recovery.platform, new Set(['darwin', 'linux', 'win32'] as const), `${subject}.recoveryExecutable.platform`)
  for (const field of ['executablePath', 'centerRoot'] as const) {
    absolutePath(recovery[field], `${subject}.recoveryExecutable.${field}`)
  }
  digest(recovery.executableSha256, `${subject}.recoveryExecutable.executableSha256`)
  string(recovery.packageVersion, `${subject}.recoveryExecutable.packageVersion`, 128)
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(string(recovery.arch, `${subject}.recoveryExecutable.arch`, 64))) {
    fail(`${subject}.recoveryExecutable.arch`)
  }
  const officialDsh = exactRecord(recovery.officialDsh, `${subject}.recoveryExecutable.officialDsh`, [
    'entrypointPath', 'entrypointSha256', 'hostHome', 'packageName', 'packageRoot', 'packageTreeSha256',
    'packageVersion', 'pnpm', 'productionDependencies', 'schemaVersion', 'supervisorPath', 'supervisorSha256',
    'timeoutMs', 'node',
  ])
  if (officialDsh.schemaVersion !== 2 || officialDsh.packageName !== '@deepseek-ai/dsh'
    || officialDsh.packageVersion !== '0.1.1-rc.2') {
    fail(`${subject}.recoveryExecutable.officialDsh identity`)
  }
  for (const field of ['entrypointPath', 'hostHome', 'packageRoot', 'supervisorPath'] as const) {
    absolutePath(officialDsh[field], `${subject}.recoveryExecutable.officialDsh.${field}`)
  }
  digest(officialDsh.entrypointSha256, `${subject}.recoveryExecutable.officialDsh.entrypointSha256`)
  digest(officialDsh.packageTreeSha256, `${subject}.recoveryExecutable.officialDsh.packageTreeSha256`)
  digest(officialDsh.supervisorSha256, `${subject}.recoveryExecutable.officialDsh.supervisorSha256`)
  const recoveryTimeout = integer(officialDsh.timeoutMs, `${subject}.recoveryExecutable.officialDsh.timeoutMs`)
  if (recoveryTimeout < 1_000 || recoveryTimeout > 600_000) {
    fail(`${subject}.recoveryExecutable.officialDsh.timeoutMs`)
  }
  let previousDependency = ''
  array(
    officialDsh.productionDependencies,
    `${subject}.recoveryExecutable.officialDsh.productionDependencies`,
    1_024,
  ).forEach((value, index) => {
    const dependencySubject = `${subject}.recoveryExecutable.officialDsh.productionDependencies[${String(index)}]`
    const dependency = exactRecord(value, dependencySubject, [
      'packageName', 'packageRoot', 'packageTreeSha256', 'packageVersion',
    ])
    const packageName = string(dependency.packageName, `${dependencySubject}.packageName`, 256)
    const packageVersion = string(dependency.packageVersion, `${dependencySubject}.packageVersion`, 128)
    const packageRoot = absolutePath(dependency.packageRoot, `${dependencySubject}.packageRoot`)
    digest(dependency.packageTreeSha256, `${dependencySubject}.packageTreeSha256`)
    const key = `${packageName}\0${packageVersion}\0${packageRoot}`
    if (index > 0 && previousDependency.localeCompare(key) >= 0) fail(`${subject}.recoveryExecutable.officialDsh.productionDependencies`)
    previousDependency = key
  })
  const node = exactRecord(officialDsh.node, `${subject}.recoveryExecutable.officialDsh.node`, [
    'executablePath', 'executableSha256', 'schemaVersion', 'version',
  ])
  if (node.schemaVersion !== 1) fail(`${subject}.recoveryExecutable.officialDsh.node.schemaVersion`)
  absolutePath(node.executablePath, `${subject}.recoveryExecutable.officialDsh.node.executablePath`)
  digest(node.executableSha256, `${subject}.recoveryExecutable.officialDsh.node.executableSha256`)
  if (!/^v\d+\.\d+\.\d+(?:[-+].*)?$/u.test(string(
    node.version,
    `${subject}.recoveryExecutable.officialDsh.node.version`,
    64,
  ))) fail(`${subject}.recoveryExecutable.officialDsh.node.version`)
  const pnpm = exactRecord(officialDsh.pnpm, `${subject}.recoveryExecutable.officialDsh.pnpm`, [
    'entrypointPath', 'entrypointSha256', 'packageName', 'packageRoot', 'packageTreeSha256', 'packageVersion',
    'registryIntegrity', 'runtimeRoot', 'schemaVersion', 'shellPath', 'shellSha256', 'shimPath', 'shimSha256',
  ])
  if (pnpm.schemaVersion !== 1 || pnpm.packageName !== 'pnpm' || pnpm.packageVersion !== '11.7.0'
    || pnpm.registryIntegrity !== 'sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==') {
    fail(`${subject}.recoveryExecutable.officialDsh.pnpm identity`)
  }
  for (const field of ['packageRoot', 'entrypointPath', 'shimPath', 'shellPath', 'runtimeRoot'] as const) {
    absolutePath(pnpm[field], `${subject}.recoveryExecutable.officialDsh.pnpm.${field}`)
  }
  for (const field of ['packageTreeSha256', 'entrypointSha256', 'shimSha256', 'shellSha256'] as const) {
    digest(pnpm[field], `${subject}.recoveryExecutable.officialDsh.pnpm.${field}`)
  }
  return input as unknown as OperationReceipt['body']['planEvidence']
}

function receiptEvidence(
  value: unknown,
  context: Readonly<{
    outcome: 'committed' | 'rolled-back' | 'failed'
    mutationCount: number
    verificationCount: number
    restartRequired: boolean
  }>,
  subject: string,
): void {
  const input = exactRecord(value, subject, ['checksActuallyRun', 'mutation', 'verification', 'rollback', 'restart', 'recovery', 'notProven'])
  array(input.checksActuallyRun, `${subject}.checksActuallyRun`, 64).forEach((item, index) => {
    const row = exactRecord(item, `${subject}.checksActuallyRun[${String(index)}]`, ['code', 'phase'])
    string(row.code, `${subject}.checksActuallyRun[${String(index)}].code`, 128)
    literal(row.phase, new Set(['planning', 'prepare', 'apply', 'verify', 'external-restart']), `${subject}.checksActuallyRun[${String(index)}].phase`)
  })
  const statuses = new Set(['proven', 'not-required', 'not-proven'] as const)
  const mutation = literal(input.mutation, statuses, `${subject}.mutation`)
  const verification = literal(input.verification, statuses, `${subject}.verification`)
  const rollback = exactRecord(input.rollback, `${subject}.rollback`, ['attempted', 'status'])
  const rollbackAttempted = bool(rollback.attempted, `${subject}.rollback.attempted`)
  const rollbackStatus = literal(rollback.status, statuses, `${subject}.rollback.status`)
  const restart = exactRecord(input.restart, `${subject}.restart`, ['required', 'status'])
  const restartRequired = bool(restart.required, `${subject}.restart.required`)
  const restartStatus = literal(restart.status, statuses, `${subject}.restart.status`)
  const recovery = exactRecord(input.recovery, `${subject}.recovery`, ['attempts', 'status'])
  const recoveryAttempts = integer(recovery.attempts, `${subject}.recovery.attempts`)
  const recoveryStatus = literal(recovery.status, statuses, `${subject}.recovery.status`)
  const expected = {
    mutation: context.mutationCount > 0 ? 'proven' : context.outcome === 'failed' ? 'not-required' : 'not-proven',
    verification: context.outcome === 'committed' && context.verificationCount > 0
      ? 'proven' : context.outcome === 'failed' ? 'not-required' : 'not-proven',
    rollback: rollbackAttempted ? context.outcome === 'rolled-back' ? 'proven' : 'not-proven' : 'not-required',
    restart: context.restartRequired && context.mutationCount > 0
      ? context.verificationCount > 0 && context.outcome !== 'failed' ? 'proven' : 'not-proven'
      : 'not-required',
    recovery: recoveryAttempts === 0 ? 'not-required' : context.outcome === 'rolled-back' ? 'proven' : 'not-proven',
  } as const
  if (mutation !== expected.mutation
    || verification !== expected.verification
    || rollbackStatus !== expected.rollback
    || restartRequired !== (context.restartRequired && context.mutationCount > 0)
    || restartStatus !== expected.restart
    || recoveryStatus !== expected.recovery) fail(subject)
  const claimOrder = ['mutation', 'verification', 'rollback', 'restart', 'recovery'] as const
  const notProven = array(input.notProven, `${subject}.notProven`, claimOrder.length)
    .map((claim, index) => literal(claim, new Set(claimOrder), `${subject}.notProven[${String(index)}]`))
  const expectedClaims = claimOrder.filter(claim => expected[claim] === 'not-proven')
  if (notProven.length !== expectedClaims.length || notProven.some((claim, index) => claim !== expectedClaims[index])) fail(`${subject}.notProven`)
}

async function receipt(value: unknown, subject: string): Promise<OperationReceipt> {
  const input = exactRecord(value, subject, ['body', 'digest'])
  const body = receiptBody(input.body, `${subject}.body`)
  const receiptDigest = digest(input.digest, `${subject}.digest`)
  if (await canonicalDigest(body) !== receiptDigest) throw new Error(`extension-center: ${subject} digest mismatch`)
  return input as unknown as OperationReceipt
}

async function parseLifecycleResponse(value: unknown): Promise<LifecycleResponse> {
  responseSize(value, 'lifecycle response')
  const input = exactRecord(value, 'lifecycle response', ['protocolVersion', 'operationId', 'status', 'receipt'])
  if (input.protocolVersion !== PROTOCOL_VERSION) fail('lifecycle response.protocolVersion')
  const operationId = string(input.operationId, 'lifecycle response.operationId')
  const status = literal(input.status, new Set([
    'committed', 'rolled-back', 'failed', 'recovery-required', 'restart-required',
  ]), 'lifecycle response.status')
  if (status === 'restart-required' || status === 'recovery-required') {
    if (input.receipt !== null) fail('lifecycle response.receipt')
  } else {
    const verified = await receipt(input.receipt, 'lifecycle response.receipt')
    if (verified.body.operationId !== operationId || verified.body.outcome !== status) fail('lifecycle response receipt binding')
  }
  return input as unknown as LifecycleResponse
}

/** Strictly validate an operation/list response. */
export function parseOperationListResponse(value: unknown): OperationListResponse {
  responseSize(value, 'operation list response')
  const input = exactRecord(value, 'operation list response', ['protocolVersion', 'operations'])
  if (input.protocolVersion !== PROTOCOL_VERSION) fail('operation list response.protocolVersion')
  const identities = new Set<string>()
  array(input.operations, 'operation list response.operations', MAX_OPERATIONS).forEach((value, index) => {
    const subject = `operation list response.operations[${index}]`
    const row = exactRecord(value, subject, [
      'operationId', 'targetKey', 'phase', 'operationKind', 'lastAtMs', 'recoveryCommand', 'recoveryNotice',
    ])
    const operationId = string(row.operationId, `${subject}.operationId`)
    if (identities.has(operationId)) fail('operation list response duplicate operation')
    identities.add(operationId)
    string(row.targetKey, `${subject}.targetKey`)
    const phase = literal(row.phase, new Set([
      'authorized', 'staging', 'applying', 'verifying', 'rolling-back', 'committed', 'rolled-back', 'failed', 'recovery-required',
    ]), `${subject}.phase`)
    literal(row.operationKind, OPERATIONS, `${subject}.operationKind`)
    timestamp(row.lastAtMs, `${subject}.lastAtMs`)
    if (phase === 'recovery-required') {
      if (row.recoveryCommand === null) {
        if (row.recoveryNotice !== null) fail(`${subject}.recoveryNotice`)
      } else {
        const command = array(row.recoveryCommand, `${subject}.recoveryCommand`, 3)
        if (command.length !== 3) fail(`${subject}.recoveryCommand`)
        command.forEach((argument, argumentIndex) => {
          string(argument, `${subject}.recoveryCommand[${String(argumentIndex)}]`, 4_096)
        })
        if (row.recoveryNotice !== 'journal-reconciliation-pending') fail(`${subject}.recoveryNotice`)
      }
    } else if (row.recoveryCommand !== null || row.recoveryNotice !== null) {
      fail(`${subject}.recovery fields`)
    }
  })
  return input as unknown as OperationListResponse
}

/** Strictly validate an operation/receipts response and every receipt digest. */
export async function parseOperationReceiptsResponse(value: unknown): Promise<OperationReceiptsResponse> {
  responseSize(value, 'operation receipts response')
  const input = exactRecord(value, 'operation receipts response', ['protocolVersion', 'receipts'])
  if (input.protocolVersion !== PROTOCOL_VERSION) fail('operation receipts response.protocolVersion')
  const identities = new Set<string>()
  for (const [index, value] of array(input.receipts, 'operation receipts response.receipts', MAX_OPERATIONS).entries()) {
    const subject = `operation receipts response.receipts[${index}]`
    const stored = exactRecord(value, subject, ['operationId', 'targetKey', 'receipt'])
    const operationId = string(stored.operationId, `${subject}.operationId`)
    const targetKey = string(stored.targetKey, `${subject}.targetKey`)
    if (identities.has(operationId)) fail('operation receipts response duplicate operation')
    identities.add(operationId)
    const verified = await receipt(stored.receipt, `${subject}.receipt`)
    if (verified.body.operationId !== operationId || verified.body.targetKey !== targetKey) fail(`${subject} binding`)
  }
  return input as unknown as OperationReceiptsResponse
}

async function call(
  rpc: ClientConnectionRpc,
  endpoint: string,
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const result = await rpc.call(EXTENSION_CENTER_RPC_CHANNEL, endpoint, payload, signal)
  if (!result.ok) throw new ExtensionCenterRpcError(result.error)
  return result.value
}

/** Create a stateless, strict management client over the Connection carrier. */
export function createExtensionManagementClient(rpc: ClientConnectionRpc): ExtensionManagementClient {
  return {
    async inventory(scopeKey, profileId, signal) {
      const value = await call(rpc, 'inventory/list', { protocolVersion: PROTOCOL_VERSION, scopeKey, profileId }, signal)
      const response = await parseInventoryListResponse(value)
      if (response.inventory.scopeKey !== scopeKey || response.inventory.profileId !== profileId) {
        fail('inventory response request binding')
      }
      return response
    },
    async verify(scopeKey, profileId, targetKey, signal) {
      string(targetKey, 'inventory verify request.targetKey')
      const value = await call(rpc, 'inventory/verify', {
        protocolVersion: PROTOCOL_VERSION,
        scopeKey,
        profileId,
        targetKey,
      }, signal)
      const response = await parseInventoryListResponse(value)
      if (response.inventory.scopeKey !== scopeKey
        || response.inventory.profileId !== profileId
        || !response.inventory.rows.some(row => row.targetKey === targetKey)) {
        fail('inventory verify response request binding')
      }
      return response
    },
    async preview(input, signal) {
      if (input.targetKey !== null) string(input.targetKey, 'intent preview request.targetKey')
      if (input.targetKey === null && (input.operationKind === 'enable' || input.operationKind === 'disable' || input.operationKind === 'purge')) {
        fail('intent preview request.targetKey')
      }
      const value = await call(rpc, 'intent/preview', {
        protocolVersion: PROTOCOL_VERSION,
        origin: 'store',
        candidateRef: input.candidateRef,
        operationKind: input.operationKind,
        scopeKey: input.scopeKey,
        profileId: input.profileId,
        targetKey: input.targetKey,
        continuationId: null,
        configuration: input.configuration,
      }, signal)
      const response = await parseIntentPreviewResponse(value)
      if (
        response.plan.content.candidateRef !== input.candidateRef
        || response.plan.content.operationKind !== input.operationKind
        || response.plan.content.scopeKey !== input.scopeKey
        || response.plan.content.profileId !== input.profileId
        || (input.targetKey !== null && response.plan.content.targetKey !== input.targetKey)
      ) fail('intent preview response request binding')
      return response
    },
    async configurationOptions(input, signal) {
      if (input.targetKey !== null) string(input.targetKey, 'configuration options request.targetKey')
      literal(input.operationKind, new Set(OPERATIONS), 'configuration options request.operationKind')
      const response = parseConfigurationOptionsResponse(await call(rpc, 'configuration/options', {
        protocolVersion: PROTOCOL_VERSION,
        candidateRef: input.candidateRef,
        operationKind: input.operationKind,
        targetKey: input.targetKey,
        scopeKey: input.scopeKey,
        profileId: input.profileId,
      }, signal))
      if (response.options.some(option => option.candidateRef !== input.candidateRef)) {
        fail('configuration options response request binding')
      }
      return response
    },
    async taskApprovals(signal) {
      return parseTaskApprovalListResponse(await call(rpc, 'approval/list', { protocolVersion: PROTOCOL_VERSION }, signal))
    },
    async configureTask(input, signal) {
      if (!/^resolution:[0-9a-f-]{36}$/u.test(input.resolutionId)
        || !input.candidateRef.startsWith('mcp:')
        || !/^[0-9a-f-]{36}$/u.test(input.continuationId)) {
        fail('task configuration request binding')
      }
      rpcJson(input.configuration, 'task configuration request.configuration')
      const value = await call(rpc, 'approval/configure', {
        protocolVersion: PROTOCOL_VERSION,
        resolutionId: input.resolutionId,
        candidateRef: input.candidateRef,
        continuationId: input.continuationId,
        configuration: input.configuration,
      }, signal)
      const response = await parseTaskConfigurationResponse(value)
      if (response.resolutionId !== input.resolutionId
        || response.plan.content.candidateRef !== input.candidateRef) {
        fail('task configuration response request binding')
      }
      return response
    },
    async taskAttempts(signal) {
      return parseTaskAttemptListResponse(await call(
        rpc,
        'task-attempt/list',
        { protocolVersion: PROTOCOL_VERSION },
        signal,
      ))
    },
    async selectTaskCandidate(sourceTaskAttemptId, selectedCandidateRef, signal) {
      taskAttemptId(sourceTaskAttemptId, 'task choice request.taskAttemptId')
      candidateRef(selectedCandidateRef, 'task choice request.candidateRef')
      const response = parseTaskAttemptResolutionResponse(await call(rpc, 'task-attempt/select', {
        protocolVersion: PROTOCOL_VERSION,
        taskAttemptId: sourceTaskAttemptId,
        candidateRef: selectedCandidateRef,
      }, signal))
      if (response.taskAttemptId === sourceTaskAttemptId
        || (response.decision === 'acquisition-candidate' && response.candidateRefs[0] !== selectedCandidateRef)) {
        fail('task choice response request binding')
      }
      return response
    },
    async retryOriginalTask(sourceTaskAttemptId, signal) {
      taskAttemptId(sourceTaskAttemptId, 'task retry request.taskAttemptId')
      const response = parseTaskAttemptResolutionResponse(await call(rpc, 'task-attempt/retry', {
        protocolVersion: PROTOCOL_VERSION,
        taskAttemptId: sourceTaskAttemptId,
      }, signal))
      if (response.taskAttemptId === sourceTaskAttemptId) fail('task retry response request binding')
      return response
    },
    async cancelTaskAttempt(requestedTaskAttemptId, signal) {
      taskAttemptId(requestedTaskAttemptId, 'task cancel request.taskAttemptId')
      const response = parseTaskAttemptCancelResponse(await call(rpc, 'task-attempt/cancel', {
        protocolVersion: PROTOCOL_VERSION,
        taskAttemptId: requestedTaskAttemptId,
      }, signal))
      if (response.attempt.taskAttemptId !== requestedTaskAttemptId) fail('task cancel response request binding')
      return response
    },
    async plan(planHash, signal) {
      digest(planHash, 'plan get request.planHash')
      const value = await call(rpc, 'plan/get', { protocolVersion: PROTOCOL_VERSION, planHash }, signal)
      const input = exactRecord(value, 'plan get response', ['protocolVersion', 'state'])
      if (input.protocolVersion !== PROTOCOL_VERSION) fail('plan get response.protocolVersion')
      if (input.state === null) return null
      const state = await planState(input.state)
      if (state.plan.hash !== planHash) fail('plan get response request binding')
      return state
    },
    async decide(planValue, decision, signal) {
      const value = await call(rpc, 'plan/decide', {
        protocolVersion: PROTOCOL_VERSION,
        planId: planValue.content.planId,
        planHash: planValue.hash,
        operationKind: planValue.content.operationKind,
        decision,
      }, signal)
      const input = exactRecord(value, 'plan decision response', ['protocolVersion', 'state'])
      if (input.protocolVersion !== PROTOCOL_VERSION) fail('plan decision response.protocolVersion')
      const state = await planState(input.state)
      if (state.plan.hash !== planValue.hash) fail('plan decision response request binding')
      return state
    },
    async execute(planHash, signal) {
      digest(planHash, 'lifecycle request.planHash')
      const response = await parseLifecycleResponse(await call(rpc, 'lifecycle/request', {
        protocolVersion: PROTOCOL_VERSION,
        planHash,
      }, signal))
      if (response.receipt !== null && response.receipt.body.planHash !== planHash) {
        fail('lifecycle response request binding')
      }
      return response
    },
    async recover(operationId, signal) {
      string(operationId, 'operation recovery request.operationId')
      const response = await parseLifecycleResponse(await call(rpc, 'operation/recover', {
        protocolVersion: PROTOCOL_VERSION,
        operationId,
      }, signal))
      if (response.operationId !== operationId) fail('operation recovery response request binding')
      return response
    },
    async operations(signal) {
      return parseOperationListResponse(await call(rpc, 'operation/list', { protocolVersion: PROTOCOL_VERSION }, signal))
    },
    async receipts(signal) {
      return parseOperationReceiptsResponse(await call(rpc, 'operation/receipts', { protocolVersion: PROTOCOL_VERSION }, signal))
    },
  }
}

/** Parse one JSON configuration draft into the strict RPC JSON subset. */
export function parseConfigurationDraft(text: string): RpcJson {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('invalid-json')
  }
  const visit = (item: unknown): RpcJson => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(visit)
    if (typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => {
        if (child === undefined) throw new Error('invalid-json')
        return [key, visit(child)]
      }))
    }
    throw new Error('invalid-json')
  }
  return visit(value)
}
