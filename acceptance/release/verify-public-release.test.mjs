import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  AcceptanceFailure,
  TARGET_DSH_COMMIT,
  TARGET_DSH_VERSION,
  immutablePackageTreeDigest,
} from '../full-p0/support.mjs'
import {
  acquireVerifiedReleaseArtifact,
  assertAscendingReleaseTransition,
  assertPackedManifestIdentity,
  assertProfileBaselineRestored,
  assertProfileLockBindsArtifact,
  normalizeReleaseArtifactSource,
  parseReleaseAcceptanceArguments,
  parseReleaseVersion,
  prepareReceiptDestination,
  runReleaseAcceptance,
  validateGitHubReleaseMetadata,
  validateGitHubImmutableReleaseProof,
  validateArchiveEntries,
  validateRuntimeAcceptanceReceipt,
  verifyPinnedPnpm,
} from './verify-public-release.mjs'

const previousVersion = '0.1.0-rc.1'
const currentVersion = '0.1.0'
const previousCommit = 'a'.repeat(40)
const currentCommit = 'b'.repeat(40)
const previousArtifactSha = 'sha256:' + 'c'.repeat(64)
const currentArtifactSha = 'sha256:' + 'd'.repeat(64)
const previousManifestSha = 'sha256:' + 'e'.repeat(64)
const currentManifestSha = 'sha256:' + 'f'.repeat(64)
const pnpmTreeSha = 'sha256:' + '1'.repeat(64)
const runtimeSha = 'sha256:' + '2'.repeat(64)
const ciSha = 'sha256:' + '3'.repeat(64)
const sumsSha = 'sha256:' + '7'.repeat(64)
const attestationFileSha = 'sha256:' + '8'.repeat(64)

function publicUrl(version) {
  return 'https://github.com/striveh/dsh-plugin-extension-center/releases/download/v'
    + version + '/dsh-plugin-extension-center-' + version + '.tgz'
}

function digest(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex')
}

function acceptanceCode(code) {
  return error => error instanceof AcceptanceFailure && error.code === code
}

function artifact(overrides = {}) {
  const version = overrides.version ?? currentVersion
  return {
    source: overrides.source ?? publicUrl(version),
    version,
    sha256: overrides.sha256 ?? currentArtifactSha,
    sizeBytes: overrides.sizeBytes ?? 42,
    commit: overrides.commit ?? currentCommit,
    manifestSha256: overrides.manifestSha256 ?? currentManifestSha,
  }
}

function ciReleaseAssets(spec) {
  return [
    { name: `dsh-plugin-extension-center-${spec.version}.tgz`, sizeBytes: spec.sizeBytes, sha256: spec.sha256 },
    { name: 'SHA256SUMS', sizeBytes: 80, sha256: sumsSha },
    { name: 'pack-attestation.json', sizeBytes: 800, sha256: attestationFileSha },
  ]
}

function releaseMetadata(spec, expectedAssets = ciReleaseAssets(spec)) {
  const tag = 'v' + spec.version
  return {
    id: 111,
    tag_name: tag,
    draft: false,
    prerelease: parseReleaseVersion(spec.version).prerelease.length > 0,
    html_url: 'https://github.com/striveh/dsh-plugin-extension-center/releases/tag/' + tag,
    target_commitish: spec.commit,
    published_at: '2026-08-27T01:02:03Z',
    assets: expectedAssets.map((expected, index) => {
      const assetId = 222 + index
      return {
      id: assetId,
      name: expected.name,
      state: 'uploaded',
      size: expected.sizeBytes,
      digest: expected.sha256,
      browser_download_url: `https://github.com/striveh/dsh-plugin-extension-center/releases/download/${tag}/${expected.name}`,
      url: 'https://api.github.com/repos/striveh/dsh-plugin-extension-center/releases/assets/'
        + String(assetId),
      updated_at: '2026-08-27T01:02:04Z',
    }}),
  }
}

