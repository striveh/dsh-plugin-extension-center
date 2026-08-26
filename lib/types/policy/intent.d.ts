import type { AcquisitionIntent, ResolvedIntentCandidate } from './types.ts';
/**
 * Mint one internal acquisition intent after the Host has re-resolved every coordinate.
 * @param input Provenance and exact eligible candidate; browser/model payloads never call this directly.
 * @returns Immutable intent with a canonical entrance-independent mutation core.
 */
export declare function mintAcquisitionIntent(input: Readonly<{
    intentId: string;
    origin: 'store' | 'task';
    idempotencyKey: string;
    continuationId?: string;
    createdAtMs: number;
    expiresAtMs: number;
    candidate: ResolvedIntentCandidate;
}>): AcquisitionIntent;
//# sourceMappingURL=intent.d.ts.map
