#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { OFFICIAL_NPM_REGISTRY, TARGET_DSH_REGISTRY_INTEGRITY } from '../store-only/support.mjs'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../../lib/catalog-data.js'
import {
  TARGET_DSH_COMMIT,
  TARGET_DSH_VERSION,
  AcceptanceFailure,
  sanitizeDiagnostic,
} from './support.mjs'
import { canonicalSha256 } from './receipt-binding.mjs'
import { REQUIRED_FAULT_MATRIX_CASE_IDS } from './fault-matrix.mjs'
import { EXPECTED_PUBLIC_CATALOG, PUBLIC_CATALOG_URL } from '../release/verify-public-catalog.mjs'
import {
  GITHUB_BRANCH,
  GITHUB_REPOSITORY,
  GITHUB_WORKFLOW_PATH,
  REQUIRED_CI_JOBS,
} from '../release/verify-github-ci.mjs'
import { assertAscendingReleaseTransition, parseReleaseVersion } from '../release/verify-public-release.mjs'
import { validatePublicationIncidentReceipt } from '../release/assert-publication-incident.mjs'

const CENTER_PACKAGE = 'dsh-plugin-extension-center'
const POST_PUBLICATION_WORKFLOW_PATH = '.github/workflows/post-publication-evidence.yml'
const GITHUB_MAIN_REF = `refs/heads/${GITHUB_BRANCH}`
const RECOVERY_FAILED_COMMIT = '951c48cf7666991487eab9ef26d39f359b68cc20'
const RECOVERY_FAILED_RUN_ID = 33103882901
const RECOVERY_FAILED_RUN_ATTEMPT = 1
const RECOVERY_PREVIOUS_COMMIT = '882d3c3cc59b597bb24ee55025690f8c4447abd5'
const RECOVERY_PREVIOUS_RUN_ID = 33099069510
const RECOVERY_PREVIOUS_RUN_ATTEMPT = 1
const RECOVERY_INCIDENT_RUN_ATTEMPT = 1
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const MAX_SOURCE_EVIDENCE_AGE_MS = 60 * 60 * 1_000
const GITHUB_ASSET_ORIGINS = new Set([
  'https://objects.githubusercontent.com',
  'https://release-assets.githubusercontent.com',
])
const EXPECTED_CATALOG_SOURCE_NOT_PROVEN = Object.freeze([
  'third-party-code-safety',
  'human-authority-review-independent-reexecution',
  'future-source-availability-or-status',
])
const RELEASE_CATALOG_NOT_PROVEN = Object.freeze([
  'catalog-third-party-code-safety',
  'catalog-human-authority-review-independent-reexecution',
  'catalog-future-source-availability-or-status',
])
const EXPECTED_FULL_NOT_PROVEN = Object.freeze([
  'published-extension-center-release-installation',
  'center-update-with-distinct-artifact-version-and-digest',
  'update-with-distinct-signed-catalog-revision',
  'cross-platform-matrix',
])
const INPUT_FLAGS = Object.freeze([
  '--full-p0',
  '--runtime-release',
  '--public-release',
  '--public-catalog',
  '--catalog-sources',
  '--github-ci',
  '--verifier-github-ci',
  '--verifier-commit',
  '--verifier-run-id',
  '--verifier-run-attempt',
  '--previous-github-ci',
  '--previous-verifier-github-ci',
  '--previous-release-ready',
  '--previous-evidence-run-id',
  '--publication-incident',
  '--publication-incident-verifier-github-ci',
  '--publication-incident-run-id',
  '--receipt',
])
const REQUIRED_INPUT_FLAGS = Object.freeze([
  '--full-p0',
  '--runtime-release',
  '--public-release',
  '--public-catalog',
  '--catalog-sources',
  '--github-ci',
  '--verifier-github-ci',
  '--verifier-commit',
  '--verifier-run-id',
  '--verifier-run-attempt',
])
const DEFAULT_RECEIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../.artifacts/acceptance/release-ready/receipt.json',
)
const USAGE = `usage: node acceptance/full-p0/assert-release-ready.mjs \
  --full-p0 <receipt.json> --runtime-release <receipt.json> \
  --public-release <receipt.json> --public-catalog <receipt.json> \
  --catalog-sources <receipt.json> --github-ci <receipt.json> \
  --verifier-github-ci <receipt.json> --verifier-commit <commit> \
  --verifier-run-id <id> --verifier-run-attempt <attempt> \
  [--previous-github-ci <receipt.json>] \
  [--previous-verifier-github-ci <receipt.json> \
    --previous-release-ready <receipt.json> --previous-evidence-run-id <id>] \
  [--publication-incident <receipt.json> \
    --publication-incident-verifier-github-ci <receipt.json> \
    --publication-incident-run-id <id>] \
  [--receipt <path>]\n`

function fail(code, message) {
  throw new AcceptanceFailure(code, message)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('P0-RELEASE-READY-FORMAT', `${label} must be a JSON object`)
  }
  return value
}

function bounded(value, label, maximum = 4_096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('P0-RELEASE-READY-FORMAT', `${label} must be one bounded string`)
  }
  return value
}

function digest(value, label) {
  const decoded = bounded(value, label, 80)
  if (!SHA256.test(decoded)) fail('P0-RELEASE-READY-BINDING', `${label} is not a canonical SHA-256 digest`)
  return decoded
}

function nullableDigest(value, label) {
  return value === null ? null : digest(value, label)
}

function commit(value, label) {
  const decoded = bounded(value, label, 40)
  if (!COMMIT.test(decoded)) fail('P0-RELEASE-READY-BINDING', `${label} is not one exact commit`)
  return decoded
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('P0-RELEASE-READY-FORMAT', `${label} must be a positive integer`)
  }
  return value
}

function canonicalTimestamp(value, label) {
  const timestamp = bounded(value, label, 64)
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    fail('P0-RELEASE-READY-FORMAT', `${label} is not one canonical timestamp`)
  }
  return Object.freeze({ timestamp, parsed })
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    fail('P0-RELEASE-READY-FORMAT', `${label} fields are not its exact schema`)
  }
}

function exactHttpsObservationUrl(value, label) {
  const input = bounded(value, label, 2_048)
  let url
  try {
    url = new URL(input)
  } catch {
    fail('P0-RELEASE-READY-SOURCES', `${label} is not an absolute URL`)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== ''
    || url.port !== '' || url.href !== input) {
    fail('P0-RELEASE-READY-SOURCES', `${label} is not one exact credential-free HTTPS URL`)
  }
  return url
}

function exactArray(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length
    || value.some((item, index) => item !== expected[index])) {
    fail('P0-RELEASE-READY-CLAIM', `${label} is not the exact admitted claim list`)
  }
}

function passedReceipt(receipt, schemaVersion, acceptanceId, label) {
  if (receipt.schemaVersion !== schemaVersion || receipt.acceptanceId !== acceptanceId
    || receipt.status !== 'passed') {
    fail('P0-RELEASE-READY-CLAIM', `${label} did not pass its exact acceptance schema`)
  }
}

function faultMatrixEvidence(value, expectedArtifactDigest, targetValue) {
  const matrix = record(value, 'full official rc.2 faultMatrix')
  exactKeys(matrix, ['schemaVersion', 'proofScope', 'artifactDigest', 'platform', 'arch', 'cases'], 'faultMatrix')
  const target = record(targetValue, 'full official rc.2 target')
  if (matrix.schemaVersion !== 1
    || matrix.proofScope !== 'packed-center-owned-skill-journal-faults'
    || matrix.artifactDigest !== expectedArtifactDigest
    || matrix.platform !== target.os
    || matrix.arch !== target.arch
    || !Array.isArray(matrix.cases)
    || matrix.cases.length !== REQUIRED_FAULT_MATRIX_CASE_IDS.length) {
    fail('P0-RELEASE-READY-FAULT-MATRIX', 'faultMatrix is not bound to the exact packed artifact and receipt platform')
  }
  for (const [index, expectedId] of REQUIRED_FAULT_MATRIX_CASE_IDS.entries()) {
    const item = record(matrix.cases[index], `faultMatrix case ${String(index)}`)
    exactKeys(item, ['id', 'status', 'extensionKind', 'observation'], `faultMatrix case ${String(index)}`)
    const expectedObservation = expectedId === 'enospc/journal-event-before-write'
      ? 'no-journal-head-published'
      : expectedId === 'partial-current/rejected'
        ? 'journal-corrupt-fail-closed'
        : 'event-ahead-of-current-repaired-by-new-process'
    if (item.id !== expectedId || item.status !== 'passed' || item.extensionKind !== 'skill'
      || item.observation !== expectedObservation) {
      fail('P0-RELEASE-READY-FAULT-MATRIX', 'faultMatrix contains a missing, duplicate, unknown, reordered, or unsuccessful case')
    }
  }
  return Object.freeze({
    platform: matrix.platform,
    arch: matrix.arch,
    caseCount: matrix.cases.length,
  })
}

function officialTarget(targetValue, label, options = {}) {
  const target = record(targetValue, `${label} target`)
  const packageTreeDigest = digest(
    options.after === true ? target.packageTreeDigestAfter : target.packageTreeDigest,
    `${label} package tree digest`,
  )
  if (target.dshPackage !== `@deepseek-ai/dsh@${TARGET_DSH_VERSION}`
    || target.auditedSourceCommit !== TARGET_DSH_COMMIT
    || target.registry !== OFFICIAL_NPM_REGISTRY
    || target.registryIntegrity !== TARGET_DSH_REGISTRY_INTEGRITY
    || (options.version === true && target.version !== TARGET_DSH_VERSION)) {
    fail('P0-RELEASE-READY-OFFICIAL-DSH', `${label} does not bind the exact official DSH rc.2 artifact`)
  }
  if (options.after === true && target.packageTreeDigestBefore !== packageTreeDigest) {
    fail('P0-RELEASE-READY-OFFICIAL-DSH', `${label} changed the official DSH package tree`)
  }
  return Object.freeze({
    dshPackage: target.dshPackage,
    auditedSourceCommit: target.auditedSourceCommit,
    registry: target.registry,
    registryIntegrity: target.registryIntegrity,
    packageTreeDigest,
  })
}

function fullP0Evidence(value) {
  const receipt = record(value, 'full official rc.2 receipt')
  passedReceipt(receipt, 1, 'P0-RC2-001-OFFICIAL-HOST-EXTENSION-LIFECYCLES', 'full official rc.2 receipt')
  if (receipt.proofScope !== 'packed-extension-unmodified-official-rc2-host-rpc-plugin-mcp-skill-lifecycles'
    || receipt.p0Status !== 'official-rc2-lifecycle-proven'
    || receipt.releaseClaim !== 'official-dsh-rc2-compatible') {
    fail('P0-RELEASE-READY-CLAIM', 'full official rc.2 receipt overstates or changes its proof scope')
  }
  exactArray(receipt.notProven, EXPECTED_FULL_NOT_PROVEN, 'full official rc.2 notProven')
  const smoke = record(record(receipt.compatibilitySmokes, 'compatibility smokes').liveProvider, 'live provider smoke')
  if (smoke.status !== 'not-run' || smoke.blocking !== false) {
    fail('P0-RELEASE-READY-CLAIM', 'live-provider compatibility smoke must remain advisory and non-blocking')
  }
  const inputs = record(receipt.inputs, 'full official rc.2 inputs')
  if (inputs.isolatedHomesCreatedEmpty !== true || inputs.credentialVariablesPassed !== false
    || inputs.providerEndpointOverridePassed !== false || inputs.telemetryModeRequested !== 'DISABLED'
    || inputs.packedArtifactInstalledByOfficialPluginCli !== true
    || inputs.exactMcpRuntimePreprovisioned !== true
    || inputs.keylessOfficialReplayBundleInstalled !== true
    || inputs.keylessOfficialReplayBundleRemoved !== true
    || inputs.officialCliRemovalProven !== true || inputs.breakGlassRecoveryProven !== true) {
    fail('P0-RELEASE-READY-CLAIM', 'full official rc.2 receipt omits a required keyless lifecycle observation')
  }
  const observations = record(receipt.observations, 'full official rc.2 observations')
  const agentBrowserWrites = Array.isArray(observations.browserLifecycleRpcMethods)
    ? observations.browserLifecycleRpcMethods.filter(value => ['plan/decide', 'lifecycle/request'].includes(value))
    : []
  const storeBrowserWrites = Array.isArray(observations.browserStoreLifecycleRpcMethods)
    ? observations.browserStoreLifecycleRpcMethods.filter(value => (
      ['intent/preview', 'plan/decide', 'lifecycle/request'].includes(value)
    ))
    : []
  if (observations.bundleLayerObserved !== true || observations.materialUnchangedBeforeApproval !== true
    || observations.storeMaterialUnchangedBeforeApproval !== true
    || observations.officialDshPackageTreeUnchanged !== true
    || observations.centerAndChildResolutionLinksAbsent !== true
    || observations.profileRemovalBaselineDigest !== observations.profileRemovalFinalDigest
    || JSON.stringify(agentBrowserWrites) !== JSON.stringify(['plan/decide', 'lifecycle/request'])
    || JSON.stringify(storeBrowserWrites) !== JSON.stringify(['intent/preview', 'plan/decide', 'lifecycle/request'])
    || !Array.isArray(observations.terminalReceiptDigests) || observations.terminalReceiptDigests.length < 1
    || observations.terminalReceiptDigests.some(value => !SHA256.test(value))
    || !Array.isArray(observations.terminalJournalHeadDigests) || observations.terminalJournalHeadDigests.length < 1
    || observations.terminalJournalHeadDigests.some(value => !SHA256.test(value))
    || observations.controlledAba === null || observations.breakGlassRecovery === null) {
    fail('P0-RELEASE-READY-CLAIM', 'full official rc.2 receipt omits immutable Host, approval, recovery, or terminal evidence')
  }
  const artifact = record(receipt.artifact, 'full official rc.2 artifact')
  const artifactDigest = digest(artifact.digest, 'full artifact digest')
  const faultMatrix = faultMatrixEvidence(observations.faultMatrix, artifactDigest, receipt.target)
  return Object.freeze({
    target: officialTarget(receipt.target, 'full official rc.2', { version: true }),
    artifact: Object.freeze({
      version: bounded(artifact.version, 'full artifact version', 128),
      sha256: artifactDigest,
      sizeBytes: positiveInteger(artifact.bytes, 'full artifact size'),
      filename: bounded(artifact.filename, 'full artifact filename', 256),
    }),
    catalog: Object.freeze({
      revision: positiveInteger(observations.catalogRevision, 'full catalog revision'),
      entriesDigest: digest(observations.catalogEntriesDigest, 'full catalog entries digest'),
    }),
    faultMatrix,
  })
}

