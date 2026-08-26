import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import {
  evaluateCandidatePolicy,
  mintAcquisitionIntent,
  type CandidatePolicyInput,
  type ResolvedIntentCandidate,
} from '../src/policy/index.ts'

const host = {
  profileTransaction: true,
  dynamicMcpConnection: true,
  durableContinuation: true,
  skillRegistry: true,
  toolRegistry: true,
  loaderObservation: true,
  acquisition: true,
}

function policyInput(): CandidatePolicyInput {
  const entry = structuredClone(BOOTSTRAP_CATALOG_ENVELOPE.entries.find(item => item.kind === 'skill')!)
  for (const action of Object.values(entry.lifecycle)) {
    action.status = 'available'
    delete action.reason
  }
  return {
    entry,
    catalogVerified: true,
    catalogComplete: true,
    hostCapabilities: host,
    operationKind: 'install',
    desiredState: 'enabled',
    selectedScope: entry.scopes[0]!,
    currentPlatform: 'darwin',
    completeLifecycle: true,
    authorityKnown: true,
    authorityDigest: canonicalSha256({ authority: 'known' }),
    lifecycleScriptControl: 'not-applicable',
    externalRuntimeResolved: true,
    reviewEvidenceAvailable: true,
    verificationRecipeComplete: true,
    taskOneClick: false,
    unresolvedUserChoices: 0,
  }
}

describe('full P0 deterministic policy and dual-entry intent', () => {
  it('fails at the exact owner gate before any candidate can mint a write intent', () => {
    const result = evaluateCandidatePolicy({
      ...policyInput(),
      hostCapabilities: { ...host, profileTransaction: false, acquisition: false },
    })
    expect(result).toEqual({
      status: 'denied',
      policyRevision: 'extension-center-p0-policy-v2',
      code: 'host-capability',
      reason: 'the exact Host does not publish every required P0 owner',
    })
  })

  it.each([
    ['lifecycle-script', { lifecycleScriptControl: 'unknown' }],
    ['compatibility-unavailable', { entry: { ...policyInput().entry, compatibility: { ...policyInput().entry.compatibility, status: 'review-required' } } }],
    ['platform-unavailable', { currentPlatform: 'windows', entry: { ...policyInput().entry, compatibility: { ...policyInput().entry.compatibility, platforms: ['darwin'] } } }],
    ['authority-unknown', { authorityKnown: false }],
    ['review-evidence-unavailable', { reviewEvidenceAvailable: false }],
    ['verification-incomplete', { verificationRecipeComplete: false }],
    ['task-choice-required', { taskOneClick: true, unresolvedUserChoices: 1 }],
  ] as const)('denies %s deterministically', (code, change) => {
    expect(evaluateCandidatePolicy({ ...policyInput(), ...change })).toMatchObject({ status: 'denied', code })
  })

  it('produces the same canonical mutation core for Store and task entrances', () => {
    const policy = evaluateCandidatePolicy(policyInput())
    if (policy.status !== 'eligible') throw new Error('fixture policy was denied')
    const entry = policyInput().entry
    const candidate: ResolvedIntentCandidate = {
      kind: entry.kind,
      extensionId: entry.name,
      candidateRef: entry.candidateRef,
      artifactRevision: entry.artifact.version,
      artifactIntegrity: entry.artifact.integrity,
      artifactUrl: entry.artifact.acquisitionUrl,
      artifactSizeBytes: entry.artifact.sizeBytes,
      scopeKey: entry.scopes[0]!,
      profileId: 'profile:web',
      operationKind: 'install',
      desiredState: 'enabled',
      admittedCapabilities: ['skill/example', 'outcome/example'],
      authorityDeltaDigest: canonicalSha256({ authority: 'delta' }),
      policyResult: policy,
      catalogRevision: 2,
      inventoryRevision: canonicalSha256({ inventory: 2 }),
    }
    const store = mintAcquisitionIntent({
      intentId: 'intent:store:1',
      origin: 'store',
      idempotencyKey: 'idem:store:1',
      createdAtMs: 1,
      expiresAtMs: 100,
      candidate,
    })
    const task = mintAcquisitionIntent({
      intentId: 'intent:task:1',
      origin: 'task',
      idempotencyKey: 'idem:task:1',
      continuationId: 'continuation:1',
      createdAtMs: 1,
      expiresAtMs: 100,
      candidate,
    })
    expect(store.core).toEqual(task.core)
    expect(store.coreDigest).toBe(task.coreDigest)
    expect(store.origin).not.toBe(task.origin)
    expect(store.continuationId).toBeNull()
    expect(task.continuationId).toBe('continuation:1')
  })
})
