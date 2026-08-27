/** Atomic installer for the standalone recovery executable and its private execution toolchain. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, unlink, } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES = 64 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OFFICIAL_DSH_PACKAGE = '@deepseek-ai/dsh';
const OFFICIAL_DSH_VERSION = '0.1.1-rc.2';
const PNPM_PACKAGE = 'pnpm';
const PNPM_VERSION = '11.7.0';
const PNPM_REGISTRY_INTEGRITY = 'sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==';
function fail(message) {
    throw new Error(message);
}
function plain(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sameOrBelow(root, candidate) {
    const value = relative(resolve(root), resolve(candidate));
    return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
function assertRecoverySeparation(root, officialDsh) {
    if (root === officialDsh.hostHome || sameOrBelow(join(officialDsh.hostHome, 'profiles'), root)
        || sameOrBelow(root, officialDsh.packageRoot) || sameOrBelow(officialDsh.packageRoot, root)) {
        fail('recovery root overlaps official DSH Profile or package state');
    }
}
async function packageManifest() {
    const path = fileURLToPath(new URL('../../package.json', import.meta.url));
    const value = await readJsonFile(path, 'recovery package manifest');
    if (value.name !== 'dsh-plugin-extension-center' || !SAFE_SEGMENT.test(value.version)) {
        fail('recovery package identity is invalid');
    }
    return Object.freeze({ name: value.name, version: value.version });
}
async function readRegularNoFollow(path, label, maximumBytes = MAX_EXECUTABLE_BYTES) {
    if (!isAbsolute(path))
        fail(`${label} path must be absolute`);
    if (constants.O_NOFOLLOW === undefined)
        fail(`${label} cannot be opened without following links on this platform`);
    const canonical = await realpath(path);
    if (canonical !== path)
        fail(`${label} path must be its canonical realpath`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size <= 0 || opened.size > maximumBytes) {
            fail(`${label} must be a bounded regular file`);
        }
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
async function regularSha256(path, label) {
    return sha256(await readRegularNoFollow(path, label));
}
function sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
async function readJsonFile(path, label) {
    let value;
    try {
        value = JSON.parse((await readRegularNoFollow(path, label, 8 * 1024 * 1024)).toString('utf8'));
    }
    catch (cause) {
        throw new Error(`${label} is unreadable`, { cause });
    }
    if (!plain(value) || typeof value.name !== 'string' || typeof value.version !== 'string'
        || value.name.length === 0 || value.version.length === 0) {
        fail(`${label} is invalid`);
    }
    return value;
}
async function hashTree(root, path, hash, ignoreRootNodeModules) {
    const info = await lstat(path);
    const name = relative(root, path).split('\\').join('/') || '.';
    if (info.isSymbolicLink()) {
        hash.update(`link:${name}:${await readlink(path)}\0`);
        return;
    }
    if (info.isFile()) {
        if (info.size > MAX_PACKAGE_FILE_BYTES)
            fail(`package file is outside its byte bound: ${name}`);
        hash.update(`file:${name}:${String(info.size)}\0`);
        hash.update(await readFile(path));
        return;
    }
    if (!info.isDirectory())
        fail(`package contains unsupported entry ${JSON.stringify(name)}`);
    hash.update(`dir:${name}\0`);
    const entries = (await readdir(path, { withFileTypes: true }))
        .filter(entry => !(ignoreRootNodeModules && path === root && entry.name === 'node_modules'))
        .filter(entry => !(path === join(root, 'node_modules') && entry.name === '.bin'))
        .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries)
        await hashTree(root, join(path, entry.name), hash, ignoreRootNodeModules);
}
async function packageTreeSha256(packageRoot, ignoreRootNodeModules) {
    const hash = createHash('sha256');
    await hashTree(packageRoot, packageRoot, hash, ignoreRootNodeModules);
    return `sha256:${hash.digest('hex')}`;
}
async function packageRootFromResolved(packageName, resolvedPath) {
    let current = (await lstat(resolvedPath)).isDirectory() ? resolvedPath : dirname(resolvedPath);
    for (;;) {
        const manifestPath = join(current, 'package.json');
        try {
            const manifest = await readJsonFile(await realpath(manifestPath), `${packageName} package manifest`);
            if (manifest.name === packageName)
                return await realpath(current);
        }
        catch (error) {
            if (error.code !== 'ENOENT'
                && !(error instanceof Error && error.message.includes('is unreadable')))
                throw error;
        }
        const parent = dirname(current);
        if (parent === current)
            fail(`official DSH production dependency ${packageName} has no matching package root`);
        current = parent;
    }
}
async function resolveDependencyRoot(packageName, ownerRoot) {
    const segments = packageName.split('/');
    let anchor = ownerRoot;
    for (;;) {
        const manifestPath = join(anchor, 'node_modules', ...segments, 'package.json');
        try {
            const canonicalManifest = await realpath(manifestPath);
            const manifest = await readJsonFile(canonicalManifest, `official DSH production dependency ${packageName} manifest`);
            if (manifest.name !== packageName)
                fail(`official DSH production dependency identity changed: ${packageName}`);
            return await realpath(dirname(canonicalManifest));
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        const parent = dirname(anchor);
        if (parent === anchor)
            break;
        anchor = parent;
    }
    const require = createRequire(join(ownerRoot, 'package.json'));
    let resolved;
    try {
        resolved = require.resolve(packageName);
    }
    catch (cause) {
        throw new Error(`official DSH production dependency ${packageName} is not resolvable`, { cause });
    }
    return await packageRootFromResolved(packageName, await realpath(resolved));
}
async function bindProductionClosure(packageRoot) {
    const queued = [packageRoot];
    const visited = new Set([packageRoot]);
    const dependencies = [];
    while (queued.length > 0) {
        const ownerRoot = queued.shift();
        const manifest = await readJsonFile(join(ownerRoot, 'package.json'), 'official DSH production package manifest');
        const declared = plain(manifest.dependencies) ? Object.keys(manifest.dependencies).sort() : [];
        const optional = plain(manifest.optionalDependencies) ? Object.keys(manifest.optionalDependencies).sort() : [];
        for (const packageName of [...new Set([...declared, ...optional])].sort()) {
            let dependencyRoot;
            try {
                dependencyRoot = await resolveDependencyRoot(packageName, ownerRoot);
            }
            catch (error) {
                if (optional.includes(packageName) && !declared.includes(packageName))
                    continue;
                throw error;
            }
            if (visited.has(dependencyRoot))
                continue;
            visited.add(dependencyRoot);
            const dependencyManifest = await readJsonFile(join(dependencyRoot, 'package.json'), `official DSH production dependency ${packageName} manifest`);
            if (dependencyManifest.name !== packageName)
                fail(`official DSH production dependency identity changed: ${packageName}`);
            dependencies.push(Object.freeze({
                packageName,
                packageVersion: dependencyManifest.version,
                packageRoot: dependencyRoot,
                packageTreeSha256: await packageTreeSha256(dependencyRoot, true),
            }));
            queued.push(dependencyRoot);
            if (dependencies.length > 1_024)
                fail('official DSH production dependency closure exceeds its bound');
        }
    }
    return Object.freeze(dependencies.sort((left, right) => {
        const leftKey = `${left.packageName}\0${left.packageVersion}\0${left.packageRoot}`;
        const rightKey = `${right.packageName}\0${right.packageVersion}\0${right.packageRoot}`;
        return leftKey.localeCompare(rightKey);
    }));
}
async function ensurePrivateDirectory(path) {
    await mkdir(path, { recursive: false, mode: 0o700 });
    const canonical = await realpath(path);
    const state = await lstat(path);
    if (canonical !== path || !state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0) {
        fail(`recovery directory ${JSON.stringify(path)} is not a private real directory`);
    }
}
async function ensurePath(root, parts) {
    let current = root;
    for (const part of parts) {
        current = join(current, part);
        try {
            await ensurePrivateDirectory(current);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const canonical = await realpath(current);
            const state = await lstat(current);
            if (canonical !== current || !state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0) {
                fail(`recovery directory ${JSON.stringify(current)} is not a private real directory`);
            }
        }
    }
    return current;
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
async function installExclusive(path, bytes, mode = 0o500) {
    const directory = dirname(path);
    const temporary = join(directory, `.install-${randomUUID()}`);
    const handle = await open(temporary, 'wx', mode);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        try {
            await link(temporary, path);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const installed = await readRegularNoFollow(path, 'installed immutable executable');
            if (!installed.equals(bytes))
                fail('installed immutable executable already contains different bytes');
        }
        await syncDirectory(directory);
    }
    finally {
        await unlink(temporary).catch((error) => {
            if (error.code !== 'ENOENT')
                throw error;
        });
    }
}
async function copyPackageTree(sourceRoot, destinationRoot, packageRoot = sourceRoot) {
    await mkdir(destinationRoot, { mode: 0o700 });
    for (const entry of (await readdir(sourceRoot, { withFileTypes: true }))
        .filter(entry => !(sourceRoot === packageRoot && entry.name === 'node_modules'))
        .filter(entry => !(sourceRoot === join(packageRoot, 'node_modules') && entry.name === '.bin'))
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const source = join(sourceRoot, entry.name);
        const destination = join(destinationRoot, entry.name);
        if (entry.isSymbolicLink())
            fail(`bundled pnpm contains a symbolic link: ${entry.name}`);
        if (entry.isDirectory())
            await copyPackageTree(source, destination, packageRoot);
        else if (entry.isFile()) {
            if ((await lstat(source)).size > MAX_PACKAGE_FILE_BYTES)
                fail(`bundled pnpm file exceeds its byte bound: ${entry.name}`);
            await copyFile(source, destination, constants.COPYFILE_EXCL);
            await chmod(destination, 0o400);
        }
        else
            fail(`bundled pnpm contains an unsupported entry: ${entry.name}`);
    }
}
function shellQuote(value) {
    if (value.includes('\n') || value.includes('\r') || value.includes('\0'))
        fail('private pnpm shim path is unsafe');
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
async function locateBundledPnpmManifest(configured) {
    const candidate = configured ?? createRequire(import.meta.url).resolve(PNPM_PACKAGE);
    const manifestPath = await realpath(resolve(candidate));
    const manifest = await readJsonFile(manifestPath, 'bundled pnpm package manifest');
    if (manifest.name !== PNPM_PACKAGE || manifest.version !== PNPM_VERSION || !plain(manifest.bin)
        || manifest.bin.pnpm !== 'bin/pnpm.mjs' || plain(manifest.dependencies) && Object.keys(manifest.dependencies).length > 0) {
        fail(`bundled pnpm must be the dependency-free ${PNPM_PACKAGE}@${PNPM_VERSION} package`);
    }
    return manifestPath;
}
async function installPrivateToolchain(input) {
    const nodePath = await realpath(resolve(input.nodePath ?? process.execPath));
    const nodeSha256 = await regularSha256(nodePath, 'bound Node executable');
    const supervisorSource = await realpath(resolve(input.supervisorPath));
    const supervisorBytes = await readRegularNoFollow(supervisorSource, 'built official DSH supervisor');
    const supervisorSha256 = sha256(supervisorBytes);
    const shellPath = await realpath('/bin/sh');
    const shellSha256 = await regularSha256(shellPath, 'bound POSIX shell');
    const pnpmManifestPath = await locateBundledPnpmManifest(input.pnpmManifestPath);
    const pnpmSourceRoot = await realpath(dirname(pnpmManifestPath));
    const pnpmSourceDigest = await packageTreeSha256(pnpmSourceRoot, true);
    const generationDigest = createHash('sha256').update(JSON.stringify({
        nodePath,
        nodeSha256,
        nodeVersion: process.version,
        pnpmSourceDigest,
        shellPath,
        shellSha256,
        supervisorSha256,
    })).digest('hex');
    const toolchains = await ensurePath(input.root, ['recovery', 'toolchains']);
    const generation = join(toolchains, generationDigest);
    try {
        await ensurePrivateDirectory(generation);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        const canonical = await realpath(generation);
        const state = await lstat(generation);
        if (canonical !== generation || !state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0) {
            fail('private toolchain generation is unsafe');
        }
    }
    const pnpmPackageRoot = join(generation, 'pnpm');
    try {
        await lstat(pnpmPackageRoot);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        const temporary = join(generation, `.pnpm-${randomUUID()}`);
        try {
            await copyPackageTree(pnpmSourceRoot, temporary);
            await rename(temporary, pnpmPackageRoot);
            await syncDirectory(generation);
        }
        catch (cause) {
            await rm(temporary, { recursive: true, force: true });
            throw cause;
        }
    }
    if (await packageTreeSha256(pnpmPackageRoot, true) !== pnpmSourceDigest) {
        fail('private pnpm package tree does not match its bundled source');
    }
    const pnpmEntrypoint = join(pnpmPackageRoot, 'bin', 'pnpm.mjs');
    const pnpmEntrypointSha256 = await regularSha256(pnpmEntrypoint, 'private pnpm entrypoint');
    const supervisorPath = join(generation, 'supervisor.mjs');
    await installExclusive(supervisorPath, supervisorBytes);
    const bin = await ensurePath(generation, ['bin']);
    const shimPath = join(bin, 'pnpm');
    const shimBytes = Buffer.from(`#!${shellPath}\nexec ${shellQuote(nodePath)} ${shellQuote(pnpmEntrypoint)} \"$@\"\n`, 'utf8');
    await installExclusive(shimPath, shimBytes);
    const runtimeRoot = await ensurePath(generation, ['runtime']);
    return Object.freeze({
        node: Object.freeze({
            schemaVersion: 1,
            executablePath: nodePath,
            executableSha256: nodeSha256,
            version: process.version,
        }),
        supervisorPath,
        supervisorSha256,
        pnpm: Object.freeze({
            schemaVersion: 1,
            packageName: PNPM_PACKAGE,
            packageVersion: PNPM_VERSION,
            registryIntegrity: PNPM_REGISTRY_INTEGRITY,
            packageRoot: pnpmPackageRoot,
            packageTreeSha256: pnpmSourceDigest,
            entrypointPath: pnpmEntrypoint,
            entrypointSha256: pnpmEntrypointSha256,
            shimPath,
            shimSha256: sha256(shimBytes),
            shellPath,
            shellSha256,
            runtimeRoot,
        }),
    });
}
async function bindOfficialDsh(input, toolchain) {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 600_000) {
        fail('official DSH recovery timeout must be an integer between 1000 and 600000');
    }
    if (!isAbsolute(input.entrypointPath) || !isAbsolute(input.hostHome)) {
        fail('official DSH recovery paths must be absolute');
    }
    const entrypointPath = await realpath(resolve(input.entrypointPath));
    const entrypointInfo = await lstat(entrypointPath);
    if (!entrypointInfo.isFile() || entrypointInfo.isSymbolicLink()) {
        fail('official DSH recovery entrypoint is not a regular file');
    }
    const packageRoot = await realpath(resolve(dirname(entrypointPath), '..'));
    const packageInfo = await lstat(packageRoot);
    if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) {
        fail('official DSH recovery package root is not a real directory');
    }
    const manifest = await readJsonFile(join(packageRoot, 'package.json'), 'official DSH recovery package manifest');
    const bin = manifest.bin;
    if (manifest.name !== OFFICIAL_DSH_PACKAGE || manifest.version !== OFFICIAL_DSH_VERSION
        || !plain(bin) || typeof bin.dsh !== 'string') {
        fail(`official DSH recovery CLI must be ${OFFICIAL_DSH_PACKAGE}@${OFFICIAL_DSH_VERSION}`);
    }
    const declared = await realpath(resolve(packageRoot, bin.dsh));
    if (declared !== entrypointPath)
        fail('official DSH recovery entrypoint does not match its package manifest');
    const hostHome = await realpath(resolve(input.hostHome));
    const hostHomeInfo = await lstat(hostHome);
    if (!hostHomeInfo.isDirectory() || hostHomeInfo.isSymbolicLink()) {
        fail('official DSH recovery home is not a real directory');
    }
    const entrypointSha256 = await regularSha256(entrypointPath, 'official DSH recovery entrypoint');
    const firstTreeDigest = await packageTreeSha256(packageRoot, true);
    const productionDependencies = await bindProductionClosure(packageRoot);
    if (entrypointSha256 !== await regularSha256(entrypointPath, 'official DSH recovery entrypoint')
        || firstTreeDigest !== await packageTreeSha256(packageRoot, true)) {
        fail('official DSH recovery package changed while it was bound');
    }
    return Object.freeze({
        schemaVersion: 2,
        packageName: OFFICIAL_DSH_PACKAGE,
        packageVersion: OFFICIAL_DSH_VERSION,
        packageRoot,
        packageTreeSha256: firstTreeDigest,
        productionDependencies,
        entrypointPath,
        entrypointSha256,
        hostHome,
        timeoutMs: input.timeoutMs,
        node: toolchain.node,
        supervisorPath: toolchain.supervisorPath,
        supervisorSha256: toolchain.supervisorSha256,
        pnpm: toolchain.pnpm,
    });
}
/**
 * Install one immutable private CLI copy and bind it to an exact Center-owned state root.
 * @param input Built standalone CLI, supervisor, bundled pnpm, and Center-owned destination.
 * @returns Exact opening-event recovery executable binding.
 */
