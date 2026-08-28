#!/usr/bin/env node
/**
 * Standalone Center journal verifier and desired-state recovery executable.
 *
 * This file imports only Node built-ins. A pinned copy can restore the
 * Extension Center's own Plugin records even when the Center runtime cannot
 * start. It invokes only the journal-bound official DSH CLI to restore the
 * exact Profile dependency before committing Center state; it never writes
 * an official Profile manifest, lockfile, package tree, or bundle list itself.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
const CURRENT_FILENAME = 'CURRENT.json';
const EVENT_FILENAME = /^(\d{10})-([0-9a-f]{64})\.json$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ARTIFACT_INTEGRITY = /^sha(?:256:[0-9a-f]{64}|512:(?:[0-9a-f]{128}|[A-Za-z0-9+/]{86}==))$/;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSACTION_BYTES = 24 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_MODULES_METADATA_BYTES = 1024 * 1024;
const OUTPUT_LIMIT = 32 * 1024;
const PROCESS_PROBE_OUTPUT_LIMIT = 4 * 1024;
const PROCESS_PROBE_TIMEOUT_MS = 2_000;
const TERMINATION_GRACE_MS = 250;
const SUPERVISOR_FALLBACK_MS = 2_000;
const PROCESS_GROUP_QUIESCENCE_MS = 5_000;
const PROCESS_GROUP_POLL_MS = 10;
const SUPERVISOR_CHILD_OUTCOME_BYTES = 4_096;
const OFFICIAL_DSH_PACKAGE = '@deepseek-ai/dsh';
const OFFICIAL_DSH_VERSION = '0.1.2-alpha.1';
const PNPM_11_PACKAGE_MANAGER = /^pnpm@11\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const PROFILE_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;
const PHASES = [
    'authorized', 'staging', 'applying', 'verifying', 'rolling-back',
    'committed', 'rolled-back', 'failed', 'recovery-required',
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
let hostIdentityEvidence = null;
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
function isCompleteSupervisorChildOutcome(bytes) {
    return bytes.length > 0 && bytes.length <= SUPERVISOR_CHILD_OUTCOME_BYTES
        && bytes[bytes.length - 1] === 0x0a && bytes.subarray(0, -1).indexOf(0x0a) === -1
        && bytes.indexOf(0x0d) === -1;
}
function decodeSupervisorChildOutcome(bytes, label) {
    if (!isCompleteSupervisorChildOutcome(bytes))
        failure(`${label} is not one bounded JSON record`);
    const value = bytes.toString('utf8');
    let parsed;
    try {
        parsed = JSON.parse(value.slice(0, -1));
    }
    catch (cause) {
        throw new Error(`${label} is not valid JSON`, { cause });
    }
    const record = strictRecord(parsed, ['schemaVersion', 'code', 'signal', 'launchError'], label);
    if (record.schemaVersion !== 1 || typeof record.launchError !== 'boolean'
        || !(record.code === null || Number.isSafeInteger(record.code) && record.code >= 0
            && record.code <= 255)
        || !(record.signal === null || typeof record.signal === 'string' && /^[A-Z0-9]+$/u.test(record.signal))
        || (record.code === null) === (record.signal === null)) {
        failure(`${label} fields are invalid`);
    }
    return Object.freeze(record);
}
function boundedString(value, label, maximum = 1_024) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
        failure(`${label} must be a bounded non-empty string`);
    }
    return value;
}
function nullableString(value, label, maximum = 1_024) {
    return value === null ? null : boundedString(value, label, maximum);
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
function literal(value, values, label) {
    if (typeof value !== 'string' || !values.includes(value))
        failure(`${label} has an unsupported value`);
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
function processEvidenceDigest(kind, platform, marker) {
    return `sha256:${createHash('sha256').update(kind).update('\0').update(platform).update('\0').update(marker).digest('hex')}`;
}
function decodeProcessIdentity(value, label) {
    const record = strictRecord(value, ['schemaVersion', 'pid', 'platform', 'machineDigest', 'bootDigest', 'birthDigest'], `${label} process identity`);
    if (record.schemaVersion !== 1)
        failure(`${label} process identity schemaVersion is unsupported`);
    const pid = safeInteger(record.pid, `${label} process identity.pid`, 1);
    const platform = literal(record.platform, ['darwin', 'linux', 'win32'], `${label} process identity.platform`);
    const machine = record.machineDigest === null ? null : digest(record.machineDigest, `${label} process identity.machineDigest`);
    const boot = record.bootDigest === null ? null : digest(record.bootDigest, `${label} process identity.bootDigest`);
    const birth = record.birthDigest === null ? null : digest(record.birthDigest, `${label} process identity.birthDigest`);
    return Object.freeze({ schemaVersion: 1, pid, platform, machineDigest: machine, bootDigest: boot, birthDigest: birth });
}
async function processProbeCommand(executable, arguments_, env) {
    return await new Promise(resolveResult => {
        const child = spawn(executable, arguments_, {
            env,
            shell: false,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        });
        let stdout = '';
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolveResult(value);
        };
        const timer = setTimeout(() => {
            child.kill();
            finish(null);
        }, PROCESS_PROBE_TIMEOUT_MS);
        timer.unref();
        child.stdout.on('data', (chunk) => {
            if (Buffer.byteLength(stdout) >= PROCESS_PROBE_OUTPUT_LIMIT)
                return;
            stdout = (stdout + chunk.toString('utf8')).slice(0, PROCESS_PROBE_OUTPUT_LIMIT);
        });
        child.once('error', () => { finish(null); });
        child.once('close', code => { finish(Object.freeze({ code, stdout })); });
    });
}
function linuxProcessStartTicks(stat) {
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0 || stat[commandEnd + 1] !== ' ')
        return null;
    const fieldsFromState = stat.slice(commandEnd + 2).trim().split(/\s+/u);
    const startTicks = fieldsFromState[19];
    return startTicks !== undefined && /^\d+$/u.test(startTicks) ? startTicks : null;
}
async function probeProcessBirth(pid, platform) {
    if (platform === 'linux') {
        let stat;
        try {
            stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
        }
        catch (error) {
            return Object.freeze({ status: error.code === 'ENOENT' ? 'absent' : 'unknown' });
        }
        const startTicks = linuxProcessStartTicks(stat);
        if (startTicks === null)
            return Object.freeze({ status: 'unknown' });
        try {
            const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase();
            if (!/^[0-9a-f-]{36}$/u.test(bootId))
                return Object.freeze({ status: 'unknown' });
            return Object.freeze({ status: 'present', marker: `${bootId}:${startTicks}` });
        }
        catch {
            return Object.freeze({ status: 'present', marker: '' });
        }
    }
    if (platform === 'darwin') {
        const result = await processProbeCommand('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
            LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC0',
        });
        if (result === null)
            return Object.freeze({ status: 'unknown' });
        const marker = result.stdout.trim().replace(/\s+/gu, ' ');
        if (result.code === 0 && marker.length > 0)
            return Object.freeze({ status: 'present', marker });
        if (result.code === 1 && marker.length === 0)
            return Object.freeze({ status: 'absent' });
        return Object.freeze({ status: 'unknown' });
    }
    const systemRoot = process.env.SystemRoot;
    if (systemRoot === undefined || systemRoot.length === 0)
        return Object.freeze({ status: 'unknown' });
    const script = [
        `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue`,
        "if ($null -eq $p) { [Console]::Out.Write('absent'); exit 3 }",
        "try { [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)); exit 0 } catch { exit 4 }",
    ].join('; ');
    const result = await processProbeCommand(`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { SystemRoot: systemRoot });
    if (result === null)
        return Object.freeze({ status: 'unknown' });
    const marker = result.stdout.trim();
    if (result.code === 0 && /^\d+$/u.test(marker))
        return Object.freeze({ status: 'present', marker });
    if (result.code === 3 && marker === 'absent')
        return Object.freeze({ status: 'absent' });
    return Object.freeze({ status: 'unknown' });
}
async function probeHostIdentityEvidence(platform) {
    if (platform === 'linux') {
        try {
            const machineMarker = (await readFile('/etc/machine-id', 'utf8')).trim().toLowerCase();
            const bootMarker = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase();
            if (!/^[0-9a-f]{32}$/u.test(machineMarker) || !/^[0-9a-f-]{36}$/u.test(bootMarker))
                return null;
            return Object.freeze({ machineMarker, bootMarker });
        }
        catch {
            return null;
        }
    }
    if (platform === 'darwin') {
        const environment = { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin', TZ: 'UTC0' };
        const [machine, boot] = await Promise.all([
            processProbeCommand('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], environment),
            processProbeCommand('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], environment),
        ]);
        const machineMarker = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/u.exec(machine?.stdout ?? '')?.[1];
        const bootMarker = boot?.stdout.trim();
        if (machine?.code !== 0 || boot?.code !== 0 || machineMarker === undefined
            || bootMarker === undefined || !/^[0-9A-Fa-f-]{36}$/u.test(bootMarker))
            return null;
        return Object.freeze({ machineMarker: machineMarker.toLowerCase(), bootMarker: bootMarker.toLowerCase() });
    }
    const systemRoot = process.env.SystemRoot;
    if (systemRoot === undefined || systemRoot.length === 0)
        return null;
    const script = [
        "$m = (Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid",
        '$b = (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks',
        "[Console]::Out.Write($m.ToString() + '|' + $b.ToString([Globalization.CultureInfo]::InvariantCulture))",
    ].join('; ');
    const result = await processProbeCommand(`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { SystemRoot: systemRoot });
    if (result?.code !== 0)
        return null;
    const match = /^([^|\r\n]{1,256})\|(\d+)$/u.exec(result.stdout.trim());
    return match === null ? null : Object.freeze({ machineMarker: match[1].toLowerCase(), bootMarker: match[2] });
}
function currentHostIdentityEvidence(platform) {
    hostIdentityEvidence ??= probeHostIdentityEvidence(platform);
    return hostIdentityEvidence;
}
async function currentProcessIdentity() {
    const platform = literal(process.platform, ['darwin', 'linux', 'win32'], 'current platform');
    const [host, observed] = await Promise.all([
        currentHostIdentityEvidence(platform),
        probeProcessBirth(process.pid, platform),
    ]);
    return Object.freeze({
        schemaVersion: 1,
        pid: process.pid,
        platform,
        machineDigest: host === null ? null : processEvidenceDigest('machine', platform, host.machineMarker),
        bootDigest: host === null ? null : processEvidenceDigest('boot', platform, host.bootMarker),
        birthDigest: observed.status === 'present' && observed.marker.length > 0
            ? processEvidenceDigest('birth', platform, observed.marker)
            : null,
    });
}
async function processIdentityStatus(identity) {
    if (identity.platform !== process.platform || identity.machineDigest === null
        || identity.bootDigest === null || identity.birthDigest === null)
        return 'unknown';
    const host = await currentHostIdentityEvidence(identity.platform);
    if (host === null)
        return 'unknown';
    if (processEvidenceDigest('machine', identity.platform, host.machineMarker) !== identity.machineDigest)
        return 'unknown';
    if (processEvidenceDigest('boot', identity.platform, host.bootMarker) !== identity.bootDigest)
        return 'dead';
    const observed = await probeProcessBirth(identity.pid, identity.platform);
    if (observed.status === 'absent')
        return 'dead';
    if (observed.status === 'unknown' || observed.marker.length === 0)
        return 'unknown';
    return processEvidenceDigest('birth', identity.platform, observed.marker) === identity.birthDigest ? 'alive' : 'dead';
}
function decodeProfileLockOwner(value, profileId, label) {
    if (isRecord(value) && value.schemaVersion === 1) {
        failure(`${label} has no process-birth evidence; manual recovery is required`);
    }
    const owner = strictRecord(value, ['schemaVersion', 'profileId', 'ownerId', 'leaseId', 'processIdentity', 'acquiredAtMs'], label);
    if (owner.schemaVersion !== 2 || owner.profileId !== profileId)
        failure(`${label} identity is invalid`);
    const leaseId = boundedString(owner.leaseId, `${label}.leaseId`);
    if (!/^lease:[0-9a-f-]{36}$/u.test(leaseId))
        failure(`${label}.leaseId is invalid`);
    return Object.freeze({
        schemaVersion: 2,
        profileId,
        ownerId: boundedString(owner.ownerId, `${label}.ownerId`),
        leaseId,
        processIdentity: decodeProcessIdentity(owner.processIdentity, label),
        acquiredAtMs: safeInteger(owner.acquiredAtMs, `${label}.acquiredAtMs`),
    });
}
function decodeProfileTakeover(value, profileId, label) {
    const claim = strictRecord(value, [
        'schemaVersion', 'profileId', 'sourceLeaseId', 'sourceOwnerDigest', 'quarantineId', 'takeoverId',
        'claimantOwnerId', 'claimantProcessIdentity', 'claimedAtMs',
    ], label);
    if (claim.schemaVersion !== 1 || claim.profileId !== profileId)
        failure(`${label} identity is invalid`);
    const sourceLeaseId = boundedString(claim.sourceLeaseId, `${label}.sourceLeaseId`);
    const quarantineId = boundedString(claim.quarantineId, `${label}.quarantineId`);
    const takeoverId = boundedString(claim.takeoverId, `${label}.takeoverId`);
    if (!/^lease:[0-9a-f-]{36}$/u.test(sourceLeaseId)
        || !/^quarantine:[0-9a-f-]{36}$/u.test(quarantineId)
        || !/^takeover:[0-9a-f-]{36}$/u.test(takeoverId))
        failure(`${label} token is invalid`);
    return Object.freeze({
        schemaVersion: 1,
        profileId,
        sourceLeaseId,
        sourceOwnerDigest: digest(claim.sourceOwnerDigest, `${label}.sourceOwnerDigest`),
        quarantineId,
        takeoverId,
        claimantOwnerId: boundedString(claim.claimantOwnerId, `${label}.claimantOwnerId`),
        claimantProcessIdentity: decodeProcessIdentity(claim.claimantProcessIdentity, `${label}.claimant`),
        claimedAtMs: safeInteger(claim.claimedAtMs, `${label}.claimedAtMs`),
    });
}
function fileDigest(value) {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function storageKey(value) {
    return createHash('sha256').update(value).digest('hex');
}
function below(root, path) {
    const value = relative(resolve(root), resolve(path));
    return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
function sameOrBelow(root, path) {
    return resolve(root) === resolve(path) || below(root, path);
}
function verifyRecoverySeparation(centerRoot, binding) {
    if (centerRoot === binding.hostHome || sameOrBelow(join(binding.hostHome, 'profiles'), centerRoot)
        || sameOrBelow(centerRoot, binding.packageRoot) || sameOrBelow(binding.packageRoot, centerRoot)) {
        failure('recovery root overlaps official DSH Profile or package state');
    }
}
async function readRegularNoFollow(path, maximumBytes, label) {
    if (constants.O_NOFOLLOW === undefined)
        failure(`${label} cannot be opened without following links on this platform`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size <= 0 || opened.size > maximumBytes)
            failure(`${label} has an invalid file type or byte length`);
        const bytes = await handle.readFile();
        if (bytes.length !== opened.size)
            failure(`${label} changed while it was read`);
        const current = await lstat(path);
        if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino)
            failure(`${label} path changed while it was read`);
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
async function readOptionalRecord(path, maximumBytes, label) {
    try {
        return parseCanonicalRecord(await readRegularNoFollow(path, maximumBytes, label), label);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function syncDirectory(path) {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function ensureRealDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const canonical = await realpath(path);
    const info = await lstat(path);
    if (canonical !== path || !info.isDirectory() || info.isSymbolicLink())
        failure(`Center-owned directory is unsafe: ${path}`);
}
async function writeExclusive(path, value) {
    await ensureRealDirectory(dirname(path));
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await syncDirectory(dirname(path));
}
async function writeAtomic(path, value) {
    await ensureRealDirectory(dirname(path));
    const temporary = join(dirname(path), `.tmp-${randomUUID()}`);
    try {
        await writeExclusive(temporary, value);
        await rename(temporary, path);
        await syncDirectory(dirname(path));
    }
    catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}
async function removeRegular(path, label) {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
            failure(`${label} is not a Center-owned regular record`);
        await rm(path);
        await syncDirectory(dirname(path));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
function decodeProfileName(value, label) {
    const profile = boundedString(value, label, 256);
    if (profile.includes('/') || profile.includes('\\') || profile.includes(':') || profile.startsWith('-')
        || /[\u0000-\u001f\u007f]/u.test(profile) || profile === '.' || profile === '..' || profile === 'node_modules') {
        failure(`${label} must be one CLI-safe non-reserved path segment`);
    }
    return profile;
}
function decodeRecoveryExecutable(value) {
    const record = strictRecord(value, [
        'schemaVersion', 'executablePath', 'executableSha256', 'centerRoot', 'packageVersion', 'platform', 'arch', 'officialDsh',
    ], 'journal recoveryExecutable');
    if (record.schemaVersion !== 5)
        failure('journal recoveryExecutable schemaVersion is unsupported');
    const executablePath = boundedString(record.executablePath, 'journal recoveryExecutable.executablePath', 4_096);
    const centerRoot = boundedString(record.centerRoot, 'journal recoveryExecutable.centerRoot', 4_096);
    if (!isAbsolute(executablePath) || !isAbsolute(centerRoot))
        failure('recovery executable and Center root paths must be absolute');
    const official = strictRecord(record.officialDsh, [
        'schemaVersion', 'packageName', 'packageVersion', 'packageRoot', 'packageTreeSha256', 'entrypointPath',
        'entrypointSha256', 'hostHome', 'timeoutMs', 'productionDependencies', 'node', 'supervisorPath',
        'supervisorSha256', 'pnpm',
    ], 'journal recoveryExecutable.officialDsh');
    const packageRoot = boundedString(official.packageRoot, 'journal recoveryExecutable.officialDsh.packageRoot', 4_096);
    const entrypointPath = boundedString(official.entrypointPath, 'journal recoveryExecutable.officialDsh.entrypointPath', 4_096);
    const hostHome = boundedString(official.hostHome, 'journal recoveryExecutable.officialDsh.hostHome', 4_096);
    const supervisorPath = boundedString(official.supervisorPath, 'journal recoveryExecutable.officialDsh.supervisorPath', 4_096);
    const timeoutMs = safeInteger(official.timeoutMs, 'journal recoveryExecutable.officialDsh.timeoutMs', 1_000);
    if (official.schemaVersion !== 2 || official.packageName !== OFFICIAL_DSH_PACKAGE
        || official.packageVersion !== OFFICIAL_DSH_VERSION || !isAbsolute(packageRoot)
        || !isAbsolute(entrypointPath) || !isAbsolute(hostHome) || !isAbsolute(supervisorPath) || timeoutMs > 600_000) {
        failure('journal recoveryExecutable.officialDsh identity is invalid');
    }
    if (!Array.isArray(official.productionDependencies) || official.productionDependencies.length > 1_024) {
        failure('journal recoveryExecutable.officialDsh production dependency closure is invalid');
    }
    const productionDependencies = official.productionDependencies.map((value, index) => {
        const label = `journal recoveryExecutable.officialDsh.productionDependencies[${String(index)}]`;
        const dependency = strictRecord(value, [
            'packageName', 'packageVersion', 'packageRoot', 'packageTreeSha256',
        ], label);
        const dependencyRoot = boundedString(dependency.packageRoot, `${label}.packageRoot`, 4_096);
        if (!isAbsolute(dependencyRoot))
            failure(`${label}.packageRoot must be absolute`);
        return Object.freeze({
            packageName: boundedString(dependency.packageName, `${label}.packageName`, 256),
            packageVersion: boundedString(dependency.packageVersion, `${label}.packageVersion`, 128),
            packageRoot: dependencyRoot,
            packageTreeSha256: digest(dependency.packageTreeSha256, `${label}.packageTreeSha256`),
        });
    });
    const dependencyKeys = productionDependencies.map(value => `${value.packageName}\0${value.packageVersion}\0${value.packageRoot}`);
    if (new Set(dependencyKeys).size !== dependencyKeys.length
        || dependencyKeys.some((value, index) => index > 0 && dependencyKeys[index - 1].localeCompare(value) >= 0)) {
        failure('journal recoveryExecutable.officialDsh production dependency closure is not sorted and unique');
    }
    const node = strictRecord(official.node, [
        'schemaVersion', 'executablePath', 'executableSha256', 'version',
    ], 'journal recoveryExecutable.officialDsh.node');
    const nodePath = boundedString(node.executablePath, 'journal recoveryExecutable.officialDsh.node.executablePath', 4_096);
    if (node.schemaVersion !== 1 || !isAbsolute(nodePath))
        failure('journal recoveryExecutable.officialDsh.node is invalid');
    const pnpm = strictRecord(official.pnpm, [
        'schemaVersion', 'packageName', 'packageVersion', 'registryIntegrity', 'packageRoot', 'packageTreeSha256',
        'entrypointPath', 'entrypointSha256', 'shimPath', 'shimSha256', 'shellPath', 'shellSha256', 'runtimeRoot',
    ], 'journal recoveryExecutable.officialDsh.pnpm');
    const pnpmPackageRoot = boundedString(pnpm.packageRoot, 'journal recoveryExecutable.officialDsh.pnpm.packageRoot', 4_096);
    const pnpmEntrypoint = boundedString(pnpm.entrypointPath, 'journal recoveryExecutable.officialDsh.pnpm.entrypointPath', 4_096);
    const pnpmShim = boundedString(pnpm.shimPath, 'journal recoveryExecutable.officialDsh.pnpm.shimPath', 4_096);
    const pnpmShell = boundedString(pnpm.shellPath, 'journal recoveryExecutable.officialDsh.pnpm.shellPath', 4_096);
    const runtimeRoot = boundedString(pnpm.runtimeRoot, 'journal recoveryExecutable.officialDsh.pnpm.runtimeRoot', 4_096);
    if (pnpm.schemaVersion !== 1 || pnpm.packageName !== 'pnpm' || pnpm.packageVersion !== '11.21.0'
        || pnpm.registryIntegrity !== 'sha512-UhcFvOaJkk6scvWjWHEi82JonvZXHlW6gAdv1jfBETLs/62ib61Op5xIW/3b/T1aKlsFgFp36JPeceyKbMo7sQ=='
        || ![pnpmPackageRoot, pnpmEntrypoint, pnpmShim, pnpmShell, runtimeRoot].every(isAbsolute)) {
        failure('journal recoveryExecutable.officialDsh.pnpm is invalid');
    }
    return Object.freeze({
        schemaVersion: 5,
        executablePath,
        executableSha256: digest(record.executableSha256, 'journal recoveryExecutable.executableSha256'),
        centerRoot,
        packageVersion: boundedString(record.packageVersion, 'journal recoveryExecutable.packageVersion', 128),
        platform: literal(record.platform, ['darwin', 'linux', 'win32'], 'journal recoveryExecutable.platform'),
        arch: boundedString(record.arch, 'journal recoveryExecutable.arch', 64),
        officialDsh: Object.freeze({
            schemaVersion: 2,
            packageName: OFFICIAL_DSH_PACKAGE,
            packageVersion: OFFICIAL_DSH_VERSION,
            packageRoot,
            packageTreeSha256: digest(official.packageTreeSha256, 'journal recoveryExecutable.officialDsh.packageTreeSha256'),
            productionDependencies: Object.freeze(productionDependencies),
            entrypointPath,
            entrypointSha256: digest(official.entrypointSha256, 'journal recoveryExecutable.officialDsh.entrypointSha256'),
            hostHome,
            timeoutMs,
            node: Object.freeze({
                schemaVersion: 1,
                executablePath: nodePath,
                executableSha256: digest(node.executableSha256, 'journal recoveryExecutable.officialDsh.node.executableSha256'),
                version: boundedString(node.version, 'journal recoveryExecutable.officialDsh.node.version', 64),
            }),
            supervisorPath,
            supervisorSha256: digest(official.supervisorSha256, 'journal recoveryExecutable.officialDsh.supervisorSha256'),
            pnpm: Object.freeze({
                schemaVersion: 1,
                packageName: 'pnpm',
                packageVersion: '11.21.0',
                registryIntegrity: pnpm.registryIntegrity,
                packageRoot: pnpmPackageRoot,
                packageTreeSha256: digest(pnpm.packageTreeSha256, 'journal recoveryExecutable.officialDsh.pnpm.packageTreeSha256'),
                entrypointPath: pnpmEntrypoint,
                entrypointSha256: digest(pnpm.entrypointSha256, 'journal recoveryExecutable.officialDsh.pnpm.entrypointSha256'),
                shimPath: pnpmShim,
                shimSha256: digest(pnpm.shimSha256, 'journal recoveryExecutable.officialDsh.pnpm.shimSha256'),
                shellPath: pnpmShell,
                shellSha256: digest(pnpm.shellSha256, 'journal recoveryExecutable.officialDsh.pnpm.shellSha256'),
                runtimeRoot,
            }),
        }),
    });
}
function decodePlanEvidence(value, label) {
    const record = strictRecord(value, [
        'origin', 'candidateRef', 'extensionKind', 'extensionId', 'artifactRevision', 'artifactIntegrity', 'artifactUrl',
        'artifactSizeBytes', 'desiredState', 'ownerKey', 'scopeKey', 'profileId', 'idempotencyKey', 'authorityDigest',
        'configurationDigest', 'retentionDigest', 'mutationDigest', 'verificationDigest', 'reviewEvidence',
        'restartRequired', 'fences', 'recoveryExecutable',
    ], label);
    literal(record.origin, ['store', 'task'], `${label}.origin`);
    boundedString(record.candidateRef, `${label}.candidateRef`, 2_048);
    const extensionKind = literal(record.extensionKind, ['plugin', 'mcp', 'skill'], `${label}.extensionKind`);
    const extensionId = boundedString(record.extensionId, `${label}.extensionId`, 256);
    boundedString(record.artifactRevision, `${label}.artifactRevision`, 256);
    if (typeof record.artifactIntegrity !== 'string' || !ARTIFACT_INTEGRITY.test(record.artifactIntegrity)) {
        failure(`${label}.artifactIntegrity is invalid`);
    }
    boundedString(record.artifactUrl, `${label}.artifactUrl`, 2_048);
    safeInteger(record.artifactSizeBytes, `${label}.artifactSizeBytes`, 1);
    literal(record.desiredState, ['enabled', 'disabled', 'removed'], `${label}.desiredState`);
    const ownerKey = boundedString(record.ownerKey, `${label}.ownerKey`);
    const scopeKey = boundedString(record.scopeKey, `${label}.scopeKey`, 512);
    const profileId = decodeProfileName(record.profileId, `${label}.profileId`);
    boundedString(record.idempotencyKey, `${label}.idempotencyKey`, 512);
    for (const field of ['authorityDigest', 'configurationDigest', 'retentionDigest', 'mutationDigest', 'verificationDigest']) {
        digest(record[field], `${label}.${field}`);
    }
    if (typeof record.restartRequired !== 'boolean')
        failure(`${label}.restartRequired must be boolean`);
    const review = strictRecord(record.reviewEvidence, [
        'schemaVersion', 'kind', 'operationKind', 'checks', 'removed', 'retained', 'credentialChoice', 'rollbackPoint',
        'rollbackLimits', 'notProven', 'manifest', 'dependencies', 'managedMaterial', 'packageMetadata', 'activation', 'scripts', 'settings',
    ], `${label}.reviewEvidence`);
    if (review.schemaVersion !== 1 || review.kind !== 'plugin')
        failure(`${label}.reviewEvidence is not Plugin evidence`);
    const fences = strictRecord(record.fences, [
        'catalogRevision', 'inventoryRevision', 'targetRevision', 'ownerRevision', 'scopeRevision', 'profileRevision',
    ], `${label}.fences`);
    safeInteger(fences.catalogRevision, `${label}.fences.catalogRevision`, 1);
    digest(fences.inventoryRevision, `${label}.fences.inventoryRevision`);
    for (const field of ['targetRevision', 'ownerRevision', 'scopeRevision', 'profileRevision']) {
        boundedString(fences[field], `${label}.fences.${field}`);
    }
    return Object.freeze({ extensionId, extensionKind, ownerKey, profileId, scopeKey,
        recoveryExecutable: decodeRecoveryExecutable(record.recoveryExecutable) });
}
function decodeOpening(value, targetKey) {
    const record = strictRecord(value, [
        'type', 'planId', 'planHash', 'operationKind', 'managedObject', 'externalRuntimeAction', 'runtimeBinding',
        'planEvidence', 'beforeDigest',
    ], 'journal opening entry');
    if (record.type !== 'operation-opened')
        failure('journal must begin with operation-opened');
    boundedString(record.planId, 'journal opening planId');
    digest(record.planHash, 'journal opening planHash');
    literal(record.operationKind, ['install', 'configure', 'update', 'enable', 'disable', 'uninstall', 'restore', 'purge'], 'journal opening operationKind');
    if (record.managedObject !== 'artifact' || record.runtimeBinding !== null) {
        failure('break-glass recovery supports only Plugin artifact operations');
    }
    literal(record.externalRuntimeAction, ['download', 'none'], 'journal opening externalRuntimeAction');
    const beforeDigest = digest(record.beforeDigest, 'journal opening beforeDigest');
    const evidence = decodePlanEvidence(record.planEvidence, 'journal opening planEvidence');
    if (evidence.extensionKind !== 'plugin' || evidence.ownerKey !== 'managedPlugins') {
        failure('break-glass recovery supports only Center-owned managedPlugins operations');
    }
    packageSegments(evidence.extensionId);
    if (evidence.extensionId === 'dsh-plugin-extension-center')
        failure('the Extension Center cannot recover a self-managed operation');
    if (targetKey !== `plugin:${evidence.profileId}:${evidence.scopeKey}:${evidence.extensionId}`) {
        failure('journal Plugin target does not bind its plan identity');
    }
    return Object.freeze({ extensionId: evidence.extensionId, profileId: evidence.profileId,
        scopeKey: evidence.scopeKey, beforeDigest, recoveryExecutable: evidence.recoveryExecutable });
}
function decodeReceipt(value, operationId, targetKey, phase, sequence, head) {
    const receipt = strictRecord(value, ['body', 'digest'], 'journal receipt');
    const body = strictRecord(receipt.body, [
        'schemaVersion', 'operationId', 'planId', 'planHash', 'operationKind', 'managedObject', 'externalRuntimeAction',
        'runtimeBinding', 'planEvidence', 'targetKey', 'outcome', 'beforeDigest', 'afterDigest', 'mutationDigests',
        'verificationDigests', 'evidence', 'journalEventCount', 'journalHeadDigest', 'issuedAtMs',
    ], 'journal receipt body');
    if (body.schemaVersion !== 1 || body.operationId !== operationId || body.targetKey !== targetKey
        || body.outcome !== phase || !['committed', 'rolled-back', 'failed'].includes(phase)
        || body.journalEventCount !== sequence - 1 || body.journalHeadDigest !== head) {
        failure('journal receipt does not bind its terminal journal prefix');
    }
    if (canonicalDigest(body) !== digest(receipt.digest, 'journal receipt digest')) {
        failure('journal receipt digest does not match its body');
    }
}
function decodeEntry(value, context) {
    if (!isRecord(value) || typeof value.type !== 'string')
        failure('journal event entry is invalid');
    if (context.receiptSeen)
        failure('journal receipt must be the final event');
    if (context.phase === null) {
        if (context.sequence !== 1)
            failure('journal opening sequence is invalid');
        return Object.freeze({ phase: 'authorized', opening: decodeOpening(value, context.targetKey), receiptSeen: false });
    }
    if (value.type === 'phase-transition') {
        const record = strictRecord(value, ['type', 'from', 'to', 'evidenceDigest', 'reason'], 'journal phase transition');
        const from = literal(record.from, PHASES, 'journal phase transition from');
        const to = literal(record.to, PHASES, 'journal phase transition to');
        if (from !== context.phase || !NEXT_PHASES[from].includes(to))
            failure(`invalid journal transition from ${from} to ${to}`);
        if (record.evidenceDigest !== null)
            digest(record.evidenceDigest, 'journal phase transition evidenceDigest');
        if (!['committed', 'rolled-back', 'failed'].includes(to) && record.evidenceDigest !== null) {
            failure('non-terminal journal transitions cannot publish final evidence');
        }
        if (record.reason !== null && (typeof record.reason !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(record.reason))) {
            failure('journal phase transition reason is invalid');
        }
        if ((to === 'failed' || to === 'recovery-required') && record.reason === null)
            failure(`${to} requires a stable reason`);
        return Object.freeze({ phase: to, opening: null, receiptSeen: false });
    }
    if (value.type === 'mutation-observed' || value.type === 'verification-observed') {
        const field = value.type === 'mutation-observed' ? 'mutationDigest' : 'verificationDigest';
        const permitted = value.type === 'mutation-observed'
            ? ['applying', 'verifying', 'rolling-back']
            : ['verifying', 'rolling-back'];
        if (!permitted.includes(context.phase))
            failure(`${value.type} is invalid during ${context.phase}`);
        strictRecord(value, ['type', field], `journal ${value.type}`);
        digest(value[field], `journal ${field}`);
        return Object.freeze({ phase: context.phase, opening: null, receiptSeen: false });
    }
    if (value.type === 'receipt-issued') {
        const record = strictRecord(value, ['type', 'receipt'], 'journal receipt entry');
        decodeReceipt(record.receipt, context.operationId, context.targetKey, context.phase, context.sequence, context.previousDigest);
        return Object.freeze({ phase: context.phase, opening: null, receiptSeen: true });
    }
    failure(`unsupported journal entry type ${JSON.stringify(value.type)}`);
}
async function verifyCenterRoot(centerRoot) {
    if (!isAbsolute(centerRoot) || resolve(centerRoot) !== centerRoot)
        failure('Center root argument must be a canonical absolute path');
    const canonical = await realpath(centerRoot);
    const info = await lstat(centerRoot);
    if (canonical !== centerRoot || !info.isDirectory() || info.isSymbolicLink())
        failure('Center root is not its canonical real directory');
    const manifest = strictRecord(await readOptionalRecord(join(centerRoot, 'manifest.json'), MAX_POINTER_BYTES, 'Center manifest'), ['schemaVersion', 'centerId', 'createdAtMs'], 'Center manifest');
    if (manifest.schemaVersion !== 1 || typeof manifest.centerId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(manifest.centerId)
        || !Number.isSafeInteger(manifest.createdAtMs) || manifest.createdAtMs < 0) {
        failure('Center manifest values are invalid');
    }
    return canonical;
}
async function verifyJournal(centerRoot, operationId) {
    boundedString(operationId, 'operationId', 512);
    const directory = join(centerRoot, 'operations', storageKey(operationId));
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
        failure('operation journal directory is not a canonical real directory');
    }
    const entries = await readdir(directory, { withFileTypes: true });
    const events = entries.filter(entry => EVENT_FILENAME.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name));
    const unexpected = entries.filter(entry => entry.name !== CURRENT_FILENAME && !EVENT_FILENAME.test(entry.name));
    if (unexpected.length > 0 || events.length === 0
        || entries.some(entry => (entry.name === CURRENT_FILENAME || EVENT_FILENAME.test(entry.name)) && !entry.isFile())) {
        failure('operation journal directory contains invalid durable records');
    }
    const pointer = strictRecord(parseCanonicalRecord(await readRegularNoFollow(join(directory, CURRENT_FILENAME), MAX_POINTER_BYTES, 'operation CURRENT'), 'operation CURRENT'), ['schemaVersion', 'operationId', 'targetKey', 'eventCount', 'headDigest'], 'operation CURRENT');
    if (pointer.schemaVersion !== 1 || pointer.operationId !== operationId)
        failure('operation CURRENT identity is invalid');
    const targetKey = boundedString(pointer.targetKey, 'operation CURRENT targetKey');
    if (safeInteger(pointer.eventCount, 'operation CURRENT eventCount', 1) !== events.length) {
        failure('operation CURRENT does not anchor every durable event');
    }
    const headDigest = digest(pointer.headDigest, 'operation CURRENT headDigest');
    let previousDigest = null;
    let previousAtMs = 0;
    let phase = null;
    let opening = null;
    let receiptSeen = false;
    for (let index = 0; index < events.length; index += 1) {
        const entry = events[index];
        const match = EVENT_FILENAME.exec(entry.name);
        const sequence = index + 1;
        if (Number(match[1]) !== sequence)
            failure('journal event filenames are not contiguous');
        const event = strictRecord(parseCanonicalRecord(await readRegularNoFollow(join(directory, entry.name), MAX_EVENT_BYTES, `journal event ${String(sequence)}`), `journal event ${String(sequence)}`), ['schemaVersion', 'operationId', 'targetKey', 'sequence', 'previousDigest', 'atMs', 'entry', 'digest'], `journal event ${String(sequence)}`);
        if (event.schemaVersion !== 1 || event.operationId !== operationId || event.targetKey !== targetKey || event.sequence !== sequence) {
            failure(`journal event ${String(sequence)} identity is invalid`);
        }
        if (event.previousDigest !== previousDigest)
            failure(`journal event ${String(sequence)} chain is invalid`);
        const atMs = safeInteger(event.atMs, `journal event ${String(sequence)} atMs`);
        if (index > 0 && atMs < previousAtMs)
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
        const decoded = decodeEntry(event.entry, { operationId, targetKey, phase, sequence, previousDigest, receiptSeen });
        phase = decoded.phase;
        opening ??= decoded.opening;
        receiptSeen = decoded.receiptSeen;
        previousDigest = eventDigest;
        previousAtMs = atMs;
    }
    if (previousDigest !== headDigest)
        failure('operation CURRENT headDigest does not match the journal head');
    if (opening === null || phase === null)
        failure('operation journal has no verified opening');
    return Object.freeze({ operationId, targetKey, phase, headDigest, opening });
}
async function verifyExecutable(path, expectedDigest, label) {
    const canonical = await realpath(path);
    if (canonical !== path)
        failure(`${label} path is not its canonical realpath`);
    const bytes = await readRegularNoFollow(path, MAX_EXECUTABLE_BYTES, label);
    if (fileDigest(bytes) !== expectedDigest)
        failure(`${label} hash does not match its pin`);
    return canonical;
}
async function hashImmutableTree(root, path, hash, ignoreRootNodeModules) {
    const info = await lstat(path);
    const name = relative(root, path).split(sep).join('/') || '.';
    if (info.isSymbolicLink()) {
        hash.update(`link:${name}:${await readlink(path)}\0`);
        return;
    }
    if (info.isFile()) {
        hash.update(`file:${name}:${String(info.size)}\0`);
        hash.update(await readFile(path));
        return;
    }
    if (!info.isDirectory())
        failure(`official DSH package contains unsupported entry ${JSON.stringify(name)}`);
    hash.update(`dir:${name}\0`);
    const entries = (await readdir(path, { withFileTypes: true }))
        .filter(entry => !(ignoreRootNodeModules && path === root && entry.name === 'node_modules'))
        .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries)
        await hashImmutableTree(root, join(path, entry.name), hash, ignoreRootNodeModules);
}
async function immutableTreeDigest(root, ignoreRootNodeModules) {
    const hash = createHash('sha256');
    await hashImmutableTree(root, root, hash, ignoreRootNodeModules);
    return `sha256:${hash.digest('hex')}`;
}
async function verifyBoundPackage(root, packageName, packageVersion, expectedTreeDigest, label, ignoreRootNodeModules) {
    const canonical = await realpath(root);
    const info = await lstat(root);
    if (canonical !== root || !info.isDirectory() || info.isSymbolicLink())
        failure(`${label} root changed`);
    let manifest;
    try {
        manifest = JSON.parse((await readRegularNoFollow(join(root, 'package.json'), MAX_STATE_BYTES, `${label} manifest`))
            .toString('utf8'));
    }
    catch {
        failure(`${label} manifest is invalid JSON`);
    }
    if (!isRecord(manifest) || manifest.name !== packageName || manifest.version !== packageVersion) {
        failure(`${label} identity changed`);
    }
    if (await immutableTreeDigest(root, ignoreRootNodeModules) !== expectedTreeDigest) {
        failure(`${label} tree does not match its pin`);
    }
}
async function verifyBoundNode(binding) {
    await verifyExecutable(binding.node.executablePath, binding.node.executableSha256, 'bound Node executable');
    const result = await new Promise((accept, reject) => {
        const child = spawn(binding.node.executablePath, ['--version'], {
            cwd: dirname(binding.node.executablePath),
            env: {},
            shell: false,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output = appendOutput(output, chunk); });
        child.once('error', reject);
        child.once('close', code => accept(Object.freeze({ code, output })));
    });
    if (result.code !== 0 || result.output.trim() !== binding.node.version) {
        failure('bound Node executable version changed');
    }
}
async function verifyOfficialDsh(binding) {
    if (process.platform === 'win32')
        failure('official DSH Plugin mutation and recovery are unsupported on Windows');
    await verifyBoundNode(binding);
    await verifyExecutable(binding.supervisorPath, binding.supervisorSha256, 'bound official DSH supervisor');
    await verifyExecutable(binding.pnpm.entrypointPath, binding.pnpm.entrypointSha256, 'private pnpm entrypoint');
    await verifyExecutable(binding.pnpm.shimPath, binding.pnpm.shimSha256, 'private pnpm shim');
    await verifyExecutable(binding.pnpm.shellPath, binding.pnpm.shellSha256, 'bound POSIX shell');
    await verifyBoundPackage(binding.pnpm.packageRoot, binding.pnpm.packageName, binding.pnpm.packageVersion, binding.pnpm.packageTreeSha256, 'private pnpm package', false);
    const packageRoot = await realpath(binding.packageRoot);
    const packageInfo = await lstat(binding.packageRoot);
    if (packageRoot !== binding.packageRoot || !packageInfo.isDirectory() || packageInfo.isSymbolicLink()) {
        failure('official DSH recovery package root changed');
    }
    const entrypoint = await verifyExecutable(binding.entrypointPath, binding.entrypointSha256, 'official DSH recovery entrypoint');
    if (!below(packageRoot, entrypoint))
        failure('official DSH recovery entrypoint escapes its package root');
    const manifestPath = join(packageRoot, 'package.json');
    const manifestBytes = await readRegularNoFollow(manifestPath, MAX_STATE_BYTES, 'official DSH recovery package manifest');
    let manifest;
    try {
        manifest = JSON.parse(manifestBytes.toString('utf8'));
    }
    catch {
        failure('official DSH recovery package manifest is invalid JSON');
    }
    if (!isRecord(manifest) || manifest.name !== OFFICIAL_DSH_PACKAGE || manifest.version !== OFFICIAL_DSH_VERSION
        || !isRecord(manifest.bin) || manifest.bin.dsh !== 'lib/bin.js') {
        failure('official DSH recovery package identity changed');
    }
    const declared = await realpath(resolve(packageRoot, manifest.bin.dsh));
    if (declared !== entrypoint)
        failure('official DSH recovery package no longer declares its bound entrypoint');
    const hostHome = await realpath(binding.hostHome);
    const homeInfo = await lstat(binding.hostHome);
    if (hostHome !== binding.hostHome || !homeInfo.isDirectory() || homeInfo.isSymbolicLink()) {
        failure('official DSH recovery home changed');
    }
    if (await immutableTreeDigest(packageRoot, true) !== binding.packageTreeSha256) {
        failure('official DSH recovery package tree does not match its pin');
    }
    for (const dependency of binding.productionDependencies) {
        await verifyBoundPackage(dependency.packageRoot, dependency.packageName, dependency.packageVersion, dependency.packageTreeSha256, `official DSH production dependency ${dependency.packageName}`, true);
    }
}
function appendOutput(held, chunk) {
    if (held.length >= OUTPUT_LIMIT)
        return held;
    return (held + chunk.toString('utf8')).slice(0, OUTPUT_LIMIT);
}
async function auditProfileExecution(binding, profileId) {
    const profilePath = join(binding.hostHome, 'profiles', decodeProfileName(profileId, 'official DSH recovery Profile id'));
    const canonical = await realpath(profilePath);
    const info = await lstat(profilePath);
    if (canonical !== profilePath || !info.isDirectory() || info.isSymbolicLink()) {
        failure('official DSH recovery Profile directory is unsafe');
    }
    for (const name of ['.npmrc', '.pnpmfile.cjs', '.pnpmfile.js', '.pnpmfile.mjs', 'pnpmfile.cjs', 'pnpmfile.js', 'pnpmfile.mjs']) {
        try {
            await lstat(join(profilePath, name));
            failure(`official DSH recovery Profile execution control is forbidden: ${name}`);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    if ((await readRegularNoFollow(join(profilePath, 'pnpm-workspace.yaml'), MAX_POINTER_BYTES, 'official DSH recovery Profile workspace')).toString('utf8') !== PROFILE_WORKSPACE) {
        failure('official DSH recovery Profile workspace contains unsupported execution controls');
    }
    let manifest;
    try {
        manifest = JSON.parse((await readRegularNoFollow(join(profilePath, 'package.json'), MAX_STATE_BYTES, 'official DSH recovery Profile manifest')).toString('utf8'));
    }
    catch {
        failure('official DSH recovery Profile manifest is invalid JSON');
    }
    if (!isRecord(manifest) || ['scripts', 'pnpm', 'packageManager', 'devEngines', 'workspaces', 'config', 'publishConfig']
        .some(field => Object.hasOwn(manifest, field))) {
        failure('official DSH recovery Profile manifest contains package-manager execution controls');
    }
    return profilePath;
}
async function readInstalledProfileStore(profilePath) {
    const nodeModulesPath = join(profilePath, 'node_modules');
    let canonicalNodeModules;
    let nodeModulesInfo;
    try {
        [canonicalNodeModules, nodeModulesInfo] = await Promise.all([realpath(nodeModulesPath), lstat(nodeModulesPath)]);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    if (canonicalNodeModules !== nodeModulesPath || !nodeModulesInfo.isDirectory() || nodeModulesInfo.isSymbolicLink()) {
        failure('official DSH recovery Profile node_modules directory is unsafe');
    }
    const metadataPath = join(nodeModulesPath, '.modules.yaml');
    let metadataBytes;
    try {
        metadataBytes = await readRegularNoFollow(metadataPath, MAX_MODULES_METADATA_BYTES, 'official DSH recovery Profile pnpm modules metadata');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            failure('installed official DSH recovery Profile pnpm modules metadata is missing');
        }
        throw error;
    }
    let metadata;
    try {
        metadata = JSON.parse(metadataBytes.toString('utf8'));
    }
    catch {
        failure('official DSH recovery Profile pnpm modules metadata is invalid JSON');
    }
    if (!isRecord(metadata) || metadata.layoutVersion !== 5 || metadata.nodeLinker !== 'hoisted'
        || metadata.virtualStoreDir !== '.pnpm' || typeof metadata.packageManager !== 'string'
        || !PNPM_11_PACKAGE_MANAGER.test(metadata.packageManager)) {
        failure('official DSH recovery Profile pnpm modules metadata is incompatible with pinned pnpm 11');
    }
    const storeDir = metadata.storeDir;
    if (typeof storeDir !== 'string' || storeDir.length === 0 || storeDir.length > 4_096
        || !isAbsolute(storeDir) || /[\u0000-\u001f\u007f]/u.test(storeDir) || !storeDir.endsWith(`${sep}v11`)) {
        failure('official DSH recovery Profile pnpm modules metadata storeDir is unsafe');
    }
    let canonicalStore;
    let storeInfo;
    try {
        [canonicalStore, storeInfo] = await Promise.all([realpath(storeDir), lstat(storeDir)]);
    }
    catch {
        failure('official DSH recovery Profile pnpm modules metadata storeDir is unavailable');
    }
    if (canonicalStore !== storeDir || !storeInfo.isDirectory() || storeInfo.isSymbolicLink()) {
        failure('official DSH recovery Profile pnpm modules metadata storeDir is not a canonical directory');
    }
    return storeDir;
}
function decodeMetadataCache(value, binding, profileId) {
    const record = strictRecord(value, [
        'schemaVersion', 'profileId', 'profilePath', 'generationPath', 'generationSha256', 'cachePath', 'manifestPath',
        'manifestSha256', 'profileManifestSha256', 'lockfileSha256', 'modulesSha256', 'sourcePnpmVersion',
        'storeDir', 'expectedStoreDir', 'pnpmMajor', 'pnpmVersion',
    ], 'Plugin recovery metadata cache');
    if (record.schemaVersion !== 1 || record.profileId !== profileId || record.pnpmMajor !== 11
        || record.pnpmVersion !== '11.21.0')
        failure('Plugin recovery metadata cache identity is invalid');
    const profilePath = boundedString(record.profilePath, 'Plugin recovery metadata cache profilePath', 4_096);
    const generationPath = boundedString(record.generationPath, 'Plugin recovery metadata cache generationPath', 4_096);
    const cachePath = boundedString(record.cachePath, 'Plugin recovery metadata cache cachePath', 4_096);
    const manifestPath = boundedString(record.manifestPath, 'Plugin recovery metadata cache manifestPath', 4_096);
    const storeDir = boundedString(record.storeDir, 'Plugin recovery metadata cache storeDir', 4_096);
    const expectedStoreDir = boundedString(record.expectedStoreDir, 'Plugin recovery metadata cache expectedStoreDir', 4_096);
    const generationSha256 = digest(record.generationSha256, 'Plugin recovery metadata cache generationSha256');
    const manifestSha256 = digest(record.manifestSha256, 'Plugin recovery metadata cache manifestSha256');
    const profileManifestSha256 = digest(record.profileManifestSha256, 'Plugin recovery metadata cache profileManifestSha256');
    const lockfileSha256 = record.lockfileSha256 === null
        ? null
        : digest(record.lockfileSha256, 'Plugin recovery metadata cache lockfileSha256');
    const modulesSha256 = record.modulesSha256 === null
        ? null
        : digest(record.modulesSha256, 'Plugin recovery metadata cache modulesSha256');
    const sourcePnpmVersion = record.sourcePnpmVersion === null
        ? null
        : boundedString(record.sourcePnpmVersion, 'Plugin recovery metadata cache sourcePnpmVersion', 64);
    if (sourcePnpmVersion !== null && !PNPM_11_PACKAGE_MANAGER.test(sourcePnpmVersion)) {
        failure('Plugin recovery metadata cache source pnpm major is invalid');
    }
    const profileRoot = join(binding.hostHome, 'profiles', profileId);
    const cacheRoot = join(binding.pnpm.runtimeRoot, 'metadata-cache', storageKey(profileId));
    if (profilePath !== profileRoot || !below(cacheRoot, generationPath)
        || generationPath !== join(cacheRoot, generationSha256.slice('sha256:'.length))
        || cachePath !== join(generationPath, 'cache') || manifestPath !== join(generationPath, 'manifest.json')
        || ![profilePath, generationPath, cachePath, manifestPath, storeDir, expectedStoreDir].every(isAbsolute)) {
        failure('Plugin recovery metadata cache paths do not bind the official Profile runtime');
    }
    return Object.freeze({
        schemaVersion: 1,
        profileId,
        profilePath,
        generationPath,
        generationSha256,
        cachePath,
        manifestPath,
        manifestSha256,
        profileManifestSha256,
        lockfileSha256,
        modulesSha256,
        sourcePnpmVersion,
        storeDir,
        expectedStoreDir,
        pnpmMajor: 11,
        pnpmVersion: '11.21.0',
    });
}
async function metadataCacheFiles(root) {
    const output = [];
    const visit = async (path) => {
        const info = await lstat(path);
        if (info.isSymbolicLink())
            failure('Plugin recovery metadata cache contains a symbolic link');
        if (info.isFile()) {
            const bytes = await readRegularNoFollow(path, MAX_STATE_BYTES, 'Plugin recovery metadata cache file');
            output.push(Object.freeze({
                path: relative(root, path).split(sep).join('/'),
                sizeBytes: bytes.length,
                sha256: fileDigest(bytes),
            }));
            return;
        }
        if (!info.isDirectory())
            failure('Plugin recovery metadata cache contains an unsupported entry');
        for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
            await visit(join(path, entry.name));
        }
    };
    await visit(root);
    return Object.freeze(output.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
async function verifyMetadataCache(official, metadataCache) {
    const binding = decodeMetadataCache(metadataCache, official, metadataCache.profileId);
    const bytes = await readRegularNoFollow(binding.manifestPath, MAX_STATE_BYTES, 'Plugin recovery metadata cache manifest');
    if (fileDigest(bytes) !== binding.manifestSha256)
        failure('Plugin recovery metadata cache manifest digest changed');
    const manifestValue = parseCanonicalRecord(bytes, 'Plugin recovery metadata cache manifest');
    const manifest = strictRecord(manifestValue, [
        'schemaVersion', 'profileId', 'profilePath', 'generationPath', 'generationSha256', 'cachePath', 'manifestPath',
        'profileManifestSha256', 'lockfileSha256', 'modulesSha256', 'sourcePnpmVersion', 'storeDir',
        'expectedStoreDir', 'pnpmMajor', 'pnpmVersion', 'files',
    ], 'Plugin recovery metadata cache manifest');
    if (!Array.isArray(manifest.files) || manifest.files.length > 32_768) {
        failure('Plugin recovery metadata cache manifest files are invalid');
    }
    const files = manifest.files.map((value, index) => {
        const item = strictRecord(value, ['path', 'sizeBytes', 'sha256'], `Plugin recovery metadata cache file ${String(index)}`);
        const path = boundedString(item.path, `Plugin recovery metadata cache file ${String(index)} path`, 4_096);
        if (isAbsolute(path) || path.split('/').includes('..')
            || !['pnpm/v11/metadata/registry.npmjs.org/', 'pnpm/v11/metadata-full/registry.npmjs.org/']
                .some(prefix => path.startsWith(prefix))) {
            failure(`Plugin recovery metadata cache file ${String(index)} path is unsafe`);
        }
        return Object.freeze({
            path,
            sizeBytes: safeInteger(item.sizeBytes, `Plugin recovery metadata cache file ${String(index)} sizeBytes`),
            sha256: digest(item.sha256, `Plugin recovery metadata cache file ${String(index)} sha256`),
        });
    });
    if (files.some((item, index) => index > 0 && files[index - 1].path >= item.path)) {
        failure('Plugin recovery metadata cache files are not sorted and unique');
    }
    const { files: _files, ...manifestBinding } = manifest;
    if (canonicalJson({ ...manifestBinding, manifestSha256: binding.manifestSha256 }) !== canonicalJson(binding)) {
        failure('Plugin recovery metadata cache manifest does not match the provider snapshot');
    }
    const generation = {
        schemaVersion: 1,
        profileId: binding.profileId,
        profilePath: binding.profilePath,
        profileManifestSha256: binding.profileManifestSha256,
        lockfileSha256: binding.lockfileSha256,
        modulesSha256: binding.modulesSha256,
        sourcePnpmVersion: binding.sourcePnpmVersion,
        storeDir: binding.storeDir,
        expectedStoreDir: binding.expectedStoreDir,
        pnpmMajor: binding.pnpmMajor,
        pnpmVersion: binding.pnpmVersion,
        files,
    };
    if (canonicalDigest(generation) !== binding.generationSha256) {
        failure('Plugin recovery metadata cache generation digest changed');
    }
    if (canonicalJson(await metadataCacheFiles(binding.cachePath)) !== canonicalJson(files)) {
        failure('Plugin recovery metadata cache files changed');
    }
    const [canonicalStore, storeInfo] = await Promise.all([realpath(binding.storeDir), lstat(binding.storeDir)]);
    if (canonicalStore !== binding.storeDir || !storeInfo.isDirectory() || storeInfo.isSymbolicLink()) {
        failure('Plugin recovery metadata cache store is not canonical');
    }
}
async function createExecutionEnvironment(binding, profileId, metadataCache) {
    const directory = join(binding.pnpm.runtimeRoot, `operation-${randomUUID()}`);
    await ensureRealDirectory(directory);
    const paths = {};
    for (const name of ['config', 'data', 'state', 'tmp']) {
        paths[name] = join(directory, name);
        await ensureRealDirectory(paths[name]);
    }
    const cache = join(directory, 'cache');
    await cp(metadataCache.cachePath, cache, { recursive: true, force: false, errorOnExist: true });
    const store = metadataCache.storeDir;
    const expectedStore = metadataCache.expectedStoreDir;
    const userConfig = join(directory, 'user.npmrc');
    const globalConfig = join(directory, 'global.npmrc');
    for (const path of [userConfig, globalConfig]) {
        const handle = await open(path, 'wx', 0o600);
        await handle.close();
    }
    return Object.freeze({
        directory,
        store,
        expectedStore,
        userConfig,
        globalConfig,
        environment: Object.freeze({
            PATH: dirname(binding.pnpm.shimPath),
            DSH_HOME: binding.hostHome,
            CI: '1',
            NO_COLOR: '1',
            LANG: 'C',
            LC_ALL: 'C',
            TMPDIR: paths.tmp,
            XDG_CACHE_HOME: cache,
            XDG_CONFIG_HOME: paths.config,
            XDG_DATA_HOME: paths.data,
            XDG_STATE_HOME: paths.state,
            pnpm_config_userconfig: userConfig,
            pnpm_config_globalconfig: globalConfig,
            pnpm_config_store_dir: store,
            pnpm_config_cache: cache,
            pnpm_config_offline: 'true',
            pnpm_config_ignore_scripts: 'true',
            pnpm_config_ignore_pnpmfile: 'true',
            pnpm_config_auto_install_peers: 'false',
            pnpm_config_package_import_method: 'copy',
            pnpm_config_verify_store_integrity: 'true',
            pnpm_config_strict_store_pkg_content_check: 'true',
            pnpm_config_side_effects_cache: 'false',
            pnpm_config_block_exotic_subdeps: 'true',
            pnpm_config_manage_package_manager_versions: 'false',
        }),
    });
}
function hardenPnpmArguments(arguments_, runtime) {
    return Object.freeze([
        ...arguments_,
        '--store-dir', runtime.store,
    ]);
}
async function executionLease(binding, profileId, processGroupPid) {
    const lease = join(binding.hostHome, '.extension-center-plugin-coordination', 'leases', storageKey(profileId));
    const owner = decodeProfileLockOwner(await readOptionalRecord(join(lease, 'owner.json'), MAX_POINTER_BYTES, 'official DSH recovery lease owner'), profileId, 'official DSH recovery lease owner');
    const current = await currentProcessIdentity();
    if (!sameProcessIdentity(owner.processIdentity, current)) {
        failure('official DSH recovery lease is not owned by this process');
    }
    const value = {
        schemaVersion: 1,
        profileId,
        ownerId: owner.ownerId,
        parentPid: process.pid,
        processGroupPid,
        supervisorSha256: binding.supervisorSha256,
        startedAtMs: Date.now(),
    };
    const path = join(lease, 'execution.json');
    await writeExclusive(path, value);
    return Object.freeze({ path, value: Object.freeze(value), owner });
}
function executionDispatch(record) {
    const value = Object.freeze({
        schemaVersion: 1,
        profileId: record.owner.profileId,
        ownerId: record.owner.ownerId,
        leaseId: record.owner.leaseId,
        processGroupPid: record.value.processGroupPid,
        executionDigest: canonicalDigest(record.value),
        dispatchedAtMs: Date.now(),
    });
    return Object.freeze({
        path: join(dirname(record.path), 'execution-dispatch.json'),
        value,
    });
}
async function clearExecutionRecord(record, label, optional) {
    const current = await readOptionalRecord(record.path, MAX_POINTER_BYTES, label);
    if (current === undefined && optional)
        return;
    if (current === undefined || canonicalJson(current) !== canonicalJson(record.value))
        failure(`${label} changed`);
    await removeRegular(record.path, label);
}
async function runOfficialDsh(binding, profileId, arguments_, label, metadataCache) {
    await verifyOfficialDsh(binding);
    const profilePath = await auditProfileExecution(binding, profileId);
    const installedStore = await readInstalledProfileStore(profilePath);
    await verifyMetadataCache(binding, metadataCache);
    if (metadataCache.profileId !== profileId
        || installedStore !== null && installedStore !== metadataCache.expectedStoreDir) {
        failure('Plugin recovery metadata cache does not bind the Profile store');
    }
    const runtime = await createExecutionEnvironment(binding, profileId, metadataCache);
    const hardenedArguments = hardenPnpmArguments(arguments_, runtime);
    const encoded = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        nodePath: binding.node.executablePath,
        entrypointPath: binding.entrypointPath,
        cwd: dirname(binding.entrypointPath),
        timeoutMs: binding.timeoutMs,
        arguments: hardenedArguments,
        environment: runtime.environment,
    }), 'utf8').toString('base64url');
    const durableRecords = { lease: null, dispatch: null, dispatchDurable: false };
    let processGroupQuiescent = false;
    try {
        const child = spawn(binding.node.executablePath, [binding.supervisorPath, encoded], {
            cwd: dirname(binding.supervisorPath),
            detached: true,
            env: {},
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const childOutcomeChunks = [];
        let childOutcomeBytes = 0;
        let childOutcomeOverflow = false;
        let childOutcomeReadError;
        let launchError;
        let fallback = null;
        let timeoutObservation = null;
        let deadlineAtMs = null;
        let outcomeObservedAtMs = null;
        let timedOut = false;
        let closeObserved = false;
        let exitObserved = false;
        let dispatchSettled = false;
        let executionWrite = Promise.resolve();
        let dispatchWrite = Promise.resolve();
        let resolveDispatch;
        let rejectDispatch;
        const dispatchPromise = new Promise((accept, reject) => {
            resolveDispatch = () => {
                if (dispatchSettled)
                    return;
                dispatchSettled = true;
                accept();
            };
            rejectDispatch = cause => {
                if (dispatchSettled)
                    return;
                dispatchSettled = true;
                reject(cause);
            };
        });
        let resolveClose;
        const closePromise = new Promise(accept => {
            resolveClose = accept;
        });
        child.stdout.on('data', (chunk) => { stdout = appendOutput(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = appendOutput(stderr, chunk); });
        child.stdio[3].on('data', (chunk) => {
            if (childOutcomeOverflow)
                return;
            childOutcomeBytes += chunk.length;
            if (childOutcomeBytes > SUPERVISOR_CHILD_OUTCOME_BYTES) {
                childOutcomeOverflow = true;
                childOutcomeChunks.length = 0;
                return;
            }
            childOutcomeChunks.push(Buffer.from(chunk));
            if (outcomeObservedAtMs === null
                && isCompleteSupervisorChildOutcome(Buffer.concat(childOutcomeChunks, childOutcomeBytes))) {
                outcomeObservedAtMs = performance.now();
                if (timeoutObservation !== null) {
                    clearTimeout(timeoutObservation);
                    timeoutObservation = null;
                }
            }
        });
        child.stdio[3].once('error', cause => { childOutcomeReadError = cause; });
        child.stdin.once('error', cause => {
            rejectDispatch(new Error('official DSH recovery supervisor start dispatch failed', { cause }));
        });
        child.once('error', cause => {
            launchError = cause;
            rejectDispatch(new Error(`official DSH recovery ${label} could not start`, { cause }));
        });
        child.once('spawn', () => {
            const pid = child.pid;
            if (pid === undefined) {
                rejectDispatch(new Error('official DSH recovery supervisor has no process id'));
                return;
            }
            fallback = setTimeout(() => {
                if (exitObserved)
                    return;
                try {
                    process.kill(-pid, 'SIGKILL');
                }
                catch { /* supervisor already exited */ }
            }, binding.timeoutMs + SUPERVISOR_FALLBACK_MS);
            fallback.unref();
            executionWrite = executionLease(binding, profileId, pid).then(record => {
                durableRecords.lease = record;
                if (dispatchSettled || closeObserved)
                    return;
                const deadline = performance.now() + binding.timeoutMs;
                deadlineAtMs = deadline;
                timeoutObservation = setTimeout(() => { timedOut = true; }, Math.max(0, deadline - performance.now()));
                timeoutObservation.unref();
                try {
                    child.stdin.write('START\n', error => {
                        if (dispatchSettled)
                            return;
                        if (closeObserved) {
                            rejectDispatch(new Error('official DSH recovery supervisor closed before its start dispatch became durable'));
                            return;
                        }
                        if (error !== undefined && error !== null) {
                            rejectDispatch(new Error('official DSH recovery supervisor start dispatch failed', { cause: error }));
                            return;
                        }
                        const candidate = executionDispatch(record);
                        durableRecords.dispatch = candidate;
                        dispatchWrite = writeExclusive(candidate.path, candidate.value).then(() => {
                            durableRecords.dispatchDurable = true;
                            if (!closeObserved)
                                resolveDispatch();
                        }, cause => {
                            rejectDispatch(new Error('official DSH recovery supervisor start dispatch could not be recorded', { cause }));
                        });
                    });
                }
                catch (cause) {
                    rejectDispatch(new Error('official DSH recovery supervisor start dispatch failed', { cause }));
                    return;
                }
            }, cause => {
                rejectDispatch(cause);
            });
        });
        child.once('exit', () => {
            exitObserved = true;
            if (fallback !== null) {
                clearTimeout(fallback);
                fallback = null;
            }
        });
        child.once('close', (code, signal) => {
            if (fallback !== null) {
                clearTimeout(fallback);
                fallback = null;
            }
            if (timeoutObservation !== null) {
                clearTimeout(timeoutObservation);
                timeoutObservation = null;
            }
            closeObserved = true;
            rejectDispatch(new Error('official DSH recovery supervisor closed before its start dispatch became durable'));
            resolveClose(Object.freeze({ code, signal }));
        });
        let dispatchError;
        try {
            await dispatchPromise;
        }
        catch (cause) {
            dispatchError = cause;
            if (!exitObserved)
                child.stdin.destroy();
        }
        const supervisorOutcome = await closePromise;
        await executionWrite;
        await dispatchWrite;
        const pid = child.pid;
        processGroupQuiescent = pid === undefined || await waitForProcessGroupQuiescence(pid);
        if (!processGroupQuiescent) {
            throw new Error('official DSH recovery supervisor process group did not reach quiescence; durable execution fence retained');
        }
        if (dispatchError !== undefined)
            throw dispatchError;
        if (launchError !== undefined)
            throw new Error(`official DSH recovery ${label} could not start`, { cause: launchError });
        const deadlineExpired = deadlineAtMs !== null && (timedOut || (outcomeObservedAtMs === null
            ? performance.now() >= deadlineAtMs
            : outcomeObservedAtMs >= deadlineAtMs));
        if (deadlineExpired) {
            throw new Error(`official DSH recovery ${label} timed out`);
        }
        if (childOutcomeReadError !== undefined) {
            throw new Error('official DSH recovery supervisor child outcome could not be read', { cause: childOutcomeReadError });
        }
        if (childOutcomeOverflow)
            failure('official DSH recovery supervisor child outcome is not one bounded JSON record');
        const childOutcome = childOutcomeBytes === 0
            ? null
            : decodeSupervisorChildOutcome(Buffer.concat(childOutcomeChunks, childOutcomeBytes), 'official DSH recovery supervisor child outcome');
        if (childOutcome === null) {
            if (supervisorOutcome.code === 125)
                throw new Error(`official DSH recovery ${label} lost its parent`);
            throw new Error(`official DSH recovery ${label} supervisor closed without a child outcome`);
        }
        if (supervisorOutcome.code !== null || supervisorOutcome.signal !== 'SIGKILL') {
            throw new Error(`official DSH recovery ${label} supervisor did not terminate its process group after publishing the child outcome`);
        }
        if (childOutcome.launchError) {
            throw new Error(`official DSH recovery ${label} could not start`);
        }
        if (childOutcome.code === 124) {
            throw new Error(`official DSH recovery ${label} timed out`);
        }
        else if (childOutcome.code === 0) {
            // Continue with post-mutation verification only after dispatch and group quiescence are both proven.
        }
        else {
            const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
                || `exit=${String(childOutcome.code)} signal=${String(childOutcome.signal)}`;
            throw new Error(`official DSH recovery ${label} failed: ${detail}`);
        }
        const auditedProfilePath = await auditProfileExecution(binding, profileId);
        const observedStore = await readInstalledProfileStore(auditedProfilePath);
        if (observedStore !== null && observedStore !== runtime.expectedStore
            || installedStore !== null && observedStore === null) {
            failure('official DSH recovery Profile pnpm modules metadata storeDir changed during mutation');
        }
        await verifyMetadataCache(binding, metadataCache);
        await verifyOfficialDsh(binding);
    }
    finally {
        const lease = durableRecords.lease;
        const dispatch = durableRecords.dispatch;
        if (lease !== null && processGroupQuiescent) {
            if (dispatch === null) {
                const unexpected = await readOptionalRecord(join(dirname(lease.path), 'execution-dispatch.json'), MAX_POINTER_BYTES, 'official DSH recovery execution dispatch');
                if (unexpected !== undefined)
                    failure('official DSH recovery execution dispatch has no exact attempt');
            }
            else {
                await clearExecutionRecord(dispatch, 'official DSH recovery execution dispatch', !durableRecords.dispatchDurable);
            }
            await clearExecutionRecord(lease, 'official DSH recovery execution lease', false);
        }
        if (lease === null || processGroupQuiescent) {
            const canonical = await realpath(runtime.directory).catch(() => null);
            if (canonical === runtime.directory)
                await rm(runtime.directory, { recursive: true });
        }
    }
}
function validateJson(value, label, depth = 0, budget = { nodes: 0 }) {
    budget.nodes += 1;
    if (budget.nodes > 4_096 || depth > 16)
        failure(`${label} exceeds the JSON complexity bound`);
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            failure(`${label} contains a non-finite number`);
        return;
    }
    if (Array.isArray(value)) {
        if (value.length > 256)
            failure(`${label} exceeds the JSON array bound`);
        value.forEach((item, index) => validateJson(item, `${label}[${String(index)}]`, depth + 1, budget));
        return;
    }
    if (!isRecord(value) || Object.keys(value).length > 128)
        failure(`${label} is not bounded JSON`);
    for (const key of Object.keys(value)) {
        if (key.length === 0 || key.length > 128)
            failure(`${label} contains an invalid key`);
        validateJson(value[key], `${label}.${key}`, depth + 1, budget);
    }
}
function decodePluginKindState(value, extensionId, label) {
    if (!isRecord(value))
        failure(`${label} must be an object`);
    const fields = ['consumerObserved', 'restartObserved', 'loaderPhase', 'packageName', 'restartToken', 'treeDigest'];
    const hasEvidence = Object.hasOwn(value, 'runtimeEvidence');
    const hasRollback = Object.hasOwn(value, 'rollbackOperationId');
    const record = strictRecord(value, [
        ...fields,
        ...(hasRollback ? ['rollbackOperationId'] : []),
        ...(hasEvidence ? ['runtimeEvidence'] : []),
    ], label);
    const phase = literal(record.loaderPhase, ['absent', 'active', 'pending-restart'], `${label}.loaderPhase`);
    if (record.packageName !== extensionId || typeof record.consumerObserved !== 'boolean'
        || typeof record.restartObserved !== 'boolean') {
        failure(`${label} does not bind the managed Plugin`);
    }
    boundedString(record.restartToken, `${label}.restartToken`, 512);
    if (hasRollback)
        boundedString(record.rollbackOperationId, `${label}.rollbackOperationId`, 512);
    digest(record.treeDigest, `${label}.treeDigest`);
    if (phase === 'pending-restart') {
        if (record.consumerObserved || record.restartObserved || hasEvidence)
            failure(`${label} has contradictory pending evidence`);
    }
    else {
        if (!record.consumerObserved || !record.restartObserved || !hasEvidence)
            failure(`${label} has incomplete settled evidence`);
        const evidence = strictRecord(record.runtimeEvidence, ['entryId', 'fiberPhase', 'moduleName'], `${label}.runtimeEvidence`);
        boundedString(evidence.entryId, `${label}.runtimeEvidence.entryId`, 512);
        boundedString(evidence.moduleName, `${label}.runtimeEvidence.moduleName`, 4_096);
        if (evidence.fiberPhase !== phase)
            failure(`${label}.runtimeEvidence does not bind loaderPhase`);
    }
}
function decodeVersion(value, root, targetKey, label) {
    if (value === null)
        return null;
    const record = strictRecord(value, [
        'candidateRef', 'artifactRevision', 'artifactIntegrity', 'materialPath', 'configuration', 'enabled',
        'ownerRevision', 'kindState',
    ], label);
    const candidateRef = boundedString(record.candidateRef, `${label}.candidateRef`, 256);
    if (!candidateRef.startsWith('plugin:'))
        failure(`${label}.candidateRef is not a Plugin reference`);
    boundedString(record.artifactRevision, `${label}.artifactRevision`, 256);
    if (typeof record.artifactIntegrity !== 'string' || !ARTIFACT_INTEGRITY.test(record.artifactIntegrity)) {
        failure(`${label}.artifactIntegrity is invalid`);
    }
    const materialPath = boundedString(record.materialPath, `${label}.materialPath`, 4_096);
    const expectedPath = join(root, 'material', 'plugins', storageKey(targetKey), storageKey(record.artifactIntegrity));
    if (!isAbsolute(materialPath) || materialPath !== expectedPath)
        failure(`${label}.materialPath does not bind its target and artifact`);
    if (typeof record.enabled !== 'boolean')
        failure(`${label}.enabled must be boolean`);
    validateJson(record.configuration, `${label}.configuration`);
    decodePluginKindState(record.kindState, targetKey.slice(targetKey.lastIndexOf(':') + 1), `${label}.kindState`);
    const ownerRevision = boundedString(record.ownerRevision, `${label}.ownerRevision`, 512);
    if (!ownerRevision.startsWith('managed-plugin:'))
        failure(`${label}.ownerRevision does not bind the Plugin owner`);
    return record;
}
function decodeManaged(value, root, expected, targetKey, label) {
    const record = strictRecord(value, [
        'schemaVersion', 'kind', 'extensionId', 'targetKey', 'scopeKey', 'profileId', 'revision', 'lastOperationId',
        'current', 'lastGood', 'removed', 'pending', 'updatedAtMs',
    ], label);
    if (record.schemaVersion !== 1 || record.kind !== 'plugin' || record.extensionId !== expected.extensionId
        || record.targetKey !== targetKey || record.scopeKey !== expected.scopeKey || record.profileId !== expected.profileId) {
        failure(`${label} identity does not bind the Plugin journal`);
    }
    safeInteger(record.revision, `${label}.revision`, 1);
    if (record.lastOperationId !== null)
        boundedString(record.lastOperationId, `${label}.lastOperationId`, 512);
    decodeVersion(record.current, root, targetKey, `${label}.current`);
    decodeVersion(record.lastGood, root, targetKey, `${label}.lastGood`);
    decodeVersion(record.removed, root, targetKey, `${label}.removed`);
    if (record.pending !== null) {
        const pending = strictRecord(record.pending, [
            'generation', 'operationId', 'operationKind', 'packageName', 'profileId', 'revision', 'treeDigest',
        ], `${label}.pending`);
        boundedString(pending.operationId, `${label}.pending.operationId`, 512);
        if (pending.operationId !== record.lastOperationId
            || pending.profileId !== expected.profileId || pending.packageName !== expected.extensionId) {
            failure(`${label}.pending does not bind the Plugin journal`);
        }
    }
    safeInteger(record.updatedAtMs, `${label}.updatedAtMs`);
    return record;
}
function managedStateDigest(record) {
    if (record === null)
        return canonicalDigest(null);
    return canonicalDigest({
        kind: record.kind,
        extensionId: record.extensionId,
        targetKey: record.targetKey,
        scopeKey: record.scopeKey,
        profileId: record.profileId,
        current: record.current,
        lastGood: record.lastGood,
        removed: record.removed,
        pending: record.pending,
    });
}
function materialPath(record, field) {
    const version = record[field];
    return version === null ? null : version.materialPath;
}
function decodeSidecar(value, root, expected, targetKey, label) {
    const record = strictRecord(value, [
        'schemaVersion', 'profileId', 'packageName', 'targetKey', 'revision', 'lastOperationId', 'managed',
        'loaderEntryId', 'loaderName', 'restartPending', 'lastGoodMaterialPath', 'tombstoneMaterialPath',
    ], label);
    if (record.schemaVersion !== 1 || record.profileId !== expected.profileId || record.packageName !== expected.extensionId
        || record.targetKey !== targetKey || typeof record.restartPending !== 'boolean') {
        failure(`${label} identity does not bind the Plugin journal`);
    }
    nullableString(record.loaderEntryId, `${label}.loaderEntryId`, 512);
    nullableString(record.loaderName, `${label}.loaderName`, 4_096);
    const managed = decodeManaged(record.managed, root, expected, targetKey, `${label}.managed`);
    if (record.revision !== managed.revision || record.lastOperationId !== managed.lastOperationId
        || record.lastGoodMaterialPath !== materialPath(managed, 'lastGood')
        || record.tombstoneMaterialPath !== materialPath(managed, 'removed')) {
        failure(`${label} does not bind its managed record`);
    }
    return record;
}
function decodeProviderSnapshot(value, root, journal) {
    const record = strictRecord(value, [
        'schemaVersion', 'operationId', 'targetKey', 'before', 'beforeDigest', 'recoveryPoint',
    ], 'Plugin provider snapshot');
    if (record.schemaVersion !== 1 || record.operationId !== journal.operationId || record.targetKey !== journal.targetKey) {
        failure('Plugin provider snapshot identity does not bind the journal');
    }
    const before = record.before === null
        ? null
        : decodeManaged(record.before, root, journal.opening, journal.targetKey, 'Plugin provider snapshot.before');
    const beforeDigest = digest(record.beforeDigest, 'Plugin provider snapshot.beforeDigest');
    if (beforeDigest !== managedStateDigest(before) || beforeDigest !== journal.opening.beforeDigest) {
        failure('Plugin provider snapshot before-state does not bind the journal');
    }
    const point = strictRecord(record.recoveryPoint, ['artifactPath', 'kind', 'metadataCache', 'snapshot'], 'Plugin recovery point');
    if (point.kind !== 'plugin')
        failure('Plugin recovery point is invalid');
    if (point.artifactPath !== null) {
        const artifactPath = boundedString(point.artifactPath, 'Plugin recovery point artifactPath', 4_096);
        if (!isAbsolute(artifactPath) || !below(join(root, 'artifacts'), artifactPath) || !artifactPath.endsWith('.tgz')) {
            failure('Plugin recovery point artifact is outside Center storage');
        }
    }
    const snapshot = strictRecord(point.snapshot, [
        'bootStatus', 'digest', 'materialRoot', 'ownerRevision', 'profileId', 'revision',
    ], 'Plugin recovery point snapshot');
    const revision = safeInteger(snapshot.revision, 'Plugin recovery point snapshot.revision');
    const snapshotDigest = digest(snapshot.digest, 'Plugin recovery point snapshot.digest');
    if (snapshot.profileId !== journal.opening.profileId || snapshot.materialRoot !== join(root, 'material', 'plugins')
        || snapshot.ownerRevision !== `managed-plugin:${String(revision)}:${snapshotDigest}`) {
        failure('Plugin recovery point snapshot does not bind Center-owned state');
    }
    literal(snapshot.bootStatus, ['live', 'pending-restart', 'verified'], 'Plugin recovery point snapshot.bootStatus');
    if (point.metadataCache === null)
        failure('Plugin recovery point has no metadata cache binding');
    const metadataCache = decodeMetadataCache(point.metadataCache, journal.opening.recoveryExecutable.officialDsh, journal.opening.profileId);
    return Object.freeze({ operationId: journal.operationId, targetKey: journal.targetKey, before, beforeDigest,
        digest: canonicalDigest(record), metadataCache });
}
function packageSegments(name) {
    if (name.length > 214 || !PACKAGE_NAME.test(name) || name === '.' || name === '..') {
        failure(`managed Plugin package name is unsafe: ${name}`);
    }
    return name.split('/');
}
function safeArchivePath(value, label) {
    const path = boundedString(value, label, 4_096);
    if (path.includes('\\') || path.startsWith('/') || path.endsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')
        || path === 'node_modules' || path.startsWith('node_modules/')) {
        failure(`${label} is unsafe`);
    }
    return path;
}
function decodeMaterialMarker(value, root, targetKey, packageName, version) {
    const record = strictRecord(value, [
        'schemaVersion', 'targetKey', 'packageName', 'version', 'integrity', 'artifactPath', 'artifactSizeBytes',
        'artifactSha256', 'manifestDigest', 'files',
    ], 'managed Plugin material marker');
    const artifactRevision = boundedString(version.artifactRevision, 'managed Plugin version artifactRevision', 256);
    const artifactIntegrity = boundedString(version.artifactIntegrity, 'managed Plugin version artifactIntegrity', 256);
    const artifactPath = boundedString(record.artifactPath, 'managed Plugin material marker artifactPath', 4_096);
    const artifactSizeBytes = safeInteger(record.artifactSizeBytes, 'managed Plugin material marker artifactSizeBytes', 1);
    if (record.schemaVersion !== 1 || record.targetKey !== targetKey || record.packageName !== packageName
        || record.version !== artifactRevision || record.integrity !== artifactIntegrity
        || !ARTIFACT_INTEGRITY.test(artifactIntegrity) || !isAbsolute(artifactPath)
        || !below(join(root, 'artifacts'), artifactPath) || !artifactPath.endsWith('.tgz')
        || artifactSizeBytes > MAX_ARTIFACT_BYTES || !Array.isArray(record.files)
        || record.files.length === 0 || record.files.length > 4_096) {
        failure('managed Plugin material marker identity is invalid');
    }
    const files = record.files.map((item, index) => {
        const file = strictRecord(item, ['path', 'sha256', 'sizeBytes'], `managed Plugin material marker files[${String(index)}]`);
        return Object.freeze({
            path: safeArchivePath(file.path, `managed Plugin material marker files[${String(index)}].path`),
            sizeBytes: safeInteger(file.sizeBytes, `managed Plugin material marker files[${String(index)}].sizeBytes`),
            sha256: digest(file.sha256, `managed Plugin material marker files[${String(index)}].sha256`),
        });
    });
    if (files.some((file, index) => index > 0 && files[index - 1].path >= file.path)) {
        failure('managed Plugin material marker files are not strictly sorted');
    }
    return Object.freeze({
        schemaVersion: 1,
        targetKey,
        packageName,
        version: artifactRevision,
        integrity: artifactIntegrity,
        artifactPath,
        artifactSizeBytes,
        artifactSha256: digest(record.artifactSha256, 'managed Plugin material marker artifactSha256'),
        manifestDigest: digest(record.manifestDigest, 'managed Plugin material marker manifestDigest'),
        files: Object.freeze(files),
    });
}
async function verifyArtifact(marker) {
    const bytes = await readRegularNoFollow(marker.artifactPath, MAX_ARTIFACT_BYTES, 'managed Plugin retained artifact');
    if (bytes.length !== marker.artifactSizeBytes || fileDigest(bytes) !== marker.artifactSha256) {
        failure('managed Plugin retained artifact does not match its material marker');
    }
    const match = /^(sha256|sha512):([0-9a-f]+|[A-Za-z0-9+/]+={0,2})$/u.exec(marker.integrity);
    if (match === null)
        failure('managed Plugin retained artifact integrity is invalid');
    const hexadecimal = /^[0-9a-f]+$/u.test(match[2]);
    const observed = createHash(match[1]).update(bytes).digest(hexadecimal ? 'hex' : 'base64');
    if (observed !== match[2])
        failure('managed Plugin retained artifact changed after admission');
}
async function collectPackageFiles(root, current, ignoreNodeModules) {
    const output = [];
    const entries = (await readdir(current, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        if (ignoreNodeModules && current === root && entry.name === 'node_modules')
            continue;
        const path = join(current, entry.name);
        const relativePath = relative(root, path).split(sep).join('/');
        if (entry.isSymbolicLink())
            failure(`managed Plugin package contains an unexpected symbolic link: ${relativePath}`);
        if (entry.isDirectory())
            output.push(...await collectPackageFiles(root, path, ignoreNodeModules));
        else if (entry.isFile())
            output.push(relativePath);
        else
            failure(`managed Plugin package contains an unsupported entry: ${relativePath}`);
    }
    return output;
}
async function packageTreeMatches(packageRoot, marker, ignoreNodeModules) {
    let canonicalRoot;
    try {
        canonicalRoot = await realpath(packageRoot);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
    const rootInfo = await lstat(canonicalRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        failure('managed Plugin package root is unsafe');
    const paths = await collectPackageFiles(canonicalRoot, canonicalRoot, ignoreNodeModules);
    if (paths.length !== marker.files.length || paths.some((path, index) => path !== marker.files[index].path))
        return false;
    for (const file of marker.files) {
        const bytes = await readRegularNoFollow(join(canonicalRoot, ...file.path.split('/')), MAX_ARTIFACT_BYTES, `managed Plugin package ${file.path}`);
        if (bytes.length !== file.sizeBytes || fileDigest(bytes) !== file.sha256)
            return false;
    }
    let manifest;
    try {
        manifest = JSON.parse((await readFile(join(canonicalRoot, 'package.json'))).toString('utf8'));
    }
    catch {
        return false;
    }
    if (!isRecord(manifest) || manifest.name !== marker.packageName || manifest.version !== marker.version
        || canonicalDigest(manifest) !== marker.manifestDigest || !isRecord(manifest.dsh)
        || !isRecord(manifest.dsh.bundle) || typeof manifest.dsh.bundle.patch !== 'string')
        return false;
    const declaredPatch = manifest.dsh.bundle.patch;
    if (declaredPatch.includes('\\') || declaredPatch.startsWith('/'))
        return false;
    const patchPath = safeArchivePath(declaredPatch.replace(/^\.\//u, ''), 'managed Plugin bundle patch');
    return marker.files.some(file => file.path === patchPath);
}
async function materialMarker(root, targetKey, packageName, version) {
    const materialPath = boundedString(version.materialPath, 'managed Plugin version materialPath', 4_096);
    const expectedPath = join(root, 'material', 'plugins', storageKey(targetKey), storageKey(boundedString(version.artifactIntegrity, 'managed Plugin version artifactIntegrity', 256)));
    if (materialPath !== expectedPath)
        failure('managed Plugin version material path is invalid');
    const markerValue = await readOptionalRecord(`${materialPath}.owner.json`, MAX_STATE_BYTES, 'managed Plugin material marker');
    if (markerValue === undefined)
        failure('managed Plugin material marker is absent');
    const marker = decodeMaterialMarker(markerValue, root, targetKey, packageName, version);
    await verifyArtifact(marker);
    if (!await packageTreeMatches(materialPath, marker, false)) {
        failure('managed Plugin retained material does not match its marker');
    }
    return marker;
}
async function readProfileObservation(binding, profileId, packageName) {
    const profilePath = join(binding.hostHome, 'profiles', profileId);
    let profileInfo;
    try {
        profileInfo = await lstat(profilePath);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return Object.freeze({ profileExists: false, dependency: null, bundleCount: 0 });
        }
        throw error;
    }
    if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink() || await realpath(profilePath) !== profilePath) {
        failure('official DSH recovery Profile directory is unsafe');
    }
    const manifestPath = join(profilePath, 'package.json');
    const bytes = await readRegularNoFollow(manifestPath, MAX_STATE_BYTES, 'official DSH recovery Profile manifest');
    let manifest;
    try {
        manifest = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        failure('official DSH recovery Profile manifest is invalid JSON');
    }
    if (!isRecord(manifest))
        failure('official DSH recovery Profile manifest is invalid');
    const dependencyValue = isRecord(manifest.dependencies) ? manifest.dependencies[packageName] : undefined;
    if (dependencyValue !== undefined && (typeof dependencyValue !== 'string' || dependencyValue.length === 0)) {
        failure('official DSH recovery Profile dependency is invalid');
    }
    const bundles = isRecord(manifest.dsh) && isRecord(manifest.dsh.profile) ? manifest.dsh.profile.bundles : undefined;
    if (bundles !== undefined && (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string'))) {
        failure('official DSH recovery Profile bundle list is invalid');
    }
    return Object.freeze({
        profileExists: true,
        dependency: dependencyValue ?? null,
        bundleCount: Array.isArray(bundles) ? bundles.filter(item => item === packageName).length : 0,
    });
}
function currentVersion(record) {
    return record?.current ?? null;
}
async function physicalStatus(root, binding, profileId, packageName, targetKey, record) {
    const observation = await readProfileObservation(binding, profileId, packageName);
    const version = currentVersion(record);
    if (version === null) {
        if (observation.dependency !== null)
            return 'mismatch';
        return observation.bundleCount === 0 ? 'exact' : observation.bundleCount === 1 ? 'partial' : 'mismatch';
    }
    if (observation.dependency === null || !observation.profileExists)
        return 'mismatch';
    const marker = await materialMarker(root, targetKey, packageName, version);
    if (observation.dependency !== `file:${marker.artifactPath}` || observation.bundleCount > 1)
        return 'mismatch';
    const installedPath = join(binding.hostHome, 'profiles', profileId, 'node_modules', ...packageSegments(packageName));
    if (!await packageTreeMatches(installedPath, marker, true))
        return 'mismatch';
    return observation.bundleCount === 1 ? 'exact' : 'partial';
}
function retainedVersion(record) {
    return record.current ?? record.removed ?? record.lastGood;
}
async function restoreOfficialProfile(root, binding, journal, metadataCache, source, restored) {
    const { profileId, extensionId: packageName } = journal.opening;
    const restoredStatus = await physicalStatus(root, binding, profileId, packageName, journal.targetKey, restored);
    if (restoredStatus === 'exact')
        return;
    const sourceStatus = await physicalStatus(root, binding, profileId, packageName, journal.targetKey, source);
    if (sourceStatus === 'mismatch')
        failure('official DSH Profile changed outside the recovery operation');
    const desired = currentVersion(restored);
    if (desired !== null) {
        const marker = await materialMarker(root, journal.targetKey, packageName, desired);
        await runOfficialDsh(binding, profileId, [
            'plugin', `--profile=${profileId}`, 'add', marker.artifactPath, '--save-exact',
        ], `add ${packageName}@${marker.version}`, metadataCache);
    }
    else {
        let observed = await readProfileObservation(binding, profileId, packageName);
        if (observed.dependency === null && observed.bundleCount === 1) {
            const repair = retainedVersion(source);
            if (repair === null)
                failure('official DSH Profile stale bundle has no retained repair artifact');
            const marker = await materialMarker(root, journal.targetKey, packageName, repair);
            await runOfficialDsh(binding, profileId, [
                'plugin', `--profile=${profileId}`, 'add', marker.artifactPath, '--save-exact',
            ], `repair ${packageName}@${marker.version}`, metadataCache);
            observed = await readProfileObservation(binding, profileId, packageName);
        }
        if (observed.dependency !== null || observed.bundleCount > 0) {
            await runOfficialDsh(binding, profileId, ['plugin', `--profile=${profileId}`, 'remove', packageName], `remove ${packageName}`, metadataCache);
        }
    }
    if (await physicalStatus(root, binding, profileId, packageName, journal.targetKey, restored) !== 'exact') {
        failure('official DSH Profile did not reach the exact recovery before-state');
    }
}
function statePaths(root, journal) {
    return Object.freeze({
        managed: join(root, 'state', 'managed', `${storageKey(journal.targetKey)}.json`),
        sidecar: join(root, 'plugin', 'profiles', storageKey(journal.opening.profileId), 'packages', `${storageKey(journal.targetKey)}.json`),
        transaction: join(root, 'recovery', 'transactions', `${storageKey(journal.operationId)}.json`),
        evidence: join(root, 'plugin', 'break-glass-restores', `${storageKey(journal.operationId)}.json`),
        absentRollback: join(root, 'plugin', 'absent-rollbacks', `${storageKey(journal.operationId)}.json`),
    });
}
function restoreEvidence(journal, snapshot, restored) {
    return Object.freeze({
        schemaVersion: 1,
        operationId: journal.operationId,
        targetKey: journal.targetKey,
        profileId: journal.opening.profileId,
        packageName: journal.opening.extensionId,
        journalHeadDigest: journal.headDigest,
        providerSnapshotDigest: snapshot.digest,
        beforeDigest: snapshot.beforeDigest,
        restoredManagedDigest: managedStateDigest(restored),
        restoredRevision: restored?.revision ?? null,
        status: 'settled',
    });
}
function restoredState(source, snapshot, journal, nowMs) {
    if (snapshot.before === null)
        return Object.freeze({ managed: null, sidecar: null });
    if (source.managed.revision < snapshot.before.revision)
        failure('managed Plugin revision moved behind its provider snapshot');
    const managed = {
        ...snapshot.before,
        revision: source.managed.revision + 1,
        lastOperationId: journal.operationId,
        pending: null,
        updatedAtMs: nowMs,
    };
    const sidecar = {
        schemaVersion: 1,
        profileId: managed.profileId,
        packageName: source.packageName,
        targetKey: managed.targetKey,
        revision: managed.revision,
        lastOperationId: managed.lastOperationId,
        managed,
        loaderEntryId: null,
        loaderName: null,
        restartPending: true,
        lastGoodMaterialPath: materialPath(managed, 'lastGood'),
        tombstoneMaterialPath: materialPath(managed, 'removed'),
    };
    return Object.freeze({ managed, sidecar });
}
function decodeRestoreEvidence(value, journal, snapshot, restored, label) {
    const record = strictRecord(value, [
        'schemaVersion', 'operationId', 'targetKey', 'profileId', 'packageName', 'journalHeadDigest',
        'providerSnapshotDigest', 'beforeDigest', 'restoredManagedDigest', 'restoredRevision', 'status',
    ], label);
    if (record.schemaVersion !== 1 || record.operationId !== journal.operationId || record.targetKey !== journal.targetKey
        || record.profileId !== journal.opening.profileId || record.packageName !== journal.opening.extensionId
        || record.journalHeadDigest !== journal.headDigest || record.providerSnapshotDigest !== snapshot.digest
        || record.beforeDigest !== snapshot.beforeDigest || record.restoredManagedDigest !== snapshot.beforeDigest
        || record.restoredManagedDigest !== managedStateDigest(restored) || record.status !== 'settled'
        || record.restoredRevision !== (restored?.revision ?? null)) {
        failure(`${label} does not bind the exact recovery before-state`);
    }
    if (record.restoredRevision !== null)
        safeInteger(record.restoredRevision, `${label}.restoredRevision`, 1);
    return record;
}
function decodeTransaction(value, root, journal, snapshot) {
    const record = strictRecord(value, [
        'schemaVersion', 'operationId', 'targetKey', 'profileId', 'journalHeadDigest', 'providerSnapshotDigest',
        'sourceManaged', 'sourceManagedDigest', 'sourceSidecar', 'sourceSidecarDigest', 'restoredManaged', 'restoredSidecar',
        'recoveryEvidence', 'recoveryEvidenceDigest', 'preparedAtMs', 'committedAtMs', 'status',
    ], 'Plugin recovery transaction');
    if (record.schemaVersion !== 1 || record.operationId !== journal.operationId || record.targetKey !== journal.targetKey
        || record.profileId !== journal.opening.profileId || record.journalHeadDigest !== journal.headDigest
        || record.providerSnapshotDigest !== snapshot.digest) {
        failure('Plugin recovery transaction does not bind the verified recovery inputs');
    }
    const sourceManaged = record.sourceManaged === null
        ? null
        : decodeManaged(record.sourceManaged, root, journal.opening, journal.targetKey, 'Plugin recovery transaction.sourceManaged');
    const sourceManagedDigest = record.sourceManagedDigest === null
        ? null
        : digest(record.sourceManagedDigest, 'Plugin recovery transaction.sourceManagedDigest');
    if ((sourceManaged === null) !== (sourceManagedDigest === null)
        || sourceManaged !== null && canonicalDigest(sourceManaged) !== sourceManagedDigest) {
        failure('Plugin recovery transaction managed backup does not match its digest');
    }
    const sourceSidecar = decodeSidecar(record.sourceSidecar, root, journal.opening, journal.targetKey, 'Plugin recovery transaction.sourceSidecar');
    if (canonicalDigest(sourceSidecar) !== digest(record.sourceSidecarDigest, 'Plugin recovery transaction.sourceSidecarDigest')) {
        failure('Plugin recovery transaction sidecar backup does not match its digest');
    }
    if (sourceSidecar.lastOperationId !== journal.operationId
        || sourceSidecar.managed.lastOperationId !== journal.operationId) {
        failure('Plugin recovery transaction backup does not bind the recovery operation');
    }
    if (sourceManaged !== null) {
        const same = canonicalJson(sourceManaged) === canonicalJson(sourceSidecar.managed);
        if (!same && sourceSidecar.revision !== sourceManaged.revision + 1) {
            failure('Plugin recovery transaction backups contain divergent owner state');
        }
    }
    safeInteger(record.preparedAtMs, 'Plugin recovery transaction.preparedAtMs');
    const status = literal(record.status, ['prepared', 'committed'], 'Plugin recovery transaction.status');
    if ((status === 'prepared') !== (record.committedAtMs === null)) {
        failure('Plugin recovery transaction status is inconsistent');
    }
    if (record.committedAtMs !== null)
        safeInteger(record.committedAtMs, 'Plugin recovery transaction.committedAtMs');
    const managed = record.restoredManaged === null
        ? null
        : decodeManaged(record.restoredManaged, root, journal.opening, journal.targetKey, 'Plugin recovery transaction.restoredManaged');
    const sidecar = record.restoredSidecar === null
        ? null
        : decodeSidecar(record.restoredSidecar, root, journal.opening, journal.targetKey, 'Plugin recovery transaction.restoredSidecar');
    if ((managed === null) !== (sidecar === null) || managed !== null && canonicalJson(managed) !== canonicalJson(sidecar.managed)
        || managedStateDigest(managed) !== snapshot.beforeDigest) {
        failure('Plugin recovery transaction does not restore the provider before-state');
    }
    if (managed !== null && (managed.revision !== sourceSidecar.revision + 1
        || managed.lastOperationId !== journal.operationId || managed.pending !== null)) {
        failure('Plugin recovery transaction does not advance the restored revision exactly once');
    }
    const recoveryEvidence = decodeRestoreEvidence(record.recoveryEvidence, journal, snapshot, managed, 'Plugin recovery transaction evidence');
    if (canonicalDigest(recoveryEvidence) !== digest(record.recoveryEvidenceDigest, 'Plugin recovery transaction evidence digest'))
        failure('Plugin recovery transaction evidence digest does not match');
    return record;
}
function sameProcessIdentity(left, right) {
    return left.schemaVersion === right.schemaVersion && left.pid === right.pid && left.platform === right.platform
        && left.machineDigest === right.machineDigest && left.bootDigest === right.bootDigest
        && left.birthDigest === right.birthDigest;
}
function sameProfileLockOwner(left, right) {
    return left.schemaVersion === right.schemaVersion && left.profileId === right.profileId
        && left.ownerId === right.ownerId && left.leaseId === right.leaseId && left.acquiredAtMs === right.acquiredAtMs
        && sameProcessIdentity(left.processIdentity, right.processIdentity);
}
function processGroupStatus(processGroupPid) {
    if (process.platform === 'win32')
        return 'unknown';
    try {
        process.kill(-processGroupPid, 0);
        return 'alive';
    }
    catch (error) {
        const code = error.code;
        if (code === 'EPERM')
            return 'alive';
        if (code === 'ESRCH')
            return 'dead';
        return 'unknown';
    }
}
async function waitForProcessGroupQuiescence(processGroupPid) {
    const deadline = performance.now() + PROCESS_GROUP_QUIESCENCE_MS;
    for (;;) {
        const status = processGroupStatus(processGroupPid);
        if (status === 'dead')
            return true;
        if (status === 'unknown')
            return false;
        if (performance.now() >= deadline)
            return false;
        await new Promise(resolveDelay => setTimeout(resolveDelay, PROCESS_GROUP_POLL_MS));
    }
}
async function assertProfileLeaseEntries(path) {
    const allowed = new Set(['owner.json', 'execution.json', 'execution-dispatch.json']);
    for (const entry of await readdir(path, { withFileTypes: true })) {
        if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
            failure('managed Plugin profile lock contains foreign state');
        }
    }
}
async function assertProfileExecutionDead(destination, owner, profileId) {
    await assertProfileLeaseEntries(destination);
    const [executionValue, dispatchValue] = await Promise.all([
        readOptionalRecord(join(destination, 'execution.json'), MAX_POINTER_BYTES, 'Plugin recovery held execution'),
        readOptionalRecord(join(destination, 'execution-dispatch.json'), MAX_POINTER_BYTES, 'Plugin recovery held execution dispatch'),
    ]);
    if (executionValue === undefined) {
        if (dispatchValue !== undefined)
            failure('managed Plugin profile execution dispatch has no execution lease');
        return;
    }
    const execution = strictRecord(executionValue, [
        'schemaVersion', 'profileId', 'ownerId', 'parentPid', 'processGroupPid', 'supervisorSha256', 'startedAtMs',
    ], 'Plugin recovery held execution');
    if (execution.schemaVersion !== 1 || execution.profileId !== profileId || execution.ownerId !== owner.ownerId
        || execution.parentPid !== owner.processIdentity.pid || !Number.isSafeInteger(execution.processGroupPid)
        || execution.processGroupPid < 1 || !Number.isSafeInteger(execution.startedAtMs)) {
        failure('managed Plugin profile execution lease is corrupt');
    }
    digest(execution.supervisorSha256, 'Plugin recovery held execution.supervisorSha256');
    if (dispatchValue !== undefined) {
        const dispatch = strictRecord(dispatchValue, [
            'schemaVersion', 'profileId', 'ownerId', 'leaseId', 'processGroupPid', 'executionDigest', 'dispatchedAtMs',
        ], 'Plugin recovery held execution dispatch');
        if (dispatch.schemaVersion !== 1 || dispatch.profileId !== profileId || dispatch.ownerId !== owner.ownerId
            || dispatch.leaseId !== owner.leaseId || dispatch.processGroupPid !== execution.processGroupPid
            || dispatch.executionDigest !== canonicalDigest(executionValue) || !Number.isSafeInteger(dispatch.dispatchedAtMs)) {
            failure('managed Plugin profile execution dispatch is corrupt');
        }
    }
    const status = processGroupStatus(execution.processGroupPid);
    if (status === 'alive')
        failure(`managed Plugin profile has a live official CLI subtree: ${profileId}`);
    if (status === 'unknown')
        failure(`managed Plugin profile CLI subtree cannot be verified: ${profileId}`);
}
function profileCoordinationPaths(binding, profileId) {
    const root = join(binding.hostHome, '.extension-center-plugin-coordination');
    const key = storageKey(profileId);
    const locks = join(root, 'leases');
    const takeovers = join(root, 'lease-takeovers');
    const quarantines = join(root, 'lease-quarantine');
    return Object.freeze({
        locks,
        takeovers,
        quarantines,
        destination: join(locks, key),
        takeover: join(takeovers, key),
        profileQuarantine: join(quarantines, key),
    });
}
async function pathStatus(path) {
    try {
        const info = await lstat(path);
        return info.isDirectory() && !info.isSymbolicLink() ? 'directory' : 'other';
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return 'absent';
        throw error;
    }
}
async function readProfileTakeover(path, profileId) {
    const status = await pathStatus(path);
    if (status === 'absent')
        return undefined;
    if (status !== 'directory')
        failure('managed Plugin profile takeover path is unsafe');
    const value = await readOptionalRecord(join(path, 'record.json'), MAX_POINTER_BYTES, 'Plugin recovery takeover');
    if (value === undefined)
        failure('managed Plugin profile takeover is incomplete');
    return decodeProfileTakeover(value, profileId, 'Plugin recovery takeover');
}
async function readAnyProfileTakeover(path) {
    const status = await pathStatus(path);
    if (status === 'absent')
        return undefined;
    if (status !== 'directory')
        failure('managed Plugin profile takeover path is unsafe');
    const value = await readOptionalRecord(join(path, 'record.json'), MAX_POINTER_BYTES, 'Plugin recovery takeover');
    if (value === undefined || !isRecord(value))
        failure('managed Plugin profile takeover is incomplete');
    const profileId = boundedString(value.profileId, 'Plugin recovery takeover.profileId', 256);
    return decodeProfileTakeover(value, profileId, 'Plugin recovery takeover');
}
async function assertNoProfileTakeover(paths, profileId) {
    if (await pathStatus(paths.takeover) !== 'absent' || await pathStatus(paths.profileQuarantine) !== 'absent') {
        failure(`managed Plugin profile is busy: ${profileId}`);
    }
}
async function removeProfileTakeover(paths, record) {
    const current = await readProfileTakeover(paths.takeover, record.profileId);
    if (current === undefined || current.takeoverId !== record.takeoverId
        || canonicalDigest(current) !== canonicalDigest(record)) {
        failure('managed Plugin profile takeover ownership changed');
    }
    await rm(paths.takeover, { recursive: true });
    await removeRetiredProfileTakeovers(paths, record.profileId);
    await syncDirectory(paths.takeovers);
}
async function removeExactProfileTakeoverPath(paths, path, expected) {
    const current = await readProfileTakeover(path, expected.profileId);
    if (current === undefined)
        return;
    if (current.takeoverId !== expected.takeoverId || canonicalDigest(current) !== canonicalDigest(expected)) {
        failure('managed Plugin profile retired takeover ownership changed');
    }
    await rm(path, { recursive: true });
    await syncDirectory(paths.takeovers);
}
async function listProfileTakeovers(paths, profileId) {
    const output = [];
    for (const entry of (await readdir(paths.takeovers, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const canonical = entry.name === storageKey(profileId);
        const retired = /^\.retired-[0-9a-f-]{36}$/u.test(entry.name);
        if (!entry.isDirectory() || !canonical && !retired)
            continue;
        const path = join(paths.takeovers, entry.name);
        const record = canonical
            ? await readProfileTakeover(path, profileId)
            : await readAnyProfileTakeover(path);
        if (record?.profileId !== profileId)
            continue;
        if (record !== undefined)
            output.push(Object.freeze({ path, canonical, record }));
    }
    return Object.freeze(output.sort((left, right) => Number(right.canonical) - Number(left.canonical)));
}
async function removeRetiredProfileTakeovers(paths, profileId) {
    for (const entry of await listProfileTakeovers(paths, profileId)) {
        if (!entry.canonical)
            await removeExactProfileTakeoverPath(paths, entry.path, entry.record);
    }
}
async function installProfileTakeoverRecord(paths, held, claimantOwnerId, claimantProcessIdentity, quarantineId = `quarantine:${randomUUID()}`) {
    const temporary = join(paths.takeovers, `.takeover-${randomUUID()}`);
    const record = Object.freeze({
        schemaVersion: 1,
        profileId: held.profileId,
        sourceLeaseId: held.leaseId,
        sourceOwnerDigest: canonicalDigest(held),
        quarantineId,
        takeoverId: `takeover:${randomUUID()}`,
        claimantOwnerId,
        claimantProcessIdentity,
        claimedAtMs: Date.now(),
    });
    await mkdir(temporary, { mode: 0o700 });
    try {
        await writeExclusive(join(temporary, 'record.json'), record);
        await rename(temporary, paths.takeover);
        await syncDirectory(paths.takeovers);
        return record;
    }
    catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
    }
}
async function acquireProfileTakeover(paths, held, claimantOwnerId, claimantProcessIdentity) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const existing = await readProfileTakeover(paths.takeover, held.profileId);
        if (existing !== undefined) {
            const interrupted = existing.claimantOwnerId === held.ownerId
                && sameProcessIdentity(existing.claimantProcessIdentity, held.processIdentity);
            const sourceMatches = existing.sourceLeaseId === held.leaseId
                && existing.sourceOwnerDigest === canonicalDigest(held);
            if (!sourceMatches && !interrupted) {
                failure('managed Plugin profile takeover does not bind its current owner');
            }
            if (await processIdentityStatus(existing.claimantProcessIdentity) !== 'dead') {
                failure(`managed Plugin profile stale recovery is already owned: ${held.profileId}`);
            }
            const retired = join(paths.takeovers, `.retired-${randomUUID()}`);
            try {
                await rename(paths.takeover, retired);
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    continue;
                throw error;
            }
            await syncDirectory(paths.takeovers);
            try {
                const record = await installProfileTakeoverRecord(paths, held, claimantOwnerId, claimantProcessIdentity, sourceMatches ? existing.quarantineId : undefined);
                await removeExactProfileTakeoverPath(paths, retired, existing);
                return record;
            }
            catch (error) {
                if (['EEXIST', 'ENOTEMPTY'].includes(error.code ?? ''))
                    continue;
                throw error;
            }
        }
        try {
            return await installProfileTakeoverRecord(paths, held, claimantOwnerId, claimantProcessIdentity);
        }
        catch (error) {
            if (['EEXIST', 'ENOTEMPTY'].includes(error.code ?? ''))
                continue;
            throw error;
        }
    }
    failure(`managed Plugin profile stale recovery contention requires manual recovery: ${held.profileId}`);
}
async function assertProfileOwnerDead(destination, owner, profileId) {
    const status = await processIdentityStatus(owner.processIdentity);
    if (status === 'alive')
        failure(`managed Plugin profile is busy: ${profileId}`);
    if (status === 'unknown')
        failure(`managed Plugin profile owner identity cannot be verified: ${profileId}`);
    await assertProfileExecutionDead(destination, owner, profileId);
}
async function installProfileOwner(paths, temporary, owner) {
    await rename(temporary, paths.destination);
    await syncDirectory(paths.locks);
    const installed = decodeProfileLockOwner(await readOptionalRecord(join(paths.destination, 'owner.json'), MAX_POINTER_BYTES, 'Plugin recovery installed lock'), owner.profileId, 'Plugin recovery installed lock');
    if (!sameProfileLockOwner(installed, owner))
        failure(`managed Plugin profile takeover is incomplete: ${owner.profileId}`);
}
async function finishProfileTakeover(paths, record) {
    const current = await readProfileTakeover(paths.takeover, record.profileId);
    if (current === undefined || current.takeoverId !== record.takeoverId
        || canonicalDigest(current) !== canonicalDigest(record)) {
        failure('managed Plugin profile takeover ownership changed');
    }
    await rm(paths.profileQuarantine, { recursive: true });
    await syncDirectory(paths.quarantines);
    await removeProfileTakeover(paths, record);
}
async function takeoverInstalledProfileLock(paths, profileId, claimantOwner, temporary) {
    const held = decodeProfileLockOwner(await readOptionalRecord(join(paths.destination, 'owner.json'), MAX_POINTER_BYTES, 'Plugin recovery held lock'), profileId, 'Plugin recovery held lock');
    await assertProfileOwnerDead(paths.destination, held, profileId);
    const takeover = await acquireProfileTakeover(paths, held, claimantOwner.ownerId, claimantOwner.processIdentity);
    const current = decodeProfileLockOwner(await readOptionalRecord(join(paths.destination, 'owner.json'), MAX_POINTER_BYTES, 'Plugin recovery claimed lock'), profileId, 'Plugin recovery claimed lock');
    if (!sameProfileLockOwner(current, held))
        failure(`managed Plugin profile lock changed during stale recovery: ${profileId}`);
    await assertProfileOwnerDead(paths.destination, current, profileId);
    await ensureRealDirectory(paths.profileQuarantine);
    const quarantine = join(paths.profileQuarantine, takeover.quarantineId.slice('quarantine:'.length));
    await rename(paths.destination, quarantine);
    await syncDirectory(paths.locks);
    await syncDirectory(paths.profileQuarantine);
    const moved = decodeProfileLockOwner(await readOptionalRecord(join(quarantine, 'owner.json'), MAX_POINTER_BYTES, 'Plugin recovery quarantined lock'), profileId, 'Plugin recovery quarantined lock');
    if (!sameProfileLockOwner(moved, held) || takeover.sourceLeaseId !== moved.leaseId
        || takeover.sourceOwnerDigest !== canonicalDigest(moved)) {
        failure(`managed Plugin profile quarantine changed during stale recovery: ${profileId}`);
    }
    await assertProfileOwnerDead(quarantine, moved, profileId);
    await installProfileOwner(paths, temporary, claimantOwner);
    await finishProfileTakeover(paths, takeover);
}
async function resumeProfileTakeover(paths, profileId, claimantOwner, temporary) {
    const entries = await listProfileTakeovers(paths, profileId);
    const quarantineStatus = await pathStatus(paths.profileQuarantine);
    if (entries.length === 0) {
        if (quarantineStatus !== 'absent')
            failure(`managed Plugin profile quarantine requires manual recovery: ${profileId}`);
        return false;
    }
    for (const entry of entries) {
        if (await processIdentityStatus(entry.record.claimantProcessIdentity) !== 'dead') {
            failure(`managed Plugin profile stale recovery is already owned: ${profileId}`);
        }
    }
    const entry = entries[0];
    const existing = entry.record;
    const destinationStatus = await pathStatus(paths.destination);
    if (destinationStatus === 'other')
        failure(`managed Plugin profile lock path is unsafe: ${profileId}`);
    if (destinationStatus === 'directory') {
        await takeoverInstalledProfileLock(paths, profileId, claimantOwner, temporary);
        return true;
    }
    if (quarantineStatus === 'other')
        failure(`managed Plugin profile quarantine path is unsafe: ${profileId}`);
    if (quarantineStatus === 'absent') {
        const canonical = entries.find(candidate => candidate.canonical);
        if (canonical !== undefined)
            await removeProfileTakeover(paths, canonical.record);
        else {
            for (const candidate of entries) {
                await removeExactProfileTakeoverPath(paths, candidate.path, candidate.record);
            }
        }
        return false;
    }
    const quarantine = join(paths.profileQuarantine, existing.quarantineId.slice('quarantine:'.length));
    const held = decodeProfileLockOwner(await readOptionalRecord(join(quarantine, 'owner.json'), MAX_POINTER_BYTES, 'Plugin recovery quarantined lock'), profileId, 'Plugin recovery quarantined lock');
    if (existing.sourceLeaseId !== held.leaseId || existing.sourceOwnerDigest !== canonicalDigest(held)) {
        failure(`managed Plugin profile quarantine does not bind its takeover: ${profileId}`);
    }
    await assertProfileOwnerDead(quarantine, held, profileId);
    const takeover = await acquireProfileTakeover(paths, held, claimantOwner.ownerId, claimantOwner.processIdentity);
    const reread = decodeProfileLockOwner(await readOptionalRecord(join(quarantine, 'owner.json'), MAX_POINTER_BYTES, 'Plugin recovery quarantined lock'), profileId, 'Plugin recovery quarantined lock');
    if (!sameProfileLockOwner(reread, held))
        failure(`managed Plugin profile quarantine changed during recovery: ${profileId}`);
    await assertProfileOwnerDead(quarantine, reread, profileId);
    const finalOwner = decodeProfileLockOwner(await readOptionalRecord(join(quarantine, 'owner.json'), MAX_POINTER_BYTES, 'Plugin recovery quarantined lock'), profileId, 'Plugin recovery quarantined lock');
    if (!sameProfileLockOwner(finalOwner, reread))
        failure(`managed Plugin profile quarantine changed during recovery: ${profileId}`);
    await assertProfileOwnerDead(quarantine, finalOwner, profileId);
    await installProfileOwner(paths, temporary, claimantOwner);
    await finishProfileTakeover(paths, takeover);
    return true;
}
async function acquireProfileLock(binding, profileId) {
    const paths = profileCoordinationPaths(binding, profileId);
    await ensureRealDirectory(paths.locks);
    await ensureRealDirectory(paths.takeovers);
    await ensureRealDirectory(paths.quarantines);
    const temporary = join(paths.locks, `.lock-${randomUUID()}`);
    const owner = Object.freeze({
        schemaVersion: 2,
        profileId,
        ownerId: `break-glass:${randomUUID()}`,
        leaseId: `lease:${randomUUID()}`,
        processIdentity: await currentProcessIdentity(),
        acquiredAtMs: Date.now(),
    });
    await mkdir(temporary, { mode: 0o700 });
    await writeExclusive(join(temporary, 'owner.json'), owner);
    try {
        const resumed = await resumeProfileTakeover(paths, profileId, owner, temporary);
        if (!resumed) {
            await assertNoProfileTakeover(paths, profileId);
            try {
                await installProfileOwner(paths, temporary, owner);
            }
            catch (error) {
                if (!['EEXIST', 'ENOTEMPTY'].includes(error.code ?? ''))
                    throw error;
                await takeoverInstalledProfileLock(paths, profileId, owner, temporary);
            }
        }
        try {
            await assertNoProfileTakeover(paths, profileId);
        }
        catch (error) {
            const installedValue = await readOptionalRecord(join(paths.destination, 'owner.json'), MAX_POINTER_BYTES, 'Plugin recovery raced lock');
            if (installedValue !== undefined
                && sameProfileLockOwner(decodeProfileLockOwner(installedValue, profileId, 'Plugin recovery raced lock'), owner)) {
                await rm(paths.destination, { recursive: true });
                await syncDirectory(paths.locks);
            }
            throw error;
        }
    }
    catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
    }
    return async () => {
        await assertProfileLeaseEntries(paths.destination);
        const held = decodeProfileLockOwner(await readOptionalRecord(join(paths.destination, 'owner.json'), MAX_POINTER_BYTES, 'Plugin recovery lock owner'), profileId, 'Plugin recovery lock owner');
        if (!sameProfileLockOwner(held, owner))
            failure('managed Plugin profile lock ownership changed');
        const [execution, dispatch] = await Promise.all([
            readOptionalRecord(join(paths.destination, 'execution.json'), MAX_POINTER_BYTES, 'Plugin recovery execution lease'),
            readOptionalRecord(join(paths.destination, 'execution-dispatch.json'), MAX_POINTER_BYTES, 'Plugin recovery execution dispatch'),
        ]);
        if (execution !== undefined || dispatch !== undefined) {
            failure('managed Plugin profile execution subtree has not reached quiescence');
        }
        await assertNoProfileTakeover(paths, profileId);
        await rm(paths.destination, { recursive: true });
        await syncDirectory(paths.locks);
    };
}
async function stateDigest(path, label) {
    const value = await readOptionalRecord(path, MAX_STATE_BYTES, label);
    return value === undefined ? null : canonicalDigest(value);
}
async function verifyFinalState(paths, transaction) {
    const managed = await stateDigest(paths.managed, 'managed Plugin final state');
    const sidecar = await stateDigest(paths.sidecar, 'managed Plugin final sidecar');
    const expectedManaged = transaction.restoredManaged === null ? null : canonicalDigest(transaction.restoredManaged);
    const expectedSidecar = transaction.restoredSidecar === null ? null : canonicalDigest(transaction.restoredSidecar);
    if (managed !== expectedManaged || sidecar !== expectedSidecar) {
        failure('managed Plugin current state diverged from the committed recovery transaction');
    }
}
async function writeBoundRecord(path, value, label) {
    const existing = await readOptionalRecord(path, MAX_STATE_BYTES, label);
    if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(value))
            failure(`${label} conflicts with existing recovery evidence`);
        return;
    }
    try {
        await writeExclusive(path, value);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        const raced = await readOptionalRecord(path, MAX_STATE_BYTES, label);
        if (canonicalJson(raced) !== canonicalJson(value))
            failure(`${label} conflicts with raced recovery evidence`);
    }
}
function absentRollbackEvidence(transaction) {
    if (transaction.restoredManaged !== null)
        return null;
    const source = transaction.sourceSidecar;
    return {
        schemaVersion: 1,
        operationId: transaction.operationId,
        targetKey: transaction.targetKey,
        profileId: transaction.profileId,
        packageName: source.packageName,
        sourceRevision: source.managed.revision,
        sourceDigest: canonicalDigest(source.managed),
        loaderEntryId: source.loaderEntryId,
        loaderName: source.loaderName,
        restartRequired: source.managed.current !== null,
        createdByOwnerId: `break-glass:${transaction.journalHeadDigest}`,
        status: 'settled',
    };
}
async function publishRecoveryEvidence(paths, transaction) {
    await writeBoundRecord(paths.evidence, transaction.recoveryEvidence, 'Plugin break-glass restore evidence');
    const absent = absentRollbackEvidence(transaction);
    if (absent !== null)
        await writeBoundRecord(paths.absentRollback, absent, 'Plugin absent rollback evidence');
}
async function verifyPublishedEvidence(paths, transaction) {
    const evidence = await readOptionalRecord(paths.evidence, MAX_STATE_BYTES, 'Plugin break-glass restore evidence');
    if (evidence === undefined || canonicalJson(evidence) !== canonicalJson(transaction.recoveryEvidence)) {
        failure('Plugin break-glass restore evidence diverged from its transaction');
    }
    const expectedAbsent = absentRollbackEvidence(transaction);
    if (expectedAbsent !== null) {
        const absent = await readOptionalRecord(paths.absentRollback, MAX_STATE_BYTES, 'Plugin absent rollback evidence');
        if (absent === undefined || canonicalJson(absent) !== canonicalJson(expectedAbsent)) {
            failure('Plugin absent rollback evidence diverged from its transaction');
        }
    }
}
async function clearBoundQuarantine(root, binding, journal) {
    const directory = join(binding.hostHome, '.extension-center-plugin-coordination', 'quarantine');
    const path = join(directory, `${storageKey(journal.opening.profileId)}.json`);
    const value = await readOptionalRecord(path, MAX_STATE_BYTES, 'official Profile ambiguity quarantine');
    if (value === undefined)
        return;
    const record = strictRecord(value, [
        'schemaVersion', 'profileId', 'packageName', 'operationId', 'targetKey', 'centerRoot',
        'beforeDigest', 'afterDigest', 'reason', 'createdAtMs',
    ], 'official Profile ambiguity quarantine');
    if (record.schemaVersion !== 1 || record.profileId !== journal.opening.profileId
        || record.packageName !== journal.opening.extensionId || record.operationId !== journal.operationId
        || record.targetKey !== journal.targetKey || record.centerRoot !== root) {
        failure('official Profile ambiguity quarantine does not bind this recovery operation');
    }
    digest(record.beforeDigest, 'official Profile ambiguity quarantine.beforeDigest');
    digest(record.afterDigest, 'official Profile ambiguity quarantine.afterDigest');
    boundedString(record.reason, 'official Profile ambiguity quarantine.reason', 2_048);
    safeInteger(record.createdAtMs, 'official Profile ambiguity quarantine.createdAtMs');
    await removeRegular(path, 'official Profile ambiguity quarantine');
}
async function applyPreparedTransaction(paths, transaction) {
    const currentManaged = await stateDigest(paths.managed, 'managed Plugin current state');
    const currentSidecar = await stateDigest(paths.sidecar, 'managed Plugin current sidecar');
    const finalManaged = transaction.restoredManaged === null ? null : canonicalDigest(transaction.restoredManaged);
    const finalSidecar = transaction.restoredSidecar === null ? null : canonicalDigest(transaction.restoredSidecar);
    const managedKnown = currentManaged === transaction.sourceManagedDigest || currentManaged === finalManaged;
    const sidecarKnown = currentSidecar === transaction.sourceSidecarDigest || currentSidecar === finalSidecar;
    if (!managedKnown || !sidecarKnown)
        failure('managed Plugin current state changed after recovery was prepared');
    if (transaction.restoredSidecar === null)
        await removeRegular(paths.sidecar, 'managed Plugin sidecar');
    else
        await writeAtomic(paths.sidecar, transaction.restoredSidecar);
    if (transaction.restoredManaged === null)
        await removeRegular(paths.managed, 'managed Plugin state');
    else
        await writeAtomic(paths.managed, transaction.restoredManaged);
}
async function loadProviderSnapshot(root, journal) {
    const path = join(root, 'state', 'provider-snapshots', `${storageKey(journal.operationId)}.json`);
    const value = await readOptionalRecord(path, MAX_STATE_BYTES, 'Plugin provider snapshot');
    if (value === undefined)
        failure('Plugin provider snapshot is absent');
    return decodeProviderSnapshot(value, root, journal);
}
async function loadCurrentSidecar(root, journal, paths) {
    const managedValue = await readOptionalRecord(paths.managed, MAX_STATE_BYTES, 'managed Plugin current state');
    const sidecarValue = await readOptionalRecord(paths.sidecar, MAX_STATE_BYTES, 'managed Plugin current sidecar');
    if (sidecarValue === undefined)
        failure('managed Plugin current sidecar is absent');
    const sidecar = decodeSidecar(sidecarValue, root, journal.opening, journal.targetKey, 'managed Plugin current sidecar');
    if (sidecar.lastOperationId !== journal.operationId || sidecar.managed.lastOperationId !== journal.operationId) {
        failure('managed Plugin current state does not bind the recovery operation');
    }
    if (managedValue !== undefined) {
        const managed = decodeManaged(managedValue, root, journal.opening, journal.targetKey, 'managed Plugin current state');
        const same = canonicalJson(managed) === canonicalJson(sidecar.managed);
        const sidecarAhead = sidecar.revision === managed.revision + 1;
        if (!same && !sidecarAhead)
            failure('managed Plugin state and owner sidecar diverged');
        if (same && sidecar.revision !== managed.revision)
            failure('managed Plugin sidecar revision is invalid');
    }
    return Object.freeze({ managedValue, sidecar });
}
/**
 * Restore one recovery-required Plugin operation to its durable provider before-state.
 * @param centerRoot Exact Center-owned durable root.
 * @param operationId Exact durable operation identity.
 * @param invokedPath Executed recovery file path used for the self pin.
 */
