import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { canonicalJson, canonicalSha256, verifyCatalog } from '../src/catalog.ts'
import {
  ALPHA_WIKI_CANDIDATES,
  PRODUCTION_ALPHA_ADMISSION_POLICY,
  prepareAlphaCatalogAdmission,
  prepareAlphaLifecycleCatalog,
} from '../scripts/alpha-catalog-admission-core.mjs'

const OBSERVED_AT = '2026-08-28T00:00:00.000Z'
const ISSUED_AT = '2026-08-28T01:00:00.000Z'
const EXPIRES_AT = '2027-08-28T01:00:00.000Z'

function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function treeDocument(candidate: typeof ALPHA_WIKI_CANDIDATES[number]) {
  const directories = [
    '.github',
    '.github/plugins',
    '.github/plugins/deep-wiki',
    '.github/plugins/deep-wiki/skills',
    '.github/plugins/deep-wiki/skills/wiki-page-writer',
  ]
  return {
    sha: candidate.treeSha,
    truncated: false,
    tree: [
      ...directories.map((path, index) => ({
        path,
        mode: '040000',
        type: 'tree',
        sha: String(index).repeat(40).slice(0, 40),
      })),
      {
        path: candidate.artifactId,
        mode: '100644',
        type: 'blob',
        sha: candidate.blobSha,
        size: candidate.sizeBytes,
      },
      {
        path: '.github/plugins/deep-wiki/skills/wiki-page-writer/references',
        mode: '040000',
        type: 'tree',
        sha: 'a'.repeat(40),
      },
      {
        path: '.github/plugins/deep-wiki/skills/wiki-page-writer/references/acceptance-criteria.md',
        mode: '100644',
        type: 'blob',
        sha: 'b'.repeat(40),
        size: 2_254,
      },
    ],
  }
}

