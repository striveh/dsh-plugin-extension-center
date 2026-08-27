#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGitHubCiArtifactReceipt } from './verify-github-ci.mjs'
import {
  AcceptanceFailure,
  TARGET_DSH_COMMIT,
  TARGET_DSH_VERSION,
  assertNoPackageLifecycleScripts,
  hasBlockedCredentialEnvironment,
  hasProviderEndpointOverride,
  immutablePackageTreeDigest,
  installOfficialDshHost,
  keylessEnvironment,
  runChecked,
  sanitizeDiagnostic,
  sha256,
} from '../full-p0/support.mjs'

const CENTER_PACKAGE = 'dsh-plugin-extension-center'
const GITHUB_OWNER = 'striveh'
const GITHUB_REPOSITORY = 'dsh-plugin-extension-center'
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_RUNTIME_RECEIPT_BYTES = 1024 * 1024
const MAX_GH_OUTPUT_BYTES = 8 * 1024 * 1024
const SHA256 = /^(?:sha256:)?([0-9a-f]{64})$/u
const EXACT_SHA256 = /^sha256:[0-9a-f]{64}$/u
const SHA1 = /^[0-9a-f]{40}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const PINNED_PNPM_VERSION = '11.21.0'
const RUNTIME_ACCEPTANCE_ID = 'P0-CENTER-HOST-CLIENT-BOOT'
const RELEASE_PREDICATE_TYPE = 'https://in-toto.io/attestation/release/v0.1'
const RELEASE_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1'
const EXPECTED_MANIFEST_FIELDS = Object.freeze([
  'name', 'private', 'type', 'main', 'types', 'exports', 'files', 'engines', 'dsh',
  'dependencies', 'bundledDependencies', 'peerDependencies', 'peerDependenciesMeta',
])
const REDIRECT_HOSTS = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])
const USAGE = `usage: node acceptance/release/verify-public-release.mjs \\
  --current <github-release-url-or-local-path> --current-version <version> \\
  --current-sha256 <sha256> --current-size <bytes> --current-commit <sha> \\
  --current-manifest-sha256 <sha256> \\
  [--previous <github-release-url-or-local-path> --previous-version <version> \\
   --previous-sha256 <sha256> --previous-size <bytes> --previous-commit <sha> \\
   --previous-manifest-sha256 <sha256>] \\
  --runtime-receipt <path> --runtime-receipt-sha256 <sha256> \\
  --ci-receipt <path> --ci-receipt-sha256 <sha256> \\
  [--previous-ci-receipt <path> --previous-ci-receipt-sha256 <sha256>] \\
  --pnpm-bin <path> --pnpm-root <path> --pnpm-version ${PINNED_PNPM_VERSION} \\
  --pnpm-tree-sha256 <sha256> \\
  [--receipt <path>]
`

function fail(code, message) {
  throw new AcceptanceFailure(code, message)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('P0-RELEASE-INPUT', `${label} must be an object`)
  }
  return value
}

function bounded(value, label, maximum = 4_096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    fail('P0-RELEASE-INPUT', `${label} must be a bounded non-empty string`)
  }
  return value
}

function commit(value, label) {
  const decoded = bounded(value, label, 40)
  if (!COMMIT.test(decoded)) fail('P0-RELEASE-INPUT', `${label} must be a lowercase 40-character commit`)
  return decoded
}

function expectedSha256(value, label) {
  const match = SHA256.exec(bounded(value, label, 80))
  if (match === null) fail('P0-RELEASE-INPUT', `${label} must be a lowercase SHA-256 digest`)
  return `sha256:${match[1]}`
}

/**
 * Require one attested bundled pnpm tree to match its recomputed packed and installed trees.
 * @param {unknown} attestedValue Attested pnpm tree SHA-256.
 * @param {unknown} packedValue Recomputed packed pnpm tree SHA-256.
 * @param {unknown} installedValue Recomputed installed pnpm tree SHA-256.
 * @returns {string} The common canonical SHA-256.
 */
export function assertReleasePnpmTreeBinding(attestedValue, packedValue, installedValue = packedValue) {
  const attested = expectedSha256(attestedValue, 'attested pnpm tree sha256')
  const packed = expectedSha256(packedValue, 'packed pnpm tree sha256')
  const installed = expectedSha256(installedValue, 'installed pnpm tree sha256')
  if (packed !== attested || installed !== attested) {
    fail('P0-RELEASE-PNPM-ATTESTATION', 'attested, packed, and installed pnpm trees do not match')
  }
  return attested
}

function positiveSize(value, label) {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_ARTIFACT_BYTES) {
    fail('P0-RELEASE-INPUT', `${label} must be between 1 and ${String(MAX_ARTIFACT_BYTES)} bytes`)
  }
  return parsed
}

/** Parse one canonical SemVer without build metadata. */
export function parseReleaseVersion(value, label = 'Release version') {
  const decoded = bounded(value, label, 128)
  const match = SEMVER.exec(decoded)
  if (match === null) fail('P0-RELEASE-VERSION', `${label} must be canonical SemVer without build metadata`)
  const core = match.slice(1, 4).map(Number)
  if (core.some(value => !Number.isSafeInteger(value))) {
    fail('P0-RELEASE-VERSION', `${label} core identifiers must be safe integers`)
  }
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  if (prerelease.some(identifier => /^[0-9]+$/u.test(identifier)
    && identifier.length > 1 && identifier.startsWith('0'))) {
    fail('P0-RELEASE-VERSION', `${label} has a non-canonical numeric prerelease identifier`)
  }
  return Object.freeze({
    raw: decoded,
    major: core[0],
    minor: core[1],
    patch: core[2],
    prerelease: Object.freeze(prerelease),
  })
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined || right[index] === undefined) return left[index] === undefined ? -1 : 1
    if (left[index] === right[index]) continue
    const leftNumeric = /^[0-9]+$/u.test(left[index])
    const rightNumeric = /^[0-9]+$/u.test(right[index])
    if (leftNumeric && rightNumeric) {
      if (left[index].length !== right[index].length) return left[index].length < right[index].length ? -1 : 1
      return left[index] < right[index] ? -1 : 1
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return left[index] < right[index] ? -1 : 1
  }
  return 0
}

function compareReleaseVersions(left, right) {
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** Require a true SemVer upgrade rather than a downgrade or alternate build. */
export function assertAscendingReleaseTransition(previous, current) {
  const before = typeof previous === 'string' ? parseReleaseVersion(previous, 'previous version') : previous
  const after = typeof current === 'string' ? parseReleaseVersion(current, 'current version') : current
  if (compareReleaseVersions(before, after) >= 0) {
    fail('P0-RELEASE-VERSION-ORDER', 'current version must be strictly newer than previous version')
  }
  return Object.freeze({ previous: before.raw, current: after.raw })
}

function artifactSpecification(value, label) {
  const spec = record(value, label)
  const parsedVersion = parseReleaseVersion(spec.version, `${label} version`)
  normalizeReleaseArtifactSource(spec.source, `${label} source`, parsedVersion.raw)
  return Object.freeze({
    source: bounded(spec.source, `${label} source`),
    version: parsedVersion.raw,
    parsedVersion,
    sha256: expectedSha256(spec.sha256, `${label} sha256`),
    sizeBytes: positiveSize(spec.sizeBytes, `${label} size`),
    commit: commit(spec.commit, `${label} commit`),
    manifestSha256: expectedSha256(spec.manifestSha256, `${label} manifest sha256`),
  })
}

function githubReleaseUrl(source, label, expectedVersion = null) {
  let url
  try {
    url = new URL(source)
  } catch {
    fail('P0-RELEASE-SOURCE', `${label} is not a valid URL`)
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== ''
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    fail('P0-RELEASE-SOURCE', `${label} must be a credential-free fixed GitHub HTTPS URL`)
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 6 || segments[0] !== GITHUB_OWNER || segments[1] !== GITHUB_REPOSITORY
    || segments[2] !== 'releases' || segments[3] !== 'download'
    || segments.slice(4).some(segment => segment.length === 0 || /%2f/iu.test(segment))) {
    fail('P0-RELEASE-SOURCE', `${label} must address one ${GITHUB_OWNER}/${GITHUB_REPOSITORY} Release asset`)
  }
  if (expectedVersion !== null && (segments[4] !== `v${expectedVersion}`
    || segments[5] !== `${CENTER_PACKAGE}-${expectedVersion}.tgz`)) {
    fail('P0-RELEASE-SOURCE', `${label} tag and asset name must match version ${expectedVersion}`)
  }
  return url
}

/**
 * Normalize one exact public Release URL or local rehearsal path.
 * @param {string} source URL or local path.
 * @param {string} label Diagnostic label.
 * @returns {{kind: 'github-release', url: string} | {kind: 'local', path: string}} Source identity.
 */
export function normalizeReleaseArtifactSource(source, label = 'artifact source', expectedVersion = null) {
  const value = bounded(source, label)
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    return Object.freeze({ kind: 'github-release', url: githubReleaseUrl(value, label, expectedVersion).href })
  }
  const path = resolve(value)
  return Object.freeze({ kind: 'local', path })
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('P0-RELEASE-METADATA', `${label} must be a positive integer`)
  return value
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    fail('P0-RELEASE-METADATA', `${label} must be an ISO timestamp`)
  }
  return value
}

