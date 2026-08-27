#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { parse as parseYaml } from 'yaml'

const EXPECTED_PACKAGE_NAME = 'dsh-plugin-extension-center'
const PNPM_VERSION = '11.21.0'
const PNPM_REGISTRY_INTEGRITY = 'sha512-UhcFvOaJkk6scvWjWHEi82JonvZXHlW6gAdv1jfBETLs/62ib61Op5xIW/3b/T1aKlsFgFp36JPeceyKbMo7sQ=='
const PNPM_REGISTRY_TARBALL = `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`
const PNPM_BIN = Object.freeze({
  pn: 'bin/pnpm.mjs',
  pnpm: 'bin/pnpm.mjs',
  pnpx: 'bin/pnpx.mjs',
  pnx: 'bin/pnpx.mjs',
})
const PNPM_PUBLISHED_FILES = Object.freeze(['dist', '!dist/**/*.map', 'bin'])
const OUTPUT_RELATIVE_PATH = join('.artifacts', 'release-candidate')
const ATTESTATION_FILENAME = 'pack-attestation.json'
const COMMIT = /^[0-9a-f]{40}$/u
const MAX_PNPM_TARBALL_BYTES = 32 * 1024 * 1024
const MAX_PNPM_TAR_BYTES = 128 * 1024 * 1024
const TAR_BLOCK_BYTES = 512
const MAX_PNPM_TREE_ENTRIES = 10_000
const MAX_PNPM_FILE_BYTES = 64 * 1024 * 1024
const MAX_PNPM_TREE_BYTES = 128 * 1024 * 1024
const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
const DEFAULT_PROCESS_STDOUT_BYTES = 64 * 1024
const DEFAULT_PROCESS_STDERR_BYTES = 64 * 1024
const DEFAULT_PROCESS_TOTAL_BYTES = 64 * 1024
const DEFAULT_PROCESS_KILL_CLOSE_MS = 2_000
const WINDOWS_SYSTEM_DIRECTORY = join(
  process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
  'System32',
)

/**
 * Pack the current built inputs twice and publish only byte-identical evidence.
 * @param {{projectRoot: string, outputRoot: string, runPack?: Function, readPackedManifest?: Function, inspectPackedToolchain?: Function, registryDependencies?: object}} options Verification options.
 * @returns {Promise<{archivePath: string, sumsPath: string, filename: string, sha256: string, pnpmTreeSha256: string}>} Published evidence.
 */
export async function verifyDeterministicPack(options) {
  const projectRoot = resolve(options.projectRoot)
  const outputRoot = resolve(options.outputRoot)
  assertExactOutputRoot(projectRoot, outputRoot)
  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })

  const injectedPack = options.runPack !== undefined
  const injectedInspection = options.inspectPackedToolchain !== undefined
  if (injectedPack !== injectedInspection) {
    throw new Error('deterministic-pack: pack and toolchain inspection test seams must be injected together')
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-extension-center-pack-'))
  try {
    const sourceManifestBytes = await readFile(join(projectRoot, 'package.json'))
    const sourceManifest = parseJson(sourceManifestBytes.toString('utf8'), 'source package.json')
    assertManifestIdentity(sourceManifest, sourceManifest, 0)
    const authority = injectedPack
      ? null
      : await authenticatePnpmAuthority({
        projectRoot,
        temporaryRoot: join(temporaryRoot, 'pnpm-authority'),
      }, options.registryDependencies)
    const archiveOperations = authority?.archiveOperations ?? resolveArchiveOperations(options.registryDependencies)
    const readPackedManifest = options.readPackedManifest
      ?? (archive => readManifestFromTar(archive, archiveOperations))
    const runPack = options.runPack ?? (input => runPnpmPack(input, authority))
    const inspectPackedToolchain = options.inspectPackedToolchain
      ?? (input => inspectBundledPnpmWithAuthority(input, authority))
    const passRoots = [join(temporaryRoot, 'pass-1'), join(temporaryRoot, 'pass-2')]
    await Promise.all(passRoots.map(path => mkdir(path, { mode: 0o700 })))
    const archives = []
    for (const [index, destination] of passRoots.entries()) {
      await runPack({ projectRoot, destination, pass: index + 1 })
      archives.push(await singleArchive(destination, index + 1))
    }
    if (basename(archives[0]) !== basename(archives[1])) {
      throw new Error('deterministic-pack: consecutive packs produced different archive names')
    }

    for (const [index, archive] of archives.entries()) {
      assertManifestIdentity(sourceManifest, await readPackedManifest(archive), index + 1)
    }
    const [firstBytes, secondBytes] = await Promise.all(archives.map((path, index) => injectedPack
      ? readFile(path)
      : auditTarGzArchive(path, `main pack pass ${String(index + 1)}`)))
    if (!firstBytes.equals(secondBytes)) {
      throw new Error('deterministic-pack: consecutive archives are not byte-identical')
    }
    const pnpmTreeSha256 = await inspectPackedToolchain({
      archive: archives[0],
      projectRoot,
      temporaryRoot: join(temporaryRoot, 'toolchain'),
    })

    const filename = basename(archives[0])
    const sha256 = createHash('sha256').update(firstBytes).digest('hex')
    const archivePath = join(outputRoot, filename)
    const sumsPath = join(outputRoot, 'SHA256SUMS')
    await copyFile(archives[0], archivePath)
    await writeFile(sumsPath, `${sha256}  ${filename}\n`, { flag: 'wx', mode: 0o600 })
    const provenance = options.provenance ?? null
    let attestationPath = null
    let attestation = null
    if (provenance !== null) {
      const readPackedManifestBytes = options.readPackedManifestBytes
        ?? (archive => readManifestBytesFromTar(archive, archiveOperations))
      const manifestBytes = await readPackedManifestBytes(archives[0])
      attestation = buildPackAttestation({
        provenance,
        packageName: sourceManifest.name,
        version: sourceManifest.version,
        filename,
        sizeBytes: firstBytes.length,
        sha256: `sha256:${sha256}`,
        manifestSha256: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
        sourceManifestSha256: `sha256:${createHash('sha256').update(sourceManifestBytes).digest('hex')}`,
        pnpmTreeSha256,
      })
      attestationPath = join(outputRoot, ATTESTATION_FILENAME)
      await writeFile(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    }
    return Object.freeze({ archivePath, sumsPath, attestationPath, attestation, filename, sha256, pnpmTreeSha256 })
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true })
    await mkdir(outputRoot, { recursive: true, mode: 0o700 })
    throw error
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function positiveInteger(value, label) {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`deterministic-pack: ${label} must be a positive integer`)
  return parsed
}

