import { describe, expect, it } from 'vitest'
import { hostCapabilities, probeHostOwners, type HostOwnerDefinitions } from '../src/host/index.ts'

class ProfileDefinition {}
class McpDefinition {}
class ContinuationDefinition {}

const profileMethods = {
  snapshot() {}, stage() {}, commit() {}, abort() {}, restoreLastGood() {}, getRestoreReceipt() {}, acknowledgeBoot() {}, list() {},
}
const mcpMethods = {
  snapshot() {}, get() {}, getRemoved() {}, configure() {}, enable() {}, disable() {}, update() {}, remove() {}, restore() {}, purge() {},
}
const continuationMethods = {
  create() {}, reserve() {}, get() {}, list() {}, cancel() {}, supersede() {}, registerVerifier() {},
}

class ProfileOwner extends ProfileDefinition {
  readonly protocolVersion = 1
  snapshot = profileMethods.snapshot
  stage = profileMethods.stage
  commit = profileMethods.commit
  abort = profileMethods.abort
  restoreLastGood = profileMethods.restoreLastGood
  getRestoreReceipt = profileMethods.getRestoreReceipt
  acknowledgeBoot = profileMethods.acknowledgeBoot
  list = profileMethods.list
}

class McpOwner extends McpDefinition {
  readonly protocolVersion = 1
  snapshot = mcpMethods.snapshot
  get = mcpMethods.get
  getRemoved = mcpMethods.getRemoved
  configure = mcpMethods.configure
  enable = mcpMethods.enable
  disable = mcpMethods.disable
  update = mcpMethods.update
  remove = mcpMethods.remove
  restore = mcpMethods.restore
  purge = mcpMethods.purge
}

class ContinuationOwner extends ContinuationDefinition {
  readonly protocolVersion = 1
  create = continuationMethods.create
  reserve = continuationMethods.reserve
  get = continuationMethods.get
  list = continuationMethods.list
  cancel = continuationMethods.cancel
  supersede = continuationMethods.supersede
  registerVerifier = continuationMethods.registerVerifier
}

const definitions: HostOwnerDefinitions = {
  profileTransactions: ProfileDefinition,
  mcpConnections: McpDefinition,
  taskContinuations: ContinuationDefinition,
}

const existingOwners = {
  skills: { registerProvider() {}, snapshot() {}, list() {}, get() {} },
  tools: { register() {} },
  loader: { await() {}, entries() {} },
}

function lookup(values: Readonly<Record<string, unknown>>) {
  return { get: (name: string) => values[name] }
}

describe('exact Host owner probing', () => {
  it('requires the official Definition identity, protocol version, and complete method set', () => {
    const owners = probeHostOwners(lookup({
      profileTransactions: new ProfileOwner(),
      mcpConnections: new McpOwner(),
      taskContinuations: new ContinuationOwner(),
      ...existingOwners,
    }), definitions)
    expect(hostCapabilities(owners)).toMatchObject({ acquisition: true })

    const sameNameFakes = probeHostOwners(lookup({
      profileTransactions: { protocolVersion: 1, ...profileMethods },
      mcpConnections: { protocolVersion: 1, ...mcpMethods },
      taskContinuations: { protocolVersion: 1, ...continuationMethods },
      ...existingOwners,
    }), definitions)
    expect(hostCapabilities(sameNameFakes)).toMatchObject({
      profileTransaction: false,
      dynamicMcpConnection: false,
      durableContinuation: false,
      acquisition: false,
    })

    const wrongVersion = new ProfileOwner() as ProfileOwner & { protocolVersion: number }
    Object.defineProperty(wrongVersion, 'protocolVersion', { value: 2 })
    expect(probeHostOwners(lookup({
      profileTransactions: wrongVersion,
      mcpConnections: new McpOwner(),
      taskContinuations: new ContinuationOwner(),
      ...existingOwners,
    }), definitions).profileTransactions).toBeNull()
  })
})
