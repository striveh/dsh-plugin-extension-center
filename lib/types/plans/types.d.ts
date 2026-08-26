import type { ArtifactIntegrity, Sha256Digest } from '../domain/json.ts';
/** Current immutable plan schema. */
export declare const IMMUTABLE_PLAN_SCHEMA_VERSION: 1;
/** Lifecycle mutations represented by one exact plan. */
export type OperationKind = 'install' | 'configure' | 'update' | 'enable' | 'disable' | 'uninstall' | 'restore' | 'purge';
/** Extension kinds managed by independent providers. */
export type ManagedExtensionKind = 'plugin' | 'mcp' | 'skill';
/** Product object changed by an approved lifecycle operation. */
export type ManagedObject = 'artifact' | 'connection';
/** Whether the approved operation acquires extension bytes from the catalog. */
export type ExternalRuntimeAction = 'download' | 'none';
/** Exact preprovisioned runtime bound into an MCP connection plan. */
export interface RuntimeBinding {
    readonly runtimeRef: string;
    readonly version: string;
    readonly descriptorDigest: Sha256Digest;
}
/** Exact desired state bound into a plan. */
export type DesiredState = 'enabled' | 'disabled' | 'removed';
/** Authoritative revisions that must still match when a plan is decided and consumed. */
export interface PlanRevisionFences {
    readonly catalogRevision: number;
    readonly inventoryRevision: Sha256Digest;
    readonly targetRevision: string;
    readonly ownerRevision: string;
    readonly scopeRevision: string;
    readonly profileRevision: string;
}
/** Lifecycle review checks whose successful execution may be recorded in a receipt. */
export type ReviewCheckCode = 'catalog-admission' | 'owner-revision' | 'review-record' | 'artifact-integrity' | 'plugin-manifest' | 'plugin-dependencies' | 'plugin-lifecycle-scripts' | 'plugin-bundle' | 'plugin-settings-schema' | 'profile-lockfile' | 'isolated-profile-boot' | 'loader-consumer' | 'skill-file-manifest' | 'skill-frontmatter' | 'skill-body' | 'skill-links' | 'skill-executables' | 'invocation-policy' | 'merged-skill-winner' | 'mcp-runtime-integrity' | 'mcp-descriptor' | 'mcp-secret-absence' | 'mcp-initialize' | 'mcp-tools-list' | 'mcp-tool-generation' | 'owner-mutation' | 'owner-absence' | 'quiescent-disposal';
/** Operation phase that owns one review check. */
export type ReviewCheckPhase = 'planning' | 'prepare' | 'apply' | 'verify' | 'external-restart';
/** One stable check disclosed before approval. */
export interface PlannedReviewCheck {
    readonly code: ReviewCheckCode;
    readonly phase: ReviewCheckPhase;
}
/** Exact material disclosed as removed or retained by an operation. */
export interface ReviewMaterial {
    readonly kind: 'profile-dependency' | 'profile-lockfile' | 'bundle-row' | 'plugin-settings' | 'skill-file' | 'connection-row' | 'credential-record' | 'external-runtime' | 'remote-data' | 'recovery-point';
    readonly id: string;
    readonly digest: Sha256Digest | null;
}
/** Exact recovery point bound before an operation may mutate owner state. */
export interface ReviewRollbackPoint {
    readonly kind: 'absent-state' | 'managed-version' | 'profile-generation';
    readonly id: string;
    readonly digest: Sha256Digest;
}
/** Limits that remain true even when DSH-managed rollback succeeds. */
export type ReviewRollbackLimit = 'dsh-managed-state-only' | 'remote-grants-not-revoked' | 'third-party-side-effects-not-reversed' | 'external-runtime-not-restored' | 'workspace-files-not-restored' | 'purge-irreversible' | 'restart-required-before-runtime-proof';
/** Claims intentionally not represented as verified by an immutable plan. */
export type ReviewNotProvenClaim = 'catalog-admission-is-not-security-audit' | 'target-lockfile-bytes-before-staging' | 'third-party-code-side-effects' | 'remote-side-effects' | 'external-runtime-state' | 'post-restart-consumer' | 'user-task-outcome';
/** Fields shared by every kind-specific approval record. */
export interface ReviewEvidenceBase {
    readonly schemaVersion: 1;
    readonly operationKind: OperationKind;
    readonly checks: readonly PlannedReviewCheck[];
    readonly removed: readonly ReviewMaterial[];
    readonly retained: readonly ReviewMaterial[];
    readonly credentialChoice: 'not-applicable' | 'retain-local-record' | 'delete-local-record';
    readonly rollbackPoint: ReviewRollbackPoint | null;
    readonly rollbackLimits: readonly ReviewRollbackLimit[];
    readonly notProven: readonly ReviewNotProvenClaim[];
}
/** Exact dependency change displayed for a Profile Plugin operation. */
export interface PluginDependencyChange {
    readonly kind: 'profile' | 'host' | 'runtime' | 'extension' | 'peer';
    readonly id: string;
    readonly beforeVersion: string | null;
    readonly afterVersion: string | null;
    readonly required: boolean;
}
/** Secret-free, artifact-pinned Profile Plugin review evidence. */
export interface PluginReviewEvidence extends ReviewEvidenceBase {
    readonly kind: 'plugin';
    readonly manifest: Readonly<{
        packageName: string;
        beforeVersion: string | null;
        afterVersion: string | null;
        body: string;
        manifestDigest: Sha256Digest;
        files: readonly string[];
        fileManifestDigest: Sha256Digest;
    }>;
    readonly dependencies: readonly PluginDependencyChange[];
    readonly lockfile: Readonly<{
        path: 'pnpm-lock.yaml';
        beforeDigest: Sha256Digest | null;
        packageName: string;
        beforeVersion: string | null;
        afterVersion: string | null;
        targetIntegrity: ArtifactIntegrity | null;
    }>;
    readonly bundles: readonly Readonly<{
        id: string;
        action: 'add' | 'retain' | 'remove' | 'restore';
        patchDigest: Sha256Digest;
        patchBody: string;
    }>[];
    readonly scripts: Readonly<{
        before: readonly string[];
        after: readonly string[];
        forbiddenLifecycle: readonly string[];
    }>;
    readonly settings: Readonly<{
        adapterVersion: string | null;
        adapterDigest: Sha256Digest | null;
        schemaDigest: Sha256Digest | null;
        ownerRevision: string;
        migration: 'not-required' | 'validated' | 'pending';
        schema: readonly Readonly<{
            field: string;
            type: 'integer';
            minimum: number;
            maximum: number;
        }>[];
        migrationChanges: readonly string[];
        diffDigest: Sha256Digest;
    }>;
}
/** Exact file change displayed for a Skill operation. */
export interface SkillFileChange {
    readonly path: string;
    readonly change: 'add' | 'retain' | 'replace' | 'remove' | 'restore' | 'purge';
    readonly beforeDigest: Sha256Digest | null;
    readonly afterDigest: Sha256Digest | null;
    readonly sizeBytes: number;
    readonly executableBefore: boolean;
    readonly executableAfter: boolean;
    readonly linkBefore: string | null;
    readonly linkAfter: string | null;
}
/** Secret-free, complete Skill content and invocation review evidence. */
export interface SkillReviewEvidence extends ReviewEvidenceBase {
    readonly kind: 'skill';
    readonly files: readonly SkillFileChange[];
    readonly body: Readonly<{
        before: string | null;
        after: string | null;
        beforeDigest: Sha256Digest | null;
        afterDigest: Sha256Digest | null;
    }>;
    readonly invocation: Readonly<{
        beforeModelInvocable: boolean | null;
        beforeUserInvocable: boolean | null;
        afterModelInvocable: boolean | null;
        afterUserInvocable: boolean | null;
    }>;
}
/** Exact stdio descriptor bound to an MCP plan without secret-bearing fields. */
export interface McpStdioReviewDescriptor {
    readonly transport: 'stdio';
    readonly serverName: string;
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
    readonly toolCallTimeoutMs: number;
    readonly reconnect: Readonly<{
        enabled: boolean;
        initialDelayMs: number;
        maxDelayMs: number;
        maxAttempts: number;
    }>;
}
/** Exact unauthenticated HTTP descriptor bound to an MCP plan. */
export interface McpHttpReviewDescriptor {
    readonly transport: 'http';
    readonly serverName: string;
    readonly origin: string;
    readonly endpoint: string;
    readonly authentication: 'none';
    readonly redirects: 'forbidden';
    readonly dataEgressDisclosure: string;
    readonly toolCallTimeoutMs: number;
    readonly reconnect: Readonly<{
        enabled: boolean;
        initialDelayMs: number;
        maxDelayMs: number;
        maxAttempts: number;
    }>;
}
/** Secret-free MCP connection review evidence; authentication fields do not exist in P0. */
export interface McpReviewEvidence extends ReviewEvidenceBase {
    readonly kind: 'mcp';
    readonly descriptor: McpStdioReviewDescriptor | McpHttpReviewDescriptor;
    readonly runtime: Readonly<{
        ownership: 'host' | 'remote';
        version: string;
        digest: Sha256Digest | null;
        action: 'none';
    }>;
    readonly credentials: 'none';
    readonly dataEgress: 'local-process' | 'remote-origin';
}
/** Strict discriminated review record carried by plans, journals, and receipts. */
export type PlanReviewEvidence = PluginReviewEvidence | SkillReviewEvidence | McpReviewEvidence;
/** Canonical content protected by an immutable plan hash. */
export interface PlanContent {
    readonly schemaVersion: typeof IMMUTABLE_PLAN_SCHEMA_VERSION;
    readonly singleUse: true;
    readonly planId: string;
    readonly intentId: string;
    readonly origin: 'store' | 'task';
    readonly candidateRef: string;
    readonly extensionKind: ManagedExtensionKind;
    readonly extensionId: string;
    readonly managedObject: ManagedObject;
    readonly externalRuntimeAction: ExternalRuntimeAction;
    readonly runtimeBinding: RuntimeBinding | null;
    readonly artifactRevision: string;
    readonly artifactIntegrity: ArtifactIntegrity;
    readonly artifactUrl: string;
    readonly artifactSizeBytes: number;
    readonly operationKind: OperationKind;
    readonly desiredState: DesiredState;
    readonly targetKey: string;
    readonly ownerKey: string;
    readonly scopeKey: string;
    readonly profileId: string;
    readonly idempotencyKey: string;
    readonly authorityDigest: Sha256Digest;
    readonly configurationDigest: Sha256Digest;
    readonly retentionDigest: Sha256Digest;
    readonly mutationDigest: Sha256Digest;
    readonly verificationDigest: Sha256Digest;
    readonly reviewEvidence: PlanReviewEvidence;
    readonly restartRequired: boolean;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
    readonly fences: PlanRevisionFences;
}
/** One recursively frozen plan and its canonical content digest. */
export interface ImmutablePlan {
    readonly content: PlanContent;
    readonly hash: Sha256Digest;
}
/** Human decision submitted through a separate trusted surface. */
export interface PlanDecisionInput {
    readonly planId: string;
    readonly planHash: Sha256Digest;
    readonly operationKind: OperationKind;
    readonly decision: 'approve' | 'reject';
}
/** Current owner observations required to authorize the exact plan. */
export interface PlanUseContext {
    readonly operationKind: OperationKind;
    readonly targetKey: string;
    readonly ownerKey: string;
    readonly scopeKey: string;
    readonly profileId: string;
    readonly fences: PlanRevisionFences;
}
/** Immutable record of the single human decision. */
export interface PlanDecisionRecord extends PlanDecisionInput {
    readonly decidedAtMs: number;
}
/** Hash-pinned standalone recovery executable, public DSH CLI, and Host home. */
export interface RecoveryExecutableBinding {
    readonly schemaVersion: 2;
    readonly executablePath: string;
    readonly executableSha256: Sha256Digest;
    readonly hostCliPath: string;
    readonly hostCliSha256: Sha256Digest;
    readonly hostHome: string;
    readonly packageVersion: string;
    readonly platform: 'darwin' | 'linux' | 'win32';
    readonly arch: string;
}
/** Authorization emitted only after an approved plan is consumed once. */
export interface OperationAuthorization {
    readonly operationId: string;
    readonly planId: string;
    readonly planHash: Sha256Digest;
    readonly origin: 'store' | 'task';
    readonly candidateRef: string;
    readonly extensionKind: ManagedExtensionKind;
    readonly extensionId: string;
    readonly operationKind: OperationKind;
    readonly managedObject: ManagedObject;
    readonly externalRuntimeAction: ExternalRuntimeAction;
    readonly runtimeBinding: RuntimeBinding | null;
    readonly artifactRevision: string;
    readonly artifactIntegrity: ArtifactIntegrity;
    readonly artifactUrl: string;
    readonly artifactSizeBytes: number;
    readonly desiredState: DesiredState;
    readonly targetKey: string;
    readonly ownerKey: string;
    readonly scopeKey: string;
    readonly profileId: string;
    readonly idempotencyKey: string;
    readonly authorityDigest: Sha256Digest;
    readonly configurationDigest: Sha256Digest;
    readonly retentionDigest: Sha256Digest;
    readonly mutationDigest: Sha256Digest;
    readonly verificationDigest: Sha256Digest;
    readonly reviewEvidence: PlanReviewEvidence;
    readonly restartRequired: boolean;
    readonly fences: PlanRevisionFences;
    readonly recoveryExecutable: RecoveryExecutableBinding;
    readonly authorizedAtMs: number;
}
/** Initial plan state before a trusted human decision. */
export interface PendingPlanState {
    readonly status: 'pending';
    readonly plan: ImmutablePlan;
}
/** Plan state after its one approval, before operation authorization is consumed. */
export interface ApprovedPlanState {
    readonly status: 'approved';
    readonly plan: ImmutablePlan;
    readonly decision: PlanDecisionRecord;
}
/** Terminal plan state after human rejection. */
export interface RejectedPlanState {
    readonly status: 'rejected';
    readonly plan: ImmutablePlan;
    readonly decision: PlanDecisionRecord;
}
/** Terminal plan state after expiry before a valid decision or consumption. */
export interface ExpiredPlanState {
    readonly status: 'expired';
    readonly plan: ImmutablePlan;
    readonly expiredAtMs: number;
}
/** Terminal plan state after its authorization is consumed once. */
export interface ConsumedPlanState {
    readonly status: 'consumed';
    readonly plan: ImmutablePlan;
    readonly decision: PlanDecisionRecord;
    readonly authorization: OperationAuthorization;
}
/** Complete immutable authorization state for one plan. */
export type PlanAuthorizationState = PendingPlanState | ApprovedPlanState | RejectedPlanState | ExpiredPlanState | ConsumedPlanState;
/** Result of one trusted human decision. */
export interface PlanDecisionTransition {
    readonly state: ApprovedPlanState | RejectedPlanState | ExpiredPlanState;
    readonly authorization: null;
}
/** Result of consuming one approved plan. */
export interface PlanConsumptionTransition {
    readonly state: ConsumedPlanState;
    readonly authorization: OperationAuthorization;
}
//# sourceMappingURL=types.d.ts.map