function exactString(value, label, maximum = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`deterministic-pack: ${label} must be a bounded string`)
  }
  return value
}

/** Build one self-digested pack statement whose authority comes from its exact-run Actions artifact. */
export function buildPackAttestation(input) {
  const provenance = input?.provenance
  if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) {
    throw new Error('deterministic-pack: provenance must be an object')
  }
  const commit = exactString(provenance.commit, 'commit', 40)
  if (!COMMIT.test(commit)) throw new Error('deterministic-pack: commit must be one lowercase 40-character SHA')
  const repository = exactString(provenance.repository, 'repository')
  const event = exactString(provenance.event, 'event', 64)
  const ref = exactString(provenance.ref, 'ref')
  const job = exactString(provenance.job, 'job', 128)
  if (repository !== 'striveh/dsh-plugin-extension-center' || event !== 'push'
    || ref !== 'refs/heads/main' || job !== 'verify') {
    throw new Error('deterministic-pack: provenance is not the exact main push verify job')
  }
  const body = Object.freeze({
    schemaVersion: 1,
    attestationId: 'DSH-CENTER-DETERMINISTIC-PACK',
    repository,
    workflow: '.github/workflows/ci.yml',
    event,
    ref,
    commit,
    runId: positiveInteger(provenance.runId, 'run id'),
    runAttempt: positiveInteger(provenance.runAttempt, 'run attempt'),
    job,
    artifact: Object.freeze({
      packageName: exactString(input.packageName, 'package name'),
      version: exactString(input.version, 'package version', 128),
      filename: exactString(input.filename, 'archive filename'),
      sizeBytes: positiveInteger(input.sizeBytes, 'archive size'),
      sha256: exactString(input.sha256, 'archive SHA-256', 80),
      manifestSha256: exactString(input.manifestSha256, 'packed manifest SHA-256', 80),
      sourceManifestSha256: exactString(input.sourceManifestSha256, 'source manifest SHA-256', 80),
      pnpmTreeSha256: exactString(input.pnpmTreeSha256, 'pnpm tree SHA-256', 80),
    }),
  })
  for (const [label, value] of Object.entries(body.artifact).filter(([key]) => key.endsWith('Sha256') || key === 'sha256')) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`deterministic-pack: ${label} is not a canonical SHA-256`)
  }
  return Object.freeze({
    ...body,
    attestationDigest: `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`,
  })
}

/** Return exact GitHub Actions provenance, or null outside GitHub Actions. */
export function githubProvenanceFromEnvironment(environment) {
  if (environment.GITHUB_ACTIONS !== 'true') return null
  const provenance = {
    repository: environment.GITHUB_REPOSITORY,
    event: environment.GITHUB_EVENT_NAME,
    ref: environment.GITHUB_REF,
    commit: environment.GITHUB_SHA,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    job: environment.GITHUB_JOB,
  }
  if (provenance.repository !== 'striveh/dsh-plugin-extension-center'
    || provenance.event !== 'push' || provenance.ref !== 'refs/heads/main'
    || provenance.job !== 'verify') return null
  return Object.freeze(provenance)
}

/** Require the packed manifest to retain the exact independent Bundle identity. */
export function assertManifestIdentity(source, packed, pass) {
  if (source.name !== EXPECTED_PACKAGE_NAME || typeof source.version !== 'string' || source.version.length === 0
    || source.version.trim() !== source.version) {
    throw new Error('deterministic-pack: source manifest identity is invalid')
  }
  for (const field of [
    'name', 'version', 'private', 'type', 'main', 'types', 'exports', 'files', 'engines', 'dsh',
    'dependencies', 'bundledDependencies',
  ]) {
    if (canonicalJson(packed[field]) !== canonicalJson(source[field])) {
      throw new Error(`deterministic-pack: pass ${String(pass)} manifest changed ${field}`)
    }
  }
  if (packed.bin !== undefined) throw new Error(`deterministic-pack: pass ${String(pass)} declared a package bin`)
  const scripts = packed.scripts !== null && typeof packed.scripts === 'object' && !Array.isArray(packed.scripts)
    ? Object.keys(packed.scripts)
    : []
  const lifecycle = scripts.filter(name => /^(?:pre|post)?(?:install|uninstall)$/u.test(name)
    || ['prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack'].includes(name))
  if (lifecycle.length > 0) {
    throw new Error(`deterministic-pack: pass ${String(pass)} declared lifecycle scripts: ${lifecycle.join(', ')}`)
  }
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
}

