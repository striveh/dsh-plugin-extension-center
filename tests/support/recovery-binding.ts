import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { RecoveryExecutableBinding } from '../../src/plans/index.ts'

function regularFile(path: string, label: string): string {
  const resolved = realpathSync(path)
  if (!lstatSync(resolved).isFile()) throw new Error(`${label} must be a regular file`)
  return resolved
}

function digest(path: string): RecoveryExecutableBinding['executableSha256'] {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

function supportedPlatform(): RecoveryExecutableBinding['platform'] {
  if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
    return process.platform
  }
  throw new Error(`unsupported recovery fixture platform: ${process.platform}`)
}

const executablePath = regularFile(
  resolve(process.cwd(), 'src/recovery/break-glass.ts'),
  'fixture recovery executable',
)
const centerRoot = realpathSync(process.cwd())
const nodePath = realpathSync(process.execPath)
const supervisorPath = regularFile(resolve(centerRoot, 'lib/recovery/supervisor.js'), 'fixture supervisor')
const pnpmManifestPath = realpathSync(createRequire(import.meta.url).resolve('pnpm'))
const pnpmRoot = dirname(pnpmManifestPath)
const pnpmEntrypoint = regularFile(join(pnpmRoot, 'bin', 'pnpm.mjs'), 'fixture pnpm entrypoint')
const shellPath = realpathSync('/bin/sh')

/** Real, hash-pinned executable identities used by plan and journal tests. */
export const TEST_RECOVERY_EXECUTABLE_BINDING: RecoveryExecutableBinding = Object.freeze({
  schemaVersion: 5,
  executablePath,
  executableSha256: digest(executablePath),
  centerRoot,
  packageVersion: '0.0.0-test',
  platform: supportedPlatform(),
  arch: process.arch,
  officialDsh: Object.freeze({
    schemaVersion: 2,
    packageName: '@deepseek-ai/dsh',
    packageVersion: '0.1.2-alpha.1',
    packageRoot: centerRoot,
    packageTreeSha256: digest(executablePath),
    productionDependencies: Object.freeze([]),
    entrypointPath: executablePath,
    entrypointSha256: digest(executablePath),
    hostHome: centerRoot,
    timeoutMs: 120_000,
    node: Object.freeze({
      schemaVersion: 1,
      executablePath: nodePath,
      executableSha256: digest(nodePath),
      version: process.version,
    }),
    supervisorPath,
    supervisorSha256: digest(supervisorPath),
    pnpm: Object.freeze({
      schemaVersion: 1,
      packageName: 'pnpm',
      packageVersion: '11.21.0',
      registryIntegrity: 'sha512-UhcFvOaJkk6scvWjWHEi82JonvZXHlW6gAdv1jfBETLs/62ib61Op5xIW/3b/T1aKlsFgFp36JPeceyKbMo7sQ==',
      packageRoot: pnpmRoot,
      packageTreeSha256: digest(pnpmManifestPath),
      entrypointPath: pnpmEntrypoint,
      entrypointSha256: digest(pnpmEntrypoint),
      shimPath: executablePath,
      shimSha256: digest(executablePath),
      shellPath,
      shellSha256: digest(shellPath),
      runtimeRoot: centerRoot,
    }),
  }),
})
