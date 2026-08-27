import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { TARGET_DSH_REGISTRY_INTEGRITY } from '../store-only/support.mjs'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../../lib/catalog-data.js'
import { TARGET_DSH_COMMIT } from './support.mjs'
import { canonicalSha256 } from './receipt-binding.mjs'
import { REQUIRED_FAULT_MATRIX_CASE_IDS } from './fault-matrix.mjs'
import { EXPECTED_PUBLIC_CATALOG, PUBLIC_CATALOG_URL } from '../release/verify-public-catalog.mjs'
import { REQUIRED_CI_JOBS } from '../release/verify-github-ci.mjs'
import {
  FAILED_ARTIFACT_ENTRIES,
  FAILED_JOB_NAME,
  FAILED_STEP_NAME,
} from '../release/assert-publication-incident.mjs'
import { assertReleaseReady, parseReleaseReadyArguments } from './assert-release-ready.mjs'

const TREE = `sha256:${'a'.repeat(64)}`
const RUNTIME_RECEIPT_SHA = `sha256:${'b'.repeat(64)}`
const BOOTSTRAP_ENTRIES = EXPECTED_PUBLIC_CATALOG.packagedBootstrapEntriesDigest
const PREVIOUS_BOOTSTRAP_ENTRIES = `sha256:${'0'.repeat(64)}`
const RECOVERY_RC1_COMMIT = '951c48cf7666991487eab9ef26d39f359b68cc20'
const RECOVERY_RC0_COMMIT = '882d3c3cc59b597bb24ee55025690f8c4447abd5'
const RECOVERY_FAILED_RUN_ID = 33103882901
const RECOVERY_PREVIOUS_RUN_ID = 33099069510
const RECOVERY_INCIDENT_RUN_ID = 33110000001
const CURRENT = Object.freeze({
  version: '0.1.0-rc.1',
  sha256: `sha256:${'c'.repeat(64)}`,
  sizeBytes: 1234,
  manifestSha256: `sha256:${'d'.repeat(64)}`,
  pnpmTreeSha256: `sha256:${'5'.repeat(64)}`,
  sourceCommit: 'e'.repeat(40),
})
const PREVIOUS = Object.freeze({
  version: '0.1.0-rc.0',
  sha256: `sha256:${'f'.repeat(64)}`,
  sizeBytes: 1200,
  manifestSha256: `sha256:${'1'.repeat(64)}`,
  pnpmTreeSha256: `sha256:${'6'.repeat(64)}`,
  sourceCommit: '2'.repeat(40),
})
const VERIFIER = Object.freeze({
  ...CURRENT,
  sha256: `sha256:${'7'.repeat(64)}`,
  manifestSha256: `sha256:${'8'.repeat(64)}`,
  pnpmTreeSha256: `sha256:${'9'.repeat(64)}`,
  sourceCommit: 'a'.repeat(40),
})

function verifierIdentity(target, verifier, runId) {
  return {
    repository: 'striveh/dsh-plugin-extension-center',
    workflowPath: '.github/workflows/post-publication-evidence.yml',
    ref: 'refs/heads/main',
    refProtected: true,
    commit: verifier.sourceCommit,
    runId,
    runAttempt: 1,
    mode: verifier.sourceCommit === target.sourceCommit ? 'same-commit' : 'rc0-backfill',
  }
}

function releasePayload(artifact) {
  return [
    {
      name: `dsh-plugin-extension-center-${artifact.version}.tgz`,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    },
    { name: 'SHA256SUMS', sizeBytes: 96, sha256: `sha256:${artifact.sourceCommit[0].repeat(64)}` },
    { name: 'pack-attestation.json', sizeBytes: 900, sha256: artifact.manifestSha256 },
  ]
}

function officialTarget(after = false) {
  return {
    dshPackage: '@deepseek-ai/dsh@0.1.1-rc.2',
    auditedSourceCommit: TARGET_DSH_COMMIT,
    registry: 'https://registry.npmjs.org/',
    registryIntegrity: TARGET_DSH_REGISTRY_INTEGRITY,
    ...(after
      ? { packageTreeDigestBefore: TREE, packageTreeDigestAfter: TREE }
      : { packageTreeDigest: TREE }),
  }
}

function releaseArtifact(artifact) {
  const payload = releasePayload(artifact)
  const tag = `v${artifact.version}`
  return {
    sourceKind: 'github-release',
    publicUrl: `https://github.com/striveh/dsh-plugin-extension-center/releases/download/v${artifact.version}/dsh-plugin-extension-center-${artifact.version}.tgz`,
    finalHost: 'release-assets.githubusercontent.com',
    redirects: 1,
    ...artifact,
    sha512: `sha512-${Buffer.alloc(64).toString('base64')}`,
    release: {
      releaseId: 10,
      tag,
      sourceCommit: artifact.sourceCommit,
      targetCommitish: artifact.sourceCommit,
      prerelease: artifact.version.includes('-'),
      publishedAt: '2026-08-27T00:00:00.000Z',
      assets: payload.map((asset, index) => ({
        id: 11 + index,
        ...asset,
        publicUrl: `https://github.com/striveh/dsh-plugin-extension-center/releases/download/${tag}/${asset.name}`,
        updatedAt: '2026-08-27T00:00:00.000Z',
      })),
    },
    releasePayload: payload.map(asset => ({
      ...asset,
      publicUrl: `https://github.com/striveh/dsh-plugin-extension-center/releases/download/${tag}/${asset.name}`,
      finalHost: 'release-assets.githubusercontent.com',
      redirects: 1,
    })),
    immutableRelease: {
      repository: 'striveh/dsh-plugin-extension-center',
      tag,
      releaseId: 10,
      ghVersion: '2.88.1',
      bundleSha256: `sha256:${'6'.repeat(64)}`,
      statementSha256: `sha256:${'7'.repeat(64)}`,
      releaseVerificationResultSha256: `sha256:${'8'.repeat(64)}`,
      tagRefSha1: artifact.sourceCommit,
      assets: payload.map(asset => ({
        ...asset,
        verificationResultSha256: `sha256:${'a'.repeat(64)}`,
      })),
    },
    packed: {
      manifestSha256: artifact.manifestSha256,
      entryCount: 100,
      payloadTreeSha256: `sha256:${'3'.repeat(64)}`,
      patchSha256: `sha256:${'4'.repeat(64)}`,
      bundledPnpmTreeSha256: artifact.pnpmTreeSha256,
    },
  }
}

function releaseReadyArtifact(artifact) {
  const released = releaseArtifact(artifact)
  return {
    version: artifact.version,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    manifestSha256: artifact.manifestSha256,
    pnpmTreeSha256: artifact.pnpmTreeSha256,
    sourceCommit: artifact.sourceCommit,
    releaseId: released.release.releaseId,
    releasePayload: released.releasePayload.map(({ name, sizeBytes, sha256 }) => ({ name, sizeBytes, sha256 })),
    immutableRelease: {
      bundleSha256: released.immutableRelease.bundleSha256,
      statementSha256: released.immutableRelease.statementSha256,
      tagRefSha1: released.immutableRelease.tagRefSha1,
    },
  }
}

