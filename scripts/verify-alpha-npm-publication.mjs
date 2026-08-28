#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseYaml } from 'yaml'

const PACKAGE_NAME = 'dsh-plugin-extension-center'
const BOOTSTRAP_VERSION = '0.2.0-alpha.0'
const ALPHA_VERSION = /^0\.2\.0-alpha\.(?:0|[1-9][0-9]*)$/u
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
const SRI = /^sha512-[A-Za-z0-9+/]+={0,2}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const SHA512_HEX = /^sha512:[0-9a-f]{128}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const GITHUB_NUMBER = /^[1-9][0-9]{0,19}$/u
const REPOSITORY = 'striveh/dsh-plugin-extension-center'
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`
const WORKFLOW_PATH = '.github/workflows/npm-publish.yml'
const PROVENANCE_PREDICATE = 'https://slsa.dev/provenance/v1'
const GITHUB_ACTIONS_BUILD_TYPE = 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1'
const TRUSTED_NPM_VERSION = '12.0.2'

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`alpha-npm-publication: ${label} must be an object`)
  }
  return value
}

/** Validate registry integrity and the next dist-tag against the exact published archive bytes. */
export function validateAlphaNpmPublication(metadataValue, tagsValue, archiveBytes, version, expectedNext = version) {
  const result = validateAlphaNpmArchive(metadataValue, archiveBytes, version)
  const tags = record(tagsValue, 'npm dist-tags')
  if (!ALPHA_VERSION.test(expectedNext ?? '') || tags.next !== expectedNext
    || tags.latest !== undefined && !STABLE_VERSION.test(tags.latest)) {
    throw new Error('alpha-npm-publication: next does not select the alpha exclusively')
  }
  return result
}

/** Require the default stable channel to remain unchanged across an alpha publication. */
export function assertAlphaLatestUnchanged(beforeValue, afterValue) {
  const before = record(beforeValue, 'prepublication npm dist-tags')
  const after = record(afterValue, 'postpublication npm dist-tags')
  if (before.latest !== after.latest
    || before.latest !== undefined && !STABLE_VERSION.test(before.latest)
    || after.latest !== undefined && !STABLE_VERSION.test(after.latest)) {
    throw new Error('alpha-npm-publication: latest changed during alpha publication')
  }
}

/** Validate registry metadata against exact archive bytes without requiring a mutable dist-tag. */
export function validateAlphaNpmArchive(metadataValue, archiveBytes, version) {
  const metadata = record(metadataValue, 'npm metadata')
  if (!(archiveBytes instanceof Uint8Array) || !ALPHA_VERSION.test(version ?? '')) {
    throw new Error('alpha-npm-publication: expected one Center alpha archive')
  }
  const integrity = metadata['dist.integrity'] ?? metadata.dist?.integrity
  const tarball = metadata['dist.tarball'] ?? metadata.dist?.tarball
  const expectedIntegrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`
  const expectedTarball = `https://registry.npmjs.org/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${version}.tgz`
  if (metadata.name !== PACKAGE_NAME || metadata.version !== version
    || !SRI.test(integrity ?? '') || integrity !== expectedIntegrity || tarball !== expectedTarball) {
    throw new Error('alpha-npm-publication: registry metadata does not bind the exact published archive')
  }
  return Object.freeze({ packageName: PACKAGE_NAME, version, integrity })
}

/** Classify a target version as missing or already published with the exact CI archive bytes. */
export function classifyAlphaNpmTarget(metadataValue, archiveBytes, version) {
  const metadata = record(metadataValue, 'npm metadata')
  if (!(archiveBytes instanceof Uint8Array) || !ALPHA_VERSION.test(version ?? '')) {
    throw new Error('alpha-npm-publication: expected one Center alpha archive')
  }
  if (metadata.error?.code === 'E404') return Object.freeze({ status: 'missing' })
  const publication = validateAlphaNpmArchive(metadata, archiveBytes, version)
  return Object.freeze({ status: 'published', ...publication })
}