function githubApiUrl(path) {
  return new URL(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/${path}`)
}

function githubReleaseAssetUrl(version, name) {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases/download/v${version}/${name}`
}

function exactCiReleaseAssets(value, spec, label = 'CI release payload') {
  const expectedNames = [
    `${CENTER_PACKAGE}-${spec.version}.tgz`,
    'SHA256SUMS',
    'pack-attestation.json',
  ]
  if (!Array.isArray(value) || value.length !== expectedNames.length) {
    fail('P0-RELEASE-CI-PAYLOAD', `${label} must contain exactly the three admitted Release assets`)
  }
  const assets = value.map((candidate, index) => {
    const asset = record(candidate, `${label} asset ${String(index)}`)
    if (asset.name !== expectedNames[index] || !EXACT_SHA256.test(asset.sha256)) {
      fail('P0-RELEASE-CI-PAYLOAD', `${label} asset names or digests changed`)
    }
    return Object.freeze({
      name: asset.name,
      sizeBytes: positiveSize(asset.sizeBytes, `${label} ${asset.name} size`),
      sha256: asset.sha256,
      publicUrl: githubReleaseAssetUrl(spec.version, asset.name),
    })
  })
  if (assets[0].sha256 !== spec.sha256 || assets[0].sizeBytes !== spec.sizeBytes) {
    fail('P0-RELEASE-CI-PAYLOAD', `${label} tgz differs from the release artifact specification`)
  }
  return Object.freeze(assets)
}

async function boundedResponseBytes(response, maximum, code, label) {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => undefined)
    fail(code, `${label} Content-Length exceeded its bound`)
  }
  if (response.body === null) fail(code, `${label} response has no body`)
  const chunks = []
  let total = 0
  for await (const value of response.body) {
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > maximum) fail(code, `${label} response exceeded its byte bound`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

async function fetchGitHubJson(url, fetchImpl, label) {
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        accept: 'application/vnd.github+json',
        'accept-encoding': 'identity',
        'user-agent': 'dsh-extension-center-release-acceptance',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    fail('P0-RELEASE-METADATA', `${label} request failed`)
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-RELEASE-METADATA', `${label} returned HTTP ${String(response.status)}`)
  }
  const encoding = response.headers.get('content-encoding')
  if (encoding !== null && encoding !== 'identity') {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-RELEASE-METADATA', `${label} response changed byte identity`)
  }
  let decoded
  try {
    decoded = JSON.parse((await boundedResponseBytes(
      response,
      MAX_METADATA_BYTES,
      'P0-RELEASE-METADATA',
      label,
    )).toString('utf8'))
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error
    fail('P0-RELEASE-METADATA', `${label} response is not JSON`)
  }
  return record(decoded, `${label} response`)
}

/** Bind GitHub Release and tag metadata to one exact three-file CI payload. */
export function validateGitHubReleaseMetadata(specification, releaseValue, commitValue, ciReleaseAssetsValue) {
  const spec = artifactSpecification(specification, 'GitHub Release artifact')
  const expectedAssets = exactCiReleaseAssets(ciReleaseAssetsValue, spec)
  const source = normalizeReleaseArtifactSource(spec.source, 'GitHub Release source', spec.version)
  if (source.kind !== 'github-release') fail('P0-RELEASE-METADATA', 'GitHub metadata requires a public Release source')
  const release = record(releaseValue, 'GitHub Release metadata')
  const resolvedCommit = record(commitValue, 'GitHub tag commit metadata')
  const tag = `v${spec.version}`
  const expectedPrerelease = spec.parsedVersion.prerelease.length > 0
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== expectedPrerelease
    || release.html_url !== `https://github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases/tag/${tag}`
    || typeof release.target_commitish !== 'string' || release.target_commitish.length === 0
    || release.target_commitish.length > 256 || resolvedCommit.sha !== spec.commit) {
    fail('P0-RELEASE-METADATA', 'GitHub Release state, tag, or resolved commit did not match the artifact')
  }
  if (!Array.isArray(release.assets)) fail('P0-RELEASE-METADATA', 'GitHub Release assets must be an array')
  const releaseId = positiveInteger(release.id, 'GitHub Release id')
  if (release.assets.length !== expectedAssets.length) {
    fail('P0-RELEASE-METADATA', 'GitHub Release must contain exactly the three CI payload assets')
  }
  const assets = Object.freeze(expectedAssets.map(expected => {
    const matches = release.assets.filter(candidate => candidate?.name === expected.name)
    if (matches.length !== 1) fail('P0-RELEASE-METADATA', `GitHub Release asset ${expected.name} is missing or duplicated`)
    const asset = record(matches[0], `GitHub Release asset ${expected.name}`)
    const assetId = positiveInteger(asset.id, `GitHub asset ${expected.name} id`)
    if (asset.state !== 'uploaded' || asset.size !== expected.sizeBytes || asset.digest !== expected.sha256
      || asset.browser_download_url !== expected.publicUrl
      || asset.url !== `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases/assets/${String(assetId)}`) {
      fail('P0-RELEASE-METADATA', `GitHub asset ${expected.name} identity, digest, size, or URL did not match CI`)
    }
    return Object.freeze({
      id: assetId,
      name: expected.name,
      sizeBytes: expected.sizeBytes,
      sha256: expected.sha256,
      publicUrl: expected.publicUrl,
      updatedAt: timestamp(asset.updated_at, `GitHub asset ${expected.name} updated_at`),
    })
  }))
  return Object.freeze({
    releaseId,
    tag,
    sourceCommit: spec.commit,
    targetCommitish: release.target_commitish,
    prerelease: expectedPrerelease,
    publishedAt: timestamp(release.published_at, 'GitHub Release published_at'),
    assets,
  })
}

async function verifyGitHubReleaseMetadata(spec, ciReleaseAssets, fetchImpl) {
  const tag = `v${spec.version}`
  const [release, resolvedCommit] = await Promise.all([
    fetchGitHubJson(githubApiUrl(`releases/tags/${encodeURIComponent(tag)}`), fetchImpl, 'GitHub Release metadata'),
    fetchGitHubJson(githubApiUrl(`commits/${encodeURIComponent(tag)}`), fetchImpl, 'GitHub tag commit'),
  ])
  return validateGitHubReleaseMetadata(spec, release, resolvedCommit, ciReleaseAssets)
}

function ghVersion(value) {
  const match = /^gh version (\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(bounded(value, 'GitHub CLI version output', 4_096))
  if (match === null) fail('P0-RELEASE-IMMUTABILITY', 'GitHub CLI did not report one semantic version')
  const version = match.slice(1).map(Number)
  if (version.some(part => !Number.isSafeInteger(part))
    || version[0] < 2 || version[0] === 2 && (version[1] < 88 || version[1] === 88 && version[2] < 1)) {
    fail('P0-RELEASE-IMMUTABILITY', 'GitHub CLI must be version 2.88.1 or newer for immutable Release verification')
  }
  return `${String(version[0])}.${String(version[1])}.${String(version[2])}`
}

function exactBase64(value, label) {
  const encoded = bounded(value, label, MAX_GH_OUTPUT_BYTES)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length < 2 || bytes.toString('base64') !== encoded) {
    fail('P0-RELEASE-IMMUTABILITY', `${label} is not canonical base64`)
  }
  return bytes
}

function releaseAttestationResult(value, expected) {
  const result = record(value, 'GitHub immutable Release verification result')
  const attestation = record(result.attestation, 'GitHub immutable Release attestation')
  const bundle = record(attestation.bundle, 'GitHub immutable Release attestation bundle')
  const envelope = record(bundle.dsseEnvelope, 'GitHub immutable Release DSSE envelope')
  if (attestation.initiator !== 'github' || envelope.payloadType !== 'application/vnd.in-toto+json') {
    fail('P0-RELEASE-IMMUTABILITY', 'GitHub Release attestation issuer or payload type is invalid')
  }
  let statement
  try {
    statement = JSON.parse(exactBase64(envelope.payload, 'GitHub immutable Release statement').toString('utf8'))
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error
    fail('P0-RELEASE-IMMUTABILITY', 'GitHub immutable Release statement is not JSON')
  }
  const decoded = record(statement, 'GitHub immutable Release statement')
  const predicate = record(decoded.predicate, 'GitHub immutable Release predicate')
  if (decoded._type !== RELEASE_STATEMENT_TYPE || decoded.predicateType !== RELEASE_PREDICATE_TYPE
    || predicate.repository !== `${GITHUB_OWNER}/${GITHUB_REPOSITORY}`
    || predicate.tag !== expected.tag || String(predicate.releaseId) !== String(expected.releaseId)) {
    fail('P0-RELEASE-IMMUTABILITY', 'GitHub immutable Release statement does not bind the exact repository, tag, and Release id')
  }
  if (!Array.isArray(decoded.subject) || decoded.subject.length !== expected.assets.length + 1) {
    fail('P0-RELEASE-IMMUTABILITY', 'GitHub immutable Release statement has an unexpected subject set')
  }
  const tagUri = `pkg:github/${GITHUB_OWNER}/${GITHUB_REPOSITORY}@${expected.tag}`
  const tagSubjects = decoded.subject.filter(subject => subject?.uri === tagUri)
  if (tagSubjects.length !== 1) fail('P0-RELEASE-IMMUTABILITY', 'GitHub immutable Release statement omitted its exact tag subject')
  const tagDigest = record(tagSubjects[0].digest, 'GitHub immutable Release tag digest')
  if (Object.keys(tagDigest).length !== 1 || !SHA1.test(tagDigest.sha1)) {
    fail('P0-RELEASE-IMMUTABILITY', 'GitHub immutable Release tag subject is not one SHA-1 ref digest')
  }
  for (const expectedAsset of expected.assets) {
    const subjects = decoded.subject.filter(subject => subject?.name === expectedAsset.name)
    if (subjects.length !== 1) {
      fail('P0-RELEASE-IMMUTABILITY', `GitHub immutable Release statement omitted exact asset ${expectedAsset.name}`)
    }
    const subjectDigest = record(subjects[0].digest, `GitHub immutable Release asset ${expectedAsset.name} digest`)
    if (Object.keys(subjectDigest).length !== 1 || `sha256:${subjectDigest.sha256}` !== expectedAsset.sha256) {
      fail('P0-RELEASE-IMMUTABILITY', `GitHub immutable Release statement changed asset ${expectedAsset.name}`)
    }
  }
  const verificationResult = record(result.verificationResult, 'GitHub immutable Release signature verification')
  return Object.freeze({
    bundleSha256: `sha256:${sha256(Buffer.from(canonicalJson(bundle)))}`,
    statementSha256: `sha256:${sha256(Buffer.from(canonicalJson(decoded)))}`,
    verificationResultSha256: `sha256:${sha256(Buffer.from(canonicalJson(verificationResult)))}`,
    tagRefSha1: tagDigest.sha1,
  })
}

