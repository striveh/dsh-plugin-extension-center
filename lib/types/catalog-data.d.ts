import type { CatalogEntry, CatalogEnvelope, CatalogRoot, CatalogSignature } from './catalog-contract.ts';
/** Curated entries in bootstrap revision 10. Free-form upstream text is not included. */
export declare const BOOTSTRAP_CATALOG_ENTRIES: readonly CatalogEntry[];
/** Packaged trust root. The private signing key is not part of this repository. */
export declare const BOOTSTRAP_CATALOG_ROOT: CatalogRoot;
/** Immutable bootstrap catalog shipped for fully offline Store discovery. */
export declare const BOOTSTRAP_CATALOG_ENVELOPE: CatalogEnvelope;
/** Threshold signature for the immutable bootstrap envelope. */
export declare const BOOTSTRAP_CATALOG_SIGNATURES: readonly CatalogSignature[];
//# sourceMappingURL=catalog-data.d.ts.map