function immutableResult(spec, expectedAssets = ciReleaseAssets(spec), releaseId = 111) {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://in-toto.io/attestation/release/v0.1',
    subject: [
      {
        uri: `pkg:github/striveh/dsh-plugin-extension-center@v${spec.version}`,
        digest: { sha1: '9'.repeat(40) },
      },
      ...expectedAssets.map(asset => ({
        name: asset.name,
        digest: { sha256: asset.sha256.slice('sha256:'.length) },
      })),
    ],
    predicate: {
      repository: 'striveh/dsh-plugin-extension-center',
      tag: `v${spec.version}`,
      releaseId: String(releaseId),
    },
  }
  return {
    attestation: {
      initiator: 'github',
      bundle_url: 'https://api.github.com/repos/striveh/dsh-plugin-extension-center/attestations/1',
      bundle: {
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        dsseEnvelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
          signatures: [{ keyid: '', sig: 'c2ln' }],
        },
      },
    },
    verificationResult: { verified: true },
  }
}

function immutableProof(spec, expectedAssets = ciReleaseAssets(spec), releaseId = 111) {
  const result = immutableResult(spec, expectedAssets, releaseId)
  return {
    tag: `v${spec.version}`,
    releaseId,
    assets: expectedAssets,
    ghVersionOutput: 'gh version 2.88.1 (test)\n',
    releaseResult: result,
    assetResults: expectedAssets.map(asset => ({ name: asset.name, result })),
  }
}

function runtimeReceipt(previous, current) {
  const coordinate = spec => ({
    version: spec.version,
    sha256: spec.sha256,
    manifestSha256: spec.manifestSha256,
    sourceCommit: spec.commit,
    hostBoot: true,
    clientBoot: true,
    rpcRegistration: true,
  })
  return {
    schemaVersion: 2,
    acceptanceId: 'P0-CENTER-HOST-CLIENT-BOOT',
    status: 'passed',
    profileId: 'web',
    target: {
      dshPackage: '@deepseek-ai/dsh@' + TARGET_DSH_VERSION,
      auditedSourceCommit: TARGET_DSH_COMMIT,
    },
    officialDshPackageTreeUnchanged: true,
    artifacts: {
      previous: previous === null ? null : coordinate(previous),
      current: coordinate(current),
    },
    ciPackAttestation: {
      acceptanceId: 'P0-GITHUB-CI-EXACT-COMMIT',
      fileSha256: ciSha,
      receiptDigest: 'sha256:' + '4'.repeat(64),
      runId: 77,
      runAttempt: 1,
      artifact: {
        ...coordinate(current),
        sizeBytes: current.sizeBytes,
        attestationDigest: 'sha256:' + '5'.repeat(64),
        actionsArtifactId: 88,
        actionsArchiveSha256: 'sha256:' + '6'.repeat(64),
      },
    },
  }
}

function apiFetch(spec, artifactHandler, expectedAssets = ciReleaseAssets(spec)) {
  const calls = []
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url)
    calls.push({ url: parsed.href, options })
    if (parsed.hostname === 'api.github.com' && parsed.pathname.includes('/releases/tags/')) {
      return new Response(JSON.stringify(releaseMetadata(spec, expectedAssets)), { status: 200 })
    }
    if (parsed.hostname === 'api.github.com' && parsed.pathname.includes('/commits/')) {
      return new Response(JSON.stringify({ sha: spec.commit }), { status: 200 })
    }
    return artifactHandler(parsed, options)
  }
  return { calls, fetchImpl }
}

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), 'center-release-test-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function fullCliArtifacts() {
  return [
    '--previous', publicUrl(previousVersion),
    '--previous-version', previousVersion,
    '--previous-sha256', previousArtifactSha,
    '--previous-size', '41',
    '--previous-commit', previousCommit,
    '--previous-manifest-sha256', previousManifestSha,
    '--current', publicUrl(currentVersion),
    '--current-version', currentVersion,
    '--current-sha256', currentArtifactSha,
    '--current-size', '42',
    '--current-commit', currentCommit,
    '--current-manifest-sha256', currentManifestSha,
  ]
}

function fullCliEvidence() {
  return [
    '--runtime-receipt', '/tmp/runtime.json',
    '--runtime-receipt-sha256', runtimeSha,
    '--ci-receipt', '/tmp/github-ci.json',
    '--ci-receipt-sha256', ciSha,
    '--previous-ci-receipt', '/tmp/previous-github-ci.json',
    '--previous-ci-receipt-sha256', 'sha256:' + '4'.repeat(64),
    '--pnpm-bin', '/opt/pnpm/bin/pnpm.mjs',
    '--pnpm-root', '/opt/pnpm',
    '--pnpm-version', '11.21.0',
    '--pnpm-tree-sha256', pnpmTreeSha,
    '--receipt', '/tmp/release.json',
  ]
}