/** Bind one `gh release verify` and one `verify-asset` result per exact CI payload file. */
export function validateGitHubImmutableReleaseProof(value) {
  const input = record(value, 'GitHub immutable Release proof')
  const tag = bounded(input.tag, 'GitHub immutable Release tag', 128)
  const releaseId = positiveInteger(input.releaseId, 'GitHub immutable Release id')
  const assets = input.assets
  if (!Array.isArray(assets) || assets.length !== 3) {
    fail('P0-RELEASE-IMMUTABILITY', 'GitHub immutable Release proof requires exactly three assets')
  }
  const exactAssets = Object.freeze(assets.map((value, index) => {
    const asset = record(value, `GitHub immutable Release asset ${String(index)}`)
    if (!EXACT_SHA256.test(asset.sha256)) fail('P0-RELEASE-IMMUTABILITY', 'GitHub immutable Release asset digest is invalid')
    return Object.freeze({
      name: bounded(asset.name, `GitHub immutable Release asset ${String(index)} name`, 256),
      sizeBytes: positiveSize(asset.sizeBytes, `GitHub immutable Release asset ${String(index)} size`),
      sha256: asset.sha256,
    })
  }))
  const expected = Object.freeze({ tag, releaseId, assets: exactAssets })
  const release = releaseAttestationResult(input.releaseResult, expected)
  if (!Array.isArray(input.assetResults) || input.assetResults.length !== exactAssets.length) {
    fail('P0-RELEASE-IMMUTABILITY', 'GitHub immutable Release proof requires one signed result per asset')
  }
  const assetProofs = Object.freeze(exactAssets.map((asset, index) => {
    const candidate = record(input.assetResults[index], `GitHub immutable Release asset proof ${String(index)}`)
    if (candidate.name !== asset.name) fail('P0-RELEASE-IMMUTABILITY', 'GitHub immutable Release asset proof order changed')
    const proof = releaseAttestationResult(candidate.result, expected)
    if (proof.bundleSha256 !== release.bundleSha256 || proof.statementSha256 !== release.statementSha256
      || proof.tagRefSha1 !== release.tagRefSha1) {
      fail('P0-RELEASE-IMMUTABILITY', `GitHub immutable proof for ${asset.name} is not the same Release attestation`)
    }
    return Object.freeze({
      name: asset.name,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      verificationResultSha256: proof.verificationResultSha256,
    })
  }))
  return Object.freeze({
    repository: `${GITHUB_OWNER}/${GITHUB_REPOSITORY}`,
    tag,
    releaseId,
    ghVersion: ghVersion(input.ghVersionOutput),
    bundleSha256: release.bundleSha256,
    statementSha256: release.statementSha256,
    releaseVerificationResultSha256: release.verificationResultSha256,
    tagRefSha1: release.tagRefSha1,
    assets: assetProofs,
  })
}

async function runBoundedGh(arguments_) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('gh', arguments_, {
      env: { ...process.env, GH_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 120_000)
    timer.unref()
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_GH_OUTPUT_BYTES) child.kill('SIGKILL')
      else stdout.push(chunk)
    })
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_GH_OUTPUT_BYTES) child.kill('SIGKILL')
    })
    child.once('error', () => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      rejectRun(new AcceptanceFailure('P0-RELEASE-IMMUTABILITY', 'GitHub CLI could not be executed'))
    })
    child.once('close', exitCode => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (exitCode !== 0 || timedOut || stdoutBytes > MAX_GH_OUTPUT_BYTES || stderrBytes > MAX_GH_OUTPUT_BYTES) {
        rejectRun(new AcceptanceFailure(
          'P0-RELEASE-IMMUTABILITY',
          `GitHub immutable Release verification failed (exit=${String(exitCode)}; stdoutBytes=${String(stdoutBytes)}; stderrBytes=${String(stderrBytes)})`,
        ))
        return
      }
      resolveRun(Buffer.concat(stdout, stdoutBytes).toString('utf8'))
    })
  })
}

function ghJson(value, label) {
  const text = bounded(value, label, MAX_GH_OUTPUT_BYTES)
  try {
    return record(JSON.parse(text), label)
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error
    fail('P0-RELEASE-IMMUTABILITY', `${label} is not JSON`)
  }
}

async function verifyGitHubImmutableRelease(tag, releaseId, downloadedAssets, runner = runBoundedGh) {
  const ghVersionOutput = await runner(['--version'])
  const releaseResult = ghJson(await runner([
    'release', 'verify', tag, '--repo', `${GITHUB_OWNER}/${GITHUB_REPOSITORY}`, '--format', 'json',
  ]), 'gh release verify output')
  const assetResults = []
  for (const asset of downloadedAssets) {
    const result = ghJson(await runner([
      'release', 'verify-asset', tag, asset.path,
      '--repo', `${GITHUB_OWNER}/${GITHUB_REPOSITORY}`, '--format', 'json',
    ]), `gh release verify-asset output for ${asset.name}`)
    assetResults.push(Object.freeze({ name: asset.name, result }))
  }
  return validateGitHubImmutableReleaseProof({
    tag,
    releaseId,
    assets: downloadedAssets,
    ghVersionOutput,
    releaseResult,
    assetResults,
  })
}

function redirectUrl(location, current) {
  let next
  try {
    next = new URL(location, current)
  } catch {
    fail('P0-RELEASE-REDIRECT', 'Release download returned an invalid redirect location')
  }
  if (next.protocol !== 'https:' || next.port !== '' || next.username !== '' || next.password !== ''
    || next.hash !== '' || !REDIRECT_HOSTS.has(next.hostname)) {
    fail('P0-RELEASE-REDIRECT', 'Release download redirected outside the fixed GitHub asset hosts')
  }
  return next
}

async function fetchReleaseResponse(url, fetchImpl) {
  let current = new URL(url)
  const visited = new Set([current.href])
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    let response
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'application/octet-stream',
          'accept-encoding': 'identity',
          'user-agent': 'dsh-extension-center-release-acceptance',
        },
        signal: AbortSignal.timeout(120_000),
      })
    } catch {
      throw new AcceptanceFailure('P0-RELEASE-DOWNLOAD', 'fixed GitHub Release download failed')
    }
    if (response.status === 200) {
      return Object.freeze({ response, finalUrl: current, redirects })
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined)
      fail('P0-RELEASE-DOWNLOAD', `GitHub Release download returned HTTP ${String(response.status)}`)
    }
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (location === null || redirects === 2) {
      fail('P0-RELEASE-REDIRECT', 'GitHub Release download exceeded its redirect bound')
    }
    const next = redirectUrl(location, current)
    if (visited.has(next.href)) fail('P0-RELEASE-REDIRECT', 'GitHub Release download entered a redirect loop')
    visited.add(next.href)
    current = next
  }
  fail('P0-RELEASE-REDIRECT', 'GitHub Release redirect handling did not settle')
}

