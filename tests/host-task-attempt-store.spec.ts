import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, canonicalSha256 } from '../src/domain/index.ts'
import { FileTaskAttemptStore } from '../src/task-attempt/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function input(root: string, createdAtMs = 1_000) {
  return {
    sessionId: 'session-task-attempt',
    originalMessageId: 'message-task-attempt',
    profileId: 'web',
    projectRoot: root,
    need: {
      schemaVersion: 1 as const,
      outcomeTags: ['documentation'],
      inputModalities: ['text'] as const,
      outputModalities: ['text'] as const,
      scopeKey: 'user' as const,
      platform: 'darwin' as const,
      requiredDataAccess: [] as const,
      maximumAuthority: [] as const,
    },
    resumeAgentOptions: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 512 },
    createdAtMs,
    expiresAtMs: createdAtMs + 60_000,
  }
}

async function readyAcquisition(store: FileTaskAttemptStore, root: string, createdAtMs = 1_000) {
  const created = await store.create(input(root, createdAtMs))
  const resolving = await store.transition(created.taskAttemptId, created.revision, 'resolving', null, createdAtMs + 1)
  const awaiting = await store.transition(resolving.taskAttemptId, resolving.revision, 'awaiting-approval', {
    kind: 'acquisition-candidate',
    resolutionId: 'resolution:00000000-0000-4000-8000-000000000201',
    candidateRef: 'skill:documentation',
    continuationId: '00000000-0000-4000-8000-000000000202',
    verificationPayloadDigest: canonicalSha256({ continuation: root }),
  }, createdAtMs + 2)
  const acquiring = await store.transition(awaiting.taskAttemptId, awaiting.revision, 'acquiring', awaiting.result, createdAtMs + 3)
  const verifying = await store.transition(acquiring.taskAttemptId, acquiring.revision, 'verifying-visibility', acquiring.result, createdAtMs + 4)
  return store.transition(verifying.taskAttemptId, verifying.revision, 'ready-to-resume', verifying.result, createdAtMs + 5)
}

