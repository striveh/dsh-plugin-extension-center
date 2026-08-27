/** Stable reason emitted when official Profile state cannot be safely classified or compensated. */
export const OFFICIAL_PROFILE_AMBIGUITY_CODE = 'profile-state-ambiguous';
/** Fail-closed signal that retains both operation and Profile quarantine until explicit recovery. */
export class OfficialProfileAmbiguityError extends Error {
    code = OFFICIAL_PROFILE_AMBIGUITY_CODE;
    constructor(message, options) {
        super(message, options);
        this.name = 'OfficialProfileAmbiguityError';
    }
}
/** Identify a Profile ambiguity across provider and operation-runner layers. */
export function isOfficialProfileAmbiguityError(error) {
    return error instanceof OfficialProfileAmbiguityError
        || typeof error === 'object' && error !== null
            && error.code === OFFICIAL_PROFILE_AMBIGUITY_CODE;
}
//# sourceMappingURL=types.js.map
