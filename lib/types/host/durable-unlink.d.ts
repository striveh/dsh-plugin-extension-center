/** Filesystem operations injected only to verify durable unlink ordering and failures. */
export interface DurableUnlinkOperations {
    /** Remove the exact path before its parent directory is synchronized. */
    readonly remove: (path: string, options: Readonly<{
        force: boolean;
    }>) => Promise<void>;
    /** Synchronize the directory entry update that removed the path. */
    readonly synchronize: (directory: string) => Promise<void>;
}
/** Remove one file and durably persist the directory entry update. */
export declare function durableUnlink(path: string, options?: Readonly<{
    force?: boolean;
}>, operations?: DurableUnlinkOperations): Promise<void>;
//# sourceMappingURL=durable-unlink.d.ts.map
