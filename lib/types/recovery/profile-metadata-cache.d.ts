/** Content-addressed pnpm 11 registry metadata synthesized from one installed official Profile generation. */
import type { OfficialDshRecoveryBinding } from '../plans/types.ts';
/** One content-addressed metadata-cache generation verified by normal and break-glass official CLI paths. */
export interface ProfileMetadataCacheBinding {
    readonly schemaVersion: 1;
    readonly profileId: string;
    readonly profilePath: string;
    readonly generationPath: string;
    readonly generationSha256: `sha256:${string}`;
    readonly cachePath: string;
    readonly manifestPath: string;
    readonly manifestSha256: `sha256:${string}`;
    readonly profileManifestSha256: `sha256:${string}`;
    readonly lockfileSha256: `sha256:${string}` | null;
    readonly modulesSha256: `sha256:${string}` | null;
    readonly sourcePnpmVersion: string | null;
    readonly storeDir: string;
    readonly expectedStoreDir: string;
    readonly pnpmMajor: 11;
    readonly pnpmVersion: '11.7.0';
}
/** Strictly decode one provider-snapshot cache binding. */
export declare function decodeProfileMetadataCacheBinding(value: unknown, label?: string): ProfileMetadataCacheBinding;
/** Extract one nullable cache binding from a durable Plugin provider recovery point. */
export declare function profileMetadataCacheFromRecoveryPoint(value: unknown): ProfileMetadataCacheBinding | null;
/** Build or reuse the content-addressed cache generation for the Profile's exact pre-mutation state. */
export declare function prepareProfileMetadataCache(official: OfficialDshRecoveryBinding, profileIdValue: string): Promise<ProfileMetadataCacheBinding>;
/** Verify content-addressed cache provenance, contents, pnpm/store identity, and optionally current Profile generation. */
export declare function verifyProfileMetadataCache(official: OfficialDshRecoveryBinding, value: ProfileMetadataCacheBinding, requireCurrentProfile: boolean): Promise<void>;
//# sourceMappingURL=profile-metadata-cache.d.ts.map
