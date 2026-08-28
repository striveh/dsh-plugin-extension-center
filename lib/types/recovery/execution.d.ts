/** Verified private execution of the official DSH 0.1.2-alpha.1 Plugin CLI. */
import type { OfficialDshRecoveryBinding } from '../plans/types.ts';
import { type ProfileMetadataCacheBinding } from './profile-metadata-cache.ts';
/** Verify every executable and package identity in one official execution binding. */
export declare function verifyOfficialExecutionBinding(binding: OfficialDshRecoveryBinding): Promise<void>;
/** Reject Profile-local package-manager execution controls before any mutation starts. */
export declare function auditOfficialProfileExecution(binding: OfficialDshRecoveryBinding, profileId: string): Promise<string>;
/** Run one mutation through the pinned supervisor, private pnpm shim, and minimal environment. */
export declare function runBoundOfficialDsh(binding: OfficialDshRecoveryBinding, profileId: string, arguments_: readonly string[], label: string, metadataCache: ProfileMetadataCacheBinding): Promise<void>;
//# sourceMappingURL=execution.d.ts.map
