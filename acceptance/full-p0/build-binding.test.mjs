import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  REPOSITORY_BUILD_RECORD_PATH,
  repositoryRuntimeArtifactDigest,
  repositorySourceDigest,
  verifyRepositoryBuildBinding,
} from './build-binding.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-extension-build-binding-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  await write(join(root, '.gitignore'), 'lib/\n.dsh-build/\n')
  await write(join(root, 'src/input.ts'), 'export const value = 1\n')
  execFileSync('git', ['add', '.gitignore', 'src/input.ts'], { cwd: root })
  await write(join(root, 'packages/example/runtime/lib/index.js'), 'export const value = 1\n')
  const record = {
    formatVersion: 2,
    source: await repositorySourceDigest(root),
    runtimeArtifacts: await repositoryRuntimeArtifactDigest(root),
  }
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
  await write(join(root, REPOSITORY_BUILD_RECORD_PATH), recordBytes)
  return {
    root,
    record,
    verifiedRecord: {
      ...record,
      recordSha256: `sha256:${createHash('sha256').update(recordBytes).digest('hex')}`,
    },
  }
}

test('accepts only the exact source and runtime sets recorded by a complete build', async () => {
  const { root, verifiedRecord } = await fixture()
  assert.deepEqual(await verifyRepositoryBuildBinding(root), verifiedRecord)

  await write(join(root, 'src/input.ts'), 'export const value = 2\n')
  await assert.rejects(verifyRepositoryBuildBinding(root), /Host source differs/)

  await write(join(root, 'src/input.ts'), 'export const value = 1\n')
  await write(join(root, REPOSITORY_BUILD_RECORD_PATH), `${JSON.stringify({
    formatVersion: 2,
    source: await repositorySourceDigest(root),
    runtimeArtifacts: await repositoryRuntimeArtifactDigest(root),
  }, null, 2)}\n`)
  await write(join(root, 'packages/example/runtime/lib/index.js'), 'export const value = 2\n')
  await assert.rejects(verifyRepositoryBuildBinding(root), /Host runtime artifacts differ/)
})

test('rejects a same-content replacement between source endpoint observations', async () => {
  const { root, record } = await fixture()
  const source = join(root, 'src/input.ts')
  const replacement = join(root, 'src/replacement.ts')
  await write(replacement, 'export const value = 1\n')
  await rename(replacement, source)

  const replaced = await repositorySourceDigest(root)
  assert.equal(replaced.sha256, record.source.sha256)
  assert.notEqual(replaced.identitySha256, record.source.identitySha256)
  await assert.rejects(verifyRepositoryBuildBinding(root), /Host source differs/)
})

test('includes non-ignored untracked source in the binding', async () => {
  const { root } = await fixture()
  await write(join(root, 'src/new-input.ts'), 'export const later = true\n')
  await assert.rejects(verifyRepositoryBuildBinding(root), /Host source differs/)
})

test('verifies a tracked deletion as part of the checkout source state', async () => {
  const { root } = await fixture()
  await rm(join(root, 'src/input.ts'))
  const record = {
    formatVersion: 2,
    source: await repositorySourceDigest(root),
    runtimeArtifacts: await repositoryRuntimeArtifactDigest(root),
  }
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
  await write(join(root, REPOSITORY_BUILD_RECORD_PATH), recordBytes)

  assert.deepEqual(await verifyRepositoryBuildBinding(root), {
    ...record,
    recordSha256: `sha256:${createHash('sha256').update(recordBytes).digest('hex')}`,
  })
})

test('includes hidden Host-side lib artifacts in the runtime binding', async () => {
  const { root } = await fixture()
  await write(join(root, 'packages/example/runtime/lib/.hidden.js'), 'export const hidden = true\n')
  const runtimeArtifacts = await repositoryRuntimeArtifactDigest(root)
  const record = {
    formatVersion: 2,
    source: await repositorySourceDigest(root),
    runtimeArtifacts,
  }
  await write(join(root, REPOSITORY_BUILD_RECORD_PATH), `${JSON.stringify(record, null, 2)}\n`)

  await write(join(root, 'packages/example/runtime/lib/.hidden.js'), 'export const hidden = false\n')
  await assert.rejects(verifyRepositoryBuildBinding(root), /Host runtime artifacts differ/)
})

test('preserves literal backslashes in POSIX runtime artifact names', { skip: sep === '\\' }, async () => {
  const { root } = await fixture()
  const literalBackslash = join(root, 'packages/example/runtime/lib/name\\part.js')
  const nested = join(root, 'packages/example/runtime/lib/name/part.js')
  await write(literalBackslash, 'export const literal = true\n')
  await write(nested, 'export const nested = true\n')
  const digest = await repositoryRuntimeArtifactDigest(root)
  const record = {
    formatVersion: 2,
    source: await repositorySourceDigest(root),
    runtimeArtifacts: digest,
  }
  await write(join(root, REPOSITORY_BUILD_RECORD_PATH), `${JSON.stringify(record, null, 2)}\n`)

  await write(literalBackslash, 'export const literal = false\n')
  await assert.rejects(verifyRepositoryBuildBinding(root), /Host runtime artifacts differ/)
})

test('rejects source and runtime symlinks whose authority is outside the Host checkout', { skip: process.platform === 'win32' }, async () => {
  const { root } = await fixture()
  const externalRoot = await mkdtemp(join(tmpdir(), 'dsh-extension-build-binding-external-'))
  roots.push(externalRoot)
  const externalSource = join(externalRoot, 'source.ts')
  await write(externalSource, 'export const external = true\n')
  await symlink(externalSource, join(root, 'src/external.ts'))
  execFileSync('git', ['add', 'src/external.ts'], { cwd: root })
  await assert.rejects(repositorySourceDigest(root), /resolves outside the repository/)

  await rm(join(root, 'src/external.ts'))
  await symlink(externalSource, join(root, 'packages/example/runtime/lib/external.js'))
  await assert.rejects(repositoryRuntimeArtifactDigest(root), /not a regular file/)
})

test('fails closed when the complete build record is absent or invalid', async () => {
  const { root } = await fixture()
  await rm(join(root, REPOSITORY_BUILD_RECORD_PATH))
  await assert.rejects(verifyRepositoryBuildBinding(root), /is missing or invalid/)

  await write(join(root, REPOSITORY_BUILD_RECORD_PATH), '{"formatVersion":1}\n')
  await assert.rejects(verifyRepositoryBuildBinding(root), /formatVersion/)
})
