import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertManifestIdentity,
  githubProvenanceFromEnvironment,
  verifyDeterministicPack,
} from './verify-deterministic-pack.mjs'

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
    engines: { dsh: '0.1.1-rc.2' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dependencies: { pnpm: '11.7.0' },
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
