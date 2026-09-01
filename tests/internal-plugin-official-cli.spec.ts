import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfficialDshPluginCli } from '../src/internal/plugin/index.ts'
import { captureCurrentProcessIdentity } from '../src/host/process-identity.ts'
import { RETIRED_PNPM_EXECUTION_IDENTITY, type OfficialDshRecoveryBinding } from '../src/plans/index.ts'
import { installRecoveryExecutable } from '../src/recovery/install.ts'
import { prepareProfileMetadataCache } from '../src/recovery/profile-metadata-cache.ts'

const roots: string[] = []
const spawnedPids: number[] = []
const require = createRequire(import.meta.url)
const originalDshHome = process.env.DSH_HOME
const originalNodeOptions = process.env.NODE_OPTIONS
const originalNodePath = process.env.NODE_PATH
const originalPath = process.env.PATH
const PROFILE_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const INSTALLED_DSH_MANIFEST_PATH = require.resolve('@deepseek-ai/dsh/package.json')
const INSTALLED_DSH_VERSION = (JSON.parse(await readFile(INSTALLED_DSH_MANIFEST_PATH, 'utf8')) as { version?: unknown }).version

function storageKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function prepareProfile(hostHome: string, profileId: string): Promise<string> {
  const profile = join(hostHome, 'profiles', profileId)
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profileId}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }))
  await writeFile(join(profile, 'pnpm-workspace.yaml'), PROFILE_WORKSPACE)
  const lease = join(hostHome, '.extension-center-plugin-coordination', 'leases', storageKey(profileId))
  await mkdir(lease, { recursive: true, mode: 0o700 })
  await writeFile(join(lease, 'owner.json'), JSON.stringify({
    schemaVersion: 2,
    profileId,
    ownerId: `fixture:${profileId}`,
    leaseId: `lease:${randomUUID()}`,
    processIdentity: await captureCurrentProcessIdentity(),
    acquiredAtMs: Date.now(),
  }))
  return profile
}

async function writePnpmModulesMetadata(profile: string, storeDir: string): Promise<string> {
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await mkdir(storeDir, { recursive: true })
  const canonicalStore = await realpath(storeDir)
  await writeFile(join(profile, 'node_modules', '.modules.yaml'), `${JSON.stringify({
    layoutVersion: 5,
    nodeLinker: 'hoisted',
    packageManager: 'pnpm@11.21.0',
    hoistedLocations: {},
    registries: { default: 'https://registry.npmjs.org/' },
    storeDir: canonicalStore,
    virtualStoreDir: '.pnpm',
  }, null, 2)}\n`)
  await writeFile(join(profile, 'pnpm-lock.yaml'), JSON.stringify({
    lockfileVersion: '9.0',
    importers: { '.': { dependencies: {} } },
    packages: {},
    snapshots: {},
  }))
  return canonicalStore
}

async function bindFixture(
  fixture: Readonly<{ entrypoint: string; hostHome: string }>,
  timeoutMs = 5_000,
  nodePath?: string,
  supervisorPath = resolve(process.cwd(), 'lib/recovery/supervisor.js'),
): Promise<OfficialDshRecoveryBinding> {
  const centerRoot = await mkdtemp(join(tmpdir(), 'extension-official-dsh-toolchain-'))
  roots.push(centerRoot)
  const recovery = await installRecoveryExecutable({
    root: centerRoot,
    packageVersion: '0.0.0-test',
    cliPath: resolve(process.cwd(), 'lib/recovery/break-glass.js'),
    supervisorPath,
    nodePath,
    officialDsh: {
      entrypointPath: fixture.entrypoint,
      hostHome: fixture.hostHome,
      timeoutMs,
    },
  })
  return recovery.officialDsh
}

afterEach(async () => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = originalNodeOptions
  if (originalNodePath === undefined) delete process.env.NODE_PATH
  else process.env.NODE_PATH = originalNodePath
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function officialCli(version = '0.1.2-alpha.3'): Promise<Readonly<{
  entrypoint: string
  sourceEntrypoint: string
  hostHome: string
  log: string
}>> {
  const root = await mkdtemp(join(tmpdir(), 'extension-official-dsh-cli-'))
  roots.push(root)
  const directory = join(root, 'cli')
  const library = join(directory, 'lib')
  const entrypoint = join(library, 'bin.js')
  const sourceEntrypoint = join(directory, 'src', 'bin.ts')
  const log = join(root, 'invocations.jsonl')
  const hostHome = join(root, 'dsh-home')
  await mkdir(library, { recursive: true })
  await mkdir(dirname(sourceEntrypoint), { recursive: true })
  await mkdir(hostHome, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version, type: 'module', bin: { dsh: 'lib/bin.js' },
  }))
  await writeFile(entrypoint, [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), dshHome: process.env.DSH_HOME, home: process.env.HOME, nodeOptions: process.env.NODE_OPTIONS, nodePath: process.env.NODE_PATH, path: process.env.PATH, pnpmCache: process.env.pnpm_config_cache, pnpmOffline: process.env.pnpm_config_offline, pnpmIgnoreScripts: process.env.pnpm_config_ignore_scripts, pnpmStore: process.env.pnpm_config_store_dir }) + '\\n')`,
  ].join('\n'))
  await writeFile(sourceEntrypoint, "throw new Error('official DSH source startup entrypoint must not run during recovery')\n")
  return { entrypoint, sourceEntrypoint, hostHome, log }
}

async function hangingOfficialCli(): Promise<Readonly<{ entrypoint: string; hostHome: string; pids: string }>> {
  const fixture = await officialCli()
  const pids = join(dirname(dirname(fixture.entrypoint)), 'pids.json')
  const grandchild = [
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
  ].join(';')
  await writeFile(fixture.entrypoint, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    `const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
    `writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]))`,
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  return { entrypoint: fixture.entrypoint, hostHome: fixture.hostHome, pids }
}