async function writeVerifiedBytes(destination, bytes, expected) {
  if (bytes.length !== expected.sizeBytes || `sha256:${sha256(bytes)}` !== expected.sha256) {
    fail('P0-RELEASE-ARTIFACT-IDENTITY', 'Release artifact bytes do not match the expected size and SHA-256')
  }
  const handle = await open(destination, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function downloadVerified(destination, source, expected, fetchImpl) {
  const { response, finalUrl, redirects } = await fetchReleaseResponse(source.url, fetchImpl)
  const encoding = response.headers.get('content-encoding')
  if (encoding !== null && encoding !== 'identity') {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-RELEASE-DOWNLOAD', 'GitHub Release response used a content encoding that changes byte identity')
  }
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && (!/^[0-9]+$/u.test(declaredLength)
    || Number(declaredLength) !== expected.sizeBytes)) {
    await response.body?.cancel().catch(() => undefined)
    fail('P0-RELEASE-ARTIFACT-IDENTITY', 'GitHub Release Content-Length does not match the expected artifact size')
  }
  if (response.body === null) fail('P0-RELEASE-DOWNLOAD', 'GitHub Release response has no body')
  const handle = await open(destination, 'wx', 0o600)
  const sha256Hash = createHash('sha256')
  const sha512Hash = createHash('sha512')
  let sizeBytes = 0
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value)
      sizeBytes += chunk.length
      if (sizeBytes > expected.sizeBytes || sizeBytes > MAX_ARTIFACT_BYTES) {
        fail('P0-RELEASE-ARTIFACT-BOUND', 'GitHub Release response exceeded its exact byte bound')
      }
      sha256Hash.update(chunk)
      sha512Hash.update(chunk)
      await handle.write(chunk)
    }
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(destination, { force: true })
    throw error
  }
  await handle.close()
  const observed = `sha256:${sha256Hash.digest('hex')}`
  if (sizeBytes !== expected.sizeBytes || observed !== expected.sha256) {
    await rm(destination, { force: true })
    fail('P0-RELEASE-ARTIFACT-IDENTITY', 'downloaded GitHub Release bytes do not match expected size and SHA-256')
  }
  return Object.freeze({
    sourceKind: 'github-release',
    publicUrl: source.url,
    finalHost: finalUrl.hostname,
    redirects,
    sizeBytes,
    sha256: observed,
    sha512: `sha512-${sha512Hash.digest('base64')}`,
  })
}

/**
 * Acquire one artifact into an isolated destination and verify its byte identity.
 * @param {{source: string, version: string, sha256: string, sizeBytes: number}} specification Expected artifact.
 * @param {string} destination Exclusive destination path.
 * @param {{fetchImpl?: typeof fetch}} [dependencies] Deterministic fetch seam for direct tests.
 * @returns {Promise<Readonly<Record<string, unknown>>>} Verified acquisition evidence.
 */
export async function acquireVerifiedReleaseArtifact(specification, destination, dependencies = {}) {
  const spec = artifactSpecification(specification, 'Release artifact')
  const expected = Object.freeze({ version: spec.version, sha256: spec.sha256, sizeBytes: spec.sizeBytes })
  const source = normalizeReleaseArtifactSource(spec.source, 'Release artifact source', spec.version)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  if (source.kind === 'github-release') {
    const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') fail('P0-RELEASE-DOWNLOAD', 'HTTPS fetch is unavailable')
    const ciReleaseAssets = exactCiReleaseAssets(dependencies.ciReleaseAssets, spec)
    const release = await verifyGitHubReleaseMetadata(spec, ciReleaseAssets, fetchImpl)
    const sidecarRoot = join(dirname(destination), `.${basename(destination)}.release-assets`)
    await mkdir(sidecarRoot, { mode: 0o700 })
    const downloadedAssets = []
    let tgzEvidence = null
    for (const asset of ciReleaseAssets) {
      const path = asset.name.endsWith('.tgz') ? destination : join(sidecarRoot, asset.name)
      const evidence = await downloadVerified(path, { url: asset.publicUrl }, asset, fetchImpl)
      downloadedAssets.push(Object.freeze({
        name: asset.name,
        path: await realpath(path),
        sizeBytes: evidence.sizeBytes,
        sha256: evidence.sha256,
        publicUrl: evidence.publicUrl,
        finalHost: evidence.finalHost,
        redirects: evidence.redirects,
      }))
      if (asset.name.endsWith('.tgz')) tgzEvidence = evidence
    }
    if (tgzEvidence === null) fail('P0-RELEASE-CI-PAYLOAD', 'CI Release payload omitted its tgz')
    const immutableRelease = dependencies.immutableReleaseProof === undefined
      ? await verifyGitHubImmutableRelease(release.tag, release.releaseId, downloadedAssets, dependencies.ghRunner)
      : validateGitHubImmutableReleaseProof(dependencies.immutableReleaseProof)
    if (immutableRelease.tag !== release.tag || immutableRelease.releaseId !== release.releaseId
      || immutableRelease.assets.some((asset, index) => asset.name !== downloadedAssets[index].name
        || asset.sha256 !== downloadedAssets[index].sha256 || asset.sizeBytes !== downloadedAssets[index].sizeBytes)) {
      fail('P0-RELEASE-IMMUTABILITY', 'GitHub immutable proof does not bind the downloaded exact Release assets')
    }
    return Object.freeze({
      ...tgzEvidence,
      version: expected.version,
      sourceCommit: spec.commit,
      release,
      releasePayload: Object.freeze(downloadedAssets.map(({ path: _path, ...asset }) => asset)),
      immutableRelease,
    })
  }
  const canonical = await realpath(source.path)
  const info = await lstat(canonical)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.sizeBytes) {
    fail('P0-RELEASE-ARTIFACT-IDENTITY', 'local Release artifact is not the expected real file')
  }
  const bytes = await readFile(canonical)
  await writeVerifiedBytes(destination, bytes, expected)
  return Object.freeze({
    sourceKind: 'local',
    publicUrl: null,
    finalHost: null,
    redirects: 0,
    version: expected.version,
    sourceCommit: spec.commit,
    sizeBytes: bytes.length,
    sha256: `sha256:${sha256(bytes)}`,
    sha512: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    release: null,
    releasePayload: null,
    immutableRelease: null,
  })
}

/**
 * Parse exact Release artifact coordinates for the standalone acceptance runner.
 * @param {string[]} arguments_ CLI arguments after the executable and script path.
 * @returns {Readonly<Record<string, unknown>>} Normalized acceptance input or help selection.
 */
export function parseReleaseAcceptanceArguments(arguments_) {
  if (!Array.isArray(arguments_)) fail('P0-RELEASE-INPUT', 'CLI arguments must be an array')
  if (arguments_.length === 1 && arguments_[0] === '--help') return Object.freeze({ help: true })
  const values = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (typeof key !== 'string' || !key.startsWith('--') || value === undefined || values.has(key)) {
      fail('P0-RELEASE-INPUT', 'CLI flags must be unique key/value pairs')
    }
    values.set(key, value)
  }
  const admitted = new Set([
    '--current', '--current-version', '--current-sha256', '--current-size', '--current-commit',
    '--current-manifest-sha256',
    '--previous', '--previous-version', '--previous-sha256', '--previous-size', '--previous-commit',
    '--previous-manifest-sha256',
    '--runtime-receipt', '--runtime-receipt-sha256', '--ci-receipt', '--ci-receipt-sha256',
    '--previous-ci-receipt', '--previous-ci-receipt-sha256',
    '--pnpm-bin', '--pnpm-root', '--pnpm-version', '--pnpm-tree-sha256', '--receipt',
  ])
  for (const key of values.keys()) if (!admitted.has(key)) fail('P0-RELEASE-INPUT', `unknown CLI flag ${key}`)
  const artifact = prefix => {
    const keys = [
      `--${prefix}`, `--${prefix}-version`, `--${prefix}-sha256`, `--${prefix}-size`,
      `--${prefix}-commit`, `--${prefix}-manifest-sha256`,
    ]
    const present = keys.filter(key => values.has(key))
    if (present.length === 0 && prefix === 'previous') return null
    if (present.length !== keys.length) fail('P0-RELEASE-INPUT', `${prefix} artifact coordinates must be complete`)
    return artifactSpecification({
      source: values.get(keys[0]),
      version: values.get(keys[1]),
      sha256: values.get(keys[2]),
      sizeBytes: values.get(keys[3]),
      commit: values.get(keys[4]),
      manifestSha256: values.get(keys[5]),
    }, `${prefix} artifact`)
  }
  const current = artifact('current')
  if (current === null) fail('P0-RELEASE-INPUT', 'current artifact coordinates are required')
  const previous = artifact('previous')
  if (previous !== null) {
    assertAscendingReleaseTransition(previous.parsedVersion, current.parsedVersion)
    if (previous.sha256 === current.sha256 || previous.commit === current.commit
      || previous.manifestSha256 === current.manifestSha256) {
      fail('P0-RELEASE-INPUT', 'previous and current releases must have distinct artifact, manifest, and commit identities')
    }
  }
  const previousCiKeys = ['--previous-ci-receipt', '--previous-ci-receipt-sha256']
  const previousCiPresent = previousCiKeys.filter(key => values.has(key))
  if ((previous === null && previousCiPresent.length !== 0)
    || (previous !== null && previousCiPresent.length !== previousCiKeys.length)) {
    fail('P0-RELEASE-INPUT', 'previous CI receipt coordinates must be present exactly when a previous artifact is supplied')
  }
  for (const key of [
    '--runtime-receipt', '--runtime-receipt-sha256', '--ci-receipt', '--ci-receipt-sha256', '--pnpm-bin', '--pnpm-root',
    '--pnpm-version', '--pnpm-tree-sha256',
  ]) {
    if (!values.has(key)) fail('P0-RELEASE-INPUT', `${key} is required`)
  }
  const pnpmVersion = bounded(values.get('--pnpm-version'), 'pnpm version', 32)
  if (pnpmVersion !== PINNED_PNPM_VERSION) {
    fail('P0-RELEASE-PNPM', `pnpm version must be exactly ${PINNED_PNPM_VERSION}`)
  }
  const defaultReceipt = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../.artifacts/acceptance/release/receipt.json',
  )
  return Object.freeze({
    help: false,
    previous,
    current,
    runtimeAcceptance: Object.freeze({
      path: resolve(bounded(values.get('--runtime-receipt'), 'runtime receipt path')),
      sha256: expectedSha256(values.get('--runtime-receipt-sha256'), 'runtime receipt sha256'),
    }),
    ciReceipt: Object.freeze({
      path: resolve(bounded(values.get('--ci-receipt'), 'GitHub CI receipt path')),
      sha256: expectedSha256(values.get('--ci-receipt-sha256'), 'GitHub CI receipt sha256'),
    }),
    previousCiReceipt: previous === null ? null : Object.freeze({
      path: resolve(bounded(values.get('--previous-ci-receipt'), 'previous GitHub CI receipt path')),
      sha256: expectedSha256(values.get('--previous-ci-receipt-sha256'), 'previous GitHub CI receipt sha256'),
    }),
    pnpm: Object.freeze({
      binPath: resolve(bounded(values.get('--pnpm-bin'), 'pnpm bin path')),
      packageRoot: resolve(bounded(values.get('--pnpm-root'), 'pnpm package root')),
      version: pnpmVersion,
      treeSha256: expectedSha256(values.get('--pnpm-tree-sha256'), 'pnpm tree sha256'),
    }),
    receiptPath: resolve(values.has('--receipt')
      ? bounded(values.get('--receipt'), 'receipt path')
      : defaultReceipt),
  })
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Validate the exact packed manifest bytes and complete release-facing identity. */
export function assertPackedManifestIdentity(manifestBytes, specification, authorityManifest) {
  const spec = artifactSpecification(specification, 'packed artifact')
  const observedManifestSha256 = `sha256:${sha256(manifestBytes)}`
  if (observedManifestSha256 !== spec.manifestSha256) {
    fail('P0-RELEASE-PACKAGE', 'packed package.json bytes did not match the expected manifest SHA-256')
  }
  let manifest
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'))
  } catch {
    fail('P0-RELEASE-PACKAGE', 'Release artifact package manifest is not JSON')
  }
  const authority = record(authorityManifest, 'release manifest authority')
  assertNoPackageLifecycleScripts(manifest, `packed ${spec.version}`)
  if (manifest.name !== CENTER_PACKAGE || manifest.version !== spec.version || manifest.bin !== undefined) {
    fail('P0-RELEASE-PACKAGE', 'packed package name, version, or forbidden bin did not match')
  }
  for (const field of EXPECTED_MANIFEST_FIELDS) {
    if (canonicalJson(manifest[field]) !== canonicalJson(authority[field])) {
      fail('P0-RELEASE-PACKAGE', `packed package manifest changed authoritative field ${field}`)
    }
  }
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml'
    || manifest.dsh?.client?.platform !== 'web'
    || manifest.engines?.dsh !== TARGET_DSH_VERSION) {
    fail('P0-RELEASE-PACKAGE', `Release artifact is not the full Host+Web Client Bundle for official ${TARGET_DSH_VERSION}`)
  }
  return Object.freeze({ manifest, manifestSha256: observedManifestSha256 })
}

