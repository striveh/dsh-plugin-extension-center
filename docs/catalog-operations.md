# Catalog discovery, admission, and signing

English | [中文](catalog-operations.zh.md)

The Extension Center separates public discovery from writable Store admission. Runtime Store search and task Capability RAG read only one signed, locally verified snapshot. They never browse community sites, send task text to a registry, execute an upstream install field, or let the model supply package coordinates.

## Lead discovery

`pnpm catalog:discover -- --out <new-leads.json>` performs a bounded, credential-free sweep of three fixed public inputs:

- the unofficial [DSH community catalog](https://awesome-dsh-plugin.com/plugins.json) for Plugin leads;
- the paginated [official MCP Registry API](https://registry.modelcontextprotocol.io/v0.1/servers) for exact MCP version leads; and
- one fixed GitHub repository search for the `agent-skill` topic for Skill-repository leads.

Requests use HTTPS, reject redirects, accept JSON only, cap response bytes and MCP pages, and write a new exclusive owner-only report. A bounded MCP batch retains `mcpNextCursor`; the next invocation passes it through `--mcp-cursor`, or uses the official Registry's incremental filter through `--mcp-updated-since`. This continuation is safe because lead reports are curation input, not catalog completeness claims. Community descriptions, README summaries, default branches, and free-form install strings are discarded. The report retains only closed lead fields, source-document digests, pinned version hints when the upstream registry provides them, and non-authoritative activity signals. Invalid rows become digest-only rejection records. A lead cannot appear in the Store or task resolver.

The current `awesome-dsh-plugin.com/plugins.json` document is a useful community lead source but uses its own unsigned directory schema. It is not the signed `{ envelope, signatures }` document accepted by `catalogTrustedOrigin` and must never be configured as that trusted runtime origin.

## Admission evidence

Publication consumes a curator-authored admission document and exact local artifact files. Every entry must bind one or more known leads with the same extension kind and upstream repository. It must use immutable source and artifact coordinates and make all five writable P0 actions—Install, Configure, Update, Uninstall, and Restore—available.

Each admission also embeds four exact, candidate-bound receipts:

- lifecycle fixtures with all five actions passed on DSH `0.1.1-rc.2` and an exact source revision;
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
