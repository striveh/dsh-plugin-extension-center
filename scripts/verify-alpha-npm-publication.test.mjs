import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  assertAlphaLatestUnchanged,
  classifyAlphaNpmTarget,
  createAlphaNpmProvenanceReceipt,
  validateAlphaBootstrapInstallation,
  validateAlphaNpmArchive,
  validateAlphaNpmPublication,
  validateAlphaNpmProvenance,
} from './verify-alpha-npm-publication.mjs'

const version = '0.2.0-alpha.1'
const archive = Buffer.from('published alpha bytes')
const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
const execFileAsync = promisify(execFile)

function metadata() {
  return {
    name: 'dsh-plugin-extension-center',
    version,
    'dist.integrity': integrity,
    'dist.tarball': `https://registry.npmjs.org/dsh-plugin-extension-center/-/dsh-plugin-extension-center-${version}.tgz`,
  }
}

test('accepts exact registry bytes selected only by next', () => {
  assert.deepEqual(validateAlphaNpmPublication(metadata(), { latest: '0.1.0', next: version }, archive, version), {
    packageName: 'dsh-plugin-extension-center',
    version,
    integrity,
  })
})

test('rejects integrity, tarball, next, and latest drift', () => {
  assert.throws(
    () => validateAlphaNpmPublication(metadata(), { next: version }, Buffer.from('changed'), version),
    /exact published archive/u,
  )
  assert.throws(
    () => validateAlphaNpmPublication({ ...metadata(), 'dist.tarball': 'https://example.invalid/a.tgz' }, { next: version }, archive, version),
    /exact published archive/u,
  )
  assert.throws(() => validateAlphaNpmPublication(metadata(), { next: '0.2.0-alpha.2' }, archive, version), /exclusively/u)
  assert.throws(() => validateAlphaNpmPublication(metadata(), { latest: version, next: version }, archive, version), /exclusively/u)
  assert.throws(
    () => validateAlphaNpmPublication(metadata(), { latest: '0.2.0-alpha.0', next: version }, archive, version),
    /exclusively/u,
  )
  assert.doesNotThrow(() => assertAlphaLatestUnchanged({ latest: '0.1.0' }, { latest: '0.1.0' }))
  assert.throws(() => assertAlphaLatestUnchanged({ latest: '0.1.0' }, { latest: '0.1.1' }), /latest changed/u)
  assert.throws(
    () => assertAlphaLatestUnchanged({ latest: '0.2.0-alpha.0' }, { latest: '0.2.0-alpha.0' }),
    /latest changed/u,
  )
})

test('classifies a safe retry without republishing an existing version', () => {
  assert.deepEqual(classifyAlphaNpmTarget({ error: { code: 'E404' } }, archive, version), {
    status: 'missing',
  })
  assert.deepEqual(classifyAlphaNpmTarget(metadata(), archive, version), {
    status: 'published',
    packageName: 'dsh-plugin-extension-center',
    version,
    integrity,
  })
  assert.deepEqual(validateAlphaNpmArchive(metadata(), archive, version), {
    packageName: 'dsh-plugin-extension-center', version, integrity,
  })
  assert.throws(
    () => classifyAlphaNpmTarget(metadata(), Buffer.from('different CI archive'), version),
    /does not bind the exact published archive/u,
  )
  assert.throws(
    () => classifyAlphaNpmTarget({ error: { code: 'E404' } }, archive, '0.2.0-alpha.0-typo'),
    /expected one Center alpha archive/u,
  )
})