test('requires canonical SemVer and a strictly ascending transition', () => {
  assert.deepEqual(parseReleaseVersion(previousVersion), {
    raw: previousVersion,
    major: 0,
    minor: 1,
    patch: 0,
    prerelease: ['rc', '1'],
  })
  assert.deepEqual(assertAscendingReleaseTransition(previousVersion, currentVersion), {
    previous: previousVersion,
    current: currentVersion,
  })
  for (const invalid of [
    '1.0',
    '01.0.0',
    '1.0.0+build',
    '1.0.0-rc.01',
    '9007199254740992.0.0',
  ]) {
    assert.throws(() => parseReleaseVersion(invalid), acceptanceCode('P0-RELEASE-VERSION'))
  }
  for (const [before, after] of [
    ['1.0.0', '1.0.0'],
    ['1.0.0', '0.9.0'],
    ['1.0.0-rc.2', '1.0.0-rc.1'],
  ]) {
    assert.throws(
      () => assertAscendingReleaseTransition(before, after),
      acceptanceCode('P0-RELEASE-VERSION-ORDER'),
    )
  }
  assert.deepEqual(
    assertAscendingReleaseTransition(
      '1.0.0-900719925474099299999999999999',
      '1.0.0-900719925474099300000000000000',
    ),
    {
      previous: '1.0.0-900719925474099299999999999999',
      current: '1.0.0-900719925474099300000000000000',
    },
  )
})

test('parses complete release, runtime, and fixed pnpm coordinates', () => {
  const parsed = parseReleaseAcceptanceArguments([...fullCliArtifacts(), ...fullCliEvidence()])
  assert.equal(parsed.previous.version, previousVersion)
  assert.equal(parsed.current.version, currentVersion)
  assert.equal(parsed.previous.commit, previousCommit)
  assert.equal(parsed.current.manifestSha256, currentManifestSha)
  assert.equal(parsed.pnpm.version, '11.21.0')
  assert.equal(parsed.runtimeAcceptance.sha256, runtimeSha)
  assert.equal(parsed.ciReceipt.sha256, ciSha)
  assert.deepEqual(parseReleaseAcceptanceArguments(['--help']), { help: true })

  assert.throws(
    () => parseReleaseAcceptanceArguments(fullCliArtifacts()),
    acceptanceCode('P0-RELEASE-INPUT'),
  )
  const wrongPnpm = [...fullCliArtifacts(), ...fullCliEvidence()]
  wrongPnpm[wrongPnpm.indexOf('--pnpm-version') + 1] = '11.20.0'
  assert.throws(
    () => parseReleaseAcceptanceArguments(wrongPnpm),
    acceptanceCode('P0-RELEASE-PNPM'),
  )
  const sameCommit = [...fullCliArtifacts(), ...fullCliEvidence()]
  sameCommit[sameCommit.indexOf('--current-commit') + 1] = previousCommit
  assert.throws(
    () => parseReleaseAcceptanceArguments(sameCommit),
    acceptanceCode('P0-RELEASE-INPUT'),
  )
})

test('binds public source tag and asset name to the expected version', () => {
  assert.deepEqual(normalizeReleaseArtifactSource(
    publicUrl(currentVersion),
    'current source',
    currentVersion,
  ), {
    kind: 'github-release',
    url: publicUrl(currentVersion),
  })
  assert.equal(normalizeReleaseArtifactSource('./packed.tgz').kind, 'local')
  for (const source of [
    publicUrl(previousVersion),
    publicUrl(currentVersion).replace('/v0.1.0/', '/final/'),
    publicUrl(currentVersion).replace(
      'dsh-plugin-extension-center-0.1.0.tgz',
      'renamed.tgz',
    ),
    publicUrl(currentVersion).replace('https:', 'http:'),
    publicUrl(currentVersion).replace('github.com', 'example.com'),
    publicUrl(currentVersion) + '?download=1',
  ]) {
    assert.throws(
      () => normalizeReleaseArtifactSource(source, 'source', currentVersion),
      acceptanceCode('P0-RELEASE-SOURCE'),
      source,
    )
  }
})

