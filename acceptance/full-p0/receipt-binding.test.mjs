import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  canonicalJson,
  canonicalSha256,
  verifyImmutablePlanDigest,
  verifyOperationReceiptJournal,
  verifyReceiptInventory,
  verifyTerminalReceipt,
  verifyTerminalReceiptPlanBinding,
} from './receipt-binding.mjs'

const bodies = []

afterEach(() => {
  bodies.splice(0)
})

function recoveryPath(name) {
  return process.platform === 'win32' ? `C:\\dsh-test\\${name}` : `/dsh-test/${name}`
}

function skillReviewEvidence() {
  const text = '---\nname: example\ndescription: Example\n---\nExample body\n'
  const digest = canonicalSha256({ text })
  return {
    schemaVersion: 1,
    kind: 'skill',
    operationKind: 'install',
    checks: [
      { code: 'catalog-admission', phase: 'planning' },
      { code: 'skill-file-manifest', phase: 'prepare' },
      { code: 'owner-mutation', phase: 'apply' },
      { code: 'merged-skill-winner', phase: 'verify' },
    ],
    removed: [],
    retained: [],
    credentialChoice: 'not-applicable',
    rollbackPoint: { kind: 'absent-state', id: 'skill:web:user:example', digest: canonicalSha256(null) },
    rollbackLimits: ['dsh-managed-state-only'],
    notProven: ['catalog-admission-is-not-security-audit'],
    files: [{
      path: 'SKILL.md',
      change: 'add',
      beforeDigest: null,
      afterDigest: digest,
      sizeBytes: Buffer.byteLength(text),
      executableBefore: false,
      executableAfter: false,
      linkBefore: null,
      linkAfter: null,
    }],
    body: { before: null, after: text, beforeDigest: null, afterDigest: digest },
    invocation: {
      beforeModelInvocable: null,
      beforeUserInvocable: null,
      afterModelInvocable: true,
      afterUserInvocable: true,
    },
  }
}

function operationPlanEvidence() {
  const evidence = skillReviewEvidence()
  return {
    origin: 'store',
    candidateRef: 'skill:example@1',
    extensionKind: 'skill',
    extensionId: 'example',
    artifactRevision: '1',
    artifactIntegrity: canonicalSha256({ artifact: 'example' }),
    artifactUrl: 'https://example.invalid/SKILL.md',
    artifactSizeBytes: 42,
    desiredState: 'enabled',
    ownerKey: 'skill:user',
    scopeKey: 'user',
    profileId: 'web',
    idempotencyKey: 'fixture-install-one',
    authorityDigest: canonicalSha256({ authority: true }),
    configurationDigest: canonicalSha256({ configuration: true }),
    retentionDigest: canonicalSha256({ retention: true }),
    mutationDigest: canonicalSha256({ mutation: 'planned' }),
    verificationDigest: canonicalSha256({ verification: 'planned' }),
    reviewEvidence: evidence,
    restartRequired: false,
    fences: {
      catalogRevision: 1,
      inventoryRevision: canonicalSha256({ inventory: 1 }),
      targetRevision: 'absent',
      ownerRevision: 'owner:1',
      scopeRevision: 'scope:1',
      profileRevision: 'profile:1',
    },
    recoveryExecutable: {
      schemaVersion: 2,
      executablePath: recoveryPath('break-glass.mjs'),
      executableSha256: canonicalSha256({ executable: true }),
      hostCliPath: recoveryPath('dsh'),
      hostCliSha256: canonicalSha256({ cli: true }),
      hostHome: recoveryPath('home'),
      packageVersion: '0.1.0',
      platform: ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'linux',
      arch: process.arch,
    },
  }
}

function immutablePlanContent() {
  const { recoveryExecutable: _recoveryExecutable, ...evidence } = operationPlanEvidence()
  return {
    schemaVersion: 1,
    singleUse: true,
    planId: 'plan:one',
    intentId: 'intent:one',
    ...evidence,
    managedObject: 'artifact',
    externalRuntimeAction: 'download',
    runtimeBinding: null,
    operationKind: 'install',
    targetKey: 'skill:web:user:example',
    createdAtMs: 1,
    expiresAtMs: 60_001,
  }
}

