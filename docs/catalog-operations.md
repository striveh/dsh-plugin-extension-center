# Catalog discovery, admission, and signing

English | [中文](catalog-operations.zh.md)

The Extension Center separates public discovery from writable Store admission. Runtime Store search and task Capability RAG read only one signed, locally verified snapshot. They never browse community sites, send task text to a registry, execute an upstream install field, or let the model supply package coordinates.

## Lead discovery

`pnpm catalog:discover -- --out <new-leads.json>` performs a bounded, credential-free sweep of four fixed public inputs:

- the unofficial [DSH community catalog](https://awesome-dsh-plugin.com/plugins.json) for Plugin leads;
- the paginated [official MCP Registry API](https://registry.modelcontextprotocol.io/v0.1/servers) for exact MCP version leads;
- one fixed GitHub repository search for the `agent-skill` topic for Skill-repository leads; and
- one separately identified fixed GitHub repository search for the `agent-skills` topic, which covers repositories such as `microsoft/skills` without merging its provenance with the singular-topic response.

Requests use HTTPS, reject redirects, accept JSON only, cap response bytes and MCP pages, and write a new exclusive owner-only report. A bounded MCP batch retains `mcpNextCursor`; the next invocation passes it through `--mcp-cursor`, or uses the official Registry's incremental filter through `--mcp-updated-since`. This continuation is safe because lead reports are curation input, not catalog completeness claims. Community descriptions, README summaries, default branches, and free-form install strings are discarded. The report retains only closed lead fields, source-document digests, pinned version hints when the upstream registry provides them, and non-authoritative activity signals. Invalid rows become digest-only rejection records. A lead cannot appear in the Store or task resolver.

The scheduled discovery workflow also re-fetches every artifact in the currently signed catalog, resolves Plugin Release tags to their admitted Git commit, checks that exact MCP Registry versions remain active, and revalidates commit-pinned Skill content. It emits a separate digest-bound source-freshness receipt. This does not admit a lead, repeat the human authority review, or certify third-party code safety.

The current `awesome-dsh-plugin.com/plugins.json` document is a useful community lead source but uses its own unsigned directory schema. It is not the signed `{ envelope, signatures }` document accepted by `catalogTrustedUrl` and must never be configured as that trusted runtime URL.

## Admission evidence

Publication consumes a curator-authored admission document and exact local artifact files. Every entry must bind one or more known leads with the same extension kind and upstream repository. It must use immutable source and artifact coordinates and make all five writable P0 actions—Install, Configure, Update, Uninstall, and Restore—available.

Each admission also embeds four exact, candidate-bound receipts:

- for the stable generic publisher, lifecycle fixtures with all five actions passed for the exact candidate source revision on the unmodified official DSH `0.1.1-rc.2` artifact; the protected alpha specialization below instead requires its exact official-alpha receipt;
- compatibility with at least one explicit platform result;
- human authority review with a canonical authority digest; and
- a complete dependency-graph scan reporting no install lifecycle scripts.

The publisher re-hashes the local artifact and rejects a size or integrity mismatch. It validates these receipts but does not manufacture their claims or execute unreviewed upstream code; the fixture, compatibility, authority-review, and dependency-scan systems remain independent evidence producers.

The package build must also know how to construct the exact pre-authorization review evidence for the candidate. Plugin and Skill admissions are therefore limited to a package-pinned identity that binds kind, candidate reference, extension name, artifact id, revision, integrity, and size. MCP admissions use the typed runtime-bound review recipe and remain ineligible at runtime until an exact allowlisted descriptor preflight succeeds. The publisher rejects an admission without one of those recipes, and the runtime catalog verifier plus the shared Store/task policy repeat that check before the candidate can be treated as writable. Adding a new Plugin or Skill requires shipping its review record in a new Extension Center build; a signed catalog entry alone cannot make it executable.

## Official-alpha Wiki Skill admission

The alpha path is a protected, fixed-candidate specialization rather than an open-ended curator form. It advances only the exact committed and signed public revision 11 to revision 12, replaces the rc.2 entry set with the two package-reviewed `microsoft/skills` `wiki-page-writer` commits `6142f8e60ac58372845c0fcdd2dbf043cd1bb698` and `67ae723a23ba880e3e5c8a3e5e2320092024476e`, and sets their compatibility and required Host dependency to exact official DSH `0.1.2-alpha.3` at `dd6322d604e00eec1ba5e0c8541159906a21094a`. Successful stable post-publication run `33130950000` proves the public r11 deployment and refresh, and the alpha package now embeds that exact r11 predecessor; the exact predecessor preflight passes. This closes only the r11 prerequisite. The r12 lifecycle, admission, review, Pages deployment, runtime refresh, and public artifact lifecycle evidence remain `Pending`/RED. No search result, user URL, model output, or test fixture can change those coordinates or substitute for those receipts.

Both Wiki entries retain `configuration.required: false`; v1 is eligible and ready without a configuration prerequisite. The lifecycle producer still executes the optional Configure action so that the supported write path and configuration-preserving Update/Restore behavior are proven without reclassifying the Skill as configuration-required.

The `Prepare official-alpha catalog admission` workflow runs only on protected `main` in the `catalog-release` environment. Before the signing step can emit a review artifact, it downloads one exact receipt from a successful `Produce official-alpha Wiki Skill lifecycle receipt` workflow run and verifies the receipt file digest, workflow path, repository, the same protected-main commit as the admission checkout, run id and attempt, success conclusion, unmodified official DSH tag and commit, exact r12 document and entries digests, current catalog validity, and the six committed writes Install v1, Configure, Update to v2, Uninstall, Restore v2, and final Uninstall. That producer uses the same catalog builder to create an isolated development-only signed r12 input, launches the exact official alpha source, establishes its one-time browser login and HttpOnly management session, performs every management RPC from that authenticated page, and uploads only the secret-free schema-2 lifecycle receipt. The receipt derives `catalogObservedAt` and `catalogIssuedAt` from the current TLS-protected GitHub HTTP `Date`; admission reuses those recorded times and accepts no dispatcher-supplied time. Every committed write binds `operationId`, `journalHeadDigest`, `journalEventCount`, `inventoryRevision`, `managedRevision`, `configurationRevision`, `materialIntegrity`, `ownerRevisionDigest`, `ownerEvidenceDigest`, and its plan, receipt, before/after, mutation, and verification digests. The temporary signed input is not a production catalog artifact and is never copied into the package, `catalog/public`, Pages, or the admission artifact.

The final receipt field is `activeCandidateAbsent`, not an assertion that the inventory row or recovery material disappeared. Final Uninstall must leave the candidate inactive and invisible while retaining the tombstone and exact rollback material used by Restore. This producer does not execute or claim Purge; the historical ordinary-user lifecycle design assigns that future destructive proof to a separate lane.

Both workflows independently re-fetch a fixed GitHub search for `repo:microsoft/skills topic:agent-skills`, the two exact commit and full-tree records, and the two exact raw `SKILL.md` files. The verifier binds the expected tree and blob ids, 5,807/5,869-byte sizes, SHA-256 values `7929f8adf896dbbf1fd744493f643c55a6812f0418d6cd89b3284f8f924d0c8f` and `f1270ea4123116e846bf2dc7a53a9e396ed43d694cdb7be22b9a35da9a40feb6`, Git blob ids, regular-file modes, normalized ancestor paths, and the packaged authority-review bodies. A symlink, submodule, truncated tree, path escape, package manifest, executable script, script directory, changed byte, missing metadata, failed lifecycle operation, or different predecessor fails before an admission artifact is written. The managed Skill artifact is the one exact raw `SKILL.md`, not a repository tarball; unrelated repository archive bytes are deliberately not treated as installation material.

The admission workflow uploads a signed canonical `plugins.json`, an evidence record with status `prepared-for-review`, and checksums. It does not commit, deploy, or mutate a Profile. A maintainer must review and commit the exact bytes through a pull request, and a separate Pages deployment plus runtime refresh receipt must prove publication. Exact public artifact installation and the ordinary-user Store lifecycle remain separate later gates; publishing the Center to npm is not one of them. Until a real lifecycle producer run, catalog signing run, pull-request commit, Pages receipt, and public artifact lifecycle receipt exist, alpha catalog admission, deployment, and ordinary-user use remain `Pending`; unit fixtures, including `tests/support/alpha-catalog.ts`, cannot satisfy any of those gates.

## Immutable publication

`pnpm catalog:publish -- ...` verifies the preceding signed document against an external JSON trust root, admits the curated entries, creates exactly the next revision with the previous-envelope digest, signs canonical JSON with the supplied Ed25519 private-key files, and self-verifies the configured threshold. It writes a new signed document and a separate evidence index; neither output path may already exist. Private key bytes are read from bounded regular files, never printed, persisted in the catalog, or stored in this repository.

Example argument form:

```sh
pnpm catalog:publish -- \
  --leads leads-2026-08-26.json \
  --admissions admissions-2026-08-26.json \
  --artifact-root ./admission-artifacts \
  --previous plugins-r6.json \
  --root catalog-root.json \
  --key release-1=/secure/release-1.pk8.pem \
  --issued-at 2026-08-26T00:00:00.000Z \
  --expires-at 2026-09-25T00:00:00.000Z \
  --out plugins-r7.json \
  --evidence-out plugins-r7.evidence.json
```

The package contains the public runtime trust root and offline bootstrap only. A real remote revision still requires an operator-controlled key ceremony, independently produced receipts, deployment of the exact signed file as `/plugins.json`, and a post-deployment refresh receipt. Local pipeline tests do not prove that operational release gate.

The current public root has one trusted Ed25519 key and `threshold: 1`; it is therefore a one-of-one signing policy. The pipeline supports a larger threshold and multiple key ids, but that mechanism is not multi-party protection until a later packaged root actually provisions independent keys.

For an entry-preserving successor, `pnpm catalog:rollover -- --previous <committed-plugins.json> ...` reads and verifies the exact preceding document, keeps its admitted entries unchanged, signs only the next revision, and writes a separate evidence record. The manual `Prepare signed catalog successor` workflow performs this operation in the `catalog-release` environment and uploads the proposed document, evidence, and checksums for review. It does not commit or deploy the output. A maintainer must review the artifact, commit the exact signed bytes and evidence on a pull request, and let the Pages workflow verify and deploy that protected-`main` input.

Each later Center release promotes the preceding successful public document into its packaged bootstrap before signing another successor. The post-publication workflow binds the previous successful release-ready receipt by exact Actions run id and rejects the update unless the previous deployed catalog is byte-identity-equivalent at the revision, entries, envelope, and signature-set coordinates to the current packaged bootstrap. Historical rc.0 uses receipt schema 2; recovery rc.2 and later releases use schema 3 so the rc.1 incident remains transitively bound. The current deployment must be the exact adjacent signed successor. rc.1 carried packaged `r9` and deployed `r10`, but its cache-preserving rc.0 update failed before a composite receipt was created. Recovery rc.2 kept `r9→r10`, bound rc.0 as the last successful predecessor plus rc.1 as an immutable `not-release-ready` incident, and produced the successful receipt used by stable. Stable `v0.1.0` packaged `r10`, deployed signed `r11`, and proved that transition in post-publication run `33130950000`. The current alpha source promotes that proven r11 document into its packaged bootstrap; this promotion is not r12 lifecycle, admission, deployment, refresh, or public artifact lifecycle evidence.

The preceding post-publication procedure is historical stable-line audit material. Its workflow is no longer an active compatibility or completion gate.

The preceding post-publication procedure is historical stable-line audit material. Its workflow is no longer an active compatibility or completion gate.

## Public revision 11

The committed Pages input at `catalog/public/plugins.json` was the entry-preserving exact successor to stable's packaged bootstrap revision 10 and is now the current alpha package bootstrap. Revision 11 uses key id `bootstrap-2026-08-26-8`, previous-envelope digest `sha256:3ad9e4423ec7ab339a0a1ecafb1f7471c327092cb1db05eecfada5fb3e5351c0`, entries digest `sha256:da9f5a4f703462cb27de0df26e265c3461dd85a51f0b5a2deecb76ee22d9de86`, canonical document digest `sha256:e44452094f3067bbca5672ab2d6052ea60dfcdd877ee0842f91803ae66bcd8e5`, issue time `2026-08-27T20:25:05.000Z`, and expiry `2027-08-27T20:25:05.000Z`. Its canonical file, including the terminal newline, has SHA-256 `38a5414c2da581bf0014a2769c9842375b0d0822b77f89e5159b27b3042fc58e`; the alpha predecessor preflight accepts that exact r11 bootstrap.

The manual Pages workflow runs only from `main`, derives the expected revision from the packaged bootstrap plus the exact committed successor, verifies that adjacent signed transition, then copies the exact canonical bytes. It has no signing secret and cannot construct another revision. Stable post-publication run `33130950000` completed successfully on protected `main` commit `6d95545652e15c57b9e13390095a7172e65034b3`. Its Actions artifact digest is `sha256:7dbc3145d376f75ed4ff8763af46290f7daff5a0be9dcf446fd017f02a23c2c0`; its release-ready receipt digest is `sha256:cdc27dfcb5768b8fe14c082553b5120e98d050748015df0311d1e610edf27994`; and its public-catalog receipt digest is `sha256:4bb66be8eef541eaebde8e0ee56ad09225f6f288948365d08c00c9d3159ad700`. The public-catalog receipt binds `https://striveh.github.io/dsh-plugin-extension-center/plugins.json` to the exact revision-11 file SHA-256 above. This proves the stable official-rc.2 Release, Pages deployment, same-root update, and runtime refresh only; alpha r12 and public artifact lifecycle evidence remain `Pending`/RED.