test('binds GitHub Release state, asset metadata, and resolved tag commit', () => {
  const spec = artifact()
  const assets = ciReleaseAssets(spec)
  const evidence = validateGitHubReleaseMetadata(spec, releaseMetadata(spec, assets), { sha: spec.commit }, assets)
  assert.equal(evidence.tag, 'v' + currentVersion)
  assert.equal(evidence.sourceCommit, currentCommit)
  assert.equal(evidence.prerelease, false)
  assert.deepEqual(evidence.assets.map(asset => asset.name), assets.map(asset => asset.name))

  const draft = structuredClone(releaseMetadata(spec, assets))
  draft.draft = true
  assert.throws(
    () => validateGitHubReleaseMetadata(spec, draft, { sha: spec.commit }, assets),
    acceptanceCode('P0-RELEASE-METADATA'),
  )
  const wrongDigest = structuredClone(releaseMetadata(spec, assets))
  wrongDigest.assets[0].digest = previousArtifactSha
  assert.throws(
    () => validateGitHubReleaseMetadata(spec, wrongDigest, { sha: spec.commit }, assets),
    acceptanceCode('P0-RELEASE-METADATA'),
  )
  assert.throws(
    () => validateGitHubReleaseMetadata(spec, releaseMetadata(spec, assets), { sha: previousCommit }, assets),
    acceptanceCode('P0-RELEASE-METADATA'),
  )
  const extra = structuredClone(releaseMetadata(spec, assets))
  extra.assets.push({ ...extra.assets[0], id: 999, name: 'unexpected.txt' })
  assert.throws(
    () => validateGitHubReleaseMetadata(spec, extra, { sha: spec.commit }, assets),
    acceptanceCode('P0-RELEASE-METADATA'),
  )
})

test('binds the concrete immutable Release and one GitHub attestation verification per exact asset', () => {
  const spec = artifact()
  const assets = ciReleaseAssets(spec)
  const proof = validateGitHubImmutableReleaseProof(immutableProof(spec, assets))
  assert.equal(proof.tag, `v${spec.version}`)
  assert.equal(proof.releaseId, 111)
  assert.equal(proof.ghVersion, '2.88.1')
  assert.deepEqual(proof.assets.map(asset => asset.name), assets.map(asset => asset.name))

  const missingAssetProof = structuredClone(immutableProof(spec, assets))
  missingAssetProof.assetResults.pop()
  assert.throws(
    () => validateGitHubImmutableReleaseProof(missingAssetProof),
    acceptanceCode('P0-RELEASE-IMMUTABILITY'),
  )
  const wrongRelease = structuredClone(immutableProof(spec, assets))
  const payload = JSON.parse(Buffer.from(
    wrongRelease.releaseResult.attestation.bundle.dsseEnvelope.payload,
    'base64',
  ).toString('utf8'))
  payload.predicate.releaseId = '999'
  wrongRelease.releaseResult.attestation.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(payload)).toString('base64')
  assert.throws(
    () => validateGitHubImmutableReleaseProof(wrongRelease),
    acceptanceCode('P0-RELEASE-IMMUTABILITY'),
  )
})

test('downloads through manually checked metadata and asset redirects', async () => {
  await withTemporaryDirectory(async root => {
    const bytes = Buffer.from('packed-center-release')
    const spec = artifact({ sha256: digest(bytes), sizeBytes: bytes.length })
    const sidecars = {
      SHA256SUMS: Buffer.from(`${spec.sha256.slice('sha256:'.length)}  dsh-plugin-extension-center-${spec.version}.tgz\n`),
      'pack-attestation.json': Buffer.from('{"attested":true}\n'),
    }
    const assets = [
      { name: `dsh-plugin-extension-center-${spec.version}.tgz`, sizeBytes: bytes.length, sha256: digest(bytes) },
      ...Object.entries(sidecars).map(([name, value]) => ({ name, sizeBytes: value.length, sha256: digest(value) })),
    ]
    const destination = join(root, 'download', 'center.tgz')
    const payload = new Map([[assets[0].name, bytes], ...Object.entries(sidecars)])
    const network = apiFetch(spec, async parsed => {
      if (parsed.hostname === 'github.com') {
        const name = parsed.pathname.split('/').at(-1)
        return new Response(null, {
          status: 302,
          headers: { location: `https://release-assets.githubusercontent.com/release/${name}?signature=fixed` },
        })
      }
      const observed = payload.get(parsed.pathname.split('/').at(-1))
      return new Response(observed, {
        status: 200,
        headers: { 'content-length': String(observed.length) },
      })
    }, assets)
    const evidence = await acquireVerifiedReleaseArtifact(spec, destination, {
      fetchImpl: network.fetchImpl,
      ciReleaseAssets: assets,
      immutableReleaseProof: immutableProof(spec, assets),
    })

    assert.equal(network.calls.length, 8)
    assert.ok(network.calls.every(call => call.options.redirect === 'manual'))
    assert.equal(evidence.sourceKind, 'github-release')
    assert.equal(evidence.finalHost, 'release-assets.githubusercontent.com')
    assert.equal(evidence.release.sourceCommit, currentCommit)
    assert.equal(evidence.sha256, digest(bytes))
    assert.equal(evidence.releasePayload.length, 3)
    assert.equal(evidence.immutableRelease.releaseId, 111)
    assert.match(evidence.sha512, /^sha512-/u)
    assert.deepEqual(await readFile(destination), bytes)
  })
})

