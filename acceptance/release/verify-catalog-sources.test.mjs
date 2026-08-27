import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { AcceptanceFailure } from '../full-p0/support.mjs'
import {
  parseCatalogSourceArguments,
  verifyCatalogSources,
} from './verify-catalog-sources.mjs'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function sha512(bytes) {
  return `sha512:${createHash('sha512').update(bytes).digest('base64')}`
}

function response(body, options = {}) {
  const bytes = Buffer.from(body)
  const headers = new Headers(options.headers ?? {})
  if (!headers.has('content-type')) headers.set('content-type', options.json ? 'application/json' : 'application/octet-stream')
  if (!headers.has('content-length')) headers.set('content-length', String(bytes.length))
  return new Response(bytes, { status: options.status ?? 200, headers })
}

function entries() {
  const pluginBytes = Buffer.from('plugin archive')
  const mcpBytes = Buffer.from('mcp archive')
  const skillBytes = Buffer.from('---\nname: docs\ndescription: docs\n---\n')
  return {
    bytes: { pluginBytes, mcpBytes, skillBytes },
    envelope: {
      revision: 2,
      entriesDigest: sha256('entries'),
      entries: [{
        candidateRef: 'plugin:example/plugin@1.0.0',
        kind: 'plugin',
        name: 'example-plugin',
        source: {
          type: 'github-release',
          upstreamUrl: 'https://github.com/example/plugin',
          url: 'https://github.com/example/plugin/releases/tag/v1.0.0',
          revision: COMMIT,
        },
        artifact: {
          version: '1.0.0',
          id: 'example-plugin',
          acquisitionUrl: 'https://github.com/example/plugin/releases/download/v1.0.0/example-plugin.tgz',
          sizeBytes: pluginBytes.length,
          integrity: sha256(pluginBytes),
        },
      }, {
        candidateRef: 'mcp:io.example/files@2.0.0',
        kind: 'mcp',
        name: 'io.example/files',
        source: {
          type: 'mcp-registry',
          upstreamUrl: 'https://github.com/example/files',
          url: 'https://registry.modelcontextprotocol.io/?q=io.example%2Ffiles',
          revision: '2.0.0',
        },
        artifact: {
          version: '2.0.0',
          id: '@example/files',
          acquisitionUrl: 'https://registry.npmjs.org/@example/files/-/files-2.0.0.tgz',
          sizeBytes: mcpBytes.length,
          integrity: sha512(mcpBytes),
        },
      }, {
        candidateRef: `skill:example/skills@${COMMIT}`,
        kind: 'skill',
        name: 'docs',
        source: {
          type: 'github-content',
          upstreamUrl: 'https://github.com/example/skills',
          url: `https://github.com/example/skills/tree/${COMMIT}/skills/docs`,
          revision: COMMIT,
        },
        artifact: {
          version: COMMIT,
          id: 'skills/docs/SKILL.md',
          acquisitionUrl: `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/docs/SKILL.md`,
          sizeBytes: skillBytes.length,
          integrity: sha256(skillBytes),
        },
      }],
    },
  }
}

function network(fixture, overrides = {}) {
  const calls = []
  const fetchImpl = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (overrides[url] !== undefined) return overrides[url]()
    if (url.endsWith('/git/ref/tags/v1.0.0')) {
      return response(JSON.stringify({ ref: 'refs/tags/v1.0.0', object: {
        type: 'tag',
        sha: '1111111111111111111111111111111111111111',
      } }), { json: true })
    }
    if (url.endsWith('/git/tags/1111111111111111111111111111111111111111')) {
      return response(JSON.stringify({
        tag: 'v1.0.0',
        sha: '1111111111111111111111111111111111111111',
        object: { type: 'commit', sha: COMMIT },
      }), { json: true })
    }
    if (url.includes('/git/commits/')) {
      return response(JSON.stringify({ sha: COMMIT }), { json: true })
    }
    if (url === 'https://github.com/example/plugin/releases/download/v1.0.0/example-plugin.tgz') {
      return response('', {
        status: 302,
        headers: {
          location: 'https://release-assets.githubusercontent.com/example/plugin-1.0.0.tgz?sp=r&sig=temporary-secret',
        },
      })
    }
    if (url === 'https://release-assets.githubusercontent.com/example/plugin-1.0.0.tgz?sp=r&sig=temporary-secret') {
      return response(fixture.bytes.pluginBytes)
    }
    if (url.includes('/v0.1/servers/io.example%2Ffiles/versions/2.0.0')) {
      return response(JSON.stringify({
        server: {
          name: 'io.example/files',
          version: '2.0.0',
          repository: { source: 'github', url: 'https://github.com/example/files.git' },
          packages: [{
            registryType: 'npm', identifier: '@example/files', version: '2.0.0', transport: { type: 'stdio' },
          }],
        },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
      }), { json: true })
    }
    if (url === 'https://registry.npmjs.org/%40example%2Ffiles/2.0.0') {
      return response(JSON.stringify({
        name: '@example/files',
        version: '2.0.0',
        dist: {
          tarball: 'https://registry.npmjs.org/@example/files/-/files-2.0.0.tgz',
          integrity: sha512(fixture.bytes.mcpBytes).replace('sha512:', 'sha512-'),
        },
      }), { json: true })
    }
    if (url === 'https://registry.npmjs.org/@example/files/-/files-2.0.0.tgz') {
      return response(fixture.bytes.mcpBytes)
    }
    if (url.includes('raw.githubusercontent.com/example/skills/')) return response(fixture.bytes.skillBytes)
    throw new Error(`unexpected URL ${url}`)
  }
  return { calls, fetchImpl }
}