test('accepts only an installed alpha.0 bootstrap bound to its registry integrity', () => {
  const bootstrapVersion = '0.2.0-alpha.0'
  const bootstrapArchive = Buffer.from('bootstrap alpha bytes')
  const bootstrapIntegrity = `sha512-${createHash('sha512').update(bootstrapArchive).digest('base64')}`
  const bootstrapMetadata = {
    name: 'dsh-plugin-extension-center',
    version: bootstrapVersion,
    'dist.integrity': bootstrapIntegrity,
    'dist.tarball': `https://registry.npmjs.org/dsh-plugin-extension-center/-/dsh-plugin-extension-center-${bootstrapVersion}.tgz`,
  }
  assert.deepEqual(
    validateAlphaNpmPublication(
      bootstrapMetadata,
      { next: bootstrapVersion },
      bootstrapArchive,
      bootstrapVersion,
    ),
    { packageName: 'dsh-plugin-extension-center', version: bootstrapVersion, integrity: bootstrapIntegrity },
  )
  const projectManifest = { dependencies: { 'dsh-plugin-extension-center': bootstrapVersion } }
  const installedManifest = {
    name: 'dsh-plugin-extension-center',
    version: bootstrapVersion,
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  }
  const lock = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      dsh-plugin-extension-center:
        specifier: ${bootstrapVersion}
        version: ${bootstrapVersion}
packages:
  dsh-plugin-extension-center@${bootstrapVersion}:
    resolution:
      integrity: ${bootstrapIntegrity}
snapshots:
  dsh-plugin-extension-center@${bootstrapVersion}: {}
`
  assert.deepEqual(
    validateAlphaBootstrapInstallation(
      bootstrapMetadata,
      projectManifest,
      installedManifest,
      lock,
      bootstrapVersion,
    ),
    { packageName: 'dsh-plugin-extension-center', version: bootstrapVersion, integrity: bootstrapIntegrity },
  )
  assert.throws(
    () => validateAlphaBootstrapInstallation(
      bootstrapMetadata,
      projectManifest,
      installedManifest,
      lock.replace(bootstrapIntegrity, `sha512-${Buffer.alloc(64, 1).toString('base64')}`),
      bootstrapVersion,
    ),
    /not bound to registry integrity/u,
  )
  assert.throws(
    () => validateAlphaBootstrapInstallation(
      bootstrapMetadata,
      projectManifest,
      { ...installedManifest, version: '0.2.0-alpha.1' },
      lock,
      bootstrapVersion,
    ),
    /did not install as one exact Bundle/u,
  )
})

test('binds a cryptographically audited SLSA bundle to protected main and exact archive bytes', () => {
  const fixture = provenanceFixture({ attestedAttempt: '2' })
  assert.deepEqual(validateAlphaNpmProvenance(
    fixture.metadata,
    fixture.attestations,
    fixture.audit,
    archive,
    version,
    { commit: fixture.commit, runId: '123', runAttempt: '2', targetState: 'missing' },
  ), {
    packageName: 'dsh-plugin-extension-center',
    version,
    integrity,
    invocationId: 'https://github.com/striveh/dsh-plugin-extension-center/actions/runs/123/attempts/2',
  })

  const retry = provenanceFixture({ attestedAttempt: '1' })
  assert.doesNotThrow(() => validateAlphaNpmProvenance(
    retry.metadata,
    retry.attestations,
    retry.audit,
    archive,
    version,
    { commit: retry.commit, runId: '123', runAttempt: '3', targetState: 'published' },
  ))
  assert.throws(() => validateAlphaNpmProvenance(
    retry.metadata,
    retry.attestations,
    retry.audit,
    archive,
    version,
    { commit: retry.commit, runId: '123', runAttempt: '3', targetState: 'missing' },
  ), /publication run/u)
})

test('creates a deterministic secret-free receipt that distinguishes publication from verification attempts', () => {
  const fixture = provenanceFixture({ attestedAttempt: '1' })
  const receipt = createAlphaNpmProvenanceReceipt(
    fixture.metadata,
    fixture.attestations,
    fixture.audit,
    archive,
    version,
    { commit: fixture.commit, runId: '123', runAttempt: '3', targetState: 'published' },
    '12.0.2',
  )
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.receiptId, 'DSH-CENTER-NPM-PROVENANCE')
  assert.equal(receipt.status, 'passed')
  assert.deepEqual(receipt.package, {
    name: 'dsh-plugin-extension-center',
    version,
    integrity,
    tarballUrl: `https://registry.npmjs.org/dsh-plugin-extension-center/-/dsh-plugin-extension-center-${version}.tgz`,
    tarballSha256: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
    tarballSha512: `sha512:${createHash('sha512').update(archive).digest('hex')}`,
  })
  assert.equal(receipt.provenance.repository, 'https://github.com/striveh/dsh-plugin-extension-center')
  assert.equal(receipt.provenance.workflow, '.github/workflows/npm-publish.yml')
  assert.equal(receipt.provenance.ref, 'refs/heads/main')
  assert.equal(receipt.provenance.commit, fixture.commit)
  assert.match(receipt.provenance.bundleDigest, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(receipt.provenance.bundleDigestAlgorithm, 'sha256-canonical-json')
  assert.deepEqual(receipt.publication, {
    runId: '123',
    runAttempt: '1',
    invocationId: 'https://github.com/striveh/dsh-plugin-extension-center/actions/runs/123/attempts/1',
  })
  assert.deepEqual(receipt.verification, { runId: '123', runAttempt: '3' })
  assert.deepEqual(receipt.audit, {
    command: 'npm audit signatures --json --include-attestations',
    npmVersion: '12.0.2',
    verdict: 'passed',
    invalidCount: 0,
    missingCount: 0,
    targetVerified: true,
    provenanceBundleMatched: true,
  })
  assert.match(receipt.receiptDigest, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(Object.isFrozen(receipt), true)
  assert.equal(Object.isFrozen(receipt.provenance), true)
  assert.doesNotMatch(JSON.stringify(receipt), /(?:_auth|authorization|credential|secret|token|\/Users\/|\/home\/runner)/iu)
  assert.deepEqual(receipt, createAlphaNpmProvenanceReceipt(
    fixture.metadata,
    fixture.attestations,
    fixture.audit,
    archive,
    version,
    { commit: fixture.commit, runId: '123', runAttempt: '3', targetState: 'published' },
    '12.0.2',
  ))
  assert.throws(
    () => createAlphaNpmProvenanceReceipt(
      fixture.metadata,
      fixture.attestations,
      fixture.audit,
      archive,
      version,
      { commit: fixture.commit, runId: '123', runAttempt: '3', targetState: 'published' },
      '12.0.1',
    ),
    /npm CLI must be exactly 12\.0\.2/u,
  )
})