test('fails closed on an untrusted redirect and removes an over-bound partial download', async () => {
  await withTemporaryDirectory(async root => {
    const redirected = join(root, 'redirected.tgz')
    const redirectSpec = artifact({ sha256: 'sha256:' + '3'.repeat(64), sizeBytes: 1 })
    const redirectNetwork = apiFetch(redirectSpec, async () => new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example/center.tgz' },
    }))
    await assert.rejects(
      acquireVerifiedReleaseArtifact(redirectSpec, redirected, {
        fetchImpl: redirectNetwork.fetchImpl,
        ciReleaseAssets: ciReleaseAssets(redirectSpec),
        immutableReleaseProof: immutableProof(redirectSpec),
      }),
      acceptanceCode('P0-RELEASE-REDIRECT'),
    )
    await assert.rejects(stat(redirected), error => error?.code === 'ENOENT')

    const bounded = join(root, 'bounded.tgz')
    const expected = Buffer.from('abc')
    const boundSpec = artifact({ sha256: digest(expected), sizeBytes: expected.length })
    const boundNetwork = apiFetch(boundSpec, async () => new Response(
      Buffer.from('too-large'),
      { status: 200 },
    ))
    await assert.rejects(
      acquireVerifiedReleaseArtifact(boundSpec, bounded, {
        fetchImpl: boundNetwork.fetchImpl,
        ciReleaseAssets: ciReleaseAssets(boundSpec),
        immutableReleaseProof: immutableProof(boundSpec),
      }),
      acceptanceCode('P0-RELEASE-ARTIFACT-BOUND'),
    )
    await assert.rejects(stat(bounded), error => error?.code === 'ENOENT')
  })
})

test('supports a byte-bound local rehearsal and rejects wrong identity', async () => {
  await withTemporaryDirectory(async root => {
    const bytes = Buffer.from('local-packed-center')
    const local = join(root, 'source.tgz')
    const copied = join(root, 'copied.tgz')
    await writeFile(local, bytes)
    const spec = artifact({
      source: local,
      sha256: digest(bytes),
      sizeBytes: bytes.length,
    })
    const evidence = await acquireVerifiedReleaseArtifact(spec, copied)
    assert.equal(evidence.sourceKind, 'local')
    assert.equal(evidence.sourceCommit, currentCommit)
    assert.deepEqual(await readFile(copied), bytes)

    await assert.rejects(
      acquireVerifiedReleaseArtifact({
        ...spec,
        sha256: previousArtifactSha,
      }, join(root, 'wrong.tgz')),
      acceptanceCode('P0-RELEASE-ARTIFACT-IDENTITY'),
    )
  })
})

test('binds complete packed manifest bytes and authoritative publication fields', async () => {
  const authority = JSON.parse(await readFile(
    fileURLToPath(new URL('../../package.json', import.meta.url)),
    'utf8',
  ))
  const manifest = structuredClone(authority)
  manifest.version = currentVersion
  const bytes = Buffer.from(JSON.stringify(manifest))
  const spec = artifact({
    source: '/tmp/current.tgz',
    manifestSha256: digest(bytes),
  })
  const observed = assertPackedManifestIdentity(bytes, spec, authority)
  assert.equal(observed.manifest.version, currentVersion)
  assert.equal(observed.manifestSha256, digest(bytes))

  const changed = structuredClone(manifest)
  delete changed.exports['./client']
  const changedBytes = Buffer.from(JSON.stringify(changed))
  assert.throws(
    () => assertPackedManifestIdentity(changedBytes, {
      ...spec,
      manifestSha256: digest(changedBytes),
    }, authority),
    acceptanceCode('P0-RELEASE-PACKAGE'),
  )
  assert.throws(
    () => assertPackedManifestIdentity(bytes, {
      ...spec,
      manifestSha256: previousManifestSha,
    }, authority),
    acceptanceCode('P0-RELEASE-PACKAGE'),
  )
})

