/** Atomic installer for the dependency-free break-glass executable pin. */
import type { RecoveryExecutableBinding } from '../plans/types.ts';
/** Inputs whose exact bytes become one durable recovery executable binding. */
export interface InstallRecoveryExecutableInput {
    readonly root: string;
    readonly packageVersion: string;
    readonly cliPath: string;
    readonly hostCliPath: string;
    readonly platform?: 'darwin' | 'linux' | 'win32';
    readonly arch?: string;
}
/**
 * Install one immutable private CLI copy and bind it to an exact Host CLI hash.
 * @param input Built standalone CLI, Host CLI, and Center-owned destination.
 * @returns Exact opening-event recovery executable binding.
 */
export declare function installRecoveryExecutable(input: InstallRecoveryExecutableInput): Promise<RecoveryExecutableBinding>;
/**
 * Materialize the built package's standalone CLI and bind the exact DSH CLI that launched this Host.
 * @param root Center-owned durable root outside the installed Profile generation.
 * @returns Exact executable binding embedded in every consumed operation.
 */
export declare function installPackagedRecoveryExecutable(root: string): Promise<RecoveryExecutableBinding>;
//# sourceMappingURL=install.d.ts.map