function exactSha512Integrity(value, label) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`deterministic-pack: ${label} is not a canonical SHA-512 SRI`)
  }
  const encoded = value.slice('sha512-'.length)
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.byteLength !== 64 || decoded.toString('base64') !== encoded) {
    throw new Error(`deterministic-pack: ${label} is not a canonical SHA-512 SRI`)
  }
  return value
}

function assertPnpmLockIdentity(lockText, expectedIntegrity) {
  let lock
  try {
    lock = parseYaml(lockText, { maxAliasCount: 0, uniqueKeys: true })
  } catch (cause) {
    throw new Error('deterministic-pack: pnpm lockfile is not unambiguous YAML', { cause })
  }
  const root = record(lock)
  const importers = record(root?.importers)
  const project = record(importers?.['.'])
  const dependencies = record(project?.dependencies)
  const dependency = record(dependencies?.pnpm)
  const packages = record(root?.packages)
  const snapshots = record(root?.snapshots)
  const packageKey = `pnpm@${PNPM_VERSION}`
  const packageEntry = record(packages?.[packageKey])
  const resolution = record(packageEntry?.resolution)
  const snapshot = record(snapshots?.[packageKey])
  const pnpmPackageKeys = packages === null ? [] : Object.keys(packages).filter(key => key.startsWith('pnpm@'))
  const pnpmSnapshotKeys = snapshots === null ? [] : Object.keys(snapshots).filter(key => key.startsWith('pnpm@'))
  if (root?.lockfileVersion !== '9.0'
    || dependency?.specifier !== PNPM_VERSION || dependency?.version !== PNPM_VERSION
    || canonicalJson(resolution) !== canonicalJson({ integrity: expectedIntegrity })
    || snapshot === null || Object.keys(snapshot).length !== 0
    || canonicalJson(pnpmPackageKeys) !== canonicalJson([packageKey])
    || canonicalJson(pnpmSnapshotKeys) !== canonicalJson([packageKey])) {
    throw new Error('deterministic-pack: lockfile does not bind one exact pnpm registry SRI')
  }
}

async function fetchVerifiedPnpmTarball(fetchImpl, expectedIntegrity) {
  if (typeof fetchImpl !== 'function') throw new Error('deterministic-pack: HTTPS fetch is unavailable')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_PROCESS_TIMEOUT_MS)
  timeout.unref()
  let response
  try {
    try {
      response = await fetchImpl(PNPM_REGISTRY_TARBALL, {
        cache: 'no-store',
        credentials: 'omit',
        headers: Object.freeze({
          accept: 'application/octet-stream',
          'accept-encoding': 'identity',
          connection: 'close',
        }),
        redirect: 'error',
        signal: controller.signal,
      })
    } catch (cause) {
      throw new Error('deterministic-pack: exact pnpm registry tarball could not be fetched', { cause })
    }
    const contentEncoding = response?.headers?.get?.('content-encoding') ?? null
    const contentLengthText = response?.headers?.get?.('content-length') ?? null
    const contentLength = contentLengthText === null || !/^[0-9]+$/u.test(contentLengthText)
      ? null
      : Number(contentLengthText)
    if (response?.status !== 200 || response.body === null || response.body === undefined
      || contentEncoding !== null && contentEncoding !== 'identity'
      || contentLength !== null && (!Number.isSafeInteger(contentLength)
        || contentLength < 1 || contentLength > MAX_PNPM_TARBALL_BYTES)) {
      await response?.body?.cancel?.().catch(() => undefined)
      throw new Error('deterministic-pack: pnpm registry response is not one bounded identity-encoded tarball')
    }
    const chunks = []
    let sizeBytes = 0
    try {
      for await (const value of response.body) {
        const chunk = Buffer.from(value)
        sizeBytes += chunk.byteLength
        if (sizeBytes > MAX_PNPM_TARBALL_BYTES) {
          throw new Error('deterministic-pack: pnpm registry tarball exceeded its byte bound')
        }
        chunks.push(chunk)
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith('deterministic-pack:')) throw cause
      throw new Error('deterministic-pack: pnpm registry tarball body could not be read', { cause })
    }
    if (sizeBytes < 1 || contentLength !== null && sizeBytes !== contentLength) {
      throw new Error('deterministic-pack: pnpm registry tarball length changed during download')
    }
    const bytes = Buffer.concat(chunks, sizeBytes)
    const observedIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    if (observedIntegrity !== expectedIntegrity) {
      throw new Error('deterministic-pack: pnpm registry tarball bytes do not match the lock-pinned SRI')
    }
    auditTarGzBytes(bytes, { label: 'pnpm registry tarball', rootPrefix: 'package' })
    return bytes
  } finally {
    clearTimeout(timeout)
  }
}

function tarOctal(header, offset, length, label) {
  const field = header.subarray(offset, offset + length)
  if ((field[0] & 0x80) !== 0) throw new Error(`deterministic-pack: ${label} uses an unsupported base-256 tar number`)
  const text = field.toString('ascii').replaceAll('\0', ' ').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/u.test(text)) throw new Error(`deterministic-pack: ${label} has a non-octal tar number`)
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`deterministic-pack: ${label} tar number is out of range`)
  return value
}

