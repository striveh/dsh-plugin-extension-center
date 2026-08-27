import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  APPROVAL_REQUIRED_MARKER,
  CONTINUATION_PROMPT,
  DOCUMENTATION_CAPABILITY_NEED,
  DOCUMENTATION_SKILL_CANDIDATE,
  DOCUMENTATION_SKILL_NAME,
  FULFILLED_MARKER,
  KEYLESS_REPLAY_BUNDLE,
  OFFICIAL_REPLAY_PACKAGE,
  ORIGINAL_TASK,
  assertFulfilledAgentHistory,
  assertFulfilledAgentProjection,
  assertPreAuthorizationAgentHistory,
  assertPreAuthorizationAgentProjection,
  buildKeylessAgentReplayOverride,
  normalizeHistoryEvents,
  renderKeylessReplayBundlePatch,
} from './agent-acquisition.mjs'
import { AcceptanceFailure, TARGET_DSH_VERSION } from './support.mjs'

const sessionId = 'session-agent-proof'
const originalMessageId = 'message-original'
const continuationMessageId = 'message-continuation'
const taskAttemptId = 'task-attempt-agent-proof'
const resolutionId = 'resolution:123e4567-e89b-42d3-a456-426614174000'
const continuationId = '123e4567-e89b-42d3-a456-426614174001'
const planId = 'plan:agent-proof'
const planHash = `sha256:${'a'.repeat(64)}`
const operationId = 'operation:agent-proof'
const receiptDigest = `sha256:${'b'.repeat(64)}`
const cwd = resolve('/tmp/extension-center-agent-proof')
const agentPreset = 'standard'