/** Bind one cryptographically audited npm provenance bundle to this workflow invocation and archive. */
export function validateAlphaNpmProvenance(
  metadataValue,
  attestationsValue,
  auditValue,
  archiveBytes,
  version,
  invocation,
) {
  const publication = validateAlphaNpmArchive(metadataValue, archiveBytes, version)
  const metadata = record(metadataValue, 'npm metadata')
  const attestations = record(attestationsValue, 'npm attestations')
  const audit = record(auditValue, 'npm signature audit')
  const commit = invocation?.commit
  const runId = invocation?.runId
  const runAttempt = invocation?.runAttempt
  const targetState = invocation?.targetState
  if (!/^[0-9a-f]{40}$/u.test(commit ?? '') || !GITHUB_NUMBER.test(runId ?? '')
    || !GITHUB_NUMBER.test(runAttempt ?? '') || !['missing', 'published'].includes(targetState)) {
    throw new Error('alpha-npm-publication: workflow invocation identity is invalid')
  }
  const expectedAttestationsUrl = `https://registry.npmjs.org/-/npm/v1/attestations/${PACKAGE_NAME}@${version}`
  const metadataAttestations = record(
    metadata['dist.attestations'] ?? metadata.dist?.attestations,
    'npm attestation metadata',
  )
  if (metadataAttestations.url !== expectedAttestationsUrl
    || metadataAttestations.provenance?.predicateType !== PROVENANCE_PREDICATE) {
    throw new Error('alpha-npm-publication: registry metadata does not select exact SLSA provenance')
  }
  const provenanceMatches = list(attestations.attestations, 'npm attestation list')
    .filter(attestation => attestation?.predicateType === PROVENANCE_PREDICATE)
  if (provenanceMatches.length !== 1) {
    throw new Error('alpha-npm-publication: registry does not expose one SLSA provenance bundle')
  }
  const provenance = record(provenanceMatches[0], 'SLSA provenance attestation')
  const bundle = record(provenance.bundle, 'SLSA provenance bundle')
  const envelope = record(bundle.dsseEnvelope, 'SLSA DSSE envelope')
  const statement = decodeStatement(envelope.payload)
  const expectedSubject = `pkg:npm/${PACKAGE_NAME}@${version}`
  const subjects = list(statement.subject, 'SLSA subjects')
  const expectedDigest = createHash('sha512').update(archiveBytes).digest('hex')
  if (envelope.payloadType !== 'application/vnd.in-toto+json') {
    throw new Error('alpha-npm-publication: SLSA DSSE envelope is not in-toto JSON')
  }
  if (statement._type !== 'https://in-toto.io/Statement/v1'
    || statement.predicateType !== PROVENANCE_PREDICATE || subjects.length !== 1
    || subjects[0]?.name !== expectedSubject || subjects[0]?.digest?.sha512 !== expectedDigest) {
    throw new Error('alpha-npm-publication: SLSA subject does not bind the exact npm archive')
  }
  const predicate = record(statement.predicate, 'SLSA predicate')
  const buildDefinition = record(predicate.buildDefinition, 'SLSA build definition')
  const workflow = buildDefinition.externalParameters?.workflow
  const expectedDependency = `git+${REPOSITORY_URL}@refs/heads/main`
  const dependencies = list(buildDefinition.resolvedDependencies, 'SLSA resolved dependencies')
  if (buildDefinition.buildType !== GITHUB_ACTIONS_BUILD_TYPE
    || workflow?.repository !== REPOSITORY_URL || workflow?.path !== WORKFLOW_PATH
    || workflow?.ref !== 'refs/heads/main'
    || buildDefinition.internalParameters?.github?.event_name !== 'workflow_dispatch'
    || dependencies.length !== 1
    || dependencies.filter(dependency => dependency?.uri === expectedDependency
      && dependency?.digest?.gitCommit === commit).length !== 1) {
    throw new Error('alpha-npm-publication: SLSA build identity does not bind protected main')
  }
  const runDetails = record(predicate.runDetails, 'SLSA run details')
  const invocationPrefix = `${REPOSITORY_URL}/actions/runs/${runId}/attempts/`
  const invocationId = runDetails.metadata?.invocationId
  const attestedAttempt = typeof invocationId === 'string' && invocationId.startsWith(invocationPrefix)
    ? invocationId.slice(invocationPrefix.length)
    : ''
  const attemptMatches = GITHUB_NUMBER.test(attestedAttempt)
    && (targetState === 'missing'
      ? attestedAttempt === runAttempt
      : BigInt(attestedAttempt) <= BigInt(runAttempt))
  if (runDetails.builder?.id !== 'https://github.com/actions/runner/github-hosted' || !attemptMatches) {
    throw new Error('alpha-npm-publication: SLSA invocation does not bind this publication run')
  }
  const invalid = list(audit.invalid, 'npm signature audit invalid list')
  const missing = list(audit.missing, 'npm signature audit missing list')
  const verified = list(audit.verified, 'npm signature audit verified list')
  const targetAudits = verified.filter(entry => entry?.name === PACKAGE_NAME && entry?.version === version)
  const auditedBundles = Array.isArray(targetAudits[0]?.attestationBundles)
    ? targetAudits[0].attestationBundles.filter(candidate => candidate?.predicateType === PROVENANCE_PREDICATE)
    : []
  if (invalid.length !== 0 || missing.length !== 0 || targetAudits.length !== 1
    || auditedBundles.length !== 1
    || targetAudits[0]?.attestations?.url !== expectedAttestationsUrl
    || targetAudits[0]?.attestations?.provenance?.predicateType !== PROVENANCE_PREDICATE
    || !isDeepStrictEqual(auditedBundles[0], provenance)) {
    throw new Error('alpha-npm-publication: npm signature audit did not verify the exact provenance bundle')
  }
  return Object.freeze({ ...publication, invocationId })
}

