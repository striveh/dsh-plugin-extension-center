import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type { CandidatePolicyInput, CandidatePolicyResult, PolicyDenialCode } from './types.ts'

export const POLICY_REVISION = 'extension-center-p0-policy-v2' as const
export const SUPPORTED_DSH_VERSION = '0.1.1-rc.2' as const

function denied(code: PolicyDenialCode, reason: string): CandidatePolicyResult {
  return Object.freeze({ status: 'denied', policyRevision: POLICY_REVISION, code, reason })
}

/**
 * Apply deterministic admission before Store selection or model ranking.
 * @param input Host-resolved catalog, owner, authority, and task constraints.
 * @returns Eligible result with authority digest, or the first stable denial.
 */
export function evaluateCandidatePolicy(input: CandidatePolicyInput): CandidatePolicyResult {
  if (!input.catalogVerified) return denied('catalog-unavailable', 'catalog trust verification is unavailable')
  if (!input.catalogComplete) return denied('catalog-incomplete', 'catalog or inventory observation is incomplete')
  const host = input.hostCapabilities
  if (!host.acquisition) {
    return denied('host-capability', 'the exact Host does not publish every required P0 owner')
  }
  if (input.entry.compatibility.status !== 'compatible'
    || input.entry.compatibility.dsh !== SUPPORTED_DSH_VERSION) {
    return denied('compatibility-unavailable', 'the exact candidate is not admitted for this DSH release')
  }
  if (input.currentPlatform === 'unsupported'
    || !input.entry.compatibility.platforms.includes(input.currentPlatform)) {
    return denied('platform-unavailable', 'the exact candidate is not admitted for this Host platform')
  }
  if (!input.completeLifecycle) {
    return denied('lifecycle-incomplete', 'the candidate lacks a complete owner-backed lifecycle')
  }
  const action = input.entry.lifecycle[input.operationKind as keyof typeof input.entry.lifecycle]
  if (action === undefined || action.status !== 'available') {
    return denied('action-unavailable', action?.reason ?? 'the requested action is not admitted')
  }
  if (
    input.entry.artifact.version === 'latest'
    || ['main', 'master', 'head'].includes(input.entry.source.revision.toLowerCase())
  ) {
    return denied('moving-reference', 'the candidate does not use an immutable artifact revision')
  }
  if (!input.entry.scopes.includes(input.selectedScope as never)) {
    return denied('scope-unavailable', 'the selected scope is not admitted for this candidate')
  }
  if (!input.authorityKnown) return denied('authority-unknown', 'the authority delta is incomplete')
  if (input.lifecycleScriptControl === 'unknown') {
    return denied('lifecycle-script', 'the artifact has no enforced pre-mutation lifecycle-script inspection')
  }
  if (input.entry.configuration.credentials === 'required') {
    return denied('credential-unsupported', 'authenticated acquisition requires a formal credential-reference owner')
  }
  if (input.entry.kind === 'mcp' && !input.externalRuntimeResolved) {
    return denied('external-runtime-unresolved', 'the admitted MCP runtime prerequisite is not present')
  }
  if (!input.reviewEvidenceAvailable) {
    return denied('review-evidence-unavailable', 'the exact candidate has no review evidence record understood by this package')
  }
  if (!input.verificationRecipeComplete) {
    return denied('verification-incomplete', 'the runtime visibility recipe is incomplete')
  }
  if (input.taskOneClick && input.unresolvedUserChoices !== 0) {
    return denied('task-choice-required', 'task acquisition cannot default an unresolved user choice')
  }
  return Object.freeze({
    status: 'eligible',
    policyRevision: POLICY_REVISION,
    authorityDigest: canonicalSha256({
      candidateRef: input.entry.candidateRef,
      authorityDigest: input.authorityDigest,
      operationKind: input.operationKind,
      desiredState: input.desiredState,
      selectedScope: input.selectedScope,
    }),
  })
}

/** Freeze a policy result before embedding it in another durable record. */
export function snapshotPolicyResult(value: CandidatePolicyResult): CandidatePolicyResult {
  return immutableJsonClone(value) as CandidatePolicyResult
}
