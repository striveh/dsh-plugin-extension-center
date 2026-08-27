import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  AcceptanceFailure,
  TARGET_DSH_VERSION,
  delay,
  runChecked,
} from './support.mjs'

/** Exact published keyless adapter exercised by this assembled-Agent proof. */
export const OFFICIAL_REPLAY_PACKAGE = '@deepseek-ai/dsh-llm-replay'

/** Acceptance-only Bundle installed through the official profile plugin command. */
export const KEYLESS_REPLAY_BUNDLE = 'dsh-extension-center-keyless-agent-proof'

/** Exact catalog candidate selected by the deterministic capability need. */
export const DOCUMENTATION_SKILL_CANDIDATE =
  'skill:github-awesome-copilot/documentation-writer@d0d9d9f014abb27bf0d8321851867500a3a46bba'

/** Exact Skill name that must be loaded after continuation. */
export const DOCUMENTATION_SKILL_NAME = 'documentation-writer'

/** First-turn marker: the Agent stopped with mutation still awaiting a person. */
export const APPROVAL_REQUIRED_MARKER = 'EXTENSION_CENTER_APPROVAL_REQUIRED'

/** Second-turn marker: the same Agent loaded the acquired Skill and fulfilled the task. */
export const FULFILLED_MARKER = 'EXTENSION_CENTER_SKILL_CONTINUATION_FULFILLED'

/** Plugin-owned follow-up that resumes the original Session after verified acquisition. */
export const CONTINUATION_PROMPT =
  'The requested capability is now verified for the existing task. Re-check it and continue that task.'

/** Deterministic user task sent through the official Web RPC. */
export const ORIGINAL_TASK =
  'This task requires the documentation-writer Skill. Acquire it through the Extension Center, then load and use it.'

/** Exact need whose only admitted catalog result is the pinned documentation Skill. */
export const DOCUMENTATION_CAPABILITY_NEED = Object.freeze({
  outcomeTags: Object.freeze(['documentation']),
  inputModalities: Object.freeze(['text']),
  outputModalities: Object.freeze(['text']),
  scopeKey: 'user',
  profileId: 'web',
  requiredDataAccess: Object.freeze([]),
  maximumAuthority: Object.freeze(['model-context', 'network']),
})

const RESOLUTION_ID = '{{fromRequest:"resolutionId":"(resolution:[0-9a-f-]{36})"}}'
const CONTINUATION_ID = '{{fromRequest:"continuationId":"([0-9a-f-]{36})"}}'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const RESOLUTION = /^resolution:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const PROFILE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * Build the complete five-call official Replay script.
 *
 * The sidecar contains only model output. Every Tool result comes from the
 * packed Extension Center and the official Skill tool at runtime.
 */
export function buildKeylessAgentReplayOverride() {
  const acquisitionArguments = JSON.stringify({
    resolutionId: RESOLUTION_ID,
    candidateRef: DOCUMENTATION_SKILL_CANDIDATE,
    continuationId: CONTINUATION_ID,
  })
  return Object.freeze([
    toolEntry('call-capability-resolve', 'extension_center_resolve', JSON.stringify(DOCUMENTATION_CAPABILITY_NEED), 12),
    toolEntry('call-capability-request', 'extension_center_request_acquisition', acquisitionArguments, 16),
    textEntry(APPROVAL_REQUIRED_MARKER, 4),
    toolEntry('call-skill-load', 'skill', JSON.stringify({ name: DOCUMENTATION_SKILL_NAME }), 8),
    textEntry(FULFILLED_MARKER, 6),
  ])
}

/** Render the acceptance Bundle patch over the exact official Web profile. */
export function renderKeylessReplayBundlePatch(options) {
  if (!isAbsolute(options?.fixturePath ?? '') || !isAbsolute(options?.overridePath ?? '')) {
    throw new TypeError('keyless Replay fixture and override paths must be absolute')
  }
  return [
    '# Acceptance-only keyless Agent proof over the unmodified official Web profile.',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: llm-deepseek',
    '  disabled: true',
    '- insert:',
    '    - id: extension-center-keyless-agent-replay',
    `      name: '${OFFICIAL_REPLAY_PACKAGE}'`,
    '      config:',
    `        file: ${JSON.stringify(options.fixturePath)}`,
    `        overrideFile: ${JSON.stringify(options.overridePath)}`,
    '        paceMs: 0',
    '        providers:',
    '          - id: deepseek-official',
    '            name: DeepSeek Replay',
    '            models:',
    '              - id: deepseek-v4-flash',
    '                name: DeepSeek-V4-Flash Replay',
    '              - id: deepseek-v4-pro',
    '                name: DeepSeek-V4-Pro Replay',
    '',
  ].join('\n')
}

/**
 * Pack and install the acceptance-only Replay Bundle through `dsh plugin`.
 *
 * Call this after the Extension Center artifact is installed and before the
 * official Web Host starts, so the Replay layer is last in the profile.
 */
