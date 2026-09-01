import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, canonicalSha256 } from '../src/domain/index.ts'
import { captureCurrentProcessIdentity, type ManagedTargetRecord, type ManagedVersion } from '../src/host/index.ts'
import {
  createOperationJournal,
  transitionOperation,
  type OperationAuthorization,
  type OperationJournal,
} from '../src/operations/index.ts'
import { managedStateDigest } from '../src/providers/records.ts'
import { installRecoveryExecutable } from '../src/recovery/install.ts'
import { prepareProfileMetadataCache } from '../src/recovery/profile-metadata-cache.ts'
import { FileOperationStore } from '../src/storage/operation-store.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const roots: string[] = []
const spawnedPids: number[] = []
interface TrackedCliProcess {
  readonly child: ChildProcess
  readonly close: Promise<void>
  closed: boolean
  cleanup: Promise<void> | null
}

const spawnedCliProcesses = new Set<TrackedCliProcess>()
const CLI_RUN_TIMEOUT_MS = 20_000
const CLI_CLEANUP_TIMEOUT_MS = 5_000
const OPERATION_ID = 'operation:break-glass:plugin:1'
const PROFILE_ID = 'web'
const SCOPE_KEY = 'profile:web'
const EXTENSION_ID = 'dsh-example'
const TARGET_KEY = `plugin:${PROFILE_ID}:${SCOPE_KEY}:${EXTENSION_ID}`

interface Fixture {
  readonly root: string
  readonly cliPath: string
  readonly supervisorPath: string
  readonly dshEntrypoint: string
  readonly dshPackageRoot: string
  readonly officialCliLog: string
  readonly hostHome: string
  readonly profileStore: string
  readonly profilePath: string
  readonly operationDirectory: string
  readonly managedPath: string
  readonly sidecarPath: string
  readonly transactionPath: string
  readonly before: ManagedTargetRecord | null
  readonly orphanPids: string | null
}

interface RetainedVersion {
  readonly managed: ManagedVersion
  readonly artifactPath: string
}

async function within<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null
  const deadline = new Promise<never>((_resolvePromise, reject) => {
    timeout = setTimeout(() => reject(new Error(label)), timeoutMs)
    timeout.unref()
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timeout !== null) clearTimeout(timeout)
  }
}

function trackCliProcess(child: ChildProcess): TrackedCliProcess {
  let resolveClose!: () => void
  const tracked: TrackedCliProcess = {
    child,
    close: new Promise<void>(accept => { resolveClose = accept }),
    closed: false,
    cleanup: null,
  }
  spawnedCliProcesses.add(tracked)
  child.once('close', () => {
    tracked.closed = true
    spawnedCliProcesses.delete(tracked)
    resolveClose()
  })
  return tracked
}

function stopTrackedCliProcess(tracked: TrackedCliProcess): Promise<void> {
  tracked.cleanup ??= (async () => {
    if (!tracked.closed && tracked.child.exitCode === null && tracked.child.signalCode === null) {
      try {
        tracked.child.kill('SIGKILL')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await within(
      tracked.close,
      CLI_CLEANUP_TIMEOUT_MS,
      'break-glass CLI did not close during test cleanup',
    )
  })()
  return tracked.cleanup
}

async function terminateTrackedCliChildren(): Promise<void> {
  await Promise.all([...spawnedCliProcesses].map(stopTrackedCliProcess))
}

afterEach(async () => {
  const cleanupErrors: unknown[] = []
  try {
    await terminateTrackedCliChildren()
  } catch (error: unknown) {
    cleanupErrors.push(error)
  }
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupErrors.push(error)
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'break-glass process cleanup failed; fixture roots retained')
  }
  const removals = await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  for (const removal of removals) if (removal.status === 'rejected') cleanupErrors.push(removal.reason)
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'break-glass test cleanup failed')
})

function storageKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fileSha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function retainedVersion(root: string, name: string): Promise<RetainedVersion> {
  const manifest = {
    name: EXTENSION_ID,
    version: name,
    dsh: { bundle: { patch: 'cordis.yml' } },
  }
  const files = [
    { path: 'cordis.yml', bytes: Buffer.from(`plugins:\n  example-${name}: {}\n`) },
    { path: 'package.json', bytes: Buffer.from(`${JSON.stringify(manifest)}\n`) },
  ].sort((left, right) => left.path.localeCompare(right.path))
  const artifact = {
    packageName: EXTENSION_ID,
    version: name,
    files: files.map(file => ({ path: file.path, content: file.bytes.toString('base64') })),
  }
  const artifactBytes = Buffer.from(`${canonicalJson(artifact)}\n`)
  const integrity = fileSha256(artifactBytes)
  const artifactPath = join(root, 'artifacts', `${EXTENSION_ID}-${name}.tgz`)
  const materialPath = join(root, 'material', 'plugins', storageKey(TARGET_KEY), storageKey(integrity))
  await mkdir(materialPath, { recursive: true })
  await mkdir(dirname(artifactPath), { recursive: true })
  await writeFile(artifactPath, artifactBytes)
  for (const file of files) await writeFile(join(materialPath, file.path), file.bytes)
  await writeCanonical(`${materialPath}.owner.json`, {
    schemaVersion: 1,
    targetKey: TARGET_KEY,
    packageName: EXTENSION_ID,
    version: name,
    integrity,
    artifactPath,
    artifactSizeBytes: artifactBytes.length,
    artifactSha256: fileSha256(artifactBytes),
    manifestDigest: canonicalSha256(manifest),
    files: files.map(file => ({ path: file.path, sizeBytes: file.bytes.length, sha256: fileSha256(file.bytes) })),
  })
  return {
    artifactPath,
    managed: {
      candidateRef: `plugin:${EXTENSION_ID}@${name}`,
      artifactRevision: name,
      artifactIntegrity: integrity,
      materialPath,
      configuration: { value: name },
      enabled: true,
      ownerRevision: `managed-plugin:${name}`,
      kindState: {
        packageName: EXTENSION_ID,
        restartToken: `managed:${name}`,
        treeDigest: canonicalSha256({ tree: name }),
        loaderPhase: 'active',
        consumerObserved: true,
        restartObserved: true,
        runtimeEvidence: { entryId: `loader:${name}`, moduleName: EXTENSION_ID, fiberPhase: 'active' },
      },
    },
  }
}

