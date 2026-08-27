import { isAbsolute } from 'node:path'
import {
  readArtifactIntegrity,
  readBoundedString,
  readLiteral,
  readNonNegativeInteger,
  readSha256Digest,
  readStrictRecord,
} from '../domain/codec.ts'
import { failDomain } from '../domain/errors.ts'
import { canonicalSha256, immutableJsonClone } from '../domain/json.ts'
import {
  IMMUTABLE_PLAN_SCHEMA_VERSION,
  type DesiredState,
  type ImmutablePlan,
  type ManagedExtensionKind,
  type OperationAuthorization,
  type PlanAuthorizationState,
  type PlanDecisionRecord,
  type OperationKind,
  type PlanContent,
  type PlanDecisionInput,
  type PlanRevisionFences,
  type RecoveryExecutableBinding,
  type PlanUseContext,
} from './types.ts'
import { decodePlanReviewEvidence } from './review-codec.ts'
import {
  isCurrentPnpmExecutionIdentity,
  isReadablePnpmExecutionIdentity,
  type ReadablePnpmExecutionIdentity,
} from './pnpm-runtime.ts'

const OPERATION_KINDS: readonly OperationKind[] = [
  'install',
  'configure',
  'update',
  'enable',
  'disable',
  'uninstall',
  'restore',
  'purge',
]
const EXTENSION_KINDS: readonly ManagedExtensionKind[] = ['plugin', 'mcp', 'skill']
const DESIRED_STATES: readonly DesiredState[] = ['enabled', 'disabled', 'removed']
const MANAGED_OBJECTS = ['artifact', 'connection'] as const
const EXTERNAL_RUNTIME_ACTIONS = ['download', 'none'] as const

function decodeRuntimeBinding(value: unknown, path: string): PlanContent['runtimeBinding'] {
  if (value === null) return null
  const record = readStrictRecord(value, ['descriptorDigest', 'runtimeRef', 'version'], path)
  return immutableJsonClone({
    runtimeRef: readBoundedString(record.runtimeRef, `${path}.runtimeRef`),
    version: readBoundedString(record.version, `${path}.version`),
    descriptorDigest: readSha256Digest(record.descriptorDigest, `${path}.descriptorDigest`),
  }) as PlanContent['runtimeBinding']
}

