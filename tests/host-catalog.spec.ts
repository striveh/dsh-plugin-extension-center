// @vitest-environment node

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_ROOT,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from '../src/catalog-data.ts'
import {
  canonicalSha256,
  catalogListResponse,
  catalogReviewEvidenceSupport,
  verifyBootstrapCatalog,
  verifyCatalog,
} from '../src/catalog.ts'
import { EXTENSION_CENTER_RPC_CHANNEL } from '../src/catalog-contract.ts'
import { apply } from '../src/index.ts'
import { candidateUpdateSuccessor, FILESYSTEM_MCP_CANDIDATES, SKILL_CANDIDATES } from '../src/kind-candidates.ts'
import { CAPABILITY_RESOLVER_CANDIDATES } from '../src/resolver-candidates.ts'

const VALID_NOW = Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1

describe('signed bootstrap catalog', () => {
  it('verifies revision 10 and projects exact update candidates across all three extension kinds', () => {
    const catalog = verifyBootstrapCatalog(VALID_NOW)
    const response = catalogListResponse(catalog)
    expect(catalog.keyIds).toEqual(['bootstrap-2026-08-26-8'])
    expect(BOOTSTRAP_CATALOG_ROOT.minimumRevision).toBe(10)
    expect(response.catalog).toMatchObject({ revision: 10, signatureStatus: 'verified' })
    expect(response.entries.map(entry => entry.kind)).toEqual([
      'mcp', 'mcp', 'plugin', 'plugin', 'skill', 'skill', 'skill',
    ])
    expect(response.entries.filter(entry => entry.kind === 'plugin').map(entry => entry.candidateRef)).toEqual([
      'plugin:dsh-capability-resolver@0.1.0',
      'plugin:dsh-capability-resolver@0.1.1',
    ])
    expect(response.entries.filter(entry => entry.kind === 'mcp').map(entry => entry.artifact.version)).toEqual(['1.2.2', '1.3.0'])
    expect(response.entries.filter(entry => entry.name === 'wiki-page-writer').map(entry => entry.artifact.version)).toEqual([
      '6142f8e60ac58372845c0fcdd2dbf043cd1bb698',
      '67ae723a23ba880e3e5c8a3e5e2320092024476e',
    ])
    expect(response.entries.find(entry => entry.name === 'wiki-page-writer')?.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'runtime', kind: 'model-context', access: 'send' }),
      expect.objectContaining({ phase: 'runtime', kind: 'filesystem', access: 'read' }),
      expect.objectContaining({ phase: 'runtime', kind: 'subprocess', access: 'execute' }),
    ]))
    expect(candidateUpdateSuccessor(FILESYSTEM_MCP_CANDIDATES[0].candidateRef)).toBe(FILESYSTEM_MCP_CANDIDATES[1].candidateRef)
    expect(candidateUpdateSuccessor(FILESYSTEM_MCP_CANDIDATES[1].candidateRef)).toBeNull()
    expect(candidateUpdateSuccessor(SKILL_CANDIDATES[1].candidateRef)).toBe(SKILL_CANDIDATES[2].candidateRef)
    expect(candidateUpdateSuccessor(SKILL_CANDIDATES[2].candidateRef)).toBeNull()
    expect(candidateUpdateSuccessor('skill:microsoft-skills/wiki-page-writer@unknown')).toBeNull()
    const plugin = response.entries.find(entry => entry.kind === 'plugin')
    expect(plugin?.configuration).toMatchObject({ required: false, credentials: 'none' })
    expect(plugin?.configuration.fields).toHaveLength(10)
    expect(plugin?.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'acquisition', kind: 'network', access: 'send' }),
      expect.objectContaining({ phase: 'acquisition', kind: 'filesystem', access: 'write' }),
      expect.objectContaining({ phase: 'acquisition', kind: 'subprocess', access: 'execute' }),
      expect.objectContaining({ phase: 'acquisition', kind: 'credentials', access: 'read' }),
      expect.objectContaining({ phase: 'runtime', kind: 'network', access: 'send' }),
      expect.objectContaining({ phase: 'runtime', kind: 'filesystem', access: 'write' }),
      expect.objectContaining({ phase: 'runtime', kind: 'subprocess', access: 'execute' }),
      expect.objectContaining({ phase: 'runtime', kind: 'credentials', access: 'read' }),
    ]))
    expect(response.hostCapabilities).toEqual({
      managedPluginLifecycle: false,
      dynamicMcpConnection: false,
      durableContinuation: false,
      skillRegistry: false,
      toolRegistry: false,
      loaderMutation: false,
      acquisition: false,
      reason: 'host-capability',
    })
    expect(() => catalogListResponse(catalog, {
      managedPluginLifecycle: true,
      dynamicMcpConnection: true,
      durableContinuation: true,
      skillRegistry: false,
      toolRegistry: false,
      loaderMutation: false,
      acquisition: true,
      reason: null,
    })).toThrow('Host acquisition claim')
    expect(catalogListResponse(catalog, {
      managedPluginLifecycle: true,
      dynamicMcpConnection: true,
      durableContinuation: true,
      skillRegistry: true,
      toolRegistry: true,
      loaderMutation: true,
      acquisition: true,
      reason: null,
    }).hostCapabilities.acquisition).toBe(true)
    expect(catalogListResponse(catalog, {
      managedPluginLifecycle: true,
      dynamicMcpConnection: true,
      durableContinuation: true,
      skillRegistry: true,
      toolRegistry: true,
      loaderMutation: true,
      acquisition: false,
      reason: 'host-capability',
    }).hostCapabilities.acquisition).toBe(false)
  })

  it('fails closed before indexing tampered, unsigned, moving, or expired snapshots', () => {
    expect(() => verifyCatalog(
      BOOTSTRAP_CATALOG_ROOT,
      { ...BOOTSTRAP_CATALOG_ENVELOPE, entriesDigest: `sha256:${'0'.repeat(64)}` },
      BOOTSTRAP_CATALOG_SIGNATURES,
      VALID_NOW,
    )).toThrow('entries digest mismatch')
    expect(() => verifyCatalog(
      BOOTSTRAP_CATALOG_ROOT,
      BOOTSTRAP_CATALOG_ENVELOPE,
      [{ ...BOOTSTRAP_CATALOG_SIGNATURES[0]!, keyId: 'unknown' }],
      VALID_NOW,
    )).toThrow('signature threshold')
    const moving = structuredClone(BOOTSTRAP_CATALOG_ENVELOPE)
    moving.entries[0]!.artifact.version = 'latest'
    moving.entriesDigest = canonicalSha256(moving.entries)
    expect(() => verifyCatalog(
      BOOTSTRAP_CATALOG_ROOT,
      moving,
      BOOTSTRAP_CATALOG_SIGNATURES,
      VALID_NOW,
    )).toThrow('moving artifact reference is forbidden')
    const lifecycle = structuredClone(BOOTSTRAP_CATALOG_ENVELOPE)
    lifecycle.entries[0]!.lifecycle.install = { status: 'available', reason: 'host-capability' }
    lifecycle.entriesDigest = canonicalSha256(lifecycle.entries)
    expect(() => verifyCatalog(
      BOOTSTRAP_CATALOG_ROOT,
      lifecycle,
      BOOTSTRAP_CATALOG_SIGNATURES,
      VALID_NOW,
    )).toThrow('catalog lifecycle claim is invalid')
    const unreviewable = structuredClone(BOOTSTRAP_CATALOG_ENVELOPE)
    unreviewable.entries[0]!.artifact.integrity = `sha256:${'1'.repeat(64)}`
    unreviewable.entriesDigest = canonicalSha256(unreviewable.entries)
    expect(() => verifyCatalog(
      BOOTSTRAP_CATALOG_ROOT,
      unreviewable,
      BOOTSTRAP_CATALOG_SIGNATURES,
      VALID_NOW,
    )).toThrow('candidate has no exact review evidence record')
    expect(() => verifyCatalog(
      BOOTSTRAP_CATALOG_ROOT,
      { ...BOOTSTRAP_CATALOG_ENVELOPE, previousRevisionDigest: null },
      BOOTSTRAP_CATALOG_SIGNATURES,
      VALID_NOW,
    )).toThrow('valid previous revision digest')
    expect(() => verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.expiresAt))).toThrow('expired')
  })

  it('admits review support only for exact package-known Plugin, MCP, and Skill artifacts', () => {
    const resolver = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(entry => entry.kind === 'plugin')!
    const [, next] = CAPABILITY_RESOLVER_CANDIDATES
    const nextEntry = {
      ...resolver,
      candidateRef: next.candidateRef,
      artifact: {
        ...resolver.artifact,
        version: next.version,
        integrity: next.integrity,
        sizeBytes: next.sizeBytes,
      },
    }
    expect(catalogReviewEvidenceSupport(resolver)).toBe('package-pinned')
    expect(catalogReviewEvidenceSupport(nextEntry)).toBe('package-pinned')
    expect(catalogReviewEvidenceSupport({
      ...nextEntry,
      candidateRef: 'plugin:dsh-capability-resolver@0.1.2',
      artifact: { ...nextEntry.artifact, version: '0.1.2' },
    })).toBe('unavailable')
    const mcp = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.kind === 'mcp')!
    expect(catalogReviewEvidenceSupport(mcp)).toBe('runtime-bound')
    expect(catalogReviewEvidenceSupport({
      ...mcp,
      candidateRef: 'mcp:io.github.domdomegg/filesystem-mcp@9.9.9',
      artifact: { ...mcp.artifact, version: '9.9.9' },
    })).toBe('unavailable')
    const wiki = BOOTSTRAP_CATALOG_ENVELOPE.entries.find(candidate => candidate.name === 'wiki-page-writer')!
    expect(catalogReviewEvidenceSupport(wiki)).toBe('package-pinned')
    expect(catalogReviewEvidenceSupport({
      ...wiki,
      artifact: { ...wiki.artifact, sizeBytes: wiki.artifact.sizeBytes + 1 },
    })).toBe('unavailable')
    expect(catalogReviewEvidenceSupport({
      ...nextEntry,
      artifact: { ...nextEntry.artifact, sizeBytes: next.sizeBytes + 1 },
    })).toBe('unavailable')
  })
})

