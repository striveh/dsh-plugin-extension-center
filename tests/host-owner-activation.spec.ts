// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_CENTER_RPC_CHANNEL } from '../src/catalog-contract.ts'

vi.mock('../src/recovery/install.ts', () => ({
  installPackagedRecoveryExecutable: async (root: string) => Object.freeze({
    schemaVersion: 5,
    executablePath: join(root, 'recovery', 'break-glass.mjs'),
    executableSha256: `sha256:${'1'.repeat(64)}`,
    centerRoot: root,
    packageVersion: '0.0.0-development',
    platform: 'darwin',
    arch: 'arm64',
    officialDsh: {
      schemaVersion: 2,
      packageName: '@deepseek-ai/dsh',
      packageVersion: '0.1.1-rc.2',
      packageRoot: root,
      packageTreeSha256: `sha256:${'2'.repeat(64)}`,
      productionDependencies: [],
      entrypointPath: join(root, 'dsh.js'),
      entrypointSha256: `sha256:${'3'.repeat(64)}`,
      hostHome: root,
      timeoutMs: 120_000,
      node: {
        schemaVersion: 1,
        executablePath: process.execPath,
        executableSha256: `sha256:${'4'.repeat(64)}`,
        version: process.version,
      },
      supervisorPath: join(root, 'recovery', 'supervisor.mjs'),
      supervisorSha256: `sha256:${'5'.repeat(64)}`,
      pnpm: {
        schemaVersion: 1,
        packageName: 'pnpm',
        packageVersion: '11.21.0',
        registryIntegrity: 'sha512-UhcFvOaJkk6scvWjWHEi82JonvZXHlW6gAdv1jfBETLs/62ib61Op5xIW/3b/T1aKlsFgFp36JPeceyKbMo7sQ==',
        packageRoot: join(root, 'recovery', 'toolchains', 'fixture', 'pnpm'),
        packageTreeSha256: `sha256:${'6'.repeat(64)}`,
        entrypointPath: join(root, 'recovery', 'toolchains', 'fixture', 'pnpm', 'bin', 'pnpm.mjs'),
        entrypointSha256: `sha256:${'7'.repeat(64)}`,
        shimPath: join(root, 'recovery', 'toolchains', 'fixture', 'bin', 'pnpm'),
        shimSha256: `sha256:${'8'.repeat(64)}`,
        shellPath: '/bin/sh',
        shellSha256: `sha256:${'9'.repeat(64)}`,
        runtimeRoot: join(root, 'recovery', 'toolchains', 'fixture', 'runtime'),
      },
    },
  }),
}))

const { apply } = await import('../src/host-plugin.ts')
const { ManagedPluginOwner, OfficialProfileAmbiguityError } = await import('../src/internal/plugin/index.ts')
const { InternalTaskContinuationOwner } = await import('../src/internal/continuation/index.ts')
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

class TestSkills extends Service {
  readonly providers = new Set<unknown>()
  registrations = 0
  disposals = 0

  constructor(ctx: Context) {
    super(ctx, 'skills')
  }

  registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => unknown): () => void {
    this.registrations += 1
    const provider = create({ signal: new AbortController().signal, invalidate() {} })
    this.providers.add(provider)
    return () => {
      this.disposals += 1
      this.providers.delete(provider)
    }
  }

  async snapshot() { return { skills: [], complete: true } }
  async list() { return [] }
  async get() { return undefined }
}

class TestTools extends Service {
  readonly definitions = new Set<unknown>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(definition: unknown): () => void {
    const name = typeof definition === 'object' && definition !== null
      ? (definition as Readonly<{ name?: unknown }>).name
      : undefined
    if (typeof name !== 'string') throw new Error('test Tool definition has no name')
    if ([...this.definitions].some(item => (item as Readonly<{ name: string }>).name === name)) {
      throw new Error(`tool ${JSON.stringify(name)} is already registered`)
    }
    this.definitions.add(definition)
    return () => { this.definitions.delete(definition) }
  }

  schemas() { return [] }
}

class TestLoader extends Service {
  private next = 0
  private readonly rows = new Map<string, never>()

  constructor(ctx: Context) {
    super(ctx, 'loader')
  }

  async create(): Promise<string> { return `entry:${String(++this.next)}` }
  async update(): Promise<void> {}
  async remove(id: string): Promise<void> { this.rows.delete(id) }
  async await(): Promise<void> {}
  entries(): Iterable<never> { return this.rows.values() }
}

