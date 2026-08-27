import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TARGET_DSH_REGISTRY_INTEGRITY } from '../store-only/support.mjs'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../../lib/catalog-data.js'
import { TARGET_DSH_COMMIT } from './support.mjs'
import { canonicalSha256 } from './receipt-binding.mjs'
import { REQUIRED_FAULT_MATRIX_CASE_IDS } from './fault-matrix.mjs'
import { EXPECTED_PUBLIC_CATALOG, PUBLIC_CATALOG_URL } from '../release/verify-public-catalog.mjs'
import { REQUIRED_CI_JOBS } from '../release/verify-github-ci.mjs'
import { assertReleaseReady, parseReleaseReadyArguments } from './assert-release-ready.mjs'

const TREE = `sha256:${'a'.repeat(64)}`
const RUNTIME_RECEIPT_SHA = `sha256:${'b'.repeat(64)}`
const BOOTSTRAP_ENTRIES = EXPECTED_PUBLIC_CATALOG.packagedBootstrapEntriesDigest
const PREVIOUS_BOOTSTRAP_ENTRIES = `sha256:${'0'.repeat(64)}`
const CURRENT = Object.freeze({
  version: '0.1.0-rc.1',
  sha256: `sha256:${'c'.repeat(64)}`,
  sizeBytes: 1234,
  manifestSha256: `sha256:${'d'.repeat(64)}`,
  sourceCommit: 'e'.repeat(40),
})
const PREVIOUS = Object.freeze({
  version: '0.1.0-rc.0',
  sha256: `sha256:${'f'.repeat(64)}`,
  sizeBytes: 1200,
  manifestSha256: `sha256:${'1'.repeat(64)}`,
  sourceCommit: '2'.repeat(40),
})

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
      tagRefSha1: '9'.repeat(40),
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
      bundledPnpmTreeSha256: `sha256:${'5'.repeat(64)}`,
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

function previousReleaseReadyReceipt(artifact = PREVIOUS) {
  const ci = githubCiReceipt(artifact)
  const body = {
    schemaVersion: 2,
    acceptanceId: 'P0-EXTENSION-CENTER-RELEASE-READY',
    status: 'passed',
    p0Status: 'rc0-bootstrap-release-ready',
    releaseStage: 'bootstrap-rc0',
    generatedAt: '2026-08-27T00:05:00.000Z',
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

function runtimeArtifact(artifact) {
  return { ...artifact, filename: `${artifact.version}.tgz`, hostBoot: true, clientBoot: true, rpcRegistration: true }
}

function boundArtifact(artifact) {
  return {
    version: artifact.version,
    sha256: artifact.sha256,
    manifestSha256: artifact.manifestSha256,
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
      catalogRevision: 8,
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
        removalExactBaselineRestored: true,
      },
      previous: previous === null ? null : {
        catalogRevision: EXPECTED_PUBLIC_CATALOG.previousRevision - 1,
        catalogEntriesDigest: PREVIOUS_BOOTSTRAP_ENTRIES,
        browserExternalRequests: [],
        browserExternalWebSockets: [],
        browserConsoleFailures: [],
      },
      current: {
        catalogRevision: EXPECTED_PUBLIC_CATALOG.revision,
        catalogEntriesDigest: EXPECTED_PUBLIC_CATALOG.entriesDigest,
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
      pnpmTreeSha256: `sha256:${'1'.repeat(64)}`,
      releaseAssets: releasePayload(current),
    },
    notProven: [],
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function evidence(previous = PREVIOUS, current = CURRENT) {
  const runtimeRelease = runtimeReceipt(previous, current)
  const publicRelease = publicReceipt(previous, current)
  const githubCi = githubCiReceipt(current)
  const previousGithubCi = previous === null ? null : githubCiReceipt(previous)
  const previousReleaseReady = previous === null ? null : previousReleaseReadyReceipt(previous)
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
    previousGithubCi,
    previousReleaseReady,
    previousEvidenceRunId: previous === null ? null : 99,
    receiptDigests: {
      fullP0: `sha256:${'9'.repeat(64)}`,
      runtimeRelease: RUNTIME_RECEIPT_SHA,
      publicRelease: `sha256:${'a'.repeat(64)}`,
      publicCatalog: `sha256:${'b'.repeat(64)}`,
      catalogSources: `sha256:${'d'.repeat(64)}`,
      githubCi: `sha256:${'c'.repeat(64)}`,
      previousGithubCi: previousGithubCi === null ? null : `sha256:${'6'.repeat(64)}`,
      previousReleaseReady: previousReleaseReady === null ? null : `sha256:${'7'.repeat(64)}`,
    },
    generatedAt: '2026-08-27T00:10:00.000Z',
  }
}

test('aggregates rc.1 update evidence into one exact-commit P0 release receipt', () => {
  const receipt = assertReleaseReady(evidence())
  assert.equal(receipt.p0Status, 'p0-release-ready')
  assert.equal(receipt.releaseStage, 'update-rc')
  assert.equal(receipt.target.sourceCommit, CURRENT.sourceCommit)
  assert.equal(receipt.artifacts.previous.version, PREVIOUS.version)
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

test('accepts rc.0 only as an explicit bootstrap with update still unproven', () => {
  const rc0 = { ...CURRENT, version: '0.1.0-rc.0' }
  const receipt = assertReleaseReady(evidence(null, rc0))
  assert.equal(receipt.p0Status, 'rc0-bootstrap-release-ready')
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

test('rejects rc.1 without previous-to-current evidence', () => {
  assert.throws(() => assertReleaseReady(evidence(null, CURRENT)), /rc\.1 and stable require/u)
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
  ]) {
    const input = structuredClone(evidence())
    mutate(input)
    const { receiptDigest: _oldDigest, ...body } = input.previousReleaseReady
    input.previousReleaseReady.receiptDigest = canonicalSha256(body)
    assert.throws(() => assertReleaseReady(input), /previous release-ready|GitHub CI evidence/u)
  }
})

test('rejects stable unless it advances directly from rc.1', () => {
  const previous = { ...PREVIOUS, version: '0.1.0-rc.2' }
  const current = { ...CURRENT, version: '0.1.0' }
  assert.throws(() => assertReleaseReady(evidence(previous, current)), /must update from 0\.1\.0-rc\.1/u)
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
  ]
  assert.throws(
    () => parseReleaseReadyArguments([...required, '--previous-release-ready', 'previous.json']),
    /must be supplied together/u,
  )
  assert.throws(
    () => parseReleaseReadyArguments([
      ...required,
      '--previous-release-ready', 'previous.json',
      '--previous-evidence-run-id', '01',
    ]),
    /positive integer/u,
  )
  const parsed = parseReleaseReadyArguments([
    ...required,
    '--previous-release-ready', 'previous.json',
    '--previous-evidence-run-id', '99',
  ])
  assert.equal(parsed.previousEvidenceRunId, 99)
  assert.match(parsed.previousReleaseReadyPath, /previous\.json$/u)
})
