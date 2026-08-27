import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, canonicalSha256, ExtensionDomainError } from '../src/domain/index.ts'
import {
  createOperationJournal,
  issueOperationReceipt,
  recordOperationMutation,
  recordOperationVerification,
  transitionOperation,
  type OperationAuthorization,
  type OperationJournal,
  type OperationPhase,
} from '../src/operations/index.ts'
import { FileOperationStore, operationStoreStat } from '../src/storage/index.ts'
import { TEST_RECOVERY_EXECUTABLE_BINDING } from './support/recovery-binding.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function authorization(operationId = 'operation:durable:1'): OperationAuthorization {
  return {
    operationId,
    planId: 'plan:1',
    planHash: canonicalSha256({ plan: 1 }),
    origin: 'store',
    candidateRef: 'skill:example@1',
    extensionKind: 'skill',
    extensionId: 'example',
    operationKind: 'install',
    managedObject: 'artifact',
    externalRuntimeAction: 'download',
    runtimeBinding: null,
    artifactRevision: '1.0.0',
    artifactIntegrity: canonicalSha256({ artifact: 1 }),
    artifactUrl: 'https://example.test/example.md',
    artifactSizeBytes: 123,
    desiredState: 'enabled',
    targetKey: 'skill:user/example',
    ownerKey: 'skill-filesystem:user',
    scopeKey: 'agent:1:/workspace',
    profileId: 'profile:web',
    idempotencyKey: 'idempotency:1',
    authorityDigest: canonicalSha256({ authority: 1 }),
    configurationDigest: canonicalSha256({ configuration: 1 }),
    retentionDigest: canonicalSha256({ retention: 1 }),
    reviewEvidence: testReviewEvidence('skill', 'install'),
    mutationDigest: canonicalSha256({ mutation: 'recipe' }),
    verificationDigest: canonicalSha256({ verification: 'recipe' }),
    restartRequired: false,
    fences: {
      catalogRevision: 1,
      inventoryRevision: canonicalSha256({ inventory: 1 }),
      targetRevision: 'absent',
      ownerRevision: 'skills:1',
      scopeRevision: 'scope:1',
      profileRevision: 'profile:1',
    },
    recoveryExecutable: TEST_RECOVERY_EXECUTABLE_BINDING,
    authorizedAtMs: 1,
  }
}

function next(journal: OperationJournal): OperationJournal {
  const at = journal.events.at(-1)!.atMs + 1
  const phase = journal.events.at(-1)!.entry.type === 'operation-opened'
    ? 'authorized'
    : undefined
  if (phase === 'authorized') return transitionOperation(journal, 'staging', null, null, at)
  throw new Error('unexpected fixture phase')
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'extension-center-store-'))
  roots.push(root)
  return root
}

async function persistAll(store: FileOperationStore, journals: readonly OperationJournal[]): Promise<void> {
  for (const journal of journals) await store.persist(journal)
}

function completeJournals(): { journals: OperationJournal[]; receiptDigest: string } {
  const journals: OperationJournal[] = []
  let journal = createOperationJournal(authorization(), canonicalSha256({ before: 'absent' }), 2)
  journals.push(journal)
  journal = transitionOperation(journal, 'staging', null, null, 3)
  journals.push(journal)
  journal = transitionOperation(journal, 'applying', null, null, 4)
  journals.push(journal)
  journal = recordOperationMutation(journal, canonicalSha256({ mutation: 'installed' }), 5)
  journals.push(journal)
  journal = transitionOperation(journal, 'verifying', null, null, 6)
  journals.push(journal)
  journal = recordOperationVerification(journal, canonicalSha256({ owner: 'visible' }), 7)
  journals.push(journal)
  journal = transitionOperation(journal, 'committed', canonicalSha256({ after: 'visible' }), null, 8)
  journals.push(journal)
  const issued = issueOperationReceipt(journal, 9)
  journals.push(issued.journal)
  return { journals, receiptDigest: issued.receipt.digest }
}

