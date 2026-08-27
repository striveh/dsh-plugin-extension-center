import { appendFileSync } from 'node:fs'
import { access, writeFile } from 'node:fs/promises'
import {
  createInternalTaskContinuations,
  type ContinuationAgent,
  type ContinuationAgentHandle,
  type ContinuationAgentOptions,
  type ContinuationAgents,
  type ContinuationMessage,
  type ContinuationSessionEvent,
  type TaskContinuationClaim,
} from '../../src/internal/continuation/index.ts'

const [root, readyPath, goPath, attemptsPath] = process.argv.slice(2)
if (root === undefined || readyPath === undefined || goPath === undefined || attemptsPath === undefined) {
  throw new Error('continuation owner process requires root, ready, go, and attempts paths')
}

const DIGEST = `sha256:${'a'.repeat(64)}`
const route: Readonly<ContinuationAgentOptions> = Object.freeze({
  provider: 'deepseek',
  model: 'deepseek-chat',
  maxTokens: 1024,
})
const events: ContinuationSessionEvent[] = [{
  type: 'user/message',
  time: Date.now(),
  data: { id: 'original-message', source: { kind: 'user' }, text: 'original task' },
}]

const agent: ContinuationAgent = {
  id: 'session-two-processes',
  options: route,
  session: { id: 'session-two-processes', events },
  inbox: {
    nextTurn: [],
    nextStep: [],
    remove: () => false,
  },
  followup(message: ContinuationMessage): void {
    appendFileSync(attemptsPath, `${message.id}\n`, { encoding: 'utf8', mode: 0o600 })
    events.push({
      type: 'agent/inbox/spliced',
      time: Date.now(),
      data: { target: 'next-turn', start: 0, inserted: [structuredClone(message)] },
    })
    events.push({ type: 'user/message', time: Date.now(), data: structuredClone(message) })
  },
  whenIdle: async () => {},
}

const owner = await createInternalTaskContinuations({
  root,
  agents: {
    get: id => id === agent.id ? agent : undefined,
    resume: async (_options: Parameters<ContinuationAgents['resume']>[0]): Promise<ContinuationAgentHandle> => {
      throw new Error('the two-process fixture must use its exact live Agent')
    },
    withoutInitiator: operation => operation(),
  },
  sessions: {
    get: id => id === agent.id ? agent.session : undefined,
    flush: async () => true,
  },
  sessionPersistence: {
    load: async sessionId => {
      if (sessionId !== agent.id) throw new Error('session not found')
      return Object.freeze({ meta: { agentPreset: 'standard' }, events: structuredClone(events) })
    },
  },
  dispatchClaimLeaseMs: 5_000,
})

try {
  await writeFile(readyPath, '', { mode: 0o600 })
  await waitForFile(goPath)
  const claims = await owner.list({ sessionId: agent.id }) as TaskContinuationClaim[]
  const claim = claims[0]
  if (claim === undefined) throw new Error('shared continuation claim is absent')
  owner.registerVerifier({
    id: claim.verifierId,
    verify: async value => {
      const current = value as TaskContinuationClaim
      return Object.freeze({
        kind: 'ready' as const,
        continuationId: current.continuationId,
        sessionId: current.sessionId,
        originalMessageId: current.originalMessageId,
        needDigest: current.needDigest,
        taskRevision: current.taskRevision,
        verificationPayloadDigest: current.verificationPayloadDigest,
      })
    },
  })
  if (claim.needDigest !== DIGEST) throw new Error('shared continuation claim digest changed')
  await owner.reconcile()
} finally {
  await owner.dispose()
}

async function waitForFile(path: string): Promise<void> {
  while (true) {
    try {
      await access(path)
      return
    } catch {
      await new Promise<void>(resolve => { setTimeout(resolve, 5) })
    }
  }
}
