import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { canonicalJson, canonicalSha256 } from '../full-p0/receipt-binding.mjs'

export const DSH_VERSION = '0.1.2-alpha.1'
export const DSH_TAG = 'dsh-v0.1.2-alpha.1'
export const DSH_COMMIT = 'cd5ef8148158c3a752a658978873241fdf8e2bbc'
export const CENTER_REPOSITORY = 'striveh/dsh-plugin-extension-center'
export const LIFECYCLE_WORKFLOW = '.github/workflows/official-alpha-wiki-lifecycle.yml'
export const ACCEPTANCE_ID = 'P0-OFFICIAL-ALPHA-WIKI-SKILL-LIFECYCLE'
export const WIKI_V1_REF = 'skill:microsoft-skills/wiki-page-writer@6142f8e60ac58372845c0fcdd2dbf043cd1bb698'
export const WIKI_V2_REF = 'skill:microsoft-skills/wiki-page-writer@67ae723a23ba880e3e5c8a3e5e2320092024476e'
export const WIKI_V1_INTEGRITY = 'sha256:7929f8adf896dbbf1fd744493f643c55a6812f0418d6cd89b3284f8f924d0c8f'
export const WIKI_V2_INTEGRITY = 'sha256:f1270ea4123116e846bf2dc7a53a9e396ed43d694cdb7be22b9a35da9a40feb6'

const COMMIT = /^[0-9a-f]{40}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const OPERATION_ID = /^operation:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MANAGED_REVISION = /^center:[1-9][0-9]*$/u
const CONFIGURATION_INITIAL_DIGEST = canonicalSha256({ modelInvocable: true, userInvocable: true, projectRoot: null })
const CONFIGURATION_CONFIGURED_DIGEST = canonicalSha256({ modelInvocable: true, userInvocable: false, projectRoot: null })
const NOT_PROVEN = Object.freeze([
  'ordinary-user-registry-installation',
  'public-catalog-deployment',
])
const EXPECTED_SEQUENCE = Object.freeze([
  Object.freeze({ action: 'install', candidateRef: WIKI_V1_REF, materialIntegrity: WIKI_V1_INTEGRITY, userInvocable: true, configurationPreserved: false }),
  Object.freeze({ action: 'configure', candidateRef: WIKI_V1_REF, materialIntegrity: WIKI_V1_INTEGRITY, userInvocable: false, configurationPreserved: false }),
  Object.freeze({ action: 'update', candidateRef: WIKI_V2_REF, materialIntegrity: WIKI_V2_INTEGRITY, userInvocable: false, configurationPreserved: true }),
  Object.freeze({ action: 'uninstall', candidateRef: WIKI_V2_REF, materialIntegrity: WIKI_V2_INTEGRITY, userInvocable: null, configurationPreserved: false }),
  Object.freeze({ action: 'restore', candidateRef: WIKI_V2_REF, materialIntegrity: WIKI_V2_INTEGRITY, userInvocable: false, configurationPreserved: true }),
  Object.freeze({ action: 'uninstall', candidateRef: WIKI_V2_REF, materialIntegrity: WIKI_V2_INTEGRITY, userInvocable: null, configurationPreserved: false }),
])
const FORBIDDEN_KEY = /(?:authorization|cookie|credential|diagnostic|home|password|path|private|secret|stderr|stdout|token|workspace)/iu
const FORBIDDEN_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+|\/Users\/|\/home\/runner\/|github_pat_|gh[opsu]_|npm_[A-Za-z0-9])/iu

export class AlphaLifecycleFailure extends Error {
  constructor(code, message, cause) {
    super(`[${code}] ${message}`, cause === undefined ? undefined : { cause })
    this.name = 'AlphaLifecycleFailure'
    this.code = code
  }
}