test('publication CLI atomically writes the secret-free receipt with owner-only permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpha-npm-receipt-cli-test-'))
  const fixture = provenanceFixture({ attestedAttempt: '2' })
  const paths = Object.fromEntries(
    ['metadata', 'archive', 'attestations', 'audit', 'bootstrap', 'receipt']
      .map(name => [name, join(root, `${name}.json`)]),
  )
  paths.archive = join(root, 'package.tgz')
  try {
    await Promise.all([
      writeFile(paths.metadata, JSON.stringify({
        ...fixture.metadata,
        'dist-tags': { latest: '0.1.0', next: version },
      })),
      writeFile(paths.archive, archive),
      writeFile(paths.attestations, JSON.stringify(fixture.attestations)),
      writeFile(paths.audit, JSON.stringify(fixture.audit)),
      writeFile(paths.bootstrap, JSON.stringify({
        'dist-tags': { latest: '0.1.0', next: '0.2.0-alpha.0' },
      })),
    ])
    await execFileAsync(process.execPath, [
      fileURLToPath(new URL('./verify-alpha-npm-publication.mjs', import.meta.url)),
      '--metadata-json', paths.metadata,
      '--archive', paths.archive,
      '--version', version,
      '--mode', 'publication',
      '--attestations-json', paths.attestations,
      '--audit-json', paths.audit,
      '--bootstrap-metadata-json', paths.bootstrap,
      '--commit', fixture.commit,
      '--run-id', '123',
      '--run-attempt', '2',
      '--target-state', 'missing',
      '--npm-version', '12.0.2',
      '--receipt', paths.receipt,
    ])
    const receipt = JSON.parse(await readFile(paths.receipt, 'utf8'))
    assert.equal(receipt.receiptId, 'DSH-CENTER-NPM-PROVENANCE')
    assert.equal(receipt.audit.verdict, 'passed')
    if (process.platform !== 'win32') assert.equal((await stat(paths.receipt)).mode & 0o777, 0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects SLSA identity drift and an incomplete npm signature audit', () => {
  const subjectDrift = provenanceFixture({ subjectDigest: '0'.repeat(128) })
  assert.throws(() => validateFixture(subjectDrift), /exact npm archive/u)

  const repositoryDrift = provenanceFixture({ repository: 'https://github.com/example/other' })
  assert.throws(() => validateFixture(repositoryDrift), /protected main/u)

  const payloadTypeDrift = provenanceFixture()
  payloadTypeDrift.attestations.attestations[0].bundle.dsseEnvelope.payloadType = 'application/json'
  assert.throws(() => validateFixture(payloadTypeDrift), /in-toto JSON/u)

  const extraDependency = provenanceFixture({ extraDependency: true })
  assert.throws(() => validateFixture(extraDependency), /protected main/u)

  const invalidAudit = provenanceFixture()
  invalidAudit.audit.invalid.push({ name: 'dsh-plugin-extension-center', version })
  assert.throws(() => validateFixture(invalidAudit), /did not verify/u)

  const missingAudit = provenanceFixture()
  missingAudit.audit.missing.push({ name: 'dsh-plugin-extension-center', version })
  assert.throws(() => validateFixture(missingAudit), /did not verify/u)

  const duplicateAuditBundle = provenanceFixture()
  duplicateAuditBundle.audit.verified[0].attestationBundles.push(
    duplicateAuditBundle.audit.verified[0].attestationBundles[0],
  )
  assert.throws(() => validateFixture(duplicateAuditBundle), /did not verify/u)
})