/** Build a deterministic, secret-free receipt for one verified npm provenance bundle. */
export function createAlphaNpmProvenanceReceipt(
  metadataValue,
  attestationsValue,
  auditValue,
  archiveBytes,
  version,
  invocation,
  npmVersion,
) {
  if (npmVersion !== TRUSTED_NPM_VERSION) {
    throw new Error(`alpha-npm-publication: npm CLI must be exactly ${TRUSTED_NPM_VERSION}`)
  }
  const validation = validateAlphaNpmProvenance(
    metadataValue,
    attestationsValue,
    auditValue,
    archiveBytes,
    version,
    invocation,
  )
  const metadata = record(metadataValue, 'npm metadata')
  const attestations = record(attestationsValue, 'npm attestations')
  const provenance = list(attestations.attestations, 'npm attestation list')
    .filter(attestation => attestation?.predicateType === PROVENANCE_PREDICATE)[0]
  const bundle = record(provenance.bundle, 'SLSA provenance bundle')
  const invocationPrefix = `${REPOSITORY_URL}/actions/runs/${invocation.runId}/attempts/`
  const publicationAttempt = validation.invocationId.slice(invocationPrefix.length)
  const tarballUrl = metadata['dist.tarball'] ?? metadata.dist?.tarball
  const body = {
    schemaVersion: 1,
    receiptId: 'DSH-CENTER-NPM-PROVENANCE',
    status: 'passed',
    package: {
      name: PACKAGE_NAME,
      version,
      integrity: validation.integrity,
      tarballUrl,
      tarballSha256: `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`,
      tarballSha512: `sha512:${createHash('sha512').update(archiveBytes).digest('hex')}`,
    },
    provenance: {
      predicateType: PROVENANCE_PREDICATE,
      attestationUrl: `https://registry.npmjs.org/-/npm/v1/attestations/${PACKAGE_NAME}@${version}`,
      bundleDigest: canonicalSha256(bundle),
      bundleDigestAlgorithm: 'sha256-canonical-json',
      repository: REPOSITORY_URL,
      workflow: WORKFLOW_PATH,
      ref: 'refs/heads/main',
      commit: invocation.commit,
    },
    publication: {
      runId: invocation.runId,
      runAttempt: publicationAttempt,
      invocationId: validation.invocationId,
    },
    verification: {
      runId: invocation.runId,
      runAttempt: invocation.runAttempt,
    },
    audit: {
      command: 'npm audit signatures --json --include-attestations',
      npmVersion,
      verdict: 'passed',
      invalidCount: 0,
      missingCount: 0,
      targetVerified: true,
      provenanceBundleMatched: true,
    },
  }
  return deepFreeze({ ...body, receiptDigest: canonicalSha256(body) })
}

