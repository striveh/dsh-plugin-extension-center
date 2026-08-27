#!/usr/bin/env node
/**
 * Dependency-free POSIX supervisor for one bound official DSH CLI mutation.
 *
 * The caller creates this process as a new process-group leader and keeps its
 * stdin pipe open. EOF means the caller disappeared, including `SIGKILL`; the
 * supervisor then terminates the whole group containing DSH and pnpm.
 */
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
const START = 'START\n';
const TERMINATION_GRACE_MS = 250;
const MAX_CONFIG_BYTES = 64 * 1024;
function outputClosed(error) {
    return ['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code ?? '');
}
function plain(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(message) {
    process.stderr.write(`official DSH supervisor failed: ${message}\n`);
    process.exit(126);
}
function decodeConfig(encoded) {
    if (encoded === undefined || encoded.length === 0 || encoded.length > MAX_CONFIG_BYTES * 2
        || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
        fail('configuration argument is invalid');
    }
    let value;
    try {
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.length === 0 || bytes.length > MAX_CONFIG_BYTES)
            fail('configuration exceeds its byte bound');
        value = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        fail('configuration is not valid JSON');
    }
    if (!plain(value) || Object.keys(value).sort().join(',')
        !== 'arguments,cwd,entrypointPath,environment,nodePath,schemaVersion,timeoutMs'
        || value.schemaVersion !== 1 || typeof value.nodePath !== 'string' || value.nodePath.length === 0
        || typeof value.entrypointPath !== 'string' || value.entrypointPath.length === 0
        || typeof value.cwd !== 'string' || value.cwd.length === 0
        || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1_000
        || value.timeoutMs > 600_000 || !Array.isArray(value.arguments)
        || value.arguments.length > 128 || value.arguments.some(argument => typeof argument !== 'string'
        || argument.length > 16_384 || argument.includes('\0')) || !plain(value.environment)
        || Object.keys(value.environment).length > 64
        || Object.entries(value.environment).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
            || typeof item !== 'string' || item.length > 16_384 || item.includes('\0'))) {
        fail('configuration fields are invalid');
    }
    return Object.freeze({
        schemaVersion: 1,
        nodePath: value.nodePath,
        entrypointPath: value.entrypointPath,
        cwd: value.cwd,
        timeoutMs: value.timeoutMs,
        arguments: Object.freeze([...value.arguments]),
        environment: Object.freeze({ ...value.environment }),
    });
}
const config = decodeConfig(process.argv[2]);
let child = null;
let started = false;
let termination = null;
let buffered = '';
let killTimer = null;
let timeoutTimer = null;
function signalGroup(signal) {
    try {
        process.kill(-process.pid, signal);
    }
    catch (error) {
        if (error.code !== 'ESRCH')
            throw error;
    }
}
function forwardOutput(stream, chunk) {
    try {
        stream.write(chunk);
    }
    catch (error) {
        if (!outputClosed(error))
            terminate('signal');
    }
}
function terminate(reason) {
    if (termination !== null)
        return;
    termination = reason;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), TERMINATION_GRACE_MS);
}
function exitAfterChild(code, signal, launchError) {
    if (termination !== null)
        return;
    if (timeoutTimer !== null)
        clearTimeout(timeoutTimer);
    process.stdin.pause();
    const outcome = `${JSON.stringify({
        schemaVersion: 1,
        code: launchError === undefined ? code : 126,
        signal: launchError === undefined ? signal : null,
        launchError: launchError !== undefined,
    })}\n`;
    try {
        writeSync(3, outcome);
    }
    catch (error) {
        if (!outputClosed(error)) {
            try {
                process.stderr.write(`official DSH supervisor could not publish its child outcome: ${String(error)}\n`);
            }
            catch { /* output may be closed */ }
        }
    }
    terminate('child-exit');
}
function startChild() {
    if (started || termination !== null)
        return;
    started = true;
    child = spawn(config.nodePath, [config.entrypointPath, ...config.arguments], {
        cwd: config.cwd,
        detached: false,
        env: config.environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let launchError;
    child.stdout.on('data', (chunk) => { forwardOutput(process.stdout, chunk); });
    child.stderr.on('data', (chunk) => { forwardOutput(process.stderr, chunk); });
    child.once('error', cause => { launchError = cause; });
    child.once('close', (code, signal) => exitAfterChild(code, signal, launchError));
    timeoutTimer = setTimeout(() => terminate('timeout'), config.timeoutMs);
    timeoutTimer.unref();
}
process.on('SIGTERM', () => terminate('signal'));
process.on('SIGINT', () => terminate('signal'));
process.stdout.on('error', error => { if (!outputClosed(error))
    terminate('signal'); });
process.stderr.on('error', error => { if (!outputClosed(error))
    terminate('signal'); });
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffered += chunk;
    if (buffered.length > START.length)
        fail('start handshake contains unexpected data');
    if (buffered === START)
        startChild();
});
process.stdin.on('end', () => {
    if (!started)
        process.exit(125);
    terminate('parent-eof');
});
process.stdin.resume();
//# sourceMappingURL=supervisor.js.map
