/** Exact capability-resolver releases understood by this Extension Center build. */
export declare const CAPABILITY_RESOLVER_CANDIDATES: readonly [Readonly<{
    candidateRef: "plugin:dsh-capability-resolver@0.1.0";
    version: "0.1.0";
    integrity: "sha256:895e1e44ee9edaff0c4982c671379bbc3122e2c0189250e9870ee70102f2c27e";
    sizeBytes: 92128;
    configurationSchema: "dsh-capability-resolver/config@0.1.0";
}>, Readonly<{
    candidateRef: "plugin:dsh-capability-resolver@0.1.1";
    version: "0.1.1";
    integrity: "sha256:650fab654ad7a7c22d2dd34814d8625810b67d5b6345e6ffe136c19373127c17";
    sizeBytes: 92419;
    configurationSchema: "dsh-capability-resolver/config@0.1.1";
}>];
/** One exact capability-resolver release identity. */
export type CapabilityResolverCandidate = typeof CAPABILITY_RESOLVER_CANDIDATES[number];
/** Resolve only an exact candidate/version pair admitted by this build. */
export declare function capabilityResolverCandidate(candidateRef: string, version: string): CapabilityResolverCandidate | null;
/** Whether a candidate reference names one exact supported capability-resolver release. */
export declare function isCapabilityResolverCandidate(candidateRef: string): boolean;
//# sourceMappingURL=resolver-candidates.d.ts.map
