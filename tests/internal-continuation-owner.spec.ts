// @vitest-environment node

import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TASK_CONTINUATION_PROMPT,
  createInternalTaskContinuations,
  type ContinuationAgent,
  type ContinuationAgentHandle,
  type ContinuationAgentOptions,
  type ContinuationAgents,
  type ContinuationInbox,
  type ContinuationMessage,
  type ContinuationSession,
  type ContinuationSessionEvent,
  type ContinuationSessionPersistence,
  type ContinuationSessions,
  type InternalTaskContinuationsOwner,
  type TaskContinuationClaim,
} from '../src/internal/continuation/index.ts'
import { InternalTaskContinuationStore } from '../src/internal/continuation/store.ts'

const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const roots: string[] = []
const owners: InternalTaskContinuationsOwner[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.allSettled(owners.splice(0).map(async owner => { await owner.dispose() }))
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

class TestInbox implements ContinuationInbox {
  readonly nextTurn: ContinuationMessage[] = []
  readonly nextStep: ContinuationMessage[] = []

  remove(id: string): boolean {
    for (const queue of [this.nextTurn, this.nextStep]) {
      const index = queue.findIndex(message => message.id === id)
      if (index >= 0) {
        queue.splice(index, 1)
        return true
      }
    }
    return false
  }
}

class TestAgent implements ContinuationAgent {
  readonly inbox = new TestInbox()
  readonly followups: ContinuationMessage[] = []
  readonly idle = Promise.withResolvers<void>()

  constructor(
    readonly id: string,
    readonly options: Readonly<ContinuationAgentOptions>,
    readonly session: ContinuationSession & { events: ContinuationSessionEvent[] },
    private readonly consumeImmediately = true,
    private readonly rejectIdle = false,
    private readonly throwAfterFollowup = false,
  ) {}

  followup(message: ContinuationMessage): void {
    this.followups.push(message)
    this.session.events.push({
      type: 'agent/inbox/spliced',
      time: Date.now(),
      data: { target: 'next-turn', start: this.inbox.nextTurn.length, inserted: [structuredClone(message)] },
    })
    this.inbox.nextTurn.push(message)
    if (this.throwAfterFollowup) throw new Error('simulated failure after inbox insertion')
    if (!this.consumeImmediately) return
    const claimed = this.claimNextTurn(message.id)
    this.deliverClaimed(claimed)
  }

  claimNextTurn(messageId: string): ContinuationMessage {
    const index = this.inbox.nextTurn.findIndex(message => message.id === messageId)
    const message = this.inbox.nextTurn[index]
    if (message === undefined) throw new Error(`pending message "${messageId}" is absent`)
    this.session.events.push({
      type: 'agent/inbox/spliced',
      time: Date.now(),
      data: { target: 'next-turn', start: index, removedCount: 1, inserted: [] },
    })
    this.inbox.nextTurn.splice(index, 1)
    return message
  }

  deliverClaimed(message: ContinuationMessage): void {
    this.session.events.push({ type: 'user/message', time: Date.now(), data: structuredClone(message) })
    this.idle.resolve()
  }

  settleWithoutDelivery(): void {
    this.idle.resolve()
  }

  whenIdle(): Promise<void> {
    if (this.rejectIdle) return Promise.reject(new Error('simulated whenIdle rejection'))
    return this.consumeImmediately ? Promise.resolve() : this.idle.promise
  }
}

class TestRuntime implements ContinuationSessionPersistence {
  readonly live = new Map<string, TestAgent>()
  readonly persisted = new Map<string, ContinuationSessionEvent[]>()
  readonly headers = new Map<string, Readonly<{ agentPreset?: string }>>()
  readonly attached = new Map<string, ContinuationSession & { events: ContinuationSessionEvent[] }>()
  readonly lifecycleListeners = new Set<() => void>()
  readonly resumeCalls: Array<Readonly<{ sessionId: string; options: Readonly<ContinuationAgentOptions> }>> = []
  readonly presetMounts: Array<Readonly<{ context: unknown; presetId: string }>> = []
  flushes = 0
  setupCalls = 0
  resumeFailures = 0
  flushFailures = 0
  nextLoadEvents?: readonly ContinuationSessionEvent[]

  addLive(
    id: string,
    options: Readonly<ContinuationAgentOptions> = route(),
    consumeImmediately = true,
    rejectIdle = false,
    throwAfterFollowup = false,
  ): TestAgent {
    const session = this.attached.get(id) ?? { id, events: [directUser('original-message')] }
    const agent = new TestAgent(id, options, session, consumeImmediately, rejectIdle, throwAfterFollowup)
    this.live.set(id, agent)
    this.persisted.set(id, structuredClone(session.events))
    if (!this.headers.has(id)) this.headers.set(id, Object.freeze({ agentPreset: 'standard' }))
    return agent
  }

  addPersisted(
    id: string,
    header: Readonly<{ agentPreset?: string }> = Object.freeze({ agentPreset: 'standard' }),
    events: readonly ContinuationSessionEvent[] = [directUser('original-message')],
  ): void {
    this.headers.set(id, header)
    this.persisted.set(id, [...events])
  }

  attachWithoutAgent(id: string): void {
    const events = structuredClone(this.persisted.get(id) ?? [directUser('original-message')])
    this.attached.set(id, { id, events })
  }

  session(id: string): ContinuationSession | undefined {
    return this.live.get(id)?.session ?? this.attached.get(id)
  }

  observeLifecycle(listener: () => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => { this.lifecycleListeners.delete(listener) }
  }

  emitLifecycle(): void {
    for (const listener of this.lifecycleListeners) listener()
  }

  async mount(agentContext: unknown, presetId: string): Promise<Readonly<{ id: string }>> {
    this.presetMounts.push({ context: agentContext, presetId })
    return Object.freeze({ id: presetId })
  }

  agent(id: string): TestAgent | undefined {
    return this.live.get(id)
  }

  async resume(options: Parameters<ContinuationAgents['resume']>[0]): Promise<ContinuationAgentHandle> {
    if (this.resumeFailures > 0) {
      this.resumeFailures -= 1
      throw new Error('simulated cold resume failure')
    }
    const events = this.persisted.get(options.resumeSessionId)
    if (events === undefined) throw new Error('persisted session absent')
    if (options.setup !== undefined) {
      await options.setup(Object.freeze({ sessionId: options.resumeSessionId }))
      this.setupCalls += 1
    }
    const session = { id: options.resumeSessionId, events: structuredClone(events) }
    const agent = new TestAgent(options.resumeSessionId, options.agentOptions, session)
    this.live.set(agent.id, agent)
    this.resumeCalls.push({ sessionId: agent.id, options: options.agentOptions })
    return {
      agent,
      dispose: async () => {
        this.persisted.set(agent.id, structuredClone(agent.session.events))
        if (this.live.get(agent.id) === agent) this.live.delete(agent.id)
      },
    }
  }

  withoutInitiator<Value>(operation: () => Value): Value {
    return operation()
  }

  async flush(session: ContinuationSession): Promise<boolean> {
    this.flushes += 1
    if (this.flushFailures > 0) {
      this.flushFailures -= 1
      throw new Error('simulated Session flush failure')
    }
    this.persisted.set(session.id, structuredClone(session.events))
    return true
  }

  async load(sessionId: string): ReturnType<ContinuationSessionPersistence['load']> {
    const events = this.persisted.get(sessionId)
    if (events === undefined) throw new Error(`session "${sessionId}" not found`)
    const snapshot = structuredClone(this.nextLoadEvents ?? events)
    this.nextLoadEvents = undefined
    return Object.freeze({
      meta: structuredClone(this.headers.get(sessionId) ?? {}),
      events: snapshot,
    })
  }
}

function directUser(id: string): ContinuationSessionEvent {
  return { type: 'user/message', time: Date.now(), data: { id, source: { kind: 'user' }, text: 'secret original task text' } }
}

function route(): Readonly<ContinuationAgentOptions> {
  return Object.freeze({ provider: 'deepseek', model: 'deepseek-chat', maxTokens: 1024 })
}

function request(sessionId: string, mutationId = 'mutation-1', expiresAtMs = Date.now() + 60_000) {
  return Object.freeze({
    callerId: 'extension-center',
    mutationId,
    sessionId,
    originalMessageId: 'original-message',
    needDigest: DIGEST_A,
    taskRevision: `task:${mutationId}`,
    verifierId: 'extension-center-acquisition',
    verificationPayloadDigest: DIGEST_B,
    expiresAtMs,
    resumeAgentOptions: route(),
  })
}

function ready(claim: TaskContinuationClaim) {
  return Object.freeze({
    kind: 'ready' as const,
    continuationId: claim.continuationId,
    sessionId: claim.sessionId,
    originalMessageId: claim.originalMessageId,
    needDigest: claim.needDigest,
    taskRevision: claim.taskRevision,
    verificationPayloadDigest: claim.verificationPayloadDigest,
  })
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'extension-center-continuation-'))
  roots.push(value)
  return value
}