function decodeRecoveryExecutableBindingWithIdentity(
  value: unknown,
  path: string,
  readRetired: boolean,
): RecoveryExecutableBinding {
  const record = readStrictRecord(value, [
    'arch', 'centerRoot', 'executablePath', 'executableSha256', 'officialDsh', 'packageVersion', 'platform', 'schemaVersion',
  ], path)
  const executablePath = readBoundedString(record.executablePath, `${path}.executablePath`, 4_096)
  const centerRoot = readBoundedString(record.centerRoot, `${path}.centerRoot`, 4_096)
  const arch = readBoundedString(record.arch, `${path}.arch`, 64)
  const officialDsh = readStrictRecord(record.officialDsh, [
    'entrypointPath', 'entrypointSha256', 'hostHome', 'packageName', 'packageRoot', 'packageTreeSha256',
    'packageVersion', 'pnpm', 'productionDependencies', 'schemaVersion', 'supervisorPath', 'supervisorSha256',
    'timeoutMs', 'node',
  ], `${path}.officialDsh`)
  const packageRoot = readBoundedString(officialDsh.packageRoot, `${path}.officialDsh.packageRoot`, 4_096)
  const entrypointPath = readBoundedString(officialDsh.entrypointPath, `${path}.officialDsh.entrypointPath`, 4_096)
  const hostHome = readBoundedString(officialDsh.hostHome, `${path}.officialDsh.hostHome`, 4_096)
  const supervisorPath = readBoundedString(officialDsh.supervisorPath, `${path}.officialDsh.supervisorPath`, 4_096)
  const timeoutMs = readNonNegativeInteger(officialDsh.timeoutMs, `${path}.officialDsh.timeoutMs`)
  const node = readStrictRecord(officialDsh.node, [
    'executablePath', 'executableSha256', 'schemaVersion', 'version',
  ], `${path}.officialDsh.node`)
  const nodePath = readBoundedString(node.executablePath, `${path}.officialDsh.node.executablePath`, 4_096)
  const nodeVersion = readBoundedString(node.version, `${path}.officialDsh.node.version`, 64)
  const pnpm = readStrictRecord(officialDsh.pnpm, [
    'entrypointPath', 'entrypointSha256', 'packageName', 'packageRoot', 'packageTreeSha256', 'packageVersion',
    'registryIntegrity', 'runtimeRoot', 'schemaVersion', 'shellPath', 'shellSha256', 'shimPath', 'shimSha256',
  ], `${path}.officialDsh.pnpm`)
  const pnpmPackageRoot = readBoundedString(pnpm.packageRoot, `${path}.officialDsh.pnpm.packageRoot`, 4_096)
  const pnpmEntrypoint = readBoundedString(pnpm.entrypointPath, `${path}.officialDsh.pnpm.entrypointPath`, 4_096)
  const pnpmShim = readBoundedString(pnpm.shimPath, `${path}.officialDsh.pnpm.shimPath`, 4_096)
  const pnpmShell = readBoundedString(pnpm.shellPath, `${path}.officialDsh.pnpm.shellPath`, 4_096)
  const runtimeRoot = readBoundedString(pnpm.runtimeRoot, `${path}.officialDsh.pnpm.runtimeRoot`, 4_096)
  const pnpmIdentity = {
    packageVersion: pnpm.packageVersion,
    registryIntegrity: pnpm.registryIntegrity,
  }
  if (record.schemaVersion !== 5 || !isAbsolute(executablePath) || !isAbsolute(centerRoot)
    || !/^[a-z0-9][a-z0-9._-]*$/u.test(arch)) {
    failDomain('invalid-data', `${path} values are invalid`)
  }
  if (officialDsh.schemaVersion !== 2 || officialDsh.packageName !== '@deepseek-ai/dsh'
    || officialDsh.packageVersion !== '0.1.1-rc.2' || !isAbsolute(packageRoot)
    || !isAbsolute(entrypointPath) || !isAbsolute(hostHome) || !isAbsolute(supervisorPath)
    || timeoutMs < 1_000 || timeoutMs > 600_000 || node.schemaVersion !== 1 || !isAbsolute(nodePath)
    || !/^v\d+\.\d+\.\d+(?:[-+].*)?$/u.test(nodeVersion) || pnpm.schemaVersion !== 1
    || pnpm.packageName !== 'pnpm'
    || !(readRetired ? isReadablePnpmExecutionIdentity(pnpmIdentity) : isCurrentPnpmExecutionIdentity(pnpmIdentity))
    || ![pnpmPackageRoot, pnpmEntrypoint, pnpmShim, pnpmShell, runtimeRoot].every(isAbsolute)) {
    failDomain('invalid-data', `${path}.officialDsh values are invalid`)
  }
  if (!Array.isArray(officialDsh.productionDependencies) || officialDsh.productionDependencies.length > 1_024) {
    failDomain('invalid-data', `${path}.officialDsh.productionDependencies is invalid`)
  }
  const productionDependencies = officialDsh.productionDependencies.map((dependency, index) => {
    const dependencyPath = `${path}.officialDsh.productionDependencies[${String(index)}]`
    const item = readStrictRecord(dependency, [
      'packageName', 'packageRoot', 'packageTreeSha256', 'packageVersion',
    ], dependencyPath)
    const dependencyRoot = readBoundedString(item.packageRoot, `${dependencyPath}.packageRoot`, 4_096)
    if (!isAbsolute(dependencyRoot)) failDomain('invalid-data', `${dependencyPath}.packageRoot must be absolute`)
    return {
      packageName: readBoundedString(item.packageName, `${dependencyPath}.packageName`, 256),
      packageVersion: readBoundedString(item.packageVersion, `${dependencyPath}.packageVersion`, 128),
      packageRoot: dependencyRoot,
      packageTreeSha256: readSha256Digest(item.packageTreeSha256, `${dependencyPath}.packageTreeSha256`),
    }
  })
  const dependencyKeys = productionDependencies.map(item => `${item.packageName}\0${item.packageVersion}\0${item.packageRoot}`)
  if (new Set(dependencyKeys).size !== dependencyKeys.length
    || dependencyKeys.some((key, index) => index > 0 && dependencyKeys[index - 1]!.localeCompare(key) >= 0)) {
    failDomain('invalid-data', `${path}.officialDsh.productionDependencies must be sorted and unique`)
  }
  return immutableJsonClone({
    schemaVersion: 5,
    executablePath,
    executableSha256: readSha256Digest(record.executableSha256, `${path}.executableSha256`),
    centerRoot,
    packageVersion: readBoundedString(record.packageVersion, `${path}.packageVersion`, 128),
    platform: readLiteral(record.platform, ['darwin', 'linux', 'win32'], `${path}.platform`),
    arch,
    officialDsh: {
      schemaVersion: 2,
      packageName: '@deepseek-ai/dsh',
      packageVersion: '0.1.1-rc.2',
      packageRoot,
      packageTreeSha256: readSha256Digest(
        officialDsh.packageTreeSha256,
        `${path}.officialDsh.packageTreeSha256`,
      ),
      productionDependencies,
      entrypointPath,
      entrypointSha256: readSha256Digest(
        officialDsh.entrypointSha256,
        `${path}.officialDsh.entrypointSha256`,
      ),
      hostHome,
      timeoutMs,
      node: {
        schemaVersion: 1,
        executablePath: nodePath,
        executableSha256: readSha256Digest(node.executableSha256, `${path}.officialDsh.node.executableSha256`),
        version: nodeVersion,
      },
      supervisorPath,
      supervisorSha256: readSha256Digest(
        officialDsh.supervisorSha256,
        `${path}.officialDsh.supervisorSha256`,
      ),
      pnpm: {
        schemaVersion: 1,
        packageName: 'pnpm',
        ...(pnpmIdentity as ReadablePnpmExecutionIdentity),
        packageRoot: pnpmPackageRoot,
        packageTreeSha256: readSha256Digest(
          pnpm.packageTreeSha256,
          `${path}.officialDsh.pnpm.packageTreeSha256`,
        ),
        entrypointPath: pnpmEntrypoint,
        entrypointSha256: readSha256Digest(
          pnpm.entrypointSha256,
          `${path}.officialDsh.pnpm.entrypointSha256`,
        ),
        shimPath: pnpmShim,
        shimSha256: readSha256Digest(pnpm.shimSha256, `${path}.officialDsh.pnpm.shimSha256`),
        shellPath: pnpmShell,
        shellSha256: readSha256Digest(pnpm.shellSha256, `${path}.officialDsh.pnpm.shellSha256`),
        runtimeRoot,
      },
    },
  }) as RecoveryExecutableBinding
}