function releaseArtifact(value, label) {
  const artifact = record(value, label)
  const version = bounded(artifact.version, `${label} version`, 128)
  const parsedVersion = parseReleaseVersion(version, `${label} version`)
  const sourceCommit = commit(artifact.sourceCommit, `${label} source commit`)
  const sha256 = digest(artifact.sha256, `${label} sha256`)
  const sizeBytes = positiveInteger(artifact.sizeBytes, `${label} size`)
  const manifestSha256 = digest(artifact.manifestSha256, `${label} manifest sha256`)
  const pnpmTreeSha256 = digest(artifact.pnpmTreeSha256, `${label} pnpm tree sha256`)
  if (artifact.sourceKind !== 'github-release'
    || artifact.publicUrl !== `https://github.com/${GITHUB_REPOSITORY}/releases/download/v${version}/${CENTER_PACKAGE}-${version}.tgz`
    || !SHA512.test(artifact.sha512)) {
    fail('P0-RELEASE-READY-PUBLIC-RELEASE', `${label} is not the exact public GitHub Release asset`)
  }
  const release = record(artifact.release, `${label} release metadata`)
  if (release.tag !== `v${version}` || release.sourceCommit !== sourceCommit
    || release.prerelease !== (parsedVersion.prerelease.length > 0)
    || !Number.isSafeInteger(release.releaseId) || release.releaseId < 1) {
    fail('P0-RELEASE-READY-PUBLIC-RELEASE', `${label} Release metadata does not bind its version and commit`)
  }
  const expectedNames = [`${CENTER_PACKAGE}-${version}.tgz`, 'SHA256SUMS', 'pack-attestation.json']
  const releaseAssets = release.assets
  const releasePayload = artifact.releasePayload
  if (!Array.isArray(releaseAssets) || !Array.isArray(releasePayload)
    || releaseAssets.length !== expectedNames.length || releasePayload.length !== expectedNames.length) {
    fail('P0-RELEASE-READY-PUBLIC-RELEASE', `${label} does not bind the exact three-file Release payload`)
  }
  const payload = Object.freeze(expectedNames.map((name, index) => {
    const metadata = record(releaseAssets[index], `${label} Release asset ${name}`)
    const downloaded = record(releasePayload[index], `${label} downloaded Release asset ${name}`)
    const expectedUrl = `https://github.com/${GITHUB_REPOSITORY}/releases/download/v${version}/${name}`
    if (metadata.name !== name || downloaded.name !== name || metadata.publicUrl !== expectedUrl
      || downloaded.publicUrl !== expectedUrl || metadata.sizeBytes !== downloaded.sizeBytes
      || metadata.sha256 !== downloaded.sha256 || !GITHUB_ASSET_ORIGINS.has(`https://${downloaded.finalHost}`)
      || !Number.isSafeInteger(downloaded.redirects) || downloaded.redirects < 1 || downloaded.redirects > 2) {
      fail('P0-RELEASE-READY-PUBLIC-RELEASE', `${label} Release metadata and downloaded ${name} bytes differ`)
    }
    return Object.freeze({
      name,
      sizeBytes: positiveInteger(downloaded.sizeBytes, `${label} ${name} size`),
      sha256: digest(downloaded.sha256, `${label} ${name} sha256`),
    })
  }))
  if (payload[0].sizeBytes !== sizeBytes || payload[0].sha256 !== sha256) {
    fail('P0-RELEASE-READY-PUBLIC-RELEASE', `${label} tgz payload differs from its artifact identity`)
  }
  const immutable = record(artifact.immutableRelease, `${label} immutable Release proof`)
  if (immutable.repository !== GITHUB_REPOSITORY || immutable.tag !== release.tag
    || immutable.releaseId !== release.releaseId || !/^\d+\.\d+\.\d+$/u.test(immutable.ghVersion)
    || immutable.tagRefSha1 !== sourceCommit) {
    fail('P0-RELEASE-READY-PUBLIC-RELEASE', `${label} immutable proof does not bind its concrete Release`)
  }
  for (const field of ['bundleSha256', 'statementSha256', 'releaseVerificationResultSha256']) {
    digest(immutable[field], `${label} immutable ${field}`)
  }
  if (!Array.isArray(immutable.assets) || immutable.assets.length !== payload.length
    || immutable.assets.some((candidate, index) => {
      const asset = record(candidate, `${label} immutable asset ${String(index)}`)
      digest(asset.verificationResultSha256, `${label} immutable asset verification result`)
      return asset.name !== payload[index].name || asset.sizeBytes !== payload[index].sizeBytes
        || asset.sha256 !== payload[index].sha256
    })) {
    fail('P0-RELEASE-READY-PUBLIC-RELEASE', `${label} immutable proof does not cover every exact Release asset`)
  }
  const packed = record(artifact.packed, `${label} packed evidence`)
  for (const field of ['manifestSha256', 'payloadTreeSha256', 'patchSha256', 'bundledPnpmTreeSha256']) {
    digest(packed[field], `${label} packed ${field}`)
  }
  if (packed.manifestSha256 !== manifestSha256 || !Number.isSafeInteger(packed.entryCount) || packed.entryCount < 1) {
    fail('P0-RELEASE-READY-PUBLIC-RELEASE', `${label} packed manifest evidence is inconsistent`)
  }
  if (packed.bundledPnpmTreeSha256 !== pnpmTreeSha256) {
    fail('P0-RELEASE-READY-PUBLIC-RELEASE', `${label} packed pnpm tree differs from its attested identity`)
  }
  return Object.freeze({
    version,
    sha256,
    sizeBytes,
    manifestSha256,
    pnpmTreeSha256,
    sourceCommit,
    releaseId: release.releaseId,
    releasePayload: payload,
    immutableRelease: Object.freeze({
      bundleSha256: immutable.bundleSha256,
      statementSha256: immutable.statementSha256,
      tagRefSha1: immutable.tagRefSha1,
    }),
  })
}

function fixedUpdateReleaseStage(previousVersion, currentVersion, code, label) {
  if (currentVersion === '0.1.0-rc.1') {
    if (previousVersion !== '0.1.0-rc.0') {
      fail(code, `${label} rc.1 must update from 0.1.0-rc.0`)
    }
    return 'update-rc'
  }
  if (currentVersion === '0.1.0-rc.2') {
    if (previousVersion !== '0.1.0-rc.0') {
      fail(code, `${label} recovery rc.2 must update from 0.1.0-rc.0`)
    }
    return 'recovery-rc'
  }
  if (currentVersion === '0.1.0') {
    if (previousVersion !== '0.1.0-rc.2') {
      fail(code, `${label} stable 0.1.0 must update from 0.1.0-rc.2`)
    }
    return 'stable'
  }
  fail(code, `${label} is outside the fixed rc.0 to rc.1, rc.0 to rc.2, and rc.2 to stable release sequence`)
}

function publicReleaseEvidence(value) {
  const receipt = record(value, 'public Release receipt')
  passedReceipt(receipt, 4, 'P0-CENTER-PUBLIC-RELEASE-OFFICIAL-CLI-LIFECYCLE', 'public Release receipt')
  const target = officialTarget(receipt.target, 'public Release', { after: true })
  const inputs = record(receipt.inputs, 'public Release inputs')
  if (inputs.keyless !== true || inputs.telemetryDisabled !== true) {
    fail('P0-RELEASE-READY-PUBLIC-RELEASE', 'public Release receipt is not keyless with telemetry disabled')
  }
  const current = releaseArtifact(inputs.current, 'current public artifact')
  const previous = inputs.previous === null ? null : releaseArtifact(inputs.previous, 'previous public artifact')
  const parsedCurrent = parseReleaseVersion(current.version)
  let stage
  if (current.version === '0.1.0-rc.0') {
    if (previous !== null || receipt.p0Status !== 'public-install-remove-proven') {
      fail('P0-RELEASE-READY-TRANSITION', 'rc.0 must be a current-only public install/remove bootstrap')
    }
    exactArray(receipt.notProven, [
      'host-client-runtime-directly-observed-by-this-release-runner',
      'center-update-from-older-distinct-release',
    ], 'rc.0 public Release notProven')
    stage = 'bootstrap-rc0'
  } else {
    if (parsedCurrent.major !== 0 || parsedCurrent.minor !== 1 || parsedCurrent.patch !== 0
      || previous === null || receipt.p0Status !== 'public-update-install-remove-proven') {
      fail('P0-RELEASE-READY-TRANSITION', 'rc.1, recovery rc.2, and stable require a public previous-to-current update')
    }
    stage = fixedUpdateReleaseStage(
      previous.version,
      current.version,
      'P0-RELEASE-READY-TRANSITION',
      'public Release',
    )
    assertAscendingReleaseTransition(previous.version, current.version)
    exactArray(receipt.notProven, [
      'host-client-runtime-directly-observed-by-this-release-runner',
    ], 'updated public Release notProven')
  }
  const observations = record(receipt.observations, 'public Release observations')
  const currentInstall = record(observations.currentInstall, 'current public installation')
  const previousInstall = observations.previousInstall === null
    ? null
    : record(observations.previousInstall, 'previous public installation')
  if (observations.officialDshPackageTreeUnchanged !== true
    || observations.runtimeAcceptanceRequiredAndBound !== true
    || observations.ascendingDistinctReleaseUpdate !== (previous !== null)
    || record(observations.removal, 'public Release removal').exactBaselineRestored !== true
    || digest(currentInstall.bundledPnpmTreeSha256, 'current installed pnpm tree sha256')
      !== current.pnpmTreeSha256
    || (previous === null) !== (previousInstall === null)
    || previous !== null && digest(
      previousInstall.bundledPnpmTreeSha256,
      'previous installed pnpm tree sha256',
    ) !== previous.pnpmTreeSha256) {
    fail('P0-RELEASE-READY-PUBLIC-RELEASE', 'public Release receipt omits update, removal, runtime, or Host evidence')
  }
  return Object.freeze({
    target,
    stage,
    previous,
    current,
    runtimeAcceptance: record(inputs.runtimeAcceptance, 'bound runtime acceptance'),
    ciPackAttestation: record(inputs.ciPackAttestation, 'bound CI pack attestation'),
    previousCiPackAttestation: inputs.previousCiPackAttestation === null
      ? null
      : record(inputs.previousCiPackAttestation, 'bound previous CI pack attestation'),
  })
}

function runtimeArtifact(value, label) {
  const artifact = record(value, label)
  if (artifact.hostBoot !== true || artifact.clientBoot !== true || artifact.rpcRegistration !== true) {
    fail('P0-RELEASE-READY-RUNTIME', `${label} did not pass Host, Client, and RPC boot`)
  }
  return Object.freeze({
    version: bounded(artifact.version, `${label} version`, 128),
    sha256: digest(artifact.sha256, `${label} sha256`),
    sizeBytes: positiveInteger(artifact.sizeBytes, `${label} size`),
    manifestSha256: digest(artifact.manifestSha256, `${label} manifest sha256`),
    pnpmTreeSha256: digest(artifact.pnpmTreeSha256, `${label} pnpm tree sha256`),
    sourceCommit: commit(artifact.sourceCommit, `${label} source commit`),
  })
}

function runtimeCatalogObservation(observation, label) {
  const source = bounded(observation.catalogSource, `${label} source`, 32)
  const freshness = bounded(observation.catalogFreshness, `${label} freshness`, 32)
  const degraded = observation.catalogDegraded
  const degradedReason = observation.catalogDegradedReason
  if (!['bootstrap', 'remote', 'last-good'].includes(source)
    || !['bootstrap', 'fresh', 'cached'].includes(freshness)
    || typeof degraded !== 'boolean'
    || (degraded && (typeof degradedReason !== 'string' || degradedReason.length === 0
      || degradedReason.length > 160))
    || (!degraded && degradedReason !== null)) {
    fail('P0-RELEASE-READY-RUNTIME', `${label} admission evidence is invalid`)
  }
  return Object.freeze({ source, freshness, degraded, degradedReason })
}

