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
const TARGET_KEY = 'plugin:web:profile:web:dsh-example'
const CANDIDATE_GENERATION = '11111111-1111-4111-8111-111111111111'
const RECOVERY_GENERATION = '22222222-2222-4222-8222-222222222222'

type HostBehavior = 'restore' | 'noop-restore' | 'old-rc2'

interface JsonRecord {
  readonly [key: string]: unknown
}

interface JournalFixture {
  readonly root: string
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

function event(sequence: number, previousDigest: string | null, entry: JsonRecord): JsonRecord {
  const unsigned = {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    targetKey: TARGET_KEY,
    sequence,
    previousDigest,
    atMs: 1_000 + sequence,
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

async function writeHostCli(root: string, behavior: HostBehavior): Promise<Readonly<{
  path: string
  callsPath: string
  statePath: string
}>> {
  const path = join(root, 'host-cli.mjs')
  const statePath = join(root, 'host-inventory.json')
  const callsPath = join(root, 'host-calls.json')
  const candidateDigest = jsonDigest({ generation: CANDIDATE_GENERATION })
  const recoveryDigest = jsonDigest({ generation: RECOVERY_GENERATION })
  await writeFile(statePath, `${JSON.stringify({
    snapshot: {
      profile: 'web',
      revision: 7,
      treeDigest: candidateDigest,
      effectivePath: join(root, 'profiles', CANDIDATE_GENERATION),
      activeGeneration: CANDIDATE_GENERATION,
      lastGoodGeneration: RECOVERY_GENERATION,
      rollbackGeneration: null,
      bootStatus: 'pending-restart',
    },
    active: summary(CANDIDATE_GENERATION, candidateDigest),
    staged: [],
    recoverable: [summary(RECOVERY_GENERATION, recoveryDigest)],
  }, null, 2)}\n`)
  await writeFile(path, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const statePath = join(root, 'host-inventory.json')
const callsPath = join(root, 'host-calls.json')
const args = process.argv.slice(2)
const prior = existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, 'utf8')) : []
prior.push(args)
writeFileSync(callsPath, JSON.stringify(prior))
if (args.length !== 4 || args[0] !== 'plugin' || args[1] !== '--profile' || args[2] !== 'web') {
  process.stderr.write('unsupported rc2 invocation\\n')
  process.exitCode = 2
} else if (args[3] === 'list') {
  if (${JSON.stringify(behavior)} === 'old-rc2') {
    process.stdout.write('Legend: production dependency, optional only, dev only\\n')
  } else {
    process.stdout.write(JSON.stringify(JSON.parse(readFileSync(statePath, 'utf8')), null, 2) + '\\n')
  }
} else if (args[3] === 'restore') {
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const target = state.recoverable.find(item => item.generation === state.snapshot.lastGoodGeneration)
  if (target === undefined) {
    process.stderr.write('no recovery target\\n')
    process.exitCode = 2
  } else {
    if (${JSON.stringify(behavior)} === 'restore') {
      const priorActive = state.active
      state.snapshot.revision += 1
      state.snapshot.activeGeneration = target.generation
      state.snapshot.treeDigest = target.treeDigest
      state.snapshot.effectivePath = join(root, 'profiles', target.generation)
      state.snapshot.bootStatus = 'verified'
      state.active = target
      state.staged = [...state.staged, priorActive]
      state.recoverable = []
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n')
    }
    process.stdout.write('dsh: restored generation ' + target.generation + '; restart required\\n')
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
  const cli = await compileStandaloneCli(root)
  const host = await writeHostCli(root, behavior)
  const recoveryExecutable = await installRecoveryExecutable({
    root,
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
      env: { ...process.env, DSH_HOME: join(value.root, 'dsh-home') },
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
      ['plugin', '--profile', 'web', 'list'],
      ['plugin', '--profile', 'web', 'restore'],
      ['plugin', '--profile', 'web', 'list'],
    ])
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

  it('fails closed when an rc2-style list is not the exact owner inventory', async () => {
    const value = await fixture('old-rc2')

    const result = await runCli(value)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Host CLI list did not return one JSON value')
    expect(JSON.parse(await readFile(value.callsPath, 'utf8'))).toEqual([
      ['plugin', '--profile', 'web', 'list'],
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
      ['plugin', '--profile', 'web', 'list'],
      ['plugin', '--profile', 'web', 'restore'],
      ['plugin', '--profile', 'web', 'list'],
    ])
  })
})
