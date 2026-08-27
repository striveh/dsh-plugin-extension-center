import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildRuntimeAcceptanceReceipt,
  parseRuntimeReleaseArguments,
} from './verify-runtime-release.mjs'
import { validateRuntimeAcceptanceReceipt } from './verify-public-release.mjs'
import { TARGET_DSH_REGISTRY_INTEGRITY } from '../store-only/support.mjs'

const previous = Object.freeze({
  source: '/tmp/dsh-plugin-extension-center-0.1.0-rc.0.tgz',
  version: '0.1.0-rc.0',
  sha256: `sha256:${'1'.repeat(64)}`,
  sizeBytes: 101,
  commit: 'a'.repeat(40),
  manifestSha256: `sha256:${'2'.repeat(64)}`,
  pnpmTreeSha256: `sha256:${'a'.repeat(64)}`,
})
const current = Object.freeze({
  source: '/tmp/dsh-plugin-extension-center-0.1.0-rc.1.tgz',
  version: '0.1.0-rc.1',
  sha256: `sha256:${'3'.repeat(64)}`,
  sizeBytes: 102,
  commit: 'b'.repeat(40),
  manifestSha256: `sha256:${'4'.repeat(64)}`,
  pnpmTreeSha256: `sha256:${'b'.repeat(64)}`,
})

function observation(specification, admission = {
  source: 'remote',
  freshness: 'fresh',
  degraded: false,
  degradedReason: null,
}) {
  return {
    version: specification.version,
    sha256: specification.sha256,
    sizeBytes: specification.sizeBytes,
    manifestSha256: specification.manifestSha256,
    sourceCommit: specification.commit,
    installedPnpmTreeSha256: specification.pnpmTreeSha256,
    hostReady: true,
    clientEntryObserved: true,
    clientBundleRequested: true,
    rpcCatalogListRegistered: true,
    catalogRevision: 9,
    catalogEntriesDigest: `sha256:${'5'.repeat(64)}`,
    catalogSource: admission.source,
    catalogFreshness: admission.freshness,
    catalogDegraded: admission.degraded,
    catalogDegradedReason: admission.degradedReason,
    browserExternalRequests: [],
    browserExternalWebSockets: [],
    browserConsoleFailures: [],
  }
}

function receiptInput() {
  return {
    previous,
    current,
    previousObservation: observation(previous),
    currentObservation: observation(current),
    official: {
      version: '0.1.1-rc.2',
      registry: 'https://registry.npmjs.org/',
      registryIntegrity: TARGET_DSH_REGISTRY_INTEGRITY,
      packageTreeDigestBefore: `sha256:${'6'.repeat(64)}`,
      packageTreeDigestAfter: `sha256:${'6'.repeat(64)}`,
    },
    profile: {
      profileId: 'web',
      sameProfile: true,
      officialCliUpdate: true,
      centerRootRetained: true,
      removalExactBaselineRestored: true,
    },
    ciAcceptance: {
      acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
      fileSha256: `sha256:${'7'.repeat(64)}`,
      receiptDigest: `sha256:${'8'.repeat(64)}`,
      runId: 77,
      runAttempt: 1,
      artifact: {
        version: current.version,
        sha256: current.sha256,
        sizeBytes: current.sizeBytes,
        manifestSha256: current.manifestSha256,
        pnpmTreeSha256: current.pnpmTreeSha256,
        sourceCommit: current.commit,
        attestationDigest: `sha256:${'9'.repeat(64)}`,
        actionsArtifactId: 88,
        actionsArchiveSha256: `sha256:${'a'.repeat(64)}`,
      },
    },
  }
}

function completeArguments() {
  return [
    '--previous', previous.source,
    '--previous-version', previous.version,
    '--previous-sha256', previous.sha256,
    '--previous-size', String(previous.sizeBytes),
    '--previous-commit', previous.commit,
    '--previous-manifest-sha256', previous.manifestSha256,
    '--current', current.source,
    '--current-version', current.version,
    '--current-sha256', current.sha256,
    '--current-size', String(current.sizeBytes),
    '--current-commit', current.commit,
    '--current-manifest-sha256', current.manifestSha256,
    '--ci-receipt', '/tmp/github-ci.json',
    '--ci-receipt-sha256', `sha256:${'7'.repeat(64)}`,
    '--receipt', '/tmp/runtime-release.json',
  ]
}

