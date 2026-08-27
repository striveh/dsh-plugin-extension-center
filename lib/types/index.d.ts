/** Independent Extension Center Host: verified Store, durable lifecycle, and task acquisition. */
export { apply, inject, name, type Config } from './host-plugin.ts';
export { catalogListResponse, verifyBootstrapCatalog } from './catalog.ts';
export { CatalogSnapshotManager, PUBLISHED_CATALOG_URL, canonicalCatalogUrl, verifyCatalogAdvance, } from './catalog-refresh.ts';
export type { CatalogEntry, CatalogListResponse } from './catalog-contract.ts';
export * from './service/rpc-contract.ts';
//# sourceMappingURL=index.d.ts.map