class TestAgents extends Service {
  constructor(ctx: Context) { super(ctx, 'agents') }
  get() { return undefined }
  async resume(): Promise<never> { throw new Error('unexpected continuation resume') }
  withoutInitiator<T>(operation: () => T): T { return operation() }
}

class TestAgentPresets extends Service {
  constructor(ctx: Context) { super(ctx, 'agentPresets') }
  async mount(): Promise<Readonly<{ id: string }>> { return Object.freeze({ id: 'standard' }) }
}

class TestSessions extends Service {
  constructor(ctx: Context) { super(ctx, 'sessions') }
  get() { return undefined }
  async flush() { return false }
}

class TestSessionPersistence extends Service {
  constructor(ctx: Context) { super(ctx, 'sessionPersistence') }
  async load(): Promise<never> { throw new Error('unexpected persisted Session load') }
}

async function capabilities(connection: TestConnection): Promise<Record<string, boolean>> {
  const response = await connection.call('catalog/list', { protocolVersion: 1 })
  if (response.ok !== true) throw new Error('catalog RPC failed')
  return response.value.hostCapabilities as Record<string, boolean>
}

async function mountOfficialServices(ctx: Context): Promise<Readonly<{
  connection: TestConnection
  fibers: readonly Awaited<ReturnType<Context['plugin']>>[]
}>> {
  const fibers = [
    ctx.plugin(TestConnection),
    ctx.plugin(TestSkills),
    ctx.plugin(TestTools),
    ctx.plugin(TestLoader),
    ctx.plugin(TestAgentPresets),
    ctx.plugin(TestAgents),
    ctx.plugin(TestSessions),
    ctx.plugin(TestSessionPersistence),
  ]
  await Promise.all(fibers)
  return Object.freeze({ connection: ctx.get('connection') as TestConnection, fibers: Object.freeze(fibers) })
}

