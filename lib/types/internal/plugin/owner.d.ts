import { CenterStateStore, type ManagedTargetRecord } from '../../host/index.ts';
import { type NpmPackageInspection } from '../../providers/npm-archive.ts';
import { type ProfileMetadataCacheBinding } from '../../recovery/profile-metadata-cache.ts';
import { type ManagedPluginAbsentRollback, type ManagedPluginActivation, type ManagedPluginBreakGlassRestore, type ManagedPluginCommitResult, type ManagedPluginLoader, type ManagedPluginOwnerOptions, type ManagedPluginSidecar, type ManagedPluginSnapshot } from './types.ts';
/** Center-owned material/state plus official DSH Profile CLI and Loader coordinator. */
export declare class ManagedPluginOwner {
    private readonly store;
    private readonly loader;
    private readonly root;
    private readonly hostHome;
    private readonly centerPackageName;
    private readonly cli;
    private readonly ownerId;
    private processIdentity;
    private initialized;
    constructor(store: CenterStateStore, loader: ManagedPluginLoader, options: ManagedPluginOwnerOptions);
    /** Reconcile durable desired state against official Profile packages and Loader rows. */
    initialize(): Promise<void>;
    /** Stable Center-owned Plugin state used for planning fences and restart diagnostics. */
    snapshot(profileId: string): Promise<ManagedPluginSnapshot>;
    /** Retain one admitted Bundle archive and its exact extracted-file evidence outside the Profile. */
    materialize(input: Readonly<{
        targetKey: string;
        profileId: string;
        packageName: string;
        version: string;
        integrity: string;
        archivePath: string;
        inspection: NpmPackageInspection;
    }>): Promise<ManagedPluginActivation>;
    /** Apply one desired record under a profile-wide lock and persist its owner sidecar first. */
    commit(before: ManagedTargetRecord | null, desired: ManagedTargetRecord, packageName: string, metadataCache?: ProfileMetadataCacheBinding | null): Promise<ManagedPluginCommitResult>;
    /** Prove exact Loader presence or absence for one settled managed record. */
    verify(record: ManagedTargetRecord): Promise<Readonly<{
        entryId: string;
        moduleName: string;
        fiberPhase: 'active' | 'absent';
    }>>;
    /** Read the durable owner projection, including a sidecar ahead of Center state after a crash. */
    sidecar(profileId: string, targetKey: string): Promise<ManagedPluginSidecar | null>;
    /** Restore a Plugin whose exact provider before-state was absent. */
    rollbackToAbsent(before: ManagedTargetRecord, packageName: string, operationId: string, metadataCache?: ProfileMetadataCacheBinding | null): Promise<ManagedPluginAbsentRollback>;
    /** Verify durable absence and exact runtime cleanup for one rollback receipt. */
    absentRollbackReceipt(input: Readonly<{
        operationId: string;
        targetKey: string;
        profileId: string;
    }>): Promise<ManagedPluginAbsentRollback | null>;
    /** Verify durable absence and exact runtime cleanup for one rollback receipt. */
    verifyAbsentRollback(input: Readonly<{
        operationId: string;
        targetKey: string;
        profileId: string;
    }>): Promise<ManagedPluginAbsentRollback>;
    /** Require a different Host process only when the removed package had Client code. */
    absentRollbackBootReady(operationId: string, profileId: string): Promise<boolean | null>;
    /** Remove transient rollback proof after the terminal operation receipt is durable. */
    finalizeAbsentRollback(operationId: string): Promise<void>;
    /** Read one immutable break-glass restore marker without starting ordinary Profile reconciliation. */
    breakGlassRestore(input: Readonly<{
        operationId: string;
        targetKey: string;
        profileId: string;
        packageName: string;
        journalHeadDigest: `sha256:${string}`;
        providerSnapshotDigest: `sha256:${string}`;
        beforeDigest: `sha256:${string}`;
    }>): Promise<ManagedPluginBreakGlassRestore | null>;
    private initializeOnce;
    private recoverAbsentRollbacks;
    private completeAbsentRollback;
    private absentRollbackPath;
    private breakGlassRestorePath;
    private readAbsentRollback;
    private auditMaterial;
    private activation;
    private assertOfficialBefore;
    private applyOfficialDesired;
    private observationHolds;
    private runOfficialDesired;
    private recoveryMutation;
    private operationMetadataCache;
    private applyCanonicalLoader;
    private awaitCanonicalLoaderRow;
    private settled;
    private profilePath;
    private profileDependency;
    private profileBundleCount;
    private verifyInstalledPackage;
    private canonicalRows;
    private profilePackagePath;
    private sidecarPath;
    private profileRecordPath;
    private readSidecar;
    private writeSidecar;
    private readSnapshot;
    private advanceProfile;
    private profileDigest;
    private stableOfficialObservation;
    private assertNoAmbiguity;
    private assertProfileNoAmbiguity;
    private failAmbiguous;
    private decodeQuarantine;
    private quarantinePath;
    private officialProfileObservation;
    private profileSidecars;
    private withProfileLock;
    private recoverStaleLocks;
    private recoverProfileLock;
    private assertProfileOwnerDead;
    private acquireProfileTakeover;
    private resumeProfileTakeovers;
    private assertNoProfileTakeover;
    private removeProfileTakeover;
    private installProfileTakeover;
    private listProfileTakeovers;
    private removeExactProfileTakeoverPath;
    private removeRetiredProfileTakeovers;
    private assertProfileTakeoverOwned;
    private readProfileTakeover;
    private currentProcessIdentity;
    private sameProcessIdentity;
    private leaseRoot;
    private leaseTakeoverRoot;
    private leaseQuarantineRoot;
    private quarantineRoot;
    private coordinationRoot;
    private operationKind;
    private packageName;
    private profileFromTarget;
    private assertNotSelf;
}
//# sourceMappingURL=owner.d.ts.map