test('parses one complete same-Profile update coordinate set', () => {
  const parsed = parseRuntimeReleaseArguments(completeArguments())
  assert.equal(parsed.previous.version, previous.version)
  assert.equal(parsed.current.version, current.version)
  assert.equal(parsed.previous.sha256, previous.sha256)
  assert.equal(parsed.current.manifestSha256, current.manifestSha256)
  assert.equal(parsed.ciReceipt.path, '/tmp/github-ci.json')
  assert.equal(parsed.receiptPath, '/tmp/runtime-release.json')
})

test('rejects a non-canonical current version before external effects', () => {
  const arguments_ = completeArguments()
  arguments_[arguments_.indexOf('--current-version') + 1] = '0.1.0-rc.01'
  assert.throws(
    () => parseRuntimeReleaseArguments(arguments_),
    /non-canonical numeric prerelease identifier/u,
  )
})

test('emits the exact public-release runtime receipt schema', () => {
  const receipt = buildRuntimeAcceptanceReceipt(receiptInput())
  assert.deepEqual(validateRuntimeAcceptanceReceipt(receipt, previous, current), {
    acceptanceId: 'P0-CENTER-HOST-CLIENT-BOOT',
    previous: {
      version: previous.version,
      sha256: previous.sha256,
      manifestSha256: previous.manifestSha256,
      pnpmTreeSha256: previous.pnpmTreeSha256,
      sourceCommit: previous.commit,
    },
    current: {
      version: current.version,
      sha256: current.sha256,
      manifestSha256: current.manifestSha256,
      pnpmTreeSha256: current.pnpmTreeSha256,
      sourceCommit: current.commit,
    },
    ciPackAttestation: {
      acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
      fileSha256: `sha256:${'7'.repeat(64)}`,
      receiptDigest: `sha256:${'8'.repeat(64)}`,
      artifact: {
        version: current.version,
        sha256: current.sha256,
        sizeBytes: current.sizeBytes,
        manifestSha256: current.manifestSha256,
        pnpmTreeSha256: current.pnpmTreeSha256,
        sourceCommit: current.commit,
      },
    },
    officialDshPackageTreeUnchanged: true,
  })
  assert.equal(receipt.observations.profile.officialCliUpdate, true)
  assert.equal(receipt.observations.profile.centerRootRetained, true)
  assert.equal(receipt.ciPackAttestation.artifact.sha256, current.sha256)
  assert.equal(receipt.artifacts.current.sizeBytes, current.sizeBytes)
  assert.deepEqual(receipt.observations.current.browserExternalRequests, [])
})

test('rejects forged artifact and browser observations', () => {
  const forgedCoordinate = receiptInput()
  forgedCoordinate.currentObservation.manifestSha256 = `sha256:${'f'.repeat(64)}`
  assert.throws(
    () => buildRuntimeAcceptanceReceipt(forgedCoordinate),
    /did not bind its exact artifact/u,
  )

  const forgedNetwork = receiptInput()
  forgedNetwork.currentObservation.browserExternalRequests = ['https://example.invalid/secret']
  assert.throws(
    () => buildRuntimeAcceptanceReceipt(forgedNetwork),
    /browser network or console failure/u,
  )

  const forgedClient = receiptInput()
  forgedClient.currentObservation.clientEntryObserved = false
  assert.throws(
    () => buildRuntimeAcceptanceReceipt(forgedClient),
    /did not bind its exact artifact/u,
  )

  const forgedAdmission = receiptInput()
  forgedAdmission.currentObservation.catalogDegraded = false
  forgedAdmission.currentObservation.catalogDegradedReason = 'hidden catalog failure'
  assert.throws(
    () => buildRuntimeAcceptanceReceipt(forgedAdmission),
    /did not bind its exact artifact/u,
  )

  const forgedInstalledPnpm = receiptInput()
  forgedInstalledPnpm.currentObservation.installedPnpmTreeSha256 = `sha256:${'0'.repeat(64)}`
  assert.throws(
    () => buildRuntimeAcceptanceReceipt(forgedInstalledPnpm),
    /did not bind its exact artifact/u,
  )
})