describe('independent Center owner activation', () => {
  it('uses package-scoped acquisition Tool names beside the public resolver Tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-owner-tool-coexistence-'))
    roots.push(root)
    const ctx = new Context()
    const mounted = await mountOfficialServices(ctx)
    const tools = ctx.get('tools') as TestTools
    const disposeResolver = tools.register({ name: 'capability_resolve' })
    const centerFiber = ctx.plugin({
      name: 'assembled-extension-center-tool-coexistence',
      inject: ['connection'],
      apply: (scope: Context) => apply(scope, { root }),
    })

    await expect(centerFiber).resolves.toBeDefined()
    await vi.waitFor(async () => {
      expect((await capabilities(mounted.connection)).acquisition).toBe(true)
    }, { timeout: 2_000, interval: 10 })
    expect([...tools.definitions].map(item => (item as Readonly<{ name: string }>).name).sort()).toEqual([
      'capability_resolve',
      'extension_center_request_acquisition',
      'extension_center_resolve',
    ])

    await centerFiber.dispose()
    expect([...tools.definitions]).toEqual([{ name: 'capability_resolve' }])
    disposeResolver()
    await Promise.all([...mounted.fibers].reverse().map(fiber => fiber.dispose()))
  })

  it('activates recovery RPC while official Profile ambiguity keeps new Plugin planning fail-closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-owner-ambiguity-'))
    roots.push(root)
    const ctx = new Context()
    const mounted = await mountOfficialServices(ctx)
    const initialize = vi.spyOn(ManagedPluginOwner.prototype, 'initialize')
      .mockRejectedValue(new OfficialProfileAmbiguityError('simulated official Profile ambiguity'))
    const centerFiber = ctx.plugin({
      name: 'assembled-extension-center-ambiguity',
      inject: ['connection'],
      apply: (scope: Context) => apply(scope, { root }),
    })

    await expect(centerFiber).resolves.toBeDefined()
    expect(mounted.connection.registered()).toBe(true)
    await vi.waitFor(async () => {
      expect((await capabilities(mounted.connection)).acquisition).toBe(true)
    }, { timeout: 2_000, interval: 10 })
    await expect(mounted.connection.call('operation/recover', {
      protocolVersion: 1,
      operationId: 'operation:profile-ambiguity',
    })).resolves.toMatchObject({
      ok: false,
      error: { message: 'operation is not awaiting explicit recovery' },
    })
    await expect(mounted.connection.call('intent/preview', {
      protocolVersion: 1,
      origin: 'store',
      candidateRef: 'plugin:dsh-capability-resolver@0.1.0',
      operationKind: 'install',
      scopeKey: 'profile:web',
      profileId: 'web',
      continuationId: null,
      targetKey: null,
      configuration: {},
    })).resolves.toMatchObject({
      ok: false,
      error: { message: 'Extension Center operation failed' },
    })
    expect(initialize.mock.calls.length).toBeGreaterThanOrEqual(2)

    await centerFiber.dispose()
    await Promise.all([...mounted.fibers].reverse().map(fiber => fiber.dispose()))
  })

  it('keeps lifecycle RPC fail-closed after a deferred Plugin initialization failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-owner-initialize-failure-'))
    roots.push(root)
    const ctx = new Context()
    const mounted = await mountOfficialServices(ctx)
    const initialize = vi.spyOn(ManagedPluginOwner.prototype, 'initialize')
      .mockRejectedValue(new Error('simulated owner corruption'))
    const centerFiber = ctx.plugin({
      name: 'assembled-extension-center-failure',
      inject: ['connection'],
      apply: (scope: Context) => apply(scope, { root }),
    })

    await expect(centerFiber).resolves.toBeDefined()
    await vi.waitFor(() => { expect(initialize).toHaveBeenCalled() }, { timeout: 2_000, interval: 10 })
    expect(mounted.connection.registered()).toBe(true)
    await expect(mounted.connection.call('catalog/list', { protocolVersion: 1 })).resolves.toMatchObject({
      ok: true,
      value: { hostCapabilities: { acquisition: false } },
    })
    await expect(mounted.connection.call('operation/recover', {
      protocolVersion: 1,
      operationId: 'operation:owner-corruption',
    })).resolves.toMatchObject({
      ok: false,
      error: { message: 'Extension Center lifecycle owners are not active' },
    })
    await centerFiber.dispose()
    await Promise.all([...mounted.fibers].reverse().map(fiber => fiber.dispose()))
  })

  it('returns its Loader callback before deferred Plugin recovery settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-owner-deferred-startup-'))
    roots.push(root)
    const ctx = new Context()
    const mounted = await mountOfficialServices(ctx)
    let releaseInitialization!: () => void
    const initialization = new Promise<void>((resolve) => { releaseInitialization = resolve })
    const initialize = vi.spyOn(ManagedPluginOwner.prototype, 'initialize').mockReturnValue(initialization)
    const centerFiber = ctx.plugin({
      name: 'assembled-extension-center-deferred-startup',
      inject: ['connection'],
      apply: (scope: Context) => apply(scope, { root }),
    })
    let settledBeforeRecovery = false
    const centerSettlement = Promise.resolve(centerFiber).then(() => { settledBeforeRecovery = true })

    try {
      await vi.waitFor(() => { expect(initialize).toHaveBeenCalled() }, { timeout: 2_000, interval: 10 })
      await vi.waitFor(() => { expect(settledBeforeRecovery).toBe(true) }, { timeout: 2_000, interval: 10 })
      expect(mounted.connection.registered()).toBe(true)
      await expect(mounted.connection.call('catalog/list', { protocolVersion: 1 })).resolves.toMatchObject({
        ok: true,
        value: { hostCapabilities: { acquisition: false } },
      })
      await expect(mounted.connection.call('operation/recover', {
        protocolVersion: 1,
        operationId: 'operation:startup-pending',
      })).resolves.toMatchObject({
        ok: false,
        error: { message: 'Extension Center lifecycle owners are not active' },
      })
      releaseInitialization()
      await vi.waitFor(async () => {
        expect((await capabilities(mounted.connection)).acquisition).toBe(true)
      }, { timeout: 2_000, interval: 10 })
    } finally {
      releaseInitialization()
      await centerSettlement
      await centerFiber.dispose()
      await Promise.all([...mounted.fibers].reverse().map(fiber => fiber.dispose()))
    }
  })

  it('disposes the continuation owner concurrently with service withdrawal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-owner-continuation-teardown-'))
    roots.push(root)
    const ctx = new Context()
    const mounted = await mountOfficialServices(ctx)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const originalReconcile = InternalTaskContinuationOwner.prototype.reconcile
    let reconciliations = 0
    vi.spyOn(InternalTaskContinuationOwner.prototype, 'reconcile').mockImplementation(function (signal?: AbortSignal) {
      reconciliations += 1
      if (reconciliations === 1) return originalReconcile.call(this, signal)
      entered.resolve()
      return release.promise
    })
    const originalDispose = InternalTaskContinuationOwner.prototype.dispose
    const dispose = vi.spyOn(InternalTaskContinuationOwner.prototype, 'dispose').mockImplementation(function () {
      release.resolve()
      return originalDispose.call(this)
    })
    const centerFiber = ctx.plugin({
      name: 'assembled-extension-center-continuation-teardown',
      inject: ['connection'],
      apply: (scope: Context) => apply(scope, { root }),
    })

    try {
      await centerFiber
      await entered.promise
      const outcome = await Promise.race([
        centerFiber.dispose().then(() => 'settled' as const),
        new Promise<'timed-out'>(resolve => { setTimeout(() => { resolve('timed-out') }, 500) }),
      ])
      expect(outcome).toBe('settled')
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(ctx.get('taskContinuations')).toBeUndefined()
    } finally {
      release.resolve()
      await centerFiber.dispose()
      await Promise.all([...mounted.fibers].reverse().map(fiber => fiber.dispose()))
    }
  })

  it('activates only from internal owners plus official generic services and withdraws on dependency loss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-owner-activation-'))
    roots.push(root)
    const ctx = new Context()
    const connectionFiber = ctx.plugin(TestConnection)
    await connectionFiber
    const connection = ctx.get('connection') as TestConnection
    const centerFiber = ctx.plugin({
      name: 'assembled-extension-center',
      inject: ['connection'],
      apply: (scope: Context) => apply(scope, { root }),
    })
    await centerFiber
    expect(connection.registered()).toBe(true)
    await expect(connection.call('catalog/list', { protocolVersion: 1 })).resolves.toMatchObject({
      ok: true,
      value: { hostCapabilities: { acquisition: false } },
    })

    const skillsFiber = ctx.plugin(TestSkills)
    const toolsFiber = ctx.plugin(TestTools)
    const loaderFiber = ctx.plugin(TestLoader)
    const agentPresetsFiber = ctx.plugin(TestAgentPresets)
    const agentsFiber = ctx.plugin(TestAgents)
    const sessionsFiber = ctx.plugin(TestSessions)
    const persistenceFiber = ctx.plugin(TestSessionPersistence)
    await Promise.all([
      skillsFiber,
      toolsFiber,
      loaderFiber,
      agentPresetsFiber,
      agentsFiber,
      sessionsFiber,
      persistenceFiber,
    ])

    await vi.waitFor(async () => {
      expect(await capabilities(connection)).toEqual({
        managedPluginLifecycle: true,
        dynamicMcpConnection: true,
        durableContinuation: true,
        skillRegistry: true,
        toolRegistry: true,
        loaderMutation: true,
        acquisition: true,
        reason: null,
      })
    }, { timeout: 2_000, interval: 10 })
    expect(ctx.get('profileTransactions')).toBeUndefined()
    expect(ctx.get('mcpConnections')).toBeDefined()
    expect(ctx.get('taskContinuations')).toBeDefined()
    const skills = ctx.get('skills') as TestSkills
    const tools = ctx.get('tools') as TestTools
    expect(skills.providers.size).toBe(1)
    expect(tools.definitions.size).toBe(2)

    await toolsFiber.dispose()
    await vi.waitFor(async () => {
      await expect(connection.call('operation/recover', {
        protocolVersion: 1,
        operationId: 'operation:dependency-loss',
      })).resolves.toMatchObject({
        ok: false,
        error: { message: 'Extension Center lifecycle owners are not active' },
      })
    }, { timeout: 2_000, interval: 10 })
    expect(skills.providers.size).toBe(0)

    const replacementToolsFiber = ctx.plugin(TestTools)
    await replacementToolsFiber
    await vi.waitFor(async () => {
      expect((await capabilities(connection)).acquisition).toBe(true)
    }, { timeout: 2_000, interval: 10 })
    expect(skills.providers.size).toBe(1)
    expect((ctx.get('tools') as TestTools).definitions.size).toBe(2)

    await centerFiber.dispose()
    expect(connection.registered()).toBe(false)
    expect(skills.providers.size).toBe(0)
    expect(ctx.get('mcpConnections')).toBeUndefined()
    expect(ctx.get('taskContinuations')).toBeUndefined()

    await Promise.all([
      replacementToolsFiber.dispose(),
      persistenceFiber.dispose(),
      sessionsFiber.dispose(),
      agentsFiber.dispose(),
      agentPresetsFiber.dispose(),
      loaderFiber.dispose(),
      skillsFiber.dispose(),
      connectionFiber.dispose(),
    ])
  })
})
