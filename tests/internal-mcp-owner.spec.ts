// @vitest-environment node

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CenterMcpConnectionConflictError,
  CenterMcpConnectionIdempotencyError,
  CenterMcpConnectionStore,
  CenterMcpHttpUnsupportedError,
  CenterMcpConnections,
  type CenterMcpClientConfig,
  type CenterMcpConnectionDesired,
  type CenterMcpConnectionView,
} from '../src/internal/mcp/index.ts'

interface TestToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

class TestTools extends Service {
  readonly definitions = new Map<string, TestToolDefinition>()
  readonly retainOnDispose = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(definition: TestToolDefinition): () => void {
    if (this.definitions.has(definition.name)) throw new Error(`duplicate test tool: ${definition.name}`)
    this.definitions.set(definition.name, definition)
    return () => {
      if (this.retainOnDispose.has(definition.name)) return
      if (this.definitions.get(definition.name) === definition) this.definitions.delete(definition.name)
    }
  }

  get(name: string): TestToolDefinition | undefined {
    return this.definitions.get(name)
  }

  schemas(): readonly TestToolDefinition[] {
    return [...this.definitions.values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }))
  }
}

const healthyClient: Plugin<CenterMcpClientConfig> = {
  name: 'test-mcp-client',
  inject: ['tools'],
  apply(ctx: Context, config: CenterMcpClientConfig) {
    const tools = ctx.get('tools') as TestTools
    const name = `mcp__${config.serverName}__${config.transport === 'stdio' ? config.args[0] ?? 'ping' : 'http_ping'}`
    ctx.effect(() => tools.register({ name, description: 'Fixture MCP tool.', parameters: {} }), 'test-mcp-client.tool')
  },
}

const failingClient: Plugin<CenterMcpClientConfig> = {
  name: 'failing-test-mcp-client',
  inject: ['tools'],
  apply(ctx: Context, config: CenterMcpClientConfig) {
    const tools = ctx.get('tools') as TestTools
    ctx.effect(
      () => tools.register({ name: `mcp__${config.serverName}__partial`, description: 'Must be cleaned.', parameters: {} }),
      'failing-test-mcp-client.partial-tool',
    )
    throw new Error('fixture MCP startup failed')
  },
}

const reconnect = Object.freeze({
  enabled: true,
  initialDelayMs: 50,
  maxDelayMs: 500,
  maxAttempts: 3,
})

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'center-mcp-owner-'))
  roots.push(value)
  return value
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await pathExists(path))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function spawnStoreWorker(args: readonly string[]): Readonly<{
  child: ChildProcessWithoutNullStreams
  output: () => string
}> {
  const child = spawn(process.execPath, [
    '--experimental-transform-types',
    new URL('./fixtures/mcp-store-worker.mts', import.meta.url).pathname,
    ...args,
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += String(value) })
  child.stderr.on('data', value => { output += String(value) })
  return { child, output: () => output }
}

async function waitForWorker(worker: ReturnType<typeof spawnStoreWorker>): Promise<void> {
  const [code, signal] = await once(worker.child, 'exit') as [number | null, NodeJS.Signals | null]
  if (code !== 0) throw new Error(`MCP store worker failed with code ${String(code)} signal ${String(signal)}\n${worker.output()}`)
}

function desired(id: string, tool: string, enabled: boolean): CenterMcpConnectionDesired {
  return {
    id,
    enabled,
    transport: {
      transport: 'stdio',
      command: process.execPath,
      args: [tool],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 10_000,
      reconnect,
    },
  }
}

interface MountedOwner {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly owner: CenterMcpConnections
  readonly tools: TestTools
}

async function mount(
  stateRoot: string,
  clientPlugin: Plugin<CenterMcpClientConfig> | null = healthyClient,
): Promise<MountedOwner> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TestTools)
  const fiber = ctx.plugin(CenterMcpConnections, {
    root: stateRoot,
    ...clientPlugin === null ? {} : { clientPlugin },
  })
  await fiber
  return {
    ctx,
    fiber,
    owner: ctx.get('mcpConnections') as CenterMcpConnections,
    tools: ctx.get('tools') as TestTools,
  }
}

function view(owner: CenterMcpConnections, id: string): CenterMcpConnectionView {
  const value = owner.get(id)
  if (value === undefined) throw new Error(`missing test MCP connection ${id}`)
  return value
}