function journalsThroughPhase(phase: OperationPhase, operationId: string): OperationJournal[] {
  const beforeDigest = canonicalSha256({ before: operationId })
  const journals: OperationJournal[] = []
  let journal = createOperationJournal(authorization(operationId), beforeDigest, 2)
  journals.push(journal)
  if (phase === 'authorized') return journals
  if (phase === 'failed') {
    journal = transitionOperation(journal, 'failed', beforeDigest, 'interrupted-before-mutation', 3)
    journals.push(journal)
    return journals
  }
  journal = transitionOperation(journal, 'staging', null, null, 3)
  journals.push(journal)
  if (phase === 'staging') return journals
  journal = transitionOperation(journal, 'applying', null, null, 4)
  journals.push(journal)
  if (phase === 'applying') return journals
  journal = recordOperationMutation(journal, canonicalSha256({ mutation: operationId }), 5)
  journals.push(journal)
  journal = transitionOperation(journal, 'verifying', null, null, 6)
  journals.push(journal)
  if (phase === 'verifying') return journals
  journal = recordOperationVerification(journal, canonicalSha256({ verification: operationId }), 7)
  journals.push(journal)
  if (phase === 'committed') {
    journal = transitionOperation(journal, 'committed', canonicalSha256({ after: operationId }), null, 8)
    journals.push(journal)
    return journals
  }
  journal = transitionOperation(journal, 'rolling-back', null, null, 8)
  journals.push(journal)
  if (phase === 'rolling-back') return journals
  if (phase === 'recovery-required') {
    journal = transitionOperation(journal, 'recovery-required', null, 'rollback-failed', 9)
    journals.push(journal)
    return journals
  }
  journal = transitionOperation(journal, 'rolled-back', beforeDigest, null, 9)
  journals.push(journal)
  return journals
}

