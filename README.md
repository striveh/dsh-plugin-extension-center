# dsh-plugin-extension-center

English | [中文](README.zh.md)

[![CI](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml/badge.svg)](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An independent community plugin project for a local DeepSeek Harness Unified Extension Center. P0 has two first-class acquisition paths: the Agent can detect a task capability gap and retrieve an admitted candidate with local Capability RAG, while the user can browse, search, compare, and acquire the same catalog through an Extension Store. Both paths converge on the same admitted catalog, policy, Center-owned discovery and acquisition control plane, verification, inventory, and receipt schema; every action receives its own exact immutable plan. Every writable catalog candidate must also cover discovery, installation, configuration, exact update, verification, uninstallation, and failure recovery; enablement and disablement appear only where the extension's real owner supports them. The product does not merge DSH Plugin, MCP server, and Skill lifecycles or claim that installation proves safety.

This is not an official DeepSeek Harness release. Product code, catalog policy, tests, compatibility claims, and releases belong to this repository; the DSH monorepo remains the host and is not the implementation home.

Status (2026-08-28): the source implements the signed Store, signed-catalog refresh with an unexpired last-good cache, lead-only discovery and threshold-signing, normalized inventory, immutable plans and loopback approval, per-target journals and receipts, typed Plugin/MCP/Skill operations, task-first local Capability RAG, recovery coordination, and durable continuation claims. For every admitted child Plugin Bundle, whether Host-only or Host+Client, the Center stages and pins exact archives and delegates package membership changes to the official `dsh plugin --profile` CLI; only the official Profile package manager writes Profile dependencies, lock data, `node_modules`, Bundle membership, and package-membership Loader rows. Pure configuration replaces and verifies the exact managed row through the official Loader in the same Host process. MCP stdio connections mount the official MCP Client, Skills project through the official registry, and continuation uses the official Agent and Session services. No fork-only package or DSH Host PR is part of the design. See the [plugin-only architecture](docs/plugin-only-architecture.md) for the exact boundary.

Evidence is receipt-scoped. Pre-publication acceptance requires the exact packed artifact to pass the complete official-rc.2 lifecycle, browser, controlled-ABA, break-glass, fault, deterministic Replay Agent, Ubuntu, and macOS lanes. The successful `0.1.0-rc.0` bootstrap records previous Center, CI, release-ready, and evidence-run inputs as `null`. The immutable rc.1 candidate has no successful composite receipt: its only post-publication attempt exposed the persistent catalog-cache rollover defect during a real same-Profile update and remains a `not-release-ready` incident. Recovery rc.2 must update directly from rc.0's last successful receipt, retain and migrate the same Center root, keep packaged `r9` and deployed `r10`, and bind that rc.1 incident; stable can advance only from a successful rc.2 receipt. Public Release installation, Pages refresh, and cross-bound completion exist only when their own post-publication and composite receipts pass. Replay substitutes only the model response edge while the official Agent, Session, Tool dispatch, Center-managed Skill, continuation, and receipt path run normally. A live-provider run is an advisory compatibility smoke; it neither blocks P0 nor substitutes for a deterministic receipt.

The public `main` branch is a development source preview, not a stable release or npm publication. The manifest intentionally keeps `private: true` to prevent accidental npm publication; this does not restrict the MIT-licensed GitHub source or reviewed GitHub Release assets. The status of a GitHub Release, public Pages catalog, or completed CI lane is recorded only by the receipt for that exact version and must never be inferred from source files, workflows, repository settings, or local tests.

Release provenance is byte-oriented. Only the deterministic tarball, `SHA256SUMS`, and self-digested pack attestation uploaded by the exact `main`-push Node 22 CI job are eligible for release. The CI verifier binds the Actions archive digest, run id and attempt, exact three-entry ZIP payload, source commit, packed manifest, bundled pnpm tree, and tarball bytes; it permits only the fixed GitHub API download followed by one admitted GitHub Actions or Azure Blob storage redirect. Runtime, public-release, and composite receipts must all bind that same attested tarball. Repository Release immutability and protected `v*` tags prevent later mutation; those repository policies do not substitute for the receipt of any concrete Release.

- [P0 product specification and acceptance path](docs/p0-product-spec.md)
- [P0 产品规格与验收路径](docs/p0-product-spec.zh.md)
- [Capability discovery and Extension Store research](docs/capability-rag-research.md)
- [能力发现与扩展商店研究](docs/capability-rag-research.zh.md)
- [Catalog discovery, admission, and signing](docs/catalog-operations.md)
- [目录发现、准入与签名](docs/catalog-operations.zh.md)
- [rc.2 signed offline Store acceptance](acceptance/store-only/README.md)
- [rc.2 签名离线商店验收](acceptance/store-only/README.zh.md)
- [full P0 acceptance on official rc.2](acceptance/full-p0/README.md)
- [基于官方 rc.2 的完整 P0 验收](acceptance/full-p0/README.zh.md)

The compatibility target under verification is the immutable official `dsh-v0.1.1-rc.2` release at `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. The Center consumes its published Plugin CLI, Loader, Tool, Skill, MCP Client, Agent, Session, Connection RPC, and Web Client extension points. A compatibility claim is valid only when the packed bundle passes the applicable lane on that unmodified release.

## Install a published release candidate

The coordinates below are valid only when the matching GitHub Release exists and its public-release receipt passes. Otherwise the release installation claim is unavailable; a development checkout is not a substitute. For a published candidate, install the Center from its immutable GitHub Release asset, not from a moving branch. The official DSH Plugin CLI delegates Profile package management to pnpm, so `pnpm` must be available on `PATH`:

```sh
curl -fLO https://github.com/striveh/dsh-plugin-extension-center/releases/download/v0.1.0-rc.2/dsh-plugin-extension-center-0.1.0-rc.2.tgz
curl -fLO https://github.com/striveh/dsh-plugin-extension-center/releases/download/v0.1.0-rc.2/SHA256SUMS
shasum -a 256 -c SHA256SUMS
dsh plugin --profile web add ./dsh-plugin-extension-center-0.1.0-rc.2.tgz --ignore-scripts --save-exact
dsh plugin --profile web list --depth 0
dsh --profile web --dump-config
dsh web
```

Stop the Host before updating, downgrading, or removing the Center. Pass the new exact local archive to the same `add` command for an update or downgrade. Remove it only through the official Profile package manager, then restart DSH:

```sh
dsh plugin --profile web remove dsh-plugin-extension-center
```

Runtime configuration belongs to the official Loader patch at `$DSH_HOME/profiles/web/cordis.patch.yml` or the corresponding home-level patch. A Loader patch replaces the complete matching row configuration, so repeat every field that must be retained and confirm the result with `dsh --profile web --dump-config`. The default Bundle config trusts the exact public `plugins.json` URL but deliberately declares no `mcpRuntimes` allowlist. Artifact acquisition rejects every IPv4 and IPv6 literal in initial and redirect URLs. It permits at most one redirect by default, and a cross-origin hop may target only `objects.githubusercontent.com` or `release-assets.githubusercontent.com`; it binds the consumed authorization to the signed coordinate captured by the immutable plan and verifies the admitted byte size and digest. Deployments may tighten `maximumArtifactRedirects` to zero and reduce or empty `allowedArtifactRedirectHosts`. Hostnames and DNS remain untrusted: this URL check does not resolve names and does not claim DNS-rebinding protection. An MCP candidate remains non-writable until the user configures an exact executable path, digest, version, fixed arguments, and working directory through that Loader row. P0 mutation and recovery support macOS and Linux and fail closed on Windows.

## Development checkout

Use the published `main` branch for source review and development only. Pin an exact reviewed commit instead of a moving branch when exercising the packed rc.2 Store slice:

```sh
dsh plugin --profile web add github:striveh/dsh-plugin-extension-center#<reviewed-commit-sha>
dsh --profile web --dump-config
dsh web
```

The repository commits deterministic `lib/` artifacts and declares no package lifecycle script, so a GitHub install does not execute a project build. The Center itself must be installed, updated, downgraded, or removed externally through this official CLI; it never self-modifies while running. The successful `0.1.0-rc.0` bootstrap proves catalog `r8→r9`. The immutable rc.1 candidate deployed `r10` but failed its real rc.0-to-rc.1 same-Profile update before producing a composite receipt. Recovery rc.2 therefore consumes rc.0 as the last successful predecessor, proves the retained r8 cache can migrate through packaged r9 to public r10, and records rc.1 as a failed candidate. Stable must advance directly from successful rc.2, promote `r10`, and deploy `r11`.

For development and verification:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run pack:preview
pnpm exec playwright install chromium
pnpm run test:acceptance:store
pnpm run test:acceptance:official-rc2
```

See [Contributing](CONTRIBUTING.md) for the evidence and release rules and [Security policy](SECURITY.md) for private vulnerability reporting.

## Live catalog refresh

`catalogTrustedUrl` accepts one exact canonical HTTPS URL and the Host accepts only a complete envelope verified by the package's fixed signing root. `catalogFetchTimeoutMs` bounds each fetch and `catalogRefreshIntervalMs` controls the optional background refresh. Startup, the loopback `catalog/refresh` action, the Store, and task Capability RAG all use one admitted snapshot. Store search text and task content never enter the request. On package update, the Center verifies the complete historical signed cache before atomically raising its anchor to the packaged bootstrap; a same-or-newer conflict, broken chain, signature drift, malformed file, or failed durable replacement aborts startup without exposing the historical prefix. Every durable cache read, comparison, and replacement is serialized across DSH processes by a Center-owned writer reservation; network access stays outside it, the writer re-reads the authoritative chain, and an older completion cannot replace a newer verified tip. SQLite releases the reservation after process death, while the next writer performs normal recovery without deleting user state. A failed or stale network refresh keeps only an unexpired verified bootstrap or last-good snapshot and reports `source`, `freshness`, `degradedReason`, and `lastRefreshAtMs`; an expired snapshot fails closed.

## Break-glass Center recovery

The source installs a dependency-free recovery CLI at `$DSH_HOME/extension-center/recovery/<package-version>/<platform>-<arch>/break-glass.mjs`. Recovery binding schema v5, with official-execution binding v2, pins that file and Center root plus the canonical Node executable, version, and digest; the POSIX supervisor; a private bundled `pnpm@11.21.0` package, registry SRI, complete tree, entrypoint, shim, and shell; and the exact official rc.2 package, entrypoint, and installed production-dependency closure. For an installed Profile, the Center strictly reads the exact pre-mutation `package.json`, `pnpm-lock.yaml`, `node_modules/.modules.yaml`, and referenced installed package manifests, then synthesizes an owner-only, content-addressed pnpm 11 abbreviated and full metadata-cache generation from those local facts. The bound generation identity covers the Profile digests, existing canonical store, generated files, pinned pnpm runtime, and cache manifest; every use re-verifies the manifest and file digests. Its binding is stored in the Plugin provider recovery snapshot, so normal rollback and standalone break-glass recovery verify and use the same generation. A missing, changed, symlinked, or mismatched cache fails before the next official CLI Profile write. Execution remains offline with lifecycle scripts disabled; this cache is not a network prewarm and makes no claim that unavailable package bytes can be fetched. Only a Profile with no lock and no `node_modules` installation uses a Center-private per-Profile store. A detached process-group supervisor terminates the complete mutation subtree after timeout or parent loss, including parent `SIGKILL`; its execution lease prevents stale-lock reclamation while the subtree remains live. This mutation and recovery path supports macOS and Linux and fails closed on Windows. Once provider apply begins, unavailable mutation recovery remains locked as `recovery-required` instead of becoming a failed receipt. Startup reads retired Center and owner sidecar state before owner initialization; a failed retired Plugin journal still referenced by either projection is quarantined and a missing exact target lock blocks writable activation. With DSH stopped, break-glass recovery verifies the journal-bound provider snapshot, invokes only the bound official CLI to restore the exact Profile before-state, verifies that result, and only then commits Center state. It never writes Profile dependencies, lock data, `node_modules`, Bundle membership, or Loader rows directly and never imports the broken Center runtime. A later official DSH boot must verify the selected Profile dependency, Loader contribution, and declared consumer before terminal recovery evidence is valid. The exact complete-lifecycle receipt records whether packed break-glass execution passed for a release candidate; source code alone makes no such claim.

## License

[MIT](LICENSE). DeepSeek Harness and DeepSeek names belong to their respective owners.