export async function installKeylessAgentReplayBundle(options) {
  const root = options?.root
  const dshBin = options?.dshBin
  const cwd = options?.cwd
  const dshHome = options?.dshHome
  const environment = options?.env
  const profileId = options?.profileId ?? 'web'
  if (![root, dshBin, cwd, dshHome].every(value => typeof value === 'string' && isAbsolute(value))) {
    throw new TypeError('Replay Bundle installation requires absolute root, dshBin, cwd, and dshHome paths')
  }
  if (environment === null || typeof environment !== 'object' || environment.DSH_HOME !== dshHome) {
    throw new TypeError('Replay Bundle installation environment must bind the exact DSH_HOME')
  }
  if (!PROFILE.test(profileId)) throw new TypeError('Replay Bundle profileId must be lower-kebab')

  const bundleRoot = join(root, 'bundle')
  const packedRoot = join(root, 'packed')
  await mkdir(root)
  await Promise.all([mkdir(bundleRoot), mkdir(packedRoot)])
  const fixturePath = join(bundleRoot, 'session.jsonl')
  const overridePath = join(bundleRoot, 'replay.override.json')
  const packageManifest = {
    name: KEYLESS_REPLAY_BUNDLE,
    version: '0.0.0',
    private: true,
    type: 'module',
    license: 'UNLICENSED',
    files: ['cordis.patch.yml', 'session.jsonl', 'replay.override.json'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dependencies: { [OFFICIAL_REPLAY_PACKAGE]: TARGET_DSH_VERSION },
  }
  await Promise.all([
    writeFile(join(bundleRoot, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`),
    writeFile(join(bundleRoot, 'cordis.patch.yml'), renderKeylessReplayBundlePatch({ fixturePath, overridePath })),
    writeFile(
      fixturePath,
      `${JSON.stringify({
        type: 'session',
        version: 0,
        id: 'recorded-extension-center-agent-acquisition',
        createdAt: 1,
        cwd: '/recorded-extension-center-workspace',
      })}\n`,
    ),
    writeFile(overridePath, `${JSON.stringify(buildKeylessAgentReplayOverride(), null, 2)}\n`),
  ])

  await runChecked('pnpm', ['pack', '--pack-destination', packedRoot], {
    cwd: bundleRoot,
    env: environment,
    timeoutMs: options.packTimeoutMs ?? 120_000,
  })
  const archives = (await readdir(packedRoot)).filter(name => name.endsWith('.tgz'))
  if (archives.length !== 1) {
    throw new AcceptanceFailure(
      'P0-AGENT-REPLAY-PACK',
      `Replay Bundle pack produced ${String(archives.length)} archives instead of one`,
    )
  }
  const archivePath = join(packedRoot, archives[0])
  const archiveDigest = `sha256:${createHash('sha256').update(await readFile(archivePath)).digest('hex')}`

  await runChecked(
    dshBin,
    ['plugin', '--profile', profileId, 'add', archivePath, '--ignore-scripts', '--save-exact'],
    {
      cwd,
      env: environment,
      timeoutMs: options.installTimeoutMs ?? 180_000,
    },
  )

  const profileRoot = join(dshHome, 'profiles', profileId)
  const profileManifest = parseJson(await readFile(join(profileRoot, 'package.json'), 'utf8'), 'installed profile manifest')
  const dependencies = record(profileManifest.dependencies, 'installed profile dependencies')
  const dsh = record(profileManifest.dsh, 'installed profile dsh manifest')
  const profile = record(dsh.profile, 'installed profile dsh.profile manifest')
  if (typeof dependencies[KEYLESS_REPLAY_BUNDLE] !== 'string'
    || !Array.isArray(profile.bundles)
    || profile.bundles.at(-1) !== KEYLESS_REPLAY_BUNDLE) {
    throw new AcceptanceFailure(
      'P0-AGENT-REPLAY-PROFILE',
      'official plugin installation did not append the packed Replay Bundle as the last Web profile layer',
    )
  }

  const installedBundleRoot = join(profileRoot, 'node_modules', KEYLESS_REPLAY_BUNDLE)
  const installedManifest = parseJson(
    await readFile(join(installedBundleRoot, 'package.json'), 'utf8'),
    'installed Replay Bundle manifest',
  )
  if (installedManifest.name !== KEYLESS_REPLAY_BUNDLE || installedManifest.version !== '0.0.0') {
    throw new AcceptanceFailure('P0-AGENT-REPLAY-ARTIFACT', 'profile resolved a different Replay Bundle artifact')
  }
  const requireFromBundle = createRequire(join(installedBundleRoot, 'package.json'))
  const replayManifestPath = requireFromBundle.resolve(`${OFFICIAL_REPLAY_PACKAGE}/package.json`)
  const replayManifest = parseJson(await readFile(replayManifestPath, 'utf8'), 'installed official Replay manifest')
  if (replayManifest.name !== OFFICIAL_REPLAY_PACKAGE || replayManifest.version !== TARGET_DSH_VERSION) {
    throw new AcceptanceFailure(
      'P0-AGENT-REPLAY-VERSION',
      `profile did not resolve ${OFFICIAL_REPLAY_PACKAGE}@${TARGET_DSH_VERSION}`,
    )
  }

  return Object.freeze({
    packageName: KEYLESS_REPLAY_BUNDLE,
    archivePath,
    archiveDigest,
    fixturePath,
    overridePath,
    profileRoot,
    profileDependencySpec: dependencies[KEYLESS_REPLAY_BUNDLE],
    replayPackage: OFFICIAL_REPLAY_PACKAGE,
    replayVersion: TARGET_DSH_VERSION,
  })
}

/** Convert official history entries into their raw ordered Session events. */
export function normalizeHistoryEvents(entries) {
  if (!Array.isArray(entries)) throw new TypeError('session.history events must be an array')
  let previousSeq = -1
  return Object.freeze(entries.map((entry, index) => {
    const wrapper = record(entry, `history entry ${String(index)}`)
    const event = Object.hasOwn(wrapper, 'event') ? record(wrapper.event, `history event ${String(index)}`) : wrapper
    if (typeof event.type !== 'string' || !Number.isSafeInteger(event.seq) || event.seq < 0
      || typeof event.time !== 'number' || event.seq <= previousSeq) {
      throw new AcceptanceFailure('P0-AGENT-HISTORY-ENVELOPE', 'session.history returned unordered or malformed events')
    }
    previousSeq = event.seq
    return event
  }))
}

/** Assert the settled first turn stopped at an exact external-approval handoff. */
export function assertPreAuthorizationAgentHistory(events, options = {}) {
  const task = options.task ?? ORIGINAL_TASK
  const humanMessages = events.filter(event => event.type === 'user/message' && messageSource(event)?.kind === 'user')
  if (humanMessages.length !== 1 || messageText(humanMessages[0]) !== task) {
    fail('P0-AGENT-ORIGINAL-TASK', 'the first turn did not preserve one exact human-authored task')
  }
  const originalMessageId = messageId(humanMessages[0])
  if (originalMessageId === null) fail('P0-AGENT-ORIGINAL-MESSAGE', 'the original task has no durable message id')
  if (events.some(event => {
    const source = event.type === 'user/message' ? messageSource(event) : null
    return source?.kind === 'plugin' && source.plugin === 'dsh-plugin-extension-center'
  })) {
    fail('P0-AGENT-PREMATURE-CONTINUATION', 'a plugin continuation appeared before external authorization')
  }

  const turnEnds = events.filter(event => event.type === 'turn/end')
  if (turnEnds.length !== 1 || turnEndReason(turnEnds[0]) !== 'completed') {
    fail('P0-AGENT-FIRST-TURN', 'the approval handoff is not one completed official Agent turn')
  }
  const calls = events.filter(event => event.type === 'tool/call')
  const callNames = calls.map(toolCallName)
  if (!isDeepStrictEqual(callNames, ['extension_center_resolve', 'extension_center_request_acquisition'])) {
    fail('P0-AGENT-CAPABILITY-TOOLS', `unexpected first-turn Tool order: ${callNames.join(', ')}`)
  }

  const resolveArguments = toolCallArguments(calls[0])
  if (!isDeepStrictEqual(resolveArguments, DOCUMENTATION_CAPABILITY_NEED)) {
    fail('P0-AGENT-RESOLVE-ARGUMENTS', 'extension_center_resolve did not receive the exact bounded documentation need')
  }
  const resolveResultEvent = oneToolResult(events, toolCallId(calls[0]))
  const resolveResult = parseJson(toolResultText(resolveResultEvent), 'extension_center_resolve result')
  if (resolveResult.decision !== 'acquisition-candidate'
    || resolveResult.next !== 'request-acquisition'
    || !RESOLUTION.test(resolveResult.resolutionId ?? '')
    || !UUID.test(resolveResult.continuationId ?? '')
    || !isDeepStrictEqual(resolveResult.candidateRefs, [DOCUMENTATION_SKILL_CANDIDATE])
    || typeof resolveResult.taskAttemptId !== 'string') {
    fail('P0-AGENT-RESOLUTION', 'extension_center_resolve did not return one exact opaque acquisition candidate')
  }

  const acquisitionArguments = toolCallArguments(calls[1])
  if (!isDeepStrictEqual(acquisitionArguments, {
    resolutionId: resolveResult.resolutionId,
    candidateRef: DOCUMENTATION_SKILL_CANDIDATE,
    continuationId: resolveResult.continuationId,
  })) {
    fail('P0-AGENT-ACQUISITION-ARGUMENTS', 'extension_center_request_acquisition did not echo the exact opaque bindings')
  }
  const acquisitionResultEvent = oneToolResult(events, toolCallId(calls[1]))
  const acquisitionResult = parseJson(toolResultText(acquisitionResultEvent), 'extension_center_request_acquisition result')
  if (acquisitionResult.status !== 'approval-required'
    || acquisitionResult.resolutionId !== resolveResult.resolutionId
    || acquisitionResult.candidateRef !== DOCUMENTATION_SKILL_CANDIDATE
    || acquisitionResult.continuationId !== resolveResult.continuationId
    || acquisitionResult.operationKind !== 'install'
    || typeof acquisitionResult.planId !== 'string'
    || !DIGEST.test(acquisitionResult.planHash ?? '')) {
    fail('P0-AGENT-ACQUISITION-RESULT', 'the acquisition Tool did not create one exact human-reviewable plan')
  }

  const approvalMarker = oneAssistantMarker(events, APPROVAL_REQUIRED_MARKER)
  assertEventOrder(events, [
    humanMessages[0],
    calls[0],
    resolveResultEvent,
    calls[1],
    acquisitionResultEvent,
    approvalMarker,
    turnEnds[0],
  ], 'P0-AGENT-FIRST-TURN-ORDER')
  return Object.freeze({
    originalMessageId,
    taskAttemptId: resolveResult.taskAttemptId,
    resolutionId: resolveResult.resolutionId,
    continuationId: resolveResult.continuationId,
    candidateRef: DOCUMENTATION_SKILL_CANDIDATE,
    planId: acquisitionResult.planId,
    planHash: acquisitionResult.planHash,
    callNames: Object.freeze(callNames),
  })
}

/** Assert same-Session continuation loaded the acquired Skill and then fulfilled the task. */
export function assertFulfilledAgentHistory(events, options = {}) {
  const firstTurnEnd = events.findIndex(event => event.type === 'turn/end')
  if (firstTurnEnd < 0) fail('P0-AGENT-FIRST-TURN', 'continued history has no first turn boundary')
  const initial = assertPreAuthorizationAgentHistory(events.slice(0, firstTurnEnd + 1), options)
  const turnEnds = events.filter(event => event.type === 'turn/end')
  if (turnEnds.length !== 2 || turnEnds.some(event => turnEndReason(event) !== 'completed')) {
    fail('P0-AGENT-CONTINUED-TURN', 'fulfilled history is not exactly two completed Agent turns')
  }
  const continuations = events.filter(event => {
    const source = event.type === 'user/message' ? messageSource(event) : null
    return source?.kind === 'plugin' && source.plugin === 'dsh-plugin-extension-center'
  })
  if (continuations.length !== 1 || messageText(continuations[0]) !== CONTINUATION_PROMPT) {
    fail('P0-AGENT-CONTINUATION-MESSAGE', 'history omitted the exact single-use Extension Center continuation')
  }
  const humanMessages = events.filter(event => event.type === 'user/message' && messageSource(event)?.kind === 'user')
  if (humanMessages.length !== 1 || messageId(humanMessages[0]) !== initial.originalMessageId) {
    fail('P0-AGENT-SAME-ORIGINAL', 'continuation replaced or duplicated the original human task')
  }

  const calls = events.filter(event => event.type === 'tool/call')
  const names = calls.map(toolCallName)
  if (!isDeepStrictEqual(names, ['extension_center_resolve', 'extension_center_request_acquisition', 'skill'])) {
    fail('P0-AGENT-CONTINUED-TOOLS', `unexpected full Agent Tool order: ${names.join(', ')}`)
  }
  const skillCall = calls[2]
  if (!isDeepStrictEqual(toolCallArguments(skillCall), { name: DOCUMENTATION_SKILL_NAME })) {
    fail('P0-AGENT-SKILL-ARGUMENTS', 'continued Agent did not load the exact acquired Skill')
  }
  const skillResult = oneToolResult(events, toolCallId(skillCall))
  if (!toolResultText(skillResult).includes(`<skill_content name="${DOCUMENTATION_SKILL_NAME}">`)) {
    fail('P0-AGENT-SKILL-RESULT', 'official Skill Tool did not return the acquired Skill instructions')
  }
  const fulfilledMarker = oneAssistantMarker(events, FULFILLED_MARKER)
  assertEventOrder(events, [
    turnEnds[0],
    continuations[0],
    skillCall,
    skillResult,
    fulfilledMarker,
    turnEnds[1],
  ], 'P0-AGENT-CONTINUATION-ORDER')
  return Object.freeze({
    ...initial,
    continuationMessageId: messageId(continuations[0]),
    callNames: Object.freeze(names),
    skillLoaded: true,
    fulfillmentMarker: FULFILLED_MARKER,
  })
}

/** Bind first-turn history to the exact pending task plan and original Session. */
export function assertPreAuthorizationAgentProjection(input) {
  const history = assertPreAuthorizationAgentHistory(input.events, { task: input.task })
  const attemptsValue = centerValue(input.taskAttempts, 'task-attempt/list')
  if (!Array.isArray(attemptsValue.attempts)) fail('P0-AGENT-TASK-ATTEMPT', 'task-attempt/list omitted attempts')
  const attempts = attemptsValue.attempts.filter(attempt => attempt?.sessionId === input.sessionId)
  if (attempts.length !== 1) fail('P0-AGENT-TASK-ATTEMPT', 'the original Session does not bind exactly one task attempt')
  const attempt = record(attempts[0], 'pending task attempt')
  const acquisition = record(attempt.acquisition, 'pending task acquisition')
  if (attempt.taskAttemptId !== history.taskAttemptId
    || attempt.originalMessageId !== history.originalMessageId
    || attempt.phase !== 'awaiting-approval'
    || attempt.outcome !== null
    || acquisition.resolutionId !== history.resolutionId
    || acquisition.candidateRef !== history.candidateRef
    || acquisition.continuationId !== history.continuationId) {
    fail('P0-AGENT-TASK-BINDING', 'pending task attempt does not bind the original Session and opaque acquisition')
  }

  const approvalsValue = centerValue(input.approvals, 'approval/list')
  if (!Array.isArray(approvalsValue.approvals) || !Array.isArray(approvalsValue.configurations)) {
    fail('P0-AGENT-PENDING-PLAN', 'approval/list omitted its bounded queues')
  }
  const approvals = approvalsValue.approvals.filter(row => row?.state?.plan?.hash === history.planHash)
  if (approvals.length !== 1 || approvalsValue.configurations.length !== 0) {
    fail('P0-AGENT-PENDING-PLAN', 'the acquisition did not create one directly reviewable task plan')
  }
  const approval = record(approvals[0], 'pending task approval')
  const state = record(approval.state, 'pending task approval state')
  assertPlanBinding(state, history, 'pending')
  if (!isDeepStrictEqual(approval.configuration, {
    modelInvocable: true,
    userInvocable: true,
    projectRoot: null,
  })) {
    fail('P0-AGENT-PENDING-CONFIGURATION', 'task plan did not bind the safe default Skill invocation policy')
  }
  const session = assertSessionProjection(input.sessions, input.sessionId, input.agentPreset, input.cwd)
  return Object.freeze({ history, attempt, approval, session })
}

/** Bind fulfilled history to the consumed plan, committed receipt, and terminal task attempt. */
export function assertFulfilledAgentProjection(input) {
  const history = assertFulfilledAgentHistory(input.events, { task: input.task })
  const expected = input.expected
  if (history.taskAttemptId !== expected.taskAttemptId
    || history.originalMessageId !== expected.originalMessageId
    || history.planHash !== expected.planHash
    || history.continuationId !== expected.continuationId) {
    fail('P0-AGENT-SAME-SESSION-BINDING', 'continued history does not retain the original task bindings')
  }

  const planValue = centerValue(input.plan, 'plan/get')
  const planState = record(planValue.state, 'consumed task plan')
  assertPlanBinding(planState, history, 'consumed')
  const authorization = record(planState.authorization, 'task plan authorization')
  if (authorization.origin !== 'task'
    || authorization.planHash !== history.planHash
    || authorization.candidateRef !== DOCUMENTATION_SKILL_CANDIDATE
    || authorization.operationKind !== 'install'
    || typeof authorization.operationId !== 'string') {
    fail('P0-AGENT-CONSUMED-PLAN', 'consumed plan authorization lost its exact task acquisition binding')
  }

  const operationValue = centerValue(input.operation, 'operation/get')
  const loaded = record(operationValue.operation, 'committed task operation')
  const projection = record(loaded.projection, 'committed task operation projection')
  const receipt = record(projection.receipt, 'committed task operation receipt')
  const receiptBody = record(receipt.body, 'committed task operation receipt body')
  if (projection.operationId !== authorization.operationId
    || projection.planHash !== history.planHash
    || projection.phase !== 'committed'
    || receiptBody.operationId !== authorization.operationId
    || receiptBody.planHash !== history.planHash
    || receiptBody.outcome !== 'committed'
    || !DIGEST.test(receipt.digest ?? '')) {
    fail('P0-AGENT-COMMITTED-RECEIPT', 'task acquisition has no exact committed operation receipt')
  }

  const attemptsValue = centerValue(input.taskAttempts, 'task-attempt/list')
  if (!Array.isArray(attemptsValue.attempts)) fail('P0-AGENT-CONTINUED-ATTEMPT', 'task-attempt/list omitted attempts')
  const attempts = attemptsValue.attempts.filter(attempt => attempt?.taskAttemptId === history.taskAttemptId)
  if (attempts.length !== 1) fail('P0-AGENT-CONTINUED-ATTEMPT', 'terminal task attempt is absent or duplicated')
  const attempt = record(attempts[0], 'continued task attempt')
  if (attempt.sessionId !== input.sessionId
    || attempt.originalMessageId !== history.originalMessageId
    || attempt.phase !== 'resuming'
    || attempt.outcome !== 'continued'
    || attempt.reason !== 'continuation-claimed') {
    fail('P0-AGENT-CONTINUED-ATTEMPT', 'task attempt did not terminate as continued on the original Session')
  }
  assertSessionProjection(input.sessions, input.sessionId, input.agentPreset, input.cwd)
  return Object.freeze({
    history,
    attempt,
    planState,
    operation: loaded,
    operationId: authorization.operationId,
    receiptDigest: receipt.digest,
  })
}

/**
 * Drive one real official Web Agent through acquisition and same-Session continuation.
 *
 * `authorize` is deliberately required and external. This helper never calls
 * `plan/decide` or `lifecycle/request`; a browser/human lane must consume the
 * exact pending plan supplied to the callback.
 */
export async function runKeylessAgentAcquisition(options) {
  const origin = loopbackOrigin(options?.origin)
  const cwd = resolve(options?.cwd ?? '')
  const agentPreset = options?.agentPreset ?? 'standard'
  const authorize = options?.authorize
  const timeoutMs = positiveInteger(options?.timeoutMs ?? 120_000, 'Agent acquisition timeoutMs')
  const intervalMs = positiveInteger(options?.intervalMs ?? 100, 'Agent acquisition intervalMs')
  const rpcTimeoutMs = positiveInteger(options?.rpcTimeoutMs ?? 30_000, 'Agent acquisition rpcTimeoutMs')
  if (!isAbsolute(options?.cwd ?? '') || typeof agentPreset !== 'string' || agentPreset.length === 0) {
    throw new TypeError('Agent acquisition requires an absolute cwd and non-empty agentPreset')
  }
  if (typeof authorize !== 'function') {
    throw new TypeError('Agent acquisition requires an external human-authorization callback')
  }
  const rpc = createPublicRpcClient(origin, rpcTimeoutMs)
  const created = record(await rpc.web('session.create', { cwd, agentPreset }), 'session.create value')
  if (typeof created.sessionId !== 'string' || created.agentPreset !== agentPreset) {
    fail('P0-AGENT-SESSION-CREATE', 'official Web did not create the requested preset-bound Session')
  }
  const sessionId = created.sessionId
  const prompted = record(await rpc.web('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: ORIGINAL_TASK }],
  }), 'session.prompt value')
  if (prompted.accepted !== true) fail('P0-AGENT-PROMPT', 'official Web did not accept the original task')

  const initialSettled = await waitForSettledHistory({
    rpc,
    sessionId,
    marker: APPROVAL_REQUIRED_MARKER,
    expectedTurns: 1,
    timeoutMs,
    intervalMs,
  })
  const [taskAttempts, approvals] = await Promise.all([
    rpc.center('task-attempt/list', { protocolVersion: 1 }),
    rpc.center('approval/list', { protocolVersion: 1 }),
  ])
  const before = assertPreAuthorizationAgentProjection({
    events: initialSettled.events,
    taskAttempts,
    approvals,
    sessions: initialSettled.sessions,
    sessionId,
    agentPreset,
    cwd,
    task: ORIGINAL_TASK,
  })

  await authorize(Object.freeze({
    origin,
    sessionId,
    agentPreset,
    taskAttempt: before.attempt,
    approval: before.approval,
    acquisition: before.history,
  }))

  const consumedPlan = await pollState({ timeoutMs, intervalMs }, async () => {
    const value = await rpc.center('plan/get', { protocolVersion: 1, planHash: before.history.planHash })
    const state = value?.state
    if (state?.status === 'rejected' || state?.status === 'expired') {
      fail('P0-AGENT-AUTHORIZATION-TERMINAL', `external authorization left the task plan ${state.status}`)
    }
    return state?.status === 'consumed' ? value : null
  }, 'the external human flow did not consume the exact task plan')
  const operationId = consumedPlan.state?.authorization?.operationId
  if (typeof operationId !== 'string') fail('P0-AGENT-CONSUMED-PLAN', 'consumed task plan omitted its operation id')

  const committedOperation = await pollState({ timeoutMs, intervalMs }, async () => {
    const value = await rpc.center('operation/get', { protocolVersion: 1, operationId })
    const phase = value?.operation?.projection?.phase
    if (['rolled-back', 'failed', 'recovery-required'].includes(phase)) {
      fail('P0-AGENT-OPERATION-TERMINAL', `task acquisition operation terminated as ${phase}`)
    }
    return phase === 'committed' ? value : null
  }, 'the task acquisition operation did not commit')

  const continuedAttempts = await pollState({ timeoutMs, intervalMs }, async () => {
    const value = await rpc.center('task-attempt/list', { protocolVersion: 1 })
    const attempt = value?.attempts?.find(candidate => candidate?.taskAttemptId === before.history.taskAttemptId)
    if (attempt?.outcome !== null && attempt?.outcome !== undefined && attempt.outcome !== 'continued') {
      fail(
        'P0-AGENT-CONTINUATION-TERMINAL',
        `task attempt terminated as ${String(attempt.outcome)}; reason=${String(attempt.reason)}; acquisitionContinuationId=${String(attempt.acquisition?.continuationId)}`,
      )
    }
    return attempt?.outcome === 'continued' ? value : null
  }, 'the original task attempt was not claimed for continuation')

  const fulfilled = await waitForSettledHistory({
    rpc,
    sessionId,
    marker: FULFILLED_MARKER,
    expectedTurns: 2,
    timeoutMs,
    intervalMs,
  })
  const proof = assertFulfilledAgentProjection({
    events: fulfilled.events,
    taskAttempts: continuedAttempts,
    plan: consumedPlan,
    operation: committedOperation,
    sessions: fulfilled.sessions,
    sessionId,
    agentPreset,
    cwd,
    task: ORIGINAL_TASK,
    expected: before.history,
  })
  return Object.freeze({
    proofKind: 'official-keyless-replay-agent-loop',
    modelEvidence: 'official-replay-not-provider-model',
    sessionId,
    agentPreset,
    originalMessageId: proof.history.originalMessageId,
    continuationMessageId: proof.history.continuationMessageId,
    taskAttemptId: proof.history.taskAttemptId,
    planHash: proof.history.planHash,
    operationId: proof.operationId,
    receiptDigest: proof.receiptDigest,
    candidateRef: DOCUMENTATION_SKILL_CANDIDATE,
    toolCallNames: proof.history.callNames,
    skillLoaded: proof.history.skillLoaded,
    taskAttemptOutcome: proof.attempt.outcome,
    fulfillmentMarker: proof.history.fulfillmentMarker,
  })
}

function toolEntry(callId, name, argumentsText, outputTokens) {
  return Object.freeze({
    kind: 'chunks',
    chunks: Object.freeze([
      Object.freeze({ type: 'block-start', index: 0, blockType: 'tool-call' }),
      Object.freeze({ type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsText }),
      Object.freeze({
        type: 'block-end',
        index: 0,
        block: Object.freeze({ type: 'tool-call', id: callId, name, arguments: argumentsText }),
      }),
      Object.freeze({ type: 'usage', usage: Object.freeze({ inputTokens: 20, outputTokens }) }),
      Object.freeze({ type: 'finish', reason: Object.freeze({ kind: 'tool-calls' }) }),
    ]),
  })
}

function textEntry(text, outputTokens) {
  return Object.freeze({
    kind: 'chunks',
    chunks: Object.freeze([
      Object.freeze({ type: 'block-start', index: 0, blockType: 'text' }),
      Object.freeze({ type: 'text-delta', index: 0, text }),
      Object.freeze({ type: 'block-end', index: 0, block: Object.freeze({ type: 'text', text }) }),
      Object.freeze({ type: 'usage', usage: Object.freeze({ inputTokens: 20, outputTokens }) }),
      Object.freeze({ type: 'finish', reason: Object.freeze({ kind: 'stop' }) }),
    ]),
  })
}

function createPublicRpcClient(origin, timeoutMs) {
  let sequence = 0
  const call = async (channel, method, payload) => {
    const rpcId = `extension-center-agent-${String(++sequence).padStart(3, '0')}`
    const prefix = channel === 'web' ? '/api/' : '/dsh-extension-center/'
    const response = await fetch(new URL(`${prefix}${method}`, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) fail('P0-AGENT-RPC-HTTP', `${method} failed over HTTP ${String(response.status)}`)
    let body
    try {
      body = await response.json()
    } catch {
      fail('P0-AGENT-RPC-ENVELOPE', `${method} did not return JSON`)
    }
    const envelope = record(body, `${method} response envelope`)
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
      fail('P0-AGENT-RPC-ENVELOPE', `${method} did not return its correlated server response`)
    }
    const result = record(envelope.result, `${method} response result`)
    if (result.ok !== true) {
      const error = isRecord(result.error) && typeof result.error.message === 'string'
        ? result.error.message
        : 'business failure without a safe message'
      fail('P0-AGENT-RPC-REFUSED', `${method} was refused: ${error}`)
    }
    if (!isRecord(result.value)) fail('P0-AGENT-RPC-VALUE', `${method} returned no object value`)
    return result.value
  }
  return Object.freeze({
    web: (method, payload) => call('web', method, payload),
    center: (method, payload) => call('center', method, payload),
  })
}

async function waitForSettledHistory(input) {
  return await pollState({ timeoutMs: input.timeoutMs, intervalMs: input.intervalMs }, async () => {
    const [history, sessions] = await Promise.all([
      input.rpc.web('session.history', { sessionId: input.sessionId, maxMessages: 128 }),
      input.rpc.web('session.list', {}),
    ])
    if (!Array.isArray(history.events) || history.hasMore !== false) {
      fail('P0-AGENT-HISTORY-PAGE', 'fresh Agent history did not fit in one bounded tail page')
    }
    const events = normalizeHistoryEvents(history.events)
    const turnEnds = events.filter(event => event.type === 'turn/end')
    if (turnEnds.length > input.expectedTurns) {
      fail('P0-AGENT-UNEXPECTED-TURN', 'the official Agent ran more turns than the Replay proof permits')
    }
    if (turnEnds.length === input.expectedTurns) {
      if (turnEnds.some(event => turnEndReason(event) !== 'completed')) {
        fail('P0-AGENT-TURN-FAILED', 'the official Agent reached a non-completed turn boundary')
      }
      if (!events.some(event => event.type === 'assistant/message' && assistantText(event).includes(input.marker))) {
        fail('P0-AGENT-MARKER-MISSING', `settled Agent turn omitted ${input.marker}`)
      }
      const row = sessionRow(sessions, input.sessionId)
      if (row.running === false) return { events, sessions }
    }
    return null
  }, `official Agent did not settle through marker ${input.marker}`)
}

async function pollState(options, observe, message) {
  const deadline = Date.now() + options.timeoutMs
  while (true) {
    const value = await observe()
    if (value !== null) return value
    const remaining = deadline - Date.now()
    if (remaining <= 0) fail('P0-AGENT-TIMEOUT', message)
    await delay(Math.min(options.intervalMs, remaining))
  }
}

function centerValue(value, label) {
  const output = record(value, `${label} value`)
  if (output.protocolVersion !== 1) fail('P0-AGENT-RPC-VERSION', `${label} returned a different protocol version`)
  return output
}

function assertPlanBinding(stateValue, history, expectedStatus) {
  const state = record(stateValue, `${expectedStatus} task plan state`)
  const plan = record(state.plan, `${expectedStatus} task plan`)
  const content = record(plan.content, `${expectedStatus} task plan content`)
  if (state.status !== expectedStatus
    || plan.hash !== history.planHash
    || content.planId !== history.planId
    || content.origin !== 'task'
    || content.candidateRef !== DOCUMENTATION_SKILL_CANDIDATE
    || content.extensionKind !== 'skill'
    || content.operationKind !== 'install'
    || content.scopeKey !== 'user'
    || content.profileId !== 'web') {
    fail('P0-AGENT-PLAN-BINDING', `${expectedStatus} plan does not bind the exact task acquisition`)
  }
}

function assertSessionProjection(value, sessionId, agentPreset, cwd) {
  const row = sessionRow(value, sessionId)
  if (row.running !== false
    || row.blank !== false
    || row.agentPreset !== agentPreset
    || row.cwd !== cwd
    || row.parentSessionId !== undefined) {
    fail('P0-AGENT-SESSION-PRESERVATION', 'settled continuation changed Session identity, cwd, or Agent preset')
  }
  return row
}

function sessionRow(value, sessionId) {
  const sessions = record(value, 'session.list value')
  if (!Array.isArray(sessions.items)) fail('P0-AGENT-SESSION-LIST', 'session.list omitted items')
  const rows = sessions.items.filter(row => row?.sessionId === sessionId)
  if (rows.length !== 1) fail('P0-AGENT-SESSION-LIST', 'session.list omitted or duplicated the original Session')
  return record(rows[0], 'original Session row')
}

function oneToolResult(events, callId) {
  const results = events.filter(event => event.type === 'tool/result' && toolResultCallId(event) === callId)
  if (results.length !== 1) fail('P0-AGENT-TOOL-RESULT', `Tool call ${callId} has ${String(results.length)} durable results`)
  if (toolResultIsError(results[0])) fail('P0-AGENT-TOOL-ERROR', `Tool call ${callId} returned an error`)
  return results[0]
}

function oneAssistantMarker(events, marker) {
  const messages = events.filter(event => event.type === 'assistant/message' && assistantText(event).includes(marker))
  if (messages.length !== 1) fail('P0-AGENT-ASSISTANT-MARKER', `history contains ${String(messages.length)} ${marker} markers`)
  return messages[0]
}

function toolCallName(event) {
  const data = record(event.data, 'tool/call data')
  if (typeof data.name !== 'string') fail('P0-AGENT-TOOL-CALL', 'tool/call omitted its name')
  return data.name
}

function toolCallId(event) {
  const data = record(event.data, 'tool/call data')
  if (typeof data.callId !== 'string' || data.callId.length === 0) {
    fail('P0-AGENT-TOOL-CALL', 'tool/call omitted its call id')
  }
  return data.callId
}

function toolCallArguments(event) {
  const data = record(event.data, 'tool/call data')
  if (typeof data.arguments !== 'string') fail('P0-AGENT-TOOL-CALL', 'tool/call arguments were not durable JSON text')
  return parseJson(data.arguments, `${toolCallName(event)} arguments`)
}

function toolResultCallId(event) {
  const data = record(event.data, 'tool/result data')
  if (typeof data.callId === 'string') return data.callId
  if (isRecord(data.message) && isRecord(data.message.source) && typeof data.message.source.callId === 'string') {
    return data.message.source.callId
  }
  return null
}

function toolResultIsError(event) {
  const data = record(event.data, 'tool/result data')
  if (typeof data.isError === 'boolean') return data.isError
  if (isRecord(data.message) && Array.isArray(data.message.content)) {
    const blocks = data.message.content.filter(block => block?.type === 'tool-result')
    if (blocks.length === 1 && typeof blocks[0].isError === 'boolean') return blocks[0].isError
  }
  fail('P0-AGENT-TOOL-RESULT', 'tool/result omitted its success state')
}

function toolResultText(event) {
  const data = record(event.data, 'tool/result data')
  if (Array.isArray(data.content)) return contentText(data.content)
  if (isRecord(data.message) && Array.isArray(data.message.content)) {
    return data.message.content.filter(block => block?.type === 'tool-result')
      .map(block => contentText(block.content)).join('')
  }
  fail('P0-AGENT-TOOL-RESULT', 'tool/result omitted its rendered content')
}

function messageData(event) {
  const data = record(event.data, `${event.type} data`)
  return isRecord(data.message) ? data.message : data
}

function messageSource(event) {
  const source = messageData(event).source
  return isRecord(source) ? source : null
}

function messageId(event) {
  const id = messageData(event).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function messageText(event) {
  return contentText(messageData(event).content)
}

function assistantText(event) {
  return messageText(event)
}

function contentText(value) {
  if (!Array.isArray(value)) return ''
  return value.map(block => {
    if (!isRecord(block)) return ''
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    if (block.type === 'tool-result') return contentText(block.content)
    return ''
  }).join('')
}

function turnEndReason(event) {
  const data = record(event.data, 'turn/end data')
  return isRecord(data.reason) && typeof data.reason.kind === 'string' ? data.reason.kind : null
}

function assertEventOrder(events, ordered, code) {
  let prior = -1
  for (const event of ordered) {
    const index = events.indexOf(event)
    if (index <= prior) fail(code, 'durable Session events appeared outside their required order')
    prior = index
  }
}

function parseJson(text, label) {
  try {
    const value = JSON.parse(text)
    if (!isRecord(value)) fail('P0-AGENT-JSON', `${label} is not a JSON object`)
    return value
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error
    fail('P0-AGENT-JSON', `${label} is not valid JSON`)
  }
}

function loopbackOrigin(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Agent acquisition origin must be an absolute URL')
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
  if (parsed.origin !== value || parsed.protocol !== 'http:' || !loopback || parsed.port === '') {
    throw new TypeError('Agent acquisition origin must be one exact loopback HTTP origin with a port')
  }
  return parsed.origin
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`)
  return value
}

function record(value, label) {
  if (!isRecord(value)) fail('P0-AGENT-RECORD', `${label} must be an object`)
  return value
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(code, message) {
  throw new AcceptanceFailure(code, message)
}
