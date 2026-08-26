import { type Sha256Digest } from '../domain/json.ts';
import type { OperationAuthorization } from '../plans/types.ts';
import { type JournalCheckpoint, type OperationJournal, type OperationPhase, type OperationProjection, type OperationReceipt } from './types.ts';
/**
 * Strictly decode and verify one terminal receipt.
 *
 * @param value Untrusted receipt value.
 * @returns Recursively frozen verified receipt.
 */
export declare function decodeOperationReceipt(value: unknown): OperationReceipt;
/**
 * Return the exact head of a non-empty verified journal.
 *
 * @param value Typed or serialized operation journal.
 * @returns Event-count and head-digest checkpoint.
 */
export declare function operationJournalCheckpoint(value: unknown): JournalCheckpoint;
/**
 * Verify a digest-linked journal and optionally require its externally anchored head.
 *
 * @param value Typed or serialized operation journal.
 * @param expectedCheckpoint Optional externally anchored final head.
 * @returns Pure reconstructed operation projection.
 */
export declare function verifyOperationJournal(value: unknown, expectedCheckpoint?: JournalCheckpoint): OperationProjection;
/**
 * Start an in-memory journal from one consumed plan authorization.
 *
 * @param authorizationValue Consumed operation authorization.
 * @param beforeDigestValue Authoritative before-state digest.
 * @param atValue Trusted current time in epoch milliseconds.
 * @returns Journal containing its immutable opening event.
 */
export declare function createOperationJournal(authorizationValue: OperationAuthorization, beforeDigestValue: unknown, atValue: number): OperationJournal;
/**
 * Append one allowed operation phase transition.
 *
 * @param journal Current verified journal.
 * @param to Target phase.
 * @param evidenceDigest Final owner evidence for terminal phases, otherwise null.
 * @param reason Bounded failure reason where required.
 * @param atMs Trusted current time in epoch milliseconds.
 * @returns New immutable journal.
 */
export declare function transitionOperation(journal: OperationJournal, to: OperationPhase, evidenceDigest: Sha256Digest | null, reason: string | null, atMs: number): OperationJournal;
/**
 * Append one digest-only target mutation observation.
 *
 * @param journal Current verified journal.
 * @param mutationDigest Exact mutation digest.
 * @param atMs Trusted current time in epoch milliseconds.
 * @returns New immutable journal.
 */
export declare function recordOperationMutation(journal: OperationJournal, mutationDigest: Sha256Digest, atMs: number): OperationJournal;
/**
 * Append one authoritative verification observation.
 *
 * @param journal Current verified journal.
 * @param verificationDigest Exact owner evidence digest.
 * @param atMs Trusted current time in epoch milliseconds.
 * @returns New immutable journal.
 */
export declare function recordOperationVerification(journal: OperationJournal, verificationDigest: Sha256Digest, atMs: number): OperationJournal;
/**
 * Derive and append the only receipt for a terminal operation.
 *
 * @param journal Current verified terminal journal.
 * @param atMs Trusted receipt time in epoch milliseconds.
 * @returns New journal and its immutable receipt.
 */
export declare function issueOperationReceipt(journal: OperationJournal, atMs: number): Readonly<{
    journal: OperationJournal;
    receipt: OperationReceipt;
}>;
//# sourceMappingURL=journal.d.ts.map
