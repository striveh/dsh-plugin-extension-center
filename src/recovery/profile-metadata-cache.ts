/** Content-addressed pnpm 11 registry metadata synthesized from one installed official Profile generation. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import { canonicalJson, canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type { OfficialDshRecoveryBinding } from '../plans/types.ts'

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_LOCK_BYTES = 32 * 1024 * 1024
const MAX_MODULES_BYTES = 1024 * 1024
const MAX_CACHE_FILE_BYTES = 32 * 1024 * 1024
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const PNPM_11 = /^pnpm@11\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
const REGISTRY = 'https://registry.npmjs.org/'

/** One content-addressed metadata-cache generation verified by normal and break-glass official CLI paths. */
export interface ProfileMetadataCacheBinding {
  readonly schemaVersion: 1
  readonly profileId: string
  readonly profilePath: string
  readonly generationPath: string
  readonly generationSha256: `sha256:${string}`
  readonly cachePath: string
  readonly manifestPath: string
  readonly manifestSha256: `sha256:${string}`
  readonly profileManifestSha256: `sha256:${string}`
  readonly lockfileSha256: `sha256:${string}` | null
  readonly modulesSha256: `sha256:${string}` | null
  readonly sourcePnpmVersion: string | null
  readonly storeDir: string
  readonly expectedStoreDir: string
  readonly pnpmMajor: 11
  readonly pnpmVersion: '11.7.0'
}

interface CacheFile {
  readonly path: string
  readonly sizeBytes: number
  readonly sha256: `sha256:${string}`
}

interface CacheManifest extends Omit<ProfileMetadataCacheBinding, 'manifestSha256'> {
  readonly files: readonly CacheFile[]
}