test('accepts only bounded regular archive entries under one package root', () => {
  const entries = [
    'package/package.json',
    'package/cordis.patch.yml',
    'package/lib/index.js',
  ]
  const verbose = entries.map(name => `-rw-r--r-- user/group 1 2026-08-27 00:00 ${name}`)
  assert.equal(validateArchiveEntries(`${entries.join('\n')}\n`, `${verbose.join('\n')}\n`), 3)
  for (const unsafe of [
    '../package/package.json',
    'package/../escape',
    'package/lib\\escape.js',
    'package/\u00e9.js',
  ]) {
    assert.throws(
      () => validateArchiveEntries(
        `package/package.json\npackage/cordis.patch.yml\n${unsafe}\n`,
        `- package/package.json\n- package/cordis.patch.yml\n- ${unsafe}\n`,
      ),
      acceptanceCode('P0-RELEASE-PACKAGE'),
    )
  }
  assert.throws(
    () => validateArchiveEntries(
      'package/package.json\npackage/cordis.patch.yml\npackage/link\n',
      '- package/package.json\n- package/cordis.patch.yml\nl package/link\n',
    ),
    acceptanceCode('P0-RELEASE-PACKAGE'),
  )
})

test('binds Profile lock to one exact file archive and rejects stale previous residue', () => {
  const sri = 'sha512-' + Buffer.from('artifact').toString('base64')
  const currentPath = '/private/downloads/current.tgz'
  const lock = [
    'importers:',
    '  .:',
    '    dependencies:',
    '      dsh-plugin-extension-center:',
    '        specifier: file:' + currentPath,
    'packages:',
    '  dsh-plugin-extension-center@file:current.tgz:',
    '    resolution: {integrity: ' + sri + ', tarball: file:current.tgz}',
    '    version: ' + currentVersion,
    'snapshots:',
    '  dsh-plugin-extension-center@file:current.tgz:',
    '',
  ].join('\n')
  assert.deepEqual(assertProfileLockBindsArtifact(
    lock,
    currentPath,
    currentVersion,
    sri,
  ), {
    packageSnapshotCount: 1,
    snapshotCount: 1,
    integrity: sri,
  })
  assert.throws(
    () => assertProfileLockBindsArtifact(
      lock + 'previous.tgz\n',
      currentPath,
      currentVersion,
      sri,
      '/private/downloads/previous.tgz',
    ),
    acceptanceCode('P0-RELEASE-LOCK'),
  )
  assert.throws(
    () => assertProfileLockBindsArtifact(
      lock,
      currentPath,
      currentVersion,
      'sha512-' + Buffer.from('wrong').toString('base64'),
    ),
    acceptanceCode('P0-RELEASE-LOCK'),
  )
})

test('requires an external Host, Client, and RPC receipt bound to both releases', () => {
  const previous = artifact({
    version: previousVersion,
    sha256: previousArtifactSha,
    commit: previousCommit,
    manifestSha256: previousManifestSha,
  })
  const current = artifact()
  const receipt = runtimeReceipt(previous, current)
  const observed = validateRuntimeAcceptanceReceipt(receipt, previous, current)
  assert.equal(observed.previous.sourceCommit, previousCommit)
  assert.equal(observed.current.sourceCommit, currentCommit)

  const missingClient = structuredClone(receipt)
  missingClient.artifacts.current.clientBoot = false
  assert.throws(
    () => validateRuntimeAcceptanceReceipt(missingClient, previous, current),
    acceptanceCode('P0-RELEASE-RUNTIME-RECEIPT'),
  )
  const wrongHost = structuredClone(receipt)
  wrongHost.target.dshPackage = '@deepseek-ai/dsh@0.1.1-rc.1'
  assert.throws(
    () => validateRuntimeAcceptanceReceipt(wrongHost, previous, current),
    acceptanceCode('P0-RELEASE-RUNTIME-RECEIPT'),
  )
})

