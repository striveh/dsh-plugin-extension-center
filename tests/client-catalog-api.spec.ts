import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { catalogListResponse, verifyBootstrapCatalog } from '../src/catalog.ts'
import { createExtensionCatalogClient, parseCatalogListResponse } from '../src/client/catalog-api.ts'

const response = catalogListResponse(verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000))

describe('catalog Client wire validation', () => {
  it('calls the catalog endpoint and deeply accepts the verified projection', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, value: response })
    const client = createExtensionCatalogClient({ call } as ClientConnectionRpc)
    await expect(client.list()).resolves.toEqual(response)
    expect(call).toHaveBeenCalledWith(
      '/dsh-extension-center',
      'catalog/list',
      { protocolVersion: 1 },
      undefined,
    )
    await expect(client.refresh?.()).resolves.toEqual(response)
    expect(call).toHaveBeenLastCalledWith(
      '/dsh-extension-center',
      'catalog/refresh',
      { protocolVersion: 1 },
      undefined,
    )
  })

  it('rejects injected fields, invalid freshness, moving coordinates, duplicate refs, and inconsistent Host capability claims', () => {
    expect(() => parseCatalogListResponse({ ...response, injected: true })).toThrow('unexpected fields')

    const freshness = structuredClone(response)
    freshness.catalog.freshness = 'stale' as never
    expect(() => parseCatalogListResponse(freshness)).toThrow('freshness')

    const expired = structuredClone(response)
    expired.catalog.expiresAt = '2000-01-01T00:00:00.000Z'
    expect(() => parseCatalogListResponse(expired)).toThrow('validity interval')

    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(response.catalog.expiresAt))
    expect(() => parseCatalogListResponse(response)).toThrow('validity interval')
    now.mockRestore()

    const moving = structuredClone(response)
    moving.entries[0]!.artifact.version = 'latest'
    expect(() => parseCatalogListResponse(moving)).toThrow('moving catalog entry 0.artifact.version')

    const duplicate = structuredClone(response)
    duplicate.entries[1]!.candidateRef = duplicate.entries[0]!.candidateRef
    duplicate.entries[1]!.kind = duplicate.entries[0]!.kind
    expect(() => parseCatalogListResponse(duplicate)).toThrow('duplicate candidateRef')

    const capability = structuredClone(response)
    capability.hostCapabilities.acquisition = true
    expect(() => parseCatalogListResponse(capability)).toThrow('acquisition claim')

    const enabled = structuredClone(response)
    enabled.hostCapabilities = {
      managedPluginLifecycle: true,
      dynamicMcpConnection: true,
      durableContinuation: true,
      skillRegistry: true,
      toolRegistry: true,
      loaderMutation: true,
      acquisition: true,
      reason: null,
    }
    expect(parseCatalogListResponse(enabled).hostCapabilities.acquisition).toBe(true)

    const activating = structuredClone(enabled)
    activating.hostCapabilities.acquisition = false
    activating.hostCapabilities.reason = 'host-capability'
    expect(parseCatalogListResponse(activating).hostCapabilities.acquisition).toBe(false)

    const missingRegistry = structuredClone(enabled)
    missingRegistry.hostCapabilities.skillRegistry = false
    missingRegistry.hostCapabilities.acquisition = false
    missingRegistry.hostCapabilities.reason = 'host-capability'
    expect(parseCatalogListResponse(missingRegistry).hostCapabilities.skillRegistry).toBe(false)
    missingRegistry.hostCapabilities.acquisition = true
    missingRegistry.hostCapabilities.reason = null
    expect(() => parseCatalogListResponse(missingRegistry)).toThrow('acquisition claim')

    const lifecycle = structuredClone(response) as unknown as {
      entries: Array<{ lifecycle: { install: Record<string, unknown> } }>
    }
    lifecycle.entries[0]!.lifecycle.install = { status: 'available', reason: 'host-capability' }
    expect(() => parseCatalogListResponse(lifecycle)).toThrow('unexpected fields')

    const license = structuredClone(response)
    license.entries[0]!.license.status = 'unknown'
    expect(() => parseCatalogListResponse(license)).toThrow('license evidence')

    const missing = structuredClone(response) as unknown as { entries: Array<{ source: Record<string, unknown> }> }
    delete missing.entries[0]!.source.upstreamUrl
    expect(() => parseCatalogListResponse(missing)).toThrow('unexpected fields')
  })

  it('accepts the exact alpha Host coordinate without admitting an unknown DSH version', () => {
    const alpha = structuredClone(response)
    alpha.entries[0]!.compatibility.dsh = '0.1.2-alpha.1'
    expect(parseCatalogListResponse(alpha).entries[0]!.compatibility.dsh).toBe('0.1.2-alpha.1')

    const unknown = structuredClone(alpha)
    unknown.entries[0]!.compatibility.dsh = '0.1.2-alpha.2' as never
    expect(() => parseCatalogListResponse(unknown)).toThrow('compatibility.dsh')
  })
})