test('rejects unrelated runs, modified official Host, and incomplete previous coordinates', () => {
  const unrelated = receiptInput()
  unrelated.profile.officialCliUpdate = false
  assert.throws(
    () => buildRuntimeAcceptanceReceipt(unrelated),
    /one exact official CLI install\/update\/remove path/u,
  )

  const changedHost = receiptInput()
  changedHost.official.packageTreeDigestAfter = `sha256:${'7'.repeat(64)}`
  assert.throws(
    () => buildRuntimeAcceptanceReceipt(changedHost),
    /immutable package tree observation is invalid/u,
  )

  const forgedCiPack = receiptInput()
  forgedCiPack.ciAcceptance.artifact.sha256 = `sha256:${'0'.repeat(64)}`
  assert.throws(
    () => buildRuntimeAcceptanceReceipt(forgedCiPack),
    /exact CI-attested deterministic pack/u,
  )

  const forgedCiPnpm = receiptInput()
  forgedCiPnpm.ciAcceptance.artifact.pnpmTreeSha256 = `sha256:${'0'.repeat(64)}`
  assert.throws(
    () => buildRuntimeAcceptanceReceipt(forgedCiPnpm),
    /exact CI-attested deterministic pack/u,
  )

  assert.throws(
    () => parseRuntimeReleaseArguments(completeArguments().filter((_, index) => ![10, 11].includes(index))),
    /previous artifact coordinates must be complete/u,
  )
})

test('supports current-only boot while rejecting an injected previous observation', () => {
  const input = receiptInput()
  input.previous = null
  input.previousObservation = null
  input.profile.officialCliUpdate = null
  input.profile.centerRootRetained = null
  const receipt = buildRuntimeAcceptanceReceipt(input)
  assert.equal(receipt.artifacts.previous, null)
  assert.doesNotThrow(() => validateRuntimeAcceptanceReceipt(receipt, null, current))

  input.previousObservation = observation(previous)
  assert.throws(
    () => buildRuntimeAcceptanceReceipt(input),
    /included a previous observation/u,
  )
})

test('uses one official Host and only official Plugin CLI Profile mutations', async () => {
  const source = await readFile(
    fileURLToPath(new URL('./verify-runtime-release.mjs', import.meta.url)),
    'utf8',
  )
  assert.equal(source.match(/await installOfficialDshHost\(/gu)?.length, 1)
  assert.match(source, /'plugin', '--profile', PROFILE_ID, 'install', '--offline', '--ignore-scripts'/u)
  assert.match(source, /'plugin', '--profile', PROFILE_ID, 'add', artifact\.source,/u)
  assert.match(source, /'plugin', '--profile', PROFILE_ID, 'remove', CENTER_PACKAGE,\n\s*\]/u)
  assert.doesNotMatch(source, /'remove', CENTER_PACKAGE, '--ignore-scripts'/u)
  assert.match(source, /profileRemovalSurfaceSha256: await profileRemovalSurfaceDigest\(profileRoot\)/u)
  assert.match(source, /await assertNoManagedResolutionLinks\(profileRoot, centerRoot, \[CENTER_PACKAGE\]\)/u)
  assert.match(source, /previousInstallation = await addCenter[\s\S]+currentInstallation = await addCenter/u)
  const installedProfileSource = source.slice(
    source.indexOf('async function installedProfile'),
    source.indexOf('async function addCenter'),
  )
  assert.match(installedProfileSource, /!dump\.stdout\.includes\('# == dsh-plugin-extension-center'\)/u)
  assert.doesNotMatch(installedProfileSource, /(?<!\.stdout)\bdump\.includes\(/u)
  assert.doesNotMatch(source, /\bwriteFile\([^)]*(?:profileRoot|profiles|dshHome)/su)
  assert.doesNotMatch(source, /\b(?:appendFile|truncate)\b/u)
})
