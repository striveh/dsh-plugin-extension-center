import { describe, expect, it } from 'vitest'
import type { ManagedTargetRecord, ManagedVersion } from '../src/host/index.ts'
import { resolveDesiredState } from '../src/service/intent-plan-service.ts'

function version(enabled: boolean): ManagedVersion {
  return {
    candidateRef: 'skill:documentation-writer@v1',
    artifactRevision: 'v1',
    artifactIntegrity: `sha256:${'1'.repeat(64)}`,
    materialPath: '/managed/SKILL.md',
    configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
    enabled,
    ownerRevision: 'skills:1',
    kindState: {},
  }
}

function record(input: Readonly<{
  current: ManagedVersion | null
  removed: ManagedVersion | null
  lastGood: ManagedVersion | null
}>): ManagedTargetRecord {
  return {
    schemaVersion: 1,
    kind: 'skill',
    extensionId: 'documentation-writer',
    targetKey: 'skill:web:user:documentation-writer',
    scopeKey: 'user',
    profileId: 'web',
    revision: 1,
    lastOperationId: null,
    current: input.current,
    removed: input.removed,
    lastGood: input.lastGood,
    pending: null,
    updatedAtMs: 1,
  }
}

describe('intent plan desired state', () => {
  it('restores the enabled removed version after disable, enable, and uninstall', () => {
    const managed = record({ current: null, removed: version(true), lastGood: version(false) })

    expect(resolveDesiredState('restore', 'store', 'skill', managed)).toBe('enabled')
  })

  it('uses the disabled removed version instead of an unrelated enabled last-good version', () => {
    const managed = record({ current: null, removed: version(false), lastGood: version(true) })

    expect(resolveDesiredState('restore', 'store', 'skill', managed)).toBe('disabled')
  })

  it('uses last-good only when restore swaps an installed current version', () => {
    const managed = record({ current: version(true), removed: null, lastGood: version(false) })

    expect(resolveDesiredState('restore', 'store', 'skill', managed)).toBe('disabled')
  })
})
