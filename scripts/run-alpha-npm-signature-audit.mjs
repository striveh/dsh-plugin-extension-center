#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-plugin-extension-center'
const ALPHA_VERSION = /^0\.2\.0-alpha\.(?:0|[1-9][0-9]*)$/u
const PROVENANCE_PREDICATE = 'https://slsa.dev/provenance/v1'
const REGISTRY = 'https://registry.npmjs.org'
const MAX_ATTEMPTS = 3
const COMMAND_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const NETWORK_ARGUMENTS = Object.freeze([
  '--fetch-timeout=20000',
  '--fetch-retries=1',
  '--fetch-retry-mintimeout=1000',
  '--fetch-retry-maxtimeout=5000',
])
const RETRYABLE_NPM_CODES = new Set([
  'E404',
  'E408',
  'E425',
  'E429',
  'E500',
  'E502',
  'E503',
  'E504',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'ERR_SOCKET_TIMEOUT',
  'ETIMEDOUT',
  'FETCH_ERROR',
])

/** Classify one exact-version npm install result without retrying configuration or integrity failures. */
export function classifyNpmInstallAttempt(result) {
  if (successful(result)) return Object.freeze({ disposition: 'ready', reason: 'installed' })
  if (result?.timedOut === true) return Object.freeze({ disposition: 'retry', reason: 'network-timeout' })
  if (result?.overflow === true || typeof result?.spawnError === 'string') {
    return Object.freeze({ disposition: 'terminal', reason: 'local-execution-failure' })
  }
  const codes = npmErrorCodes(result)
  if (codes.length > 0 && codes.every(code => RETRYABLE_NPM_CODES.has(code))) {
    return Object.freeze({ disposition: 'retry', reason: `registry-${codes.join('+').toLowerCase()}` })
  }
  return Object.freeze({ disposition: 'terminal', reason: codes.length > 0 ? `npm-${codes.join('+').toLowerCase()}` : 'npm-install-failure' })
}

/** Classify npm audit output; invalid or missing signatures are always terminal. */
export function classifyNpmAuditAttempt(result, version) {
  if (!ALPHA_VERSION.test(version ?? '')) {
    throw new TypeError('alpha-npm-signature-audit: version is not one Center alpha')
  }
  const audit = parseJson(result?.stdout)
  if (isRecord(audit) && Array.isArray(audit.invalid) && Array.isArray(audit.missing)) {
    if (audit.invalid.length > 0 || audit.missing.length > 0) {
      return Object.freeze({ disposition: 'terminal', reason: 'invalid-or-missing-signature' })
    }
    if (!successful(result)) {
      const failure = classifyExecutionFailure(result)
      if (failure !== null) return failure
      return Object.freeze({ disposition: 'terminal', reason: 'audit-exit-disagrees-with-verdict' })
    }
    if (!Array.isArray(audit.verified)) {
      return Object.freeze({ disposition: 'terminal', reason: 'malformed-audit-verdict' })
    }
    const verified = audit.verified
    const targets = verified.filter(entry => entry?.name === PACKAGE_NAME && entry?.version === version)
    if (targets.length > 1) {
      return Object.freeze({ disposition: 'terminal', reason: 'ambiguous-target-audit' })
    }
    if (targets.length === 0) {
      return Object.freeze({ disposition: 'retry', reason: 'attestation-propagation' })
    }
    if (!Array.isArray(targets[0].attestationBundles)) {
      return Object.freeze({ disposition: 'terminal', reason: 'malformed-audit-verdict' })
    }
    const provenance = targets[0].attestationBundles
      .filter(bundle => bundle?.predicateType === PROVENANCE_PREDICATE)
    if (provenance.length === 1) {
      return Object.freeze({ disposition: 'ready', reason: 'cryptographically-verified', audit })
    }
    if (provenance.length > 1) {
      return Object.freeze({ disposition: 'terminal', reason: 'ambiguous-provenance-audit' })
    }
    return targets[0].attestationBundles.length === 0
      ? Object.freeze({ disposition: 'retry', reason: 'attestation-propagation' })
      : Object.freeze({ disposition: 'terminal', reason: 'unexpected-attestation-audit' })
  }
  const failure = classifyExecutionFailure(result)
  if (failure !== null) return failure
  const codes = npmErrorCodes(result)
  return Object.freeze({ disposition: 'terminal', reason: codes.length > 0 ? `npm-${codes.join('+').toLowerCase()}` : 'unparseable-audit-failure' })
}

