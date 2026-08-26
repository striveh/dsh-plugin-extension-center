import { type Sha256Digest } from '../domain/index.ts';
import type { ManagedTargetRecord, ManagedVersion } from '../host/index.ts';
import type { ProviderOperationRequest } from './types.ts';
/** Digest only the restorable target state, excluding audit revisions and timestamps. */
export declare function managedStateDigest(record: ManagedTargetRecord | null): Sha256Digest;
/** Derive the next center-owned record for one already-preflighted operation. */
export declare function nextManagedRecord(before: ManagedTargetRecord | null, request: ProviderOperationRequest, suppliedVersion: ManagedVersion | null, nowMs: number): ManagedTargetRecord;
//# sourceMappingURL=records.d.ts.map