describe('durable task-attempt owner', () => {
  it('persists the complete catalog authority domain and rejects unknown authority values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-task-authority-'))
    roots.push(root)
    const store = new FileTaskAttemptStore(root)
    await store.initialize()
    const authority = [
      'credentials', 'filesystem-read', 'filesystem-write', 'model-context', 'network', 'subprocess',
    ] as const
    const created = await store.create({
      ...input(root),
      need: { ...input(root).need, maximumAuthority: authority },
    })
    await expect(new FileTaskAttemptStore(root).get(created.taskAttemptId)).resolves.toMatchObject({
      need: { maximumAuthority: authority },
    })
    await expect(store.create({
      ...input(root, 2_000),
      need: { ...input(root).need, maximumAuthority: ['future-authority'] as never },
    })).rejects.toThrow('maximumAuthority[0] is invalid')
  })

  it('assigns a terminal outcome once and preserves it across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-task-attempt-'))
    roots.push(root)
    const store = new FileTaskAttemptStore(root)
    await store.initialize()
    const created = await store.create(input(root))
    const resolving = await store.transition(created.taskAttemptId, 0, 'resolving', null, 1_001)
    const closed = await store.close(
      resolving.taskAttemptId,
      resolving.revision,
      'use-existing',
      'existing-capability-visible',
      { kind: 'use-existing', capabilityId: 'skill:documentation-writer' },
      1_002,
    )

    await expect(store.close(
      closed.taskAttemptId,
      closed.revision,
      'failed',
      'late-overwrite',
      closed.result,
      1_003,
    )).rejects.toThrow('already terminal')
    await expect(new FileTaskAttemptStore(root).initialize()).resolves.toBeUndefined()
    await expect(new FileTaskAttemptStore(root).get(closed.taskAttemptId)).resolves.toEqual(closed)
  })

  it('reconciles dispatch ownership then claimed continuation state to resuming and continued exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-task-continuation-claimed-'))
    roots.push(root)
    const store = new FileTaskAttemptStore(root)
    await store.initialize()
    const ready = await readyAcquisition(store, root)

    const resuming = await store.reconcileContinuation(ready.taskAttemptId, 'consumed', 1_006)
    expect(resuming).toMatchObject({ phase: 'resuming', outcome: null })
    await expect(store.reconcileContinuation(ready.taskAttemptId, 'dispatching', 1_007))
      .resolves.toMatchObject({ phase: 'resuming', outcome: null })
    await expect(store.reconcileContinuation(ready.taskAttemptId, 'dispatched', 1_008))
      .resolves.toMatchObject({ phase: 'resuming', outcome: null })
    const continued = await store.reconcileContinuation(ready.taskAttemptId, 'claimed', 1_009)
    expect(continued).toMatchObject({
      phase: 'resuming',
      outcome: 'continued',
      reason: 'continuation-claimed',
    })
    await expect(store.reconcileContinuation(ready.taskAttemptId, 'claimed', 1_010)).resolves.toEqual(continued)
    await expect(new FileTaskAttemptStore(root).get(ready.taskAttemptId)).resolves.toEqual(continued)
  })

  it.each([
    [
      'invalid',
      'resume-conflict',
      'continuation-invalid:agent-settled-before-continuation-message',
      'agent-settled-before-continuation-message',
    ],
    ['delivery-unknown', 'resume-conflict', 'continuation-delivery-unknown', undefined],
    ['superseded', 'resume-conflict', 'continuation-superseded', undefined],
    ['expired', 'rejected', 'continuation-expired', undefined],
    ['canceled', 'canceled', 'continuation-canceled', undefined],
  ] as const)('maps %s continuation state to an explicit terminal task result', async (
    state,
    outcome,
    reason,
    invalidReason,
  ) => {
    const root = await mkdtemp(join(tmpdir(), `extension-task-continuation-${state}-`))
    roots.push(root)
    const store = new FileTaskAttemptStore(root)
    await store.initialize()
    const ready = await readyAcquisition(store, root)

    await expect(store.reconcileContinuation(ready.taskAttemptId, state, 1_006, invalidReason)).resolves.toMatchObject({
      outcome,
      reason,
    })
  })

  it('rejects a missing or misplaced invalid continuation reason', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-task-continuation-invalid-reason-'))
    roots.push(root)
    const store = new FileTaskAttemptStore(root)
    await store.initialize()
    const ready = await readyAcquisition(store, root)

    await expect(store.reconcileContinuation(ready.taskAttemptId, 'invalid', 1_006))
      .rejects.toThrow('requires an exact invalid reason')
    await expect(store.reconcileContinuation(
      ready.taskAttemptId,
      'consumed',
      1_006,
      'verifier-echo-mismatch',
    )).rejects.toThrow('requires invalid state')
  })

  it('derives one new choice attempt, leaves the old attempt terminal, and rejects replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-task-derivation-'))
    roots.push(root)
    const store = new FileTaskAttemptStore(root)
    await store.initialize()
    const created = await store.create(input(root))
    const resolving = await store.transition(created.taskAttemptId, 0, 'resolving', null, 1_001)
    const old = await store.close(
      resolving.taskAttemptId,
      resolving.revision,
      'choice-required',
      'material-candidate-choice-required',
      { kind: 'choice-required', candidateRefs: ['mcp:search', 'skill:search'] },
      1_002,
    )
    const selected = await store.derive({
      sourceAttemptId: old.taskAttemptId,
      kind: 'choice-selection',
      candidateRef: 'skill:search',
      createdAtMs: 2_000,
      expiresAtMs: 62_000,
    })

    expect(selected).toMatchObject({
      parentAttemptId: old.taskAttemptId,
      trigger: 'choice-selection',
      phase: 'checking-existing',
      outcome: null,
    })
    expect(await store.get(old.taskAttemptId)).toEqual(old)
    await expect(store.derive({
      sourceAttemptId: old.taskAttemptId,
      kind: 'choice-selection',
      candidateRef: 'skill:search',
      createdAtMs: 2_001,
      expiresAtMs: 62_001,
    })).rejects.toThrow('already consumed')
    const restarted = new FileTaskAttemptStore(root)
    await restarted.initialize()
    expect(await restarted.get(selected.taskAttemptId)).toEqual(selected)
  })

  it('expires once and rejects unknown durable fields on cold audit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-task-expiry-'))
    roots.push(root)
    const store = new FileTaskAttemptStore(root)
    await store.initialize()
    const created = await store.create(input(root))
    const expired = await store.expire(created.taskAttemptId, created.expiresAtMs)
    expect(expired).toMatchObject({ outcome: 'rejected', reason: 'attempt-expired' })
    await expect(store.expire(created.taskAttemptId, created.expiresAtMs + 1)).resolves.toEqual(expired)

    const directory = join(root, 'state', 'task-attempts')
    const [name] = await readdir(directory)
    const path = join(directory, name!)
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, `${canonicalJson({ ...value, unexpected: true })}\n`, 'utf8')
    await expect(new FileTaskAttemptStore(root).initialize()).rejects.toThrow('fields must be exactly')
  })

  it('reconciles one idempotent management retry and its Host continuation binding after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-task-retry-'))
    roots.push(root)
    const store = new FileTaskAttemptStore(root)
    await store.initialize()
    const created = await store.create(input(root))
    const resolving = await store.transition(created.taskAttemptId, 0, 'resolving', null, 1_001)
    const management = await store.close(
      resolving.taskAttemptId,
      resolving.revision,
      'management-required',
      'managed-extension-requires-configure',
      {
        kind: 'management-required',
        extensionRef: 'extension-ref:00000000-0000-4000-8000-000000000100',
        targetKey: 'skill:web:user:documentation',
        action: 'configure',
      },
      1_002,
    )
    const derived = await store.derive({
      sourceAttemptId: management.taskAttemptId,
      kind: 'retry-original',
      candidateRef: null,
      createdAtMs: 2_000,
      expiresAtMs: 62_000,
    })
    const retryResolving = await store.transition(derived.taskAttemptId, 0, 'resolving', null, 2_001)
    const usable = await store.close(
      retryResolving.taskAttemptId,
      retryResolving.revision,
      'use-existing',
      'existing-capability-visible',
      { kind: 'use-existing', capabilityId: 'skill:documentation' },
      2_002,
    )
    const verificationPayloadDigest = canonicalSha256({
      taskAttemptId: usable.taskAttemptId,
      parentAttemptId: management.taskAttemptId,
      targetKey: 'skill:web:user:documentation',
      action: 'configure',
      needDigest: usable.needDigest,
      existingCapabilityId: 'skill:documentation',
    })
    await store.putRetryContinuation({
      schemaVersion: 1,
      taskAttemptId: usable.taskAttemptId,
      parentAttemptId: management.taskAttemptId,
      sessionId: usable.sessionId,
      originalMessageId: usable.originalMessageId,
      needDigest: usable.needDigest,
      targetKey: 'skill:web:user:documentation',
      action: 'configure',
      existingCapabilityId: 'skill:documentation',
      verificationPayloadDigest,
      continuationId: null,
      canceledAtMs: null,
      createdAtMs: usable.updatedAtMs,
      expiresAtMs: usable.expiresAtMs,
    })
    const bound = await store.bindRetryContinuation(
      usable.taskAttemptId,
      '00000000-0000-4000-8000-000000000101',
    )

    const replay = await store.derive({
      sourceAttemptId: management.taskAttemptId,
      kind: 'retry-original',
      candidateRef: null,
      createdAtMs: 3_000,
      expiresAtMs: 63_000,
    })
    expect(replay.taskAttemptId).toBe(usable.taskAttemptId)
    const restarted = new FileTaskAttemptStore(root)
    await expect(restarted.initialize()).resolves.toBeUndefined()
    await expect(restarted.getRetryContinuation(usable.taskAttemptId)).resolves.toEqual(bound)
  })
})
