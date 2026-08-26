import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { installRecoveryExecutable } from '../src/recovery/install.ts'
import {
  createOperationJournal,
  transitionOperation,
  type OperationAuthorization,
  type OperationJournal,
} from '../src/operations/index.ts'
import { FileOperationStore } from '../src/storage/operation-store.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const roots: string[] = []
const OPERATION_ID = 'operation:break-glass:plugin:1'
const RECOVERY_MUTATION_ID = `extension-center-recovery-${createHash('sha256').update(OPERATION_ID).digest('hex')}`
const TARGET_KEY = 'plugin:web:profile:web:dsh-example'
const CANDIDATE_GENERATION = '11111111-1111-4111-8111-111111111111'
const RECOVERY_GENERATION = '22222222-2222-4222-8222-222222222222'

type HostBehavior = 'restore' | 'noop-restore' | 'old-rc2' | 'lost-restore-output' | 'lost-restore-output-before-ack'

interface JsonRecord {
  readonly [key: string]: unknown
}

interface JournalFixture {
  readonly root: string
  readonly hostHome: string
  readonly ambientHostHome: string
  readonly cliPath: string
  readonly hostCliPath: string
  readonly callsPath: string
  readonly statePath: string
  readonly operationDirectory: string
  readonly planEvidence: JsonRecord
  readonly beforeDigest: string
  readonly events: JsonRecord[]
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function jsonDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function bytesDigest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function event(
  sequence: number,
  previousDigest: string | null,
  entry: JsonRecord,
  atMs = 1_000 + sequence,
): JsonRecord {
  const unsigned = {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    targetKey: TARGET_KEY,
    sequence,
    previousDigest,
    atMs,
    entry,
  }
  return { ...unsigned, digest: jsonDigest(unsigned) }
}

function phase(from: string, to: string, reason: string | null = null, evidenceDigest: string | null = null): JsonRecord {
  return { type: 'phase-transition', from, to, evidenceDigest, reason }
}

function summary(generation: string, treeDigest: string): JsonRecord {
  return { generation, treeDigest, mutationId: null, mutation: null }
}

async function compileStandaloneCli(root: string): Promise<Readonly<{ path: string; source: string }>> {
  const source = await readFile(join(process.cwd(), 'src', 'recovery', 'break-glass.ts'), 'utf8')
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1])
  expect(imports.length).toBeGreaterThan(0)
  expect(imports.every(specifier => specifier?.startsWith('node:'))).toBe(true)
  expect(source).not.toContain("from '../index")
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
    reportDiagnostics: true,
    fileName: 'break-glass.ts',
  })
  const errors = transpiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  expect(errors).toEqual([])
  const path = join(root, 'break-glass.mjs')
  await writeFile(path, transpiled.outputText, { mode: 0o600 })
  return { path: await realpath(path), source }
}

