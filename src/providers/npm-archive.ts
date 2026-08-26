import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { gunzip } from 'node:zlib'
import { canonicalJson, canonicalSha256, type Sha256Digest } from '../domain/index.ts'

/** Stable P0 package-admission failures. */
export type MaterialAdmissionCode =
  | 'archive-format'
  | 'archive-path'
  | 'archive-type'
  | 'bin-unclear'
  | 'dependencies-unsupported'
  | 'lifecycle-scripts'
  | 'manifest-invalid'
  | 'native-unsupported'

/** Structured refusal emitted before any owner mutation. */
export class MaterialAdmissionError extends Error {
  constructor(readonly code: MaterialAdmissionCode, message: string) {
    super(message)
    this.name = 'MaterialAdmissionError'
  }
}

/** Safely admitted npm package metadata. */
export interface NpmPackageInspection {
  readonly name: string
  readonly version: string
  readonly binRelative: string | null
  readonly files: readonly string[]
  readonly manifestBody: string
  readonly manifestDigest: Sha256Digest
  readonly fileManifestDigest: Sha256Digest
  readonly scripts: readonly string[]
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly bundlePatch: Readonly<{ path: string; body: string; digest: Sha256Digest }> | null
}

interface TarEntry {
  readonly path: string
  readonly content: Buffer | null
}

function fail(code: MaterialAdmissionCode, message: string): never {
  throw new MaterialAdmissionError(code, message)
}

function gunzipBounded(input: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    gunzip(input, { maxOutputLength: 128 * 1024 * 1024 }, (error, output) => {
      if (error !== null) reject(new MaterialAdmissionError('archive-format', 'artifact is not a bounded gzip archive'))
      else resolvePromise(output)
    })
  })
}

function textField(header: Buffer, start: number, length: number): string {
  const end = header.indexOf(0, start)
  return header.subarray(start, end < 0 || end >= start + length ? start + length : end).toString('utf8')
}

function octalField(header: Buffer, start: number, length: number): number {
  const text = header.subarray(start, start + length).toString('ascii').replaceAll('\0', '').trim()
  if (!/^[0-7]+$/.test(text)) fail('archive-format', 'tar numeric field is invalid')
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value) || value < 0) fail('archive-format', 'tar numeric field is out of range')
  return value
}

function verifyHeader(header: Buffer): void {
  const expected = octalField(header, 148, 8)
  let actual = 0
  for (let index = 0; index < 512; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index] ?? 0
  }
  if (actual !== expected) fail('archive-format', 'tar header checksum mismatch')
}

function parsePax(content: Buffer): string | undefined {
  let offset = 0
  let path: string | undefined
  while (offset < content.length) {
    const space = content.indexOf(32, offset)
    if (space < 0) fail('archive-format', 'PAX record length is missing')
    const length = Number(content.subarray(offset, space).toString('ascii'))
    if (!Number.isSafeInteger(length) || length < 4 || offset + length > content.length) {
      fail('archive-format', 'PAX record length is invalid')
    }
    const record = content.subarray(space + 1, offset + length - 1).toString('utf8')
    const separator = record.indexOf('=')
    if (separator < 1) fail('archive-format', 'PAX record is invalid')
    if (record.slice(0, separator) === 'path') path = record.slice(separator + 1)
    offset += length
  }
  return path
}

function safeArchivePath(raw: string): string {
  if (raw.includes('\\') || raw.includes('\0') || raw.startsWith('/')) fail('archive-path', 'archive path is unsafe')
  const normalized = posix.normalize(raw)
  if (normalized !== raw.replace(/\/$/u, '') || normalized === '..' || normalized.startsWith('../')) {
    fail('archive-path', 'archive path escapes its package root')
  }
  if (!normalized.startsWith('package/')) fail('archive-path', 'npm archive entry is outside package/')
  const relative = normalized.slice('package/'.length)
  if (relative.length === 0 || relative.split('/').some(part => part === '' || part === '.' || part === '..')) {
    fail('archive-path', 'npm archive entry has an invalid relative path')
  }
  return relative
}

async function entries(path: string): Promise<readonly TarEntry[]> {
  const compressed = await readFile(path)
  if (compressed.length > 64 * 1024 * 1024) fail('archive-format', 'compressed artifact exceeds the P0 bound')
  const archive = await gunzipBounded(compressed)
  const output: TarEntry[] = []
  const seen = new Set<string>()
  let offset = 0
  let pendingPath: string | undefined
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    offset += 512
    if (header.every(byte => byte === 0)) break
    verifyHeader(header)
    const size = octalField(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 0)
    const bodyEnd = offset + size
    if (bodyEnd > archive.length) fail('archive-format', 'tar entry is truncated')
    const content = archive.subarray(offset, bodyEnd)
    offset += Math.ceil(size / 512) * 512
    if (type === 'x') {
      pendingPath = parsePax(content) ?? pendingPath
      continue
    }
    if (type === 'L') {
      pendingPath = content.subarray(0, content.indexOf(0) < 0 ? content.length : content.indexOf(0)).toString('utf8')
      continue
    }
    const prefix = textField(header, 345, 155)
    const name = textField(header, 0, 100)
    const raw = pendingPath ?? (prefix.length === 0 ? name : `${prefix}/${name}`)
    pendingPath = undefined
    if (!['\0', '0', '5'].includes(type)) fail('archive-type', `archive entry type ${JSON.stringify(type)} is unsupported`)
    const safe = safeArchivePath(raw)
    if (seen.has(safe)) fail('archive-path', `archive contains duplicate path ${safe}`)
    seen.add(safe)
    output.push({ path: safe, content: type === '5' ? null : Buffer.from(content) })
    if (output.length > 4096) fail('archive-format', 'archive contains too many entries')
  }
  if (output.length === 0) fail('archive-format', 'archive contains no package entries')
  return Object.freeze(output)
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function stringMap(value: unknown): Record<string, unknown> {
  return plain(value) ? value : Object.create(null) as Record<string, unknown>
}

