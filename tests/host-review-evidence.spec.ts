import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { verifyBootstrapCatalog } from '../src/catalog.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import type { ManagedTargetRecord } from '../src/host/index.ts'
import { SKILL_CANDIDATES } from '../src/kind-candidates.ts'
import { decodePlanReviewEvidence } from '../src/plans/index.ts'
import { CAPABILITY_RESOLVER_CANDIDATES } from '../src/resolver-candidates.ts'
import { buildPlanReviewEvidence } from '../src/service/review-evidence.ts'

const catalog = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
const entry = catalog.envelope.entries.find(candidate => candidate.kind === 'plugin')!
const digest = canonicalSha256({ profileId: 'web', managedPlugins: [] })
const managedPlugins = Object.freeze({
  profileId: 'web',
  revision: 0,
  digest,
  materialRoot: '/center/material/plugins',
  bootStatus: 'live' as const,
  ownerRevision: `managed-plugin:0:${digest}`,
})

describe('managed Plugin review evidence', () => {
  it('binds Center material, Loader, and restart checks to managed recovery state', async () => {
    const installed: ManagedTargetRecord = {
      schemaVersion: 1,
      kind: 'plugin',
      extensionId: entry.name,
      targetKey: `plugin:web:profile:web:${entry.name}`,
      scopeKey: 'profile:web',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:installed',
      current: {
        candidateRef: entry.candidateRef,
        artifactRevision: entry.artifact.version,
        artifactIntegrity: entry.artifact.integrity,
        materialPath: '/center/material/plugins/resolver',
        configuration: {},
        enabled: true,
        ownerRevision: managedPlugins.ownerRevision,
        kindState: { packageName: entry.artifact.id },
      },
      lastGood: null,
      removed: null,
      pending: null,
      updatedAtMs: 1,
    }
    const evidence = await buildPlanReviewEvidence({
      entry,
      operationKind: 'uninstall',
      profileId: 'web',
      ownerRevision: managedPlugins.ownerRevision,
      configuration: {},
      managed: installed,
      managedPlugins,
      runtime: null,
    })

    expect(evidence.kind).toBe('plugin')
    if (evidence.kind !== 'plugin') throw new Error('fixture selected a non-Plugin catalog entry')
    expect(evidence.rollbackPoint).toMatchObject({ kind: 'managed-version', id: entry.candidateRef })
    expect(evidence.dependencies[0]?.kind).toBe('extension')
    expect(evidence.checks).toEqual(expect.arrayContaining([
      { code: 'center-plugin-material', phase: 'apply' },
      { code: 'official-profile-package', phase: 'apply' },
      { code: 'loader-consumer', phase: 'verify' },
      { code: 'host-restart-observation', phase: 'external-restart' },
    ]))
    expect(evidence.checks.map(check => check.code)).not.toEqual(expect.arrayContaining([
      'profile-lockfile',
      'isolated-profile-boot',
    ]))
    expect(evidence.removed.map(material => material.kind)).toEqual(['loader-entry', 'profile-dependency'])
    expect(evidence.retained.map(material => material.kind)).toEqual([
      'center-plugin-material',
      'plugin-settings',
      'recovery-point',
    ])
    expect(evidence.managedMaterial).toMatchObject({
      owner: 'extension-center',
      packageName: entry.artifact.id,
      beforeVersion: entry.artifact.version,
      afterVersion: null,
      targetIntegrity: null,
    })
    expect(evidence.packageMetadata.bundlePatch).toMatchObject({ path: 'cordis.patch.yml' })
    expect(evidence.activation).toMatchObject({ loaderEntry: 'remove', restartRequired: true })
    expect(evidence.manifest.body.startsWith('{"bugs"')).toBe(true)
    expect(decodePlanReviewEvidence(evidence)).toEqual(evidence)

    const invalid = structuredClone(evidence) as { rollbackPoint: { kind: string } }
    invalid.rollbackPoint.kind = 'legacy-owner-state'
    expect(() => decodePlanReviewEvidence(invalid)).toThrow('rollbackPoint.kind')
  })

  it('refuses a Plugin review whose owner revision is not the managed snapshot revision', async () => {
    await expect(buildPlanReviewEvidence({
      entry,
      operationKind: 'install',
      profileId: 'web',
      ownerRevision: 'managed-plugin:stale',
      configuration: {},
      managed: undefined,
      managedPlugins,
      runtime: null,
    })).rejects.toThrow('snapshot does not bind')
  })

  it('binds pure Plugin configuration to the official Loader without a Host restart', async () => {
    const installed: ManagedTargetRecord = {
      schemaVersion: 1,
      kind: 'plugin',
      extensionId: entry.name,
      targetKey: `plugin:web:profile:web:${entry.name}`,
      scopeKey: 'profile:web',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:installed',
      current: {
        candidateRef: entry.candidateRef,
        artifactRevision: entry.artifact.version,
        artifactIntegrity: entry.artifact.integrity,
        materialPath: '/center/material/plugins/resolver',
        configuration: {},
        enabled: true,
        ownerRevision: managedPlugins.ownerRevision,
        kindState: { packageName: entry.artifact.id },
      },
      lastGood: null,
      removed: null,
      pending: null,
      updatedAtMs: 1,
    }
    const evidence = await buildPlanReviewEvidence({
      entry,
      operationKind: 'configure',
      profileId: 'web',
      ownerRevision: managedPlugins.ownerRevision,
      configuration: { freshCacheMs: 5_000 },
      managed: installed,
      managedPlugins,
      runtime: null,
    })

    expect(evidence.kind).toBe('plugin')
    if (evidence.kind !== 'plugin') throw new Error('fixture selected a non-Plugin catalog entry')
    expect(evidence.activation).toEqual({
      mutationOwner: 'official-loader',
      profileDependency: 'retain',
      loaderEntry: 'replace',
      restartRequired: false,
      packageName: entry.artifact.id,
    })
    expect(evidence.checks.map(check => check.code)).not.toContain('host-restart-observation')
    expect(evidence.rollbackLimits).not.toContain('restart-required-before-runtime-proof')
    expect(evidence.notProven).not.toContain('post-restart-consumer')
    expect(decodePlanReviewEvidence(evidence)).toEqual(evidence)

    const forgeries = [
      { mutationOwner: 'official-dsh-cli' },
      { profileDependency: 'replace' },
      { loaderEntry: 'retain' },
      { restartRequired: true },
    ]
    for (const forgedActivation of forgeries) {
      const forged = structuredClone(evidence)
      Object.assign(forged.activation, forgedActivation)
      expect(() => decodePlanReviewEvidence(forged)).toThrow('activation does not match operationKind')
    }
  })

  it('binds the 0.1.1 update to its exact manifest and configuration adapter', async () => {
    const [, next] = CAPABILITY_RESOLVER_CANDIDATES
    const nextEntry = {
      ...entry,
      candidateRef: next.candidateRef,
      artifact: {
        ...entry.artifact,
        version: next.version,
        integrity: next.integrity,
        sizeBytes: next.sizeBytes,
      },
    }
    const installed: ManagedTargetRecord = {
      schemaVersion: 1,
      kind: 'plugin',
      extensionId: entry.name,
      targetKey: `plugin:web:profile:web:${entry.name}`,
      scopeKey: 'profile:web',
      profileId: 'web',
      revision: 1,
      lastOperationId: 'operation:installed-0.1.0',
      current: {
        candidateRef: entry.candidateRef,
        artifactRevision: entry.artifact.version,
        artifactIntegrity: entry.artifact.integrity,
        materialPath: '/center/material/plugins/resolver-0.1.0',
        configuration: {},
        enabled: true,
        ownerRevision: managedPlugins.ownerRevision,
        kindState: { packageName: entry.artifact.id },
      },
      lastGood: null,
      removed: null,
      pending: null,
      updatedAtMs: 1,
    }
    const evidence = await buildPlanReviewEvidence({
      entry: nextEntry,
      operationKind: 'update',
      profileId: 'web',
      ownerRevision: managedPlugins.ownerRevision,
      configuration: {},
      managed: installed,
      managedPlugins,
      runtime: null,
    })

    expect(evidence.kind).toBe('plugin')
    if (evidence.kind !== 'plugin') throw new Error('fixture selected a non-Plugin catalog entry')
    expect(JSON.parse(evidence.manifest.body)).toMatchObject({
      name: 'dsh-capability-resolver',
      version: '0.1.1',
    })
    expect(evidence.manifest.manifestDigest)
      .toBe('sha256:9bdd968df0c8433bfa053fdd77cea1b7aadb53ec739b277e1860b9d291eee164')
    expect(evidence.manifest.fileManifestDigest)
      .toBe('sha256:f410f0f804a90504bd6f7ceaaa57cef4863e6df059b9503188fbb89d18f2e1e6')
    expect(evidence.packageMetadata.bundlePatch?.patchDigest)
      .toBe('sha256:e351fb7cb3171aea75de3d2144188f2733e50ead717c4428d39751c7c9c9c489')
    expect(evidence.manifest).toMatchObject({ beforeVersion: '0.1.0', afterVersion: '0.1.1' })
    expect(evidence.managedMaterial).toMatchObject({
      beforeVersion: '0.1.0',
      afterVersion: '0.1.1',
      targetIntegrity: next.integrity,
    })
    expect(evidence.settings.adapterVersion).toBe('dsh-capability-resolver/config@0.1.1')
    expect(evidence.activation).toMatchObject({ profileDependency: 'replace', loaderEntry: 'replace' })
    expect(decodePlanReviewEvidence(evidence)).toEqual(evidence)
  })
})

