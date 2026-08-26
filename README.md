# dsh-plugin-extension-center

English | [中文](README.zh.md)

[![CI](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml/badge.svg)](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An independent community plugin project for a local DeepSeek Harness Unified Extension Center. P0 has two first-class acquisition paths: the Agent can detect a task capability gap and retrieve an admitted candidate with local Capability RAG, while the user can browse, search, compare, and acquire the same catalog through an Extension Store. Both paths converge on the same admitted catalog, policy, Host-owned transaction engine, owner verification, inventory, and receipt schema; every action receives its own exact immutable plan. Every writable catalog candidate must also cover discovery, installation, configuration, exact update, verification, uninstallation, and failure recovery; enablement and disablement appear only where the extension's real owner supports them. The product does not merge DSH Plugin, MCP server, and Skill lifecycles or claim that installation proves safety.

This is not an official DeepSeek Harness release. Product code, catalog policy, tests, compatibility claims, and releases belong to this repository; the DSH monorepo remains the host and is not the implementation home.

Status (2026-08-26): the independent implementation now contains the signed offline Store, a configured live signed-catalog refresh path with an unexpired last-good cache, a lead-only discovery and threshold-signing pipeline, normalized installed inventory, immutable plan and loopback approval flow, per-target journal and recovery, typed Plugin/MCP/Skill providers, task-first local Capability RAG, trusted MCP configuration queue, and durable original-task continuation binding. The UI separates Store acquisition from Installed lifecycle actions and exposes exact catalog freshness, connection-versus-artifact ownership, authority, verification, recovery, and receipts. Focused Host/Client and deterministic catalog fault tests and packed rc.2 read-only browser acceptance pass. A package-owned standalone recovery executable is hash-pinned in new operation evidence and can request an exact Profile restore without loading the Center runtime; published rc.2 deliberately fails this path because it has no Profile transaction `list`/`restore`/`restore-receipt` Consumer. A deployed signed remote revision and its independently produced admission receipts, local writable Host crash recovery, published-release installation, real-provider task completion, and ordinary-user usability remain separate release gates.

The public `main` branch is a development source preview, not a stable release or npm publication. The manifest intentionally keeps `private: true` to prevent accidental npm publication while writable compatibility is still `TBD`; this does not restrict the MIT-licensed GitHub source. No `v0.1.0` tag or release is valid until the published-Host and external P0 gates below pass.

- [P0 product specification and acceptance path](docs/p0-product-spec.md)
- [P0 产品规格与验收路径](docs/p0-product-spec.zh.md)
- [Capability discovery and Extension Store research](docs/capability-rag-research.md)
- [能力发现与扩展商店研究](docs/capability-rag-research.zh.md)
- [Catalog discovery, admission, and signing](docs/catalog-operations.md)
- [目录发现、准入与签名](docs/catalog-operations.zh.md)
- [rc.2 signed offline Store acceptance](acceptance/store-only/README.md)
- [rc.2 签名离线商店验收](acceptance/store-only/README.zh.md)

The audited published baseline remains the immutable `dsh-v0.1.1-rc.2` release. It supports the read-only Store lane but does not contain the three new writable owners, so it remains the permanent negative compatibility lane. A separate local DSH HEAD implements Profile transactions, dynamic MCP connections, and durable task-continuation dispatch for integration testing; it is not a published release and does not rewrite rc.2 history. Writable compatibility remains **TBD** until an exact DSH release publishes those owners and the same packed Bundle passes artifact, browser, recovery, lifecycle, and real-task gates on that unmodified release.

## Development checkout

Use the published `main` branch for source review and development only. Pin an exact reviewed commit instead of a moving branch when exercising the rc.2 read-only Store lane:

```sh
dsh plugin --profile web add github:striveh/dsh-plugin-extension-center#<reviewed-commit-sha>
dsh --profile web --dump-config
dsh web
```

The repository commits deterministic `lib/` artifacts and declares no package lifecycle script, so a GitHub install does not execute a project build. Published DSH `0.1.1-rc.2` must expose lifecycle controls as unavailable; do not use a local writable-Host result as a released compatibility claim.

For development and verification:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run pack:preview
pnpm exec playwright install chromium
pnpm run test:acceptance:store
pnpm run test:acceptance:host-negative
```

The local writable-Host lane additionally requires a separately built DSH checkout containing all six required owners and remains release evidence only for that exact checkout. See [Contributing](CONTRIBUTING.md) for the evidence and release rules and [Security policy](SECURITY.md) for private vulnerability reporting.

## Live catalog refresh

`catalogTrustedOrigin` accepts one canonical HTTPS origin; the Host always fetches its fixed `/plugins.json` path and accepts only a complete envelope verified by the package's fixed signing root. `catalogFetchTimeoutMs` bounds each fetch and `catalogRefreshIntervalMs` controls the optional background refresh. Startup, the loopback `catalog/refresh` action, the Store, and task Capability RAG all use one admitted snapshot. Store search text and task content never enter the request. A failed refresh keeps only an unexpired verified bootstrap or last-good snapshot and reports `source`, `freshness`, `degradedReason`, and `lastRefreshAtMs`; an expired snapshot fails closed.

## Break-glass Profile recovery

At Host startup the built dependency-free recovery CLI is copied atomically to `$DSH_HOME/extension-center/recovery/<package-version>/<platform>-<arch>/break-glass.mjs`. Every consumed operation records that exact absolute path and SHA-256 together with the exact public DSH CLI path and SHA-256 and the canonical Host home. If the Center or Web cannot load, run the pinned absolute file with `node <pinned-break-glass.mjs> <center-root> <operation-id>`. It verifies its own bytes, the Host CLI bytes, the canonical Host home, the journal chain, `CURRENT` head, plan evidence, and any receipt. Host invocations receive the pinned home as `DSH_HOME` in a scrubbed environment; an ambient `DSH_HOME` cannot select another Profile store. It then queries the Host for the exact Profile restore receipt under the deterministic mutation identity derived from the verified operation id. A committed receipt is verified against the journal generation/tree pin and either its exact after-snapshot or the single legal boot-acknowledgement transition from that snapshot; unrelated drift is rejected. Only `not-found` permits current-selector validation and a new restore call. A lost response or killed caller therefore retries without publishing a second transition, including after the restored generation is acknowledged. It never imports the Center runtime and never writes a Profile directly. Success means only `profile restored; Center journal reconciliation pending`; a later healthy Center start must reconcile the retained journal.

The immutable rc.2 Host is the negative lane: its generic pnpm-forwarding `dsh plugin` command does not implement the exact JSON `list`, generation `restore`, and mutation-bound `restore-receipt` protocol, so recovery exits fail-closed without claiming a restore. Full recovery remains gated on a published DSH release with that public Profile transaction Consumer and packed crash-path acceptance.

## License

[MIT](LICENSE). DeepSeek Harness and DeepSeek names belong to their respective owners.
