#!/usr/bin/env node
/**
 * Standalone Center journal verifier and desired-state recovery executable.
 *
 * This file imports only Node built-ins. A pinned copy can restore the
 * Extension Center's own Plugin records even when the Center runtime cannot
 * start. It invokes only the journal-bound official DSH CLI to restore the
 * exact Profile dependency before committing Center state; it never writes
 * an official Profile manifest, lockfile, package tree, or bundle list itself.
 */
interface OfficialDshDependencyBinding {
    readonly packageName: string;
    readonly packageVersion: string;
    readonly packageRoot: string;
    readonly packageTreeSha256: string;
}
interface OfficialDshRecoveryBinding {
    readonly schemaVersion: 2;
    readonly packageName: '@deepseek-ai/dsh';
    readonly packageVersion: '0.1.1-rc.2';
    readonly packageRoot: string;
    readonly packageTreeSha256: string;
    readonly productionDependencies: readonly OfficialDshDependencyBinding[];
    readonly entrypointPath: string;
    readonly entrypointSha256: string;
    readonly hostHome: string;
    readonly timeoutMs: number;
    readonly node: Readonly<{
        schemaVersion: 1;
        executablePath: string;
        executableSha256: string;
        version: string;
    }>;
    readonly supervisorPath: string;
    readonly supervisorSha256: string;
    readonly pnpm: Readonly<{
        schemaVersion: 1;
        packageName: 'pnpm';
        packageVersion: '11.21.0';
        registryIntegrity: string;
        packageRoot: string;
        packageTreeSha256: string;
        entrypointPath: string;
        entrypointSha256: string;
        shimPath: string;
        shimSha256: string;
        shellPath: string;
        shellSha256: string;
        runtimeRoot: string;
    }>;
}
/** Immutable executable and official DSH identities embedded in an operation opening event. */
export interface RecoveryExecutableBinding {
    readonly schemaVersion: 5;
    readonly executablePath: string;
    readonly executableSha256: string;
    readonly centerRoot: string;
    readonly packageVersion: string;
    readonly platform: 'darwin' | 'linux' | 'win32';
    readonly arch: string;
    readonly officialDsh: OfficialDshRecoveryBinding;
}
/**
 * Restore one recovery-required Plugin operation to its durable provider before-state.
 * @param centerRoot Exact Center-owned durable root.
 * @param operationId Exact durable operation identity.
 * @param invokedPath Executed recovery file path used for the self pin.
 */
export declare function recoverProfile(centerRoot: string, operationId: string, invokedPath: string): Promise<void>;
export {};
//# sourceMappingURL=break-glass.d.ts.map
