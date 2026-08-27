import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalJson, canonicalSha256 } from './receipt-binding.mjs'
import { AcceptanceFailure, immutablePackageTreeDigest } from './support.mjs'

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const RECOVERY_STDOUT = 'Official Profile and Center state restored; restart verification pending\n'
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024
const MAX_JSON_BYTES = 32 * 1024 * 1024
const MAX_TAR_ENTRY_BYTES = 256 * 1024 * 1024

function fail(code, message) {
  throw new AcceptanceFailure(code, message)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('P0-BREAK-GLASS-INPUT', `${label} must be an object`)
  }
  return value
}

function exactKeys(value, fields, label) {
  const actual = Object.keys(record(value, label)).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('P0-BREAK-GLASS-EVIDENCE', `${label} fields are invalid`)
  }
  return value
}

function string(value, label, maximum = 4_096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    fail('P0-BREAK-GLASS-INPUT', `${label} must be a bounded non-empty string`)
  }
  return value
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('P0-BREAK-GLASS-EVIDENCE', `${label} must be a lowercase SHA-256 digest`)
  }
  return value
}

function below(root, candidate) {
  const offset = relative(resolve(root), resolve(candidate))
  return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
}

function storageKey(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileSha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function managedStateDigest(value) {
  if (value === null) return canonicalSha256(null)
  const managed = record(value, 'managed state')
  return canonicalSha256({
    kind: managed.kind,
    extensionId: managed.extensionId,
    targetKey: managed.targetKey,
    scopeKey: managed.scopeKey,
    profileId: managed.profileId,
    current: managed.current,
    lastGood: managed.lastGood,
    removed: managed.removed,
    pending: managed.pending,
  })
}

function assertStopped(processState) {
  const value = record(processState, 'stopped Host process')
  if (value.exitCode === null && value.signalCode === null) {
    fail('P0-BREAK-GLASS-HOST-LIVE', 'official DSH Host and its mounted Center must be stopped before break-glass recovery')
  }
  if (value.exitCode !== null && !Number.isInteger(value.exitCode)) {
    fail('P0-BREAK-GLASS-INPUT', 'stopped Host exitCode is invalid')
  }
  if (value.signalCode !== null && typeof value.signalCode !== 'string') {
    fail('P0-BREAK-GLASS-INPUT', 'stopped Host signalCode is invalid')
  }
}

function verifyJournal(loaded) {
  const journal = record(loaded.journal, 'loaded operation journal')
  const projection = record(loaded.projection, 'loaded operation projection')
  const operationId = string(projection.operationId, 'projection.operationId', 512)
  const targetKey = string(projection.targetKey, 'projection.targetKey', 1_024)
  if (journal.schemaVersion !== 1 || journal.operationId !== operationId || journal.targetKey !== targetKey || !Array.isArray(journal.events)
    || journal.events.length < 5) {
    fail('P0-BREAK-GLASS-JOURNAL', 'loaded operation journal identity or event list is invalid')
  }
  let previousDigest = null
  let phase = null
  let opening = null
  let previousAtMs = 0
  const next = {
    authorized: ['staging', 'failed'],
    staging: ['applying', 'rolling-back', 'failed'],
    applying: ['verifying', 'rolling-back', 'failed'],
    verifying: ['committed', 'rolling-back', 'failed'],
    'rolling-back': ['rolled-back', 'recovery-required'],
    committed: [],
    'rolled-back': [],
    failed: [],
    'recovery-required': ['rolling-back'],
  }
  for (const [index, raw] of journal.events.entries()) {
    const event = record(raw, `journal.events[${String(index)}]`)
    const sequence = index + 1
    if (event.schemaVersion !== 1 || event.operationId !== operationId || event.targetKey !== targetKey
      || event.sequence !== sequence || event.previousDigest !== previousDigest
      || !Number.isSafeInteger(event.atMs) || event.atMs < previousAtMs) {
      fail('P0-BREAK-GLASS-JOURNAL', `journal event ${String(sequence)} identity or chain is invalid`)
    }
    const eventDigest = digest(event.digest, `journal.events[${String(index)}].digest`)
    const unsigned = {
      schemaVersion: event.schemaVersion,
      operationId: event.operationId,
      targetKey: event.targetKey,
      sequence: event.sequence,
      previousDigest: event.previousDigest,
      atMs: event.atMs,
      entry: event.entry,
    }
    if (canonicalSha256(unsigned) !== eventDigest) {
      fail('P0-BREAK-GLASS-JOURNAL', `journal event ${String(sequence)} digest does not match its content`)
    }
    const entry = record(event.entry, `journal.events[${String(index)}].entry`)
    if (index === 0) {
      if (entry.type !== 'operation-opened') fail('P0-BREAK-GLASS-JOURNAL', 'journal does not begin with operation-opened')
      opening = entry
      phase = 'authorized'
    } else if (entry.type === 'phase-transition') {
      if (entry.from !== phase || !next[phase]?.includes(entry.to)) {
        fail('P0-BREAK-GLASS-JOURNAL', `journal contains an invalid ${String(entry.from)} to ${String(entry.to)} transition`)
      }
      if (entry.to === 'recovery-required' && (typeof entry.reason !== 'string'
        || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(entry.reason))) {
        fail('P0-BREAK-GLASS-JOURNAL', 'recovery-required transition has no stable failure reason')
      }
      phase = entry.to
    } else if (entry.type === 'mutation-observed') {
      if (!['applying', 'verifying', 'rolling-back'].includes(phase)) {
        fail('P0-BREAK-GLASS-JOURNAL', `mutation evidence is invalid during ${String(phase)}`)
      }
      digest(entry.mutationDigest, `journal.events[${String(index)}].entry.mutationDigest`)
    } else if (entry.type === 'verification-observed') {
      if (!['verifying', 'rolling-back'].includes(phase)) {
        fail('P0-BREAK-GLASS-JOURNAL', `verification evidence is invalid during ${String(phase)}`)
      }
      digest(entry.verificationDigest, `journal.events[${String(index)}].entry.verificationDigest`)
    } else {
      fail('P0-BREAK-GLASS-JOURNAL', `recovery-required journal contains unsupported event ${String(entry.type)}`)
    }
    previousDigest = eventDigest
    previousAtMs = event.atMs
  }
  if (phase !== 'recovery-required' || projection.phase !== phase || projection.receipt !== null
    || projection.beforeDigest !== opening.beforeDigest || projection.operationKind !== opening.operationKind) {
    fail('P0-BREAK-GLASS-JOURNAL', 'operation is not an unreceipted recovery-required journal')
  }
  const planEvidence = record(opening.planEvidence, 'journal opening planEvidence')
  if (planEvidence.extensionKind !== 'plugin' || planEvidence.ownerKey !== 'managedPlugins'
    || opening.managedObject !== 'artifact' || opening.runtimeBinding !== null) {
    fail('P0-BREAK-GLASS-JOURNAL', 'journal is not a Center-owned managed Plugin artifact operation')
  }
  const packageName = string(planEvidence.extensionId, 'planEvidence.extensionId')
  if (!PACKAGE_NAME.test(packageName) || packageName === 'dsh-plugin-extension-center') {
    fail('P0-BREAK-GLASS-JOURNAL', 'journal does not target an admissible managed child Plugin')
  }
  const profileId = string(planEvidence.profileId, 'planEvidence.profileId')
  const scopeKey = string(planEvidence.scopeKey, 'planEvidence.scopeKey')
  if (targetKey !== `plugin:${profileId}:${scopeKey}:${packageName}`) {
    fail('P0-BREAK-GLASS-JOURNAL', 'journal target does not bind its Plugin, Profile, and scope')
  }
  return Object.freeze({
    operationId,
    targetKey,
    packageName,
    profileId,
    beforeDigest: digest(opening.beforeDigest, 'journal opening beforeDigest'),
    headDigest: previousDigest,
    planEvidence,
  })
}

/**
 * Validate the observed Host state before any break-glass process is launched.
 * @param {Readonly<Record<string, unknown>>} input Packed acceptance inputs.
 * @returns {Readonly<Record<string, unknown>>} Journal-bound recovery identities.
 */
export function validatePackedBreakGlassPrecondition(input) {
  const value = record(input, 'packed break-glass input')
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    fail('P0-BREAK-GLASS-UNSUPPORTED-PLATFORM', 'official DSH Plugin mutation and recovery must fail closed on this platform')
  }
  assertStopped(value.stoppedHostProcess)
  const centerRoot = string(value.centerRoot, 'centerRoot')
  const normalized = verifyJournal(record(value.loadedOperation, 'loadedOperation'))
  const summary = record(value.operationSummary, 'operationSummary')
  if (summary.operationId !== normalized.operationId || summary.targetKey !== normalized.targetKey
    || summary.phase !== 'recovery-required' || summary.operationKind !== value.loadedOperation.projection.operationKind
    || summary.recoveryNotice !== 'journal-reconciliation-pending') {
    fail('P0-BREAK-GLASS-SUMMARY', 'operation/list did not expose the exact recovery-required Plugin projection')
  }
  const binding = record(normalized.planEvidence.recoveryExecutable, 'schema 5 recovery executable binding')
  const official = record(binding.officialDsh, 'official DSH recovery binding')
  const node = record(official.node, 'bound Node')
  const pnpm = record(official.pnpm, 'bound private pnpm')
  const packageVersion = string(binding.packageVersion, 'recovery packageVersion', 128)
  if (binding.schemaVersion !== 5 || binding.platform !== process.platform || binding.arch !== process.arch
    || binding.centerRoot !== centerRoot || official.schemaVersion !== 2
    || official.packageName !== '@deepseek-ai/dsh' || official.packageVersion !== '0.1.1-rc.2'
    || node.schemaVersion !== 1 || node.version !== process.version
    || pnpm.schemaVersion !== 1 || pnpm.packageName !== 'pnpm' || pnpm.packageVersion !== '11.21.0') {
    fail('P0-BREAK-GLASS-BINDING', 'journal does not carry the exact schema 5 official rc.2 execution binding')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(packageVersion)) {
    fail('P0-BREAK-GLASS-BINDING', 'recovery package version is not a safe installed-generation segment')
  }
  for (const [label, value] of [
    ['recovery executable digest', binding.executableSha256],
    ['official DSH package digest', official.packageTreeSha256],
    ['official DSH entrypoint digest', official.entrypointSha256],
    ['bound Node digest', node.executableSha256],
    ['supervisor digest', official.supervisorSha256],
    ['private pnpm package digest', pnpm.packageTreeSha256],
    ['private pnpm entrypoint digest', pnpm.entrypointSha256],
    ['private pnpm shim digest', pnpm.shimSha256],
  ]) digest(value, label)
  for (const [label, path] of [
    ['Center root', value.centerRoot],
    ['recovery executable', binding.executablePath],
    ['bound Node', node.executablePath],
    ['official DSH package', official.packageRoot],
    ['official DSH entrypoint', official.entrypointPath],
    ['supervisor', official.supervisorPath],
    ['private pnpm package', pnpm.packageRoot],
    ['private pnpm entrypoint', pnpm.entrypointPath],
    ['private pnpm shim', pnpm.shimPath],
    ['private pnpm runtime', pnpm.runtimeRoot],
  ]) {
    if (!isAbsolute(string(path, label))) fail('P0-BREAK-GLASS-BINDING', `${label} path is not absolute`)
  }
  const expectedExecutable = join(
    centerRoot,
    'recovery',
    packageVersion,
    `${binding.platform}-${binding.arch}`,
    'break-glass.mjs',
  )
  if (binding.executablePath !== expectedExecutable || !below(centerRoot, official.supervisorPath)
    || !below(centerRoot, pnpm.packageRoot) || !below(centerRoot, pnpm.runtimeRoot)) {
    fail('P0-BREAK-GLASS-BINDING', 'recovery executable or private toolchain escaped its installed Center generation')
  }
  const command = [binding.executablePath, centerRoot, normalized.operationId]
  if (!Array.isArray(summary.recoveryCommand) || summary.recoveryCommand.length !== 3
    || summary.recoveryCommand.some((item, index) => item !== command[index])) {
    fail('P0-BREAK-GLASS-SUMMARY', 'operation/list recovery argv does not match the journal-bound executable')
  }
  return Object.freeze({ ...normalized, binding, official, node, pnpm, command: Object.freeze(command) })
}