async function treeDigest(root, options = {}) {
  const canonicalRoot = await realpath(root)
  const hash = createHash('sha256')
  const visit = async path => {
    const name = relative(canonicalRoot, path).split(sep).join('/') || '.'
    if (name !== '.' && options.exclude?.(name) === true) return
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      if (options.rejectLinks === true) fail('P0-RELEASE-PACKAGE', `unexpected symbolic link in ${name}`)
      hash.update(`link:${name}:${await readlink(path)}\0`)
      return
    }
    if (info.isFile()) {
      hash.update(`file:${name}:${String(info.size)}\0`)
      hash.update(await readFile(path))
      return
    }
    if (!info.isDirectory()) fail('P0-RELEASE-PACKAGE', `unsupported filesystem entry in ${name}`)
    hash.update(`directory:${name}\0`)
    for (const entry of (await readdir(path)).sort()) await visit(join(path, entry))
  }
  await visit(canonicalRoot)
  return `sha256:${hash.digest('hex')}`
}

export function validateArchiveEntries(listOutput, verboseOutput) {
  const entries = listOutput.split(/\r?\n/u).filter(Boolean)
  const verbose = verboseOutput.split(/\r?\n/u).filter(Boolean)
  if (entries.length === 0 || entries.length > 20_000 || entries.length !== verbose.length) {
    fail('P0-RELEASE-PACKAGE', 'Release archive entry inventory is empty, excessive, or ambiguous')
  }
  const unique = new Set()
  for (const [index, name] of entries.entries()) {
    if (name.length > 1_024 || name.includes('\0') || name.includes('\\') || !/^[ -~]+$/u.test(name)
      || !(name === 'package' || name.startsWith('package/'))
      || name.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
      || !['-', 'd'].includes(verbose[index][0]) || unique.has(name)) {
      fail('P0-RELEASE-PACKAGE', 'Release archive contains an unsafe, duplicate, or non-regular entry')
    }
    unique.add(name)
  }
  for (const required of ['package/package.json', 'package/cordis.patch.yml']) {
    if (!unique.has(required)) fail('P0-RELEASE-PACKAGE', `Release archive omitted ${required}`)
  }
  return entries.length
}

async function inspectPackedArtifact(artifactPath, spec, env, unpackRoot, authorityManifest) {
  const [list, verbose] = await Promise.all([
    runChecked('tar', ['-tzf', artifactPath], { cwd: dirname(artifactPath), env, timeoutMs: 30_000 }),
    runChecked('tar', ['-tvzf', artifactPath], { cwd: dirname(artifactPath), env, timeoutMs: 30_000 }),
  ])
  const entryCount = validateArchiveEntries(list.stdout, verbose.stdout)
  await mkdir(unpackRoot, { mode: 0o700 })
  await runChecked('tar', ['-xzf', artifactPath, '-C', unpackRoot], {
    cwd: dirname(artifactPath),
    env,
    timeoutMs: 60_000,
  })
  const packageRoot = await realpath(join(unpackRoot, 'package'))
  if (!isInside(unpackRoot, packageRoot)) fail('P0-RELEASE-PACKAGE', 'unpacked package escaped its private root')
  const manifestBytes = await readFile(join(packageRoot, 'package.json'))
  const manifestIdentity = assertPackedManifestIdentity(manifestBytes, spec, authorityManifest)
  const patchBytes = await readFile(join(packageRoot, 'cordis.patch.yml'))
  const payloadTreeSha256 = await treeDigest(packageRoot, {
    exclude: name => name === 'node_modules' || name.startsWith('node_modules/'),
    rejectLinks: true,
  })
  const packedPnpmRoot = await realpath(join(packageRoot, 'node_modules', 'pnpm'))
  const packedPnpmManifest = JSON.parse(await readFile(join(packedPnpmRoot, 'package.json'), 'utf8'))
  if (packedPnpmManifest.name !== 'pnpm'
    || packedPnpmManifest.version !== authorityManifest.dependencies?.pnpm) {
    fail('P0-RELEASE-PACKAGE', 'packed private pnpm did not match the authoritative dependency')
  }
  return Object.freeze({
    ...manifestIdentity,
    entryCount,
    packageRoot,
    payloadTreeSha256,
    patchSha256: `sha256:${sha256(patchBytes)}`,
    bundledPnpmTreeSha256: await immutablePackageTreeDigest(packedPnpmRoot),
  })
}

function isInside(root, path) {
  const offset = relative(root, path)
  return offset === '' || offset !== '..' && !offset.startsWith(`..${sep}`)
}

function profileManifest(manifest, label) {
  const value = record(manifest, label)
  const dependencies = value.dependencies === undefined ? {} : record(value.dependencies, `${label} dependencies`)
  const bundles = value.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string')) {
    fail('P0-RELEASE-PROFILE', `${label} Bundle list is invalid`)
  }
  return Object.freeze({ value, dependencies, bundles })
}

function normalizedProfileManifest(manifest) {
  const copy = structuredClone(manifest)
  if (copy.dependencies === undefined) copy.dependencies = {}
  return canonicalJson(copy)
}

async function centerResidue(profileRoot) {
  const observed = []
  const visit = async path => {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      const name = relative(profileRoot, child).split(sep).join('/')
      if (entry.name.includes(CENTER_PACKAGE)) observed.push(name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(child)
    }
  }
  await visit(profileRoot)
  return observed.sort()
}

function markerCount(dump) {
  return dump.split('# == dsh-plugin-extension-center').length - 1
}

async function assertCenterAbsent(profileRoot, manifest, lockfile, dump, code) {
  const decoded = profileManifest(manifest, 'Center-absent Profile manifest')
  if (decoded.dependencies[CENTER_PACKAGE] !== undefined || decoded.bundles.includes(CENTER_PACKAGE)
    || lockfile.includes(CENTER_PACKAGE) || markerCount(dump) !== 0
    || dump.includes('name: dsh-plugin-extension-center')) {
    fail(code, 'Profile retained a Center dependency, Bundle, lock entry, or dump layer')
  }
  const residue = await centerResidue(profileRoot)
  if (residue.length !== 0) fail(code, `Profile retained Center filesystem residue: ${residue.join(', ')}`)
  return residue
}