async function owner(
  storageRoot: string,
  runtime: TestRuntime,
  setup?: Parameters<typeof createInternalTaskContinuations>[0]['resumeSetup'],
  overrides: Partial<Parameters<typeof createInternalTaskContinuations>[0]> = {},
) {
  const value = await createInternalTaskContinuations({
    root: storageRoot,
    agents: {
      get: id => runtime.agent(id),
      resume: options => runtime.resume(options),
      withoutInitiator: operation => runtime.withoutInitiator(operation),
    },
    sessions: {
      get: id => runtime.session(id),
      flush: session => runtime.flush(session),
    },
    sessionPersistence: runtime,
    agentPresets: runtime,
    observeLifecycle: listener => runtime.observeLifecycle(listener),
    ...(setup === undefined ? {} : { resumeSetup: setup }),
    ...overrides,
  })
  owners.push(value)
  return value
}

describe('InternalTaskContinuationOwner', () => {
  it('reserves one durable caller key idempotently and never stores original task prose', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    runtime.addPersisted('session-1')
    const continuations = await owner(storageRoot, runtime)
    const input = request('session-1')

    const [first, replay] = await Promise.all([
      continuations.reserve(input),
      continuations.reserve(structuredClone(input)),
    ]) as TaskContinuationClaim[]
    expect(replay.continuationId).toBe(first.continuationId)
    expect(await continuations.list({ callerId: input.callerId, mutationId: input.mutationId })).toHaveLength(1)
    await expect(continuations.reserve({ ...input, needDigest: DIGEST_B }))
      .rejects.toMatchObject({ code: 'TASK_CONTINUATION_MUTATION_CONFLICT' })

    const database = await readFile(join(storageRoot, 'continuations.sqlite'))
    expect(database.includes(Buffer.from('secret original task text'))).toBe(false)
    expect(first).toMatchObject({ state: 'pending', resumeAgentOptions: route() })
  })

  it('derives the exact route from create() and rejects a non-authoritative Agent', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-live')
    const continuations = await owner(storageRoot, runtime)
    const { resumeAgentOptions: _route, ...createInput } = request('session-live')

    await expect(continuations.create({
      id: live.id,
      options: live.options,
      session: live.session,
      inbox: live.inbox,
      followup: (message: ContinuationMessage) => { live.followup(message) },
      whenIdle: async () => { await live.whenIdle() },
    }, createInput)).rejects.toThrow('exact live session')
    const claim = await continuations.create(live, createInput) as TaskContinuationClaim
    expect(claim.resumeAgentOptions).toEqual(route())
  })

  it('keeps a live Agent parked until an exact verifier echo and dispatches only once', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-live')
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-live')) as TaskContinuationClaim

    await continuations.reconcile()
    expect(live.followups).toEqual([])
    let available = false
    continuations.registerVerifier({
      id: claim.verifierId,
      verify: async value => available ? ready(value as TaskContinuationClaim) : { kind: 'not-ready' },
    })
    await continuations.reconcile()
    expect(live.followups).toEqual([])

    available = true
    await continuations.reconcile()
    await continuations.reconcile()
    expect(live.followups).toHaveLength(1)
    expect(live.followups[0]).toEqual({
      id: claim.dispatchMessageId,
      role: 'user',
      content: [{ type: 'text', text: TASK_CONTINUATION_PROMPT }],
      source: { kind: 'plugin', plugin: 'dsh-plugin-extension-center' },
    })
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'claimed' })
  })

  it('lets only one of two Host owners dispatch through a shared SQLite store', async () => {
    const storageRoot = await root()
    const firstRuntime = new TestRuntime()
    const secondRuntime = new TestRuntime()
    const firstAgent = firstRuntime.addLive('session-two-hosts')
    const secondAgent = secondRuntime.addLive('session-two-hosts')
    const first = await owner(storageRoot, firstRuntime)
    const claim = await first.reserve(request('session-two-hosts')) as TaskContinuationClaim
    const second = await owner(storageRoot, secondRuntime)
    first.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })
    second.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await Promise.all([first.reconcile(), second.reconcile()])

    expect([...firstAgent.followups, ...secondAgent.followups]).toHaveLength(1)
    expect([...firstAgent.followups, ...secondAgent.followups][0]?.id).toBe(claim.dispatchMessageId)
    expect(await first.get(claim.continuationId)).toMatchObject({
      state: 'claimed',
      dispatchFence: 1,
    })
    expect(await second.get(claim.continuationId)).toEqual(await first.get(claim.continuationId))
  })

  it('lets only one of two processes dispatch through a shared SQLite store', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    runtime.addPersisted('session-two-processes')
    const preparing = await owner(storageRoot, runtime)
    const claim = await preparing.reserve(request('session-two-processes')) as TaskContinuationClaim
    await preparing.dispose()
    owners.splice(owners.indexOf(preparing), 1)
    const firstReady = join(storageRoot, 'first.ready')
    const secondReady = join(storageRoot, 'second.ready')
    const go = join(storageRoot, 'go')
    const attempts = join(storageRoot, 'attempts.log')
    const fixture = fileURLToPath(new URL('./support/continuation-owner-process.ts', import.meta.url))
    const first = runOwnerProcess(fixture, storageRoot, firstReady, go, attempts)
    const second = runOwnerProcess(fixture, storageRoot, secondReady, go, attempts)
    try {
      await vi.waitFor(async () => {
        await Promise.all([access(firstReady), access(secondReady)])
      }, { timeout: 5_000 })
      await writeFile(go, '', { mode: 0o600 })
      await Promise.all([first.done, second.done])
    } finally {
      first.stop()
      second.stop()
      await Promise.allSettled([first.done, second.done])
    }

    const dispatched = (await readFile(attempts, 'utf8')).trim().split('\n')
    expect(dispatched).toEqual([claim.dispatchMessageId])
    const store = new InternalTaskContinuationStore(storageRoot, 1_000)
    await store.initialize()
    expect(await store.get(claim.continuationId)).toMatchObject({ state: 'claimed', dispatchFence: 1 })
    store.close()
  })

  it('reclaims only a pre-call lease and terminalizes a crashed post-boundary owner without retry', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    runtime.addPersisted('session-fenced-crash')
    const continuations = await owner(storageRoot, runtime)
    const reserved = await continuations.reserve(request('session-fenced-crash')) as TaskContinuationClaim
    await continuations.dispose()
    owners.splice(owners.indexOf(continuations), 1)

    const firstStore = new InternalTaskContinuationStore(storageRoot, 1_000)
    await firstStore.initialize()
    const readyClaim = await firstStore.transition({
      id: reserved.continuationId,
      from: ['pending'],
      to: 'ready',
      expectedRecordRevision: reserved.recordRevision,
      updatedAtMs: reserved.updatedAtMs + 1,
    })
    const consumed = await firstStore.transition({
      id: reserved.continuationId,
      from: ['ready'],
      to: 'consumed',
      expectedRecordRevision: readyClaim?.recordRevision,
      updatedAtMs: reserved.updatedAtMs + 2,
    })
    const firstClaim = await firstStore.claimDispatch({
      id: reserved.continuationId,
      ownerId: 'owner-a',
      nowMs: reserved.updatedAtMs + 3,
      leaseExpiresAtMs: reserved.updatedAtMs + 13,
      expectedSessionId: reserved.sessionId,
      expectedTaskRevision: reserved.taskRevision,
    })
    expect(consumed?.state).toBe('consumed')
    expect(firstClaim).toMatchObject({ state: 'dispatching', dispatchFence: 1, dispatchOwnerId: 'owner-a' })
    expect(firstClaim).not.toHaveProperty('dispatchStartedAtMs')
    firstStore.close()

    const secondStore = new InternalTaskContinuationStore(storageRoot, 1_000)
    await secondStore.initialize()
    await expect(secondStore.claimDispatch({
      id: reserved.continuationId,
      ownerId: 'owner-b',
      nowMs: reserved.updatedAtMs + 12,
      leaseExpiresAtMs: reserved.updatedAtMs + 22,
      expectedSessionId: reserved.sessionId,
      expectedTaskRevision: reserved.taskRevision,
    })).resolves.toBeUndefined()
    const reclaimed = await secondStore.claimDispatch({
      id: reserved.continuationId,
      ownerId: 'owner-b',
      nowMs: reserved.updatedAtMs + 14,
      leaseExpiresAtMs: reserved.updatedAtMs + 24,
      expectedSessionId: reserved.sessionId,
      expectedTaskRevision: reserved.taskRevision,
    })
    expect(reclaimed).toMatchObject({ state: 'dispatching', dispatchFence: 2, dispatchOwnerId: 'owner-b' })
    const started = await secondStore.beginDispatch({
      id: reserved.continuationId,
      ownerId: 'owner-b',
      fence: reclaimed!.dispatchFence,
      expectedRecordRevision: reclaimed!.recordRevision,
      updatedAtMs: reserved.updatedAtMs + 15,
    })
    expect(started).toMatchObject({ state: 'dispatching', dispatchStartedAtMs: reserved.updatedAtMs + 15 })
    secondStore.close()

    const recoveringStore = new InternalTaskContinuationStore(storageRoot, 1_000)
    await recoveringStore.initialize()
    await expect(recoveringStore.claimDispatch({
      id: reserved.continuationId,
      ownerId: 'owner-c',
      nowMs: reserved.updatedAtMs + 25,
      leaseExpiresAtMs: reserved.updatedAtMs + 35,
      expectedSessionId: reserved.sessionId,
      expectedTaskRevision: reserved.taskRevision,
    })).resolves.toBeUndefined()
    await expect(recoveringStore.expireDispatch(
      reserved.continuationId,
      reserved.updatedAtMs + 25,
    )).resolves.toMatchObject({
      state: 'delivery-unknown',
      dispatchFence: 2,
      deliveryUnknownReason: 'owner-lease-expired',
    })
    await expect(recoveringStore.claimDispatch({
      id: reserved.continuationId,
      ownerId: 'owner-c',
      nowMs: reserved.updatedAtMs + 26,
      leaseExpiresAtMs: reserved.updatedAtMs + 36,
      expectedSessionId: reserved.sessionId,
      expectedTaskRevision: reserved.taskRevision,
    })).resolves.toBeUndefined()
    recoveringStore.close()
  })

  it('migrates an ambiguous v1 consumed claim to delivery-unknown instead of replaying it', async () => {
    const storageRoot = await root()
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(join(storageRoot, 'continuations.sqlite'))
    database.exec(`PRAGMA application_id = ${String(0x45434331)}`)
    database.exec(`CREATE TABLE claims (
      continuation_id TEXT PRIMARY KEY NOT NULL,
      caller_id TEXT NOT NULL,
      mutation_id TEXT NOT NULL,
      record_revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      dispatch_message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      original_message_id TEXT NOT NULL,
      need_digest TEXT NOT NULL,
      task_revision TEXT NOT NULL,
      verifier_id TEXT NOT NULL,
      verification_payload_digest TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      agent_provider TEXT,
      agent_model TEXT,
      agent_max_tokens INTEGER,
      superseded_by_task_revision TEXT,
      UNIQUE (caller_id, mutation_id)
    ) STRICT`)
    database.prepare(`INSERT INTO claims VALUES (
      ?, ?, ?, 2, 'consumed', ?, ?, ?, ?, ?, ?, ?, 1000, 1100, 61000, ?, ?, ?, NULL
    )`).run(
      '00000000-0000-4000-8000-000000000401',
      'extension-center',
      'legacy-mutation',
      '00000000-0000-4000-8000-000000000402',
      'legacy-session',
      'original-message',
      DIGEST_A,
      'task:legacy',
      'extension-center-acquisition',
      DIGEST_B,
      'deepseek',
      'deepseek-chat',
      1024,
    )
    database.exec('PRAGMA user_version = 1')
    database.close()

    const store = new InternalTaskContinuationStore(storageRoot, 1_000)
    await store.initialize()
    const migrated = await store.get('00000000-0000-4000-8000-000000000401')
    expect(migrated).toMatchObject({
      version: 3,
      state: 'delivery-unknown',
      recordRevision: 3,
      dispatchOwnerId: 'legacy-v1',
      dispatchFence: 1,
      deliveryUnknownReason: 'legacy-consumed',
    })
    await expect(store.claimDispatch({
      id: migrated!.continuationId,
      ownerId: 'new-owner',
      nowMs: 1_200,
      leaseExpiresAtMs: 2_200,
      expectedSessionId: migrated!.sessionId,
      expectedTaskRevision: migrated!.taskRevision,
    })).resolves.toBeUndefined()
    store.close()
  })

  it('keeps an ambiguous post-followup failure at-most-once and repairs only from durable evidence', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-ambiguous-followup', route(), false, false, true)
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-ambiguous-followup')) as TaskContinuationClaim
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()
    expect(live.followups).toHaveLength(1)
    expect(await continuations.get(claim.continuationId)).toMatchObject({
      state: 'delivery-unknown',
      deliveryUnknownReason: 'followup-error',
    })
    await continuations.reconcile()
    expect(live.followups).toHaveLength(1)

    await runtime.flush(live.session)
    await continuations.reconcile()
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'dispatched' })
    expect(live.followups).toHaveLength(1)
    const claimedMessage = live.claimNextTurn(claim.dispatchMessageId)
    live.deliverClaimed(claimedMessage)
    await vi.waitFor(async () => {
      expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'claimed' })
    })
    expect(live.followups).toHaveLength(1)
  })

  it('does not replay a follow-up while official pre-step has claimed its durable inbox insertion', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-delayed-pre-step', route(), false)
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-delayed-pre-step')) as TaskContinuationClaim
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()
    expect(live.followups).toHaveLength(1)
    const claimedMessage = live.claimNextTurn(claim.dispatchMessageId)
    runtime.emitLifecycle()
    await continuations.reconcile()

    expect(live.followups).toHaveLength(1)
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'dispatched' })
    live.deliverClaimed(claimedMessage)
    runtime.emitLifecycle()
    await vi.waitFor(async () => {
      expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'claimed' })
    })
    expect(live.session.events.filter(event => event.type === 'user/message'
      && (event.data as { id?: string }).id === claim.dispatchMessageId)).toHaveLength(1)
  })

  it('fails closed when a durable claimed inbox insertion settles without its user message', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-missing-user-message', route(), false)
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-missing-user-message')) as TaskContinuationClaim
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()
    live.claimNextTurn(claim.dispatchMessageId)
    runtime.emitLifecycle()
    await continuations.reconcile()
    expect(live.followups).toHaveLength(1)

    live.settleWithoutDelivery()
    await vi.waitFor(async () => {
      expect(await continuations.get(claim.continuationId)).toMatchObject({
        state: 'invalid',
        invalidReason: 'agent-settled-before-continuation-message',
      })
    })
    expect(live.followups).toHaveLength(1)
  })

  it('refreshes durable evidence when settlement overtakes a dispatched reconciliation read', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-settlement-race', route(), false)
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-settlement-race')) as TaskContinuationClaim
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()
    const claimedMessage = live.claimNextTurn(claim.dispatchMessageId)
    live.deliverClaimed(claimedMessage)

    await continuations.reconcile()

    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'claimed' })
    expect(live.followups).toHaveLength(1)
  })

  it('does not invalidate a dispatched message during the bounded pre-step persistence gap', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-pre-step-gap', route(), false)
    const continuations = await owner(storageRoot, runtime, undefined, {
      retryInitialDelayMs: 50,
      retryMaxDelayMs: 50,
    })
    const claim = await continuations.reserve(request('session-pre-step-gap')) as TaskContinuationClaim
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()
    const claimedMessage = live.claimNextTurn(claim.dispatchMessageId)
    live.settleWithoutDelivery()
    await Promise.resolve()
    await Promise.resolve()
    await continuations.reconcile()

    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'dispatched' })
    live.deliverClaimed(claimedMessage)
    await runtime.flush(live.session)
    await vi.advanceTimersByTimeAsync(50)

    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'claimed' })
    expect(live.followups).toHaveLength(1)
  })

  it('uses an acknowledged live Session flush instead of a lagging persistence reader', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-dispatch-persistence-gap', route(), false)
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-dispatch-persistence-gap')) as TaskContinuationClaim
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()
    const flushesBeforeDispatchReconciliation = runtime.flushes
    runtime.nextLoadEvents = [directUser(claim.originalMessageId)]
    await continuations.reconcile()

    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'dispatched' })
    expect(live.followups).toHaveLength(1)
    expect(runtime.flushes).toBeGreaterThan(flushesBeforeDispatchReconciliation)
    expect(runtime.nextLoadEvents).toBeDefined()
    const claimedMessage = live.claimNextTurn(claim.dispatchMessageId)
    live.deliverClaimed(claimedMessage)
    await continuations.reconcile()
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'claimed' })
  })

  it('terminalizes a verifier that fails to echo the exact evidence without waking the Agent', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-live')
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-live')) as TaskContinuationClaim
    continuations.registerVerifier({
      id: claim.verifierId,
      verify: async value => ({ ...ready(value as TaskContinuationClaim), needDigest: DIGEST_B }),
    })

    await continuations.reconcile()
    expect(await continuations.get(claim.continuationId)).toMatchObject({
      state: 'invalid',
      invalidReason: 'verifier-echo-mismatch',
    })
    expect(live.followups).toEqual([])
  })

  it('rejects a forged dispatch event that bypasses the verifier gate', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-live')
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-live')) as TaskContinuationClaim
    live.session.events.push({
      type: 'user/message',
      time: Date.now(),
      data: {
        id: claim.dispatchMessageId,
        role: 'user',
        content: [{ type: 'text', text: TASK_CONTINUATION_PROMPT }],
        source: { kind: 'plugin', plugin: 'dsh-plugin-extension-center' },
      },
    })

    await continuations.reconcile()
    expect(await continuations.get(claim.continuationId)).toMatchObject({
      state: 'invalid',
      invalidReason: 'dispatch-evidence-before-owned-call',
    })
    expect(live.followups).toEqual([])
  })

  it('aborts an in-flight verifier on unregister and preserves the pending claim', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    runtime.addLive('session-live')
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-live')) as TaskContinuationClaim
    const entered = Promise.withResolvers<void>()
    const dispose = continuations.registerVerifier({
      id: claim.verifierId,
      verify: async (_value, signal) => {
        entered.resolve()
        await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        return { kind: 'not-ready' }
      },
    })
    expect(() => continuations.registerVerifier({ id: claim.verifierId, verify: async () => ({ kind: 'not-ready' }) }))
      .toThrow('already registered')

    const reconciling = continuations.reconcile()
    await entered.promise
    dispose()
    await reconciling
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'pending' })
  })

  it('cancels only one reconcile caller while the shared scan remains owner-controlled', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    runtime.addLive('session-live')
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-live')) as TaskContinuationClaim
    const entered = Promise.withResolvers<void>()
    const disposeVerifier = continuations.registerVerifier({
      id: claim.verifierId,
      verify: async (_value, signal) => {
        entered.resolve()
        await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        return { kind: 'not-ready' }
      },
    })
    const controller = new AbortController()
    const reason = new Error('caller generation retired')
    const reconciling = continuations.reconcile(controller.signal)
    await entered.promise

    controller.abort(reason)
    await expect(reconciling).rejects.toBe(reason)
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'pending' })

    disposeVerifier()
    await continuations.reconcile()
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'pending' })
  })

  it('disposes while a verifier-backed reconcile is pending', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    runtime.addLive('session-live')
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-live')) as TaskContinuationClaim
    const entered = Promise.withResolvers<void>()
    continuations.registerVerifier({
      id: claim.verifierId,
      verify: async (_value, signal) => {
        entered.resolve()
        await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        return { kind: 'not-ready' }
      },
    })
    const reconciling = continuations.reconcile()
    await entered.promise

    await expect(Promise.all([reconciling, continuations.dispose()])).resolves.toHaveLength(2)
    owners.splice(owners.indexOf(continuations), 1)
  })

  it('recovers a pending claim after restart and cold-resumes through the official Agent route', async () => {
    const storageRoot = await root()
    const firstRuntime = new TestRuntime()
    firstRuntime.addPersisted('session-cold')
    const firstOwner = await owner(storageRoot, firstRuntime)
    const claim = await firstOwner.reserve(request('session-cold')) as TaskContinuationClaim
    await firstOwner.dispose()
    owners.splice(owners.indexOf(firstOwner), 1)

    const restartedRuntime = new TestRuntime()
    restartedRuntime.addPersisted('session-cold')
    let setupClaim: string | undefined
    const restarted = await owner(storageRoot, restartedRuntime, async (_context, value) => {
      setupClaim = value.continuationId
    })
    restarted.registerVerifier({
      id: claim.verifierId,
      verify: async value => ready(value as TaskContinuationClaim),
    })

    await restarted.reconcile()
    expect(restartedRuntime.resumeCalls).toEqual([{ sessionId: 'session-cold', options: route() }])
    expect(restartedRuntime.presetMounts.map(call => call.presetId)).toEqual(['standard'])
    expect(restartedRuntime.setupCalls).toBe(1)
    expect(setupClaim).toBe(claim.continuationId)
    expect(await restarted.get(claim.continuationId)).toMatchObject({ state: 'claimed' })
    expect(restartedRuntime.persisted.get('session-cold')?.filter(event =>
      event.type === 'user/message' && (event.data as { id?: string }).id === claim.dispatchMessageId)).toHaveLength(1)
  })

  it('reconstructs the last persisted non-default preset before publishing a cold-resumed Agent', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    runtime.addPersisted(
      'session-selected-preset',
      { agentPreset: 'standard' },
      [directUser('original-message'), { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }],
    )
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-selected-preset')) as TaskContinuationClaim
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()

    expect(runtime.presetMounts.map(call => call.presetId)).toEqual(['minimal'])
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'claimed' })
  })

  it('fails closed when persisted state cannot identify the exact cold-resume preset', async () => {
    vi.useFakeTimers()
    const storageRoot = await root()
    const runtime = new TestRuntime()
    runtime.addPersisted('session-no-preset', {})
    const continuations = await owner(storageRoot, runtime, undefined, {
      retryInitialDelayMs: 1_000,
      retryMaxDelayMs: 1_000,
    })
    const claim = await continuations.reserve(request('session-no-preset')) as TaskContinuationClaim
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()

    expect(runtime.resumeCalls).toEqual([])
    expect(runtime.presetMounts).toEqual([])
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'consumed' })
    expect(vi.getTimerCount()).toBe(1)
    await continuations.dispose()
    owners.splice(owners.indexOf(continuations), 1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('automatically retries a consumed claim after the first cold resume failure', async () => {
    vi.useFakeTimers()
    const storageRoot = await root()
    const runtime = new TestRuntime()
    runtime.addPersisted('session-retry-resume')
    runtime.resumeFailures = 1
    const continuations = await owner(storageRoot, runtime, undefined, {
      retryInitialDelayMs: 10,
      retryMaxDelayMs: 20,
    })
    const claim = await continuations.reserve(request('session-retry-resume')) as TaskContinuationClaim
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'consumed' })
    await vi.advanceTimersByTimeAsync(10)

    expect(runtime.resumeCalls).toHaveLength(1)
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'claimed' })
  })

  it('continues after an attached Session gains its Agent and emits an official lifecycle signal', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    runtime.addPersisted('session-attached')
    const continuations = await owner(storageRoot, runtime, undefined, {
      retryInitialDelayMs: 1_000,
      retryMaxDelayMs: 1_000,
    })
    const claim = await continuations.reserve(request('session-attached')) as TaskContinuationClaim
    runtime.attachWithoutAgent('session-attached')
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'consumed' })
    const live = runtime.addLive('session-attached')
    runtime.emitLifecycle()
    await vi.waitFor(async () => {
      expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'claimed' })
    })

    expect(live.followups).toHaveLength(1)
    expect(live.followups[0]?.id).toBe(claim.dispatchMessageId)
  })

  it('reconciles a crash-persisted dispatch marker without inserting a duplicate follow-up', async () => {
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-marker', route(), false)
    const continuations = await owner(storageRoot, runtime)
    const claim = await continuations.reserve(request('session-marker')) as TaskContinuationClaim
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()
    expect(live.followups).toHaveLength(1)
    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'dispatched' })
    await continuations.reconcile()
    expect(live.followups).toHaveLength(1)
    expect(live.inbox.nextTurn).toHaveLength(1)
  })

  it('keeps one dispatch message when whenIdle rejects and the consumed claim retries', async () => {
    vi.useFakeTimers()
    const storageRoot = await root()
    const runtime = new TestRuntime()
    const live = runtime.addLive('session-idle-reject', route(), false, true)
    const continuations = await owner(storageRoot, runtime, undefined, {
      retryInitialDelayMs: 10,
      retryMaxDelayMs: 20,
    })
    const claim = await continuations.reserve(request('session-idle-reject')) as TaskContinuationClaim
    continuations.registerVerifier({ id: claim.verifierId, verify: async value => ready(value as TaskContinuationClaim) })

    await continuations.reconcile()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)

    expect(await continuations.get(claim.continuationId)).toMatchObject({ state: 'dispatched' })
    expect(live.followups).toHaveLength(1)
    expect(live.inbox.nextTurn).toHaveLength(1)
    expect(live.followups[0]?.id).toBe(claim.dispatchMessageId)
  })

  it('expires undelivered work and enforces cancel and supersede fences', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    const storageRoot = await root()
    const runtime = new TestRuntime()
    runtime.addPersisted('session-terminal')
    const continuations = await owner(storageRoot, runtime)
    const expiring = await continuations.reserve(request('session-terminal', 'expire', Date.now() + 100)) as TaskContinuationClaim
    vi.setSystemTime(Date.now() + 101)
    await continuations.reconcile()
    expect(await continuations.get(expiring.continuationId)).toMatchObject({ state: 'expired' })

    const canceled = await continuations.reserve(request('session-terminal', 'cancel', Date.now() + 60_000)) as TaskContinuationClaim
    await expect(continuations.cancel({ id: canceled.continuationId, sessionId: 'wrong', taskRevision: canceled.taskRevision }))
      .resolves.toBe(false)
    await expect(continuations.cancel({ id: canceled.continuationId, sessionId: canceled.sessionId, taskRevision: canceled.taskRevision }))
      .resolves.toBe(true)
    await expect(continuations.cancel({ id: canceled.continuationId, sessionId: canceled.sessionId, taskRevision: canceled.taskRevision }))
      .resolves.toBe(false)

    const superseded = await continuations.reserve(request('session-terminal', 'supersede', Date.now() + 60_000)) as TaskContinuationClaim
    await expect(continuations.supersede({
      id: superseded.continuationId,
      sessionId: superseded.sessionId,
      taskRevision: superseded.taskRevision,
      replacementTaskRevision: 'task:newer',
    })).resolves.toBe(true)
    expect(await continuations.get(superseded.continuationId)).toMatchObject({
      state: 'superseded',
      supersededByTaskRevision: 'task:newer',
    })
  })
})

function runOwnerProcess(
  fixture: string,
  rootPath: string,
  readyPath: string,
  goPath: string,
  attemptsPath: string,
): Readonly<{ done: Promise<void>; stop(): void }> {
  const child = spawn(process.execPath, [
    '--experimental-transform-types',
    fixture,
    rootPath,
    readyPath,
    goPath,
    attemptsPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const done = new Promise<void>((resolve, reject) => {
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`continuation owner process exited ${String(code)}: ${stderr.trim()}`))
    })
  })
  void done.catch(() => {})
  return Object.freeze({
    done,
    stop: () => { if (child.exitCode === null) child.kill() },
  })
}
