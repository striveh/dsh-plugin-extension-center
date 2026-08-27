import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const READABLE_PNPM_IDENTITIES = Object.freeze([
  Object.freeze({
    packageVersion: '11.21.0',
    registryIntegrity: 'sha512-UhcFvOaJkk6scvWjWHEi82JonvZXHlW6gAdv1jfBETLs/62ib61Op5xIW/3b/T1aKlsFgFp36JPeceyKbMo7sQ==',
  }),
  Object.freeze({
    packageVersion: '11.7.0',
    registryIntegrity: 'sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==',
  }),
])
const OPERATION_KINDS = Object.freeze([
  'install', 'configure', 'update', 'enable', 'disable', 'uninstall', 'restore', 'purge',
])
const OPERATION_PHASES = Object.freeze([
  'authorized', 'staging', 'applying', 'verifying', 'rolling-back',
  'committed', 'rolled-back', 'failed', 'recovery-required',
])
const TERMINAL_PHASES = Object.freeze(['committed', 'rolled-back', 'failed'])
const CHECK_CODES = Object.freeze([
  'catalog-admission', 'owner-revision', 'review-record', 'artifact-integrity', 'plugin-manifest',
  'plugin-dependencies', 'plugin-lifecycle-scripts', 'plugin-package-metadata', 'plugin-settings-schema',
  'center-plugin-material', 'official-profile-package', 'loader-consumer', 'host-restart-observation',
  'skill-file-manifest',
  'skill-frontmatter', 'skill-body', 'skill-links', 'skill-executables', 'invocation-policy',
  'merged-skill-winner', 'mcp-runtime-integrity', 'mcp-descriptor', 'mcp-secret-absence',
  'mcp-initialize', 'mcp-tools-list', 'mcp-tool-generation', 'owner-mutation', 'owner-absence',
  'quiescent-disposal',
])
const CHECK_PHASES = Object.freeze(['planning', 'prepare', 'apply', 'verify', 'external-restart'])
const MATERIAL_KINDS = Object.freeze([
  'center-plugin-material', 'profile-dependency', 'loader-entry', 'plugin-settings', 'skill-file',
  'connection-row', 'credential-record', 'external-runtime', 'remote-data', 'recovery-point',
])
const ROLLBACK_LIMITS = Object.freeze([
  'dsh-managed-state-only', 'remote-grants-not-revoked', 'third-party-side-effects-not-reversed',
  'external-runtime-not-restored', 'workspace-files-not-restored', 'purge-irreversible',
  'restart-required-before-runtime-proof',
])
const REVIEW_NOT_PROVEN = Object.freeze([
  'catalog-admission-is-not-security-audit', 'third-party-code-side-effects', 'remote-side-effects', 'external-runtime-state',
  'post-restart-consumer', 'user-task-outcome',
])
const RECEIPT_NOT_PROVEN = Object.freeze(['mutation', 'verification', 'rollback', 'restart', 'recovery'])
const PLAN_CONTENT_KEYS = Object.freeze([
  'artifactIntegrity',
  'artifactRevision',
  'artifactSizeBytes',
  'artifactUrl',
  'authorityDigest',
  'candidateRef',
  'configurationDigest',
  'createdAtMs',
  'desiredState',
  'expiresAtMs',
  'extensionId',
  'extensionKind',
  'externalRuntimeAction',
  'fences',
  'idempotencyKey',
  'intentId',
  'managedObject',
  'mutationDigest',
  'operationKind',
  'origin',
  'ownerKey',
  'planId',
  'profileId',
  'restartRequired',
  'retentionDigest',
  'reviewEvidence',
  'runtimeBinding',
  'schemaVersion',
  'scopeKey',
  'singleUse',
  'targetKey',
  'verificationDigest',
])
const PLAN_AUTHORIZATION_SHARED_KEYS = Object.freeze([
  'origin',
  'candidateRef',
  'extensionKind',
  'extensionId',
  'artifactRevision',
  'artifactIntegrity',
  'artifactUrl',
  'artifactSizeBytes',
  'desiredState',
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
])
const RECEIPT_BODY_KEYS = Object.freeze([
  'afterDigest',
  'beforeDigest',
  'evidence',
  'externalRuntimeAction',
  'issuedAtMs',
  'journalEventCount',
  'journalHeadDigest',
  'managedObject',
  'mutationDigests',
  'operationId',
  'operationKind',
  'outcome',
  'planEvidence',
  'planHash',
  'planId',
  'runtimeBinding',
  'schemaVersion',
  'targetKey',
  'verificationDigests',
])
const PROJECTION_KEYS = Object.freeze([
  'afterDigest',
  'beforeDigest',
  'completedReviewPhases',
  'externalRuntimeAction',
  'lastAtMs',
  'managedObject',
  'mutationDigests',
  'operationId',
  'operationKind',
  'phase',
  'planEvidence',
  'planHash',
  'planId',
  'receipt',
  'recoveryAttempts',
  'rollbackAttempted',
  'runtimeBinding',
  'targetKey',
  'verificationDigests',
])
const NEXT_PHASES = Object.freeze({
  authorized: Object.freeze(['staging', 'failed']),
  staging: Object.freeze(['applying', 'rolling-back', 'failed']),
  applying: Object.freeze(['verifying', 'rolling-back', 'failed']),
  verifying: Object.freeze(['committed', 'rolling-back', 'failed']),
  'rolling-back': Object.freeze(['rolled-back', 'recovery-required']),
  committed: Object.freeze([]),
  'rolled-back': Object.freeze([]),
  failed: Object.freeze([]),
  'recovery-required': Object.freeze(['rolling-back']),
})

function fail(message) {
  throw new Error(`terminal receipt binding: ${message}`)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has an unexpected key set`)
  }
}

function canonicalize(value, path, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) fail(`${path} contains a cycle`)
    const keys = Reflect.ownKeys(value)
    const permitted = new Set(['length', ...value.map((_, index) => String(index))])
    if (keys.some(key => !permitted.has(key)) || Object.keys(value).length !== value.length) {
      fail(`${path} must be a dense JSON array without custom properties`)
    }
    ancestors.add(value)
    try {
      return `[${value.map((entry, index) => canonicalize(entry, `${path}[${String(index)}]`, ancestors)).join(',')}]`
    } finally {
      ancestors.delete(value)
    }
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain JSON object`)
    if (ancestors.has(value)) fail(`${path} contains a cycle`)
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key === 'symbol')) fail(`${path} contains a symbol key`)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
        fail(`${path}.${String(key)} is not an enumerable JSON data property`)
      }
    }
    ancestors.add(value)
    try {
      return `{${keys.sort().map((key) => {
        const descriptor = descriptors[key]
        return `${JSON.stringify(key)}:${canonicalize(descriptor.value, `${path}.${key}`, ancestors)}`
      }).join(',')}}`
    } finally {
      ancestors.delete(value)
    }
  }
  fail(`${path} contains unsupported ${typeof value}`)
}

/** Serialize strict JSON with lexicographically sorted object keys. */
export function canonicalJson(value) {
  return canonicalize(value, '$', new Set())
}

