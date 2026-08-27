import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type { ManagedTargetRecord, ManagedVersion, McpConnectionsOwner } from '../host/index.ts'
import { filesystemMcpCandidate } from '../kind-candidates.ts'
import type { McpReviewEvidence } from '../plans/index.ts'
import { CenterStateStore } from '../host/index.ts'
import type { RpcJson } from '../service/rpc-contract.ts'
import { managedStateDigest, nextManagedRecord } from './records.ts'
import type {
  AppliedProviderOperation,
  LifecycleProvider,
  PreparedProviderOperation,
  ProviderOperationRequest,
  ProviderVerification,
} from './types.ts'

interface AdmittedMcpRuntimeBase {
  readonly runtimeRef: string
  readonly candidateRef: string
  readonly version: string
}

/** Exact Host-preprovisioned stdio runtime; the Center never acquires these bytes. */
export interface AdmittedMcpStdioRuntime extends AdmittedMcpRuntimeBase {
  readonly transport: 'stdio'
  readonly executablePath: string
  readonly executableSha256: `sha256:${string}`
  readonly fixedArgs: readonly string[]
  readonly workingDirectory: string
}

/** Exact unauthenticated HTTPS connection admitted by the Host. */
export interface AdmittedMcpHttpRuntime extends AdmittedMcpRuntimeBase {
  readonly transport: 'streamable-http'
  readonly origin: string
  readonly endpoint: string
  readonly authentication: 'none'
  readonly redirects: 'forbidden'
  readonly dataEgressDisclosure: string
}

/** Host-authored immutable MCP descriptor allowlist; payloads select only its opaque id. */
export type AdmittedMcpRuntime = AdmittedMcpStdioRuntime | AdmittedMcpHttpRuntime

/** Verified fixed Host runtime descriptor bound into an immutable plan. */
export interface McpRuntimePreflight {
  readonly runtimeRef: string
  readonly version: string
  readonly descriptorDigest: `sha256:${string}`
  readonly reviewDescriptor: McpReviewEvidence['descriptor']
  readonly runtimeDigest: `sha256:${string}` | null
}

interface McpRuntimeOptionBase {
  readonly candidateRef: string
  readonly runtimeRef: string
  readonly version: string
}

/** Browser-safe stdio selector facts; none are accepted back as authority. */
export interface McpStdioRuntimeOption extends McpRuntimeOptionBase {
  readonly transport: 'stdio'
  readonly executablePath: string
  readonly fixedArgs: readonly string[]
  readonly workingDirectory: string
}

/** Browser-safe HTTPS selector facts and mandatory data-egress disclosure. */
export interface McpHttpRuntimeOption extends McpRuntimeOptionBase {
  readonly transport: 'streamable-http'
  readonly origin: string
  readonly endpoint: string
  readonly authentication: 'none'
  readonly redirects: 'forbidden'
  readonly dataEgressDisclosure: string
}

/** Safe exact selector row; the browser can select only runtimeRef. */
export type McpRuntimeOption = McpStdioRuntimeOption | McpHttpRuntimeOption

interface McpConfigurationBase {
  readonly connectionId: string
  readonly runtimeRef: string
  readonly toolCallTimeoutMs: number
  readonly reconnect: Readonly<{
    enabled: boolean
    initialDelayMs: number
    maxDelayMs: number
    maxAttempts: number
  }>
}

interface McpStdioConfiguration extends McpConfigurationBase {
  readonly transport: 'stdio'
  readonly roots: readonly string[]
}

interface McpHttpConfiguration extends McpConfigurationBase {
  readonly transport: 'streamable-http'
}

type McpConfiguration = McpStdioConfiguration | McpHttpConfiguration

interface McpKindStateBase {
  readonly connectionId: string
  readonly runtimeRef: string
  readonly runtimeVersion: string
  readonly descriptorDigest: `sha256:${string}`
  readonly configured: boolean
}

interface McpStdioKindState extends McpKindStateBase {
  readonly transport: 'stdio'
  readonly executablePath: string
}

interface McpHttpKindState extends McpKindStateBase {
  readonly transport: 'streamable-http'
  readonly origin: string
  readonly endpoint: string
  readonly dataEgressDisclosure: string
}

type McpKindState = McpStdioKindState | McpHttpKindState

interface PreparedMcp {
  readonly configuration: McpConfiguration
  readonly runtime: AdmittedMcpRuntime
  readonly ownerActiveRevision: number | null
  readonly ownerRemovedRevision: number | null
  readonly ownerToolGeneration: number | null
  readonly ownerToolNames: readonly string[]
}

/** Exact Host-owner observation for one Center-managed MCP version. */
export interface McpManagedOwnerEvidence {
  readonly descriptorMatches: boolean
  readonly descriptorDigest: `sha256:${string}` | null
  readonly descriptorRevision: string | null
  readonly transport: 'stdio' | 'http' | null
  readonly desiredEnabled: boolean
  readonly observedLifecycle: 'absent' | 'disabled' | 'starting' | 'ready' | 'degraded' | 'unknown'
  readonly liveDetailAvailable: boolean
  readonly toolGeneration: number | null
  readonly qualifiedTools: readonly string[]
}

