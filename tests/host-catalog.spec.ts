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
import { canonicalSha256, catalogListResponse, verifyBootstrapCatalog, verifyCatalog } from '../src/catalog.ts'
import { EXTENSION_CENTER_RPC_CHANNEL } from '../src/catalog-contract.ts'
import { apply } from '../src/index.ts'

const VALID_NOW = Date.parse('2026-08-25T10:15:00.000Z')

describe('signed bootstrap catalog', () => {
  it('verifies the threshold signature and projects all three extension kinds without write capabilities', () => {
    const catalog = verifyBootstrapCatalog(VALID_NOW)
    const response = catalogListResponse(catalog)
    expect(catalog.keyIds).toEqual(['bootstrap-2026-08-25-6'])
    expect(response.catalog).toMatchObject({ revision: 6, signatureStatus: 'verified' })
    expect(response.entries.map(entry => entry.kind).sort()).toEqual(['mcp', 'plugin', 'skill'])
    expect(response.entries[0]?.configuration).toMatchObject({ required: false, credentials: 'none' })
    expect(response.entries[0]?.configuration.fields).toHaveLength(10)
    expect(response.entries[0]?.permissions).toEqual(expect.arrayContaining([
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
      profileTransaction: false,
      dynamicMcpConnection: false,
      durableContinuation: false,
      skillRegistry: false,
      toolRegistry: false,
      loaderObservation: false,
      acquisition: false,
      reason: 'host-capability',
    })
    expect(() => catalogListResponse(catalog, {
      profileTransaction: true,
      dynamicMcpConnection: true,
      durableContinuation: true,
      skillRegistry: false,
      toolRegistry: false,
      loaderObservation: false,
      acquisition: true,
      reason: null,
    })).toThrow('Host acquisition claim')
    expect(catalogListResponse(catalog, {
      profileTransaction: true,
      dynamicMcpConnection: true,
      durableContinuation: true,
      skillRegistry: true,
      toolRegistry: true,
      loaderObservation: true,
      acquisition: true,
      reason: null,
    }).hostCapabilities.acquisition).toBe(true)
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
    expect(() => verifyBootstrapCatalog(Date.parse('2027-08-25T10:15:00.000Z'))).toThrow('expired')
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
        effect: (effect: () => unknown) => effect(),
      } as unknown as Context, { root })
      expect(handle).toHaveBeenCalledOnce()
      if (handler === undefined) throw new Error('Host did not register the catalog RPC')
      const signal = new AbortController().signal
      await expect(handler('catalog/list', { protocolVersion: 1 }, signal)).resolves.toMatchObject({
        ok: true,
        value: {
          catalog: { source: 'bootstrap', freshness: 'bootstrap', degraded: false },
          entries: [{ kind: 'plugin' }, { kind: 'mcp' }, { kind: 'skill' }],
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
      vi.setSystemTime(Date.parse('2027-08-25T10:15:00.000Z'))
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