function managed(root: string, revision: number, operationId: string, current: ManagedVersion): ManagedTargetRecord {
  return {
    schemaVersion: 1,
    kind: 'plugin',
    extensionId: EXTENSION_ID,
    targetKey: TARGET_KEY,
    scopeKey: SCOPE_KEY,
    profileId: PROFILE_ID,
    revision,
    lastOperationId: operationId,
    current,
    lastGood: null,
    removed: null,
    pending: null,
    updatedAtMs: 1_000 + revision,
  }
}

function sidecar(record: ManagedTargetRecord) {
  return {
    schemaVersion: 1,
    profileId: PROFILE_ID,
    packageName: EXTENSION_ID,
    targetKey: TARGET_KEY,
    revision: record.revision,
    lastOperationId: record.lastOperationId,
    managed: record,
    loaderEntryId: 'loader:current',
    loaderName: EXTENSION_ID,
    restartPending: false,
    lastGoodMaterialPath: record.lastGood?.materialPath ?? null,
    tombstoneMaterialPath: record.removed?.materialPath ?? null,
  }
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${canonicalJson(value)}\n`, { mode: 0o600 })
}

async function createOfficialDshFixture(root: string): Promise<Readonly<{
  entrypointPath: string
  packageRoot: string
  hostHome: string
  logPath: string
  storeDir: string
}>> {
  const packageRoot = join(root, 'official-host', 'node_modules', '@deepseek-ai', 'dsh')
  const entrypointPath = join(packageRoot, 'lib', 'bin.js')
  const hostHome = join(root, 'bound-dsh-home')
  const logPath = join(root, 'official-cli-invocations.jsonl')
  const storeDir = join(root, 'profile-store', 'v11')
  await mkdir(dirname(entrypointPath), { recursive: true })
  await mkdir(hostHome, { recursive: true })
  await mkdir(storeDir, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.1.2-alpha.3',
    type: 'module',
    bin: { dsh: 'lib/bin.js' },
  })}\n`)
  await writeFile(entrypointPath, `#!/usr/bin/env node
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

const args = process.argv.slice(2)
const profileArg = args.find(value => value.startsWith('--profile='))
const storeIndex = args.lastIndexOf('--store-dir')
const configuredStore = storeIndex < 0 ? undefined : args[storeIndex + 1]
if (args[0] !== 'plugin' || profileArg === undefined || !isAbsolute(process.env.DSH_HOME ?? '')
  || configuredStore === undefined || !isAbsolute(configuredStore)) process.exit(2)
const storeDir = basename(configuredStore) === 'v11' ? configuredStore : join(configuredStore, 'v11')
await mkdir(storeDir, { recursive: true })
await appendFile(${JSON.stringify(logPath)}, JSON.stringify({ argv: args, pnpmStore: process.env.pnpm_config_store_dir }) + '\\n')
const profileId = profileArg.slice('--profile='.length)
const actionIndex = args.findIndex(value => value === 'add' || value === 'remove')
const action = args[actionIndex]
const operand = args[actionIndex + 1]
if (actionIndex < 0 || operand === undefined) process.exit(2)
const profile = join(process.env.DSH_HOME, 'profiles', profileId)
const manifestPath = join(profile, 'package.json')
await mkdir(join(profile, 'node_modules'), { recursive: true })
await writeFile(join(profile, 'node_modules', '.modules.yaml'), JSON.stringify({
  layoutVersion: 5,
  nodeLinker: 'hoisted',
  packageManager: 'pnpm@11.21.0',
  hoistedLocations: {},
  registries: { default: 'https://registry.npmjs.org/' },
  storeDir,
  virtualStoreDir: '.pnpm',
}) + '\\n')
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\\n  - .\\n\\nnodeLinker: hoisted\\nautoInstallPeers: false\\n')
let manifest
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { manifest = { name: 'profile-' + profileId } }
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []
if (action === 'add') {
  const archive = JSON.parse(await readFile(operand, 'utf8'))
  manifest.dependencies[archive.packageName] = 'file:' + operand
  if (!manifest.dsh.profile.bundles.includes(archive.packageName)) manifest.dsh.profile.bundles.push(archive.packageName)
  const installed = join(profile, 'node_modules', ...archive.packageName.split('/'))
  await rm(installed, { recursive: true, force: true })
  for (const file of archive.files) {
    const destination = join(installed, ...file.path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, Buffer.from(file.content, 'base64'))
  }
} else {
  delete manifest.dependencies[operand]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(value => value !== operand)
  await rm(join(profile, 'node_modules', ...operand.split('/')), { recursive: true, force: true })
}
await writeFile(manifestPath, JSON.stringify(manifest) + '\\n')
await writeFile(join(profile, 'pnpm-lock.yaml'), JSON.stringify({
  lockfileVersion: '9.0',
  importers: { '.': { dependencies: Object.fromEntries(Object.entries(manifest.dependencies).map(([name, specifier]) => [name, { specifier, version: specifier }])) } },
  packages: {},
  snapshots: {},
}) + '\\n')
`, { mode: 0o500 })
  return {
    entrypointPath: await realpath(entrypointPath),
    packageRoot: await realpath(packageRoot),
    hostHome: await realpath(hostHome),
    logPath: await realpath(logPath).catch(() => logPath),
    storeDir: await realpath(storeDir),
  }
}

async function runOfficialFixture(entrypoint: string, hostHome: string, arguments_: readonly string[]): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...arguments_], {
      env: { ...process.env, DSH_HOME: hostHome },
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) accept()
      else reject(new Error(`fake official DSH failed: exit=${String(code)} signal=${String(signal)}`))
    })
  })
}

async function compileStandaloneCli(root: string): Promise<string> {
  const source = await readFile(join(process.cwd(), 'src', 'recovery', 'break-glass.ts'), 'utf8')
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1])
  expect(imports.length).toBeGreaterThan(0)
  expect(imports.every(specifier => specifier?.startsWith('node:'))).toBe(true)
  expect(source).not.toContain("from '../")
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
    reportDiagnostics: true,
    fileName: 'break-glass.ts',
  })
  expect(transpiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? []).toEqual([])
  const path = join(root, 'compiled-break-glass.mjs')
  await writeFile(path, transpiled.outputText, { mode: 0o500 })
  return await realpath(path)
}

