import type { OfficialDshRecoveryBinding } from '../../plans/types.ts'
import { runBoundOfficialDsh } from '../../recovery/execution.ts'
import {
  prepareProfileMetadataCache,
  verifyProfileMetadataCache,
  type ProfileMetadataCacheBinding,
} from '../../recovery/profile-metadata-cache.ts'
import type { ManagedPluginCli } from './types.ts'

function profileArgument(profileId: string): string {
  if (profileId.length === 0 || profileId.length > 256 || profileId.includes('/') || profileId.includes('\\')
    || profileId.includes(':') || profileId.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(profileId)
    || profileId === '.' || profileId === '..' || profileId === 'node_modules') {
    throw new Error(`official DSH Plugin profile id is unsafe: ${profileId}`)
  }
  return profileId
}

/** Official rc.2 Plugin CLI adapter bound to one private, hash-pinned execution toolchain. */
export class OfficialDshPluginCli implements ManagedPluginCli {
  constructor(private readonly binding: OfficialDshRecoveryBinding) {}

  /** Verify provider-bound metadata and optionally require its exact pre-mutation Profile generation. */
  async audit(
    profileId: string,
    metadataCache: ProfileMetadataCacheBinding | null,
    requireCurrentProfile: boolean,
  ): Promise<void> {
    if (metadataCache === null) throw new Error('official DSH Plugin mutation has no provider-bound metadata cache')
    await verifyProfileMetadataCache(this.binding, metadataCache, requireCurrentProfile)
  }

  /** Install one exact Center-owned archive through the official Profile package manager. */
  async add(
    profileId: string,
    packageName: string,
    version: string,
    artifactPath: string,
    metadataCache?: ProfileMetadataCacheBinding | null,
  ): Promise<void> {
    const profile = profileArgument(profileId)
    const cache = metadataCache ?? await prepareProfileMetadataCache(this.binding, profile)
    await runBoundOfficialDsh(this.binding, profile, [
      'plugin', '--profile', profile, 'add', artifactPath, '--save-exact',
    ], `add ${packageName}@${version}`, cache)
  }

  /** Remove one exact direct dependency through the official Profile package manager. */
  async remove(
    profileId: string,
    packageName: string,
    metadataCache?: ProfileMetadataCacheBinding | null,
  ): Promise<void> {
    const profile = profileArgument(profileId)
    const cache = metadataCache ?? await prepareProfileMetadataCache(this.binding, profile)
    await runBoundOfficialDsh(
      this.binding,
      profile,
      ['plugin', '--profile', profile, 'remove', packageName],
      `remove ${packageName}`,
      cache,
    )
  }
}
