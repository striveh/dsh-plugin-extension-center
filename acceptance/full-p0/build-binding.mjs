import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

export const REPOSITORY_BUILD_RECORD_PATH = '.dsh-build/repository-build.json'

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function updateDigest(hash, path, kind, mode, content) {
  hash.update(`${Buffer.byteLength(path)}:${path}`)
  hash.update(`${kind}:${String(mode & 0o111)}:${content.byteLength}:`)
  hash.update(content)
}

function updateField(hash, value) {
  const content = typeof value === 'string' ? Buffer.from(value) : value
  hash.update(`${String(content.byteLength)}:`)
  hash.update(content)
}

function updateIdentityDigest(hash, path, kind, info, linkTarget) {
  updateField(hash, path)
  updateField(hash, kind)
  updateField(hash, info === undefined ? '0' : String(info.dev))
  updateField(hash, info === undefined ? '0' : String(info.ino))
  updateField(hash, info === undefined ? '0' : String(info.size))
  updateField(hash, info === undefined ? '0' : String(info.mtimeNs))
  updateField(hash, info === undefined ? '0' : String(info.ctimeNs))
  updateField(hash, info === undefined ? '0' : String(info.mode))
  updateField(hash, linkTarget)
}

function errnoIs(error, code) {
  return error instanceof Error && 'code' in error && error.code === code
}

function gitSourcePaths(root) {
  return new Promise((resolvePaths, rejectPaths) => {
    const child = spawn('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let bytes = 0
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 32 * 1024 * 1024) {
        child.kill('SIGKILL')
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', chunk => { stderr.push(chunk) })
    child.once('error', rejectPaths)
    child.once('close', exitCode => {
      if (bytes > 32 * 1024 * 1024) {
        rejectPaths(new Error('git source file list exceeded 32 MiB'))
        return
      }
      if (exitCode !== 0) {
        rejectPaths(new Error(`git ls-files exited ${String(exitCode)}: ${Buffer.concat(stderr).toString()}`))
        return
      }
      resolvePaths(Buffer.concat(stdout).toString('utf8').split('\0').filter(Boolean).sort(compareCodeUnits))
    })
  })
}

function repositoryPath(root, absolute) {
  const path = relative(root, absolute)
  return sep === '\\' ? path.replaceAll('\\', '/') : path
}

function isWithin(root, target) {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

async function assertListedSourceTree(root, target, sourcePathSet, visitedDirectories) {
  const canonical = await realpath(target)
  if (!isWithin(root, canonical)) {
    throw new Error(`Host source symlink resolves outside the repository: ${repositoryPath(root, target)}`)
  }
  const targetInfo = await stat(canonical)
  if (targetInfo.isFile()) {
    const path = repositoryPath(root, canonical)
    if (!sourcePathSet.has(path)) throw new Error(`Host source symlink resolves to unlisted source entry: ${path}`)
    return
  }
  if (!targetInfo.isDirectory()) {
    throw new Error(`Host source symlink resolves to an unsupported entry: ${repositoryPath(root, canonical)}`)
  }
  if (visitedDirectories.has(canonical)) return
  visitedDirectories.add(canonical)
  for (const entry of await readdir(canonical, { withFileTypes: true })) {
    const absolute = join(canonical, entry.name)
    const info = await lstat(absolute)
    if (info.isDirectory()) {
      await assertListedSourceTree(root, absolute, sourcePathSet, visitedDirectories)
      continue
    }
    const path = repositoryPath(root, absolute)
    if (!sourcePathSet.has(path)) throw new Error(`Host source symlink reaches unlisted source entry: ${path}`)
    if (info.isSymbolicLink()) {
      await assertListedSourceTree(root, absolute, sourcePathSet, visitedDirectories)
      continue
    }
    if (!info.isFile()) throw new Error(`Host source symlink reaches an unsupported entry: ${path}`)
  }
}

/** Compute the verifier's exact tracked and non-ignored source digest. */
export async function repositorySourceDigest(root) {
  const paths = await gitSourcePaths(root)
  const canonicalRoot = await realpath(root)
  const sourcePathSet = new Set(paths)
  const visitedDirectories = new Set()
  const hash = createHash('sha256')
  const identityHash = createHash('sha256')
  for (const path of paths) {
    const absolute = join(root, path)
    let info
    try {
      info = await lstat(absolute, { bigint: true })
    } catch (error) {
      if (!errnoIs(error, 'ENOENT')) throw error
      updateDigest(hash, path, 'missing', 0, Buffer.alloc(0))
      updateIdentityDigest(identityHash, path, 'missing', undefined, Buffer.alloc(0))
      continue
    }
    if (info.isSymbolicLink()) {
      const linkTarget = await readlink(absolute, { encoding: 'buffer' })
      await assertListedSourceTree(canonicalRoot, absolute, sourcePathSet, visitedDirectories)
      updateDigest(hash, path, 'symlink', Number(info.mode), linkTarget)
      updateIdentityDigest(identityHash, path, 'symlink', info, linkTarget)
      continue
    }
    if (!info.isFile()) throw new Error(`Host source entry is neither a file nor a symbolic link: ${path}`)
    updateDigest(hash, path, 'file', Number(info.mode), await readFile(absolute))
    updateIdentityDigest(identityHash, path, 'file', info, Buffer.alloc(0))
  }
  return {
    fileCount: paths.length,
    sha256: hash.digest('hex'),
    identitySha256: identityHash.digest('hex'),
  }
}

async function directoryNames(root, parts) {
  const absolute = join(root, ...parts)
  let rootInfo
  try {
    rootInfo = await lstat(absolute)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return []
    throw error
  }
  const rootPath = parts.join('/')
  if (rootInfo.isSymbolicLink()) throw new Error(`Host repository runtime artifact ancestor ${rootPath} is a symbolic link`)
  if (!rootInfo.isDirectory()) throw new Error(`Host repository runtime artifact ancestor ${rootPath} is not a directory`)
  const entries = await readdir(absolute, { withFileTypes: true })
  const names = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name)
      continue
    }
    if (!entry.isSymbolicLink()) continue
    const path = join(absolute, entry.name)
    if ((await stat(path)).isDirectory()) {
      throw new Error(`Host repository runtime artifact ancestor ${[...parts, entry.name].join('/')} is a symbolic link`)
    }
  }
  return names.sort(compareCodeUnits)
}

