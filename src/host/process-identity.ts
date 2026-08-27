import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** Platforms with a concrete process-birth probe used by durable lock recovery. */
export type ProcessIdentityPlatform = 'darwin' | 'linux' | 'win32'

/** PID plus content-addressed process-birth evidence captured by the lock owner. */
export interface ProcessIdentity {
  readonly schemaVersion: 1
  readonly pid: number
  readonly platform: ProcessIdentityPlatform
  readonly machineDigest: `sha256:${string}` | null
  readonly bootDigest: `sha256:${string}` | null
  readonly birthDigest: `sha256:${string}` | null
}

/** Conservative result of comparing a durable owner with the process currently using its PID. */
export type ProcessIdentityStatus = 'alive' | 'dead' | 'unknown'

type BirthProbe = Readonly<
  | { status: 'present'; marker: string }
  | { status: 'absent' }
  | { status: 'unknown' }
>

interface CommandResult {
  readonly code: number | null
  readonly stdout: string
}

interface HostEvidence {
  readonly machineMarker: string
  readonly bootMarker: string
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const MAX_PROBE_OUTPUT_BYTES = 4 * 1024
const PROBE_TIMEOUT_MS = 2_000
let hostEvidence: Promise<HostEvidence | null> | null = null

function supportedPlatform(value: NodeJS.Platform): ProcessIdentityPlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`durable process identity is unsupported on ${value}`)
}

function evidenceDigest(
  kind: 'machine' | 'boot' | 'birth',
  platform: ProcessIdentityPlatform,
  marker: string,
): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(kind).update('\0').update(platform).update('\0').update(marker).digest('hex')}`
}

async function command(executable: string, arguments_: readonly string[], env: NodeJS.ProcessEnv): Promise<CommandResult | null> {
  return await new Promise(resolve => {
    const child = spawn(executable, arguments_, {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, PROBE_TIMEOUT_MS)
    timer.unref()
    const finish = (value: CommandResult | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) >= MAX_PROBE_OUTPUT_BYTES) return
      stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_PROBE_OUTPUT_BYTES)
    })
    child.once('error', () => { finish(null) })
    child.once('close', code => { finish(Object.freeze({ code, stdout })) })
  })
}

function linuxStartTicks(stat: string): string | null {
  const commandEnd = stat.lastIndexOf(')')
  if (commandEnd < 0 || stat[commandEnd + 1] !== ' ') return null
  const fieldsFromState = stat.slice(commandEnd + 2).trim().split(/\s+/u)
  const startTicks = fieldsFromState[19]
  return startTicks !== undefined && /^\d+$/u.test(startTicks) ? startTicks : null
}

async function probeLinux(pid: number): Promise<BirthProbe> {
  let stat: string
  try {
    stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ status: 'absent' })
    return Object.freeze({ status: 'unknown' })
  }
  const startTicks = linuxStartTicks(stat)
  if (startTicks === null) return Object.freeze({ status: 'unknown' })
  try {
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase()
    if (!/^[0-9a-f-]{36}$/u.test(bootId)) return Object.freeze({ status: 'unknown' })
    return Object.freeze({ status: 'present', marker: `${bootId}:${startTicks}` })
  } catch {
    return Object.freeze({ status: 'present', marker: '' })
  }
}

async function probeDarwin(pid: number): Promise<BirthProbe> {
  const result = await command('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
    TZ: 'UTC0',
  })
  if (result === null) return Object.freeze({ status: 'unknown' })
  const marker = result.stdout.trim().replace(/\s+/gu, ' ')
  if (result.code === 0 && marker.length > 0) return Object.freeze({ status: 'present', marker })
  if (result.code === 1 && marker.length === 0) return Object.freeze({ status: 'absent' })
  return Object.freeze({ status: 'unknown' })
}

async function probeWindows(pid: number): Promise<BirthProbe> {
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined || systemRoot.length === 0) return Object.freeze({ status: 'unknown' })
  const script = [
    `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { [Console]::Out.Write('absent'); exit 3 }",
    "try { [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)); exit 0 } catch { exit 4 }",
  ].join('; ')
  const executable = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  const result = await command(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    SystemRoot: systemRoot,
  })
  if (result === null) return Object.freeze({ status: 'unknown' })
  const marker = result.stdout.trim()
  if (result.code === 0 && /^\d+$/u.test(marker)) return Object.freeze({ status: 'present', marker })
  if (result.code === 3 && marker === 'absent') return Object.freeze({ status: 'absent' })
  return Object.freeze({ status: 'unknown' })
}