function record(value: RpcJson): Readonly<Record<string, RpcJson>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('MCP configuration must be an object')
  return value as Readonly<Record<string, RpcJson>>
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[], subject: string): void {
  const actual = Object.keys(value).sort()
  const allowed = [...expected].sort()
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${subject} contains an unsupported or missing field`)
  }
}

async function configuration(value: RpcJson): Promise<McpConfiguration> {
  const input = record(value)
  if (input.transport !== 'stdio' && input.transport !== 'streamable-http') {
    throw new Error('MCP configuration transport is invalid')
  }
  exactKeys(
    input,
    input.transport === 'stdio'
      ? ['connectionId', 'reconnect', 'roots', 'runtimeRef', 'toolCallTimeoutMs', 'transport']
      : ['connectionId', 'reconnect', 'runtimeRef', 'toolCallTimeoutMs', 'transport'],
    'MCP configuration',
  )
  if (typeof input.connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(input.connectionId)) {
    throw new Error('MCP connectionId is invalid')
  }
  if (typeof input.runtimeRef !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(input.runtimeRef)) {
    throw new Error('MCP runtimeRef is invalid')
  }
  const roots: string[] = []
  if (input.transport === 'stdio') {
    if (!Array.isArray(input.roots) || input.roots.length === 0 || input.roots.length > 16) {
      throw new Error('MCP roots must contain between one and sixteen paths')
    }
    for (const root of input.roots) {
      if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw new Error('MCP roots must be absolute paths')
      const canonical = await realpath(root)
      if (canonical !== root) throw new Error('MCP root must be its canonical real path')
      const info = await lstat(canonical)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('MCP root must resolve to a real directory')
      roots.push(canonical)
    }
  }
  if (!Number.isSafeInteger(input.toolCallTimeoutMs) || (input.toolCallTimeoutMs as number) < 100
    || (input.toolCallTimeoutMs as number) > 300_000) {
    throw new Error('MCP toolCallTimeoutMs must be between 100 and 300000')
  }
  const reconnect = record(input.reconnect as RpcJson)
  const reconnectKeys = ['enabled', 'initialDelayMs', 'maxAttempts', 'maxDelayMs']
  if (Object.keys(reconnect).sort().join('\0') !== reconnectKeys.sort().join('\0')) {
    throw new Error('MCP reconnect contains an unsupported field')
  }
  if (typeof reconnect.enabled !== 'boolean'
    || !Number.isSafeInteger(reconnect.initialDelayMs)
    || (reconnect.initialDelayMs as number) < 50
    || (reconnect.initialDelayMs as number) > 60_000
    || !Number.isSafeInteger(reconnect.maxDelayMs)
    || (reconnect.maxDelayMs as number) < 50
    || (reconnect.maxDelayMs as number) > 300_000
    || (reconnect.initialDelayMs as number) > (reconnect.maxDelayMs as number)
    || !Number.isSafeInteger(reconnect.maxAttempts)
    || (reconnect.maxAttempts as number) < 1
    || (reconnect.maxAttempts as number) > 100) {
    throw new Error('MCP reconnect policy is outside the admitted bounds')
  }
  const common = {
    connectionId: input.connectionId,
    runtimeRef: input.runtimeRef,
    toolCallTimeoutMs: input.toolCallTimeoutMs as number,
    reconnect: Object.freeze({
      enabled: reconnect.enabled,
      initialDelayMs: reconnect.initialDelayMs as number,
      maxDelayMs: reconnect.maxDelayMs as number,
      maxAttempts: reconnect.maxAttempts as number,
    }),
  }
  return input.transport === 'stdio'
    ? Object.freeze({ ...common, transport: 'stdio', roots: Object.freeze([...new Set(roots)].sort()) })
    : Object.freeze({ ...common, transport: 'streamable-http' })
}

function kindState(value: ManagedVersion): McpKindState {
  const raw = value.kindState
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('managed MCP state is invalid')
  const state = raw as Record<string, RpcJson>
  if (state.transport !== 'stdio' && state.transport !== 'streamable-http') throw new Error('managed MCP state transport is invalid')
  exactKeys(
    state,
    state.transport === 'stdio'
      ? ['configured', 'connectionId', 'descriptorDigest', 'executablePath', 'runtimeRef', 'runtimeVersion', 'transport']
      : ['configured', 'connectionId', 'dataEgressDisclosure', 'descriptorDigest', 'endpoint', 'origin', 'runtimeRef', 'runtimeVersion', 'transport'],
    'managed MCP state',
  )
  if (typeof state.connectionId !== 'string'
    || typeof state.runtimeRef !== 'string'
    || typeof state.runtimeVersion !== 'string'
    || typeof state.descriptorDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(state.descriptorDigest)
    || typeof state.configured !== 'boolean') throw new Error('managed MCP state fields are invalid')
  if (state.transport === 'stdio' && typeof state.executablePath !== 'string') {
    throw new Error('managed MCP stdio state fields are invalid')
  }
  if (state.transport === 'streamable-http' && (
    typeof state.origin !== 'string'
    || typeof state.endpoint !== 'string'
    || typeof state.dataEgressDisclosure !== 'string'
  )) throw new Error('managed MCP HTTP state fields are invalid')
  return state as unknown as McpKindState
}

function viewRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function viewRevision(value: unknown): number {
  const revision = viewRecord(value)?.revision
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new Error('MCP owner view has no revision')
  return revision as number
}

function viewToolGeneration(value: unknown): number | null {
  const generation = viewRecord(viewRecord(value)?.tools)?.generation
  return Number.isSafeInteger(generation) && (generation as number) >= 0 ? generation as number : null
}

function exactOwnerToolNames(value: unknown, connectionId: string): readonly string[] {
  const names = viewRecord(viewRecord(value)?.tools)?.names
  const prefix = `mcp__${connectionId}__`
  if (!Array.isArray(names)
    || names.length > 4_096
    || names.some(name => typeof name !== 'string' || name.length > 256 || !name.startsWith(prefix))
    || new Set(names).size !== names.length) {
    throw new Error('MCP owner Tool names are invalid or outside their connection namespace')
  }
  return Object.freeze([...names].sort((left, right) => left.localeCompare(right)))
}

function recordTransport(value: unknown): 'stdio' | 'http' | null {
  const descriptor = viewRecord(value)
  return descriptor?.transport === 'stdio'
    ? 'stdio'
    : descriptor?.transport === 'streamable-http' ? 'http' : null
}

function boundedIdentifier(value: unknown, pattern: RegExp, subject: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || !pattern.test(value)) {
    throw new Error(`${subject} is invalid`)
  }
  return value
}

function canonicalHttpCoordinates(origin: unknown, endpoint: unknown): Readonly<{ origin: string; endpoint: string }> {
  if (typeof origin !== 'string' || typeof endpoint !== 'string') throw new Error('allowlisted MCP HTTP coordinates are invalid')
  let parsedOrigin: URL
  let parsedEndpoint: URL
  try {
    parsedOrigin = new URL(origin)
    parsedEndpoint = new URL(endpoint)
  } catch {
    throw new Error('allowlisted MCP HTTP coordinates are invalid')
  }
  if (parsedOrigin.protocol !== 'https:'
    || parsedEndpoint.protocol !== 'https:'
    || parsedOrigin.username !== '' || parsedOrigin.password !== ''
    || parsedEndpoint.username !== '' || parsedEndpoint.password !== ''
    || parsedOrigin.pathname !== '/' || parsedOrigin.search !== '' || parsedOrigin.hash !== ''
    || parsedEndpoint.hash !== ''
    || parsedOrigin.origin !== origin
    || parsedEndpoint.toString() !== endpoint
    || parsedEndpoint.origin !== origin) {
    throw new Error('allowlisted MCP HTTP origin and endpoint must be canonical credential-free HTTPS coordinates')
  }
  return Object.freeze({ origin, endpoint })
}

function admittedRuntime(value: AdmittedMcpRuntime): AdmittedMcpRuntime {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('MCP runtime allowlist row is invalid')
  const input = value as unknown as Readonly<Record<string, unknown>>
  if (input.transport !== 'stdio' && input.transport !== 'streamable-http') {
    throw new Error('MCP runtime transport is invalid')
  }
  exactKeys(
    input,
    input.transport === 'stdio'
      ? ['candidateRef', 'executablePath', 'executableSha256', 'fixedArgs', 'runtimeRef', 'transport', 'version', 'workingDirectory']
      : ['authentication', 'candidateRef', 'dataEgressDisclosure', 'endpoint', 'origin', 'redirects', 'runtimeRef', 'transport', 'version'],
    'MCP runtime allowlist row',
  )
  const runtimeRef = boundedIdentifier(input.runtimeRef, /^[a-z0-9][a-z0-9._:-]{0,127}$/, 'MCP runtimeRef', 128)
  const candidateRef = boundedIdentifier(input.candidateRef, /^mcp:[A-Za-z0-9@._:/-]{1,240}$/, 'MCP candidateRef', 256)
  const version = boundedIdentifier(input.version, /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/, 'MCP runtime version', 128)
  if (filesystemMcpCandidate(candidateRef, version) === null) {
    throw new Error('MCP runtime candidate and version are not admitted by this build')
  }
  if (input.transport === 'stdio') {
    if (typeof input.executablePath !== 'string' || !isAbsolute(input.executablePath)
      || resolve(input.executablePath) !== input.executablePath
      || typeof input.workingDirectory !== 'string' || !isAbsolute(input.workingDirectory)
      || resolve(input.workingDirectory) !== input.workingDirectory
      || typeof input.executableSha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.executableSha256)
      || !Array.isArray(input.fixedArgs) || input.fixedArgs.length > 64
      || input.fixedArgs.some(argument => typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0'))) {
      throw new Error('allowlisted MCP stdio coordinates are invalid')
    }
    return Object.freeze({
      transport: 'stdio',
      runtimeRef,
      candidateRef,
      version,
      executablePath: input.executablePath,
      executableSha256: input.executableSha256 as `sha256:${string}`,
      fixedArgs: Object.freeze([...input.fixedArgs] as string[]),
      workingDirectory: input.workingDirectory,
    })
  }
  if (input.authentication !== 'none' || input.redirects !== 'forbidden'
    || typeof input.dataEgressDisclosure !== 'string'
    || input.dataEgressDisclosure.length === 0 || input.dataEgressDisclosure.length > 2_048
    || input.dataEgressDisclosure.trim() !== input.dataEgressDisclosure
    || input.dataEgressDisclosure.includes('\0')) {
    throw new Error('allowlisted MCP HTTP policy is invalid')
  }
  const coordinates = canonicalHttpCoordinates(input.origin, input.endpoint)
  return Object.freeze({
    transport: 'streamable-http',
    runtimeRef,
    candidateRef,
    version,
    ...coordinates,
    authentication: 'none',
    redirects: 'forbidden',
    dataEgressDisclosure: input.dataEgressDisclosure,
  })
}

async function verifyRuntime(runtime: AdmittedMcpRuntime, candidateRef: string): Promise<void> {
  if (runtime.candidateRef !== candidateRef) throw new Error('allowlisted MCP runtime is not admitted for this candidate')
  if (runtime.transport === 'streamable-http') {
    canonicalHttpCoordinates(runtime.origin, runtime.endpoint)
    return
  }
  const executable = await realpath(runtime.executablePath)
  if (executable !== runtime.executablePath) throw new Error('allowlisted MCP runtime executable is not its canonical real path')
  const cwd = await realpath(runtime.workingDirectory)
  if (cwd !== runtime.workingDirectory) throw new Error('allowlisted MCP runtime working directory is not its canonical real path')
  const cwdInfo = await lstat(cwd)
  if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink()) throw new Error('allowlisted MCP runtime working directory is invalid')
  const handle = await open(executable, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const hash = createHash('sha256')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('allowlisted MCP runtime is not a regular file')
    if (process.platform !== 'win32' && (info.mode & 0o111) === 0) throw new Error('allowlisted MCP runtime is not executable')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
  } finally {
    await handle.close()
  }
  if (`sha256:${hash.digest('hex')}` !== runtime.executableSha256) throw new Error('allowlisted MCP runtime digest changed')
}

function runtimeDescriptorDigest(runtime: AdmittedMcpRuntime): `sha256:${string}` {
  return canonicalSha256(runtime)
}

type McpOwnerMutationPhase =
  | 'configure-create'
  | 'configure-update'
  | 'disable'
  | 'enable'
  | 'purge'
  | 'restore-record'
  | 'restore-disable'
  | 'restore-enable'
  | 'restore-update'
  | 'rollback-configure'
  | 'rollback-disable'
  | 'rollback-enable'
  | 'rollback-new-purge'
  | 'rollback-new-remove'
  | 'rollback-remove'
  | 'rollback-restore'
  | 'rollback-unconfigured-purge'
  | 'rollback-unconfigured-remove'
  | 'rollback-update'
  | 'task-configure'
  | 'task-enable'
  | 'task-rollback-purge'
  | 'task-rollback-remove'
  | 'uninstall-remove'
  | 'update'

function ownerMutationId(
  operationId: string,
  phase: McpOwnerMutationPhase,
  descriptorDigest: `sha256:${string}`,
): string {
  return `mcp:${canonicalSha256({ operationId, phase, descriptorDigest }).slice('sha256:'.length)}`
}

function configurationForRuntime(config: McpConfiguration, runtime: AdmittedMcpRuntime): void {
  if (config.transport !== runtime.transport) throw new Error('MCP configuration transport does not match runtimeRef')
}

function transport(runtime: AdmittedMcpRuntime, config: McpConfiguration): RpcJson {
  configurationForRuntime(config, runtime)
  if (runtime.transport === 'stdio' && config.transport === 'stdio') {
    return {
      transport: 'stdio',
      command: runtime.executablePath,
      args: [...runtime.fixedArgs, ...config.roots],
      env: {},
      cwd: runtime.workingDirectory,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      reconnect: config.reconnect,
    }
  }
  if (runtime.transport !== 'streamable-http' || config.transport !== 'streamable-http') {
    throw new Error('MCP configuration transport does not match runtimeRef')
  }
  return {
    transport: 'streamable-http',
    url: runtime.endpoint,
    headers: {},
    redirect: 'error',
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    reconnect: config.reconnect,
  }
}

function runtimeOption(runtime: AdmittedMcpRuntime): McpRuntimeOption {
  return runtime.transport === 'stdio'
    ? Object.freeze({
        candidateRef: runtime.candidateRef,
        runtimeRef: runtime.runtimeRef,
        version: runtime.version,
        transport: 'stdio',
        executablePath: runtime.executablePath,
        fixedArgs: Object.freeze([...runtime.fixedArgs]),
        workingDirectory: runtime.workingDirectory,
      })
    : Object.freeze({
        candidateRef: runtime.candidateRef,
        runtimeRef: runtime.runtimeRef,
        version: runtime.version,
        transport: 'streamable-http',
        origin: runtime.origin,
        endpoint: runtime.endpoint,
        authentication: 'none',
        redirects: 'forbidden',
        dataEgressDisclosure: runtime.dataEgressDisclosure,
      })
}

function stateFor(runtime: AdmittedMcpRuntime, connectionId: string, configured: boolean): McpKindState {
  const common = {
    connectionId,
    runtimeRef: runtime.runtimeRef,
    runtimeVersion: runtime.version,
    descriptorDigest: runtimeDescriptorDigest(runtime),
    configured,
  }
  return runtime.transport === 'stdio'
    ? Object.freeze({ ...common, transport: 'stdio', executablePath: runtime.executablePath })
    : Object.freeze({
        ...common,
        transport: 'streamable-http',
        origin: runtime.origin,
        endpoint: runtime.endpoint,
        dataEgressDisclosure: runtime.dataEgressDisclosure,
      })
}

function stateMatchesRuntime(
  state: McpKindState,
  runtime: AdmittedMcpRuntime,
  materialPath: string,
  managementRoot: string,
): boolean {
  if (state.runtimeRef !== runtime.runtimeRef
    || state.runtimeVersion !== runtime.version
    || state.descriptorDigest !== runtimeDescriptorDigest(runtime)
    || state.transport !== runtime.transport) return false
  return state.transport === 'stdio' && runtime.transport === 'stdio'
    ? state.executablePath === runtime.executablePath && materialPath === runtime.executablePath
    : state.transport === 'streamable-http' && runtime.transport === 'streamable-http'
      && state.origin === runtime.origin
      && state.endpoint === runtime.endpoint
      && state.dataEgressDisclosure === runtime.dataEgressDisclosure
      && materialPath === managementRoot
}

/** Dynamic MCP lifecycle over one explicit preinstalled runtime allowlist. */
export class McpLifecycleProvider implements LifecycleProvider {
  readonly kind = 'mcp' as const
  private readonly runtimes: ReadonlyMap<string, AdmittedMcpRuntime>

  constructor(
    private readonly store: CenterStateStore,
    private readonly owner: McpConnectionsOwner,
    runtimes: readonly AdmittedMcpRuntime[],
  ) {
    const admitted = runtimes.map(runtime => admittedRuntime(runtime))
    this.runtimes = new Map(admitted.map(runtime => [runtime.runtimeRef, runtime]))
    if (this.runtimes.size !== runtimes.length) throw new Error('MCP runtime allowlist contains duplicate ids')
  }

  async observe(targetKey: string): Promise<ManagedTargetRecord | null> {
    return await this.store.getManaged(targetKey) ?? null
  }

  /** Verify a selected allowlisted runtime and bounded user roots without mutating its owner. */
  async preflight(candidateRef: string, value: RpcJson): Promise<McpRuntimePreflight | null> {
    const config = await configuration(value)
    const runtime = this.runtimes.get(config.runtimeRef)
    if (runtime === undefined) return null
    configurationForRuntime(config, runtime)
    await verifyRuntime(runtime, candidateRef)
    const reviewDescriptor: McpReviewEvidence['descriptor'] = runtime.transport === 'stdio' && config.transport === 'stdio'
      ? Object.freeze({
          transport: 'stdio',
          serverName: config.connectionId,
          executable: runtime.executablePath,
          arguments: Object.freeze([...runtime.fixedArgs, ...config.roots]),
          workingDirectory: runtime.workingDirectory,
          toolCallTimeoutMs: config.toolCallTimeoutMs,
          reconnect: config.reconnect,
        })
      : runtime.transport === 'streamable-http' && config.transport === 'streamable-http'
        ? Object.freeze({
            transport: 'http',
            serverName: config.connectionId,
            origin: runtime.origin,
            endpoint: runtime.endpoint,
            authentication: 'none',
            redirects: 'forbidden',
            dataEgressDisclosure: runtime.dataEgressDisclosure,
            toolCallTimeoutMs: config.toolCallTimeoutMs,
            reconnect: config.reconnect,
          })
        : (() => { throw new Error('MCP configuration transport does not match runtimeRef') })()
    return Object.freeze({
      runtimeRef: runtime.runtimeRef,
      version: runtime.version,
      descriptorDigest: runtimeDescriptorDigest(runtime),
      reviewDescriptor,
      runtimeDigest: runtime.transport === 'stdio' ? runtime.executableSha256 : null,
    })
  }

  /** List currently usable descriptor facts; the browser can submit only the opaque selector. */
  async options(candidateRef: string): Promise<readonly McpRuntimeOption[]> {
    const output: McpRuntimeOption[] = []
    for (const runtime of this.runtimes.values()) {
      if (runtime.candidateRef !== candidateRef) continue
      try {
        await verifyRuntime(runtime, candidateRef)
      } catch {
        continue
      }
      output.push(runtimeOption(runtime))
    }
    return Object.freeze(output.sort((left, right) => left.runtimeRef.localeCompare(right.runtimeRef)))
  }

  /**
   * Compare durable Center state with the exact admitted runtime and current MCP owner record.
   * @param version Managed version whose authority must still match the Host owner.
   * @returns Sanitized owner evidence; descriptor drift never qualifies tools as visible.
   */
  async inspect(version: ManagedVersion): Promise<McpManagedOwnerEvidence> {
    const state = kindState(version)
    const active = viewRecord(this.owner.get(state.connectionId))
    const removed = viewRecord(this.owner.getRemoved(state.connectionId))
    const held = active ?? removed
    const desired = viewRecord(held?.desired)
    const observed = viewRecord(active?.observed)
    const tools = viewRecord(active?.tools)
    const rawNames = Array.isArray(tools?.names)
      ? tools.names.filter((name): name is string => typeof name === 'string').sort()
      : []
    const namesValid = Array.isArray(tools?.names) && tools.names.every(name => typeof name === 'string')
    const revision = Number.isSafeInteger(held?.revision) ? held!.revision as number : null
    const rawTransport = recordTransport(desired?.transport)
    const rawLifecycle = active === undefined
      ? 'absent'
      : observed?.state === 'ready' ? 'ready'
        : observed?.state === 'disabled' ? 'disabled'
          : observed?.state === 'connecting' || observed?.state === 'stopping' ? 'starting'
            : observed?.state === 'error' ? 'degraded' : 'unknown'
    let descriptorMatches = active === undefined && removed === undefined && !state.configured
    if (state.configured && held !== undefined && (active === undefined) !== (removed === undefined)) {
      try {
        const config = await configuration(version.configuration)
        const runtime = this.runtimes.get(state.runtimeRef)
        if (runtime !== undefined) {
          await verifyRuntime(runtime, version.candidateRef)
          const expectedTransport = transport(runtime, config)
          descriptorMatches = config.runtimeRef === runtime.runtimeRef
            && stateMatchesRuntime(state, runtime, version.materialPath, this.store.root)
            && desired?.id === state.connectionId
            && desired.enabled === version.enabled
            && canonicalSha256(desired.transport ?? null) === canonicalSha256(expectedTransport)
            && revision !== null
          if (active !== undefined) {
            descriptorMatches = descriptorMatches
              && version.ownerRevision === `mcp:${String(revision)}`
              && observed?.desiredRevision === revision
          }
        }
      } catch {
        descriptorMatches = false
      }
    }
    const toolGeneration = Number.isSafeInteger(tools?.generation) ? tools!.generation as number : null
    const runtimeEvidenceMatches = rawLifecycle === 'ready'
      ? desired?.enabled === true
        && toolGeneration !== null
        && typeof tools?.digest === 'string'
        && namesValid
        && rawNames.length > 0
      : rawLifecycle === 'disabled'
        ? desired?.enabled === false && namesValid && rawNames.length === 0
        : true
    const exact = descriptorMatches && runtimeEvidenceMatches
    return Object.freeze({
      descriptorMatches: exact,
      descriptorDigest: exact ? state.descriptorDigest : null,
      descriptorRevision: revision === null ? null : String(revision),
      transport: rawTransport,
      desiredEnabled: desired?.enabled === true,
      observedLifecycle: exact ? rawLifecycle : 'degraded',
      liveDetailAvailable: held !== undefined,
      toolGeneration: exact ? toolGeneration : null,
      qualifiedTools: Object.freeze(exact ? rawNames : []),
    })
  }

  async prepare(request: ProviderOperationRequest): Promise<PreparedProviderOperation> {
    if (request.artifactPath !== null) throw new Error('MCP lifecycle must not download or execute catalog package artifacts')
    const before = await this.observe(request.plan.targetKey)
    const config = await configuration(request.payload.configuration)
    const runtime = this.runtimes.get(config.runtimeRef)
    if (runtime === undefined) throw new Error('MCP runtimeRef is not in the Host allowlist')
    configurationForRuntime(config, runtime)
    await verifyRuntime(runtime, request.plan.candidateRef)
    const review = request.plan.reviewEvidence
    if (review.kind !== 'mcp') throw new Error('MCP plan has no MCP review evidence')
    const descriptor: McpReviewEvidence['descriptor'] = runtime.transport === 'stdio' && config.transport === 'stdio'
      ? {
          transport: 'stdio', serverName: config.connectionId, executable: runtime.executablePath,
          arguments: [...runtime.fixedArgs, ...config.roots], workingDirectory: runtime.workingDirectory,
          toolCallTimeoutMs: config.toolCallTimeoutMs, reconnect: config.reconnect,
        }
      : runtime.transport === 'streamable-http' && config.transport === 'streamable-http'
        ? {
            transport: 'http', serverName: config.connectionId, origin: runtime.origin, endpoint: runtime.endpoint,
            authentication: 'none', redirects: 'forbidden', dataEgressDisclosure: runtime.dataEgressDisclosure,
            toolCallTimeoutMs: config.toolCallTimeoutMs, reconnect: config.reconnect,
          }
        : (() => { throw new Error('MCP configuration transport does not match runtimeRef') })()
    if (canonicalSha256(descriptor) !== canonicalSha256(review.descriptor)
      || review.credentials !== 'none'
      || review.runtime.version !== runtime.version
      || review.runtime.digest !== (runtime.transport === 'stdio' ? runtime.executableSha256 : null)) {
      throw new Error('MCP runtime or descriptor does not match the immutable review evidence')
    }
    const descriptorDigest = runtimeDescriptorDigest(runtime)
    if (request.plan.managedObject !== 'connection'
      || request.plan.externalRuntimeAction !== 'none'
      || request.plan.runtimeBinding?.runtimeRef !== runtime.runtimeRef
      || request.plan.runtimeBinding.version !== runtime.version
      || request.plan.runtimeBinding.descriptorDigest !== descriptorDigest) {
      throw new Error('MCP plan does not bind the exact preprovisioned runtime connection')
    }
    const scopeRevision = canonicalSha256({
      scopeKey: request.plan.scopeKey,
      profileId: request.plan.profileId,
      configuration: request.payload.configuration,
      runtimeDescriptorDigest: descriptorDigest,
    })
    if (scopeRevision !== request.plan.fences.scopeRevision) {
      throw new Error('MCP allowlist descriptor or configuration changed after plan approval')
    }
    if (before?.current !== null && before?.current !== undefined
      && request.plan.operationKind === 'configure'
      && kindState(before.current).connectionId !== config.connectionId) {
      throw new Error('MCP connectionId cannot change during configure')
    }
    const ownerConnectionId = before?.current !== null && before?.current !== undefined
      ? kindState(before.current).connectionId
      : before?.removed !== null && before?.removed !== undefined
        ? kindState(before.removed).connectionId
        : config.connectionId
    const ownerActive = this.owner.get(ownerConnectionId)
    const ownerRemoved = this.owner.getRemoved(ownerConnectionId)
    if (ownerActive !== undefined && ownerRemoved !== undefined) throw new Error('MCP owner exposes contradictory active and removed records')
    const ownerSnapshotRevision = this.owner.snapshot().revision
    const boundOwnerRevision = ownerActive !== undefined
      ? viewRevision(ownerActive)
      : ownerRemoved !== undefined ? viewRevision(ownerRemoved) : ownerSnapshotRevision
    if (request.plan.fences.ownerRevision !== `mcp:${String(boundOwnerRevision)}`) {
      throw new Error('MCP owner revision changed after plan approval')
    }
    let ownerToolNames: readonly string[] = Object.freeze([])
    if (request.plan.operationKind === 'uninstall' || request.plan.operationKind === 'purge') {
      const expectedNames = ownerActive === undefined
        ? Object.freeze([] as string[])
        : exactOwnerToolNames(ownerActive, ownerConnectionId)
      const registeredNames = this.owner.registeredToolNames(ownerConnectionId, expectedNames)
      if (expectedNames.some(name => !registeredNames.includes(name))) {
        throw new Error('MCP owner Tool registry changed after plan approval')
      }
      ownerToolNames = Object.freeze([...new Set([...expectedNames, ...registeredNames])]
        .sort((left, right) => left.localeCompare(right)))
    }
    const prior = before?.current ?? before?.removed
    if (prior !== null && prior !== undefined && kindState(prior).configured) {
      const priorState = kindState(prior)
      const priorRuntime = this.runtimes.get(priorState.runtimeRef)
      if (priorRuntime === undefined) throw new Error('managed MCP runtime is no longer allowlisted')
      await verifyRuntime(priorRuntime, prior.candidateRef)
      const expectedTransport = transport(priorRuntime, await configuration(prior.configuration))
      const held = viewRecord(ownerActive ?? ownerRemoved)
      const desired = viewRecord(held?.desired)
      if (held === undefined
        || !stateMatchesRuntime(priorState, priorRuntime, prior.materialPath, this.store.root)
        || desired?.id !== priorState.connectionId
        || desired.enabled !== prior.enabled
        || canonicalSha256(desired.transport ?? null) !== canonicalSha256(expectedTransport)) {
        throw new Error('MCP owner descriptor changed after plan approval')
      }
    } else if (ownerActive !== undefined || ownerRemoved !== undefined) {
      throw new Error('unconfigured MCP target conflicts with an existing owner descriptor')
    }
    return Object.freeze({
      request,
      before,
      beforeDigest: managedStateDigest(before),
      stagingPath: null,
      prepared: Object.freeze({
        configuration: config,
        runtime,
        ownerActiveRevision: ownerActive === undefined ? null : viewRevision(ownerActive),
        ownerRemovedRevision: ownerRemoved === undefined ? null : viewRevision(ownerRemoved),
        ownerToolGeneration: viewToolGeneration(ownerActive),
        ownerToolNames,
      } satisfies PreparedMcp),
    })
  }

  recoveryPoint(prepared: PreparedProviderOperation): RpcJson {
    const detail = prepared.prepared as PreparedMcp
    return immutableJsonClone({
      kind: 'mcp',
      configuration: detail.configuration,
      runtime: detail.runtime,
      ownerActiveRevision: detail.ownerActiveRevision,
      ownerRemovedRevision: detail.ownerRemovedRevision,
      ownerToolGeneration: detail.ownerToolGeneration,
      ownerToolNames: detail.ownerToolNames,
    }) as unknown as RpcJson
  }

  async apply(prepared: PreparedProviderOperation): Promise<AppliedProviderOperation> {
    const detail = prepared.prepared as PreparedMcp
    const { request } = prepared
    let supplied: ManagedVersion | null = null
    if (request.plan.operationKind === 'install' || request.plan.operationKind === 'update') {
      supplied = immutableJsonClone({
        candidateRef: request.plan.candidateRef,
        artifactRevision: request.plan.artifactRevision,
        artifactIntegrity: request.plan.artifactIntegrity,
        materialPath: detail.runtime.transport === 'stdio' ? detail.runtime.executablePath : this.store.root,
        configuration: request.payload.configuration,
        enabled: request.plan.desiredState === 'enabled',
        ownerRevision: request.plan.fences.ownerRevision,
        kindState: stateFor(detail.runtime, detail.configuration.connectionId, false),
      }) as unknown as ManagedVersion
    }
    let after = nextManagedRecord(prepared.before, request, supplied, Date.now())
    if (request.plan.operationKind === 'configure' && after.current !== null) {
      const priorState = kindState(after.current)
      after = immutableJsonClone({
        ...after,
        current: {
          ...after.current,
          materialPath: detail.runtime.transport === 'stdio' ? detail.runtime.executablePath : this.store.root,
          kindState: stateFor(detail.runtime, detail.configuration.connectionId, priorState.configured),
        },
      }) as unknown as ManagedTargetRecord
    }
    after = await this.mutateOwner(
      after,
      prepared.before,
      detail,
      request.plan.operationKind,
      request.plan.origin,
      request.authorization.operationId,
    )
    await this.store.putManaged(after, prepared.before?.revision ?? 0)
    return Object.freeze({
      prepared,
      mutationDigest: canonicalSha256({ operationId: request.authorization.operationId, after: managedStateDigest(after) }),
      afterDigest: managedStateDigest(after),
      restartRequired: false,
      restartToken: null,
      rollbackRestartRequired: false,
    })
  }

  async verify(applied: AppliedProviderOperation): Promise<ProviderVerification | null> {
    const stored = await this.store.getManaged(applied.prepared.request.plan.targetKey)
    const operation = applied.prepared.request.plan.operationKind
    if (operation === 'uninstall' || operation === 'purge') {
      const prior = operation === 'purge'
        ? applied.prepared.before?.removed ?? applied.prepared.before?.lastGood
        : applied.prepared.before?.current
      if (prior !== null && prior !== undefined) {
        const connectionId = kindState(prior).connectionId
        if (this.owner.get(connectionId) !== undefined
          || operation === 'purge' && this.owner.getRemoved(connectionId) !== undefined) {
          throw new Error('removed MCP connection remains active')
        }
        const detail = applied.prepared.prepared as PreparedMcp | null
        if (detail === null) throw new Error('official Tool registry cannot prove MCP teardown')
        const residual = this.owner.registeredToolNames(connectionId, detail.ownerToolNames)
        if (residual.length > 0) throw new Error('removed MCP connection still exposes Tool registry entries')
        return Object.freeze({
          digest: canonicalSha256({
            connection: null,
            connectionId,
            removedToolNames: detail.ownerToolNames,
            ownerRevision: this.owner.snapshot().revision,
          }),
        })
      }
      return Object.freeze({ digest: canonicalSha256({ connection: null, ownerRevision: this.owner.snapshot().revision }) })
    }
    const current = stored?.current
    if (current === null || current === undefined) throw new Error('managed MCP has no current runtime precondition')
    const state = kindState(current)
    if (!state.configured) return Object.freeze({ digest: canonicalSha256({ descriptor: state.descriptorDigest, configured: false }) })
    const view = viewRecord(this.owner.get(state.connectionId))
    if (view === undefined) throw new Error('configured MCP is absent from its owner')
    const desired = viewRecord(view.desired)
    const observed = viewRecord(view.observed)
    const tools = viewRecord(view.tools)
    const names = tools?.names
    const revision = viewRevision(view)
    const runtime = this.runtimes.get(state.runtimeRef)
    if (runtime === undefined) throw new Error('configured MCP runtime is no longer allowlisted')
    await verifyRuntime(runtime, current.candidateRef)
    const expectedTransport = transport(runtime, await configuration(current.configuration))
    if (!stateMatchesRuntime(state, runtime, current.materialPath, this.store.root)
      || desired?.id !== state.connectionId
      || desired.enabled !== current.enabled
      || canonicalSha256(desired.transport ?? null) !== canonicalSha256(expectedTransport)
      || observed?.desiredRevision !== revision) {
      throw new Error('configured MCP desired descriptor does not match the approved connection')
    }
    if (current.enabled) {
      if (
        desired?.enabled !== true
        || observed?.state !== 'ready'
        || !Number.isSafeInteger(tools?.generation)
        || typeof tools?.digest !== 'string'
        || !Array.isArray(names)
        || names.length === 0
        || !names.every(name => typeof name === 'string')
      ) throw new Error('enabled MCP lacks ready tool-generation evidence')
      const detail = applied.prepared.prepared as PreparedMcp | null
      if (detail !== null && detail.ownerToolGeneration !== null) {
        if ((tools!.generation as number) < detail.ownerToolGeneration) {
          throw new Error('enabled MCP tool generation regressed from the approved owner view')
        }
        if (operation === 'enable' && (tools!.generation as number) === detail.ownerToolGeneration) {
          throw new Error('enabled MCP tool generation did not advance from the approved owner view')
        }
      }
    } else if (desired?.enabled !== false || observed?.state !== 'disabled' || !Array.isArray(names) || names.length !== 0) {
      throw new Error('disabled MCP still exposes live tools')
    }
    return Object.freeze({ digest: canonicalSha256({ desired, observed, tools }) })
  }

  async rollback(applied: AppliedProviderOperation) {
    const current = await this.store.getManaged(applied.prepared.request.plan.targetKey)
    if (current === undefined) throw new Error('managed MCP disappeared before rollback')
    const before = applied.prepared.before
    if (before === null) {
      const created = current.current
      if (created !== null) {
        const state = kindState(created)
        const descriptorDigest = state.descriptorDigest
        const live = this.owner.get(state.connectionId)
        if (live !== undefined) {
          await this.owner.remove({
            id: state.connectionId,
            mutationId: ownerMutationId(
              applied.prepared.request.authorization.operationId,
              'rollback-new-remove',
              descriptorDigest,
            ),
            expectedRevision: viewRevision(live),
          })
        }
        const removed = this.owner.getRemoved(state.connectionId)
        if (removed !== undefined) {
          await this.owner.purge({
            id: state.connectionId,
            mutationId: ownerMutationId(
              applied.prepared.request.authorization.operationId,
              'rollback-new-purge',
              descriptorDigest,
            ),
            expectedRevision: viewRevision(removed),
          })
        }
      }
      await this.store.deleteManaged(current.targetKey, current.revision)
    } else {
      await this.restoreOwner(before, applied.prepared.request.authorization.operationId)
      await this.store.putManaged(immutableJsonClone({
        ...before,
        revision: current.revision + 1,
        lastOperationId: applied.prepared.request.authorization.operationId,
        updatedAtMs: Date.now(),
      }) as ManagedTargetRecord, current.revision)
    }
    return applied.prepared.beforeDigest
  }

  async recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation | null> {
    const snapshot = await this.store.getProviderSnapshot(request.authorization.operationId)
    if (snapshot === undefined || snapshot.targetKey !== request.plan.targetKey
      || snapshot.beforeDigest !== managedStateDigest(snapshot.before)) throw new Error('MCP recovery snapshot is absent or corrupt')
    const point = record(snapshot.recoveryPoint)
    if (point.kind !== 'mcp'
      || !Number.isSafeInteger(point.ownerActiveRevision) && point.ownerActiveRevision !== null
      || !Number.isSafeInteger(point.ownerRemovedRevision) && point.ownerRemovedRevision !== null
      || !Number.isSafeInteger(point.ownerToolGeneration) && point.ownerToolGeneration !== null
      || !Array.isArray(point.ownerToolNames)
      || point.ownerToolNames.length > 4_096
      || point.ownerToolNames.some(name => typeof name !== 'string' || name.length > 256)) {
      throw new Error('MCP recovery point is invalid')
    }
    const config = await configuration(point.configuration as RpcJson)
    const requestedConfiguration = await configuration(request.payload.configuration)
    const runtimeValue = record(point.runtime as RpcJson)
    const runtime = this.runtimes.get(config.runtimeRef)
    if (runtime === undefined
      || request.plan.runtimeBinding?.runtimeRef !== runtime.runtimeRef
      || request.plan.runtimeBinding.version !== runtime.version
      || request.plan.runtimeBinding.descriptorDigest !== runtimeDescriptorDigest(runtime)
      || canonicalSha256(config) !== canonicalSha256(requestedConfiguration)
      || canonicalSha256(runtime) !== canonicalSha256(runtimeValue)
      || canonicalSha256({
        scopeKey: request.plan.scopeKey,
        profileId: request.plan.profileId,
        configuration: request.payload.configuration,
        runtimeDescriptorDigest: runtimeDescriptorDigest(runtime),
      }) !== request.plan.fences.scopeRevision) {
      throw new Error('MCP recovery runtime no longer matches the immutable plan')
    }
    configurationForRuntime(config, runtime)
    await verifyRuntime(runtime, request.plan.candidateRef)
    const ownerToolNames = Object.freeze((point.ownerToolNames as string[]).map(name => {
      if (!name.startsWith(`mcp__${config.connectionId}__`)) throw new Error('MCP recovery Tool name is outside its connection namespace')
      return name
    }).sort((left, right) => left.localeCompare(right)))
    if (new Set(ownerToolNames).size !== ownerToolNames.length) throw new Error('MCP recovery Tool names contain duplicates')
    const prepared: PreparedProviderOperation = {
      request,
      before: snapshot.before,
      beforeDigest: snapshot.beforeDigest as `sha256:${string}`,
      stagingPath: null,
      prepared: Object.freeze({
        configuration: config,
        runtime,
        ownerActiveRevision: point.ownerActiveRevision as number | null,
        ownerRemovedRevision: point.ownerRemovedRevision as number | null,
        ownerToolGeneration: point.ownerToolGeneration as number | null,
        ownerToolNames,
      } satisfies PreparedMcp),
    }
    const current = await this.store.getManaged(request.plan.targetKey)
    if (current?.lastOperationId === request.authorization.operationId) {
      return Object.freeze({
        prepared,
        mutationDigest: canonicalSha256({ operationId: request.authorization.operationId, after: managedStateDigest(current) }),
        afterDigest: managedStateDigest(current),
        restartRequired: false,
        restartToken: null,
        rollbackRestartRequired: false,
      })
    }
    if (managedStateDigest(current ?? null) !== snapshot.beforeDigest) {
      throw new Error('MCP center state diverged after its owner mutation')
    }
    return await this.apply(prepared)
  }

  cleanup(): Promise<void> {
    return Promise.resolve()
  }

  private async mutateOwner(
    value: ManagedTargetRecord,
    before: ManagedTargetRecord | null,
    detail: PreparedMcp,
    operation: ProviderOperationRequest['plan']['operationKind'],
    origin: ProviderOperationRequest['plan']['origin'],
    operationId: string,
  ): Promise<ManagedTargetRecord> {
    let current = value.current
    let receipt: unknown
    let targetRuntime = detail.runtime
    let targetConfiguration = detail.configuration
    if (operation === 'restore') {
      if (current === null) throw new Error('MCP restore has no retained target')
      const state = kindState(current)
      const retainedRuntime = this.runtimes.get(state.runtimeRef)
      if (retainedRuntime === undefined) throw new Error('retained MCP runtime is no longer allowlisted')
      const retainedConfiguration = await configuration(current.configuration)
      configurationForRuntime(retainedConfiguration, retainedRuntime)
      await verifyRuntime(retainedRuntime, current.candidateRef)
      if (runtimeDescriptorDigest(retainedRuntime) !== runtimeDescriptorDigest(detail.runtime)
        || canonicalSha256(retainedConfiguration) !== canonicalSha256(detail.configuration)) {
        throw new Error('prepared MCP restore target does not match retained state')
      }
      targetRuntime = retainedRuntime
      targetConfiguration = retainedConfiguration
    }
    const descriptorDigest = runtimeDescriptorDigest(targetRuntime)
    const mutationId = (phase: McpOwnerMutationPhase): string => ownerMutationId(operationId, phase, descriptorDigest)
    if (operation === 'purge') {
      const prior = before?.removed ?? before?.lastGood
      if (prior !== null && prior !== undefined) {
        const state = kindState(prior)
        if (detail.ownerRemovedRevision !== null) {
          await this.owner.purge({
            id: state.connectionId,
            mutationId: mutationId('purge'),
            expectedRevision: detail.ownerRemovedRevision,
          })
        }
      }
      return value
    }
    if (operation === 'install') {
      if (current === null) throw new Error('MCP install did not retain its exact runtime precondition')
      const state = kindState(current)
      try {
        receipt = await this.owner.configure({
          desired: { id: state.connectionId, enabled: false, transport: transport(targetRuntime, targetConfiguration) },
          mutationId: mutationId(origin === 'task' ? 'task-configure' : 'configure-create'),
          expectedRevision: 0,
        })
        let live = this.owner.get(state.connectionId)
        if (live === undefined) throw new Error('MCP configure did not publish a desired record')
        const configuredRevision = viewRecord(receipt)?.revision
        if (!Number.isSafeInteger(configuredRevision)) throw new Error('MCP configure receipt has no exact revision')
        if (origin === 'task') {
          receipt = await this.owner.enable({
            id: state.connectionId,
            mutationId: mutationId('task-enable'),
            expectedRevision: configuredRevision,
          })
          live = this.owner.get(state.connectionId)
          if (live === undefined) throw new Error('MCP enable removed its desired record')
        }
      } catch (error: unknown) {
        const live = this.owner.get(state.connectionId)
        if (live !== undefined) {
          await this.owner.remove({
            id: state.connectionId,
            mutationId: mutationId('task-rollback-remove'),
            expectedRevision: viewRevision(live),
          })
        }
        const removed = this.owner.getRemoved(state.connectionId)
        if (removed !== undefined) {
          await this.owner.purge({
            id: state.connectionId,
            mutationId: mutationId('task-rollback-purge'),
            expectedRevision: viewRevision(removed),
          })
        }
        throw error
      }
      const receiptRevision = viewRecord(receipt)?.revision
      current = immutableJsonClone({
        ...current,
        enabled: origin === 'task',
        ownerRevision: Number.isSafeInteger(receiptRevision) ? `mcp:${String(receiptRevision)}` : current.ownerRevision,
        kindState: { ...state, configured: true },
      }) as ManagedVersion
      return immutableJsonClone({ ...value, current }) as ManagedTargetRecord
    }
    if (operation === 'uninstall') {
      const prior = before?.current
      if (prior === null || prior === undefined) throw new Error('MCP uninstall has no current descriptor')
      const removed = value.removed
      if (removed === null) throw new Error('MCP uninstall did not retain its removed descriptor')
      const state = kindState(prior)
      let removedRevision = this.owner.snapshot().revision
      if (detail.ownerActiveRevision !== null) {
        receipt = await this.owner.remove({
          id: state.connectionId,
          mutationId: mutationId('uninstall-remove'),
          expectedRevision: detail.ownerActiveRevision,
        })
        const receiptRevision = viewRecord(receipt)?.revision
        if (!Number.isSafeInteger(receiptRevision) || (receiptRevision as number) < 0) {
          throw new Error('MCP remove receipt has no exact revision')
        }
        const ownerRemoved = this.owner.getRemoved(state.connectionId)
        if (ownerRemoved === undefined || viewRevision(ownerRemoved) !== receiptRevision) {
          throw new Error('MCP remove receipt does not match its removed owner record')
        }
        removedRevision = receiptRevision as number
      }
      return immutableJsonClone({
        ...value,
        removed: { ...removed, ownerRevision: `mcp:${String(removedRevision)}` },
      }) as unknown as ManagedTargetRecord
    }
    if (current !== null) {
      const state = kindState(current)
      let live = this.owner.get(state.connectionId)
      let activeRevision = detail.ownerActiveRevision
      if (operation === 'restore' && detail.ownerRemovedRevision !== null) {
        receipt = await this.owner.restore({
          id: state.connectionId,
          mutationId: mutationId('restore-record'),
          expectedRevision: detail.ownerRemovedRevision,
        })
        const restoredRevision = viewRecord(receipt)?.revision
        activeRevision = Number.isSafeInteger(restoredRevision) ? restoredRevision as number : null
        live = this.owner.get(state.connectionId)
      }
      if (operation === 'configure') {
        receipt = detail.ownerActiveRevision === null
          ? await this.owner.configure({
            desired: { id: state.connectionId, enabled: current.enabled, transport: transport(targetRuntime, targetConfiguration) },
            mutationId: mutationId('configure-create'),
            expectedRevision: 0,
          })
          : await this.owner.update({
            id: state.connectionId,
            mutationId: mutationId('configure-update'),
            expectedRevision: detail.ownerActiveRevision,
            transport: transport(targetRuntime, targetConfiguration),
          })
        live = this.owner.get(state.connectionId)
      } else if (operation === 'update' || operation === 'restore') {
        if (activeRevision === null) throw new Error(`MCP ${operation} requires an existing or recoverable owner descriptor`)
        receipt = await this.owner.update({
          id: state.connectionId,
          mutationId: mutationId(operation === 'restore' ? 'restore-update' : 'update'),
          expectedRevision: activeRevision,
          transport: transport(targetRuntime, targetConfiguration),
        })
        live = this.owner.get(state.connectionId)
        if (operation === 'restore') {
          if (live === undefined) throw new Error('MCP restore update removed its desired record')
          const liveDesired = viewRecord(viewRecord(live)?.desired)
          if (liveDesired?.enabled !== current.enabled) {
            receipt = current.enabled
              ? await this.owner.enable({
                  id: state.connectionId,
                  mutationId: mutationId('restore-enable'),
                  expectedRevision: viewRevision(live),
                })
              : await this.owner.disable({
                  id: state.connectionId,
                  mutationId: mutationId('restore-disable'),
                  expectedRevision: viewRevision(live),
                })
            live = this.owner.get(state.connectionId)
          }
        }
      }
      if (operation === 'enable' || operation === 'disable') {
        if (live === undefined || !kindState(before!.current!).configured) {
          throw new Error(`MCP ${operation} requires a configured owner descriptor`)
        }
        receipt = operation === 'enable'
          ? await this.owner.enable({
              id: state.connectionId,
              mutationId: mutationId('enable'),
              expectedRevision: detail.ownerActiveRevision!,
            })
          : await this.owner.disable({
              id: state.connectionId,
              mutationId: mutationId('disable'),
              expectedRevision: detail.ownerActiveRevision!,
            })
        live = this.owner.get(state.connectionId)
      }
      const configured = this.owner.get(state.connectionId) !== undefined
      const receiptRevision = viewRecord(receipt)?.revision
      current = immutableJsonClone({
        ...current,
        ownerRevision: Number.isSafeInteger(receiptRevision) ? `mcp:${String(receiptRevision)}` : current.ownerRevision,
        kindState: { ...state, configured },
      }) as ManagedVersion
    }
    return immutableJsonClone({ ...value, current }) as ManagedTargetRecord
  }

  private async restoreOwner(before: ManagedTargetRecord | null, operationId: string): Promise<void> {
    const desired = before?.current ?? before?.removed
    if (desired === null || desired === undefined) return
    const state = kindState(desired)
    if (!state.configured) {
      const descriptorDigest = state.descriptorDigest
      const live = this.owner.get(state.connectionId)
      if (live !== undefined) {
        await this.owner.remove({
          id: state.connectionId,
          mutationId: ownerMutationId(operationId, 'rollback-unconfigured-remove', descriptorDigest),
          expectedRevision: viewRevision(live),
        })
      }
      const removed = this.owner.getRemoved(state.connectionId)
      if (removed !== undefined) {
        await this.owner.purge({
          id: state.connectionId,
          mutationId: ownerMutationId(operationId, 'rollback-unconfigured-purge', descriptorDigest),
          expectedRevision: viewRevision(removed),
        })
      }
      return
    }
    const config = await configuration(desired.configuration)
    const runtime = this.runtimes.get(state.runtimeRef)
    if (runtime === undefined) throw new Error('rollback runtime is no longer admitted')
    await verifyRuntime(runtime, desired.candidateRef)
    if (runtimeDescriptorDigest(runtime) !== state.descriptorDigest) {
      throw new Error('rollback runtime descriptor no longer matches durable state')
    }
    const desiredTransport = transport(runtime, config)
    const descriptorDigest = state.descriptorDigest
    const mutationId = (phase: McpOwnerMutationPhase): string => ownerMutationId(operationId, phase, descriptorDigest)
    let live = this.owner.get(state.connectionId)
    let removed = this.owner.getRemoved(state.connectionId)
    if (live === undefined) {
      if (removed !== undefined) {
        const heldDesired = viewRecord(viewRecord(removed)?.desired)
        const alreadyRemoved = before?.current === null
          && heldDesired?.enabled === desired.enabled
          && canonicalSha256(heldDesired?.transport ?? null) === canonicalSha256(desiredTransport)
        if (alreadyRemoved) return
        await this.owner.restore({
          id: state.connectionId,
          mutationId: mutationId('rollback-restore'),
          expectedRevision: viewRevision(removed),
        })
      } else {
        await this.owner.configure({
          desired: { id: state.connectionId, enabled: desired.enabled, transport: desiredTransport },
          mutationId: mutationId('rollback-configure'),
          expectedRevision: 0,
        })
      }
      live = this.owner.get(state.connectionId)
    }
    if (live !== undefined) {
      const heldDesired = viewRecord(viewRecord(live)?.desired)
      if (canonicalSha256(heldDesired?.transport ?? null) !== canonicalSha256(desiredTransport)) {
        await this.owner.update({
          id: state.connectionId,
          mutationId: mutationId('rollback-update'),
          expectedRevision: viewRevision(live),
          transport: desiredTransport,
        })
        live = this.owner.get(state.connectionId)
      }
    }
    if (live !== undefined) {
      const desiredState = viewRecord(viewRecord(live)?.desired)?.enabled === true
      if (desired.enabled !== desiredState) {
        const request = {
          id: state.connectionId,
          mutationId: mutationId(desired.enabled ? 'rollback-enable' : 'rollback-disable'),
          expectedRevision: viewRevision(live),
        }
        await (desired.enabled ? this.owner.enable(request) : this.owner.disable(request))
        live = this.owner.get(state.connectionId)
      }
    }
    if (before?.current !== null || live === undefined) return
    await this.owner.remove({
      id: state.connectionId,
      mutationId: mutationId('rollback-remove'),
      expectedRevision: viewRevision(live),
    })
    removed = this.owner.getRemoved(state.connectionId)
    if (removed === undefined) throw new Error('MCP rollback did not restore the removed owner descriptor')
  }
}