function acceptanceCode(code) {
  return error => error instanceof AcceptanceFailure && error.code === code
}

test('re-fetches exact GitHub Release, MCP Registry, and GitHub content sources and artifact bytes', async () => {
  const fixture = entries()
  const remote = network(fixture)
  const observed = await verifyCatalogSources(fixture.envelope, {
    fetchImpl: remote.fetchImpl,
    githubToken: 'fixture-token',
  })
  assert.deepEqual(observed.map(value => value.candidateRef), [
    'mcp:io.example/files@2.0.0',
    'plugin:example/plugin@1.0.0',
    `skill:example/skills@${COMMIT}`,
  ])
  assert.deepEqual(observed.map(value => value.source.sourceType), [
    'mcp-registry', 'github-release', 'github-content',
  ])
  assert.equal(observed.find(value => value.kind === 'plugin').artifact.redirectCount, 1)
  assert.equal(observed.find(value => value.kind === 'plugin').artifact.finalUrl,
    'https://release-assets.githubusercontent.com/example/plugin-1.0.0.tgz')
  assert.equal(JSON.stringify(observed).includes('temporary-secret'), false)
  assert.equal(observed.find(value => value.kind === 'mcp').artifact.integrity, sha512(fixture.bytes.mcpBytes))
  const githubCalls = remote.calls.filter(value => value.url.startsWith('https://api.github.com/'))
  assert.equal(githubCalls.length, 3)
  assert.equal(githubCalls[0].init.headers.authorization, 'Bearer fixture-token')
  assert.ok(githubCalls.every(value => value.init.headers.authorization === 'Bearer fixture-token'))
  assert.ok(githubCalls.every(value => value.init.headers['x-github-api-version'] === '2022-11-28'))
  assert.ok(remote.calls.filter(value => !value.url.startsWith('https://api.github.com/'))
    .every(value => value.init.headers.authorization === undefined))
  assert.equal(observed.find(value => value.kind === 'mcp').source.packageRegistryEndpoint,
    'https://registry.npmjs.org/%40example%2Ffiles/2.0.0')
  assert.equal(observed.find(value => value.kind === 'skill').artifact.initialUrl,
    `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/docs/SKILL.md`)
  assert.equal(observed.find(value => value.kind === 'skill').artifact.finalUrl,
    `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/docs/SKILL.md`)
  assert.ok(remote.calls.every(value => value.init.method === 'GET'))
})

test('rejects changed bytes, cross-origin redirects, stale tags, and deprecated MCP versions', async () => {
  const cases = [
    {
      code: 'P0-CATALOG-SOURCES-INTEGRITY',
      overrides: {
        [`https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/docs/SKILL.md`]: () => response(Buffer.alloc(entries().bytes.skillBytes.length, 0x78)),
      },
    },
    {
      code: 'P0-CATALOG-SOURCES-REDIRECT',
      overrides: {
        'https://github.com/example/plugin/releases/download/v1.0.0/example-plugin.tgz': () => response('', {
          status: 302, headers: { location: 'https://downloads.example.test/plugin.tgz' },
        }),
      },
    },
    {
      code: 'P0-CATALOG-SOURCES-SOURCE',
      overrides: {
        'https://api.github.com/repos/example/plugin/git/tags/1111111111111111111111111111111111111111': () => response(JSON.stringify({
          object: { type: 'commit', sha: '2222222222222222222222222222222222222222' },
        }), { json: true }),
      },
    },
    {
      code: 'P0-CATALOG-SOURCES-SOURCE',
      overrides: {
        'https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Ffiles/versions/2.0.0': () => response(JSON.stringify({
          server: {
            name: 'io.example/files', version: '2.0.0', repository: { url: 'https://github.com/example/files.git' },
            packages: [{ registryType: 'npm', identifier: '@example/files', version: '2.0.0', transport: { type: 'stdio' } }],
          },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } },
        }), { json: true }),
      },
    },
  ]
  for (const fixtureCase of cases) {
    const fixture = entries()
    const remote = network(fixture, fixtureCase.overrides)
    await assert.rejects(
      verifyCatalogSources(fixture.envelope, { fetchImpl: remote.fetchImpl }),
      acceptanceCode(fixtureCase.code),
    )
  }
})

