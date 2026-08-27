# Contributing

Thanks for improving `dsh-plugin-extension-center`. The project is an independent community plugin and must keep Plugin, MCP, and Skill ownership distinct while giving ordinary users one coherent management experience.

## Development baseline

- Node.js `22.19.x` or a newer version admitted by `package.json`
- pnpm `11.21.0`
- The unmodified official DeepSeek Harness `0.1.1-rc.2` release at `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`

Install dependencies and run the source and package gates:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run pack:preview
```

For packed official rc.2 Store evidence and the complete-lifecycle runner candidate:

```sh
pnpm exec playwright install chromium
pnpm run test:acceptance:store
pnpm run test:acceptance:official-rc2
```

Build artifacts under `lib/` are part of the GitHub distribution and must change with source. Do not add `prepare`, `preinstall`, `install`, or `postinstall`: GitHub consumers must not have to authorize package code execution during installation.

## Product and security invariants

- Store browsing and task-driven discovery share one admitted signed catalog, policy evaluator, immutable-plan format, authorization flow, Center-owned operation journal, verification, receipt, recovery coordination, and continuation path.
- Discovery sources produce leads, not install authority. A model cannot supply a package, URL, command, credential, redirect, or approval.
- Plugin, MCP, and Skill lifecycle states remain type-specific. Never collapse package presence, configuration, activation, runtime health, tool discovery, task success, or recovery into one status.
- Every mutation requires an exact unexpired single-use human grant with a plan hash and inventory revision fence. Configuration, enablement, update, uninstall, restore, and purge are separate actions when supported.
- For every admitted child Plugin Bundle, whether Host-only or Host+Client, the Center stages and pins the archive but every Profile mutation runs through the official `dsh plugin --profile` CLI. The Center never writes Profile dependencies, lock data, `node_modules`, Bundle membership, or Loader rows directly. Center-owned MCP, Skill, and Continuation adapters use the official MCP Client, Skill registry, Agent, and Session services. Durable records alone cannot claim that an extension is installed, enabled, connected, verified, restored, or used successfully.
- Logs, journals, receipts, UI evidence, fixtures, and issues exclude credentials, task text, private catalog rows, cookies, authorization headers, and provider payloads.
- Recovery binding schema v5 and official-execution binding v2 pin the fixed executable and Center state root together with Node, the process supervisor, private bundled pnpm, and the official rc.2 package tree, production closure, declared entrypoint, and `hostHome`. Even when the Center or Host cannot start, recovery may roll back a child Plugin only by restoring the journal-bound Profile before-state through that official CLI, verifying it, and then committing Center state. It fails closed on drift and never writes Profile package-manager state directly.
- An installed-Profile child Plugin mutation strictly derives an owner-only, content-addressed pnpm 11 metadata generation from the exact pre-mutation manifest, lock, modules metadata, installed manifests, and canonical store. Its binding lives in the Plugin provider recovery snapshot; normal and break-glass paths re-verify the same manifest and file digests before the next Profile write, remain offline with lifecycle scripts disabled, and fail closed on missing or changed material. The cache is not a network prewarm. Only a fresh Profile with neither lock nor `node_modules` installation uses the Center-private store.
- Artifact acquisition rejects all IPv4 and IPv6 literals in initial and redirect URLs. Hostnames and DNS remain untrusted; do not describe this lexical URL policy as DNS-rebinding protection.
- The rc.2 external Plugin CLI exposes no lock or compare-and-swap token to the Center. Center target locks serialize Center operations only. The packed controlled ABA lane must prove its exact separately invoked official-CLI ordering enters recovery instead of publishing false success; do not generalize that receipt to untested interleavings.
- Compatibility evidence comes only from the same packed artifact running on the unmodified official rc.2 release. A patched Host or source checkout is not a substitute.

Read the [P0 product specification](docs/p0-product-spec.md), [catalog operations](docs/catalog-operations.md), and [Capability RAG research](docs/capability-rag-research.md) before changing the corresponding surface.

## Change evidence

Pull requests should state the user-visible outcome, affected extension kinds and lifecycle actions, authority and recovery impact, sensitive-data impact, DSH version impact, commands actually run, and anything still unverified. Product-visible changes require the owning Host/Client tests plus the packed journey that reaches the changed behavior. Synthetic fixtures are required; never publish real credentials, tasks, private repositories, or user data.

## Release rules

Do not create a stable tag or stable GitHub Release while the packed official rc.2 P0 receipt is incomplete. A prerelease must state its exact proven scope and every `Pending` external receipt. GitHub-only releases retain `private: true` to prevent accidental npm publication; that flag does not block a reviewed `.tgz` GitHub Release.

A stable release requires all of the following:

1. Update the package version, both READMEs, the changelog, exact DSH compatibility, and catalog admission evidence together.
2. Start from a clean reviewed commit; run the source, packed Store, official rc.2 lifecycle, recovery, browser, and keyless official Replay Agent gates owned by the declared scope. Replay replaces only model responses; the real Agent, Session, Tool, Skill, continuation, and receipt path must execute. A live-provider smoke is advisory and non-blocking.
3. Pack twice from the same commit and require identical bytes and SHA-256; inspect every archive path and the packed manifest. The exact `main`-push Node 22 CI job must upload the eligible tarball with `SHA256SUMS` and a self-digested attestation bound to the source commit, run id and attempt, packed manifest, bundled pnpm tree, and artifact coordinates.
4. Install the exact public tag or attached archive through the official CLI into an isolated unmodified rc.2 Profile and verify Store, Plugin, MCP, Skill, update, recovery, removal, original-task continuation, and the controlled external-CLI ABA ordering as claimed. Remove child Plugins and the Center through the same official CLI, prove the official DSH source and package tree remain unchanged, and record every expected Profile package-manager change.
5. Require exact-commit CI and cross-platform receipts, private-vulnerability reporting, immutable `v*` tag protection, repository Release immutability, release notes with exact receipts and remaining uncertainty, and attached `.tgz` plus `SHA256SUMS`. The CI verifier must bind the Actions archive digest, run id and attempt, path-safe exact three-entry ZIP, and attested tarball; runtime, public-release, and composite receipts must cross-bind those same bytes. Every update must also bind the exact previous successful post-publication run and schema-v2 release-ready receipt, promote that receipt's deployed catalog into the current packaged bootstrap, and deploy only its exact signed adjacent successor. A configured workflow, enabled repository policy, or requested matrix is not a passing receipt. Each published version's status comes only from its exact external receipts.
6. Do not publish to the `@deepseek-ai` npm scope. Any future package registry publication needs an independently owned name, provenance, two-factor protection, and the same reviewed bytes.

The public catalog is a separate signed artifact. Curate new entries through `pnpm catalog:publish`; use `pnpm catalog:rollover` only to create the exact next entry-preserving revision. Commit the signed document and its evidence record, then manually dispatch the Pages workflow from protected `main`. The workflow verifies the signature and exact adjacent bootstrap chain and copies the committed canonical bytes; it cannot sign or alter a catalog. A Pages deployment claim exists only after the fixed public URL returns the exact canonical bytes and a runtime refresh receipt proves the signed successor. The release sequence is rc.0 `r8→r9`, rc.1 `r9→r10`, and stable `r10→r11`.