function tarText(field, label) {
  const nul = field.indexOf(0)
  const end = nul === -1 ? field.length : nul
  if (nul !== -1 && field.subarray(nul).some(byte => byte !== 0)) {
    throw new Error(`deterministic-pack: ${label} has non-null tar field padding`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(field.subarray(0, end))
  } catch (cause) {
    throw new Error(`deterministic-pack: ${label} is not UTF-8`, { cause })
  }
}

function safeTarPath(input, rootPrefix, label) {
  const path = input.endsWith('/') ? input.slice(0, -1) : input
  if (path.length < 1 || path.length > 1024 || !/^[ -~]+$/u.test(path)
    || path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.includes('\\')) {
    throw new Error(`deterministic-pack: ${label} has an unsafe tar path`)
  }
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')
    || segments[0] !== rootPrefix) {
    throw new Error(`deterministic-pack: ${label} escaped its required ${rootPrefix}/ root`)
  }
  return segments.join('/')
}

function tarChecksum(header, label) {
  const expected = tarOctal(header, 148, 8, `${label} checksum`)
  let observed = 0
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    observed += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  if (observed !== expected) throw new Error(`deterministic-pack: ${label} has an invalid tar header checksum`)
}

/** Audit a bounded tar.gz before any external extractor observes its headers. */
export function auditTarGzBytes(value, options = {}) {
  const label = options.label ?? 'archive'
  const rootPrefix = options.rootPrefix ?? 'package'
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_PNPM_TARBALL_BYTES) {
    throw new Error(`deterministic-pack: ${label} exceeds its compressed byte bound`)
  }
  let tar
  try {
    tar = gunzipSync(Buffer.from(value), { maxOutputLength: MAX_PNPM_TAR_BYTES })
  } catch (cause) {
    throw new Error(`deterministic-pack: ${label} is invalid or exceeds its expanded byte bound`, { cause })
  }
  if (tar.byteLength < TAR_BLOCK_BYTES * 2 || tar.byteLength % TAR_BLOCK_BYTES !== 0) {
    throw new Error(`deterministic-pack: ${label} is not a block-aligned tar archive`)
  }
  const entries = new Set()
  let entryCount = 0
  let fileBytes = 0
  let headerCount = 0
  let offset = 0
  let pendingLongPath = null
  let ended = false
  while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES)
    if (header.every(byte => byte === 0)) {
      const next = tar.subarray(offset + TAR_BLOCK_BYTES, offset + TAR_BLOCK_BYTES * 2)
      if (next.byteLength !== TAR_BLOCK_BYTES || !next.every(byte => byte === 0)
        || !tar.subarray(offset + TAR_BLOCK_BYTES * 2).every(byte => byte === 0)) {
        throw new Error(`deterministic-pack: ${label} has invalid tar end padding`)
      }
      ended = true
      break
    }
    headerCount += 1
    if (headerCount > MAX_PNPM_TREE_ENTRIES * 2) {
      throw new Error(`deterministic-pack: ${label} exceeds its tar header bound`)
    }
    tarChecksum(header, label)
    const magic = header.subarray(257, 263).toString('ascii')
    if (magic !== 'ustar\0' && magic !== 'ustar ') {
      throw new Error(`deterministic-pack: ${label} has an unsupported tar format`)
    }
    const size = tarOctal(header, 124, 12, `${label} size`)
    const dataOffset = offset + TAR_BLOCK_BYTES
    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
    const nextOffset = dataOffset + paddedSize
    if (nextOffset > tar.byteLength) throw new Error(`deterministic-pack: ${label} has a truncated tar entry`)
    const padding = tar.subarray(dataOffset + size, nextOffset)
    if (!padding.every(byte => byte === 0)) throw new Error(`deterministic-pack: ${label} has non-null tar entry padding`)
    const rawType = header[156]
    const type = rawType === 0 ? '0' : String.fromCharCode(rawType)
    if (type === 'L') {
      if (pendingLongPath !== null || size < 2 || size > 1025) {
        throw new Error(`deterministic-pack: ${label} has an invalid GNU long path header`)
      }
      const extensionName = tarText(header.subarray(0, 100), `${label} GNU long path name`)
      const extensionPrefix = tarText(header.subarray(345, 500), `${label} GNU long path prefix`)
      const extensionLink = tarText(header.subarray(157, 257), `${label} GNU long path link name`)
      if (extensionName !== '././@LongLink' || extensionPrefix !== '' || extensionLink !== '') {
        throw new Error(`deterministic-pack: ${label} has an invalid GNU long path header`)
      }
      const data = tar.subarray(dataOffset, dataOffset + size)
      if (data[data.length - 1] !== 0 || data.subarray(0, data.length - 1).includes(0)) {
        throw new Error(`deterministic-pack: ${label} has an invalid GNU long path payload`)
      }
      pendingLongPath = safeTarPath(
        tarText(data.subarray(0, data.length - 1), `${label} GNU long path`),
        rootPrefix,
        label,
      )
      offset = nextOffset
      continue
    }
    if (!['0', '5'].includes(type)) {
      throw new Error(`deterministic-pack: ${label} contains an unsupported tar entry type ${JSON.stringify(type)}`)
    }
    const name = tarText(header.subarray(0, 100), `${label} name`)
    const prefix = tarText(header.subarray(345, 500), `${label} prefix`)
    const headerPath = safeTarPath(prefix === '' ? name : `${prefix}/${name}`, rootPrefix, label)
    const path = pendingLongPath ?? headerPath
    pendingLongPath = null
    if (tarText(header.subarray(157, 257), `${label} link name`) !== '') {
      throw new Error(`deterministic-pack: ${label} contains a link target on a regular entry`)
    }
    entryCount += 1
    if (entryCount > MAX_PNPM_TREE_ENTRIES || entries.has(path)) {
      throw new Error(`deterministic-pack: ${label} contains excessive or duplicate tar entries`)
    }
    entries.add(path)
    if (type === '5') {
      if (size !== 0) throw new Error(`deterministic-pack: ${label} has a non-empty directory entry`)
    } else {
      fileBytes += size
      if (size > MAX_PNPM_FILE_BYTES || fileBytes > MAX_PNPM_TREE_BYTES) {
        throw new Error(`deterministic-pack: ${label} exceeds its declared file-byte bound`)
      }
    }
    offset = nextOffset
  }
  if (!ended || pendingLongPath !== null || entryCount < 1) {
    throw new Error(`deterministic-pack: ${label} has an incomplete tar entry sequence`)
  }
  return Object.freeze({ entryCount, fileBytes })
}