/**
 * Strictly decode the current absolute hash-pinned recovery executable.
 * @param value Untrusted current-generation binding.
 * @param path Diagnostic field path.
 * @returns Recursively frozen current binding.
 */
export function decodeRecoveryExecutableBinding(
  value: unknown,
  path = 'recoveryExecutable',
): RecoveryExecutableBinding {
  return decodeRecoveryExecutableBindingWithIdentity(value, path, false)
}

/**
 * Strictly decode a current or retired durable recovery binding for read-only history.
 * @param value Untrusted persisted binding.
 * @param path Diagnostic field path.
 * @returns Recursively frozen recognized binding.
 */
export function decodeStoredRecoveryExecutableBinding(
  value: unknown,
  path = 'recoveryExecutable',
): RecoveryExecutableBinding {
  return decodeRecoveryExecutableBindingWithIdentity(value, path, true)
}

function assertManagedObjectBinding(value: Readonly<{
  managedObject: PlanContent['managedObject']
  externalRuntimeAction: PlanContent['externalRuntimeAction']
  runtimeBinding: PlanContent['runtimeBinding']
  operationKind: PlanContent['operationKind']
}>, path: string): void {
  const connection = value.managedObject === 'connection'
  const artifactDownload = ['install', 'update'].includes(value.operationKind)
  if ((connection && (value.externalRuntimeAction !== 'none' || value.runtimeBinding === null))
    || (!connection && (value.runtimeBinding !== null
      || value.externalRuntimeAction !== (artifactDownload ? 'download' : 'none')))) {
    failDomain('invalid-data', `${path} managed object and runtime authority are inconsistent`)
  }
}

function decodeFences(value: unknown, path: string): PlanRevisionFences {
  const record = readStrictRecord(value, [
    'catalogRevision',
    'inventoryRevision',
    'targetRevision',
    'ownerRevision',
    'scopeRevision',
    'profileRevision',
  ], path)
  const catalogRevision = readNonNegativeInteger(record.catalogRevision, `${path}.catalogRevision`)
  if (catalogRevision === 0) failDomain('invalid-data', `${path}.catalogRevision must be positive`)
  return {
    catalogRevision,
    inventoryRevision: readSha256Digest(record.inventoryRevision, `${path}.inventoryRevision`),
    targetRevision: readBoundedString(record.targetRevision, `${path}.targetRevision`),
    ownerRevision: readBoundedString(record.ownerRevision, `${path}.ownerRevision`),
    scopeRevision: readBoundedString(record.scopeRevision, `${path}.scopeRevision`),
    profileRevision: readBoundedString(record.profileRevision, `${path}.profileRevision`),
  }
}

