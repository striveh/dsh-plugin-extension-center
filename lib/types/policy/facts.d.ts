import type { CatalogEntry } from '../catalog-contract.ts';
import { type Sha256Digest } from '../domain/index.ts';
import type { DesiredState, OperationKind } from '../plans/index.ts';
/** Platform key used by both Store and task admission. */
export declare function currentHostPlatform(): 'darwin' | 'linux' | 'windows' | 'unsupported';
/** Derive catalog facts instead of accepting optimistic booleans from either product entrance. */
export declare function candidateAdmissionFacts(entry: CatalogEntry, operationKind: OperationKind): Readonly<{
    completeLifecycle: boolean;
    authorityKnown: boolean;
    lifecycleScriptControl: 'not-applicable' | 'inspect-before-mutation';
    reviewEvidenceAvailable: boolean;
    verificationRecipeComplete: boolean;
}>;
/** Derive whether this exact operation needs a later Host boot before verification can finish. */
export declare function operationRestartRequired(entry: CatalogEntry, operationKind: OperationKind): boolean;
/** Digest of the owner-specific observation recipe enforced by the selected provider implementation. */
export declare function verificationRecipeDigest(kind: CatalogEntry['kind'], operationKind: OperationKind, desiredState: DesiredState): Sha256Digest;
//# sourceMappingURL=facts.d.ts.map
