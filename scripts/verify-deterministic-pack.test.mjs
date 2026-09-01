import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  auditTarGzBytes,
  assertManifestIdentity,
  githubProvenanceFromEnvironment,
  inspectBundledPnpm,
  runChecked,
  verifyDeterministicPack,
} from './verify-deterministic-pack.mjs'

const PNPM_VERSION = '11.21.0'
const PNPM_REGISTRY_TARBALL = `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REAL_PNPM_BIN = join(PROJECT_ROOT, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')

function writeTarOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0')
  header.write(text, offset, length - 1, 'ascii')
}

function tarHeader({ name, type = '0', linkName = '', bytes = Buffer.alloc(0) }) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'ascii')
  writeTarOctal(header, 100, 8, 0o644)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, bytes.byteLength)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write(linkName, 157, 100, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

function tarGz(entries) {
  const blocks = []
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes ?? '')
    blocks.push(tarHeader({ ...entry, bytes }), bytes)
    const padding = (512 - bytes.byteLength % 512) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function pnpmLock(integrity) {
  return [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      pnpm:',
    `        specifier: ${PNPM_VERSION}`,
    `        version: ${PNPM_VERSION}`,
    'packages:',
    `  pnpm@${PNPM_VERSION}:`,
    `    resolution: {integrity: ${integrity}}`,
    'snapshots:',
    `  pnpm@${PNPM_VERSION}: {}`,
    '',
  ].join('\n')
}

function manifest(version = '0.0.0-development') {
  return {
    name: 'dsh-plugin-extension-center',
    version,
    private: true,
    type: 'module',
    main: 'lib/index.js',
    types: 'lib/types/index.d.ts',
    exports: { '.': { default: './lib/index.js' } },
    files: ['lib', 'cordis.patch.yml'],
    engines: { dsh: '0.1.2-alpha.3' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dependencies: { pnpm: '11.21.0' },
    bundledDependencies: ['pnpm'],
    scripts: { test: 'node --test' },
  }
}

async function inspectPackedToolchain() {
  return `sha256:${'a'.repeat(64)}`
}

async function fixture(version = '0.0.0-development') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-deterministic-pack-test-'))
  const projectRoot = join(root, 'project')
  const outputRoot = join(projectRoot, '.artifacts', 'release-candidate')
  await mkdir(outputRoot, { recursive: true })
  await writeFile(join(projectRoot, 'package.json'), `${JSON.stringify(manifest(version), null, 2)}\n`)
  return { root, projectRoot, outputRoot }
}

function run(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', rejectRun)
    child.once('close', (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr })
      else rejectRun(new Error(`${command} failed with ${signal ?? String(code)}`))
    })
  })
}

async function bundledPnpmFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-packed-pnpm-test-'))
  const projectRoot = join(root, 'project')
  const sourceRoot = join(projectRoot, 'node_modules', 'pnpm')
  const registryStage = join(root, 'registry-stage')
  const registryArchive = join(root, 'registry-pnpm.tgz')
  const packedArchiveRoot = join(root, 'packed-archive')
  const packedPublicationRoot = join(root, 'packed-publication')
  const outerRoot = join(root, 'outer')
  const archive = join(root, 'center.tgz')
  const executionLog = join(root, 'pnpm-executions.jsonl')
  const counterfeitMarker = join(root, 'counterfeit-installed-executed')
  const counterfeitCount = join(root, 'counterfeit-installed-count')
  const pnpmfileMarker = join(root, 'project-pnpmfile-executed')
  await Promise.all([
    mkdir(join(sourceRoot, 'bin'), { recursive: true }),
    mkdir(join(sourceRoot, 'dist'), { recursive: true }),
    mkdir(join(sourceRoot, 'artifacts', 'source-only'), { recursive: true }),
    mkdir(registryStage, { recursive: true }),
    mkdir(packedArchiveRoot, { recursive: true }),
    mkdir(packedPublicationRoot, { recursive: true }),
    mkdir(join(outerRoot, 'package', 'node_modules'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(projectRoot, 'package.json'), `${JSON.stringify(manifest(), null, 2)}\n`),
    writeFile(join(projectRoot, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\n'),
    writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'pnpm',
      version: PNPM_VERSION,
      type: 'module',
      main: 'bin/pnpm.mjs',
      exports: { '.': './package.json' },
      bin: {
        pnpm: 'bin/pnpm.mjs',
        pnpx: 'bin/pnpx.mjs',
        pn: 'bin/pnpm.mjs',
        pnx: 'bin/pnpx.mjs',
      },
      files: ['dist', '!dist/**/*.map', 'bin'],
    }, null, 2)),
    writeFile(join(sourceRoot, 'bin', 'pnpm.mjs'), [
      "import { spawnSync } from 'node:child_process'",
      "import { appendFileSync } from 'node:fs'",
      "import { fileURLToPath } from 'node:url'",
      `appendFileSync(${JSON.stringify(executionLog)}, JSON.stringify({ bin: fileURLToPath(import.meta.url), cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n')`,
      "if (process.argv[2] === '--version') {",
      `  process.stdout.write(${JSON.stringify(`${options.reportedVersion ?? PNPM_VERSION}\n`)})`,
      '} else {',
      `  const child = spawnSync(process.execPath, [${JSON.stringify(REAL_PNPM_BIN)}, ...process.argv.slice(2)], { cwd: process.cwd(), env: process.env, stdio: 'inherit' })`,
      '  if (child.error !== undefined) throw child.error',
      '  process.exitCode = child.status ?? 1',
      '}',
      '',
    ].join('\n')),
    writeFile(join(sourceRoot, 'bin', 'pnpx.mjs'), 'process.stdout.write("pnpx fixture\\n")\n'),
    writeFile(join(sourceRoot, 'dist', 'worker.js'), 'export const worker = true\n'),
    writeFile(join(sourceRoot, 'CHANGELOG.md'), 'source-only release history\n'),
    writeFile(join(sourceRoot, 'artifacts', 'source-only', 'builder.js'), 'source-only build input\n'),
  ])
  await cp(sourceRoot, join(registryStage, 'package'), { recursive: true })
  await run('tar', ['-czf', registryArchive, '-C', registryStage, 'package'], root)
  const registryBytes = await readFile(registryArchive)
  const registryIntegrity = `sha512-${createHash('sha512').update(registryBytes).digest('base64')}`
  await writeFile(join(projectRoot, 'pnpm-lock.yaml'), pnpmLock(registryIntegrity))
  if (options.mutateInstalledAfterRegistry === true) {
    await writeFile(join(sourceRoot, 'dist', 'worker.js'), 'export const worker = "counterfeit"\n')
  }
  await run(process.execPath, [join(sourceRoot, 'bin', 'pnpm.mjs'), 'pack', '--pack-destination', packedArchiveRoot], sourceRoot)
  await run('tar', ['-xzf', join(packedArchiveRoot, `pnpm-${PNPM_VERSION}.tgz`), '-C', packedPublicationRoot], root)
  if (options.mutatePackedExecutable === true) {
    await writeFile(join(packedPublicationRoot, 'package', 'bin', 'pnpm.mjs'), 'process.stdout.write("forged\\n")\n')
  }
  await Promise.all([
    cp(join(packedPublicationRoot, 'package'), join(outerRoot, 'package', 'node_modules', 'pnpm'), { recursive: true }),
    writeFile(join(outerRoot, 'package', 'package.json'), `${JSON.stringify(manifest(), null, 2)}\n`),
  ])
  await run('tar', ['-czf', archive, '-C', outerRoot, 'package'], root)
  if (options.poisonPnpmfile === true) {
    await writeFile(join(projectRoot, '.pnpmfile.cjs'), [
      "const { writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(pnpmfileMarker)}, 'executed')`,
      'module.exports = { hooks: { beforePacking: manifest => manifest } }',
      '',
    ].join('\n'))
  }
  if (options.counterfeitInstalledEntrypoint === true) {
    const genuineEntrypoint = await readFile(join(sourceRoot, 'bin', 'pnpm.mjs'))
    await writeFile(join(sourceRoot, 'bin', 'pnpm.mjs'), [
      "import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "import { fileURLToPath } from 'node:url'",
      `const countPath = ${JSON.stringify(counterfeitCount)}`,
      'const count = (existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0) + 1',
      'writeFileSync(countPath, String(count))',
      `writeFileSync(${JSON.stringify(counterfeitMarker)}, 'executed')`,
      "const flag = process.argv.indexOf('--pack-destination')",
      "if (flag < 0 || process.argv[flag + 1] === undefined) throw new Error('missing pack destination')",
      `copyFileSync(${JSON.stringify(archive)}, join(process.argv[flag + 1], ${JSON.stringify(`dsh-plugin-extension-center-${manifest().version}.tgz`)}))`,
      `if (count >= 2) writeFileSync(fileURLToPath(import.meta.url), Buffer.from(${JSON.stringify(genuineEntrypoint.toString('base64'))}, 'base64'))`,
      '',
    ].join('\n'))
  }
  await rm(executionLog, { force: true })
  return {
    archive,
    counterfeitMarker,
    executionLog,
    outputRoot: join(projectRoot, '.artifacts', 'release-candidate'),
    projectRoot,
    pnpmfileMarker,
    registryBytes,
    registryIntegrity,
    root,
    sourceRoot,
    sourceOnlyPath: join(sourceRoot, 'artifacts', 'source-only', 'builder.js'),
    temporaryRoot: join(root, 'inspect'),
  }
}

