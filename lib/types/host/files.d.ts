/** Map an opaque identity to one attacker-independent path segment. */
export declare function storageKey(value: string): string;
/** Require one existing directory path that is not a symbolic link. */
export declare function ensurePrivateDirectory(path: string): Promise<void>;
/** Ensure a derived child stays below an exact center-owned root. */
export declare function safeChild(root: string, ...segments: readonly string[]): string;
/** Flush one directory entry update where the platform exposes directory fsync. */
export declare function syncDirectory(path: string): Promise<void>;
/** Durably replace one canonical JSON record through a private temporary file. */
export declare function writeCanonicalAtomic(path: string, value: unknown): Promise<void>;
/** Install one canonical JSON record exactly once. */
export declare function writeCanonicalExclusive(path: string, value: unknown): Promise<void>;
/** Read one complete canonical JSON record, or return undefined when absent. */
export declare function readCanonicalOptional(path: string): Promise<unknown | undefined>;
/** Open one existing regular file without following its final symbolic link. */
export declare function openRegularNoFollow(path: string): Promise<import("fs/promises").FileHandle>;
//# sourceMappingURL=files.d.ts.map