async function captureProfileBaseline(dshBin, profileRoot, cwd, env) {
  const [manifestText, lockfile, dump] = await Promise.all([
    readFile(join(profileRoot, 'package.json'), 'utf8'),
    readFile(join(profileRoot, 'pnpm-lock.yaml'), 'utf8'),
    runChecked(dshBin, ['--profile', 'web', '--dump-config'], { cwd, env, timeoutMs: 60_000 }),
  ])
  const manifest = JSON.parse(manifestText)
  await assertCenterAbsent(profileRoot, manifest, lockfile, dump.stdout, 'P0-RELEASE-BASELINE')
  return Object.freeze({
    manifest: normalizedProfileManifest(manifest),
    lockSha256: `sha256:${sha256(Buffer.from(lockfile))}`,
    treeWithoutManifestSha256: await treeDigest(profileRoot, {
      exclude: name => name === 'package.json',
    }),
    dumpSha256: `sha256:${sha256(Buffer.from(dump.stdout))}`,
  })
}

/** Require the active Profile lock to bind only the exact archive and SRI. */
export function assertProfileLockBindsArtifact(lockfile, artifactPath, expectedVersion, expectedSha512, forbiddenPath = null) {
  if (typeof lockfile !== 'string' || typeof expectedSha512 !== 'string'
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(expectedSha512)) {
    fail('P0-RELEASE-LOCK', 'Profile lock assertion received invalid evidence')
  }
  const headers = [...lockfile.matchAll(new RegExp(`^  ${CENTER_PACKAGE}@file:[^\\r\\n]+:$`, 'gmu'))]
  const sriMatches = lockfile.split(`integrity: ${expectedSha512}`).length - 1
  if (!lockfile.includes(`specifier: file:${artifactPath}`) || headers.length !== 2 || sriMatches !== 1
    || !lockfile.includes(`version: ${expectedVersion}`)
    || forbiddenPath !== null && lockfile.includes(basename(forbiddenPath))) {
    fail('P0-RELEASE-LOCK', 'Profile lock did not bind only the exact active Center archive and SRI')
  }
  return Object.freeze({ packageSnapshotCount: 1, snapshotCount: 1, integrity: expectedSha512 })
}

async function profileObservation(dshHome, artifact, forbiddenArtifactPath = null) {
  const profileRoot = join(dshHome, 'profiles', 'web')
  const manifest = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
  const decoded = profileManifest(manifest, 'Profile manifest')
  const dependency = decoded.dependencies[CENTER_PACKAGE] ?? null
  const installedRoot = await realpath(join(profileRoot, 'node_modules', CENTER_PACKAGE))
  const installedManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
  if (dependency !== `file:${artifact.path}`
    || decoded.bundles.filter(value => value === CENTER_PACKAGE).length !== 1
    || installedManifest.name !== CENTER_PACKAGE || installedManifest.version !== artifact.spec.version) {
    fail('P0-RELEASE-PROFILE', `Profile did not select exact ${CENTER_PACKAGE}@${artifact.spec.version}`)
  }
  const payloadTreeSha256 = await treeDigest(installedRoot, {
    exclude: name => name === 'node_modules' || name.startsWith('node_modules/'),
    rejectLinks: true,
  })
  const patchSha256 = `sha256:${sha256(await readFile(join(installedRoot, 'cordis.patch.yml')))}`
  const installedPnpmRoot = await realpath(join(installedRoot, 'node_modules', 'pnpm'))
  const bundledPnpmTreeSha256 = await immutablePackageTreeDigest(installedPnpmRoot)
  if (payloadTreeSha256 !== artifact.packed.payloadTreeSha256
    || patchSha256 !== artifact.packed.patchSha256
    || bundledPnpmTreeSha256 !== artifact.packed.bundledPnpmTreeSha256) {
    fail('P0-RELEASE-INSTALLED-IDENTITY', 'installed Center tree, patch, or bundled pnpm differed from the packed artifact')
  }
  assertReleasePnpmTreeBinding(
    artifact.pnpmTreeSha256,
    artifact.packed.bundledPnpmTreeSha256,
    bundledPnpmTreeSha256,
  )
  const lockfile = await readFile(join(profileRoot, 'pnpm-lock.yaml'), 'utf8')
  const lock = assertProfileLockBindsArtifact(
    lockfile,
    artifact.path,
    artifact.spec.version,
    artifact.evidence.sha512,
    forbiddenArtifactPath,
  )
  return Object.freeze({
    dependency,
    bundleCount: 1,
    installedVersion: installedManifest.version,
    payloadTreeSha256,
    patchSha256,
    bundledPnpmTreeSha256,
    lock,
    lockSha256: `sha256:${sha256(Buffer.from(lockfile))}`,
  })
}

async function addCenter(dshBin, artifact, dshHome, cwd, env, forbiddenArtifactPath = null) {
  await runChecked(dshBin, [
    'plugin', '--profile', 'web', 'add', artifact.path,
    '--offline', '--ignore-scripts', '--save-exact',
  ], { cwd, env, timeoutMs: 180_000 })
  const profile = await profileObservation(dshHome, artifact, forbiddenArtifactPath)
  const dump = await runChecked(dshBin, ['--profile', 'web', '--dump-config'], {
    cwd,
    env,
    timeoutMs: 60_000,
  })
  if (markerCount(dump.stdout) !== 1 || !dump.stdout.includes('name: dsh-plugin-extension-center')) {
    fail('P0-RELEASE-BUNDLE', `official dump did not contain one ${CENTER_PACKAGE}@${artifact.spec.version} Bundle layer`)
  }
  return Object.freeze({
    ...profile,
    dumpMarkerCount: 1,
    dumpSha256: `sha256:${sha256(Buffer.from(dump.stdout))}`,
  })
}

async function assertRemoved(dshBin, profileRoot, baseline, cwd, env) {
  const [manifestText, lockfile, dump] = await Promise.all([
    readFile(join(profileRoot, 'package.json'), 'utf8'),
    readFile(join(profileRoot, 'pnpm-lock.yaml'), 'utf8'),
    runChecked(dshBin, ['--profile', 'web', '--dump-config'], { cwd, env, timeoutMs: 60_000 }),
  ])
  const manifest = JSON.parse(manifestText)
  await assertCenterAbsent(profileRoot, manifest, lockfile, dump.stdout, 'P0-RELEASE-REMOVE')
  const observed = Object.freeze({
    manifest: normalizedProfileManifest(manifest),
    lockSha256: `sha256:${sha256(Buffer.from(lockfile))}`,
    treeWithoutManifestSha256: await treeDigest(profileRoot, {
      exclude: name => name === 'package.json',
    }),
    dumpSha256: `sha256:${sha256(Buffer.from(dump.stdout))}`,
  })
  assertProfileBaselineRestored(baseline, observed)
  return Object.freeze({
    dependencyAbsent: true,
    bundleAbsent: true,
    lockResidueAbsent: true,
    filesystemResidueAbsent: true,
    dumpAbsent: true,
    exactBaselineRestored: true,
  })
}

/** Require every stable Profile baseline field to return exactly after removal. */
export function assertProfileBaselineRestored(baselineValue, observedValue) {
  const baseline = record(baselineValue, 'Profile baseline')
  const observed = record(observedValue, 'observed removed Profile')
  for (const field of ['manifest', 'lockSha256', 'treeWithoutManifestSha256', 'dumpSha256']) {
    if (observed[field] !== baseline[field]) {
      fail('P0-RELEASE-REMOVE-BASELINE', `official CLI remove changed baseline field ${field}`)
    }
  }
  return true
}

function runtimeArtifact(value, spec, label) {
  const observed = record(value, label)
  const pnpmTreeSha256 = expectedSha256(observed.pnpmTreeSha256, `${label} pnpm tree sha256`)
  if (observed.version !== spec.version || observed.sha256 !== spec.sha256
    || observed.manifestSha256 !== spec.manifestSha256 || observed.sourceCommit !== spec.commit
    || observed.hostBoot !== true || observed.clientBoot !== true || observed.rpcRegistration !== true) {
    fail('P0-RELEASE-RUNTIME-RECEIPT', `${label} did not bind the artifact and passed Host+Client/RPC boot`)
  }
  return Object.freeze({
    version: observed.version,
    sha256: observed.sha256,
    manifestSha256: observed.manifestSha256,
    pnpmTreeSha256,
    sourceCommit: observed.sourceCommit,
  })
}

