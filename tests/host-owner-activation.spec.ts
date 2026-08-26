import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_CENTER_RPC_CHANNEL } from '../src/catalog-contract.ts'
import type { HostOwnerDefinitions } from '../src/host/index.ts'
import { OperationRunner } from '../src/service/operation-runner.ts'

const recoveryState = vi.hoisted((): {
  invocations: number
  mutationRoot: string
  pending: Promise<void>
  signals: AbortSignal[]
} => ({
  invocations: 0,
  mutationRoot: '',
  pending: Promise.resolve(),
  signals: [],
}))

vi.mock('../src/recovery/install.ts', () => ({
  installPackagedRecoveryExecutable: async (root: string, hostHome: string) => {
    return Object.freeze({
      schemaVersion: 2,
      executablePath: join(root, 'recovery', 'break-glass.mjs'),
      executableSha256: `sha256:${'1'.repeat(64)}`,
      hostCliPath: join(root, 'host', 'dsh.js'),
      hostCliSha256: `sha256:${'2'.repeat(64)}`,
      hostHome,
      packageVersion: '0.0.0-development',
      platform: 'darwin',
      arch: 'arm64',
    })
  },
}))

const { applyWithHostOwnerDefinitions } = await import('../src/host-plugin.ts')

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class TestConnection extends Service {
  private handler: ConnectionRpcHandler | undefined

  readonly rpc = {
    handle: (channel: string, handler: ConnectionRpcHandler, options: { authority: 'loopback' }) => {
      if (channel !== EXTENSION_CENTER_RPC_CHANNEL || options.authority !== 'loopback' || this.handler !== undefined) {
        throw new Error('unexpected Extension Center RPC registration')
      }
      this.handler = handler
      return async () => {
        if (this.handler === handler) this.handler = undefined
      }
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  async call(endpoint: string, payload: unknown): Promise<any> {
    if (this.handler === undefined) throw new Error('Extension Center RPC is unavailable')
    return await this.handler(endpoint, payload, new AbortController().signal)
  }

  registered(): boolean {
    return this.handler !== undefined
  }
}

class TestProfileTransactions extends Service {
  readonly protocolVersion = 1 as const

  constructor(ctx: Context) {
    super(ctx, 'profileTransactions')
  }

  async snapshot() { return {} }
  async stage() { return {} }
  async commit() { return {} }
  async abort() { return false }
  async restoreLastGood() { return {} }
  async getRestoreReceipt() { return null }
  async acknowledgeBoot() { return {} }
  async list() { return {} }
}

class TestMcpConnections extends Service {
  readonly protocolVersion = 1 as const

  constructor(ctx: Context) {
    super(ctx, 'mcpConnections')
  }

  snapshot() { return { revision: 0, connections: [], removed: [] } }
  get() { return undefined }
  getRemoved() { return undefined }
  async configure() { return {} }
  async enable() { return {} }
  async disable() { return {} }
  async update() { return {} }
  async remove() { return {} }
  async restore() { return {} }
  async purge() { return {} }
}

class TestTaskContinuations extends Service {
  readonly protocolVersion = 1 as const
  readonly verifiers = new Set<unknown>()

  constructor(ctx: Context) {
    super(ctx, 'taskContinuations')
  }

  async create() { return {} }
  async reserve() { return {} }
  async get() { return {} }
  async list() { return [] }
  async cancel() { return false }
  async supersede() { return false }
  registerVerifier(verifier: unknown): () => void {
    this.verifiers.add(verifier)
    return () => { this.verifiers.delete(verifier) }
  }
}

class TestSkills extends Service {
  readonly providers = new Set<unknown>()
  registrationCount = 0
  disposalCount = 0

  constructor(ctx: Context) {
    super(ctx, 'skills')
  }

  registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => unknown): () => void {
    this.registrationCount += 1
    const provider = create({ signal: new AbortController().signal, invalidate() {} })
    this.providers.add(provider)
    return () => {
      this.disposalCount += 1
      this.providers.delete(provider)
    }
  }

  async snapshot() { return { skills: [], complete: true } }
  async list() { return [] }
  async get() { return undefined }
}

class TestTools extends Service {
  readonly definitions = new Set<unknown>()
  readonly instanceId = Symbol('TestTools owner')
  registrationCount = 0
  disposalCount = 0

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(definition: unknown): () => void {
    this.registrationCount += 1
    this.definitions.add(definition)
    return () => {
      this.disposalCount += 1
      this.definitions.delete(definition)
    }
  }

  schemas() { return [] }
}

class TestLoader extends Service {
  constructor(ctx: Context) {
    super(ctx, 'loader')
  }

  async await() {}
  * entries(): Iterable<never> {}
}

const definitions: HostOwnerDefinitions = Object.freeze({
  profileTransactions: TestProfileTransactions,
  mcpConnections: TestMcpConnections,
  taskContinuations: TestTaskContinuations,
})

async function capabilities(connection: TestConnection): Promise<Record<string, boolean>> {
  const response = await connection.call('catalog/list', { protocolVersion: 1 })
  if (response.ok !== true) throw new Error('catalog RPC failed')
  return response.value.hostCapabilities as Record<string, boolean>
}

async function acquisition(connection: TestConnection): Promise<boolean> {
  return (await capabilities(connection)).acquisition ?? false
}

async function waitForAcquisition(connection: TestConnection, expected: boolean): Promise<void> {
  await vi.waitFor(async () => {
    expect(await acquisition(connection)).toBe(expected)
  }, { timeout: 2_000, interval: 5 })
}

async function expectWriteAvailability(connection: TestConnection, available: boolean): Promise<void> {
  const response = await connection.call('operation/recover', {
    protocolVersion: 1,
    operationId: 'operation:owner-generation-probe',
  })
  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'bad-request',
      message: available
        ? 'operation is not awaiting explicit recovery'
        : 'Extension Center writes are unavailable because a required Host capability is absent',
    },
  })
}

