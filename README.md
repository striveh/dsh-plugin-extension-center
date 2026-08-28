# dsh-plugin-extension-center

English | [中文](README.zh.md)

[![CI](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml/badge.svg)](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An independent community plugin project for a local DeepSeek Harness Unified Extension Center. P0 has two first-class acquisition paths: the Agent can detect a task capability gap and retrieve an admitted candidate with local Capability RAG, while the user can browse, search, compare, and acquire the same catalog through an Extension Store. Both paths converge on the same admitted catalog, policy, Center-owned discovery and acquisition control plane, verification, inventory, and receipt schema; every action receives its own exact immutable plan. Every writable catalog candidate must also cover discovery, installation, configuration, exact update, verification, uninstallation, and failure recovery; enablement and disablement appear only where the extension's real owner supports them. The product does not merge DSH Plugin, MCP server, and Skill lifecycles or claim that installation proves safety.

This is not an official DeepSeek Harness release. Product code, catalog policy, tests, compatibility claims, and releases belong to this repository; the DSH monorepo remains the host and is not the implementation home.

Status (2026-08-28): the source implements the signed Store, signed-catalog refresh with an unexpired last-good cache, lead-only discovery and threshold-signing, normalized inventory, immutable plans and browser-session-authenticated user decisions, per-target journals and receipts, typed Plugin/MCP/Skill operations, task-first local Capability RAG, recovery coordination, and durable continuation claims. For every admitted child Plugin Bundle, whether Host-only or Host+Client, the Center stages and pins exact archives and delegates package membership changes to the official `dsh plugin --profile` CLI; only the official Profile package manager writes Profile dependencies, lock data, `node_modules`, Bundle membership, and package-membership Loader rows. Pure configuration replaces and verifies the exact managed row through the official Loader in the same Host process. MCP stdio connections mount the official MCP Client, Skills project through the official registry, and continuation uses the official Agent and Session services. No fork-only package or DSH Host PR is part of the design. See the [plugin-only architecture](docs/plugin-only-architecture.md) for the exact boundary.

Evidence is receipt-scoped. The following history belongs to stable `0.1.0` on official rc.2; it does not prove the new alpha line. The successful `0.1.0-rc.0` bootstrap records previous Center, CI, release-ready, and evidence-run inputs as `null`. The immutable rc.1 candidate has no successful composite receipt: its only post-publication attempt exposed the persistent catalog-cache rollover defect during a real same-Profile update and remains a `not-release-ready` incident. Recovery rc.2 updated directly from rc.0's last successful receipt, retained and migrated the same Center root through packaged `r9` to deployed `r10`, bound that rc.1 incident, and produced the successful predecessor receipt used by stable. Stable packaged `r10` and committed its signed `r11` successor. Replay substitutes only the model response edge while the official Agent, Session, Tool dispatch, Center-managed Skill, continuation, and receipt path run normally. A live-provider run is an advisory compatibility smoke; it neither blocks P0 nor substitutes for a deterministic receipt.

Stable `v0.1.0` is proven historical evidence. Post-publication run `33130950000` completed successfully on protected `main` commit `6d95545652e15c57b9e13390095a7172e65034b3`; its Actions artifact digest is `sha256:7dbc3145d376f75ed4ff8763af46290f7daff5a0be9dcf446fd017f02a23c2c0`. The release-ready receipt digest is `sha256:cdc27dfcb5768b8fe14c082553b5120e98d050748015df0311d1e610edf27994`, and the public-catalog receipt digest is `sha256:4bb66be8eef541eaebde8e0ee56ad09225f6f288948365d08c00c9d3159ad700`. That catalog receipt binds public revision 11 to exact file SHA-256 `38a5414c2da581bf0014a2769c9842375b0d0822b77f89e5159b27b3042fc58e`. These receipts establish the stable Release, public catalog, runtime/update, and composite status for the official-rc.2 line only.

The public `main` branch is a moving development source, not a release coordinate or npm publication. The alpha manifest is publishable only so an exact reviewed artifact can eventually enter the public registry under the `next` tag; source state does not establish publication. The status of an npm package, GitHub Release, public Pages catalog, or completed CI lane is recorded only by the receipt for that exact version and must never be inferred from source files, workflows, repository settings, or local tests.

Release provenance is byte-oriented. Only the deterministic tarball, `SHA256SUMS`, and self-digested pack attestation uploaded by the exact `main`-push Node 22 CI job are eligible for release. The CI verifier binds the Actions archive digest, run id and attempt, exact three-entry ZIP payload, source commit, packed manifest, bundled pnpm tree, and tarball bytes; it permits only the fixed GitHub API download followed by one admitted GitHub Actions or Azure Blob storage redirect. Runtime, public-release, and composite receipts must all bind that same attested tarball. A receipt may rely on Release immutability or protected `v*` tags only when it records those controls for the exact run; repository policy does not substitute for the receipt of any concrete Release.

- [P0 product specification and acceptance path](docs/p0-product-spec.md)
- [P0 产品规格与验收路径](docs/p0-product-spec.zh.md)
- [Capability discovery and Extension Store research](docs/capability-rag-research.md)
- [能力发现与扩展商店研究](docs/capability-rag-research.zh.md)
- [Catalog discovery, admission, and signing](docs/catalog-operations.md)
- [目录发现、准入与签名](docs/catalog-operations.zh.md)
- [Ordinary-user registry installation and lifecycle acceptance](acceptance/ordinary-user/README.md)
- [普通用户注册表安装与完整生命周期验收](acceptance/ordinary-user/README.zh.md)
- [rc.2 signed offline Store acceptance](acceptance/store-only/README.md)
- [rc.2 签名离线商店验收](acceptance/store-only/README.zh.md)
- [full P0 acceptance on official rc.2](acceptance/full-p0/README.md)
- [基于官方 rc.2 的完整 P0 验收](acceptance/full-p0/README.zh.md)

The alpha compatibility target under verification is official `dsh-v0.1.2-alpha.1` at `cd5ef8148158c3a752a658978873241fdf8e2bbc`. The repository contains a source-checkpoint procedure that builds the official Client and Web artifacts before exercising the Host and browser, but no receipt currently binds a completed run to that source commit and Center artifact. The checkpoint therefore remains unproven development input. The official GitHub prerelease tag exists without assets, and npm does not publish `@deepseek-ai/dsh@0.1.2-alpha.1`. Stable Center `0.1.0` remains historical evidence scoped to immutable official `dsh-v0.1.1-rc.2` at `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

The required CI context `Alpha package contract checkpoint` aggregates source, build, test, and deterministic-package checks only; it does not establish compatibility with the official alpha runtime. Only a protected registry ordinary-user receipt can establish its covered production lane.

## Alpha evidence matrix

Status as of 2026-08-28 is evidence-scoped. `Pending`/RED means the required external receipt does not exist; source, workflow, fixture, local archive, or synthetic receipt availability does not change that status.

| Evidence item | Required evidence | Current state |
| --- | --- | --- |
| Stable `0.1.0` on official rc.2 | The version's exact historical release and composite receipts | Proven historical: successful run `33130950000`, artifact digest `sha256:7dbc3145…c2c0`, release-ready receipt `sha256:cdc27dfc…994`, and public-catalog receipt `sha256:4bb66be8…d700`. It does not prove any alpha coordinate or lane. |
| Official alpha source checkpoint | A protected-run receipt and artifact binding for the exact official source commit, Center artifact, Host, and browser run | Unproven development input; the procedure exists, but no completed protected run receipt is present. |
| Official DSH npm coordinate | Public immutable `@deepseek-ai/dsh@0.1.2-alpha.1` version and integrity | `Pending`/RED; npm returns no matching version, and the GitHub prerelease has no assets. |
| Center `0.2.0-alpha.0` bootstrap | Public immutable npm release plus separately authorized bootstrap and provenance evidence | `Pending`/RED; the package is absent from npm. |
| Center `0.2.0-alpha.1` under `@next` | Public immutable npm release, provenance, signature audit, and exact tag binding | `Pending`/RED; the package and tag are absent from npm. |
| Alpha catalog `r11→r12` | Receipt-authorized r11 alpha bootstrap; protected schema-2 lifecycle evidence for catalog time plus operation, journal, inventory, configuration, material, and owner state; reviewed signed r12 commit; Pages bytes; and runtime refresh receipt | r11 prerequisite proven: stable receipts authorize the exact public bytes, the alpha package now embeds the same r11, and the exact predecessor preflight passes. r12 lifecycle, admission, review, deployment, refresh, and registry proof remain `Pending`/RED. |
| Plugin lifecycle | Registry-installed alpha artifact on unmodified official DSH with typed lifecycle, recovery, and removal receipt | `Pending`/RED; no alpha production receipt exists. |
| MCP lifecycle | Signed alpha candidate, exact Host runtime configuration, connection/tool verification, recovery, and removal receipt | `Pending`/RED; no alpha production receipt exists. |
| Skill lifecycle | Protected receipt schema 3 from the real Playwright UI lifecycle and its Actions artifact binding | `Pending`/RED; the runner and schema checks exist, but registry and catalog prerequisites are missing. A future `laneStatus: "proven"` still leaves product `p0Status: "red"`. |
| Agent acquisition and composite P0 | Original-task continuation receipt cross-bound with the Plugin, MCP, and Skill receipts | `Pending`/RED; the required alpha inputs and composite receipt do not exist. |

## Ordinary-user alpha gate

The production command is direct and uses only the official DSH Plugin CLI and npm registry. It becomes usable only after the registry prerequisites in the matrix are published:

```sh
npm install --global pnpm@11.21.0 @deepseek-ai/dsh@0.1.2-alpha.1
pnpm --version
dsh plugin --profile web add dsh-plugin-extension-center@next --ignore-scripts --save-exact
dsh plugin --profile web list --depth 0
dsh --profile web --dump-config
dsh web
```

`pnpm run test:acceptance:ordinary-user` requires exact `pnpm@11.21.0`, installs exact official DSH and Center packages into isolated directories, resolves `@next` to immutable version and integrity, invokes the literal standard `dsh plugin ... add dsh-plugin-extension-center@next` command, re-resolves the tag to reject movement, verifies install, list, composed Bundle, `0.2.0-alpha.0`-to-newer update, real Host and browser Client, and uninstall, then verifies the independently installed official DSH package tree did not change. Those delivery checks cannot prove Extension Center management by themselves. Receipt schema 3 uses one real Playwright page to select the user scope, click the visible Review install control, edit the typed Skill form, review and approve each exact plan, and drive Configure, exact Update, both Uninstalls, committed Restore, and Purge through visible lifecycle controls. The runner observes the authenticated UI's mutation exchanges; its verification helper admits only catalog, inventory, configuration, operation, and receipt-verification reads. Each write binds its immutable plan, exact approval, terminal operation journal and receipt, artifact bytes, configuration revision, and owner state. Purge must remove managed bytes and rollback state while retaining one non-recoverable `candidateRef: null` history row that exposes Install again. A direct-RPC mutation fails immediately with `ORDINARY-USER-MANAGEMENT-DIRECT-MUTATION`; an incomplete accessible UI sequence fails with `ORDINARY-USER-MANAGEMENT-LIFECYCLE-MISSING`; an absent signed alpha pair records `ORDINARY-USER-MANAGEMENT-CANDIDATE-PENDING` and remains RED. A protected complete Skill run may report `laneStatus: "proven"`, but its product `p0Status` remains `red` until separate Plugin, MCP, and Agent acquisition/continuation evidence is cross-bound. The lane also rejects file paths, tarballs, URLs, mutable Git refs, source launchers in registry mode, missing previous releases, and unpublished packages. As of 2026-08-28 the default registry lane is `Pending`/RED because official DSH alpha, Center `0.2.0-alpha.0`, and Center `0.2.0-alpha.1` under `@next` are absent from npm; no local archive or source checkout is accepted as a substitute.

The first package requires a controlled `0.2.0-alpha.0` registry bootstrap after every official alpha dependency exists. The npm Trusted Publisher must then bind this repository's `npm-publish.yml` and protected `npm-alpha-publication` environment. Before the irreversible alpha.1 publish, the workflow downloads alpha.0, verifies its registry integrity, requires `next` to select alpha.0 while `latest` remains absent or stable, and installs it in an isolated project outside the repository workspace. It queries alpha.1 before publishing: a missing version is published once, the same already-published bytes skip publication and resume post-publication verification, and different bytes fail closed. The post-publication gate requires `latest` to remain unchanged and non-alpha, fetches the registry attestation bundle, binds its exact SHA-512 subject to this repository, protected-main workflow, commit, run, and attempt, and requires an independent npm installation to pass `npm audit signatures` with no invalid or missing entries. Install and audit network requests have explicit per-command and per-fetch timeouts with three admitted attempts; only registry/network and attestation-propagation failures retry, while invalid or missing signatures stop immediately. A deterministic secret-free receipt records the package integrity and tarball digests, provenance bundle digest, source and workflow identity, publication and verification attempts, exact npm version, and audit verdict beside the ordinary-user receipt in the publication artifact. Recovery of an already-published version admits only a prior attempt in the same GitHub Actions run lineage; a new dispatch cannot inherit that trusted-publication claim. The production ordinary-user lane is then bound to the same exact version and integrity; the workflow cannot bootstrap a missing npm package or turn a pending receipt green. Trusted-publishing OIDC does not authorize `npm dist-tag`, so if an already-published alpha.1 no longer owns `next`, an authorized maintainer must restore `next` interactively and rerun the same Actions run; the workflow never attempts to republish the immutable version.

The alpha policy admits only candidates whose signed compatibility evidence names exact DSH `0.1.2-alpha.1`. The packaged stable catalog remains readable for review, but its rc.2 candidates fail closed for mutation until separately tested alpha artifacts are signed into an alpha catalog. Full ordinary-user proof also needs a real immutable successor pair; a single Skill without a real update target cannot satisfy the receipt. A successful Center boot, visible Store card, or synthetic receipt fixture is not an extension-lifecycle receipt.

The protected alpha catalog path fixes that successor pair to the two exact `microsoft/skills` `wiki-page-writer` commits. Successful stable run `33130950000` proves the public r11 bytes and authorizes their promotion from the public predecessor into the alpha package bootstrap. The alpha package now embeds byte-exact r11, and `acceptance/alpha-catalog/preflight.mjs` passes its predecessor check. This closes only the r11 prerequisite. A separate lifecycle producer must still exercise its temporary, isolated signed r12 input on the unmodified official alpha source before the admission workflow can reproduce the same deterministic r12 and upload it for pull-request review. Its schema-2 receipt records the catalog observation time and binds each operation to operation, journal, inventory, managed, configuration, material, and owner-state evidence. The producer derives catalog time from the current TLS-protected GitHub HTTP `Date`, and admission reuses the receipt's observed and issued times instead of accepting dispatcher-supplied timestamps. These source controls do not prove that either protected alpha workflow ran. Neither workflow commits or deploys the document, and `tests/support/alpha-catalog.ts` is never a production input. The r12 lifecycle run, catalog signature proposal, reviewed commit, Pages deployment, runtime refresh, and registry ordinary-user receipt are all still `Pending`; see [catalog operations](docs/catalog-operations.md).

## Install published stable release `0.1.0`

The published `v0.1.0` GitHub Release and the coordinates below are covered by successful post-publication run `33130950000` and release-ready receipt `sha256:cdc27dfcb5768b8fe14c082553b5120e98d050748015df0311d1e610edf27994`. They belong only to the historical official-rc.2 line and do not establish alpha compatibility. Install from the immutable GitHub Release asset, not from a moving branch or development checkout. The official DSH Plugin CLI delegates Profile package management to pnpm, so `pnpm` must be available on `PATH`:

```sh
curl -fLO https://github.com/striveh/dsh-plugin-extension-center/releases/download/v0.1.0/dsh-plugin-extension-center-0.1.0.tgz
curl -fLO https://github.com/striveh/dsh-plugin-extension-center/releases/download/v0.1.0/SHA256SUMS
shasum -a 256 -c SHA256SUMS
dsh plugin --profile web add ./dsh-plugin-extension-center-0.1.0.tgz --ignore-scripts --save-exact
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

Use the public `main` branch for source review and development only. Pin an exact reviewed commit instead of a moving branch when exercising the alpha bundle against the exact official DSH source tag:

```sh
dsh plugin --profile web add github:striveh/dsh-plugin-extension-center#<reviewed-commit-sha>
dsh --profile web --dump-config
dsh web
```

The repository commits deterministic `lib/` artifacts and declares no package lifecycle script, so a GitHub install does not execute a project build. The Center itself must be installed, updated, downgraded, or removed externally through this official CLI; it never self-modifies while running. The successful `0.1.0-rc.0` bootstrap proves catalog `r8→r9`. The immutable rc.1 candidate deployed `r10` but failed its real rc.0-to-rc.1 same-Profile update before producing a composite receipt. Recovery rc.2 consumes rc.0 as the last successful predecessor, proves the retained r8 cache can migrate through packaged r9 to public r10, records rc.1 as a failed candidate, and supplies the stable promotion's successful predecessor receipt. Stable packages `r10` and commits signed `r11`; successful post-publication run `33130950000` and its exact receipts establish that historical Release and deployment.

For development and verification:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run verify:pack
pnpm run test:acceptance:store
node --test acceptance/ordinary-user/support.test.mjs
```

The historical official-rc.2 runner belongs to the exact stable `v0.1.0` source line. The current alpha checkout must not reuse that result. Its production gate is `pnpm run test:acceptance:ordinary-user`, which is expected to return `Pending`/RED until the exact public DSH package, both Center alpha packages, and the signed alpha catalog are available.

See [Contributing](CONTRIBUTING.md) for the evidence and release rules and [Security policy](SECURITY.md) for private vulnerability reporting.

## Live catalog refresh

`catalogTrustedUrl` accepts one exact canonical HTTPS URL and the Host accepts only a complete envelope verified by the package's fixed signing root. `catalogFetchTimeoutMs` bounds each fetch and `catalogRefreshIntervalMs` controls the optional background refresh. Startup, the authenticated `catalog/refresh` action, the Store, and task Capability RAG all use one admitted snapshot. Connection applies Host/Origin/Fetch-Site trust checks and an authority-bound browser-session cookie before RPC dispatch; the payload carries no transport authority or human identity. Store search text and task content never enter the request. On package update, the Center verifies the complete historical signed cache before atomically raising its anchor to the packaged bootstrap; a same-or-newer conflict, broken chain, signature drift, malformed file, or failed durable replacement aborts startup without exposing the historical prefix. Every durable cache read, comparison, and replacement is serialized across DSH processes by a Center-owned writer reservation; network access stays outside it, the writer re-reads the authoritative chain, and an older completion cannot replace a newer verified tip. SQLite releases the reservation after process death, while the next writer performs normal recovery without deleting user state. A failed or stale network refresh keeps only an unexpired verified bootstrap or last-good snapshot and reports `source`, `freshness`, `degradedReason`, and `lastRefreshAtMs`; an expired snapshot fails closed.

## Break-glass Center recovery

The source installs a dependency-free recovery CLI at `$DSH_HOME/extension-center/recovery/<package-version>/<platform>-<arch>/break-glass.mjs`. Recovery binding schema v5, with official-execution binding v2, pins that file and Center root plus the canonical Node executable, version, and digest; the POSIX supervisor; a private bundled `pnpm@11.21.0` package, registry SRI, complete tree, entrypoint, shim, and shell; and the exact official `0.1.2-alpha.1` package, built `lib/bin.js` entrypoint, and installed production-dependency closure. For an installed Profile, the Center strictly reads the exact pre-mutation `package.json`, `pnpm-lock.yaml`, `node_modules/.modules.yaml`, and referenced installed package manifests, then synthesizes an owner-only, content-addressed pnpm 11 abbreviated and full metadata-cache generation from those local facts. The bound generation identity covers the Profile digests, existing canonical store, generated files, pinned pnpm runtime, and cache manifest; every use re-verifies the manifest and file digests. Its binding is stored in the Plugin provider recovery snapshot, so normal rollback and standalone break-glass recovery verify and use the same generation. A missing, changed, symlinked, or mismatched cache fails before the next official CLI Profile write. Execution remains offline with lifecycle scripts disabled; this cache is not a network prewarm and makes no claim that unavailable package bytes can be fetched. Only a Profile with no lock and no `node_modules` installation uses a Center-private per-Profile store. A detached process-group supervisor terminates the complete mutation subtree after timeout or parent loss, including parent `SIGKILL`; its execution lease prevents stale-lock reclamation while the subtree remains live. This mutation and recovery path supports macOS and Linux and fails closed on Windows. Once provider apply begins, unavailable mutation recovery remains locked as `recovery-required` instead of becoming a failed receipt. Startup reads retired Center and owner sidecar state before owner initialization; a failed retired Plugin journal still referenced by either projection is quarantined and a missing exact target lock blocks writable activation. With DSH stopped, break-glass recovery verifies the journal-bound provider snapshot, invokes only the bound official CLI to restore the exact Profile before-state, verifies that result, and only then commits Center state. It never writes Profile dependencies, lock data, `node_modules`, Bundle membership, or Loader rows directly and never imports the broken Center runtime. A later official DSH boot must verify the selected Profile dependency, Loader contribution, and declared consumer before terminal recovery evidence is valid. The exact complete-lifecycle receipt records whether packed break-glass execution passed for a release artifact under review; source code alone makes no such claim.

## License

[MIT](LICENSE). DeepSeek Harness and DeepSeek names belong to their respective owners.