/** Validate the required external Host+Client boot receipt against both artifacts. */
export function validateRuntimeAcceptanceReceipt(receiptValue, previous, current) {
  const receipt = record(receiptValue, 'runtime acceptance receipt')
  const target = record(receipt.target, 'runtime acceptance target')
  const artifacts = record(receipt.artifacts, 'runtime acceptance artifacts')
  if (receipt.schemaVersion !== 2 || receipt.acceptanceId !== RUNTIME_ACCEPTANCE_ID || receipt.status !== 'passed'
    || receipt.profileId !== 'web' || target.dshPackage !== `@deepseek-ai/dsh@${TARGET_DSH_VERSION}`
    || target.auditedSourceCommit !== TARGET_DSH_COMMIT
    || receipt.officialDshPackageTreeUnchanged !== true) {
    fail('P0-RELEASE-RUNTIME-RECEIPT', 'runtime acceptance receipt target or status is invalid')
  }
  const expectedPrevious = previous === null ? null : runtimeArtifact(artifacts.previous, previous, 'previous runtime artifact')
  if (previous === null && artifacts.previous !== null) {
    fail('P0-RELEASE-RUNTIME-RECEIPT', 'runtime receipt included an unexpected previous artifact')
  }
  const expectedCurrent = runtimeArtifact(artifacts.current, current, 'current runtime artifact')
  const ci = record(receipt.ciPackAttestation, 'runtime CI pack attestation')
  const ciArtifactValue = record(ci.artifact, 'runtime CI-attested artifact')
  const ciPnpmTreeSha256 = expectedSha256(
    ciArtifactValue.pnpmTreeSha256,
    'runtime CI-attested pnpm tree sha256',
  )
  if (ciArtifactValue.version !== current.version || ciArtifactValue.sha256 !== current.sha256
    || ciArtifactValue.sizeBytes !== current.sizeBytes
    || ciArtifactValue.manifestSha256 !== current.manifestSha256
    || ciArtifactValue.sourceCommit !== current.commit
    || ciPnpmTreeSha256 !== expectedCurrent.pnpmTreeSha256) {
    fail('P0-RELEASE-RUNTIME-RECEIPT', 'runtime CI-attested artifact does not match the current Release')
  }
  const ciArtifact = Object.freeze({
    version: ciArtifactValue.version,
    sha256: ciArtifactValue.sha256,
    sizeBytes: ciArtifactValue.sizeBytes,
    manifestSha256: ciArtifactValue.manifestSha256,
    pnpmTreeSha256: ciPnpmTreeSha256,
    sourceCommit: ciArtifactValue.sourceCommit,
  })
  if (ci.acceptanceId !== 'P0-GITHUB-CI-EXACT-COMMIT'
    || typeof ci.fileSha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(ci.fileSha256)
    || typeof ci.receiptDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(ci.receiptDigest)) {
    fail('P0-RELEASE-RUNTIME-RECEIPT', 'runtime receipt CI pack binding is invalid')
  }
  return Object.freeze({
    acceptanceId: receipt.acceptanceId,
    previous: expectedPrevious,
    current: expectedCurrent,
    ciPackAttestation: Object.freeze({
      acceptanceId: ci.acceptanceId,
      fileSha256: ci.fileSha256,
      receiptDigest: ci.receiptDigest,
      artifact: ciArtifact,
    }),
    officialDshPackageTreeUnchanged: true,
  })
}

async function loadRuntimeAcceptance(input, previous, current) {
  const path = resolve(bounded(input.path, 'runtime receipt path'))
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_RUNTIME_RECEIPT_BYTES) {
    fail('P0-RELEASE-RUNTIME-RECEIPT', 'runtime acceptance input must be a bounded regular file')
  }
  const bytes = await readFile(path)
  const observedSha256 = `sha256:${sha256(bytes)}`
  if (observedSha256 !== expectedSha256(input.sha256, 'runtime receipt sha256')) {
    fail('P0-RELEASE-RUNTIME-RECEIPT', 'runtime acceptance receipt SHA-256 changed')
  }
  let decoded
  try {
    decoded = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('P0-RELEASE-RUNTIME-RECEIPT', 'runtime acceptance receipt is not JSON')
  }
  return Object.freeze({
    ...validateRuntimeAcceptanceReceipt(decoded, previous, current),
    sha256: observedSha256,
    path: await realpath(path),
  })
}

export async function verifyPinnedPnpm(input, shimRoot, cwd, environment) {
  if (process.platform === 'win32') fail('P0-RELEASE-PNPM', 'release acceptance currently requires a POSIX pnpm binding')
  const value = record(input, 'pinned pnpm input')
  const version = bounded(value.version, 'pnpm version', 32)
  if (version !== PINNED_PNPM_VERSION) fail('P0-RELEASE-PNPM', `pnpm must be exactly ${PINNED_PNPM_VERSION}`)
  const packageRoot = await realpath(resolve(bounded(value.packageRoot, 'pnpm package root')))
  const binPath = await realpath(resolve(bounded(value.binPath, 'pnpm bin path')))
  if (!isInside(packageRoot, binPath)) fail('P0-RELEASE-PNPM', 'pnpm bin must resolve inside its exact package root')
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const declaredBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pnpm
  if (manifest.name !== 'pnpm' || manifest.version !== version || typeof declaredBin !== 'string'
    || await realpath(join(packageRoot, declaredBin)) !== binPath) {
    fail('P0-RELEASE-PNPM', 'pnpm package manifest did not bind the requested executable')
  }
  const treeSha256 = await immutablePackageTreeDigest(packageRoot)
  if (treeSha256 !== expectedSha256(value.treeSha256, 'pnpm tree sha256')) {
    fail('P0-RELEASE-PNPM', 'pnpm package tree did not match its expected SHA-256')
  }
  const observedVersion = await runChecked(process.execPath, [binPath, '--version'], {
    cwd,
    env: environment,
    timeoutMs: 30_000,
  })
  if (observedVersion.stdout.trim() !== version) fail('P0-RELEASE-PNPM', 'pnpm executable reported the wrong version')
  if (await immutablePackageTreeDigest(packageRoot) !== treeSha256) {
    fail('P0-RELEASE-PNPM', 'pnpm package tree changed while verifying its executable')
  }
  await mkdir(shimRoot, { mode: 0o700 })
  const shimPath = join(shimRoot, 'pnpm')
  await symlink(binPath, shimPath)
  if (await realpath(shimPath) !== binPath) fail('P0-RELEASE-PNPM', 'private pnpm shim did not bind the exact executable')
  return Object.freeze({
    version,
    packageRoot,
    binPath,
    binSha256: `sha256:${sha256(await readFile(binPath))}`,
    treeSha256,
    shimRoot,
    nodeExecutable: process.execPath,
    nodeVersion: process.version,
  })
}

