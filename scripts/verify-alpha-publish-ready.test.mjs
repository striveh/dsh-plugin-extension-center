import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertAlphaPublicationLock,
  assertAlphaPublicationManifest,
} from './verify-alpha-publish-ready.mjs'

const clientPackages = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-slots',
]

function manifest() {
  const peers = Object.fromEntries(clientPackages.map(name => [name, '0.1.2-alpha.1']))
  return {
    name: 'dsh-plugin-extension-center',
    version: '0.2.0-alpha.1',
    publishConfig: { access: 'public', tag: 'next' },
    engines: { dsh: '0.1.2-alpha.1' },
    dependencies: { '@deepseek-ai/dsh-mcp-client': '0.1.2-alpha.1' },
    peerDependencies: peers,
    devDependencies: {
      '@deepseek-ai/dsh': '0.1.2-alpha.1',
      ...peers,
    },
  }
}

function lockfile() {
  const lines = ["lockfileVersion: '9.0'", 'importers:', '  .:', '    dependencies:']
  for (const name of ['@deepseek-ai/dsh-mcp-client']) {
    lines.push(`      '${name}':`, '        specifier: 0.1.2-alpha.1', '        version: 0.1.2-alpha.1')
  }
  lines.push('    devDependencies:')
  for (const name of ['@deepseek-ai/dsh', ...clientPackages]) {
    lines.push(`      '${name}':`, '        specifier: 0.1.2-alpha.1', '        version: 0.1.2-alpha.1')
  }
  lines.push('packages:')
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-mcp-client', ...clientPackages]) {
    lines.push(`  '${name}@0.1.2-alpha.1': {}`)
  }
  lines.push('snapshots:')
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-mcp-client', ...clientPackages]) {
    lines.push(`  '${name}@0.1.2-alpha.1': {}`)
  }
  return `${lines.join('\n')}\n`
}

test('accepts only one fully aligned alpha publication input', () => {
  assert.deepEqual(assertAlphaPublicationLock(lockfile(), manifest()), {
    centerVersion: '0.2.0-alpha.1',
    dshVersion: '0.1.2-alpha.1',
  })
})

test('rejects a mixed rc.2 runtime or development tree', () => {
  const runtime = manifest()
  runtime.dependencies['@deepseek-ai/dsh-mcp-client'] = '0.1.1-rc.2'
  assert.throws(() => assertAlphaPublicationManifest(runtime), /runtime MCP Client/u)

  const development = manifest()
  development.devDependencies['@deepseek-ai/dsh-client-connection'] = '0.1.1-rc.2'
  assert.throws(() => assertAlphaPublicationManifest(development), /dsh-client-connection/u)
})

test('rejects a stale lock even when the manifest is aligned', () => {
  assert.throws(
    () => assertAlphaPublicationLock(lockfile().replace('specifier: 0.1.2-alpha.1', 'specifier: 0.1.1-rc.2'), manifest()),
    /lockfile does not bind/u,
  )
})

test('rejects a longer prerelease prefix and any mixed transitive DSH release', () => {
  assert.throws(
    () => assertAlphaPublicationLock(
      lockfile().replace('version: 0.1.2-alpha.1', 'version: 0.1.2-alpha.10'),
      manifest(),
    ),
    /lockfile does not bind/u,
  )
  assert.throws(
    () => assertAlphaPublicationLock(
      `${lockfile()}  '@deepseek-ai/dsh-agent@0.1.1-rc.2': {}\n`,
      manifest(),
    ),
    /mixed DSH release/u,
  )
})

test('rejects unenumerated manifest DSH dependencies and incomplete lock trees', () => {
  const mixedManifest = manifest()
  mixedManifest.optionalDependencies = { '@deepseek-ai/dsh-extra': '0.1.1-rc.2' }
  assert.throws(
    () => assertAlphaPublicationLock(lockfile(), mixedManifest),
    /optionalDependencies.*exact official alpha/u,
  )

  const extraManifest = manifest()
  extraManifest.dependencies['@deepseek-ai/dsh-extra'] = '0.1.2-alpha.1'
  assert.throws(
    () => assertAlphaPublicationLock(lockfile(), extraManifest),
    /lockfile does not bind @deepseek-ai\/dsh-extra/u,
  )

  assert.throws(
    () => assertAlphaPublicationLock(lockfile().replace(/packages:[\s\S]*$/u, ''), manifest()),
    /packages section is missing/u,
  )
})

test('rejects mixed DSH references inside an otherwise alpha-keyed lock tree', () => {
  const mixed = lockfile().replace(
    "  '@deepseek-ai/dsh@0.1.2-alpha.1': {}",
    "  '@deepseek-ai/dsh@0.1.2-alpha.1':\n    dependencies:\n      '@deepseek-ai/dsh-agent': 0.1.1-rc.2",
  )
  assert.throws(
    () => assertAlphaPublicationLock(mixed, manifest()),
    /references mixed DSH release/u,
  )
})
