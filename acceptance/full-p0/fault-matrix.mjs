import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workerPath = fileURLToPath(new URL('./fault-matrix-worker.mjs', import.meta.url))
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

/** Exact fault cases required in the official rc.2 receipt and composite release gate. */
export const REQUIRED_FAULT_MATRIX_CASE_IDS = Object.freeze([
  'enospc/journal-event-before-write',
  'partial-current/rejected',
  ...phases.map(phase => `phase-crash/${phase}`),
])

function runWorker(args, expectedCode) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [workerPath, ...args], {
      cwd: dirname(workerPath),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const append = (current, chunk) => `${current}${chunk.toString()}`.slice(-32_768)
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectRun(new Error(`fault matrix worker timed out: ${args.join(' ')}`))
    }, 30_000)
    child.once('error', error => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code !== expectedCode || signal !== null) {
        rejectRun(new Error(
          `fault matrix worker ${args.join(' ')} exited code=${String(code)} signal=${String(signal)}; `
          + `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
        ))
        return
      }
      resolveRun(Object.freeze({ stdout, stderr }))
    })
  })
}

function exactCaseIds(value) {
  if (!Array.isArray(value) || value.length !== REQUIRED_FAULT_MATRIX_CASE_IDS.length) return false
  return value.every((item, index) => item?.id === REQUIRED_FAULT_MATRIX_CASE_IDS[index]
    && item.status === 'passed'
    && item.extensionKind === 'skill')
}

/** Reject a missing, duplicate, reordered, unknown, or unsuccessful fault case. */
export function assertExactFaultMatrix(value, expectedArtifactDigest) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.proofScope !== 'packed-center-owned-skill-journal-faults'
    || value.artifactDigest !== expectedArtifactDigest
    || value.platform !== process.platform
    || value.arch !== process.arch
    || !exactCaseIds(value.cases)) {
    throw new Error('faultMatrix is not the exact fixed passing Center-owned case set')
  }
  return value
}

/** Run process-death and storage faults against the exact packed Extension Center modules. */
export async function runCenterOwnedFaultMatrix(input) {
  const moduleRoot = resolve(input.moduleRoot)
  const root = resolve(input.root)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const cases = []

  const enospcRoot = join(root, 'enospc')
  await runWorker(['enospc', moduleRoot, enospcRoot], 0)
  cases.push(Object.freeze({
    id: 'enospc/journal-event-before-write',
    status: 'passed',
    extensionKind: 'skill',
    observation: 'no-journal-head-published',
  }))

  const partialRoot = join(root, 'partial-current')
  await runWorker(['partial-current-crash', moduleRoot, partialRoot], 86)
  await runWorker(['reject-partial-current', moduleRoot, partialRoot], 0)
  cases.push(Object.freeze({
    id: 'partial-current/rejected',
    status: 'passed',
    extensionKind: 'skill',
    observation: 'journal-corrupt-fail-closed',
  }))

  for (const phase of phases) {
    const caseRoot = join(root, `phase-${phase}`)
    await runWorker(['crash-phase', moduleRoot, caseRoot, phase], 86)
    await runWorker(['recover-phase', moduleRoot, caseRoot, phase], 0)
    cases.push(Object.freeze({
      id: `phase-crash/${phase}`,
      status: 'passed',
      extensionKind: 'skill',
      observation: 'event-ahead-of-current-repaired-by-new-process',
    }))
  }

  return Object.freeze({
    schemaVersion: 1,
    proofScope: 'packed-center-owned-skill-journal-faults',
    artifactDigest: input.artifactDigest,
    platform: process.platform,
    arch: process.arch,
    cases: Object.freeze(cases),
  })
}