interface ProfileSource {
  readonly profilePath: string
  readonly profileManifestSha256: `sha256:${string}`
  readonly lockfileSha256: `sha256:${string}` | null
  readonly modulesSha256: `sha256:${string}` | null
  readonly sourcePnpmVersion: string | null
  readonly storeDir: string
  readonly expectedStoreDir: string
  readonly metadata: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

function fail(message: string): never {
  throw new Error(message)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function profileSegment(value: string): string {
  if (value.length === 0 || value.length > 256 || value.includes('/') || value.includes('\\')
    || value.includes(':') || value.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(value)
    || value === '.' || value === '..' || value === 'node_modules') {
    fail(`official DSH metadata cache profile id is unsafe: ${value}`)
  }
  return value
}

function below(root: string, child: string): boolean {
  const value = relative(resolve(root), resolve(child))
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`)
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function readRegular(path: string, label: string, maximumBytes: number): Promise<Buffer> {
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

async function readOptionalRegular(path: string, label: string, maximumBytes: number): Promise<Buffer | null> {
  try {
    return await readRegular(path, label, maximumBytes)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function ensurePrivate(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const [canonical, info] = await Promise.all([realpath(path), lstat(path)])
  if (canonical !== path || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail(`official DSH metadata cache directory is unsafe: ${path}`)
  }
}

function decodeJson(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown
  } catch (cause) {
    throw new Error(`${label} is invalid JSON`, { cause })
  }
  if (!plain(value)) fail(`${label} must be an object`)
  return value
}

function decodeLock(bytes: Buffer): Record<string, unknown> {
  const document = parseDocument(bytes.toString('utf8'), { schema: 'core', strict: true, uniqueKeys: true })
  if (document.errors.length > 0 || document.warnings.length > 0) {
    fail('official DSH Profile pnpm lockfile is not unambiguous YAML')
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 })
  if (!plain(value) || !['9.0', 9].includes(value.lockfileVersion as string | number)
    || !plain(value.importers) || !plain(value.importers['.'])
    || !plain(value.packages) || !plain(value.snapshots)) {
    fail('official DSH Profile pnpm lockfile is incompatible with pinned pnpm 11')
  }
  return value
}

function packageKey(value: string): Readonly<{ name: string; version: string }> | null {
  const peer = value.indexOf('(')
  const base = peer < 0 ? value : value.slice(0, peer)
  const separator = base.startsWith('@') ? base.indexOf('@', base.indexOf('/') + 1) : base.indexOf('@')
  if (separator < 1) return null
  const name = base.slice(0, separator)
  const version = base.slice(separator + 1)
  return PACKAGE_NAME.test(name) && EXACT_VERSION.test(version) ? Object.freeze({ name, version }) : null
}

function dependencyVersion(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (plain(value) && typeof value.version === 'string') return value.version
  return null
}

function safeMap(value: unknown, label: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (!plain(value) || Object.keys(value).length > 4_096) fail(`${label} is invalid`)
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value).sort(([left], [right]) => compareText(left, right))) {
    if (!PACKAGE_NAME.test(key) || typeof item !== 'string' || item.length === 0 || item.length > 512) fail(`${label} is invalid`)
    output[key] = item
  }
  return Object.freeze(output)
}

function packageTarball(name: string, version: string): string {
  const leaf = name.slice(name.lastIndexOf('/') + 1)
  return `${REGISTRY}${name}/-/${leaf}-${version}.tgz`
}

async function installedManifest(
  profilePath: string,
  locations: Record<string, unknown>,
  snapshotKey: string,
  name: string,
  version: string,
): Promise<Readonly<{
  sha256: `sha256:${string}`
  dependencies?: Readonly<Record<string, string>>
  optionalDependencies?: Readonly<Record<string, string>>
  peerDependencies?: Readonly<Record<string, string>>
  bin?: unknown
}> | null> {
  const held = locations[snapshotKey]
  if (!Array.isArray(held) || held.length === 0 || held.some(item => typeof item !== 'string')) return null
  const candidates = [...new Set(held as string[])].sort(compareText)
  for (const location of candidates) {
    if (isAbsolute(location) || location.includes('\0')) fail('official DSH Profile pnpm hoisted location is unsafe')
    const path = resolve(profilePath, location, 'package.json')
    if (!below(profilePath, path)) fail('official DSH Profile pnpm hoisted location escapes the Profile')
    let bytes: Buffer
    try {
      bytes = await readRegular(path, `installed registry package ${name}`, MAX_MANIFEST_BYTES)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const manifest = decodeJson(bytes, `installed registry package ${name} manifest`)
    if (manifest.name !== name || manifest.version !== version) fail(`installed registry package ${name} identity changed`)
    return Object.freeze({
      sha256: digest(bytes),
      dependencies: safeMap(manifest.dependencies, `installed registry package ${name} manifest.dependencies`),
      optionalDependencies: safeMap(
        manifest.optionalDependencies,
        `installed registry package ${name} manifest.optionalDependencies`,
      ),
      peerDependencies: safeMap(
        manifest.peerDependencies,
        `installed registry package ${name} manifest.peerDependencies`,
      ),
      bin: manifest.bin,
    })
  }
  return null
}

function lockPackage(packages: Record<string, unknown>, name: string, version: string): Record<string, unknown> {
  const value = packages[`${name}@${version}`]
  if (!plain(value) || !plain(value.resolution) || typeof value.resolution.integrity !== 'string') {
    fail(`official DSH Profile pnpm lockfile has no exact integrity for ${name}@${version}`)
  }
  const matched = /^(sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(value.resolution.integrity)
  if (matched === null) fail(`official DSH Profile pnpm lockfile has no exact integrity for ${name}@${version}`)
  const bytes = Buffer.from(matched[2]!, 'base64')
  const expectedBytes = matched[1] === 'sha256' ? 32 : 64
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== matched[2]) {
    fail(`official DSH Profile pnpm lockfile integrity is non-canonical for ${name}@${version}`)
  }
  return value
}

async function registryMetadata(
  profilePath: string,
  lock: Record<string, unknown>,
  modules: Record<string, unknown>,
): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>> {
  const packages = lock.packages as Record<string, unknown>
  const snapshots = lock.snapshots as Record<string, unknown>
  const importer = (lock.importers as Record<string, unknown>)['.'] as Record<string, unknown>
  const locations = modules.hoistedLocations
  if (!plain(locations)) fail('official DSH Profile pnpm modules metadata hoistedLocations is invalid')
  const pending: string[] = []
  for (const group of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    const dependencies = importer[group]
    if (dependencies === undefined) continue
    if (!plain(dependencies)) fail('official DSH Profile pnpm lockfile importer dependency group is invalid')
    for (const [name, value] of Object.entries(dependencies)) {
      const version = dependencyVersion(value)
      if (!PACKAGE_NAME.test(name) || version === null) fail('official DSH Profile pnpm lockfile importer dependency is invalid')
      const snapshotKey = `${name}@${version}`
      if (Object.hasOwn(snapshots, snapshotKey) || packageKey(snapshotKey) !== null) pending.push(snapshotKey)
    }
  }
  const visited = new Set<string>()
  const versions = new Map<string, Map<string, Readonly<Record<string, unknown>>>>()
  while (pending.length > 0) {
    const snapshotKey = pending.shift()!
    if (visited.has(snapshotKey)) continue
    visited.add(snapshotKey)
    const snapshot = snapshots[snapshotKey]
    if (!plain(snapshot)) fail(`official DSH Profile pnpm lockfile snapshot is missing: ${snapshotKey}`)
    for (const group of ['dependencies', 'optionalDependencies']) {
      const dependencies = snapshot[group]
      if (dependencies === undefined) continue
      if (!plain(dependencies)) fail(`official DSH Profile pnpm lockfile ${snapshotKey} dependency group is invalid`)
      for (const [name, value] of Object.entries(dependencies)) {
        const version = dependencyVersion(value)
        if (!PACKAGE_NAME.test(name) || version === null) fail(`official DSH Profile pnpm lockfile ${snapshotKey} dependency is invalid`)
        const dependencyKey = `${name}@${version}`
        if (Object.hasOwn(snapshots, dependencyKey) || packageKey(dependencyKey) !== null) pending.push(dependencyKey)
      }
    }
    const parsed = packageKey(snapshotKey)
    if (parsed === null) continue
    const packageRecord = lockPackage(packages, parsed.name, parsed.version)
    const manifest = await installedManifest(profilePath, locations, snapshotKey, parsed.name, parsed.version)
    if (manifest === null) {
      fail(`official DSH Profile has no exact installed manifest for registry package ${snapshotKey}`)
    }
    const resolution = packageRecord.resolution as Record<string, unknown>
    const metadata: Record<string, unknown> = {
      name: parsed.name,
      version: parsed.version,
      dist: {
        integrity: resolution.integrity,
        tarball: typeof resolution.tarball === 'string' ? resolution.tarball : packageTarball(parsed.name, parsed.version),
      },
    }
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      const map = manifest[group]
      if (map !== undefined && Object.keys(map).length > 0) metadata[group] = map
    }
    for (const group of ['peerDependenciesMeta', 'engines', 'os', 'cpu', 'libc'] as const) {
      if (packageRecord[group] !== undefined) metadata[group] = packageRecord[group]
    }
    if (manifest.bin !== undefined) metadata.bin = manifest.bin
    metadata._extensionCenterInstalledManifestSha256 = manifest.sha256
    const held = versions.get(parsed.name) ?? new Map<string, Readonly<Record<string, unknown>>>()
    const prior = held.get(parsed.version)
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(metadata)) {
      fail(`official DSH Profile resolves contradictory metadata for ${parsed.name}@${parsed.version}`)
    }
    held.set(parsed.version, Object.freeze(metadata))
    versions.set(parsed.name, held)
  }
  const output: Record<string, Readonly<Record<string, unknown>>> = {}
  for (const [name, held] of [...versions].sort(([left], [right]) => compareText(left, right))) {
    const ordered = Object.fromEntries([...held].sort(([left], [right]) => compareText(left, right)))
    const latest = Object.keys(ordered).at(-1)
    if (latest === undefined) continue
    output[name] = Object.freeze({ name, 'dist-tags': { latest }, versions: ordered })
  }
  return Object.freeze(output)
}

async function profileSource(binding: OfficialDshRecoveryBinding, profileId: string): Promise<ProfileSource> {
  const profilePath = join(binding.hostHome, 'profiles', profileSegment(profileId))
  const [canonical, info] = await Promise.all([realpath(profilePath), lstat(profilePath)])
  if (canonical !== profilePath || !info.isDirectory() || info.isSymbolicLink()) fail('official DSH Profile directory is unsafe')
  const manifestBytes = await readRegular(join(profilePath, 'package.json'), 'official DSH Profile manifest', MAX_MANIFEST_BYTES)
  decodeJson(manifestBytes, 'official DSH Profile manifest')
  const modulesPath = join(profilePath, 'node_modules', '.modules.yaml')
  const modulesBytes = await readOptionalRegular(modulesPath, 'official DSH Profile pnpm modules metadata', MAX_MODULES_BYTES)
  const lockBytes = await readOptionalRegular(join(profilePath, 'pnpm-lock.yaml'), 'official DSH Profile pnpm lockfile', MAX_LOCK_BYTES)
  if (modulesBytes === null) {
    if (lockBytes !== null) fail('uninstalled official DSH Profile retains a pnpm lockfile without modules metadata')
    const stores = join(binding.pnpm.runtimeRoot, 'stores')
    await ensurePrivate(stores)
    const storeDir = join(stores, createHash('sha256').update(profileId).digest('hex'))
    await ensurePrivate(storeDir)
    return Object.freeze({
      profilePath,
      profileManifestSha256: digest(manifestBytes),
      lockfileSha256: null,
      modulesSha256: null,
      sourcePnpmVersion: null,
      storeDir,
      expectedStoreDir: join(storeDir, 'v11'),
      metadata: Object.freeze({}),
    })
  }
  const modules = decodeJson(modulesBytes, 'official DSH Profile pnpm modules metadata')
  const sourcePnpmVersion = modules.packageManager
  const registry = modules.registries
  if (modules.layoutVersion !== 5 || modules.nodeLinker !== 'hoisted' || modules.virtualStoreDir !== '.pnpm'
    || typeof sourcePnpmVersion !== 'string' || !PNPM_11.test(sourcePnpmVersion)
    || !plain(registry) || registry.default !== REGISTRY) {
    fail('official DSH Profile pnpm modules metadata is incompatible with the pinned registry and pnpm 11')
  }
  const storeDir = modules.storeDir
  if (typeof storeDir !== 'string' || !isAbsolute(storeDir) || !storeDir.endsWith(`${sep}v11`)
    || storeDir.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(storeDir)) {
    fail('official DSH Profile pnpm modules metadata storeDir is unsafe')
  }
  const [canonicalStore, storeInfo] = await Promise.all([realpath(storeDir), lstat(storeDir)])
  if (canonicalStore !== storeDir || !storeInfo.isDirectory() || storeInfo.isSymbolicLink()) {
    fail('official DSH Profile pnpm modules metadata storeDir is not a canonical directory')
  }
  if (lockBytes === null) fail('installed official DSH Profile pnpm lockfile is missing')
  const lock = decodeLock(lockBytes)
  return Object.freeze({
    profilePath,
    profileManifestSha256: digest(manifestBytes),
    lockfileSha256: digest(lockBytes),
    modulesSha256: digest(modulesBytes),
    sourcePnpmVersion,
    storeDir,
    expectedStoreDir: storeDir,
    metadata: await registryMetadata(profilePath, lock, modules),
  })
}

function bindingFields(value: unknown, label: string): ProfileMetadataCacheBinding {
  if (!plain(value)) fail(`${label} must be an object`)
  const expected = [
    'cachePath', 'expectedStoreDir', 'generationPath', 'generationSha256', 'lockfileSha256', 'manifestPath',
    'manifestSha256', 'modulesSha256', 'pnpmMajor', 'pnpmVersion', 'profileId', 'profileManifestSha256',
    'profilePath', 'schemaVersion', 'sourcePnpmVersion', 'storeDir',
  ]
  if (Object.keys(value).sort(compareText).join('\0') !== expected.sort(compareText).join('\0') || value.schemaVersion !== 1
    || value.pnpmMajor !== 11 || value.pnpmVersion !== '11.7.0') fail(`${label} fields are invalid`)
  for (const field of ['profileId', 'profilePath', 'generationPath', 'cachePath', 'manifestPath', 'storeDir', 'expectedStoreDir'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0 || value[field].length > 4_096) fail(`${label}.${field} is invalid`)
  }
  for (const field of ['generationSha256', 'manifestSha256', 'profileManifestSha256'] as const) {
    if (typeof value[field] !== 'string' || !SHA256.test(value[field])) fail(`${label}.${field} is invalid`)
  }
  for (const field of ['lockfileSha256', 'modulesSha256'] as const) {
    if (value[field] !== null && (typeof value[field] !== 'string' || !SHA256.test(value[field]))) fail(`${label}.${field} is invalid`)
  }
  if (value.sourcePnpmVersion !== null && (typeof value.sourcePnpmVersion !== 'string' || !PNPM_11.test(value.sourcePnpmVersion))) {
    fail(`${label}.sourcePnpmVersion is invalid`)
  }
  profileSegment(value.profileId as string)
  if (![value.profilePath, value.generationPath, value.cachePath, value.manifestPath, value.storeDir, value.expectedStoreDir]
    .every(path => typeof path === 'string' && isAbsolute(path))) fail(`${label} paths must be absolute`)
  return immutableJsonClone(value) as unknown as ProfileMetadataCacheBinding
}

/** Strictly decode one provider-snapshot cache binding. */
export function decodeProfileMetadataCacheBinding(value: unknown, label = 'Plugin metadata cache'): ProfileMetadataCacheBinding {
  return bindingFields(value, label)
}

/** Extract one nullable cache binding from a durable Plugin provider recovery point. */
export function profileMetadataCacheFromRecoveryPoint(value: unknown): ProfileMetadataCacheBinding | null {
  if (!plain(value) || value.kind !== 'plugin') fail('Plugin recovery point cannot supply a metadata cache binding')
  return value.metadataCache === null
    ? null
    : decodeProfileMetadataCacheBinding(value.metadataCache, 'Plugin recovery point metadata cache')
}

function manifestSeed(
  source: ProfileSource,
  profileId: string,
  files: readonly CacheFile[],
): Omit<CacheManifest, 'manifestPath' | 'generationPath' | 'cachePath'> {
  const generationSha256 = canonicalSha256({
    schemaVersion: 1,
    profileId,
    profilePath: source.profilePath,
    profileManifestSha256: source.profileManifestSha256,
    lockfileSha256: source.lockfileSha256,
    modulesSha256: source.modulesSha256,
    sourcePnpmVersion: source.sourcePnpmVersion,
    storeDir: source.storeDir,
    expectedStoreDir: source.expectedStoreDir,
    pnpmMajor: 11,
    pnpmVersion: '11.7.0',
    files,
  })
  return Object.freeze({
    schemaVersion: 1,
    profileId,
    profilePath: source.profilePath,
    generationSha256,
    profileManifestSha256: source.profileManifestSha256,
    lockfileSha256: source.lockfileSha256,
    modulesSha256: source.modulesSha256,
    sourcePnpmVersion: source.sourcePnpmVersion,
    storeDir: source.storeDir,
    expectedStoreDir: source.expectedStoreDir,
    pnpmMajor: 11,
    pnpmVersion: '11.7.0',
    files,
  })
}

async function cacheFiles(root: string): Promise<readonly CacheFile[]> {
  const output: CacheFile[] = []
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) fail('official DSH metadata cache contains a symbolic link')
    if (info.isFile()) {
      const bytes = await readRegular(path, 'official DSH metadata cache file', MAX_CACHE_FILE_BYTES)
      output.push(Object.freeze({
        path: relative(root, path).split(sep).join('/'),
        sizeBytes: bytes.length,
        sha256: digest(bytes),
      }))
      return
    }
    if (!info.isDirectory()) fail('official DSH metadata cache contains an unsupported entry')
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => compareText(left.name, right.name))) {
      await visit(join(path, entry.name))
    }
  }
  await visit(root)
  return Object.freeze(output.sort((left, right) => compareText(left.path, right.path)))
}

async function writeMetadata(root: string, metadata: ProfileSource['metadata']): Promise<readonly CacheFile[]> {
  for (const [name, body] of Object.entries(metadata)) {
    const path = join(root, 'pnpm', 'v11', 'metadata', 'registry.npmjs.org', ...name.split('/')) + '.jsonl'
    await ensurePrivate(dirname(path))
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(`${canonicalJson({})}\n${canonicalJson(body)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  return await cacheFiles(root)
}

/** Build or reuse the content-addressed cache generation for the Profile's exact pre-mutation state. */
export async function prepareProfileMetadataCache(
  official: OfficialDshRecoveryBinding,
  profileIdValue: string,
): Promise<ProfileMetadataCacheBinding> {
  const profileId = profileSegment(profileIdValue)
  const source = await profileSource(official, profileId)
  const root = join(official.pnpm.runtimeRoot, 'metadata-cache', createHash('sha256').update(profileId).digest('hex'))
  await ensurePrivate(root)
  const temporary = join(root, `.generation-${randomUUID()}`)
  await ensurePrivate(temporary)
  const temporaryCache = join(temporary, 'cache')
  await ensurePrivate(temporaryCache)
  try {
    const files = await writeMetadata(temporaryCache, source.metadata)
    const seed = manifestSeed(source, profileId, files)
    const generationPath = join(root, seed.generationSha256.slice('sha256:'.length))
    const cachePath = join(generationPath, 'cache')
    const manifestPath = join(generationPath, 'manifest.json')
    const manifest: CacheManifest = Object.freeze({
      ...seed,
      generationPath,
      cachePath,
      manifestPath,
    })
    const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`)
    const manifestSha256 = digest(manifestBytes)
    const manifestHandle = await open(join(temporary, 'manifest.json'), 'wx', 0o600)
    try {
      await manifestHandle.writeFile(manifestBytes)
      await manifestHandle.sync()
    } finally {
      await manifestHandle.close()
    }
    try {
      await rename(temporary, generationPath)
    } catch (error: unknown) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await rm(temporary, { recursive: true })
    }
    const manifestBinding = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'files'))
    const binding = bindingFields({ ...manifestBinding, manifestSha256 }, 'Plugin metadata cache')
    await verifyProfileMetadataCache(official, binding, true)
    return binding
  } catch (error: unknown) {
    const canonical = await realpath(temporary).catch(() => null)
    if (canonical === temporary) {
      await rm(temporary, { recursive: true }).catch(() => undefined)
    }
    throw error
  }
}

/** Verify content-addressed cache provenance, contents, pnpm/store identity, and optionally current Profile generation. */
export async function verifyProfileMetadataCache(
  official: OfficialDshRecoveryBinding,
  value: ProfileMetadataCacheBinding,
  requireCurrentProfile: boolean,
): Promise<void> {
  const binding = bindingFields(value, 'Plugin metadata cache')
  const profileId = profileSegment(binding.profileId)
  const profilePath = join(official.hostHome, 'profiles', profileId)
  const cacheRoot = join(official.pnpm.runtimeRoot, 'metadata-cache', createHash('sha256').update(profileId).digest('hex'))
  if (binding.profilePath !== profilePath || !below(cacheRoot, binding.generationPath)
    || binding.cachePath !== join(binding.generationPath, 'cache')
    || binding.manifestPath !== join(binding.generationPath, 'manifest.json')
    || binding.generationPath !== join(cacheRoot, binding.generationSha256.slice('sha256:'.length))
    || official.pnpm.packageVersion !== binding.pnpmVersion) {
    fail('Plugin metadata cache provenance does not bind the official Profile and pnpm runtime')
  }
  const manifestBytes = await readRegular(binding.manifestPath, 'official DSH metadata cache manifest', MAX_MANIFEST_BYTES)
  if (digest(manifestBytes) !== binding.manifestSha256) fail('official DSH metadata cache manifest digest changed')
  const manifest = decodeJson(manifestBytes, 'official DSH metadata cache manifest')
  const files = manifest.files
  if (!Array.isArray(files) || files.length > 32_768) fail('official DSH metadata cache manifest files are invalid')
  const decodedFiles: CacheFile[] = files.map((item, index) => {
    if (!plain(item) || Object.keys(item).sort(compareText).join('\0') !== ['path', 'sha256', 'sizeBytes'].join('\0')
      || typeof item.path !== 'string' || item.path.length === 0 || item.path.startsWith('/')
      || item.path.split('/').includes('..')
      || !Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0
      || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      fail(`official DSH metadata cache manifest file ${String(index)} is invalid`)
    }
    return Object.freeze({ path: item.path, sizeBytes: item.sizeBytes as number, sha256: item.sha256 as `sha256:${string}` })
  })
  const manifestBinding = bindingFields({
    ...Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'files')),
    manifestSha256: binding.manifestSha256,
  }, 'Plugin metadata cache manifest')
  if (canonicalJson(manifestBinding) !== canonicalJson(binding)) fail('official DSH metadata cache manifest does not match its provider binding')
  const observedFiles = await cacheFiles(binding.cachePath)
  if (canonicalJson(observedFiles) !== canonicalJson(decodedFiles)) fail('official DSH metadata cache files changed')
  if (requireCurrentProfile) {
    const current = await profileSource(official, profileId)
    if (current.profilePath !== binding.profilePath
      || current.profileManifestSha256 !== binding.profileManifestSha256
      || current.lockfileSha256 !== binding.lockfileSha256
      || current.modulesSha256 !== binding.modulesSha256
      || current.sourcePnpmVersion !== binding.sourcePnpmVersion
      || current.storeDir !== binding.storeDir
      || current.expectedStoreDir !== binding.expectedStoreDir) {
      fail('official DSH Profile changed after its metadata cache generation was prepared')
    }
    const expectedFiles = Object.entries(current.metadata).map(([name, body]) => {
      const bytes = Buffer.from(`${canonicalJson({})}\n${canonicalJson(body)}\n`)
      return Object.freeze({
        path: `pnpm/v11/metadata/registry.npmjs.org/${name}.jsonl`,
        sizeBytes: bytes.length,
        sha256: digest(bytes),
      })
    }).sort((left, right) => compareText(left.path, right.path))
    if (canonicalJson(expectedFiles) !== canonicalJson(decodedFiles)) {
      fail('official DSH Profile registry metadata changed after cache preparation')
    }
  }
}