async function compileStandaloneSupervisor(root: string): Promise<string> {
  const source = await readFile(join(process.cwd(), 'src', 'recovery', 'supervisor.ts'), 'utf8')
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1])
  expect(imports.every(specifier => specifier?.startsWith('node:'))).toBe(true)
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
    reportDiagnostics: true,
    fileName: 'supervisor.ts',
  })
  expect(transpiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? []).toEqual([])
  const path = join(root, 'compiled-supervisor.mjs')
  await writeFile(path, transpiled.outputText, { mode: 0o500 })
  return await realpath(path)
}

function authorization(
  recoveryExecutable: OperationAuthorization['recoveryExecutable'],
  beforeDigest: `sha256:${string}`,
  ownerKey = 'managedPlugins',
): OperationAuthorization {
  return {
    operationId: OPERATION_ID,
    planId: 'plan:break-glass:1',
    planHash: canonicalSha256({ plan: 1 }),
    origin: 'store',
    candidateRef: `plugin:${EXTENSION_ID}@2.0.0`,
    extensionKind: 'plugin',
    extensionId: EXTENSION_ID,
    operationKind: 'update',
    managedObject: 'artifact',
    externalRuntimeAction: 'download',
    runtimeBinding: null,
    artifactRevision: '2.0.0',
    artifactIntegrity: canonicalSha256({ artifact: 2 }),
    artifactUrl: 'https://example.invalid/dsh-example-2.0.0.tgz',
    artifactSizeBytes: 1024,
    desiredState: 'enabled',
    targetKey: TARGET_KEY,
    ownerKey,
    scopeKey: SCOPE_KEY,
    profileId: PROFILE_ID,
    idempotencyKey: 'break-glass-idempotency',
    authorityDigest: canonicalSha256({ authority: 1 }),
    configurationDigest: canonicalSha256({ configuration: 2 }),
    retentionDigest: canonicalSha256({ retention: 1 }),
    mutationDigest: canonicalSha256({ mutation: 2 }),
    verificationDigest: canonicalSha256({ verification: 2 }),
    reviewEvidence: testReviewEvidence('plugin', 'update', {
      generation: '22222222-2222-4222-8222-222222222222',
      treeDigest: beforeDigest,
    }),
    restartRequired: true,
    fences: {
      catalogRevision: 1,
      inventoryRevision: canonicalSha256({ inventory: 1 }),
      targetRevision: 'plugin:1',
      ownerRevision: 'managed-plugin:1',
      scopeRevision: 'profile:web:1',
      profileRevision: 'managed-plugin:1',
    },
    recoveryExecutable,
    authorizedAtMs: 1_000,
  }
}