async function settle(fibers: readonly (Fiber & PromiseLike<Fiber>)[]): Promise<void> {
  const settlements = await Promise.allSettled(fibers.map(fiber => fiber.await()))
  expect(settlements.every(settlement => settlement.status === 'fulfilled')).toBe(true)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('dynamic writable Host owner activation', () => {
  it('keeps read RPC live, rejects a stale recovery generation, withdraws on loss, and tears down with the Center', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-owner-activation-'))
    roots.push(root)
    const ctx = new Context()
    const connectionFiber = ctx.plugin(TestConnection)
    await connectionFiber
    const connection = ctx.get('connection') as TestConnection
    const centerFiber = ctx.plugin({
      name: 'assembled-extension-center',
      inject: ['connection'],
      apply: (scope: Context) => applyWithHostOwnerDefinitions(scope, { root }, definitions),
    })
    await centerFiber

    expect(connectionFiber.state).toBe(2)
    expect(centerFiber.state).toBe(2)
    expect(connection.registered()).toBe(true)
    await waitForAcquisition(connection, false)

    const continuationGate = Promise.withResolvers<void>()
    const staleRecoveryGate = Promise.withResolvers<void>()
    const currentRecoveryGate = Promise.withResolvers<void>()
    recoveryState.invocations = 0
    recoveryState.mutationRoot = root
    recoveryState.pending = staleRecoveryGate.promise
    recoveryState.signals = []
    vi.spyOn(OperationRunner.prototype, 'recover').mockImplementation(async (signal) => {
      const invocation = ++recoveryState.invocations
      const pending = recoveryState.pending
      recoveryState.signals.push(signal)
      await pending
      if (!signal.aborted) {
        await writeFile(join(recoveryState.mutationRoot, `recovery-generation-${invocation}.mutation`), 'mutated\n')
      }
    })
    const profileFiber = ctx.plugin(TestProfileTransactions)
    const mcpFiber = ctx.plugin(TestMcpConnections)
    const skillsFiber = ctx.plugin(TestSkills)
    const toolsFiber = ctx.plugin(TestTools)
    const loaderFiber = ctx.plugin(TestLoader)
    const continuationFiber = ctx.plugin(async (scope: Context) => {
      await continuationGate.promise
      new TestTaskContinuations(scope)
    })
    const ownerSettlements = settle([
      profileFiber,
      mcpFiber,
      skillsFiber,
      toolsFiber,
      loaderFiber,
      continuationFiber,
    ])
    await settle([profileFiber, mcpFiber, skillsFiber, toolsFiber, loaderFiber])
    await waitForAcquisition(connection, false)
    await expect(capabilities(connection)).resolves.toMatchObject({
      profileTransaction: true,
      dynamicMcpConnection: true,
      durableContinuation: false,
      skillRegistry: true,
      toolRegistry: true,
      loaderObservation: true,
      acquisition: false,
    })
    continuationGate.resolve()
    await ownerSettlements
    await expect(capabilities(connection)).resolves.toMatchObject({
      profileTransaction: true,
      dynamicMcpConnection: true,
      durableContinuation: true,
      skillRegistry: true,
      toolRegistry: true,
      loaderObservation: true,
      acquisition: false,
    })
    await expect(connection.call('inventory/list', {
      protocolVersion: 1,
      scopeKey: 'profile:web',
      profileId: 'web',
    })).resolves.toMatchObject({
      ok: true,
      value: {
        hostCapabilities: { acquisition: false },
        inventory: { complete: false },
      },
    })
    expect(recoveryState.invocations).toBe(1)
    expect(recoveryState.signals).toHaveLength(1)
    expect(recoveryState.signals[0]?.aborted).toBe(false)
    await expectWriteAvailability(connection, false)

    const staleTools = ctx.get('tools') as TestTools
    recoveryState.pending = currentRecoveryGate.promise
    const staleToolsDisposal = toolsFiber.dispose()
    await vi.waitFor(() => {
      expect(ctx.get('tools')).toBeUndefined()
    }, { timeout: 2_000, interval: 5 })
    await vi.waitFor(() => {
      expect(recoveryState.signals[0]?.aborted).toBe(true)
    }, { timeout: 2_000, interval: 5 })
    const replacementToolsFiber = ctx.plugin(TestTools)
    await replacementToolsFiber
    const currentTools = ctx.get('tools') as TestTools
    expect(currentTools.instanceId).not.toBe(staleTools.instanceId)
    await expect(capabilities(connection)).resolves.toMatchObject({
      profileTransaction: true,
      dynamicMcpConnection: true,
      durableContinuation: true,
      skillRegistry: true,
      toolRegistry: true,
      loaderObservation: true,
      acquisition: false,
    })
    expect(recoveryState.invocations).toBe(1)

    staleRecoveryGate.resolve()
    await vi.waitFor(() => {
      expect(recoveryState.invocations).toBe(2)
    }, { timeout: 2_000, interval: 5 })
    expect(recoveryState.signals).toHaveLength(2)
    expect(recoveryState.signals[1]?.aborted).toBe(false)
    await expect(exists(join(root, 'recovery-generation-1.mutation'))).resolves.toBe(false)
    await waitForAcquisition(connection, false)
    await expectWriteAvailability(connection, false)
    expect(staleTools.registrationCount).toBe(0)
    expect(staleTools.definitions.size).toBe(0)
    expect(currentTools.registrationCount).toBe(0)
    expect(currentTools.definitions.size).toBe(0)

    currentRecoveryGate.resolve()
    await waitForAcquisition(connection, true)
    await expect(exists(join(root, 'recovery-generation-2.mutation'))).resolves.toBe(true)
    await staleToolsDisposal
    await expectWriteAvailability(connection, true)
    await expect(connection.call('inventory/list', {
      protocolVersion: 1,
      scopeKey: 'profile:web',
      profileId: 'web',
    })).resolves.toMatchObject({
      ok: true,
      value: {
        hostCapabilities: { acquisition: true },
        inventory: { complete: true },
      },
    })

    const continuations = ctx.get('taskContinuations') as TestTaskContinuations
    const skills = ctx.get('skills') as TestSkills
    const tools = ctx.get('tools') as TestTools
    expect(tools.instanceId).toBe(currentTools.instanceId)
    expect(continuations.verifiers.size).toBe(2)
    expect(skills.providers.size).toBe(1)
    expect(tools.definitions.size).toBe(2)
    expect(tools.registrationCount).toBe(2)
    expect(staleTools.registrationCount).toBe(0)

    const lifecycleGate = Promise.withResolvers<void>()
    const lifecycleStarted = Promise.withResolvers<void>()
    const lifecycleMutation = join(root, 'retired-lifecycle.mutation')
    let lifecycleSignal: AbortSignal | undefined
    vi.spyOn(OperationRunner.prototype, 'recoverOperation').mockImplementation(async (operationId, signal) => {
      lifecycleSignal = signal
      lifecycleStarted.resolve()
      await lifecycleGate.promise
      if (!signal.aborted) await writeFile(lifecycleMutation, 'mutated\n')
      return {
        protocolVersion: 1,
        operationId,
        status: 'committed',
        receipt: null,
      }
    })
    const lifecycleCall = connection.call('operation/recover', {
      protocolVersion: 1,
      operationId: 'operation:owner-generation-in-flight',
    })
    await lifecycleStarted.promise
    const mcpDisposal = mcpFiber.dispose()
    let mcpDisposed = false
    void mcpDisposal.then(() => { mcpDisposed = true })
    await waitForAcquisition(connection, false)
    expect(lifecycleSignal?.aborted).toBe(true)
    await expect(capabilities(connection)).resolves.toMatchObject({
      profileTransaction: true,
      dynamicMcpConnection: false,
      durableContinuation: true,
      skillRegistry: true,
      toolRegistry: true,
      loaderObservation: true,
      acquisition: false,
    })
    expect(continuations.verifiers.size).toBe(2)
    expect(skills.providers.size).toBe(1)
    expect(skills.disposalCount).toBe(1)
    expect(tools.definitions.size).toBe(2)
    expect(tools.disposalCount).toBe(0)
    expect(mcpDisposed).toBe(false)

    const replacementMcpFiber = ctx.plugin(TestMcpConnections)
    await replacementMcpFiber
    expect(recoveryState.invocations).toBe(2)
    await expect(exists(lifecycleMutation)).resolves.toBe(false)
    lifecycleGate.resolve()
    await expect(lifecycleCall).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    await mcpDisposal
    expect(mcpDisposed).toBe(true)
    await waitForAcquisition(connection, true)
    expect(recoveryState.invocations).toBe(3)
    await expect(exists(lifecycleMutation)).resolves.toBe(false)
    expect(continuations.verifiers.size).toBe(2)
    expect(skills.providers.size).toBe(1)
    expect(skills.disposalCount).toBe(2)
    expect(tools.definitions.size).toBe(2)
    expect(tools.disposalCount).toBe(2)

    await centerFiber.dispose()
    expect(connection.registered()).toBe(false)
    expect(continuations.verifiers.size).toBe(0)
    expect(skills.providers.size).toBe(0)
    expect(skills.disposalCount).toBe(3)
    expect(tools.definitions.size).toBe(0)
    expect(tools.disposalCount).toBe(4)

    await Promise.all([
      replacementMcpFiber.dispose(),
      replacementToolsFiber.dispose(),
      continuationFiber.dispose(),
      loaderFiber.dispose(),
      skillsFiber.dispose(),
      profileFiber.dispose(),
      connectionFiber.dispose(),
    ])
  })
})
