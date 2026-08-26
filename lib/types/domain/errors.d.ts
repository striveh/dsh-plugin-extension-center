/** Stable failures emitted by the pure P0 domain kernel. */
export type ExtensionDomainErrorCode = 'invalid-data' | 'journal-corrupt' | 'journal-truncated' | 'journal-transition' | 'plan-context-mismatch' | 'plan-expired' | 'plan-integrity' | 'plan-replay' | 'revision-stale' | 'target-busy' | 'target-lock-mismatch';
/** A bounded domain failure that callers can map without inspecting prose. */
export declare class ExtensionDomainError extends Error {
    /** Stable machine-readable reason. */
    readonly code: ExtensionDomainErrorCode;
    /**
     * Create one bounded domain failure.
     *
     * @param code Stable machine-readable reason.
     * @param message Non-sensitive diagnostic detail.
     */
    constructor(code: ExtensionDomainErrorCode, message: string);
}
/**
 * Stop one domain transition with a stable error code.
 *
 * @param code Stable machine-readable reason.
 * @param message Non-sensitive diagnostic detail.
 */
export declare function failDomain(code: ExtensionDomainErrorCode, message: string): never;
//# sourceMappingURL=errors.d.ts.map