async function noisyHangingOfficialCli(): Promise<Readonly<{ entrypoint: string; hostHome: string; pids: string }>> {
  const fixture = await hangingOfficialCli()
  await writeFile(fixture.entrypoint, `${await readFile(fixture.entrypoint, 'utf8')}\nsetInterval(() => process.stdout.write('late output\\n'), 1)\n`)
  return fixture
}

async function nearDeadlineSuccessfulOfficialCli(
  delayMs: number,
): Promise<Readonly<{ entrypoint: string; hostHome: string; log: string }>> {
  const fixture = await officialCli()
  await writeFile(
    fixture.entrypoint,
    `${await readFile(fixture.entrypoint, 'utf8')}\nawait new Promise(resolveDelay => setTimeout(resolveDelay, ${String(delayMs)}))\n`,
  )
  return fixture
}

async function exitingParentOfficialCli(): Promise<Readonly<{ entrypoint: string; hostHome: string; pids: string }>> {
  const fixture = await officialCli()
  const pids = join(dirname(dirname(fixture.entrypoint)), 'pids.json')
  const grandchild = [
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
  ].join(';')
  await writeFile(fixture.entrypoint, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    `const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
    `writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]))`,
    "process.on('SIGTERM', () => process.exit(143))",
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  return { entrypoint: fixture.entrypoint, hostHome: fixture.hostHome, pids }
}

async function successfulOrphaningOfficialCli(): Promise<Readonly<{ entrypoint: string; hostHome: string; pids: string }>> {
  const fixture = await officialCli()
  const pids = join(dirname(dirname(dirname(fixture.entrypoint))), 'successful-orphan-pids.json')
  const grandchild = [
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
  ].join(';')
  await writeFile(fixture.entrypoint, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    `const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
    'child.unref()',
    `writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]))`,
  ].join('\n'))
  return { entrypoint: fixture.entrypoint, hostHome: fixture.hostHome, pids }
}

async function expectProcessAbsent(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
  }
  throw new Error(`timed-out Plugin CLI process remains alive: ${String(pid)}`)
}

async function waitForJson(path: string, child?: ReturnType<typeof spawn>): Promise<unknown> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error('watchdog fixture parent exited before publishing process evidence')
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
  }
  throw new Error(`process evidence was not published: ${path}`)
}

async function packedSmokePlugin(root: string): Promise<string> {
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'fixture-official-cli-smoke',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    exports: {
      '.': './index.js',
      './cordis.patch.yml': './cordis.patch.yml',
      './package.json': './package.json',
    },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    files: ['index.js', 'cordis.patch.yml'],
  }))
  await writeFile(join(source, 'index.js'), 'export default function apply() {}\n')
  await writeFile(join(source, 'cordis.patch.yml'), '[]\n')
  execFileSync('pnpm', ['pack', '--pack-destination', root], { cwd: source, stdio: 'pipe' })
  const archives = (await readdir(root)).filter(name => name.endsWith('.tgz'))
  if (archives.length !== 1) throw new Error('smoke Plugin pack did not produce one archive')
  return join(root, archives[0]!)
}

