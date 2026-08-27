/** Atomic installer for the standalone recovery executable and its private execution toolchain. */
import type { RecoveryExecutableBinding } from '../plans/types.ts';
/** Inputs whose exact bytes become one durable recovery executable binding. */
export interface InstallRecoveryExecutableInput {
    readonly root: string;
    readonly packageVersion: string;
    readonly cliPath: string;
    readonly supervisorPath: string;
    readonly pnpmManifestPath?: string;
    readonly nodePath?: string;
    readonly officialDsh: Readonly<{
        readonly entrypointPath: string;
        readonly hostHome: string;
        readonly timeoutMs: number;
    }>;
    readonly platform?: 'darwin' | 'linux' | 'win32';
    readonly arch?: string;
}
/**
 * Install one immutable private CLI copy and bind it to an exact Center-owned state root.
 * @param input Built standalone CLI, supervisor, bundled pnpm, and Center-owned destination.
 * @returns Exact opening-event recovery executable binding.
 */
export declare function installRecoveryExecutable(input: InstallRecoveryExecutableInput): Promise<RecoveryExecutableBinding>;
/**
 * Materialize the built package's standalone CLI and private toolchain below the durable root.
 * @param root Center-owned durable root outside official Profile files.
 * @param officialDsh Exact installed official rc.2 CLI and Harness home.
 * @returns Exact executable binding embedded in every consumed operation.
 */
export declare function installPackagedRecoveryExecutable(root: string, officialDsh: InstallRecoveryExecutableInput['officialDsh']): Promise<RecoveryExecutableBinding>;
//# sourceMappingURL=install.d.ts.map
