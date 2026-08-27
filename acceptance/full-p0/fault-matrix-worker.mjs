import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, suppliedModuleRoot, suppliedCaseRoot, suppliedPhase] = process.argv.slice(2)
if (typeof mode !== 'string' || typeof suppliedModuleRoot !== 'string' || typeof suppliedCaseRoot !== 'string') {
  throw new Error('fault matrix worker requires mode, module root, and case root')
}

const moduleRoot = resolve(suppliedModuleRoot)
const caseRoot = resolve(suppliedCaseRoot)
await mkdir(caseRoot, { recursive: true, mode: 0o700 })

const [{ canonicalSha256 }, operations, storage] = await Promise.all([
  import(pathToFileURL(join(moduleRoot, 'domain', 'index.js')).href),
  import(pathToFileURL(join(moduleRoot, 'operations', 'index.js')).href),
  import(pathToFileURL(join(moduleRoot, 'storage', 'index.js')).href),
])

const {
  createOperationJournal,
  recordOperationMutation,
  recordOperationVerification,
  transitionOperation,
} = operations
const { FileOperationStore } = storage
const phases = Object.freeze([
  'authorized',
  'staging',
  'applying',
  'verifying',
  'rolling-back',
  'committed',
  'rolled-back',
  'failed',
  'recovery-required',
])

function reviewEvidence() {
  const body = '---\nname: fault-matrix\ndescription: Fault matrix fixture\n---\nfixture\n'
  const digest = canonicalSha256(body)
  return Object.freeze({
    schemaVersion: 1,
    kind: 'skill',
    operationKind: 'configure',
    checks: Object.freeze([{ code: 'catalog-admission', phase: 'planning' }]),
    removed: Object.freeze([]),
    retained: Object.freeze([]),
    credentialChoice: 'not-applicable',
    rollbackPoint: Object.freeze({ kind: 'absent-state', id: 'absent', digest: canonicalSha256(null) }),
    rollbackLimits: Object.freeze(['dsh-managed-state-only']),
    notProven: Object.freeze(['user-task-outcome']),
    files: Object.freeze([{
      path: 'SKILL.md',
      change: 'add',
      beforeDigest: null,
      afterDigest: digest,
      sizeBytes: Buffer.byteLength(body),
      executableBefore: false,
      executableAfter: false,
      linkBefore: null,
      linkAfter: null,
    }]),
    body: Object.freeze({ before: null, after: body, beforeDigest: null, afterDigest: digest }),
    invocation: Object.freeze({
      beforeModelInvocable: null,
      beforeUserInvocable: null,
      afterModelInvocable: true,
      afterUserInvocable: true,
    }),
  })
}

function recoveryBinding() {
  const digest = canonicalSha256({ fixture: 'fault-matrix-executable' })
  const absolute = resolve(caseRoot, 'fixture-executable')
  const platform = ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'linux'
  return Object.freeze({
    schemaVersion: 5,
    executablePath: absolute,
    executableSha256: digest,
    centerRoot: caseRoot,
    packageVersion: '0.1.0-fault-matrix',
    platform,
    arch: process.arch,
    officialDsh: Object.freeze({
      schemaVersion: 2,
      packageName: '@deepseek-ai/dsh',
      packageVersion: '0.1.1-rc.2',
      packageRoot: caseRoot,
      packageTreeSha256: digest,
      productionDependencies: Object.freeze([]),
      entrypointPath: absolute,
      entrypointSha256: digest,
      hostHome: caseRoot,
      timeoutMs: 1_000,
      node: Object.freeze({
        schemaVersion: 1,
        executablePath: process.execPath,
        executableSha256: digest,
        version: process.version,
      }),
      supervisorPath: absolute,
      supervisorSha256: digest,
      pnpm: Object.freeze({
        schemaVersion: 1,
        packageName: 'pnpm',
        packageVersion: '11.7.0',
        registryIntegrity: 'sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==',
        packageRoot: caseRoot,
        packageTreeSha256: digest,
        entrypointPath: absolute,
        entrypointSha256: digest,
        shimPath: absolute,
        shimSha256: digest,
        shellPath: absolute,
        shellSha256: digest,
        runtimeRoot: caseRoot,
      }),
    }),
  })
}

function authorization(operationId) {
  const digest = canonicalSha256({ fixture: operationId })
  return Object.freeze({
    operationId,
    planId: `plan:${operationId}`,
    planHash: canonicalSha256({ plan: operationId }),
    origin: 'store',
    candidateRef: 'skill:fault-matrix@1',
    extensionKind: 'skill',
    extensionId: 'fault-matrix',
    operationKind: 'configure',
    managedObject: 'artifact',
    externalRuntimeAction: 'none',
    runtimeBinding: null,
    artifactRevision: '1.0.0',
    artifactIntegrity: digest,
    artifactUrl: 'https://example.invalid/fault-matrix.md',
    artifactSizeBytes: 1,
    desiredState: 'enabled',
    targetKey: `skill:web:user:fault-matrix-${operationId}`,
    ownerKey: 'skills',
    scopeKey: 'user',
    profileId: 'web',
    idempotencyKey: canonicalSha256({ idempotency: operationId }),
    authorityDigest: digest,
    configurationDigest: canonicalSha256({ modelInvocable: true, userInvocable: true, projectRoot: null }),
    retentionDigest: digest,
    mutationDigest: digest,
    verificationDigest: digest,
    reviewEvidence: reviewEvidence(),
    restartRequired: false,
    fences: Object.freeze({
      catalogRevision: 1,
      inventoryRevision: digest,
      targetRevision: 'absent',
      ownerRevision: 'skills:empty',
      scopeRevision: digest,
      profileRevision: 'profile:0:tree',
    }),
    recoveryExecutable: recoveryBinding(),
    authorizedAtMs: 1,
  })
}