function receiptBody(operationId = 'operation:one', content = immutablePlanContent()) {
  const planEvidence = operationPlanEvidence()
  const body = {
    schemaVersion: 1,
    operationId,
    planId: content.planId,
    planHash: canonicalSha256(content),
    operationKind: content.operationKind,
    managedObject: content.managedObject,
    externalRuntimeAction: content.externalRuntimeAction,
    runtimeBinding: content.runtimeBinding,
    planEvidence,
    targetKey: content.targetKey,
    outcome: 'committed',
    beforeDigest: canonicalSha256(null),
    afterDigest: canonicalSha256({ installed: true }),
    mutationDigests: [canonicalSha256({ mutation: true })],
    verificationDigests: [canonicalSha256({ verified: true })],
    evidence: {
      checksActuallyRun: planEvidence.reviewEvidence.checks,
      mutation: 'proven',
      verification: 'proven',
      rollback: { attempted: false, status: 'not-required' },
      restart: { required: false, status: 'not-required' },
      recovery: { attempts: 0, status: 'not-required' },
      notProven: [],
    },
    journalEventCount: 7,
    journalHeadDigest: null,
    issuedAtMs: 8,
  }
  bodies.push(body)
  return body
}

function event(operationId, targetKey, sequence, previousDigest, atMs, entry) {
  const unsigned = { schemaVersion: 1, operationId, targetKey, sequence, previousDigest, atMs, entry }
  return { ...unsigned, digest: canonicalSha256(unsigned) }
}

function fixture(operationId = 'operation:one') {
  const content = immutablePlanContent()
  const plan = { content, hash: canonicalSha256(content) }
  const body = receiptBody(operationId, content)
  const events = []
  events.push(event(operationId, body.targetKey, 1, null, 1, {
    type: 'operation-opened',
    planId: body.planId,
    planHash: body.planHash,
    operationKind: body.operationKind,
    managedObject: body.managedObject,
    externalRuntimeAction: body.externalRuntimeAction,
    runtimeBinding: body.runtimeBinding,
    planEvidence: body.planEvidence,
    beforeDigest: body.beforeDigest,
  }))
  events.push(event(operationId, body.targetKey, 2, events.at(-1).digest, 2, {
    type: 'phase-transition', from: 'authorized', to: 'staging', evidenceDigest: null, reason: null,
  }))
  events.push(event(operationId, body.targetKey, 3, events.at(-1).digest, 3, {
    type: 'phase-transition', from: 'staging', to: 'applying', evidenceDigest: null, reason: null,
  }))
  events.push(event(operationId, body.targetKey, 4, events.at(-1).digest, 4, {
    type: 'mutation-observed', mutationDigest: body.mutationDigests[0],
  }))
  events.push(event(operationId, body.targetKey, 5, events.at(-1).digest, 5, {
    type: 'phase-transition', from: 'applying', to: 'verifying', evidenceDigest: null, reason: null,
  }))
  events.push(event(operationId, body.targetKey, 6, events.at(-1).digest, 6, {
    type: 'verification-observed', verificationDigest: body.verificationDigests[0],
  }))
  events.push(event(operationId, body.targetKey, 7, events.at(-1).digest, 7, {
    type: 'phase-transition', from: 'verifying', to: body.outcome, evidenceDigest: body.afterDigest, reason: null,
  }))
  body.journalHeadDigest = events.at(-1).digest
  const terminalReceipt = { body, digest: canonicalSha256(body) }
  events.push(event(operationId, body.targetKey, 8, events.at(-1).digest, body.issuedAtMs, {
    type: 'receipt-issued', receipt: terminalReceipt,
  }))
  return {
    plan,
    receipt: terminalReceipt,
    operation: {
      journal: { schemaVersion: 1, operationId, targetKey: body.targetKey, events },
      projection: {
        operationId,
        targetKey: body.targetKey,
        planId: body.planId,
        planHash: body.planHash,
        operationKind: body.operationKind,
        managedObject: body.managedObject,
        externalRuntimeAction: body.externalRuntimeAction,
        runtimeBinding: body.runtimeBinding,
        planEvidence: body.planEvidence,
        phase: body.outcome,
        beforeDigest: body.beforeDigest,
        afterDigest: body.afterDigest,
        mutationDigests: body.mutationDigests,
        verificationDigests: body.verificationDigests,
        rollbackAttempted: false,
        recoveryAttempts: 0,
        completedReviewPhases: ['planning', 'prepare', 'apply', 'verify'],
        lastAtMs: body.issuedAtMs,
        receipt: terminalReceipt,
      },
      recovered: false,
    },
  }
}

