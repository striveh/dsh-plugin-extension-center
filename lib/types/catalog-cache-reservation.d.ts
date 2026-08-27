/**
 * Hold the catalog's cross-process writer reservation while one callback re-reads and commits durable cache state.
 * @param directory Center-owned catalog storage directory.
 * @param work Short callback that performs no network access.
 * @returns The callback result after the SQLite writer transaction commits.
 */
export declare function withCatalogCacheWriter<T>(directory: string, work: () => Promise<T>): Promise<T>;
//# sourceMappingURL=catalog-cache-reservation.d.ts.map
