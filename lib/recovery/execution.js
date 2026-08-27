/** Verified private execution of the official DSH rc.2 Plugin CLI. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { captureCurrentProcessIdentity, decodeProcessIdentity, } from "../host/process-identity.js";
import { verifyProfileMetadataCache, } from "./profile-metadata-cache.js";
const PROFILE_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_MODULES_METADATA_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const SUPERVISOR_FALLBACK_MS = 2_000;
const PNPM_11_PACKAGE_MANAGER = /^pnpm@11\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const PROFILE_CONTROLS = [
    '.npmrc', '.pnpmfile.cjs', '.pnpmfile.js', '.pnpmfile.mjs', 'pnpmfile.cjs', 'pnpmfile.js', 'pnpmfile.mjs',
];
const MANIFEST_EXECUTION_FIELDS = [
    'scripts', 'pnpm', 'packageManager', 'devEngines', 'workspaces', 'config', 'publishConfig',
];
function fail(message) {
    throw new Error(message);
}
function plain(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function storageKey(value) {
    return createHash('sha256').update(value).digest('hex');
}
function appendOutput(held, chunk) {
    if (held.length >= MAX_OUTPUT_BYTES)
        return held;
    return (held + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
}
async function readRegular(path, label, maximumBytes = MAX_FILE_BYTES) {
    if (!isAbsolute(path) || constants.O_NOFOLLOW === undefined)
        fail(`${label} cannot be read without following links`);
    if (await realpath(path) !== path)
        fail(`${label} path is not canonical`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size < 0 || opened.size > maximumBytes)
            fail(`${label} is not a bounded regular file`);
        const bytes = await handle.readFile();
        const current = await lstat(path);
        if (bytes.length !== opened.size || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
            fail(`${label} changed while it was read`);
        }
        return bytes;
    }
    finally {
        await handle.close();
    }
}
function digest(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
async function hashTree(root, path, hash, ignoreRootNodeModules) {
    const info = await lstat(path);
    const name = relative(root, path).split(sep).join('/') || '.';
    if (info.isSymbolicLink()) {
        hash.update(`link:${name}:${await readlink(path)}\0`);
        return;
    }
    if (info.isFile()) {
        if (info.size > 64 * 1024 * 1024)
            fail(`bound package file exceeds its byte limit: ${name}`);
        hash.update(`file:${name}:${String(info.size)}\0`);
        hash.update(await readFile(path));
        return;
    }
    if (!info.isDirectory())
        fail(`bound package has an unsupported entry: ${name}`);
    hash.update(`dir:${name}\0`);
    const entries = (await readdir(path, { withFileTypes: true }))
        .filter(entry => !(ignoreRootNodeModules && path === root && entry.name === 'node_modules'))
        .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries)
        await hashTree(root, join(path, entry.name), hash, ignoreRootNodeModules);
}
async function treeDigest(root, ignoreRootNodeModules) {
    const hash = createHash('sha256');
    await hashTree(root, root, hash, ignoreRootNodeModules);
    return `sha256:${hash.digest('hex')}`;
}
async function verifyRegularPin(path, expected, label) {
    if (digest(await readRegular(path, label)) !== expected)
        fail(`${label} hash does not match its pin`);
}
async function verifyPackage(root, packageName, packageVersion, expectedTreeDigest, label, ignoreRootNodeModules) {
    const canonical = await realpath(root);
    const info = await lstat(root);
    if (canonical !== root || !info.isDirectory() || info.isSymbolicLink())
        fail(`${label} root changed`);
    let manifest;
    try {
        manifest = JSON.parse((await readRegular(join(root, 'package.json'), `${label} manifest`, 8 * 1024 * 1024)).toString('utf8'));
    }
    catch (cause) {
        throw new Error(`${label} manifest is invalid`, { cause });
    }
    if (!plain(manifest) || manifest.name !== packageName || manifest.version !== packageVersion) {
        fail(`${label} identity changed`);
    }
    if (await treeDigest(root, ignoreRootNodeModules) !== expectedTreeDigest)
        fail(`${label} tree does not match its pin`);
}
async function probeNodeVersion(binding) {
    const output = await new Promise((accept, reject) => {
        const child = spawn(binding.node.executablePath, ['--version'], {
            cwd: dirname(binding.node.executablePath),
            env: {},
            shell: false,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk) => { stdout = appendOutput(stdout, chunk); });
        child.once('error', reject);
        child.once('close', code => accept(Object.freeze({ code, stdout })));
    });
    if (output.code !== 0 || output.stdout.trim() !== binding.node.version)
        fail('bound Node executable version changed');
}
/** Verify every executable and package identity in one official execution binding. */
export async function verifyOfficialExecutionBinding(binding) {
    if (process.platform === 'win32')
        fail('official DSH Plugin mutation and recovery are unsupported on Windows');
    await verifyRegularPin(binding.node.executablePath, binding.node.executableSha256, 'bound Node executable');
    await probeNodeVersion(binding);
    await verifyRegularPin(binding.supervisorPath, binding.supervisorSha256, 'bound official DSH supervisor');
    await verifyRegularPin(binding.pnpm.entrypointPath, binding.pnpm.entrypointSha256, 'private pnpm entrypoint');
    await verifyRegularPin(binding.pnpm.shimPath, binding.pnpm.shimSha256, 'private pnpm shim');
    await verifyRegularPin(binding.pnpm.shellPath, binding.pnpm.shellSha256, 'bound POSIX shell');
    await verifyPackage(binding.pnpm.packageRoot, binding.pnpm.packageName, binding.pnpm.packageVersion, binding.pnpm.packageTreeSha256, 'private pnpm package', false);
    await verifyRegularPin(binding.entrypointPath, binding.entrypointSha256, 'official DSH entrypoint');
    await verifyPackage(binding.packageRoot, binding.packageName, binding.packageVersion, binding.packageTreeSha256, 'official DSH package', true);
    for (const dependency of binding.productionDependencies) {
        await verifyPackage(dependency.packageRoot, dependency.packageName, dependency.packageVersion, dependency.packageTreeSha256, `official DSH production dependency ${dependency.packageName}`, true);
    }
}
function profileSegment(profileId) {
    if (profileId.length === 0 || profileId.length > 256 || profileId.includes('/') || profileId.includes('\\')
        || profileId.includes(':') || profileId.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(profileId)
        || profileId === '.' || profileId === '..' || profileId === 'node_modules') {
        fail(`official DSH Plugin profile id is unsafe: ${profileId}`);
    }
    return profileId;
}
/** Reject Profile-local package-manager execution controls before any mutation starts. */
export async function auditOfficialProfileExecution(binding, profileId) {
    const profilePath = join(binding.hostHome, 'profiles', profileSegment(profileId));
    const canonical = await realpath(profilePath);
    const info = await lstat(profilePath);
    if (canonical !== profilePath || !info.isDirectory() || info.isSymbolicLink())
        fail('official DSH Profile directory is unsafe');
    for (const name of PROFILE_CONTROLS) {
        try {
            await lstat(join(profilePath, name));
            fail(`official DSH Profile execution control is forbidden: ${name}`);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    const workspace = await readRegular(join(profilePath, 'pnpm-workspace.yaml'), 'official DSH Profile workspace', 64 * 1024);
    if (workspace.toString('utf8') !== PROFILE_WORKSPACE)
        fail('official DSH Profile workspace contains unsupported execution controls');
    let manifest;
    try {
        manifest = JSON.parse((await readRegular(join(profilePath, 'package.json'), 'official DSH Profile manifest', 8 * 1024 * 1024)).toString('utf8'));
    }
    catch (cause) {
        throw new Error('official DSH Profile manifest is invalid', { cause });
    }
    if (!plain(manifest) || MANIFEST_EXECUTION_FIELDS.some(field => Object.hasOwn(manifest, field))) {
        fail('official DSH Profile manifest contains package-manager execution controls');
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
        fail('official DSH Profile node_modules directory is unsafe');
    }
    const metadataPath = join(nodeModulesPath, '.modules.yaml');
    let metadataBytes;
    try {
        metadataBytes = await readRegular(metadataPath, 'official DSH Profile pnpm modules metadata', MAX_MODULES_METADATA_BYTES);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            fail('installed official DSH Profile pnpm modules metadata is missing');
        }
        throw error;
    }
    let metadata;
    try {
        metadata = JSON.parse(metadataBytes.toString('utf8'));
    }
    catch (cause) {
        throw new Error('official DSH Profile pnpm modules metadata is invalid JSON', { cause });
    }
    if (!plain(metadata) || metadata.layoutVersion !== 5 || metadata.nodeLinker !== 'hoisted'
        || metadata.virtualStoreDir !== '.pnpm' || typeof metadata.packageManager !== 'string'
        || !PNPM_11_PACKAGE_MANAGER.test(metadata.packageManager)) {
        fail('official DSH Profile pnpm modules metadata is incompatible with pinned pnpm 11');
    }
    const storeDir = metadata.storeDir;
    if (typeof storeDir !== 'string' || storeDir.length === 0 || storeDir.length > 4_096
        || !isAbsolute(storeDir) || /[\u0000-\u001f\u007f]/u.test(storeDir) || !storeDir.endsWith(`${sep}v11`)) {
        fail('official DSH Profile pnpm modules metadata storeDir is unsafe');
    }
    let canonicalStore;
    let storeInfo;
    try {
        [canonicalStore, storeInfo] = await Promise.all([realpath(storeDir), lstat(storeDir)]);
    }
    catch (cause) {
        throw new Error('official DSH Profile pnpm modules metadata storeDir is unavailable', { cause });
    }
    if (canonicalStore !== storeDir || !storeInfo.isDirectory() || storeInfo.isSymbolicLink()) {
        fail('official DSH Profile pnpm modules metadata storeDir is not a canonical directory');
    }
    return storeDir;
}
async function ensurePrivate(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const canonical = await realpath(path);
    const info = await lstat(path);
    if (canonical !== path || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        fail(`private official DSH execution directory is unsafe: ${path}`);
    }
}
async function createEnvironment(binding, metadataCache) {
    const directory = join(binding.pnpm.runtimeRoot, `operation-${randomUUID()}`);
    await ensurePrivate(directory);
    const paths = Object.fromEntries(await Promise.all(['config', 'data', 'state', 'tmp'].map(async (name) => {
        const path = join(directory, name);
        await ensurePrivate(path);
        return [name, path];
    })));
    const cache = join(directory, 'cache');
    await cp(metadataCache.cachePath, cache, { recursive: true, force: false, errorOnExist: true });
    const store = metadataCache.storeDir;
    const expectedStore = metadataCache.expectedStoreDir;
    const userConfig = join(directory, 'user.npmrc');
    const globalConfig = join(directory, 'global.npmrc');
    await writeFile(userConfig, '', { flag: 'wx', mode: 0o600 });
    await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
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
async function readLeaseOwner(binding, profileId) {
    const path = join(binding.hostHome, '.extension-center-plugin-coordination', 'leases', storageKey(profileSegment(profileId)));
    let value;
    try {
        value = JSON.parse((await readRegular(join(path, 'owner.json'), 'official DSH Profile lease owner', 64 * 1024)).toString('utf8'));
    }
    catch (cause) {
        throw new Error('official DSH Profile lease owner is invalid', { cause });
    }
    if (!plain(value) || Object.keys(value).sort().join(',')
        !== 'acquiredAtMs,leaseId,ownerId,processIdentity,profileId,schemaVersion'
        || value.schemaVersion !== 2 || value.profileId !== profileId
        || typeof value.ownerId !== 'string' || value.ownerId.length === 0
        || typeof value.leaseId !== 'string' || !/^lease:[0-9a-f-]{36}$/u.test(value.leaseId)
        || !Number.isSafeInteger(value.acquiredAtMs)) {
        fail('official DSH Profile lease is not owned by this process');
    }
    const identity = decodeProcessIdentity(value.processIdentity, 'official DSH Profile lease');
    const current = await captureCurrentProcessIdentity();
    if (identity.pid !== current.pid || identity.platform !== current.platform
        || identity.machineDigest !== current.machineDigest || identity.bootDigest !== current.bootDigest
        || identity.birthDigest !== current.birthDigest)
        fail('official DSH Profile lease is not owned by this process');
    return Object.freeze({ path, ownerId: value.ownerId });
}
async function writeExecutionRecord(binding, profileId, processGroupPid) {
    const owner = await readLeaseOwner(binding, profileId);
    const path = join(owner.path, 'execution.json');
    const body = `${JSON.stringify({
        ownerId: owner.ownerId,
        parentPid: process.pid,
        processGroupPid,
        profileId,
        schemaVersion: 1,
        startedAtMs: Date.now(),
        supervisorSha256: binding.supervisorSha256,
    })}\n`;
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    return Object.freeze({ path, body });
}
async function clearExecutionRecord(record) {
    let body;
    try {
        body = (await readRegular(record.path, 'official DSH execution lease', 64 * 1024)).toString('utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            fail('official DSH execution lease disappeared');
        throw error;
    }
    if (body !== record.body)
        fail('official DSH execution lease changed');
    await unlink(record.path);
}
/** Run one mutation through the pinned supervisor, private pnpm shim, and minimal environment. */
export async function runBoundOfficialDsh(binding, profileId, arguments_, label, metadataCache) {
    if (arguments_.length === 0 || arguments_.length > 128
        || arguments_.some(argument => argument.length > 16_384 || argument.includes('\0'))) {
        fail('official DSH Plugin arguments are invalid');
    }
    await verifyOfficialExecutionBinding(binding);
    const profilePath = await auditOfficialProfileExecution(binding, profileId);
    const installedStore = await readInstalledProfileStore(profilePath);
    await verifyProfileMetadataCache(binding, metadataCache, false);
    if (metadataCache.profileId !== profileId
        || installedStore !== null && installedStore !== metadataCache.expectedStoreDir) {
        fail('official DSH Plugin metadata cache does not bind the Profile store');
    }
    const runtime = await createEnvironment(binding, metadataCache);
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
    let execution = null;
    try {
        await new Promise((accept, reject) => {
            const child = spawn(binding.node.executablePath, [binding.supervisorPath, encoded], {
                cwd: dirname(binding.supervisorPath),
                detached: true,
                env: {},
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            let stdout = '';
            let stderr = '';
            let launchError;
            let fallback = null;
            let timeoutObservation = null;
            let timedOut = false;
            let settled = false;
            child.stdout.on('data', (chunk) => { stdout = appendOutput(stdout, chunk); });
            child.stderr.on('data', (chunk) => { stderr = appendOutput(stderr, chunk); });
            child.once('error', cause => { launchError = cause; });
            const abort = (cause) => {
                if (settled)
                    return;
                settled = true;
                const pid = child.pid;
                if (pid !== undefined) {
                    try {
                        process.kill(-pid, 'SIGKILL');
                    }
                    catch { /* group may not have started */ }
                }
                reject(cause);
            };
            child.once('spawn', () => {
                const pid = child.pid;
                if (pid === undefined)
                    return abort(new Error('official DSH supervisor has no process id'));
                void writeExecutionRecord(binding, profileId, pid).then(record => {
                    execution = record;
                    child.stdin.write('START\n');
                    timeoutObservation = setTimeout(() => { timedOut = true; }, binding.timeoutMs);
                    timeoutObservation.unref();
                    fallback = setTimeout(() => {
                        try {
                            process.kill(-pid, 'SIGKILL');
                        }
                        catch { /* supervisor already exited */ }
                    }, binding.timeoutMs + SUPERVISOR_FALLBACK_MS);
                    fallback.unref();
                }, abort);
            });
            child.once('close', (code, signal) => {
                if (fallback !== null)
                    clearTimeout(fallback);
                if (timeoutObservation !== null)
                    clearTimeout(timeoutObservation);
                if (settled)
                    return;
                settled = true;
                if (launchError !== undefined)
                    return reject(new Error(`official DSH Plugin ${label} could not start`, { cause: launchError }));
                if (code === 0)
                    return accept();
                if (code === 124 || timedOut)
                    return reject(new Error(`official DSH Plugin ${label} timed out`));
                if (code === 125)
                    return reject(new Error(`official DSH Plugin ${label} lost its parent`));
                const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
                    || `exit=${String(code)} signal=${String(signal)}`;
                reject(new Error(`official DSH Plugin ${label} failed: ${detail}`));
            });
        });
        const auditedProfilePath = await auditOfficialProfileExecution(binding, profileId);
        const observedStore = await readInstalledProfileStore(auditedProfilePath);
        if (observedStore !== null && observedStore !== runtime.expectedStore
            || installedStore !== null && observedStore === null) {
            fail('official DSH Profile pnpm modules metadata storeDir changed during mutation');
        }
        await verifyProfileMetadataCache(binding, metadataCache, false);
        await verifyOfficialExecutionBinding(binding);
    }
    finally {
        if (execution !== null)
            await clearExecutionRecord(execution);
        const canonical = await realpath(runtime.directory).catch(() => null);
        if (canonical === runtime.directory)
            await rm(runtime.directory, { recursive: true });
    }
}
//# sourceMappingURL=execution.js.map
