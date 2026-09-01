import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import {
  admittedAuthorityDigest,
  evaluateCandidatePolicy,
  mintAcquisitionIntent,
  operationRestartRequired,
  verificationRecipeDigest,
  type CandidatePolicyInput,
  type ResolvedIntentCandidate,
} from '../src/policy/index.ts'

const host = {
  managedPluginLifecycle: true,
  dynamicMcpConnection: true,
  durableContinuation: true,
  skillRegistry: true,
  toolRegistry: true,
  loaderMutation: true,
  acquisition: true,
}

function policyInput(): CandidatePolicyInput {
  const entry = structuredClone(BOOTSTRAP_CATALOG_ENVELOPE.entries.find(item => item.kind === 'skill')!)
  entry.compatibility.dsh = '0.1.2-alpha.3'
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
  it('requires a later Host boot for Plugin package mutations but not Loader-only configuration', () => {
    const plugin = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(item => item.kind === 'plugin')!

    expect(operationRestartRequired(plugin, 'install')).toBe(true)
    expect(operationRestartRequired(plugin, 'update')).toBe(true)
    expect(operationRestartRequired(plugin, 'uninstall')).toBe(true)
    expect(operationRestartRequired(plugin, 'restore')).toBe(true)
    expect(operationRestartRequired(plugin, 'configure')).toBe(false)
    expect(operationRestartRequired(plugin, 'enable')).toBe(false)
    expect(operationRestartRequired(plugin, 'disable')).toBe(false)
    expect(operationRestartRequired(plugin, 'purge')).toBe(false)

    const mcp = structuredClone(BOOTSTRAP_CATALOG_ENVELOPE.entries.find(item => item.kind === 'mcp')!)
    mcp.restart.required = true
    expect(operationRestartRequired(mcp, 'install')).toBe(false)
  })

  it('binds Host restart observation only into Plugin package-operation recipes', () => {
    expect(verificationRecipeDigest('plugin', 'configure', 'enabled')).toBe(canonicalSha256({
      recipeRevision: 2,
      kind: 'plugin',
      operationKind: 'configure',
      desiredState: 'enabled',
      steps: ['center-plugin-material', 'managed-owner-revision', 'loader-consumer'],
    }))
    expect(verificationRecipeDigest('plugin', 'uninstall', 'removed')).toBe(canonicalSha256({
      recipeRevision: 2,
      kind: 'plugin',
      operationKind: 'uninstall',
      desiredState: 'removed',
      steps: ['plugin-owner-absence', 'center-inventory-absence', 'host-restart-observation'],
    }))
    expect(verificationRecipeDigest('plugin', 'purge', 'removed')).toBe(canonicalSha256({
      recipeRevision: 2,
      kind: 'plugin',
      operationKind: 'purge',
      desiredState: 'removed',
      steps: ['plugin-owner-absence', 'center-inventory-absence'],
    }))
  })

  it('fails at the exact owner gate before any candidate can mint a write intent', () => {
    const result = evaluateCandidatePolicy({
      ...policyInput(),
      hostCapabilities: { ...host, managedPluginLifecycle: false, acquisition: false },
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
    ['compatibility-unavailable', { entry: { ...policyInput().entry, compatibility: { ...policyInput().entry.compatibility, dsh: '0.1.1-rc.2' } } }],
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

  it('binds the raw intent authority delta to the exact admitted operation and scope', () => {
    const input = policyInput()
    const policy = evaluateCandidatePolicy(input)
    if (policy.status !== 'eligible') throw new Error('fixture policy was denied')

    expect(policy.authorityDigest).toBe(admittedAuthorityDigest({
      candidateRef: input.entry.candidateRef,
      authorityDeltaDigest: input.authorityDigest,
      operationKind: input.operationKind,
      desiredState: input.desiredState,
      selectedScope: input.selectedScope,
    }))
    expect(policy.authorityDigest).not.toBe(input.authorityDigest)
  })
})
