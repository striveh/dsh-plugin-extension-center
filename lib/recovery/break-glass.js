#!/usr/bin/env node
/**
 * Standalone, read-only Center journal verifier and Host Profile recovery CLI.
 *
 * This module imports only Node built-ins so an installed byte-for-byte pin can
 * run after the Center runtime or its dependency graph is unavailable.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const RECORD_SCHEMA_VERSION = 1;
const CURRENT_FILENAME = 'CURRENT.json';
const EVENT_FILENAME = /^(\d{10})-([0-9a-f]{64})\.json$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 32 * 1024 * 1024;
const MAX_HOST_OUTPUT_BYTES = 4 * 1024 * 1024;
const HOST_TIMEOUT_MS = 30_000;
const PHASES = [
    'authorized',
    'staging',
    'applying',
    'verifying',
    'rolling-back',
    'committed',
    'rolled-back',
    'failed',
    'recovery-required',
];
const NEXT_PHASES = {
    authorized: ['staging', 'failed'],
    staging: ['applying', 'rolling-back', 'failed'],
    applying: ['verifying', 'rolling-back', 'failed'],
    verifying: ['committed', 'rolling-back', 'failed'],
    'rolling-back': ['rolled-back', 'recovery-required'],
    committed: [],
    'rolled-back': [],
    failed: [],
    'recovery-required': ['rolling-back'],
};
function failure(message) {
    throw new Error(message);
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function strictRecord(value, fields, label) {
    if (!isRecord(value))
        failure(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        failure(`${label} fields are invalid`);
    }
    return value;
}
function boundedString(value, label, maximum = 1_024) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
        failure(`${label} must be a bounded non-empty string`);
    }
    return value;
}
function safeInteger(value, label, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) {
        failure(`${label} must be a safe integer greater than or equal to ${String(minimum)}`);
    }
    return value;
}
function digest(value, label) {
    if (typeof value !== 'string' || !SHA256.test(value))
        failure(`${label} must be a canonical SHA-256 digest`);
    return value;
}
function nullableDigest(value, label) {
    return value === null ? null : digest(value, label);
}
function literal(value, values, label) {
    if (typeof value !== 'string' || !values.includes(value)) {
        failure(`${label} has an unsupported value`);
    }
    return value;
}
function canonicalJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            failure('canonical JSON contains a non-finite number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (!isRecord(value))
        failure(`canonical JSON contains unsupported ${typeof value}`);
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function canonicalDigest(value) {
    return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
function fileDigest(value) {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
async function readRegularNoFollow(path, maximumBytes, label) {
    if (constants.O_NOFOLLOW === undefined)
        failure(`${label} cannot be opened without following links on this platform`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!opened.isFile())
            failure(`${label} must be a regular file`);
        if (opened.size <= 0 || opened.size > maximumBytes)
            failure(`${label} has an invalid byte length`);
        const bytes = await handle.readFile();
        if (bytes.length !== opened.size)
            failure(`${label} changed while it was read`);
        const current = await lstat(path);
        if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
            failure(`${label} path changed while it was read`);
        }
        return bytes;
    }
    finally {
        await handle.close();
    }
}
function parseCanonicalRecord(bytes, label) {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes) || !text.endsWith('\n')
        || text.slice(0, -1).includes('\n') || text.includes('\r')) {
        failure(`${label} is not one canonical UTF-8 JSON record`);
    }
    let value;
    try {
        value = JSON.parse(text.slice(0, -1));
    }
    catch {
        failure(`${label} is not valid JSON`);
    }
    if (`${canonicalJson(value)}\n` !== text)
        failure(`${label} is not canonical JSON`);
    return value;
}
function decodeProfileName(value, label) {
    const profile = boundedString(value, label, 255);
    if (profile.includes('/') || profile.includes('\\') || profile === '.' || profile === '..'
        || profile === 'node_modules' || profile === '.dsh-profile-transactions') {
        failure(`${label} must be one non-reserved path segment`);
    }
    return profile;
}
function decodeRuntimeBinding(value, label) {
    if (value === null)
        return;
    const record = strictRecord(value, ['descriptorDigest', 'runtimeRef', 'version'], label);
    boundedString(record.runtimeRef, `${label}.runtimeRef`);
    boundedString(record.version, `${label}.version`);
    digest(record.descriptorDigest, `${label}.descriptorDigest`);
}
function decodePlanEvidence(value, label) {
    const record = strictRecord(value, [
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
        'recoveryExecutable',
    ], label);
    literal(record.origin, ['store', 'task'], `${label}.origin`);
    boundedString(record.candidateRef, `${label}.candidateRef`, 2_048);
    const extensionKind = literal(record.extensionKind, ['plugin', 'mcp', 'skill'], `${label}.extensionKind`);
    boundedString(record.extensionId, `${label}.extensionId`);
    boundedString(record.artifactRevision, `${label}.artifactRevision`);
    if (typeof record.artifactIntegrity !== 'string'
        || !/^sha(?:256:[0-9a-f]{64}|512:(?:[0-9a-f]{128}|[A-Za-z0-9+/]{86}==))$/.test(record.artifactIntegrity)) {
        failure(`${label}.artifactIntegrity is invalid`);
    }
    boundedString(record.artifactUrl, `${label}.artifactUrl`, 2_048);
    safeInteger(record.artifactSizeBytes, `${label}.artifactSizeBytes`);
    literal(record.desiredState, ['enabled', 'disabled', 'removed'], `${label}.desiredState`);
    const ownerKey = boundedString(record.ownerKey, `${label}.ownerKey`);
    boundedString(record.scopeKey, `${label}.scopeKey`);
    const profileId = decodeProfileName(record.profileId, `${label}.profileId`);
    boundedString(record.idempotencyKey, `${label}.idempotencyKey`);
    for (const field of ['authorityDigest', 'configurationDigest', 'retentionDigest', 'mutationDigest', 'verificationDigest']) {
        digest(record[field], `${label}.${field}`);
    }
    if (typeof record.restartRequired !== 'boolean')
        failure(`${label}.restartRequired must be boolean`);
    const recoveryTarget = decodePluginReviewRecovery(record.reviewEvidence, `${label}.reviewEvidence`);
    const fences = strictRecord(record.fences, [
        'catalogRevision',
        'inventoryRevision',
        'targetRevision',
        'ownerRevision',
        'scopeRevision',
        'profileRevision',
    ], `${label}.fences`);
    safeInteger(fences.catalogRevision, `${label}.fences.catalogRevision`, 1);
    digest(fences.inventoryRevision, `${label}.fences.inventoryRevision`);
    for (const field of ['targetRevision', 'ownerRevision', 'scopeRevision', 'profileRevision']) {
        boundedString(fences[field], `${label}.fences.${field}`);
    }
    return Object.freeze({
        extensionKind,
        profileId,
        ownerKey,
        recoveryExecutable: decodeRecoveryExecutable(record.recoveryExecutable),
        recoveryTarget,
    });
}
function stringArray(value, label) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
        failure(`${label} must be a string array`);
}
function decodePluginReviewRecovery(value, label) {
    const record = strictRecord(value, [
        'schemaVersion', 'kind', 'operationKind', 'checks', 'removed', 'retained', 'credentialChoice',
        'rollbackPoint', 'rollbackLimits', 'notProven', 'manifest', 'dependencies', 'lockfile', 'bundles',
        'scripts', 'settings',
    ], label);
    if (record.schemaVersion !== 1 || record.kind !== 'plugin')
        failure(`${label} is not Plugin review evidence`);
    literal(record.operationKind, ['install', 'configure', 'update', 'enable', 'disable', 'uninstall', 'restore', 'purge'], `${label}.operationKind`);
    literal(record.credentialChoice, ['not-applicable', 'retain-local-record', 'delete-local-record'], `${label}.credentialChoice`);
    for (const field of ['checks', 'removed', 'retained', 'dependencies', 'bundles']) {
        if (!Array.isArray(record[field]))
            failure(`${label}.${field} must be an array`);
    }
    stringArray(record.rollbackLimits, `${label}.rollbackLimits`);
    stringArray(record.notProven, `${label}.notProven`);
    const manifest = strictRecord(record.manifest, [
        'packageName', 'beforeVersion', 'afterVersion', 'body', 'manifestDigest', 'files', 'fileManifestDigest',
    ], `${label}.manifest`);
    boundedString(manifest.packageName, `${label}.manifest.packageName`);
    if (manifest.beforeVersion !== null)
        boundedString(manifest.beforeVersion, `${label}.manifest.beforeVersion`);
    if (manifest.afterVersion !== null)
        boundedString(manifest.afterVersion, `${label}.manifest.afterVersion`);
    boundedString(manifest.body, `${label}.manifest.body`, 1024 * 1024);
    digest(manifest.manifestDigest, `${label}.manifest.manifestDigest`);
    digest(manifest.fileManifestDigest, `${label}.manifest.fileManifestDigest`);
    stringArray(manifest.files, `${label}.manifest.files`);
    const lockfile = strictRecord(record.lockfile, [
        'path', 'beforeDigest', 'packageName', 'beforeVersion', 'afterVersion', 'targetIntegrity',
    ], `${label}.lockfile`);
    if (lockfile.path !== 'pnpm-lock.yaml')
        failure(`${label}.lockfile.path is unsupported`);
    nullableDigest(lockfile.beforeDigest, `${label}.lockfile.beforeDigest`);
    boundedString(lockfile.packageName, `${label}.lockfile.packageName`);
    const scripts = strictRecord(record.scripts, ['before', 'after', 'forbiddenLifecycle'], `${label}.scripts`);
    stringArray(scripts.before, `${label}.scripts.before`);
    stringArray(scripts.after, `${label}.scripts.after`);
    stringArray(scripts.forbiddenLifecycle, `${label}.scripts.forbiddenLifecycle`);
    strictRecord(record.settings, [
        'adapterVersion', 'adapterDigest', 'schemaDigest', 'ownerRevision', 'migration', 'schema',
        'migrationChanges', 'diffDigest',
    ], `${label}.settings`);
    for (const [index, item] of record.checks.entries()) {
        strictRecord(item, ['code', 'phase'], `${label}.checks[${String(index)}]`);
    }
    for (const field of ['removed', 'retained']) {
        for (const [index, item] of record[field].entries()) {
            strictRecord(item, ['kind', 'id', 'digest'], `${label}.${field}[${String(index)}]`);
        }
    }
    for (const [index, item] of record.dependencies.entries()) {
        strictRecord(item, ['kind', 'id', 'beforeVersion', 'afterVersion', 'required'], `${label}.dependencies[${String(index)}]`);
    }
    for (const [index, item] of record.bundles.entries()) {
        strictRecord(item, ['id', 'action', 'patchDigest', 'patchBody'], `${label}.bundles[${String(index)}]`);
    }
    const point = strictRecord(record.rollbackPoint, ['kind', 'id', 'digest'], `${label}.rollbackPoint`);
    if (point.kind !== 'profile-generation')
        failure(`${label}.rollbackPoint is not a recoverable Profile generation`);
    const generation = decodeGeneration(point.id, `${label}.rollbackPoint.id`);
    if (generation === null)
        failure(`${label}.rollbackPoint.id cannot be null`);
    return Object.freeze({ generation, treeDigest: digest(point.digest, `${label}.rollbackPoint.digest`) });
}
function decodeRecoveryExecutable(value) {
    const record = strictRecord(value, [
        'schemaVersion',
        'executablePath',
        'executableSha256',
        'hostCliPath',
        'hostCliSha256',
        'hostHome',
        'packageVersion',
        'platform',
        'arch',
    ], 'journal recoveryExecutable');
    if (record.schemaVersion !== 2)
        failure('journal recoveryExecutable schemaVersion is unsupported');
    const executablePath = boundedString(record.executablePath, 'journal recoveryExecutable.executablePath', 4_096);
    const hostCliPath = boundedString(record.hostCliPath, 'journal opening recoveryExecutable.hostCliPath', 4_096);
    const hostHome = boundedString(record.hostHome, 'journal opening recoveryExecutable.hostHome', 4_096);
    if (!isAbsolute(executablePath) || !isAbsolute(hostCliPath) || !isAbsolute(hostHome)) {
        failure('recovery executable paths and Host home must be absolute');
    }
    return Object.freeze({
        schemaVersion: 2,
        executablePath,
        executableSha256: digest(record.executableSha256, 'journal recoveryExecutable.executableSha256'),
        hostCliPath,
        hostCliSha256: digest(record.hostCliSha256, 'journal opening recoveryExecutable.hostCliSha256'),
        hostHome,
        packageVersion: boundedString(record.packageVersion, 'journal recoveryExecutable.packageVersion', 128),
        platform: literal(record.platform, ['darwin', 'linux', 'win32'], 'journal recoveryExecutable.platform'),
        arch: boundedString(record.arch, 'journal recoveryExecutable.arch', 64),
    });
}
function decodeOpening(value) {
    const record = strictRecord(value, [
        'type',
        'planId',
        'planHash',
        'operationKind',
        'managedObject',
        'externalRuntimeAction',
        'runtimeBinding',
        'planEvidence',
        'beforeDigest',
    ], 'journal opening entry');
    if (record.type !== 'operation-opened')
        failure('journal must begin with operation-opened');
    boundedString(record.planId, 'journal opening planId');
    digest(record.planHash, 'journal opening planHash');
    literal(record.operationKind, ['install', 'configure', 'update', 'enable', 'disable', 'uninstall', 'restore', 'purge'], 'journal opening operationKind');
    if (record.managedObject !== 'artifact')
        failure('break-glass recovery supports only Plugin artifact operations');
    literal(record.externalRuntimeAction, ['download', 'none'], 'journal opening externalRuntimeAction');
    decodeRuntimeBinding(record.runtimeBinding, 'journal opening runtimeBinding');
    if (record.runtimeBinding !== null)
        failure('Plugin artifact recovery cannot carry a runtime binding');
    digest(record.beforeDigest, 'journal opening beforeDigest');
    const evidence = decodePlanEvidence(record.planEvidence, 'journal opening planEvidence');
    if (evidence.extensionKind !== 'plugin' || evidence.ownerKey !== 'profileTransactions') {
        failure('break-glass recovery supports only Profile-owned Plugin operations');
    }
    return Object.freeze({
        profileId: evidence.profileId,
        extensionKind: 'plugin',
        recoveryExecutable: evidence.recoveryExecutable,
        recoveryTarget: evidence.recoveryTarget,
    });
}
function decodeReceipt(value, context) {
    const receipt = strictRecord(value, ['body', 'digest'], 'journal receipt');
    const body = strictRecord(receipt.body, [
        'schemaVersion',
        'operationId',
        'planId',
        'planHash',
        'operationKind',
        'managedObject',
        'externalRuntimeAction',
        'runtimeBinding',
        'planEvidence',
        'targetKey',
        'outcome',
        'beforeDigest',
        'afterDigest',
        'mutationDigests',
        'verificationDigests',
        'evidence',
        'journalEventCount',
        'journalHeadDigest',
        'issuedAtMs',
    ], 'journal receipt body');
    if (body.schemaVersion !== RECORD_SCHEMA_VERSION)
        failure('journal receipt schemaVersion is unsupported');
    if (body.operationId !== context.operationId || body.targetKey !== context.targetKey) {
        failure('journal receipt identity does not match its event');
    }
    if (body.outcome !== context.phase || !['committed', 'rolled-back', 'failed'].includes(context.phase)) {
        failure('journal receipt outcome does not match the terminal phase');
    }
    if (body.journalEventCount !== context.sequence - 1 || body.journalHeadDigest !== context.previousDigest) {
        failure('journal receipt does not bind the preceding journal head');
    }
    boundedString(body.planId, 'journal receipt body.planId');
    digest(body.planHash, 'journal receipt body.planHash');
    literal(body.operationKind, ['install', 'configure', 'update', 'enable', 'disable', 'uninstall', 'restore', 'purge'], 'journal receipt body.operationKind');
    literal(body.managedObject, ['artifact', 'connection'], 'journal receipt body.managedObject');
    literal(body.externalRuntimeAction, ['download', 'none'], 'journal receipt body.externalRuntimeAction');
    decodeRuntimeBinding(body.runtimeBinding, 'journal receipt body.runtimeBinding');
    decodePlanEvidence(body.planEvidence, 'journal receipt body.planEvidence');
    digest(body.beforeDigest, 'journal receipt body.beforeDigest');
    nullableDigest(body.afterDigest, 'journal receipt body.afterDigest');
    for (const field of ['mutationDigests', 'verificationDigests']) {
        if (!Array.isArray(body[field]))
            failure(`journal receipt body.${field} must be an array`);
        body[field].forEach((item, index) => digest(item, `journal receipt body.${field}[${String(index)}]`));
    }
    strictRecord(body.evidence, ['checksActuallyRun', 'mutation', 'verification', 'rollback', 'restart', 'recovery', 'notProven'], 'journal receipt body.evidence');
    safeInteger(body.journalEventCount, 'journal receipt body.journalEventCount', 1);
    digest(body.journalHeadDigest, 'journal receipt body.journalHeadDigest');
    safeInteger(body.issuedAtMs, 'journal receipt body.issuedAtMs');
    const receiptDigest = digest(receipt.digest, 'journal receipt digest');
    if (canonicalDigest(body) !== receiptDigest)
        failure('journal receipt digest does not match its body');
}
function decodeEntry(value, context) {
    if (!isRecord(value) || typeof value.type !== 'string')
        failure('journal event entry is invalid');
    if (context.receiptSeen)
        failure('journal receipt must be the final event');
    if (context.phase === null) {
        if (context.sequence !== 1)
            failure('journal opening sequence is invalid');
        return Object.freeze({ phase: 'authorized', opening: decodeOpening(value), receiptSeen: false });
    }
    if (value.type === 'phase-transition') {
        const record = strictRecord(value, ['type', 'from', 'to', 'evidenceDigest', 'reason'], 'journal phase transition');
        const from = literal(record.from, PHASES, 'journal phase transition from');
        const to = literal(record.to, PHASES, 'journal phase transition to');
        if (from !== context.phase || !NEXT_PHASES[from].includes(to))
            failure(`invalid journal transition from ${from} to ${to}`);
        const evidenceDigest = nullableDigest(record.evidenceDigest, 'journal phase transition evidenceDigest');
        if (!['committed', 'rolled-back', 'failed'].includes(to) && evidenceDigest !== null) {
            failure('non-terminal journal transitions cannot publish final evidence');
        }
        if (record.reason !== null
            && (typeof record.reason !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(record.reason))) {
            failure('journal phase transition reason is invalid');
        }
        if ((to === 'failed' || to === 'recovery-required') && record.reason === null) {
            failure(`${to} requires a stable reason`);
        }
        return Object.freeze({ phase: to, opening: null, receiptSeen: false });
    }
    if (value.type === 'mutation-observed') {
        const record = strictRecord(value, ['type', 'mutationDigest'], 'journal mutation observation');
        if (!['applying', 'verifying', 'rolling-back'].includes(context.phase)) {
            failure(`mutation observation is invalid during ${context.phase}`);
        }
        digest(record.mutationDigest, 'journal mutation observation digest');
        return Object.freeze({ phase: context.phase, opening: null, receiptSeen: false });
    }
    if (value.type === 'verification-observed') {
        const record = strictRecord(value, ['type', 'verificationDigest'], 'journal verification observation');
        if (!['verifying', 'rolling-back'].includes(context.phase)) {
            failure(`verification observation is invalid during ${context.phase}`);
        }
        digest(record.verificationDigest, 'journal verification observation digest');
        return Object.freeze({ phase: context.phase, opening: null, receiptSeen: false });
    }
    if (value.type === 'receipt-issued') {
        const record = strictRecord(value, ['type', 'receipt'], 'journal receipt entry');
        decodeReceipt(record.receipt, {
            operationId: context.operationId,
            targetKey: context.targetKey,
            phase: context.phase,
            sequence: context.sequence,
            previousDigest: context.previousDigest,
        });
        return Object.freeze({ phase: context.phase, opening: null, receiptSeen: true });
    }
    failure(`unsupported journal entry type ${JSON.stringify(value.type)}`);
}
async function verifyJournal(centerRoot, operationId) {
    boundedString(operationId, 'operationId', 512);
    const root = await realpath(resolve(centerRoot));
    if (!(await lstat(root)).isDirectory())
        failure('Center root must be a directory');
    const directoryName = createHash('sha256').update(operationId).digest('hex');
    const directory = join(root, 'operations', directoryName);
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
        failure('operation journal directory is not a canonical real directory');
    }
    const entries = await readdir(directory, { withFileTypes: true });
    const eventEntries = entries.filter(entry => EVENT_FILENAME.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name));
    const unexpected = entries.filter(entry => entry.name !== CURRENT_FILENAME && !EVENT_FILENAME.test(entry.name));
    if (unexpected.length > 0 || eventEntries.length === 0
        || entries.some(entry => (entry.name === CURRENT_FILENAME || EVENT_FILENAME.test(entry.name)) && !entry.isFile())) {
        failure('operation journal directory contains invalid durable records');
    }
    const pointer = strictRecord(parseCanonicalRecord(await readRegularNoFollow(join(directory, CURRENT_FILENAME), MAX_POINTER_BYTES, 'operation CURRENT'), 'operation CURRENT'), ['schemaVersion', 'operationId', 'targetKey', 'eventCount', 'headDigest'], 'operation CURRENT');
    if (pointer.schemaVersion !== RECORD_SCHEMA_VERSION || pointer.operationId !== operationId) {
        failure('operation CURRENT identity is invalid');
    }
    const targetKey = boundedString(pointer.targetKey, 'operation CURRENT targetKey');
    const eventCount = safeInteger(pointer.eventCount, 'operation CURRENT eventCount', 1);
    const headDigest = digest(pointer.headDigest, 'operation CURRENT headDigest');
    if (eventCount !== eventEntries.length)
        failure('operation CURRENT does not anchor every durable event');
    let priorDigest = null;
    let priorAtMs = 0;
    let phase = null;
    let opening = null;
    let receiptSeen = false;
    for (let index = 0; index < eventEntries.length; index += 1) {
        const entry = eventEntries[index];
        const match = EVENT_FILENAME.exec(entry.name);
        const sequence = index + 1;
        if (Number(match[1]) !== sequence)
            failure('journal event filenames are not contiguous');
        const event = strictRecord(parseCanonicalRecord(await readRegularNoFollow(join(directory, entry.name), MAX_EVENT_BYTES, `journal event ${String(sequence)}`), `journal event ${String(sequence)}`), ['schemaVersion', 'operationId', 'targetKey', 'sequence', 'previousDigest', 'atMs', 'entry', 'digest'], `journal event ${String(sequence)}`);
        if (event.schemaVersion !== RECORD_SCHEMA_VERSION || event.operationId !== operationId
            || event.targetKey !== targetKey || event.sequence !== sequence) {
            failure(`journal event ${String(sequence)} identity is invalid`);
        }
        if (event.previousDigest !== priorDigest)
            failure(`journal event ${String(sequence)} chain is invalid`);
        const atMs = safeInteger(event.atMs, `journal event ${String(sequence)} atMs`);
        if (index > 0 && atMs < priorAtMs)
            failure(`journal time moved backwards at event ${String(sequence)}`);
        const eventDigest = digest(event.digest, `journal event ${String(sequence)} digest`);
        if (eventDigest !== `sha256:${match[2]}`)
            failure(`journal event ${String(sequence)} filename does not match its digest`);
        const unsigned = {
            schemaVersion: event.schemaVersion,
            operationId: event.operationId,
            targetKey: event.targetKey,
            sequence: event.sequence,
            previousDigest: event.previousDigest,
            atMs: event.atMs,
            entry: event.entry,
        };
        if (canonicalDigest(unsigned) !== eventDigest)
            failure(`journal event ${String(sequence)} digest does not match its content`);
        const decoded = decodeEntry(event.entry, {
            operationId,
            targetKey,
            phase,
            sequence,
            previousDigest: priorDigest,
            receiptSeen,
        });
        phase = decoded.phase;
        opening ??= decoded.opening;
        receiptSeen = decoded.receiptSeen;
        priorDigest = eventDigest;
        priorAtMs = atMs;
    }
    if (priorDigest !== headDigest)
        failure('operation CURRENT headDigest does not match the journal head');
    if (opening === null || phase === null)
        failure('operation journal has no verified opening');
    return Object.freeze({ operationId, targetKey, phase, opening });
}
async function verifyExecutable(path, expectedDigest, label) {
    const pinnedRealpath = await realpath(path);
    if (pinnedRealpath !== path)
        failure(`${label} path is not its canonical realpath`);
    const bytes = await readRegularNoFollow(path, MAX_EXECUTABLE_BYTES, label);
    if (fileDigest(bytes) !== expectedDigest)
        failure(`${label} hash does not match its pin`);
    return pinnedRealpath;
}
async function verifyHostHome(path) {
    const pinnedRealpath = await realpath(path);
    const state = await lstat(path);
    if (pinnedRealpath !== path || !state.isDirectory() || state.isSymbolicLink()) {
        failure('Host home path is not its canonical real directory');
    }
    return pinnedRealpath;
}
function hostEnvironment(hostHome) {
    const allowed = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR'];
    const output = { DSH_HOME: hostHome };
    for (const name of allowed) {
        const value = process.env[name];
        if (value !== undefined)
            output[name] = value;
    }
    return output;
}
function recoveryMutationId(operationId) {
    return `extension-center-recovery-${createHash('sha256').update(operationId).digest('hex')}`;
}
function runHost(hostCliPath, hostHome, profileId, operation, mutationId) {
    const args = [
        hostCliPath,
        'plugin', '--profile', profileId, operation,
        ...operation === 'restore' || operation === 'restore-receipt'
            ? ['--mutation-id', boundedString(mutationId, 'Host restore mutation id', 128)]
            : [],
    ];
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: '/',
            env: hostEnvironment(hostHome),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let settled = false;
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            if (!settled) {
                settled = true;
                reject(new Error(`Host CLI ${operation} timed out`));
            }
        }, HOST_TIMEOUT_MS);
        const capture = (chunks, chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_HOST_OUTPUT_BYTES) {
                child.kill('SIGKILL');
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error(`Host CLI ${operation} exceeded the output limit`));
                }
                return;
            }
            chunks.push(chunk);
        };
        child.stdout.on('data', (chunk) => capture(stdout, chunk));
        child.stderr.on('data', (chunk) => capture(stderr, chunk));
        child.once('error', (error) => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (settled)
                return;
            settled = true;
            if (signal !== null || code === null) {
                reject(new Error(`Host CLI ${operation} ended without an exit code`));
                return;
            }
            resolvePromise({
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
                exitCode: code,
            });
        });
    });
}
function decodeGeneration(value, label) {
    if (value === null)
        return null;
    if (typeof value !== 'string' || !GENERATION.test(value))
        failure(`${label} is not an exact Profile generation id`);
    return value;
}
function decodeSummary(value, label) {
    const record = strictRecord(value, ['generation', 'treeDigest', 'mutationId', 'mutation'], label);
    const generation = decodeGeneration(record.generation, `${label}.generation`);
    if (generation === null)
        failure(`${label}.generation cannot be null`);
    const treeDigest = digest(record.treeDigest, `${label}.treeDigest`);
    if (record.mutationId !== null)
        boundedString(record.mutationId, `${label}.mutationId`, 128);
    if (record.mutation !== null && !isRecord(record.mutation))
        failure(`${label}.mutation must be an object or null`);
    return Object.freeze({ generation, treeDigest });
}
function parseHostJson(text, label) {
    if (Buffer.byteLength(text) > MAX_HOST_OUTPUT_BYTES || text.includes('\0'))
        failure(`${label} output is invalid`);
    try {
        const value = JSON.parse(text);
        return value;
    }
    catch {
        failure(`${label} did not return one JSON value`);
    }
}
function decodeSnapshot(value, profileId, label) {
    const snapshotRecord = strictRecord(value, [
        'profile',
        'revision',
        'treeDigest',
        'effectivePath',
        'activeGeneration',
        'lastGoodGeneration',
        'rollbackGeneration',
        'bootStatus',
    ], label);
    const snapshot = Object.freeze({
        profile: decodeProfileName(snapshotRecord.profile, `${label}.profile`),
        revision: safeInteger(snapshotRecord.revision, `${label}.revision`),
        treeDigest: digest(snapshotRecord.treeDigest, `${label}.treeDigest`),
        effectivePath: boundedString(snapshotRecord.effectivePath, `${label}.effectivePath`, 4_096),
        activeGeneration: decodeGeneration(snapshotRecord.activeGeneration, `${label}.activeGeneration`),
        lastGoodGeneration: decodeGeneration(snapshotRecord.lastGoodGeneration, `${label}.lastGoodGeneration`),
        rollbackGeneration: decodeGeneration(snapshotRecord.rollbackGeneration, `${label}.rollbackGeneration`),
        bootStatus: literal(snapshotRecord.bootStatus, ['live', 'pending-restart', 'verified'], `${label}.bootStatus`),
    });
    if (snapshot.profile !== profileId || !isAbsolute(snapshot.effectivePath)) {
        failure(`${label} does not describe the journal Profile`);
    }
    return snapshot;
}
function decodeInventory(text, profileId) {
    const root = strictRecord(parseHostJson(text, 'Host CLI list'), ['snapshot', 'active', 'staged', 'recoverable'], 'Host Profile inventory');
    const snapshot = decodeSnapshot(root.snapshot, profileId, 'Host Profile snapshot');
    const active = root.active === null ? null : decodeSummary(root.active, 'Host Profile active generation');
    if ((snapshot.activeGeneration === null) !== (active === null)
        || active !== null && active.generation !== snapshot.activeGeneration
        || active !== null && active.treeDigest !== snapshot.treeDigest) {
        failure('Host Profile active summary does not match its snapshot');
    }
    if (!Array.isArray(root.staged) || !Array.isArray(root.recoverable)) {
        failure('Host Profile generation inventories must be arrays');
    }
    const staged = Object.freeze(root.staged.map((value, index) => decodeSummary(value, `Host Profile staged[${String(index)}]`)));
    const recoverable = Object.freeze(root.recoverable.map((value, index) => decodeSummary(value, `Host Profile recoverable[${String(index)}]`)));
    const allGenerations = [active, ...staged, ...recoverable].filter((value) => value !== null);
    if (new Set(allGenerations.map(value => value.generation)).size !== allGenerations.length) {
        failure('Host Profile inventory repeats a generation');
    }
    return Object.freeze({ snapshot, active, staged, recoverable });
}
function decodeRestoreReceipt(text, profileId, mutationId) {
    const root = strictRecord(parseHostJson(text, 'Host CLI restore-receipt'), ['profile', 'mutationId', 'status', 'receipt'], 'Host Profile restore receipt result');
    if (decodeProfileName(root.profile, 'Host Profile restore receipt result.profile') !== profileId
        || boundedString(root.mutationId, 'Host Profile restore receipt result.mutationId', 128) !== mutationId) {
        failure('Host Profile restore receipt result does not bind the requested mutation');
    }
    const status = literal(root.status, ['not-found', 'committed'], 'Host Profile restore receipt result.status');
    if (status === 'not-found') {
        if (root.receipt !== null)
            failure('Host Profile restore receipt result carries a receipt for not-found');
        return null;
    }
    const record = strictRecord(root.receipt, ['mutationId', 'status', 'operation', 'before', 'after', 'restartRequired'], 'Host Profile restore receipt');
    if (boundedString(record.mutationId, 'Host Profile restore receipt.mutationId', 128) !== mutationId
        || literal(record.status, ['committed'], 'Host Profile restore receipt.status') !== 'committed'
        || literal(record.operation, ['restore'], 'Host Profile restore receipt.operation') !== 'restore'
        || record.restartRequired !== true) {
        failure('Host Profile restore receipt does not bind one committed restore');
    }
    return Object.freeze({
        mutationId,
        status: 'committed',
        operation: 'restore',
        before: decodeSnapshot(record.before, profileId, 'Host Profile restore receipt.before'),
        after: decodeSnapshot(record.after, profileId, 'Host Profile restore receipt.after'),
        restartRequired: true,
    });
}
function recoveryTarget(inventory, pinned) {
    const target = inventory.snapshot.activeGeneration !== inventory.snapshot.lastGoodGeneration
        ? inventory.snapshot.lastGoodGeneration
        : inventory.snapshot.rollbackGeneration;
    if (target === null || target !== pinned.generation)
        failure('Host Profile current recovery selector drifted from the journal pin');
    const matches = inventory.recoverable.filter(item => item.generation === target);
    if (matches.length !== 1 || matches[0].treeDigest !== pinned.treeDigest) {
        failure('Host Profile inventory does not expose the pinned recovery generation and tree digest');
    }
    return matches[0];
}
function verifyRestoreTransition(before, after, target) {
    if (after.revision !== before.revision + 1
        || after.activeGeneration !== target.generation
        || after.treeDigest !== target.treeDigest
        || after.lastGoodGeneration !== before.lastGoodGeneration
        || after.rollbackGeneration !== before.rollbackGeneration) {
        failure('Host Profile inventory does not prove the exact restored generation');
    }
    const expectedStatus = target.generation === after.lastGoodGeneration ? 'verified' : 'pending-restart';
    if (after.bootStatus !== expectedStatus)
        failure('Host Profile restored generation has an invalid boot status');
}
function verifyRestored(before, after, target) {
    verifyRestoreTransition(before.snapshot, after.snapshot, target);
    if (after.active?.generation !== target.generation || after.active.treeDigest !== target.treeDigest) {
        failure('Host Profile inventory does not prove the exact restored generation');
    }
}
function verifyCommittedRestore(receipt, current, pinned) {
    const target = receipt.before.activeGeneration !== receipt.before.lastGoodGeneration
        ? receipt.before.lastGoodGeneration
        : receipt.before.rollbackGeneration;
    if (target !== pinned.generation)
        failure('Host Profile restore receipt does not bind the journal recovery generation');
    verifyRestoreTransition(receipt.before, receipt.after, pinned);
    const exactReceiptState = canonicalJson(current.snapshot) === canonicalJson(receipt.after);
    const acknowledgedReceiptState = receipt.after.bootStatus === 'pending-restart'
        && current.snapshot.profile === receipt.after.profile
        && current.snapshot.revision === receipt.after.revision + 1
        && current.snapshot.treeDigest === receipt.after.treeDigest
        && current.snapshot.effectivePath === receipt.after.effectivePath
        && current.snapshot.activeGeneration === receipt.after.activeGeneration
        && current.snapshot.lastGoodGeneration === receipt.after.activeGeneration
        && current.snapshot.rollbackGeneration === receipt.after.lastGoodGeneration
        && current.snapshot.bootStatus === 'verified';
    if ((!exactReceiptState && !acknowledgedReceiptState)
        || current.active?.generation !== pinned.generation
        || current.active.treeDigest !== pinned.treeDigest) {
        failure('Host Profile current inventory diverged from the committed restore receipt');
    }
}
/**
 * Verify one recovery-required Plugin journal and publish its Host-owned recovery target.
 * @param centerRoot Exact Center durable root.
 * @param operationId Exact durable operation identity.
 * @param invokedPath Executed recovery CLI path used for the self pin.
 */
