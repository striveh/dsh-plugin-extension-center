import { type CatalogEntry, type CatalogEnvelope, type CatalogHostCapabilities, type CatalogListResponse, type CatalogRoot, type CatalogSignature } from './catalog-contract.ts';
import type { CatalogAdmissionStatus } from './catalog-refresh.ts';
/** How the Host can construct candidate-bound review evidence before authorization. */
export type CatalogReviewEvidenceSupport = 'package-pinned' | 'runtime-bound' | 'unavailable';
/** Reject signed eligibility that has no exact review record understood by this package build. */
export declare function catalogReviewEvidenceSupport(entry: CatalogEntry): CatalogReviewEvidenceSupport;
/** Recursively canonicalize JSON-compatible data with lexicographically sorted object keys. */
export declare function canonicalJson(value: unknown): string;
/** Hash one canonical JSON value. */
export declare function canonicalSha256(value: unknown): `sha256:${string}`;
/** Verified immutable catalog plus the accepted signing key ids. */
export interface VerifiedCatalog {
    readonly envelope: CatalogEnvelope;
    readonly keyIds: readonly string[];
}
/** Validate and verify one immutable catalog against a packaged trust root. */
export declare function verifyCatalog(root: CatalogRoot, envelope: CatalogEnvelope, signatures: readonly CatalogSignature[], now?: number): VerifiedCatalog;
/** Verify the packaged offline bootstrap catalog. */
export declare function verifyBootstrapCatalog(now?: number): VerifiedCatalog;
/** Project a verified catalog onto the private browser RPC. */
export declare function catalogListResponse(catalog: VerifiedCatalog, hostCapabilities?: CatalogHostCapabilities, admission?: CatalogAdmissionStatus): CatalogListResponse;
//# sourceMappingURL=catalog.d.ts.map
