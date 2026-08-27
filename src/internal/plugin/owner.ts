import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { join, posix, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import { canonicalSha256, immutableJsonClone } from '../../domain/index.ts'
import {
  CenterStateStore,
  captureCurrentProcessIdentity,
  decodeProcessIdentity,
  ensurePrivateDirectory,
  inspectProcessIdentity,
  openRegularNoFollow,
  readCanonicalOptional,
  safeChild,
  storageKey,
  syncDirectory,
  writeCanonicalAtomic,
  writeCanonicalExclusive,
  type ManagedTargetRecord,
  type ManagedVersion,
  type ProcessIdentity,
} from '../../host/index.ts'
import { decodeManagedTarget } from '../../host/state-codec.ts'
import { durableUnlink } from '../../host/durable-unlink.ts'
import { inspectNpmArchive, materializeNpmArchive, type NpmPackageInspection } from '../../providers/npm-archive.ts'
import {
  profileMetadataCacheFromRecoveryPoint,
  type ProfileMetadataCacheBinding,
} from '../../recovery/profile-metadata-cache.ts'
import type { RpcJson } from '../../service/rpc-contract.ts'
import {
  OfficialProfileAmbiguityError,
  type ManagedPluginAbsentRollback,
  type ManagedPluginActivation,
  type ManagedPluginBreakGlassRestore,
  type ManagedPluginCommitResult,
  type ManagedPluginCli,
  type ManagedPluginFileEvidence,
  type ManagedPluginLoader,
  type ManagedPluginMaterialMarker,
  type ManagedPluginOwnerOptions,
  type ManagedPluginSidecar,
  type ManagedPluginSnapshot,
} from './types.ts'
import { OfficialDshPluginCli } from './official-cli.ts'

interface ProfileOwnerRecord {
  readonly schemaVersion: 1
  readonly profileId: string
  readonly revision: number
  readonly digest: `sha256:${string}`
}

interface ProfileLockRecord {
  readonly schemaVersion: 2
  readonly profileId: string
  readonly ownerId: string
  readonly leaseId: string
  readonly processIdentity: ProcessIdentity
  readonly acquiredAtMs: number
}

interface ProfileTakeoverRecord {
  readonly schemaVersion: 1
  readonly profileId: string
  readonly sourceLeaseId: string
  readonly sourceOwnerDigest: `sha256:${string}`
  readonly quarantineId: string
  readonly takeoverId: string
  readonly claimantOwnerId: string
  readonly claimantProcessIdentity: ProcessIdentity
  readonly claimedAtMs: number
}

interface ProfileTakeoverEntry {
  readonly path: string
  readonly canonical: boolean
  readonly record: ProfileTakeoverRecord
}

interface ProfileExecutionRecord {
  readonly schemaVersion: 1
  readonly profileId: string
  readonly ownerId: string
  readonly parentPid: number
  readonly processGroupPid: number
  readonly supervisorSha256: `sha256:${string}`
  readonly startedAtMs: number
}

interface ProfileQuarantineRecord {
  readonly schemaVersion: 1
  readonly profileId: string
  readonly packageName: string
  readonly operationId: string | null
  readonly targetKey: string | null
  readonly centerRoot: string
  readonly beforeDigest: `sha256:${string}`
  readonly afterDigest: `sha256:${string}`
  readonly reason: string
  readonly createdAtMs: number
}

interface OfficialProfileObservation {
  readonly manifest: Readonly<Record<string, unknown>>
  readonly manifestDigest: `sha256:${string}`
  readonly lockDigest: `sha256:${string}` | null
  readonly lock: Readonly<Record<string, unknown>> | null
  readonly dependencies: readonly Readonly<{ name: string; spec: string }>[]
  readonly bundles: readonly string[]
  readonly installed: readonly Readonly<{
    targetKey: string
    packageName: string
    treeDigest: `sha256:${string}` | null
  }>[]
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u

function packageSegments(name: string): readonly string[] {
  if (name.length > 214 || !PACKAGE_NAME.test(name) || name === '.' || name === '..') {
    throw new Error(`managed Plugin package name is unsafe: ${name}`)
  }
  return Object.freeze(name.split('/'))
}

function profileSegment(profileId: string): string {
  if (profileId.length === 0 || profileId.length > 256 || profileId.includes('/') || profileId.includes('\\')
    || profileId.includes(':') || profileId.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(profileId)
    || profileId === '.' || profileId === '..' || profileId === 'node_modules') {
    throw new Error(`managed Plugin profile id is unsafe: ${profileId}`)
  }
  return profileId
}

function below(root: string, child: string): boolean {
  const value = relative(resolve(root), resolve(child))
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`)
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function pluginVersionState(version: ManagedVersion): Readonly<Record<string, unknown>> {
  return plain(version.kindState) ? version.kindState : Object.freeze({})
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`managed Plugin ${field} is invalid`)
  return value
}

function decodeProfileLock(value: unknown): ProfileLockRecord {
  if (plain(value) && value.schemaVersion === 1) {
    throw new Error('managed Plugin profile lock has no process-birth evidence; manual recovery is required')
  }
  if (!plain(value) || Object.keys(value).sort().join(',')
    !== 'acquiredAtMs,leaseId,ownerId,processIdentity,profileId,schemaVersion'
    || value.schemaVersion !== 2 || typeof value.profileId !== 'string' || typeof value.ownerId !== 'string'
    || value.ownerId.length === 0 || typeof value.leaseId !== 'string' || !/^lease:[0-9a-f-]{36}$/u.test(value.leaseId)
    || !Number.isSafeInteger(value.acquiredAtMs)) {
    throw new Error('managed Plugin profile lock is corrupt')
  }
  return Object.freeze({
    schemaVersion: 2,
    profileId: profileSegment(value.profileId),
    ownerId: value.ownerId,
    leaseId: value.leaseId,
    processIdentity: decodeProcessIdentity(value.processIdentity, 'managed Plugin profile lock'),
    acquiredAtMs: value.acquiredAtMs as number,
  })
}

function sameProfileLock(left: ProfileLockRecord, right: ProfileLockRecord): boolean {
  return left.schemaVersion === right.schemaVersion && left.profileId === right.profileId
    && left.ownerId === right.ownerId && left.leaseId === right.leaseId && left.acquiredAtMs === right.acquiredAtMs
    && left.processIdentity.schemaVersion === right.processIdentity.schemaVersion
    && left.processIdentity.pid === right.processIdentity.pid
    && left.processIdentity.platform === right.processIdentity.platform
    && left.processIdentity.machineDigest === right.processIdentity.machineDigest
    && left.processIdentity.bootDigest === right.processIdentity.bootDigest
    && left.processIdentity.birthDigest === right.processIdentity.birthDigest
}

function decodeProfileExecution(
  value: unknown,
  owner: Readonly<{ profileId: string; ownerId: string; processIdentity: ProcessIdentity }>,
): ProfileExecutionRecord {
  if (!plain(value) || Object.keys(value).sort().join(',')
    !== 'ownerId,parentPid,processGroupPid,profileId,schemaVersion,startedAtMs,supervisorSha256'
    || value.schemaVersion !== 1 || value.profileId !== owner.profileId || value.ownerId !== owner.ownerId
    || value.parentPid !== owner.processIdentity.pid || !Number.isSafeInteger(value.processGroupPid)
    || (value.processGroupPid as number) < 1 || !Number.isSafeInteger(value.startedAtMs)
    || typeof value.supervisorSha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.supervisorSha256)) {
    throw new Error('managed Plugin Profile execution lease is corrupt')
  }
  return value as unknown as ProfileExecutionRecord
}

function processGroupStatus(processGroupPid: number): 'alive' | 'dead' | 'unknown' {
  if (process.platform === 'win32') return 'unknown'
  try {
    process.kill(-processGroupPid, 0)
    return 'alive'
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return 'alive'
    if (code === 'ESRCH') return 'dead'
    return 'unknown'
  }
}

async function existingInfo(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function regularDigest(path: string, algorithm: 'sha256' | 'sha512'): Promise<Readonly<{
  sizeBytes: number
  digest: string
}>> {
  const handle = await openRegularNoFollow(path)
  const hash = createHash(algorithm)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`managed Plugin path is not a regular file: ${path}`)
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
    return Object.freeze({ sizeBytes: info.size, digest: hash.digest('hex') })
  } finally {
    await handle.close()
  }
}

async function fileEvidence(root: string, current = root): Promise<readonly ManagedPluginFileEvidence[]> {
  const output: ManagedPluginFileEvidence[] = []
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name)
    const relativePath = relative(root, path).split(sep).join('/')
    if (entry.isSymbolicLink()) throw new Error(`managed Plugin tree contains a symbolic link: ${relativePath}`)
    if (entry.isDirectory()) output.push(...await fileEvidence(root, path))
    else if (entry.isFile()) {
      const observed = await regularDigest(path, 'sha256')
      output.push(Object.freeze({
        path: relativePath,
        sizeBytes: observed.sizeBytes,
        sha256: `sha256:${observed.digest}`,
      }))
    }
    else throw new Error(`managed Plugin material contains an unsupported file type: ${relativePath}`)
  }
  return Object.freeze(output.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

async function artifactEvidence(path: string): Promise<Readonly<{
  path: string
  sizeBytes: number
  sha256: `sha256:${string}`
}>> {
  const observed = await regularDigest(path, 'sha256')
  return Object.freeze({ path: resolve(path), sizeBytes: observed.sizeBytes, sha256: `sha256:${observed.digest}` })
}

function bundlePatchPath(manifestBody: string): string {
  const manifest: unknown = JSON.parse(manifestBody)
  if (!plain(manifest) || !plain(manifest.dsh) || !plain(manifest.dsh.bundle)
    || typeof manifest.dsh.bundle.patch !== 'string' || manifest.dsh.bundle.patch.includes('\\')
    || manifest.dsh.bundle.patch.startsWith('/')) {
    throw new Error('managed Plugin manifest has no admitted Bundle patch')
  }
  const normalized = posix.normalize(manifest.dsh.bundle.patch.replace(/^\.\//u, ''))
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('managed Plugin Bundle patch path is unsafe')
  }
  return normalized
}

async function verifyArtifact(path: string, integrity: string): Promise<void> {
  const match = /^(sha256|sha512):([0-9a-f]+|[A-Za-z0-9+/]+={0,2})$/u.exec(integrity)
  if (match === null) throw new Error('managed Plugin artifact integrity is invalid')
  const [, algorithm, encoded] = match
  const hexadecimal = /^[0-9a-f]+$/u.test(encoded!)
  if (algorithm === 'sha256' ? !hexadecimal || encoded!.length !== 64
    : hexadecimal ? encoded!.length !== 128 : !/^[A-Za-z0-9+/]{86}==$/u.test(encoded!)) {
    throw new Error('managed Plugin artifact integrity is invalid')
  }
  const handle = await openRegularNoFollow(path)
  const hash = createHash(algorithm!)
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
  } finally {
    await handle.close()
  }
  const observed = hash.digest(hexadecimal ? 'hex' : 'base64')
  if (observed !== encoded) throw new Error('managed Plugin artifact changed after admission')
}

function markerPath(materialPath: string): string {
  return `${materialPath}.owner.json`
}

function decodeFileEvidence(value: unknown, field: string): ManagedPluginFileEvidence {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'path,sha256,sizeBytes'
    || typeof value.path !== 'string' || value.path.length === 0 || value.path.includes('\\')
    || value.path.startsWith('/') || posix.normalize(value.path) !== value.path
    || value.path === '..' || value.path.startsWith('../')
    || !Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 0
    || typeof value.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.sha256)) {
    throw new Error(`managed Plugin ${field} is invalid`)
  }
  return Object.freeze({
    path: value.path,
    sizeBytes: value.sizeBytes as number,
    sha256: value.sha256 as `sha256:${string}`,
  })
}

function decodeMarker(value: unknown, expected: Readonly<{
  targetKey: string
  packageName: string
  materialPath: string
  artifactRoot: string
}>): ManagedPluginMaterialMarker {
  if (!plain(value)) throw new Error('managed Plugin material marker is invalid')
  const keys = Object.keys(value).sort()
  const expectedKeys = [
    'artifactPath', 'artifactSha256', 'artifactSizeBytes', 'files', 'integrity', 'manifestDigest',
    'packageName', 'schemaVersion', 'targetKey', 'version',
  ]
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || value.schemaVersion !== 1
    || value.targetKey !== expected.targetKey || value.packageName !== expected.packageName
    || typeof value.version !== 'string' || typeof value.integrity !== 'string'
    || typeof value.artifactPath !== 'string' || !below(expected.artifactRoot, value.artifactPath)
    || !Number.isSafeInteger(value.artifactSizeBytes) || (value.artifactSizeBytes as number) < 1
    || typeof value.artifactSha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.artifactSha256)
    || typeof value.manifestDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.manifestDigest)
    || !Array.isArray(value.files)) {
    throw new Error('managed Plugin material marker does not own the material')
  }
  const files = value.files.map((item, index) => decodeFileEvidence(item, `material marker files[${String(index)}]`))
  if (files.length === 0 || new Set(files.map(item => item.path)).size !== files.length
    || files.some((item, index) => index > 0 && files[index - 1]!.path >= item.path)) {
    throw new Error('managed Plugin material marker file evidence is not canonical')
  }
  if (!below(resolve(expected.materialPath, '..'), expected.materialPath)) throw new Error('managed Plugin material marker path is invalid')
  return Object.freeze({
    schemaVersion: 1,
    targetKey: expected.targetKey,
    packageName: expected.packageName,
    version: value.version,
    integrity: value.integrity,
    artifactPath: resolve(value.artifactPath),
    artifactSizeBytes: value.artifactSizeBytes as number,
    artifactSha256: value.artifactSha256 as `sha256:${string}`,
    manifestDigest: value.manifestDigest,
    files: Object.freeze(files),
  })
}

function sidecarMaterial(record: ManagedTargetRecord, field: 'lastGood' | 'removed'): string | null {
  return record[field]?.materialPath ?? null
}

const LOCK_DEPENDENCY_GROUPS = Object.freeze(['dependencies', 'devDependencies', 'optionalDependencies'] as const)

function decodePnpmLock(body: string): Readonly<Record<string, unknown>> {
  const document = parseDocument(body, { schema: 'core', uniqueKeys: true })
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error('selected Plugin Profile pnpm lockfile is not unambiguous YAML')
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 })
  if (!plain(value) || !['9.0', 9].includes(value.lockfileVersion as string | number)) {
    throw new Error('selected Plugin Profile pnpm lockfile version is unsupported')
  }
  if (!plain(value.importers) || !plain(value.importers['.'])) {
    throw new Error('selected Plugin Profile pnpm lockfile importer is invalid')
  }
  for (const importer of Object.values(value.importers)) {
    if (!plain(importer)) throw new Error('selected Plugin Profile pnpm lockfile importer is invalid')
    for (const group of LOCK_DEPENDENCY_GROUPS) {
      if (importer[group] !== undefined && !plain(importer[group])) {
        throw new Error('selected Plugin Profile pnpm lockfile dependency group is invalid')
      }
    }
  }
  if (value.packages !== undefined && !plain(value.packages)) {
    throw new Error('selected Plugin Profile pnpm lockfile packages are invalid')
  }
  if (value.snapshots !== undefined && !plain(value.snapshots)) {
    throw new Error('selected Plugin Profile pnpm lockfile snapshots are invalid')
  }
  canonicalSha256(value)
  return immutableJsonClone(value)
}

function targetLockEntry(key: string, packageName: string): boolean {
  return key === packageName || key.startsWith(`${packageName}@`)
}

function nonTargetLock(lock: Readonly<Record<string, unknown>> | null, packageName: string): Readonly<Record<string, unknown>> | null {
  if (lock === null) return null
  const normalized = JSON.parse(JSON.stringify(lock)) as Record<string, unknown>
  const importers = normalized.importers as Record<string, unknown>
  const rootImporter = importers['.'] as Record<string, unknown>
  for (const group of LOCK_DEPENDENCY_GROUPS) {
    const dependencies = rootImporter[group]
    if (plain(dependencies)) delete dependencies[packageName]
  }
  for (const field of ['packages', 'snapshots'] as const) {
    const entries = normalized[field]
    if (!plain(entries)) continue
    for (const key of Object.keys(entries)) {
      if (targetLockEntry(key, packageName)) delete entries[key]
    }
  }
  return immutableJsonClone(normalized)
}

function nonTargetProfileDigest(observation: OfficialProfileObservation, packageName: string): `sha256:${string}` {
  const manifest = JSON.parse(JSON.stringify(observation.manifest)) as Record<string, unknown>
  if (plain(manifest.dependencies)) delete manifest.dependencies[packageName]
  if (plain(manifest.dsh) && plain(manifest.dsh.profile) && Array.isArray(manifest.dsh.profile.bundles)) {
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(item => item !== packageName)
  }
  return canonicalSha256({
    manifest,
    lock: nonTargetLock(observation.lock, packageName),
    installed: observation.installed.filter(item => item.packageName !== packageName),
  })
}

function sidecarFrom(
  record: ManagedTargetRecord,
  packageName: string,
  runtime: Readonly<{ entryId: string | null; loaderName: string | null; restartPending: boolean }>,
): ManagedPluginSidecar {
  return Object.freeze({
    schemaVersion: 1,
    profileId: record.profileId,
    packageName,
    targetKey: record.targetKey,
    revision: record.revision,
    lastOperationId: record.lastOperationId,
    managed: record,
    loaderEntryId: runtime.entryId,
    loaderName: runtime.loaderName,
    restartPending: runtime.restartPending,
    lastGoodMaterialPath: sidecarMaterial(record, 'lastGood'),
    tombstoneMaterialPath: sidecarMaterial(record, 'removed'),
  })
}

function decodeAbsentRollback(value: unknown): ManagedPluginAbsentRollback {
  if (!plain(value)) throw new Error('managed Plugin absent rollback receipt is invalid')
  const keys = Object.keys(value).sort()
  const expected = [
    'createdByOwnerId', 'loaderEntryId', 'loaderName', 'operationId', 'packageName', 'profileId',
    'restartRequired', 'schemaVersion', 'sourceDigest', 'sourceRevision', 'status', 'targetKey',
  ]
  if (JSON.stringify(keys) !== JSON.stringify(expected) || value.schemaVersion !== 1
    || typeof value.operationId !== 'string' || value.operationId.length === 0
    || typeof value.targetKey !== 'string' || value.targetKey.length === 0
    || typeof value.profileId !== 'string' || value.profileId.length === 0
    || typeof value.packageName !== 'string' || value.packageName.length === 0
    || !Number.isSafeInteger(value.sourceRevision) || (value.sourceRevision as number) < 1
    || typeof value.sourceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.sourceDigest)
    || (value.loaderEntryId !== null && typeof value.loaderEntryId !== 'string')
    || (value.loaderName !== null && typeof value.loaderName !== 'string')
    || typeof value.restartRequired !== 'boolean'
    || typeof value.createdByOwnerId !== 'string' || value.createdByOwnerId.length === 0
    || !['pending', 'settled'].includes(value.status as string)) {
    throw new Error('managed Plugin absent rollback receipt fields are invalid')
  }
  const profileId = profileSegment(value.profileId)
  packageSegments(value.packageName)
  if (!value.targetKey.startsWith(`plugin:${profileId}:`)) {
    throw new Error('managed Plugin absent rollback target does not bind its profile')
  }
  return Object.freeze({
    schemaVersion: 1,
    operationId: value.operationId,
    targetKey: value.targetKey,
    profileId,
    packageName: value.packageName,
    sourceRevision: value.sourceRevision as number,
    sourceDigest: value.sourceDigest as `sha256:${string}`,
    loaderEntryId: value.loaderEntryId,
    loaderName: value.loaderName,
    restartRequired: value.restartRequired,
    createdByOwnerId: value.createdByOwnerId,
    status: value.status as 'pending' | 'settled',
  })
}

/** Center-owned material/state plus official DSH Profile CLI and Loader coordinator. */
export class ManagedPluginOwner {
  private readonly root: string
  private readonly hostHome: string
  private readonly centerPackageName: string
  private readonly cli: ManagedPluginCli
  private readonly ownerId = randomUUID()
  private processIdentity: Promise<ProcessIdentity> | null = null
  private initialized: Promise<void> | null = null

  constructor(
    private readonly store: CenterStateStore,
    private readonly loader: ManagedPluginLoader,
    options: ManagedPluginOwnerOptions,
  ) {
    this.root = resolve(store.root)
    this.hostHome = resolve(options.hostHome)
    this.centerPackageName = options.centerPackageName ?? 'dsh-plugin-extension-center'
    if (options.pluginCli === undefined && options.officialDsh === undefined) {
      throw new Error('managed Plugin owner requires a trusted official DSH execution binding')
    }
    this.cli = options.pluginCli ?? new OfficialDshPluginCli(options.officialDsh!)
  }

  /** Reconcile durable desired state against official Profile packages and Loader rows. */
  initialize(): Promise<void> {
    this.initialized ??= this.initializeOnce()
    return this.initialized
  }

  /** Stable Center-owned Plugin state used for planning fences and restart diagnostics. */
  async snapshot(profileId: string): Promise<ManagedPluginSnapshot> {
    await this.initialize()
    return await this.readSnapshot(profileSegment(profileId))
  }

  /** Retain one admitted Bundle archive and its exact extracted-file evidence outside the Profile. */
  async materialize(input: Readonly<{
    targetKey: string
    profileId: string
    packageName: string
    version: string
    integrity: string
    archivePath: string
    inspection: NpmPackageInspection
  }>): Promise<ManagedPluginActivation> {
    await this.initialize()
    this.assertNotSelf(input.packageName)
    packageSegments(input.packageName)
    const profileId = profileSegment(input.profileId)
    if (input.inspection.bundlePatch === null) throw new Error('managed Plugin archive has no admitted Bundle patch')
    if (input.inspection.files.some(path => path === 'node_modules' || path.startsWith('node_modules/'))) {
      throw new Error('managed Plugin archive may not carry node_modules material')
    }
    const artifactPath = resolve(input.archivePath)
    if (!below(safeChild(this.root, 'artifacts'), artifactPath)) {
      throw new Error('managed Plugin archive is not Center-owned immutable material')
    }
    const artifact = await artifactEvidence(artifactPath)
    const materialParent = safeChild(this.root, 'material', 'plugins', storageKey(input.targetKey))
    await ensurePrivateDirectory(materialParent)
    const materialPath = safeChild(materialParent, storageKey(input.integrity))
    const existing = await existingInfo(materialPath)
    let marker: ManagedPluginMaterialMarker
    if (existing === null) {
      const observed = await materializeNpmArchive(input.archivePath, materialPath, null)
      if (observed.manifestDigest !== input.inspection.manifestDigest) {
        throw new Error('managed Plugin materialization changed the admitted manifest')
      }
      const files = await fileEvidence(materialPath)
      marker = Object.freeze({
        schemaVersion: 1,
        targetKey: input.targetKey,
        packageName: input.packageName,
        version: input.version,
        integrity: input.integrity,
        artifactPath: artifact.path,
        artifactSizeBytes: artifact.sizeBytes,
        artifactSha256: artifact.sha256,
        manifestDigest: input.inspection.manifestDigest,
        files,
      })
      try {
        await writeCanonicalExclusive(markerPath(materialPath), marker)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    } else {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error('foreign material exists at the managed Plugin destination')
      }
      marker = decodeMarker(await readCanonicalOptional(markerPath(materialPath)), {
        targetKey: input.targetKey,
        packageName: input.packageName,
        materialPath,
        artifactRoot: safeChild(this.root, 'artifacts'),
      })
    }
    const bindingMismatches = [
      marker.version === input.version ? null : 'version',
      marker.integrity === input.integrity ? null : 'integrity',
      marker.artifactPath === artifactPath ? null : 'artifact-path',
      marker.artifactSizeBytes === artifact.sizeBytes ? null : 'artifact-size',
      marker.artifactSha256 === artifact.sha256 ? null : 'artifact-digest',
      marker.manifestDigest === input.inspection.manifestDigest ? null : 'manifest-digest',
      canonicalSha256(marker.files.map(item => item.path)) === canonicalSha256(input.inspection.files)
        ? null
        : 'file-manifest',
    ].filter((field): field is string => field !== null)
    if (bindingMismatches.length > 0) {
      throw new Error(`managed Plugin material marker does not bind the admitted archive: ${bindingMismatches.join(',')}`)
    }
    await this.auditMaterial(materialPath, marker)
    return await this.activation(input.targetKey, input.packageName, profileId, {
      candidateRef: `plugin:${input.packageName}@${input.version}`,
      artifactRevision: input.version,
      artifactIntegrity: input.integrity,
      materialPath,
      configuration: {},
      enabled: true,
      ownerRevision: 'managed-plugin:materialized',
      kindState: {},
    })
  }

  /** Apply one desired record under a profile-wide lock and persist its owner sidecar first. */
  async commit(
    before: ManagedTargetRecord | null,
    desired: ManagedTargetRecord,
    packageName: string,
    metadataCache: ProfileMetadataCacheBinding | null = null,
  ): Promise<ManagedPluginCommitResult> {
    await this.initialize()
    this.assertNotSelf(packageName)
    return await this.withProfileLock(desired.profileId, async () => {
      const prior = await this.readSidecar(desired.profileId, desired.targetKey)
      if (before === null ? prior !== null : prior === null || canonicalSha256(prior.managed) !== canonicalSha256(before)) {
        throw new Error('managed Plugin owner sidecar does not match the operation before-state')
      }
      const priorActivation = before?.current === null || before?.current === undefined
        ? null
        : await this.activation(before.targetKey, packageName, before.profileId, before.current)
      const desiredActivation = desired.current === null
        ? null
        : await this.activation(desired.targetKey, packageName, desired.profileId, desired.current)
      const restartRequired = priorActivation !== null || desiredActivation !== null
      const operationKind = this.operationKind(desired)
      if (restartRequired && operationKind !== 'configure') {
        await this.assertOfficialBefore(before, priorActivation, desired.profileId, packageName)
        if (desiredActivation !== null) {
          await verifyArtifact(desiredActivation.artifactPath, desiredActivation.artifactIntegrity)
        }
        const runtime = Object.freeze({
          entryId: null,
          loaderName: desiredActivation?.loaderName ?? null,
          restartPending: true,
        })
        const intent = sidecarFrom(desired, packageName, runtime)
        await this.writeSidecar(intent)
        await this.advanceProfile(desired.profileId)
        try {
          if (desired.lastOperationId === null) throw new Error('managed Plugin mutation has no operation identity')
          await this.applyOfficialDesired(desired.profileId, packageName, desiredActivation, priorActivation, {
            operationId: desired.lastOperationId,
            targetKey: desired.targetKey,
            metadataCache,
            requireCurrentProfile: operationKind !== 'rollback',
          })
        } catch (error: unknown) {
          if (!(error instanceof OfficialProfileAmbiguityError)) {
            if (prior === null) await durableUnlink(this.sidecarPath(desired.profileId, desired.targetKey), { force: true })
            else await this.writeSidecar(prior)
            await this.advanceProfile(desired.profileId)
          }
          throw error
        }
        return Object.freeze({ sidecar: intent, restartRequired: true })
      }
      let runtime: Readonly<{ entryId: string | null; loaderName: string | null; restartPending: boolean }>
      try {
        runtime = await this.applyCanonicalLoader(packageName, desiredActivation)
      } catch (error: unknown) {
        try {
          await this.applyCanonicalLoader(packageName, priorActivation)
        } catch (rollbackError: unknown) {
          throw new AggregateError([error, rollbackError], 'managed Plugin owner mutation and rollback failed')
        }
        throw error
      }
      const managed = this.settled(desired, desiredActivation, runtime.entryId)
      const sidecar = sidecarFrom(managed, packageName, runtime)
      await this.writeSidecar(sidecar)
      await this.advanceProfile(desired.profileId)
      return Object.freeze({ sidecar, restartRequired: false })
    })
  }

  /** Prove exact Loader presence or absence for one settled managed record. */
  async verify(record: ManagedTargetRecord): Promise<Readonly<{ entryId: string; moduleName: string; fiberPhase: 'active' | 'absent' }>> {
    await this.initialize()
    const sidecar = await this.readSidecar(record.profileId, record.targetKey)
    if (sidecar === null || canonicalSha256(sidecar.managed) !== canonicalSha256(record)) {
      throw new Error('managed Plugin runtime has no exact owner sidecar')
    }
    if (sidecar.restartPending) throw new Error('managed Plugin runtime still requires a process restart')
    if (record.current === null) {
      if (sidecar.loaderEntryId !== null || sidecar.loaderName !== null) {
        throw new Error('removed managed Plugin retains Loader ownership')
      }
      if (this.canonicalRows(sidecar.packageName).length !== 0) {
        throw new Error('removed managed Plugin retains its canonical Loader row')
      }
      return Object.freeze({ entryId: record.targetKey, moduleName: sidecar.packageName, fiberPhase: 'absent' })
    }
    if (sidecar.loaderEntryId === null || sidecar.loaderName === null) {
      throw new Error('installed managed Plugin has no Loader row')
    }
    const row = await this.awaitCanonicalLoaderRow(sidecar.packageName, sidecar.loaderEntryId)
    if (row.options.name !== sidecar.loaderName) throw new Error('managed Plugin Loader row identity changed')
    return Object.freeze({ entryId: row.id, moduleName: row.options.name, fiberPhase: 'active' })
  }

  /** Read the durable owner projection, including a sidecar ahead of Center state after a crash. */
  async sidecar(profileId: string, targetKey: string): Promise<ManagedPluginSidecar | null> {
    await this.initialize()
    return await this.readSidecar(profileSegment(profileId), targetKey)
  }

  /** Restore a Plugin whose exact provider before-state was absent. */
  async rollbackToAbsent(
    before: ManagedTargetRecord,
    packageName: string,
    operationId: string,
    metadataCache: ProfileMetadataCacheBinding | null = null,
  ): Promise<ManagedPluginAbsentRollback> {
    await this.initialize()
    this.assertNotSelf(packageName)
    return await this.withProfileLock(before.profileId, async () => {
      const prior = await this.readSidecar(before.profileId, before.targetKey)
      if (prior === null || canonicalSha256(prior.managed) !== canonicalSha256(before)) {
        throw new Error('managed Plugin owner sidecar does not match absent rollback source')
      }
      const activation = before.current === null
        ? null
        : await this.activation(before.targetKey, packageName, before.profileId, before.current)
      const receipt: ManagedPluginAbsentRollback = Object.freeze({
        schemaVersion: 1,
        operationId,
        targetKey: before.targetKey,
        profileId: before.profileId,
        packageName,
        sourceRevision: before.revision,
        sourceDigest: canonicalSha256(before),
        loaderEntryId: prior.loaderEntryId,
        loaderName: prior.loaderName,
        restartRequired: activation !== null,
        createdByOwnerId: this.ownerId,
        status: 'pending',
      })
      await writeCanonicalAtomic(this.absentRollbackPath(operationId), receipt)
      return await this.completeAbsentRollback(receipt, prior, metadataCache)
    })
  }

  /** Verify durable absence and exact runtime cleanup for one rollback receipt. */
  async absentRollbackReceipt(input: Readonly<{
    operationId: string
    targetKey: string
    profileId: string
  }>): Promise<ManagedPluginAbsentRollback | null> {
    await this.initialize()
    const receipt = await this.readAbsentRollback(input.operationId)
    if (receipt === null) return null
    if (receipt.targetKey !== input.targetKey || receipt.profileId !== input.profileId) {
      throw new Error('managed Plugin absent rollback receipt does not bind the operation')
    }
    return receipt
  }

  /** Verify durable absence and exact runtime cleanup for one rollback receipt. */
  async verifyAbsentRollback(input: Readonly<{
    operationId: string
    targetKey: string
    profileId: string
  }>): Promise<ManagedPluginAbsentRollback> {
    const receipt = await this.absentRollbackReceipt(input)
    if (receipt === null || receipt.status !== 'settled') {
      throw new Error('managed Plugin absent rollback receipt does not bind the operation')
    }
    if (await this.store.getManaged(input.targetKey) !== undefined
      || await this.readSidecar(input.profileId, input.targetKey) !== null) {
      throw new Error('managed Plugin absent rollback retained authoritative state')
    }
    if (await this.profileDependency(receipt.profileId, receipt.packageName) !== null) {
      throw new Error('managed Plugin absent rollback retained its official Profile dependency')
    }
    // EntryTree.store is populated before entry fibers settle. Absence only
    // depends on the configured row inventory; awaiting the whole tree from
    // this plugin's own startup recovery would wait on the current fiber.
    const retained = [...this.loader.entries()].some(entry => entry.id === receipt.loaderEntryId
      || entry.options.name === receipt.loaderName || entry.options.name === receipt.packageName)
    if (retained) throw new Error('managed Plugin absent rollback retained its Loader row')
    return receipt
  }

  /** Require a different Host process only when the removed package had Client code. */
  async absentRollbackBootReady(operationId: string, profileId: string): Promise<boolean | null> {
    await this.initialize()
    const receipt = await this.readAbsentRollback(operationId)
    if (receipt === null) return null
    if (receipt.profileId !== profileId || receipt.status !== 'settled') return false
    return !receipt.restartRequired || receipt.createdByOwnerId !== this.ownerId
  }

  /** Remove transient rollback proof after the terminal operation receipt is durable. */
  async finalizeAbsentRollback(operationId: string): Promise<void> {
    await durableUnlink(this.absentRollbackPath(operationId), { force: true })
  }

  /** Read one immutable break-glass restore marker without starting ordinary Profile reconciliation. */
  async breakGlassRestore(input: Readonly<{
    operationId: string
    targetKey: string
    profileId: string
    packageName: string
    journalHeadDigest: `sha256:${string}`
    providerSnapshotDigest: `sha256:${string}`
    beforeDigest: `sha256:${string}`
  }>): Promise<ManagedPluginBreakGlassRestore | null> {
    const value = await readCanonicalOptional(this.breakGlassRestorePath(input.operationId))
    if (value === undefined) return null
    if (!plain(value) || Object.keys(value).sort().join(',') !== [
      'beforeDigest', 'journalHeadDigest', 'operationId', 'packageName', 'profileId', 'providerSnapshotDigest',
      'restoredManagedDigest', 'restoredRevision', 'schemaVersion', 'status', 'targetKey',
    ].join(',') || value.schemaVersion !== 1 || value.status !== 'settled'
      || value.operationId !== input.operationId || value.targetKey !== input.targetKey
      || value.profileId !== input.profileId || value.packageName !== input.packageName
      || value.journalHeadDigest !== input.journalHeadDigest
      || value.providerSnapshotDigest !== input.providerSnapshotDigest || value.beforeDigest !== input.beforeDigest
      || typeof value.restoredManagedDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.restoredManagedDigest)
      || value.restoredRevision !== null
        && (!Number.isSafeInteger(value.restoredRevision) || (value.restoredRevision as number) < 1)) {
      throw new Error('managed Plugin break-glass restore marker does not bind the verified recovery inputs')
    }
    profileSegment(value.profileId)
    packageSegments(value.packageName)
    return Object.freeze({
      schemaVersion: 1,
      operationId: value.operationId,
      targetKey: value.targetKey,
      profileId: value.profileId,
      packageName: value.packageName,
      journalHeadDigest: value.journalHeadDigest,
      providerSnapshotDigest: value.providerSnapshotDigest,
      beforeDigest: value.beforeDigest,
      restoredManagedDigest: value.restoredManagedDigest as `sha256:${string}`,
      restoredRevision: value.restoredRevision as number | null,
      status: 'settled',
    })
  }

  private async initializeOnce(): Promise<void> {
    await ensurePrivateDirectory(safeChild(this.root, 'plugin'))
    await ensurePrivateDirectory(safeChild(this.root, 'plugin', 'profiles'))
    await ensurePrivateDirectory(safeChild(this.root, 'plugin', 'absent-rollbacks'))
    await ensurePrivateDirectory(this.coordinationRoot())
    await ensurePrivateDirectory(this.leaseRoot())
    await ensurePrivateDirectory(this.leaseTakeoverRoot())
    await ensurePrivateDirectory(this.leaseQuarantineRoot())
    await ensurePrivateDirectory(this.quarantineRoot())
    await this.assertNoAmbiguity()
    await this.recoverStaleLocks()
    await this.recoverAbsentRollbacks()
    const records = (await this.store.listManaged()).filter(record => record.kind === 'plugin')
    for (const record of records.sort((left, right) => left.targetKey.localeCompare(right.targetKey))) {
      await this.withProfileLock(record.profileId, async () => {
        let sidecar = await this.readSidecar(record.profileId, record.targetKey)
        let effective = record
        if (sidecar === null) {
          sidecar = sidecarFrom(record, this.packageName(record), {
            entryId: null, loaderName: null, restartPending: true,
          })
        } else if (sidecar.revision === record.revision + 1) {
          await this.store.putManaged(sidecar.managed, record.revision)
          effective = sidecar.managed
        } else if (sidecar.revision !== record.revision || canonicalSha256(sidecar.managed) !== canonicalSha256(record)) {
          throw new Error('managed Plugin Center state and owner sidecar diverged')
        }
        const activation = effective.current === null
          ? null
          : await this.activation(effective.targetKey, sidecar.packageName, effective.profileId, effective.current)
        const retained = effective.current ?? effective.removed
        if (retained !== null && effective.current === null) {
          await this.activation(effective.targetKey, sidecar.packageName, effective.profileId, retained)
        }
        let runtime: Readonly<{ entryId: string | null; loaderName: string | null; restartPending: false }>
        const dependency = await this.profileDependency(effective.profileId, sidecar.packageName)
        if (activation !== null) {
          if (dependency === null) {
            if (!sidecar.restartPending) throw new Error('managed Plugin lost its official Profile dependency')
            await this.applyOfficialDesired(
              effective.profileId,
              sidecar.packageName,
              activation,
              null,
              this.recoveryMutation(effective),
            )
            return
          }
          await this.verifyInstalledPackage(effective.profileId, activation)
          const bundled = await this.profileBundleCount(effective.profileId, sidecar.packageName)
          if (bundled !== 1 || sidecar.restartPending && this.canonicalRows(sidecar.packageName).length === 0) {
            if (!sidecar.restartPending) throw new Error('managed Plugin official Bundle membership diverged')
            await this.applyOfficialDesired(
              effective.profileId,
              sidecar.packageName,
              activation,
              undefined,
              this.recoveryMutation(effective),
            )
            return
          }
          runtime = await this.applyCanonicalLoader(sidecar.packageName, activation)
        } else {
          const bundled = await this.profileBundleCount(effective.profileId, sidecar.packageName)
          if (dependency !== null || bundled !== 0 || await existingInfo(await this.profilePackagePath(
            effective.profileId, sidecar.packageName,
          )) !== null) {
            if (!sidecar.restartPending) throw new Error('removed managed Plugin regained official Profile state')
            await this.applyOfficialDesired(
              effective.profileId,
              sidecar.packageName,
              null,
              undefined,
              this.recoveryMutation(effective),
            )
            return
          }
          runtime = await this.applyCanonicalLoader(sidecar.packageName, null)
        }
        const settled = this.settled(effective, activation, runtime.entryId, true)
        const repaired = sidecarFrom(settled, sidecar.packageName, runtime)
        await this.writeSidecar(repaired)
        await this.store.putManaged(settled, effective.revision)
        await this.advanceProfile(record.profileId)
      })
    }
  }

  private async recoverAbsentRollbacks(): Promise<void> {
    const directory = safeChild(this.root, 'plugin', 'absent-rollbacks')
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
        throw new Error('managed Plugin absent rollback directory contains foreign state')
      }
      const receipt = decodeAbsentRollback(await readCanonicalOptional(join(directory, entry.name)))
      if (`${storageKey(receipt.operationId)}.json` !== entry.name) {
        throw new Error('managed Plugin absent rollback filename does not bind its operation')
      }
      if (receipt.status === 'pending') {
        await this.withProfileLock(receipt.profileId, async () => {
          await this.completeAbsentRollback(receipt, await this.readSidecar(receipt.profileId, receipt.targetKey))
        })
      }
    }
  }

  private async completeAbsentRollback(
    receipt: ManagedPluginAbsentRollback,
    heldSidecar: ManagedPluginSidecar | null,
    metadataCache: ProfileMetadataCacheBinding | null = null,
  ): Promise<ManagedPluginAbsentRollback> {
    const current = await this.store.getManaged(receipt.targetKey)
    if (current !== undefined && (current.revision !== receipt.sourceRevision
      || canonicalSha256(current) !== receipt.sourceDigest)) {
      throw new Error('managed Plugin absent rollback source changed')
    }
    if (heldSidecar !== null && canonicalSha256(heldSidecar.managed) !== receipt.sourceDigest) {
      throw new Error('managed Plugin absent rollback sidecar changed')
    }
    const prior = heldSidecar ?? (current === undefined ? null : sidecarFrom(current, receipt.packageName, {
      entryId: receipt.loaderEntryId,
      loaderName: receipt.loaderName,
      restartPending: false,
    }))
    if (prior !== null) {
      const version = prior.managed.current ?? prior.managed.removed
      const activation = version === null
        ? null
        : await this.activation(receipt.targetKey, receipt.packageName, receipt.profileId, version)
      if (activation !== null) await this.applyOfficialDesired(receipt.profileId, receipt.packageName, null, activation, {
        operationId: receipt.operationId,
        targetKey: receipt.targetKey,
        metadataCache,
        requireCurrentProfile: false,
      })
    }
    await durableUnlink(this.sidecarPath(receipt.profileId, receipt.targetKey), { force: true })
    if (current !== undefined) await this.store.deleteManaged(receipt.targetKey, current.revision)
    const settled = Object.freeze({ ...receipt, status: 'settled' as const })
    await writeCanonicalAtomic(this.absentRollbackPath(receipt.operationId), settled)
    await this.advanceProfile(receipt.profileId)
    return settled
  }

  private absentRollbackPath(operationId: string): string {
    return safeChild(this.root, 'plugin', 'absent-rollbacks', `${storageKey(operationId)}.json`)
  }

  private breakGlassRestorePath(operationId: string): string {
    return safeChild(this.root, 'plugin', 'break-glass-restores', `${storageKey(operationId)}.json`)
  }

  private async readAbsentRollback(operationId: string): Promise<ManagedPluginAbsentRollback | null> {
    const value = await readCanonicalOptional(this.absentRollbackPath(operationId))
    if (value === undefined) return null
    const receipt = decodeAbsentRollback(value)
    if (receipt.operationId !== operationId) throw new Error('managed Plugin absent rollback path does not bind its operation')
    return receipt
  }

  private async auditMaterial(materialPath: string, marker: ManagedPluginMaterialMarker): Promise<void> {
    const observed = await fileEvidence(materialPath)
    if (canonicalSha256(observed) !== canonicalSha256(marker.files)) {
      throw new Error('managed Plugin immutable material file evidence changed')
    }
    const artifact = await artifactEvidence(marker.artifactPath)
    if (artifact.sizeBytes !== marker.artifactSizeBytes || artifact.sha256 !== marker.artifactSha256) {
      throw new Error('managed Plugin retained artifact evidence changed')
    }
  }

  private async activation(
    targetKey: string,
    packageName: string,
    profileId: string,
    version: ManagedVersion,
  ): Promise<ManagedPluginActivation> {
    const marker = decodeMarker(await readCanonicalOptional(markerPath(version.materialPath)), {
      targetKey,
      packageName,
      materialPath: version.materialPath,
      artifactRoot: safeChild(this.root, 'artifacts'),
    })
    await this.auditMaterial(version.materialPath, marker)
    const manifestBody = await readFile(join(version.materialPath, 'package.json'), 'utf8')
    const canonical = JSON.stringify(JSON.parse(manifestBody))
    const inspection = await inspectNpmArchiveFromMaterial(marker, canonical)
    const patchPath = bundlePatchPath(inspection.manifestBody)
    if (!marker.files.some(file => file.path === patchPath)) {
      throw new Error('managed Plugin retained Bundle patch is absent')
    }
    await verifyArtifact(marker.artifactPath, version.artifactIntegrity)
    return Object.freeze({
      targetKey,
      packageName,
      materialPath: version.materialPath,
      artifactPath: marker.artifactPath,
      artifactSizeBytes: marker.artifactSizeBytes,
      artifactSha256: marker.artifactSha256,
      artifactRevision: marker.version,
      artifactIntegrity: version.artifactIntegrity,
      loaderName: packageName,
      manifestDigest: marker.manifestDigest as `sha256:${string}`,
      bundlePatchPath: patchPath,
      files: marker.files,
      configuration: version.configuration,
    })
  }

  private async assertOfficialBefore(
    before: ManagedTargetRecord | null,
    activation: ManagedPluginActivation | null,
    desiredProfileId: string,
    packageName: string,
  ): Promise<void> {
    const profileId = before?.profileId ?? desiredProfileId
    const dependency = await this.profileDependency(profileId, packageName)
    const bundleCount = await this.profileBundleCount(profileId, packageName)
    const rows = this.canonicalRows(packageName)
    if (before === null) {
      if (dependency !== null || bundleCount !== 0 || rows.length > 0
        || await existingInfo(await this.profilePackagePath(profileId, packageName)) !== null) {
        throw new Error('managed Plugin package collides with foreign official Profile state')
      }
      return
    }
    if (activation !== null) {
      if (dependency === null || bundleCount !== 1 || rows.length !== 1) {
        throw new Error('managed Plugin official Profile state diverged before mutation')
      }
      await this.verifyInstalledPackage(profileId, activation)
      return
    }
    if (dependency !== null || bundleCount !== 0 || rows.length > 0
      || await existingInfo(await this.profilePackagePath(profileId, packageName)) !== null) {
      throw new Error('managed Plugin removed state collides with official Profile state')
    }
  }

  private async applyOfficialDesired(
    profileId: string,
    packageName: string,
    activation: ManagedPluginActivation | null,
    compensation?: ManagedPluginActivation | null,
    mutation: Readonly<{
      operationId: string
      targetKey: string
      metadataCache?: ProfileMetadataCacheBinding | null
      requireCurrentProfile: boolean
    }> | null = null,
  ): Promise<void> {
    await this.assertProfileNoAmbiguity(profileId)
    const before = await this.stableOfficialObservation(profileId, packageName, 'before', mutation)
    if (this.observationHolds(before, packageName, activation)) return
    const metadataCache = mutation === null
      ? null
      : mutation.metadataCache ?? await this.operationMetadataCache(mutation.operationId, profileId)
    await this.cli.audit(profileId, metadataCache, mutation?.requireCurrentProfile ?? false)
    let commandFailure: Readonly<{ error: unknown }> | null = null
    try {
      await this.runOfficialDesired(profileId, packageName, activation, metadataCache)
    } catch (error: unknown) {
      commandFailure = Object.freeze({ error })
    }
    const after = await this.stableOfficialObservation(profileId, packageName, 'after', mutation)
    if (nonTargetProfileDigest(before, packageName) !== nonTargetProfileDigest(after, packageName)) {
      await this.failAmbiguous(
        profileId, packageName, 'official CLI changed non-target Profile state', before, after, undefined, mutation,
      )
    }
    if (commandFailure !== null) {
      if (canonicalSha256(before) === canonicalSha256(after)) throw commandFailure.error
      if (compensation === undefined) {
        await this.failAmbiguous(
          profileId, packageName, 'official CLI failed after changing Profile state', before, after, commandFailure.error,
          mutation,
        )
      }
      const rollbackDesired: ManagedPluginActivation | null = compensation ?? null
      let compensationFailure: Readonly<{ error: unknown }> | null = null
      try {
        await this.cli.audit(profileId, metadataCache, false)
        await this.runOfficialDesired(profileId, packageName, rollbackDesired, metadataCache)
      } catch (error: unknown) {
        compensationFailure = Object.freeze({ error })
      }
      const restored = await this.stableOfficialObservation(profileId, packageName, 'after', mutation)
      if (canonicalSha256(before) === canonicalSha256(restored)) {
        if (compensationFailure === null) throw commandFailure.error
        throw new AggregateError(
          [commandFailure.error, compensationFailure.error],
          'official DSH Plugin mutation failed but exact before-state was restored',
        )
      }
      await this.failAmbiguous(
        profileId,
        packageName,
        'official CLI compensation did not restore the exact Profile before-state',
        before,
        restored,
        compensationFailure === null
          ? commandFailure.error
          : new AggregateError([commandFailure.error, compensationFailure.error]),
        mutation,
      )
    }
    if (!this.observationHolds(after, packageName, activation)) {
      await this.failAmbiguous(
        profileId, packageName, 'official CLI target state is not the admitted desired state', before, after, undefined, mutation,
      )
    }
  }

  private observationHolds(
    observation: OfficialProfileObservation,
    packageName: string,
    activation: ManagedPluginActivation | null,
  ): boolean {
    const dependency = observation.dependencies.find(item => item.name === packageName)
    const bundleCount = observation.bundles.filter(item => item === packageName).length
    const installed = observation.installed.find(item => item.packageName === packageName)
    if (activation === null) return dependency === undefined && bundleCount === 0 && installed?.treeDigest === null
    return dependency !== undefined && bundleCount === 1
      && installed?.treeDigest === canonicalSha256(activation.files)
  }

  private async runOfficialDesired(
    profileId: string,
    packageName: string,
    activation: ManagedPluginActivation | null,
    metadataCache: ProfileMetadataCacheBinding | null,
  ): Promise<void> {
    if (activation === null) {
      await this.cli.remove(profileId, packageName, metadataCache)
      return
    }
    await verifyArtifact(activation.artifactPath, activation.artifactIntegrity)
    await this.cli.add(profileId, packageName, activation.artifactRevision, activation.artifactPath, metadataCache)
  }

  private recoveryMutation(record: ManagedTargetRecord): Readonly<{
    operationId: string
    targetKey: string
    requireCurrentProfile: false
  }> | null {
    return record.lastOperationId === null
      ? null
      : Object.freeze({ operationId: record.lastOperationId, targetKey: record.targetKey, requireCurrentProfile: false })
  }

  private async operationMetadataCache(
    operationId: string,
    profileId: string,
  ): Promise<ProfileMetadataCacheBinding | null> {
    const snapshot = await this.store.getProviderSnapshot(operationId)
    if (snapshot === undefined) return null
    const metadataCache = profileMetadataCacheFromRecoveryPoint(snapshot.recoveryPoint)
    if (metadataCache !== null && metadataCache.profileId !== profileId) {
      throw new Error('Plugin recovery metadata cache does not bind the Profile')
    }
    return metadataCache
  }

  private async applyCanonicalLoader(
    packageName: string,
    activation: ManagedPluginActivation | null,
  ): Promise<Readonly<{ entryId: string | null; loaderName: string | null; restartPending: false }>> {
    const rows = this.canonicalRows(packageName)
    if (activation === null) {
      if (rows.length > 0) throw new Error('removed managed Plugin retains its canonical Loader row')
      return Object.freeze({ entryId: null, loaderName: null, restartPending: false })
    }
    if (rows.length !== 1) {
      throw new Error('managed Plugin has no unique canonical Loader row')
    }
    const row = await this.awaitCanonicalLoaderRow(packageName, rows[0]!.id)
    await this.loader.update(row.id, { config: activation.configuration })
    const updated = await this.awaitCanonicalLoaderRow(packageName, row.id)
    return Object.freeze({ entryId: row.id, loaderName: packageName, restartPending: false })
  }

  private async awaitCanonicalLoaderRow(
    packageName: string,
    entryId: string,
  ): Promise<ReturnType<ManagedPluginOwner['canonicalRows']>[number]> {
    const row = this.canonicalRows(packageName).find(entry => entry.id === entryId)
    if (row === undefined || row.options.group || row.disabled) {
      throw new Error('managed Plugin has no enabled exact Loader row')
    }
    await row.refresh()
    const started = this.canonicalRows(packageName).find(entry => entry.id === entryId)
    if (started === undefined || started.options.group || started.disabled || started.fiber === undefined) {
      throw new Error('managed Plugin canonical Loader row did not start')
    }
    await started.fiber.await()
    const settled = this.canonicalRows(packageName).find(entry => entry.id === entryId)
    if (settled === undefined || settled.options.group || settled.disabled || settled.fiber?.state !== 2) {
      throw new Error('managed Plugin canonical Loader row is not ACTIVE')
    }
    return settled
  }

  private settled(
    record: ManagedTargetRecord,
    activation: ManagedPluginActivation | null,
    entryId: string | null,
    advanceRevision = false,
  ): ManagedTargetRecord {
    const evidence = Object.freeze({
      entryId: entryId ?? record.targetKey,
      moduleName: activation?.loaderName ?? this.packageName(record),
      fiberPhase: activation === null ? 'absent' as const : 'active' as const,
    })
    const update = (version: ManagedVersion): ManagedVersion => immutableJsonClone({
      ...version,
      kindState: {
        ...pluginVersionState(version),
        packageName: this.packageName(record),
        restartToken: `managed:${String(record.revision)}`,
        treeDigest: canonicalSha256({ targetKey: record.targetKey, revision: record.revision, activation }),
        loaderPhase: evidence.fiberPhase,
        consumerObserved: true,
        restartObserved: true,
        runtimeEvidence: evidence,
      },
    }) as ManagedVersion
    return immutableJsonClone({
      ...record,
      revision: record.revision + (advanceRevision ? 1 : 0),
      current: record.current === null ? null : update(record.current),
      removed: record.current === null && record.removed !== null ? update(record.removed) : record.removed,
      pending: null,
      updatedAtMs: advanceRevision ? Date.now() : record.updatedAtMs,
    }) as ManagedTargetRecord
  }

  private async profilePath(profileId: string): Promise<string> {
    const profile = safeChild(this.hostHome, 'profiles', profileSegment(profileId))
    const profileInfo = await existingInfo(profile)
    if (profileInfo === null || !profileInfo.isDirectory() || profileInfo.isSymbolicLink()) {
      throw new Error(`selected Plugin Profile is not a real directory: ${profile}`)
    }
    return profile
  }

  private async profileDependency(profileId: string, packageName: string): Promise<string | null> {
    const profile = await this.profilePath(profileId)
    const manifestPath = safeChild(profile, 'package.json')
    const manifestInfo = await existingInfo(manifestPath)
    if (manifestInfo === null || !manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw new Error('selected Plugin Profile manifest is not a regular file')
    }
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!plain(manifest) || !plain(manifest.dependencies)) return null
    const value = manifest.dependencies[packageName]
    if (value === undefined) return null
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('selected Plugin Profile dependency is invalid')
    }
    return value
  }

  private async profileBundleCount(profileId: string, packageName: string): Promise<number> {
    const profile = await this.profilePath(profileId)
    const manifest: unknown = JSON.parse(await readFile(safeChild(profile, 'package.json'), 'utf8'))
    if (!plain(manifest)) throw new Error('selected Plugin Profile manifest is invalid')
    const dsh = manifest.dsh === undefined ? null : manifest.dsh
    if (dsh !== null && !plain(dsh)) throw new Error('selected Plugin Profile dsh metadata is invalid')
    const profileMetadata = dsh === null || dsh.profile === undefined ? null : dsh.profile
    if (profileMetadata !== null && !plain(profileMetadata)) {
      throw new Error('selected Plugin Profile bundle metadata is invalid')
    }
    const bundles = profileMetadata === null || profileMetadata.bundles === undefined ? [] : profileMetadata.bundles
    if (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string')) {
      throw new Error('selected Plugin Profile bundle list is invalid')
    }
    return bundles.filter(item => item === packageName).length
  }

  private async verifyInstalledPackage(profileId: string, activation: ManagedPluginActivation): Promise<void> {
    const packageRoot = await realpath(await this.profilePackagePath(profileId, activation.packageName)).catch((cause: unknown) => {
      throw new Error('official DSH Plugin package is not materialized', { cause })
    })
    const rootInfo = await lstat(packageRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('official DSH Plugin package root is not a real directory')
    }
    const files = await fileEvidence(packageRoot)
    if (canonicalSha256(files) !== canonicalSha256(activation.files)) {
      throw new Error('official DSH Plugin installed tree does not match the admitted archive')
    }
    const manifestPath = join(packageRoot, 'package.json')
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!plain(manifest) || manifest.name !== activation.packageName || manifest.version !== activation.artifactRevision
      || canonicalSha256(manifest) !== activation.manifestDigest
      || bundlePatchPath(JSON.stringify(manifest)) !== activation.bundlePatchPath) {
      throw new Error('official DSH Plugin package metadata does not match the admitted Bundle')
    }
  }

  private canonicalRows(packageName: string): ReturnType<ManagedPluginLoader['entries']> extends Iterable<infer T> ? T[] : never {
    return [...this.loader.entries()].filter(entry => !entry.options.group && entry.options.name === packageName) as never
  }

  private async profilePackagePath(profileId: string, packageName: string): Promise<string> {
    return join(await this.profilePath(profileId), 'node_modules', ...packageSegments(packageName))
  }

  private sidecarPath(profileId: string, targetKey: string): string {
    return safeChild(this.root, 'plugin', 'profiles', storageKey(profileId), 'packages', `${storageKey(targetKey)}.json`)
  }

  private profileRecordPath(profileId: string): string {
    return safeChild(this.root, 'plugin', 'profiles', storageKey(profileId), 'owner.json')
  }

  private async readSidecar(profileId: string, targetKey: string): Promise<ManagedPluginSidecar | null> {
    const value = await readCanonicalOptional(this.sidecarPath(profileId, targetKey))
    if (value === undefined) return null
    if (!plain(value) || value.schemaVersion !== 1 || value.profileId !== profileId || value.targetKey !== targetKey
      || typeof value.packageName !== 'string' || !Number.isSafeInteger(value.revision)
      || (value.lastOperationId !== null && typeof value.lastOperationId !== 'string')
      || (value.loaderEntryId !== null && typeof value.loaderEntryId !== 'string')
      || (value.loaderName !== null && typeof value.loaderName !== 'string')
      || typeof value.restartPending !== 'boolean'
      || (value.lastGoodMaterialPath !== null && typeof value.lastGoodMaterialPath !== 'string')
      || (value.tombstoneMaterialPath !== null && typeof value.tombstoneMaterialPath !== 'string')) {
      throw new Error('managed Plugin owner sidecar is invalid')
    }
    const managed = decodeManagedTarget(value.managed, this.root, targetKey)
    if (managed.profileId !== profileId || managed.revision !== value.revision
      || managed.lastOperationId !== value.lastOperationId) {
      throw new Error('managed Plugin owner sidecar does not bind its managed state')
    }
    return Object.freeze({
      schemaVersion: 1,
      profileId,
      packageName: value.packageName,
      targetKey,
      revision: value.revision,
      lastOperationId: value.lastOperationId,
      managed,
      loaderEntryId: value.loaderEntryId,
      loaderName: value.loaderName,
      restartPending: value.restartPending,
      lastGoodMaterialPath: value.lastGoodMaterialPath,
      tombstoneMaterialPath: value.tombstoneMaterialPath,
    })
  }

  private async writeSidecar(sidecar: ManagedPluginSidecar): Promise<void> {
    await writeCanonicalAtomic(this.sidecarPath(sidecar.profileId, sidecar.targetKey), sidecar)
  }

  private async readSnapshot(profileId: string): Promise<ManagedPluginSnapshot> {
    const held = await readCanonicalOptional(this.profileRecordPath(profileId))
    const sidecars = await this.profileSidecars(profileId)
    const digest = await this.profileDigest(profileId, sidecars)
    let record: ProfileOwnerRecord
    if (held === undefined) {
      record = { schemaVersion: 1, profileId, revision: 0, digest }
      await writeCanonicalAtomic(this.profileRecordPath(profileId), record)
    } else {
      if (!plain(held) || held.schemaVersion !== 1 || held.profileId !== profileId
        || !Number.isSafeInteger(held.revision) || typeof held.digest !== 'string') {
        throw new Error('managed Plugin profile owner record is invalid')
      }
      record = held as unknown as ProfileOwnerRecord
      if (record.digest !== digest) {
        record = { ...record, revision: record.revision + 1, digest }
        await writeCanonicalAtomic(this.profileRecordPath(profileId), record)
      }
    }
    const pending = sidecars.some(item => item.restartPending)
    return Object.freeze({
      profileId,
      revision: record.revision,
      digest: record.digest,
      materialRoot: safeChild(this.root, 'material', 'plugins'),
      bootStatus: pending ? 'pending-restart' : sidecars.length === 0 ? 'live' : 'verified',
      ownerRevision: `managed-plugin:${String(record.revision)}:${record.digest}`,
    })
  }

  private async advanceProfile(profileId: string): Promise<void> {
    const prior = await this.readSnapshot(profileId)
    const sidecars = await this.profileSidecars(profileId)
    const digest = await this.profileDigest(profileId, sidecars)
    const record: ProfileOwnerRecord = {
      schemaVersion: 1,
      profileId,
      revision: prior.digest === digest ? prior.revision : prior.revision + 1,
      digest,
    }
    await writeCanonicalAtomic(this.profileRecordPath(profileId), record)
  }

  private async profileDigest(profileId: string, sidecars: readonly ManagedPluginSidecar[]): Promise<`sha256:${string}`> {
    const official = await this.officialProfileObservation(profileId, sidecars)
    return canonicalSha256({
      sidecars: sidecars.map(item => ({ targetKey: item.targetKey, revision: item.revision, managed: item.managed })),
      official,
    })
  }

  private async stableOfficialObservation(
    profileId: string,
    packageName: string,
    phase: 'before' | 'after',
    mutation: Readonly<{ operationId: string; targetKey: string }> | null = null,
  ): Promise<OfficialProfileObservation> {
    const sidecars = await this.profileSidecars(profileId)
    const first = await this.officialProfileObservation(profileId, sidecars)
    const second = await this.officialProfileObservation(profileId, sidecars)
    if (canonicalSha256(first) !== canonicalSha256(second)) {
      await this.failAmbiguous(
        profileId, packageName, `official Profile did not stabilize ${phase} CLI mutation`, first, second, undefined, mutation,
      )
    }
    return second
  }

  private async assertNoAmbiguity(): Promise<void> {
    const directory = this.quarantineRoot()
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/u.test(entry.name))) {
      throw new Error('managed Plugin Profile quarantine directory contains foreign state')
    }
    for (const entry of entries) {
      const record = this.decodeQuarantine(await readCanonicalOptional(join(directory, entry.name)))
      if (`${storageKey(record.profileId)}.json` !== entry.name) {
        throw new Error('managed Plugin Profile quarantine filename does not bind its profile')
      }
    }
    if (entries.length > 0) throw new OfficialProfileAmbiguityError('managed Plugin has unresolved official Profile quarantine')
  }

  private async assertProfileNoAmbiguity(profileId: string): Promise<void> {
    const value = await readCanonicalOptional(this.quarantinePath(profileId))
    if (value !== undefined) {
      this.decodeQuarantine(value)
      throw new OfficialProfileAmbiguityError('managed Plugin profile has unresolved official Profile quarantine')
    }
  }

  private async failAmbiguous(
    profileId: string,
    packageName: string,
    reason: string,
    before: OfficialProfileObservation,
    after: OfficialProfileObservation,
    cause?: unknown,
    mutation: Readonly<{ operationId: string; targetKey: string }> | null = null,
  ): Promise<never> {
    const record: ProfileQuarantineRecord = {
      schemaVersion: 1,
      profileId,
      packageName,
      operationId: mutation?.operationId ?? null,
      targetKey: mutation?.targetKey ?? null,
      centerRoot: this.root,
      beforeDigest: canonicalSha256(before),
      afterDigest: canonicalSha256(after),
      reason,
      createdAtMs: Date.now(),
    }
    try {
      await writeCanonicalExclusive(this.quarantinePath(profileId), record)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    throw new OfficialProfileAmbiguityError(reason, cause === undefined ? undefined : { cause })
  }

  private decodeQuarantine(value: unknown): ProfileQuarantineRecord {
    if (!plain(value) || Object.keys(value).sort().join(',') !== [
      'afterDigest', 'beforeDigest', 'centerRoot', 'createdAtMs', 'operationId', 'packageName', 'profileId', 'reason',
      'schemaVersion', 'targetKey',
    ].join(',') || value.schemaVersion !== 1 || typeof value.profileId !== 'string'
      || typeof value.packageName !== 'string' || typeof value.centerRoot !== 'string'
      || (value.operationId !== null && (typeof value.operationId !== 'string' || value.operationId.length === 0))
      || (value.targetKey !== null && (typeof value.targetKey !== 'string' || value.targetKey.length === 0))
      || (value.operationId === null) !== (value.targetKey === null)
      || resolve(value.centerRoot) !== value.centerRoot
      || typeof value.beforeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.beforeDigest)
      || typeof value.afterDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.afterDigest)
      || typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 512
      || !Number.isSafeInteger(value.createdAtMs) || (value.createdAtMs as number) < 0) {
      throw new Error('managed Plugin Profile quarantine record is invalid')
    }
    const profileId = profileSegment(value.profileId)
    packageSegments(value.packageName)
    return Object.freeze({
      schemaVersion: 1,
      profileId,
      packageName: value.packageName,
      operationId: value.operationId,
      targetKey: value.targetKey,
      centerRoot: value.centerRoot,
      beforeDigest: value.beforeDigest as `sha256:${string}`,
      afterDigest: value.afterDigest as `sha256:${string}`,
      reason: value.reason,
      createdAtMs: value.createdAtMs as number,
    })
  }

  private quarantinePath(profileId: string): string {
    return safeChild(this.quarantineRoot(), `${storageKey(profileSegment(profileId))}.json`)
  }

  private async officialProfileObservation(
    profileId: string,
    sidecars: readonly ManagedPluginSidecar[],
  ): Promise<OfficialProfileObservation> {
    const profile = await this.profilePath(profileId)
    const manifestPath = safeChild(profile, 'package.json')
    const manifestFile = await regularDigest(manifestPath, 'sha256')
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!plain(manifest)) throw new Error('selected Plugin Profile manifest is invalid')
    const dependencyRecord = manifest.dependencies === undefined ? Object.freeze({}) : manifest.dependencies
    if (!plain(dependencyRecord) || Object.values(dependencyRecord).some(value => typeof value !== 'string')) {
      throw new Error('selected Plugin Profile dependencies are invalid')
    }
    const dsh = manifest.dsh === undefined ? null : manifest.dsh
    if (dsh !== null && !plain(dsh)) throw new Error('selected Plugin Profile dsh metadata is invalid')
    const profileMetadata = dsh === null || dsh.profile === undefined ? null : dsh.profile
    if (profileMetadata !== null && !plain(profileMetadata)) {
      throw new Error('selected Plugin Profile bundle metadata is invalid')
    }
    const bundles = profileMetadata === null || profileMetadata.bundles === undefined ? [] : profileMetadata.bundles
    if (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string')) {
      throw new Error('selected Plugin Profile bundle list is invalid')
    }
    const lockPath = safeChild(profile, 'pnpm-lock.yaml')
    const lockInfo = await existingInfo(lockPath)
    let lockDigest: `sha256:${string}` | null = null
    let lock: Readonly<Record<string, unknown>> | null = null
    if (lockInfo !== null) {
      const observed = await regularDigest(lockPath, 'sha256')
      lockDigest = `sha256:${observed.digest}`
      lock = decodePnpmLock(await readFile(lockPath, 'utf8'))
    }
    const installed: Array<OfficialProfileObservation['installed'][number]> = []
    for (const sidecar of sidecars) {
      const packagePath = await this.profilePackagePath(profileId, sidecar.packageName)
      const packageInfo = await existingInfo(packagePath)
      let treeDigest: `sha256:${string}` | null = null
      if (packageInfo !== null) {
        const packageRoot = await realpath(packagePath).catch((cause: unknown) => {
          throw new Error('managed Plugin official Profile package path is unresolved', { cause })
        })
        const rootInfo = await lstat(packageRoot)
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
          throw new Error('managed Plugin official Profile package root is invalid')
        }
        treeDigest = canonicalSha256(await fileEvidence(packageRoot))
      }
      installed.push(Object.freeze({
        targetKey: sidecar.targetKey,
        packageName: sidecar.packageName,
        treeDigest,
      }))
    }
    return Object.freeze({
      manifest: immutableJsonClone(manifest) as Readonly<Record<string, unknown>>,
      manifestDigest: `sha256:${manifestFile.digest}`,
      lockDigest,
      lock,
      dependencies: Object.freeze(Object.entries(dependencyRecord).sort(([left], [right]) => left.localeCompare(right))
        .map(([name, spec]) => Object.freeze({ name, spec: spec as string }))),
      bundles: Object.freeze([...(bundles as string[])]),
      installed: Object.freeze(installed),
    })
  }

  private async profileSidecars(profileId: string): Promise<readonly ManagedPluginSidecar[]> {
    const directory = safeChild(this.root, 'plugin', 'profiles', storageKey(profileId), 'packages')
    const info = await existingInfo(directory)
    if (info === null) return Object.freeze([])
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('managed Plugin sidecar directory is invalid')
    const output: ManagedPluginSidecar[] = []
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
        throw new Error('managed Plugin sidecar directory contains foreign state')
      }
      const value = await readCanonicalOptional(join(directory, entry.name))
      if (!plain(value) || typeof value.targetKey !== 'string' || storageKey(value.targetKey) + '.json' !== entry.name) {
        throw new Error('managed Plugin sidecar filename does not bind its target')
      }
      output.push((await this.readSidecar(profileId, value.targetKey))!)
    }
    return Object.freeze(output)
  }

  private async withProfileLock<T>(profileId: string, action: () => Promise<T>): Promise<T> {
    const safeProfile = profileSegment(profileId)
    await this.assertProfileNoAmbiguity(safeProfile)
    await this.assertNoProfileTakeover(safeProfile)
    const locks = this.leaseRoot()
    await ensurePrivateDirectory(locks)
    const destination = safeChild(locks, storageKey(safeProfile))
    const temporary = safeChild(locks, `.lock-${randomUUID()}`)
    const record: ProfileLockRecord = {
      schemaVersion: 2,
      profileId: safeProfile,
      ownerId: this.ownerId,
      leaseId: `lease:${randomUUID()}`,
      processIdentity: await this.currentProcessIdentity(),
      acquiredAtMs: Date.now(),
    }
    await mkdir(temporary, { mode: 0o700 })
    let installed = false
    try {
      await writeCanonicalExclusive(join(temporary, 'owner.json'), record)
      await rename(temporary, destination)
      installed = true
      await syncDirectory(locks)
      try {
        await this.assertNoProfileTakeover(safeProfile)
      } catch (error: unknown) {
        const raced = decodeProfileLock(await readCanonicalOptional(join(destination, 'owner.json')))
        if (sameProfileLock(raced, record)) {
          await rm(destination, { recursive: true })
          await syncDirectory(locks)
        }
        throw error
      }
    } catch (error: unknown) {
      await rm(temporary, { recursive: true, force: true })
      if (installed) throw error
      if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new Error(`managed Plugin profile is busy: ${safeProfile}`)
      }
      throw error
    }
    try {
      await this.assertProfileNoAmbiguity(safeProfile)
      return await action()
    } finally {
      const owner = decodeProfileLock(await readCanonicalOptional(join(destination, 'owner.json')))
      if (!sameProfileLock(owner, record)) throw new Error('managed Plugin profile lock ownership changed')
      if (await readCanonicalOptional(join(destination, 'execution.json')) !== undefined) {
        throw new Error('managed Plugin profile execution subtree has not reached quiescence')
      }
      await this.assertNoProfileTakeover(safeProfile)
      await rm(destination, { recursive: true })
      await syncDirectory(locks)
    }
  }

  private async recoverStaleLocks(): Promise<void> {
    await this.resumeProfileTakeovers()
    const locks = this.leaseRoot()
    for (const entry of await readdir(locks, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f]{64}$/u.test(entry.name)) {
        throw new Error('managed Plugin lock directory contains foreign state')
      }
      const path = join(locks, entry.name)
      const owner = decodeProfileLock(await readCanonicalOptional(join(path, 'owner.json')))
      await this.recoverProfileLock(path, owner)
    }
  }

  private async recoverProfileLock(path: string, owner: ProfileLockRecord): Promise<void> {
    await this.assertProfileOwnerDead(path, owner)
    const gate = await this.acquireProfileTakeover(owner)
    const current = decodeProfileLock(await readCanonicalOptional(join(path, 'owner.json')))
    if (!sameProfileLock(current, owner)) throw new Error('managed Plugin profile lock changed during stale recovery')
    await this.assertProfileOwnerDead(path, current)
    const targetRoot = safeChild(this.leaseQuarantineRoot(), storageKey(owner.profileId))
    await ensurePrivateDirectory(targetRoot)
    const quarantine = safeChild(targetRoot, gate.quarantineId.slice('quarantine:'.length))
    await rename(path, quarantine)
    await syncDirectory(this.leaseRoot())
    await syncDirectory(targetRoot)
    const moved = decodeProfileLock(await readCanonicalOptional(join(quarantine, 'owner.json')))
    if (!sameProfileLock(moved, owner)) throw new Error('managed Plugin profile quarantine changed during stale recovery')
    await this.assertProfileOwnerDead(quarantine, moved)
    await this.assertProfileTakeoverOwned(gate)
    await rm(targetRoot, { recursive: true })
    await syncDirectory(this.leaseQuarantineRoot())
    await this.removeProfileTakeover(gate)
  }

  private async assertProfileOwnerDead(path: string, owner: ProfileLockRecord): Promise<void> {
    const status = await inspectProcessIdentity(owner.processIdentity)
    if (status === 'alive') throw new Error(`managed Plugin profile is owned by live process ${String(owner.processIdentity.pid)}`)
    if (status === 'unknown') throw new Error('managed Plugin profile owner identity cannot be verified; manual recovery is required')
    const executionValue = await readCanonicalOptional(join(path, 'execution.json'))
    if (executionValue === undefined) return
    const execution = decodeProfileExecution(executionValue, {
      profileId: owner.profileId,
      ownerId: owner.ownerId,
      processIdentity: owner.processIdentity,
    })
    const group = processGroupStatus(execution.processGroupPid)
    if (group === 'alive') throw new Error(`managed Plugin profile has a live official CLI subtree ${String(execution.processGroupPid)}`)
    if (group === 'unknown') throw new Error('managed Plugin profile CLI subtree cannot be verified; manual recovery is required')
  }

  private async acquireProfileTakeover(owner: ProfileLockRecord): Promise<ProfileTakeoverRecord> {
    const root = this.leaseTakeoverRoot()
    await ensurePrivateDirectory(root)
    const destination = safeChild(root, storageKey(owner.profileId))
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await this.readProfileTakeover(destination)
      if (existing !== undefined) {
        const interrupted = existing.claimantOwnerId === owner.ownerId
          && this.sameProcessIdentity(existing.claimantProcessIdentity, owner.processIdentity)
        const sourceMatches = existing.sourceLeaseId === owner.leaseId
          && existing.sourceOwnerDigest === canonicalSha256(owner)
        if (existing.profileId !== owner.profileId || !sourceMatches && !interrupted) {
          throw new Error('managed Plugin profile takeover does not bind its current owner')
        }
        if (await inspectProcessIdentity(existing.claimantProcessIdentity) !== 'dead') {
          throw new Error('managed Plugin profile stale recovery is already owned by a live or unverifiable Host')
        }
        const retired = safeChild(root, `.retired-${randomUUID()}`)
        try {
          await rename(destination, retired)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        await syncDirectory(root)
        try {
          const record = await this.installProfileTakeover(
            root,
            destination,
            owner,
            sourceMatches ? existing.quarantineId : undefined,
          )
          await this.removeExactProfileTakeoverPath(retired, existing)
          return record
        } catch (error: unknown) {
          if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
          throw error
        }
      }
      try {
        return await this.installProfileTakeover(root, destination, owner)
      } catch (error: unknown) {
        if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
        throw error
      }
    }
    throw new Error('managed Plugin profile stale recovery contention requires manual recovery')
  }

  private async resumeProfileTakeovers(): Promise<void> {
    const root = this.leaseTakeoverRoot()
    await ensurePrivateDirectory(root)
    const entries = await this.listProfileTakeovers()
    const blockedProfiles = new Set<string>()
    for (const entry of entries) {
      if (await inspectProcessIdentity(entry.record.claimantProcessIdentity) !== 'dead') {
        blockedProfiles.add(entry.record.profileId)
      }
    }
    for (const entry of entries) {
      const gate = entry.record
      if (blockedProfiles.has(gate.profileId)) continue
      const leasePath = safeChild(this.leaseRoot(), storageKey(gate.profileId))
      const leaseValue = await readCanonicalOptional(join(leasePath, 'owner.json'))
      if (leaseValue !== undefined) {
        await this.recoverProfileLock(leasePath, decodeProfileLock(leaseValue))
        continue
      }
      const quarantine = safeChild(
        this.leaseQuarantineRoot(),
        storageKey(gate.profileId),
        gate.quarantineId.slice('quarantine:'.length),
      )
      const quarantinedValue = await readCanonicalOptional(join(quarantine, 'owner.json'))
      if (quarantinedValue !== undefined) {
        const owner = decodeProfileLock(quarantinedValue)
        if (owner.profileId !== gate.profileId || owner.leaseId !== gate.sourceLeaseId
          || canonicalSha256(owner) !== gate.sourceOwnerDigest) {
          throw new Error('managed Plugin profile quarantine does not bind its takeover')
        }
        await this.assertProfileOwnerDead(quarantine, owner)
        const replacement = await this.acquireProfileTakeover(owner)
        const reread = decodeProfileLock(await readCanonicalOptional(join(quarantine, 'owner.json')))
        if (!sameProfileLock(reread, owner)) {
          throw new Error('managed Plugin profile quarantine changed during stale recovery')
        }
        await this.assertProfileOwnerDead(quarantine, reread)
        const finalOwner = decodeProfileLock(await readCanonicalOptional(join(quarantine, 'owner.json')))
        if (!sameProfileLock(finalOwner, reread)) {
          throw new Error('managed Plugin profile quarantine changed during stale recovery')
        }
        await this.assertProfileOwnerDead(quarantine, finalOwner)
        await this.assertProfileTakeoverOwned(replacement)
        await rm(safeChild(this.leaseQuarantineRoot(), storageKey(gate.profileId)), { recursive: true })
        await syncDirectory(this.leaseQuarantineRoot())
        await this.removeProfileTakeover(replacement)
      } else {
        if (entry.canonical) await this.removeProfileTakeover(gate)
        else await this.removeExactProfileTakeoverPath(entry.path, gate)
      }
    }
  }

  private async assertNoProfileTakeover(profileId: string): Promise<void> {
    const gate = await existingInfo(safeChild(this.leaseTakeoverRoot(), storageKey(profileId)))
    const quarantine = await existingInfo(safeChild(this.leaseQuarantineRoot(), storageKey(profileId)))
    if (gate !== null || quarantine !== null) throw new Error(`managed Plugin profile is busy: ${profileId}`)
  }

  private async removeProfileTakeover(record: ProfileTakeoverRecord): Promise<void> {
    const path = safeChild(this.leaseTakeoverRoot(), storageKey(record.profileId))
    const current = await this.readProfileTakeover(path)
    if (current === undefined || current.takeoverId !== record.takeoverId
      || canonicalSha256(current) !== canonicalSha256(record)) {
      throw new Error('managed Plugin profile takeover ownership changed')
    }
    await rm(path, { recursive: true })
    await this.removeRetiredProfileTakeovers(record.profileId)
    await syncDirectory(this.leaseTakeoverRoot())
  }

  private async installProfileTakeover(
    root: string,
    destination: string,
    owner: ProfileLockRecord,
    quarantineId = `quarantine:${randomUUID()}`,
  ): Promise<ProfileTakeoverRecord> {
    const temporary = safeChild(root, `.takeover-${randomUUID()}`)
    const record: ProfileTakeoverRecord = Object.freeze({
      schemaVersion: 1,
      profileId: owner.profileId,
      sourceLeaseId: owner.leaseId,
      sourceOwnerDigest: canonicalSha256(owner),
      quarantineId,
      takeoverId: `takeover:${randomUUID()}`,
      claimantOwnerId: this.ownerId,
      claimantProcessIdentity: await this.currentProcessIdentity(),
      claimedAtMs: Date.now(),
    })
    await mkdir(temporary, { mode: 0o700 })
    try {
      await writeCanonicalExclusive(join(temporary, 'record.json'), record)
      await rename(temporary, destination)
      await syncDirectory(root)
      return record
    } catch (error: unknown) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }

  private async listProfileTakeovers(): Promise<readonly ProfileTakeoverEntry[]> {
    const root = this.leaseTakeoverRoot()
    const output: ProfileTakeoverEntry[] = []
    for (const entry of (await readdir(root, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const canonical = /^[0-9a-f]{64}$/u.test(entry.name)
      const retired = /^\.retired-[0-9a-f-]{36}$/u.test(entry.name)
      if (!entry.isDirectory() || !canonical && !retired) continue
      const path = safeChild(root, entry.name)
      const record = await this.readProfileTakeover(path)
      if (record === undefined || canonical && storageKey(record.profileId) !== entry.name) {
        throw new Error('managed Plugin profile takeover is corrupt')
      }
      output.push(Object.freeze({ path, canonical, record }))
    }
    return Object.freeze(output)
  }

  private async removeExactProfileTakeoverPath(path: string, expected: ProfileTakeoverRecord): Promise<void> {
    const current = await this.readProfileTakeover(path)
    if (current === undefined) return
    if (current.takeoverId !== expected.takeoverId || canonicalSha256(current) !== canonicalSha256(expected)) {
      throw new Error('managed Plugin profile retired takeover ownership changed')
    }
    await rm(path, { recursive: true })
    await syncDirectory(this.leaseTakeoverRoot())
  }

  private async removeRetiredProfileTakeovers(profileId: string): Promise<void> {
    const root = this.leaseTakeoverRoot()
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\.retired-[0-9a-f-]{36}$/u.test(entry.name)) continue
      const path = safeChild(root, entry.name)
      const record = await this.readProfileTakeover(path)
      if (record?.profileId === profileId) await this.removeExactProfileTakeoverPath(path, record)
    }
  }

  private async assertProfileTakeoverOwned(record: ProfileTakeoverRecord): Promise<void> {
    const current = await this.readProfileTakeover(
      safeChild(this.leaseTakeoverRoot(), storageKey(record.profileId)),
    )
    if (current === undefined || current.takeoverId !== record.takeoverId
      || canonicalSha256(current) !== canonicalSha256(record)) {
      throw new Error('managed Plugin profile takeover ownership changed')
    }
  }

  private async readProfileTakeover(path: string): Promise<ProfileTakeoverRecord | undefined> {
    const value = await readCanonicalOptional(join(path, 'record.json'))
    if (value === undefined) return undefined
    if (!plain(value) || Object.keys(value).sort().join(',') !== [
      'claimantOwnerId', 'claimantProcessIdentity', 'claimedAtMs', 'profileId', 'quarantineId', 'schemaVersion',
      'sourceLeaseId', 'sourceOwnerDigest', 'takeoverId',
    ].join(',') || value.schemaVersion !== 1 || typeof value.profileId !== 'string'
      || typeof value.sourceLeaseId !== 'string' || !/^lease:[0-9a-f-]{36}$/u.test(value.sourceLeaseId)
      || typeof value.sourceOwnerDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.sourceOwnerDigest)
      || typeof value.quarantineId !== 'string' || !/^quarantine:[0-9a-f-]{36}$/u.test(value.quarantineId)
      || typeof value.takeoverId !== 'string' || !/^takeover:[0-9a-f-]{36}$/u.test(value.takeoverId)
      || typeof value.claimantOwnerId !== 'string' || value.claimantOwnerId.length === 0
      || !Number.isSafeInteger(value.claimedAtMs)) throw new Error('managed Plugin profile takeover is invalid')
    return Object.freeze({
      schemaVersion: 1,
      profileId: profileSegment(value.profileId),
      sourceLeaseId: value.sourceLeaseId,
      sourceOwnerDigest: value.sourceOwnerDigest as `sha256:${string}`,
      quarantineId: value.quarantineId,
      takeoverId: value.takeoverId,
      claimantOwnerId: value.claimantOwnerId,
      claimantProcessIdentity: decodeProcessIdentity(value.claimantProcessIdentity, 'managed Plugin profile takeover claimant'),
      claimedAtMs: value.claimedAtMs as number,
    })
  }

  private currentProcessIdentity(): Promise<ProcessIdentity> {
    this.processIdentity ??= captureCurrentProcessIdentity()
    return this.processIdentity
  }

  private sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
    return left.schemaVersion === right.schemaVersion && left.pid === right.pid && left.platform === right.platform
      && left.machineDigest === right.machineDigest && left.bootDigest === right.bootDigest
      && left.birthDigest === right.birthDigest
  }

  private leaseRoot(): string {
    return safeChild(this.coordinationRoot(), 'leases')
  }

  private leaseTakeoverRoot(): string {
    return safeChild(this.coordinationRoot(), 'lease-takeovers')
  }

  private leaseQuarantineRoot(): string {
    return safeChild(this.coordinationRoot(), 'lease-quarantine')
  }

  private quarantineRoot(): string {
    return safeChild(this.coordinationRoot(), 'quarantine')
  }

  private coordinationRoot(): string {
    return safeChild(this.hostHome, '.extension-center-plugin-coordination')
  }

  private operationKind(record: ManagedTargetRecord): 'install' | 'configure' | 'update' | 'uninstall' | 'restore' | 'rollback' {
    if (!plain(record.pending) || typeof record.pending.operationKind !== 'string'
      || !['install', 'configure', 'update', 'uninstall', 'restore', 'rollback'].includes(record.pending.operationKind)) {
      throw new Error('managed Plugin desired state has no exact operation kind')
    }
    return record.pending.operationKind as 'install' | 'configure' | 'update' | 'uninstall' | 'restore' | 'rollback'
  }

  private packageName(record: ManagedTargetRecord): string {
    const version = record.current ?? record.removed ?? record.lastGood
    if (version === null) throw new Error('managed Plugin record has no retained package identity')
    const state = version.kindState as Readonly<Record<string, RpcJson>>
    return readString(state.packageName, 'packageName')
  }

  private profileFromTarget(targetKey: string): string {
    const parts = targetKey.split(':')
    if (parts.length < 2 || parts[0] !== 'plugin') throw new Error('managed Plugin target key is invalid')
    return profileSegment(parts[1]!)
  }

  private assertNotSelf(packageName: string): void {
    if (packageName === this.centerPackageName) {
      throw new Error('the Extension Center cannot manage its own Plugin package')
    }
  }
}

async function inspectNpmArchiveFromMaterial(
  marker: ManagedPluginMaterialMarker,
  manifestBody: string,
): Promise<Readonly<{ manifestBody: string }>> {
  const manifest: unknown = JSON.parse(manifestBody)
  if (!plain(manifest) || canonicalSha256(manifest) !== marker.manifestDigest) {
    throw new Error('managed Plugin immutable manifest changed')
  }
  return Object.freeze({ manifestBody: JSON.stringify(manifest) })
}
