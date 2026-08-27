import type { ManagedTargetRecord, ManagedVersion } from '../../host/index.ts';
import type { OfficialDshRecoveryBinding } from '../../plans/types.ts';
import type { ProfileMetadataCacheBinding } from '../../recovery/profile-metadata-cache.ts';
import type { RpcJson } from '../../service/rpc-contract.ts';
/** Stable reason emitted when official Profile state cannot be safely classified or compensated. */
export declare const OFFICIAL_PROFILE_AMBIGUITY_CODE: "profile-state-ambiguous";
/** Fail-closed signal that retains both operation and Profile quarantine until explicit recovery. */
export declare class OfficialProfileAmbiguityError extends Error {
    readonly code: "profile-state-ambiguous";
    constructor(message: string, options?: ErrorOptions);
}
/** Identify a Profile ambiguity across provider and operation-runner layers. */
export declare function isOfficialProfileAmbiguityError(error: unknown): error is OfficialProfileAmbiguityError;
/** Official Loader mutation surface used by the Center-owned Plugin owner. */
export interface ManagedPluginLoader {
    update(id: string, options: Readonly<{
        config?: unknown;
        group?: boolean | null;
        disabled?: boolean | null;
        inject?: unknown;
    }>, parent?: string | null, position?: number): Promise<void>;
    await(): Promise<void>;
    entries(): Iterable<Readonly<{
        id: string;
        options: Readonly<{
            id?: string;
            name: string;
            config?: unknown;
            group?: boolean;
        }>;
        disabled: boolean;
        refresh(): Promise<void>;
        fiber?: Readonly<{
            state: number;
            await(): Promise<unknown>;
        }>;
    }>>;
}
/** Coordinates used for read-only Profile verification and official-CLI delegation; the owner never writes Profile files directly. */
export interface ManagedPluginOwnerOptions {
    readonly hostHome: string;
    readonly centerPackageName?: string;
    /** Startup quarantine decided from the exact durable operation authorization before owner reconciliation. */
    readonly isOperationQuarantined?: (operationId: string, targetKey: string, profileId: string) => boolean;
    /** Target-wide startup quarantine for every retired unfinished Plugin operation. */
    readonly isTargetQuarantined?: (targetKey: string, profileId: string) => boolean;
    /** Durable official CLI, Node, DSH closure, supervisor, and private pnpm binding. */
    readonly officialDsh?: OfficialDshRecoveryBinding;
    /** Deterministic official-CLI seam used only by focused owner tests. */
    readonly pluginCli?: ManagedPluginCli;
}
/** Exact official Profile package-manager mutations available to the owner. */
export interface ManagedPluginCli {
    audit(profileId: string, metadataCache: ProfileMetadataCacheBinding | null, requireCurrentProfile: boolean): Promise<void>;
    add(profileId: string, packageName: string, version: string, artifactPath: string, metadataCache?: ProfileMetadataCacheBinding | null): Promise<void>;
    remove(profileId: string, packageName: string, metadataCache?: ProfileMetadataCacheBinding | null): Promise<void>;
}
/** Stable Center-owned state used for plan fences and startup diagnostics. */
export interface ManagedPluginSnapshot {
    readonly profileId: string;
    readonly revision: number;
    readonly digest: `sha256:${string}`;
    readonly materialRoot: string;
    readonly bootStatus: 'live' | 'pending-restart' | 'verified';
    readonly ownerRevision: string;
}
/** Loader addressing derived from one admitted package manifest. */
export interface ManagedPluginActivation {
    readonly targetKey: string;
    readonly packageName: string;
    readonly materialPath: string;
    readonly artifactPath: string;
    readonly artifactSizeBytes: number;
    readonly artifactSha256: `sha256:${string}`;
    readonly artifactRevision: string;
    readonly artifactIntegrity: string;
    readonly loaderName: string;
    readonly manifestDigest: `sha256:${string}`;
    readonly bundlePatchPath: string;
    readonly files: readonly ManagedPluginFileEvidence[];
    readonly configuration: RpcJson;
}
/** Durable owner sidecar written before the Center projection advances. */
export interface ManagedPluginSidecar {
    readonly schemaVersion: 1;
    readonly profileId: string;
    readonly packageName: string;
    readonly targetKey: string;
    readonly revision: number;
    readonly lastOperationId: string | null;
    readonly managed: ManagedTargetRecord;
    readonly loaderEntryId: string | null;
    readonly loaderName: string | null;
    readonly restartPending: boolean;
    readonly lastGoodMaterialPath: string | null;
    readonly tombstoneMaterialPath: string | null;
}
/** Result of applying one exact desired record to filesystem and Loader state. */
export interface ManagedPluginCommitResult {
    readonly sidecar: ManagedPluginSidecar;
    readonly restartRequired: boolean;
}
/** Durable proof that rollback restored an initially absent managed Plugin. */
export interface ManagedPluginAbsentRollback {
    readonly schemaVersion: 1;
    readonly operationId: string;
    readonly targetKey: string;
    readonly profileId: string;
    readonly packageName: string;
    readonly sourceRevision: number;
    readonly sourceDigest: `sha256:${string}`;
    readonly loaderEntryId: string | null;
    readonly loaderName: string | null;
    readonly restartRequired: boolean;
    readonly createdByOwnerId: string;
    readonly status: 'pending' | 'settled';
}
/** Settled evidence that the pinned recovery executable restored official and Center before-state. */
export interface ManagedPluginBreakGlassRestore {
    readonly schemaVersion: 1;
    readonly operationId: string;
    readonly targetKey: string;
    readonly profileId: string;
    readonly packageName: string;
    readonly journalHeadDigest: `sha256:${string}`;
    readonly providerSnapshotDigest: `sha256:${string}`;
    readonly beforeDigest: `sha256:${string}`;
    readonly restoredManagedDigest: `sha256:${string}`;
    readonly restoredRevision: number | null;
    readonly status: 'settled';
}
/** Material metadata retained beside, rather than inside, immutable package bytes. */
export interface ManagedPluginMaterialMarker {
    readonly schemaVersion: 1;
    readonly targetKey: string;
    readonly packageName: string;
    readonly version: string;
    readonly integrity: string;
    readonly artifactPath: string;
    readonly artifactSizeBytes: number;
    readonly artifactSha256: `sha256:${string}`;
    readonly manifestDigest: string;
    readonly files: readonly ManagedPluginFileEvidence[];
}
/** Exact regular-file evidence used for material and installed-tree audits. */
export interface ManagedPluginFileEvidence {
    readonly path: string;
    readonly sizeBytes: number;
    readonly sha256: `sha256:${string}`;
}
/** Resolve one nullable managed version into its package activation. */
export type ManagedPluginActivationResolver = (targetKey: string, packageName: string, profileId: string, version: ManagedVersion) => Promise<ManagedPluginActivation>;
//# sourceMappingURL=types.d.ts.map