export async function recoverProfile(centerRoot, operationId, invokedPath) {
    const journal = await verifyJournal(centerRoot, operationId);
    if (journal.phase !== 'recovery-required' || journal.opening.extensionKind !== 'plugin') {
        failure('operation is not a recovery-required Plugin operation');
    }
    const pins = journal.opening.recoveryExecutable;
    if (pins.platform !== process.platform || pins.arch !== process.arch) {
        failure('recovery executable platform does not match this process');
    }
    const pinnedSelf = await verifyExecutable(pins.executablePath, pins.executableSha256, 'recovery executable');
    const modulePath = await realpath(fileURLToPath(import.meta.url));
    const invokedRealpath = await realpath(resolve(invokedPath));
    if (pinnedSelf !== modulePath || invokedRealpath !== modulePath) {
        failure('running recovery executable does not match the journal pin');
    }
    const hostCli = await verifyExecutable(pins.hostCliPath, pins.hostCliSha256, 'Host CLI');
    const hostHome = await verifyHostHome(pins.hostHome);
    const mutationId = recoveryMutationId(journal.operationId);
    const receiptResult = await runHost(hostCli, hostHome, journal.opening.profileId, 'restore-receipt', mutationId);
    if (receiptResult.exitCode !== 0 || receiptResult.stderr !== '') {
        failure(`Host CLI restore-receipt probe failed with exit code ${String(receiptResult.exitCode)}`);
    }
    const receipt = decodeRestoreReceipt(receiptResult.stdout, journal.opening.profileId, mutationId);
    if (receipt !== null) {
        const currentResult = await runHost(hostCli, hostHome, journal.opening.profileId, 'list');
        if (currentResult.exitCode !== 0 || currentResult.stderr !== '') {
            failure(`Host CLI committed-restore list failed with exit code ${String(currentResult.exitCode)}`);
        }
        const current = decodeInventory(currentResult.stdout, journal.opening.profileId);
        verifyCommittedRestore(receipt, current, journal.opening.recoveryTarget);
        await verifyExecutable(pins.hostCliPath, pins.hostCliSha256, 'Host CLI after recovery');
        return;
    }
    const beforeResult = await runHost(hostCli, hostHome, journal.opening.profileId, 'list');
    if (beforeResult.exitCode !== 0 || beforeResult.stderr !== '') {
        failure(`Host CLI list probe failed with exit code ${String(beforeResult.exitCode)}`);
    }
    const before = decodeInventory(beforeResult.stdout, journal.opening.profileId);
    const target = recoveryTarget(before, journal.opening.recoveryTarget);
    const restoreResult = await runHost(hostCli, hostHome, journal.opening.profileId, 'restore', mutationId);
    if (restoreResult.exitCode !== 0 || restoreResult.stderr !== ''
        || restoreResult.stdout !== `dsh: restored generation ${target.generation}; restart required\n`) {
        failure(`Host CLI restore did not publish generation ${target.generation}`);
    }
    const afterResult = await runHost(hostCli, hostHome, journal.opening.profileId, 'list');
    if (afterResult.exitCode !== 0 || afterResult.stderr !== '') {
        failure(`Host CLI post-restore list failed with exit code ${String(afterResult.exitCode)}`);
    }
    const after = decodeInventory(afterResult.stdout, journal.opening.profileId);
    verifyRestored(before, after, target);
    await verifyExecutable(pins.hostCliPath, pins.hostCliSha256, 'Host CLI after recovery');
}
async function main() {
    const [centerRoot, operationId, ...extra] = process.argv.slice(2);
    if (centerRoot === undefined || operationId === undefined || extra.length > 0 || process.argv[1] === undefined) {
        process.stderr.write('usage: node <pinned-recovery-cli> <center-root> <operation-id>\n');
        return 2;
    }
    try {
        await recoverProfile(centerRoot, operationId, process.argv[1]);
        process.stdout.write('profile restored; Center journal reconciliation pending\n');
        return 0;
    }
    catch (error) {
        process.stderr.write(`break-glass recovery failed: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}
async function isMainModule() {
    if (process.argv[1] === undefined)
        return false;
    try {
        return await realpath(resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url));
    }
    catch {
        return false;
    }
}
if (await isMainModule())
    process.exitCode = await main();
//# sourceMappingURL=break-glass.js.map