/** Hash strict canonical JSON with the receipt algorithm. */
export function canonicalSha256(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

/**
 * Independently bind an immutable plan hash to the complete returned content.
 * @returns The verified plan object.
 */
export function verifyImmutablePlanDigest(value) {
  const candidate = record(value, 'plan')
  exactKeys(candidate, ['content', 'hash'], 'plan')
  const content = immutablePlanContent(candidate.content, 'plan.content')
  const hash = digest(candidate.hash, 'plan.hash')
  if (canonicalSha256(content) !== hash) fail('plan.hash does not match its canonical content')
  return candidate
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function boundedString(value, label, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a bounded non-empty string`)
  }
  return value
}

function nullableString(value, label, maximum = 4_096) {
  return value === null ? null : boundedString(value, label, maximum)
}

function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be boolean`)
  return value
}

function nullableBoolean(value, label) {
  return value === null ? null : boolean(value, label)
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`)
  return value
}

function literal(value, accepted, label) {
  if (typeof value !== 'string' || !accepted.includes(value)) fail(`${label} is not an accepted value`)
  return value
}

function digest(value, label, nullable = false) {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256 digest`)
  return value
}

function artifactIntegrity(value, label, nullable = false) {
  if (nullable && value === null) return null
  if (typeof value !== 'string') fail(`${label} must be a pinned artifact integrity`)
  if (/^sha256:[0-9a-f]{64}$/u.test(value) || /^sha512:[0-9a-f]{128}$/u.test(value)) return value
  const match = /^sha512:([A-Za-z0-9+/]{86}==)$/u.exec(value)
  if (match !== null) {
    const decoded = Buffer.from(match[1], 'base64')
    if (decoded.length === 64 && decoded.toString('base64') === match[1]) return value
  }
  fail(`${label} must be a pinned artifact integrity`)
}

function array(value, label, maximum = 512) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be a bounded array`)
  return value
}

function literalArray(value, accepted, label) {
  const output = array(value, label).map((entry, index) => literal(entry, accepted, `${label}[${String(index)}]`))
  if (new Set(output).size !== output.length) fail(`${label} contains duplicates`)
  return output
}

function stringArray(value, label, maximum = 512) {
  const output = array(value, label, maximum)
    .map((entry, index) => boundedString(entry, `${label}[${String(index)}]`))
  if (new Set(output).size !== output.length) fail(`${label} contains duplicates`)
  return output
}

function exactText(value, label) {
  if (value === null) return null
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024 || value.includes('\0')) {
    fail(`${label} must be bounded UTF-8 text without NUL`)
  }
  return value
}

function exactArgument(value, label, maximum = 4_096) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a bounded argument without control characters`)
  }
  return value
}

function reviewChecks(value, label) {
  const output = array(value, label, 64).map((entry, index) => {
    const at = `${label}[${String(index)}]`
    const candidate = record(entry, at)
    exactKeys(candidate, ['code', 'phase'], at)
    literal(candidate.code, CHECK_CODES, `${at}.code`)
    literal(candidate.phase, CHECK_PHASES, `${at}.phase`)
    return candidate
  })
  if (output.length === 0 || new Set(output.map(entry => entry.code)).size !== output.length) {
    fail(`${label} must contain unique checks`)
  }
  return output
}

function reviewMaterials(value, label) {
  const output = array(value, label, 128).map((entry, index) => {
    const at = `${label}[${String(index)}]`
    const candidate = record(entry, at)
    exactKeys(candidate, ['digest', 'id', 'kind'], at)
    literal(candidate.kind, MATERIAL_KINDS, `${at}.kind`)
    boundedString(candidate.id, `${at}.id`, 4_096)
    digest(candidate.digest, `${at}.digest`, true)
    return candidate
  })
  if (new Set(output.map(entry => `${entry.kind}\0${entry.id}`)).size !== output.length) {
    fail(`${label} contains duplicate material`)
  }
  return output
}

function reviewRollbackPoint(value, label) {
  if (value === null) return null
  const candidate = record(value, label)
  exactKeys(candidate, ['digest', 'id', 'kind'], label)
  literal(candidate.kind, ['absent-state', 'managed-version'], `${label}.kind`)
  boundedString(candidate.id, `${label}.id`)
  digest(candidate.digest, `${label}.digest`)
  return candidate
}

function validateCommonReview(candidate, label) {
  if (candidate.schemaVersion !== 1) fail(`${label}.schemaVersion must be 1`)
  literal(candidate.operationKind, OPERATION_KINDS, `${label}.operationKind`)
  reviewChecks(candidate.checks, `${label}.checks`)
  reviewMaterials(candidate.removed, `${label}.removed`)
  reviewMaterials(candidate.retained, `${label}.retained`)
  literal(candidate.credentialChoice, [
    'not-applicable', 'retain-local-record', 'delete-local-record',
  ], `${label}.credentialChoice`)
  reviewRollbackPoint(candidate.rollbackPoint, `${label}.rollbackPoint`)
  literalArray(candidate.rollbackLimits, ROLLBACK_LIMITS, `${label}.rollbackLimits`)
  literalArray(candidate.notProven, REVIEW_NOT_PROVEN, `${label}.notProven`)
}