function runtimeReleaseEvidence(value) {
  const receipt = record(value, 'runtime Release receipt')
  passedReceipt(receipt, 2, 'P0-CENTER-HOST-CLIENT-BOOT', 'runtime Release receipt')
  if (receipt.profileId !== 'web' || receipt.officialDshPackageTreeUnchanged !== true) {
    fail('P0-RELEASE-READY-RUNTIME', 'runtime Release did not use one unchanged official Web Profile')
  }
  const artifacts = record(receipt.artifacts, 'runtime Release artifacts')
  const previous = artifacts.previous === null ? null : runtimeArtifact(artifacts.previous, 'previous runtime artifact')
  const current = runtimeArtifact(artifacts.current, 'current runtime artifact')
  const observations = record(receipt.observations, 'runtime Release observations')
  const currentObservation = record(observations.current, 'current runtime observation')
  const previousObservation = observations.previous === null
    ? null
    : record(observations.previous, 'previous runtime observation')
  if ((previous === null) !== (previousObservation === null)) {
    fail('P0-RELEASE-READY-RUNTIME', 'runtime Release artifact and observation history disagree')
  }
  if (digest(currentObservation.installedPnpmTreeSha256, 'current runtime installed pnpm tree sha256')
      !== current.pnpmTreeSha256
    || previous !== null && digest(
      previousObservation.installedPnpmTreeSha256,
      'previous runtime installed pnpm tree sha256',
    ) !== previous.pnpmTreeSha256) {
    fail('P0-RELEASE-READY-RUNTIME', 'runtime installed pnpm tree differs from its packed artifact')
  }
  const observedArtifacts = previousObservation === null
    ? [currentObservation]
    : [previousObservation, currentObservation]
  if (observations.keyless !== true || observations.telemetryDisabled !== true
    || observedArtifacts.some(observation => !Array.isArray(observation.browserExternalRequests)
      || observation.browserExternalRequests.length !== 0
      || !Array.isArray(observation.browserExternalWebSockets)
      || observation.browserExternalWebSockets.length !== 0
      || !Array.isArray(observation.browserConsoleFailures)
      || observation.browserConsoleFailures.length !== 0)) {
    fail('P0-RELEASE-READY-RUNTIME', 'runtime Release retained browser, credential, telemetry, or console uncertainty')
  }
  const profile = record(observations.profile, 'runtime Profile observation')
  if (profile.profileId !== 'web' || profile.sameProfile !== true
    || profile.removalExactBaselineRestored !== true
    || profile.officialCliUpdate !== (previous === null ? null : true)
    || profile.centerRootRetained !== (previous === null ? null : true)) {
    fail('P0-RELEASE-READY-RUNTIME', 'runtime Release did not prove its exact same-Profile lifecycle')
  }
  return Object.freeze({
    target: officialTarget(receipt.target, 'runtime Release'),
    previous,
    current,
    ciPackAttestation: record(receipt.ciPackAttestation, 'runtime CI pack attestation'),
    previousCatalog: previousObservation === null ? null : Object.freeze({
      revision: positiveInteger(previousObservation.catalogRevision, 'previous runtime catalog revision'),
      entriesDigest: digest(previousObservation.catalogEntriesDigest, 'previous runtime catalog entries digest'),
      admission: runtimeCatalogObservation(previousObservation, 'previous runtime catalog'),
    }),
    currentCatalog: Object.freeze({
      revision: positiveInteger(currentObservation.catalogRevision, 'runtime catalog revision'),
      entriesDigest: digest(currentObservation.catalogEntriesDigest, 'runtime catalog entries digest'),
      admission: runtimeCatalogObservation(currentObservation, 'current runtime catalog'),
    }),
  })
}

function publicCatalogEvidence(value) {
  const receipt = record(value, 'public catalog receipt')
  passedReceipt(receipt, 2, 'P0-PUBLIC-CATALOG-DEPLOYMENT', 'public catalog receipt')
  if (receipt.p0Status !== 'public-catalog-deployment-proven') {
    fail('P0-RELEASE-READY-CATALOG', 'public catalog deployment is not proven')
  }
  const { receiptDigest, ...body } = receipt
  if (receiptDigest !== canonicalSha256(body)) {
    fail('P0-RELEASE-READY-CATALOG', 'public catalog receipt digest does not bind its body')
  }
  exactArray(receipt.notProven, [], 'public catalog notProven')
  const target = record(receipt.target, 'public catalog target')
  const packaged = record(receipt.packagedBootstrap, 'packaged catalog bootstrap')
  const deployment = record(receipt.deployment, 'public catalog deployment')
  const refresh = record(receipt.runtimeRefresh, 'public catalog runtime refresh')
  if (target.url !== PUBLIC_CATALOG_URL || target.redirectPolicy !== 'forbidden'
    || target.expectedContentType !== 'application/json'
    || target.expectedRevision !== EXPECTED_PUBLIC_CATALOG.revision
    || target.expectedSizeBytes !== EXPECTED_PUBLIC_CATALOG.sizeBytes
    || target.expectedBytesSha256 !== EXPECTED_PUBLIC_CATALOG.bytesSha256
    || target.expectedEnvelopeDigest !== EXPECTED_PUBLIC_CATALOG.envelopeDigest
    || packaged.revision !== EXPECTED_PUBLIC_CATALOG.previousRevision
    || packaged.previousRevisionDigest !== EXPECTED_PUBLIC_CATALOG.packagedBootstrapPreviousRevisionDigest
    || packaged.entriesDigest !== EXPECTED_PUBLIC_CATALOG.packagedBootstrapEntriesDigest
    || packaged.envelopeDigest !== EXPECTED_PUBLIC_CATALOG.previousRevisionDigest
    || packaged.rootDigest !== EXPECTED_PUBLIC_CATALOG.packagedBootstrapRootDigest
    || packaged.signatureSetDigest !== EXPECTED_PUBLIC_CATALOG.packagedBootstrapSignatureSetDigest
    || deployment.httpStatus !== 200 || deployment.finalUrl !== PUBLIC_CATALOG_URL
    || deployment.redirected !== false || deployment.contentType !== 'application/json'
    || deployment.sizeBytes !== EXPECTED_PUBLIC_CATALOG.sizeBytes
    || deployment.bytesSha256 !== EXPECTED_PUBLIC_CATALOG.bytesSha256
    || deployment.documentDigest !== EXPECTED_PUBLIC_CATALOG.documentDigest
    || deployment.envelopeDigest !== EXPECTED_PUBLIC_CATALOG.envelopeDigest
    || deployment.signatureSetDigest !== EXPECTED_PUBLIC_CATALOG.signatureSetDigest
    || deployment.revision !== EXPECTED_PUBLIC_CATALOG.revision
    || deployment.previousRevisionDigest !== EXPECTED_PUBLIC_CATALOG.previousRevisionDigest
    || deployment.previousRevisionDigest !== packaged.envelopeDigest
    || deployment.entriesDigest !== EXPECTED_PUBLIC_CATALOG.entriesDigest
    || refresh.source !== 'remote' || refresh.freshness !== 'fresh' || refresh.degraded !== false
    || refresh.revision !== deployment.revision || refresh.entriesDigest !== deployment.entriesDigest) {
    fail('P0-RELEASE-READY-CATALOG', 'public catalog receipt does not bind the exact signed deployment and runtime refresh')
  }
  return Object.freeze({
    receiptDigest,
    bootstrap: Object.freeze({
      revision: packaged.revision,
      previousRevisionDigest: nullableDigest(packaged.previousRevisionDigest, 'packaged catalog previous revision digest'),
      entriesDigest: digest(packaged.entriesDigest, 'packaged catalog entries digest'),
      envelopeDigest: digest(packaged.envelopeDigest, 'packaged catalog envelope digest'),
      rootDigest: digest(packaged.rootDigest, 'packaged catalog root digest'),
      signatureSetDigest: digest(packaged.signatureSetDigest, 'packaged catalog signature-set digest'),
    }),
    deployment: Object.freeze({
      url: deployment.finalUrl,
      revision: deployment.revision,
      previousRevisionDigest: deployment.previousRevisionDigest,
      entriesDigest: deployment.entriesDigest,
      envelopeDigest: deployment.envelopeDigest,
      signatureSetDigest: deployment.signatureSetDigest,
      documentDigest: deployment.documentDigest,
      bytesSha256: deployment.bytesSha256,
      sizeBytes: deployment.sizeBytes,
    }),
  })
}

function releaseReadyArtifact(value, label) {
  const artifact = record(value, label)
  const version = bounded(artifact.version, `${label} version`, 128)
  parseReleaseVersion(version, `${label} version`)
  const sha256 = digest(artifact.sha256, `${label} SHA-256`)
  const sizeBytes = positiveInteger(artifact.sizeBytes, `${label} size`)
  const manifestSha256 = digest(artifact.manifestSha256, `${label} manifest SHA-256`)
  const pnpmTreeSha256 = digest(artifact.pnpmTreeSha256, `${label} pnpm tree SHA-256`)
  const sourceCommit = commit(artifact.sourceCommit, `${label} source commit`)
  const expectedNames = [`${CENTER_PACKAGE}-${version}.tgz`, 'SHA256SUMS', 'pack-attestation.json']
  if (!Array.isArray(artifact.releasePayload) || artifact.releasePayload.length !== expectedNames.length) {
    fail('P0-RELEASE-READY-PREVIOUS', `${label} omits its exact three-file Release payload`)
  }
  const releasePayload = Object.freeze(artifact.releasePayload.map((candidate, index) => {
    const asset = record(candidate, `${label} Release asset ${String(index)}`)
    if (asset.name !== expectedNames[index]) {
      fail('P0-RELEASE-READY-PREVIOUS', `${label} Release asset order or name changed`)
    }
    return Object.freeze({
      name: asset.name,
      sizeBytes: positiveInteger(asset.sizeBytes, `${label} Release asset size`),
      sha256: digest(asset.sha256, `${label} Release asset SHA-256`),
    })
  }))
  if (releasePayload[0].sizeBytes !== sizeBytes || releasePayload[0].sha256 !== sha256) {
    fail('P0-RELEASE-READY-PREVIOUS', `${label} Release payload differs from its artifact identity`)
  }
  const immutable = record(artifact.immutableRelease, `${label} immutable Release`)
  return Object.freeze({
    version,
    sha256,
    sizeBytes,
    manifestSha256,
    pnpmTreeSha256,
    sourceCommit,
    releaseId: positiveInteger(artifact.releaseId, `${label} Release id`),
    releasePayload,
    immutableRelease: Object.freeze({
      bundleSha256: digest(immutable.bundleSha256, `${label} immutable bundle SHA-256`),
      statementSha256: digest(immutable.statementSha256, `${label} immutable statement SHA-256`),
      tagRefSha1: immutable.tagRefSha1 === sourceCommit
        ? immutable.tagRefSha1
        : fail('P0-RELEASE-READY-PREVIOUS', `${label} immutable tag ref is invalid`),
    }),
  })
}

function releaseReadyCatalog(value, label) {
  const catalog = record(value, label)
  const bootstrapValue = record(catalog.bootstrap, `${label} bootstrap`)
  const deploymentValue = record(catalog.deployment, `${label} deployment`)
  const bootstrap = Object.freeze({
    revision: positiveInteger(bootstrapValue.revision, `${label} bootstrap revision`),
    previousRevisionDigest: nullableDigest(
      bootstrapValue.previousRevisionDigest,
      `${label} bootstrap previous revision digest`,
    ),
    entriesDigest: digest(bootstrapValue.entriesDigest, `${label} bootstrap entries digest`),
    envelopeDigest: digest(bootstrapValue.envelopeDigest, `${label} bootstrap envelope digest`),
    rootDigest: digest(bootstrapValue.rootDigest, `${label} bootstrap root digest`),
    signatureSetDigest: digest(bootstrapValue.signatureSetDigest, `${label} bootstrap signature-set digest`),
  })
  const deployment = Object.freeze({
    url: bounded(deploymentValue.url, `${label} deployment URL`, 2_048),
    revision: positiveInteger(deploymentValue.revision, `${label} deployment revision`),
    previousRevisionDigest: digest(
      deploymentValue.previousRevisionDigest,
      `${label} deployment previous revision digest`,
    ),
    entriesDigest: digest(deploymentValue.entriesDigest, `${label} deployment entries digest`),
    envelopeDigest: digest(deploymentValue.envelopeDigest, `${label} deployment envelope digest`),
    signatureSetDigest: digest(
      deploymentValue.signatureSetDigest,
      `${label} deployment signature-set digest`,
    ),
    documentDigest: digest(deploymentValue.documentDigest, `${label} deployment document digest`),
    bytesSha256: digest(deploymentValue.bytesSha256, `${label} deployment bytes SHA-256`),
    sizeBytes: positiveInteger(deploymentValue.sizeBytes, `${label} deployment size`),
  })
  if (deployment.url !== PUBLIC_CATALOG_URL || deployment.revision !== bootstrap.revision + 1
    || deployment.previousRevisionDigest !== bootstrap.envelopeDigest) {
    fail('P0-RELEASE-READY-PREVIOUS', `${label} is not one adjacent signed public catalog transition`)
  }
  return Object.freeze({ bootstrap, deployment })
}