function validateFixture(fixture) {
  return validateAlphaNpmProvenance(
    fixture.metadata,
    fixture.attestations,
    fixture.audit,
    archive,
    version,
    { commit: fixture.commit, runId: '123', runAttempt: '2', targetState: 'missing' },
  )
}

function provenanceFixture({
  attestedAttempt = '2',
  extraDependency = false,
  repository = 'https://github.com/striveh/dsh-plugin-extension-center',
  subjectDigest = createHash('sha512').update(archive).digest('hex'),
} = {}) {
  const commit = 'a'.repeat(40)
  const predicateType = 'https://slsa.dev/provenance/v1'
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/dsh-plugin-extension-center@${version}`
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{
      name: `pkg:npm/dsh-plugin-extension-center@${version}`,
      digest: { sha512: subjectDigest },
    }],
    predicateType,
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            ref: 'refs/heads/main',
            repository,
            path: '.github/workflows/npm-publish.yml',
          },
        },
        internalParameters: { github: { event_name: 'workflow_dispatch' } },
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/striveh/dsh-plugin-extension-center@refs/heads/main',
            digest: { gitCommit: commit },
          },
          ...(extraDependency ? [{ uri: 'git+https://github.com/example/other@refs/heads/main' }] : []),
        ],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
        metadata: {
          invocationId: `https://github.com/striveh/dsh-plugin-extension-center/actions/runs/123/attempts/${attestedAttempt}`,
        },
      },
    },
  }
  const bundle = {
    mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3',
    verificationMaterial: {},
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
      signatures: [{ sig: 'fixture' }],
    },
  }
  const metadataValue = {
    ...metadata(),
    'dist.attestations': { url, provenance: { predicateType } },
  }
  const provenance = {
    predicateType,
    bundle,
    signedAccessSignatureUrl: 'https://registry.npmjs.org/-/npm/v1/attestations/signature/fixture',
  }
  return {
    commit,
    metadata: metadataValue,
    attestations: { attestations: [provenance] },
    audit: {
      invalid: [],
      missing: [],
      verified: [{
        name: 'dsh-plugin-extension-center',
        version,
        attestations: {
          url,
          provenance: { predicateType },
        },
        attestationBundles: [provenance],
      }],
    },
  }
}
