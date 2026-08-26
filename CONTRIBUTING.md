# Contributing

Thanks for improving `dsh-plugin-extension-center`. The project is an independent community plugin and must keep Plugin, MCP, and Skill ownership distinct while giving ordinary users one coherent management experience.

## Development baseline

- Node.js `22.19.x` or a newer version admitted by `package.json`
- pnpm `11.21.0`
- DeepSeek Harness `0.1.1-rc.2` for the permanent published read-only and expected-negative lanes
- A separately built local DSH checkout only for the explicitly labelled local writable-Host lane

Install dependencies and run the source and package gates:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run pack:preview
```

For packed rc.2 browser and Host-owner acceptance:

```sh
pnpm exec playwright install chromium
pnpm run test:acceptance:store
pnpm run test:acceptance:host-negative
```

Build artifacts under `lib/` are part of the GitHub distribution and must change with source. Do not add `prepare`, `preinstall`, `install`, or `postinstall`: GitHub consumers must not have to authorize package code execution during installation.

## Product and security invariants

- Store browsing and task-driven discovery share one admitted signed catalog, policy evaluator, immutable-plan format, authorization flow, owner transaction, verification, receipt, and recovery path.
- Discovery sources produce leads, not install authority. A model cannot supply a package, URL, command, credential, redirect, or approval.
- Plugin, MCP, and Skill lifecycle states remain type-specific. Never collapse package presence, configuration, activation, runtime health, tool discovery, task success, or recovery into one status.
- Every mutation requires an exact unexpired single-use human grant with a plan hash and inventory revision fence. Configuration, enablement, update, uninstall, restore, and purge are separate actions when supported.
- Host owners perform mutations and report observed state. Center-only records cannot claim that an extension was installed, enabled, connected, verified, restored, or used successfully.
- Logs, journals, receipts, UI evidence, fixtures, and issues exclude credentials, task text, private catalog rows, cookies, authorization headers, and provider payloads.
- The fixed recovery executable and Host CLI are hash-pinned. Recovery fails closed on drift and never writes a Profile directly.
- A local DSH HEAD result is labelled local-only. Compatibility cannot broaden until the same packed artifact passes on an unmodified published release.

Read the [P0 product specification](docs/p0-product-spec.md), [catalog operations](docs/catalog-operations.md), and [Capability RAG research](docs/capability-rag-research.md) before changing the corresponding surface.

## Change evidence

Pull requests should state the user-visible outcome, affected extension kinds and lifecycle actions, authority and recovery impact, sensitive-data impact, DSH version impact, commands actually run, and anything still unverified. Product-visible changes require the owning Host/Client tests plus the packed journey that reaches the changed behavior. Synthetic fixtures are required; never publish real credentials, tasks, private repositories, or user data.

## Release rules

The public `main` branch is a development source preview. Do not create a stable tag or GitHub Release while the manifest version is `0.0.0-development`, npm publication is guarded by `private: true`, or writable DSH compatibility is `TBD`.

A stable release requires all of the following:

1. Update the package version, both READMEs, this changelog, exact DSH compatibility, and catalog admission evidence together.
2. Start from a clean reviewed commit; run the source, packed Store, expected-negative Host, exact published writable-Host, lifecycle, recovery, and real-task gates owned by the declared scope.
3. Pack twice from the same commit and require identical bytes and SHA-256; inspect every archive path and the packed manifest.
4. Install the exact public tag or attached archive into isolated unmodified supported DSH profiles and verify Store, Plugin, MCP, Skill, update, recovery, removal, and original-task continuation as claimed.
5. Require CI, cross-platform coverage, private-vulnerability reporting, immutable `v*` tag protection, release notes with exact receipts and remaining uncertainty, and attached `.tgz` plus `SHA256SUMS`.
6. Do not publish to the `@deepseek-ai` npm scope. Any future package registry publication needs an independently owned name, provenance, two-factor protection, and the same reviewed bytes.