describe('full P0 durable operation store', () => {
  it('persists a strict idempotent operation reservation until its journal is durable', async () => {
    const root = await fixtureRoot()
    const store = new FileOperationStore(root)
    const reservation = {
      schemaVersion: 1 as const,
      operationId: 'operation:reservation:1',
      planHash: canonicalSha256({ plan: 'reservation' }),
      targetKey: 'skill:user/example',
      beforeDigest: canonicalSha256({ before: 'reservation' }),
      reservedAtMs: 1,
    }
    await store.reserve(reservation)
    await store.reserve(reservation)
    await expect(store.listReservations()).resolves.toEqual([reservation])

    const directory = join(root, 'operation-reservations')
    const path = join(directory, (await readdir(directory))[0]!)
    await writeFile(path, `${canonicalJson({ ...reservation, unexpected: true })}\n`, 'utf8')
    await expect(store.listReservations()).rejects.toMatchObject({ code: 'journal-corrupt' })
  })

  it('persists immutable event records, reconstructs the chain, and lists only verified receipts', async () => {
    const root = await fixtureRoot()
    const store = new FileOperationStore(root)
    const completed = completeJournals()
    await persistAll(store, completed.journals)

    const loaded = await new FileOperationStore(root).load('operation:durable:1')
    expect(loaded).toMatchObject({ recovered: false, projection: { phase: 'committed' } })
    expect(loaded?.journal.events).toHaveLength(completed.journals.length)
    expect(loaded?.projection.receipt?.digest).toBe(completed.receiptDigest)
    await expect(new FileOperationStore(root).listReceipts()).resolves.toMatchObject([
      { operationId: 'operation:durable:1', receipt: { digest: completed.receiptDigest } },
    ])

    const durable = await operationStoreStat(root, 'operation:durable:1')
    expect(durable.files.filter(file => /^\d/.test(file))).toHaveLength(completed.journals.length)
    expect(durable.files).toContain('CURRENT.json')
  })

  it('recovers a valid event installed after the last atomic pointer advance', async () => {
    const root = await fixtureRoot()
    const store = new FileOperationStore(root)
    let journal = createOperationJournal(authorization(), canonicalSha256({ before: 1 }), 2)
    await store.persist(journal)
    const pointerBefore = (await operationStoreStat(root, journal.operationId)).files
    expect(pointerBefore).toHaveLength(2)

    journal = next(journal)
    const scratch = await fixtureRoot()
    await new FileOperationStore(scratch).persist(createOperationJournal(authorization(), canonicalSha256({ before: 1 }), 2))
    await new FileOperationStore(scratch).persist(journal)
    const scratchFiles = await operationStoreStat(scratch, journal.operationId)
    const eventTwo = scratchFiles.files.find(file => file.startsWith('0000000002-'))!
    const sourceDirectory = join(scratch, 'operations', (await readdir(join(scratch, 'operations')))[0]!)
    const targetDirectory = join(root, 'operations', (await readdir(join(root, 'operations')))[0]!)
    await rename(join(sourceDirectory, eventTwo), join(targetDirectory, eventTwo))

    const recovered = await new FileOperationStore(root).load(journal.operationId)
    expect(recovered).toMatchObject({ recovered: true, projection: { phase: 'staging' } })
    const pointer = JSON.parse(await readFile(join(targetDirectory, 'CURRENT.json'), 'utf8'))
    expect(pointer.eventCount).toBe(2)
  })

  it('fails closed at the fixed ENOSPC event-write seam without publishing a journal head', async () => {
    const root = await fixtureRoot()
    const noSpace = Object.assign(new Error('simulated fixed journal ENOSPC'), { code: 'ENOSPC' })
    const store = new FileOperationStore(root, point => {
      if (point === 'journal-event-before-write') throw noSpace
    })
    const journal = createOperationJournal(authorization('operation:enospc'), canonicalSha256(null), 2)

    await expect(store.persist(journal)).rejects.toBe(noSpace)
    await expect(new FileOperationStore(root).load(journal.operationId)).resolves.toBeUndefined()
  })

  it('rejects a partial CURRENT pointer even when the next event itself is durable', async () => {
    const root = await fixtureRoot()
    let journal = createOperationJournal(authorization('operation:partial-current'), canonicalSha256(null), 2)
    await new FileOperationStore(root).persist(journal)
    journal = transitionOperation(journal, 'staging', null, null, 3)
    const store = new FileOperationStore(root, async (point, context) => {
      if (point !== 'journal-event-durable-before-current' || context.phase !== 'staging') return
      await writeFile(context.currentPath, '{"schemaVersion":', 'utf8')
      throw new Error('simulated process death after partial CURRENT replacement')
    })

    await expect(store.persist(journal)).rejects.toThrow('simulated process death')
    await expect(new FileOperationStore(root).load(journal.operationId))
      .rejects.toMatchObject({ code: 'journal-corrupt' })
  })

  it('repairs an event-ahead-of-CURRENT crash at every journal phase', async () => {
    const phases: readonly OperationPhase[] = [
      'authorized',
      'staging',
      'applying',
      'verifying',
      'rolling-back',
      'committed',
      'rolled-back',
      'failed',
      'recovery-required',
    ]
    for (const phase of phases) {
      const root = await fixtureRoot()
      const operationId = `operation:phase-crash:${phase}`
      const journals = journalsThroughPhase(phase, operationId)
      const store = new FileOperationStore(root, (point, context) => {
        if (point === 'journal-event-durable-before-current' && context.phase === phase) {
          throw new Error(`simulated ${phase} process death`)
        }
      })
      for (const journal of journals.slice(0, -1)) await store.persist(journal)
      await expect(store.persist(journals.at(-1)!)).rejects.toThrow(`simulated ${phase} process death`)

      const recovered = await new FileOperationStore(root).load(operationId)
      expect(recovered, phase).toMatchObject({ recovered: true, projection: { phase } })
      expect(recovered?.journal.events).toHaveLength(journals.at(-1)!.events.length)
    }
  })

  it('rejects a valid-prefix truncation and an altered content-addressed event', async () => {
    const root = await fixtureRoot()
    const store = new FileOperationStore(root)
    const completed = completeJournals()
    await persistAll(store, completed.journals.slice(0, 2))
    const operationDirectory = join(root, 'operations', (await readdir(join(root, 'operations')))[0]!)
    const eventTwo = (await readdir(operationDirectory)).find(file => file.startsWith('0000000002-'))!
    await unlink(join(operationDirectory, eventTwo))
    await expect(new FileOperationStore(root).load('operation:durable:1'))
      .rejects.toMatchObject({ code: 'journal-truncated' })

    const otherRoot = await fixtureRoot()
    const other = new FileOperationStore(otherRoot)
    await persistAll(other, completed.journals.slice(0, 2))
    const otherDirectory = join(otherRoot, 'operations', (await readdir(join(otherRoot, 'operations')))[0]!)
    const firstName = (await readdir(otherDirectory)).find(file => file.startsWith('0000000001-'))!
    const parsed = JSON.parse(await readFile(join(otherDirectory, firstName), 'utf8'))
    parsed.targetKey = 'skill:user/attacker'
    await writeFile(join(otherDirectory, firstName), `${canonicalJson(parsed)}\n`)
    await expect(new FileOperationStore(otherRoot).load('operation:durable:1'))
      .rejects.toBeInstanceOf(ExtensionDomainError)
  })

  it('serializes concurrent same-operation appends and refuses a non-linear prefix', async () => {
    const root = await fixtureRoot()
    const store = new FileOperationStore(root)
    const first = createOperationJournal(authorization(), canonicalSha256({ before: 1 }), 2)
    await store.persist(first)
    const second = next(first)
    const alternative = transitionOperation(first, 'staging', null, null, 4)

    const results = await Promise.allSettled([store.persist(second), store.persist(alternative)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await store.load(first.operationId))?.journal.events).toHaveLength(2)
  })
})