export async function installRecoveryExecutable(input) {
    const root = await realpath(resolve(input.root));
    if (!(await lstat(root)).isDirectory())
        fail('recovery root must be a directory');
    const platformValue = input.platform ?? process.platform;
    const arch = input.arch ?? process.arch;
    if (platformValue === 'win32')
        fail('official DSH Plugin mutation and recovery are unsupported on Windows');
    if (platformValue !== 'darwin' && platformValue !== 'linux')
        fail('recovery platform is unsupported');
    const platform = platformValue;
    for (const [label, value] of [['packageVersion', input.packageVersion], ['platform', platform], ['arch', arch]]) {
        if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..')
            fail(`recovery ${label} is not a safe path segment`);
    }
    const cliBytes = await readRegularNoFollow(input.cliPath, 'built recovery executable');
    const preflightEntrypoint = await realpath(resolve(input.officialDsh.entrypointPath));
    const preflightHome = await realpath(resolve(input.officialDsh.hostHome));
    assertRecoverySeparation(root, {
        hostHome: preflightHome,
        packageRoot: await realpath(resolve(dirname(preflightEntrypoint), '..')),
    });
    const toolchain = await installPrivateToolchain({
        root,
        supervisorPath: input.supervisorPath,
        pnpmManifestPath: input.pnpmManifestPath,
        nodePath: input.nodePath,
    });
    const officialDsh = await bindOfficialDsh(input.officialDsh, toolchain);
    assertRecoverySeparation(root, officialDsh);
    const directory = await ensurePath(root, ['recovery', input.packageVersion, `${platform}-${arch}`]);
    const path = join(directory, 'break-glass.mjs');
    await installExclusive(path, cliBytes);
    const installedBytes = await readRegularNoFollow(path, 'installed recovery executable');
    if (((await lstat(path)).mode & 0o077) !== 0)
        fail('installed recovery executable is not private');
    return Object.freeze({
        schemaVersion: 5,
        executablePath: path,
        executableSha256: sha256(installedBytes),
        centerRoot: root,
        packageVersion: input.packageVersion,
        platform,
        arch,
        officialDsh,
    });
}
/**
 * Materialize the built package's standalone CLI and private toolchain below the durable root.
 * @param root Center-owned durable root outside official Profile files.
 * @param officialDsh Exact installed official rc.2 CLI and Harness home.
 * @returns Exact executable binding embedded in every consumed operation.
 */
export async function installPackagedRecoveryExecutable(root, officialDsh) {
    const manifest = await packageManifest();
    const cliPath = await realpath(fileURLToPath(new URL('./break-glass.js', import.meta.url)));
    const supervisorPath = await realpath(fileURLToPath(new URL('./supervisor.js', import.meta.url)));
    return await installRecoveryExecutable({
        root,
        packageVersion: manifest.version,
        cliPath,
        supervisorPath,
        officialDsh,
    });
}
//# sourceMappingURL=install.js.map
