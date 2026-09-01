import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalJson, canonicalSha256 } from '../full-p0/receipt-binding.mjs'
import {
  WIKI_V1_INTEGRITY,
  WIKI_V1_REF,
  WIKI_V2_INTEGRITY,
  WIKI_V2_REF,
  createAlphaLifecycleReceipt,
} from '../alpha-catalog/support.mjs'
import { verifyAlphaNpmProvenanceReceipt } from '../../scripts/verify-alpha-npm-publication.mjs'
import {
  ALPHA_P0_ACCEPTANCE_ID,
  evaluateAlphaP0Composite,
  verifyAlphaP0CompositeReceipt,
} from './support.mjs'
import { parseAlphaP0CompositeArguments, runAlphaP0Composite } from './verify.mjs'

const DIGEST = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
const CENTER_COMMIT = 'c'.repeat(40)

function emptyInput() {
  return {
    ordinaryUser: null,
    ordinaryActions: null,
    npmProvenance: null,
    catalog: null,
    plugin: null,
    mcp: null,
    agent: null,
  }
}

function npmReceipt() {
  const sha512Hex = 'ab'.repeat(64)
  const version = '0.2.0-alpha.1'
  const body = {
    schemaVersion: 1,
    receiptId: 'DSH-CENTER-NPM-PROVENANCE',
    status: 'passed',
    package: {
      name: 'dsh-plugin-extension-center',
      version,
      integrity: `sha512-${Buffer.from(sha512Hex, 'hex').toString('base64')}`,
      tarballUrl: `https://registry.npmjs.org/dsh-plugin-extension-center/-/dsh-plugin-extension-center-${version}.tgz`,
      tarballSha256: DIGEST('alpha-tarball'),
      tarballSha512: `sha512:${sha512Hex}`,
    },
    provenance: {
      predicateType: 'https://slsa.dev/provenance/v1',
      attestationUrl: `https://registry.npmjs.org/-/npm/v1/attestations/dsh-plugin-extension-center@${version}`,
      bundleDigest: DIGEST('provenance-bundle'),
      bundleDigestAlgorithm: 'sha256-canonical-json',
      repository: 'https://github.com/striveh/dsh-plugin-extension-center',
      workflow: '.github/workflows/npm-publish.yml',
      ref: 'refs/heads/main',
      commit: CENTER_COMMIT,
    },
    publication: {
      runId: '123456',
      runAttempt: '1',
      invocationId: 'https://github.com/striveh/dsh-plugin-extension-center/actions/runs/123456/attempts/1',
    },
    verification: { runId: '123456', runAttempt: '2' },
    audit: {
      command: 'npm audit signatures --json --include-attestations',
      npmVersion: '12.0.2',
      verdict: 'passed',
      invalidCount: 0,
      missingCount: 0,
      targetVerified: true,
      provenanceBundleMatched: true,
    },
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function alphaLifecycleOperations() {
  const configured = canonicalSha256({ modelInvocable: true, userInvocable: false, projectRoot: null })
  const initial = canonicalSha256({ modelInvocable: true, userInvocable: true, projectRoot: null })
  const rows = [
    ['install', WIKI_V1_REF, WIKI_V1_INTEGRITY, false, true],
    ['configure', WIKI_V1_REF, WIKI_V1_INTEGRITY, false, false],
    ['update', WIKI_V2_REF, WIKI_V2_INTEGRITY, true, false],
    ['uninstall', WIKI_V2_REF, WIKI_V2_INTEGRITY, false, null],
    ['restore', WIKI_V2_REF, WIKI_V2_INTEGRITY, true, false],
    ['uninstall', WIKI_V2_REF, WIKI_V2_INTEGRITY, false, null],
  ]
  return rows.map(([action, candidateRef, materialIntegrity, configurationPreserved, userInvocable], index) => ({
    sequence: index + 1,
    action,
    candidateRef,
    status: 'committed',
    planHash: DIGEST(`plan-${String(index)}`),
    receiptDigest: DIGEST(`receipt-${String(index)}`),
    operationId: `operation:12345678-1234-4${String(index).padStart(3, '0')}-8123-123456789abc`,
    externalRuntimeAction: ['install', 'update'].includes(action) ? 'download' : 'none',
    beforeDigest: DIGEST(`before-${String(index)}`),
    afterDigest: DIGEST(`after-${String(index)}`),
    mutationDigests: [DIGEST(`mutation-${String(index)}`)],
    verificationDigests: [DIGEST(`verification-${String(index)}`)],
    journalEventCount: 7,
    journalHeadDigest: DIGEST(`journal-${String(index)}`),
    inventoryRevision: DIGEST(`inventory-${String(index)}`),
    managedRevision: `center:${String(index + 1)}`,
    configurationRevision: action === 'install'
      ? initial
      : ['configure', 'update', 'restore'].includes(action) ? configured : null,
    observedCandidateRef: candidateRef,
    ownerRevisionDigest: DIGEST(`owner-revision-${String(index)}`),
    ownerEvidenceDigest: DIGEST(`owner-evidence-${String(index)}`),
    materialIntegrity,
    ownerStateVerified: true,
    configurationPreserved,
    userInvocable,
  }))
}

function alphaLifecycleReceipt() {
  return createAlphaLifecycleReceipt({
    centerCommit: CENTER_COMMIT,
    runId: 123456,
    runAttempt: 2,
    officialDshSourceUnmodified: true,
    officialDshSourceTreeDigest: DIGEST('official-dsh-source-tree'),
    officialDshEntrypointDigest: DIGEST('official-dsh-entrypoint'),
    centerPackageDigest: DIGEST('center-package'),
    activeCandidateAbsent: true,
    catalog: {
      revision: 12,
      documentDigest: DIGEST('catalog-document'),
      entriesDigest: DIGEST('catalog-entries'),
      observedAt: '2026-08-28T00:00:00.000Z',
      issuedAt: '2026-08-28T00:00:00.000Z',
      expiresAt: '2026-08-29T00:00:00.000Z',
    },
    operations: alphaLifecycleOperations(),
  })
}

function productIdentity() {
  return {
    officialDsh: {
      packageName: '@deepseek-ai/dsh',
      version: '0.1.2-alpha.3',
      sourceCommit: 'dd6322d604e00eec1ba5e0c8541159906a21094a',
      registry: 'https://registry.npmjs.org/',
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    },
    center: {
      packageName: 'dsh-plugin-extension-center',
      version: '0.2.0-alpha.1',
      integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
      tarballSha256: DIGEST('center-tarball'),
      sourceCommit: CENTER_COMMIT,
    },
    catalog: {
      catalogId: 'dsh-extension-center-public',
      revision: 13,
      documentDigest: DIGEST('catalog-document-13'),
      entriesDigest: DIGEST('catalog-entries-13'),
    },
  }
}

function protectedRun(workflowFile) {
  return {
    repository: 'striveh/dsh-plugin-extension-center',
    repositoryId: '123456789',
    workflowFile,
    workflowRef: `striveh/dsh-plugin-extension-center/${workflowFile}@refs/heads/main`,
    ref: 'refs/heads/main',
    commit: 'd'.repeat(40),
    eventName: 'workflow_dispatch',
    refProtected: true,
    runId: '987654321',
    runAttempt: '2',
  }
}

function actionsArtifact(run, prefix) {
  return {
    name: `${prefix}-${run.commit}-attempt-${run.runAttempt}`,
    id: '24681012',
    digest: DIGEST(`${prefix}-archive`),
  }
}

function lifecycleLane(kind) {
  const workflow = `.github/workflows/alpha-${kind}-lifecycle.yml`
  const run = protectedRun(workflow)
  const initialCandidate = `${kind}:fixture@1.0.0`
  const updateCandidate = `${kind}:fixture@1.1.0`
  const initialConfiguration = DIGEST(`${kind}-initial-configuration`)
  const configured = DIGEST(`${kind}-configured`)
  const sequence = ['install', 'configure', 'update', 'uninstall', 'restore', 'uninstall', 'purge']
    .map((operationKind, index) => ({
      sequence: index + 1,
      operationKind,
      candidateRef: index < 2 ? initialCandidate : updateCandidate,
      targetKey: `${kind}:web:user:fixture`,
      planHash: DIGEST(`${kind}-plan-${String(index)}`),
      operationId: `operation:${kind}:${String(index + 1)}`,
      receiptDigest: DIGEST(`${kind}-receipt-${String(index)}`),
      journalHeadDigest: DIGEST(`${kind}-journal-${String(index)}`),
      inventoryRevision: DIGEST(`${kind}-inventory-${String(index)}`),
      ownerRevision: `center:${kind}:${String(index + 1)}`,
      ownerStateDigest: DIGEST(`${kind}-owner-${String(index)}`),
      materialDigest: DIGEST(`${kind}-material-${String(index)}`),
      configurationRevision: index === 0
        ? initialConfiguration
        : [1, 2, 4].includes(index) ? configured : null,
      decision: 'approve',
      terminalStatus: 'committed',
      ownerStateVerified: true,
      userInterface: {
        actionObserved: true,
        planReviewObserved: true,
        approvalObserved: true,
        completionObserved: true,
      },
    }))
  const body = {
    schemaVersion: 1,
    acceptanceId: kind === 'plugin' ? 'P0-ALPHA-PLUGIN-UI-LIFECYCLE' : 'P0-ALPHA-MCP-UI-LIFECYCLE',
    status: 'passed',
    laneStatus: 'proven',
    extensionKind: kind,
    product: productIdentity(),
    run,
    artifact: actionsArtifact(run, `alpha-${kind}-lifecycle`),
    sequence,
    providerEvidence: kind === 'plugin'
      ? {
        officialCliWritesProfile: true,
        loaderConsumerVerified: true,
        restartObserved: true,
        officialDshPackageTreeUnchanged: true,
        recoveryReceiptDigest: DIGEST('plugin-recovery'),
      }
      : {
        executableDigest: DIGEST('mcp-executable'),
        descriptorDigest: DIGEST('mcp-descriptor'),
        initializeDigest: DIGEST('mcp-initialize'),
        toolsListDigest: DIGEST('mcp-tools-list'),
        generationDigest: DIGEST('mcp-generation'),
        runtimePreprovisioned: true,
        secretsAbsent: true,
        externalPackageManagedByCenter: false,
      },
    finalState: {
      targetKey: sequence.at(-1).targetKey,
      inventoryRevision: sequence.at(-1).inventoryRevision,
      ownerStateDigest: sequence.at(-1).ownerStateDigest,
      tombstoneRetained: true,
      managedBytesAbsent: true,
      rollback: 'unavailable',
      installActionAvailable: true,
    },
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function catalogLane() {
  const run = protectedRun('.github/workflows/alpha-catalog-activation.yml')
  const product = productIdentity()
  const body = {
    schemaVersion: 1,
    acceptanceId: 'P0-ALPHA-SIGNED-CATALOG-ACTIVATION',
    status: 'passed',
    laneStatus: 'proven',
    product,
    run,
    artifact: actionsArtifact(run, 'alpha-catalog-activation'),
    deployment: {
      url: 'https://striveh.github.io/dsh-plugin-extension-center/plugins.json',
      httpStatus: 200,
      redirected: false,
      contentType: 'application/json',
      sizeBytes: 12345,
      bytesSha256: DIGEST('catalog-bytes'),
      revision: product.catalog.revision,
      documentDigest: product.catalog.documentDigest,
      entriesDigest: product.catalog.entriesDigest,
      signatureSetDigest: DIGEST('catalog-signatures'),
      signatureThresholdVerified: true,
      keyIds: ['catalog-key-1'],
      candidateKinds: ['plugin', 'mcp', 'skill'],
      successorKinds: ['plugin', 'mcp', 'skill'],
      runtimeRefresh: {
        source: 'remote',
        freshness: 'fresh',
        degraded: false,
        signatureStatus: 'verified',
        revision: product.catalog.revision,
        entriesDigest: product.catalog.entriesDigest,
      },
    },
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

function agentLane() {
  const run = protectedRun('.github/workflows/alpha-agent-acquisition.yml')
  const body = {
    schemaVersion: 1,
    acceptanceId: 'P0-ALPHA-AGENT-CAPABILITY-ACQUISITION-CONTINUATION',
    status: 'passed',
    laneStatus: 'proven',
    product: productIdentity(),
    run,
    artifact: actionsArtifact(run, 'alpha-agent-acquisition'),
    session: {
      sessionIdDigest: DIGEST('agent-session'),
      originalMessageDigest: DIGEST('agent-original-message'),
      historyDigest: DIGEST('agent-history'),
      toolNames: ['extension_center_resolve', 'extension_center_request_acquisition', 'skill'],
      needDigest: DIGEST('agent-need'),
      selectedCandidateRef: 'skill:fixture@1.0.0',
      planHash: DIGEST('agent-plan'),
      operationReceiptDigest: DIGEST('agent-operation-receipt'),
      approvalDriver: 'playwright-accessible-ui',
      humanApprovalObserved: true,
      acquiredRuntimeEvidenceDigest: DIGEST('agent-runtime-evidence'),
      usedExtensionKind: 'skill',
      skillResultDigest: DIGEST('agent-skill-result'),
      continuationIdDigest: DIGEST('agent-continuation-id'),
      continuationClaimDigest: DIGEST('agent-continuation-claim'),
      sameSession: true,
      originalMessageCount: 1,
      continuationCount: 1,
      originalTaskCompleted: true,
    },
  }
  return { ...body, receiptDigest: canonicalSha256(body) }
}

test('no lane can inherit proof from another missing lane', () => {
  const receipt = evaluateAlphaP0Composite(emptyInput())
  assert.equal(receipt.acceptanceId, ALPHA_P0_ACCEPTANCE_ID)
  assert.equal(receipt.status, 'not-proven')
  assert.equal(receipt.p0Status, 'red')
  assert.equal(receipt.notProven.length, 11)
  for (const lane of Object.values(receipt.lanes)) assert.equal(lane.status, 'missing')
  assert.deepEqual(receipt, verifyAlphaP0CompositeReceipt(receipt))
})

test('valid npm provenance remains externally unverified inside the offline composite', () => {
  const provenance = npmReceipt()
  const verified = verifyAlphaNpmProvenanceReceipt(provenance)
  assert.equal(verified.package.version, '0.2.0-alpha.1')
  const receipt = evaluateAlphaP0Composite({ ...emptyInput(), npmProvenance: provenance })
  assert.equal(receipt.lanes.centerPackageProvenance.status, 'externally-unverified')
  assert.equal(receipt.lanes.centerPackageProvenance.artifactDigest, null)
  assert.equal(receipt.lanes.pluginLifecycle.status, 'missing')
  assert.equal(receipt.lanes.mcpLifecycle.status, 'missing')
  assert.equal(receipt.lanes.agentAcquisitionContinuation.status, 'missing')
  assert.equal(receipt.p0Status, 'red')

  const drifted = structuredClone(provenance)
  drifted.package.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`
  const { receiptDigest: _digest, ...body } = drifted
  drifted.receiptDigest = canonicalSha256(body)
  assert.throws(() => verifyAlphaNpmProvenanceReceipt(drifted), /integrity and SHA-512 differ/u)
})

test('schema-2 official-alpha Skill lifecycle is retained as development evidence, never signed-catalog proof', () => {
  const receipt = evaluateAlphaP0Composite({ ...emptyInput(), catalog: alphaLifecycleReceipt() })
  assert.deepEqual(receipt.lanes.signedCatalog, {
    status: 'development-only',
    code: 'ALPHA-P0-CATALOG-DEVELOPMENT-ONLY-SCHEMA-2',
    schemaVersion: 2,
    acceptanceId: 'P0-OFFICIAL-ALPHA-WIKI-SKILL-LIFECYCLE',
    receiptDigest: alphaLifecycleReceipt().receiptDigest,
    workflow: '.github/workflows/official-alpha-wiki-lifecycle.yml',
    commit: CENTER_COMMIT,
    runId: '123456',
    runAttempt: '2',
    artifactDigest: null,
  })
  assert.equal(receipt.p0Status, 'red')
  assert.ok(receipt.notProven.includes('lane:signedCatalog'))
  verifyAlphaP0CompositeReceipt(receipt)
})

test('a rehashed but incomplete Plugin claim remains invalid and cannot turn the gate green', () => {
  const body = {
    schemaVersion: 1,
    acceptanceId: 'P0-ALPHA-PLUGIN-UI-LIFECYCLE',
    status: 'passed',
    laneStatus: 'proven',
    extensionKind: 'plugin',
  }
  const fabricated = { ...body, receiptDigest: canonicalSha256(body) }
  const receipt = evaluateAlphaP0Composite({ ...emptyInput(), plugin: fabricated })
  assert.equal(receipt.lanes.pluginLifecycle.status, 'invalid')
  assert.equal(receipt.p0Status, 'red')
})

test('schema-valid Plugin, MCP, and Agent claims stay externally unverified without independent Actions evidence', () => {
  const receipt = evaluateAlphaP0Composite({
    ...emptyInput(),
    plugin: lifecycleLane('plugin'),
    mcp: lifecycleLane('mcp'),
    agent: agentLane(),
  })
  assert.equal(receipt.lanes.signedCatalog.status, 'missing')
  assert.equal(receipt.lanes.pluginLifecycle.status, 'externally-unverified')
  assert.equal(receipt.lanes.mcpLifecycle.status, 'externally-unverified')
  assert.equal(receipt.lanes.agentAcquisitionContinuation.status, 'externally-unverified')
  assert.equal(receipt.lanes.pluginLifecycle.artifactDigest, null)
  assert.equal(receipt.lanes.mcpLifecycle.artifactDigest, null)
  assert.equal(receipt.lanes.agentAcquisitionContinuation.artifactDigest, null)
  assert.equal(receipt.lanes.officialDshRegistryInstall.status, 'missing')
  assert.equal(receipt.lanes.centerPackageProvenance.status, 'missing')
  assert.equal(receipt.p0Status, 'red')
  verifyAlphaP0CompositeReceipt(receipt)
})

test('a rehashed catalog projection without its signed document remains invalid', () => {
  const receipt = evaluateAlphaP0Composite({ ...emptyInput(), catalog: catalogLane() })
  assert.equal(receipt.lanes.signedCatalog.status, 'invalid')
  assert.equal(receipt.p0Status, 'red')
})

test('externally unverified lanes retain diagnostics but cannot contribute product bindings', () => {
  const plugin = lifecycleLane('plugin')
  const mcp = lifecycleLane('mcp')
  mcp.product.catalog.entriesDigest = DIGEST('substituted-catalog-entries')
  const { receiptDigest: _digest, ...body } = mcp
  mcp.receiptDigest = canonicalSha256(body)
  const receipt = evaluateAlphaP0Composite({
    ...emptyInput(),
    plugin,
    mcp,
  })
  assert.equal(receipt.lanes.pluginLifecycle.status, 'externally-unverified')
  assert.equal(receipt.lanes.mcpLifecycle.status, 'externally-unverified')
  assert.equal(receipt.lanes.pluginLifecycle.receiptDigest, plugin.receiptDigest)
  assert.equal(receipt.lanes.mcpLifecycle.receiptDigest, mcp.receiptDigest)
  assert.equal(receipt.bindings.protectedEvidenceCoordinates, false)
  assert.equal(receipt.p0Status, 'red')
})

test('composite receipt rejects status tampering even after rehashing', () => {
  const receipt = structuredClone(evaluateAlphaP0Composite(emptyInput()))
  receipt.status = 'passed'
  receipt.p0Status = 'proven'
  const { receiptDigest: _digest, ...body } = receipt
  receipt.receiptDigest = canonicalSha256(body)
  assert.throws(() => verifyAlphaP0CompositeReceipt(receipt), /overall status does not fail closed/u)
})

test('schema 1 rejects a fully rehashed all-proven composite claim', () => {
  const receipt = structuredClone(evaluateAlphaP0Composite(emptyInput()))
  for (const [index, name] of Object.keys(receipt.lanes).entries()) {
    receipt.lanes[name] = {
      status: 'proven',
      code: `FORGED-LANE-${String(index + 1)}`,
      schemaVersion: 1,
      acceptanceId: `forged-lane-${String(index + 1)}`,
      receiptDigest: DIGEST(`forged-receipt-${String(index + 1)}`),
      workflow: '.github/workflows/forged.yml',
      commit: 'a'.repeat(40),
      runId: '1',
      runAttempt: '1',
      artifactDigest: DIGEST(`forged-artifact-${String(index + 1)}`),
    }
  }
  for (const name of Object.keys(receipt.bindings)) receipt.bindings[name] = true
  receipt.notProven = []
  receipt.status = 'passed'
  receipt.p0Status = 'proven'
  const { receiptDigest: _digest, ...body } = receipt
  receipt.receiptDigest = canonicalSha256(body)
  assert.throws(
    () => verifyAlphaP0CompositeReceipt(receipt),
    /schema 1 cannot prove P0 without independent external evidence verification/u,
  )
})

test('CLI writes one canonical RED receipt when required alpha lane receipts are absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpha-p0-composite-'))
  try {
    const options = parseAlphaP0CompositeArguments(['--', '--receipt', 'receipt.json'], root)
    const receipt = await runAlphaP0Composite(options)
    const [text, info] = await Promise.all([readFile(options.receiptPath, 'utf8'), lstat(options.receiptPath)])
    assert.equal(receipt.p0Status, 'red')
    assert.equal(text, `${canonicalJson(receipt)}\n`)
    assert.equal(info.isFile(), true)
    if (process.platform !== 'win32') assert.equal(info.mode & 0o077, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('CLI refuses to replace an existing receipt or symlink target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpha-p0-composite-exclusive-'))
  try {
    const options = parseAlphaP0CompositeArguments(['--', '--receipt', 'receipt.json'], root)
    const first = await runAlphaP0Composite(options)
    await assert.rejects(runAlphaP0Composite(options), /EEXIST|file already exists/u)
    assert.deepEqual(JSON.parse(await readFile(options.receiptPath, 'utf8')), first)

    const symlinkOptions = parseAlphaP0CompositeArguments(['--', '--receipt', 'receipt-link.json'], root)
    await symlink('protected.json', symlinkOptions.receiptPath)
    await assert.rejects(runAlphaP0Composite(symlinkOptions), /EEXIST|file already exists/u)
    const linkInfo = await lstat(symlinkOptions.receiptPath)
    assert.equal(linkInfo.isSymbolicLink(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