function validatePluginReview(candidate, label, baseKeys) {
  exactKeys(candidate, [
    ...baseKeys, 'manifest', 'dependencies', 'managedMaterial', 'packageMetadata', 'activation', 'scripts', 'settings',
  ], label)
  validateCommonReview(candidate, label)
  const manifest = record(candidate.manifest, `${label}.manifest`)
  exactKeys(manifest, [
    'afterVersion', 'beforeVersion', 'body', 'fileManifestDigest', 'files', 'manifestDigest', 'packageName',
  ], `${label}.manifest`)
  boundedString(manifest.packageName, `${label}.manifest.packageName`, 256)
  nullableString(manifest.beforeVersion, `${label}.manifest.beforeVersion`, 256)
  nullableString(manifest.afterVersion, `${label}.manifest.afterVersion`, 256)
  if (exactText(manifest.body, `${label}.manifest.body`) === null) fail(`${label}.manifest.body cannot be null`)
  digest(manifest.manifestDigest, `${label}.manifest.manifestDigest`)
  stringArray(manifest.files, `${label}.manifest.files`, 4_096)
  digest(manifest.fileManifestDigest, `${label}.manifest.fileManifestDigest`)

  const dependencies = array(candidate.dependencies, `${label}.dependencies`, 256).map((entry, index) => {
    const at = `${label}.dependencies[${String(index)}]`
    const dependency = record(entry, at)
    exactKeys(dependency, ['afterVersion', 'beforeVersion', 'id', 'kind', 'required'], at)
    literal(dependency.kind, ['host', 'runtime', 'extension', 'peer'], `${at}.kind`)
    boundedString(dependency.id, `${at}.id`, 256)
    nullableString(dependency.beforeVersion, `${at}.beforeVersion`, 256)
    nullableString(dependency.afterVersion, `${at}.afterVersion`, 256)
    boolean(dependency.required, `${at}.required`)
    return dependency
  })
  if (new Set(dependencies.map(entry => `${entry.kind}\0${entry.id}`)).size !== dependencies.length) {
    fail(`${label}.dependencies contains duplicates`)
  }

  const managedMaterial = record(candidate.managedMaterial, `${label}.managedMaterial`)
  exactKeys(managedMaterial, [
    'afterVersion', 'beforeVersion', 'owner', 'packageName', 'targetIntegrity',
  ], `${label}.managedMaterial`)
  literal(managedMaterial.owner, ['extension-center'], `${label}.managedMaterial.owner`)
  boundedString(managedMaterial.packageName, `${label}.managedMaterial.packageName`, 256)
  nullableString(managedMaterial.beforeVersion, `${label}.managedMaterial.beforeVersion`, 256)
  nullableString(managedMaterial.afterVersion, `${label}.managedMaterial.afterVersion`, 256)
  artifactIntegrity(managedMaterial.targetIntegrity, `${label}.managedMaterial.targetIntegrity`, true)

  const packageMetadata = record(candidate.packageMetadata, `${label}.packageMetadata`)
  exactKeys(packageMetadata, ['bundlePatch'], `${label}.packageMetadata`)
  if (packageMetadata.bundlePatch !== null) {
    const bundlePatch = record(packageMetadata.bundlePatch, `${label}.packageMetadata.bundlePatch`)
    exactKeys(bundlePatch, ['patchBody', 'patchDigest', 'path'], `${label}.packageMetadata.bundlePatch`)
    if (bundlePatch.path !== 'cordis.patch.yml') fail(`${label}.packageMetadata.bundlePatch.path is unsupported`)
    digest(bundlePatch.patchDigest, `${label}.packageMetadata.bundlePatch.patchDigest`)
    if (exactText(bundlePatch.patchBody, `${label}.packageMetadata.bundlePatch.patchBody`) === null) {
      fail(`${label}.packageMetadata.bundlePatch.patchBody cannot be null`)
    }
  }
  const activation = record(candidate.activation, `${label}.activation`)
  exactKeys(activation, [
    'loaderEntry', 'mutationOwner', 'packageName', 'profileDependency', 'restartRequired',
  ], `${label}.activation`)
  literal(activation.mutationOwner, ['official-dsh-cli', 'official-loader'], `${label}.activation.mutationOwner`)
  literal(activation.profileDependency, ['add', 'replace', 'remove', 'restore', 'retain'], `${label}.activation.profileDependency`)
  literal(activation.loaderEntry, ['create', 'replace', 'remove', 'restore', 'retain'], `${label}.activation.loaderEntry`)
  boundedString(activation.packageName, `${label}.activation.packageName`, 256)
  boolean(activation.restartRequired, `${label}.activation.restartRequired`)
  const expectedActivation = ({
    install: { mutationOwner: 'official-dsh-cli', profileDependency: 'add', loaderEntry: 'create', restartRequired: true },
    configure: { mutationOwner: 'official-loader', profileDependency: 'retain', loaderEntry: 'replace', restartRequired: false },
    update: { mutationOwner: 'official-dsh-cli', profileDependency: 'replace', loaderEntry: 'replace', restartRequired: true },
    uninstall: { mutationOwner: 'official-dsh-cli', profileDependency: 'remove', loaderEntry: 'remove', restartRequired: true },
    restore: { mutationOwner: 'official-dsh-cli', profileDependency: 'restore', loaderEntry: 'restore', restartRequired: true },
  })[candidate.operationKind]
  if (expectedActivation === undefined
    || activation.mutationOwner !== expectedActivation.mutationOwner
    || activation.profileDependency !== expectedActivation.profileDependency
    || activation.loaderEntry !== expectedActivation.loaderEntry
    || activation.restartRequired !== expectedActivation.restartRequired) {
    fail(`${label}.activation does not match operationKind`)
  }
  if (manifest.packageName !== managedMaterial.packageName || manifest.packageName !== activation.packageName
    || manifest.beforeVersion !== managedMaterial.beforeVersion || manifest.afterVersion !== managedMaterial.afterVersion
    || (managedMaterial.afterVersion === null) !== (managedMaterial.targetIntegrity === null)) {
    fail(`${label} Plugin package identity fields are inconsistent`)
  }

  const scripts = record(candidate.scripts, `${label}.scripts`)
  exactKeys(scripts, ['after', 'before', 'forbiddenLifecycle'], `${label}.scripts`)
  stringArray(scripts.before, `${label}.scripts.before`)
  stringArray(scripts.after, `${label}.scripts.after`)
  stringArray(scripts.forbiddenLifecycle, `${label}.scripts.forbiddenLifecycle`, 4)

  const settings = record(candidate.settings, `${label}.settings`)
  exactKeys(settings, [
    'adapterDigest', 'adapterVersion', 'diffDigest', 'migration', 'migrationChanges',
    'ownerRevision', 'schema', 'schemaDigest',
  ], `${label}.settings`)
  nullableString(settings.adapterVersion, `${label}.settings.adapterVersion`, 256)
  digest(settings.adapterDigest, `${label}.settings.adapterDigest`, true)
  digest(settings.schemaDigest, `${label}.settings.schemaDigest`, true)
  boundedString(settings.ownerRevision, `${label}.settings.ownerRevision`)
  literal(settings.migration, ['not-required', 'validated', 'pending'], `${label}.settings.migration`)
  const schema = array(settings.schema, `${label}.settings.schema`, 128).map((entry, index) => {
    const at = `${label}.settings.schema[${String(index)}]`
    const field = record(entry, at)
    exactKeys(field, ['field', 'maximum', 'minimum', 'type'], at)
    boundedString(field.field, `${at}.field`, 128)
    if (field.type !== 'integer') fail(`${at}.type is unsupported`)
    const minimum = integer(field.minimum, `${at}.minimum`)
    const maximum = integer(field.maximum, `${at}.maximum`)
    if (minimum > maximum) fail(`${at} range is invalid`)
    return field
  })
  if (new Set(schema.map(entry => entry.field)).size !== schema.length) fail(`${label}.settings.schema contains duplicates`)
  stringArray(settings.migrationChanges, `${label}.settings.migrationChanges`, 128)
  digest(settings.diffDigest, `${label}.settings.diffDigest`)
}

function validateSkillReview(candidate, label, baseKeys) {
  exactKeys(candidate, [...baseKeys, 'files', 'body', 'invocation'], label)
  validateCommonReview(candidate, label)
  const files = array(candidate.files, `${label}.files`, 4_096).map((entry, index) => {
    const at = `${label}.files[${String(index)}]`
    const file = record(entry, at)
    exactKeys(file, [
      'afterDigest', 'beforeDigest', 'change', 'executableAfter', 'executableBefore',
      'linkAfter', 'linkBefore', 'path', 'sizeBytes',
    ], at)
    boundedString(file.path, `${at}.path`, 4_096)
    literal(file.change, ['add', 'retain', 'replace', 'remove', 'restore', 'purge'], `${at}.change`)
    digest(file.beforeDigest, `${at}.beforeDigest`, true)
    digest(file.afterDigest, `${at}.afterDigest`, true)
    integer(file.sizeBytes, `${at}.sizeBytes`)
    boolean(file.executableBefore, `${at}.executableBefore`)
    boolean(file.executableAfter, `${at}.executableAfter`)
    nullableString(file.linkBefore, `${at}.linkBefore`)
    nullableString(file.linkAfter, `${at}.linkAfter`)
    return file
  })
  if (files.length === 0 || new Set(files.map(entry => entry.path)).size !== files.length) {
    fail(`${label}.files must contain unique files`)
  }
  const body = record(candidate.body, `${label}.body`)
  exactKeys(body, ['after', 'afterDigest', 'before', 'beforeDigest'], `${label}.body`)
  exactText(body.before, `${label}.body.before`)
  exactText(body.after, `${label}.body.after`)
  digest(body.beforeDigest, `${label}.body.beforeDigest`, true)
  digest(body.afterDigest, `${label}.body.afterDigest`, true)
  const invocation = record(candidate.invocation, `${label}.invocation`)
  exactKeys(invocation, [
    'afterModelInvocable', 'afterUserInvocable', 'beforeModelInvocable', 'beforeUserInvocable',
  ], `${label}.invocation`)
  nullableBoolean(invocation.beforeModelInvocable, `${label}.invocation.beforeModelInvocable`)
  nullableBoolean(invocation.beforeUserInvocable, `${label}.invocation.beforeUserInvocable`)
  nullableBoolean(invocation.afterModelInvocable, `${label}.invocation.afterModelInvocable`)
  nullableBoolean(invocation.afterUserInvocable, `${label}.invocation.afterUserInvocable`)
}