function registryFixtureDependencies(paths, bytes = paths.registryBytes) {
  return {
    expectedRegistryIntegrity: paths.registryIntegrity,
    async fetchImpl(url, init) {
      assert.equal(url, PNPM_REGISTRY_TARBALL)
      assert.equal(init.redirect, 'error')
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      })
    },
  }
}

function recordTarExtractions(dependencies) {
  const calls = []
  return {
    calls,
    dependencies: {
      ...dependencies,
      async testOnlyTarRunner(command, args, options, context) {
        calls.push(Object.freeze({
          args: [...args],
          kind: context.kind,
          sourceArchive: context.sourceArchive,
          stagedArchive: context.stagedArchive,
          stagedBytes: await readFile(context.stagedArchive),
        }))
        return runChecked(command, args, options)
      },
    },
  }
}

async function assertPrivateStagedArchive(call) {
  assert.equal(call.args[1], call.stagedArchive)
  assert.notEqual(call.stagedArchive, call.sourceArchive)
  assert.deepEqual(call.stagedBytes, await readFile(call.sourceArchive))
  await assert.rejects(access(call.stagedArchive), error => error?.code === 'ENOENT')
}

test('deterministic verifier replaces stale evidence with one tgz and SHA256SUMS', async () => {
  const paths = await fixture()
  try {
    await writeFile(join(paths.outputRoot, 'stale'), 'stale')
    const bytes = Buffer.from('deterministic archive fixture')
    let packs = 0
    const result = await verifyDeterministicPack({
      projectRoot: paths.projectRoot,
      outputRoot: paths.outputRoot,
      async runPack({ destination }) {
        packs += 1
        await writeFile(join(destination, 'dsh-plugin-extension-center-0.0.0-development.tgz'), bytes)
      },
      async readPackedManifest() {
        return manifest()
      },
      inspectPackedToolchain,
    })
    const digest = createHash('sha256').update(bytes).digest('hex')
    assert.equal(packs, 2)
    assert.equal(result.sha256, digest)
    assert.deepEqual((await readdir(paths.outputRoot)).sort(), [
      'SHA256SUMS',
      'dsh-plugin-extension-center-0.0.0-development.tgz',
    ])
    assert.deepEqual(await readFile(result.archivePath), bytes)
    assert.equal(await readFile(result.sumsPath, 'utf8'), `${digest}  ${result.filename}\n`)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('writes a self-digested exact-run attestation beside the byte-identical tgz', async () => {
  const paths = await fixture('0.1.0-rc.0')
  try {
    const bytes = Buffer.from('attested deterministic archive fixture')
    const packedManifestBytes = Buffer.from(`${JSON.stringify(manifest('0.1.0-rc.0'))}\n`)
    const result = await verifyDeterministicPack({
      projectRoot: paths.projectRoot,
      outputRoot: paths.outputRoot,
      provenance: {
        repository: 'striveh/dsh-plugin-extension-center',
        event: 'push',
        ref: 'refs/heads/main',
        commit: 'b'.repeat(40),
        runId: 123,
        runAttempt: 2,
        job: 'verify',
      },
      async runPack({ destination }) {
        await writeFile(join(destination, 'dsh-plugin-extension-center-0.1.0-rc.0.tgz'), bytes)
      },
      async readPackedManifest() {
        return manifest('0.1.0-rc.0')
      },
      async readPackedManifestBytes() {
        return packedManifestBytes
      },
      inspectPackedToolchain,
    })
    assert.deepEqual((await readdir(paths.outputRoot)).sort(), [
      'SHA256SUMS',
      'dsh-plugin-extension-center-0.1.0-rc.0.tgz',
      'pack-attestation.json',
    ])
    const written = JSON.parse(await readFile(result.attestationPath, 'utf8'))
    assert.equal(written.commit, 'b'.repeat(40))
    assert.equal(written.runId, 123)
    assert.equal(written.runAttempt, 2)
    assert.equal(written.artifact.sha256, `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    assert.equal(written.artifact.manifestSha256, `sha256:${createHash('sha256').update(packedManifestBytes).digest('hex')}`)
    assert.equal(written.attestationDigest.length, 'sha256:'.length + 64)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('selects provenance only for the exact main push verify job', () => {
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'striveh/dsh-plugin-extension-center',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'c'.repeat(40),
    GITHUB_RUN_ID: '55',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'verify',
  }
  assert.equal(githubProvenanceFromEnvironment(environment).commit, 'c'.repeat(40))
  assert.equal(githubProvenanceFromEnvironment({ ...environment, GITHUB_JOB: 'rc2-acceptance' }), null)
  assert.equal(githubProvenanceFromEnvironment({ ...environment, GITHUB_EVENT_NAME: 'pull_request' }), null)
  assert.equal(githubProvenanceFromEnvironment({}), null)
})

test('deterministic verifier rejects byte drift and publishes no candidate', async () => {
  const paths = await fixture()
  try {
    await assert.rejects(
      verifyDeterministicPack({
        projectRoot: paths.projectRoot,
        outputRoot: paths.outputRoot,
        async runPack({ destination, pass }) {
          await writeFile(join(destination, 'fixture.tgz'), `pass-${String(pass)}`)
        },
        async readPackedManifest() {
          return manifest()
        },
        inspectPackedToolchain,
      }),
      /not byte-identical/u,
    )
    assert.deepEqual(await readdir(paths.outputRoot), [])
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('deterministic verifier rejects multiple pack outputs', async () => {
  const paths = await fixture()
  try {
    await assert.rejects(
      verifyDeterministicPack({
        projectRoot: paths.projectRoot,
        outputRoot: paths.outputRoot,
        async runPack({ destination }) {
          await writeFile(join(destination, 'one.tgz'), 'one')
          await writeFile(join(destination, 'two.tgz'), 'two')
        },
        async readPackedManifest() {
          return manifest()
        },
        inspectPackedToolchain,
      }),
      /instead of one tgz/u,
    )
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('packed manifest identity must match the source manifest', () => {
  assert.throws(
    () => assertManifestIdentity(manifest(), manifest('0.0.1'), 2),
    /manifest changed version/u,
  )
  assert.throws(
    () => assertManifestIdentity(manifest(), { ...manifest(), bin: { center: 'bin.js' } }, 1),
    /declared a package bin/u,
  )
})

test('deterministic verifier refuses any output directory outside the exact evidence path', async () => {
  const paths = await fixture()
  try {
    await assert.rejects(
      verifyDeterministicPack({
        projectRoot: paths.projectRoot,
        outputRoot: join(paths.projectRoot, '.artifacts'),
        inspectPackedToolchain,
      }),
      /exact \.artifacts\/release-candidate directory/u,
    )
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('bundled pnpm proof compares the packed tree with the lock-installed publication view', async () => {
  const paths = await bundledPnpmFixture()
  try {
    assert.equal(await readFile(paths.sourceOnlyPath, 'utf8'), 'source-only build input\n')
    const listing = await run('tar', ['-tzf', paths.archive], paths.root)
    assert.doesNotMatch(listing.stdout, /CHANGELOG|artifacts\/source-only/u)
    assert.match(
      await inspectBundledPnpm(paths, registryFixtureDependencies(paths)),
      /^sha256:[0-9a-f]{64}$/u,
    )
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('bundled pnpm proof rejects a changed packed executable', async () => {
  const paths = await bundledPnpmFixture({ mutatePackedExecutable: true })
  try {
    await assert.rejects(
      inspectBundledPnpm(paths, registryFixtureDependencies(paths)),
      /publication views do not match/u,
    )
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('bundled pnpm proof requires the matching publication tree to execute as the pinned version', async () => {
  const paths = await bundledPnpmFixture({ reportedVersion: '11.20.0' })
  try {
    await assert.rejects(
      inspectBundledPnpm(paths, registryFixtureDependencies(paths)),
      /does not execute as pnpm@11\.21\.0/u,
    )
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('bundled pnpm publication never delegates its comparison rule to PATH', async () => {
  const paths = await bundledPnpmFixture()
  const poisonedBin = join(paths.root, 'poisoned-bin')
  const marker = join(paths.root, 'path-pnpm-was-called')
  const previousPath = process.env.PATH
  try {
    await mkdir(poisonedBin)
    const fakePnpm = join(poisonedBin, 'pnpm')
    await writeFile(fakePnpm, `#!/bin/sh\nprintf called > ${JSON.stringify(marker)}\nexit 73\n`)
    await chmod(fakePnpm, 0o700)
    process.env.PATH = `${poisonedBin}:${previousPath ?? ''}`
    assert.match(
      await inspectBundledPnpm(paths, registryFixtureDependencies(paths)),
      /^sha256:[0-9a-f]{64}$/u,
    )
    await assert.rejects(access(marker), error => error?.code === 'ENOENT')
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('bundled pnpm proof rejects matching installed and packed counterfeit bytes', async () => {
  const paths = await bundledPnpmFixture({ mutateInstalledAfterRegistry: true })
  try {
    await assert.rejects(
      inspectBundledPnpm(paths, registryFixtureDependencies(paths)),
      /lock-installed pnpm bytes differ from the SRI-authenticated registry source/u,
    )
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('default verifier rejects a self-restoring installed packer before it can execute', async () => {
  const paths = await bundledPnpmFixture({ counterfeitInstalledEntrypoint: true })
  try {
    await assert.rejects(
      verifyDeterministicPack({
        projectRoot: paths.projectRoot,
        outputRoot: paths.outputRoot,
        registryDependencies: registryFixtureDependencies(paths),
      }),
      /lock-installed pnpm bytes differ from the SRI-authenticated registry source/u,
    )
    await assert.rejects(access(paths.counterfeitMarker), error => error?.code === 'ENOENT')
    assert.match(await readFile(join(paths.sourceRoot, 'bin', 'pnpm.mjs'), 'utf8'), /counterfeit-installed-count/u)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('default verifier uses only the authenticated registry executable for both main packs', async () => {
  const paths = await bundledPnpmFixture()
  const registryDependencies = registryFixtureDependencies(paths)
  let fetches = 0
  const fixtureFetch = registryDependencies.fetchImpl
  registryDependencies.fetchImpl = async (...args) => {
    fetches += 1
    return fixtureFetch(...args)
  }
  try {
    const result = await verifyDeterministicPack({
      projectRoot: paths.projectRoot,
      outputRoot: paths.outputRoot,
      registryDependencies,
    })
    assert.match(result.pnpmTreeSha256, /^sha256:[0-9a-f]{64}$/u)
    assert.equal(fetches, 1)
    const executions = (await readFile(paths.executionLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const canonicalProjectRoot = await realpath(paths.projectRoot)
    const mainPacks = executions.filter(entry => entry.cwd === canonicalProjectRoot && entry.args[0] === 'pack')
    assert.equal(mainPacks.length, 2, JSON.stringify(executions))
    for (const entry of mainPacks) {
      assert.notEqual(entry.bin, join(paths.sourceRoot, 'bin', 'pnpm.mjs'))
      assert.match(entry.bin, /pnpm-authority\/registry-source\/registry-unpacked\/package\/bin\/pnpm\.mjs$/u)
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('authenticated pack execution does not load a project pnpmfile hook', async () => {
  const paths = await bundledPnpmFixture({ poisonPnpmfile: true })
  try {
    const result = await verifyDeterministicPack({
      projectRoot: paths.projectRoot,
      outputRoot: paths.outputRoot,
      registryDependencies: registryFixtureDependencies(paths),
    })
    assert.match(result.pnpmTreeSha256, /^sha256:[0-9a-f]{64}$/u)
    await assert.rejects(access(paths.pnpmfileMarker), error => error?.code === 'ENOENT')
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('default real inspection digest is the pnpm tree digest written into attestation', async () => {
  const paths = await bundledPnpmFixture()
  try {
    const result = await verifyDeterministicPack({
      projectRoot: paths.projectRoot,
      outputRoot: paths.outputRoot,
      provenance: {
        repository: 'striveh/dsh-plugin-extension-center',
        event: 'push',
        ref: 'refs/heads/main',
        commit: 'd'.repeat(40),
        runId: 456,
        runAttempt: 1,
        job: 'verify',
      },
      registryDependencies: registryFixtureDependencies(paths),
    })
    const written = JSON.parse(await readFile(result.attestationPath, 'utf8'))
    assert.match(result.pnpmTreeSha256, /^sha256:[0-9a-f]{64}$/u)
    assert.notEqual(result.pnpmTreeSha256, `sha256:${'a'.repeat(64)}`)
    assert.equal(result.attestation.artifact.pnpmTreeSha256, result.pnpmTreeSha256)
    assert.equal(written.artifact.pnpmTreeSha256, result.pnpmTreeSha256)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('tar preflight accepts one bounded regular package entry', () => {
  assert.deepEqual(
    auditTarGzBytes(tarGz([{ name: 'package/file.js', bytes: 'safe\n' }]), { label: 'fixture' }),
    { entryCount: 1, fileBytes: 5 },
  )
})

for (const vector of [
  {
    name: 'path traversal',
    archive: () => tarGz([{ name: 'package/../../escape', bytes: 'owned\n' }]),
    pattern: /escaped its required package\/ root/u,
  },
  {
    name: 'symbolic links',
    archive: () => tarGz([{ name: 'package/link', type: '2', linkName: '/tmp/target' }]),
    pattern: /unsupported tar entry type/u,
  },
  {
    name: 'duplicate entries',
    archive: () => tarGz([
      { name: 'package/file.js', bytes: 'first\n' },
      { name: 'package/file.js', bytes: 'second\n' },
    ]),
    pattern: /excessive or duplicate tar entries/u,
  },
  {
    name: 'GNU sparse entries',
    archive: () => tarGz([{ name: 'package/sparse.bin', type: 'S' }]),
    pattern: /unsupported tar entry type/u,
  },
]) {
  test(`tar preflight rejects ${vector.name} before extraction`, () => {
    assert.throws(() => auditTarGzBytes(vector.archive(), { label: 'malicious fixture' }), vector.pattern)
  })
}

test('registry tar audit rejects before the registry extractor is called', async () => {
  const paths = await bundledPnpmFixture()
  try {
    const maliciousBytes = tarGz([{ name: 'package/../../registry-escape', bytes: 'owned\n' }])
    const maliciousIntegrity = `sha512-${createHash('sha512').update(maliciousBytes).digest('base64')}`
    await writeFile(join(paths.projectRoot, 'pnpm-lock.yaml'), pnpmLock(maliciousIntegrity))
    const baseDependencies = registryFixtureDependencies(paths, maliciousBytes)
    baseDependencies.expectedRegistryIntegrity = maliciousIntegrity
    const recorded = recordTarExtractions(baseDependencies)
    await assert.rejects(
      inspectBundledPnpm({
        ...paths,
        temporaryRoot: join(paths.root, 'registry-reject-inspection'),
      }, recorded.dependencies),
      /escaped its required package\/ root/u,
    )
    assert.deepEqual(recorded.calls, [])
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('publication tar audit rejects before the publication extractor is called', async () => {
  const paths = await bundledPnpmFixture()
  try {
    const maliciousBytes = tarGz([{ name: 'package/../../publication-escape', bytes: 'owned\n' }])
    const recorded = recordTarExtractions(registryFixtureDependencies(paths))
    recorded.dependencies.testOnlyBeforeArchiveAudit = async ({ archive, kind }) => {
      if (kind === 'registry-publication') await writeFile(archive, maliciousBytes)
    }
    await assert.rejects(
      inspectBundledPnpm({
        ...paths,
        temporaryRoot: join(paths.root, 'publication-reject-inspection'),
      }, recorded.dependencies),
      /escaped its required package\/ root/u,
    )
    assert.equal(recorded.calls.some(call => call.kind === 'registry'), true)
    assert.equal(recorded.calls.some(call => call.kind === 'registry-publication'), false)
    await assertPrivateStagedArchive(recorded.calls.find(call => call.kind === 'registry'))
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('main tar audit rejects before the main subtree extractor is called', async () => {
  const paths = await bundledPnpmFixture()
  try {
    const maliciousArchive = join(paths.root, 'malicious-main.tgz')
    await writeFile(maliciousArchive, tarGz([{ name: 'package/../../main-escape', bytes: 'owned\n' }]))
    const recorded = recordTarExtractions(registryFixtureDependencies(paths))
    await assert.rejects(
      inspectBundledPnpm({
        ...paths,
        archive: maliciousArchive,
        temporaryRoot: join(paths.root, 'main-reject-inspection'),
      }, recorded.dependencies),
      /escaped its required package\/ root/u,
    )
    assert.deepEqual(
      recorded.calls.map(call => call.kind),
      ['registry', 'registry-publication', 'installed-publication'],
    )
    await assertPrivateStagedArchive(recorded.calls[2])
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('bundled pnpm proof rejects registry bytes that do not match the structured lock SRI', async () => {
  const paths = await bundledPnpmFixture()
  try {
    const tampered = Buffer.from(paths.registryBytes)
    tampered[tampered.length - 1] ^= 1
    await assert.rejects(
      inspectBundledPnpm(paths, registryFixtureDependencies(paths, tampered)),
      /registry tarball bytes do not match the lock-pinned SRI/u,
    )
    const expected = paths.registryIntegrity
    const wrong = `sha512-${Buffer.alloc(64, 7).toString('base64')}`
    await writeFile(join(paths.projectRoot, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      pnpm:',
      `        specifier: ${PNPM_VERSION}`,
      `        version: ${PNPM_VERSION}`,
      'packages:',
      `  pnpm@${PNPM_VERSION}:`,
      `    resolution: {integrity: ${wrong}}`,
      'snapshots:',
      `  pnpm@${PNPM_VERSION}: {}`,
      'decoy:',
      `  pnpm@${PNPM_VERSION}:`,
      `    resolution: {integrity: ${expected}}`,
      '',
    ].join('\n'))
    await assert.rejects(
      inspectBundledPnpm(paths, registryFixtureDependencies(paths)),
      /lockfile does not bind one exact pnpm registry SRI/u,
    )
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('bounded subprocess rejects output floods without retaining unbounded bytes', async () => {
  await assert.rejects(
    runChecked(process.execPath, ['-e', [
      'process.stdout.write("o".repeat(32 * 1024))',
      'process.stderr.write("e".repeat(32 * 1024))',
      'setInterval(() => {}, 1000)',
    ].join(';')], {
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maximumStdoutBytes: 4096,
      maximumStderrBytes: 4096,
      maximumTotalBytes: 6144,
    }),
    /exceeded its output byte bound.*stdoutBytes=[0-9]+, stderrBytes=[0-9]+/u,
  )
})

test('bounded subprocess kills a hung descendant process group and waits for close', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pack-runner-group-test-'))
  const marker = join(root, 'pids.json')
  let pids = []
  try {
    const descendant = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'
    const parent = [
      'const { spawn } = require("node:child_process")',
      'const { writeFileSync } = require("node:fs")',
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
      'writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]))',
      'process.on("SIGTERM", () => {})',
      'setInterval(() => {}, 1000)',
    ].join(';')
    await assert.rejects(
      runChecked(process.execPath, ['-e', parent, marker], {
        cwd: root,
        timeoutMs: 500,
        killCloseMs: 2_000,
      }),
      /timed out/u,
    )
    pids = JSON.parse(await readFile(marker, 'utf8'))
    for (let attempt = 0; attempt < 100 && pids.some(pid => processExists(pid)); attempt += 1) {
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
    assert(pids.every(pid => !processExists(pid)), 'timed-out process group still had a live member')
  } finally {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch { /* exact test process already exited */ }
    }
    await rm(root, { recursive: true, force: true })
  }
})

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}