/** Parse the exact source, catalog, TLS, run, and receipt coordinates accepted by the development producer. */
export function parseAlphaLifecycleArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (typeof key !== 'string' || !key.startsWith('--') || value === undefined || values.has(key.slice(2))) {
      throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-ARGUMENT', 'expected unique --name value arguments')
    }
    values.set(key.slice(2), value)
  }
  const one = name => {
    const value = values.get(name)
    if (value === undefined) throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-ARGUMENT', `missing --${name}`)
    values.delete(name)
    return value
  }
  const path = name => {
    const value = one(name)
    if (!isAbsolute(value)) throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-PATH', `--${name} must be absolute`)
    return resolve(value)
  }
  const centerCommit = one('center-commit')
  if (!COMMIT.test(centerCommit)) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-CENTER-COMMIT', 'Center commit must be one lowercase Git commit')
  }
  const runId = positiveInteger(one('run-id'), 'run id')
  const runAttempt = positiveInteger(one('run-attempt'), 'run attempt')
  const result = Object.freeze({
    dshSourceRoot: path('dsh-source-root'),
    centerSourceRoot: path('center-source-root'),
    centerCommit,
    catalogPath: path('catalog'),
    catalogEvidencePath: path('catalog-evidence'),
    tlsCertificatePath: path('tls-certificate'),
    tlsPrivateKeyPath: path('tls-private-key'),
    receiptPath: path('receipt'),
    runId,
    runAttempt,
  })
  if (values.size > 0) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-ARGUMENT', `unsupported --${values.keys().next().value}`)
  }
  return result
}

/** Build the only receipt admitted by the entry-changing alpha catalog gate. */
export function createAlphaLifecycleReceipt(input) {
  if (!COMMIT.test(input.centerCommit ?? '') || input.officialDshSourceUnmodified !== true
    || !SHA256.test(input.officialDshSourceTreeDigest ?? '')
    || !SHA256.test(input.officialDshEntrypointDigest ?? '')
    || !SHA256.test(input.centerPackageDigest ?? '')
    || input.activeCandidateAbsent !== true || !Number.isSafeInteger(input.runId) || input.runId < 1
    || !Number.isSafeInteger(input.runAttempt) || input.runAttempt < 1) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-RECEIPT', 'source, run, or final-inventory evidence is incomplete')
  }
  const catalog = validateCatalogCoordinates(input.catalog)
  const operations = validateOperationSequence(input.operations)
  const body = {
    schemaVersion: 2,
    acceptanceId: ACCEPTANCE_ID,
    status: 'passed',
    p0Status: 'not-proven-development',
    target: {
      dshVersion: DSH_VERSION,
      dshTag: DSH_TAG,
      dshCommit: DSH_COMMIT,
      officialDshSourceUnmodified: true,
      officialDshSourceTreeDigest: input.officialDshSourceTreeDigest,
      officialDshEntrypointDigest: input.officialDshEntrypointDigest,
      centerSourceCommit: input.centerCommit,
      centerPackageDigest: input.centerPackageDigest,
      catalogRevision: catalog.revision,
      catalogDocumentDigest: catalog.documentDigest,
      catalogEntriesDigest: catalog.entriesDigest,
      catalogObservedAt: catalog.observedAt,
      catalogIssuedAt: catalog.issuedAt,
      catalogExpiresAt: catalog.expiresAt,
    },
    run: {
      repository: CENTER_REPOSITORY,
      workflow: LIFECYCLE_WORKFLOW,
      ref: 'refs/heads/main',
      commit: input.centerCommit,
      runId: input.runId,
      runAttempt: input.runAttempt,
    },
    sequence: operations,
    activeCandidateAbsent: true,
    notProven: [...NOT_PROVEN],
  }
  const receipt = deepFreeze({ ...body, receiptDigest: canonicalSha256(body) })
  assertSecretFreeAlphaLifecycleReceipt(receipt)
  return receipt
}