/**
 * Strictly decode canonical immutable plan content.
 *
 * @param value Untrusted plan content.
 * @returns Recursively frozen validated content.
 */
export function decodePlanContent(value: unknown): PlanContent {
  const record = readStrictRecord(value, [
    'schemaVersion',
    'singleUse',
    'planId',
    'intentId',
    'origin',
    'candidateRef',
    'extensionKind',
    'extensionId',
    'managedObject',
    'externalRuntimeAction',
    'runtimeBinding',
    'artifactRevision',
    'artifactIntegrity',
    'artifactUrl',
    'artifactSizeBytes',
    'operationKind',
    'desiredState',
    'targetKey',
    'ownerKey',
    'scopeKey',
    'profileId',
    'idempotencyKey',
    'authorityDigest',
    'configurationDigest',
    'retentionDigest',
    'mutationDigest',
    'verificationDigest',
    'reviewEvidence',
    'restartRequired',
    'createdAtMs',
    'expiresAtMs',
    'fences',
  ], 'plan.content')
  if (record.schemaVersion !== IMMUTABLE_PLAN_SCHEMA_VERSION) {
    failDomain('invalid-data', 'plan.content.schemaVersion is unsupported')
  }
  if (record.singleUse !== true) failDomain('invalid-data', 'plan.content.singleUse must be true')
  const createdAtMs = readNonNegativeInteger(record.createdAtMs, 'plan.content.createdAtMs')
  const expiresAtMs = readNonNegativeInteger(record.expiresAtMs, 'plan.content.expiresAtMs')
  if (createdAtMs >= expiresAtMs) failDomain('invalid-data', 'plan validity interval is invalid')
  const decoded: PlanContent = {
    schemaVersion: IMMUTABLE_PLAN_SCHEMA_VERSION,
    singleUse: true,
    planId: readBoundedString(record.planId, 'plan.content.planId'),
    intentId: readBoundedString(record.intentId, 'plan.content.intentId'),
    origin: readLiteral(record.origin, ['store', 'task'], 'plan.content.origin'),
    candidateRef: readBoundedString(record.candidateRef, 'plan.content.candidateRef'),
    extensionKind: readLiteral(record.extensionKind, EXTENSION_KINDS, 'plan.content.extensionKind'),
    extensionId: readBoundedString(record.extensionId, 'plan.content.extensionId'),
    managedObject: readLiteral(record.managedObject, MANAGED_OBJECTS, 'plan.content.managedObject'),
    externalRuntimeAction: readLiteral(record.externalRuntimeAction, EXTERNAL_RUNTIME_ACTIONS, 'plan.content.externalRuntimeAction'),
    runtimeBinding: decodeRuntimeBinding(record.runtimeBinding, 'plan.content.runtimeBinding'),
    artifactRevision: readBoundedString(record.artifactRevision, 'plan.content.artifactRevision'),
    artifactIntegrity: readArtifactIntegrity(record.artifactIntegrity, 'plan.content.artifactIntegrity'),
    artifactUrl: readBoundedString(record.artifactUrl, 'plan.content.artifactUrl', 2_048),
    artifactSizeBytes: readNonNegativeInteger(record.artifactSizeBytes, 'plan.content.artifactSizeBytes'),
    operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'plan.content.operationKind'),
    desiredState: readLiteral(record.desiredState, DESIRED_STATES, 'plan.content.desiredState'),
    targetKey: readBoundedString(record.targetKey, 'plan.content.targetKey'),
    ownerKey: readBoundedString(record.ownerKey, 'plan.content.ownerKey'),
    scopeKey: readBoundedString(record.scopeKey, 'plan.content.scopeKey'),
    profileId: readBoundedString(record.profileId, 'plan.content.profileId'),
    idempotencyKey: readBoundedString(record.idempotencyKey, 'plan.content.idempotencyKey'),
    authorityDigest: readSha256Digest(record.authorityDigest, 'plan.content.authorityDigest'),
    configurationDigest: readSha256Digest(record.configurationDigest, 'plan.content.configurationDigest'),
    retentionDigest: readSha256Digest(record.retentionDigest, 'plan.content.retentionDigest'),
    mutationDigest: readSha256Digest(record.mutationDigest, 'plan.content.mutationDigest'),
    verificationDigest: readSha256Digest(record.verificationDigest, 'plan.content.verificationDigest'),
    reviewEvidence: decodePlanReviewEvidence(record.reviewEvidence),
    restartRequired: record.restartRequired === true
      ? true
      : record.restartRequired === false
        ? false
        : failDomain('invalid-data', 'plan.content.restartRequired must be boolean'),
    createdAtMs,
    expiresAtMs,
    fences: decodeFences(record.fences, 'plan.content.fences'),
  }
  if ((decoded.extensionKind === 'mcp') !== (decoded.managedObject === 'connection')) {
    failDomain('invalid-data', 'plan.content extension kind and managed object are inconsistent')
  }
  if (decoded.reviewEvidence.kind !== decoded.extensionKind
    || decoded.reviewEvidence.operationKind !== decoded.operationKind) {
    failDomain('invalid-data', 'plan.content review evidence does not match the operation')
  }
  if (decoded.reviewEvidence.kind === 'plugin'
    && decoded.reviewEvidence.activation.restartRequired !== decoded.restartRequired) {
    failDomain('invalid-data', 'plan.content restart requirement does not match Plugin activation evidence')
  }
  assertManagedObjectBinding(decoded, 'plan.content')
  return immutableJsonClone(decoded) as PlanContent
}