function previousReleaseReadyReceipt(artifact = PREVIOUS, verifier = artifact, runId = 99) {
  const ci = githubCiReceipt(artifact)
  const verifierCi = githubCiReceipt(verifier)
  const body = {
    schemaVersion: 2,
    acceptanceId: 'P0-EXTENSION-CENTER-RELEASE-READY',
    status: 'passed',
    p0Status: 'rc0-bootstrap-release-ready',
    releaseStage: 'bootstrap-rc0',
    generatedAt: '2026-08-27T00:05:00.000Z',
    verifier: verifierIdentity(artifact, verifier, runId),
    target: {
      repository: 'striveh/dsh-plugin-extension-center',
      sourceCommit: artifact.sourceCommit,
      version: artifact.version,
      officialDsh: officialTarget(),
    },
    artifacts: { previous: null, current: releaseReadyArtifact(artifact) },
    catalog: {
      bootstrap: {
        revision: EXPECTED_PUBLIC_CATALOG.previousRevision - 1,
        previousRevisionDigest: null,
        entriesDigest: PREVIOUS_BOOTSTRAP_ENTRIES,
        envelopeDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapPreviousRevisionDigest,
        rootDigest: `sha256:${'1'.repeat(64)}`,
        signatureSetDigest: `sha256:${'2'.repeat(64)}`,
      },
      deployment: {
        url: PUBLIC_CATALOG_URL,
        revision: EXPECTED_PUBLIC_CATALOG.previousRevision,
        previousRevisionDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapPreviousRevisionDigest,
        entriesDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapEntriesDigest,
        envelopeDigest: EXPECTED_PUBLIC_CATALOG.previousRevisionDigest,
        signatureSetDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapSignatureSetDigest,
        documentDigest: `sha256:${'3'.repeat(64)}`,
        bytesSha256: `sha256:${'4'.repeat(64)}`,
        sizeBytes: 2048,
      },
    },
    evidence: {
      fullP0: {
        acceptanceId: 'P0-RC2-001-OFFICIAL-HOST-EXTENSION-LIFECYCLES',
        sha256: `sha256:${'9'.repeat(64)}`,
        faultMatrix: { platform: 'linux', arch: 'x64', caseCount: REQUIRED_FAULT_MATRIX_CASE_IDS.length },
      },
      runtimeRelease: {
        acceptanceId: 'P0-CENTER-HOST-CLIENT-BOOT',
        sha256: RUNTIME_RECEIPT_SHA,
      },
      publicRelease: {
        acceptanceId: 'P0-CENTER-PUBLIC-RELEASE-OFFICIAL-CLI-LIFECYCLE',
        sha256: `sha256:${'a'.repeat(64)}`,
      },
      publicCatalog: {
        acceptanceId: 'P0-PUBLIC-CATALOG-DEPLOYMENT',
        sha256: `sha256:${'b'.repeat(64)}`,
        receiptDigest: `sha256:${'3'.repeat(64)}`,
      },
      catalogSources: {
        acceptanceId: 'P0-CATALOG-SOURCE-FRESHNESS',
        sha256: `sha256:${'d'.repeat(64)}`,
        receiptDigest: `sha256:${'4'.repeat(64)}`,
        observedAt: '2026-08-27T00:00:00.000Z',
        entryCount: BOOTSTRAP_CATALOG_ENVELOPE.entries.length,
      },
      githubCi: {
        acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
        sha256: `sha256:${'6'.repeat(64)}`,
        receiptDigest: ci.receiptDigest,
        runId: ci.run.id,
      },
      verifierGithubCi: {
        acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
        sha256: `sha256:${'5'.repeat(64)}`,
        receiptDigest: verifierCi.receiptDigest,
        commit: verifierCi.target.commit,
        runId: verifierCi.run.id,
        runAttempt: verifierCi.run.attempt,
      },
      previousGithubCi: null,
      previousReleaseReady: null,
    },
    claims: {
      independentPluginOnly: true,
      officialDshPackageTreeUnchanged: true,
      fullPluginMcpSkillLifecycle: true,
      hostClientRpcBoot: true,
      publicInstallRemove: true,
      publicPreviousToCurrentUpdate: false,
      signedPublicCatalogRefresh: true,
      signedCatalogPreviousToCurrentUpdate: false,
      exactCatalogSourceFreshness: true,
      exactCommitCrossPlatformCi: true,
      exactImmutableReleaseAndAssets: true,
      centerOwnedJournalFaultMatrix: true,
    },
    compatibilitySmokes: { liveProvider: { status: 'not-run', blocking: false, reason: 'advisory' } },
    notProven: [
      'public-previous-to-current-update',
      'signed-catalog-previous-to-current-update',
      'catalog-third-party-code-safety',
      'catalog-human-authority-review-independent-reexecution',
      'catalog-future-source-availability-or-status',
    ],
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function updateReleaseReadyReceipt(previous, current) {
  const receipt = previousReleaseReadyReceipt(current)
  receipt.schemaVersion = 3
  receipt.p0Status = 'p0-release-ready'
  receipt.releaseStage = current.version === '0.1.0'
    ? 'stable'
    : current.version === '0.1.0-rc.2'
      ? 'recovery-rc'
      : 'update-rc'
  receipt.artifacts.previous = releaseReadyArtifact(previous)
  receipt.evidence.previousGithubCi = {
    acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
    sha256: `sha256:${'1'.repeat(64)}`,
    receiptDigest: `sha256:${'2'.repeat(64)}`,
    runId: 41,
  }
  receipt.evidence.previousReleaseReady = {
    acceptanceId: 'P0-EXTENSION-CENTER-RELEASE-READY',
    sha256: `sha256:${'3'.repeat(64)}`,
    receiptDigest: `sha256:${'4'.repeat(64)}`,
    runId: 40,
  }
  receipt.evidence.publicationIncident = current.version === '0.1.0-rc.2'
    ? {
      acceptanceId: 'P0-EXTENSION-CENTER-PUBLICATION-INCIDENT',
      sha256: `sha256:${'8'.repeat(64)}`,
      receiptDigest: `sha256:${'9'.repeat(64)}`,
      runId: RECOVERY_INCIDENT_RUN_ID,
      runAttempt: 1,
      failedRunId: RECOVERY_FAILED_RUN_ID,
      failedRunAttempt: 1,
      targetCommit: RECOVERY_RC1_COMMIT,
      targetVersion: '0.1.0-rc.1',
      verifierCommit: current.sourceCommit,
      verifierGithubCiSha256: `sha256:${'a'.repeat(64)}`,
      verifierGithubCiReceiptDigest: `sha256:${'b'.repeat(64)}`,
      verifierGithubCiRunId: 42,
      verifierGithubCiRunAttempt: 1,
    }
    : null
  receipt.claims.publicPreviousToCurrentUpdate = true
  receipt.claims.signedCatalogPreviousToCurrentUpdate = true
  receipt.notProven = receipt.notProven.slice(2)
  const { receiptDigest: _oldDigest, ...body } = receipt
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function runtimeArtifact(artifact) {
  return { ...artifact, filename: `${artifact.version}.tgz`, hostBoot: true, clientBoot: true, rpcRegistration: true }
}

function boundArtifact(artifact) {
  return {
    version: artifact.version,
    sha256: artifact.sha256,
    manifestSha256: artifact.manifestSha256,
    pnpmTreeSha256: artifact.pnpmTreeSha256,
    sourceCommit: artifact.sourceCommit,
  }
}

function fullReceipt(current = CURRENT) {
  return {
    schemaVersion: 1,
    acceptanceId: 'P0-RC2-001-OFFICIAL-HOST-EXTENSION-LIFECYCLES',
    proofScope: 'packed-extension-unmodified-official-rc2-host-rpc-plugin-mcp-skill-lifecycles',
    status: 'passed',
    p0Status: 'official-rc2-lifecycle-proven',
    releaseClaim: 'official-dsh-rc2-compatible',
    target: { ...officialTarget(), version: '0.1.1-rc.2', os: process.platform, arch: process.arch },
    inputs: {
      isolatedHomesCreatedEmpty: true,
      credentialVariablesPassed: false,
      providerEndpointOverridePassed: false,
      telemetryModeRequested: 'DISABLED',
      packedArtifactInstalledByOfficialPluginCli: true,
      exactMcpRuntimePreprovisioned: true,
      keylessOfficialReplayBundleInstalled: true,
      keylessOfficialReplayBundleRemoved: true,
      officialCliRemovalProven: true,
      distinctCenterArtifactUpdateProven: false,
      breakGlassRecoveryProven: true,
    },
    artifact: {
      filename: `dsh-plugin-extension-center-${current.version}.tgz`,
      bytes: current.sizeBytes,
      digest: current.sha256,
      version: current.version,
    },
    observations: {
      bundleLayerObserved: true,
      catalogRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
      catalogEntriesDigest: BOOTSTRAP_ENTRIES,
      browserLifecycleRpcMethods: ['catalog/list', 'plan/decide', 'lifecycle/request'],
      browserStoreLifecycleRpcMethods: ['catalog/list', 'intent/preview', 'plan/decide', 'lifecycle/request'],
      terminalReceiptDigests: [`sha256:${'6'.repeat(64)}`],
      terminalJournalHeadDigests: [`sha256:${'7'.repeat(64)}`],
      materialUnchangedBeforeApproval: true,
      storeMaterialUnchangedBeforeApproval: true,
      officialDshPackageTreeUnchanged: true,
      profileRemovalBaselineDigest: `sha256:${'8'.repeat(64)}`,
      profileRemovalFinalDigest: `sha256:${'8'.repeat(64)}`,
      centerAndChildResolutionLinksAbsent: true,
      controlledAba: {},
      breakGlassRecovery: {},
      faultMatrix: {
        schemaVersion: 1,
        proofScope: 'packed-center-owned-skill-journal-faults',
        artifactDigest: current.sha256,
        platform: process.platform,
        arch: process.arch,
        cases: REQUIRED_FAULT_MATRIX_CASE_IDS.map(id => ({
          id,
          status: 'passed',
          extensionKind: 'skill',
          observation: id === 'enospc/journal-event-before-write'
            ? 'no-journal-head-published'
            : id === 'partial-current/rejected'
              ? 'journal-corrupt-fail-closed'
              : 'event-ahead-of-current-repaired-by-new-process',
        })),
      },
    },
    notProven: [
      'published-extension-center-release-installation',
      'center-update-with-distinct-artifact-version-and-digest',
      'update-with-distinct-signed-catalog-revision',
      'cross-platform-matrix',
    ],
    compatibilitySmokes: {
      liveProvider: { status: 'not-run', blocking: false, reason: 'advisory' },
    },
  }
}

function runtimeReceipt(previous = PREVIOUS, current = CURRENT) {
  return {
    schemaVersion: 2,
    acceptanceId: 'P0-CENTER-HOST-CLIENT-BOOT',
    status: 'passed',
    profileId: 'web',
    target: officialTarget(),
    officialDshPackageTreeUnchanged: true,
    artifacts: { previous: previous === null ? null : runtimeArtifact(previous), current: runtimeArtifact(current) },
    ciPackAttestation: {
      acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
      fileSha256: `sha256:${'c'.repeat(64)}`,
      receiptDigest: null,
      runId: 42,
      runAttempt: 1,
      artifact: {
        ...current,
        attestationDigest: `sha256:${'d'.repeat(64)}`,
        actionsArtifactId: 77,
        actionsArchiveSha256: `sha256:${'e'.repeat(64)}`,
        releaseAssets: releasePayload(current),
      },
    },
    observations: {
      keyless: true,
      telemetryDisabled: true,
      profile: {
        profileId: 'web',
        sameProfile: true,
        officialCliUpdate: previous === null ? null : true,
        centerRootRetained: previous === null ? null : true,
        removalExactBaselineRestored: true,
      },
      previous: previous === null ? null : {
        installedPnpmTreeSha256: previous.pnpmTreeSha256,
        catalogRevision: EXPECTED_PUBLIC_CATALOG.previousRevision - 1,
        catalogEntriesDigest: PREVIOUS_BOOTSTRAP_ENTRIES,
        catalogSource: 'bootstrap',
        catalogFreshness: 'bootstrap',
        catalogDegraded: true,
        catalogDegradedReason: 'catalog revision chain contains a gap',
        browserExternalRequests: [],
        browserExternalWebSockets: [],
        browserConsoleFailures: [],
      },
      current: {
        installedPnpmTreeSha256: current.pnpmTreeSha256,
        catalogRevision: EXPECTED_PUBLIC_CATALOG.revision,
        catalogEntriesDigest: EXPECTED_PUBLIC_CATALOG.entriesDigest,
        catalogSource: 'remote',
        catalogFreshness: 'fresh',
        catalogDegraded: false,
        catalogDegradedReason: null,
        browserExternalRequests: [],
        browserExternalWebSockets: [],
        browserConsoleFailures: [],
      },
    },
  }
}

function publicReceipt(previous = PREVIOUS, current = CURRENT) {
  const update = previous !== null
  return {
    schemaVersion: 4,
    acceptanceId: 'P0-CENTER-PUBLIC-RELEASE-OFFICIAL-CLI-LIFECYCLE',
    status: 'passed',
    p0Status: update ? 'public-update-install-remove-proven' : 'public-install-remove-proven',
    target: officialTarget(true),
    inputs: {
      previous: previous === null ? null : releaseArtifact(previous),
      current: releaseArtifact(current),
      runtimeAcceptance: {
        acceptanceId: 'P0-CENTER-HOST-CLIENT-BOOT',
        sha256: RUNTIME_RECEIPT_SHA,
        previous: previous === null ? null : boundArtifact(previous),
        current: boundArtifact(current),
        officialDshPackageTreeUnchanged: true,
      },
      ciPackAttestation: {
        acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
        fileSha256: `sha256:${'c'.repeat(64)}`,
        receiptDigest: null,
        runId: 42,
        runAttempt: 1,
        artifact: {
          ...current,
          attestationDigest: `sha256:${'d'.repeat(64)}`,
          actionsArtifactId: 77,
          actionsArchiveSha256: `sha256:${'e'.repeat(64)}`,
          releaseAssets: releasePayload(current),
        },
      },
      previousCiPackAttestation: previous === null ? null : {
        acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
        fileSha256: `sha256:${'6'.repeat(64)}`,
        receiptDigest: null,
        runId: 42,
        runAttempt: 1,
        artifact: {
          ...previous,
          attestationDigest: `sha256:${'d'.repeat(64)}`,
          actionsArtifactId: 77,
          actionsArchiveSha256: `sha256:${'e'.repeat(64)}`,
          releaseAssets: releasePayload(previous),
        },
      },
      keyless: true,
      telemetryDisabled: true,
    },
    observations: {
      ascendingDistinctReleaseUpdate: update,
      previousInstall: previous === null ? null : {
        bundledPnpmTreeSha256: previous.pnpmTreeSha256,
      },
      currentInstall: {
        bundledPnpmTreeSha256: current.pnpmTreeSha256,
      },
      removal: { exactBaselineRestored: true },
      officialDshPackageTreeUnchanged: true,
      runtimeAcceptanceRequiredAndBound: true,
    },
    notProven: [
      'host-client-runtime-directly-observed-by-this-release-runner',
      ...(!update ? ['center-update-from-older-distinct-release'] : []),
    ],
  }
}

function publicCatalogReceipt() {
  const body = {
    schemaVersion: 2,
    acceptanceId: 'P0-PUBLIC-CATALOG-DEPLOYMENT',
    status: 'passed',
    p0Status: 'public-catalog-deployment-proven',
    observedAt: '2026-08-27T00:00:00.000Z',
    target: {
      url: PUBLIC_CATALOG_URL,
      redirectPolicy: 'forbidden',
      expectedContentType: 'application/json',
      expectedRevision: EXPECTED_PUBLIC_CATALOG.revision,
      expectedSizeBytes: EXPECTED_PUBLIC_CATALOG.sizeBytes,
      expectedBytesSha256: EXPECTED_PUBLIC_CATALOG.bytesSha256,
      expectedEnvelopeDigest: EXPECTED_PUBLIC_CATALOG.envelopeDigest,
    },
    packagedBootstrap: {
      revision: EXPECTED_PUBLIC_CATALOG.previousRevision,
      previousRevisionDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapPreviousRevisionDigest,
      entriesDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapEntriesDigest,
      envelopeDigest: EXPECTED_PUBLIC_CATALOG.previousRevisionDigest,
      rootDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapRootDigest,
      signatureSetDigest: EXPECTED_PUBLIC_CATALOG.packagedBootstrapSignatureSetDigest,
    },
    deployment: {
      httpStatus: 200,
      finalUrl: PUBLIC_CATALOG_URL,
      redirected: false,
      contentType: 'application/json',
      sizeBytes: EXPECTED_PUBLIC_CATALOG.sizeBytes,
      bytesSha256: EXPECTED_PUBLIC_CATALOG.bytesSha256,
      canonicalOneLine: true,
      documentDigest: EXPECTED_PUBLIC_CATALOG.documentDigest,
      envelopeDigest: EXPECTED_PUBLIC_CATALOG.envelopeDigest,
      signatureSetDigest: EXPECTED_PUBLIC_CATALOG.signatureSetDigest,
      revision: EXPECTED_PUBLIC_CATALOG.revision,
      previousRevisionDigest: EXPECTED_PUBLIC_CATALOG.previousRevisionDigest,
      entriesDigest: EXPECTED_PUBLIC_CATALOG.entriesDigest,
      keyIds: ['bootstrap-2026-08-26-8'],
    },
    runtimeRefresh: {
      source: 'remote',
      freshness: 'fresh',
      degraded: false,
      revision: EXPECTED_PUBLIC_CATALOG.revision,
      entriesDigest: EXPECTED_PUBLIC_CATALOG.entriesDigest,
    },
    notProven: [],
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function catalogSourceReceipt() {
  const entries = BOOTSTRAP_CATALOG_ENVELOPE.entries.map((entry, index) => ({
    candidateRef: entry.candidateRef,
    kind: entry.kind,
    entryDigest: canonicalSha256(entry),
    source: {
      sourceType: entry.source.type,
      endpoint: entry.source.type === 'mcp-registry'
        ? `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(entry.name)}/versions/${encodeURIComponent(entry.artifact.version)}`
        : entry.source.type === 'github-release'
          ? `https://api.github.com/repos/${new URL(entry.source.upstreamUrl).pathname.slice(1)}/git/ref/tags/${encodeURIComponent(`v${entry.artifact.version}`)}`
          : `https://api.github.com/repos/${new URL(entry.source.upstreamUrl).pathname.slice(1)}/git/commits/${entry.source.revision}`,
      ...(entry.source.type === 'mcp-registry'
        ? { packageRegistryEndpoint: `https://registry.npmjs.org/${encodeURIComponent(entry.artifact.id)}/${encodeURIComponent(entry.artifact.version)}` }
        : {}),
      resolvedRevision: entry.source.revision,
    },
    artifact: {
      sizeBytes: entry.artifact.sizeBytes,
      integrity: entry.artifact.integrity,
      sha256: entry.artifact.integrity.startsWith('sha256:')
        ? entry.artifact.integrity
        : `sha256:${String(index + 1).repeat(64)}`,
      redirectCount: 0,
      initialUrl: entry.artifact.acquisitionUrl,
      finalUrl: entry.artifact.acquisitionUrl,
      finalOrigin: new URL(entry.artifact.acquisitionUrl).origin,
    },
  }))
  const body = {
    schemaVersion: 2,
    acceptanceId: 'P0-CATALOG-SOURCE-FRESHNESS',
    status: 'passed',
    p0Status: 'exact-signed-catalog-source-observations-proven',
    observedAt: '2026-08-27T00:00:00.000Z',
    catalog: {
      revision: EXPECTED_PUBLIC_CATALOG.revision,
      entriesDigest: EXPECTED_PUBLIC_CATALOG.entriesDigest,
      documentDigest: EXPECTED_PUBLIC_CATALOG.documentDigest,
      bytesSha256: EXPECTED_PUBLIC_CATALOG.bytesSha256,
    },
    entries,
    notProven: [
      'third-party-code-safety',
      'human-authority-review-independent-reexecution',
      'future-source-availability-or-status',
    ],
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function githubCiReceipt(current = CURRENT) {
  const requiredJobs = Object.fromEntries(REQUIRED_CI_JOBS.map((requirement, index) => [
    requirement.key,
    { id: index + 1, name: requirement.name, status: 'completed', conclusion: 'success' },
  ]))
  const body = {
    schemaVersion: 1,
    acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
    status: 'passed',
    p0Status: 'exact-commit-ci-proven',
    observedAt: '2026-08-27T00:00:00.000Z',
    target: {
      repository: 'striveh/dsh-plugin-extension-center',
      branch: 'main',
      workflowPath: '.github/workflows/ci.yml',
      commit: current.sourceCommit,
    },
    run: { id: 42, attempt: 1, event: 'push', headBranch: 'main', headSha: current.sourceCommit, status: 'completed', conclusion: 'success' },
    requiredJobs,
    packAttestation: {
      actionsArtifactId: 77,
      actionsArtifactName: `release-candidate-${current.sourceCommit}-attempt-1`,
      actionsArchiveSha256: `sha256:${'e'.repeat(64)}`,
      attestationDigest: `sha256:${'d'.repeat(64)}`,
      ...current,
      filename: `dsh-plugin-extension-center-${current.version}.tgz`,
      sourceManifestSha256: `sha256:${'f'.repeat(64)}`,
      pnpmTreeSha256: current.pnpmTreeSha256,
      releaseAssets: releasePayload(current),
    },
    notProven: [],
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function receiptFileSha256(receipt) {
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function publicationIncidentReceipt({
  current,
  previous,
  previousGithubCi,
  previousReleaseReady,
  verifierGithubCi,
  verifierGithubCiSha256,
}) {
  const repository = 'striveh/dsh-plugin-extension-center'
  const failedArtifact = {
    ...CURRENT,
    version: '0.1.0-rc.1',
    sourceCommit: RECOVERY_RC1_COMMIT,
  }
  const failedPayload = releasePayload(failedArtifact)
  const failedRunUrl = `https://github.com/${repository}/actions/runs/${String(RECOVERY_FAILED_RUN_ID)}`
  const previousRunUrl = `https://github.com/${repository}/actions/runs/${String(RECOVERY_PREVIOUS_RUN_ID)}`
  const failedCurrentCoordinate = {
    fileSha256: `sha256:${'c'.repeat(64)}`,
    receiptDigest: `sha256:${'d'.repeat(64)}`,
    commit: RECOVERY_RC1_COMMIT,
    version: '0.1.0-rc.1',
    ciRunId: 33102419745,
    ciRunAttempt: 1,
  }
  const body = {
    schemaVersion: 1,
    acceptanceId: 'P0-EXTENSION-CENTER-PUBLICATION-INCIDENT',
    status: 'failed',
    p0Status: 'not-release-ready',
    observedAt: '2026-08-27T19:00:00.000Z',
    target: {
      repository,
      sourceCommit: RECOVERY_RC1_COMMIT,
      version: '0.1.0-rc.1',
      release: {
        id: 378036901,
        version: '0.1.0-rc.1',
        tag: 'v0.1.0-rc.1',
        tagCommit: RECOVERY_RC1_COMMIT,
        immutable: true,
        prerelease: true,
        htmlUrl: `https://github.com/${repository}/releases/tag/v0.1.0-rc.1`,
        createdAt: '2026-08-27T18:13:43.000Z',
        publishedAt: '2026-08-27T18:28:51.000Z',
        assets: failedPayload.map((asset, index) => ({
          id: 500 + index,
          ...asset,
          publicUrl: `https://github.com/${repository}/releases/download/v0.1.0-rc.1/${asset.name}`,
        })),
      },
    },
    verifier: {
      repository,
      workflowPath: '.github/workflows/publication-incident-evidence.yml',
      ref: 'refs/heads/main',
      refProtected: true,
      commit: current.sourceCommit,
      runId: RECOVERY_INCIDENT_RUN_ID,
      runAttempt: 1,
      githubCi: {
        acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
        fileSha256: verifierGithubCiSha256,
        receiptDigest: verifierGithubCi.receiptDigest,
        runId: verifierGithubCi.run.id,
        runAttempt: verifierGithubCi.run.attempt,
      },
    },
    failure: {
      classification: 'runtime-release-verification-failed',
      run: {
        id: RECOVERY_FAILED_RUN_ID,
        attempt: 1,
        runNumber: 18,
        workflowPath: '.github/workflows/post-publication-evidence.yml',
        event: 'workflow_dispatch',
        headBranch: 'main',
        headSha: RECOVERY_RC1_COMMIT,
        status: 'completed',
        conclusion: 'failure',
        htmlUrl: failedRunUrl,
        createdAt: '2026-08-27T18:31:21.000Z',
        updatedAt: '2026-08-27T18:33:21.000Z',
      },
      job: {
        id: 98628458057,
        name: FAILED_JOB_NAME,
        status: 'completed',
        conclusion: 'failure',
        startedAt: '2026-08-27T18:31:25.000Z',
        completedAt: '2026-08-27T18:33:21.000Z',
        htmlUrl: `${failedRunUrl}/job/98628458057`,
        failedStep: {
          number: 15,
          name: FAILED_STEP_NAME,
          status: 'completed',
          conclusion: 'failure',
          startedAt: '2026-08-27T18:32:00.000Z',
          completedAt: '2026-08-27T18:32:01.000Z',
        },
        releaseReadyCompositeStep: {
          number: 20,
          name: 'Compose one cross-bound release-ready receipt',
          status: 'completed',
          conclusion: 'skipped',
        },
      },
      artifact: {
        id: 9659675180,
        name: `post-publication-evidence-${RECOVERY_RC1_COMMIT}-1`,
        archiveSizeBytes: 4096,
        archiveSha256: `sha256:${'e'.repeat(64)}`,
        entries: [...FAILED_ARTIFACT_ENTRIES],
        receipts: {
          current: failedCurrentCoordinate,
          previous: {
            fileSha256: `sha256:${'6'.repeat(64)}`,
            receiptDigest: previousGithubCi.receiptDigest,
            commit: previous.sourceCommit,
            version: previous.version,
            ciRunId: previousGithubCi.run.id,
            ciRunAttempt: previousGithubCi.run.attempt,
          },
          verifier: { ...failedCurrentCoordinate },
        },
      },
      releaseReadyReceiptPresent: false,
      releaseReadyCompositeConclusion: 'skipped',
    },
    previousSuccessfulPublication: {
      targetCommit: previous.sourceCommit,
      run: {
        id: RECOVERY_PREVIOUS_RUN_ID,
        attempt: 1,
        runNumber: 17,
        workflowPath: '.github/workflows/post-publication-evidence.yml',
        event: 'workflow_dispatch',
        headBranch: 'main',
        headSha: previousReleaseReady.verifier.commit,
        status: 'completed',
        conclusion: 'success',
        htmlUrl: previousRunUrl,
        createdAt: '2026-08-27T17:34:09.000Z',
        updatedAt: '2026-08-27T17:36:15.000Z',
      },
      artifact: {
        id: 9650000000,
        name: `post-publication-evidence-${previous.sourceCommit}-1`,
        archiveSizeBytes: 8192,
        archiveSha256: `sha256:${'f'.repeat(64)}`,
      },
      releaseReadyReceipt: {
        acceptanceId: 'P0-EXTENSION-CENTER-RELEASE-READY',
        p0Status: previousReleaseReady.p0Status,
        fileSha256: `sha256:${'7'.repeat(64)}`,
        receiptDigest: previousReleaseReady.receiptDigest,
        targetVersion: previous.version,
        verifierCommit: previousReleaseReady.verifier.commit,
      },
    },
    releaseReadyAcceptanceId: null,
    notProven: [
      'release-readiness',
      'root-cause-from-actions-metadata',
      'successful-update-runtime-verification',
    ],
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function evidence(previous = PREVIOUS, current = CURRENT, verifier = current, previousVerifier = previous) {
  const recovery = current.version === '0.1.0-rc.2'
  const runtimeRelease = runtimeReceipt(previous, current)
  const publicRelease = publicReceipt(previous, current)
  const githubCi = githubCiReceipt(current)
  const verifierGithubCi = githubCiReceipt(verifier)
  const previousGithubCi = previous === null ? null : githubCiReceipt(previous)
  const previousVerifierGithubCi = previous === null ? null : githubCiReceipt(previousVerifier)
  const previousReleaseReady = previous === null
    ? null
    : previousReleaseReadyReceipt(
      previous,
      previousVerifier,
      recovery ? RECOVERY_PREVIOUS_RUN_ID : 99,
    )
  const publicationIncidentVerifierGithubCi = recovery ? githubCiReceipt(current) : null
  const publicationIncidentVerifierGithubCiSha256 = publicationIncidentVerifierGithubCi === null
    ? null
    : receiptFileSha256(publicationIncidentVerifierGithubCi)
  const publicationIncident = recovery
    ? publicationIncidentReceipt({
      current,
      previous,
      previousGithubCi,
      previousReleaseReady,
      verifierGithubCi: publicationIncidentVerifierGithubCi,
      verifierGithubCiSha256: publicationIncidentVerifierGithubCiSha256,
    })
    : null
  runtimeRelease.ciPackAttestation.receiptDigest = githubCi.receiptDigest
  publicRelease.inputs.ciPackAttestation.receiptDigest = githubCi.receiptDigest
  if (previousGithubCi !== null) {
    publicRelease.inputs.previousCiPackAttestation.receiptDigest = previousGithubCi.receiptDigest
  }
  return {
    fullP0: fullReceipt(current),
    runtimeRelease,
    publicRelease,
    publicCatalog: publicCatalogReceipt(),
    catalogSources: catalogSourceReceipt(),
    githubCi,
    verifierGithubCi,
    verifier: verifierIdentity(current, verifier, 314),
    previousGithubCi,
    previousVerifierGithubCi,
    previousReleaseReady,
    previousEvidenceRunId: previous === null
      ? null
      : recovery ? RECOVERY_PREVIOUS_RUN_ID : 99,
    publicationIncident,
    publicationIncidentVerifierGithubCi,
    publicationIncidentRunId: recovery ? RECOVERY_INCIDENT_RUN_ID : null,
    receiptDigests: {
      fullP0: `sha256:${'9'.repeat(64)}`,
      runtimeRelease: RUNTIME_RECEIPT_SHA,
      publicRelease: `sha256:${'a'.repeat(64)}`,
      publicCatalog: `sha256:${'b'.repeat(64)}`,
      catalogSources: `sha256:${'d'.repeat(64)}`,
      githubCi: `sha256:${'c'.repeat(64)}`,
      verifierGithubCi: `sha256:${'5'.repeat(64)}`,
      previousGithubCi: previousGithubCi === null ? null : `sha256:${'6'.repeat(64)}`,
      previousVerifierGithubCi: previousVerifierGithubCi === null ? null : `sha256:${'5'.repeat(64)}`,
      previousReleaseReady: previousReleaseReady === null ? null : `sha256:${'7'.repeat(64)}`,
      publicationIncident: publicationIncident === null ? null : receiptFileSha256(publicationIncident),
      publicationIncidentVerifierGithubCi: publicationIncidentVerifierGithubCiSha256,
    },
    generatedAt: '2026-08-27T00:10:00.000Z',
  }
}

test('aggregates rc.1 update evidence into one exact-commit P0 release receipt', () => {
  const receipt = assertReleaseReady(evidence())
  assert.equal(receipt.p0Status, 'p0-release-ready')
  assert.equal(receipt.releaseStage, 'update-rc')
  assert.equal(receipt.target.sourceCommit, CURRENT.sourceCommit)
  assert.deepEqual(receipt.verifier, verifierIdentity(CURRENT, CURRENT, 314))
  assert.equal(receipt.evidence.verifierGithubCi.commit, CURRENT.sourceCommit)
  assert.equal(receipt.artifacts.previous.version, PREVIOUS.version)
  assert.equal(receipt.artifacts.current.pnpmTreeSha256, CURRENT.pnpmTreeSha256)
  assert.equal(receipt.claims.publicPreviousToCurrentUpdate, true)
  assert.equal(receipt.claims.signedCatalogPreviousToCurrentUpdate, true)
  assert.equal(receipt.evidence.previousReleaseReady.runId, 99)
  assert.deepEqual(receipt.notProven, [
    'catalog-third-party-code-safety',
    'catalog-human-authority-review-independent-reexecution',
    'catalog-future-source-availability-or-status',
  ])
  const { receiptDigest, ...body } = receipt
  assert.equal(receiptDigest, canonicalSha256(body))
})

test('aggregates recovery rc.2 directly from the successful rc.0 receipt', () => {
  const rc0 = { ...PREVIOUS, sourceCommit: RECOVERY_RC0_COMMIT }
  const rc2 = { ...CURRENT, version: '0.1.0-rc.2' }
  const receipt = assertReleaseReady(evidence(rc0, rc2))
  assert.equal(receipt.schemaVersion, 3)
  assert.equal(receipt.p0Status, 'p0-release-ready')
  assert.equal(receipt.releaseStage, 'recovery-rc')
  assert.equal(receipt.artifacts.previous.version, '0.1.0-rc.0')
  assert.equal(receipt.artifacts.current.version, '0.1.0-rc.2')
  assert.equal(receipt.evidence.previousReleaseReady.runId, RECOVERY_PREVIOUS_RUN_ID)
  assert.equal(receipt.evidence.publicationIncident.targetCommit, RECOVERY_RC1_COMMIT)
  assert.equal(receipt.evidence.publicationIncident.failedRunId, RECOVERY_FAILED_RUN_ID)
  assert.equal(receipt.evidence.publicationIncident.runId, RECOVERY_INCIDENT_RUN_ID)
  assert.equal(receipt.evidence.publicationIncident.runAttempt, 1)
})

test('requires the complete terminal publication incident input set for recovery rc.2', () => {
  const rc0 = { ...PREVIOUS, sourceCommit: RECOVERY_RC0_COMMIT }
  const rc2 = { ...CURRENT, version: '0.1.0-rc.2' }
  for (const mutate of [
    input => { input.publicationIncident = null },
    input => { input.publicationIncidentVerifierGithubCi = null },
    input => { input.publicationIncidentRunId = null },
    input => { input.receiptDigests.publicationIncident = null },
    input => { input.receiptDigests.publicationIncidentVerifierGithubCi = null },
  ]) {
    const input = evidence(rc0, rc2)
    mutate(input)
    assert.throws(() => assertReleaseReady(input), /publication incident|terminal rc\.1/u)
  }
})

test('rejects re-digested publication incident coordinate and retained-evidence drift', () => {
  const rc0 = { ...PREVIOUS, sourceCommit: RECOVERY_RC0_COMMIT }
  const rc2 = { ...CURRENT, version: '0.1.0-rc.2' }
  for (const mutate of [
    input => { input.publicationIncident.target.version = '0.1.0-rc.9' },
    input => { input.publicationIncident.failure.run.id += 1 },
    input => { input.publicationIncident.verifier.githubCi.fileSha256 = `sha256:${'0'.repeat(64)}` },
    input => { input.publicationIncident.failure.artifact.receipts.previous.fileSha256 = `sha256:${'0'.repeat(64)}` },
    input => { input.publicationIncident.previousSuccessfulPublication.releaseReadyReceipt.receiptDigest = `sha256:${'0'.repeat(64)}` },
  ]) {
    const input = evidence(rc0, rc2)
    mutate(input)
    const { receiptDigest: _oldDigest, ...body } = input.publicationIncident
    input.publicationIncident.receiptDigest = canonicalSha256(body)
    input.receiptDigests.publicationIncident = receiptFileSha256(input.publicationIncident)
    assert.throws(() => assertReleaseReady(input), /publication incident|rc\.1 incident/u)
  }
})

test('rejects incident evidence outside recovery rc.2 and the immutable failed rc.1 target', () => {
  const rc0 = { ...PREVIOUS, sourceCommit: RECOVERY_RC0_COMMIT }
  const rc2 = { ...CURRENT, version: '0.1.0-rc.2' }
  const injected = evidence()
  const recovery = evidence(rc0, rc2)
  injected.publicationIncident = recovery.publicationIncident
  injected.publicationIncidentVerifierGithubCi = recovery.publicationIncidentVerifierGithubCi
  injected.publicationIncidentRunId = recovery.publicationIncidentRunId
  injected.receiptDigests.publicationIncident = recovery.receiptDigests.publicationIncident
  injected.receiptDigests.publicationIncidentVerifierGithubCi = recovery.receiptDigests.publicationIncidentVerifierGithubCi
  assert.throws(() => assertReleaseReady(injected), /only recovery rc\.2/u)

  const immutableRc1 = { ...CURRENT, sourceCommit: RECOVERY_RC1_COMMIT }
  assert.throws(
    () => assertReleaseReady(evidence(PREVIOUS, immutableRc1)),
    /terminal not-release-ready/u,
  )
})

test('accepts rc.0 only as an explicit bootstrap with update still unproven', () => {
  const rc0 = { ...CURRENT, version: '0.1.0-rc.0' }
  const receipt = assertReleaseReady(evidence(null, rc0, VERIFIER))
  assert.equal(receipt.p0Status, 'rc0-bootstrap-release-ready')
  assert.equal(receipt.verifier.mode, 'rc0-backfill')
  assert.equal(receipt.verifier.commit, VERIFIER.sourceCommit)
  assert.equal(receipt.claims.publicPreviousToCurrentUpdate, false)
  assert.equal(receipt.claims.signedCatalogPreviousToCurrentUpdate, false)
  assert.deepEqual(receipt.notProven, [
    'public-previous-to-current-update',
    'signed-catalog-previous-to-current-update',
    'catalog-third-party-code-safety',
    'catalog-human-authority-review-independent-reexecution',
    'catalog-future-source-availability-or-status',
  ])
})

test('accepts independent official DSH tree fingerprints after every lane proves its tree unchanged', () => {
  const input = evidence()
  const fullTree = `sha256:${'0'.repeat(64)}`
  const runtimeTree = `sha256:${'1'.repeat(64)}`
  const publicTree = `sha256:${'2'.repeat(64)}`
  input.fullP0.target.packageTreeDigest = fullTree
  input.runtimeRelease.target.packageTreeDigest = runtimeTree
  input.publicRelease.target.packageTreeDigestBefore = publicTree
  input.publicRelease.target.packageTreeDigestAfter = publicTree

  const receipt = assertReleaseReady(input)
  assert.equal(receipt.target.officialDsh.registryIntegrity, TARGET_DSH_REGISTRY_INTEGRITY)
  assert.equal(receipt.target.officialDsh.packageTreeDigest, fullTree)
})

test('requires the same persistent Center root to recover from the previous catalog gap and refresh current', () => {
  const replacedRoot = evidence()
  replacedRoot.runtimeRelease.observations.profile.centerRootRetained = false
  assert.throws(() => assertReleaseReady(replacedRoot), /same-Profile lifecycle/u)

  const hiddenPreviousGap = evidence()
  hiddenPreviousGap.runtimeRelease.observations.previous.catalogDegraded = false
  hiddenPreviousGap.runtimeRelease.observations.previous.catalogDegradedReason = null
  assert.throws(() => assertReleaseReady(hiddenPreviousGap), /adjacent-only catalog degradation/u)

  const degradedCurrent = evidence()
  degradedCurrent.runtimeRelease.observations.current.catalogSource = 'bootstrap'
  degradedCurrent.runtimeRelease.observations.current.catalogFreshness = 'bootstrap'
  degradedCurrent.runtimeRelease.observations.current.catalogDegraded = true
  degradedCurrent.runtimeRelease.observations.current.catalogDegradedReason = 'catalog revision chain contains a gap'
  assert.throws(() => assertReleaseReady(degradedCurrent), /fresh public catalog/u)
})

test('rejects publication identity drift and a changed official DSH tree within one lifecycle', () => {
  for (const [field, value] of [
    ['dshPackage', '@deepseek-ai/dsh@0.0.0'],
    ['auditedSourceCommit', '0'.repeat(40)],
    ['registry', 'https://registry.example.invalid/'],
    ['registryIntegrity', 'sha512-invalid'],
  ]) {
    const changedIdentity = evidence()
    changedIdentity.runtimeRelease.target[field] = value
    assert.throws(
      () => assertReleaseReady(changedIdentity),
      /does not bind the exact official DSH rc\.2 artifact/u,
      field,
    )
  }

  const changedTree = evidence()
  changedTree.publicRelease.target.packageTreeDigestAfter = `sha256:${'0'.repeat(64)}`
  assert.throws(
    () => assertReleaseReady(changedTree),
    /changed the official DSH package tree/u,
  )

  const changedRuntimeTree = evidence()
  changedRuntimeTree.runtimeRelease.officialDshPackageTreeUnchanged = false
  assert.throws(
    () => assertReleaseReady(changedRuntimeTree),
    /runtime Release did not use one unchanged official Web Profile/u,
  )

  const changedFullTree = evidence()
  changedFullTree.fullP0.observations.officialDshPackageTreeUnchanged = false
  assert.throws(() => assertReleaseReady(changedFullTree), /immutable Host/u)
})

test('permits a distinct verifier only for the immutable rc.0 bootstrap', () => {
  assert.throws(
    () => assertReleaseReady(evidence(PREVIOUS, CURRENT, VERIFIER)),
    /only immutable rc\.0 may use a distinct verifier commit/u,
  )

  const input = structuredClone(evidence())
  input.verifier.commit = VERIFIER.sourceCommit
  assert.throws(() => assertReleaseReady(input), /verifier GitHub CI commit/u)
})

test('accepts rc.1 consuming an rc.0 receipt backfilled by a distinct protected-main verifier', () => {
  const receipt = assertReleaseReady(evidence(PREVIOUS, CURRENT, CURRENT, VERIFIER))
  assert.equal(receipt.releaseStage, 'update-rc')
  assert.equal(receipt.verifier.mode, 'same-commit')
  assert.equal(receipt.evidence.previousReleaseReady.runId, 99)
})

test('rejects drift in the verifier CI consumed from an rc.0 backfill receipt', () => {
  const input = structuredClone(evidence(PREVIOUS, CURRENT, CURRENT, VERIFIER))
  input.previousVerifierGithubCi.target.commit = 'b'.repeat(40)
  input.previousVerifierGithubCi.run.headSha = 'b'.repeat(40)
  input.previousVerifierGithubCi.packAttestation.sourceCommit = 'b'.repeat(40)
  const { receiptDigest: _oldDigest, ...body } = input.previousVerifierGithubCi
  input.previousVerifierGithubCi.receiptDigest = canonicalSha256(body)
  assert.throws(
    () => assertReleaseReady(input),
    /previous release-ready receipt does not bind its exact verifier GitHub CI receipt/u,
  )
})

test('rejects verifier workflow identity or CI binding drift', () => {
  for (const mutate of [
    input => { input.verifier.repository = 'other/repository' },
    input => { input.verifier.workflowPath = '.github/workflows/other.yml' },
    input => { input.verifier.ref = 'refs/heads/feature' },
    input => { input.verifier.refProtected = false },
    input => {
      input.verifierGithubCi.target.commit = VERIFIER.sourceCommit
      input.verifierGithubCi.run.headSha = VERIFIER.sourceCommit
      input.verifierGithubCi.packAttestation.sourceCommit = VERIFIER.sourceCommit
      const { receiptDigest: _oldDigest, ...body } = input.verifierGithubCi
      input.verifierGithubCi.receiptDigest = canonicalSha256(body)
    },
  ]) {
    const input = structuredClone(evidence())
    mutate(input)
    assert.throws(() => assertReleaseReady(input), /verifier/u)
  }
})

test('rejects rc.1 without previous-to-current evidence', () => {
  assert.throws(() => assertReleaseReady(evidence(null, CURRENT)), /rc\.1, recovery rc\.2, and stable require/u)
})

test('rejects an update without the exact previous release-ready receipt and run', () => {
  for (const mutate of [
    input => {
      input.previousReleaseReady = null
      input.receiptDigests.previousReleaseReady = null
    },
    input => { input.previousEvidenceRunId = null },
  ]) {
    const input = structuredClone(evidence())
    mutate(input)
    assert.throws(() => assertReleaseReady(input), /previous release-ready catalog transition/u)
  }
})

test('rejects a previous release receipt whose deployed catalog was not promoted into this package', () => {
  const input = structuredClone(evidence())
  input.previousReleaseReady.catalog.deployment.entriesDigest = `sha256:${'8'.repeat(64)}`
  const { receiptDigest: _oldDigest, ...body } = input.previousReleaseReady
  input.previousReleaseReady.receiptDigest = canonicalSha256(body)
  assert.throws(
    () => assertReleaseReady(input),
    /previous deployed and current packaged catalogs differs/u,
  )
})

test('rejects a re-digested previous release-ready receipt with missing or drifted evidence bindings', () => {
  for (const mutate of [
    input => { input.previousReleaseReady.evidence = {} },
    input => { input.previousReleaseReady.evidence.githubCi.receiptDigest = `sha256:${'0'.repeat(64)}` },
    input => { input.previousReleaseReady.evidence.githubCi.runId += 1 },
    input => { input.previousReleaseReady.verifier.runId += 1 },
    input => { input.previousReleaseReady.evidence.verifierGithubCi.runAttempt += 1 },
  ]) {
    const input = structuredClone(evidence())
    mutate(input)
    const { receiptDigest: _oldDigest, ...body } = input.previousReleaseReady
    input.previousReleaseReady.receiptDigest = canonicalSha256(body)
    assert.throws(() => assertReleaseReady(input), /previous release-ready|GitHub CI evidence/u)
  }
})

test('accepts stable only from a successful rc.2 recovery receipt', () => {
  const rc0 = {
    ...PREVIOUS,
    sha256: `sha256:${'3'.repeat(64)}`,
    manifestSha256: `sha256:${'4'.repeat(64)}`,
    sourceCommit: '5'.repeat(40),
  }
  const rc2 = { ...PREVIOUS, version: '0.1.0-rc.2' }
  const stable = { ...CURRENT, version: '0.1.0' }
  const input = evidence(rc2, stable)
  input.previousReleaseReady = updateReleaseReadyReceipt(rc0, rc2)

  const receipt = assertReleaseReady(input)
  assert.equal(receipt.releaseStage, 'stable')
  assert.equal(receipt.artifacts.previous.version, '0.1.0-rc.2')
  assert.equal(receipt.artifacts.current.version, '0.1.0')
  assert.equal(receipt.schemaVersion, 3)
  assert.equal(receipt.evidence.publicationIncident, null)
})

test('stable rejects an rc.2 receipt that drops or drifts its transitive incident binding', () => {
  const rc0 = {
    ...PREVIOUS,
    sourceCommit: RECOVERY_RC0_COMMIT,
  }
  const rc2 = { ...PREVIOUS, version: '0.1.0-rc.2' }
  const stable = { ...CURRENT, version: '0.1.0' }
  for (const mutate of [
    receipt => {
      receipt.schemaVersion = 2
      delete receipt.evidence.publicationIncident
    },
    receipt => { receipt.evidence.publicationIncident = null },
    receipt => { receipt.evidence.publicationIncident.targetCommit = '0'.repeat(40) },
    receipt => { receipt.evidence.publicationIncident.verifierCommit = '0'.repeat(40) },
    receipt => { receipt.evidence.publicationIncident.verifierGithubCiRunId += 1 },
  ]) {
    const input = evidence(rc2, stable)
    input.previousReleaseReady = updateReleaseReadyReceipt(rc0, rc2)
    mutate(input.previousReleaseReady)
    const { receiptDigest: _oldDigest, ...body } = input.previousReleaseReady
    input.previousReleaseReady.receiptDigest = canonicalSha256(body)
    assert.throws(() => assertReleaseReady(input), /recovery rc\.2|publication incident|schema-2/u)
  }
})

test('rejects stable directly from rc.1', () => {
  const rc1 = { ...PREVIOUS, version: '0.1.0-rc.1' }
  const stable = { ...CURRENT, version: '0.1.0' }
  assert.throws(() => assertReleaseReady(evidence(rc1, stable)), /must update from 0\.1\.0-rc\.2/u)
})

test('rejects rc.1 to rc.2 even with an otherwise valid previous release-ready receipt', () => {
  const rc0 = {
    ...PREVIOUS,
    sha256: `sha256:${'3'.repeat(64)}`,
    manifestSha256: `sha256:${'4'.repeat(64)}`,
    sourceCommit: '5'.repeat(40),
  }
  const rc1 = { ...PREVIOUS, version: '0.1.0-rc.1' }
  const rc2 = { ...CURRENT, version: '0.1.0-rc.2' }
  const input = evidence(rc1, rc2)
  input.previousReleaseReady = updateReleaseReadyReceipt(rc0, rc1)
  assert.throws(() => assertReleaseReady(input), /recovery rc\.2 must update from 0\.1\.0-rc\.0/u)
})

test('rejects stable when the previous release-ready receipt embeds an rc.9 to rc.2 transition', () => {
  const rc9 = {
    ...PREVIOUS,
    version: '0.1.0-rc.9',
    sha256: `sha256:${'3'.repeat(64)}`,
    manifestSha256: `sha256:${'4'.repeat(64)}`,
    sourceCommit: '5'.repeat(40),
  }
  const rc2 = { ...PREVIOUS, version: '0.1.0-rc.2' }
  const stable = { ...CURRENT, version: '0.1.0' }
  const input = evidence(rc2, stable)
  input.previousReleaseReady = updateReleaseReadyReceipt(rc9, rc2)
  assert.throws(() => assertReleaseReady(input), /previous release-ready.*recovery rc\.2 must update from 0\.1\.0-rc\.0/u)
})

test('rejects a previous release-ready receipt whose release stage disagrees with its transition', () => {
  const rc0 = {
    ...PREVIOUS,
    sha256: `sha256:${'3'.repeat(64)}`,
    manifestSha256: `sha256:${'4'.repeat(64)}`,
    sourceCommit: '5'.repeat(40),
  }
  const rc2 = { ...PREVIOUS, version: '0.1.0-rc.2' }
  const stable = { ...CURRENT, version: '0.1.0' }
  const input = evidence(rc2, stable)
  input.previousReleaseReady = updateReleaseReadyReceipt(rc0, rc2)
  input.previousReleaseReady.releaseStage = 'update-rc'
  const { receiptDigest: _oldDigest, ...body } = input.previousReleaseReady
  input.previousReleaseReady.receiptDigest = canonicalSha256(body)
  assert.throws(() => assertReleaseReady(input), /previous release-ready stage and artifact history disagree/u)
})

test('rejects previous runtime evidence that no longer identifies its prior packaged bootstrap', () => {
  const input = structuredClone(evidence())
  input.runtimeRelease.observations.previous.catalogRevision += 1
  assert.throws(
    () => assertReleaseReady(input),
    /previous runtime artifact did not retain its prior packaged bootstrap/u,
  )
})

test('rejects any artifact digest, version, manifest, commit, or runtime receipt mismatch', () => {
  for (const mutate of [
    input => { input.fullP0.artifact.digest = `sha256:${'0'.repeat(64)}` },
    input => { input.runtimeRelease.artifacts.current.manifestSha256 = `sha256:${'0'.repeat(64)}` },
    input => { input.githubCi.target.commit = '0'.repeat(40); input.githubCi.run.headSha = '0'.repeat(40); const { receiptDigest, ...body } = input.githubCi; input.githubCi.receiptDigest = canonicalSha256(body) },
    input => { input.githubCi.packAttestation.sha256 = `sha256:${'0'.repeat(64)}`; const { receiptDigest, ...body } = input.githubCi; input.githubCi.receiptDigest = canonicalSha256(body) },
    input => { input.githubCi.packAttestation.pnpmTreeSha256 = `sha256:${'0'.repeat(64)}`; const { receiptDigest, ...body } = input.githubCi; input.githubCi.receiptDigest = canonicalSha256(body) },
    input => { input.publicRelease.inputs.current.packed.bundledPnpmTreeSha256 = `sha256:${'0'.repeat(64)}` },
    input => { input.publicRelease.inputs.current.immutableRelease.tagRefSha1 = '0'.repeat(40) },
    input => { input.runtimeRelease.observations.current.installedPnpmTreeSha256 = `sha256:${'0'.repeat(64)}` },
    input => { input.publicRelease.inputs.runtimeAcceptance.sha256 = `sha256:${'0'.repeat(64)}` },
    input => { input.runtimeRelease.ciPackAttestation.fileSha256 = `sha256:${'0'.repeat(64)}` },
  ]) {
    const input = structuredClone(evidence())
    mutate(input)
    assert.throws(() => assertReleaseReady(input), /P0-|differs|does not match|does not bind/u)
  }
})

test('rejects a re-digested previous CI receipt whose sidecar bytes are bound to another Release', () => {
  const input = structuredClone(evidence())
  input.previousGithubCi.packAttestation.releaseAssets[1].sha256 = `sha256:${'0'.repeat(64)}`
  const { receiptDigest: _oldDigest, ...body } = input.previousGithubCi
  input.previousGithubCi.receiptDigest = canonicalSha256(body)
  input.publicRelease.inputs.previousCiPackAttestation.receiptDigest = input.previousGithubCi.receiptDigest
  assert.throws(
    () => assertReleaseReady(input),
    /previous CI and public Release payloads|same exact three-file payload/u,
  )
})

test('rejects a catalog outside the signed bootstrap-to-deployment chain', () => {
  const input = structuredClone(evidence())
  input.runtimeRelease.observations.current.catalogEntriesDigest = `sha256:${'0'.repeat(64)}`
  assert.throws(() => assertReleaseReady(input), /signed bootstrap-to-public catalog chain/u)
})

test('rejects source freshness evidence for a different signed catalog', () => {
  const input = structuredClone(evidence())
  input.catalogSources.catalog.entriesDigest = `sha256:${'0'.repeat(64)}`
  const { receiptDigest, ...body } = input.catalogSources
  input.catalogSources.receiptDigest = canonicalSha256(body)
  assert.throws(() => assertReleaseReady(input), /catalog source receipt is not bound/u)
})

test('rejects stale or incompletely cross-bound source observations even when re-digested', () => {
  for (const mutate of [
    input => { input.catalogSources.observedAt = '2026-08-26T00:00:00.000Z' },
    input => { input.catalogSources.entries[0].entryDigest = `sha256:${'0'.repeat(64)}` },
    input => { input.catalogSources.entries[0].source.endpoint = 'https://api.github.com/repos/example/other/git/commits/0123456789abcdef0123456789abcdef01234567' },
    input => { input.catalogSources.entries[0].artifact.initialUrl = 'https://registry.npmjs.org/other/-/other-1.0.0.tgz' },
    input => { input.catalogSources.entries[0].artifact.finalUrl += '?sig=temporary-secret' },
    input => {
      const observed = input.catalogSources.entries.find(entry => entry.artifact.integrity.startsWith('sha256:'))
      observed.artifact.sha256 = `sha256:${'0'.repeat(64)}`
    },
  ]) {
    const input = structuredClone(evidence())
    mutate(input)
    const { receiptDigest, ...body } = input.catalogSources
    input.catalogSources.receiptDigest = canonicalSha256(body)
    assert.throws(() => assertReleaseReady(input), /P0-|source|catalog|fresh/u)
  }
})

test('rejects stale aggregate-name or incomplete full-P0 claims even with passed statuses', () => {
  const stale = structuredClone(evidence())
  stale.githubCi.requiredJobs.aggregate.name = 'Published rc.2 Store and Host-owner lanes'
  const { receiptDigest, ...body } = stale.githubCi
  stale.githubCi.receiptDigest = canonicalSha256(body)
  assert.throws(() => assertReleaseReady(stale), /plugin-only release gate/u)

  const incomplete = structuredClone(evidence())
  incomplete.fullP0.notProven.push('break-glass-managed-plugin-restore-receipt')
  assert.throws(() => assertReleaseReady(incomplete), /exact admitted claim list/u)
})

test('rejects any missing, duplicate, unknown, reordered, or unsuccessful faultMatrix case', () => {
  for (const mutate of [
    input => { input.fullP0.observations.faultMatrix.cases.shift() },
    input => { input.fullP0.observations.faultMatrix.cases[1] = structuredClone(input.fullP0.observations.faultMatrix.cases[0]) },
    input => { input.fullP0.observations.faultMatrix.cases[0].id = 'unknown' },
    input => { input.fullP0.observations.faultMatrix.cases.reverse() },
    input => { input.fullP0.observations.faultMatrix.cases[0].status = 'failed' },
  ]) {
    const input = structuredClone(evidence())
    mutate(input)
    assert.throws(() => assertReleaseReady(input), /faultMatrix/u)
  }
})

test('requires the previous release-ready path and canonical run id as one CLI pair', () => {
  const required = [
    '--full-p0', 'full.json',
    '--runtime-release', 'runtime.json',
    '--public-release', 'public.json',
    '--public-catalog', 'catalog.json',
    '--catalog-sources', 'sources.json',
    '--github-ci', 'ci.json',
    '--verifier-github-ci', 'verifier-ci.json',
    '--verifier-commit', CURRENT.sourceCommit,
    '--verifier-run-id', '314',
    '--verifier-run-attempt', '1',
  ]
  assert.throws(
    () => parseReleaseReadyArguments([...required, '--previous-release-ready', 'previous.json']),
    /must be supplied together/u,
  )
  assert.throws(
    () => parseReleaseReadyArguments([
      ...required,
      '--previous-verifier-github-ci', 'previous-verifier-ci.json',
      '--previous-release-ready', 'previous.json',
      '--previous-evidence-run-id', '01',
    ]),
    /positive integer/u,
  )
  assert.throws(
    () => parseReleaseReadyArguments([
      ...required,
      '--publication-incident', 'incident.json',
    ]),
    /publication incident receipt, verifier CI, and run id must be supplied together/u,
  )
  assert.throws(
    () => parseReleaseReadyArguments([
      ...required,
      '--publication-incident', 'incident.json',
      '--publication-incident-verifier-github-ci', 'incident-ci.json',
      '--publication-incident-run-id', '01',
    ]),
    /publication incident evidence run id must be a positive integer/u,
  )
  const parsed = parseReleaseReadyArguments([
    ...required,
    '--previous-verifier-github-ci', 'previous-verifier-ci.json',
    '--previous-release-ready', 'previous.json',
    '--previous-evidence-run-id', '99',
  ])
  assert.equal(parsed.previousEvidenceRunId, 99)
  assert.equal(parsed.verifierCommit, CURRENT.sourceCommit)
  assert.equal(parsed.verifierRunId, 314)
  assert.equal(parsed.verifierRunAttempt, 1)
  assert.match(parsed.verifierGithubCiPath, /verifier-ci\.json$/u)
  assert.match(parsed.previousVerifierGithubCiPath, /previous-verifier-ci\.json$/u)
  assert.match(parsed.previousReleaseReadyPath, /previous\.json$/u)

  const withIncident = parseReleaseReadyArguments([
    ...required,
    '--publication-incident', 'incident.json',
    '--publication-incident-verifier-github-ci', 'incident-ci.json',
    '--publication-incident-run-id', String(RECOVERY_INCIDENT_RUN_ID),
  ])
  assert.equal(withIncident.publicationIncidentRunId, RECOVERY_INCIDENT_RUN_ID)
  assert.match(withIncident.publicationIncidentPath, /incident\.json$/u)
  assert.match(withIncident.publicationIncidentVerifierGithubCiPath, /incident-ci\.json$/u)
})

test('requires canonical verifier commit and run identity CLI inputs', () => {
  const required = [
    '--full-p0', 'full.json',
    '--runtime-release', 'runtime.json',
    '--public-release', 'public.json',
    '--public-catalog', 'catalog.json',
    '--catalog-sources', 'sources.json',
    '--github-ci', 'ci.json',
    '--verifier-github-ci', 'verifier-ci.json',
    '--verifier-commit', CURRENT.sourceCommit,
    '--verifier-run-id', '314',
    '--verifier-run-attempt', '1',
  ]
  assert.throws(
    () => parseReleaseReadyArguments(required.filter((_, index) => index < required.length - 2)),
    /--verifier-run-attempt is required/u,
  )
  const badCommit = [...required]
  badCommit[badCommit.indexOf('--verifier-commit') + 1] = CURRENT.sourceCommit.toUpperCase()
  assert.throws(() => parseReleaseReadyArguments(badCommit), /verifier commit/u)
  const badRunId = [...required]
  badRunId[badRunId.indexOf('--verifier-run-id') + 1] = '01'
  assert.throws(() => parseReleaseReadyArguments(badRunId), /verifier run id/u)
})