async function canonicalRealDirectory(path, label) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) {
    fail('P0-BREAK-GLASS-PATH', `${label} is not a canonical absolute directory`)
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('P0-BREAK-GLASS-PATH', `${label} is not a real directory`)
  return path
}

async function readCanonical(path, label) {
  const bytes = await readFile(path)
  if (bytes.length === 0 || bytes.length > MAX_JSON_BYTES) fail('P0-BREAK-GLASS-EVIDENCE', `${label} exceeds its byte bound`)
  const text = bytes.toString('utf8')
  let value
  try {
    value = JSON.parse(text)
  } catch {
    fail('P0-BREAK-GLASS-EVIDENCE', `${label} is not JSON`)
  }
  if (text !== `${canonicalJson(value)}\n`) fail('P0-BREAK-GLASS-EVIDENCE', `${label} is not canonical JSON`)
  return value
}

async function optionalCanonical(path, label) {
  try {
    return await readCanonical(path, label)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function treeDigest(root) {
  const canonical = await canonicalRealDirectory(root, 'tree digest root')
  const hash = createHash('sha256')
  const visit = async (path) => {
    const info = await lstat(path)
    const name = relative(canonical, path).split(sep).join('/') || '.'
    if (info.isSymbolicLink()) {
      hash.update(`link:${name}:${await readlink(path)}\0`)
      return
    }
    if (info.isFile()) {
      hash.update(`file:${name}:${String(info.size)}\0`)
      hash.update(await readFile(path))
      return
    }
    if (!info.isDirectory()) fail('P0-BREAK-GLASS-PATH', `tree contains unsupported entry ${name}`)
    hash.update(`dir:${name}\0`)
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      await visit(join(path, entry.name))
    }
  }
  await visit(canonical)
  return `sha256:${hash.digest('hex')}`
}

async function tarEntry(archivePath, entryPath) {
  return await new Promise((resolveEntry, rejectEntry) => {
    const child = spawn('tar', ['-xOf', archivePath, entryPath], {
      cwd: dirname(archivePath),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    let stdoutBytes = 0
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_TAR_ENTRY_BYTES) {
        child.kill('SIGKILL')
        return
      }
      stdout.push(chunk)
    })
    child.stderr.resume()
    child.once('error', rejectEntry)
    child.once('close', (code, signal) => {
      if (stdoutBytes > MAX_TAR_ENTRY_BYTES) return rejectEntry(new Error(`packed entry exceeds byte bound: ${entryPath}`))
      if (code !== 0 || signal !== null) return rejectEntry(new Error(`tar could not read packed entry ${entryPath}`))
      resolveEntry(Buffer.concat(stdout))
    })
  })
}