/**
 * Create one recursively frozen plan and bind its exact canonical hash.
 *
 * @param value Untrusted plan content.
 * @returns Immutable plan.
 */
export function createImmutablePlan(value: unknown): ImmutablePlan {
  const content = decodePlanContent(value)
  return immutableJsonClone({ content, hash: canonicalSha256(content) }) as unknown as ImmutablePlan
}

/**
 * Strictly decode an immutable plan and reject content tampering.
 *
 * @param value Untrusted serialized plan.
 * @returns Recursively frozen verified plan.
 */
export function decodeImmutablePlan(value: unknown): ImmutablePlan {
  const record = readStrictRecord(value, ['content', 'hash'], 'plan')
  const content = decodePlanContent(record.content)
  const hash = readSha256Digest(record.hash, 'plan.hash')
  if (canonicalSha256(content) !== hash) failDomain('plan-integrity', 'plan hash does not match its content')
  return immutableJsonClone({ content, hash }) as unknown as ImmutablePlan
}

/**
 * Revalidate a typed plan before every authorization transition.
 *
 * @param plan Candidate immutable plan.
 * @returns Verified recursively frozen plan.
 */
export function assertImmutablePlan(plan: ImmutablePlan): ImmutablePlan {
  return decodeImmutablePlan(plan)
}

/**
 * Strictly decode one human decision.
 *
 * @param value Untrusted decision payload.
 * @returns Recursively frozen decision.
 */
export function decodePlanDecisionInput(value: unknown): PlanDecisionInput {
  const record = readStrictRecord(value, ['planId', 'planHash', 'operationKind', 'decision'], 'decision')
  return immutableJsonClone({
    planId: readBoundedString(record.planId, 'decision.planId'),
    planHash: readSha256Digest(record.planHash, 'decision.planHash'),
    operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'decision.operationKind'),
    decision: readLiteral(record.decision, ['approve', 'reject'], 'decision.decision'),
  }) as unknown as PlanDecisionInput
}

/**
 * Strictly decode current owner observations used by revision fences.
 *
 * @param value Untrusted observation payload.
 * @returns Recursively frozen observation.
 */
export function decodePlanUseContext(value: unknown): PlanUseContext {
  const record = readStrictRecord(
    value,
    ['operationKind', 'targetKey', 'ownerKey', 'scopeKey', 'profileId', 'fences'],
    'planContext',
  )
  return immutableJsonClone({
    operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'planContext.operationKind'),
    targetKey: readBoundedString(record.targetKey, 'planContext.targetKey'),
    ownerKey: readBoundedString(record.ownerKey, 'planContext.ownerKey'),
    scopeKey: readBoundedString(record.scopeKey, 'planContext.scopeKey'),
    profileId: readBoundedString(record.profileId, 'planContext.profileId'),
    fences: decodeFences(record.fences, 'planContext.fences'),
  }) as unknown as PlanUseContext
}