/**
 * Verify the exact self-contained projection emitted after npm provenance and
 * signature audit verification.
 *
 * This verifies the receipt schema and its internal cryptographic bindings. It
 * does not replace fetching the registry metadata, provenance bundle, and
 * audit result in the producer that calls {@link createAlphaNpmProvenanceReceipt}.
 */
export function verifyAlphaNpmProvenanceReceipt(value) {
  const receipt = exactRecord(value, 'npm provenance receipt', [
    'audit', 'package', 'provenance', 'publication', 'receiptDigest', 'receiptId',
    'schemaVersion', 'status', 'verification',
  ])
  const { receiptDigest, ...body } = receipt
  if (receipt.schemaVersion !== 1 || receipt.receiptId !== 'DSH-CENTER-NPM-PROVENANCE'
    || receipt.status !== 'passed' || !SHA256.test(receiptDigest ?? '')
    || receiptDigest !== canonicalSha256(body)) {
    throw new Error('alpha-npm-publication: provenance receipt identity or digest is invalid')
  }

  const packageIdentity = exactRecord(receipt.package, 'npm provenance package', [
    'integrity', 'name', 'tarballSha256', 'tarballSha512', 'tarballUrl', 'version',
  ])
  if (packageIdentity.name !== PACKAGE_NAME || !ALPHA_VERSION.test(packageIdentity.version ?? '')
    || !SRI.test(packageIdentity.integrity ?? '') || !SHA256.test(packageIdentity.tarballSha256 ?? '')
    || !SHA512_HEX.test(packageIdentity.tarballSha512 ?? '')
    || packageIdentity.tarballUrl
      !== `https://registry.npmjs.org/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${packageIdentity.version}.tgz`) {
    throw new Error('alpha-npm-publication: provenance receipt package identity is invalid')
  }
  const sha512Bytes = Buffer.from(packageIdentity.tarballSha512.slice('sha512:'.length), 'hex')
  if (packageIdentity.integrity !== `sha512-${sha512Bytes.toString('base64')}`) {
    throw new Error('alpha-npm-publication: provenance receipt integrity and SHA-512 differ')
  }

  const provenance = exactRecord(receipt.provenance, 'npm provenance identity', [
    'attestationUrl', 'bundleDigest', 'bundleDigestAlgorithm', 'commit', 'predicateType',
    'ref', 'repository', 'workflow',
  ])
  if (provenance.predicateType !== PROVENANCE_PREDICATE
    || provenance.attestationUrl
      !== `https://registry.npmjs.org/-/npm/v1/attestations/${PACKAGE_NAME}@${packageIdentity.version}`
    || !SHA256.test(provenance.bundleDigest ?? '')
    || provenance.bundleDigestAlgorithm !== 'sha256-canonical-json'
    || provenance.repository !== REPOSITORY_URL || provenance.workflow !== WORKFLOW_PATH
    || provenance.ref !== 'refs/heads/main' || !COMMIT.test(provenance.commit ?? '')) {
    throw new Error('alpha-npm-publication: provenance receipt source identity is invalid')
  }

  const publication = exactRecord(receipt.publication, 'npm publication run', [
    'invocationId', 'runAttempt', 'runId',
  ])
  const verification = exactRecord(receipt.verification, 'npm verification run', ['runAttempt', 'runId'])
  if (!GITHUB_NUMBER.test(publication.runId ?? '') || !GITHUB_NUMBER.test(publication.runAttempt ?? '')
    || !GITHUB_NUMBER.test(verification.runId ?? '') || !GITHUB_NUMBER.test(verification.runAttempt ?? '')
    || publication.runId !== verification.runId
    || BigInt(publication.runAttempt) > BigInt(verification.runAttempt)
    || publication.invocationId
      !== `${REPOSITORY_URL}/actions/runs/${publication.runId}/attempts/${publication.runAttempt}`) {
    throw new Error('alpha-npm-publication: provenance receipt run identity is invalid')
  }

  const audit = exactRecord(receipt.audit, 'npm provenance audit', [
    'command', 'invalidCount', 'missingCount', 'npmVersion', 'provenanceBundleMatched',
    'targetVerified', 'verdict',
  ])
  if (audit.command !== 'npm audit signatures --json --include-attestations'
    || audit.npmVersion !== TRUSTED_NPM_VERSION || audit.verdict !== 'passed'
    || audit.invalidCount !== 0 || audit.missingCount !== 0
    || audit.targetVerified !== true || audit.provenanceBundleMatched !== true) {
    throw new Error('alpha-npm-publication: provenance receipt audit verdict is invalid')
  }
  return Object.freeze({
    receiptDigest,
    package: Object.freeze({ ...packageIdentity }),
    sourceCommit: provenance.commit,
    publication: Object.freeze({ ...publication }),
    verification: Object.freeze({ ...verification }),
    provenanceBundleDigest: provenance.bundleDigest,
  })
}

