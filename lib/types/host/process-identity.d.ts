/** Platforms with a concrete process-birth probe used by durable lock recovery. */
export type ProcessIdentityPlatform = 'darwin' | 'linux' | 'win32';
/** PID plus content-addressed process-birth evidence captured by the lock owner. */
export interface ProcessIdentity {
    readonly schemaVersion: 1;
    readonly pid: number;
    readonly platform: ProcessIdentityPlatform;
    readonly machineDigest: `sha256:${string}` | null;
    readonly bootDigest: `sha256:${string}` | null;
    readonly birthDigest: `sha256:${string}` | null;
}
/** Conservative result of comparing a durable owner with the process currently using its PID. */
export type ProcessIdentityStatus = 'alive' | 'dead' | 'unknown';
/** Decode process evidence at a durable-file boundary. */
export declare function decodeProcessIdentity(value: unknown, label: string): ProcessIdentity;
/** Capture this process without failing lock acquisition when the platform probe is temporarily unavailable. */
export declare function captureCurrentProcessIdentity(): Promise<ProcessIdentity>;
/** Prove that the original owner remains alive or is irreversibly gone; uncertainty never authorizes recovery. */
export declare function inspectProcessIdentity(value: ProcessIdentity): Promise<ProcessIdentityStatus>;
//# sourceMappingURL=process-identity.d.ts.map
