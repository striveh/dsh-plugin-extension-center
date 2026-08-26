import type { ManagedTargetRecord, StoredContinuationActivation, StoredContinuationActivationIntent, StoredIntent, StoredOperationIndex, StoredProfileBootAck, StoredProviderSnapshot, StoredResolution, StoredTaskReceipt } from './state-store.ts';
interface CenterManifest {
    readonly schemaVersion: 1;
    readonly centerId: string;
    readonly createdAtMs: number;
}
/** Recompute the exact provider before-state digest without importing provider code. */
export declare function durableManagedStateDigest(record: ManagedTargetRecord | null): `sha256:${string}`;
/** Decode the exact center identity manifest. */
export declare function decodeCenterManifest(value: unknown): CenterManifest;
/** Decode one exact center-owned target and all retained versions. */
export declare function decodeManagedTarget(value: unknown, root: string, expectedTargetKey?: string): ManagedTargetRecord;
/** Decode one immutable intent/payload/plan-hash binding. */
export declare function decodeStoredIntent(value: unknown, expectedIntentId?: string): StoredIntent;
/** Decode one Host-only task capability resolution. */
export declare function decodeStoredResolution(value: unknown, expectedResolutionId?: string): StoredResolution;
/** Decode one non-authoritative journal lookup row. */
export declare function decodeOperationIndex(value: unknown, expectedOperationId?: string): StoredOperationIndex;
/** Decode one pre-mutation owner snapshot and recompute its before-state digest. */
export declare function decodeProviderSnapshot(value: unknown, root: string, expectedOperationId?: string): StoredProviderSnapshot;
/** Decode one exact external Profile boot acknowledgement. */
export declare function decodeProfileBootAck(value: unknown, expectedOperationId?: string): StoredProfileBootAck;
/** Decode one exact lifecycle result consumed by a continuation verifier. */
export declare function decodeTaskReceipt(value: unknown, expectedContinuationId?: string): StoredTaskReceipt;
/** Decode one reservation-to-continuation claim binding. */
export declare function decodeContinuationActivation(value: unknown, expectedReservationId?: string): StoredContinuationActivation;
/** Decode one write-ahead continuation claim creation intent. */
export declare function decodeContinuationActivationIntent(value: unknown, expectedReservationId?: string): StoredContinuationActivationIntent;
/** Assert that a decoded record identity hashes to its durable filename. */
export declare function assertStateFileIdentity(fileName: string, identity: string, path: string): void;
export {};
//# sourceMappingURL=state-codec.d.ts.map
