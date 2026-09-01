/** Verified private execution of the official DSH 0.1.2-alpha.3 Plugin CLI. */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { canonicalJson, canonicalSha256 } from '../domain/index.ts'
import {
  captureCurrentProcessIdentity,
  decodeProcessIdentity,
} from '../host/process-identity.ts'
import type { OfficialDshRecoveryBinding } from '../plans/types.ts'
import { isCurrentPnpmExecutionIdentity } from '../plans/pnpm-runtime.ts'
import {
  verifyProfileMetadataCache,
  type ProfileMetadataCacheBinding,
} from './profile-metadata-cache.ts'

const PROFILE_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`
const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_MODULES_METADATA_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 32 * 1024
const SUPERVISOR_CHILD_OUTCOME_BYTES = 4_096
const SUPERVISOR_FALLBACK_MS = 2_000
const PROCESS_GROUP_QUIESCENCE_MS = 5_000
const PROCESS_GROUP_POLL_MS = 10
const PNPM_11_PACKAGE_MANAGER = /^pnpm@11\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
const PROFILE_CONTROLS = [
  '.npmrc', '.pnpmfile.cjs', '.pnpmfile.js', '.pnpmfile.mjs', 'pnpmfile.cjs', 'pnpmfile.js', 'pnpmfile.mjs',
] as const
const MANIFEST_EXECUTION_FIELDS = [
  'scripts', 'pnpm', 'packageManager', 'devEngines', 'workspaces', 'config', 'publishConfig',
] as const

interface ExecutionValue {
  readonly ownerId: string
  readonly parentPid: number
  readonly processGroupPid: number
  readonly profileId: string
  readonly schemaVersion: 1
  readonly startedAtMs: number
  readonly supervisorSha256: string
}

interface ExecutionRecord {
  readonly path: string
  readonly body: string
  readonly value: ExecutionValue
  readonly leaseId: string
}

interface ExecutionDispatchRecord {
  readonly path: string
  readonly body: string
  readonly value: Readonly<{
    readonly schemaVersion: 1
    readonly profileId: string
    readonly ownerId: string
    readonly leaseId: string
    readonly processGroupPid: number
    readonly executionDigest: `sha256:${string}`
    readonly dispatchedAtMs: number
  }>
}

interface SupervisorChildOutcome {
  readonly schemaVersion: 1
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly launchError: boolean
}

function fail(message: string): never {
  throw new Error(message)
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storageKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function appendOutput(held: string, chunk: Buffer): string {
  if (held.length >= MAX_OUTPUT_BYTES) return held
  return (held + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES)
}

function isCompleteSupervisorChildOutcome(bytes: Buffer): boolean {
  return bytes.length > 0 && bytes.length <= SUPERVISOR_CHILD_OUTCOME_BYTES
    && bytes[bytes.length - 1] === 0x0a && bytes.subarray(0, -1).indexOf(0x0a) === -1
    && bytes.indexOf(0x0d) === -1
}

function decodeSupervisorChildOutcome(bytes: Buffer, label: string): SupervisorChildOutcome {
  if (!isCompleteSupervisorChildOutcome(bytes)) {
    fail(`${label} is not one bounded JSON record`)
  }
  const value = bytes.toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(value.slice(0, -1)) as unknown
  } catch (cause) {
    throw new Error(`${label} is not valid JSON`, { cause })
  }
  if (!plain(parsed) || Object.keys(parsed).sort().join(',') !== 'code,launchError,schemaVersion,signal'
    || parsed.schemaVersion !== 1 || typeof parsed.launchError !== 'boolean'
    || !(parsed.code === null || typeof parsed.code === 'number' && Number.isSafeInteger(parsed.code)
      && parsed.code >= 0 && parsed.code <= 255)
    || !(parsed.signal === null || typeof parsed.signal === 'string' && /^[A-Z0-9]+$/u.test(parsed.signal))
    || (parsed.code === null) === (parsed.signal === null)) {
    fail(`${label} fields are invalid`)
  }
  return Object.freeze(parsed as unknown as SupervisorChildOutcome)
}

async function readRegular(path: string, label: string, maximumBytes = MAX_FILE_BYTES): Promise<Buffer> {
  if (!isAbsolute(path) || constants.O_NOFOLLOW === undefined) fail(`${label} cannot be read without following links`)
  if (await realpath(path) !== path) fail(`${label} path is not canonical`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size < 0 || opened.size > maximumBytes) fail(`${label} is not a bounded regular file`)
    const bytes = await handle.readFile()
    const current = await lstat(path)
    if (bytes.length !== opened.size || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
      fail(`${label} changed while it was read`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function hashTree(
  root: string,
  path: string,
  hash: ReturnType<typeof createHash>,
  ignoreRootNodeModules: boolean,
): Promise<void> {
  const info = await lstat(path)
  const name = relative(root, path).split(sep).join('/') || '.'
  if (info.isSymbolicLink()) {
    hash.update(`link:${name}:${await readlink(path)}\0`)
    return
  }
  if (info.isFile()) {
    if (info.size > 64 * 1024 * 1024) fail(`bound package file exceeds its byte limit: ${name}`)
    hash.update(`file:${name}:${String(info.size)}\0`)
    hash.update(await readFile(path))
    return
  }
  if (!info.isDirectory()) fail(`bound package has an unsupported entry: ${name}`)
  hash.update(`dir:${name}\0`)
  const entries = (await readdir(path, { withFileTypes: true }))
    .filter(entry => !(ignoreRootNodeModules && path === root && entry.name === 'node_modules'))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) await hashTree(root, join(path, entry.name), hash, ignoreRootNodeModules)
}

async function treeDigest(root: string, ignoreRootNodeModules: boolean): Promise<`sha256:${string}`> {
  const hash = createHash('sha256')
  await hashTree(root, root, hash, ignoreRootNodeModules)
  return `sha256:${hash.digest('hex')}`
}

async function verifyRegularPin(path: string, expected: string, label: string): Promise<void> {
  if (digest(await readRegular(path, label)) !== expected) fail(`${label} hash does not match its pin`)
}

async function verifyPackage(
  root: string,
  packageName: string,
  packageVersion: string,
  expectedTreeDigest: string,
  label: string,
  ignoreRootNodeModules: boolean,
): Promise<void> {
  const canonical = await realpath(root)
  const info = await lstat(root)
  if (canonical !== root || !info.isDirectory() || info.isSymbolicLink()) fail(`${label} root changed`)
  let manifest: unknown
  try {
    manifest = JSON.parse((await readRegular(join(root, 'package.json'), `${label} manifest`, 8 * 1024 * 1024)).toString('utf8'))
  } catch (cause) {
    throw new Error(`${label} manifest is invalid`, { cause })
  }
  if (!plain(manifest) || manifest.name !== packageName || manifest.version !== packageVersion) {
    fail(`${label} identity changed`)
  }
  if (await treeDigest(root, ignoreRootNodeModules) !== expectedTreeDigest) fail(`${label} tree does not match its pin`)
}

async function probeNodeVersion(binding: OfficialDshRecoveryBinding): Promise<void> {
  const output = await new Promise<Readonly<{ code: number | null; stdout: string }>>((accept, reject) => {
    const child = spawn(binding.node.executablePath, ['--version'], {
      cwd: dirname(binding.node.executablePath),
      env: {},
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout = appendOutput(stdout, chunk) })
    child.once('error', reject)
    child.once('close', code => accept(Object.freeze({ code, stdout })))
  })
  if (output.code !== 0 || output.stdout.trim() !== binding.node.version) fail('bound Node executable version changed')
}

/** Verify every executable and package identity in one official execution binding. */
export async function verifyOfficialExecutionBinding(binding: OfficialDshRecoveryBinding): Promise<void> {
  if (process.platform === 'win32') fail('official DSH Plugin mutation and recovery are unsupported on Windows')
  if (!isCurrentPnpmExecutionIdentity(binding.pnpm)) {
    fail('retired private pnpm identity cannot execute official DSH')
  }
  await verifyRegularPin(binding.node.executablePath, binding.node.executableSha256, 'bound Node executable')
  await probeNodeVersion(binding)
  await verifyRegularPin(binding.supervisorPath, binding.supervisorSha256, 'bound official DSH supervisor')
  await verifyRegularPin(binding.pnpm.entrypointPath, binding.pnpm.entrypointSha256, 'private pnpm entrypoint')
  await verifyRegularPin(binding.pnpm.shimPath, binding.pnpm.shimSha256, 'private pnpm shim')
  await verifyRegularPin(binding.pnpm.shellPath, binding.pnpm.shellSha256, 'bound POSIX shell')
  await verifyPackage(
    binding.pnpm.packageRoot,
    binding.pnpm.packageName,
    binding.pnpm.packageVersion,
    binding.pnpm.packageTreeSha256,
    'private pnpm package',
    false,
  )
  await verifyRegularPin(binding.entrypointPath, binding.entrypointSha256, 'official DSH entrypoint')
  await verifyPackage(
    binding.packageRoot,
    binding.packageName,
    binding.packageVersion,
    binding.packageTreeSha256,
    'official DSH package',
    true,
  )
  for (const dependency of binding.productionDependencies) {
    await verifyPackage(
      dependency.packageRoot,
      dependency.packageName,
      dependency.packageVersion,
      dependency.packageTreeSha256,
      `official DSH production dependency ${dependency.packageName}`,
      true,
    )
  }
}

function profileSegment(profileId: string): string {
  if (profileId.length === 0 || profileId.length > 256 || profileId.includes('/') || profileId.includes('\\')
    || profileId.includes(':') || profileId.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(profileId)
    || profileId === '.' || profileId === '..' || profileId === 'node_modules') {
    fail(`official DSH Plugin profile id is unsafe: ${profileId}`)
  }
  return profileId
}

/** Reject Profile-local package-manager execution controls before any mutation starts. */
export async function auditOfficialProfileExecution(binding: OfficialDshRecoveryBinding, profileId: string): Promise<string> {
  if (!isCurrentPnpmExecutionIdentity(binding.pnpm)) {
    fail('retired private pnpm identity cannot execute official DSH')
  }
  const profilePath = join(binding.hostHome, 'profiles', profileSegment(profileId))
  const canonical = await realpath(profilePath)
  const info = await lstat(profilePath)
  if (canonical !== profilePath || !info.isDirectory() || info.isSymbolicLink()) fail('official DSH Profile directory is unsafe')
  for (const name of PROFILE_CONTROLS) {
    try {
      await lstat(join(profilePath, name))
      fail(`official DSH Profile execution control is forbidden: ${name}`)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const workspace = await readRegular(join(profilePath, 'pnpm-workspace.yaml'), 'official DSH Profile workspace', 64 * 1024)
  if (workspace.toString('utf8') !== PROFILE_WORKSPACE) fail('official DSH Profile workspace contains unsupported execution controls')
  let manifest: unknown
  try {
    manifest = JSON.parse((await readRegular(join(profilePath, 'package.json'), 'official DSH Profile manifest', 8 * 1024 * 1024)).toString('utf8'))
  } catch (cause) {
    throw new Error('official DSH Profile manifest is invalid', { cause })
  }
  if (!plain(manifest) || MANIFEST_EXECUTION_FIELDS.some(field => Object.hasOwn(manifest, field))) {
    fail('official DSH Profile manifest contains package-manager execution controls')
  }
  return profilePath
}

async function readInstalledProfileStore(profilePath: string): Promise<string | null> {
  const nodeModulesPath = join(profilePath, 'node_modules')
  let canonicalNodeModules: string
  let nodeModulesInfo: Awaited<ReturnType<typeof lstat>>
  try {
    [canonicalNodeModules, nodeModulesInfo] = await Promise.all([realpath(nodeModulesPath), lstat(nodeModulesPath)])
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (canonicalNodeModules !== nodeModulesPath || !nodeModulesInfo.isDirectory() || nodeModulesInfo.isSymbolicLink()) {
    fail('official DSH Profile node_modules directory is unsafe')
  }
  const metadataPath = join(nodeModulesPath, '.modules.yaml')
  let metadataBytes: Buffer
  try {
    metadataBytes = await readRegular(
      metadataPath,
      'official DSH Profile pnpm modules metadata',
      MAX_MODULES_METADATA_BYTES,
    )
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail('installed official DSH Profile pnpm modules metadata is missing')
    }
    throw error
  }
  let metadata: unknown
  try {
    metadata = JSON.parse(metadataBytes.toString('utf8')) as unknown
  } catch (cause) {
    throw new Error('official DSH Profile pnpm modules metadata is invalid JSON', { cause })
  }
  if (!plain(metadata) || metadata.layoutVersion !== 5 || metadata.nodeLinker !== 'hoisted'
    || metadata.virtualStoreDir !== '.pnpm' || typeof metadata.packageManager !== 'string'
    || !PNPM_11_PACKAGE_MANAGER.test(metadata.packageManager)) {
    fail('official DSH Profile pnpm modules metadata is incompatible with pinned pnpm 11')
  }
  const storeDir = metadata.storeDir
  if (typeof storeDir !== 'string' || storeDir.length === 0 || storeDir.length > 4_096
    || !isAbsolute(storeDir) || /[\u0000-\u001f\u007f]/u.test(storeDir) || !storeDir.endsWith(`${sep}v11`)) {
    fail('official DSH Profile pnpm modules metadata storeDir is unsafe')
  }
  let canonicalStore: string
  let storeInfo: Awaited<ReturnType<typeof lstat>>
  try {
    [canonicalStore, storeInfo] = await Promise.all([realpath(storeDir), lstat(storeDir)])
  } catch (cause) {
    throw new Error('official DSH Profile pnpm modules metadata storeDir is unavailable', { cause })
  }
  if (canonicalStore !== storeDir || !storeInfo.isDirectory() || storeInfo.isSymbolicLink()) {
    fail('official DSH Profile pnpm modules metadata storeDir is not a canonical directory')
  }
  return storeDir
}

async function ensurePrivate(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const canonical = await realpath(path)
  const info = await lstat(path)
  if (canonical !== path || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail(`private official DSH execution directory is unsafe: ${path}`)
  }
}

async function createEnvironment(
  binding: OfficialDshRecoveryBinding,
  metadataCache: ProfileMetadataCacheBinding,
): Promise<Readonly<{
  directory: string
  environment: Readonly<Record<string, string>>
  store: string
  expectedStore: string
  userConfig: string
  globalConfig: string
}>> {
  const directory = join(binding.pnpm.runtimeRoot, `operation-${randomUUID()}`)
  await ensurePrivate(directory)
  const paths = Object.fromEntries(await Promise.all(['config', 'data', 'state', 'tmp'].map(async name => {
    const path = join(directory, name)
    await ensurePrivate(path)
    return [name, path] as const
  }))) as Record<'config' | 'data' | 'state' | 'tmp', string>
  const cache = join(directory, 'cache')
  await cp(metadataCache.cachePath, cache, { recursive: true, force: false, errorOnExist: true })
  const store = metadataCache.storeDir
  const expectedStore = metadataCache.expectedStoreDir
  const userConfig = join(directory, 'user.npmrc')
  const globalConfig = join(directory, 'global.npmrc')
  await writeFile(userConfig, '', { flag: 'wx', mode: 0o600 })
  await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 })
  return Object.freeze({
    directory,
    store,
    expectedStore,
    userConfig,
    globalConfig,
    environment: Object.freeze({
      PATH: dirname(binding.pnpm.shimPath),
      DSH_HOME: binding.hostHome,
      CI: '1',
      NO_COLOR: '1',
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: paths.tmp,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: paths.config,
      XDG_DATA_HOME: paths.data,
      XDG_STATE_HOME: paths.state,
      pnpm_config_userconfig: userConfig,
      pnpm_config_globalconfig: globalConfig,
      pnpm_config_store_dir: store,
      pnpm_config_cache: cache,
      pnpm_config_offline: 'true',
      pnpm_config_ignore_scripts: 'true',
      pnpm_config_ignore_pnpmfile: 'true',
      pnpm_config_auto_install_peers: 'false',
      pnpm_config_package_import_method: 'copy',
      pnpm_config_verify_store_integrity: 'true',
      pnpm_config_strict_store_pkg_content_check: 'true',
      pnpm_config_side_effects_cache: 'false',
      pnpm_config_block_exotic_subdeps: 'true',
      pnpm_config_manage_package_manager_versions: 'false',
    }),
  })
}

function hardenPnpmArguments(
  arguments_: readonly string[],
  runtime: Readonly<{ store: string; userConfig: string; globalConfig: string }>,
): readonly string[] {
  return Object.freeze([
    ...arguments_,
    '--store-dir', runtime.store,
  ])
}

async function readLeaseOwner(binding: OfficialDshRecoveryBinding, profileId: string): Promise<Readonly<{
  path: string
  ownerId: string
  leaseId: string
}>> {
  const path = join(
    binding.hostHome,
    '.extension-center-plugin-coordination',
    'leases',
    storageKey(profileSegment(profileId)),
  )
  let value: unknown
  try {
    value = JSON.parse((await readRegular(join(path, 'owner.json'), 'official DSH Profile lease owner', 64 * 1024)).toString('utf8'))
  } catch (cause) {
    throw new Error('official DSH Profile lease owner is invalid', { cause })
  }
  if (!plain(value) || Object.keys(value).sort().join(',')
      !== 'acquiredAtMs,leaseId,ownerId,processIdentity,profileId,schemaVersion'
    || value.schemaVersion !== 2 || value.profileId !== profileId
    || typeof value.ownerId !== 'string' || value.ownerId.length === 0
    || typeof value.leaseId !== 'string' || !/^lease:[0-9a-f-]{36}$/u.test(value.leaseId)
    || !Number.isSafeInteger(value.acquiredAtMs)) {
    fail('official DSH Profile lease is not owned by this process')
  }
  const identity = decodeProcessIdentity(value.processIdentity, 'official DSH Profile lease')
  const current = await captureCurrentProcessIdentity()
  if (identity.pid !== current.pid || identity.platform !== current.platform
    || identity.machineDigest !== current.machineDigest || identity.bootDigest !== current.bootDigest
    || identity.birthDigest !== current.birthDigest) fail('official DSH Profile lease is not owned by this process')
  return Object.freeze({
    path,
    ownerId: value.ownerId,
    leaseId: value.leaseId,
  })
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function syncDirectorySync(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

async function waitForProcessGroupQuiescence(processGroupPid: number): Promise<boolean> {
  const deadline = performance.now() + PROCESS_GROUP_QUIESCENCE_MS
  for (;;) {
    try {
      process.kill(-processGroupPid, 0)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
    if (performance.now() >= deadline) return false
    await new Promise(resolveDelay => setTimeout(resolveDelay, PROCESS_GROUP_POLL_MS))
  }
}

async function writeExecutionRecord(
  binding: OfficialDshRecoveryBinding,
  profileId: string,
  processGroupPid: number,
): Promise<ExecutionRecord> {
  const owner = await readLeaseOwner(binding, profileId)
  const path = join(owner.path, 'execution.json')
  const value: ExecutionValue = Object.freeze({
    ownerId: owner.ownerId,
    parentPid: process.pid,
    processGroupPid,
    profileId,
    schemaVersion: 1,
    startedAtMs: Date.now(),
    supervisorSha256: binding.supervisorSha256,
  })
  const body = `${canonicalJson(value)}\n`
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(owner.path)
  return Object.freeze({
    path,
    body,
    value,
    leaseId: owner.leaseId,
  })
}

function executionDispatchRecord(record: ExecutionRecord): ExecutionDispatchRecord {
  const value = Object.freeze({
    schemaVersion: 1 as const,
    profileId: record.value.profileId,
    ownerId: record.value.ownerId,
    leaseId: record.leaseId,
    processGroupPid: record.value.processGroupPid,
    executionDigest: canonicalSha256(record.value),
    dispatchedAtMs: Date.now(),
  })
  return Object.freeze({
    path: join(dirname(record.path), 'execution-dispatch.json'),
    body: `${canonicalJson(value)}\n`,
    value,
  })
}

function writeExecutionDispatch(record: ExecutionDispatchRecord): void {
  if (constants.O_NOFOLLOW === undefined) fail('official DSH execution dispatch cannot exclude symlinks')
  const descriptor = openSync(
    record.path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    writeFileSync(descriptor, record.body, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  syncDirectorySync(dirname(record.path))
}

async function clearExecutionFile(
  record: Readonly<{ path: string; body: string }>,
  label: string,
): Promise<void> {
  let body: string
  try {
    body = (await readRegular(record.path, label, 64 * 1024)).toString('utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(`${label} disappeared`)
    throw error
  }
  if (body !== record.body) fail(`${label} changed`)
  await unlink(record.path)
  await syncDirectory(dirname(record.path))
}

async function clearOptionalExecutionFile(
  record: Readonly<{ path: string; body: string }>,
  label: string,
): Promise<void> {
  try {
    await clearExecutionFile(record, label)
  } catch (error: unknown) {
    if (!(error instanceof Error && error.message === `${label} disappeared`)) throw error
  }
}

async function assertExecutionFileAbsent(path: string, label: string): Promise<void> {
  try {
    await readRegular(path, label, 64 * 1024)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  fail(`${label} exists without an exact dispatch attempt`)
}

/** Run one mutation through the pinned supervisor, private pnpm shim, and minimal environment. */
export async function runBoundOfficialDsh(
  binding: OfficialDshRecoveryBinding,
  profileId: string,
  arguments_: readonly string[],
  label: string,
  metadataCache: ProfileMetadataCacheBinding,
): Promise<void> {
  if (arguments_.length === 0 || arguments_.length > 128
    || arguments_.some(argument => argument.length > 16_384 || argument.includes('\0'))) {
    fail('official DSH Plugin arguments are invalid')
  }
  await verifyOfficialExecutionBinding(binding)
  const profilePath = await auditOfficialProfileExecution(binding, profileId)
  const installedStore = await readInstalledProfileStore(profilePath)
  await verifyProfileMetadataCache(binding, metadataCache, false)
  if (metadataCache.profileId !== profileId
    || installedStore !== null && installedStore !== metadataCache.expectedStoreDir) {
    fail('official DSH Plugin metadata cache does not bind the Profile store')
  }
  const runtime = await createEnvironment(binding, metadataCache)
  const hardenedArguments = hardenPnpmArguments(arguments_, runtime)
  const encoded = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    nodePath: binding.node.executablePath,
    entrypointPath: binding.entrypointPath,
    cwd: dirname(binding.entrypointPath),
    timeoutMs: binding.timeoutMs,
    arguments: hardenedArguments,
    environment: runtime.environment,
  }), 'utf8').toString('base64url')
  const durableRecords: {
    execution: ExecutionRecord | null
    dispatch: ExecutionDispatchRecord | null
    dispatchDurable: boolean
  } = { execution: null, dispatch: null, dispatchDurable: false }
  let processGroupQuiescent = false
  try {
    const child = spawn(binding.node.executablePath, [binding.supervisorPath, encoded], {
      cwd: dirname(binding.supervisorPath),
      detached: true,
      env: {},
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const childOutcomeChunks: Buffer[] = []
    let childOutcomeBytes = 0
    let childOutcomeOverflow = false
    let childOutcomeReadError: unknown
    let launchError: unknown
    let fallback: NodeJS.Timeout | null = null
    let timeoutObservation: NodeJS.Timeout | null = null
    let timedOut = false
    let deadlineAtMs: number | null = null
    let outcomeObservedAtMs: number | null = null
    let closeObserved = false
    let exitObserved = false
    let dispatchSettled = false
    let executionWrite: Promise<void> = Promise.resolve()
    let resolveDispatch!: () => void
    let rejectDispatch!: (cause: unknown) => void
    const dispatchPromise = new Promise<void>((accept, reject) => {
      resolveDispatch = () => {
        if (dispatchSettled) return
        dispatchSettled = true
        accept()
      }
      rejectDispatch = cause => {
        if (dispatchSettled) return
        dispatchSettled = true
        reject(cause)
      }
    })
    let resolveClose!: (value: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>) => void
    const closePromise = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(accept => {
      resolveClose = accept
    })
    child.stdout.on('data', (chunk: Buffer) => { stdout = appendOutput(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendOutput(stderr, chunk) })
    child.stdio[3]!.on('data', (chunk: Buffer) => {
      if (childOutcomeOverflow) return
      childOutcomeBytes += chunk.length
      if (childOutcomeBytes > SUPERVISOR_CHILD_OUTCOME_BYTES) {
        childOutcomeOverflow = true
        childOutcomeChunks.length = 0
        return
      }
      childOutcomeChunks.push(Buffer.from(chunk))
      if (outcomeObservedAtMs === null
        && isCompleteSupervisorChildOutcome(Buffer.concat(childOutcomeChunks, childOutcomeBytes))) {
        outcomeObservedAtMs = performance.now()
        if (timeoutObservation !== null) {
          clearTimeout(timeoutObservation)
          timeoutObservation = null
        }
      }
    })
    child.stdio[3]!.once('error', cause => { childOutcomeReadError = cause })
    child.stdin.once('error', cause => {
      rejectDispatch(new Error('official DSH supervisor start dispatch failed', { cause }))
    })
    child.once('error', cause => {
      launchError = cause
      rejectDispatch(new Error(`official DSH Plugin ${label} could not start`, { cause }))
    })
    child.once('spawn', () => {
      const pid = child.pid
      if (pid === undefined) {
        rejectDispatch(new Error('official DSH supervisor has no process id'))
        return
      }
      fallback = setTimeout(() => {
        if (exitObserved) return
        try { process.kill(-pid, 'SIGKILL') } catch { /* supervisor already exited */ }
      }, binding.timeoutMs + SUPERVISOR_FALLBACK_MS)
      fallback.unref()
      executionWrite = writeExecutionRecord(binding, profileId, pid).then(record => {
        durableRecords.execution = record
        if (dispatchSettled || closeObserved) return
        try {
          child.stdin.write('START\n', error => {
            if (dispatchSettled) return
            if (closeObserved) {
              rejectDispatch(new Error('official DSH supervisor closed before its start dispatch became durable'))
              return
            }
            if (error !== undefined && error !== null) {
              rejectDispatch(new Error('official DSH supervisor start dispatch failed', { cause: error }))
              return
            }
            const candidate = executionDispatchRecord(record)
            durableRecords.dispatch = candidate
            try {
              writeExecutionDispatch(candidate)
              durableRecords.dispatchDurable = true
              resolveDispatch()
            } catch (cause: unknown) {
              rejectDispatch(new Error('official DSH supervisor start dispatch could not be recorded', { cause }))
            }
          })
        } catch (cause: unknown) {
          rejectDispatch(new Error('official DSH supervisor start dispatch failed', { cause }))
          return
        }
        const deadline = performance.now() + binding.timeoutMs
        deadlineAtMs = deadline
        timeoutObservation = setTimeout(() => { timedOut = true }, Math.max(0, deadline - performance.now()))
        timeoutObservation.unref()
      }, cause => {
        rejectDispatch(cause)
      })
    })
    child.once('exit', () => {
      exitObserved = true
      if (fallback !== null) {
        clearTimeout(fallback)
        fallback = null
      }
    })
    child.once('close', (code, signal) => {
      closeObserved = true
      if (fallback !== null) {
        clearTimeout(fallback)
        fallback = null
      }
      if (timeoutObservation !== null) {
        clearTimeout(timeoutObservation)
        timeoutObservation = null
      }
      rejectDispatch(new Error('official DSH supervisor closed before its start dispatch became durable'))
      resolveClose(Object.freeze({ code, signal }))
    })
    let dispatchError: unknown
    try {
      await dispatchPromise
    } catch (cause: unknown) {
      dispatchError = cause
      if (!exitObserved) child.stdin.destroy()
    }
    const supervisorClose = await closePromise
    await executionWrite
    const pid = child.pid
    processGroupQuiescent = pid === undefined || await waitForProcessGroupQuiescence(pid)
    if (!processGroupQuiescent) {
      throw new Error('official DSH supervisor process group did not reach quiescence; durable execution fence retained')
    }
    if (dispatchError !== undefined) throw dispatchError
    if (launchError !== undefined) throw new Error(`official DSH Plugin ${label} could not start`, { cause: launchError })
    const deadlineExpired = deadlineAtMs !== null && (timedOut || (outcomeObservedAtMs === null
      ? performance.now() >= deadlineAtMs
      : outcomeObservedAtMs >= deadlineAtMs))
    if (deadlineExpired) {
      throw new Error(`official DSH Plugin ${label} timed out`)
    }
    if (childOutcomeReadError !== undefined) {
      throw new Error('official DSH supervisor child outcome could not be read', { cause: childOutcomeReadError })
    }
    if (childOutcomeOverflow) fail('official DSH supervisor child outcome is not one bounded JSON record')
    if (childOutcomeBytes === 0) {
      if (supervisorClose.code === 125) throw new Error(`official DSH Plugin ${label} lost its parent`)
      throw new Error('official DSH supervisor closed without a child outcome')
    }
    const childOutcome = decodeSupervisorChildOutcome(
      Buffer.concat(childOutcomeChunks, childOutcomeBytes),
      'official DSH supervisor child outcome',
    )
    if (supervisorClose.code !== null || supervisorClose.signal !== 'SIGKILL') {
      fail('official DSH supervisor did not finish through its bound process-group cleanup')
    }
    if (childOutcome.launchError) {
      throw new Error(`official DSH Plugin ${label} could not start`)
    } else if (childOutcome.code === 124) {
      throw new Error(`official DSH Plugin ${label} timed out`)
    } else if (childOutcome.code === 0) {
      // Continue with post-mutation verification only after dispatch and group quiescence are both proven.
    } else {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
        || `exit=${String(childOutcome.code)} signal=${String(childOutcome.signal)}`
      throw new Error(`official DSH Plugin ${label} failed: ${detail}`)
    }
    const auditedProfilePath = await auditOfficialProfileExecution(binding, profileId)
    const observedStore = await readInstalledProfileStore(auditedProfilePath)
    if (observedStore !== null && observedStore !== runtime.expectedStore
      || installedStore !== null && observedStore === null) {
      fail('official DSH Profile pnpm modules metadata storeDir changed during mutation')
    }
    await verifyProfileMetadataCache(binding, metadataCache, false)
    await verifyOfficialExecutionBinding(binding)
  } finally {
    const execution = durableRecords.execution
    const dispatch = durableRecords.dispatch
    if (execution !== null && processGroupQuiescent) {
      if (dispatch === null) {
        await assertExecutionFileAbsent(
          join(dirname(execution.path), 'execution-dispatch.json'),
          'official DSH execution dispatch',
        )
      } else {
        if (durableRecords.dispatchDurable) {
          await clearExecutionFile(dispatch, 'official DSH execution dispatch')
        } else {
          await clearOptionalExecutionFile(dispatch, 'official DSH execution dispatch')
        }
      }
      await clearExecutionFile(execution, 'official DSH execution lease')
    }
    if (execution === null || processGroupQuiescent) {
      const canonical = await realpath(runtime.directory).catch(() => null)
      if (canonical === runtime.directory) await rm(runtime.directory, { recursive: true })
    }
  }
}