function releaseReadyEvidenceFile(value, label, acceptanceId, extraFields = []) {
  const evidence = record(value, label)
  exactKeys(evidence, ['acceptanceId', 'sha256', ...extraFields], label)
  if (evidence.acceptanceId !== acceptanceId) {
    fail('P0-RELEASE-READY-PREVIOUS', `${label} has an invalid acceptance id`)
  }
  return evidence
}

function previousPublicationIncidentBinding(value, releaseStage, schemaVersion) {
  if (schemaVersion === 2) {
    if (releaseStage === 'recovery-rc') {
      fail('P0-RELEASE-READY-PREVIOUS', 'recovery rc.2 release-ready evidence must bind the rc.1 publication incident')
    }
    return null
  }
  if (schemaVersion !== 3) {
    fail('P0-RELEASE-READY-PREVIOUS', 'previous release-ready receipt has an unsupported schema version')
  }
  if (releaseStage !== 'recovery-rc') {
    if (value !== null) {
      fail('P0-RELEASE-READY-PREVIOUS', 'non-recovery release-ready evidence injected a publication incident')
    }
    return null
  }
  const binding = releaseReadyEvidenceFile(
    value,
    'previous release-ready publication incident evidence',
    'P0-EXTENSION-CENTER-PUBLICATION-INCIDENT',
    [
      'receiptDigest',
      'runId',
      'runAttempt',
      'failedRunId',
      'failedRunAttempt',
      'targetCommit',
      'targetVersion',
      'verifierCommit',
      'verifierGithubCiSha256',
      'verifierGithubCiReceiptDigest',
      'verifierGithubCiRunId',
      'verifierGithubCiRunAttempt',
    ],
  )
  const normalized = Object.freeze({
    acceptanceId: binding.acceptanceId,
    sha256: digest(binding.sha256, 'previous release-ready publication incident SHA-256'),
    receiptDigest: digest(
      binding.receiptDigest,
      'previous release-ready publication incident receipt digest',
    ),
    runId: positiveInteger(binding.runId, 'previous release-ready publication incident run id'),
    runAttempt: positiveInteger(
      binding.runAttempt,
      'previous release-ready publication incident run attempt',
    ),
    failedRunId: positiveInteger(
      binding.failedRunId,
      'previous release-ready publication incident failed run id',
    ),
    failedRunAttempt: positiveInteger(
      binding.failedRunAttempt,
      'previous release-ready publication incident failed run attempt',
    ),
    targetCommit: commit(binding.targetCommit, 'previous release-ready publication incident target commit'),
    targetVersion: bounded(
      binding.targetVersion,
      'previous release-ready publication incident target version',
      128,
    ),
    verifierCommit: commit(
      binding.verifierCommit,
      'previous release-ready publication incident verifier commit',
    ),
    verifierGithubCiSha256: digest(
      binding.verifierGithubCiSha256,
      'previous release-ready publication incident verifier CI SHA-256',
    ),
    verifierGithubCiReceiptDigest: digest(
      binding.verifierGithubCiReceiptDigest,
      'previous release-ready publication incident verifier CI receipt digest',
    ),
    verifierGithubCiRunId: positiveInteger(
      binding.verifierGithubCiRunId,
      'previous release-ready publication incident verifier CI run id',
    ),
    verifierGithubCiRunAttempt: positiveInteger(
      binding.verifierGithubCiRunAttempt,
      'previous release-ready publication incident verifier CI run attempt',
    ),
  })
  if (normalized.targetCommit !== RECOVERY_FAILED_COMMIT
    || normalized.targetVersion !== '0.1.0-rc.1'
    || normalized.failedRunId !== RECOVERY_FAILED_RUN_ID
    || normalized.failedRunAttempt !== RECOVERY_FAILED_RUN_ATTEMPT
    || normalized.runAttempt !== RECOVERY_INCIDENT_RUN_ATTEMPT) {
    fail('P0-RELEASE-READY-PREVIOUS', 'recovery rc.2 release-ready evidence changed the fixed rc.1 incident coordinates')
  }
  return normalized
}

function previousReleaseReadyBindings(value, bootstrap, releaseStage, schemaVersion) {
  const evidence = record(value, 'previous release-ready evidence')
  exactKeys(evidence, [
    'fullP0',
    'runtimeRelease',
    'publicRelease',
    'publicCatalog',
    'catalogSources',
    'githubCi',
    'verifierGithubCi',
    'previousGithubCi',
    'previousReleaseReady',
    ...(schemaVersion === 3 ? ['publicationIncident'] : []),
  ], 'previous release-ready evidence')
  const fullP0 = releaseReadyEvidenceFile(
    evidence.fullP0,
    'previous release-ready full P0 evidence',
    'P0-RC2-001-OFFICIAL-HOST-EXTENSION-LIFECYCLES',
    ['faultMatrix'],
  )
  digest(fullP0.sha256, 'previous release-ready full P0 evidence SHA-256')
  const faultMatrix = record(fullP0.faultMatrix, 'previous release-ready faultMatrix evidence')
  exactKeys(faultMatrix, ['platform', 'arch', 'caseCount'], 'previous release-ready faultMatrix evidence')
  bounded(faultMatrix.platform, 'previous release-ready faultMatrix platform', 64)
  bounded(faultMatrix.arch, 'previous release-ready faultMatrix architecture', 64)
  if (positiveInteger(faultMatrix.caseCount, 'previous release-ready faultMatrix case count')
    !== REQUIRED_FAULT_MATRIX_CASE_IDS.length) {
    fail('P0-RELEASE-READY-PREVIOUS', 'previous release-ready faultMatrix case count is incomplete')
  }
  const runtimeRelease = releaseReadyEvidenceFile(
    evidence.runtimeRelease,
    'previous release-ready runtime evidence',
    'P0-CENTER-HOST-CLIENT-BOOT',
  )
  const publicRelease = releaseReadyEvidenceFile(
    evidence.publicRelease,
    'previous release-ready public Release evidence',
    'P0-CENTER-PUBLIC-RELEASE-OFFICIAL-CLI-LIFECYCLE',
  )
  const publicCatalog = releaseReadyEvidenceFile(
    evidence.publicCatalog,
    'previous release-ready public catalog evidence',
    'P0-PUBLIC-CATALOG-DEPLOYMENT',
    ['receiptDigest'],
  )
  const catalogSources = releaseReadyEvidenceFile(
    evidence.catalogSources,
    'previous release-ready catalog source evidence',
    'P0-CATALOG-SOURCE-FRESHNESS',
    ['receiptDigest', 'observedAt', 'entryCount'],
  )
  const githubCi = releaseReadyEvidenceFile(
    evidence.githubCi,
    'previous release-ready GitHub CI evidence',
    'P0-GITHUB-CI-EXACT-COMMIT',
    ['receiptDigest', 'runId'],
  )
  const verifierGithubCi = releaseReadyEvidenceFile(
    evidence.verifierGithubCi,
    'previous release-ready verifier GitHub CI evidence',
    'P0-GITHUB-CI-EXACT-COMMIT',
    ['receiptDigest', 'commit', 'runId', 'runAttempt'],
  )
  for (const [binding, label] of [
    [runtimeRelease, 'runtime'],
    [publicRelease, 'public Release'],
    [publicCatalog, 'public catalog'],
    [catalogSources, 'catalog source'],
    [githubCi, 'GitHub CI'],
    [verifierGithubCi, 'verifier GitHub CI'],
  ]) {
    digest(binding.sha256, `previous release-ready ${label} evidence SHA-256`)
  }
  digest(publicCatalog.receiptDigest, 'previous release-ready public catalog receipt digest')
  digest(catalogSources.receiptDigest, 'previous release-ready catalog source receipt digest')
  canonicalTimestamp(catalogSources.observedAt, 'previous release-ready catalog source observation time')
  positiveInteger(catalogSources.entryCount, 'previous release-ready catalog source entry count')
  digest(githubCi.receiptDigest, 'previous release-ready GitHub CI receipt digest')
  positiveInteger(githubCi.runId, 'previous release-ready GitHub CI run id')
  digest(verifierGithubCi.receiptDigest, 'previous release-ready verifier GitHub CI receipt digest')
  commit(verifierGithubCi.commit, 'previous release-ready verifier GitHub CI commit')
  positiveInteger(verifierGithubCi.runId, 'previous release-ready verifier GitHub CI run id')
  positiveInteger(verifierGithubCi.runAttempt, 'previous release-ready verifier GitHub CI run attempt')

  const previousGithubCi = evidence.previousGithubCi === null
    ? null
    : releaseReadyEvidenceFile(
      evidence.previousGithubCi,
      'previous release-ready predecessor GitHub CI evidence',
      'P0-GITHUB-CI-EXACT-COMMIT',
      ['receiptDigest', 'runId'],
    )
  const previousReleaseReady = evidence.previousReleaseReady === null
    ? null
    : releaseReadyEvidenceFile(
      evidence.previousReleaseReady,
      'previous release-ready predecessor release-ready evidence',
      'P0-EXTENSION-CENTER-RELEASE-READY',
      ['receiptDigest', 'runId'],
    )
  for (const [binding, label] of [
    [previousGithubCi, 'predecessor GitHub CI'],
    [previousReleaseReady, 'predecessor release-ready'],
  ]) {
    if (binding === null) continue
    digest(binding.sha256, `previous release-ready ${label} evidence SHA-256`)
    digest(binding.receiptDigest, `previous release-ready ${label} receipt digest`)
    positiveInteger(binding.runId, `previous release-ready ${label} run id`)
  }
  if (bootstrap !== (previousGithubCi === null) || bootstrap !== (previousReleaseReady === null)) {
    fail('P0-RELEASE-READY-PREVIOUS', 'previous release-ready predecessor evidence disagrees with its stage')
  }
  const publicationIncident = previousPublicationIncidentBinding(
    evidence.publicationIncident,
    releaseStage,
    schemaVersion,
  )
  return Object.freeze({
    githubCi: Object.freeze({
      sha256: githubCi.sha256,
      receiptDigest: githubCi.receiptDigest,
      runId: githubCi.runId,
    }),
    verifierGithubCi: Object.freeze({
      sha256: verifierGithubCi.sha256,
      receiptDigest: verifierGithubCi.receiptDigest,
      sourceCommit: verifierGithubCi.commit,
      runId: verifierGithubCi.runId,
      runAttempt: verifierGithubCi.runAttempt,
    }),
    publicationIncident,
  })
}

function previousReleaseReadyEvidence(value) {
  const receipt = record(value, 'previous release-ready receipt')
  if (![2, 3].includes(receipt.schemaVersion) || receipt.acceptanceId !== 'P0-EXTENSION-CENTER-RELEASE-READY'
    || receipt.status !== 'passed') {
    fail('P0-RELEASE-READY-CLAIM', 'previous release-ready receipt did not pass its exact acceptance schema')
  }
  if (!['rc0-bootstrap-release-ready', 'p0-release-ready'].includes(receipt.p0Status)) {
    fail('P0-RELEASE-READY-PREVIOUS', 'previous release-ready receipt has an invalid terminal status')
  }
  const { receiptDigest, ...body } = receipt
  if (receiptDigest !== canonicalSha256(body)) {
    fail('P0-RELEASE-READY-PREVIOUS', 'previous release-ready receipt digest does not bind its body')
  }
  const artifacts = record(receipt.artifacts, 'previous release-ready artifacts')
  const previous = artifacts.previous === null
    ? null
    : releaseReadyArtifact(artifacts.previous, 'previous release-ready predecessor artifact')
  const current = releaseReadyArtifact(artifacts.current, 'previous release-ready current artifact')
  const target = record(receipt.target, 'previous release-ready target')
  if (target.repository !== GITHUB_REPOSITORY || target.sourceCommit !== current.sourceCommit
    || target.version !== current.version) {
    fail('P0-RELEASE-READY-PREVIOUS', 'previous release-ready target does not bind its current artifact')
  }
  officialTarget(target.officialDsh, 'previous release-ready official DSH')
  const bootstrap = receipt.p0Status === 'rc0-bootstrap-release-ready'
  let expectedStage
  if (bootstrap) {
    if (current.version !== '0.1.0-rc.0' || previous !== null) {
      fail('P0-RELEASE-READY-PREVIOUS', 'previous release-ready stage and artifact history disagree')
    }
    expectedStage = 'bootstrap-rc0'
  } else {
    if (previous === null) {
      fail('P0-RELEASE-READY-PREVIOUS', 'previous release-ready stage and artifact history disagree')
    }
    expectedStage = fixedUpdateReleaseStage(
      previous.version,
      current.version,
      'P0-RELEASE-READY-PREVIOUS',
      'previous release-ready receipt',
    )
    assertAscendingReleaseTransition(previous.version, current.version)
  }
  if (receipt.releaseStage !== expectedStage) {
    fail('P0-RELEASE-READY-PREVIOUS', 'previous release-ready stage and artifact history disagree')
  }
  if (receipt.schemaVersion === 2 && expectedStage !== 'bootstrap-rc0') {
    fail('P0-RELEASE-READY-PREVIOUS', 'schema-2 release-ready evidence is reserved for the historical rc.0 bootstrap')
  }
  const evidence = previousReleaseReadyBindings(
    receipt.evidence,
    bootstrap,
    receipt.releaseStage,
    receipt.schemaVersion,
  )
  const verifier = verifierIdentity(
    receipt.verifier,
    current.sourceCommit,
    receipt.releaseStage,
    evidence.verifierGithubCi,
  )
  if (evidence.publicationIncident !== null
    && (evidence.publicationIncident.verifierCommit !== current.sourceCommit
      || evidence.publicationIncident.runId === verifier.runId
      || evidence.publicationIncident.verifierGithubCiRunId !== evidence.verifierGithubCi.runId
      || evidence.publicationIncident.verifierGithubCiRunAttempt !== evidence.verifierGithubCi.runAttempt)) {
    fail('P0-RELEASE-READY-PREVIOUS', 'recovery rc.2 publication incident is not independently bound to its protected-main verifier')
  }
  const claims = record(receipt.claims, 'previous release-ready claims')
  for (const field of [
    'independentPluginOnly',
    'officialDshPackageTreeUnchanged',
    'fullPluginMcpSkillLifecycle',
    'hostClientRpcBoot',
    'publicInstallRemove',
    'signedPublicCatalogRefresh',
    'exactCatalogSourceFreshness',
    'exactCommitCrossPlatformCi',
    'exactImmutableReleaseAndAssets',
    'centerOwnedJournalFaultMatrix',
  ]) {
    if (claims[field] !== true) {
      fail('P0-RELEASE-READY-PREVIOUS', `previous release-ready claim ${field} is incomplete`)
    }
  }
  if (claims.publicPreviousToCurrentUpdate !== !bootstrap
    || claims.signedCatalogPreviousToCurrentUpdate !== !bootstrap) {
    fail('P0-RELEASE-READY-PREVIOUS', 'previous release-ready update claims disagree with its stage')
  }
  exactArray(receipt.notProven, [
    ...(bootstrap ? ['public-previous-to-current-update', 'signed-catalog-previous-to-current-update'] : []),
    ...RELEASE_CATALOG_NOT_PROVEN,
  ], 'previous release-ready notProven')
  return Object.freeze({
    receiptDigest,
    stage: receipt.releaseStage,
    previous,
    current,
    catalog: releaseReadyCatalog(receipt.catalog, 'previous release-ready catalog'),
    evidence,
    verifier,
  })
}