function decodeOperationAuthorizationWithRecovery(
  value: unknown,
  readRetired: boolean,
): OperationAuthorization {
  const record = readStrictRecord(value, [
    'operationId',
    'planId',
    'planHash',
    'origin',
    'candidateRef',
    'extensionKind',
    'extensionId',
    'operationKind',
    'managedObject',
    'externalRuntimeAction',
    'runtimeBinding',
    'artifactRevision',
    'artifactIntegrity',
    'artifactUrl',
    'artifactSizeBytes',
    'desiredState',
    'targetKey',
    'ownerKey',
    'scopeKey',
    'profileId',
    'idempotencyKey',
    'authorityDigest',
    'configurationDigest',
    'retentionDigest',
    'mutationDigest',
    'verificationDigest',
    'reviewEvidence',
    'restartRequired',
    'fences',
    'recoveryExecutable',
    'authorizedAtMs',
  ], 'authorization')
  const decoded = immutableJsonClone({
    operationId: readBoundedString(record.operationId, 'authorization.operationId'),
    planId: readBoundedString(record.planId, 'authorization.planId'),
    planHash: readSha256Digest(record.planHash, 'authorization.planHash'),
    origin: readLiteral(record.origin, ['store', 'task'], 'authorization.origin'),
    candidateRef: readBoundedString(record.candidateRef, 'authorization.candidateRef'),
    extensionKind: readLiteral(record.extensionKind, EXTENSION_KINDS, 'authorization.extensionKind'),
    extensionId: readBoundedString(record.extensionId, 'authorization.extensionId'),
    operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'authorization.operationKind'),
    managedObject: readLiteral(record.managedObject, MANAGED_OBJECTS, 'authorization.managedObject'),
    externalRuntimeAction: readLiteral(record.externalRuntimeAction, EXTERNAL_RUNTIME_ACTIONS, 'authorization.externalRuntimeAction'),
    runtimeBinding: decodeRuntimeBinding(record.runtimeBinding, 'authorization.runtimeBinding'),
    artifactRevision: readBoundedString(record.artifactRevision, 'authorization.artifactRevision'),
    artifactIntegrity: readArtifactIntegrity(record.artifactIntegrity, 'authorization.artifactIntegrity'),
    artifactUrl: readBoundedString(record.artifactUrl, 'authorization.artifactUrl', 2_048),
    artifactSizeBytes: readNonNegativeInteger(record.artifactSizeBytes, 'authorization.artifactSizeBytes'),
    desiredState: readLiteral(record.desiredState, DESIRED_STATES, 'authorization.desiredState'),
    targetKey: readBoundedString(record.targetKey, 'authorization.targetKey'),
    ownerKey: readBoundedString(record.ownerKey, 'authorization.ownerKey'),
    scopeKey: readBoundedString(record.scopeKey, 'authorization.scopeKey'),
    profileId: readBoundedString(record.profileId, 'authorization.profileId'),
    idempotencyKey: readBoundedString(record.idempotencyKey, 'authorization.idempotencyKey'),
    authorityDigest: readSha256Digest(record.authorityDigest, 'authorization.authorityDigest'),
    configurationDigest: readSha256Digest(record.configurationDigest, 'authorization.configurationDigest'),
    retentionDigest: readSha256Digest(record.retentionDigest, 'authorization.retentionDigest'),
    mutationDigest: readSha256Digest(record.mutationDigest, 'authorization.mutationDigest'),
    verificationDigest: readSha256Digest(record.verificationDigest, 'authorization.verificationDigest'),
    reviewEvidence: decodePlanReviewEvidence(record.reviewEvidence, 'authorization.reviewEvidence'),
    restartRequired: record.restartRequired === true
      ? true
      : record.restartRequired === false
        ? false
        : failDomain('invalid-data', 'authorization.restartRequired must be boolean'),
    fences: decodeFences(record.fences, 'authorization.fences'),
    recoveryExecutable: (readRetired ? decodeStoredRecoveryExecutableBinding : decodeRecoveryExecutableBinding)(
      record.recoveryExecutable,
      'authorization.recoveryExecutable',
    ),
    authorizedAtMs: readNonNegativeInteger(record.authorizedAtMs, 'authorization.authorizedAtMs'),
  }) as unknown as OperationAuthorization
  assertManagedObjectBinding(decoded, 'authorization')
  if (decoded.reviewEvidence.kind !== decoded.extensionKind
    || decoded.reviewEvidence.operationKind !== decoded.operationKind) {
    failDomain('invalid-data', 'authorization review evidence does not match the operation')
  }
  return decoded
}