describe('loopback catalog RPC', () => {
  it('registers only a read endpoint and rejects malformed or unknown calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-center-host-'))
    vi.useFakeTimers()
    vi.setSystemTime(VALID_NOW)
    try {
      let handler: ConnectionRpcHandler | undefined
      const handle = vi.fn((channel, next, options) => {
        expect(channel).toBe(EXTENSION_CENTER_RPC_CHANNEL)
        expect(options).toEqual({ authority: 'loopback' })
        handler = next
        return async () => {}
      })
      await apply({
        connection: { rpc: { handle } },
        get: () => undefined,
        plugin: async () => {},
        inject: () => ({ dispose: async () => {} }),
        effect: (effect: () => unknown) => effect(),
      } as unknown as Context, { root })
      expect(handle).toHaveBeenCalledOnce()
      if (handler === undefined) throw new Error('Host did not register the catalog RPC')
      const signal = new AbortController().signal
      await expect(handler('catalog/list', { protocolVersion: 1 }, signal)).resolves.toMatchObject({
        ok: true,
        value: {
          catalog: { source: 'bootstrap', freshness: 'bootstrap', degraded: false },
          entries: [
            { kind: 'mcp' }, { kind: 'mcp' }, { kind: 'plugin' }, { kind: 'plugin' },
            { kind: 'skill' }, { kind: 'skill' }, { kind: 'skill' },
          ],
        },
      })
      await expect(handler('catalog/refresh', { protocolVersion: 1 }, signal)).resolves.toMatchObject({
        ok: true,
        value: { catalog: { source: 'bootstrap', freshness: 'bootstrap', degraded: false } },
      })
      await expect(handler('catalog/list', { protocolVersion: 1, injected: true }, signal)).resolves.toMatchObject({
        ok: false,
        error: { code: 'bad-request' },
      })
      await expect(handler('intent/preview', {}, signal)).resolves.toMatchObject({
        ok: false,
        error: { code: 'bad-request' },
      })
      const controller = new AbortController()
      controller.abort()
      await expect(handler('catalog/list', { protocolVersion: 1 }, controller.signal)).resolves.toMatchObject({
        ok: false,
        error: { code: 'cancelled' },
      })
      vi.setSystemTime(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.expiresAt))
      await expect(handler('catalog/list', { protocolVersion: 1 }, signal)).resolves.toMatchObject({
        ok: false,
        error: { code: 'bad-request' },
      })
    } finally {
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })
})