/** Validate that the immutable alpha.0 predecessor installed from the same verified registry bytes. */
export function validateAlphaBootstrapInstallation(
  metadataValue,
  projectManifestValue,
  installedManifestValue,
  lockText,
  version,
) {
  const metadata = record(metadataValue, 'npm metadata')
  const projectManifest = record(projectManifestValue, 'bootstrap project manifest')
  const installedManifest = record(installedManifestValue, 'installed bootstrap manifest')
  const integrity = metadata['dist.integrity'] ?? metadata.dist?.integrity
  if (version !== BOOTSTRAP_VERSION || metadata.name !== PACKAGE_NAME || metadata.version !== version
    || !SRI.test(integrity ?? '') || projectManifest.dependencies?.[PACKAGE_NAME] !== version
    || installedManifest.name !== PACKAGE_NAME || installedManifest.version !== version
    || installedManifest.dsh?.bundle?.patch !== './cordis.patch.yml'
    || installedManifest.dsh?.client?.platform !== 'web') {
    throw new Error('alpha-npm-publication: alpha.0 bootstrap did not install as one exact Bundle')
  }
  let lock
  try {
    lock = parseYaml(lockText, { maxAliasCount: 0, uniqueKeys: true })
  } catch (cause) {
    throw new Error('alpha-npm-publication: bootstrap pnpm lockfile is not unambiguous YAML', { cause })
  }
  const importer = record(lock?.importers?.['.'], 'bootstrap lock importer')
  const dependency = record(importer.dependencies?.[PACKAGE_NAME], 'bootstrap lock dependency')
  const packages = record(lock?.packages, 'bootstrap lock packages')
  const snapshots = record(lock?.snapshots, 'bootstrap lock snapshots')
  const packageKey = `${PACKAGE_NAME}@${version}`
  const packageEntry = record(packages[packageKey], 'bootstrap lock package')
  const resolution = record(packageEntry.resolution, 'bootstrap package resolution')
  const snapshotMatches = Object.keys(snapshots).filter(key => isExactPnpmResolutionKey(key, packageKey))
  if (lock.lockfileVersion !== '9.0' || dependency.specifier !== version
    || !isExactPnpmResolution(dependency.version, version) || resolution.integrity !== integrity
    || snapshotMatches.length !== 1) {
    throw new Error('alpha-npm-publication: alpha.0 bootstrap install is not bound to registry integrity')
  }
  return Object.freeze({ packageName: PACKAGE_NAME, version, integrity })
}