async function writeHostCli(root: string, hostHome: string, behavior: HostBehavior): Promise<Readonly<{
  path: string
  callsPath: string
  statePath: string
}>> {
  const path = join(root, 'host-cli.mjs')
  const statePath = join(hostHome, 'host-inventory.json')
  const callsPath = join(hostHome, 'host-calls.json')
  const candidateDigest = jsonDigest({ generation: CANDIDATE_GENERATION })
  const recoveryDigest = jsonDigest({ generation: RECOVERY_GENERATION })
  const restoreFromRollback = behavior === 'lost-restore-output-before-ack'
  await writeFile(statePath, `${JSON.stringify({
    snapshot: {
      profile: 'web',
      revision: 7,
      treeDigest: candidateDigest,
      effectivePath: join(hostHome, 'profiles', CANDIDATE_GENERATION),
      activeGeneration: CANDIDATE_GENERATION,
      lastGoodGeneration: restoreFromRollback ? CANDIDATE_GENERATION : RECOVERY_GENERATION,
      rollbackGeneration: restoreFromRollback ? RECOVERY_GENERATION : null,
      bootStatus: restoreFromRollback ? 'verified' : 'pending-restart',
    },
    active: summary(CANDIDATE_GENERATION, candidateDigest),
    staged: [],
    recoverable: [summary(RECOVERY_GENERATION, recoveryDigest)],
  }, null, 2)}\n`)
  await writeFile(path, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.DSH_HOME
if (root === undefined || root.length === 0) throw new Error('DSH_HOME is required')
const statePath = join(root, 'host-inventory.json')
const callsPath = join(root, 'host-calls.json')
const receiptPath = join(root, 'host-restore-receipt.json')
const args = process.argv.slice(2)
const prior = existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, 'utf8')) : []
prior.push(args)
writeFileSync(callsPath, JSON.stringify(prior))
if ((args.length !== 4 && args.length !== 6) || args[0] !== 'plugin' || args[1] !== '--profile' || args[2] !== 'web') {
  process.stderr.write('unsupported rc2 invocation\\n')
  process.exitCode = 2
} else if (args[3] === 'restore-receipt') {
  if (${JSON.stringify(behavior)} === 'old-rc2') {
    process.stderr.write('unsupported rc2 operation\\n')
    process.exitCode = 2
  } else if (args.length !== 6 || args[4] !== '--mutation-id' || args[5] !== ${JSON.stringify(RECOVERY_MUTATION_ID)}) {
    process.stderr.write('missing exact restore receipt mutation id\\n')
    process.exitCode = 2
  } else {
    const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null
    process.stdout.write(JSON.stringify({
      profile: 'web',
      mutationId: args[5],
      status: receipt === null ? 'not-found' : 'committed',
      receipt,
    }, null, 2) + '\\n')
  }
} else if (args[3] === 'list') {
  if (${JSON.stringify(behavior)} === 'old-rc2') {
    process.stdout.write('Legend: production dependency, optional only, dev only\\n')
  } else {
    process.stdout.write(JSON.stringify(JSON.parse(readFileSync(statePath, 'utf8')), null, 2) + '\\n')
  }
} else if (args[3] === 'restore') {
  if (args.length !== 6 || args[4] !== '--mutation-id' || args[5] !== ${JSON.stringify(RECOVERY_MUTATION_ID)}) {
    process.stderr.write('missing exact restore mutation id\\n')
    process.exitCode = 2
  } else {
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const targetGeneration = state.snapshot.activeGeneration !== state.snapshot.lastGoodGeneration
    ? state.snapshot.lastGoodGeneration
    : state.snapshot.rollbackGeneration
  const target = state.recoverable.find(item => item.generation === targetGeneration)
  if (target === undefined) {
    process.stderr.write('no recovery target\\n')
    process.exitCode = 2
  } else {
    if (${JSON.stringify(behavior)} === 'restore' || ${JSON.stringify(behavior)} === 'lost-restore-output'
      || ${JSON.stringify(behavior)} === 'lost-restore-output-before-ack') {
      const before = structuredClone(state.snapshot)
      const priorActive = state.active
      state.snapshot.revision += 1
      state.snapshot.activeGeneration = target.generation
      state.snapshot.treeDigest = target.treeDigest
      state.snapshot.effectivePath = join(root, 'profiles', target.generation)
      state.snapshot.bootStatus = target.generation === state.snapshot.lastGoodGeneration ? 'verified' : 'pending-restart'
      state.active = target
      state.staged = [...state.staged, priorActive]
      state.recoverable = []
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n')
      writeFileSync(receiptPath, JSON.stringify({
        mutationId: args[5],
        status: 'committed',
        operation: 'restore',
        before,
        after: state.snapshot,
        restartRequired: true,
      }, null, 2) + '\\n')
      if (${JSON.stringify(behavior)} === 'lost-restore-output'
        || ${JSON.stringify(behavior)} === 'lost-restore-output-before-ack') process.kill(process.pid, 'SIGKILL')
    }
    process.stdout.write('dsh: restored generation ' + target.generation + '; restart required\\n')
  }
  }
} else {
  process.stderr.write('unsupported rc2 operation\\n')
  process.exitCode = 2
}
`, { mode: 0o600 })
  return { path: await realpath(path), callsPath, statePath }
}

function evidence(root: string, recoveryExecutable: JsonRecord): JsonRecord {
  return {
    origin: 'store',
    candidateRef: 'store:dsh-example@2.0.0',
    extensionKind: 'plugin',
    extensionId: 'dsh-example',
    artifactRevision: '2.0.0',
    artifactIntegrity: jsonDigest({ artifact: 2 }),
    artifactUrl: 'https://example.invalid/dsh-example-2.0.0.tgz',
    artifactSizeBytes: 100,
    desiredState: 'enabled',
    ownerKey: 'profileTransactions',
    scopeKey: 'profile:web',
    profileId: 'web',
    idempotencyKey: 'break-glass-idempotency',
    authorityDigest: jsonDigest({ root, authority: true }),
    configurationDigest: jsonDigest({ root, configuration: true }),
    retentionDigest: jsonDigest({ root, retention: true }),
    reviewEvidence: testReviewEvidence('plugin', 'update', {
      generation: RECOVERY_GENERATION,
      treeDigest: jsonDigest({ generation: RECOVERY_GENERATION }),
    }),
    mutationDigest: jsonDigest({ root, mutation: true }),
    verificationDigest: jsonDigest({ root, verification: true }),
    restartRequired: true,
    fences: {
      catalogRevision: 1,
      inventoryRevision: jsonDigest({ root, inventory: true }),
      targetRevision: 'plugin:1',
      ownerRevision: 'profile:7:tree',
      scopeRevision: 'profile:web:7',
      profileRevision: 'profile:7:tree',
    },
    recoveryExecutable,
  }
}

function authorization(planEvidence: JsonRecord): OperationAuthorization {
  return {
    operationId: OPERATION_ID,
    planId: 'plan:break-glass:1',
    planHash: jsonDigest({ plan: 1 }),
    origin: planEvidence.origin as 'store',
    candidateRef: planEvidence.candidateRef as string,
    extensionKind: 'plugin',
    extensionId: planEvidence.extensionId as string,
    operationKind: 'update',
    managedObject: 'artifact',
    externalRuntimeAction: 'download',
    runtimeBinding: null,
    artifactRevision: planEvidence.artifactRevision as string,
    artifactIntegrity: planEvidence.artifactIntegrity as `sha256:${string}`,
    artifactUrl: planEvidence.artifactUrl as string,
    artifactSizeBytes: planEvidence.artifactSizeBytes as number,
    desiredState: 'enabled',
    targetKey: TARGET_KEY,
    ownerKey: 'profileTransactions',
    scopeKey: 'profile:web',
    profileId: 'web',
    idempotencyKey: planEvidence.idempotencyKey as string,
    authorityDigest: planEvidence.authorityDigest as `sha256:${string}`,
    configurationDigest: planEvidence.configurationDigest as `sha256:${string}`,
    retentionDigest: planEvidence.retentionDigest as `sha256:${string}`,
    mutationDigest: planEvidence.mutationDigest as `sha256:${string}`,
    verificationDigest: planEvidence.verificationDigest as `sha256:${string}`,
    reviewEvidence: planEvidence.reviewEvidence as OperationAuthorization['reviewEvidence'],
    restartRequired: true,
    fences: planEvidence.fences as OperationAuthorization['fences'],
    recoveryExecutable: planEvidence.recoveryExecutable as OperationAuthorization['recoveryExecutable'],
    authorizedAtMs: 1_000,
  }
}

async function persistJournal(root: string, events: readonly JsonRecord[]): Promise<string> {
  const operationDirectory = join(root, 'operations', createHash('sha256').update(OPERATION_ID).digest('hex'))
  await mkdir(operationDirectory, { recursive: true, mode: 0o700 })
  for (const value of events) {
    const sequence = value.sequence as number
    const digest = value.digest as string
    const filename = `${String(sequence).padStart(10, '0')}-${digest.slice('sha256:'.length)}.json`
    await writeFile(join(operationDirectory, filename), `${canonicalJson(value)}\n`, { mode: 0o600 })
  }
  const head = events.at(-1)!
  await writeFile(join(operationDirectory, 'CURRENT.json'), `${canonicalJson({
    schemaVersion: 1,
    operationId: OPERATION_ID,
    targetKey: TARGET_KEY,
    eventCount: events.length,
    headDigest: head.digest,
  })}\n`, { mode: 0o600 })
  return operationDirectory
}

async function fixture(behavior: HostBehavior = 'restore'): Promise<JournalFixture> {
  const created = await mkdtemp(join(tmpdir(), 'extension-break-glass-'))
  const root = await realpath(created)
  roots.push(root)
  const hostHomePath = join(root, 'host-home')
  const ambientHostHomePath = join(root, 'wrong-ambient-host-home')
  await mkdir(hostHomePath, { mode: 0o700 })
  await mkdir(ambientHostHomePath, { mode: 0o700 })
  const hostHome = await realpath(hostHomePath)
  const ambientHostHome = await realpath(ambientHostHomePath)
  const cli = await compileStandaloneCli(root)
  const host = await writeHostCli(root, hostHome, behavior)
  const recoveryExecutable = await installRecoveryExecutable({
    root,
    hostHome,
    packageVersion: '1.0.0',
    cliPath: cli.path,
    hostCliPath: host.path,
  })
  const planEvidence = evidence(root, recoveryExecutable as unknown as JsonRecord)
  const beforeDigest = jsonDigest({ before: CANDIDATE_GENERATION })
  const store = new FileOperationStore(root)
  let journal: OperationJournal = createOperationJournal(authorization(planEvidence), beforeDigest, 1_001)
  await store.persist(journal)
  for (const [to, reason] of [
    ['staging', null],
    ['applying', null],
    ['rolling-back', null],
    ['recovery-required', 'rollback-failed'],
  ] as const) {
    journal = transitionOperation(journal, to, null, reason, journal.events.length + 1_001)
    await store.persist(journal)
  }
  const events = journal.events as unknown as JsonRecord[]
  const operationDirectory = join(root, 'operations', createHash('sha256').update(OPERATION_ID).digest('hex'))
  return {
    root,
    hostHome,
    ambientHostHome,
    cliPath: recoveryExecutable.executablePath,
    hostCliPath: host.path,
    callsPath: host.callsPath,
    statePath: host.statePath,
    operationDirectory,
    planEvidence,
    beforeDigest,
    events,
  }
}

function runCli(value: JournalFixture): Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [value.cliPath, value.root, OPERATION_ID], {
      env: { ...process.env, DSH_HOME: value.ambientHostHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === null || signal !== null) {
        reject(new Error('break-glass CLI did not exit normally'))
        return
      }
      resolvePromise({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code,
      })
    })
  })
}

async function rewritePointer(value: JournalFixture, patch: (pointer: Record<string, unknown>) => void): Promise<void> {
  const path = join(value.operationDirectory, 'CURRENT.json')
  const pointer = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  patch(pointer)
  await writeFile(path, `${canonicalJson(pointer)}\n`)
}

describe('standalone Host break-glass recovery', () => {
  it('verifies pinned journal and executables, restores through the exact Host owner, and leaves reconciliation pending', async () => {
    const value = await fixture()

    const result = await runCli(value)

    expect(result).toEqual({
      stdout: 'profile restored; Center journal reconciliation pending\n',
      stderr: '',
      exitCode: 0,
    })
    expect(JSON.parse(await readFile(value.callsPath, 'utf8'))).toEqual([
      ['plugin', '--profile', 'web', 'restore-receipt', '--mutation-id', RECOVERY_MUTATION_ID],
      ['plugin', '--profile', 'web', 'list'],
      ['plugin', '--profile', 'web', 'restore', '--mutation-id', RECOVERY_MUTATION_ID],
      ['plugin', '--profile', 'web', 'list'],
    ])
    await expect(readFile(join(value.ambientHostHome, 'host-calls.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a non-canonical pinned Host home before invoking either ambient or pinned Host state', async () => {
    const value = await fixture()
    const opened = value.events[0]!
    const openedEntry = structuredClone(opened.entry) as Record<string, unknown>
    const planEvidence = openedEntry.planEvidence as Record<string, unknown>
    ;(planEvidence.recoveryExecutable as Record<string, unknown>).hostHome = `${value.hostHome}/../host-home`
    const rebuilt = [event(1, null, openedEntry)]
    for (const prior of value.events.slice(1)) {
      rebuilt.push(event(rebuilt.length + 1, rebuilt.at(-1)!.digest as string, prior.entry as JsonRecord))
    }
    await rm(value.operationDirectory, { recursive: true })
    await persistJournal(value.root, rebuilt)

    const result = await runCli(value)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Host home path is not its canonical real directory')
    await expect(readFile(value.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(value.ambientHostHome, 'host-calls.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed on a changed event chain or CURRENT head before invoking the Host CLI', async () => {
    const changedEvent = await fixture()
    const second = (await readdir(changedEvent.operationDirectory)).find(name => name.startsWith('0000000002-'))!
    const secondPath = join(changedEvent.operationDirectory, second)
    const record = JSON.parse(await readFile(secondPath, 'utf8')) as Record<string, unknown>
    ;(record.entry as Record<string, unknown>).to = 'failed'
    await writeFile(secondPath, `${canonicalJson(record)}\n`)

    const eventResult = await runCli(changedEvent)
    expect(eventResult.exitCode).toBe(1)
    expect(eventResult.stdout).toBe('')
    expect(eventResult.stderr).toContain('digest does not match its content')
    await expect(readFile(changedEvent.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const changedPointer = await fixture()
    await rewritePointer(changedPointer, pointer => { pointer.headDigest = jsonDigest({ attacker: true }) })
    const pointerResult = await runCli(changedPointer)
    expect(pointerResult.exitCode).toBe(1)
    expect(pointerResult.stderr).toContain('headDigest does not match')
    await expect(readFile(changedPointer.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a fully rehashed backward clock or non-terminal evidence before invoking the Host CLI', async () => {
    const backwardClock = await fixture()
    const rebuiltTime: JsonRecord[] = []
    for (const [index, prior] of backwardClock.events.entries()) {
      rebuiltTime.push(event(
        index + 1,
        index === 0 ? null : rebuiltTime.at(-1)!.digest as string,
        structuredClone(prior.entry) as JsonRecord,
        index === 2 ? 1_000 : prior.atMs as number,
      ))
    }
    await rm(backwardClock.operationDirectory, { recursive: true })
    await persistJournal(backwardClock.root, rebuiltTime)

    const backwardResult = await runCli(backwardClock)
    expect(backwardResult.exitCode).toBe(1)
    expect(backwardResult.stderr).toContain('journal time moved backwards')
    await expect(readFile(backwardClock.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const nonTerminalEvidence = await fixture()
    const rebuiltEvidence: JsonRecord[] = []
    for (const [index, prior] of nonTerminalEvidence.events.entries()) {
      const entry = structuredClone(prior.entry) as Record<string, unknown>
      if (index === 1) entry.evidenceDigest = jsonDigest({ forged: 'non-terminal' })
      rebuiltEvidence.push(event(
        index + 1,
        index === 0 ? null : rebuiltEvidence.at(-1)!.digest as string,
        entry,
        prior.atMs as number,
      ))
    }
    await rm(nonTerminalEvidence.operationDirectory, { recursive: true })
    await persistJournal(nonTerminalEvidence.root, rebuiltEvidence)

    const evidenceResult = await runCli(nonTerminalEvidence)
    expect(evidenceResult.exitCode).toBe(1)
    expect(evidenceResult.stderr).toContain('non-terminal journal transitions cannot publish final evidence')
    await expect(readFile(nonTerminalEvidence.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('verifies a present receipt digest before refusing a non-recovery journal', async () => {
    const value = await fixture()
    const opened = value.events[0]!
    const failed = event(2, opened.digest as string, phase('authorized', 'failed', 'owner-failed', value.beforeDigest))
    const body = {
      schemaVersion: 1,
      operationId: OPERATION_ID,
      planId: 'plan:break-glass:1',
      planHash: jsonDigest({ plan: 1 }),
      operationKind: 'update',
      managedObject: 'artifact',
      externalRuntimeAction: 'download',
      runtimeBinding: null,
      planEvidence: value.planEvidence,
      targetKey: TARGET_KEY,
      outcome: 'failed',
      beforeDigest: value.beforeDigest,
      afterDigest: value.beforeDigest,
      mutationDigests: [],
      verificationDigests: [],
      evidence: {
        checksActuallyRun: (value.planEvidence.reviewEvidence as { checks: unknown }).checks,
        mutation: 'not-required',
        verification: 'not-required',
        rollback: { attempted: false, status: 'not-required' },
        restart: { required: false, status: 'not-required' },
        recovery: { attempts: 0, status: 'not-required' },
        notProven: [],
      },
      journalEventCount: 2,
      journalHeadDigest: failed.digest,
      issuedAtMs: 1_003,
    }
    const receipt = event(3, failed.digest as string, {
      type: 'receipt-issued',
      receipt: { body, digest: jsonDigest({ wrong: true }) },
    })
    await rm(value.operationDirectory, { recursive: true })
    await persistJournal(value.root, [opened, failed, receipt])

    const result = await runCli(value)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('receipt digest does not match its body')
    await expect(readFile(value.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a mismatched self pin and a mismatched regular Host CLI pin before execution', async () => {
    const selfMismatch = await fixture()
    const opened = selfMismatch.events[0]!
    const openedEntry = structuredClone(opened.entry) as Record<string, unknown>
    const planEvidence = openedEntry.planEvidence as Record<string, unknown>
    ;(planEvidence.recoveryExecutable as Record<string, unknown>).executableSha256 = jsonDigest({ wrong: 'self' })
    const replacement = event(1, null, openedEntry)
    const rebuilt = [replacement]
    for (const prior of selfMismatch.events.slice(1)) {
      rebuilt.push(event(rebuilt.length + 1, rebuilt.at(-1)!.digest as string, prior.entry as JsonRecord))
    }
    await rm(selfMismatch.operationDirectory, { recursive: true })
    await persistJournal(selfMismatch.root, rebuilt)
    const selfResult = await runCli(selfMismatch)
    expect(selfResult.exitCode).toBe(1)
    expect(selfResult.stderr).toContain('recovery executable hash does not match its pin')

    const hostMismatch = await fixture()
    await writeFile(hostMismatch.hostCliPath, `${await readFile(hostMismatch.hostCliPath, 'utf8')}\n// changed after pin\n`)
    const hostResult = await runCli(hostMismatch)
    expect(hostResult.exitCode).toBe(1)
    expect(hostResult.stderr).toContain('Host CLI hash does not match its pin')
    await expect(readFile(hostMismatch.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when the Host lacks the exact restore-receipt protocol', async () => {
    const value = await fixture('old-rc2')

    const result = await runCli(value)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Host CLI restore-receipt probe failed with exit code 2')
    expect(JSON.parse(await readFile(value.callsPath, 'utf8'))).toEqual([
      ['plugin', '--profile', 'web', 'restore-receipt', '--mutation-id', RECOVERY_MUTATION_ID],
    ])
  })

  it('rejects a current recovery selector that drifted from the immutable generation and tree pin', async () => {
    const value = await fixture()
    const inventory = JSON.parse(await readFile(value.statePath, 'utf8')) as Record<string, unknown>
    const snapshot = inventory.snapshot as Record<string, unknown>
    snapshot.lastGoodGeneration = '33333333-3333-4333-8333-333333333333'
    await writeFile(value.statePath, `${JSON.stringify(inventory, null, 2)}\n`)

    const result = await runCli(value)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('current recovery selector drifted from the journal pin')
    expect(JSON.parse(await readFile(value.callsPath, 'utf8'))).toEqual([
      ['plugin', '--profile', 'web', 'restore-receipt', '--mutation-id', RECOVERY_MUTATION_ID],
      ['plugin', '--profile', 'web', 'list'],
    ])
  })

  it('fails closed when the post-restore owner inventory does not prove the target generation', async () => {
    const value = await fixture('noop-restore')

    const result = await runCli(value)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('does not prove the exact restored generation')
    expect(JSON.parse(await readFile(value.callsPath, 'utf8'))).toEqual([
      ['plugin', '--profile', 'web', 'restore-receipt', '--mutation-id', RECOVERY_MUTATION_ID],
      ['plugin', '--profile', 'web', 'list'],
      ['plugin', '--profile', 'web', 'restore', '--mutation-id', RECOVERY_MUTATION_ID],
      ['plugin', '--profile', 'web', 'list'],
    ])
  })

  it('recognizes the committed receipt after SIGKILL loses restore stdout and does not advance revision again', async () => {
    const value = await fixture('lost-restore-output')

    const interrupted = await runCli(value)
    expect(interrupted.exitCode).toBe(1)
    expect(interrupted.stdout).toBe('')
    expect(interrupted.stderr).toContain('Host CLI restore ended without an exit code')

    const retried = await runCli(value)
    expect(retried).toEqual({
      stdout: 'profile restored; Center journal reconciliation pending\n',
      stderr: '',
      exitCode: 0,
    })
    const state = JSON.parse(await readFile(value.statePath, 'utf8')) as {
      snapshot: { revision: number; activeGeneration: string; treeDigest: string }
    }
    expect(state.snapshot).toMatchObject({
      revision: 8,
      activeGeneration: RECOVERY_GENERATION,
      treeDigest: jsonDigest({ generation: RECOVERY_GENERATION }),
    })
    const calls = JSON.parse(await readFile(value.callsPath, 'utf8')) as string[][]
    expect(calls).toEqual([
      ['plugin', '--profile', 'web', 'restore-receipt', '--mutation-id', RECOVERY_MUTATION_ID],
      ['plugin', '--profile', 'web', 'list'],
      ['plugin', '--profile', 'web', 'restore', '--mutation-id', RECOVERY_MUTATION_ID],
      ['plugin', '--profile', 'web', 'restore-receipt', '--mutation-id', RECOVERY_MUTATION_ID],
      ['plugin', '--profile', 'web', 'list'],
    ])
    expect(calls.filter(args => args[3] === 'restore')).toHaveLength(1)
  })

  it('recognizes the same committed receipt after the restored generation is acknowledged', async () => {
    const value = await fixture('lost-restore-output-before-ack')

    const interrupted = await runCli(value)
    expect(interrupted.exitCode).toBe(1)
    expect(interrupted.stderr).toContain('Host CLI restore ended without an exit code')
    const state = JSON.parse(await readFile(value.statePath, 'utf8')) as {
      snapshot: Record<string, unknown>
    }
    state.snapshot.revision = 9
    state.snapshot.lastGoodGeneration = RECOVERY_GENERATION
    state.snapshot.rollbackGeneration = CANDIDATE_GENERATION
    state.snapshot.bootStatus = 'verified'
    await writeFile(value.statePath, `${JSON.stringify(state, null, 2)}\n`)

    const retried = await runCli(value)

    expect(retried).toEqual({
      stdout: 'profile restored; Center journal reconciliation pending\n',
      stderr: '',
      exitCode: 0,
    })
    const calls = JSON.parse(await readFile(value.callsPath, 'utf8')) as string[][]
    expect(calls.filter(args => args[3] === 'restore')).toHaveLength(1)
  })

  it('rejects unrelated snapshot drift after a committed restore receipt', async () => {
    const value = await fixture('lost-restore-output-before-ack')
    await runCli(value)
    const state = JSON.parse(await readFile(value.statePath, 'utf8')) as {
      snapshot: Record<string, unknown>
    }
    state.snapshot.revision = 9
    state.snapshot.lastGoodGeneration = RECOVERY_GENERATION
    state.snapshot.rollbackGeneration = '33333333-3333-4333-8333-333333333333'
    state.snapshot.bootStatus = 'verified'
    await writeFile(value.statePath, `${JSON.stringify(state, null, 2)}\n`)

    const retried = await runCli(value)

    expect(retried.exitCode).toBe(1)
    expect(retried.stderr).toContain('current inventory diverged from the committed restore receipt')
  })
})