async function collectRuntimeTree(root, parts, artifacts) {
  const absolute = join(root, ...parts)
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const childParts = [...parts, entry.name]
    const childAbsolute = join(root, ...childParts)
    const path = childParts.join('/')
    const info = await lstat(childAbsolute)
    if (info.isDirectory()) {
      await collectRuntimeTree(root, childParts, artifacts)
      continue
    }
    if (!info.isFile()) throw new Error(`Host repository runtime artifact is not a regular file: ${path}`)
    if (!path.endsWith('.tsbuildinfo')) artifacts.push({ absolute: childAbsolute, path })
  }
}

async function collectLibRoot(root, parts, artifacts) {
  const absolute = join(root, ...parts)
  let info
  try {
    info = await lstat(absolute)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return
    throw error
  }
  const path = parts.join('/')
  if (info.isSymbolicLink()) throw new Error(`Host repository runtime artifact ancestor ${path} is a symbolic link`)
  if (!info.isDirectory()) throw new Error(`Host repository runtime artifact ancestor ${path} is not a directory`)
  await collectRuntimeTree(root, parts, artifacts)
}

async function runtimeArtifacts(root) {
  const artifacts = []
  for (const app of await directoryNames(root, ['apps'])) await collectLibRoot(root, ['apps', app, 'lib'], artifacts)
  for (const group of await directoryNames(root, ['packages'])) {
    for (const pkg of await directoryNames(root, ['packages', group])) {
      await collectLibRoot(root, ['packages', group, pkg, 'lib'], artifacts)
    }
  }
  for (const pkg of await directoryNames(root, ['vendor'])) await collectLibRoot(root, ['vendor', pkg, 'lib'], artifacts)
  return artifacts.sort((left, right) => compareCodeUnits(left.path, right.path))
}

/** Compute the verifier's exact Host-side app, package, and vendored `lib` artifact digest. */
export async function repositoryRuntimeArtifactDigest(root) {
  const artifacts = await runtimeArtifacts(root)
  if (artifacts.length === 0) throw new Error('Host repository build has no current Host-side lib artifacts to verify')
  const hash = createHash('sha256')
  for (const artifact of artifacts) {
    const info = await lstat(artifact.absolute)
    if (!info.isFile()) throw new Error(`Host repository runtime artifact changed kind while being read: ${artifact.path}`)
    updateDigest(hash, artifact.path, 'file', info.mode, await readFile(artifact.absolute))
  }
  return { fileCount: artifacts.length, sha256: hash.digest('hex') }
}

function parseDigest(value, label) {
  if (typeof value !== 'object' || value === null
    || !Number.isSafeInteger(value.fileCount) || value.fileCount <= 0
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error(`${label} is not a positive file count and lowercase SHA-256 digest`)
  }
  return { fileCount: value.fileCount, sha256: value.sha256 }
}

function parseSourceDigest(value, label) {
  const digest = parseDigest(value, label)
  if (typeof value.identitySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.identitySha256)) {
    throw new Error(`${label}.identitySha256 is not a lowercase SHA-256 digest`)
  }
  return { ...digest, identitySha256: value.identitySha256 }
}

function sameDigest(left, right) {
  return left.fileCount === right.fileCount && left.sha256 === right.sha256
}

function sameSourceDigest(left, right) {
  return sameDigest(left, right) && left.identitySha256 === right.identitySha256
}

/**
 * Verify that one complete DSH build record still matches its source and runtime files.
 * @param {string} root local DSH repository root.
 * @returns {Promise<object>} validated record safe to include in an acceptance receipt.
 */
export async function verifyRepositoryBuildBinding(root) {
  let recordBytes
  let value
  try {
    recordBytes = await readFile(join(root, REPOSITORY_BUILD_RECORD_PATH))
    value = JSON.parse(recordBytes.toString('utf8'))
  } catch (error) {
    throw new Error(
      `Host build record ${REPOSITORY_BUILD_RECORD_PATH} is missing or invalid; run a complete pnpm run build: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof value !== 'object' || value === null || value.formatVersion !== 2) {
    throw new Error('Host repository build record formatVersion is not supported')
  }
  const source = parseSourceDigest(value.source, 'Host repository build source')
  const runtimeArtifacts = parseDigest(value.runtimeArtifacts, 'Host repository build runtimeArtifacts')
  if (!sameSourceDigest(await repositorySourceDigest(root), source)) {
    throw new Error('Host source differs from its complete repository build record; run pnpm run build again')
  }
  if (!sameDigest(await repositoryRuntimeArtifactDigest(root), runtimeArtifacts)) {
    throw new Error('Host runtime artifacts differ from their complete repository build record; run pnpm run build again')
  }
  const finalRecordBytes = await readFile(join(root, REPOSITORY_BUILD_RECORD_PATH))
  if (!recordBytes.equals(finalRecordBytes)) {
    throw new Error('Host repository build record changed while it was being verified')
  }
  return {
    formatVersion: 2,
    source,
    runtimeArtifacts,
    recordSha256: `sha256:${createHash('sha256').update(recordBytes).digest('hex')}`,
  }
}