function expectedCatalogSource(entry) {
  const upstream = new URL(entry.source.upstreamUrl)
  const repository = upstream.pathname.slice(1)
  if (entry.source.type === 'github-release') {
    return Object.freeze({
      endpoint: `https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(`v${entry.artifact.version}`)}`,
      packageRegistryEndpoint: null,
    })
  }
  if (entry.source.type === 'github-content') {
    return Object.freeze({
      endpoint: `https://api.github.com/repos/${repository}/git/commits/${entry.source.revision}`,
      packageRegistryEndpoint: null,
    })
  }
  return Object.freeze({
    endpoint: `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(entry.name)}/versions/${encodeURIComponent(entry.artifact.version)}`,
    packageRegistryEndpoint: `https://registry.npmjs.org/${encodeURIComponent(entry.artifact.id)}/${encodeURIComponent(entry.artifact.version)}`,
  })
}

function catalogSourceEvidence(value, generatedAtMs) {
  const receipt = record(value, 'catalog source receipt')
  passedReceipt(receipt, 2, 'P0-CATALOG-SOURCE-FRESHNESS', 'catalog source receipt')
  if (receipt.p0Status !== 'exact-signed-catalog-source-observations-proven') {
    fail('P0-RELEASE-READY-SOURCES', 'catalog source receipt is not exact-source proven')
  }
  const { receiptDigest, ...body } = receipt
  if (receiptDigest !== canonicalSha256(body)) {
    fail('P0-RELEASE-READY-SOURCES', 'catalog source receipt digest does not bind its body')
  }
  exactArray(receipt.notProven, EXPECTED_CATALOG_SOURCE_NOT_PROVEN, 'catalog source notProven')
  const observedAt = canonicalTimestamp(receipt.observedAt, 'catalog source observedAt')
  if (observedAt.parsed > generatedAtMs || generatedAtMs - observedAt.parsed > MAX_SOURCE_EVIDENCE_AGE_MS) {
    fail('P0-RELEASE-READY-SOURCES', 'catalog source observation is stale or from the future')
  }
  const catalog = record(receipt.catalog, 'catalog source catalog')
  if (catalog.revision !== EXPECTED_PUBLIC_CATALOG.revision
    || catalog.entriesDigest !== EXPECTED_PUBLIC_CATALOG.entriesDigest
    || catalog.documentDigest !== EXPECTED_PUBLIC_CATALOG.documentDigest
    || catalog.bytesSha256 !== EXPECTED_PUBLIC_CATALOG.bytesSha256) {
    fail('P0-RELEASE-READY-SOURCES', 'catalog source receipt is not bound to the exact deployed signed document')
  }
  const expectedEntries = new Map(BOOTSTRAP_CATALOG_ENVELOPE.entries.map(entry => [entry.candidateRef, entry]))
  if (!Array.isArray(receipt.entries) || receipt.entries.length !== expectedEntries.size) {
    fail('P0-RELEASE-READY-SOURCES', 'catalog source receipt omits Plugin, MCP, or Skill observations')
  }
  const refs = new Set()
  const kinds = new Set()
  for (const value of receipt.entries) {
    const entry = record(value, 'catalog source entry')
    const candidateRef = bounded(entry.candidateRef, 'catalog source candidateRef', 512)
    const kind = bounded(entry.kind, 'catalog source kind', 16)
    if (!['plugin', 'mcp', 'skill'].includes(kind) || !candidateRef.startsWith(`${kind}:`) || refs.has(candidateRef)) {
      fail('P0-RELEASE-READY-SOURCES', 'catalog source receipt contains a duplicate or invalid candidate identity')
    }
    const expected = expectedEntries.get(candidateRef)
    if (expected === undefined || expected.kind !== kind) {
      fail('P0-RELEASE-READY-SOURCES', 'catalog source receipt contains a candidate outside the packaged review set')
    }
    refs.add(candidateRef)
    kinds.add(kind)
    if (entry.entryDigest !== canonicalSha256(expected)) {
      fail('P0-RELEASE-READY-SOURCES', 'catalog source observation is not bound to the exact signed entry')
    }
    const expectedSource = expectedCatalogSource(expected)
    const source = record(entry.source, 'catalog source observation')
    exactKeys(source, expectedSource.packageRegistryEndpoint === null
      ? ['sourceType', 'endpoint', 'resolvedRevision']
      : ['sourceType', 'endpoint', 'packageRegistryEndpoint', 'resolvedRevision'], 'catalog source observation')
    const resolvedRevision = bounded(source.resolvedRevision, 'catalog resolved revision', 256)
    const endpoint = exactHttpsObservationUrl(source.endpoint, 'catalog source endpoint').href
    const packageRegistryEndpoint = expectedSource.packageRegistryEndpoint === null
      ? null
      : exactHttpsObservationUrl(source.packageRegistryEndpoint, 'catalog package Registry endpoint').href
    if (source.sourceType !== expected.source.type || resolvedRevision !== expected.source.revision
      || endpoint !== expectedSource.endpoint || packageRegistryEndpoint !== expectedSource.packageRegistryEndpoint) {
      fail('P0-RELEASE-READY-SOURCES', 'catalog source receipt does not resolve the exact admitted source revision')
    }
    const artifact = record(entry.artifact, 'catalog artifact observation')
    exactKeys(artifact, [
      'sizeBytes', 'integrity', 'sha256', 'redirectCount', 'initialUrl', 'finalUrl', 'finalOrigin',
    ], 'catalog artifact observation')
    const sizeBytes = positiveInteger(artifact.sizeBytes, 'catalog artifact size')
    const sha256 = digest(artifact.sha256, 'catalog artifact SHA-256')
    const integrity = bounded(artifact.integrity, 'catalog artifact integrity', 256)
    const initialUrl = exactHttpsObservationUrl(artifact.initialUrl, 'catalog artifact initial URL')
    const finalUrl = exactHttpsObservationUrl(artifact.finalUrl, 'catalog artifact final URL')
    const finalOrigin = bounded(artifact.finalOrigin, 'catalog artifact final origin', 2_048)
    if (sizeBytes !== expected.artifact.sizeBytes || integrity !== expected.artifact.integrity
      || initialUrl.href !== expected.artifact.acquisitionUrl || finalOrigin !== finalUrl.origin
      || finalUrl.search !== ''
      || (expected.artifact.integrity.startsWith('sha256:') && sha256 !== expected.artifact.integrity)) {
      fail('P0-RELEASE-READY-SOURCES', 'catalog artifact observation does not bind the exact admitted bytes')
    }
    if (!Number.isSafeInteger(artifact.redirectCount) || artifact.redirectCount < 0 || artifact.redirectCount > 3) {
      fail('P0-RELEASE-READY-SOURCES', 'catalog source receipt contains an invalid redirect count')
    }
    if (expected.source.type === 'github-release') {
      if (artifact.redirectCount === 0 && finalUrl.href !== initialUrl.href) {
        fail('P0-RELEASE-READY-SOURCES', 'GitHub Release artifact final URL changed without a redirect')
      }
      if (finalUrl.origin !== initialUrl.origin && !GITHUB_ASSET_ORIGINS.has(finalUrl.origin)) {
        fail('P0-RELEASE-READY-SOURCES', 'GitHub Release artifact ended outside admitted asset origins')
      }
    } else if (artifact.redirectCount !== 0 || finalUrl.href !== initialUrl.href) {
      fail('P0-RELEASE-READY-SOURCES', 'immutable catalog artifact unexpectedly redirected')
    }
  }
  if (!['plugin', 'mcp', 'skill'].every(kind => kinds.has(kind))) {
    fail('P0-RELEASE-READY-SOURCES', 'catalog source receipt does not cover all three extension kinds')
  }
  return Object.freeze({
    receiptDigest,
    observedAt: observedAt.timestamp,
    catalog: Object.freeze({ ...catalog }),
    entryCount: refs.size,
  })
}

function githubCiEvidence(value) {
  const receipt = record(value, 'GitHub CI receipt')
  passedReceipt(receipt, 1, 'P0-GITHUB-CI-EXACT-COMMIT', 'GitHub CI receipt')
  if (receipt.p0Status !== 'exact-commit-ci-proven') {
    fail('P0-RELEASE-READY-CI', 'GitHub CI receipt is not exact-commit proven')
  }
  const { receiptDigest, ...body } = receipt
  if (receiptDigest !== canonicalSha256(body)) fail('P0-RELEASE-READY-CI', 'GitHub CI receipt digest does not bind its body')
  exactArray(receipt.notProven, [], 'GitHub CI notProven')
  const target = record(receipt.target, 'GitHub CI target')
  if (target.repository !== GITHUB_REPOSITORY || target.branch !== GITHUB_BRANCH
    || target.workflowPath !== GITHUB_WORKFLOW_PATH) {
    fail('P0-RELEASE-READY-CI', 'GitHub CI target is not the fixed release workflow')
  }
  const sourceCommit = commit(target.commit, 'GitHub CI commit')
  const run = record(receipt.run, 'GitHub CI run')
  if (run.event !== 'push' || run.headBranch !== GITHUB_BRANCH || run.headSha !== sourceCommit
    || run.status !== 'completed' || run.conclusion !== 'success') {
    fail('P0-RELEASE-READY-CI', 'GitHub CI run is not the successful exact main push')
  }
  const jobs = record(receipt.requiredJobs, 'GitHub CI required jobs')
  for (const requirement of REQUIRED_CI_JOBS) {
    const job = record(jobs[requirement.key], `${requirement.key} GitHub CI job`)
    if (job.name !== requirement.name || job.status !== 'completed' || job.conclusion !== 'success') {
      fail('P0-RELEASE-READY-CI', `GitHub CI job ${requirement.name} is not successful`)
    }
  }
  const pack = record(receipt.packAttestation, 'GitHub CI pack attestation')
  if (pack.sourceCommit !== sourceCommit || !SHA256.test(pack.sha256)
    || !SHA256.test(pack.manifestSha256) || !SHA256.test(pack.pnpmTreeSha256)
    || !SHA256.test(pack.attestationDigest)) {
    fail('P0-RELEASE-READY-CI', 'GitHub CI receipt omits its exact deterministic pack attestation')
  }
  const expectedNames = [pack.filename, 'SHA256SUMS', 'pack-attestation.json']
  if (!Array.isArray(pack.releaseAssets) || pack.releaseAssets.length !== expectedNames.length) {
    fail('P0-RELEASE-READY-CI', 'GitHub CI receipt omits the exact three-file release payload')
  }
  const releaseAssets = Object.freeze(pack.releaseAssets.map((candidate, index) => {
    const asset = record(candidate, `GitHub CI release asset ${String(index)}`)
    if (asset.name !== expectedNames[index]) fail('P0-RELEASE-READY-CI', 'GitHub CI release asset order or name changed')
    return Object.freeze({
      name: asset.name,
      sizeBytes: positiveInteger(asset.sizeBytes, `GitHub CI release asset ${asset.name} size`),
      sha256: digest(asset.sha256, `GitHub CI release asset ${asset.name} SHA-256`),
    })
  }))
  if (releaseAssets[0].sha256 !== pack.sha256 || releaseAssets[0].sizeBytes !== pack.sizeBytes) {
    fail('P0-RELEASE-READY-CI', 'GitHub CI tgz payload differs from its pack attestation')
  }
  return Object.freeze({
    receiptDigest,
    sourceCommit,
    runId: positiveInteger(run.id, 'GitHub CI run id'),
    runAttempt: positiveInteger(run.attempt, 'GitHub CI run attempt'),
    pack: Object.freeze({ ...pack, releaseAssets }),
  })
}

