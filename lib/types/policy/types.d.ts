import type { CatalogEntry } from '../catalog-contract.ts';
import type { ArtifactIntegrity, Sha256Digest } from '../domain/index.ts';
import type { InventoryHostCapabilities } from '../inventory/index.ts';
import type { DesiredState, ManagedExtensionKind, OperationKind } from '../plans/index.ts';
/** Stable deterministic admission failures shown before any plan can exist. */
export type PolicyDenialCode = 'catalog-unavailable' | 'catalog-incomplete' | 'host-capability' | 'compatibility-unavailable' | 'platform-unavailable' | 'lifecycle-incomplete' | 'action-unavailable' | 'moving-reference' | 'scope-unavailable' | 'authority-unknown' | 'lifecycle-script' | 'credential-unsupported' | 'external-runtime-unresolved' | 'review-evidence-unavailable' | 'verification-incomplete' | 'task-choice-required';
/** Deterministic policy result embedded in the acquisition intent core. */
export type CandidatePolicyResult = {
    readonly status: 'eligible';
    readonly policyRevision: string;
    readonly authorityDigest: Sha256Digest;
} | {
    readonly status: 'denied';
    readonly policyRevision: string;
    readonly code: PolicyDenialCode;
    readonly reason: string;
};
/** Complete policy inputs resolved by the Host, not supplied by the Agent. */
export interface CandidatePolicyInput {
    readonly entry: CatalogEntry;
    readonly catalogVerified: boolean;
    readonly catalogComplete: boolean;
    readonly hostCapabilities: InventoryHostCapabilities;
    readonly operationKind: OperationKind;
    readonly desiredState: DesiredState;
    readonly selectedScope: string;
    readonly currentPlatform: 'darwin' | 'linux' | 'windows' | 'unsupported';
    readonly completeLifecycle: boolean;
    readonly authorityKnown: boolean;
    readonly authorityDigest: Sha256Digest;
    readonly lifecycleScriptControl: 'not-applicable' | 'inspect-before-mutation' | 'unknown';
    readonly externalRuntimeResolved: boolean;
    readonly reviewEvidenceAvailable: boolean;
    readonly verificationRecipeComplete: boolean;
    readonly taskOneClick: boolean;
    readonly unresolvedUserChoices: number;
}
/** Host-resolved exact candidate data used to mint a non-submittable intent. */
export interface ResolvedIntentCandidate {
    readonly kind: ManagedExtensionKind;
    readonly extensionId: string;
    readonly candidateRef: string;
    readonly artifactRevision: string;
    readonly artifactIntegrity: ArtifactIntegrity;
    readonly artifactUrl: string;
    readonly artifactSizeBytes: number;
    readonly scopeKey: string;
    readonly profileId: string;
    readonly operationKind: OperationKind;
    readonly desiredState: DesiredState;
    readonly admittedCapabilities: readonly string[];
    readonly authorityDeltaDigest: Sha256Digest;
    readonly policyResult: Extract<CandidatePolicyResult, {
        status: 'eligible';
    }>;
    readonly catalogRevision: number;
    readonly inventoryRevision: Sha256Digest;
}
/** Canonical mutation and authority core shared by Store and task entrances. */
export interface AcquisitionIntentCore {
    readonly kind: ManagedExtensionKind;
    readonly extensionId: string;
    readonly candidateRef: string;
    readonly artifactRevision: string;
    readonly artifactIntegrity: ArtifactIntegrity;
    readonly artifactUrl: string;
    readonly artifactSizeBytes: number;
    readonly scopeKey: string;
    readonly profileId: string;
    readonly operationKind: OperationKind;
    readonly desiredState: DesiredState;
    readonly admittedCapabilities: readonly string[];
    readonly authorityDeltaDigest: Sha256Digest;
    readonly policyRevision: string;
    readonly catalogRevision: number;
    readonly inventoryRevision: Sha256Digest;
}
/** Internal intent from which the Host may mint an immutable plan. */
export interface AcquisitionIntent {
    readonly schemaVersion: 1;
    readonly intentId: string;
    readonly origin: 'store' | 'task';
    readonly idempotencyKey: string;
    readonly continuationId: string | null;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
    readonly core: AcquisitionIntentCore;
    readonly coreDigest: Sha256Digest;
}
//# sourceMappingURL=types.d.ts.map
