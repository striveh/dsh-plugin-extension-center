/** A bounded domain failure that callers can map without inspecting prose. */
export class ExtensionDomainError extends Error {
    /** Stable machine-readable reason. */
    code;
    /**
     * Create one bounded domain failure.
     *
     * @param code Stable machine-readable reason.
     * @param message Non-sensitive diagnostic detail.
     */
    constructor(code, message) {
        super(message);
        this.name = 'ExtensionDomainError';
        this.code = code;
    }
}
/**
 * Stop one domain transition with a stable error code.
 *
 * @param code Stable machine-readable reason.
 * @param message Non-sensitive diagnostic detail.
 */
export function failDomain(code, message) {
    throw new ExtensionDomainError(code, message);
}
//# sourceMappingURL=errors.js.map