test('requires exact semantic Profile baseline restoration', () => {
  const baseline = {
    manifest: '{"dependencies":{}}',
    lockSha256: 'sha256:' + '1'.repeat(64),
    treeWithoutManifestSha256: 'sha256:' + '2'.repeat(64),
    dumpSha256: 'sha256:' + '3'.repeat(64),
  }
  assert.equal(assertProfileBaselineRestored(baseline, { ...baseline }), true)
  assert.throws(
    () => assertProfileBaselineRestored(baseline, {
      ...baseline,
      lockSha256: 'sha256:' + '4'.repeat(64),
    }),
    acceptanceCode('P0-RELEASE-REMOVE-BASELINE'),
  )
})

test('binds the exact pnpm package tree, entrypoint, and version', async () => {
  await withTemporaryDirectory(async root => {
    const packageRoot = join(root, 'pnpm')
    const binRoot = join(packageRoot, 'bin')
    const binPath = join(binRoot, 'pnpm.mjs')
    await mkdir(binRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'pnpm',
      version: '11.21.0',
      bin: { pnpm: 'bin/pnpm.mjs' },
    }))
    await writeFile(binPath, "process.stdout.write('11.21.0\\n')\n")
    const treeSha256 = await immutablePackageTreeDigest(packageRoot)
    const evidence = await verifyPinnedPnpm({
      packageRoot,
      binPath,
      version: '11.21.0',
      treeSha256,
    }, join(root, 'shim'), root, process.env)
    assert.equal(evidence.version, '11.21.0')
    assert.equal(evidence.treeSha256, treeSha256)
    assert.equal(await lstat(join(root, 'shim', 'pnpm')).then(info => info.isSymbolicLink()), true)

    await assert.rejects(
      verifyPinnedPnpm({
        packageRoot,
        binPath,
        version: '11.21.0',
        treeSha256: previousArtifactSha,
      }, join(root, 'bad-shim'), root, process.env),
      acceptanceCode('P0-RELEASE-PNPM'),
    )
  })
})

test('receipt output cannot overwrite or alias any evidence input', async () => {
  await withTemporaryDirectory(async root => {
    const currentPath = join(root, 'current.tgz')
    const runtimePath = join(root, 'runtime.json')
    await writeFile(currentPath, 'artifact')
    await writeFile(runtimePath, '{}')
    const spec = artifact({ source: currentPath })
    await assert.rejects(
      prepareReceiptDestination(currentPath, [spec], runtimePath),
      acceptanceCode('P0-RELEASE-RECEIPT'),
    )
    const existing = join(root, 'existing.json')
    await writeFile(existing, '{}')
    await assert.rejects(
      prepareReceiptDestination(existing, [spec], runtimePath),
      acceptanceCode('P0-RELEASE-RECEIPT'),
    )
    assert.equal(
      await prepareReceiptDestination(join(root, 'new.json'), [spec], runtimePath),
      join(await realpath(root), 'new.json'),
    )
  })
})

test('direct runner rejects a non-distinct transition before external effects', async () => {
  await assert.rejects(
    runReleaseAcceptance({
      previous: artifact({
        source: '/tmp/old.tgz',
        version: previousVersion,
        sha256: currentArtifactSha,
        commit: previousCommit,
        manifestSha256: previousManifestSha,
      }),
      current: artifact({ source: '/tmp/new.tgz' }),
      runtimeAcceptance: { path: '/tmp/runtime.json', sha256: runtimeSha },
      pnpm: {
        binPath: '/tmp/pnpm',
        packageRoot: '/tmp',
        version: '11.21.0',
        treeSha256: pnpmTreeSha,
      },
      receiptPath: '/tmp/release.json',
    }),
    acceptanceCode('P0-RELEASE-INPUT'),
  )
})

test('uses only official Plugin CLI mutations and keeps direct runtime proof explicit', async () => {
  const source = await readFile(
    fileURLToPath(new URL('./verify-public-release.mjs', import.meta.url)),
    'utf8',
  )
  assert.match(source, /'plugin', '--profile', 'web', 'add', artifact\.path,/u)
  assert.match(source, /'plugin', '--profile', 'web', 'remove', CENTER_PACKAGE,/u)
  assert.match(source, /'--offline', '--ignore-scripts', '--save-exact'/u)
  assert.match(source, /host-client-runtime-directly-observed-by-this-release-runner/u)
  assert.match(source, /PATH: \[pnpm\.shimRoot/u)
  assert.doesNotMatch(source, /\bwriteFile\([^)]*(?:profileRoot|profiles|dshHome)/su)
  assert.doesNotMatch(source, /\b(?:appendFile|truncate)\b/u)
})
