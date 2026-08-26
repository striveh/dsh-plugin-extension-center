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

describe('durable task-attempt owner', () => {
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