export async function recoverProfile(centerRoot, operationId, invokedPath) {
    const root = await verifyCenterRoot(centerRoot);
    const journal = await verifyJournal(root, operationId);
    if (journal.phase !== 'recovery-required')
        failure('operation is not a recovery-required Plugin operation');
    const pins = journal.opening.recoveryExecutable;
    if (pins.centerRoot !== root)
        failure('journal recovery executable is bound to a different Center root');
    if (!below(root, pins.officialDsh.supervisorPath) || !below(root, pins.officialDsh.pnpm.packageRoot)
        || !below(root, pins.officialDsh.pnpm.shimPath) || !below(root, pins.officialDsh.pnpm.runtimeRoot)) {
        failure('journal recovery private execution toolchain escapes the Center root');
    }
    verifyRecoverySeparation(root, pins.officialDsh);
    if (pins.platform !== process.platform || pins.arch !== process.arch)
        failure('recovery executable platform does not match this process');
    const pinnedSelf = await verifyExecutable(pins.executablePath, pins.executableSha256, 'recovery executable');
    const modulePath = await realpath(fileURLToPath(import.meta.url));
    const invokedRealpath = await realpath(resolve(invokedPath));
    if (pinnedSelf !== modulePath || invokedRealpath !== modulePath)
        failure('running recovery executable does not match the journal pin');
    await verifyOfficialDsh(pins.officialDsh);
    const snapshot = await loadProviderSnapshot(root, journal);
    await verifyMetadataCache(pins.officialDsh, snapshot.metadataCache);
    const paths = statePaths(root, journal);
    const existingTransactionValue = await readOptionalRecord(paths.transaction, MAX_TRANSACTION_BYTES, 'Plugin recovery transaction');
    let transaction;
    if (existingTransactionValue !== undefined) {
        transaction = decodeTransaction(existingTransactionValue, root, journal, snapshot);
    }
    else {
        const source = await loadCurrentSidecar(root, journal, paths);
        const restored = restoredState(source.sidecar, snapshot, journal, Date.now());
        const recoveryEvidence = restoreEvidence(journal, snapshot, restored.managed);
        transaction = {
            schemaVersion: 1,
            operationId: journal.operationId,
            targetKey: journal.targetKey,
            profileId: journal.opening.profileId,
            journalHeadDigest: journal.headDigest,
            providerSnapshotDigest: snapshot.digest,
            sourceManaged: source.managedValue === undefined ? null : source.managedValue,
            sourceManagedDigest: source.managedValue === undefined ? null : canonicalDigest(source.managedValue),
            sourceSidecar: source.sidecar,
            sourceSidecarDigest: canonicalDigest(source.sidecar),
            restoredManaged: restored.managed,
            restoredSidecar: restored.sidecar,
            recoveryEvidence,
            recoveryEvidenceDigest: canonicalDigest(recoveryEvidence),
            preparedAtMs: Date.now(),
            committedAtMs: null,
            status: 'prepared',
        };
        try {
            await writeExclusive(paths.transaction, transaction);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const raced = await readOptionalRecord(paths.transaction, MAX_TRANSACTION_BYTES, 'Plugin recovery transaction');
            transaction = decodeTransaction(raced, root, journal, snapshot);
        }
    }
    if (transaction.status === 'committed') {
        await verifyFinalState(paths, transaction);
        await publishRecoveryEvidence(paths, transaction);
        await verifyPublishedEvidence(paths, transaction);
        if (await physicalStatus(root, pins.officialDsh, journal.opening.profileId, journal.opening.extensionId, journal.targetKey, transaction.restoredManaged) !== 'exact') {
            failure('official DSH Profile diverged from the committed recovery transaction');
        }
        await clearBoundQuarantine(root, pins.officialDsh, journal);
        await verifyExecutable(pins.executablePath, pins.executableSha256, 'recovery executable after recovery');
        await verifyOfficialDsh(pins.officialDsh);
        return;
    }
    const release = await acquireProfileLock(pins.officialDsh, journal.opening.profileId);
    try {
        await restoreOfficialProfile(root, pins.officialDsh, journal, snapshot.metadataCache, transaction.sourceSidecar.managed, transaction.restoredManaged);
        await applyPreparedTransaction(paths, transaction);
        await verifyFinalState(paths, transaction);
        await publishRecoveryEvidence(paths, transaction);
        await verifyPublishedEvidence(paths, transaction);
        transaction = { ...transaction, status: 'committed', committedAtMs: Date.now() };
        await writeAtomic(paths.transaction, transaction);
    }
    finally {
        await release();
    }
    await verifyFinalState(paths, transaction);
    await verifyPublishedEvidence(paths, transaction);
    if (await physicalStatus(root, pins.officialDsh, journal.opening.profileId, journal.opening.extensionId, journal.targetKey, transaction.restoredManaged) !== 'exact') {
        failure('official DSH Profile diverged after recovery commit');
    }
    await clearBoundQuarantine(root, pins.officialDsh, journal);
    await verifyExecutable(pins.executablePath, pins.executableSha256, 'recovery executable after recovery');
    await verifyOfficialDsh(pins.officialDsh);
}
async function main() {
    const [centerRoot, operationId, ...extra] = process.argv.slice(2);
    if (centerRoot === undefined || operationId === undefined || extra.length > 0 || process.argv[1] === undefined) {
        process.stderr.write('usage: node <pinned-recovery-cli> <center-root> <operation-id>\n');
        return 2;
    }
    try {
        await recoverProfile(centerRoot, operationId, process.argv[1]);
        process.stdout.write('Official Profile and Center state restored; restart verification pending\n');
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