async function verifyPackedBinding(archivePath, normalized) {
  const canonicalArchive = await realpath(resolve(string(archivePath, 'packedArtifactPath')))
  const archiveInfo = await lstat(canonicalArchive)
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) fail('P0-BREAK-GLASS-PACK', 'packed artifact is not a real file')
  const [manifestBytes, recoveryBytes, supervisorBytes, pnpmManifestBytes] = await Promise.all([
    tarEntry(canonicalArchive, 'package/package.json'),
    tarEntry(canonicalArchive, 'package/lib/recovery/break-glass.js'),
    tarEntry(canonicalArchive, 'package/lib/recovery/supervisor.js'),
    tarEntry(canonicalArchive, 'package/node_modules/pnpm/package.json'),
  ])
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const pnpmManifest = JSON.parse(pnpmManifestBytes.toString('utf8'))
  const executableBytes = await readFile(normalized.binding.executablePath)
  const installedSupervisorBytes = await readFile(normalized.official.supervisorPath)
  if (manifest.name !== 'dsh-plugin-extension-center' || manifest.version !== normalized.binding.packageVersion
    || !Array.isArray(manifest.bundledDependencies) || !manifest.bundledDependencies.includes('pnpm')
    || pnpmManifest.name !== 'pnpm' || pnpmManifest.version !== '11.21.0'
    || fileSha256(recoveryBytes) !== normalized.binding.executableSha256
    || !recoveryBytes.equals(executableBytes)
    || fileSha256(supervisorBytes) !== normalized.official.supervisorSha256
    || !supervisorBytes.equals(installedSupervisorBytes)) {
    fail('P0-BREAK-GLASS-PACK', 'installed recovery executable or private toolchain is not bound to the packed artifact')
  }
  return Object.freeze({
    artifactSha256: fileSha256(await readFile(canonicalArchive)),
    packageVersion: manifest.version,
    recoveryExecutableSha256: normalized.binding.executableSha256,
    supervisorSha256: normalized.official.supervisorSha256,
    bundledPnpmVersion: pnpmManifest.version,
  })
}

