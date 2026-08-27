import { readArtifactIntegrity, readBoundedString, readLiteral, readNonNegativeInteger, readNullableSha256Digest, readSha256Digest, readStrictRecord, } from "../domain/codec.js";
import { failDomain } from "../domain/errors.js";
import { immutableJsonClone } from "../domain/json.js";
const OPERATIONS = [
    'install', 'configure', 'update', 'enable', 'disable', 'uninstall', 'restore', 'purge',
];
const CHECK_CODES = [
    'catalog-admission', 'owner-revision', 'review-record', 'artifact-integrity', 'plugin-manifest',
    'plugin-dependencies', 'plugin-lifecycle-scripts', 'plugin-package-metadata', 'plugin-settings-schema',
    'center-plugin-material', 'official-profile-package', 'loader-consumer', 'host-restart-observation', 'skill-file-manifest',
    'skill-frontmatter', 'skill-body', 'skill-links', 'skill-executables', 'invocation-policy',
    'merged-skill-winner', 'mcp-runtime-integrity', 'mcp-descriptor', 'mcp-secret-absence',
    'mcp-initialize', 'mcp-tools-list', 'mcp-tool-generation', 'owner-mutation', 'owner-absence',
    'quiescent-disposal',
];
const CHECK_PHASES = ['planning', 'prepare', 'apply', 'verify', 'external-restart'];
const MATERIAL_KINDS = [
    'center-plugin-material', 'profile-dependency', 'loader-entry', 'plugin-settings', 'skill-file',
    'connection-row', 'credential-record', 'external-runtime', 'remote-data', 'recovery-point',
];
const ROLLBACK_LIMITS = [
    'dsh-managed-state-only', 'remote-grants-not-revoked', 'third-party-side-effects-not-reversed',
    'external-runtime-not-restored', 'workspace-files-not-restored', 'purge-irreversible',
    'restart-required-before-runtime-proof',
];
const NOT_PROVEN = [
    'catalog-admission-is-not-security-audit', 'third-party-code-side-effects', 'remote-side-effects', 'external-runtime-state',
    'post-restart-consumer', 'user-task-outcome',
];
function boolean(value, path) {
    if (typeof value !== 'boolean')
        failDomain('invalid-data', `${path} must be boolean`);
    return value;
}
function nullableBoolean(value, path) {
    return value === null ? null : boolean(value, path);
}
function nullableString(value, path, maximum = 4_096) {
    return value === null ? null : readBoundedString(value, path, maximum);
}
function exactText(value, path) {
    if (value === null)
        return null;
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024 || value.includes('\0')) {
        failDomain('invalid-data', `${path} must be bounded UTF-8 text without NUL`);
    }
    return value;
}
function exactArgument(value, path, maximum = 4_096) {
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
        failDomain('invalid-data', `${path} must be a bounded argument without control characters`);
    }
    return value;
}
function array(value, path, maximum = 512) {
    if (!Array.isArray(value) || value.length > maximum)
        failDomain('invalid-data', `${path} must be a bounded array`);
    return value;
}
function literalArray(value, accepted, path) {
    const output = array(value, path).map((item, index) => readLiteral(item, accepted, `${path}[${String(index)}]`));
    if (new Set(output).size !== output.length)
        failDomain('invalid-data', `${path} contains duplicates`);
    return Object.freeze(output);
}
function stringArray(value, path, maximum = 512) {
    const output = array(value, path, maximum).map((item, index) => readBoundedString(item, `${path}[${String(index)}]`, 512));
    if (new Set(output).size !== output.length)
        failDomain('invalid-data', `${path} contains duplicates`);
    return Object.freeze(output);
}
function checks(value, path) {
    const output = array(value, path, 64).map((item, index) => {
        const at = `${path}[${String(index)}]`;
        const record = readStrictRecord(item, ['code', 'phase'], at);
        return Object.freeze({
            code: readLiteral(record.code, CHECK_CODES, `${at}.code`),
            phase: readLiteral(record.phase, CHECK_PHASES, `${at}.phase`),
        });
    });
    if (output.length === 0 || new Set(output.map(item => item.code)).size !== output.length) {
        failDomain('invalid-data', `${path} must contain unique checks`);
    }
    return Object.freeze(output);
}
function materials(value, path) {
    const output = array(value, path, 128).map((item, index) => {
        const at = `${path}[${String(index)}]`;
        const record = readStrictRecord(item, ['digest', 'id', 'kind'], at);
        return Object.freeze({
            kind: readLiteral(record.kind, MATERIAL_KINDS, `${at}.kind`),
            id: readBoundedString(record.id, `${at}.id`, 4_096),
            digest: readNullableSha256Digest(record.digest, `${at}.digest`),
        });
    });
    if (new Set(output.map(item => `${item.kind}\0${item.id}`)).size !== output.length) {
        failDomain('invalid-data', `${path} contains duplicate material`);
    }
    return Object.freeze(output);
}
function rollbackPoint(value, path) {
    if (value === null)
        return null;
    const record = readStrictRecord(value, ['digest', 'id', 'kind'], path);
    return Object.freeze({
        kind: readLiteral(record.kind, ['absent-state', 'managed-version'], `${path}.kind`),
        id: readBoundedString(record.id, `${path}.id`, 512),
        digest: readSha256Digest(record.digest, `${path}.digest`),
    });
}
function common(value, path) {
    const record = value;
    if (record.schemaVersion !== 1)
        failDomain('invalid-data', `${path}.schemaVersion is unsupported`);
    return Object.freeze({
        schemaVersion: 1,
        operationKind: readLiteral(record.operationKind, OPERATIONS, `${path}.operationKind`),
        checks: checks(record.checks, `${path}.checks`),
        removed: materials(record.removed, `${path}.removed`),
        retained: materials(record.retained, `${path}.retained`),
        credentialChoice: readLiteral(record.credentialChoice, ['not-applicable', 'retain-local-record', 'delete-local-record'], `${path}.credentialChoice`),
        rollbackPoint: rollbackPoint(record.rollbackPoint, `${path}.rollbackPoint`),
        rollbackLimits: literalArray(record.rollbackLimits, ROLLBACK_LIMITS, `${path}.rollbackLimits`),
        notProven: literalArray(record.notProven, NOT_PROVEN, `${path}.notProven`),
    });
}
function dependencies(value, path) {
    const output = array(value, path, 256).map((item, index) => {
        const at = `${path}[${String(index)}]`;
        const record = readStrictRecord(item, ['afterVersion', 'beforeVersion', 'id', 'kind', 'required'], at);
        return Object.freeze({
            kind: readLiteral(record.kind, ['host', 'runtime', 'extension', 'peer'], `${at}.kind`),
            id: readBoundedString(record.id, `${at}.id`, 256),
            beforeVersion: nullableString(record.beforeVersion, `${at}.beforeVersion`, 256),
            afterVersion: nullableString(record.afterVersion, `${at}.afterVersion`, 256),
            required: boolean(record.required, `${at}.required`),
        });
    });
    if (new Set(output.map(item => `${item.kind}\0${item.id}`)).size !== output.length) {
        failDomain('invalid-data', `${path} contains duplicate dependencies`);
    }
    return Object.freeze(output);
}
function fileChanges(value, path) {
    const output = array(value, path, 4_096).map((item, index) => {
        const at = `${path}[${String(index)}]`;
        const record = readStrictRecord(item, [
            'afterDigest', 'beforeDigest', 'change', 'executableAfter', 'executableBefore', 'linkAfter', 'linkBefore', 'path', 'sizeBytes',
        ], at);
        return Object.freeze({
            path: readBoundedString(record.path, `${at}.path`, 4_096),
            change: readLiteral(record.change, ['add', 'retain', 'replace', 'remove', 'restore', 'purge'], `${at}.change`),
            beforeDigest: readNullableSha256Digest(record.beforeDigest, `${at}.beforeDigest`),
            afterDigest: readNullableSha256Digest(record.afterDigest, `${at}.afterDigest`),
            sizeBytes: readNonNegativeInteger(record.sizeBytes, `${at}.sizeBytes`),
            executableBefore: boolean(record.executableBefore, `${at}.executableBefore`),
            executableAfter: boolean(record.executableAfter, `${at}.executableAfter`),
            linkBefore: nullableString(record.linkBefore, `${at}.linkBefore`),
            linkAfter: nullableString(record.linkAfter, `${at}.linkAfter`),
        });
    });
    if (output.length === 0 || new Set(output.map(item => item.path)).size !== output.length) {
        failDomain('invalid-data', `${path} must contain unique files`);
    }
    return Object.freeze(output);
}
function reconnect(value, path) {
    const record = readStrictRecord(value, ['enabled', 'initialDelayMs', 'maxAttempts', 'maxDelayMs'], path);
    return Object.freeze({
        enabled: boolean(record.enabled, `${path}.enabled`),
        initialDelayMs: readNonNegativeInteger(record.initialDelayMs, `${path}.initialDelayMs`),
        maxDelayMs: readNonNegativeInteger(record.maxDelayMs, `${path}.maxDelayMs`),
        maxAttempts: readNonNegativeInteger(record.maxAttempts, `${path}.maxAttempts`),
    });
}
function descriptor(value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        failDomain('invalid-data', `${path} must be an object`);
    const transport = readLiteral(value.transport, ['stdio', 'http'], `${path}.transport`);
    if (transport === 'stdio') {
        const record = readStrictRecord(value, [
            'arguments', 'executable', 'reconnect', 'serverName', 'toolCallTimeoutMs', 'transport', 'workingDirectory',
        ], path);
        return Object.freeze({
            transport,
            serverName: readBoundedString(record.serverName, `${path}.serverName`, 128),
            executable: readBoundedString(record.executable, `${path}.executable`, 4_096),
            arguments: Object.freeze(array(record.arguments, `${path}.arguments`, 128)
                .map((item, index) => exactArgument(item, `${path}.arguments[${String(index)}]`))),
            workingDirectory: exactArgument(record.workingDirectory, `${path}.workingDirectory`),
            toolCallTimeoutMs: readNonNegativeInteger(record.toolCallTimeoutMs, `${path}.toolCallTimeoutMs`),
            reconnect: reconnect(record.reconnect, `${path}.reconnect`),
        });
    }
    const record = readStrictRecord(value, [
        'authentication', 'dataEgressDisclosure', 'endpoint', 'origin', 'reconnect', 'redirects',
        'serverName', 'toolCallTimeoutMs', 'transport',
    ], path);
    const origin = readBoundedString(record.origin, `${path}.origin`, 2_048);
    const endpoint = readBoundedString(record.endpoint, `${path}.endpoint`, 2_048);
    let parsed;
    try {
        parsed = new URL(endpoint);
    }
    catch {
        failDomain('invalid-data', `${path}.endpoint must be an absolute URL`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin
        || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
        failDomain('invalid-data', `${path} HTTP endpoint and origin are inconsistent`);
    }
    return Object.freeze({
        transport,
        serverName: readBoundedString(record.serverName, `${path}.serverName`, 128),
        origin,
        endpoint,
        authentication: readLiteral(record.authentication, ['none'], `${path}.authentication`),
        redirects: readLiteral(record.redirects, ['forbidden'], `${path}.redirects`),
        dataEgressDisclosure: readBoundedString(record.dataEgressDisclosure, `${path}.dataEgressDisclosure`, 2_048),
        toolCallTimeoutMs: readNonNegativeInteger(record.toolCallTimeoutMs, `${path}.toolCallTimeoutMs`),
        reconnect: reconnect(record.reconnect, `${path}.reconnect`),
    });
}
/** Strictly decode normalized kind-specific evidence before hashing or crossing RPC. */
export function decodePlanReviewEvidence(value, path = 'plan.content.reviewEvidence') {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        failDomain('invalid-data', `${path} must be an object`);
    const kind = readLiteral(value.kind, ['plugin', 'mcp', 'skill'], `${path}.kind`);
    const baseFields = [
        'schemaVersion', 'kind', 'operationKind', 'checks', 'removed', 'retained', 'credentialChoice',
        'rollbackPoint', 'rollbackLimits', 'notProven',
    ];
    if (kind === 'plugin') {
        const record = readStrictRecord(value, [
            ...baseFields, 'manifest', 'dependencies', 'managedMaterial', 'packageMetadata', 'activation', 'scripts', 'settings',
        ], path);
        const base = common(record, path);
        const manifest = readStrictRecord(record.manifest, [
            'afterVersion', 'beforeVersion', 'body', 'fileManifestDigest', 'files', 'manifestDigest', 'packageName',
        ], `${path}.manifest`);
        const managedMaterial = readStrictRecord(record.managedMaterial, [
            'afterVersion', 'beforeVersion', 'owner', 'packageName', 'targetIntegrity',
        ], `${path}.managedMaterial`);
        const packageMetadata = readStrictRecord(record.packageMetadata, ['bundlePatch'], `${path}.packageMetadata`);
        const bundlePatch = packageMetadata.bundlePatch === null ? null : readStrictRecord(packageMetadata.bundlePatch, [
            'patchBody', 'patchDigest', 'path',
        ], `${path}.packageMetadata.bundlePatch`);
        if (bundlePatch !== null && bundlePatch.path !== 'cordis.patch.yml') {
            failDomain('invalid-data', `${path}.packageMetadata.bundlePatch.path is unsupported`);
        }
        const activation = readStrictRecord(record.activation, [
            'loaderEntry', 'mutationOwner', 'packageName', 'profileDependency', 'restartRequired',
        ], `${path}.activation`);
        const scripts = readStrictRecord(record.scripts, ['after', 'before', 'forbiddenLifecycle'], `${path}.scripts`);
        const settings = readStrictRecord(record.settings, [
            'adapterDigest', 'adapterVersion', 'diffDigest', 'migration', 'migrationChanges', 'ownerRevision', 'schema', 'schemaDigest',
        ], `${path}.settings`);
        const schema = array(settings.schema, `${path}.settings.schema`, 128).map((item, index) => {
            const at = `${path}.settings.schema[${String(index)}]`;
            const field = readStrictRecord(item, ['field', 'maximum', 'minimum', 'type'], at);
            if (field.type !== 'integer')
                failDomain('invalid-data', `${at}.type is unsupported`);
            const minimum = readNonNegativeInteger(field.minimum, `${at}.minimum`);
            const maximum = readNonNegativeInteger(field.maximum, `${at}.maximum`);
            if (minimum > maximum)
                failDomain('invalid-data', `${at} range is invalid`);
            return Object.freeze({
                field: readBoundedString(field.field, `${at}.field`, 128),
                type: 'integer',
                minimum,
                maximum,
            });
        });
        if (new Set(schema.map(field => field.field)).size !== schema.length)
            failDomain('invalid-data', `${path}.settings.schema contains duplicates`);
        const decoded = {
            ...base,
            kind,
            manifest: {
                packageName: readBoundedString(manifest.packageName, `${path}.manifest.packageName`, 256),
                beforeVersion: nullableString(manifest.beforeVersion, `${path}.manifest.beforeVersion`, 256),
                afterVersion: nullableString(manifest.afterVersion, `${path}.manifest.afterVersion`, 256),
                body: exactText(manifest.body, `${path}.manifest.body`) ?? failDomain('invalid-data', `${path}.manifest.body cannot be null`),
                manifestDigest: readSha256Digest(manifest.manifestDigest, `${path}.manifest.manifestDigest`),
                files: stringArray(manifest.files, `${path}.manifest.files`, 4_096),
                fileManifestDigest: readSha256Digest(manifest.fileManifestDigest, `${path}.manifest.fileManifestDigest`),
            },
            dependencies: dependencies(record.dependencies, `${path}.dependencies`),
            managedMaterial: {
                owner: readLiteral(managedMaterial.owner, ['extension-center'], `${path}.managedMaterial.owner`),
                packageName: readBoundedString(managedMaterial.packageName, `${path}.managedMaterial.packageName`, 256),
                beforeVersion: nullableString(managedMaterial.beforeVersion, `${path}.managedMaterial.beforeVersion`, 256),
                afterVersion: nullableString(managedMaterial.afterVersion, `${path}.managedMaterial.afterVersion`, 256),
                targetIntegrity: managedMaterial.targetIntegrity === null
                    ? null
                    : readArtifactIntegrity(managedMaterial.targetIntegrity, `${path}.managedMaterial.targetIntegrity`),
            },
            packageMetadata: {
                bundlePatch: bundlePatch === null ? null : {
                    path: 'cordis.patch.yml',
                    patchDigest: readSha256Digest(bundlePatch.patchDigest, `${path}.packageMetadata.bundlePatch.patchDigest`),
                    patchBody: exactText(bundlePatch.patchBody, `${path}.packageMetadata.bundlePatch.patchBody`)
                        ?? failDomain('invalid-data', `${path}.packageMetadata.bundlePatch.patchBody cannot be null`),
                },
            },
            activation: {
                mutationOwner: readLiteral(activation.mutationOwner, ['official-dsh-cli', 'official-loader'], `${path}.activation.mutationOwner`),
                profileDependency: readLiteral(activation.profileDependency, ['add', 'replace', 'remove', 'restore', 'retain'], `${path}.activation.profileDependency`),
                loaderEntry: readLiteral(activation.loaderEntry, ['create', 'replace', 'remove', 'restore', 'retain'], `${path}.activation.loaderEntry`),
                restartRequired: boolean(activation.restartRequired, `${path}.activation.restartRequired`),
                packageName: readBoundedString(activation.packageName, `${path}.activation.packageName`, 256),
            },
            scripts: {
                before: stringArray(scripts.before, `${path}.scripts.before`),
                after: stringArray(scripts.after, `${path}.scripts.after`),
                forbiddenLifecycle: stringArray(scripts.forbiddenLifecycle, `${path}.scripts.forbiddenLifecycle`, 4),
            },
            settings: {
                adapterVersion: nullableString(settings.adapterVersion, `${path}.settings.adapterVersion`, 256),
                adapterDigest: readNullableSha256Digest(settings.adapterDigest, `${path}.settings.adapterDigest`),
                schemaDigest: readNullableSha256Digest(settings.schemaDigest, `${path}.settings.schemaDigest`),
                ownerRevision: readBoundedString(settings.ownerRevision, `${path}.settings.ownerRevision`, 512),
                migration: readLiteral(settings.migration, ['not-required', 'validated', 'pending'], `${path}.settings.migration`),
                schema: Object.freeze(schema),
                migrationChanges: stringArray(settings.migrationChanges, `${path}.settings.migrationChanges`, 128),
                diffDigest: readSha256Digest(settings.diffDigest, `${path}.settings.diffDigest`),
            },
        };
        const expectedActivation = {
            install: { mutationOwner: 'official-dsh-cli', profileDependency: 'add', loaderEntry: 'create', restartRequired: true },
            configure: { mutationOwner: 'official-loader', profileDependency: 'retain', loaderEntry: 'replace', restartRequired: false },
            update: { mutationOwner: 'official-dsh-cli', profileDependency: 'replace', loaderEntry: 'replace', restartRequired: true },
            uninstall: { mutationOwner: 'official-dsh-cli', profileDependency: 'remove', loaderEntry: 'remove', restartRequired: true },
            restore: { mutationOwner: 'official-dsh-cli', profileDependency: 'restore', loaderEntry: 'restore', restartRequired: true },
        }[decoded.operationKind];
        if (expectedActivation === undefined
            || decoded.activation.mutationOwner !== expectedActivation.mutationOwner
            || decoded.activation.profileDependency !== expectedActivation.profileDependency
            || decoded.activation.loaderEntry !== expectedActivation.loaderEntry
            || decoded.activation.restartRequired !== expectedActivation.restartRequired) {
            failDomain('invalid-data', `${path}.activation does not match operationKind`);
        }
        if (decoded.manifest.packageName !== decoded.managedMaterial.packageName
            || decoded.manifest.packageName !== decoded.activation.packageName
            || decoded.manifest.beforeVersion !== decoded.managedMaterial.beforeVersion
            || decoded.manifest.afterVersion !== decoded.managedMaterial.afterVersion
            || (decoded.managedMaterial.afterVersion === null) !== (decoded.managedMaterial.targetIntegrity === null)) {
            failDomain('invalid-data', `${path} Plugin package identity fields are inconsistent`);
        }
        return immutableJsonClone(decoded);
    }
    if (kind === 'skill') {
        const record = readStrictRecord(value, [...baseFields, 'files', 'body', 'invocation'], path);
        const base = common(record, path);
        const body = readStrictRecord(record.body, ['after', 'afterDigest', 'before', 'beforeDigest'], `${path}.body`);
        const invocation = readStrictRecord(record.invocation, [
            'afterModelInvocable', 'afterUserInvocable', 'beforeModelInvocable', 'beforeUserInvocable',
        ], `${path}.invocation`);
        return immutableJsonClone({
            ...base,
            kind,
            files: fileChanges(record.files, `${path}.files`),
            body: {
                before: exactText(body.before, `${path}.body.before`),
                after: exactText(body.after, `${path}.body.after`),
                beforeDigest: readNullableSha256Digest(body.beforeDigest, `${path}.body.beforeDigest`),
                afterDigest: readNullableSha256Digest(body.afterDigest, `${path}.body.afterDigest`),
            },
            invocation: {
                beforeModelInvocable: nullableBoolean(invocation.beforeModelInvocable, `${path}.invocation.beforeModelInvocable`),
                beforeUserInvocable: nullableBoolean(invocation.beforeUserInvocable, `${path}.invocation.beforeUserInvocable`),
                afterModelInvocable: nullableBoolean(invocation.afterModelInvocable, `${path}.invocation.afterModelInvocable`),
                afterUserInvocable: nullableBoolean(invocation.afterUserInvocable, `${path}.invocation.afterUserInvocable`),
            },
        });
    }
    const record = readStrictRecord(value, [...baseFields, 'descriptor', 'runtime', 'credentials', 'dataEgress'], path);
    const base = common(record, path);
    const runtime = readStrictRecord(record.runtime, ['action', 'digest', 'ownership', 'version'], `${path}.runtime`);
    if (record.credentials !== 'none' || runtime.action !== 'none') {
        failDomain('invalid-data', `${path} cannot carry credential values or external runtime actions`);
    }
    const decodedDescriptor = descriptor(record.descriptor, `${path}.descriptor`);
    const dataEgress = readLiteral(record.dataEgress, ['local-process', 'remote-origin'], `${path}.dataEgress`);
    if ((decodedDescriptor.transport === 'stdio') !== (dataEgress === 'local-process')) {
        failDomain('invalid-data', `${path}.dataEgress does not match transport`);
    }
    return immutableJsonClone({
        ...base,
        kind,
        descriptor: decodedDescriptor,
        runtime: {
            ownership: readLiteral(runtime.ownership, ['host', 'remote'], `${path}.runtime.ownership`),
            version: readBoundedString(runtime.version, `${path}.runtime.version`, 256),
            digest: readNullableSha256Digest(runtime.digest, `${path}.runtime.digest`),
            action: 'none',
        },
        credentials: 'none',
        dataEgress,
    });
}
//# sourceMappingURL=review-codec.js.map
