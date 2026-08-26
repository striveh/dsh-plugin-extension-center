import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  canonicalSha256,
  ExtensionDomainError,
  isArtifactIntegrity,
  type ExtensionDomainErrorCode,
} from '../src/domain/index.ts'
import {
  consumeApprovedPlan,
  createImmutablePlan,
  createPlanAuthorizationState,
  decidePlan,
  decodeImmutablePlan,
  type ImmutablePlan,
  type PlanAuthorizationState,
  type PlanContent,
  type PlanUseContext,
} from '../src/plans/index.ts'
import {
  acquireTarget,
  createOperationJournal,
  createTargetLockState,
  issueOperationReceipt,
  operationJournalCheckpoint,
  recordOperationMutation,
  recordOperationVerification,
  releaseTarget,
  transitionOperation,
  verifyOperationJournal,
  type OperationJournal,
} from '../src/operations/index.ts'
import { TEST_RECOVERY_EXECUTABLE_BINDING } from './support/recovery-binding.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const CREATED_AT = Date.parse('2026-08-25T08:00:00.000Z')
const EXPIRES_AT = CREATED_AT + 60_000

function digest(label: string) {
  return canonicalSha256({ label })
}

function planContent(): PlanContent {
  return {
    schemaVersion: 1,
    singleUse: true,
    planId: 'plan:skill-install:1',
    intentId: 'intent:store:1',
    origin: 'store',
    candidateRef: 'skill:example@revision-1',
    extensionKind: 'skill',
    extensionId: 'example',
    managedObject: 'artifact',
    externalRuntimeAction: 'download',
    runtimeBinding: null,
    artifactRevision: 'revision-1',
    artifactIntegrity: digest('artifact'),
    artifactUrl: 'https://example.test/example.md',
    artifactSizeBytes: 123,
    operationKind: 'install',
    desiredState: 'enabled',
    targetKey: 'skill-root:user/example',
    ownerKey: 'skill-filesystem:user',
    scopeKey: 'agent:agent-1:/workspace',
    profileId: 'profile:web',
    idempotencyKey: 'idempotency:store:1',
    authorityDigest: digest('authority'),
    configurationDigest: digest('configuration'),
    retentionDigest: digest('retention'),
    reviewEvidence: testReviewEvidence('skill', 'install'),
    mutationDigest: digest('mutation'),
    verificationDigest: digest('verification'),
    restartRequired: false,
    createdAtMs: CREATED_AT,
    expiresAtMs: EXPIRES_AT,
    fences: {
      catalogRevision: 7,
      inventoryRevision: digest('inventory-7'),
      targetRevision: 'target:absent',
      ownerRevision: 'owner:4',
      scopeRevision: 'scope:12',
      profileRevision: 'profile:9',
    },
  }
}

function useContext(plan: ImmutablePlan): PlanUseContext {
  return {
    operationKind: plan.content.operationKind,
    targetKey: plan.content.targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    fences: plan.content.fences,
  }
}

function decision(plan: ImmutablePlan, value: 'approve' | 'reject' = 'approve') {
  return {
    planId: plan.content.planId,
    planHash: plan.hash,
    operationKind: plan.content.operationKind,
    decision: value,
  } as const
}

function expectDomainCode(action: () => unknown, code: ExtensionDomainErrorCode): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionDomainError)
    expect((error as ExtensionDomainError).code).toBe(code)
    return
  }
  throw new Error(`expected domain error ${code}`)
}

function approvedState(plan: ImmutablePlan, context = useContext(plan)) {
  const transition = decidePlan(
    createPlanAuthorizationState(plan),
    decision(plan),
    context,
    CREATED_AT + 1,
  )
  if (transition.state.status !== 'approved') throw new Error('fixture plan was not approved')
  return transition.state
}