function verifierIdentity(value, targetCommit, releaseStage, verifierCi) {
  const verifier = record(value, 'release-ready verifier')
  exactKeys(verifier, [
    'repository',
    'workflowPath',
    'ref',
    'refProtected',
    'commit',
    'runId',
    'runAttempt',
    'mode',
  ], 'release-ready verifier')
  const verifierCommit = commit(verifier.commit, 'verifier commit')
  const runId = positiveInteger(verifier.runId, 'verifier run id')
  const runAttempt = positiveInteger(verifier.runAttempt, 'verifier run attempt')
  if (verifier.repository !== GITHUB_REPOSITORY
    || verifier.workflowPath !== POST_PUBLICATION_WORKFLOW_PATH
    || verifier.ref !== GITHUB_MAIN_REF
    || verifier.refProtected !== true) {
    fail('P0-RELEASE-READY-VERIFIER', 'verifier is not the protected main post-publication workflow')
  }
  if (verifierCi.sourceCommit !== verifierCommit) {
    fail('P0-RELEASE-READY-VERIFIER', 'verifier GitHub CI commit does not match the verifier commit')
  }
  const mode = verifierCommit === targetCommit ? 'same-commit' : 'rc0-backfill'
  if (verifier.mode !== mode) {
    fail('P0-RELEASE-READY-VERIFIER', 'verifier mode does not match target and verifier commits')
  }
  if (mode === 'rc0-backfill' && releaseStage !== 'bootstrap-rc0') {
    fail('P0-RELEASE-READY-VERIFIER', 'only immutable rc.0 may use a distinct verifier commit')
  }
  return Object.freeze({
    repository: verifier.repository,
    workflowPath: verifier.workflowPath,
    ref: verifier.ref,
    refProtected: true,
    commit: verifierCommit,
    runId,
    runAttempt,
    mode,
  })
}

function sameArtifact(left, right, label) {
  for (const field of ['version', 'sha256', 'sizeBytes', 'manifestSha256', 'pnpmTreeSha256', 'sourceCommit']) {
    if (left[field] !== right[field]) fail('P0-RELEASE-READY-BINDING', `${label} differs at ${field}`)
  }
}

function sameBoundArtifact(left, right, label) {
  const bound = record(left, label)
  for (const field of ['version', 'sha256', 'manifestSha256', 'pnpmTreeSha256', 'sourceCommit']) {
    if (bound[field] !== right[field]) fail('P0-RELEASE-READY-BINDING', `${label} differs at ${field}`)
  }
}

function sameReleasePayload(left, right, label) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length
    || left.some((asset, index) => asset.name !== right[index].name
      || asset.sizeBytes !== right[index].sizeBytes || asset.sha256 !== right[index].sha256)) {
    fail('P0-RELEASE-READY-BINDING', `${label} does not bind the same exact three-file payload`)
  }
}

function sameImmutableRelease(left, right, label) {
  for (const field of ['bundleSha256', 'statementSha256', 'tagRefSha1']) {
    if (left[field] !== right[field]) {
      fail('P0-RELEASE-READY-BINDING', `${label} differs at ${field}`)
    }
  }
}

function sameCatalogIdentity(left, right, label) {
  for (const field of ['revision', 'entriesDigest', 'envelopeDigest', 'signatureSetDigest']) {
    if (left[field] !== right[field]) {
      fail('P0-RELEASE-READY-BINDING', `${label} differs at ${field}`)
    }
  }
}

function catalogObserved(catalog, publicCatalog, label) {
  const matchesBootstrap = catalog.revision === publicCatalog.bootstrap.revision
    && catalog.entriesDigest === publicCatalog.bootstrap.entriesDigest
  const matchesDeployment = catalog.revision === publicCatalog.deployment.revision
    && catalog.entriesDigest === publicCatalog.deployment.entriesDigest
  if (!matchesBootstrap && !matchesDeployment) {
    fail('P0-RELEASE-READY-BINDING', `${label} is outside the signed bootstrap-to-public catalog chain`)
  }
}

function publicationIncidentEvidence(value, verifierCiValue, inputDigest, verifierCiDigest, runId) {
  const incident = validatePublicationIncidentReceipt(value, {
    targetCommit: RECOVERY_FAILED_COMMIT,
    failedRunId: RECOVERY_FAILED_RUN_ID,
    failedRunAttempt: RECOVERY_FAILED_RUN_ATTEMPT,
    previousCommit: RECOVERY_PREVIOUS_COMMIT,
    previousEvidenceRunId: RECOVERY_PREVIOUS_RUN_ID,
    previousEvidenceRunAttempt: RECOVERY_PREVIOUS_RUN_ATTEMPT,
    verifierRunId: runId,
    verifierRunAttempt: RECOVERY_INCIDENT_RUN_ATTEMPT,
  })
  const verifierCi = githubCiEvidence(verifierCiValue)
  if (incident.verifier.commit !== verifierCi.sourceCommit
    || incident.verifier.githubCi.fileSha256 !== verifierCiDigest
    || incident.verifier.githubCi.receiptDigest !== verifierCi.receiptDigest
    || incident.verifier.githubCi.runId !== verifierCi.runId
    || incident.verifier.githubCi.runAttempt !== verifierCi.runAttempt) {
    fail('P0-RELEASE-READY-INCIDENT', 'publication incident does not bind its exact protected-main CI receipt bytes')
  }
  return Object.freeze({
    ...incident,
    fileSha256: inputDigest,
    verifierCi,
  })
}

