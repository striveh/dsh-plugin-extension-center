// @vitest-environment node

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { generatePagesCatalog } from '../scripts/generate-pages-catalog.mjs'
import {
  PUBLISHED_CATALOG_URL,
} from '../src/catalog-refresh.ts'
import {
  BOOTSTRAP_CATALOG_ROOT,
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from '../src/catalog-data.ts'
import { canonicalJson, canonicalSha256, verifyBootstrapCatalog, verifyCatalog } from '../src/catalog.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('GitHub Pages signed catalog projection', () => {
  it('mechanically emits the exact packaged signed document as bounded canonical JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-center-pages-'))
    roots.push(root)
    const outputPath = join(root, 'site', 'plugins.json')
    const generated = await generatePagesCatalog({
      outputPath,
      envelope: BOOTSTRAP_CATALOG_ENVELOPE,
      signatures: BOOTSTRAP_CATALOG_SIGNATURES,
      canonicalJson,
      verify: () => { verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1) },
    })
    const body = await readFile(outputPath, 'utf8')
    expect(body).toBe(`${canonicalJson({
      envelope: BOOTSTRAP_CATALOG_ENVELOPE,
      signatures: BOOTSTRAP_CATALOG_SIGNATURES,
    })}\n`)
    expect(generated).toMatchObject({
      outputPath,
      bytes: Buffer.byteLength(body),
      revision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
    })
    expect(generated.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })

  it('refuses to publish a document the runtime would reject by size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-center-pages-bound-'))
    roots.push(root)
    await expect(generatePagesCatalog({
      outputPath: join(root, 'site', 'plugins.json'),
      envelope: { revision: 1, value: 'x'.repeat(512 * 1024) },
      signatures: [],
      canonicalJson,
      verify() {},
    })).rejects.toThrow('runtime download bound')
  })

  it('binds the committed public document to the packaged tip or its exact signed successor', async () => {
    const body = await readFile('catalog/public/plugins.json', 'utf8')
    const document = JSON.parse(body) as {
      envelope: typeof BOOTSTRAP_CATALOG_ENVELOPE
      signatures: typeof BOOTSTRAP_CATALOG_SIGNATURES
    }
    expect(body).toBe(`${canonicalJson(document)}\n`)
    const packaged = {
      envelope: BOOTSTRAP_CATALOG_ENVELOPE,
      signatures: BOOTSTRAP_CATALOG_SIGNATURES,
    }
    if (document.envelope.revision === BOOTSTRAP_CATALOG_ENVELOPE.revision) {
      expect(document).toEqual(packaged)
      expect(canonicalSha256(document)).toBe(canonicalSha256(packaged))
      return
    }
    expect(document.envelope.revision).toBe(BOOTSTRAP_CATALOG_ENVELOPE.revision + 1)
    expect(document.envelope.previousRevisionDigest).toBe(canonicalSha256(BOOTSTRAP_CATALOG_ENVELOPE))
    expect(verifyCatalog(
      BOOTSTRAP_CATALOG_ROOT,
      document.envelope,
      document.signatures,
      Date.parse(document.envelope.issuedAt) + 1,
    ).keyIds).toEqual(document.signatures.map(signature => signature.keyId))

    const evidence = JSON.parse(await readFile(
      `catalog/public/rollover-r${String(document.envelope.revision)}.evidence.json`,
      'utf8',
    ))
    expect(evidence).toEqual({
      schemaVersion: 1,
      kind: 'entry-preserving-catalog-rollover',
      catalogId: document.envelope.catalogId,
      previousRevision: BOOTSTRAP_CATALOG_ENVELOPE.revision,
      revision: document.envelope.revision,
      previousRevisionDigest: document.envelope.previousRevisionDigest,
      previousEntriesDigest: BOOTSTRAP_CATALOG_ENVELOPE.entriesDigest,
      entriesDigest: document.envelope.entriesDigest,
      documentDigest: canonicalSha256(document),
      signingKeyIds: document.signatures.map(signature => signature.keyId),
      issuedAt: document.envelope.issuedAt,
      expiresAt: document.envelope.expiresAt,
    })
  })

  it('binds the Bundle default and least-authority Pages workflow to one exact URL', async () => {
    const patch = parse(await readFile('cordis.patch.yml', 'utf8'))
    expect(patch).toEqual([{
      insert: [{
        id: 'dsh-plugin-extension-center',
        name: 'dsh-plugin-extension-center',
        config: {
          catalogTrustedUrl: PUBLISHED_CATALOG_URL,
          maximumArtifactRedirects: 1,
          allowedArtifactRedirectHosts: [
            'objects.githubusercontent.com',
            'release-assets.githubusercontent.com',
          ],
        },
      }],
    }])

    const workflowText = await readFile('.github/workflows/pages.yml', 'utf8')
    const workflow = parse(workflowText)
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.build.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.build.if).toBe("github.ref == 'refs/heads/main'")
    expect(workflow.jobs.deploy.permissions).toEqual({ contents: 'read', pages: 'write', 'id-token': 'write' })
    expect(workflowText).not.toContain('pull_request:')
    expect(workflowText).not.toContain('push:')
    expect(workflowText).not.toContain('secrets.')
    const actions = [...workflowText.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)].map(match => match[1])
    expect(actions).toHaveLength(6)
    expect(actions.every(action => /^[^@\s]+@[0-9a-f]{40}$/u.test(action!))).toBe(true)
    expect(await readFile('site/.gitignore', 'utf8')).toBe('plugins.json\n')
  })

  it('requires exact previous post-publication evidence for every update release', async () => {
    const workflowText = await readFile('.github/workflows/post-publication-evidence.yml', 'utf8')
    const workflow = parse(workflowText)
    expect(workflow.on.workflow_dispatch.inputs.previous_commit.default).toBe('')
    expect(workflow.on.workflow_dispatch.inputs.previous_evidence_run_id.default).toBe('')
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(workflow.jobs['verify-publication'].if).toBe(
      "github.ref == 'refs/heads/main' && github.ref_protected == true",
    )
    expect(workflow.jobs['verify-publication'].steps[0].with.ref).toBe('${{ github.sha }}')
    expect(workflowText).not.toContain('ref: ${{ inputs.commit }}')
    expect(workflowText).toContain('test "$(git rev-parse HEAD)" = "$VERIFIER_COMMIT"')
    expect(workflowText).toContain('test "$GITHUB_REF_PROTECTED" = \'true\'')
    expect(workflowText).toContain('git merge-base --is-ancestor "$EXPECTED_COMMIT" "$VERIFIER_COMMIT"')
    expect(workflowText).toContain('--commit "$VERIFIER_COMMIT"')
    expect(workflowText).toContain('--verifier-github-ci .artifacts/acceptance/github-ci/verifier.json')
    expect(workflowText).toContain('--verifier-commit "$VERIFIER_COMMIT"')
    expect(workflowText).toContain('--verifier-run-id "$VERIFIER_RUN_ID"')
    expect(workflowText).toContain('--verifier-run-attempt "$VERIFIER_RUN_ATTEMPT"')
    expect(workflowText).toContain('actions/runs/${PREVIOUS_EVIDENCE_RUN_ID}')
    expect(workflowText).toContain('post-publication-evidence-${PREVIOUS_COMMIT}-${previous_attempt}')
    expect(workflowText).toContain('--previous-release-ready "$PREVIOUS_RELEASE_READY"')
    expect(workflowText).toContain('--previous-verifier-github-ci "$PREVIOUS_VERIFIER_GITHUB_CI"')
    expect(workflowText).toContain('--previous-evidence-run-id "$PREVIOUS_EVIDENCE_RUN_ID"')
    expect(workflowText).toContain("find .artifacts/previous-post-publication -type f -path '*/github-ci/verifier.json'")
    expect(workflowText).toContain("find .artifacts/previous-post-publication -type f -path '*/github-ci/current.json'")
    expect(workflowText).toContain('git merge-base --is-ancestor "$previous_head_sha" "$EXPECTED_COMMIT"')
    expect(workflowText).toContain('.evidence.githubCi.sha256 == $target_sha')
    expect(workflowText).toContain('cp "$previous_target" .artifacts/acceptance/github-ci/previous.json')
    expect(workflowText).toContain('.verifier.commit == $verifier_commit')
    expect(workflowText).toContain('.verifier.runId == $evidence_run_id')
    expect(workflowText).toContain('.verifier.runAttempt == $evidence_run_attempt')
    expect(workflowText).toContain('.verifier.refProtected == true')
    expect(workflowText).toContain('.evidence.verifierGithubCi.sha256 == $verifier_sha')
    expect(workflowText).toContain('.run.headSha == $commit')
    expect(workflowText).toContain('.receiptDigest == $receipt_digest')
    const pnpmBindingStep = workflow.jobs['verify-publication'].steps.find(
      (step: { name?: string }) => step.name === 'Resolve immutable pnpm binding',
    ) as { run?: string } | undefined
    expect(pnpmBindingStep?.run?.split('\n')[0]).toBe(
      'node scripts/resolve-pnpm-binding.mjs node_modules/pnpm/bin/pnpm.mjs > .artifacts/pnpm-binding.json',
    )
    expect(pnpmBindingStep?.run).not.toContain('command -v pnpm')
    expect(workflowText).not.toMatch(/pnpm run test:[^\n]* --(?:[ \t]|$)/mu)
    expect(workflowText).not.toContain('secrets.')
    const actions = [...workflowText.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)].map(match => match[1])
    expect(actions.every(action => /^[^@\s]+@[0-9a-f]{40}$/u.test(action!))).toBe(true)

    const discoveryWorkflow = await readFile('.github/workflows/catalog-discovery.yml', 'utf8')
    expect(discoveryWorkflow).not.toMatch(/pnpm run test:[^\n]* --(?:[ \t]|$)/mu)
  })
})