describe('full P0 canonical plan kernel', () => {
  it('hashes strict JSON deterministically without accepting non-JSON ambiguity', () => {
    const left = { z: [{ b: 2, a: 1 }], a: { y: true, x: null } }
    const right = { a: { x: null, y: true }, z: [{ a: 1, b: 2 }] }
    expect(canonicalJson(left)).toBe('{"a":{"x":null,"y":true},"z":[{"a":1,"b":2}]}')
    expect(canonicalJson(right)).toBe(canonicalJson(left))
    expect(canonicalSha256(right)).toBe(canonicalSha256(left))

    expectDomainCode(() => canonicalJson({ value: undefined }), 'invalid-data')
    expectDomainCode(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), 'invalid-data')
    expectDomainCode(() => canonicalJson(new Date(0)), 'invalid-data')
    const sparse: unknown[] = []
    sparse.length = 1
    expectDomainCode(() => canonicalJson(sparse), 'invalid-data')

    expect(isArtifactIntegrity(`sha512:${'a'.repeat(128)}`)).toBe(true)
    expect(isArtifactIntegrity('sha512:xL84LD46WmZUGGWdU2Rf6i/oDtMMdwiJ3k3I5bkku51khl7cS88SLKfkUFNa9478GtHjT46wTqTyly7aoNmneQ==')).toBe(true)
    expect(isArtifactIntegrity('sha512:xL84LD46WmZUGGWdU2Rf6i/oDtMMdwiJ3k3I5bkku51khl7cS88SLKfkUFNa9478GtHjT46wTqTyly7aoNmneQ=A')).toBe(false)
  })

  it('freezes exact plan content and rejects strict-codec or digest tampering', () => {
    const plan = createImmutablePlan(planContent())
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.content)).toBe(true)
    expect(Object.isFrozen(plan.content.fences)).toBe(true)
    expect(Reflect.set(plan.content, 'targetKey', 'skill-root:user/attacker')).toBe(false)

    const tampered = structuredClone(plan)
    tampered.content.targetKey = 'skill-root:user/attacker'
    expectDomainCode(() => decodeImmutablePlan(tampered), 'plan-integrity')

    const evidenceTampered = structuredClone(plan)
    if (evidenceTampered.content.reviewEvidence.kind !== 'skill') throw new Error('fixture evidence kind changed')
    evidenceTampered.content.reviewEvidence.body.after = '# attacker-controlled body\n'
    expectDomainCode(() => decodeImmutablePlan(evidenceTampered), 'plan-integrity')

    const evidenceWithUnknownField = structuredClone(plan) as unknown as {
      content: { reviewEvidence: Record<string, unknown> }
      hash: string
    }
    evidenceWithUnknownField.content.reviewEvidence.communitySummary = 'untrusted prose'
    expectDomainCode(() => decodeImmutablePlan(evidenceWithUnknownField), 'invalid-data')
    expectDomainCode(() => decodeImmutablePlan({ ...plan, injected: true }), 'invalid-data')

    const forgedState = {
      status: 'pending',
      plan: tampered,
    } as unknown as PlanAuthorizationState
    expectDomainCode(
      () => decidePlan(forgedState, decision(plan), useContext(plan), CREATED_AT + 1),
      'plan-integrity',
    )
  })

  it('rejects expiry, replay, wrong identities, and every stale revision fence', () => {
    const plan = createImmutablePlan(planContent())
    const pending = createPlanAuthorizationState(plan)
    const context = useContext(plan)

    const expired = decidePlan(pending, decision(plan), context, EXPIRES_AT)
    expect(expired).toMatchObject({ state: { status: 'expired' }, authorization: null })
    expectDomainCode(
      () => consumeApprovedPlan(expired.state, 'operation:expired', context, EXPIRES_AT, TEST_RECOVERY_EXECUTABLE_BINDING),
      'plan-replay',
    )

    const wrongDecision = { ...decision(plan), operationKind: 'update' }
    expectDomainCode(
      () => decidePlan(pending, wrongDecision, context, CREATED_AT + 1),
      'plan-context-mismatch',
    )
    for (const [field, replacement] of [
      ['targetKey', 'skill-root:user/other'],
      ['ownerKey', 'skill-filesystem:other'],
      ['scopeKey', 'agent:other:/workspace'],
      ['profileId', 'profile:other'],
    ] as const) {
      expectDomainCode(
        () => decidePlan(pending, decision(plan), { ...context, [field]: replacement }, CREATED_AT + 1),
        'plan-context-mismatch',
      )
    }

    const staleFences = [
      { ...context.fences, catalogRevision: context.fences.catalogRevision + 1 },
      { ...context.fences, inventoryRevision: digest('inventory-8') },
      { ...context.fences, targetRevision: 'target:external-edit' },
      { ...context.fences, ownerRevision: 'owner:5' },
      { ...context.fences, scopeRevision: 'scope:13' },
      { ...context.fences, profileRevision: 'profile:10' },
    ]
    for (const fences of staleFences) {
      expectDomainCode(
        () => decidePlan(pending, decision(plan), { ...context, fences }, CREATED_AT + 1),
        'revision-stale',
      )
    }

    const approved = approvedState(plan)
    expectDomainCode(
      () => decidePlan(approved, decision(plan), context, CREATED_AT + 2),
      'plan-replay',
    )
    expectDomainCode(
      () => consumeApprovedPlan(approved, 'operation:late', context, EXPIRES_AT, TEST_RECOVERY_EXECUTABLE_BINDING),
      'plan-expired',
    )
    const consumed = consumeApprovedPlan(
      approved,
      'operation:1',
      context,
      CREATED_AT + 2,
      TEST_RECOVERY_EXECUTABLE_BINDING,
    )
    expect(consumed.authorization).toMatchObject({
      operationId: 'operation:1',
      planHash: plan.hash,
      targetKey: plan.content.targetKey,
    })
    expectDomainCode(
      () => consumeApprovedPlan(
        consumed.state,
        'operation:replay',
        context,
        CREATED_AT + 3,
        TEST_RECOVERY_EXECUTABLE_BINDING,
      ),
      'plan-replay',
    )
  })

  it('keeps rejection terminal and emits no mutation authorization', () => {
    const plan = createImmutablePlan(planContent())
    const pending = createPlanAuthorizationState(plan)
    const locks = createTargetLockState()
    const journals: OperationJournal[] = []
    const rejected = decidePlan(pending, decision(plan, 'reject'), useContext(plan), CREATED_AT + 1)

    expect(rejected).toMatchObject({ state: { status: 'rejected' }, authorization: null })
    expect(locks.leases).toHaveLength(0)
    expect(journals).toHaveLength(0)
    expectDomainCode(
      () => consumeApprovedPlan(
        rejected.state,
        'operation:forbidden',
        useContext(plan),
        CREATED_AT + 2,
        TEST_RECOVERY_EXECUTABLE_BINDING,
      ),
      'plan-replay',
    )
    expect(pending.status).toBe('pending')
  })
})

