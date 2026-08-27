import { describe, expect, it } from 'vitest'
import { bindHostOwners, hostCapabilities } from '../src/host/index.ts'

const managedPlugins = {
  async snapshot(profileId: string) {
    return {
      profileId,
      revision: 1,
      digest: `sha256:${'1'.repeat(64)}` as `sha256:${string}`,
      materialRoot: '/managed',
      bootStatus: 'verified' as const,
      ownerRevision: `managed:1:${profileId}`,
    }
  },
}

const mcpConnections = {
  protocolVersion: 1 as const,
  snapshot() { return { revision: 0, connections: [], removed: [] } },
  get() {},
  getRemoved() {},
  registeredToolNames() { return [] },
  async configure() {},
  async enable() {},
  async disable() {},
  async update() {},
  async remove() {},
  async restore() {},
  async purge() {},
}

const taskContinuations = {
  protocolVersion: 1 as const,
  async create() {},
  async reserve() {},
  async get() {},
  async list() { return [] },
  async cancel() { return false },
  async supersede() { return false },
  async reconcile() {},
  registerVerifier() { return () => {} },
}

const official = {
  skills: { registerProvider() {}, async snapshot() { return { skills: [], complete: true } }, async list() { return [] }, async get() {} },
  tools: { register() { return () => {} } },
  loader: {
    async create() { return 'entry:1' },
    async update() {},
    async remove() {},
    async await() {},
    entries() { return [] },
  },
}

function lookup(values: Readonly<Record<string, unknown>>) {
  return { get: (name: string) => values[name] }
}

describe('independent Host owner binding', () => {
  it('requires Center-owned lifecycles and only official generic registries', () => {
    const owners = bindHostOwners(lookup(official), { managedPlugins, mcpConnections, taskContinuations })
    expect(hostCapabilities(owners)).toEqual({
      managedPluginLifecycle: true,
      dynamicMcpConnection: true,
      durableContinuation: true,
      skillRegistry: true,
      toolRegistry: true,
      loaderMutation: true,
      acquisition: true,
      reason: null,
    })
    expect('profileTransactions' in owners).toBe(false)
  })

  it('fails a malformed Center owner and reports an absent official registry independently', () => {
    expect(() => bindHostOwners(lookup(official), {
      managedPlugins,
      mcpConnections: { ...mcpConnections, protocolVersion: 2 } as never,
      taskContinuations,
    })).toThrow('Center MCP owner is invalid')
    const { registeredToolNames: _registeredToolNames, ...withoutToolRegistryEvidence } = mcpConnections
    expect(() => bindHostOwners(lookup(official), {
      managedPlugins,
      mcpConnections: withoutToolRegistryEvidence as never,
      taskContinuations,
    })).toThrow('Center MCP owner is invalid')
    const { reconcile: _reconcile, ...withoutReconcile } = taskContinuations
    expect(() => bindHostOwners(lookup(official), {
      managedPlugins,
      mcpConnections,
      taskContinuations: withoutReconcile as never,
    })).toThrow('Center continuation owner is invalid')

    const withoutLoader = bindHostOwners(lookup({ ...official, loader: undefined }), {
      managedPlugins,
      mcpConnections,
      taskContinuations,
    })
    expect(hostCapabilities(withoutLoader)).toMatchObject({
      managedPluginLifecycle: true,
      loaderMutation: false,
      acquisition: false,
      reason: 'host-capability',
    })
  })
})
