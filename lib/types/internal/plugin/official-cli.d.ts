import type { OfficialDshRecoveryBinding } from '../../plans/types.ts';
import { type ProfileMetadataCacheBinding } from '../../recovery/profile-metadata-cache.ts';
import type { ManagedPluginCli } from './types.ts';
/** Official Plugin CLI adapter bound to one private, hash-pinned execution toolchain. */
export declare class OfficialDshPluginCli implements ManagedPluginCli {
    private readonly binding;
    constructor(binding: OfficialDshRecoveryBinding);
    /** Verify provider-bound metadata and optionally require its exact pre-mutation Profile generation. */
    audit(profileId: string, metadataCache: ProfileMetadataCacheBinding | null, requireCurrentProfile: boolean): Promise<void>;
    /** Install one exact Center-owned archive through the official Profile package manager. */
    add(profileId: string, packageName: string, version: string, artifactPath: string, metadataCache?: ProfileMetadataCacheBinding | null): Promise<void>;
    /** Remove one exact direct dependency through the official Profile package manager. */
    remove(profileId: string, packageName: string, metadataCache?: ProfileMetadataCacheBinding | null): Promise<void>;
}
//# sourceMappingURL=official-cli.d.ts.map