describe('full P0 operation journal kernel', () => {
  function committedJournal(): OperationJournal {
    const plan = createImmutablePlan(planContent())
    const approved = approvedState(plan)
    const { authorization } = consumeApprovedPlan(
      approved,
      'operation:journal:1',
      useContext(plan),
      CREATED_AT + 2,
      TEST_RECOVERY_EXECUTABLE_BINDING,
    )
    let journal = createOperationJournal(authorization, digest('before'), CREATED_AT + 3)
    journal = transitionOperation(journal, 'staging', null, null, CREATED_AT + 4)
    journal = transitionOperation(journal, 'applying', null, null, CREATED_AT + 5)
    journal = recordOperationMutation(journal, digest('applied-target'), CREATED_AT + 6)
    journal = transitionOperation(journal, 'verifying', null, null, CREATED_AT + 7)
    journal = recordOperationVerification(journal, digest('owner-active'), CREATED_AT + 8)
    return transitionOperation(journal, 'committed', digest('after'), null, CREATED_AT + 9)
  }

  it('projects an append-only digest chain and derives one terminal receipt', () => {
    const terminal = committedJournal()
    const terminalLength = terminal.events.length
    const issued = issueOperationReceipt(terminal, CREATED_AT + 10)
    const projection = verifyOperationJournal(issued.journal, operationJournalCheckpoint(issued.journal))

    expect(terminal.events).toHaveLength(terminalLength)
    expect(issued.journal.events).toHaveLength(terminalLength + 1)
    expect(Object.isFrozen(issued.journal.events)).toBe(true)
    expect(projection).toMatchObject({
      phase: 'committed',
      beforeDigest: digest('before'),
      afterDigest: digest('after'),
      mutationDigests: [digest('applied-target')],
      verificationDigests: [digest('owner-active')],
      receipt: { digest: issued.receipt.digest },
    })
    expect(issued.receipt.body.journalEventCount).toBe(terminalLength)
    expect(issued.receipt.body.journalHeadDigest).toBe(terminal.events[terminalLength - 1]!.digest)
    expect(issued.receipt.body).toMatchObject({
      planEvidence: {
        candidateRef: planContent().candidateRef,
        artifactRevision: planContent().artifactRevision,
        artifactIntegrity: planContent().artifactIntegrity,
        scopeKey: planContent().scopeKey,
        profileId: planContent().profileId,
        authorityDigest: planContent().authorityDigest,
        configurationDigest: planContent().configurationDigest,
        retentionDigest: planContent().retentionDigest,
        reviewEvidence: planContent().reviewEvidence,
      },
      evidence: {
        mutation: 'proven',
        verification: 'proven',
        rollback: { attempted: false, status: 'not-required' },
        restart: { required: false, status: 'not-required' },
        recovery: { attempts: 0, status: 'not-required' },
        notProven: [],
      },
    })
    expect(canonicalJson(issued.receipt)).not.toContain('"configuration":')
    expectDomainCode(() => issueOperationReceipt(issued.journal, CREATED_AT + 11), 'journal-transition')
  })

  it('detects digest corruption and valid-prefix truncation against an anchored head', () => {
    const issued = issueOperationReceipt(committedJournal(), CREATED_AT + 10)
    const checkpoint = operationJournalCheckpoint(issued.journal)
    const truncated = structuredClone(issued.journal)
    truncated.events = truncated.events.slice(0, -1)
    expectDomainCode(() => verifyOperationJournal(truncated, checkpoint), 'journal-truncated')

    const corrupted = structuredClone(issued.journal)
    const mutation = corrupted.events.find(event => event.entry.type === 'mutation-observed')
    if (mutation === undefined || mutation.entry.type !== 'mutation-observed') {
      throw new Error('fixture mutation event is missing')
    }
    mutation.entry.mutationDigest = digest('tampered-mutation')
    expectDomainCode(() => verifyOperationJournal(corrupted), 'journal-corrupt')

    const receiptTamper = structuredClone(issued.journal)
    const receiptEvent = receiptTamper.events[receiptTamper.events.length - 1]!
    if (receiptEvent.entry.type !== 'receipt-issued') throw new Error('fixture receipt event is missing')
    receiptEvent.entry.receipt.body.afterDigest = digest('tampered-after')
    expectDomainCode(() => verifyOperationJournal(receiptTamper), 'journal-corrupt')
  })

  it('serializes operations independently per exact target without mutating prior states', () => {
    const empty = createTargetLockState()
    const first = acquireTarget(empty, 'skill-root:user/example', 'operation:1')
    expect(empty.leases).toHaveLength(0)
    expect(first.leases).toEqual([
      { targetKey: 'skill-root:user/example', operationId: 'operation:1' },
    ])
    expectDomainCode(
      () => acquireTarget(first, 'skill-root:user/example', 'operation:2'),
      'target-busy',
    )

    const parallel = acquireTarget(first, 'mcp-row:filesystem', 'operation:2')
    expect(parallel.leases).toHaveLength(2)
    expectDomainCode(
      () => acquireTarget(parallel, 'profile:web', 'operation:2'),
      'target-lock-mismatch',
    )
    expectDomainCode(
      () => releaseTarget(parallel, 'skill-root:user/example', 'operation:2'),
      'target-lock-mismatch',
    )

    const released = releaseTarget(parallel, 'skill-root:user/example', 'operation:1')
    const successor = acquireTarget(released, 'skill-root:user/example', 'operation:3')
    expect(successor.leases).toContainEqual({
      targetKey: 'skill-root:user/example',
      operationId: 'operation:3',
    })
    expect(parallel.leases).toHaveLength(2)
  })
})