async function fixture() {
  const committed = JSON.parse(await readFile('catalog/public/plugins.json', 'utf8'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const root = {
    catalogId: committed.envelope.catalogId,
    minimumRevision: 1,
    maximumAgeMs: 400 * 24 * 60 * 60 * 1_000,
    threshold: 1,
    keys: [{
      keyId: 'test-alpha-key',
      algorithm: 'ed25519' as const,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }],
  }
  const previous = {
    envelope: structuredClone(committed.envelope),
    signatures: [{
      keyId: 'test-alpha-key',
      algorithm: 'ed25519' as const,
      value: sign(null, Buffer.from(canonicalJson(committed.envelope)), privateKey).toString('base64'),
    }],
  }
  const previousBytes = Buffer.from(`${canonicalJson(previous)}\n`)
  const policy = {
    ...PRODUCTION_ALPHA_ADMISSION_POLICY,
    previousDocumentDigest: canonicalSha256(previous),
    previousFileSha256: sha256Bytes(previousBytes),
  }
  const run = {
    repository: 'striveh/dsh-plugin-extension-center',
    workflow: policy.lifecycleWorkflow,
    ref: 'refs/heads/main',
    commit: 'c'.repeat(40),
    runId: 123_456,
    runAttempt: 2,
  }
  const sequence = [
    ['install', ALPHA_WIKI_CANDIDATES[0]!, true],
    ['configure', ALPHA_WIKI_CANDIDATES[0]!, false],
    ['update', ALPHA_WIKI_CANDIDATES[1]!, false],
    ['uninstall', ALPHA_WIKI_CANDIDATES[1]!, null],
    ['restore', ALPHA_WIKI_CANDIDATES[1]!, false],
    ['uninstall', ALPHA_WIKI_CANDIDATES[1]!, null],
  ].map(([action, candidate, userInvocable], index) => ({
    sequence: index + 1,
    action,
    candidateRef: candidate.candidateRef,
    status: 'committed',
    planHash: digest(`plan-${String(index)}`),
    receiptDigest: digest(`receipt-${String(index)}`),
    operationId: `operation:12345678-1234-4${String(index).padStart(3, '0')}-8123-123456789abc`,
    externalRuntimeAction: action === 'install' || action === 'update' ? 'download' : 'none',
    beforeDigest: digest(`before-${String(index)}`),
    afterDigest: digest(`after-${String(index)}`),
    mutationDigests: [digest(`mutation-${String(index)}`)],
    verificationDigests: [digest(`verification-${String(index)}`)],
    journalEventCount: 7,
    journalHeadDigest: digest(`journal-${String(index)}`),
    inventoryRevision: digest(`inventory-${String(index)}`),
    managedRevision: `center:${String(index + 1)}`,
    configurationRevision: action === 'install'
      ? canonicalSha256({ modelInvocable: true, userInvocable: true, projectRoot: null })
      : ['configure', 'update', 'restore'].includes(String(action))
        ? canonicalSha256({ modelInvocable: true, userInvocable: false, projectRoot: null })
        : null,
    observedCandidateRef: candidate.candidateRef,
    ownerRevisionDigest: digest(`owner-revision-${String(index)}`),
    ownerEvidenceDigest: digest(`owner-evidence-${String(index)}`),
    materialIntegrity: candidate.integrity,
    ownerStateVerified: true,
    configurationPreserved: action === 'update' || action === 'restore',
    userInvocable,
  }))
  const commitDocuments = Object.fromEntries(ALPHA_WIKI_CANDIDATES.map(candidate => [candidate.version, {
    sha: candidate.version,
    tree: { sha: candidate.treeSha },
  }]))
  const treeDocuments = Object.fromEntries(ALPHA_WIKI_CANDIDATES.map(candidate => [candidate.version, treeDocument(candidate)]))
  const artifacts = Object.fromEntries(ALPHA_WIKI_CANDIDATES.map(candidate => [
    candidate.version,
    Buffer.from(candidate.reviewBody),
  ]))
  const baseInput = {
    previous,
    previousFileSha256: policy.previousFileSha256,
    packagedPrevious: structuredClone(previous),
    root,
    searchDocument: {
      total_count: 1,
      items: [{
        full_name: 'microsoft/skills',
        html_url: 'https://github.com/microsoft/skills',
        owner: { login: 'microsoft' },
        stargazers_count: 2_960,
        topics: ['agent-skills', 'agents'],
        archived: false,
        disabled: false,
        visibility: 'public',
      }],
    },
    commitDocuments,
    treeDocuments,
    artifacts,
    observedAt: OBSERVED_AT,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    signers: [{
      keyId: 'test-alpha-key',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }],
  }
  const candidate = prepareAlphaLifecycleCatalog(baseInput, policy)
  const lifecycleBody = {
    schemaVersion: 2,
    acceptanceId: 'P0-OFFICIAL-ALPHA-WIKI-SKILL-LIFECYCLE',
    status: 'passed',
    p0Status: 'not-proven-development',
    target: {
      dshVersion: policy.targetDshVersion,
      dshTag: policy.targetDshTag,
      dshCommit: policy.targetDshCommit,
      officialDshSourceUnmodified: true,
      officialDshSourceTreeDigest: digest('official-source-tree'),
      officialDshEntrypointDigest: digest('official-cli-entrypoint'),
      centerSourceCommit: run.commit,
      centerPackageDigest: digest('center-package'),
      catalogRevision: candidate.evidence.revision,
      catalogDocumentDigest: candidate.evidence.documentDigest,
      catalogEntriesDigest: candidate.evidence.entriesDigest,
      catalogObservedAt: candidate.evidence.observedAt,
      catalogIssuedAt: candidate.evidence.issuedAt,
      catalogExpiresAt: candidate.evidence.expiresAt,
    },
    run,
    sequence,
    activeCandidateAbsent: true,
    notProven: ['ordinary-user-registry-installation', 'public-catalog-deployment'],
  }
  const lifecycleReceipt = { ...lifecycleBody, receiptDigest: canonicalSha256(lifecycleBody) }
  return {
    policy,
    input: {
      ...baseInput,
      centerSourceCommit: run.commit,
      admissionTimeMs: Date.parse(ISSUED_AT) + 1,
      lifecycleReceipt,
      workflowRun: {
        id: run.runId,
        run_attempt: run.runAttempt,
        path: run.workflow,
        head_sha: run.commit,
        head_branch: 'main',
        event: 'workflow_dispatch',
        status: 'completed',
        conclusion: 'success',
        repository: { full_name: run.repository },
      },
    },
  }
}

describe('official alpha catalog admission proposal', () => {
  it('creates only the exact adjacent alpha-compatible Wiki Skill pair', async () => {
    const { input, policy } = await fixture()
    const result = prepareAlphaCatalogAdmission(input, policy)
    expect(result.document.envelope).toMatchObject({
      revision: 12,
      previousRevisionDigest: canonicalSha256(input.previous.envelope),
    })
    expect(result.document.envelope.entries.map(entry => entry.candidateRef)).toEqual(
      ALPHA_WIKI_CANDIDATES.map(candidate => candidate.candidateRef),
    )
    expect(result.document.envelope.entries.every(entry => entry.compatibility.dsh === '0.1.2-alpha.1')).toBe(true)
    expect(result.document.envelope.entries.every(entry => entry.configuration.required === false)).toBe(true)
    expect(result.evidence).toMatchObject({
      status: 'prepared-for-review',
      notProven: ['ordinary-user-registry-installation', 'public-catalog-deployment'],
      previousRevision: 11,
      revision: 12,
    })
    expect(() => verifyCatalog(
      input.root,
      result.document.envelope,
      result.document.signatures,
      Date.parse(ISSUED_AT),
    )).not.toThrow()
  })

  it('rejects changed bytes, symlinks, lifecycle scripts, and Git metadata', async () => {
    const changedBytes = await fixture()
    changedBytes.input.artifacts[ALPHA_WIKI_CANDIDATES[0]!.version] = Buffer.from('changed')
    expect(() => prepareAlphaCatalogAdmission(changedBytes.input, changedBytes.policy)).toThrow(/artifact bytes/u)

    const symlink = await fixture()
    symlink.input.treeDocuments[ALPHA_WIKI_CANDIDATES[0]!.version].tree.push({
      path: '.github/plugins/deep-wiki/skills/wiki-page-writer/escape',
      mode: '120000',
      type: 'blob',
      sha: 'd'.repeat(40),
      size: 4,
    })
    expect(() => prepareAlphaCatalogAdmission(symlink.input, symlink.policy)).toThrow(/symlink/u)

    const script = await fixture()
    script.input.treeDocuments[ALPHA_WIKI_CANDIDATES[1]!.version].tree.push({
      path: '.github/plugins/deep-wiki/skills/wiki-page-writer/scripts/install.sh',
      mode: '100755',
      type: 'blob',
      sha: 'e'.repeat(40),
      size: 10,
    })
    expect(() => prepareAlphaCatalogAdmission(script.input, script.policy)).toThrow(/lifecycle script/u)

    const treeDrift = await fixture()
    treeDrift.input.commitDocuments[ALPHA_WIKI_CANDIDATES[0]!.version].tree.sha = 'f'.repeat(40)
    expect(() => prepareAlphaCatalogAdmission(treeDrift.input, treeDrift.policy)).toThrow(/commit metadata changed/u)
  })

  it('rejects synthetic, failed, or cross-run lifecycle claims', async () => {
    const failed = await fixture()
    failed.input.workflowRun.conclusion = 'failure'
    expect(() => prepareAlphaCatalogAdmission(failed.input, failed.policy)).toThrow(/authenticate/u)

    const changed = await fixture()
    changed.input.lifecycleReceipt.sequence[2].configurationPreserved = false
    const { receiptDigest: _receiptDigest, ...body } = changed.input.lifecycleReceipt
    changed.input.lifecycleReceipt.receiptDigest = canonicalSha256(body)
    expect(() => prepareAlphaCatalogAdmission(changed.input, changed.policy)).toThrow(/operation 3/u)

    const staleSource = await fixture()
    staleSource.input.centerSourceCommit = 'd'.repeat(40)
    expect(() => prepareAlphaCatalogAdmission(staleSource.input, staleSource.policy)).toThrow(/admission source commit/u)

    const unsigned = await fixture()
    unsigned.input.lifecycleReceipt.receiptDigest = digest('fabricated')
    expect(() => prepareAlphaCatalogAdmission(unsigned.input, unsigned.policy)).toThrow(/self-bound/u)

    const expired = await fixture()
    expired.input.admissionTimeMs = Date.parse(EXPIRES_AT) + 1
    expect(() => prepareAlphaCatalogAdmission(expired.input, expired.policy)).toThrow(/expired/u)
  })

  it('rejects any predecessor other than the exact signed revision 11 bytes', async () => {
    const { input, policy } = await fixture()
    input.previousFileSha256 = digest('other predecessor')
    expect(() => prepareAlphaCatalogAdmission(input, policy)).toThrow(/exact committed signed revision 11/u)

    const unpromoted = await fixture()
    unpromoted.input.packagedPrevious.envelope.revision = 10
    expect(() => prepareAlphaCatalogAdmission(unpromoted.input, unpromoted.policy)).toThrow(/has not promoted/u)
  })

  it('requires observation before issue and expiry within the root lifetime', async () => {
    const observedAfterIssue = await fixture()
    observedAfterIssue.input.observedAt = '2026-08-28T02:00:00.000Z'
    expect(() => prepareAlphaCatalogAdmission(observedAfterIssue.input, observedAfterIssue.policy)).toThrow(/not ordered/u)

    const excessiveLifetime = await fixture()
    excessiveLifetime.input.expiresAt = '2028-08-28T01:00:00.000Z'
    expect(() => prepareAlphaCatalogAdmission(excessiveLifetime.input, excessiveLifetime.policy)).toThrow(/root lifetime/u)
  })

  it('keeps the production workflow protected, review-only, and independent of test projections', async () => {
    const workflowText = await readFile('.github/workflows/catalog-alpha-admission.yml', 'utf8')
    const coreText = await readFile('scripts/alpha-catalog-admission-core.mjs', 'utf8')
    const cliText = await readFile('scripts/prepare-alpha-catalog-admission.mjs', 'utf8')
    const workflow = parseYaml(workflowText)
    expect(workflow.jobs.prepare.environment).toBe('catalog-release')
    expect(workflow.jobs.prepare.if).toContain("github.repository == 'striveh/dsh-plugin-extension-center'")
    expect(workflow.jobs.prepare.if).toContain('github.ref_protected == true')
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(workflow.on.workflow_dispatch.inputs ?? {}).not.toHaveProperty('observed_at')
    expect(workflow.on.workflow_dispatch.inputs ?? {}).not.toHaveProperty('issued_at')
    expect(workflow.on.workflow_dispatch.inputs ?? {}).not.toHaveProperty('expires_at')
    expect(`${workflowText}\n${coreText}\n${cliText}`).not.toContain('tests/support/alpha-catalog')
    expect(workflowText).toContain('node scripts/prepare-alpha-catalog-admission.mjs admit')
    expect(workflowText).toContain('--center-source-commit "$CENTER_SOURCE_COMMIT"')
    expect(cliText).toContain("response.headers.get('date')")
    expect(cliText).toContain('catalogObservedAt')
    expect(cliText).not.toContain("one('observed-at')")
    expect(cliText).not.toContain("one('issued-at')")
    expect(cliText).not.toContain("one('expires-at')")
    expect(workflowText).not.toContain('git push')
    expect(workflowText).not.toContain('pages')
  })
})
