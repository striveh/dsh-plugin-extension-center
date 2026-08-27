import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  assertExactFaultMatrix,
  REQUIRED_FAULT_MATRIX_CASE_IDS,
  runCenterOwnedFaultMatrix,
} from './fault-matrix.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const artifactDigest = `sha256:${'a'.repeat(64)}`

test('runs the exact packed Center-owned fault case set in separate crash and recovery processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-fault-matrix-'))
  try {
    const matrix = await runCenterOwnedFaultMatrix({
      moduleRoot: join(projectRoot, 'lib'),
      root,
      artifactDigest,
    })
    assert.equal(assertExactFaultMatrix(matrix, artifactDigest), matrix)
    assert.deepEqual(matrix.cases.map(item => item.id), REQUIRED_FAULT_MATRIX_CASE_IDS)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects missing, duplicate, unknown, reordered, and unsuccessful fault cases', () => {
  const exact = {
    schemaVersion: 1,
    proofScope: 'packed-center-owned-skill-journal-faults',
    artifactDigest,
    platform: process.platform,
    arch: process.arch,
    cases: REQUIRED_FAULT_MATRIX_CASE_IDS.map(id => ({ id, status: 'passed', extensionKind: 'skill' })),
  }
  assert.doesNotThrow(() => assertExactFaultMatrix(exact, artifactDigest))
  for (const mutated of [
    { ...exact, cases: exact.cases.slice(1) },
    { ...exact, cases: [exact.cases[0], ...exact.cases.slice(0, -1)] },
    { ...exact, cases: exact.cases.map((item, index) => index === 0 ? { ...item, id: 'unknown' } : item) },
    { ...exact, cases: [exact.cases[1], exact.cases[0], ...exact.cases.slice(2)] },
    { ...exact, cases: exact.cases.map((item, index) => index === 0 ? { ...item, status: 'failed' } : item) },
  ]) {
    assert.throws(() => assertExactFaultMatrix(mutated, artifactDigest), /exact fixed passing/)
  }
})