async function probeHostEvidence(platform: ProcessIdentityPlatform): Promise<HostEvidence | null> {
  if (platform === 'linux') {
    try {
      const machineMarker = (await readFile('/etc/machine-id', 'utf8')).trim().toLowerCase()
      const bootMarker = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase()
      if (!/^[0-9a-f]{32}$/u.test(machineMarker) || !/^[0-9a-f-]{36}$/u.test(bootMarker)) return null
      return Object.freeze({ machineMarker, bootMarker })
    } catch {
      return null
    }
  }
  if (platform === 'darwin') {
    const environment = { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin', TZ: 'UTC0' }
    const [machine, boot] = await Promise.all([
      command('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], environment),
      command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], environment),
    ])
    const machineMarker = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/u.exec(machine?.stdout ?? '')?.[1]
    const bootMarker = boot?.stdout.trim()
    if (machine?.code !== 0 || boot?.code !== 0 || machineMarker === undefined
      || bootMarker === undefined || !/^[0-9A-Fa-f-]{36}$/u.test(bootMarker)) return null
    return Object.freeze({ machineMarker: machineMarker.toLowerCase(), bootMarker: bootMarker.toLowerCase() })
  }
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined || systemRoot.length === 0) return null
  const script = [
    "$m = (Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid",
    '$b = (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks',
    "[Console]::Out.Write($m.ToString() + '|' + $b.ToString([Globalization.CultureInfo]::InvariantCulture))",
  ].join('; ')
  const result = await command(
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { SystemRoot: systemRoot },
  )
  if (result?.code !== 0) return null
  const match = /^([^|\r\n]{1,256})\|(\d+)$/u.exec(result.stdout.trim())
  return match === null ? null : Object.freeze({ machineMarker: match[1]!.toLowerCase(), bootMarker: match[2]! })
}

function currentHostEvidence(platform: ProcessIdentityPlatform): Promise<HostEvidence | null> {
  hostEvidence ??= probeHostEvidence(platform)
  return hostEvidence
}

async function probe(pid: number, platform: ProcessIdentityPlatform): Promise<BirthProbe> {
  if (platform === 'linux') return await probeLinux(pid)
  if (platform === 'darwin') return await probeDarwin(pid)
  return await probeWindows(pid)
}

/** Decode process evidence at a durable-file boundary. */
export function decodeProcessIdentity(value: unknown, label: string): ProcessIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',')
      !== 'birthDigest,bootDigest,machineDigest,pid,platform,schemaVersion') {
    throw new Error(`${label} process identity is invalid`)
  }
  const candidate = value as Partial<ProcessIdentity>
  if (candidate.schemaVersion !== 1 || !Number.isSafeInteger(candidate.pid) || (candidate.pid as number) < 1
    || !['darwin', 'linux', 'win32'].includes(candidate.platform as string)
    || candidate.machineDigest !== null
      && (typeof candidate.machineDigest !== 'string' || !SHA256.test(candidate.machineDigest))
    || candidate.bootDigest !== null
      && (typeof candidate.bootDigest !== 'string' || !SHA256.test(candidate.bootDigest))
    || candidate.birthDigest !== null && (typeof candidate.birthDigest !== 'string' || !SHA256.test(candidate.birthDigest))) {
    throw new Error(`${label} process identity fields are invalid`)
  }
  return Object.freeze({
    schemaVersion: 1,
    pid: candidate.pid as number,
    platform: candidate.platform as ProcessIdentityPlatform,
    machineDigest: candidate.machineDigest as `sha256:${string}` | null,
    bootDigest: candidate.bootDigest as `sha256:${string}` | null,
    birthDigest: candidate.birthDigest as `sha256:${string}` | null,
  })
}

/** Capture this process without failing lock acquisition when the platform probe is temporarily unavailable. */
export async function captureCurrentProcessIdentity(): Promise<ProcessIdentity> {
  const platform = supportedPlatform(process.platform)
  const [host, observed] = await Promise.all([currentHostEvidence(platform), probe(process.pid, platform)])
  return Object.freeze({
    schemaVersion: 1,
    pid: process.pid,
    platform,
    machineDigest: host === null ? null : evidenceDigest('machine', platform, host.machineMarker),
    bootDigest: host === null ? null : evidenceDigest('boot', platform, host.bootMarker),
    birthDigest: observed.status === 'present' && observed.marker.length > 0
      ? evidenceDigest('birth', platform, observed.marker)
      : null,
  })
}

/** Prove that the original owner remains alive or is irreversibly gone; uncertainty never authorizes recovery. */
export async function inspectProcessIdentity(value: ProcessIdentity): Promise<ProcessIdentityStatus> {
  const identity = decodeProcessIdentity(value, 'durable owner')
  if (identity.platform !== process.platform || identity.machineDigest === null
    || identity.bootDigest === null || identity.birthDigest === null) return 'unknown'
  const host = await currentHostEvidence(identity.platform)
  if (host === null) return 'unknown'
  if (evidenceDigest('machine', identity.platform, host.machineMarker) !== identity.machineDigest) return 'unknown'
  if (evidenceDigest('boot', identity.platform, host.bootMarker) !== identity.bootDigest) return 'dead'
  const observed = await probe(identity.pid, identity.platform)
  if (observed.status === 'absent') return 'dead'
  if (observed.status === 'unknown' || observed.marker.length === 0) return 'unknown'
  return evidenceDigest('birth', identity.platform, observed.marker) === identity.birthDigest ? 'alive' : 'dead'
}
