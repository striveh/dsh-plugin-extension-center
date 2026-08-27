import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { ArtifactFetcher } from '../src/host/index.ts'
import { createImmutablePlan, type ImmutablePlan, type OperationAuthorization } from '../src/plans/index.ts'
import { TEST_RECOVERY_EXECUTABLE_BINDING } from './support/recovery-binding.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(
  bytes = Buffer.from('exact plugin archive'),
  url = 'https://downloads.example.test/plugin.tgz',
): Promise<Readonly<{
  root: string
  plan: ImmutablePlan
  authorization: OperationAuthorization
}>> {
  const root = await mkdtemp(join(tmpdir(), 'extension-artifact-'))
  roots.push(root)
  const entry = structuredClone(BOOTSTRAP_CATALOG_ENVELOPE.entries.find(item => item.kind === 'plugin')!)
  entry.artifact.acquisitionUrl = url
  entry.artifact.sizeBytes = bytes.byteLength
  entry.artifact.integrity = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const plan = createImmutablePlan({
    schemaVersion: 1,
    singleUse: true,
    planId: 'plan:artifact-test',
    intentId: 'intent:artifact-test',
    origin: 'store',
    candidateRef: entry.candidateRef,
    extensionKind: entry.kind,
    extensionId: entry.name,
    managedObject: 'artifact',
    externalRuntimeAction: 'download',
    runtimeBinding: null,
    artifactRevision: entry.artifact.version,
    artifactIntegrity: entry.artifact.integrity,
    artifactUrl: entry.artifact.acquisitionUrl,
    artifactSizeBytes: entry.artifact.sizeBytes,
    operationKind: 'install',
    desiredState: 'enabled',
    targetKey: 'plugin:profile:web:profile:web:dsh-capability-resolver',
    ownerKey: 'managedPlugins',
    scopeKey: 'profile:web',
    profileId: 'profile:web',
    idempotencyKey: 'artifact-test',
    authorityDigest: `sha256:${'1'.repeat(64)}`,
    configurationDigest: canonicalSha256({}),
    retentionDigest: canonicalSha256({ candidateRef: entry.candidateRef, retainedData: entry.retainedData }),
    reviewEvidence: testReviewEvidence(entry.kind, 'install'),
    mutationDigest: `sha256:${'2'.repeat(64)}`,
    verificationDigest: `sha256:${'3'.repeat(64)}`,
    restartRequired: entry.restart.required,
    createdAtMs: 1,
    expiresAtMs: 10_000,
    fences: {
      catalogRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
      inventoryRevision: `sha256:${'4'.repeat(64)}`,
      targetRevision: 'absent',
      ownerRevision: 'managed-plugin:0:tree',
      scopeRevision: `sha256:${'5'.repeat(64)}`,
      profileRevision: 'profile:0:tree',
    },
  })
  const authorization: OperationAuthorization = {
    operationId: 'operation:artifact-test',
    planId: plan.content.planId,
    planHash: plan.hash,
    origin: plan.content.origin,
    candidateRef: plan.content.candidateRef,
    extensionKind: plan.content.extensionKind,
    extensionId: plan.content.extensionId,
    operationKind: plan.content.operationKind,
    managedObject: plan.content.managedObject,
    externalRuntimeAction: plan.content.externalRuntimeAction,
    runtimeBinding: plan.content.runtimeBinding,
    artifactRevision: plan.content.artifactRevision,
    artifactIntegrity: plan.content.artifactIntegrity,
    artifactUrl: plan.content.artifactUrl,
    artifactSizeBytes: plan.content.artifactSizeBytes,
    desiredState: plan.content.desiredState,
    targetKey: plan.content.targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    idempotencyKey: plan.content.idempotencyKey,
    authorityDigest: plan.content.authorityDigest,
    configurationDigest: plan.content.configurationDigest,
    retentionDigest: plan.content.retentionDigest,
    mutationDigest: plan.content.mutationDigest,
    verificationDigest: plan.content.verificationDigest,
    reviewEvidence: plan.content.reviewEvidence,
    restartRequired: plan.content.restartRequired,
    fences: plan.content.fences,
    recoveryExecutable: TEST_RECOVERY_EXECUTABLE_BINDING,
    authorizedAtMs: 2,
  }
  return { root, plan, authorization }
}

function fetcher(root: string, implementation: typeof fetch, redirects = 0, hosts: readonly string[] = []): ArtifactFetcher {
  return new ArtifactFetcher(root, { maximumRedirects: redirects, allowedCrossOriginHosts: hosts }, implementation)
}