function inspectEntries(values: readonly TarEntry[], expectedBin: string | null): NpmPackageInspection {
  const manifestEntry = values.find(entry => entry.path === 'package.json' && entry.content !== null)
  if (manifestEntry?.content === null || manifestEntry === undefined) fail('manifest-invalid', 'npm package has no regular package.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestEntry.content.toString('utf8')) as unknown
  } catch {
    fail('manifest-invalid', 'npm package.json is not valid JSON')
  }
  if (!plain(parsed) || typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    fail('manifest-invalid', 'npm package name and version are required')
  }
  if (parsed.scripts !== undefined && !plain(parsed.scripts)) fail('manifest-invalid', 'package scripts must be an object')
  const scripts = stringMap(parsed.scripts)
  const peerDependencies = stringMap(parsed.peerDependencies)
  if (Object.values(peerDependencies).some(version => typeof version !== 'string')) {
    fail('manifest-invalid', 'package peerDependencies must contain string versions')
  }
  const forbiddenScripts = ['preinstall', 'install', 'postinstall', 'prepare'].filter(name => Object.hasOwn(scripts, name))
  if (forbiddenScripts.length > 0) {
    fail('lifecycle-scripts', `P0 refuses lifecycle scripts: ${forbiddenScripts.join(', ')}`)
  }
  for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
    const value = parsed[field]
    if (Array.isArray(value) ? value.length > 0 : Object.keys(stringMap(value)).length > 0) {
      fail('dependencies-unsupported', `P0 refuses package field ${field}`)
    }
  }
  if (parsed.gypfile === true || values.some(entry => entry.path.endsWith('.node') || entry.path === 'binding.gyp')) {
    fail('native-unsupported', 'P0 refuses native package material')
  }
  const bins = typeof parsed.bin === 'string'
    ? { [parsed.name]: parsed.bin }
    : stringMap(parsed.bin)
  let binRelative: string | null = null
  if (expectedBin === null) {
    if (Object.keys(bins).length > 0) fail('bin-unclear', 'package exposes a bin that is not admitted for this lifecycle')
  } else {
    const value = bins[expectedBin]
    if (typeof value !== 'string' || value.startsWith('/') || value.includes('\\')) {
      fail('bin-unclear', `package does not expose exact bin ${expectedBin}`)
    }
    const normalized = posix.normalize(value.replace(/^\.\//u, ''))
    if (normalized === '..' || normalized.startsWith('../')) fail('bin-unclear', 'package bin escapes its root')
    if (!values.some(entry => entry.path === normalized && entry.content !== null)) {
      fail('bin-unclear', 'package bin target is not a regular archive entry')
    }
    if (Object.keys(bins).length !== 1) fail('bin-unclear', 'package exposes additional unadmitted bins')
    binRelative = normalized
  }
  const files = Object.freeze(values.filter(entry => entry.content !== null).map(entry => entry.path).sort())
  const manifestBody = canonicalJson(parsed)
  const dsh = stringMap(parsed.dsh)
  const bundle = stringMap(dsh.bundle)
  let bundlePatch: NpmPackageInspection['bundlePatch'] = null
  if (bundle.patch !== undefined) {
    if (typeof bundle.patch !== 'string' || bundle.patch.startsWith('/') || bundle.patch.includes('\\')) {
      fail('manifest-invalid', 'package dsh.bundle.patch is invalid')
    }
    const patchPath = posix.normalize(bundle.patch.replace(/^\.\//u, ''))
    const patchEntry = values.find(entry => entry.path === patchPath && entry.content !== null)
    if (patchEntry?.content === null || patchEntry === undefined) fail('manifest-invalid', 'package Bundle patch is absent')
    const body = patchEntry.content.toString('utf8')
    bundlePatch = Object.freeze({
      path: patchPath,
      body,
      digest: `sha256:${createHash('sha256').update(patchEntry.content).digest('hex')}`,
    })
  }
  return Object.freeze({
    name: parsed.name,
    version: parsed.version,
    binRelative,
    files,
    manifestBody,
    manifestDigest: canonicalSha256(parsed),
    fileManifestDigest: canonicalSha256(files),
    scripts: Object.freeze(Object.keys(scripts).sort()),
    peerDependencies: Object.freeze(peerDependencies as Record<string, string>),
    bundlePatch,
  })
}

/** Inspect one npm archive without executing package code. */
export async function inspectNpmArchive(path: string, expectedBin: string | null): Promise<NpmPackageInspection> {
  return inspectEntries(await entries(path), expectedBin)
}

/** Extract an already-admitted archive into a new center-owned immutable directory. */
export async function materializeNpmArchive(
  archivePath: string,
  destination: string,
  expectedBin: string | null,
): Promise<NpmPackageInspection> {
  const values = await entries(archivePath)
  const inspection = inspectEntries(values, expectedBin)
  const temporary = `${destination}.stage-${randomUUID()}`
  await mkdir(temporary, { recursive: false, mode: 0o700 })
  try {
    for (const entry of values) {
      const path = join(temporary, ...entry.path.split('/'))
      if (entry.content === null) {
        await mkdir(path, { recursive: true, mode: 0o700 })
      } else {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, entry.content, { flag: 'wx', mode: 0o600 })
      }
    }
    await rename(temporary, destination)
  } catch (error: unknown) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
  return inspection
}
