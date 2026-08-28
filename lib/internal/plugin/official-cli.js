import { runBoundOfficialDsh } from "../../recovery/execution.js";
import { prepareProfileMetadataCache, verifyProfileMetadataCache, } from "../../recovery/profile-metadata-cache.js";
function profileArgument(profileId) {
    if (profileId.length === 0 || profileId.length > 256 || profileId.includes('/') || profileId.includes('\\')
        || profileId.includes(':') || profileId.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(profileId)
        || profileId === '.' || profileId === '..' || profileId === 'node_modules') {
        throw new Error(`official DSH Plugin profile id is unsafe: ${profileId}`);
    }
    return profileId;
}
/** Official Plugin CLI adapter bound to one private, hash-pinned execution toolchain. */
export class OfficialDshPluginCli {
    binding;
    constructor(binding) {
        this.binding = binding;
    }
    /** Verify provider-bound metadata and optionally require its exact pre-mutation Profile generation. */
    async audit(profileId, metadataCache, requireCurrentProfile) {
        if (metadataCache === null)
            throw new Error('official DSH Plugin mutation has no provider-bound metadata cache');
        await verifyProfileMetadataCache(this.binding, metadataCache, requireCurrentProfile);
    }
    /** Install one exact Center-owned archive through the official Profile package manager. */
    async add(profileId, packageName, version, artifactPath, metadataCache) {
        const profile = profileArgument(profileId);
        const cache = metadataCache ?? await prepareProfileMetadataCache(this.binding, profile);
        await runBoundOfficialDsh(this.binding, profile, [
            'plugin', '--profile', profile, 'add', artifactPath, '--save-exact',
        ], `add ${packageName}@${version}`, cache);
    }
    /** Remove one exact direct dependency through the official Profile package manager. */
    async remove(profileId, packageName, metadataCache) {
        const profile = profileArgument(profileId);
        const cache = metadataCache ?? await prepareProfileMetadataCache(this.binding, profile);
        await runBoundOfficialDsh(this.binding, profile, ['plugin', '--profile', profile, 'remove', packageName], `remove ${packageName}`, cache);
    }
}
//# sourceMappingURL=official-cli.js.map