describe('Center-owned MCP connection lifecycle', () => {
  it('owns revisions, child fibers, qualified tools, removal, restore, and purge', async () => {
    const mounted = await mount(await root())
    const configured = await mounted.owner.configure({
      desired: desired('docs', 'search', false),
      mutationId: 'configure-docs',
      expectedRevision: 0,
    })
    expect(configured).toMatchObject({ operation: 'configure', revision: 1, snapshotRevision: 1, changed: true })
    expect(view(mounted.owner, 'docs')).toMatchObject({
      desired: { enabled: false },
      observed: { state: 'disabled', desiredRevision: 1 },
      tools: { names: [] },
    })

    const enabled = await mounted.owner.enable({
      id: 'docs',
      mutationId: 'enable-docs',
      expectedRevision: configured.revision,
    })
    expect(mounted.tools.get('mcp__docs__search')).toBeDefined()
    expect(view(mounted.owner, 'docs')).toMatchObject({
      observed: { state: 'ready', desiredRevision: enabled.revision },
      tools: { names: ['mcp__docs__search'] },
    })
    expect(mounted.owner.registeredToolNames('docs', ['mcp__docs__search']))
      .toEqual(['mcp__docs__search'])

    const generation = view(mounted.owner, 'docs').tools.generation
    const updated = await mounted.owner.update({
      id: 'docs',
      mutationId: 'update-docs',
      expectedRevision: enabled.revision,
      transport: desired('docs', 'fetch', true).transport,
    })
    expect(mounted.tools.get('mcp__docs__search')).toBeUndefined()
    expect(mounted.tools.get('mcp__docs__fetch')).toBeDefined()
    expect(view(mounted.owner, 'docs').tools.generation).toBeGreaterThan(generation)

    const removed = await mounted.owner.remove({
      id: 'docs',
      mutationId: 'remove-docs',
      expectedRevision: updated.revision,
    })
    expect(mounted.tools.get('mcp__docs__fetch')).toBeUndefined()
    expect(mounted.owner.registeredToolNames('docs', ['mcp__docs__fetch'])).toEqual([])
    expect(mounted.owner.get('docs')).toBeUndefined()
    expect(mounted.owner.getRemoved('docs')).toMatchObject({ revision: removed.revision, desired: { enabled: true } })

    const restored = await mounted.owner.restore({
      id: 'docs',
      mutationId: 'restore-docs',
      expectedRevision: removed.revision,
    })
    expect(restored.revision).toBe(removed.revision + 1)
    expect(mounted.tools.get('mcp__docs__fetch')).toBeDefined()

    const removedAgain = await mounted.owner.remove({
      id: 'docs',
      mutationId: 'remove-docs-again',
      expectedRevision: restored.revision,
    })
    await mounted.owner.purge({
      id: 'docs',
      mutationId: 'purge-docs',
      expectedRevision: removedAgain.revision,
    })
    expect(mounted.owner.getRemoved('docs')).toBeUndefined()
  })

  it('replays exact mutation ids, rejects mismatched reuse, and enforces record CAS', async () => {
    const mounted = await mount(await root())
    const request = {
      desired: desired('stable', 'ping', false),
      mutationId: 'stable-configure',
      expectedRevision: 0 as const,
    }
    const first = await mounted.owner.configure(request)
    const snapshotRevision = mounted.owner.snapshot().revision
    await expect(mounted.owner.configure(request)).resolves.toEqual(first)
    expect(mounted.owner.snapshot().revision).toBe(snapshotRevision)

    await expect(mounted.owner.configure({
      ...request,
      desired: desired('stable', 'different', false),
    })).rejects.toBeInstanceOf(CenterMcpConnectionIdempotencyError)
    await expect(mounted.owner.enable({
      id: 'stable',
      mutationId: 'stale-enable',
      expectedRevision: 0,
    })).rejects.toBeInstanceOf(CenterMcpConnectionConflictError)
  })

  it('reports a real Tool registry residue even after owner provenance is removed', async () => {
    const mounted = await mount(await root())
    const configured = await mounted.owner.configure({
      desired: desired('residual', 'search', true),
      mutationId: 'configure-residual',
      expectedRevision: 0,
    })
    const name = 'mcp__residual__search'
    mounted.tools.retainOnDispose.add(name)

    await mounted.owner.remove({
      id: 'residual',
      mutationId: 'remove-residual',
      expectedRevision: configured.revision,
    })

    expect(mounted.owner.get('residual')).toBeUndefined()
    expect(mounted.owner.registeredToolNames('residual', [name])).toEqual([name])
    mounted.tools.retainOnDispose.delete(name)
    mounted.tools.definitions.delete(name)
  })

  it('cold-remounts enabled desired state and disposes every child with the owner', async () => {
    const stateRoot = await root()
    const first = await mount(stateRoot)
    await first.owner.configure({
      desired: desired('resume', 'kept', true),
      mutationId: 'resume-configure',
      expectedRevision: 0,
    })
    expect(first.tools.get('mcp__resume__kept')).toBeDefined()
    await first.fiber.dispose()
    expect(first.tools.get('mcp__resume__kept')).toBeUndefined()

    const resumed = await mount(stateRoot)
    expect(resumed.tools.get('mcp__resume__kept')).toBeDefined()
    expect(view(resumed.owner, 'resume')).toMatchObject({ observed: { state: 'ready' } })
    const persisted = new CenterMcpConnectionStore(stateRoot)
    expect(await persisted.load()).toMatchObject({ schemaVersion: 1, revision: 1 })
    persisted.close()
  })

  it('serializes two process writers before either can transform stale desired state', async () => {
    const stateRoot = await root()
    const firstStarted = join(stateRoot, 'first-started')
    const firstEntered = join(stateRoot, 'first-entered')
    const secondStarted = join(stateRoot, 'second-started')
    const secondEntered = join(stateRoot, 'second-entered')
    const release = join(stateRoot, 'release-first')
    const first = spawnStoreWorker([stateRoot, 'alpha', firstStarted, firstEntered, release, 'hold'])
    await waitForPath(firstEntered)
    const second = spawnStoreWorker([stateRoot, 'beta', secondStarted, secondEntered, release, 'continue'])
    await waitForPath(secondStarted)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(await pathExists(secondEntered)).toBe(false)
    await writeFile(release, '')
    await Promise.all([waitForWorker(first), waitForWorker(second)])
    expect(await pathExists(secondEntered)).toBe(true)

    const persisted = new CenterMcpConnectionStore(stateRoot)
    const state = await persisted.load()
    persisted.close()
    expect(state.revision).toBe(2)
    expect(state.connections.map(record => record.desired.id)).toEqual(['alpha', 'beta'])
    expect(state.mutations.map(record => record.mutationId).sort()).toEqual(['configure-alpha', 'configure-beta'])
  })

  it('mounts the published official rc.2 MCP client on the real child-Fiber path', async () => {
    const stateRoot = await root()
    const server = join(stateRoot, 'fixture-mcp-server.mjs')
    await writeFile(server, [
      "process.stdin.setEncoding('utf8')",
      "let buffer = ''",
      "const send = value => process.stdout.write(`${JSON.stringify(value)}\\n`)",
      "process.stdin.on('data', chunk => {",
      "  buffer += chunk",
      "  for (;;) {",
      "    const newline = buffer.indexOf('\\n')",
      "    if (newline < 0) break",
      "    const line = buffer.slice(0, newline).replace(/\\r$/, '')",
      "    buffer = buffer.slice(newline + 1)",
      "    if (line.length === 0) continue",
      "    const message = JSON.parse(line)",
      "    if (message.method === 'initialize') send({",
      "      jsonrpc: '2.0', id: message.id, result: {",
      "        protocolVersion: message.params.protocolVersion,",
      "        capabilities: { tools: {} },",
      "        serverInfo: { name: 'center-test', version: '1.0.0' },",
      "      },",
      "    })",
      "    if (message.method === 'tools/list') send({",
      "      jsonrpc: '2.0', id: message.id, result: {",
      "        tools: [{ name: 'ping', description: 'Fixture ping.', inputSchema: { type: 'object' } }],",
      "      },",
      "    })",
      "  }",
      "})",
      '',
    ].join('\n'), { mode: 0o700 })

    const mounted = await mount(stateRoot, null)
    await mounted.owner.configure({
      desired: {
        ...desired('official', 'unused', true),
        transport: {
          ...desired('official', 'unused', true).transport,
          command: process.execPath,
          args: [server],
          cwd: stateRoot,
        },
      },
      mutationId: 'official-configure',
      expectedRevision: 0,
    })

    expect(view(mounted.owner, 'official')).toMatchObject({
      observed: { state: 'ready' },
      tools: { names: ['mcp__official__ping'] },
    })
    expect(mounted.tools.get('mcp__official__ping')).toBeDefined()
  })

  it('rolls back a partially mounted client fiber and publishes a sanitized error state', async () => {
    const mounted = await mount(await root(), failingClient)
    await expect(mounted.owner.configure({
      desired: desired('broken', 'unused', true),
      mutationId: 'broken-configure',
      expectedRevision: 0,
    })).resolves.toMatchObject({ operation: 'configure', changed: true })

    expect(mounted.tools.get('mcp__broken__partial')).toBeUndefined()
    expect(view(mounted.owner, 'broken')).toMatchObject({
      desired: { enabled: true },
      observed: { state: 'error', message: 'Error: fixture MCP startup failed' },
      tools: { names: [] },
    })
  })

  it('fails closed before persistence when rc.2 cannot enforce HTTP redirect rejection', async () => {
    const mounted = await mount(await root())
    await expect(mounted.owner.configure({
      desired: {
        id: 'remote',
        enabled: false,
        transport: {
          transport: 'streamable-http',
          url: 'https://mcp.example.test/endpoint',
          headers: {},
          redirect: 'error',
          toolCallTimeoutMs: 10_000,
          reconnect,
        },
      },
      mutationId: 'configure-remote',
      expectedRevision: 0,
    })).rejects.toBeInstanceOf(CenterMcpHttpUnsupportedError)
    expect(mounted.owner.snapshot()).toMatchObject({ revision: 0, connections: [], removed: [] })
  })
})