describe('approved artifact acquisition', () => {
  it('binds consumed authorization and immutable plan before network and caches an exact .tgz', async () => {
    const bytes = Buffer.from('bound archive')
    const value = await fixture(bytes)
    const request = vi.fn<typeof fetch>(async () => new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    }))
    const acquired = await fetcher(value.root, request).fetch(value, new AbortController().signal)
    expect(basename(acquired.path)).toMatch(/^[0-9a-f]{64}\.tgz$/)
    expect(request).toHaveBeenCalledOnce()
    await expect(fetcher(value.root, vi.fn<typeof fetch>()).fetch(value, new AbortController().signal))
      .resolves.toEqual(acquired)

    const mismatches: Array<() => typeof value> = [
      () => ({ ...value, authorization: { ...value.authorization, planHash: `sha256:${'a'.repeat(64)}` } }),
      () => ({ ...value, plan: { ...value.plan, content: { ...value.plan.content, candidateRef: 'plugin:wrong@1' } } }),
      () => ({ ...value, authorization: { ...value.authorization, artifactRevision: 'different' } }),
      () => ({ ...value, authorization: { ...value.authorization, artifactIntegrity: `sha256:${'b'.repeat(64)}` } }),
      () => ({ ...value, authorization: { ...value.authorization, artifactUrl: 'https://other.example.test/plugin.tgz' } }),
    ]
    for (const mutate of mismatches) {
      const network = vi.fn<typeof fetch>()
      await expect(fetcher(value.root, network).fetch(mutate(), new AbortController().signal)).rejects.toThrow()
      expect(network).not.toHaveBeenCalled()
    }
  })

  it('rejects non-download and non-artifact authorizations before network', async () => {
    const value = await fixture(Buffer.from('must not be fetched'))
    const noDownloadPlan = createImmutablePlan({
      ...value.plan.content,
      operationKind: 'configure',
      externalRuntimeAction: 'none',
      reviewEvidence: testReviewEvidence('plugin', 'configure'),
      restartRequired: false,
    })
    const noDownload = {
      ...value,
      plan: noDownloadPlan,
      authorization: {
        ...value.authorization,
        planHash: noDownloadPlan.hash,
        operationKind: noDownloadPlan.content.operationKind,
        externalRuntimeAction: noDownloadPlan.content.externalRuntimeAction,
        reviewEvidence: noDownloadPlan.content.reviewEvidence,
        restartRequired: noDownloadPlan.content.restartRequired,
      },
    }
    const connectionPlan = {
      ...value.plan,
      content: {
        ...value.plan.content,
        managedObject: 'connection' as const,
        externalRuntimeAction: 'none' as const,
        runtimeBinding: {
          runtimeRef: 'fixture',
          version: '1.0.0',
          descriptorDigest: `sha256:${'a'.repeat(64)}` as const,
        },
      },
    }
    const connection = {
      ...value,
      plan: connectionPlan,
      authorization: {
        ...value.authorization,
        managedObject: connectionPlan.content.managedObject,
        externalRuntimeAction: connectionPlan.content.externalRuntimeAction,
        runtimeBinding: connectionPlan.content.runtimeBinding,
      },
    }
    for (const binding of [noDownload, connection]) {
      const network = vi.fn<typeof fetch>()
      await expect(fetcher(value.root, network).fetch(binding, new AbortController().signal))
        .rejects.toThrow('does not authorize artifact acquisition')
      expect(network).not.toHaveBeenCalled()
    }
  })

  it.each([
    'http://downloads.example.test/plugin.tgz',
    'https://0.0.0.0/plugin.tgz',
    'https://127.0.0.1/plugin.tgz',
    'https://2130706433/plugin.tgz',
    'https://192.0.2.1/plugin.tgz',
    'https://[::1]/plugin.tgz',
    'https://[fc00::1]/plugin.tgz',
    'https://[fe80::1]/plugin.tgz',
    'https://[::ffff:7f00:1]/plugin.tgz',
    'https://[2001:db8::1]/plugin.tgz',
    'https://localhost/plugin.tgz',
    'https://localhost./plugin.tgz',
  ])('rejects a forbidden initial URL before network: %s', async (url) => {
    const value = await fixture(Buffer.from('exact plugin archive'), url)
    const network = vi.fn<typeof fetch>()
    await expect(fetcher(value.root, network).fetch(value, new AbortController().signal)).rejects.toThrow(/HTTPS acquisition policy/)
    expect(network).not.toHaveBeenCalled()
  })

  it('accepts an exact decoded body when HTTP Content-Length describes compressed wire bytes', async () => {
    const decoded = Buffer.from('decoded artifact bytes are authoritative after transparent content decoding')
    const value = await fixture(decoded)
    const network = vi.fn<typeof fetch>(async () => new Response(decoded, {
      status: 200,
      headers: {
        'content-encoding': 'gzip',
        'content-length': '23',
      },
    }))
    await expect(fetcher(value.root, network).fetch(value, new AbortController().signal)).resolves.toMatchObject({
      sizeBytes: decoded.byteLength,
      integrity: value.plan.content.artifactIntegrity,
    })
    expect(network).toHaveBeenCalledOnce()
  })

  it('enforces redirect authority, redirect count, decoded body length, and digest', async () => {
    const bytes = Buffer.from('bounded body')
    const cases: readonly Readonly<{
      implementation: typeof fetch
      redirects?: number
      hosts?: readonly string[]
      error: RegExp
    }>[] = [{
      implementation: async () => new Response(null, { status: 302, headers: { location: 'https://other.example.test/a.tgz' } }),
      redirects: 1,
      error: /redirect target/,
    }, {
      implementation: async () => new Response(null, { status: 302, headers: { location: '/again.tgz' } }),
      error: /redirect limit/,
    }, {
      implementation: async () => new Response(bytes.subarray(0, bytes.byteLength - 1), { status: 200 }),
      error: /admitted size/,
    }, {
      implementation: async () => new Response(Buffer.concat([bytes, Buffer.from('x')]), { status: 200 }),
      error: /exceeds/,
    }, {
      implementation: async () => new Response(Buffer.alloc(bytes.byteLength, 0x78), { status: 200 }),
      error: /integrity/,
    }]
    for (const item of cases) {
      const value = await fixture(bytes)
      await expect(fetcher(value.root, item.implementation, item.redirects ?? 0, item.hosts ?? [])
        .fetch(value, new AbortController().signal)).rejects.toThrow(item.error)
      const temporary = join(value.root, 'artifacts', 'temporary')
      await expect(readdir(temporary)).resolves.toEqual([])
    }
  })

  it.each([
    'https://[::1]/redirected.tgz',
    'https://[::ffff:7f00:1]/redirected.tgz',
    'https://127.0.0.1/redirected.tgz',
    'https://localhost./redirected.tgz',
  ])('rejects a forbidden redirect URL before a second request: %s', async (location) => {
    const bytes = Buffer.from('forbidden redirect')
    const value = await fixture(bytes)
    const request = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302,
      headers: { location },
    }))
    await expect(fetcher(value.root, request, 1, ['localhost', 'localhost.'])
      .fetch(value, new AbortController().signal)).rejects.toThrow(/HTTPS acquisition policy/)
    expect(request).toHaveBeenCalledOnce()
  })

  it('follows one admitted GitHub Release asset redirect and verifies the exact bytes', async () => {
    const bytes = Buffer.from('github release asset')
    const value = await fixture(bytes, 'https://github.com/example/plugin/releases/download/v1/plugin.tgz')
    const request = vi.fn<typeof fetch>(async (url) => {
      if (url === value.plan.content.artifactUrl) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/release/plugin.tgz?signature=fixed' },
        })
      }
      return new Response(bytes, { status: 200 })
    })
    await expect(fetcher(value.root, request, 1, ['release-assets.githubusercontent.com'])
      .fetch(value, new AbortController().signal)).resolves.toMatchObject({
        sizeBytes: bytes.byteLength,
        integrity: value.plan.content.artifactIntegrity,
        finalUrl: 'https://release-assets.githubusercontent.com/release/plugin.tgz?signature=fixed',
      })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('propagates cancellation without promoting a partial artifact', async () => {
    const value = await fixture(Buffer.from('cancelled body'))
    const controller = new AbortController()
    const network = vi.fn<typeof fetch>(async (_url, init) => {
      controller.abort(new Error('cancelled by test'))
      throw init?.signal?.reason
    })
    await expect(fetcher(value.root, network).fetch(value, controller.signal)).rejects.toThrow('cancelled by test')
    const algorithmDirectory = join(value.root, 'artifacts', 'sha256')
    await expect(readdir(algorithmDirectory)).resolves.toEqual([])
  })
})