function list(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`alpha-npm-publication: ${label} must be an array`)
  }
  return value
}

function exactRecord(value, label, fields) {
  const candidate = record(value, label)
  const actual = Object.keys(candidate).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`alpha-npm-publication: ${label} fields are invalid`)
  }
  return candidate
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('alpha-npm-publication: canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => {
      if (value[key] === undefined) throw new Error(`alpha-npm-publication: canonical JSON rejects undefined field ${key}`)
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    }).join(',')}}`
  }
  throw new Error(`alpha-npm-publication: canonical JSON rejects ${typeof value}`)
}

function canonicalSha256(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function decodeStatement(payload) {
  if (typeof payload !== 'string' || payload.length < 1 || payload.length > 4 * 1024 * 1024
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload)) {
    throw new Error('alpha-npm-publication: SLSA DSSE payload is not canonical base64')
  }
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.toString('base64') !== payload) {
    throw new Error('alpha-npm-publication: SLSA DSSE payload is not canonical base64')
  }
  try {
    return record(JSON.parse(bytes.toString('utf8')), 'SLSA statement')
  } catch (cause) {
    throw new Error('alpha-npm-publication: SLSA DSSE payload is not one JSON statement', { cause })
  }
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (![
      '--metadata-json', '--archive', '--version', '--mode', '--bootstrap-install-root', '--expected-next',
      '--attestations-json', '--audit-json', '--bootstrap-metadata-json', '--commit', '--run-id', '--run-attempt',
      '--target-state', '--npm-version', '--receipt',
    ].includes(key)
      || value === undefined || values[key.slice(2)] !== undefined) {
      throw new Error('alpha-npm-publication: expected one exact argument set')
    }
    values[key.slice(2)] = value
  }
  const mode = values.mode ?? 'publication'
  const modeArguments = {
    archive: [],
    classify: [],
    bootstrap: ['bootstrap-install-root', 'expected-next'],
    publication: [
      'attestations-json', 'audit-json', 'bootstrap-metadata-json', 'commit', 'run-id', 'run-attempt', 'target-state',
      'npm-version', 'receipt',
    ],
  }[mode]
  if (modeArguments === undefined || ['metadata-json', 'archive', 'version', ...modeArguments]
    .some(key => values[key] === undefined)) {
    throw new Error('alpha-npm-publication: expected each required argument exactly once')
  }
  const allowed = new Set(['metadata-json', 'archive', 'version', 'mode', ...modeArguments])
  if (Object.keys(values).some(key => !allowed.has(key))) {
    throw new Error(`alpha-npm-publication: ${mode} mode received incompatible arguments`)
  }
  return { ...values, mode }
}

async function boundedFile(path, maximum, label) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
    throw new Error(`alpha-npm-publication: ${label} is not one bounded regular file`)
  }
  return await readFile(path)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const [metadataBytes, archiveBytes] = await Promise.all([
    boundedFile(resolve(options['metadata-json']), 1024 * 1024, 'metadata JSON'),
    boundedFile(resolve(options.archive), 64 * 1024 * 1024, 'package archive'),
  ])
  const metadata = parseJson(metadataBytes, 'npm response')
  if (options.mode === 'classify') {
    const classification = classifyAlphaNpmTarget(metadata, archiveBytes, options.version)
    process.stdout.write(`${classification.status}\n`)
    return
  }
  if (options.mode === 'archive') {
    const result = validateAlphaNpmArchive(metadata, archiveBytes, options.version)
    process.stdout.write(`alpha-npm-publication: ${result.packageName}@${result.version} ${result.integrity}\n`)
    return
  }
  if (options.mode === 'bootstrap') {
    const result = validateAlphaNpmPublication(
      metadata,
      metadata['dist-tags'],
      archiveBytes,
      options.version,
      options['expected-next'],
    )
    const installRoot = resolve(options['bootstrap-install-root'])
    const [projectManifestBytes, installedManifestBytes, lockBytes] = await Promise.all([
      boundedFile(join(installRoot, 'package.json'), 1024 * 1024, 'bootstrap project manifest'),
      boundedFile(join(installRoot, 'node_modules', PACKAGE_NAME, 'package.json'), 1024 * 1024, 'installed bootstrap manifest'),
      boundedFile(join(installRoot, 'pnpm-lock.yaml'), 4 * 1024 * 1024, 'bootstrap pnpm lockfile'),
    ])
    validateAlphaBootstrapInstallation(
      metadata,
      parseJson(projectManifestBytes, 'bootstrap project manifest'),
      parseJson(installedManifestBytes, 'installed bootstrap manifest'),
      lockBytes.toString('utf8'),
      options.version,
    )
    process.stdout.write(`alpha-npm-publication: ${result.packageName}@${result.version} ${result.integrity}\n`)
    return
  }
  const [attestationsBytes, auditBytes, bootstrapMetadataBytes] = await Promise.all([
    boundedFile(resolve(options['attestations-json']), 16 * 1024 * 1024, 'attestations JSON'),
    boundedFile(resolve(options['audit-json']), 16 * 1024 * 1024, 'signature audit JSON'),
    boundedFile(resolve(options['bootstrap-metadata-json']), 1024 * 1024, 'bootstrap metadata JSON'),
  ])
  const result = validateAlphaNpmPublication(
    metadata,
    metadata['dist-tags'],
    archiveBytes,
    options.version,
  )
  const bootstrapMetadata = parseJson(bootstrapMetadataBytes, 'bootstrap metadata response')
  assertAlphaLatestUnchanged(bootstrapMetadata['dist-tags'], metadata['dist-tags'])
  const provenance = validateAlphaNpmProvenance(
    metadata,
    parseJson(attestationsBytes, 'attestations response'),
    parseJson(auditBytes, 'signature audit response'),
    archiveBytes,
    options.version,
    {
      commit: options.commit,
      runId: options['run-id'],
      runAttempt: options['run-attempt'],
      targetState: options['target-state'],
    },
  )
  const receipt = createAlphaNpmProvenanceReceipt(
    metadata,
    parseJson(attestationsBytes, 'attestations response'),
    parseJson(auditBytes, 'signature audit response'),
    archiveBytes,
    options.version,
    {
      commit: options.commit,
      runId: options['run-id'],
      runAttempt: options['run-attempt'],
      targetState: options['target-state'],
    },
    options['npm-version'],
  )
  await writeReceipt(resolve(options.receipt), receipt)
  process.stdout.write(`alpha-npm-publication: ${result.packageName}@${result.version} ${result.integrity} ${provenance.invocationId}\n`)
}

async function writeReceipt(path, receipt) {
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  if (bytes.length > 64 * 1024 || receipt?.receiptDigest !== canonicalSha256(stripReceiptDigest(receipt))) {
    throw new Error('alpha-npm-publication: provenance receipt is not bounded or self-consistent')
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

function stripReceiptDigest(receipt) {
  const { receiptDigest, ...body } = record(receipt, 'provenance receipt')
  if (typeof receiptDigest !== 'string') throw new Error('alpha-npm-publication: provenance receipt digest is missing')
  return body
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    throw new Error(`alpha-npm-publication: ${label} is not JSON`, { cause })
  }
}

function isExactPnpmResolution(value, version) {
  return typeof value === 'string'
    && (value === version || value.startsWith(`${version}(`) && value.endsWith(')'))
}

function isExactPnpmResolutionKey(key, packageKey) {
  return key === packageKey || key.startsWith(`${packageKey}(`) && key.endsWith(')')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