async function fixture(input: Readonly<{
  absentBefore?: boolean
  ownerKey?: string
  orphaningCli?: boolean
}> = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'extension-break-glass-')))
  roots.push(root)
  await writeCanonical(join(root, 'manifest.json'), {
    schemaVersion: 1,
    centerId: randomUUID(),
    createdAtMs: 1_000,
  })
  const v1 = await retainedVersion(root, '1.0.0')
  const v2 = await retainedVersion(root, '2.0.0')
  const officialRoot = await realpath(await mkdtemp(join(tmpdir(), 'extension-break-glass-host-')))
  roots.push(officialRoot)
  const official = await createOfficialDshFixture(officialRoot)
  await runOfficialFixture(official.entrypointPath, official.hostHome, [
    'plugin', `--profile=${PROFILE_ID}`, 'add', v2.artifactPath,
    '--offline', '--ignore-scripts', '--save-exact', '--store-dir', official.storeDir,
  ])
  const orphanPids = input.orphaningCli === true ? join(root, 'orphan-pids.json') : null
  if (orphanPids !== null) {
    const grandchild = [
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)',
    ].join(';')
    await chmod(official.entrypointPath, 0o700)
    await writeFile(official.entrypointPath, [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      `const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
      'child.unref()',
      `writeFileSync(${JSON.stringify(orphanPids)}, JSON.stringify([process.pid, child.pid]))`,
    ].join('\n'))
    await chmod(official.entrypointPath, 0o500)
  }
  const compiled = await compileStandaloneCli(root)
  const supervisor = await compileStandaloneSupervisor(root)
  const recoveryExecutable = await installRecoveryExecutable({
    root,
    packageVersion: '1.0.0',
    cliPath: compiled,
    supervisorPath: supervisor,
    officialDsh: {
      entrypointPath: official.entrypointPath,
      hostHome: official.hostHome,
      timeoutMs: 10_000,
    },
  })
  const metadataCache = await prepareProfileMetadataCache(recoveryExecutable.officialDsh, PROFILE_ID)
  const before = input.absentBefore === true ? null : managed(root, 4, 'operation:prior', v1.managed)
  const after = managed(root, before === null ? 1 : 5, OPERATION_ID, v2.managed)
  const beforeDigest = managedStateDigest(before)
  const store = new FileOperationStore(root)
  let journal: OperationJournal = createOperationJournal(
    authorization(recoveryExecutable, beforeDigest, input.ownerKey),
    beforeDigest,
    1_001,
  )
  await store.persist(journal)
  for (const [to, reason] of [
    ['staging', null],
    ['applying', null],
    ['rolling-back', null],
    ['recovery-required', 'rollback-failed'],
  ] as const) {
    journal = transitionOperation(journal, to, null, reason, 1_001 + journal.events.length)
    await store.persist(journal)
  }
  const managedPath = join(root, 'state', 'managed', `${storageKey(TARGET_KEY)}.json`)
  const sidecarPath = join(root, 'plugin', 'profiles', storageKey(PROFILE_ID), 'packages', `${storageKey(TARGET_KEY)}.json`)
  const transactionPath = join(root, 'recovery', 'transactions', `${storageKey(OPERATION_ID)}.json`)
  await writeCanonical(managedPath, after)
  await writeCanonical(sidecarPath, sidecar(after))
  await writeCanonical(join(root, 'state', 'provider-snapshots', `${storageKey(OPERATION_ID)}.json`), {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    targetKey: TARGET_KEY,
    before,
    beforeDigest,
    recoveryPoint: {
      kind: 'plugin',
      snapshot: {
        profileId: PROFILE_ID,
        revision: 4,
        digest: canonicalSha256({ profile: 4 }),
        materialRoot: join(root, 'material', 'plugins'),
        bootStatus: 'verified',
        ownerRevision: `managed-plugin:4:${canonicalSha256({ profile: 4 })}`,
      },
      artifactPath: null,
      metadataCache,
    },
  })
  return {
    root,
    cliPath: recoveryExecutable.executablePath,
    supervisorPath: recoveryExecutable.officialDsh.supervisorPath,
    dshEntrypoint: official.entrypointPath,
    dshPackageRoot: official.packageRoot,
    officialCliLog: official.logPath,
    hostHome: official.hostHome,
    profileStore: official.storeDir,
    profilePath: join(official.hostHome, 'profiles', PROFILE_ID),
    operationDirectory: join(root, 'operations', storageKey(OPERATION_ID)),
    managedPath,
    sidecarPath,
    transactionPath,
    before,
    orphanPids,
  }
}

async function runCli(
  value: Fixture,
  root = value.root,
  environment: Readonly<Record<string, string>> = {},
): Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>> {
  const child = spawn(process.execPath, [value.cliPath, root, OPERATION_ID], {
    env: { PATH: '/definitely-not-used', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tracked = trackCliProcess(child)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const completion = new Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>>((accept, reject) => {
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === null || signal !== null) return reject(new Error('break-glass CLI did not exit normally'))
      accept({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code })
    })
  })
  try {
    return await within(completion, CLI_RUN_TIMEOUT_MS, 'break-glass CLI did not close within its test deadline')
  } finally {
    await stopTrackedCliProcess(tracked)
  }
}

async function expectProcessAbsent(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
  }
  throw new Error(`break-glass official CLI process remains alive: ${String(pid)}`)
}

async function profileState(value: Fixture): Promise<Readonly<{
  dependency: string | undefined
  bundles: readonly string[]
  installedVersion: string | null
}>> {
  const manifest = JSON.parse(await readFile(join(value.profilePath, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  let installedVersion: string | null = null
  try {
    const installed = JSON.parse(await readFile(
      join(value.profilePath, 'node_modules', EXTENSION_ID, 'package.json'),
      'utf8',
    )) as { version?: unknown }
    installedVersion = typeof installed.version === 'string' ? installed.version : null
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return {
    dependency: manifest.dependencies?.[EXTENSION_ID],
    bundles: manifest.dsh?.profile?.bundles ?? [],
    installedVersion,
  }
}

describe('standalone Center break-glass recovery', { timeout: 30_000 }, () => {
  it('classifies the observed child outcome deadline before accepting supervisor success', async () => {
    for (const name of ['execution.ts', 'break-glass.ts']) {
      const source = await readFile(join(process.cwd(), 'src', 'recovery', name), 'utf8')
      const observation = source.indexOf('outcomeObservedAtMs = performance.now()')
      const deadline = source.indexOf('if (deadlineExpired)', observation)
      const success = source.indexOf('else if (childOutcome.code === 0)', deadline)
      const stdinError = source.indexOf("child.stdin.once('error'")
      const startDispatch = source.indexOf("child.stdin.write('START\\n'", stdinError)
      const durableDispatch = source.indexOf('writeExecutionDispatch(candidate)', startDispatch)
      const exitObserved = source.indexOf("child.once('exit'")
      const closeObserved = source.indexOf("child.once('close'", exitObserved)
      const passiveDispatchFailure = source.indexOf('if (!exitObserved) child.stdin.destroy()')
      expect(observation).toBeGreaterThanOrEqual(0)
      expect(deadline).toBeGreaterThan(observation)
      expect(success).toBeGreaterThan(deadline)
      expect(stdinError).toBeGreaterThanOrEqual(0)
      expect(startDispatch).toBeGreaterThan(stdinError)
      expect(durableDispatch).toBeGreaterThan(startDispatch)
      expect(exitObserved).toBeGreaterThanOrEqual(0)
      expect(durableDispatch).toBeLessThan(exitObserved)
      expect(closeObserved).toBeGreaterThan(exitObserved)
      expect(passiveDispatchFailure).toBeGreaterThan(closeObserved)
      expect([...source.matchAll(/process\.kill\(-pid, 'SIGKILL'\)/gu)]).toHaveLength(1)
    }
  })

  it('makes a fast recovery dispatch durable before observing supervisor close', async () => {
    const value = await fixture()
    const preloadPath = join(value.root, 'dispatch-close-barrier.mjs')
    await writeFile(preloadPath, [
      "import childProcess from 'node:child_process'",
      "import fs from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      "const suffix = '/execution-dispatch.json'",
      'let resolveSupervisorClose',
      'const supervisorClosed = new Promise(accept => { resolveSupervisorClose = accept })',
      'const realSpawn = childProcess.spawn.bind(childProcess)',
      'const realOpen = fs.promises.open.bind(fs.promises)',
      'childProcess.spawn = (command, arguments_, options) => {',
      '  const child = realSpawn(command, arguments_, options)',
      '  if (Array.isArray(arguments_) && arguments_[0] === process.env.DISPATCH_SUPERVISOR_PATH) {',
      '    child.once(\'close\', resolveSupervisorClose)',
      '  }',
      '  return child',
      '}',
      'fs.promises.open = async (path, ...arguments_) => {',
      '  const handle = await realOpen(path, ...arguments_)',
      '  if (String(path).endsWith(suffix)) {',
      '    const realSync = handle.sync.bind(handle)',
      '    handle.sync = async () => {',
      '      await supervisorClosed',
      '      return realSync()',
      '    }',
      '  }',
      '  return handle',
      '}',
      'syncBuiltinESMExports()',
    ].join('\n'))

    await expect(runCli(value, value.root, {
      DISPATCH_SUPERVISOR_PATH: value.supervisorPath,
      NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
    })).resolves.toMatchObject({ exitCode: 0, stderr: '' })
  }, 30_000)

  it('uses the bound official CLI to restore Profile v1 before committing Center state', async () => {
    const value = await fixture()

    await expect(profileState(value)).resolves.toMatchObject({
      dependency: expect.stringContaining('2.0.0.tgz'),
      bundles: [EXTENSION_ID],
      installedVersion: '2.0.0',
    })

    const result = await runCli(value)

    expect(result).toEqual({
      stdout: 'Official Profile and Center state restored; restart verification pending\n',
      stderr: '',
      exitCode: 0,
    })
    await expect(profileState(value)).resolves.toMatchObject({
      dependency: expect.stringContaining('1.0.0.tgz'),
      bundles: [EXTENSION_ID],
      installedVersion: '1.0.0',
    })
    const restored = JSON.parse(await readFile(value.managedPath, 'utf8')) as ManagedTargetRecord
    expect(restored).toMatchObject({
      revision: 6,
      lastOperationId: OPERATION_ID,
      current: value.before!.current,
      pending: null,
    })
    const owner = JSON.parse(await readFile(value.sidecarPath, 'utf8')) as Record<string, unknown>
    expect(owner).toMatchObject({
      revision: 6,
      lastOperationId: OPERATION_ID,
      managed: restored,
      loaderEntryId: null,
      loaderName: null,
      restartPending: true,
    })
    expect(JSON.parse(await readFile(value.transactionPath, 'utf8'))).toMatchObject({
      status: 'committed',
      sourceManaged: expect.objectContaining({ revision: 5 }),
      sourceSidecar: expect.objectContaining({ revision: 5, packageName: EXTENSION_ID }),
    })
    expect(JSON.parse(await readFile(
      join(value.root, 'plugin', 'break-glass-restores', `${storageKey(OPERATION_ID)}.json`),
      'utf8',
    ))).toMatchObject({
      operationId: OPERATION_ID,
      targetKey: TARGET_KEY,
      providerSnapshotDigest: expect.stringMatching(/^sha256:/),
      beforeDigest: managedStateDigest(value.before),
      restoredManagedDigest: managedStateDigest(value.before),
      restoredRevision: 6,
      status: 'settled',
    })
    const invocations = (await readFile(value.officialCliLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as Array<{
      argv: string[]
      pnpmStore: string
    }>
    expect(invocations.at(-1)?.argv.slice(-2)).toEqual(['--store-dir', value.profileStore])
    expect(invocations.at(-1)?.pnpmStore).toBe(value.profileStore)
  }, 30_000)

  it('rejects corrupt and unsafe installed Profile store metadata before break-glass mutation', async () => {
    const corrupt = await fixture()
    const corruptMetadata = join(corrupt.profilePath, 'node_modules', '.modules.yaml')
    await writeFile(corruptMetadata, '{')

    const corruptResult = await runCli(corrupt)

    expect(corruptResult.exitCode).toBe(1)
    expect(corruptResult.stderr).toContain('modules metadata is invalid JSON')

    const unsafe = await fixture()
    const unsafeMetadata = join(unsafe.profilePath, 'node_modules', '.modules.yaml')
    await writeFile(unsafeMetadata, JSON.stringify({
      layoutVersion: 5,
      nodeLinker: 'hoisted',
      packageManager: 'pnpm@11.21.0',
      storeDir: 'relative/v11',
      virtualStoreDir: '.pnpm',
    }))

    const unsafeResult = await runCli(unsafe)

    expect(unsafeResult.exitCode).toBe(1)
    expect(unsafeResult.stderr).toContain('metadata storeDir is unsafe')
  }, 30_000)

  it('uses the provider-bound pre-mutation cache after a partial mutation changes the current lockfile', async () => {
    const value = await fixture()
    await writeFile(join(value.profilePath, 'pnpm-lock.yaml'), '{ partial-mutation: true }\n')

    await expect(runCli(value)).resolves.toMatchObject({ exitCode: 0, stderr: '' })
    await expect(profileState(value)).resolves.toMatchObject({ installedVersion: '1.0.0' })
  })

  it('rejects a tampered provider-bound cache before running recovery mutation', async () => {
    const value = await fixture()
    const snapshotPath = join(value.root, 'state', 'provider-snapshots', `${storageKey(OPERATION_ID)}.json`)
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      recoveryPoint: { metadataCache: { manifestPath: string } }
    }
    const beforeLog = await readFile(value.officialCliLog, 'utf8')
    await writeFile(
      snapshot.recoveryPoint.metadataCache.manifestPath,
      Buffer.concat([await readFile(snapshot.recoveryPoint.metadataCache.manifestPath), Buffer.from(' ')]),
    )

    const result = await runCli(value)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('metadata cache manifest digest changed')
    await expect(readFile(value.officialCliLog, 'utf8')).resolves.toEqual(beforeLog)
  })

  it('ignores an invoking-process DSH_HOME override and mutates only the bound Host home', async () => {
    const value = await fixture()
    const attackerHome = join(value.root, 'attacker-selected-home')
    await mkdir(attackerHome)

    await expect(runCli(value, value.root, { DSH_HOME: attackerHome })).resolves.toMatchObject({ exitCode: 0 })

    await expect(profileState(value)).resolves.toMatchObject({ bundles: [EXTENSION_ID], installedVersion: '1.0.0' })
    await expect(readFile(join(attackerHome, 'profiles', PROFILE_ID, 'package.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('accepts the strict rollback marker when standalone recovery reads a managed Plugin version', async () => {
    const value = await fixture()
    const source = JSON.parse(await readFile(value.managedPath, 'utf8')) as ManagedTargetRecord
    const current = source.current as ManagedVersion
    const marked = {
      ...source,
      current: {
        ...current,
        kindState: { ...(current.kindState as Record<string, unknown>), rollbackOperationId: OPERATION_ID },
      },
    } as ManagedTargetRecord
    await writeCanonical(value.managedPath, marked)
    await writeCanonical(value.sidecarPath, sidecar(marked))

    await expect(runCli(value)).resolves.toMatchObject({ exitCode: 0, stderr: '' })
  }, 30_000)

  it('replays a committed recovery without advancing the revision again', async () => {
    const value = await fixture()
    await expect(runCli(value)).resolves.toMatchObject({ exitCode: 0 })
    const firstManaged = await readFile(value.managedPath, 'utf8')
    const firstSidecar = await readFile(value.sidecarPath, 'utf8')
    const firstTransaction = await readFile(value.transactionPath, 'utf8')

    const replay = await runCli(value)

    expect(replay.exitCode).toBe(0)
    expect(await readFile(value.managedPath, 'utf8')).toBe(firstManaged)
    expect(await readFile(value.sidecarPath, 'utf8')).toBe(firstSidecar)
    expect(await readFile(value.transactionPath, 'utf8')).toBe(firstTransaction)
    await expect(profileState(value)).resolves.toMatchObject({ bundles: [EXTENSION_ID], installedVersion: '1.0.0' })
  }, 30_000)

  it('finishes a prepared transaction after only the owner sidecar reached restored state', async () => {
    const value = await fixture()
    await expect(runCli(value)).resolves.toMatchObject({ exitCode: 0 })
    const transaction = JSON.parse(await readFile(value.transactionPath, 'utf8')) as Record<string, unknown>
    transaction.status = 'prepared'
    transaction.committedAtMs = null
    await writeCanonical(value.transactionPath, transaction)
    await writeCanonical(value.managedPath, transaction.sourceManaged)

    const replay = await runCli(value)

    expect(replay.exitCode).toBe(0)
    expect(JSON.parse(await readFile(value.managedPath, 'utf8'))).toEqual(transaction.restoredManaged)
    expect(JSON.parse(await readFile(value.transactionPath, 'utf8'))).toMatchObject({ status: 'committed' })
  }, 30_000)

  it('removes the official dependency, bundle, installed target, and Center records when before-state was absent', async () => {
    const value = await fixture({ absentBefore: true })

    await expect(runCli(value)).resolves.toMatchObject({ exitCode: 0 })

    await expect(profileState(value)).resolves.toEqual({ dependency: undefined, bundles: [], installedVersion: null })
    await expect(readFile(value.managedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(value.sidecarPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(value.transactionPath, 'utf8'))).toMatchObject({
      status: 'committed',
      sourceManaged: expect.objectContaining({ revision: 1 }),
      sourceSidecar: expect.objectContaining({ revision: 1 }),
      restoredManaged: null,
      restoredSidecar: null,
    })
    expect(JSON.parse(await readFile(
      join(value.root, 'plugin', 'absent-rollbacks', `${storageKey(OPERATION_ID)}.json`),
      'utf8',
    ))).toMatchObject({
      operationId: OPERATION_ID,
      targetKey: TARGET_KEY,
      sourceRevision: 1,
      restartRequired: true,
      status: 'settled',
    })
    await expect(runCli(value)).resolves.toMatchObject({ exitCode: 0 })
  }, 30_000)

  it('rejects a changed dependency spec and duplicate bundle membership after commit', async () => {
    const dependency = await fixture()
    await expect(runCli(dependency)).resolves.toMatchObject({ exitCode: 0 })
    const dependencyManifestPath = join(dependency.profilePath, 'package.json')
    const dependencyManifest = JSON.parse(await readFile(dependencyManifestPath, 'utf8')) as {
      dependencies: Record<string, string>
    }
    dependencyManifest.dependencies[EXTENSION_ID] = 'file:/attacker/replacement.tgz'
    await writeFile(dependencyManifestPath, `${JSON.stringify(dependencyManifest)}\n`)
    const dependencyReplay = await runCli(dependency)
    expect(dependencyReplay.exitCode).toBe(1)
    expect(dependencyReplay.stderr).toContain('Profile diverged from the committed recovery transaction')

    const duplicate = await fixture()
    await expect(runCli(duplicate)).resolves.toMatchObject({ exitCode: 0 })
    const duplicateManifestPath = join(duplicate.profilePath, 'package.json')
    const duplicateManifest = JSON.parse(await readFile(duplicateManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    duplicateManifest.dsh.profile.bundles.push(EXTENSION_ID)
    await writeFile(duplicateManifestPath, `${JSON.stringify(duplicateManifest)}\n`)
    const duplicateReplay = await runCli(duplicate)
    expect(duplicateReplay.exitCode).toBe(1)
    expect(duplicateReplay.stderr).toContain('Profile diverged from the committed recovery transaction')
  }, 30_000)

  it('reclaims a dead shared Profile lease before restoring', async () => {
    const value = await fixture()
    const lease = join(
      value.hostHome,
      '.extension-center-plugin-coordination',
      'leases',
      storageKey(PROFILE_ID),
    )
    const currentIdentity = await captureCurrentProcessIdentity()
    const owner = {
      schemaVersion: 2,
      profileId: PROFILE_ID,
      ownerId: 'break-glass:dead-owner',
      leaseId: `lease:${randomUUID()}`,
      processIdentity: {
        ...currentIdentity,
        pid: 2_147_483_647,
        birthDigest: `sha256:${'0'.repeat(64)}`,
      },
      acquiredAtMs: 1,
    }
    const execution = {
      schemaVersion: 1,
      profileId: PROFILE_ID,
      ownerId: owner.ownerId,
      parentPid: owner.processIdentity.pid,
      processGroupPid: 2_147_483_646,
      supervisorSha256: `sha256:${'1'.repeat(64)}`,
      startedAtMs: 2,
    }
    await writeCanonical(join(lease, 'owner.json'), owner)
    await writeCanonical(join(lease, 'execution.json'), execution)
    await writeCanonical(join(lease, 'execution-dispatch.json'), {
      schemaVersion: 1,
      profileId: PROFILE_ID,
      ownerId: owner.ownerId,
      leaseId: owner.leaseId,
      processGroupPid: execution.processGroupPid,
      executionDigest: canonicalSha256(execution),
      dispatchedAtMs: 3,
    })

    await expect(runCli(value)).resolves.toMatchObject({ exitCode: 0, stderr: '' })
    await expect(profileState(value)).resolves.toMatchObject({ installedVersion: '1.0.0' })
  })

  it('clears a same-group descendant after the standalone official CLI exits successfully', async () => {
    const value = await fixture({ orphaningCli: true })
    if (value.orphanPids === null) throw new Error('orphaning CLI fixture has no pid record')

    const result = await runCli(value)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('exact recovery before-state')
    const pids = JSON.parse(await readFile(value.orphanPids, 'utf8')) as number[]
    spawnedPids.push(...pids)
    await Promise.all(pids.map(expectProcessAbsent))
  }, 30_000)

  it('rejects an orphan execution dispatch without deleting the shared Profile lease', async () => {
    const value = await fixture()
    const lease = join(
      value.hostHome,
      '.extension-center-plugin-coordination',
      'leases',
      storageKey(PROFILE_ID),
    )
    const currentIdentity = await captureCurrentProcessIdentity()
    const owner = {
      schemaVersion: 2,
      profileId: PROFILE_ID,
      ownerId: 'break-glass:orphan-dispatch',
      leaseId: `lease:${randomUUID()}`,
      processIdentity: {
        ...currentIdentity,
        pid: 2_147_483_647,
        birthDigest: `sha256:${'0'.repeat(64)}`,
      },
      acquiredAtMs: 1,
    }
    await writeCanonical(join(lease, 'owner.json'), owner)
    await writeCanonical(join(lease, 'execution-dispatch.json'), {
      schemaVersion: 1,
      profileId: PROFILE_ID,
      ownerId: owner.ownerId,
      leaseId: owner.leaseId,
      processGroupPid: 2_147_483_646,
      executionDigest: `sha256:${'1'.repeat(64)}`,
      dispatchedAtMs: 2,
    })

    const result = await runCli(value)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('execution dispatch has no execution lease')
    await expect(readFile(join(lease, 'owner.json'), 'utf8')).resolves.toContain(owner.ownerId)
  })

  it('continues a dead break-glass claimant from a retired takeover gate and exact quarantine', async () => {
    const value = await fixture()
    const coordination = join(value.hostHome, '.extension-center-plugin-coordination')
    const key = storageKey(PROFILE_ID)
    const quarantineId = `quarantine:${randomUUID()}`
    const leaseId = `lease:${randomUUID()}`
    const currentIdentity = await captureCurrentProcessIdentity()
    const owner = {
      schemaVersion: 2,
      profileId: PROFILE_ID,
      ownerId: 'break-glass:dead-claimant',
      leaseId,
      processIdentity: {
        ...currentIdentity,
        pid: 2_147_483_647,
        birthDigest: `sha256:${'0'.repeat(64)}`,
      },
      acquiredAtMs: 1,
    }
    const quarantineRoot = join(coordination, 'lease-quarantine', key)
    const quarantine = join(quarantineRoot, quarantineId.slice('quarantine:'.length))
    const takeoverRoot = join(coordination, 'lease-takeovers')
    const retired = join(takeoverRoot, `.retired-${randomUUID()}`)
    await writeCanonical(join(quarantine, 'owner.json'), owner)
    await writeCanonical(join(retired, 'record.json'), {
      schemaVersion: 1,
      profileId: PROFILE_ID,
      sourceLeaseId: leaseId,
      sourceOwnerDigest: canonicalSha256(owner),
      quarantineId,
      takeoverId: `takeover:${randomUUID()}`,
      claimantOwnerId: owner.ownerId,
      claimantProcessIdentity: owner.processIdentity,
      claimedAtMs: 1,
    })

    await expect(runCli(value)).resolves.toMatchObject({ exitCode: 0, stderr: '' })

    await expect(readdir(takeoverRoot)).resolves.toEqual([])
    await expect(readdir(quarantineRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(coordination, 'leases'))).resolves.toEqual([])
  }, 30_000)

  it('fails closed without removing a lease whose process may still own a live subtree', async () => {
    const value = await fixture()
    const ownerPath = join(
      value.hostHome,
      '.extension-center-plugin-coordination',
      'leases',
      storageKey(PROFILE_ID),
      'owner.json',
    )
    await writeCanonical(ownerPath, {
      schemaVersion: 2,
      profileId: PROFILE_ID,
      ownerId: 'break-glass:live-owner',
      leaseId: `lease:${randomUUID()}`,
      processIdentity: await captureCurrentProcessIdentity(),
      acquiredAtMs: 1,
    })

    const result = await runCli(value)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('profile is busy')
    await expect(readFile(ownerPath, 'utf8')).resolves.toContain('break-glass:live-owner')
  })

  it('clears only an exact operation-bound ambiguity quarantine after settled recovery', async () => {
    const value = await fixture()
    const quarantine = join(
      value.hostHome,
      '.extension-center-plugin-coordination',
      'quarantine',
      `${storageKey(PROFILE_ID)}.json`,
    )
    await writeCanonical(quarantine, {
      schemaVersion: 1,
      profileId: PROFILE_ID,
      packageName: EXTENSION_ID,
      operationId: OPERATION_ID,
      targetKey: TARGET_KEY,
      centerRoot: value.root,
      beforeDigest: canonicalSha256({ before: 1 }),
      afterDigest: canonicalSha256({ after: 1 }),
      reason: 'interrupted official Profile observation',
      createdAtMs: 1,
    })
    await expect(runCli(value)).resolves.toMatchObject({ exitCode: 0 })
    await expect(readFile(quarantine, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const mismatch = await fixture()
    const mismatchedPath = join(
      mismatch.hostHome,
      '.extension-center-plugin-coordination',
      'quarantine',
      `${storageKey(PROFILE_ID)}.json`,
    )
    await writeCanonical(mismatchedPath, {
      schemaVersion: 1,
      profileId: PROFILE_ID,
      packageName: EXTENSION_ID,
      operationId: 'operation:foreign',
      targetKey: TARGET_KEY,
      centerRoot: mismatch.root,
      beforeDigest: canonicalSha256({ before: 1 }),
      afterDigest: canonicalSha256({ after: 1 }),
      reason: 'foreign operation',
      createdAtMs: 1,
    })
    const result = await runCli(mismatch)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('quarantine does not bind this recovery operation')
    await expect(readFile(mismatchedPath, 'utf8')).resolves.toContain('operation:foreign')
  }, 30_000)

  it('fails closed when the bound official CLI entrypoint or package tree changes', async () => {
    const entrypoint = await fixture()
    await chmod(entrypoint.dshEntrypoint, 0o700)
    await writeFile(entrypoint.dshEntrypoint, `${await readFile(entrypoint.dshEntrypoint, 'utf8')}\n// tampered\n`, { mode: 0o500 })
    const entrypointResult = await runCli(entrypoint)
    expect(entrypointResult.exitCode).toBe(1)
    expect(entrypointResult.stderr).toContain('official DSH recovery entrypoint hash does not match its pin')

    const tree = await fixture()
    await writeFile(join(tree.dshPackageRoot, 'injected.js'), 'export default true\n')
    const treeResult = await runCli(tree)
    expect(treeResult.exitCode).toBe(1)
    expect(treeResult.stderr).toContain('official DSH recovery package tree does not match its pin')
  }, 30_000)

  it('fails closed on executable pin, journal chain, and CURRENT tampering', async () => {
    const executable = await fixture()
    await chmod(executable.cliPath, 0o700)
    await writeFile(executable.cliPath, `${await readFile(executable.cliPath, 'utf8')}\n// tampered\n`, { mode: 0o500 })
    const pinResult = await runCli(executable)
    expect(pinResult.exitCode).toBe(1)
    expect(pinResult.stderr).toContain('recovery executable hash does not match its pin')

    const chain = await fixture()
    const second = (await readdir(chain.operationDirectory)).find(name => name.startsWith('0000000002-'))!
    const secondPath = join(chain.operationDirectory, second)
    const event = JSON.parse(await readFile(secondPath, 'utf8')) as Record<string, unknown>
    ;(event.entry as Record<string, unknown>).to = 'failed'
    await writeCanonical(secondPath, event)
    const chainResult = await runCli(chain)
    expect(chainResult.exitCode).toBe(1)
    expect(chainResult.stderr).toContain('digest does not match its content')

    const pointer = await fixture()
    const pointerPath = join(pointer.operationDirectory, 'CURRENT.json')
    const current = JSON.parse(await readFile(pointerPath, 'utf8')) as Record<string, unknown>
    current.headDigest = canonicalSha256({ attacker: true })
    await writeCanonical(pointerPath, current)
    const pointerResult = await runCli(pointer)
    expect(pointerResult.exitCode).toBe(1)
    expect(pointerResult.stderr).toContain('headDigest does not match')
  }, 30_000)

  it('rejects current-state drift before recovery and after a committed replay', async () => {
    const before = await fixture()
    const managedValue = JSON.parse(await readFile(before.managedPath, 'utf8')) as Record<string, unknown>
    managedValue.lastOperationId = 'operation:attacker'
    await writeCanonical(before.managedPath, managedValue)
    const beforeResult = await runCli(before)
    expect(beforeResult.exitCode).toBe(1)
    expect(beforeResult.stderr).toContain('state and owner sidecar diverged')

    const after = await fixture()
    await expect(runCli(after)).resolves.toMatchObject({ exitCode: 0 })
    const restored = JSON.parse(await readFile(after.managedPath, 'utf8')) as Record<string, unknown>
    restored.updatedAtMs = (restored.updatedAtMs as number) + 1
    await writeCanonical(after.managedPath, restored)
    const replay = await runCli(after)
    expect(replay.exitCode).toBe(1)
    expect(replay.stderr).toContain('diverged from the committed recovery transaction')
  }, 30_000)

  it('rejects retained artifact drift and committed Profile tree drift', async () => {
    const artifact = await fixture()
    const source = JSON.parse(await readFile(artifact.managedPath, 'utf8')) as ManagedTargetRecord
    const sourceMarkerPath = `${source.current!.materialPath}.owner.json`
    const sourceMarker = JSON.parse(await readFile(sourceMarkerPath, 'utf8')) as { artifactPath: string }
    await writeFile(sourceMarker.artifactPath, 'tampered retained archive\n')
    const artifactResult = await runCli(artifact)
    expect(artifactResult.exitCode).toBe(1)
    expect(artifactResult.stderr).toContain('retained artifact')

    const profile = await fixture()
    await expect(runCli(profile)).resolves.toMatchObject({ exitCode: 0 })
    await writeFile(join(profile.profilePath, 'node_modules', EXTENSION_ID, 'cordis.yml'), 'tampered runtime\n')
    const profileResult = await runCli(profile)
    expect(profileResult.exitCode).toBe(1)
    expect(profileResult.stderr).toContain('Profile diverged from the committed recovery transaction')
  }, 30_000)

  it('rejects a non-Center Plugin owner and a non-canonical root', async () => {
    const wrongOwner = await fixture({ ownerKey: 'profileTransactions' })
    const ownerResult = await runCli(wrongOwner)
    expect(ownerResult.exitCode).toBe(1)
    expect(ownerResult.stderr).toContain('Center-owned managedPlugins')

    const wrongRoot = await fixture()
    const nonCanonical = `${wrongRoot.root}/../${basename(wrongRoot.root)}`
    const rootResult = await runCli(wrongRoot, nonCanonical)
    expect(rootResult.exitCode).toBe(1)
    expect(rootResult.stderr).toContain('canonical absolute path')
  })

  it('rejects recovery roots overlapping official Profile or package state before creating recovery files', async () => {
    const cliRoot = await realpath(await mkdtemp(join(tmpdir(), 'extension-break-glass-cli-')))
    const officialRoot = await realpath(await mkdtemp(join(tmpdir(), 'extension-break-glass-overlap-')))
    roots.push(cliRoot, officialRoot)
    const official = await createOfficialDshFixture(officialRoot)
    const cliPath = await compileStandaloneCli(cliRoot)
    const supervisorPath = await compileStandaloneSupervisor(cliRoot)
    const profileRoot = join(official.hostHome, 'profiles', PROFILE_ID, 'extension-center')
    await mkdir(profileRoot, { recursive: true })
    for (const root of [official.hostHome, profileRoot, official.packageRoot]) {
      await expect(installRecoveryExecutable({
        root,
        packageVersion: '1.0.0',
        cliPath,
        supervisorPath,
        officialDsh: {
          entrypointPath: official.entrypointPath,
          hostHome: official.hostHome,
          timeoutMs: 10_000,
        },
      })).rejects.toThrow('overlaps official DSH Profile or package state')
      await expect(readFile(join(root, 'recovery', '1.0.0', `${process.platform}-${process.arch}`, 'break-glass.mjs')))
        .rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})
