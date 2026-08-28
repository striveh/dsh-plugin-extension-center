import type { CandidatePolicyInput, CandidatePolicyResult } from './types.ts';
export declare const POLICY_REVISION: "extension-center-p0-policy-v2";
export declare const SUPPORTED_DSH_VERSION: "0.1.2-alpha.1";
/**
 * Bind one raw authority delta to the exact admitted operation and scope.
 * @param input Candidate, authority-delta, operation, desired-state, and scope coordinates.
 * @returns Canonical authority digest embedded in the immutable plan and authorization.
 */
export declare function admittedAuthorityDigest(input: Readonly<{
    candidateRef: string;
    authorityDeltaDigest: CandidatePolicyInput['authorityDigest'];
    operationKind: CandidatePolicyInput['operationKind'];
    desiredState: CandidatePolicyInput['desiredState'];
    selectedScope: string;
}>): CandidatePolicyInput['authorityDigest'];
/**
 * Apply deterministic admission before Store selection or model ranking.
 * @param input Host-resolved catalog, owner, authority, and task constraints.
 * @returns Eligible result with authority digest, or the first stable denial.
 */
export declare function evaluateCandidatePolicy(input: CandidatePolicyInput): CandidatePolicyResult;
/** Freeze a policy result before embedding it in another durable record. */
export declare function snapshotPolicyResult(value: CandidatePolicyResult): CandidatePolicyResult;
//# sourceMappingURL=evaluate.d.ts.map