test('builds one five-call official Replay script with opaque acquisition echo', () => {
  const replay = buildKeylessAgentReplayOverride()
  assert.equal(replay.length, 5)
  assert.deepEqual(replay.map(entry => finishKind(entry)), [
    'tool-calls', 'tool-calls', 'stop', 'tool-calls', 'stop',
  ])
  const tools = replay.flatMap(entry => {
    const block = entry.chunks.find(chunk => chunk.type === 'block-end')?.block
    return block?.type === 'tool-call' ? [block] : []
  })
  assert.deepEqual(tools.map(tool => tool.name), [
    'extension_center_resolve', 'extension_center_request_acquisition', 'skill',
  ])
  assert.deepEqual(JSON.parse(tools[0].arguments), DOCUMENTATION_CAPABILITY_NEED)
  const acquisition = JSON.parse(tools[1].arguments)
  assert.equal(acquisition.candidateRef, DOCUMENTATION_SKILL_CANDIDATE)
  assert.match(acquisition.resolutionId, /^\{\{fromRequest:/u)
  assert.match(acquisition.continuationId, /^\{\{fromRequest:/u)
  assert.doesNotMatch(tools[1].arguments, /123e4567/u)
  assert.deepEqual(JSON.parse(tools[2].arguments), { name: DOCUMENTATION_SKILL_NAME })
  assert.equal(textDelta(replay[2]), APPROVAL_REQUIRED_MARKER)
  assert.equal(textDelta(replay[4]), FULFILLED_MARKER)
})

test('renders an acceptance Bundle over only official profile extension rows', () => {
  const fixturePath = resolve('/tmp/agent-replay/session.jsonl')
  const overridePath = resolve('/tmp/agent-replay/replay.override.json')
  const patch = renderKeylessReplayBundlePatch({ fixturePath, overridePath })
  assert.match(patch, /- id: session-title-llm\n  disabled: true/u)
  assert.match(patch, /- id: llm-deepseek\n  disabled: true/u)
  assert.match(patch, new RegExp(`name: '${OFFICIAL_REPLAY_PACKAGE}'`, 'u'))
  assert.match(patch, /id: deepseek-official/u)
  assert.match(patch, /id: deepseek-v4-flash/u)
  assert.match(patch, /id: deepseek-v4-pro/u)
  assert.match(patch, new RegExp(JSON.stringify(fixturePath).replaceAll('/', '\\/'), 'u'))
  assert.match(patch, new RegExp(JSON.stringify(overridePath).replaceAll('/', '\\/'), 'u'))
  assert.doesNotMatch(patch, /host-plugin|agent-loop|mock|official.*checkout/iu)
  assert.equal(KEYLESS_REPLAY_BUNDLE, 'dsh-extension-center-keyless-agent-proof')
  assert.equal(`${OFFICIAL_REPLAY_PACKAGE}@${TARGET_DSH_VERSION}`, '@deepseek-ai/dsh-llm-replay@0.1.1-rc.2')
  assert.throws(
    () => renderKeylessReplayBundlePatch({ fixturePath: 'relative', overridePath }),
    /must be absolute/u,
  )
})

test('normalizes correlated official history wrappers and rejects an unordered page', () => {
  const events = initialEvents()
  assert.deepEqual(
    normalizeHistoryEvents(events.map(event => ({ event }))).map(event => event.type),
    events.map(event => event.type),
  )
  const unordered = events.map(event => ({ ...event }))
  unordered[1].seq = unordered[0].seq
  assert.throws(
    () => normalizeHistoryEvents(unordered),
    error => acceptanceCode(error, 'P0-AGENT-HISTORY-ENVELOPE'),
  )
})

test('binds the first real Agent turn to one pending task plan without continuation', () => {
  const events = initialEvents()
  const history = assertPreAuthorizationAgentHistory(events)
  assert.deepEqual(history, {
    originalMessageId,
    taskAttemptId,
    resolutionId,
    continuationId,
    candidateRef: DOCUMENTATION_SKILL_CANDIDATE,
    planId,
    planHash,
    callNames: ['extension_center_resolve', 'extension_center_request_acquisition'],
  })
  const projected = assertPreAuthorizationAgentProjection({
    events,
    taskAttempts: taskAttempts('awaiting-approval', null, null),
    approvals: pendingApprovals(),
    sessions: sessionList(agentPreset),
    sessionId,
    agentPreset,
    cwd,
  })
  assert.equal(projected.attempt.sessionId, sessionId)
  assert.equal(projected.approval.state.status, 'pending')
})

test('proves same-Session continuation, successful Skill use, committed receipt, and continued task outcome', () => {
  const events = fulfilledEvents()
  const history = assertFulfilledAgentHistory(events)
  assert.equal(history.originalMessageId, originalMessageId)
  assert.equal(history.continuationMessageId, continuationMessageId)
  assert.equal(history.skillLoaded, true)
  assert.deepEqual(history.callNames, [
    'extension_center_resolve', 'extension_center_request_acquisition', 'skill',
  ])
  const proof = assertFulfilledAgentProjection({
    events,
    taskAttempts: taskAttempts('resuming', 'continued', 'continuation-claimed'),
    plan: consumedPlan(),
    operation: committedOperation(),
    sessions: sessionList(agentPreset),
    sessionId,
    agentPreset,
    cwd,
    expected: assertPreAuthorizationAgentHistory(initialEvents()),
  })
  assert.equal(proof.operationId, operationId)
  assert.equal(proof.receiptDigest, receiptDigest)
  assert.equal(proof.attempt.outcome, 'continued')
})

test('fails closed when the acquired Skill result is an error', () => {
  const events = fulfilledEvents().map(event => event.type === 'tool/result'
    && event.data.message.source.callId === 'call-skill-load'
    ? {
        ...event,
        data: {
          ...event.data,
          message: {
            ...event.data.message,
            content: event.data.message.content.map(block => ({ ...block, isError: true })),
          },
        },
      }
    : event)
  assert.throws(
    () => assertFulfilledAgentHistory(events),
    error => acceptanceCode(error, 'P0-AGENT-TOOL-ERROR'),
  )
})

test('fails closed when continuation precedes external authorization', () => {
  const events = initialEvents()
  events.splice(events.length - 1, 0, userEvent({
    id: continuationMessageId,
    text: CONTINUATION_PROMPT,
    source: { kind: 'plugin', plugin: 'dsh-plugin-extension-center' },
  }))
  resequence(events)
  assert.throws(
    () => assertPreAuthorizationAgentHistory(events),
    error => acceptanceCode(error, 'P0-AGENT-PREMATURE-CONTINUATION'),
  )
})

test('does not mistake another official plugin message for a Center continuation', () => {
  const events = initialEvents()
  events.splice(events.length - 1, 0, userEvent({
    id: 'message-other-plugin',
    text: 'Unrelated official plugin context.',
    source: { kind: 'plugin', plugin: 'dsh-system-prompt' },
  }))
  resequence(events)
  assert.doesNotThrow(() => assertPreAuthorizationAgentHistory(events))
})

test('fails closed when the Session preset changes across the continuation', () => {
  assert.throws(
    () => assertPreAuthorizationAgentProjection({
      events: initialEvents(),
      taskAttempts: taskAttempts('awaiting-approval', null, null),
      approvals: pendingApprovals(),
      sessions: sessionList('cordis'),
      sessionId,
      agentPreset,
      cwd,
    }),
    error => acceptanceCode(error, 'P0-AGENT-SESSION-PRESERVATION'),
  )
})

test('fails closed when the terminal task attempt is not continued', () => {
  assert.throws(
    () => assertFulfilledAgentProjection({
      events: fulfilledEvents(),
      taskAttempts: taskAttempts('resuming', 'failed', 'resume-failed'),
      plan: consumedPlan(),
      operation: committedOperation(),
      sessions: sessionList(agentPreset),
      sessionId,
      agentPreset,
      cwd,
      expected: assertPreAuthorizationAgentHistory(initialEvents()),
    }),
    error => acceptanceCode(error, 'P0-AGENT-CONTINUED-ATTEMPT'),
  )
})

function initialEvents() {
  const events = [
    userEvent({ id: originalMessageId, text: ORIGINAL_TASK, source: { kind: 'user', rpcId: 'prompt-1' } }),
    toolCall('call-resolve', 'extension_center_resolve', DOCUMENTATION_CAPABILITY_NEED),
    toolResult('call-resolve', {
      protocolVersion: 1,
      taskAttemptId,
      resolutionId,
      decision: 'acquisition-candidate',
      needDigest: `sha256:${'c'.repeat(64)}`,
      existingCapabilityId: null,
      candidateRefs: [DOCUMENTATION_SKILL_CANDIDATE],
      continuationId,
      extensionRef: null,
      managementAction: null,
      next: 'request-acquisition',
    }),
    toolCall('call-request', 'extension_center_request_acquisition', {
      resolutionId,
      candidateRef: DOCUMENTATION_SKILL_CANDIDATE,
      continuationId,
    }),
    toolResult('call-request', {
      protocolVersion: 1,
      resolutionId,
      continuationId,
      candidateRef: DOCUMENTATION_SKILL_CANDIDATE,
      planId,
      planHash,
      operationKind: 'install',
      status: 'approval-required',
    }),
    assistantEvent(APPROVAL_REQUIRED_MARKER, 'assistant-approval'),
    turnEnd(1),
  ]
  resequence(events)
  return events
}

function fulfilledEvents() {
  const events = initialEvents()
  events.push(
    userEvent({
      id: continuationMessageId,
      text: CONTINUATION_PROMPT,
      source: { kind: 'plugin', plugin: 'dsh-plugin-extension-center' },
    }),
    toolCall('call-skill-load', 'skill', { name: DOCUMENTATION_SKILL_NAME }),
    {
      type: 'tool/result',
      data: {
        message: {
          id: 'tool-message-call-skill-load',
          role: 'user',
          source: { kind: 'tool', callId: 'call-skill-load' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-skill-load',
            content: [{ type: 'text', text: `<skill_content name="${DOCUMENTATION_SKILL_NAME}">\nreal instructions\n</skill_content>` }],
            isError: false,
          }],
        },
      },
    },
    assistantEvent(FULFILLED_MARKER, 'assistant-fulfilled'),
    turnEnd(2),
  )
  resequence(events)
  return events
}

function userEvent({ id, text, source }) {
  return {
    type: 'user/message',
    data: { id, role: 'user', content: [{ type: 'text', text }], source },
  }
}

function assistantEvent(text, id) {
  return {
    type: 'assistant/message',
    data: {
      message: {
        id,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      },
    },
  }
}

function toolCall(callId, name, args) {
  return { type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } }
}

function toolResult(callId, value) {
  return {
    type: 'tool/result',
    data: {
      message: {
        id: `tool-message-${callId}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: JSON.stringify(value) }],
          isError: false,
        }],
      },
    },
  }
}

function turnEnd(turn) {
  return { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }
}

function resequence(events) {
  for (const [index, event] of events.entries()) {
    event.seq = index
    event.time = 1_000 + index
  }
}

function taskAttempts(phase, outcome, reason) {
  return {
    protocolVersion: 1,
    attempts: [{
      taskAttemptId,
      parentAttemptId: null,
      trigger: 'model',
      sessionId,
      originalMessageId,
      createdAtMs: 1,
      expiresAtMs: 999_999,
      updatedAtMs: 2,
      phase,
      outcome,
      reason,
      choice: null,
      management: null,
      acquisition: { resolutionId, candidateRef: DOCUMENTATION_SKILL_CANDIDATE, continuationId },
      retryContinuation: null,
    }],
  }
}

function plan(status) {
  return {
    status,
    plan: {
      hash: planHash,
      content: {
        planId,
        origin: 'task',
        candidateRef: DOCUMENTATION_SKILL_CANDIDATE,
        extensionKind: 'skill',
        operationKind: 'install',
        scopeKey: 'user',
        profileId: 'web',
      },
    },
  }
}

function pendingApprovals() {
  return {
    protocolVersion: 1,
    approvals: [{
      state: plan('pending'),
      configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
    }],
    configurations: [],
  }
}

function consumedPlan() {
  const state = plan('consumed')
  state.authorization = {
    operationId,
    planHash,
    origin: 'task',
    candidateRef: DOCUMENTATION_SKILL_CANDIDATE,
    operationKind: 'install',
  }
  return { protocolVersion: 1, state }
}

function committedOperation() {
  return {
    protocolVersion: 1,
    operation: {
      journal: {},
      recovered: false,
      projection: {
        operationId,
        planHash,
        phase: 'committed',
        receipt: {
          digest: receiptDigest,
          body: { operationId, planHash, outcome: 'committed' },
        },
      },
    },
  }
}

function sessionList(preset) {
  return {
    items: [{
      sessionId,
      updatedAt: 10,
      running: false,
      blank: false,
      cwd,
      agentPreset: preset,
    }],
  }
}

function finishKind(entry) {
  return entry.chunks.find(chunk => chunk.type === 'finish')?.reason.kind
}

function textDelta(entry) {
  return entry.chunks.find(chunk => chunk.type === 'text-delta')?.text
}

function acceptanceCode(error, code) {
  return error instanceof AcceptanceFailure && error.code === code
}