function journalsThroughPhase(phase) {
  if (!phases.includes(phase)) throw new Error(`unsupported fault phase ${JSON.stringify(phase)}`)
  const operationId = `operation:fault-matrix:${phase}`
  const beforeDigest = canonicalSha256({ before: operationId })
  const journals = []
  let journal = createOperationJournal(authorization(operationId), beforeDigest, 2)
  journals.push(journal)
  if (phase === 'authorized') return journals
  if (phase === 'failed') {
    journal = transitionOperation(journal, 'failed', beforeDigest, 'interrupted-before-mutation', 3)
    journals.push(journal)
    return journals
  }
  journal = transitionOperation(journal, 'staging', null, null, 3)
  journals.push(journal)
  if (phase === 'staging') return journals
  journal = transitionOperation(journal, 'applying', null, null, 4)
  journals.push(journal)
  if (phase === 'applying') return journals
  journal = recordOperationMutation(journal, canonicalSha256({ mutation: operationId }), 5)
  journals.push(journal)
  journal = transitionOperation(journal, 'verifying', null, null, 6)
  journals.push(journal)
  if (phase === 'verifying') return journals
  journal = recordOperationVerification(journal, canonicalSha256({ verification: operationId }), 7)
  journals.push(journal)
  if (phase === 'committed') {
    journal = transitionOperation(journal, 'committed', canonicalSha256({ after: operationId }), null, 8)
    journals.push(journal)
    return journals
  }
  journal = transitionOperation(journal, 'rolling-back', null, null, 8)
  journals.push(journal)
  if (phase === 'rolling-back') return journals
  if (phase === 'recovery-required') {
    journal = transitionOperation(journal, 'recovery-required', null, 'rollback-failed', 9)
    journals.push(journal)
    return journals
  }
  journal = transitionOperation(journal, 'rolled-back', beforeDigest, null, 9)
  journals.push(journal)
  return journals
}

async function crashPhase(phase) {
  const journals = journalsThroughPhase(phase)
  const store = new FileOperationStore(caseRoot, (point, context) => {
    if (point === 'journal-event-durable-before-current' && context.phase === phase) process.exit(86)
  })
  for (const journal of journals) await store.persist(journal)
  throw new Error(`fault seam did not stop the ${phase} process`)
}

async function recoverPhase(phase) {
  const operationId = `operation:fault-matrix:${phase}`
  const store = new FileOperationStore(caseRoot)
  const loaded = await store.load(operationId)
  if (loaded?.recovered !== true || loaded.projection.phase !== phase) {
    throw new Error(`fault recovery did not restore the exact ${phase} journal head`)
  }
  const stable = await store.load(operationId)
  if (stable?.recovered !== false || stable.projection.phase !== phase) {
    throw new Error(`fault recovery did not publish a stable ${phase} CURRENT pointer`)
  }
}

async function enospc() {
  const operationId = 'operation:fault-matrix:enospc'
  const journal = createOperationJournal(authorization(operationId), canonicalSha256(null), 2)
  const store = new FileOperationStore(caseRoot, point => {
    if (point === 'journal-event-before-write') {
      throw Object.assign(new Error('fixed journal write has no space'), { code: 'ENOSPC' })
    }
  })
  let failure
  try {
    await store.persist(journal)
  } catch (error) {
    failure = error
  }
  if (failure?.code !== 'ENOSPC' || await new FileOperationStore(caseRoot).load(operationId) !== undefined) {
    throw new Error('ENOSPC seam published a journal head')
  }
}

async function partialCurrentCrash() {
  const operationId = 'operation:fault-matrix:partial-current'
  let journal = createOperationJournal(authorization(operationId), canonicalSha256(null), 2)
  await new FileOperationStore(caseRoot).persist(journal)
  journal = transitionOperation(journal, 'staging', null, null, 3)
  const store = new FileOperationStore(caseRoot, async (point, context) => {
    if (point !== 'journal-event-durable-before-current' || context.phase !== 'staging') return
    await writeFile(context.currentPath, '{"schemaVersion":', 'utf8')
    process.exit(86)
  })
  await store.persist(journal)
  throw new Error('partial CURRENT seam did not stop the process')
}

async function rejectPartialCurrent() {
  let failure
  try {
    await new FileOperationStore(caseRoot).load('operation:fault-matrix:partial-current')
  } catch (error) {
    failure = error
  }
  if (failure?.code !== 'journal-corrupt') throw new Error('partial CURRENT was not rejected as journal-corrupt')
}

if (mode === 'crash-phase') await crashPhase(suppliedPhase)
else if (mode === 'recover-phase') await recoverPhase(suppliedPhase)
else if (mode === 'enospc') await enospc()
else if (mode === 'partial-current-crash') await partialCurrentCrash()
else if (mode === 'reject-partial-current') await rejectPartialCurrent()
else throw new Error(`unknown fault matrix worker mode ${JSON.stringify(mode)}`)

process.stdout.write(`${JSON.stringify({ mode, phase: suppliedPhase ?? null, status: 'passed' })}\n`)
