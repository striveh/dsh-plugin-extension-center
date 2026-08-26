#!/usr/bin/env node
/**
 * Standalone, read-only Center journal verifier and Host Profile recovery CLI.
 *
 * This module imports only Node built-ins so an installed byte-for-byte pin can
 * run after the Center runtime or its dependency graph is unavailable.
 */
/** Immutable executable and Host-home identities embedded in the operation opening event. */
export interface RecoveryExecutableBinding {
    readonly schemaVersion: 2;
    readonly executablePath: string;
    readonly executableSha256: string;
    readonly hostCliPath: string;
    readonly hostCliSha256: string;
    readonly hostHome: string;
    readonly packageVersion: string;
    readonly platform: 'darwin' | 'linux' | 'win32';
    readonly arch: string;
}
/**
 * Verify one recovery-required Plugin journal and publish its Host-owned recovery target.
 * @param centerRoot Exact Center durable root.
 * @param operationId Exact durable operation identity.
 * @param invokedPath Executed recovery CLI path used for the self pin.
 */
export declare function recoverProfile(centerRoot: string, operationId: string, invokedPath: string): Promise<void>;
//# sourceMappingURL=break-glass.d.ts.map