/** Install and audit one immutable Center alpha with finite network-only retries. */
export async function runAlphaNpmSignatureAudit({
  version,
  outputPath,
  commandRunner = runNpmCommand,
  delay = retryDelay,
}) {
  if (!ALPHA_VERSION.test(version ?? '') || typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new TypeError('alpha-npm-signature-audit: expected an alpha version and audit output path')
  }
  const auditRoot = await mkdtemp(join(tmpdir(), 'dsh-center-signature-audit-'))
  const target = `${PACKAGE_NAME}@${version}`
  let installAttempts = 0
  let auditAttempts = 0
  try {
    await writeFile(
      join(auditRoot, 'package.json'),
      '{"name":"dsh-center-signature-audit","version":"0.0.0","private":true}\n',
      { flag: 'wx', mode: 0o600 },
    )
    installAttempts = await runPhase({
      label: 'install',
      args: [
        'install', target, '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=true',
        `--registry=${REGISTRY}`, '--json', ...NETWORK_ARGUMENTS,
      ],
      cwd: auditRoot,
      commandRunner,
      delay,
      classify: classifyNpmInstallAttempt,
    })
    const auditResult = await runPhase({
      label: 'audit',
      args: [
        'audit', 'signatures', '--json', '--include-attestations', `--registry=${REGISTRY}`,
        ...NETWORK_ARGUMENTS,
      ],
      cwd: auditRoot,
      commandRunner,
      delay,
      classify: result => classifyNpmAuditAttempt(result, version),
      returnResult: true,
    })
    auditAttempts = auditResult.attempts
    await atomicWrite(resolve(outputPath), auditResult.result.stdout)
    return Object.freeze({ installAttempts, auditAttempts })
  } finally {
    await rm(auditRoot, { recursive: true, force: true })
  }
}

async function runPhase({ label, args, cwd, commandRunner, delay, classify, returnResult = false }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await commandRunner(args, { cwd, timeoutMs: COMMAND_TIMEOUT_MS })
    const decision = classify(result)
    if (decision.disposition === 'ready') {
      return returnResult ? Object.freeze({ attempts: attempt, result }) : attempt
    }
    if (decision.disposition === 'terminal') {
      throw new Error(`alpha-npm-signature-audit: ${label} failed without retry (${decision.reason})`)
    }
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`alpha-npm-signature-audit: ${label} exhausted ${MAX_ATTEMPTS} attempts (${decision.reason})`)
    }
    process.stderr.write(`alpha-npm-signature-audit: retrying ${label} after ${decision.reason}\n`)
    await delay()
  }
  throw new Error(`alpha-npm-signature-audit: ${label} retry state is unreachable`)
}

async function runNpmCommand(args, { cwd, timeoutMs }) {
  return await new Promise(resolveResult => {
    const child = spawn('npm', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let stdoutLength = 0
    let stderrLength = 0
    let overflow = false
    let timedOut = false
    let spawnError = null
    let settled = false
    const append = (chunks, chunk, currentLength) => {
      const nextLength = currentLength + chunk.length
      if (nextLength > MAX_OUTPUT_BYTES) {
        overflow = true
        child.kill('SIGKILL')
      } else {
        chunks.push(chunk)
      }
      return nextLength
    }
    child.stdout.on('data', chunk => { stdoutLength = append(stdout, chunk, stdoutLength) })
    child.stderr.on('data', chunk => { stderrLength = append(stderr, chunk, stderrLength) })
    child.on('error', error => {
      spawnError = typeof error?.code === 'string' ? error.code : 'SPAWN_ERROR'
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('close', exitCode => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(Object.freeze({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        overflow,
        spawnError,
      }))
    })
  })
}

function successful(result) {
  return result?.exitCode === 0 && result.timedOut !== true && result.overflow !== true
    && typeof result.spawnError !== 'string'
}

function classifyExecutionFailure(result) {
  if (result?.timedOut === true) return Object.freeze({ disposition: 'retry', reason: 'network-timeout' })
  if (result?.overflow === true || typeof result?.spawnError === 'string') {
    return Object.freeze({ disposition: 'terminal', reason: 'local-execution-failure' })
  }
  const codes = npmErrorCodes(result)
  if (codes.length > 0 && codes.every(code => RETRYABLE_NPM_CODES.has(code))) {
    return Object.freeze({ disposition: 'retry', reason: `registry-${codes.join('+').toLowerCase()}` })
  }
  return null
}

function npmErrorCodes(result) {
  const codes = new Set()
  for (const text of [result?.stdout, result?.stderr]) {
    if (typeof text !== 'string') continue
    const parsed = parseJson(text)
    const code = parsed?.error?.code ?? parsed?.code
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(code)) codes.add(code)
    for (const match of text.matchAll(/npm error code ([A-Z][A-Z0-9_]*)/gu)) codes.add(match[1])
  }
  return [...codes].sort()
}

function parseJson(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_OUTPUT_BYTES) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function atomicWrite(path, text) {
  if (typeof text !== 'string' || text.length < 1 || Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
    throw new Error('alpha-npm-signature-audit: successful audit output is not bounded JSON')
  }
  JSON.parse(text)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, text.endsWith('\n') ? text : `${text}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

async function retryDelay() {
  await new Promise(resolveDelay => setTimeout(resolveDelay, 5_000))
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--version', '--output'].includes(key) || value === undefined || values[key.slice(2)] !== undefined) {
      throw new Error('alpha-npm-signature-audit: expected --version and --output exactly once')
    }
    values[key.slice(2)] = value
  }
  if (Object.keys(values).length !== 2 || values.version === undefined || values.output === undefined) {
    throw new Error('alpha-npm-signature-audit: expected --version and --output exactly once')
  }
  return values
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2))
    const result = await runAlphaNpmSignatureAudit({ version: options.version, outputPath: options.output })
    process.stdout.write(`alpha-npm-signature-audit: install-attempts=${result.installAttempts} audit-attempts=${result.auditAttempts}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
