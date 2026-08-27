/** Exact capability-resolver releases understood by this Extension Center build. */
export const CAPABILITY_RESOLVER_CANDIDATES = Object.freeze([
    Object.freeze({
        candidateRef: 'plugin:dsh-capability-resolver@0.1.0',
        version: '0.1.0',
        integrity: 'sha256:895e1e44ee9edaff0c4982c671379bbc3122e2c0189250e9870ee70102f2c27e',
        sizeBytes: 92_128,
        configurationSchema: 'dsh-capability-resolver/config@0.1.0',
    }),
    Object.freeze({
        candidateRef: 'plugin:dsh-capability-resolver@0.1.1',
        version: '0.1.1',
        integrity: 'sha256:650fab654ad7a7c22d2dd34814d8625810b67d5b6345e6ffe136c19373127c17',
        sizeBytes: 92_419,
        configurationSchema: 'dsh-capability-resolver/config@0.1.1',
    }),
]);
/** Resolve only an exact candidate/version pair admitted by this build. */
export function capabilityResolverCandidate(candidateRef, version) {
    return CAPABILITY_RESOLVER_CANDIDATES.find(candidate => candidate.candidateRef === candidateRef && candidate.version === version) ?? null;
}
/** Whether a candidate reference names one exact supported capability-resolver release. */
export function isCapabilityResolverCandidate(candidateRef) {
    return CAPABILITY_RESOLVER_CANDIDATES.some(candidate => candidate.candidateRef === candidateRef);
}
//# sourceMappingURL=resolver-candidates.js.map