function appendBounded(current, chunk) {
  const remaining = MAX_PROCESS_OUTPUT_BYTES - Buffer.byteLength(current)
  return remaining <= 0 ? current : current + chunk.subarray(0, remaining).toString()
}

async function runRecoveryProcess(normalized, operationId, timeoutMs) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(normalized.node.executablePath, [
      normalized.binding.executablePath,
      normalized.binding.centerRoot,
      operationId,
    ], {
      cwd: dirname(normalized.binding.executablePath),
      detached: process.platform !== 'win32',
      env: {
        PATH: '/extension-center-break-glass-does-not-use-path',
        DSH_HOME: normalized.attackerHome,
        LANG: 'C',
        LC_ALL: 'C',
        NO_COLOR: '1',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk) })
    child.once('error', error => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) return rejectRun(new Error('packed break-glass recovery timed out'))
      resolveRun(Object.freeze({ exitCode: code, signal, stdout, stderr }))
    })
  })
}

async function collectFiles(root, current = root, ignoreRootNodeModules = false) {
  const output = []
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (ignoreRootNodeModules && current === root && entry.name === 'node_modules') continue
    const path = join(current, entry.name)
    const name = relative(root, path).split(sep).join('/')
    if (entry.isSymbolicLink()) fail('P0-BREAK-GLASS-PROFILE', `installed Plugin contains a symbolic link: ${name}`)
    if (entry.isDirectory()) output.push(...await collectFiles(root, path, ignoreRootNodeModules))
    else if (entry.isFile()) {
      const bytes = await readFile(path)
      output.push(Object.freeze({ path: name, sizeBytes: bytes.length, sha256: fileSha256(bytes) }))
    } else fail('P0-BREAK-GLASS-PROFILE', `installed Plugin contains an unsupported entry: ${name}`)
  }
  return Object.freeze(output)
}