/** Reject extra fields, synthetic sequence claims, credentials, and local-machine values. */
export function assertSecretFreeAlphaLifecycleReceipt(value) {
  const receipt = exactRecord(value, 'receipt', [
    'acceptanceId', 'activeCandidateAbsent', 'notProven', 'p0Status', 'receiptDigest',
    'run', 'schemaVersion', 'sequence', 'status', 'target',
  ])
  const { receiptDigest, ...body } = receipt
  if (receipt.schemaVersion !== 2 || receipt.acceptanceId !== ACCEPTANCE_ID
    || receipt.status !== 'passed' || receipt.p0Status !== 'not-proven-development'
    || receipt.activeCandidateAbsent !== true || !sameList(receipt.notProven, NOT_PROVEN)
    || !SHA256.test(receiptDigest ?? '') || canonicalSha256(body) !== receiptDigest) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-RECEIPT', 'receipt identity or self-digest is invalid')
  }
  const target = exactRecord(receipt.target, 'receipt target', [
    'catalogDocumentDigest', 'catalogEntriesDigest', 'catalogExpiresAt', 'catalogIssuedAt',
    'catalogObservedAt', 'catalogRevision', 'centerPackageDigest', 'centerSourceCommit', 'dshCommit',
    'dshTag', 'dshVersion', 'officialDshEntrypointDigest', 'officialDshSourceTreeDigest',
    'officialDshSourceUnmodified',
  ])
  const run = exactRecord(receipt.run, 'receipt run', ['commit', 'ref', 'repository', 'runAttempt', 'runId', 'workflow'])
  validateCatalogCoordinates({
    revision: target.catalogRevision,
    documentDigest: target.catalogDocumentDigest,
    entriesDigest: target.catalogEntriesDigest,
    observedAt: target.catalogObservedAt,
    issuedAt: target.catalogIssuedAt,
    expiresAt: target.catalogExpiresAt,
  })
  if (target.dshVersion !== DSH_VERSION || target.dshTag !== DSH_TAG || target.dshCommit !== DSH_COMMIT
    || target.officialDshSourceUnmodified !== true || !COMMIT.test(target.centerSourceCommit ?? '')
    || !SHA256.test(target.officialDshSourceTreeDigest ?? '')
    || !SHA256.test(target.officialDshEntrypointDigest ?? '')
    || !SHA256.test(target.centerPackageDigest ?? '')
    || run.repository !== CENTER_REPOSITORY || run.workflow !== LIFECYCLE_WORKFLOW
    || run.ref !== 'refs/heads/main' || run.commit !== target.centerSourceCommit
    || !Number.isSafeInteger(run.runId) || run.runId < 1
    || !Number.isSafeInteger(run.runAttempt) || run.runAttempt < 1) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-RECEIPT', 'receipt target or protected-main run identity is invalid')
  }
  validateOperationSequence(receipt.sequence)
  visitReceipt(receipt)
  return receipt
}

