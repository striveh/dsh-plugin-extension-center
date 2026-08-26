import type { CandidatePolicyInput, CandidatePolicyResult } from './types.ts';
export declare const POLICY_REVISION: "extension-center-p0-policy-v2";
export declare const SUPPORTED_DSH_VERSION: "0.1.1-rc.2";
/**
 * Apply deterministic admission before Store selection or model ranking.
 * @param input Host-resolved catalog, owner, authority, and task constraints.
 * @returns Eligible result with authority digest, or the first stable denial.
 */
export declare function evaluateCandidatePolicy(input: CandidatePolicyInput): CandidatePolicyResult;
/** Freeze a policy result before embedding it in another durable record. */
export declare function snapshotPolicyResult(value: CandidatePolicyResult): CandidatePolicyResult;
//# sourceMappingURL=evaluate.d.ts.map