/**
 * Strictly decode an operation authorization produced by the current plan consumer.
 * @param value Untrusted authorization payload.
 * @returns Recursively frozen current authorization.
 */
export function decodeOperationAuthorization(value: unknown): OperationAuthorization {
  return decodeOperationAuthorizationWithRecovery(value, false)
}

/**
 * Strictly decode a current or retired consumed authorization from durable storage.
 * @param value Untrusted persisted authorization.
 * @returns Recursively frozen recognized authorization.
 */
export function decodeStoredOperationAuthorization(value: unknown): OperationAuthorization {
  return decodeOperationAuthorizationWithRecovery(value, true)
}

function decodeDecisionRecord(value: unknown): PlanDecisionRecord {
  const record = readStrictRecord(
    value,
    ['planId', 'planHash', 'operationKind', 'decision', 'decidedAtMs'],
    'planState.decision',
  )
  return immutableJsonClone({
    planId: readBoundedString(record.planId, 'planState.decision.planId'),
    planHash: readSha256Digest(record.planHash, 'planState.decision.planHash'),
    operationKind: readLiteral(record.operationKind, OPERATION_KINDS, 'planState.decision.operationKind'),
    decision: readLiteral(record.decision, ['approve', 'reject'], 'planState.decision.decision'),
    decidedAtMs: readNonNegativeInteger(record.decidedAtMs, 'planState.decision.decidedAtMs'),
  }) as unknown as PlanDecisionRecord
}

function assertStateBindings(state: PlanAuthorizationState): PlanAuthorizationState {
  const { plan } = state
  if (state.status === 'pending') return state
  if (state.status === 'expired') {
    if (state.expiredAtMs < plan.content.expiresAtMs) {
      failDomain('invalid-data', 'planState expired before plan expiry')
    }
    return state
  }
  const { decision } = state
  if (
    decision.planId !== plan.content.planId
    || decision.planHash !== plan.hash
    || decision.operationKind !== plan.content.operationKind
    || decision.decidedAtMs < plan.content.createdAtMs
    || decision.decidedAtMs >= plan.content.expiresAtMs
  ) {
    failDomain('plan-integrity', 'planState decision does not bind the exact plan')
  }
  if (state.status === 'approved' && decision.decision !== 'approve') {
    failDomain('plan-integrity', 'approved planState does not contain approval')
  }
  if (state.status === 'rejected' && decision.decision !== 'reject') {
    failDomain('plan-integrity', 'rejected planState does not contain rejection')
  }
  if (state.status !== 'consumed') return state
  const { authorization } = state
  const authorizationBinding = canonicalSha256({
    origin: authorization.origin,
    candidateRef: authorization.candidateRef,
    extensionKind: authorization.extensionKind,
    extensionId: authorization.extensionId,
    managedObject: authorization.managedObject,
    externalRuntimeAction: authorization.externalRuntimeAction,
    runtimeBinding: authorization.runtimeBinding,
    artifactRevision: authorization.artifactRevision,
    artifactIntegrity: authorization.artifactIntegrity,
    artifactUrl: authorization.artifactUrl,
    artifactSizeBytes: authorization.artifactSizeBytes,
    operationKind: authorization.operationKind,
    desiredState: authorization.desiredState,
    targetKey: authorization.targetKey,
    ownerKey: authorization.ownerKey,
    scopeKey: authorization.scopeKey,
    profileId: authorization.profileId,
    idempotencyKey: authorization.idempotencyKey,
    authorityDigest: authorization.authorityDigest,
    configurationDigest: authorization.configurationDigest,
    retentionDigest: authorization.retentionDigest,
    mutationDigest: authorization.mutationDigest,
    verificationDigest: authorization.verificationDigest,
    reviewEvidence: authorization.reviewEvidence,
    restartRequired: authorization.restartRequired,
    fences: authorization.fences,
  })
  const planBinding = canonicalSha256({
    origin: plan.content.origin,
    candidateRef: plan.content.candidateRef,
    extensionKind: plan.content.extensionKind,
    extensionId: plan.content.extensionId,
    managedObject: plan.content.managedObject,
    externalRuntimeAction: plan.content.externalRuntimeAction,
    runtimeBinding: plan.content.runtimeBinding,
    artifactRevision: plan.content.artifactRevision,
    artifactIntegrity: plan.content.artifactIntegrity,
    artifactUrl: plan.content.artifactUrl,
    artifactSizeBytes: plan.content.artifactSizeBytes,
    operationKind: plan.content.operationKind,
    desiredState: plan.content.desiredState,
    targetKey: plan.content.targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    idempotencyKey: plan.content.idempotencyKey,
    authorityDigest: plan.content.authorityDigest,
    configurationDigest: plan.content.configurationDigest,
    retentionDigest: plan.content.retentionDigest,
    mutationDigest: plan.content.mutationDigest,
    verificationDigest: plan.content.verificationDigest,
    reviewEvidence: plan.content.reviewEvidence,
    restartRequired: plan.content.restartRequired,
    fences: plan.content.fences,
  })
  if (
    decision.decision !== 'approve'
    || authorization.planId !== plan.content.planId
    || authorization.planHash !== plan.hash
    || authorization.operationKind !== plan.content.operationKind
    || authorization.targetKey !== plan.content.targetKey
    || authorization.ownerKey !== plan.content.ownerKey
    || authorization.scopeKey !== plan.content.scopeKey
    || authorization.profileId !== plan.content.profileId
    || authorizationBinding !== planBinding
    || authorization.authorizedAtMs < decision.decidedAtMs
    || authorization.authorizedAtMs >= plan.content.expiresAtMs
  ) {
    failDomain('plan-integrity', 'consumed planState authorization does not bind the exact plan')
  }
  return state
}