/** Atomically write one canonical owner-only receipt after every runtime check has passed. */
export async function writeAlphaLifecycleReceipt(path, receipt) {
  assertSecretFreeAlphaLifecycleReceipt(receipt)
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`, 'utf8')
  if (bytes.length > 64 * 1024) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-RECEIPT', 'receipt exceeds its byte bound')
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length
    || process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-RECEIPT', 'written receipt is not one owner-only regular file')
  }
}

function validateCatalogCoordinates(value) {
  const catalog = exactRecord(value, 'catalog coordinates', [
    'documentDigest', 'entriesDigest', 'expiresAt', 'issuedAt', 'observedAt', 'revision',
  ])
  if (catalog.revision !== 12 || !SHA256.test(catalog.documentDigest ?? '')
    || !SHA256.test(catalog.entriesDigest ?? '')) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-CATALOG', 'catalog revision or digest is invalid')
  }
  for (const [field, timestamp] of [
    ['observedAt', catalog.observedAt], ['issuedAt', catalog.issuedAt], ['expiresAt', catalog.expiresAt],
  ]) {
    const parsed = Date.parse(timestamp)
    if (typeof timestamp !== 'string' || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
      throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-CATALOG', `catalog ${field} is not canonical`)
    }
  }
  if (Date.parse(catalog.observedAt) > Date.parse(catalog.issuedAt)
    || Date.parse(catalog.issuedAt) >= Date.parse(catalog.expiresAt)) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-CATALOG', 'catalog validity interval is invalid')
  }
  return catalog
}

function validateOperationSequence(value) {
  if (!Array.isArray(value) || value.length !== EXPECTED_SEQUENCE.length) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-SEQUENCE', 'receipt must contain the exact six lifecycle operations')
  }
  const operations = value.map((entry, index) => {
    const operation = exactRecord(entry, `operation ${String(index + 1)}`, [
      'action', 'afterDigest', 'beforeDigest', 'candidateRef', 'configurationPreserved',
      'configurationRevision', 'externalRuntimeAction', 'inventoryRevision', 'journalEventCount',
      'journalHeadDigest', 'managedRevision', 'materialIntegrity', 'mutationDigests',
      'observedCandidateRef', 'operationId', 'ownerEvidenceDigest', 'ownerRevisionDigest',
      'ownerStateVerified', 'planHash', 'receiptDigest', 'sequence', 'status',
      'userInvocable', 'verificationDigests',
    ])
    const expected = EXPECTED_SEQUENCE[index]
    const expectedConfigurationRevision = expected.action === 'install'
      ? CONFIGURATION_INITIAL_DIGEST
      : ['configure', 'update', 'restore'].includes(expected.action)
        ? CONFIGURATION_CONFIGURED_DIGEST
        : null
    const expectedRuntimeAction = ['install', 'update'].includes(expected.action) ? 'download' : 'none'
    if (operation.sequence !== index + 1 || operation.action !== expected.action
      || operation.userInvocable !== expected.userInvocable
      || operation.configurationPreserved !== expected.configurationPreserved
      || operation.status !== 'committed' || operation.ownerStateVerified !== true
      || operation.candidateRef !== expected.candidateRef
      || operation.observedCandidateRef !== expected.candidateRef
      || operation.materialIntegrity !== expected.materialIntegrity
      || operation.externalRuntimeAction !== expectedRuntimeAction
      || operation.configurationRevision !== expectedConfigurationRevision
      || !OPERATION_ID.test(operation.operationId ?? '')
      || !MANAGED_REVISION.test(operation.managedRevision ?? '')
      || !Number.isSafeInteger(operation.journalEventCount) || operation.journalEventCount < 2
      || !SHA256.test(operation.planHash ?? '') || !SHA256.test(operation.receiptDigest ?? '')
      || !SHA256.test(operation.beforeDigest ?? '') || !SHA256.test(operation.afterDigest ?? '')
      || !SHA256.test(operation.journalHeadDigest ?? '') || !SHA256.test(operation.inventoryRevision ?? '')
      || !SHA256.test(operation.ownerRevisionDigest ?? '') || !SHA256.test(operation.ownerEvidenceDigest ?? '')
      || !digestList(operation.mutationDigests) || !digestList(operation.verificationDigests)) {
      throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-SEQUENCE', `operation ${String(index + 1)} is incomplete`)
    }
    return Object.freeze({ ...operation })
  })
  if (new Set(operations.map(operation => operation.operationId)).size !== EXPECTED_SEQUENCE.length
    || new Set(operations.map(operation => operation.inventoryRevision)).size !== EXPECTED_SEQUENCE.length
    || new Set(operations.map(operation => operation.managedRevision)).size !== EXPECTED_SEQUENCE.length) {
    throw new AlphaLifecycleFailure(
      'ALPHA-LIFECYCLE-SEQUENCE',
      'receipt must expose six distinct operation, inventory, and managed revisions',
    )
  }
  return Object.freeze(operations)
}

function digestList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(digest => SHA256.test(digest))
}

function exactRecord(value, subject, fields) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-RECEIPT', `${subject} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-RECEIPT', `${subject} fields are invalid`)
  }
  return value
}

function visitReceipt(value, key = null) {
  if (key !== null && FORBIDDEN_KEY.test(key)) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-RECEIPT', `receipt contains forbidden field ${key}`)
  }
  if (typeof value === 'string' && FORBIDDEN_VALUE.test(value)) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-RECEIPT', 'receipt contains a credential-like or local-machine value')
  }
  if (Array.isArray(value)) {
    for (const child of value) visitReceipt(child)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [childKey, child] of Object.entries(value)) visitReceipt(child, childKey)
  }
}

function sameList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index])
}

function positiveInteger(value, subject) {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-ARGUMENT', `${subject} must be a positive decimal integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new AlphaLifecycleFailure('ALPHA-LIFECYCLE-ARGUMENT', `${subject} exceeds the safe integer range`)
  }
  return parsed
}

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