/** Aggregate independently generated receipts and reject any cross-run identity drift. */
export function assertReleaseReady(inputValue) {
  const input = record(inputValue, 'release-ready evidence')
  const generatedAt = canonicalTimestamp(
    input.generatedAt === undefined ? new Date().toISOString() : input.generatedAt,
    'generatedAt',
  )
  const suppliedDigests = record(input.receiptDigests, 'release-ready receipt digests')
  const receiptDigests = Object.freeze(Object.fromEntries([
    ['fullP0', 'full P0'],
    ['runtimeRelease', 'runtime Release'],
    ['publicRelease', 'public Release'],
    ['publicCatalog', 'public catalog'],
    ['catalogSources', 'catalog sources'],
    ['githubCi', 'GitHub CI'],
    ['verifierGithubCi', 'verifier GitHub CI'],
  ].map(([key, label]) => [key, digest(suppliedDigests[key], `${label} receipt SHA-256`)])))
  const full = fullP0Evidence(input.fullP0)
  const runtime = runtimeReleaseEvidence(input.runtimeRelease)
  const published = publicReleaseEvidence(input.publicRelease)
  const catalog = publicCatalogEvidence(input.publicCatalog)
  const sources = catalogSourceEvidence(input.catalogSources, generatedAt.parsed)
  const ci = githubCiEvidence(input.githubCi)
  const verifierCi = githubCiEvidence(input.verifierGithubCi)
  const verifier = verifierIdentity(
    input.verifier,
    published.current.sourceCommit,
    published.stage,
    verifierCi,
  )
  const previousCi = input.previousGithubCi === null ? null : githubCiEvidence(input.previousGithubCi)
  const previousCiDigest = previousCi === null
    ? suppliedDigests.previousGithubCi === null ? null
      : fail('P0-RELEASE-READY-BINDING', 'rc.0 must explicitly bind previous GitHub CI as null')
    : digest(suppliedDigests.previousGithubCi, 'previous GitHub CI receipt SHA-256')
  const previousReady = input.previousReleaseReady === null
    ? null
    : previousReleaseReadyEvidence(input.previousReleaseReady)
  const previousReadyDigest = previousReady === null
    ? suppliedDigests.previousReleaseReady === null ? null
      : fail('P0-RELEASE-READY-BINDING', 'rc.0 must explicitly bind previous release-ready evidence as null')
    : digest(suppliedDigests.previousReleaseReady, 'previous release-ready receipt SHA-256')
  const previousVerifierCi = input.previousVerifierGithubCi === null
    ? null
    : githubCiEvidence(input.previousVerifierGithubCi)
  const previousVerifierCiDigest = previousVerifierCi === null
    ? suppliedDigests.previousVerifierGithubCi === null ? null
      : fail('P0-RELEASE-READY-BINDING', 'rc.0 must explicitly bind previous verifier GitHub CI as null')
    : digest(suppliedDigests.previousVerifierGithubCi, 'previous verifier GitHub CI receipt SHA-256')
  const previousEvidenceRunId = input.previousEvidenceRunId === null
    ? null
    : positiveInteger(input.previousEvidenceRunId, 'previous post-publication evidence run id')
  const incidentInput = input.publicationIncident ?? null
  const incidentVerifierCiInput = input.publicationIncidentVerifierGithubCi ?? null
  const incidentRunIdInput = input.publicationIncidentRunId ?? null
  const incidentDigestInput = suppliedDigests.publicationIncident ?? null
  const incidentVerifierCiDigestInput = suppliedDigests.publicationIncidentVerifierGithubCi ?? null
  const incidentInputsPresent = [
    incidentInput,
    incidentVerifierCiInput,
    incidentRunIdInput,
    incidentDigestInput,
    incidentVerifierCiDigestInput,
  ].map(value => value !== null)
  if (incidentInputsPresent.some(Boolean) && !incidentInputsPresent.every(Boolean)) {
    fail('P0-RELEASE-READY-INCIDENT', 'publication incident receipt, verifier CI, digests, and run id must be supplied together')
  }
  const recovery = published.stage === 'recovery-rc'
  if (recovery !== incidentInputsPresent.every(Boolean)) {
    fail(
      'P0-RELEASE-READY-INCIDENT',
      recovery
        ? 'recovery rc.2 omitted the terminal rc.1 publication incident'
        : 'only recovery rc.2 may bind the terminal rc.1 publication incident',
    )
  }
  const incident = recovery
    ? publicationIncidentEvidence(
      incidentInput,
      incidentVerifierCiInput,
      digest(incidentDigestInput, 'publication incident receipt SHA-256'),
      digest(incidentVerifierCiDigestInput, 'publication incident verifier CI SHA-256'),
      positiveInteger(incidentRunIdInput, 'publication incident evidence run id'),
    )
    : null
  if (published.stage === 'update-rc' && published.current.sourceCommit === RECOVERY_FAILED_COMMIT) {
    fail('P0-RELEASE-READY-INCIDENT', 'immutable rc.1 is terminal not-release-ready and cannot produce a passed composite')
  }
  if (incident !== null && incident.target.version !== '0.1.0-rc.1') {
    fail('P0-RELEASE-READY-INCIDENT', 'publication incident does not bind immutable rc.1')
  }
  if (incident !== null
    && (incident.verifier.githubCi.runId !== verifierCi.runId
      || incident.verifier.githubCi.runAttempt !== verifierCi.runAttempt)) {
    fail('P0-RELEASE-READY-INCIDENT', 'publication incident verifier did not observe the rc.2 exact-main CI run')
  }

  for (const field of ['dshPackage', 'auditedSourceCommit', 'registry', 'registryIntegrity']) {
    if (full.target[field] !== runtime.target[field] || full.target[field] !== published.target[field]) {
      fail('P0-RELEASE-READY-BINDING', 'receipts do not share one exact published official DSH rc.2 identity')
    }
  }
  sameArtifact(runtime.current, published.current, 'current runtime and public artifacts')
  if (full.artifact.version !== published.current.version
    || full.artifact.sha256 !== published.current.sha256
    || full.artifact.sizeBytes !== published.current.sizeBytes) {
    fail('P0-RELEASE-READY-BINDING', 'full lifecycle did not exercise the exact public current artifact')
  }
  if (ci.sourceCommit !== published.current.sourceCommit) {
    fail('P0-RELEASE-READY-BINDING', 'public artifact commit does not match the exact successful GitHub CI commit')
  }
  sameArtifact(ci.pack, published.current, 'CI-attested and public current artifacts')
  sameReleasePayload(ci.pack.releaseAssets, published.current.releasePayload, 'current CI and public Release payloads')
  for (const [label, binding] of [
    ['runtime', runtime.ciPackAttestation],
    ['public', published.ciPackAttestation],
  ]) {
    const artifact = record(binding.artifact, `${label} CI-attested artifact`)
    if (binding.acceptanceId !== 'P0-GITHUB-CI-EXACT-COMMIT'
      || binding.fileSha256 !== receiptDigests.githubCi
      || binding.receiptDigest !== ci.receiptDigest
      || binding.runId !== ci.runId || binding.runAttempt !== ci.runAttempt
      || artifact.version !== ci.pack.version || artifact.sha256 !== ci.pack.sha256
      || artifact.sizeBytes !== ci.pack.sizeBytes || artifact.manifestSha256 !== ci.pack.manifestSha256
      || artifact.pnpmTreeSha256 !== ci.pack.pnpmTreeSha256
      || artifact.sourceCommit !== ci.pack.sourceCommit) {
      fail('P0-RELEASE-READY-BINDING', `${label} receipt does not bind the exact CI deterministic pack attestation`)
    }
    sameReleasePayload(artifact.releaseAssets, ci.pack.releaseAssets, `${label} CI pack payload`)
  }
  if ((runtime.previous === null) !== (published.previous === null)) {
    fail('P0-RELEASE-READY-BINDING', 'runtime and public receipts disagree about the previous artifact')
  }
  if (runtime.previous !== null) sameArtifact(runtime.previous, published.previous, 'previous runtime and public artifacts')
  const runtimeBinding = published.runtimeAcceptance
  if (runtimeBinding.acceptanceId !== 'P0-CENTER-HOST-CLIENT-BOOT'
    || runtimeBinding.sha256 !== receiptDigests.runtimeRelease
    || runtimeBinding.officialDshPackageTreeUnchanged !== true) {
    fail('P0-RELEASE-READY-BINDING', 'public Release receipt does not bind the exact runtime receipt bytes')
  }
  sameBoundArtifact(runtimeBinding.current, published.current, 'public runtime binding and current artifact')
  if (published.previous === null) {
    if (runtimeBinding.previous !== null || runtime.previousCatalog !== null
      || previousCi !== null || published.previousCiPackAttestation !== null
      || previousReady !== null || previousReadyDigest !== null || previousEvidenceRunId !== null
      || previousVerifierCi !== null || previousVerifierCiDigest !== null) {
      fail('P0-RELEASE-READY-BINDING', 'rc.0 injected previous runtime, public, CI, or release-ready evidence')
    }
  } else {
    sameBoundArtifact(runtimeBinding.previous, published.previous, 'public runtime binding and previous artifact')
    if (previousCi === null || previousCiDigest === null) {
      fail('P0-RELEASE-READY-BINDING', 'public update omitted the previous exact-commit GitHub CI receipt')
    }
    sameArtifact(previousCi.pack, published.previous, 'previous CI-attested and public artifacts')
    sameArtifact(previousCi.pack, runtime.previous, 'previous CI-attested and runtime artifacts')
    sameReleasePayload(previousCi.pack.releaseAssets, published.previous.releasePayload, 'previous CI and public Release payloads')
    const binding = record(published.previousCiPackAttestation, 'bound previous CI pack attestation')
    const artifact = record(binding.artifact, 'bound previous CI-attested artifact')
    if (binding.acceptanceId !== 'P0-GITHUB-CI-EXACT-COMMIT'
      || binding.fileSha256 !== previousCiDigest || binding.receiptDigest !== previousCi.receiptDigest
      || binding.runId !== previousCi.runId || binding.runAttempt !== previousCi.runAttempt) {
      fail('P0-RELEASE-READY-BINDING', 'public Release receipt does not bind the previous exact GitHub CI receipt')
    }
    sameArtifact(artifact, previousCi.pack, 'bound previous CI artifact')
    sameReleasePayload(artifact.releaseAssets, previousCi.pack.releaseAssets, 'bound previous CI payload')
    if (previousReady === null || previousReadyDigest === null || previousEvidenceRunId === null
      || previousVerifierCi === null || previousVerifierCiDigest === null
      || runtime.previousCatalog === null) {
      fail('P0-RELEASE-READY-BINDING', 'public update omitted the previous release-ready catalog transition')
    }
    if (previousReady.evidence.githubCi.sha256 !== previousCiDigest
      || previousReady.evidence.githubCi.receiptDigest !== previousCi.receiptDigest
      || previousReady.evidence.githubCi.runId !== previousCi.runId) {
      fail('P0-RELEASE-READY-BINDING', 'previous release-ready receipt does not bind its exact GitHub CI evidence')
    }
    if (previousReady.verifier.runId !== previousEvidenceRunId) {
      fail('P0-RELEASE-READY-BINDING', 'previous release-ready verifier run does not match the downloaded evidence run')
    }
    const previousVerifierBinding = previousReady.evidence.verifierGithubCi
    if (previousVerifierBinding.sha256 !== previousVerifierCiDigest
      || previousVerifierBinding.receiptDigest !== previousVerifierCi.receiptDigest
      || previousVerifierBinding.sourceCommit !== previousVerifierCi.sourceCommit
      || previousVerifierBinding.runId !== previousVerifierCi.runId
      || previousVerifierBinding.runAttempt !== previousVerifierCi.runAttempt) {
      fail('P0-RELEASE-READY-BINDING', 'previous release-ready receipt does not bind its exact verifier GitHub CI receipt')
    }
    sameArtifact(previousReady.current, published.previous, 'previous release-ready and public previous artifacts')
    sameReleasePayload(
      previousReady.current.releasePayload,
      published.previous.releasePayload,
      'previous release-ready and public previous payloads',
    )
    sameImmutableRelease(
      previousReady.current.immutableRelease,
      published.previous.immutableRelease,
      'previous release-ready and public previous immutable Releases',
    )
    if (previousReady.current.releaseId !== published.previous.releaseId) {
      fail('P0-RELEASE-READY-BINDING', 'previous release-ready receipt names a different concrete Release')
    }
    sameCatalogIdentity(
      previousReady.catalog.deployment,
      catalog.bootstrap,
      'previous deployed and current packaged catalogs',
    )
    if (runtime.previousCatalog.revision !== previousReady.catalog.bootstrap.revision
      || runtime.previousCatalog.entriesDigest !== previousReady.catalog.bootstrap.entriesDigest) {
      fail('P0-RELEASE-READY-BINDING', 'previous runtime artifact did not retain its prior packaged bootstrap against the newer public successor')
    }
    const previousAdmission = runtime.previousCatalog.admission
    if (previousAdmission.source !== 'bootstrap' || previousAdmission.freshness !== 'bootstrap'
      || previousAdmission.degraded !== true
      || previousAdmission.degradedReason !== 'catalog revision chain contains a gap') {
      fail('P0-RELEASE-READY-BINDING', 'previous runtime artifact did not expose the expected adjacent-only catalog degradation before update')
    }
    if (recovery) {
      if (incident.failure.previous.commit !== published.previous.sourceCommit
        || incident.failure.previous.version !== published.previous.version
        || incident.failure.previous.fileSha256 !== previousCiDigest
        || incident.failure.previous.receiptDigest !== previousCi.receiptDigest
        || incident.failure.previous.runId !== previousCi.runId
        || incident.failure.previous.runAttempt !== previousCi.runAttempt) {
        fail('P0-RELEASE-READY-INCIDENT', 'rc.1 incident does not retain the exact successful rc.0 CI receipt')
      }
      if (incident.previousSuccessfulPublication.targetCommit !== published.previous.sourceCommit
        || incident.previousSuccessfulPublication.runId !== previousEvidenceRunId
        || incident.previousSuccessfulPublication.releaseReadyFileSha256 !== previousReadyDigest
        || incident.previousSuccessfulPublication.releaseReadyReceiptDigest !== previousReady.receiptDigest) {
        fail('P0-RELEASE-READY-INCIDENT', 'rc.1 incident does not retain the exact successful rc.0 release-ready receipt')
      }
      if (incident.verifier.commit !== published.current.sourceCommit
        || incident.verifier.runId === verifier.runId
        || incident.verifier.runId === incident.failure.runId
        || incident.verifier.runId === incident.previousSuccessfulPublication.runId) {
        fail('P0-RELEASE-READY-INCIDENT', 'rc.1 incident was not independently recorded by the rc.2 protected-main verifier')
      }
    }
  }
  catalogObserved(full.catalog, catalog, 'full lifecycle catalog observation')
  catalogObserved(runtime.currentCatalog, catalog, 'runtime Release catalog observation')
  if (runtime.currentCatalog.admission.source !== 'remote'
    || runtime.currentCatalog.admission.freshness !== 'fresh'
    || runtime.currentCatalog.admission.degraded !== false
    || runtime.currentCatalog.admission.degradedReason !== null) {
    fail('P0-RELEASE-READY-BINDING', 'current runtime artifact did not refresh the same persistent Center root to the fresh public catalog')
  }
  if (sources.catalog.revision !== catalog.deployment.revision
    || sources.catalog.entriesDigest !== catalog.deployment.entriesDigest
    || sources.catalog.documentDigest !== catalog.deployment.documentDigest
    || sources.catalog.bytesSha256 !== catalog.deployment.bytesSha256) {
    fail('P0-RELEASE-READY-BINDING', 'source freshness and public deployment receipts do not describe the same signed catalog')
  }

  const previous = published.previous === null ? null : Object.freeze({ ...published.previous })
  const current = Object.freeze({ ...published.current })
  const bootstrap = published.stage === 'bootstrap-rc0'
  const body = Object.freeze({
    schemaVersion: 3,
    acceptanceId: 'P0-EXTENSION-CENTER-RELEASE-READY',
    status: 'passed',
    p0Status: bootstrap ? 'rc0-bootstrap-release-ready' : 'p0-release-ready',
    releaseStage: published.stage,
    generatedAt: generatedAt.timestamp,
    verifier,
    target: Object.freeze({
      repository: GITHUB_REPOSITORY,
      sourceCommit: current.sourceCommit,
      version: current.version,
      officialDsh: full.target,
    }),
    artifacts: Object.freeze({ previous, current }),
    catalog: Object.freeze({ bootstrap: catalog.bootstrap, deployment: catalog.deployment }),
    evidence: Object.freeze({
      fullP0: Object.freeze({
        acceptanceId: input.fullP0.acceptanceId,
        sha256: receiptDigests.fullP0,
        faultMatrix: full.faultMatrix,
      }),
      runtimeRelease: Object.freeze({ acceptanceId: input.runtimeRelease.acceptanceId, sha256: receiptDigests.runtimeRelease }),
      publicRelease: Object.freeze({ acceptanceId: input.publicRelease.acceptanceId, sha256: receiptDigests.publicRelease }),
      publicCatalog: Object.freeze({ acceptanceId: input.publicCatalog.acceptanceId, sha256: receiptDigests.publicCatalog, receiptDigest: catalog.receiptDigest }),
      catalogSources: Object.freeze({ acceptanceId: input.catalogSources.acceptanceId, sha256: receiptDigests.catalogSources, receiptDigest: sources.receiptDigest, observedAt: sources.observedAt, entryCount: sources.entryCount }),
      githubCi: Object.freeze({ acceptanceId: input.githubCi.acceptanceId, sha256: receiptDigests.githubCi, receiptDigest: ci.receiptDigest, runId: ci.runId }),
      verifierGithubCi: Object.freeze({
        acceptanceId: input.verifierGithubCi.acceptanceId,
        sha256: receiptDigests.verifierGithubCi,
        receiptDigest: verifierCi.receiptDigest,
        commit: verifierCi.sourceCommit,
        runId: verifierCi.runId,
        runAttempt: verifierCi.runAttempt,
      }),
      previousGithubCi: previousCi === null ? null : Object.freeze({
        acceptanceId: input.previousGithubCi.acceptanceId,
        sha256: previousCiDigest,
        receiptDigest: previousCi.receiptDigest,
        runId: previousCi.runId,
      }),
      previousReleaseReady: previousReady === null ? null : Object.freeze({
        acceptanceId: input.previousReleaseReady.acceptanceId,
        sha256: previousReadyDigest,
        receiptDigest: previousReady.receiptDigest,
        runId: previousEvidenceRunId,
      }),
      publicationIncident: incident === null ? null : Object.freeze({
        acceptanceId: incident.acceptanceId,
        sha256: incident.fileSha256,
        receiptDigest: incident.receiptDigest,
        runId: incident.verifier.runId,
        runAttempt: incident.verifier.runAttempt,
        failedRunId: incident.failure.runId,
        failedRunAttempt: incident.failure.runAttempt,
        targetCommit: incident.target.sourceCommit,
        targetVersion: incident.target.version,
        verifierCommit: incident.verifier.commit,
        verifierGithubCiSha256: incident.verifier.githubCi.fileSha256,
        verifierGithubCiReceiptDigest: incident.verifier.githubCi.receiptDigest,
        verifierGithubCiRunId: incident.verifier.githubCi.runId,
        verifierGithubCiRunAttempt: incident.verifier.githubCi.runAttempt,
      }),
    }),
    claims: Object.freeze({
      independentPluginOnly: true,
      officialDshPackageTreeUnchanged: true,
      fullPluginMcpSkillLifecycle: true,
      hostClientRpcBoot: true,
      publicInstallRemove: true,
      publicPreviousToCurrentUpdate: !bootstrap,
      signedPublicCatalogRefresh: true,
      signedCatalogPreviousToCurrentUpdate: !bootstrap,
      exactCatalogSourceFreshness: true,
      exactCommitCrossPlatformCi: true,
      exactImmutableReleaseAndAssets: true,
      centerOwnedJournalFaultMatrix: true,
    }),
    compatibilitySmokes: Object.freeze({ liveProvider: input.fullP0.compatibilitySmokes.liveProvider }),
    notProven: Object.freeze([
      ...(bootstrap ? ['public-previous-to-current-update', 'signed-catalog-previous-to-current-update'] : []),
      ...RELEASE_CATALOG_NOT_PROVEN,
    ]),
  })
  return Object.freeze({ ...body, receiptDigest: canonicalSha256(body) })
}

