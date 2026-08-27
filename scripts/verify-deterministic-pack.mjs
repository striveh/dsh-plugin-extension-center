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
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_PACKAGE_NAME = 'dsh-plugin-extension-center'
const PNPM_VERSION = '11.7.0'
const PNPM_REGISTRY_INTEGRITY = 'sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA=='
const OUTPUT_RELATIVE_PATH = join('.artifacts', 'release-candidate')
const ATTESTATION_FILENAME = 'pack-attestation.json'
const COMMIT = /^[0-9a-f]{40}$/u

/**
 * Pack the current built inputs twice and publish only byte-identical evidence.
 * @param {{projectRoot: string, outputRoot: string, runPack?: Function, readPackedManifest?: Function, inspectPackedToolchain?: Function}} options Verification options.
 * @returns {Promise<{archivePath: string, sumsPath: string, filename: string, sha256: string, pnpmTreeSha256: string}>} Published evidence.
 */
export async function verifyDeterministicPack(options) {
  const projectRoot = resolve(options.projectRoot)
  const outputRoot = resolve(options.outputRoot)
  assertExactOutputRoot(projectRoot, outputRoot)
  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })

  const runPack = options.runPack ?? runPnpmPack
  const readPackedManifest = options.readPackedManifest ?? readManifestFromTar
  const inspectPackedToolchain = options.inspectPackedToolchain ?? inspectBundledPnpm
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-extension-center-pack-'))
  try {
    const sourceManifestBytes = await readFile(join(projectRoot, 'package.json'))
    const sourceManifest = parseJson(sourceManifestBytes.toString('utf8'), 'source package.json')
    assertManifestIdentity(sourceManifest, sourceManifest, 0)
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
    const [firstBytes, secondBytes] = await Promise.all(archives.map(path => readFile(path)))
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
      const readPackedManifestBytes = options.readPackedManifestBytes ?? readManifestBytesFromTar
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

async function hashTree(root, path, hash) {
  const info = await lstat(path)
  const name = relative(root, path).split('\\').join('/') || '.'
  if (info.isSymbolicLink()) {
    hash.update(`link:${name}:${await readlink(path)}\0`)
    return
  }
  if (info.isFile()) {
    if (info.size > 64 * 1024 * 1024) throw new Error(`deterministic-pack: bundled pnpm file exceeds its byte bound: ${name}`)
    hash.update(`file:${name}:${String(info.size)}\0`)
    hash.update(await readFile(path))
    return
  }
  if (!info.isDirectory()) throw new Error(`deterministic-pack: bundled pnpm has an unsupported entry: ${name}`)
  hash.update(`dir:${name}\0`)
  for (const entry of (await readdir(path, { withFileTypes: true }))
    .filter(entry => !(path === root && entry.name === 'node_modules'))
    .filter(entry => !(path === join(root, 'node_modules') && entry.name === '.bin'))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    await hashTree(root, join(path, entry.name), hash)
  }
}

async function treeDigest(root) {
  const hash = createHash('sha256')
  await hashTree(root, root, hash)
  return `sha256:${hash.digest('hex')}`
}

/** Verify the packed private pnpm is the exact lock-pinned source tree copied by recovery installation. */
export async function inspectBundledPnpm({ archive, projectRoot, temporaryRoot }) {
  const sourceManifest = parseJson(await readFile(join(projectRoot, 'package.json'), 'utf8'), 'source package.json')
  if (sourceManifest.dependencies?.pnpm !== PNPM_VERSION
    || canonicalJson(sourceManifest.bundledDependencies) !== canonicalJson(['pnpm'])) {
    throw new Error('deterministic-pack: source manifest does not bundle exact pnpm@11.7.0')
  }
  const lock = await readFile(join(projectRoot, 'pnpm-lock.yaml'), 'utf8')
  if (!lock.includes(`pnpm@${PNPM_VERSION}:\n    resolution: {integrity: ${PNPM_REGISTRY_INTEGRITY}}`)) {
    throw new Error('deterministic-pack: lockfile does not pin the expected pnpm registry SRI')
  }
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
  await runChecked('tar', [
    '-xzf', archive, '-C', temporaryRoot, 'package/node_modules/pnpm',
  ], dirname(archive))
  const sourceRoot = await realpath(join(projectRoot, 'node_modules', 'pnpm'))
  const packedRoot = await realpath(join(temporaryRoot, 'package', 'node_modules', 'pnpm'))
  const packedManifest = parseJson(await readFile(join(packedRoot, 'package.json'), 'utf8'), 'packed pnpm package.json')
  if (packedManifest.name !== 'pnpm' || packedManifest.version !== PNPM_VERSION
    || packedManifest.bin?.pnpm !== 'bin/pnpm.mjs'
    || packedManifest.dependencies !== undefined && Object.keys(packedManifest.dependencies).length > 0) {
    throw new Error('deterministic-pack: packed private pnpm identity is invalid')
  }
  const [sourceDigest, packedDigest] = await Promise.all([treeDigest(sourceRoot), treeDigest(packedRoot)])
  if (sourceDigest !== packedDigest) throw new Error('deterministic-pack: packed private pnpm tree differs from the lock-installed source')
  return sourceDigest
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

async function runPnpmPack({ projectRoot, destination }) {
  await runChecked('pnpm', ['pack', '--pack-destination', destination], projectRoot)
}

async function readManifestFromTar(archive) {
  const result = await runChecked('tar', ['-xOf', archive, 'package/package.json'], dirname(archive))
  return parseJson(result.stdout, 'packed package.json')
}

async function readManifestBytesFromTar(archive) {
  const result = await runChecked('tar', ['-xOf', archive, 'package/package.json'], dirname(archive))
  return Buffer.from(result.stdout)
}

function runChecked(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', rejectRun)
    child.once('close', (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr })
      else rejectRun(new Error(`deterministic-pack: ${command} failed with ${signal ?? String(code)} (stdoutBytes=${String(Buffer.byteLength(stdout))}, stderrBytes=${String(Buffer.byteLength(stderr))})`))
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