function validateReconnect(value, label) {
  const candidate = record(value, label)
  exactKeys(candidate, ['enabled', 'initialDelayMs', 'maxAttempts', 'maxDelayMs'], label)
  boolean(candidate.enabled, `${label}.enabled`)
  integer(candidate.initialDelayMs, `${label}.initialDelayMs`)
  integer(candidate.maxDelayMs, `${label}.maxDelayMs`)
  integer(candidate.maxAttempts, `${label}.maxAttempts`)
}

function validateMcpDescriptor(value, label) {
  const candidate = record(value, label)
  const transport = literal(candidate.transport, ['stdio', 'http'], `${label}.transport`)
  if (transport === 'stdio') {
    exactKeys(candidate, [
      'arguments', 'executable', 'reconnect', 'serverName', 'toolCallTimeoutMs', 'transport', 'workingDirectory',
    ], label)
    boundedString(candidate.serverName, `${label}.serverName`, 128)
    boundedString(candidate.executable, `${label}.executable`, 4_096)
    array(candidate.arguments, `${label}.arguments`, 128)
      .forEach((entry, index) => exactArgument(entry, `${label}.arguments[${String(index)}]`))
    exactArgument(candidate.workingDirectory, `${label}.workingDirectory`)
    integer(candidate.toolCallTimeoutMs, `${label}.toolCallTimeoutMs`)
    validateReconnect(candidate.reconnect, `${label}.reconnect`)
    return transport
  }
  exactKeys(candidate, [
    'authentication', 'dataEgressDisclosure', 'endpoint', 'origin', 'reconnect', 'redirects',
    'serverName', 'toolCallTimeoutMs', 'transport',
  ], label)
  boundedString(candidate.serverName, `${label}.serverName`, 128)
  const origin = boundedString(candidate.origin, `${label}.origin`, 2_048)
  const endpoint = boundedString(candidate.endpoint, `${label}.endpoint`, 2_048)
  let parsed
  try {
    parsed = new URL(endpoint)
  } catch {
    fail(`${label}.endpoint must be an absolute URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin
    || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    fail(`${label} HTTP endpoint and origin are inconsistent`)
  }
  literal(candidate.authentication, ['none'], `${label}.authentication`)
  literal(candidate.redirects, ['forbidden'], `${label}.redirects`)
  boundedString(candidate.dataEgressDisclosure, `${label}.dataEgressDisclosure`, 2_048)
  integer(candidate.toolCallTimeoutMs, `${label}.toolCallTimeoutMs`)
  validateReconnect(candidate.reconnect, `${label}.reconnect`)
  return transport
}

function validateMcpReview(candidate, label, baseKeys) {
  exactKeys(candidate, [...baseKeys, 'descriptor', 'runtime', 'credentials', 'dataEgress'], label)
  validateCommonReview(candidate, label)
  const transport = validateMcpDescriptor(candidate.descriptor, `${label}.descriptor`)
  const runtime = record(candidate.runtime, `${label}.runtime`)
  exactKeys(runtime, ['action', 'digest', 'ownership', 'version'], `${label}.runtime`)
  if (candidate.credentials !== 'none' || runtime.action !== 'none') {
    fail(`${label} cannot carry credential values or external runtime actions`)
  }
  literal(runtime.ownership, ['host', 'remote'], `${label}.runtime.ownership`)
  boundedString(runtime.version, `${label}.runtime.version`, 256)
  digest(runtime.digest, `${label}.runtime.digest`, true)
  const dataEgress = literal(candidate.dataEgress, ['local-process', 'remote-origin'], `${label}.dataEgress`)
  if ((transport === 'stdio') !== (dataEgress === 'local-process')) {
    fail(`${label}.dataEgress does not match transport`)
  }
}

function planReviewEvidence(value, label) {
  const candidate = record(value, label)
  const kind = literal(candidate.kind, ['plugin', 'mcp', 'skill'], `${label}.kind`)
  const baseKeys = [
    'schemaVersion', 'kind', 'operationKind', 'checks', 'removed', 'retained',
    'credentialChoice', 'rollbackPoint', 'rollbackLimits', 'notProven',
  ]
  if (kind === 'plugin') validatePluginReview(candidate, label, baseKeys)
  else if (kind === 'skill') validateSkillReview(candidate, label, baseKeys)
  else validateMcpReview(candidate, label, baseKeys)
  return candidate
}

function runtimeBinding(value, label) {
  if (value === null) return null
  const candidate = record(value, label)
  exactKeys(candidate, ['descriptorDigest', 'runtimeRef', 'version'], label)
  boundedString(candidate.runtimeRef, `${label}.runtimeRef`)
  boundedString(candidate.version, `${label}.version`)
  digest(candidate.descriptorDigest, `${label}.descriptorDigest`)
  return candidate
}

function revisionFences(value, label) {
  const candidate = record(value, label)
  exactKeys(candidate, [
    'catalogRevision', 'inventoryRevision', 'targetRevision', 'ownerRevision', 'scopeRevision', 'profileRevision',
  ], label)
  if (integer(candidate.catalogRevision, `${label}.catalogRevision`) === 0) {
    fail(`${label}.catalogRevision must be positive`)
  }
  digest(candidate.inventoryRevision, `${label}.inventoryRevision`)
  for (const field of ['targetRevision', 'ownerRevision', 'scopeRevision', 'profileRevision']) {
    boundedString(candidate[field], `${label}.${field}`)
  }
  return candidate
}

function managedObjectBinding(operationKind, managedObject, externalRuntimeAction, binding, label) {
  const connection = managedObject === 'connection'
  const artifactDownload = operationKind === 'install' || operationKind === 'update'
  if ((connection && (externalRuntimeAction !== 'none' || binding === null))
    || (!connection && (binding !== null || externalRuntimeAction !== (artifactDownload ? 'download' : 'none')))) {
    fail(`${label} managed object and runtime authority are inconsistent`)
  }
}

function immutablePlanContent(value, label) {
  const candidate = record(value, label)
  exactKeys(candidate, PLAN_CONTENT_KEYS, label)
  if (candidate.schemaVersion !== 1) fail(`${label}.schemaVersion must be 1`)
  if (candidate.singleUse !== true) fail(`${label}.singleUse must be true`)
  for (const field of [
    'planId', 'intentId', 'candidateRef', 'extensionId', 'artifactRevision', 'targetKey',
    'ownerKey', 'scopeKey', 'profileId', 'idempotencyKey',
  ]) {
    boundedString(candidate[field], `${label}.${field}`)
  }
  literal(candidate.origin, ['store', 'task'], `${label}.origin`)
  const extensionKind = literal(candidate.extensionKind, ['plugin', 'mcp', 'skill'], `${label}.extensionKind`)
  const managedObject = literal(candidate.managedObject, ['artifact', 'connection'], `${label}.managedObject`)
  const externalRuntimeAction = literal(
    candidate.externalRuntimeAction,
    ['download', 'none'],
    `${label}.externalRuntimeAction`,
  )
  const binding = runtimeBinding(candidate.runtimeBinding, `${label}.runtimeBinding`)
  artifactIntegrity(candidate.artifactIntegrity, `${label}.artifactIntegrity`)
  boundedString(candidate.artifactUrl, `${label}.artifactUrl`, 2_048)
  integer(candidate.artifactSizeBytes, `${label}.artifactSizeBytes`)
  const operationKind = literal(candidate.operationKind, OPERATION_KINDS, `${label}.operationKind`)
  literal(candidate.desiredState, ['enabled', 'disabled', 'removed'], `${label}.desiredState`)
  for (const field of [
    'authorityDigest', 'configurationDigest', 'retentionDigest', 'mutationDigest', 'verificationDigest',
  ]) {
    digest(candidate[field], `${label}.${field}`)
  }
  const reviewEvidence = planReviewEvidence(candidate.reviewEvidence, `${label}.reviewEvidence`)
  boolean(candidate.restartRequired, `${label}.restartRequired`)
  const createdAtMs = integer(candidate.createdAtMs, `${label}.createdAtMs`)
  const expiresAtMs = integer(candidate.expiresAtMs, `${label}.expiresAtMs`)
  if (createdAtMs >= expiresAtMs) fail(`${label} validity interval is invalid`)
  revisionFences(candidate.fences, `${label}.fences`)
  managedObjectBinding(operationKind, managedObject, externalRuntimeAction, binding, label)
  if (reviewEvidence.kind !== extensionKind
    || reviewEvidence.operationKind !== operationKind
    || ((extensionKind === 'mcp') !== (managedObject === 'connection'))) {
    fail(`${label} review evidence and managed object do not match the operation`)
  }
  if (reviewEvidence.kind === 'plugin'
    && reviewEvidence.activation.restartRequired !== candidate.restartRequired) {
    fail(`${label} restart requirement does not match Plugin activation evidence`)
  }
  return candidate
}

function planEvidence(value, label) {
  const candidate = record(value, label)
  exactKeys(candidate, [
    'origin', 'candidateRef', 'extensionKind', 'extensionId', 'artifactRevision', 'artifactIntegrity',
    'artifactUrl', 'artifactSizeBytes', 'desiredState', 'ownerKey', 'scopeKey', 'profileId',
    'idempotencyKey', 'authorityDigest', 'configurationDigest', 'retentionDigest', 'mutationDigest',
    'verificationDigest', 'reviewEvidence', 'restartRequired', 'fences', 'recoveryExecutable',
  ], label)
  literal(candidate.origin, ['store', 'task'], `${label}.origin`)
  boundedString(candidate.candidateRef, `${label}.candidateRef`)
  literal(candidate.extensionKind, ['plugin', 'mcp', 'skill'], `${label}.extensionKind`)
  boundedString(candidate.extensionId, `${label}.extensionId`)
  boundedString(candidate.artifactRevision, `${label}.artifactRevision`)
  artifactIntegrity(candidate.artifactIntegrity, `${label}.artifactIntegrity`)
  boundedString(candidate.artifactUrl, `${label}.artifactUrl`, 2_048)
  integer(candidate.artifactSizeBytes, `${label}.artifactSizeBytes`)
  literal(candidate.desiredState, ['enabled', 'disabled', 'removed'], `${label}.desiredState`)
  for (const field of ['ownerKey', 'scopeKey', 'profileId', 'idempotencyKey']) {
    boundedString(candidate[field], `${label}.${field}`)
  }
  for (const field of [
    'authorityDigest', 'configurationDigest', 'retentionDigest', 'mutationDigest', 'verificationDigest',
  ]) {
    digest(candidate[field], `${label}.${field}`)
  }
  const reviewEvidence = planReviewEvidence(candidate.reviewEvidence, `${label}.reviewEvidence`)
  const restartRequired = boolean(candidate.restartRequired, `${label}.restartRequired`)
  if (reviewEvidence.kind === 'plugin'
    && reviewEvidence.activation.restartRequired !== restartRequired) {
    fail(`${label}.restartRequired does not match Plugin activation evidence`)
  }
  revisionFences(candidate.fences, `${label}.fences`)
  const recovery = record(candidate.recoveryExecutable, `${label}.recoveryExecutable`)
  exactKeys(recovery, [
    'arch', 'centerRoot', 'executablePath', 'executableSha256', 'officialDsh', 'packageVersion', 'platform', 'schemaVersion',
  ], `${label}.recoveryExecutable`)
  const executablePath = boundedString(recovery.executablePath, `${label}.recoveryExecutable.executablePath`, 4_096)
  const centerRoot = boundedString(recovery.centerRoot, `${label}.recoveryExecutable.centerRoot`, 4_096)
  const arch = boundedString(recovery.arch, `${label}.recoveryExecutable.arch`, 64)
  if (recovery.schemaVersion !== 5 || !isAbsolute(executablePath)
    || !isAbsolute(centerRoot) || !/^[a-z0-9][a-z0-9._-]*$/u.test(arch)) {
    fail(`${label}.recoveryExecutable values are invalid`)
  }
  digest(recovery.executableSha256, `${label}.recoveryExecutable.executableSha256`)
  boundedString(recovery.packageVersion, `${label}.recoveryExecutable.packageVersion`, 128)
  literal(recovery.platform, ['darwin', 'linux', 'win32'], `${label}.recoveryExecutable.platform`)
  const officialDsh = record(recovery.officialDsh, `${label}.recoveryExecutable.officialDsh`)
  exactKeys(officialDsh, [
    'entrypointPath', 'entrypointSha256', 'hostHome', 'packageName', 'packageRoot', 'packageTreeSha256',
    'packageVersion', 'pnpm', 'productionDependencies', 'schemaVersion', 'supervisorPath', 'supervisorSha256',
    'timeoutMs', 'node',
  ], `${label}.recoveryExecutable.officialDsh`)
  if (officialDsh.schemaVersion !== 2 || officialDsh.packageName !== '@deepseek-ai/dsh'
    || officialDsh.packageVersion !== '0.1.1-rc.2') {
    fail(`${label}.recoveryExecutable.officialDsh identity is invalid`)
  }
  for (const field of ['entrypointPath', 'hostHome', 'packageRoot', 'supervisorPath']) {
    if (!isAbsolute(boundedString(officialDsh[field], `${label}.recoveryExecutable.officialDsh.${field}`, 4_096))) {
      fail(`${label}.recoveryExecutable.officialDsh.${field} must be absolute`)
    }
  }
  digest(officialDsh.entrypointSha256, `${label}.recoveryExecutable.officialDsh.entrypointSha256`)
  digest(officialDsh.packageTreeSha256, `${label}.recoveryExecutable.officialDsh.packageTreeSha256`)
  digest(officialDsh.supervisorSha256, `${label}.recoveryExecutable.officialDsh.supervisorSha256`)
  const timeoutMs = integer(officialDsh.timeoutMs, `${label}.recoveryExecutable.officialDsh.timeoutMs`)
  if (timeoutMs < 1_000 || timeoutMs > 600_000) fail(`${label}.recoveryExecutable.officialDsh.timeoutMs is invalid`)
  const dependencyKeys = array(
    officialDsh.productionDependencies,
    `${label}.recoveryExecutable.officialDsh.productionDependencies`,
    1_024,
  ).map((value, index) => {
    const dependencyLabel = `${label}.recoveryExecutable.officialDsh.productionDependencies[${String(index)}]`
    const dependency = record(value, dependencyLabel)
    exactKeys(dependency, ['packageName', 'packageRoot', 'packageTreeSha256', 'packageVersion'], dependencyLabel)
    const packageName = boundedString(dependency.packageName, `${dependencyLabel}.packageName`, 256)
    const packageVersion = boundedString(dependency.packageVersion, `${dependencyLabel}.packageVersion`, 128)
    const packageRoot = boundedString(dependency.packageRoot, `${dependencyLabel}.packageRoot`, 4_096)
    if (!isAbsolute(packageRoot)) fail(`${dependencyLabel}.packageRoot must be absolute`)
    digest(dependency.packageTreeSha256, `${dependencyLabel}.packageTreeSha256`)
    return `${packageName}\0${packageVersion}\0${packageRoot}`
  })
  if (new Set(dependencyKeys).size !== dependencyKeys.length
    || dependencyKeys.some((key, index) => index > 0 && dependencyKeys[index - 1].localeCompare(key) >= 0)) {
    fail(`${label}.recoveryExecutable.officialDsh.productionDependencies must be sorted and unique`)
  }
  const node = record(officialDsh.node, `${label}.recoveryExecutable.officialDsh.node`)
  exactKeys(node, ['executablePath', 'executableSha256', 'schemaVersion', 'version'], `${label}.recoveryExecutable.officialDsh.node`)
  if (node.schemaVersion !== 1
    || !isAbsolute(boundedString(node.executablePath, `${label}.recoveryExecutable.officialDsh.node.executablePath`, 4_096))
    || !/^v\d+\.\d+\.\d+(?:[-+].*)?$/u.test(boundedString(node.version, `${label}.recoveryExecutable.officialDsh.node.version`, 64))) {
    fail(`${label}.recoveryExecutable.officialDsh.node is invalid`)
  }
  digest(node.executableSha256, `${label}.recoveryExecutable.officialDsh.node.executableSha256`)
  const pnpm = record(officialDsh.pnpm, `${label}.recoveryExecutable.officialDsh.pnpm`)
  exactKeys(pnpm, [
    'entrypointPath', 'entrypointSha256', 'packageName', 'packageRoot', 'packageTreeSha256', 'packageVersion',
    'registryIntegrity', 'runtimeRoot', 'schemaVersion', 'shellPath', 'shellSha256', 'shimPath', 'shimSha256',
  ], `${label}.recoveryExecutable.officialDsh.pnpm`)
  if (pnpm.schemaVersion !== 1 || pnpm.packageName !== 'pnpm'
    || !READABLE_PNPM_IDENTITIES.some(identity => identity.packageVersion === pnpm.packageVersion
      && identity.registryIntegrity === pnpm.registryIntegrity)) {
    fail(`${label}.recoveryExecutable.officialDsh.pnpm identity is invalid`)
  }
  for (const field of ['packageRoot', 'entrypointPath', 'shimPath', 'shellPath', 'runtimeRoot']) {
    if (!isAbsolute(boundedString(pnpm[field], `${label}.recoveryExecutable.officialDsh.pnpm.${field}`, 4_096))) {
      fail(`${label}.recoveryExecutable.officialDsh.pnpm.${field} must be absolute`)
    }
  }
  for (const field of ['packageTreeSha256', 'entrypointSha256', 'shimSha256', 'shellSha256']) {
    digest(pnpm[field], `${label}.recoveryExecutable.officialDsh.pnpm.${field}`)
  }
  return candidate
}

function deriveReceiptEvidence(input) {
  const mutation = input.mutationDigests.length > 0
    ? 'proven'
    : input.outcome === 'failed' ? 'not-required' : 'not-proven'
  const verification = input.outcome === 'committed' && input.verificationDigests.length > 0
    ? 'proven'
    : input.outcome === 'failed' ? 'not-required' : 'not-proven'
  const rollback = input.rollbackAttempted
    ? input.outcome === 'rolled-back' ? 'proven' : 'not-proven'
    : 'not-required'
  const restartRequired = input.planEvidence.restartRequired && input.mutationDigests.length > 0
  const restart = !restartRequired
    ? 'not-required'
    : input.verificationDigests.length > 0 && input.outcome !== 'failed' ? 'proven' : 'not-proven'
  const recovery = input.recoveryAttempts === 0
    ? 'not-required'
    : input.outcome === 'rolled-back' ? 'proven' : 'not-proven'
  const statuses = { mutation, verification, rollback, restart, recovery }
  return {
    checksActuallyRun: input.planEvidence.reviewEvidence.checks
      .filter(check => input.completedReviewPhases.includes(check.phase)),
    mutation,
    verification,
    rollback: { attempted: input.rollbackAttempted, status: rollback },
    restart: { required: restartRequired, status: restart },
    recovery: { attempts: input.recoveryAttempts, status: recovery },
    notProven: RECEIPT_NOT_PROVEN.filter(claim => statuses[claim] === 'not-proven'),
  }
}

function receiptEvidence(value, body, label) {
  const candidate = record(value, label)
  exactKeys(candidate, [
    'checksActuallyRun', 'mutation', 'verification', 'rollback', 'restart', 'recovery', 'notProven',
  ], label)
  const checksActuallyRun = reviewChecks(candidate.checksActuallyRun, `${label}.checksActuallyRun`)
  literal(candidate.mutation, ['proven', 'not-required', 'not-proven'], `${label}.mutation`)
  literal(candidate.verification, ['proven', 'not-required', 'not-proven'], `${label}.verification`)
  const rollback = record(candidate.rollback, `${label}.rollback`)
  exactKeys(rollback, ['attempted', 'status'], `${label}.rollback`)
  boolean(rollback.attempted, `${label}.rollback.attempted`)
  literal(rollback.status, ['proven', 'not-required', 'not-proven'], `${label}.rollback.status`)
  const restart = record(candidate.restart, `${label}.restart`)
  exactKeys(restart, ['required', 'status'], `${label}.restart`)
  boolean(restart.required, `${label}.restart.required`)
  literal(restart.status, ['proven', 'not-required', 'not-proven'], `${label}.restart.status`)
  const recovery = record(candidate.recovery, `${label}.recovery`)
  exactKeys(recovery, ['attempts', 'status'], `${label}.recovery`)
  integer(recovery.attempts, `${label}.recovery.attempts`)
  literal(recovery.status, ['proven', 'not-required', 'not-proven'], `${label}.recovery.status`)
  array(candidate.notProven, `${label}.notProven`, RECEIPT_NOT_PROVEN.length)
    .forEach((claim, index) => literal(claim, RECEIPT_NOT_PROVEN, `${label}.notProven[${String(index)}]`))
  const expected = deriveReceiptEvidence({
    ...body,
    rollbackAttempted: rollback.attempted,
    recoveryAttempts: recovery.attempts,
    completedReviewPhases: checksActuallyRun.map(check => check.phase),
  })
  if (!sameJson(candidate, expected)) fail(`${label} is inconsistent with the terminal evidence`)
  return candidate
}

function receipt(value, label) {
  const candidate = record(value, label)
  exactKeys(candidate, ['body', 'digest'], label)
  const body = record(candidate.body, `${label}.body`)
  exactKeys(body, RECEIPT_BODY_KEYS, `${label}.body`)
  if (body.schemaVersion !== 1) fail(`${label}.body.schemaVersion must be 1`)
  boundedString(body.operationId, `${label}.body.operationId`)
  boundedString(body.planId, `${label}.body.planId`)
  digest(body.planHash, `${label}.body.planHash`)
  const operationKind = literal(body.operationKind, OPERATION_KINDS, `${label}.body.operationKind`)
  const managedObject = literal(body.managedObject, ['artifact', 'connection'], `${label}.body.managedObject`)
  const externalRuntimeAction = literal(
    body.externalRuntimeAction,
    ['download', 'none'],
    `${label}.body.externalRuntimeAction`,
  )
  const binding = runtimeBinding(body.runtimeBinding, `${label}.body.runtimeBinding`)
  const evidence = planEvidence(body.planEvidence, `${label}.body.planEvidence`)
  boundedString(body.targetKey, `${label}.body.targetKey`)
  const outcome = literal(body.outcome, TERMINAL_PHASES, `${label}.body.outcome`)
  digest(body.beforeDigest, `${label}.body.beforeDigest`)
  digest(body.afterDigest, `${label}.body.afterDigest`, true)
  const mutationDigests = array(body.mutationDigests, `${label}.body.mutationDigests`)
  const verificationDigests = array(body.verificationDigests, `${label}.body.verificationDigests`)
  mutationDigests.forEach((entry, index) => digest(entry, `${label}.body.mutationDigests[${String(index)}]`))
  verificationDigests.forEach((entry, index) => digest(entry, `${label}.body.verificationDigests[${String(index)}]`))
  receiptEvidence(body.evidence, {
    outcome,
    mutationDigests,
    verificationDigests,
    planEvidence: evidence,
  }, `${label}.body.evidence`)
  if (integer(body.journalEventCount, `${label}.body.journalEventCount`) < 1) {
    fail(`${label}.body.journalEventCount must be positive`)
  }
  digest(body.journalHeadDigest, `${label}.body.journalHeadDigest`)
  integer(body.issuedAtMs, `${label}.body.issuedAtMs`)
  managedObjectBinding(operationKind, managedObject, externalRuntimeAction, binding, `${label}.body`)
  if (evidence.reviewEvidence.kind !== evidence.extensionKind
    || evidence.reviewEvidence.operationKind !== operationKind
    || ((evidence.extensionKind === 'mcp') !== (managedObject === 'connection'))) {
    fail(`${label}.body plan evidence does not match the operation kind and managed object`)
  }
  const receiptDigest = digest(candidate.digest, `${label}.digest`)
  if (canonicalSha256(body) !== receiptDigest) fail(`${label}.digest does not match its canonical body`)
  return candidate
}

function unsignedEvent(event) {
  return {
    schemaVersion: event.schemaVersion,
    operationId: event.operationId,
    targetKey: event.targetKey,
    sequence: event.sequence,
    previousDigest: event.previousDigest,
    atMs: event.atMs,
    entry: event.entry,
  }
}

function addCompletedReviewPhase(phases, phase) {
  return phases.includes(phase) ? phases : [...phases, phase]
}

/**
 * Independently verify a terminal receipt's complete schema, semantics, and canonical digest.
 * @returns The verified receipt object.
 */
export function verifyTerminalReceipt(value) {
  return receipt(value, 'receipt')
}

/**
 * Bind one independently decoded immutable plan to the authorization evidence in its terminal receipt.
 * @param {unknown} receiptValue Terminal lifecycle receipt.
 * @param {unknown} planValue Immutable plan returned before approval.
 * @returns The verified receipt object.
 */
export function verifyTerminalReceiptPlanBinding(receiptValue, planValue) {
  const terminal = receipt(receiptValue, 'receipt')
  const plan = verifyImmutablePlanDigest(planValue)
  const content = plan.content
  const body = terminal.body
  for (const field of [
    'planId', 'operationKind', 'managedObject', 'externalRuntimeAction', 'runtimeBinding', 'targetKey',
  ]) {
    if (!sameJson(body[field], content[field])) fail(`receipt body.${field} does not match plan.content.${field}`)
  }
  if (body.planHash !== plan.hash) fail('receipt body.planHash does not match plan.hash')
  for (const field of PLAN_AUTHORIZATION_SHARED_KEYS) {
    if (!sameJson(body.planEvidence[field], content[field])) {
      fail(`receipt body.planEvidence.${field} does not match plan.content.${field}`)
    }
  }
  return terminal
}

/**
 * Bind a terminal receipt to one externally returned durable operation journal.
 * @param {unknown} operationValue `operation/get` operation value.
 * @param {unknown} receiptValue terminal lifecycle receipt.
 */
export function verifyOperationReceiptJournal(operationValue, receiptValue) {
  const expectedReceipt = receipt(receiptValue, 'expected receipt')
  const operation = record(operationValue, 'operation')
  exactKeys(operation, ['journal', 'projection', 'recovered'], 'operation')
  if (typeof operation.recovered !== 'boolean') fail('operation.recovered must be boolean')

  const journal = record(operation.journal, 'operation.journal')
  exactKeys(journal, ['events', 'operationId', 'schemaVersion', 'targetKey'], 'operation.journal')
  if (journal.schemaVersion !== 1) fail('operation.journal.schemaVersion must be 1')
  const operationId = boundedString(journal.operationId, 'operation.journal.operationId')
  const targetKey = boundedString(journal.targetKey, 'operation.journal.targetKey')
  if (operationId !== expectedReceipt.body.operationId || targetKey !== expectedReceipt.body.targetKey) {
    fail('journal identity does not match the terminal receipt')
  }
  if (!Array.isArray(journal.events) || journal.events.length < 2) fail('journal must contain a terminal prefix and receipt event')

  let previousDigest = null
  let previousAtMs = 0
  for (const [index, eventValue] of journal.events.entries()) {
    const event = record(eventValue, `operation.journal.events[${String(index)}]`)
    exactKeys(event, [
      'atMs', 'digest', 'entry', 'operationId', 'previousDigest', 'schemaVersion', 'sequence', 'targetKey',
    ], `operation.journal.events[${String(index)}]`)
    if (event.operationId !== operationId || event.targetKey !== targetKey
      || event.schemaVersion !== 1 || event.sequence !== index + 1 || event.previousDigest !== previousDigest) {
      fail(`journal link mismatch at event ${String(index + 1)}`)
    }
    if (!Number.isSafeInteger(event.atMs) || event.atMs < previousAtMs) fail(`journal time moved backwards at event ${String(index + 1)}`)
    const eventDigest = digest(event.digest, `operation.journal.events[${String(index)}].digest`)
    if (canonicalSha256(unsignedEvent(event)) !== eventDigest) fail(`journal digest mismatch at event ${String(index + 1)}`)
    previousDigest = eventDigest
    previousAtMs = event.atMs
  }

  const opening = record(journal.events[0].entry, 'opening entry')
  exactKeys(opening, [
    'beforeDigest', 'externalRuntimeAction', 'managedObject', 'operationKind', 'planEvidence',
    'planHash', 'planId', 'runtimeBinding', 'type',
  ], 'opening entry')
  if (opening.type !== 'operation-opened') fail('journal does not begin with operation-opened')
  for (const field of [
    'planId', 'planHash', 'operationKind', 'managedObject', 'externalRuntimeAction',
    'runtimeBinding', 'planEvidence', 'beforeDigest',
  ]) {
    if (!sameJson(opening[field], expectedReceipt.body[field])) fail(`opening ${field} does not match the receipt body`)
  }

  let projection = {
    operationId,
    targetKey,
    planId: opening.planId,
    planHash: opening.planHash,
    operationKind: opening.operationKind,
    managedObject: opening.managedObject,
    externalRuntimeAction: opening.externalRuntimeAction,
    runtimeBinding: opening.runtimeBinding,
    planEvidence: opening.planEvidence,
    phase: 'authorized',
    beforeDigest: opening.beforeDigest,
    afterDigest: null,
    mutationDigests: [],
    verificationDigests: [],
    rollbackAttempted: false,
    recoveryAttempts: 0,
    completedReviewPhases: ['planning'],
    lastAtMs: journal.events[0].atMs,
    receipt: null,
  }

  const receiptIndex = journal.events.length - 1
  for (let index = 1; index < receiptIndex; index += 1) {
    const entry = record(journal.events[index].entry, `journal entry ${String(index + 1)}`)
    const entryLabel = `journal entry ${String(index + 1)}`
    if (entry.type === 'phase-transition') {
      exactKeys(entry, ['evidenceDigest', 'from', 'reason', 'to', 'type'], entryLabel)
      const from = literal(entry.from, OPERATION_PHASES, `${entryLabel}.from`)
      const to = literal(entry.to, OPERATION_PHASES, `${entryLabel}.to`)
      const evidenceDigest = digest(entry.evidenceDigest, `${entryLabel}.evidenceDigest`, true)
      const reason = entry.reason === null ? null : boundedString(entry.reason, `${entryLabel}.reason`, 64)
      if (reason !== null && !/^[a-z0-9][a-z0-9-]*$/u.test(reason)) fail(`${entryLabel}.reason is not a stable reason code`)
      if (from !== projection.phase || !NEXT_PHASES[projection.phase].includes(to)) {
        fail(`invalid phase transition at event ${String(index + 1)}`)
      }
      const terminal = TERMINAL_PHASES.includes(to)
      if (!terminal && evidenceDigest !== null) fail(`non-terminal evidence at event ${String(index + 1)}`)
      if ((to === 'failed' || to === 'recovery-required') && reason === null) fail(`${to} requires a reason`)
      if (to === 'committed'
        && (evidenceDigest === null || projection.verificationDigests.length === 0 || reason !== null)) {
        fail('committed transition lacks verified owner evidence')
      }
      if (to === 'rolled-back' && (evidenceDigest !== projection.beforeDigest || reason !== null)) {
        fail('rolled-back transition does not prove the before state')
      }
      if (to === 'failed'
        && (projection.mutationDigests.length !== 0 || evidenceDigest !== projection.beforeDigest)) {
        fail('failed transition does not prove an unchanged before state')
      }
      projection = {
        ...projection,
        phase: to,
        afterDigest: terminal ? evidenceDigest : null,
        rollbackAttempted: projection.rollbackAttempted || to === 'rolling-back',
        recoveryAttempts: projection.recoveryAttempts + (to === 'recovery-required' ? 1 : 0),
        completedReviewPhases: to === 'applying'
          ? addCompletedReviewPhase(projection.completedReviewPhases, 'prepare')
          : projection.completedReviewPhases,
        lastAtMs: journal.events[index].atMs,
      }
      continue
    }
    if (entry.type === 'mutation-observed') {
      exactKeys(entry, ['mutationDigest', 'type'], entryLabel)
      if (!['applying', 'verifying', 'rolling-back'].includes(projection.phase)) {
        fail(`mutation observation is invalid during ${projection.phase}`)
      }
      projection = {
        ...projection,
        mutationDigests: [
          ...projection.mutationDigests,
          digest(entry.mutationDigest, `${entryLabel}.mutationDigest`),
        ],
        completedReviewPhases: addCompletedReviewPhase(projection.completedReviewPhases, 'apply'),
        lastAtMs: journal.events[index].atMs,
      }
      continue
    }
    if (entry.type === 'verification-observed') {
      exactKeys(entry, ['type', 'verificationDigest'], entryLabel)
      if (!['verifying', 'rolling-back'].includes(projection.phase)) {
        fail(`verification observation is invalid during ${projection.phase}`)
      }
      let completedReviewPhases = addCompletedReviewPhase(projection.completedReviewPhases, 'verify')
      if (projection.planEvidence.restartRequired) {
        completedReviewPhases = addCompletedReviewPhase(completedReviewPhases, 'external-restart')
      }
      projection = {
        ...projection,
        verificationDigests: [
          ...projection.verificationDigests,
          digest(entry.verificationDigest, `${entryLabel}.verificationDigest`),
        ],
        completedReviewPhases,
        lastAtMs: journal.events[index].atMs,
      }
      continue
    }
    fail(`unsupported journal entry at event ${String(index + 1)}`)
  }

  const receiptEvent = journal.events[receiptIndex]
  const receiptEntry = record(receiptEvent.entry, 'receipt event entry')
  exactKeys(receiptEntry, ['receipt', 'type'], 'receipt event entry')
  if (receiptEntry.type !== 'receipt-issued') fail('receipt is not the final journal event')
  if (!TERMINAL_PHASES.includes(projection.phase)) fail('receipt does not follow a terminal operation')
  const embeddedReceipt = receipt(receiptEntry.receipt, 'journal receipt')
  if (!sameJson(embeddedReceipt, expectedReceipt)) fail('journal receipt differs from the lifecycle receipt')
  const expectedBody = {
    schemaVersion: 1,
    operationId: projection.operationId,
    planId: projection.planId,
    planHash: projection.planHash,
    operationKind: projection.operationKind,
    managedObject: projection.managedObject,
    externalRuntimeAction: projection.externalRuntimeAction,
    runtimeBinding: projection.runtimeBinding,
    planEvidence: projection.planEvidence,
    targetKey: projection.targetKey,
    outcome: projection.phase,
    beforeDigest: projection.beforeDigest,
    afterDigest: projection.afterDigest,
    mutationDigests: projection.mutationDigests,
    verificationDigests: projection.verificationDigests,
    evidence: deriveReceiptEvidence({ ...projection, outcome: projection.phase }),
    journalEventCount: receiptIndex,
    journalHeadDigest: receiptEvent.previousDigest,
    issuedAtMs: receiptEvent.atMs,
  }
  if (!sameJson(expectedReceipt.body, expectedBody)) {
    fail('receipt body does not match the reconstructed terminal journal prefix')
  }

  projection = { ...projection, lastAtMs: receiptEvent.atMs, receipt: expectedReceipt }
  const returnedProjection = record(operation.projection, 'operation.projection')
  exactKeys(returnedProjection, PROJECTION_KEYS, 'operation.projection')
  if (!sameJson(returnedProjection, projection)) {
    fail('operation projection does not match the reconstructed journal')
  }
}

/**
 * Verify unique durable receipt inventory and bind it to the lifecycle receipts.
 * @param {unknown} rowsValue `operation/receipts` rows.
 * @param {readonly unknown[]} expectedValues lifecycle receipts observed in this run.
 */
export function verifyReceiptInventory(rowsValue, expectedValues) {
  if (!Array.isArray(rowsValue)) fail('receipt inventory must be an array')
  const expected = expectedValues.map((value, index) => receipt(value, `expected receipts[${String(index)}]`))
  const expectedIds = new Set(expected.map(value => value.body.operationId))
  const expectedDigests = new Set(expected.map(value => value.digest))
  if (expectedIds.size !== expected.length || expectedDigests.size !== expected.length) {
    fail('lifecycle receipts must have unique operation ids and digests')
  }
  if (rowsValue.length !== expected.length) fail('durable receipt inventory size does not match this isolated run')
  const observedIds = new Set()
  for (const [index, value] of rowsValue.entries()) {
    const row = record(value, `receipt inventory[${String(index)}]`)
    exactKeys(row, ['operationId', 'receipt', 'targetKey'], `receipt inventory[${String(index)}]`)
    const stored = receipt(row.receipt, `receipt inventory[${String(index)}].receipt`)
    if (row.operationId !== stored.body.operationId || row.targetKey !== stored.body.targetKey) {
      fail(`receipt inventory[${String(index)}] identity does not match its receipt`)
    }
    if (observedIds.has(row.operationId)) fail('durable receipt inventory contains a duplicate operation id')
    observedIds.add(row.operationId)
    const expectedReceipt = expected.find(candidate => candidate.body.operationId === row.operationId)
    if (expectedReceipt === undefined || !sameJson(stored, expectedReceipt)) {
      fail(`receipt inventory[${String(index)}] does not match a lifecycle receipt`)
    }
  }
}