function rehashOperation(value) {
  const events = value.operation.journal.events
  let previousDigest = null
  for (let index = 0; index < events.length - 1; index += 1) {
    const current = events[index]
    current.previousDigest = previousDigest
    current.digest = canonicalSha256({
      schemaVersion: current.schemaVersion,
      operationId: current.operationId,
      targetKey: current.targetKey,
      sequence: current.sequence,
      previousDigest: current.previousDigest,
      atMs: current.atMs,
      entry: current.entry,
    })
    previousDigest = current.digest
  }
  value.receipt.body.journalHeadDigest = previousDigest
  value.receipt.digest = canonicalSha256(value.receipt.body)
  const receiptEvent = events.at(-1)
  receiptEvent.previousDigest = previousDigest
  receiptEvent.entry.receipt = value.receipt
  receiptEvent.digest = canonicalSha256({
    schemaVersion: receiptEvent.schemaVersion,
    operationId: receiptEvent.operationId,
    targetKey: receiptEvent.targetKey,
    sequence: receiptEvent.sequence,
    previousDigest: receiptEvent.previousDigest,
    atMs: receiptEvent.atMs,
    entry: receiptEvent.entry,
  })
  value.operation.projection.planEvidence = value.receipt.body.planEvidence
  value.operation.projection.receipt = value.receipt
}

