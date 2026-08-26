/** Atomic installer for the dependency-free break-glass executable pin. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RecoveryExecutableBinding } from '../plans/types.ts'

const MAX_EXECUTABLE_BYTES = 32 * 1024 * 1024
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Inputs whose exact bytes become one durable recovery executable binding. */
export interface InstallRecoveryExecutableInput {
  readonly root: string
  readonly packageVersion: string
  readonly cliPath: string
  readonly hostCliPath: string
  readonly platform?: 'darwin' | 'linux' | 'win32'
  readonly arch?: string
}

interface PackageManifest {
  readonly name: string
  readonly version: string
}

function fail(message: string): never {
  throw new Error(message)
}

async function packageManifest(): Promise<PackageManifest> {
  const path = fileURLToPath(new URL('../../package.json', import.meta.url))
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (cause) {
    throw new Error('recovery package manifest is unreadable', { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('recovery package manifest is invalid')
  }
  const record = value as Record<string, unknown>
  if (record.name !== 'dsh-plugin-extension-center'
    || typeof record.version !== 'string' || !SAFE_SEGMENT.test(record.version)) {
    fail('recovery package identity is invalid')
  }
  return Object.freeze({ name: record.name, version: record.version })
}

async function readRegularNoFollow(path: string, label: string): Promise<Buffer> {
  if (!isAbsolute(path)) fail(`${label} path must be absolute`)
  if (constants.O_NOFOLLOW === undefined) fail(`${label} cannot be opened without following links on this platform`)
  const canonical = await realpath(path)
  if (canonical !== path) fail(`${label} path must be its canonical realpath`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size <= 0 || opened.size > MAX_EXECUTABLE_BYTES) {
      fail(`${label} must be a bounded regular file`)
    }
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

function sha256(bytes: Uint8Array): RecoveryExecutableBinding['executableSha256'] {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: false, mode: 0o700 })
  const canonical = await realpath(path)
  const state = await lstat(path)
  if (canonical !== path || !state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0) {
    fail(`recovery directory ${JSON.stringify(path)} is not a private real directory`)
  }
}

async function ensurePath(root: string, parts: readonly string[]): Promise<string> {
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      await ensurePrivateDirectory(current)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const canonical = await realpath(current)
      const state = await lstat(current)
      if (canonical !== current || !state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0) {
        fail(`recovery directory ${JSON.stringify(current)} is not a private real directory`)
      }
    }
  }
  return current
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function installExclusive(path: string, bytes: Buffer): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.break-glass-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o500)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    try {
      await link(temporary, path)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const installed = await readRegularNoFollow(path, 'installed recovery executable')
      if (!installed.equals(bytes)) fail('installed recovery executable pin already contains different bytes')
    }
    await syncDirectory(directory)
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

/**
 * Install one immutable private CLI copy and bind it to an exact Host CLI hash.
 * @param input Built standalone CLI, Host CLI, and Center-owned destination.
 * @returns Exact opening-event recovery executable binding.
 */
export async function installRecoveryExecutable(
  input: InstallRecoveryExecutableInput,
): Promise<RecoveryExecutableBinding> {
  const root = await realpath(resolve(input.root))
  if (!(await lstat(root)).isDirectory()) fail('recovery root must be a directory')
  const platformValue = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  if (platformValue !== 'darwin' && platformValue !== 'linux' && platformValue !== 'win32') {
    fail('recovery platform is unsupported')
  }
  const platform = platformValue
  for (const [label, value] of [['packageVersion', input.packageVersion], ['platform', platform], ['arch', arch]] as const) {
    if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') fail(`recovery ${label} is not a safe path segment`)
  }
  const cliBytes = await readRegularNoFollow(input.cliPath, 'built recovery executable')
  const hostCliBytes = await readRegularNoFollow(input.hostCliPath, 'Host CLI')
  const directory = await ensurePath(root, ['recovery', input.packageVersion, `${platform}-${arch}`])
  const path = join(directory, 'break-glass.mjs')
  await installExclusive(path, cliBytes)
  const installedBytes = await readRegularNoFollow(path, 'installed recovery executable')
  if (((await lstat(path)).mode & 0o077) !== 0) fail('installed recovery executable is not private')
  return Object.freeze({
    schemaVersion: 1,
    executablePath: path,
    executableSha256: sha256(installedBytes),
    hostCliPath: input.hostCliPath,
    hostCliSha256: sha256(hostCliBytes),
    packageVersion: input.packageVersion,
    platform,
    arch,
  })
}

/**
 * Materialize the built package's standalone CLI and bind the exact DSH CLI that launched this Host.
 * @param root Center-owned durable root outside the installed Profile generation.
 * @returns Exact executable binding embedded in every consumed operation.
 */
export async function installPackagedRecoveryExecutable(root: string): Promise<RecoveryExecutableBinding> {
  const hostArgument = process.argv[1]
  if (hostArgument === undefined) fail('the launching DSH CLI path is unavailable')
  const manifest = await packageManifest()
  const cliPath = await realpath(fileURLToPath(new URL('./break-glass.js', import.meta.url)))
  const hostCliPath = await realpath(resolve(hostArgument))
  return await installRecoveryExecutable({
    root,
    packageVersion: manifest.version,
    cliPath,
    hostCliPath,
  })
}