async function auditTarGzArchive(archive, label) {
  const info = await lstat(archive)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_PNPM_TARBALL_BYTES) {
    throw new Error(`deterministic-pack: ${label} is not one bounded regular archive`)
  }
  const bytes = await readFile(archive)
  if (bytes.byteLength !== info.size) throw new Error(`deterministic-pack: ${label} changed while being read`)
  auditTarGzBytes(bytes, { label, rootPrefix: 'package' })
  return bytes
}

function resolveArchiveOperations(dependencies = {}) {
  const runTar = dependencies?.testOnlyTarRunner ?? runChecked
  const beforeAudit = dependencies?.testOnlyBeforeArchiveAudit ?? null
  if (typeof runTar !== 'function' || beforeAudit !== null && typeof beforeAudit !== 'function') {
    throw new Error('deterministic-pack: archive test seams must be functions')
  }
  return Object.freeze({ beforeAudit, runTar })
}

async function runAuditedTar({ archive, destination, kind, label, member, operation }, operations) {
  if (!['extract-member', 'read-member'].includes(operation) || typeof member !== 'string'
    || operation === 'extract-member' && typeof destination !== 'string') {
    throw new Error('deterministic-pack: audited tar operation is invalid')
  }
  const admittedMember = safeTarPath(member, 'package', 'audited tar member')
  const canonicalDestination = operation === 'extract-member'
    ? await realpath(destination)
    : null
  await operations.beforeAudit?.(Object.freeze({ archive, kind }))
  const auditedBytes = await auditTarGzArchive(archive, label)
  const stagingRoot = await mkdtemp(join(tmpdir(), 'dsh-audited-tar-'))
  const stagedArchive = join(stagingRoot, 'archive.tgz')
  try {
    await writeFile(stagedArchive, auditedBytes, { flag: 'wx', mode: 0o600 })
    const args = operation === 'extract-member'
      ? ['-xzf', stagedArchive, '-C', canonicalDestination, admittedMember]
      : ['-xOf', stagedArchive, admittedMember]
    return await operations.runTar(
      process.platform === 'win32' ? join(WINDOWS_SYSTEM_DIRECTORY, 'tar.exe') : '/usr/bin/tar',
      args,
      { cwd: stagingRoot },
      Object.freeze({ kind, sourceArchive: archive, stagedArchive }),
    )
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

async function registryPnpmTree(temporaryRoot, fetchImpl, expectedIntegrity, archiveOperations) {
  const archive = join(temporaryRoot, 'registry-pnpm.tgz')
  const unpackRoot = join(temporaryRoot, 'registry-unpacked')
  const bytes = await fetchVerifiedPnpmTarball(fetchImpl, expectedIntegrity)
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
  await Promise.all([
    writeFile(archive, bytes, { flag: 'wx', mode: 0o600 }),
    mkdir(unpackRoot, { recursive: true, mode: 0o700 }),
  ])
  await runAuditedTar({
    archive,
    destination: unpackRoot,
    kind: 'registry',
    label: 'pnpm registry tarball extraction',
    member: 'package',
    operation: 'extract-member',
  }, archiveOperations)
  return realpath(join(unpackRoot, 'package'))
}

async function hashTree(root, path, hash, state, exclude) {
  const info = await lstat(path)
  const name = relative(root, path).split('\\').join('/') || '.'
  if (info.isSymbolicLink()) {
    throw new Error(`deterministic-pack: bundled pnpm contains a symbolic link: ${name}`)
  }
  if (exclude(name, info)) return
  state.entries += 1
  if (state.entries > MAX_PNPM_TREE_ENTRIES || name.length > 1024
    || name !== '.' && (!/^[ -~]+$/u.test(name)
      || name.split('/').some(segment => segment === '' || segment === '.' || segment === '..'))) {
    throw new Error('deterministic-pack: bundled pnpm tree exceeds its entry or path bound')
  }
  if (info.isFile()) {
    state.bytes += info.size
    if (info.size > MAX_PNPM_FILE_BYTES || state.bytes > MAX_PNPM_TREE_BYTES) {
      throw new Error(`deterministic-pack: bundled pnpm file exceeds its byte bound: ${name}`)
    }
    const bytes = await readFile(path)
    if (bytes.byteLength !== info.size) throw new Error(`deterministic-pack: bundled pnpm file changed while hashing: ${name}`)
    hash.update(`file:${name}:${String(info.size)}\0`)
    hash.update(bytes)
    return
  }
  if (!info.isDirectory()) throw new Error(`deterministic-pack: bundled pnpm has an unsupported entry: ${name}`)
  hash.update(`dir:${name}\0`)
  for (const entry of (await readdir(path, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    await hashTree(root, join(path, entry.name), hash, state, exclude)
  }
}

async function treeDigest(root, options = {}) {
  const hash = createHash('sha256')
  await hashTree(root, root, hash, { bytes: 0, entries: 0 }, options.exclude ?? (() => false))
  return `sha256:${hash.digest('hex')}`
}

function assertPnpmPackageIdentity(manifest, label) {
  const scripts = manifest.scripts !== null && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
    ? Object.keys(manifest.scripts)
    : []
  const lifecycle = scripts.filter(name => /^(?:pre|post)?(?:install|uninstall)$/u.test(name)
    || ['prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack'].includes(name))
  if (manifest.name !== 'pnpm' || manifest.version !== PNPM_VERSION
    || manifest.main !== 'bin/pnpm.mjs'
    || canonicalJson(manifest.exports) !== canonicalJson({ '.': './package.json' })
    || canonicalJson(manifest.bin) !== canonicalJson(PNPM_BIN)
    || canonicalJson(manifest.files) !== canonicalJson(PNPM_PUBLISHED_FILES)
    || manifest.dependencies !== undefined && Object.keys(manifest.dependencies).length > 0
    || lifecycle.length > 0) {
    throw new Error(`deterministic-pack: ${label} private pnpm identity is invalid`)
  }
}

async function authenticatePnpmAuthority({ projectRoot, temporaryRoot }, dependencies = {}) {
  const archiveOperations = resolveArchiveOperations(dependencies)
  const expectedRegistryIntegrity = exactSha512Integrity(
    dependencies?.expectedRegistryIntegrity ?? PNPM_REGISTRY_INTEGRITY,
    'expected pnpm registry integrity',
  )
  const sourceManifest = parseJson(await readFile(join(projectRoot, 'package.json'), 'utf8'), 'source package.json')
  if (sourceManifest.dependencies?.pnpm !== PNPM_VERSION
    || canonicalJson(sourceManifest.bundledDependencies) !== canonicalJson(['pnpm'])) {
    throw new Error('deterministic-pack: source manifest does not bundle exact pnpm@11.21.0')
  }
  const lock = await readFile(join(projectRoot, 'pnpm-lock.yaml'), 'utf8')
  assertPnpmLockIdentity(lock, expectedRegistryIntegrity)
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
  const registryRoot = await registryPnpmTree(
    join(temporaryRoot, 'registry-source'),
    dependencies?.fetchImpl ?? globalThis.fetch,
    expectedRegistryIntegrity,
    archiveOperations,
  )
  const [canonicalProjectRoot, canonicalTemporaryRoot] = await Promise.all([
    realpath(projectRoot),
    realpath(temporaryRoot),
  ])
  const sourceRoot = await realpath(join(projectRoot, 'node_modules', 'pnpm'))
  const pnpmBin = await realpath(join(registryRoot, 'bin', 'pnpm.mjs'))
  if (!isInside(canonicalProjectRoot, sourceRoot) || !isInside(canonicalTemporaryRoot, registryRoot)
    || !isInside(registryRoot, pnpmBin)) {
    throw new Error('deterministic-pack: private pnpm authority escaped its admitted root')
  }
  const installedManifest = parseJson(await readFile(join(sourceRoot, 'package.json'), 'utf8'), 'installed pnpm package.json')
  const registryManifest = parseJson(await readFile(join(registryRoot, 'package.json'), 'utf8'), 'registry pnpm package.json')
  assertPnpmPackageIdentity(installedManifest, 'lock-installed')
  assertPnpmPackageIdentity(registryManifest, 'registry')
  const [registrySourceDigest, installedSourceDigest] = await Promise.all([
    treeDigest(registryRoot),
    treeDigest(sourceRoot, { exclude: name => name === 'node_modules' }),
  ])
  if (registrySourceDigest !== installedSourceDigest) {
    throw new Error('deterministic-pack: lock-installed pnpm bytes differ from the SRI-authenticated registry source')
  }
  return Object.freeze({
    archiveOperations,
    expectedRegistryIntegrity,
    installedSourceDigest,
    pnpmBin,
    projectRoot: canonicalProjectRoot,
    registryRoot,
    sourceRoot,
  })
}

async function assertPnpmAuthorityStillBound(authority) {
  const [registrySourceDigest, installedSourceDigest] = await Promise.all([
    treeDigest(authority.registryRoot),
    treeDigest(authority.sourceRoot, { exclude: name => name === 'node_modules' }),
  ])
  if (registrySourceDigest !== authority.installedSourceDigest
    || installedSourceDigest !== authority.installedSourceDigest) {
    throw new Error('deterministic-pack: authenticated pnpm authority changed after preflight')
  }
}

async function sourcePublicationTree(sourceRoot, temporaryRoot, authority, kind) {
  const archiveRoot = join(temporaryRoot, 'archive')
  const unpackRoot = join(temporaryRoot, 'unpacked')
  await Promise.all([
    mkdir(archiveRoot, { recursive: true, mode: 0o700 }),
    mkdir(unpackRoot, { recursive: true, mode: 0o700 }),
  ])
  await runChecked(process.execPath, [
    authority.pnpmBin,
    'pack',
    '--config.ignore-pnpmfile=true',
    '--config.ignore-scripts=true',
    '--pack-destination',
    archiveRoot,
  ], { cwd: sourceRoot })
  const archive = await singleArchive(archiveRoot, 'private pnpm publication')
  if (basename(archive) !== `pnpm-${PNPM_VERSION}.tgz`) {
    throw new Error('deterministic-pack: private pnpm publication archive name is invalid')
  }
  await runAuditedTar({
    archive,
    destination: unpackRoot,
    kind,
    label: `${kind} tarball`,
    member: 'package',
    operation: 'extract-member',
  }, authority.archiveOperations)
  return realpath(join(unpackRoot, 'package'))
}

async function assertPackedPnpmExecutable(packedRoot) {
  const result = await runChecked(process.execPath, [join(packedRoot, 'bin', 'pnpm.mjs'), '--version'], {
    cwd: packedRoot,
    maximumStdoutBytes: 4096,
    maximumStderrBytes: 4096,
    maximumTotalBytes: 4096,
  })
  if (result.stdout.trim() !== PNPM_VERSION || result.stderr.trim() !== '') {
    throw new Error(`deterministic-pack: packed private pnpm does not execute as pnpm@${PNPM_VERSION}`)
  }
}

async function inspectBundledPnpmWithAuthority({ archive, projectRoot, temporaryRoot }, authority) {
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
  const [canonicalProjectRoot, canonicalTemporaryRoot] = await Promise.all([
    realpath(projectRoot),
    realpath(temporaryRoot),
  ])
  if (canonicalProjectRoot !== authority.projectRoot) {
    throw new Error('deterministic-pack: packed pnpm inspection changed its authenticated project root')
  }
  await assertPnpmAuthorityStillBound(authority)
  const registryPublicationRoot = await sourcePublicationTree(
    authority.registryRoot,
    join(temporaryRoot, 'registry-publication'),
    authority,
    'registry-publication',
  )
  const installedPublicationRoot = await sourcePublicationTree(
    authority.sourceRoot,
    join(temporaryRoot, 'installed-publication'),
    authority,
    'installed-publication',
  )
  await runAuditedTar({
    archive,
    destination: temporaryRoot,
    kind: 'main',
    label: 'main packed pnpm archive',
    member: 'package/node_modules/pnpm',
    operation: 'extract-member',
  }, authority.archiveOperations)
  const packedRoot = await realpath(join(temporaryRoot, 'package', 'node_modules', 'pnpm'))
  if (!isInside(canonicalTemporaryRoot, packedRoot)) {
    throw new Error('deterministic-pack: private pnpm package escaped its admitted root')
  }
  const packedManifest = parseJson(await readFile(join(packedRoot, 'package.json'), 'utf8'), 'packed pnpm package.json')
  assertPnpmPackageIdentity(packedManifest, 'packed')
  const [registryPublicationDigest, installedPublicationDigest, packedDigest] = await Promise.all([
    treeDigest(registryPublicationRoot),
    treeDigest(installedPublicationRoot),
    treeDigest(packedRoot),
  ])
  if (registryPublicationDigest !== installedPublicationDigest || registryPublicationDigest !== packedDigest) {
    throw new Error('deterministic-pack: private pnpm publication views do not match the SRI-authenticated packed tree')
  }
  await assertPackedPnpmExecutable(packedRoot)
  return packedDigest
}

/** Verify the packed private pnpm against the SRI-authenticated registry source and both publication views. */
export async function inspectBundledPnpm(input, dependencies = {}) {
  const authority = await authenticatePnpmAuthority({
    projectRoot: input.projectRoot,
    temporaryRoot: join(input.temporaryRoot, 'pnpm-authority'),
  }, dependencies)
  return inspectBundledPnpmWithAuthority(input, authority)
}

function assertExactOutputRoot(projectRoot, outputRoot) {
  const expected = resolve(projectRoot, OUTPUT_RELATIVE_PATH)
  if (outputRoot !== expected || !isInside(projectRoot, outputRoot)) {
    throw new Error('deterministic-pack: output must be the exact .artifacts/release-candidate directory')
  }
}

async function singleArchive(directory, pass) {
  const entries = await readdir(directory)
  if (entries.length !== 1 || !entries[0].endsWith('.tgz')) {
    throw new Error(`deterministic-pack: pass ${String(pass)} produced ${String(entries.length)} output files instead of one tgz`)
  }
  return join(directory, entries[0])
}

async function runPnpmPack({ projectRoot, destination }, authority) {
  if (await realpath(projectRoot) !== authority.projectRoot) {
    throw new Error('deterministic-pack: main pack changed its authenticated project root')
  }
  await runChecked(process.execPath, [
    authority.pnpmBin,
    'pack',
    '--config.ignore-pnpmfile=true',
    '--config.ignore-scripts=true',
    '--pack-destination',
    destination,
  ], { cwd: projectRoot })
}

async function readManifestFromTar(archive, archiveOperations = resolveArchiveOperations()) {
  const result = await runAuditedTar({
    archive,
    kind: 'main-manifest',
    label: 'packed manifest archive',
    member: 'package/package.json',
    operation: 'read-member',
  }, archiveOperations)
  return parseJson(result.stdout, 'packed package.json')
}

async function readManifestBytesFromTar(archive, archiveOperations = resolveArchiveOperations()) {
  const result = await runAuditedTar({
    archive,
    kind: 'main-manifest-bytes',
    label: 'packed manifest bytes archive',
    member: 'package/package.json',
    operation: 'read-member',
  }, archiveOperations)
  return Buffer.from(result.stdout)
}

function positiveRunBound(value, fallback, label) {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error(`deterministic-pack: ${label} must be a positive safe integer`)
  }
  return selected
}

function minimalProcessEnvironment() {
  const temporary = tmpdir()
  const environment = {
    CI: '1',
    HOME: join(temporary, 'dsh-deterministic-pack-no-home'),
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    NPM_CONFIG_IGNORE_PNPMFILE: 'true',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_USERCONFIG: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PATH: process.platform === 'win32'
      ? WINDOWS_SYSTEM_DIRECTORY
      : '/usr/bin:/bin',
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
  }
  if (process.platform === 'win32') {
    environment.ComSpec = process.env.ComSpec ?? join(WINDOWS_SYSTEM_DIRECTORY, 'cmd.exe')
    environment.SystemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  }
  return environment
}

function signalChildTree(child) {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return true
    } catch (error) {
      if (error?.code === 'ESRCH') return false
    }
  }
  try {
    return child.kill('SIGKILL')
  } catch {
    return false
  }
}

/** Run one subprocess with fixed environment, output limits, deadline, and owned process-group teardown. */
export function runChecked(command, args, options) {
  const timeoutMs = positiveRunBound(options?.timeoutMs, DEFAULT_PROCESS_TIMEOUT_MS, 'process timeout')
  const maximumStdoutBytes = positiveRunBound(
    options?.maximumStdoutBytes,
    DEFAULT_PROCESS_STDOUT_BYTES,
    'stdout byte bound',
  )
  const maximumStderrBytes = positiveRunBound(
    options?.maximumStderrBytes,
    DEFAULT_PROCESS_STDERR_BYTES,
    'stderr byte bound',
  )
  const maximumTotalBytes = positiveRunBound(
    options?.maximumTotalBytes,
    DEFAULT_PROCESS_TOTAL_BYTES,
    'combined output byte bound',
  )
  const killCloseMs = positiveRunBound(
    options?.killCloseMs,
    DEFAULT_PROCESS_KILL_CLOSE_MS,
    'kill-to-close timeout',
  )
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: minimalProcessEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminationReason = null
    let settled = false
    let killCloseTimer
    const settle = callback => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(killCloseTimer)
      callback()
    }
    const diagnostic = () => `stdoutBytes=${String(stdoutBytes)}, stderrBytes=${String(stderrBytes)}`
    const terminate = reason => {
      if (settled || terminationReason !== null) return
      terminationReason = reason
      signalChildTree(child)
      killCloseTimer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        settle(() => rejectRun(new Error(`deterministic-pack: ${command} ${reason} and did not close after SIGKILL (${diagnostic()})`)))
      }, killCloseMs)
    }
    const timeoutTimer = setTimeout(() => terminate('timed out'), timeoutMs)
    const capture = (target, chunk, stream) => {
      const bytes = Buffer.from(chunk)
      if (stream === 'stdout') stdoutBytes += bytes.byteLength
      else stderrBytes += bytes.byteLength
      if (stdoutBytes > maximumStdoutBytes || stderrBytes > maximumStderrBytes
        || stdoutBytes + stderrBytes > maximumTotalBytes) {
        terminate('exceeded its output byte bound')
        return
      }
      target.push(bytes)
    }
    child.stdout.on('data', chunk => capture(stdout, chunk, 'stdout'))
    child.stderr.on('data', chunk => capture(stderr, chunk, 'stderr'))
    child.stdout.once('error', () => terminate('stdout stream failed'))
    child.stderr.once('error', () => terminate('stderr stream failed'))
    child.once('error', error => {
      settle(() => rejectRun(new Error(`deterministic-pack: ${command} could not be executed`, { cause: error })))
    })
    child.once('close', (code, signal) => {
      if (terminationReason !== null) {
        settle(() => rejectRun(new Error(`deterministic-pack: ${command} ${terminationReason} (${diagnostic()})`)))
        return
      }
      const residualGroup = signalChildTree(child)
      if (code === 0 && !residualGroup) {
        settle(() => resolveRun({
          stdout: Buffer.concat(stdout, stdoutBytes).toString('utf8'),
          stderr: Buffer.concat(stderr, stderrBytes).toString('utf8'),
        }))
        return
      }
      const outcome = residualGroup ? 'left a running process group' : `failed with ${signal ?? String(code)}`
      settle(() => rejectRun(new Error(`deterministic-pack: ${command} ${outcome} (${diagnostic()})`)))
    })
  })
}

function parseJson(text, subject) {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`deterministic-pack: ${subject} is not JSON`, { cause })
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function isInside(root, path) {
  const offset = relative(root, path)
  return offset === '' || offset !== '..' && !offset.startsWith(`..${sep}`)
}

const mainPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (mainPath === fileURLToPath(import.meta.url)) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const result = await verifyDeterministicPack({
      projectRoot,
      outputRoot: join(projectRoot, OUTPUT_RELATIVE_PATH),
      provenance: githubProvenanceFromEnvironment(process.env),
    })
    process.stdout.write(`deterministic-pack: ${result.archivePath}\n`)
    process.stdout.write(`deterministic-pack: ${result.sha256}  ${result.filename}\n`)
    process.stdout.write(`deterministic-pack: bundled pnpm@${PNPM_VERSION} ${PNPM_REGISTRY_INTEGRITY} ${result.pnpmTreeSha256}\n`)
    if (result.attestationPath !== null) process.stdout.write(`deterministic-pack: ${result.attestationPath}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