/**
 * Strictly decode one durable plan authorization state and verify all identity bindings.
 *
 * @param value Untrusted persisted plan state.
 * @returns Recursively frozen verified state.
 */
function decodePlanAuthorizationStateWithRecovery(value: unknown, readRetired: boolean): PlanAuthorizationState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failDomain('invalid-data', 'planState must be an object')
  }
  const status = readLiteral(
    (value as Readonly<Record<string, unknown>>).status,
    ['pending', 'approved', 'rejected', 'expired', 'consumed'],
    'planState.status',
  )
  if (status === 'pending') {
    const record = readStrictRecord(value, ['status', 'plan'], 'planState')
    return assertStateBindings(immutableJsonClone({
      status,
      plan: decodeImmutablePlan(record.plan),
    }) as unknown as PlanAuthorizationState)
  }
  if (status === 'expired') {
    const record = readStrictRecord(value, ['status', 'plan', 'expiredAtMs'], 'planState')
    return assertStateBindings(immutableJsonClone({
      status,
      plan: decodeImmutablePlan(record.plan),
      expiredAtMs: readNonNegativeInteger(record.expiredAtMs, 'planState.expiredAtMs'),
    }) as unknown as PlanAuthorizationState)
  }
  if (status === 'approved' || status === 'rejected') {
    const record = readStrictRecord(value, ['status', 'plan', 'decision'], 'planState')
    return assertStateBindings(immutableJsonClone({
      status,
      plan: decodeImmutablePlan(record.plan),
      decision: decodeDecisionRecord(record.decision),
    }) as unknown as PlanAuthorizationState)
  }
  const record = readStrictRecord(value, ['status', 'plan', 'decision', 'authorization'], 'planState')
  return assertStateBindings(immutableJsonClone({
    status,
    plan: decodeImmutablePlan(record.plan),
    decision: decodeDecisionRecord(record.decision),
    authorization: (readRetired ? decodeStoredOperationAuthorization : decodeOperationAuthorization)(record.authorization),
  }) as unknown as PlanAuthorizationState)
}

/**
 * Strictly decode a plan authorization state emitted by the current generation.
 * @param value Untrusted state payload.
 * @returns Recursively frozen current state.
 */
export function decodePlanAuthorizationState(value: unknown): PlanAuthorizationState {
  return decodePlanAuthorizationStateWithRecovery(value, false)
}

/**
 * Strictly decode a current or retired consumed plan state from durable storage.
 * @param value Untrusted persisted state.
 * @returns Recursively frozen recognized state.
 */
export function decodeStoredPlanAuthorizationState(value: unknown): PlanAuthorizationState {
  return decodePlanAuthorizationStateWithRecovery(value, true)
}