export async function prepareReceiptDestination(path, artifacts, runtimeReceiptPath, ciReceiptPaths = []) {
  const requested = resolve(bounded(path, 'receipt path'))
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 })
  const destination = join(await realpath(dirname(requested)), basename(requested))
  const ciPaths = Array.isArray(ciReceiptPaths) ? ciReceiptPaths : [ciReceiptPaths]
  for (const candidate of [
    runtimeReceiptPath,
    ...ciPaths.filter(value => value !== null),
    ...artifacts.map(spec => normalizeReleaseArtifactSource(spec.source, 'receipt alias source', spec.version))
      .filter(source => source.kind === 'local')
      .map(source => source.path),
  ]) {
    let canonical
    try {
      canonical = await realpath(candidate)
    } catch {
      canonical = resolve(candidate)
    }
    if (canonical === destination) fail('P0-RELEASE-RECEIPT', 'receipt output aliases an acceptance input')
  }
  try {
    await lstat(destination)
    fail('P0-RELEASE-RECEIPT', 'receipt output already exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return destination
}

async function writeReceipt(destination, value) {
  const temporary = join(dirname(destination), `.release-receipt-${randomUUID()}`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  try {
    await link(temporary, destination)
  } catch (error) {
    if (error?.code === 'EEXIST') fail('P0-RELEASE-RECEIPT', 'receipt output appeared concurrently')
    throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

function packedReceiptEvidence(artifact) {
  return Object.freeze({
    manifestSha256: artifact.packed.manifestSha256,
    entryCount: artifact.packed.entryCount,
    payloadTreeSha256: artifact.packed.payloadTreeSha256,
    patchSha256: artifact.packed.patchSha256,
    bundledPnpmTreeSha256: artifact.packed.bundledPnpmTreeSha256,
  })
}

/**
 * Run release-grade Center installation, optional update, and removal through an isolated official rc.2 CLI.
 * @param {Record<string, unknown>} input Exact artifact, runtime, pnpm, and receipt coordinates.
 * @returns {Promise<Readonly<Record<string, unknown>>>} Passed acceptance receipt.
 */
export async function runReleaseAcceptance(input) {
  const value = record(input, 'Release acceptance input')
  const current = artifactSpecification(value.current, 'current artifact')
  const previous = value.previous === null || value.previous === undefined
    ? null
    : artifactSpecification(value.previous, 'previous artifact')
  if (previous !== null) {
    assertAscendingReleaseTransition(previous.parsedVersion, current.parsedVersion)
    if (previous.sha256 === current.sha256 || previous.commit === current.commit
      || previous.manifestSha256 === current.manifestSha256) {
      fail('P0-RELEASE-INPUT', 'previous and current releases must have distinct artifact, manifest, and commit identities')
    }
  }
  const runtimeInput = record(value.runtimeAcceptance, 'runtime acceptance input')
  const ciInput = record(value.ciReceipt, 'GitHub CI receipt input')
  const previousCiInput = previous === null
    ? value.previousCiReceipt === null || value.previousCiReceipt === undefined ? null
      : fail('P0-RELEASE-INPUT', 'rc.0 or current-only acceptance cannot include a previous CI receipt')
    : record(value.previousCiReceipt, 'previous GitHub CI receipt input')
  const pnpmInput = record(value.pnpm, 'pinned pnpm input')
  const ciAcceptance = await loadGitHubCiArtifactReceipt(ciInput, current)
  const previousCiAcceptance = previous === null
    ? null
    : await loadGitHubCiArtifactReceipt(previousCiInput, previous)
  const runtimeAcceptance = await loadRuntimeAcceptance(runtimeInput, previous, current)
  if (runtimeAcceptance.ciPackAttestation.fileSha256 !== ciAcceptance.fileSha256
    || runtimeAcceptance.ciPackAttestation.receiptDigest !== ciAcceptance.receiptDigest
    || runtimeAcceptance.ciPackAttestation.artifact.sha256 !== ciAcceptance.artifact.sha256
    || runtimeAcceptance.ciPackAttestation.artifact.pnpmTreeSha256
      !== ciAcceptance.artifact.pnpmTreeSha256) {
    fail('P0-RELEASE-CI-ATTESTATION', 'runtime acceptance and public Release do not share one CI pack attestation')
  }
  const receiptPath = await prepareReceiptDestination(
    value.receiptPath,
    previous === null ? [current] : [previous, current],
    runtimeAcceptance.path,
    previousCiAcceptance === null ? [ciAcceptance.path] : [previousCiAcceptance.path, ciAcceptance.path],
  )
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const authorityManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  if (authorityManifest.packageManager !== `pnpm@${PINNED_PNPM_VERSION}`) {
    fail('P0-RELEASE-PNPM', 'source manifest packageManager no longer matches the release pnpm pin')
  }

  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-extension-center-release-')))
  let receipt
  try {
    const workspace = join(tempRoot, 'workspace')
    const downloads = join(tempRoot, 'downloads')
    const unpacked = join(tempRoot, 'unpacked')
    const dshHome = join(tempRoot, 'dsh-home')
    const hostRoot = join(tempRoot, 'official-host')
    const shimRoot = join(tempRoot, 'pinned-bin')
    await Promise.all([
      mkdir(workspace, { mode: 0o700 }),
      mkdir(downloads, { mode: 0o700 }),
      mkdir(unpacked, { mode: 0o700 }),
      mkdir(dshHome, { mode: 0o700 }),
    ])
    const baseEnv = keylessEnvironment({
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: 'DISABLED',
      NO_COLOR: '1',
      LC_ALL: 'C',
    })
    if (hasBlockedCredentialEnvironment(baseEnv) || hasProviderEndpointOverride(baseEnv)) {
      fail('P0-RELEASE-ISOLATION', 'release acceptance inherited a provider credential or endpoint override')
    }
    const pnpm = await verifyPinnedPnpm(pnpmInput, shimRoot, workspace, baseEnv)
    const env = Object.freeze({
      ...baseEnv,
      PATH: [pnpm.shimRoot, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    })
    const official = await installOfficialDshHost({
      hostRoot,
      projectRoot,
      cwd: workspace,
      env,
    })
    const officialBefore = official.packageTreeDigest
    await runChecked(official.dshBin, [
      'plugin', '--profile', 'web', 'install', '--offline', '--ignore-scripts',
    ], { cwd: workspace, env, timeoutMs: 180_000 })
    const profileRoot = join(dshHome, 'profiles', 'web')
    const baseline = await captureProfileBaseline(official.dshBin, profileRoot, workspace, env)

    const acquire = async (spec, name, ci) => {
      const path = join(downloads, `${name}.tgz`)
      const evidence = await acquireVerifiedReleaseArtifact(spec, path, {
        ciReleaseAssets: ci.artifact.releaseAssets,
      })
      const packed = await inspectPackedArtifact(
        path,
        spec,
        env,
        join(unpacked, name),
        authorityManifest,
      )
      const pnpmTreeSha256 = assertReleasePnpmTreeBinding(
        ci.artifact.pnpmTreeSha256,
        packed.bundledPnpmTreeSha256,
      )
      return Object.freeze({ path: await realpath(path), spec, evidence, packed, pnpmTreeSha256 })
    }
    const prior = previous === null ? null : await acquire(previous, 'previous', previousCiAcceptance)
    const next = await acquire(current, 'current', ciAcceptance)
    if (runtimeAcceptance.current.pnpmTreeSha256 !== next.pnpmTreeSha256
      || prior !== null && runtimeAcceptance.previous?.pnpmTreeSha256 !== prior.pnpmTreeSha256) {
      fail('P0-RELEASE-PNPM-ATTESTATION', 'runtime and public Release pnpm tree evidence differ')
    }
    const previousInstall = prior === null ? null : await addCenter(
      official.dshBin,
      prior,
      dshHome,
      workspace,
      env,
    )
    const currentInstall = await addCenter(
      official.dshBin,
      next,
      dshHome,
      workspace,
      env,
      prior?.path ?? null,
    )
    if (previousInstall !== null && previousInstall.dependency === currentInstall.dependency) {
      fail('P0-RELEASE-UPDATE', 'official CLI update did not switch the exact Center artifact dependency')
    }
    await runChecked(official.dshBin, [
      'plugin', '--profile', 'web', 'remove', CENTER_PACKAGE, '--ignore-scripts',
    ], { cwd: workspace, env, timeoutMs: 180_000 })
    const removal = await assertRemoved(official.dshBin, profileRoot, baseline, workspace, env)
    const officialAfter = await immutablePackageTreeDigest(official.packageRoot)
    if (officialAfter !== officialBefore) {
      fail('P0-RELEASE-OFFICIAL-HOST', 'Center release lifecycle changed the official DSH package tree')
    }

    const publicCurrent = next.evidence.sourceKind === 'github-release'
    const updateProven = prior !== null
    const publicPrevious = prior !== null && prior.evidence.sourceKind === 'github-release'
    const publicUpdate = publicPrevious && publicCurrent
    receipt = Object.freeze({
      schemaVersion: 4,
      acceptanceId: 'P0-CENTER-PUBLIC-RELEASE-OFFICIAL-CLI-LIFECYCLE',
      status: 'passed',
      p0Status: updateProven
        ? publicUpdate ? 'public-update-install-remove-proven' : 'mixed-or-local-update-rehearsal-proven'
        : publicCurrent ? 'public-install-remove-proven' : 'local-install-remove-rehearsal-proven',
      target: Object.freeze({
        dshPackage: `@deepseek-ai/dsh@${TARGET_DSH_VERSION}`,
        auditedSourceCommit: TARGET_DSH_COMMIT,
        registry: official.registry,
        registryIntegrity: official.registryIntegrity,
        packageTreeDigestBefore: officialBefore,
        packageTreeDigestAfter: officialAfter,
      }),
      inputs: Object.freeze({
        previous: prior === null ? null : Object.freeze({
          ...prior.evidence,
          manifestSha256: prior.spec.manifestSha256,
          pnpmTreeSha256: prior.pnpmTreeSha256,
          packed: packedReceiptEvidence(prior),
        }),
        current: Object.freeze({
          ...next.evidence,
          manifestSha256: next.spec.manifestSha256,
          pnpmTreeSha256: next.pnpmTreeSha256,
          packed: packedReceiptEvidence(next),
        }),
        runtimeAcceptance: Object.freeze({
          acceptanceId: runtimeAcceptance.acceptanceId,
          sha256: runtimeAcceptance.sha256,
          previous: runtimeAcceptance.previous,
          current: runtimeAcceptance.current,
          officialDshPackageTreeUnchanged: true,
        }),
        ciPackAttestation: Object.freeze({
          acceptanceId: ciAcceptance.acceptanceId,
          fileSha256: ciAcceptance.fileSha256,
          receiptDigest: ciAcceptance.receiptDigest,
          runId: ciAcceptance.runId,
          runAttempt: ciAcceptance.runAttempt,
          artifact: ciAcceptance.artifact,
        }),
        previousCiPackAttestation: previousCiAcceptance === null ? null : Object.freeze({
          acceptanceId: previousCiAcceptance.acceptanceId,
          fileSha256: previousCiAcceptance.fileSha256,
          receiptDigest: previousCiAcceptance.receiptDigest,
          runId: previousCiAcceptance.runId,
          runAttempt: previousCiAcceptance.runAttempt,
          artifact: previousCiAcceptance.artifact,
        }),
        pnpm: Object.freeze({
          version: pnpm.version,
          packageRoot: pnpm.packageRoot,
          binPath: pnpm.binPath,
          binSha256: pnpm.binSha256,
          treeSha256: pnpm.treeSha256,
          nodeExecutable: pnpm.nodeExecutable,
          nodeVersion: pnpm.nodeVersion,
        }),
        keyless: true,
        telemetryDisabled: true,
      }),
      observations: Object.freeze({
        baseline,
        previousInstall,
        currentInstall,
        ascendingDistinctReleaseUpdate: updateProven,
        removal,
        officialDshPackageTreeUnchanged: true,
        runtimeAcceptanceRequiredAndBound: true,
      }),
      notProven: Object.freeze([
        'host-client-runtime-directly-observed-by-this-release-runner',
        ...(!publicCurrent ? ['public-github-release-download'] : []),
        ...(updateProven && !publicPrevious ? ['public-previous-release-download'] : []),
        ...(!updateProven ? ['center-update-from-older-distinct-release'] : []),
      ]),
    })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
  await writeReceipt(receiptPath, receipt)
  return receipt
}

async function main() {
  let parsed
  try {
    parsed = parseReleaseAcceptanceArguments(process.argv.slice(2))
    if (parsed.help) {
      process.stdout.write(USAGE)
      return 0
    }
    const receipt = await runReleaseAcceptance(parsed)
    process.stdout.write(`${receipt.p0Status}; receipt=${parsed.receiptPath}\n`)
    return 0
  } catch (error) {
    const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error))
    process.stderr.write(`${message}\n`)
    process.stderr.write(USAGE)
    return 1
  }
}

async function isMainModule() {
  if (process.argv[1] === undefined) return false
  try {
    return await realpath(resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (await isMainModule()) process.exitCode = await main()