describe('candidate-specific Skill review evidence', () => {
  it('binds each Wiki Page Writer revision to its exact reviewed bytes', async () => {
    const entries = catalog.envelope.entries.filter(candidate => candidate.name === 'wiki-page-writer')
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      const candidate = SKILL_CANDIDATES.find(item => item.candidateRef === entry.candidateRef)!
      const evidence = await buildPlanReviewEvidence({
        entry,
        operationKind: 'install',
        profileId: 'web',
        ownerRevision: 'skills:0',
        configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
        managed: undefined,
        managedPlugins,
        runtime: null,
      })

      expect(evidence.kind).toBe('skill')
      if (evidence.kind !== 'skill') throw new Error('fixture selected a non-Skill catalog entry')
      expect(evidence.body).toMatchObject({
        before: null,
        after: candidate.reviewBody,
        afterDigest: entry.artifact.integrity,
      })
      expect(evidence.files[0]).toMatchObject({
        change: 'add',
        afterDigest: entry.artifact.integrity,
        sizeBytes: entry.artifact.sizeBytes,
      })
      expect(decodePlanReviewEvidence(evidence)).toEqual(evidence)
    }
  })

  it('fails closed for an unknown Wiki Page Writer revision', async () => {
    const entry = catalog.envelope.entries.find(candidate => candidate.name === 'wiki-page-writer')!
    await expect(buildPlanReviewEvidence({
      entry: {
        ...entry,
        candidateRef: 'skill:microsoft-skills/wiki-page-writer@unknown',
        artifact: { ...entry.artifact, version: 'unknown' },
      },
      operationKind: 'install',
      profileId: 'web',
      ownerRevision: 'skills:0',
      configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
      managed: undefined,
      managedPlugins,
      runtime: null,
    })).rejects.toThrow('package-pinned review record')
  })
})