describe('official DSH Plugin CLI adapter', () => {
  it('uses the validated current CLI with exact argv and no shell command string', async () => {
    const fixture = await officialCli()
    const profile = await prepareProfile(fixture.hostHome, 'web')
    const profileStore = await writePnpmModulesMetadata(profile, join(dirname(fixture.hostHome), 'profile-store', 'v11'))
    process.env.DSH_HOME = join(dirname(fixture.hostHome), 'foreign-home')
    process.env.NODE_OPTIONS = '--trace-warnings'
    process.env.NODE_PATH = '/foreign/node_modules'
    const binding = await bindFixture(fixture)
    process.env.PATH = '/foreign/bin'
    const cli = new OfficialDshPluginCli(binding)
    const artifact = '/center/artifacts/sha256/fixed.tgz'

    await cli.add('web', '@fixture/plugin', '1.2.3', artifact)
    await cli.remove('web', '@fixture/plugin')

    const invocations = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(invocations).toHaveLength(2)
    expect(invocations[0].argv.slice(0, 7)).toEqual([
      'plugin', '--profile', 'web', 'add', artifact, '--save-exact', '--store-dir',
    ])
    expect(invocations[1].argv.slice(0, 6)).toEqual([
      'plugin', '--profile', 'web', 'remove', '@fixture/plugin', '--store-dir',
    ])
    expect(invocations.every(value => value.argv.slice(-2).join('\0') === `--store-dir\0${profileStore}`
      && value.pnpmStore === profileStore)).toBe(true)
    expect(invocations.every(value => value.dshHome === binding.hostHome
      && typeof value.path === 'string' && value.path.includes('/recovery/toolchains/'))).toBe(true)
    expect(invocations.every(value => value.home === undefined && value.nodeOptions === undefined && value.nodePath === undefined))
      .toBe(true)
  }, 15_000)

  it('uses the Center-private store only while a Profile has no installation metadata', async () => {
    const fixture = await officialCli()
    await prepareProfile(fixture.hostHome, 'web')
    const binding = await bindFixture(fixture)

    await new OfficialDshPluginCli(binding).remove('web', 'fixture-plugin')

    const invocation = JSON.parse((await readFile(fixture.log, 'utf8')).trim()) as {
      argv: string[]
      pnpmStore: string
    }
    const store = invocation.argv.at(-1)
    expect(invocation.argv.at(-2)).toBe('--store-dir')
    expect(store).toMatch(new RegExp(`^${binding.pnpm.runtimeRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/stores/`))
    expect(invocation.pnpmStore).toBe(store)
  }, 15_000)

  it('synthesizes and reuses one exact persistent registry metadata generation', async () => {
    const fixture = await officialCli()
    const profile = await prepareProfile(fixture.hostHome, 'web')
    const packageName = '@deepseek-ai/dsh-llm-replay'
    const version = '0.1.2-alpha.3'
    const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`
    const packagePath = join(profile, 'node_modules', ...packageName.split('/'))
    const storeDir = join(dirname(fixture.hostHome), 'profile-store', 'v11')
    await mkdir(packagePath, { recursive: true })
    await mkdir(storeDir, { recursive: true })
    await writeFile(join(packagePath, 'package.json'), JSON.stringify({
      name: packageName,
      version,
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
    }))
    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.dependencies = { [packageName]: version }
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(join(profile, 'node_modules', '.modules.yaml'), JSON.stringify({
      layoutVersion: 5,
      nodeLinker: 'hoisted',
      packageManager: 'pnpm@11.21.0',
      storeDir: await realpath(storeDir),
      virtualStoreDir: '.pnpm',
      registries: { default: 'https://registry.npmjs.org/' },
      hoistedLocations: { [`${packageName}@${version}`]: [`node_modules/${packageName}`] },
    }))
    await writeFile(join(profile, 'pnpm-lock.yaml'), JSON.stringify({
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: { [packageName]: { specifier: version, version } } } },
      packages: {
        [`${packageName}@${version}`]: {
          resolution: { integrity },
          peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
        },
      },
      snapshots: { [`${packageName}@${version}`]: {} },
    }))
    const binding = await bindFixture(fixture)

    const first = await prepareProfileMetadataCache(binding, 'web')
    const second = await prepareProfileMetadataCache(binding, 'web')

    expect(second).toEqual(first)
    const metadataPath = join(
      first.cachePath,
      'pnpm',
      'v11',
      'metadata',
      'registry.npmjs.org',
      '@deepseek-ai',
      'dsh-llm-replay.jsonl',
    )
    const records = (await readFile(metadataPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const fullMetadataPath = metadataPath.replace('/metadata/', '/metadata-full/')
    expect(await readFile(fullMetadataPath)).toEqual(await readFile(metadataPath))
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      name: packageName,
      versions: {
        [version]: {
          name: packageName,
          version,
          peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
          dist: { integrity },
        },
      },
    })

    await new OfficialDshPluginCli(binding).remove('web', 'fixture-plugin', first)
    const invocation = JSON.parse((await readFile(fixture.log, 'utf8')).trim()) as Record<string, string>
    expect(invocation.pnpmCache).toMatch(/\/operation-[^/]+\/cache$/u)
    expect(invocation.pnpmOffline).toBe('true')
    expect(invocation.pnpmIgnoreScripts).toBe('true')

    const invalidLock = JSON.parse(await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')) as {
      packages: Record<string, { resolution: { integrity: string } }>
    }
    invalidLock.packages[`${packageName}@${version}`]!.resolution.integrity = 'sha512-YWJjZA=='
    await writeFile(join(profile, 'pnpm-lock.yaml'), JSON.stringify(invalidLock))
    await expect(prepareProfileMetadataCache(binding, 'web')).rejects.toThrow('integrity is non-canonical')
  }, 20_000)

  it('caches registry transitives reachable only through a file dependency snapshot', async () => {
    const fixture = await officialCli()
    const profile = await prepareProfile(fixture.hostHome, 'web')
    const localName = 'dsh-extension-center-keyless-agent-proof'
    const localVersion = 'file:../../artifacts/keyless-agent-proof.tgz'
    const localKey = `${localName}@${localVersion}`
    const packageName = '@deepseek-ai/dsh-llm-replay'
    const version = '0.1.2-alpha.3'
    const packageKey = `${packageName}@${version}`
    const integrity = `sha512-${Buffer.alloc(64, 2).toString('base64')}`
    const packagePath = join(profile, 'node_modules', ...packageName.split('/'))
    const storeDir = join(dirname(fixture.hostHome), 'profile-store', 'v11')
    await mkdir(packagePath, { recursive: true })
    await mkdir(storeDir, { recursive: true })
    await writeFile(join(packagePath, 'package.json'), JSON.stringify({ name: packageName, version }))
    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.dependencies = { [localName]: localVersion }
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(join(profile, 'node_modules', '.modules.yaml'), JSON.stringify({
      layoutVersion: 5,
      nodeLinker: 'hoisted',
      packageManager: 'pnpm@11.21.0',
      storeDir: await realpath(storeDir),
      virtualStoreDir: '.pnpm',
      registries: { default: 'https://registry.npmjs.org/' },
      hoistedLocations: { [packageKey]: [`node_modules/${packageName}`] },
    }))
    await writeFile(join(profile, 'pnpm-lock.yaml'), JSON.stringify({
      lockfileVersion: '9.0',
      importers: {
        '.': { dependencies: { [localName]: { specifier: localVersion, version: localVersion } } },
      },
      packages: { [packageKey]: { resolution: { integrity } } },
      snapshots: {
        [localKey]: { dependencies: { [packageName]: version } },
        [packageKey]: {},
      },
    }))

    const cache = await prepareProfileMetadataCache(await bindFixture(fixture), 'web')
    const metadataPath = join(
      cache.cachePath,
      'pnpm',
      'v11',
      'metadata',
      'registry.npmjs.org',
      '@deepseek-ai',
      'dsh-llm-replay.jsonl',
    )
    const records = (await readFile(metadataPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records[1]).toMatchObject({
      name: packageName,
      versions: { [version]: { name: packageName, version, dist: { integrity } } },
    })

    await rm(join(packagePath, 'package.json'))
    await expect(prepareProfileMetadataCache(await bindFixture(fixture), 'web'))
      .rejects.toThrow(`no exact installed manifest for registry package ${packageKey}`)
  }, 20_000)

  it('uses installed manifest ranges instead of peer-context snapshot dependency values', async () => {
    const fixture = await officialCli()
    const profile = await prepareProfile(fixture.hostHome, 'web')
    const parentName = '@deepseek-ai/dsh-llm-replay'
    const parentVersion = '0.1.2-alpha.3'
    const parentKey = `${parentName}@${parentVersion}`
    const childName = '@hono/node-server'
    const childVersion = '2.1.1'
    const childSnapshotKey = `${childName}@${childVersion}(hono@4.13.4)`
    const parentIntegrity = `sha512-${Buffer.alloc(64, 3).toString('base64')}`
    const childIntegrity = `sha512-${Buffer.alloc(64, 4).toString('base64')}`
    const storeDir = join(dirname(fixture.hostHome), 'profile-store', 'v11')
    const parentPath = join(profile, 'node_modules', ...parentName.split('/'))
    const childPath = join(profile, 'node_modules', ...childName.split('/'))
    await mkdir(parentPath, { recursive: true })
    await mkdir(childPath, { recursive: true })
    await mkdir(storeDir, { recursive: true })
    await writeFile(join(parentPath, 'package.json'), JSON.stringify({
      name: parentName,
      version: parentVersion,
      dependencies: { [childName]: '^2.1.0' },
    }))
    await writeFile(join(childPath, 'package.json'), JSON.stringify({
      name: childName,
      version: childVersion,
      peerDependencies: { hono: '^4.0.0' },
    }))
    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.dependencies = { [parentName]: parentVersion }
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(join(profile, 'node_modules', '.modules.yaml'), JSON.stringify({
      layoutVersion: 5,
      nodeLinker: 'hoisted',
      packageManager: 'pnpm@11.21.0',
      storeDir: await realpath(storeDir),
      virtualStoreDir: '.pnpm',
      registries: { default: 'https://registry.npmjs.org/' },
      hoistedLocations: {
        [parentKey]: [`node_modules/${parentName}`],
        [childSnapshotKey]: [`node_modules/${childName}`],
      },
    }))
    await writeFile(join(profile, 'pnpm-lock.yaml'), JSON.stringify({
      lockfileVersion: '9.0',
      importers: {
        '.': { dependencies: { [parentName]: { specifier: parentVersion, version: parentVersion } } },
      },
      packages: {
        [parentKey]: { resolution: { integrity: parentIntegrity } },
        [`${childName}@${childVersion}`]: { resolution: { integrity: childIntegrity } },
      },
      snapshots: {
        [parentKey]: { dependencies: { [childName]: `${childVersion}(hono@4.13.4)` } },
        [childSnapshotKey]: {},
      },
    }))

    const cache = await prepareProfileMetadataCache(await bindFixture(fixture), 'web')
    const metadataPath = join(
      cache.cachePath,
      'pnpm',
      'v11',
      'metadata',
      'registry.npmjs.org',
      '@deepseek-ai',
      'dsh-llm-replay.jsonl',
    )
    const body = await readFile(metadataPath, 'utf8')
    const records = body.trim().split('\n').map(line => JSON.parse(line))
    expect(records[1]).toMatchObject({
      versions: { [parentVersion]: { dependencies: { [childName]: '^2.1.0' } } },
    })
    expect(body).not.toContain('(hono@4.13.4)')
    expect(records[1]).not.toHaveProperty('time')
  }, 20_000)

  it('rejects stale Profile provenance and tampered persistent metadata before CLI mutation', async () => {
    const fixture = await officialCli()
    const profile = await prepareProfile(fixture.hostHome, 'web')
    const binding = await bindFixture(fixture)
    const cache = await prepareProfileMetadataCache(binding, 'web')
    const cli = new OfficialDshPluginCli(binding)
    const manifestPath = join(profile, 'package.json')
    const originalManifest = await readFile(manifestPath)

    await writeFile(manifestPath, JSON.stringify({ name: 'changed-profile', dependencies: {} }))
    await expect(cli.audit('web', cache, true)).rejects.toThrow('changed after its metadata cache generation was prepared')
    await expect(cli.audit('web', cache, false)).resolves.toBeUndefined()
    await writeFile(manifestPath, originalManifest)

    await writeFile(cache.manifestPath, Buffer.concat([await readFile(cache.manifestPath), Buffer.from(' ')]))
    await expect(cli.audit('web', cache, false)).rejects.toThrow('manifest digest changed')
    await expect(readFile(fixture.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('rejects a retired private pnpm identity before probing or spawning official DSH', async () => {
    const fixture = await officialCli()
    await prepareProfile(fixture.hostHome, 'web')
    const current = await bindFixture(fixture)
    const cache = await prepareProfileMetadataCache(current, 'web')
    const retired = structuredClone(current)
    Object.assign(retired.pnpm, RETIRED_PNPM_EXECUTION_IDENTITY)

    await expect(prepareProfileMetadataCache(retired, 'web'))
      .rejects.toThrow('retired private pnpm identity cannot prepare official DSH execution metadata')
    await expect(new OfficialDshPluginCli(retired).remove('web', 'fixture-plugin', cache))
      .rejects.toThrow('retired private pnpm identity cannot execute official DSH')
    await expect(readFile(fixture.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('rejects missing, corrupt, and non-canonical installed Profile store metadata', async () => {
    const fixture = await officialCli()
    const profile = await prepareProfile(fixture.hostHome, 'web')
    const nodeModules = join(profile, 'node_modules')
    const metadataPath = join(nodeModules, '.modules.yaml')
    await mkdir(nodeModules)
    const cli = new OfficialDshPluginCli(await bindFixture(fixture))

    await expect(cli.remove('web', 'fixture-plugin')).rejects.toThrow('modules metadata is missing')

    await writeFile(metadataPath, '{')
    await expect(cli.remove('web', 'fixture-plugin')).rejects.toThrow('modules metadata is invalid JSON')

    await writeFile(metadataPath, JSON.stringify({
      layoutVersion: 5,
      nodeLinker: 'hoisted',
      packageManager: 'pnpm@11.21.0',
      hoistedLocations: {},
      registries: { default: 'https://registry.npmjs.org/' },
      storeDir: 'relative/v11',
      virtualStoreDir: '.pnpm',
    }))
    await expect(cli.remove('web', 'fixture-plugin')).rejects.toThrow('metadata storeDir is unsafe')

    const actualStore = join(dirname(fixture.hostHome), 'actual-store', 'v11')
    const linkedStore = join(dirname(fixture.hostHome), 'linked-store', 'v11')
    await mkdir(actualStore, { recursive: true })
    await mkdir(dirname(linkedStore), { recursive: true })
    await symlink(actualStore, linkedStore, 'dir')
    await writeFile(metadataPath, JSON.stringify({
      layoutVersion: 5,
      nodeLinker: 'hoisted',
      packageManager: 'pnpm@11.21.0',
      hoistedLocations: {},
      registries: { default: 'https://registry.npmjs.org/' },
      storeDir: linkedStore,
      virtualStoreDir: '.pnpm',
    }))
    await expect(cli.remove('web', 'fixture-plugin')).rejects.toThrow('storeDir is not a canonical directory')
    await expect(readFile(fixture.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('binds an official source startup to its manifest-declared built CLI', async () => {
    const fixture = await officialCli()
    await prepareProfile(fixture.hostHome, 'web')
    const binding = await bindFixture({
      entrypoint: fixture.sourceEntrypoint,
      hostHome: fixture.hostHome,
    })

    expect(binding.entrypointPath).toBe(await realpath(fixture.entrypoint))
    expect(binding.entrypointPath).not.toBe(await realpath(fixture.sourceEntrypoint))
    await new OfficialDshPluginCli(binding).remove('web', 'fixture-plugin')
    await expect(readFile(fixture.log, 'utf8')).resolves.toContain('"plugin"')
  }, 15_000)

  it('rejects an undeclared startup file inside the official package', async () => {
    const fixture = await officialCli()
    const undeclaredEntrypoint = join(dirname(fixture.sourceEntrypoint), 'other.ts')
    await writeFile(undeclaredEntrypoint, 'throw new Error()\n')

    await expect(bindFixture({
      entrypoint: undeclaredEntrypoint,
      hostHome: fixture.hostHome,
    })).rejects.toThrow('official DSH startup entrypoint does not match its package manifest')
  })

  it('rejects a source startup when its manifest-declared built CLI is unavailable', async () => {
    const fixture = await officialCli()
    await rm(fixture.entrypoint)

    await expect(bindFixture({
      entrypoint: fixture.sourceEntrypoint,
      hostHome: fixture.hostHome,
    })).rejects.toThrow('official DSH built recovery entrypoint is unavailable')
  })

  it('rejects an official manifest that declares its TypeScript source as the recovery CLI', async () => {
    const fixture = await officialCli()
    const packageRoot = dirname(dirname(fixture.entrypoint))
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: '0.1.2-alpha.3',
      type: 'module',
      bin: { dsh: 'src/bin.ts' },
    }))

    await expect(bindFixture({
      entrypoint: fixture.sourceEntrypoint,
      hostHome: fixture.hostHome,
    })).rejects.toThrow('@deepseek-ai/dsh@0.1.2-alpha.3')
  })

  it('fails closed when the configured entrypoint is not the supported latest official package', async () => {
    const fixture = await officialCli('0.1.1-rc.1')
    await expect(bindFixture(fixture)).rejects.toThrow('@deepseek-ai/dsh@0.1.2-alpha.3')
    await expect(readFile(fixture.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed before installing any Windows mutation or recovery toolchain', async () => {
    const fixture = await officialCli()
    const centerRoot = await mkdtemp(join(tmpdir(), 'extension-windows-toolchain-'))
    roots.push(centerRoot)

    await expect(installRecoveryExecutable({
      root: centerRoot,
      packageVersion: '0.0.0-test',
      cliPath: resolve(process.cwd(), 'lib/recovery/break-glass.js'),
      supervisorPath: resolve(process.cwd(), 'lib/recovery/supervisor.js'),
      officialDsh: {
        entrypointPath: fixture.entrypoint,
        hostHome: fixture.hostHome,
        timeoutMs: 5_000,
      },
      platform: 'win32',
    })).rejects.toThrow('mutation and recovery are unsupported on Windows')
    await expect(readdir(centerRoot)).resolves.toEqual([])
  })

  it('rejects Profile-local package-manager execution controls before invoking DSH', async () => {
    const fixture = await officialCli()
    const profile = await prepareProfile(fixture.hostHome, 'web')
    const cli = new OfficialDshPluginCli(await bindFixture(fixture))

    await writeFile(join(profile, '.npmrc'), 'registry=https://attacker.invalid/\n')
    await expect(cli.remove('web', 'fixture-plugin')).rejects.toThrow('execution control is forbidden: .npmrc')
    await rm(join(profile, '.npmrc'))

    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, JSON.stringify({ ...manifest, scripts: { preinstall: 'exit 1' } }))
    await expect(cli.remove('web', 'fixture-plugin')).rejects.toThrow('manifest contains package-manager execution controls')
    await writeFile(manifestPath, JSON.stringify(manifest))

    await writeFile(join(profile, 'pnpm-workspace.yaml'), `${PROFILE_WORKSPACE}allowBuilds:\n  attacker: true\n`)
    await expect(cli.remove('web', 'fixture-plugin')).rejects.toThrow('workspace contains unsupported execution controls')
    await expect(readFile(fixture.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when the private pnpm package drifts', async () => {
    const fixture = await officialCli()
    await prepareProfile(fixture.hostHome, 'web')
    const binding = await bindFixture(fixture)
    await chmod(binding.pnpm.entrypointPath, 0o600)
    await writeFile(
      binding.pnpm.entrypointPath,
      Buffer.concat([await readFile(binding.pnpm.entrypointPath), Buffer.from('\n// tampered\n')]),
    )

    await expect(new OfficialDshPluginCli(binding).remove('web', 'fixture-plugin'))
      .rejects.toThrow('private pnpm entrypoint hash does not match its pin')
    await expect(readFile(fixture.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when the bound Node executable drifts', async () => {
    const fixture = await officialCli()
    await prepareProfile(fixture.hostHome, 'web')
    const copiedNode = join(dirname(fixture.hostHome), 'bound-node')
    await copyFile(process.execPath, copiedNode)
    await chmod(copiedNode, 0o700)
    const binding = await bindFixture(fixture, 5_000, copiedNode)
    await writeFile(copiedNode, Buffer.concat([await readFile(copiedNode), Buffer.from('\n')]))

    await expect(new OfficialDshPluginCli(binding).remove('web', 'fixture-plugin'))
      .rejects.toThrow('bound Node executable hash does not match its pin')
    await expect(readFile(fixture.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('handles an EPIPE start dispatch without terminating the Host process', async () => {
    const fixture = await officialCli()
    const profileId = 'web'
    await prepareProfile(fixture.hostHome, profileId)
    const root = await mkdtemp(join(tmpdir(), 'extension-closed-supervisor-stdin-'))
    roots.push(root)
    const supervisorPath = join(root, 'closed-stdin.mjs')
    await writeFile(supervisorPath, [
      "import { closeSync } from 'node:fs'",
      'closeSync(0)',
      'process.exit(125)',
    ].join('\n'))
    const cli = new OfficialDshPluginCli(await bindFixture(fixture, 5_000, undefined, supervisorPath))

    await expect(cli.remove(profileId, 'fixture-plugin')).rejects.toThrow(
      /start dispatch failed|closed before its start dispatch became durable|lost its parent/u,
    )
    const lease = join(
      fixture.hostHome,
      '.extension-center-plugin-coordination',
      'leases',
      storageKey(profileId),
    )
    await expect(readdir(lease)).resolves.toEqual(['owner.json'])
  }, 10_000)

  it('observes both Node EPIPE delivery paths after a child closes its stdin', async () => {
    const script = [
      "import { closeSync } from 'node:fs'",
      'closeSync(0)',
      "process.stdout.write('READY\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: {},
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      await new Promise<void>((accept, reject) => {
        let output = ''
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8')
          if (output.includes('READY\n')) accept()
        })
        child.once('error', reject)
        child.once('close', code => reject(new Error(`EPIPE probe closed before READY: ${String(code)}`)))
      })
      const emittedError = new Promise<NodeJS.ErrnoException>(accept => {
        child.stdin.once('error', cause => { accept(cause as NodeJS.ErrnoException) })
      })
      const callbackError = await new Promise<NodeJS.ErrnoException | null | undefined>(accept => {
        child.stdin.write('START\n', cause => { accept(cause as NodeJS.ErrnoException | null | undefined) })
      })
      expect(callbackError?.code).toBe('EPIPE')
      await expect(emittedError).resolves.toMatchObject({ code: 'EPIPE' })
    } finally {
      const closed = child.exitCode === null && child.signalCode === null
        ? new Promise<void>(accept => { child.once('close', () => accept()) })
        : Promise.resolve()
      child.kill('SIGKILL')
      await closed
    }
  }, 5_000)

  it('terminates the complete timed-out process tree before rejecting', async () => {
    const fixture = await hangingOfficialCli()
    await prepareProfile(fixture.hostHome, 'web')
    const cli = new OfficialDshPluginCli(await bindFixture(fixture, 1_000))

    await expect(cli.remove('web', 'fixture-plugin')).rejects.toThrow('timed out')
    const pids = JSON.parse(await readFile(fixture.pids, 'utf8')) as number[]
    spawnedPids.push(...pids)
    await Promise.all(pids.map(expectProcessAbsent))
  }, 10_000)

  it('hard-kills a resistant descendant after the timed-out direct child exits', async () => {
    const fixture = await exitingParentOfficialCli()
    await prepareProfile(fixture.hostHome, 'web')
    const cli = new OfficialDshPluginCli(await bindFixture(fixture, 1_000))

    await expect(cli.remove('web', 'fixture-plugin')).rejects.toThrow('timed out')
    const pids = JSON.parse(await readFile(fixture.pids, 'utf8')) as number[]
    spawnedPids.push(...pids)
    await Promise.all(pids.map(expectProcessAbsent))
  }, 10_000)

  it('accepts an early child outcome when supervisor cleanup closes after the deadline', async () => {
    const fixture = await officialCli()
    await prepareProfile(fixture.hostHome, 'web')
    const root = await mkdtemp(join(tmpdir(), 'extension-delayed-supervisor-close-'))
    roots.push(root)
    const supervisorPath = join(root, 'delayed-close.mjs')
    const outcome = `${JSON.stringify({
      schemaVersion: 1,
      code: 0,
      signal: null,
      launchError: false,
    })}\n`
    await writeFile(supervisorPath, [
      "import { writeSync } from 'node:fs'",
      "process.stdin.setEncoding('utf8')",
      "let buffered = ''",
      "process.stdin.on('data', chunk => {",
      "  buffered += chunk",
      "  if (buffered !== 'START\\n') return",
      `  setTimeout(() => writeSync(3, ${JSON.stringify(outcome)}), 100)`,
      "  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1500)",
      "})",
      'process.stdin.resume()',
    ].join('\n'))
    const cli = new OfficialDshPluginCli(await bindFixture(fixture, 1_000, undefined, supervisorPath))

    await expect(cli.remove('web', 'fixture-plugin')).resolves.toBeUndefined()
    await expect(readFile(fixture.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)

  it('rejects a child completion observed only after the caller deadline', async () => {
    const fixture = await nearDeadlineSuccessfulOfficialCli(500)
    const profileId = 'web'
    await prepareProfile(fixture.hostHome, profileId)
    const cli = new OfficialDshPluginCli(await bindFixture(fixture, 1_000))
    const executionPath = join(
      fixture.hostHome,
      '.extension-center-plugin-coordination',
      'leases',
      storageKey(profileId),
      'execution.json',
    )
    const mutation = cli.remove(profileId, 'fixture-plugin')
    const execution = await waitForJson(executionPath) as { processGroupPid: number }
    await waitForJson(join(dirname(executionPath), 'execution-dispatch.json'))
    spawnedPids.push(execution.processGroupPid)
    let stopped = false
    try {
      process.kill(-execution.processGroupPid, 'SIGSTOP')
      stopped = true
      await new Promise(resolveDelay => setTimeout(resolveDelay, 1_250))
      process.kill(-execution.processGroupPid, 'SIGCONT')
      stopped = false
      await expect(mutation).rejects.toThrow('timed out')
      await expectProcessAbsent(execution.processGroupPid)
    } finally {
      if (stopped) {
        try { process.kill(-execution.processGroupPid, 'SIGCONT') } catch { /* group may have exited */ }
      }
    }
  }, 10_000)

  it('cleans a successful orphan group without signaling its old PGID after supervisor close', async () => {
    const fixture = await successfulOrphaningOfficialCli()
    await prepareProfile(fixture.hostHome, 'web')
    const cli = new OfficialDshPluginCli(await bindFixture(fixture, 1_000))

    const realKill = process.kill.bind(process)
    const staleHardKills: number[] = []
    const callerKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 'SIGKILL') {
        staleHardKills.push(pid)
        return true
      }
      return realKill(pid, signal)
    })
    try {
      await expect(cli.remove('web', 'fixture-plugin')).resolves.toBeUndefined()
      const pids = JSON.parse(await readFile(fixture.pids, 'utf8')) as number[]
      spawnedPids.push(...pids)
      await Promise.all(pids.map(expectProcessAbsent))
      await new Promise(resolveDelay => setTimeout(resolveDelay, 3_250))
      expect(staleHardKills).toEqual([])
    } finally {
      callerKill.mockRestore()
    }
  }, 15_000)

  it('terminates the complete process tree when its mutation parent is killed', async () => {
    const fixture = await noisyHangingOfficialCli()
    const profileId = 'web'
    await prepareProfile(fixture.hostHome, profileId)
    const root = await mkdtemp(join(tmpdir(), 'extension-watchdog-parent-'))
    roots.push(root)
    const centerRoot = join(root, 'center')
    await mkdir(centerRoot, { mode: 0o700 })
    const helperPath = join(root, 'parent.mjs')
    const executionPath = join(
      fixture.hostHome,
      '.extension-center-plugin-coordination',
      'leases',
      storageKey(profileId),
      'execution.json',
    )
    const dispatchPath = join(dirname(executionPath), 'execution-dispatch.json')
    await writeFile(helperPath, [
      "import { createHash, randomUUID } from 'node:crypto'",
      "import { mkdir, writeFile } from 'node:fs/promises'",
      "import { join } from 'node:path'",
      `import { installRecoveryExecutable } from ${JSON.stringify(pathToFileURL(resolve(process.cwd(), 'lib/recovery/install.js')).href)}`,
      `import { OfficialDshPluginCli } from ${JSON.stringify(pathToFileURL(resolve(process.cwd(), 'lib/internal/plugin/official-cli.js')).href)}`,
      `import { captureCurrentProcessIdentity } from ${JSON.stringify(pathToFileURL(resolve(process.cwd(), 'lib/host/process-identity.js')).href)}`,
      "const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))",
      "const key = createHash('sha256').update(config.profileId).digest('hex')",
      "const lease = join(config.hostHome, '.extension-center-plugin-coordination', 'leases', key)",
      "await mkdir(lease, { recursive: true, mode: 0o700 })",
      "await writeFile(join(lease, 'owner.json'), JSON.stringify({ schemaVersion: 2, profileId: config.profileId, ownerId: 'watchdog-parent', leaseId: `lease:${randomUUID()}`, processIdentity: await captureCurrentProcessIdentity(), acquiredAtMs: Date.now() }))",
      "const recovery = await installRecoveryExecutable({ root: config.centerRoot, packageVersion: '0.0.0-test', cliPath: config.recoveryPath, supervisorPath: config.supervisorPath, officialDsh: { entrypointPath: config.entrypoint, hostHome: config.hostHome, timeoutMs: 30000 } })",
      "await new OfficialDshPluginCli(recovery.officialDsh).remove(config.profileId, 'fixture-plugin')",
    ].join('\n'))
    const encoded = Buffer.from(JSON.stringify({
      centerRoot,
      entrypoint: fixture.entrypoint,
      hostHome: fixture.hostHome,
      profileId,
      recoveryPath: resolve(process.cwd(), 'lib/recovery/break-glass.js'),
      supervisorPath: resolve(process.cwd(), 'lib/recovery/supervisor.js'),
    }), 'utf8').toString('base64url')
    const parent = spawn(process.execPath, [helperPath, encoded], {
      cwd: root,
      env: {},
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    parent.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const pids = await waitForJson(fixture.pids, parent) as number[]
    const execution = await waitForJson(executionPath, parent) as { processGroupPid: number }
    const dispatch = await waitForJson(dispatchPath, parent) as { processGroupPid: number }
    expect(dispatch.processGroupPid).toBe(execution.processGroupPid)
    spawnedPids.push(execution.processGroupPid, ...pids)
    if (parent.pid === undefined) throw new Error('watchdog fixture parent has no process id')
    process.kill(parent.pid, 'SIGKILL')
    await new Promise<void>((accept, reject) => {
      parent.once('close', (_code, signal) => {
        if (signal === 'SIGKILL') accept()
        else reject(new Error(`watchdog fixture parent exited unexpectedly: ${stderr}`))
      })
    })
    await Promise.all([execution.processGroupPid, ...pids].map(expectProcessAbsent))
    await expect(readFile(executionPath, 'utf8')).resolves.toContain('watchdog-parent')
    await expect(readFile(dispatchPath, 'utf8')).resolves.toContain('watchdog-parent')
  }, 30_000)

  it.skipIf(INSTALLED_DSH_VERSION !== '0.1.2-alpha.3')(
    'runs add and remove through the latest official CLI and pnpm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-official-dsh-smoke-'))
    roots.push(root)
    const dshHome = join(root, 'dsh-home')
    await mkdir(dshHome, { recursive: true })
    const profile = await prepareProfile(dshHome, 'smoke')
    const artifact = await packedSmokePlugin(root)
    const manifestPath = INSTALLED_DSH_MANIFEST_PATH
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { bin: { dsh: string } }
    const entrypoint = resolve(dirname(manifestPath), manifest.bin.dsh)
    const cli = new OfficialDshPluginCli(await bindFixture({ entrypoint, hostHome: dshHome }, 120_000))
    await cli.add('smoke', 'fixture-official-cli-smoke', '1.0.0', artifact)
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { 'fixture-official-cli-smoke': `file:${artifact}` },
      dsh: { profile: { bundles: ['fixture-official-cli-smoke'] } },
    })

    await cli.remove('smoke', 'fixture-official-cli-smoke')
    const removed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(removed.dependencies ?? {}).toEqual({})
    expect(removed).toMatchObject({ dsh: { profile: { bundles: [] } } })
    }, 180_000,
  )

  it.each(['-web', 'web:next', 'web\0next', 'web\nnext'])('rejects unsafe Profile argv %j', async (profileId) => {
    const fixture = await officialCli()
    await prepareProfile(fixture.hostHome, 'web')
    const cli = new OfficialDshPluginCli(await bindFixture(fixture))

    await expect(cli.remove(profileId, 'fixture-plugin')).rejects.toThrow('profile id is unsafe')
    await expect(readFile(fixture.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