async function verifyPhysicalBefore(normalized, before) {
  const profileRoot = join(normalized.official.hostHome, 'profiles', normalized.profileId)
  const manifest = record(JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8')), 'official Profile manifest')
  const dependencies = manifest.dependencies === undefined ? {} : record(manifest.dependencies, 'official Profile dependencies')
  const dsh = manifest.dsh === undefined ? {} : record(manifest.dsh, 'official Profile dsh metadata')
  const profile = dsh.profile === undefined ? {} : record(dsh.profile, 'official Profile bundle metadata')
  const bundles = profile.bundles === undefined ? [] : profile.bundles
  if (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string')) {
    fail('P0-BREAK-GLASS-PROFILE', 'official Profile bundle list is invalid')
  }
  const current = before === null ? null : before.current
  if (current === null) {
    if (dependencies[normalized.packageName] !== undefined || bundles.includes(normalized.packageName)) {
      fail('P0-BREAK-GLASS-PROFILE', 'recovery did not restore an absent exact before-state')
    }
    return Object.freeze({ desired: 'absent', dependency: null, bundleCount: 0, installedTreeDigest: null })
  }
  const version = record(current, 'provider snapshot current version')
  const materialPath = string(version.materialPath, 'provider snapshot current materialPath')
  const marker = record(await readCanonical(`${materialPath}.owner.json`, 'managed Plugin material marker'), 'material marker')
  const dependency = dependencies[normalized.packageName]
  const bundleCount = bundles.filter(item => item === normalized.packageName).length
  if (marker.targetKey !== normalized.targetKey || marker.packageName !== normalized.packageName
    || marker.version !== version.artifactRevision || dependency !== `file:${marker.artifactPath}` || bundleCount !== 1) {
    fail('P0-BREAK-GLASS-PROFILE', 'official Profile dependency or Bundle membership does not match the provider before-state')
  }
  const artifactBytes = await readFile(marker.artifactPath)
  if (artifactBytes.length !== marker.artifactSizeBytes || fileSha256(artifactBytes) !== marker.artifactSha256) {
    fail('P0-BREAK-GLASS-PROFILE', 'retained before-state artifact changed')
  }
  const installedRoot = await realpath(join(profileRoot, 'node_modules', ...normalized.packageName.split('/')))
  const files = await collectFiles(installedRoot, installedRoot, true)
  if (canonicalSha256(files) !== canonicalSha256(marker.files)) {
    fail('P0-BREAK-GLASS-PROFILE', 'official Profile installed tree does not match retained before-state material')
  }
  const installedManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
  if (installedManifest.name !== normalized.packageName || installedManifest.version !== marker.version
    || canonicalSha256(installedManifest) !== marker.manifestDigest) {
    fail('P0-BREAK-GLASS-PROFILE', 'official Profile installed Plugin manifest does not match retained before-state material')
  }
  return Object.freeze({
    desired: 'installed',
    dependency,
    bundleCount,
    installedVersion: marker.version,
    installedTreeDigest: canonicalSha256(files),
  })
}

async function verifyRecoveryEvidence(normalized) {
  const providerSnapshotPath = join(
    normalized.binding.centerRoot,
    'state',
    'provider-snapshots',
    `${storageKey(normalized.operationId)}.json`,
  )
  const snapshot = record(await readCanonical(providerSnapshotPath, 'Plugin provider snapshot'), 'provider snapshot')
  const snapshotDigest = canonicalSha256(snapshot)
  if (snapshot.schemaVersion !== 1 || snapshot.operationId !== normalized.operationId
    || snapshot.targetKey !== normalized.targetKey || snapshot.beforeDigest !== normalized.beforeDigest
    || snapshot.beforeDigest !== managedStateDigest(snapshot.before)) {
    fail('P0-BREAK-GLASS-EVIDENCE', 'provider snapshot does not bind the recovery-required journal before-state')
  }
  const key = storageKey(normalized.operationId)
  const transaction = exactKeys(
    await readCanonical(join(normalized.binding.centerRoot, 'recovery', 'transactions', `${key}.json`), 'recovery transaction'),
    [
      'schemaVersion', 'operationId', 'targetKey', 'profileId', 'journalHeadDigest', 'providerSnapshotDigest',
      'sourceManaged', 'sourceManagedDigest', 'sourceSidecar', 'sourceSidecarDigest', 'restoredManaged', 'restoredSidecar',
      'recoveryEvidence', 'recoveryEvidenceDigest', 'preparedAtMs', 'committedAtMs', 'status',
    ],
    'recovery transaction',
  )
  const evidence = exactKeys(
    await readCanonical(join(normalized.binding.centerRoot, 'plugin', 'break-glass-restores', `${key}.json`), 'break-glass restore evidence'),
    [
      'schemaVersion', 'operationId', 'targetKey', 'profileId', 'packageName', 'journalHeadDigest',
      'providerSnapshotDigest', 'beforeDigest', 'restoredManagedDigest', 'restoredRevision', 'status',
    ],
    'break-glass restore evidence',
  )
  if (transaction.schemaVersion !== 1 || transaction.status !== 'committed'
    || transaction.operationId !== normalized.operationId || transaction.targetKey !== normalized.targetKey
    || transaction.profileId !== normalized.profileId || transaction.journalHeadDigest !== normalized.headDigest
    || transaction.providerSnapshotDigest !== snapshotDigest || transaction.recoveryEvidenceDigest !== canonicalSha256(evidence)
    || canonicalJson(transaction.recoveryEvidence) !== canonicalJson(evidence)) {
    fail('P0-BREAK-GLASS-EVIDENCE', 'committed recovery transaction does not bind the verified journal and provider snapshot')
  }
  if (evidence.schemaVersion !== 1 || evidence.status !== 'settled' || evidence.operationId !== normalized.operationId
    || evidence.targetKey !== normalized.targetKey || evidence.profileId !== normalized.profileId
    || evidence.packageName !== normalized.packageName || evidence.journalHeadDigest !== normalized.headDigest
    || evidence.providerSnapshotDigest !== snapshotDigest || evidence.beforeDigest !== normalized.beforeDigest
    || evidence.restoredManagedDigest !== normalized.beforeDigest) {
    fail('P0-BREAK-GLASS-EVIDENCE', 'break-glass evidence does not bind the exact settled before-state')
  }
  const managedPath = join(
    normalized.binding.centerRoot,
    'state',
    'managed',
    `${storageKey(normalized.targetKey)}.json`,
  )
  const restored = await optionalCanonical(managedPath, 'restored managed Plugin state') ?? null
  if (managedStateDigest(restored) !== normalized.beforeDigest
    || restored === null && evidence.restoredRevision !== null
    || restored !== null && (restored.lastOperationId !== normalized.operationId || restored.pending !== null
      || restored.revision !== evidence.restoredRevision)) {
    fail('P0-BREAK-GLASS-EVIDENCE', 'Center managed state does not match the committed recovery evidence')
  }
  const profile = await verifyPhysicalBefore(normalized, snapshot.before)
  return Object.freeze({
    providerSnapshotDigest: snapshotDigest,
    transactionDigest: canonicalSha256(transaction),
    recoveryEvidenceDigest: canonicalSha256(evidence),
    restoredManagedDigest: evidence.restoredManagedDigest,
    restoredRevision: evidence.restoredRevision,
    profile,
  })
}

async function writeReceipt(path, receipt) {
  if (path === undefined) return
  const destination = resolve(path)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(destination), `.break-glass-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${canonicalJson(receipt)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Execute and independently verify one packed schema 5 recovery-required Plugin operation.
 *
 * The caller must supply an operation produced by the running packed Host. This
 * helper deliberately has no journal-construction or fault-injection seam.
 * @param {Readonly<Record<string, unknown>>} input Exact packed artifact, stopped Host, RPC operation, and output path.
 * @returns {Promise<Readonly<Record<string, unknown>>>} Canonical acceptance receipt; Host restart reconciliation remains pending.
 */
export async function runPackedBreakGlassE2e(input) {
  const value = record(input, 'packed break-glass input')
  const centerRoot = await canonicalRealDirectory(resolve(string(value.centerRoot, 'centerRoot')), 'Center root')
  const attackerHome = await canonicalRealDirectory(
    resolve(string(value.attackerHome, 'attackerHome')),
    'attacker-selected DSH home',
  )
  const precondition = validatePackedBreakGlassPrecondition({ ...value, centerRoot })
  const normalized = Object.freeze({ ...precondition, attackerHome })
  const timeoutMs = value.timeoutMs ?? 180_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    fail('P0-BREAK-GLASS-INPUT', 'break-glass timeout must be an integer between 1000 and 600000')
  }
  const packed = await verifyPackedBinding(value.packedArtifactPath, normalized)
  const officialBefore = await immutablePackageTreeDigest(normalized.official.packageRoot)
  const attackerBefore = await treeDigest(attackerHome)
  const profileRoot = join(normalized.official.hostHome, 'profiles', normalized.profileId)
  const centerBeforeProbe = await treeDigest(centerRoot)
  const profileBeforeProbe = await treeDigest(profileRoot)
  const invalidOperationId = `invalid:${storageKey(normalized.operationId)}`
  const negative = await runRecoveryProcess(normalized, invalidOperationId, timeoutMs)
  if (negative.exitCode === 0 || negative.signal !== null || await treeDigest(centerRoot) !== centerBeforeProbe
    || await treeDigest(profileRoot) !== profileBeforeProbe
    || await immutablePackageTreeDigest(normalized.official.packageRoot) !== officialBefore
    || await treeDigest(attackerHome) !== attackerBefore) {
    fail('P0-BREAK-GLASS-FAIL-CLOSED', 'invalid operation probe did not fail closed before every observed state surface')
  }
  const result = await runRecoveryProcess(normalized, normalized.operationId, timeoutMs)
  if (result.exitCode !== 0 || result.signal !== null || result.stdout !== RECOVERY_STDOUT || result.stderr !== '') {
    fail('P0-BREAK-GLASS-EXECUTION', 'bound packed recovery executable did not complete with its stable success result')
  }
  const evidence = await verifyRecoveryEvidence(normalized)
  const officialAfter = await immutablePackageTreeDigest(normalized.official.packageRoot)
  const attackerAfter = await treeDigest(attackerHome)
  if (officialAfter !== officialBefore) {
    fail('P0-BREAK-GLASS-OFFICIAL-TREE', 'break-glass recovery changed the official DSH package tree')
  }
  if (attackerAfter !== attackerBefore) {
    fail('P0-BREAK-GLASS-BOUND-HOME', 'invoking-process DSH_HOME influenced recovery state')
  }
  const receipt = Object.freeze({
    schemaVersion: 1,
    acceptanceId: 'P0-PACKED-BREAK-GLASS-MANAGED-PLUGIN-RESTORE',
    status: 'passed',
    target: Object.freeze({
      dshPackage: '@deepseek-ai/dsh@0.1.1-rc.2',
      packageTreeDigestBefore: officialBefore,
      packageTreeDigestAfter: officialAfter,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: normalized.node.version,
    }),
    packed,
    operation: Object.freeze({
      operationId: normalized.operationId,
      targetKey: normalized.targetKey,
      packageName: normalized.packageName,
      profileId: normalized.profileId,
      phase: 'recovery-required',
      journalHeadDigest: normalized.headDigest,
      beforeDigest: normalized.beforeDigest,
      terminalReceipt: null,
    }),
    stoppedHost: Object.freeze({
      exitCode: value.stoppedHostProcess.exitCode,
      signalCode: value.stoppedHostProcess.signalCode,
    }),
    failClosedProbe: Object.freeze({
      invalidOperationRejected: true,
      centerTreeUnchanged: true,
      profileTreeUnchanged: true,
      officialDshPackageTreeUnchanged: true,
      invokingDshHomeUnchanged: true,
    }),
    recovery: Object.freeze({
      schemaVersion: normalized.binding.schemaVersion,
      officialExecutionBindingSchemaVersion: normalized.official.schemaVersion,
      privatePnpmVersion: normalized.pnpm.packageVersion,
      stdoutMatched: true,
      invokingDshHomeIgnored: true,
      officialDshPackageTreeUnchanged: true,
      evidence,
    }),
    remaining: Object.freeze(['host-restart-journal-reconciliation-and-terminal-receipt']),
  })
  await writeReceipt(value.receiptPath, receipt)
  return receipt
}