test('validates every trusted artifact coordinate before making any network request', async () => {
  const fixture = entries()
  fixture.envelope.entries[1].artifact.acquisitionUrl = 'https://packages.example.test/files-2.0.0.tgz'
  const remote = network(fixture)
  await assert.rejects(
    verifyCatalogSources(fixture.envelope, { fetchImpl: remote.fetchImpl }),
    acceptanceCode('P0-CATALOG-SOURCES-SOURCE'),
  )
  assert.deepEqual(remote.calls, [])
})

test('rejects redirect ports and redirects for immutable raw content', async () => {
  for (const location of [
    'https://release-assets.githubusercontent.com:8443/example/plugin-1.0.0.tgz',
    `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/docs/other.md`,
  ]) {
    const fixture = entries()
    const initial = location.includes('raw.githubusercontent.com')
      ? `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/docs/SKILL.md`
      : 'https://github.com/example/plugin/releases/download/v1.0.0/example-plugin.tgz'
    const remote = network(fixture, {
      [initial]: () => response('', { status: 302, headers: { location } }),
    })
    await assert.rejects(
      verifyCatalogSources(fixture.envelope, { fetchImpl: remote.fetchImpl }),
      acceptanceCode(location.includes(':8443') ? 'P0-CATALOG-SOURCES-URL' : 'P0-CATALOG-SOURCES-REDIRECT'),
    )
  }
})

test('rejects GitHub ref, annotated tag, and commit identities that do not match their endpoints', async () => {
  const cases = [{
    url: 'https://api.github.com/repos/example/plugin/git/ref/tags/v1.0.0',
    body: { ref: 'refs/tags/v9.9.9', object: { type: 'commit', sha: COMMIT } },
  }, {
    url: 'https://api.github.com/repos/example/plugin/git/tags/1111111111111111111111111111111111111111',
    body: { tag: 'v9.9.9', sha: '1111111111111111111111111111111111111111', object: { type: 'commit', sha: COMMIT } },
  }, {
    url: `https://api.github.com/repos/example/skills/git/commits/${COMMIT}`,
    body: { sha: '2222222222222222222222222222222222222222' },
  }]
  for (const fixtureCase of cases) {
    const fixture = entries()
    const remote = network(fixture, {
      [fixtureCase.url]: () => response(JSON.stringify(fixtureCase.body), { json: true }),
    })
    await assert.rejects(
      verifyCatalogSources(fixture.envelope, { fetchImpl: remote.fetchImpl }),
      acceptanceCode('P0-CATALOG-SOURCES-SOURCE'),
    )
  }
})

test('binds an MCP Registry package to exact npm version metadata', async () => {
  for (const dist of [{
    tarball: 'https://registry.npmjs.org/@example/files/-/files-9.9.9.tgz',
    integrity: sha512(entries().bytes.mcpBytes).replace('sha512:', 'sha512-'),
  }, {
    tarball: 'https://registry.npmjs.org/@example/files/-/files-2.0.0.tgz',
    integrity: `sha512-${Buffer.alloc(64, 0x78).toString('base64')}`,
  }]) {
    const fixture = entries()
    const remote = network(fixture, {
      'https://registry.npmjs.org/%40example%2Ffiles/2.0.0': () => response(JSON.stringify({
        name: '@example/files', version: '2.0.0', dist,
      }), { json: true }),
    })
    await assert.rejects(
      verifyCatalogSources(fixture.envelope, { fetchImpl: remote.fetchImpl }),
      acceptanceCode('P0-CATALOG-SOURCES-SOURCE'),
    )
  }
})

test('rejects an IP literal before network and invalid token material', async () => {
  const fixture = entries()
  fixture.envelope.entries[2].artifact.acquisitionUrl = `https://127.0.0.1/${COMMIT}/SKILL.md`
  const remote = network(fixture)
  await assert.rejects(
    verifyCatalogSources(fixture.envelope, { fetchImpl: remote.fetchImpl }),
    acceptanceCode('P0-CATALOG-SOURCES-URL'),
  )
  await assert.rejects(
    verifyCatalogSources(entries().envelope, { fetchImpl: remote.fetchImpl, githubToken: 'bad\ntoken' }),
    acceptanceCode('P0-CATALOG-SOURCES-INPUT'),
  )
})

test('accepts only one optional receipt path', () => {
  assert.equal(parseCatalogSourceArguments([]).help, false)
  assert.deepEqual(parseCatalogSourceArguments(['--help']), { help: true })
  assert.deepEqual(parseCatalogSourceArguments(['--receipt', '/tmp/source-receipt.json']), {
    help: false,
    receiptPath: '/tmp/source-receipt.json',
  })
  assert.throws(
    () => parseCatalogSourceArguments(['--catalog', '/tmp/plugins.json']),
    acceptanceCode('P0-CATALOG-SOURCES-INPUT'),
  )
})