async function readReceipt(path, label) {
  const opened = await lstat(path)
  if (!opened.isFile() || opened.isSymbolicLink()) {
    fail('P0-RELEASE-READY-INPUT', `${label} must be one bounded regular file`)
  }
  const canonical = await realpath(path)
  const info = await lstat(canonical)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAX_RECEIPT_BYTES) {
    fail('P0-RELEASE-READY-INPUT', `${label} must be one bounded regular file`)
  }
  const bytes = await readFile(canonical)
  if (bytes[bytes.length - 1] !== 0x0a) fail('P0-RELEASE-READY-INPUT', `${label} is incomplete`)
  let receipt
  try {
    receipt = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('P0-RELEASE-READY-INPUT', `${label} is not JSON`)
  }
  return Object.freeze({
    path: canonical,
    receipt,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  })
}

async function prepareReceiptDestination(path, inputs) {
  const requested = resolve(path)
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 })
  const destination = resolve(await realpath(dirname(requested)), basename(requested))
  if (inputs.some(input => input.path === destination)) {
    fail('P0-RELEASE-READY-RECEIPT', 'release-ready output aliases an input receipt')
  }
  try {
    await lstat(destination)
    fail('P0-RELEASE-READY-RECEIPT', 'release-ready receipt output already exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return destination
}

async function writeReceipt(destination, receipt) {
  const temporary = resolve(dirname(destination), `.release-ready-${randomUUID()}`)
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  try {
    await link(temporary, destination)
  } catch (error) {
    if (error?.code === 'EEXIST') fail('P0-RELEASE-READY-RECEIPT', 'release-ready receipt output appeared concurrently')
    throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** Read, cross-bind, and atomically publish one release-ready receipt. */
export async function composeReleaseReadyReceipt(optionsValue) {
  const options = record(optionsValue, 'release-ready options')
  const requiredInputs = await Promise.all([
    readReceipt(resolve(options.fullP0Path), 'full P0 receipt'),
    readReceipt(resolve(options.runtimeReleasePath), 'runtime Release receipt'),
    readReceipt(resolve(options.publicReleasePath), 'public Release receipt'),
    readReceipt(resolve(options.publicCatalogPath), 'public catalog receipt'),
    readReceipt(resolve(options.catalogSourcesPath), 'catalog source receipt'),
    readReceipt(resolve(options.githubCiPath), 'GitHub CI receipt'),
    readReceipt(resolve(options.verifierGithubCiPath), 'verifier GitHub CI receipt'),
  ])
  const previousGithubCi = options.previousGithubCiPath === null || options.previousGithubCiPath === undefined
    ? null
    : await readReceipt(resolve(options.previousGithubCiPath), 'previous GitHub CI receipt')
  const previousVerifierGithubCi = options.previousVerifierGithubCiPath === null
    || options.previousVerifierGithubCiPath === undefined
    ? null
    : await readReceipt(resolve(options.previousVerifierGithubCiPath), 'previous verifier GitHub CI receipt')
  const previousReleaseReady = options.previousReleaseReadyPath === null || options.previousReleaseReadyPath === undefined
    ? null
    : await readReceipt(resolve(options.previousReleaseReadyPath), 'previous release-ready receipt')
  const publicationIncident = options.publicationIncidentPath === null
    || options.publicationIncidentPath === undefined
    ? null
    : await readReceipt(resolve(options.publicationIncidentPath), 'publication incident receipt')
  const publicationIncidentVerifierGithubCi = options.publicationIncidentVerifierGithubCiPath === null
    || options.publicationIncidentVerifierGithubCiPath === undefined
    ? null
    : await readReceipt(
      resolve(options.publicationIncidentVerifierGithubCiPath),
      'publication incident verifier GitHub CI receipt',
    )
  const inputs = [
    ...requiredInputs,
    ...(previousGithubCi === null ? [] : [previousGithubCi]),
    ...(previousVerifierGithubCi === null ? [] : [previousVerifierGithubCi]),
    ...(previousReleaseReady === null ? [] : [previousReleaseReady]),
    ...(publicationIncident === null ? [] : [publicationIncident]),
    ...(publicationIncidentVerifierGithubCi === null ? [] : [publicationIncidentVerifierGithubCi]),
  ]
  if (new Set(inputs.map(input => input.path)).size !== inputs.length) {
    fail('P0-RELEASE-READY-INPUT', 'release-ready inputs must be distinct receipt files')
  }
  const destination = await prepareReceiptDestination(options.receiptPath ?? DEFAULT_RECEIPT_PATH, inputs)
  const [
    fullP0,
    runtimeRelease,
    publicRelease,
    publicCatalog,
    catalogSources,
    githubCi,
    verifierGithubCi,
  ] = requiredInputs
  const receipt = assertReleaseReady({
    fullP0: fullP0.receipt,
    runtimeRelease: runtimeRelease.receipt,
    publicRelease: publicRelease.receipt,
    publicCatalog: publicCatalog.receipt,
    catalogSources: catalogSources.receipt,
    githubCi: githubCi.receipt,
    verifierGithubCi: verifierGithubCi.receipt,
    verifier: {
      repository: GITHUB_REPOSITORY,
      workflowPath: POST_PUBLICATION_WORKFLOW_PATH,
      ref: GITHUB_MAIN_REF,
      refProtected: true,
      commit: options.verifierCommit,
      runId: options.verifierRunId,
      runAttempt: options.verifierRunAttempt,
      mode: options.verifierCommit === githubCi.receipt.target?.commit ? 'same-commit' : 'rc0-backfill',
    },
    previousGithubCi: previousGithubCi?.receipt ?? null,
    previousVerifierGithubCi: previousVerifierGithubCi?.receipt ?? null,
    previousReleaseReady: previousReleaseReady?.receipt ?? null,
    previousEvidenceRunId: options.previousEvidenceRunId ?? null,
    publicationIncident: publicationIncident?.receipt ?? null,
    publicationIncidentVerifierGithubCi: publicationIncidentVerifierGithubCi?.receipt ?? null,
    publicationIncidentRunId: options.publicationIncidentRunId ?? null,
    receiptDigests: {
      fullP0: fullP0.sha256,
      runtimeRelease: runtimeRelease.sha256,
      publicRelease: publicRelease.sha256,
      publicCatalog: publicCatalog.sha256,
      catalogSources: catalogSources.sha256,
      githubCi: githubCi.sha256,
      verifierGithubCi: verifierGithubCi.sha256,
      previousGithubCi: previousGithubCi?.sha256 ?? null,
      previousVerifierGithubCi: previousVerifierGithubCi?.sha256 ?? null,
      previousReleaseReady: previousReleaseReady?.sha256 ?? null,
      publicationIncident: publicationIncident?.sha256 ?? null,
      publicationIncidentVerifierGithubCi: publicationIncidentVerifierGithubCi?.sha256 ?? null,
    },
    generatedAt: options.generatedAt,
  })
  await writeReceipt(destination, receipt)
  return Object.freeze({ receipt, receiptPath: destination })
}

export function parseReleaseReadyArguments(arguments_) {
  if (!Array.isArray(arguments_)) fail('P0-RELEASE-READY-INPUT', 'CLI arguments must be an array')
  if (arguments_.length === 1 && arguments_[0] === '--help') return Object.freeze({ help: true })
  if (arguments_.length % 2 !== 0) fail('P0-RELEASE-READY-INPUT', 'CLI flags must be key/value pairs')
  const values = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (!INPUT_FLAGS.includes(key) || values.has(key) || value === undefined) {
      fail('P0-RELEASE-READY-INPUT', 'CLI accepts only unique release-ready receipt flags')
    }
    values.set(key, value)
  }
  for (const key of REQUIRED_INPUT_FLAGS) {
    if (!values.has(key)) fail('P0-RELEASE-READY-INPUT', `${key} is required`)
  }
  if (new Set([
    values.has('--previous-verifier-github-ci'),
    values.has('--previous-release-ready'),
    values.has('--previous-evidence-run-id'),
  ]).size !== 1) {
    fail('P0-RELEASE-READY-INPUT', 'previous verifier CI, release-ready receipt, and evidence run id must be supplied together')
  }
  if (new Set([
    values.has('--publication-incident'),
    values.has('--publication-incident-verifier-github-ci'),
    values.has('--publication-incident-run-id'),
  ]).size !== 1) {
    fail('P0-RELEASE-READY-INPUT', 'publication incident receipt, verifier CI, and run id must be supplied together')
  }
  let previousEvidenceRunId = null
  if (values.has('--previous-evidence-run-id')) {
    const input = bounded(values.get('--previous-evidence-run-id'), 'previous post-publication evidence run id', 32)
    if (!/^[1-9][0-9]*$/u.test(input)) {
      fail('P0-RELEASE-READY-INPUT', 'previous post-publication evidence run id must be a positive integer')
    }
    previousEvidenceRunId = positiveInteger(Number(input), 'previous post-publication evidence run id')
  }
  let publicationIncidentRunId = null
  if (values.has('--publication-incident-run-id')) {
    const input = bounded(
      values.get('--publication-incident-run-id'),
      'publication incident evidence run id',
      32,
    )
    if (!/^[1-9][0-9]*$/u.test(input)) {
      fail('P0-RELEASE-READY-INPUT', 'publication incident evidence run id must be a positive integer')
    }
    publicationIncidentRunId = positiveInteger(Number(input), 'publication incident evidence run id')
  }
  const verifierCommit = commit(values.get('--verifier-commit'), 'verifier commit')
  const verifierRunIdInput = bounded(values.get('--verifier-run-id'), 'verifier run id', 32)
  const verifierRunAttemptInput = bounded(values.get('--verifier-run-attempt'), 'verifier run attempt', 32)
  if (!/^[1-9][0-9]*$/u.test(verifierRunIdInput)) {
    fail('P0-RELEASE-READY-INPUT', 'verifier run id must be a positive integer')
  }
  if (!/^[1-9][0-9]*$/u.test(verifierRunAttemptInput)) {
    fail('P0-RELEASE-READY-INPUT', 'verifier run attempt must be a positive integer')
  }
  return Object.freeze({
    help: false,
    fullP0Path: resolve(bounded(values.get('--full-p0'), 'full P0 receipt path')),
    runtimeReleasePath: resolve(bounded(values.get('--runtime-release'), 'runtime Release receipt path')),
    publicReleasePath: resolve(bounded(values.get('--public-release'), 'public Release receipt path')),
    publicCatalogPath: resolve(bounded(values.get('--public-catalog'), 'public catalog receipt path')),
    catalogSourcesPath: resolve(bounded(values.get('--catalog-sources'), 'catalog source receipt path')),
    githubCiPath: resolve(bounded(values.get('--github-ci'), 'GitHub CI receipt path')),
    verifierGithubCiPath: resolve(bounded(
      values.get('--verifier-github-ci'),
      'verifier GitHub CI receipt path',
    )),
    verifierCommit,
    verifierRunId: positiveInteger(Number(verifierRunIdInput), 'verifier run id'),
    verifierRunAttempt: positiveInteger(Number(verifierRunAttemptInput), 'verifier run attempt'),
    previousGithubCiPath: values.has('--previous-github-ci')
      ? resolve(bounded(values.get('--previous-github-ci'), 'previous GitHub CI receipt path'))
      : null,
    previousVerifierGithubCiPath: values.has('--previous-verifier-github-ci')
      ? resolve(bounded(
        values.get('--previous-verifier-github-ci'),
        'previous verifier GitHub CI receipt path',
      ))
      : null,
    previousReleaseReadyPath: values.has('--previous-release-ready')
      ? resolve(bounded(values.get('--previous-release-ready'), 'previous release-ready receipt path'))
      : null,
    previousEvidenceRunId,
    publicationIncidentPath: values.has('--publication-incident')
      ? resolve(bounded(values.get('--publication-incident'), 'publication incident receipt path'))
      : null,
    publicationIncidentVerifierGithubCiPath: values.has('--publication-incident-verifier-github-ci')
      ? resolve(bounded(
        values.get('--publication-incident-verifier-github-ci'),
        'publication incident verifier GitHub CI receipt path',
      ))
      : null,
    publicationIncidentRunId,
    receiptPath: resolve(values.has('--receipt')
      ? bounded(values.get('--receipt'), 'release-ready receipt path')
      : DEFAULT_RECEIPT_PATH),
  })
}

async function main() {
  try {
    const parsed = parseReleaseReadyArguments(process.argv.slice(2))
    if (parsed.help) {
      process.stdout.write(USAGE)
      return 0
    }
    const result = await composeReleaseReadyReceipt(parsed)
    process.stdout.write(`${result.receipt.p0Status}; receipt=${result.receiptPath}; digest=${result.receipt.receiptDigest}\n`)
    return 0
  } catch (error) {
    const code = error instanceof AcceptanceFailure ? error.code : 'P0-RELEASE-READY-HARNESS'
    process.stderr.write(`${code}: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