test('uses the independent canonical JSON digest algorithm', () => {
  assert.equal(canonicalJson({ z: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"z":1}')
  assert.equal(canonicalSha256({ z: 1, a: [true, null, 'x'] }), 'sha256:cc31fc728ab32ccfd6543dd8cce686b9633b3c47fbec82c88a466688f3a8cb81')
})

test('strictly decodes an immutable plan before binding its complete canonical content', () => {
  const plan = fixture().plan
  assert.equal(verifyImmutablePlanDigest(plan), plan)

  const extra = structuredClone(plan)
  extra.content.unexpected = true
  extra.hash = canonicalSha256(extra.content)
  assert.throws(() => verifyImmutablePlanDigest(extra), /plan.content has an unexpected key set/)

  const missing = structuredClone(plan)
  delete missing.content.fences
  missing.hash = canonicalSha256(missing.content)
  assert.throws(() => verifyImmutablePlanDigest(missing), /plan.content has an unexpected key set/)

  const schema = structuredClone(plan)
  schema.content.schemaVersion = 999
  schema.hash = canonicalSha256(schema.content)
  assert.throws(() => verifyImmutablePlanDigest(schema), /plan.content.schemaVersion must be 1/)

  const semantic = structuredClone(plan)
  semantic.content.expiresAtMs = semantic.content.createdAtMs
  semantic.hash = canonicalSha256(semantic.content)
  assert.throws(() => verifyImmutablePlanDigest(semantic), /validity interval is invalid/)

  const tampered = structuredClone(plan)
  tampered.content.planId = 'plan:substituted'
  assert.throws(
    () => verifyImmutablePlanDigest(tampered),
    /does not match its canonical content/,
  )
})

test('binds the returned receipt to its independently hashed journal and projection', () => {
  const value = fixture()
  assert.equal(verifyTerminalReceipt(value.receipt), value.receipt)
  assert.equal(verifyTerminalReceiptPlanBinding(value.receipt, value.plan), value.receipt)
  assert.doesNotThrow(() => verifyOperationReceiptJournal(value.operation, value.receipt))
  assert.doesNotThrow(() => verifyReceiptInventory([{
    operationId: value.receipt.body.operationId,
    targetKey: value.receipt.body.targetKey,
    receipt: value.receipt,
  }], [value.receipt]))
})

test('rejects a self-reported fixed digest and a journal link mutation', () => {
  const value = fixture()
  assert.throws(
    () => verifyTerminalReceipt({ ...value.receipt, digest: `sha256:${'0'.repeat(64)}` }),
    /does not match its canonical body/,
  )
  value.operation.journal.events[2].entry.mutationDigest = canonicalSha256({ substituted: true })
  assert.throws(() => verifyOperationReceiptJournal(value.operation, value.receipt), /journal digest mismatch/)
})

test('rejects self-signed receipt semantics that the real schema cannot derive', () => {
  const value = fixture()
  const forgedEvidence = structuredClone(value.receipt)
  forgedEvidence.body.evidence.verification = 'not-proven'
  forgedEvidence.body.evidence.notProven = ['verification']
  forgedEvidence.digest = canonicalSha256(forgedEvidence.body)
  assert.throws(
    () => verifyTerminalReceipt(forgedEvidence),
    /evidence is inconsistent with the terminal evidence/,
  )

  const forgedPlanEvidence = structuredClone(value.receipt)
  forgedPlanEvidence.body.planEvidence = { restartRequired: false }
  forgedPlanEvidence.digest = canonicalSha256(forgedPlanEvidence.body)
  assert.throws(
    () => verifyTerminalReceipt(forgedPlanEvidence),
    /planEvidence has an unexpected key set/,
  )

  const forgedKindBinding = structuredClone(value.receipt)
  forgedKindBinding.body.planEvidence.extensionKind = 'plugin'
  forgedKindBinding.digest = canonicalSha256(forgedKindBinding.body)
  assert.throws(
    () => verifyTerminalReceipt(forgedKindBinding),
    /plan evidence does not match the operation kind and managed object/,
  )

  const forgedOperationBinding = structuredClone(value.receipt)
  forgedOperationBinding.body.planEvidence.reviewEvidence.operationKind = 'uninstall'
  forgedOperationBinding.digest = canonicalSha256(forgedOperationBinding.body)
  assert.throws(
    () => verifyTerminalReceipt(forgedOperationBinding),
    /plan evidence does not match the operation kind and managed object/,
  )
})

test('rejects a returned projection that drifts from the reconstructed journal', () => {
  const value = fixture()
  value.operation.projection.afterDigest = canonicalSha256({ substituted: true })
  assert.throws(
    () => verifyOperationReceiptJournal(value.operation, value.receipt),
    /projection does not match the reconstructed journal/,
  )
})

test('rejects a fully rehashed receipt, event chain, and projection with inconsistent plan evidence', () => {
  const value = fixture()
  value.receipt.body.planEvidence.extensionKind = 'plugin'
  value.operation.journal.events[0].entry.planEvidence = value.receipt.body.planEvidence
  rehashOperation(value)

  assert.throws(
    () => verifyOperationReceiptJournal(value.operation, value.receipt),
    /plan evidence does not match the operation kind and managed object/,
  )
})

test('rejects a fully rehashed journal and receipt whose evidence drifted from the approved plan', () => {
  const value = fixture()
  value.receipt.body.planEvidence.candidateRef = 'skill:substituted@2'
  rehashOperation(value)

  assert.doesNotThrow(() => verifyOperationReceiptJournal(value.operation, value.receipt))
  assert.throws(
    () => verifyTerminalReceiptPlanBinding(value.receipt, value.plan),
    /planEvidence.candidateRef does not match plan.content.candidateRef/,
  )
})

test('rejects duplicate or substituted durable receipt inventory', () => {
  const first = fixture('operation:one')
  const second = fixture('operation:two')
  const duplicate = [first, first].map(value => ({
    operationId: value.receipt.body.operationId,
    targetKey: value.receipt.body.targetKey,
    receipt: value.receipt,
  }))
  assert.throws(() => verifyReceiptInventory(duplicate, [first.receipt, second.receipt]), /duplicate operation id/)

  const substituted = [{
    operationId: first.receipt.body.operationId,
    targetKey: first.receipt.body.targetKey,
    receipt: first.receipt,
  }]
  assert.throws(() => verifyReceiptInventory(substituted, [second.receipt]), /does not match a lifecycle receipt/)
})
