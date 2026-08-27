# Catalog discovery, admission, and signing

English | [中文](catalog-operations.zh.md)

The Extension Center separates public discovery from writable Store admission. Runtime Store search and task Capability RAG read only one signed, locally verified snapshot. They never browse community sites, send task text to a registry, execute an upstream install field, or let the model supply package coordinates.

## Lead discovery

`pnpm catalog:discover -- --out <new-leads.json>` performs a bounded, credential-free sweep of three fixed public inputs:

- the unofficial [DSH community catalog](https://awesome-dsh-plugin.com/plugins.json) for Plugin leads;
- the paginated [official MCP Registry API](https://registry.modelcontextprotocol.io/v0.1/servers) for exact MCP version leads; and
- one fixed GitHub repository search for the `agent-skill` topic for Skill-repository leads.

Requests use HTTPS, reject redirects, accept JSON only, cap response bytes and MCP pages, and write a new exclusive owner-only report. A bounded MCP batch retains `mcpNextCursor`; the next invocation passes it through `--mcp-cursor`, or uses the official Registry's incremental filter through `--mcp-updated-since`. This continuation is safe because lead reports are curation input, not catalog completeness claims. Community descriptions, README summaries, default branches, and free-form install strings are discarded. The report retains only closed lead fields, source-document digests, pinned version hints when the upstream registry provides them, and non-authoritative activity signals. Invalid rows become digest-only rejection records. A lead cannot appear in the Store or task resolver.

The scheduled discovery workflow also re-fetches every artifact in the currently signed catalog, resolves Plugin Release tags to their admitted Git commit, checks that exact MCP Registry versions remain active, and revalidates commit-pinned Skill content. It emits a separate digest-bound source-freshness receipt. This does not admit a lead, repeat the human authority review, or certify third-party code safety.

The current `awesome-dsh-plugin.com/plugins.json` document is a useful community lead source but uses its own unsigned directory schema. It is not the signed `{ envelope, signatures }` document accepted by `catalogTrustedUrl` and must never be configured as that trusted runtime URL.

## Admission evidence

Publication consumes a curator-authored admission document and exact local artifact files. Every entry must bind one or more known leads with the same extension kind and upstream repository. It must use immutable source and artifact coordinates and make all five writable P0 actions—Install, Configure, Update, Uninstall, and Restore—available.

Each admission also embeds four exact, candidate-bound receipts:

- lifecycle fixtures with all five actions passed for the exact candidate source revision on the unmodified official DSH `0.1.1-rc.2` artifact;
- compatibility with at least one explicit platform result;
- human authority review with a canonical authority digest; and
- a complete dependency-graph scan reporting no install lifecycle scripts.

The publisher re-hashes the local artifact and rejects a size or integrity mismatch. It validates these receipts but does not manufacture their claims or execute unreviewed upstream code; the fixture, compatibility, authority-review, and dependency-scan systems remain independent evidence producers.

The package build must also know how to construct the exact pre-authorization review evidence for the candidate. Plugin and Skill admissions are therefore limited to a package-pinned identity that binds kind, candidate reference, extension name, artifact id, revision, integrity, and size. MCP admissions use the typed runtime-bound review recipe and remain ineligible at runtime until an exact allowlisted descriptor preflight succeeds. The publisher rejects an admission without one of those recipes, and the runtime catalog verifier plus the shared Store/task policy repeat that check before the candidate can be treated as writable. Adding a new Plugin or Skill requires shipping its review record in a new Extension Center build; a signed catalog entry alone cannot make it executable.

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

Each later Center release promotes the preceding public document into its packaged bootstrap before signing another successor. The post-publication workflow then binds the previous successful schema-v2 release-ready receipt by exact Actions run id and rejects the update unless the previous deployed catalog is byte-identity-equivalent at the revision, entries, envelope, and signature-set coordinates to the current packaged bootstrap. The current deployment must be the exact adjacent signed successor. This creates the release sequence rc.0 `r8→r9`, rc.1 `r9→r10`, and stable `r10→r11`; a source edit, local test, or Pages configuration cannot substitute for either deployed receipt.

## Public revision 9

The committed Pages input at `catalog/public/plugins.json` is the entry-preserving exact successor to packaged bootstrap revision 8. Revision 9 uses key id `bootstrap-2026-08-26-8`, previous-envelope digest `sha256:10e514360a51e55ca6b27822ebd4eead754ef5b53d70e2af4acffd91286aa4f5`, entries digest `sha256:da9f5a4f703462cb27de0df26e265c3461dd85a51f0b5a2deecb76ee22d9de86`, canonical document digest `sha256:efc965813858757a6a18d59a07c19db545053f00ed8aaf739122174c91e3c6ac`, issue time `2026-08-26T19:10:08.000Z`, and expiry `2027-08-26T19:10:08.000Z`. Its canonical file, including the terminal newline, has SHA-256 `cf508545567cd69bf326878170aa48d521c2026c73e001cd8cbb33cb089a214e`.

The manual Pages workflow runs only from `main`, derives the expected revision from the packaged bootstrap plus the exact committed successor, verifies that adjacent signed transition, then copies the exact canonical bytes. It has no signing secret and cannot construct another revision. The committed revision is a publication input, not deployment evidence. The current rc.0 publication is complete only after `https://striveh.github.io/dsh-plugin-extension-center/plugins.json` returns these revision-9 bytes with HTTP 200 and the runtime records a successful revision-8-to-9 refresh.
