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
      : { kind: 'profile-generation' as const, id: pluginRecovery.generation, digest: pluginRecovery.treeDigest },
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
  return {
    ...common,
    kind,
    manifest: {
      packageName: 'fixture', beforeVersion: null, afterVersion: '1.0.0', body: manifestBody,
      manifestDigest: canonicalSha256({}), files, fileManifestDigest: canonicalSha256(files),
    },
    dependencies: [],
    lockfile: {
      path: 'pnpm-lock.yaml', beforeDigest: null, packageName: 'fixture', beforeVersion: null,
      afterVersion: '1.0.0', targetIntegrity: canonicalSha256('artifact'),
    },
    bundles: [{ id: 'fixture', action: 'add', patchDigest: canonicalSha256(patchBody), patchBody }],
    scripts: { before: [], after: [], forbiddenLifecycle: [] },
    settings: {
      adapterVersion: null, adapterDigest: null, schemaDigest: null, ownerRevision: 'fixture:1',
      migration: 'not-required', schema: [], migrationChanges: [], diffDigest: canonicalSha256(null),
    },
  }
}
