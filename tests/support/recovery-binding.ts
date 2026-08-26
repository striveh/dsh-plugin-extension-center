import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
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
const hostCliPath = regularFile(process.execPath, 'fixture Host CLI')

/** Real, hash-pinned executable identities used by plan and journal tests. */
export const TEST_RECOVERY_EXECUTABLE_BINDING: RecoveryExecutableBinding = Object.freeze({
  schemaVersion: 1,
  executablePath,
  executableSha256: digest(executablePath),
  hostCliPath,
  hostCliSha256: digest(hostCliPath),
  packageVersion: '0.0.0-test',
  platform: supportedPlatform(),
  arch: process.arch,
})
