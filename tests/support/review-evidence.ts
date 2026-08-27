import { canonicalSha256, type Sha256Digest } from '../../src/domain/index.ts'
import type { ManagedExtensionKind, OperationKind, PlanReviewEvidence } from '../../src/plans/index.ts'

/** Minimal strict review record for tests whose subject is not evidence construction. */
export function testReviewEvidence(
  kind: ManagedExtensionKind,
  operationKind: OperationKind,
  pluginRecovery: Readonly<{ generation: string; treeDigest: Sha256Digest }> | null = null,
): PlanReviewEvidence {
  const common = {
    schemaVersion: 1 as const,
    operationKind,
    checks: [{ code: 'catalog-admission' as const, phase: 'planning' as const }],
    removed: [],
    retained: [],
    credentialChoice: 'not-applicable' as const,
    rollbackPoint: pluginRecovery === null
      ? { kind: 'absent-state' as const, id: 'absent', digest: canonicalSha256(null) }
      : { kind: 'managed-version' as const, id: pluginRecovery.generation, digest: pluginRecovery.treeDigest },
    rollbackLimits: ['dsh-managed-state-only' as const],
    notProven: ['user-task-outcome' as const],
  }
  if (kind === 'skill') {
    const body = '---\nname: fixture\ndescription: Fixture\n---\nfixture\n'
    const digest = canonicalSha256(body)
    return {
      ...common,
      kind,
      files: [{
        path: 'SKILL.md', change: 'add', beforeDigest: null, afterDigest: digest, sizeBytes: body.length,
        executableBefore: false, executableAfter: false, linkBefore: null, linkAfter: null,
      }],
      body: { before: null, after: body, beforeDigest: null, afterDigest: digest },
      invocation: {
        beforeModelInvocable: null, beforeUserInvocable: null,
        afterModelInvocable: true, afterUserInvocable: true,
      },
    }
  }
  if (kind === 'mcp') {
    return {
      ...common,
      kind,
      descriptor: {
        transport: 'stdio', serverName: 'fixture', executable: '/usr/bin/true', arguments: [],
        workingDirectory: '/', toolCallTimeoutMs: 1_000,
        reconnect: { enabled: false, initialDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 1 },
      },
      runtime: { ownership: 'host', version: '1.0.0', digest: canonicalSha256('runtime'), action: 'none' },
      credentials: 'none',
      dataEgress: 'local-process',
    }
  }
  const manifestBody = '{}'
  const files = ['package.json']
  const patchBody = '[]\n'
  const activation = {
    install: { profileDependency: 'add', loaderEntry: 'create' },
    configure: { profileDependency: 'retain', loaderEntry: 'replace' },
    update: { profileDependency: 'replace', loaderEntry: 'replace' },
    enable: { profileDependency: 'retain', loaderEntry: 'retain' },
    disable: { profileDependency: 'retain', loaderEntry: 'retain' },
    uninstall: { profileDependency: 'remove', loaderEntry: 'remove' },
    restore: { profileDependency: 'restore', loaderEntry: 'restore' },
    purge: { profileDependency: 'remove', loaderEntry: 'remove' },
  } as const
  return {
    ...common,
    kind,
    manifest: {
      packageName: 'fixture', beforeVersion: null, afterVersion: '1.0.0', body: manifestBody,
      manifestDigest: canonicalSha256({}), files, fileManifestDigest: canonicalSha256(files),
    },
    dependencies: [],
    managedMaterial: {
      owner: 'extension-center', packageName: 'fixture', beforeVersion: null,
      afterVersion: '1.0.0', targetIntegrity: canonicalSha256('artifact'),
    },
    packageMetadata: {
      bundlePatch: { path: 'cordis.patch.yml', patchDigest: canonicalSha256(patchBody), patchBody },
    },
    activation: {
      mutationOwner: operationKind === 'configure' ? 'official-loader' : 'official-dsh-cli',
      ...activation[operationKind],
      restartRequired: operationKind !== 'configure', packageName: 'fixture',
    },
    scripts: { before: [], after: [], forbiddenLifecycle: [] },
    settings: {
      adapterVersion: null, adapterDigest: null, schemaDigest: null, ownerRevision: 'fixture:1',
      migration: 'not-required', schema: [], migrationChanges: [], diffDigest: canonicalSha256(null),
    },
  }
}
