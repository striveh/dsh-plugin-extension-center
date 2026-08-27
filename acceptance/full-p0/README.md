# Full P0 acceptance on official DSH rc.2

English | [中文](README.zh.md)

This directory defines the release acceptance requirements for the independent Extension Center. The complete lane installs the packed Center with the official CLI into an isolated, unmodified `@deepseek-ai/dsh@0.1.1-rc.2` environment and exercises the Plugin, MCP, Skill, and Continuation journeys through the real Host and Web Client. No P0 claim exists without one terminal passing lifecycle receipt and separate passing public-release, Pages, and CI receipts for the release under review.

## Exact target

- Center artifact: the exact deterministic tarball produced from committed `lib/` output with no package lifecycle script. For a release decision, it must be the tarball uploaded with `SHA256SUMS` and a self-digested attestation by the exact `main`-push Node 22 CI job.
- Host artifact: official `@deepseek-ai/dsh@0.1.1-rc.2`, audited at commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.
- Center installation: `dsh plugin --profile web add <packed-center-artifact>` through the published CLI.
- Child ownership: the Center owns exact staged and retained Plugin archives, plans, grants, journals, receipts, verification, recovery coordination, and continuation claims. For every admitted child Plugin Bundle, whether Host-only or Host+Client, the official Profile package manager alone owns dependencies, lock data, `node_modules`, Bundle membership, and resulting Loader rows; MCP desired state and Skill material remain Center-owned.
- Official observations: Loader and declared consumers, MCP Client handshake and Tool visibility, Skill registry visibility, and Agent/Session continuation dispatch.

The Center itself remains outside its management inventory. Its update, downgrade, and removal are performed only through the official `dsh plugin --profile web ...` commands.

## Run

```sh
node --test acceptance/full-p0/support.test.mjs
node --test acceptance/full-p0/receipt-binding.test.mjs
pnpm run test:acceptance:official-rc2
```

The runner must resolve the CLI and all Host packages from the isolated official rc.2 installation. It must reject a DSH source checkout, modified Host package, workspace import, unpacked Center source tree, or mock-only runtime as release evidence.

## Evidence classes

- `Lifecycle`: a terminal receipt from this complete runner covers browser authorization and mutation, typed Plugin/MCP/Skill operations, the controlled external-CLI ABA ordering, packed break-glass recovery, and original-task continuation on the exact unmodified official rc.2 artifact.
- `Bootstrap release`: rc.0 records the previous Center artifact, previous CI receipt, previous release-ready receipt, and previous evidence run as `null`. Its packaged signed catalog revision `rN` must still refresh from Pages to the exact committed and signed adjacent successor `rN+1`, in addition to public GitHub Release installation, exact-commit Ubuntu/macOS CI, and deterministic-pack attestation verification.
- `Update release`: every later prerelease or stable release must prove a distinct previous-to-current Center artifact update and bind the exact successful post-publication receipt from the previous release. The previous receipt's deployed `rN` catalog must be the current artifact's packaged bootstrap, while the current Pages deployment must be the signed adjacent successor `rN+1`.
- `External`: Release, Pages, and CI status comes only from the generated receipts for the exact published commit and assets. Repository settings, source files, configured workflows, and local test output are inputs, not publication evidence.
- `Advisory`: a live-provider compatibility smoke does not block P0 and cannot replace the deterministic keyless Agent receipt.

## Required journey

One complete receipt must bind the exact Center tarball, official Host package identity, catalog revision, isolated state roots, browser origin, plan digests, operation journals, and terminal evidence. The release lane must prove:

1. Store search and task-driven Capability RAG read the same verified signed catalog and produce candidate-bound immutable plans.
2. Every mutation waits for an unexpired single-use loopback human grant; model-facing input cannot contain a package name, URL, shell command, credential, or approval.
3. A managed Plugin progresses through v1 install, required Host restart, same-Host Loader configuration, v2 update and restart, declared-consumer verification, rollback to a retained version, uninstall, and break-glass recovery. The Center stages and pins exact archives, but every admitted child Plugin Bundle Profile membership change runs through the official `dsh plugin --profile` CLI; pure configuration uses the official Loader API. The Center never writes Profile dependencies, lock data, `node_modules`, Bundle membership, or Loader rows directly.
4. A managed MCP connection progresses through configure, enable, handshake and Tool visibility, update, disable, restore, remove, and purge using a Center-owned desired-state record that mounts the official MCP Client.
5. A managed Skill progresses through install, configuration, registry visibility, update, disable, enable, restore, uninstall, and purge using Center-owned files and the official Skill registry.
6. A task-originated acquisition uses official DSH Replay to replace only the model response edge. The real official Agent, Session log, Tool dispatch, Center-managed Skill load and use, durable continuation claim, and receipt path must verify the acquired capability and dispatch one continuation to the original Session. Store-originated acquisition creates no continuation claim.
7. Injected pre-commit and post-commit faults preserve the journal chain and recover only the approved target: Center-owned MCP, Skill, or continuation state directly, and a child Plugin only through the official CLI. For an installed Profile, the Center must synthesize an owner-only, content-addressed pnpm 11 abbreviated and full metadata generation from the exact pre-mutation manifest, lock, modules metadata, installed manifests, and canonical store. Its provider recovery snapshot must bind the generation identity, manifest, and file digests so normal and break-glass paths re-verify the same local facts before the next Profile write. Execution stays offline with lifecycle scripts disabled; missing or changed material fails closed, and the cache does not contact a registry or promise unavailable bytes. A fresh Profile with neither lock nor `node_modules` installation uses the Center-private store. Normal and break-glass official CLI execution must publish and flush the Profile execution lease before `START`, bind the successful pipe-write callback through an exact durable dispatch marker, accept success only from one bounded private child outcome observed before a monotonic deadline, leave process-group termination with the live supervisor, keep either residual record fenced until the detached group is proven quiescent, and flush each ordered deletion before releasing the Profile lock. Break-glass schema v5 and official-execution binding v2 must also pin Node, the supervisor, private bundled pnpm, the official package and production closure, entrypoint, and `hostHome`; reject Profile execution controls; terminate orphan process groups; restore the exact Profile before-state through that CLI; verify it; and only then commit Center state. A partial observation never becomes a successful receipt. Windows mutation and recovery must fail closed.
8. Removing child Plugins and the Center with the official CLI leaves the official DSH source and package tree unchanged, records expected Profile package-manager changes, and retains only data the user explicitly chose to keep.
9. The exact rc.0 pnpm 11.7.0 version/SRI pair remains readable only as durable history. A consumed plan with only its pre-journal reservation, every nonterminal journal, a Plugin rollback awaiting finalization, and a failed Plugin journal still referenced by Center or owner sidecar state must retain its exact target lock, render a non-executable quarantine notice, and perform no provider, Loader, Node, pnpm, official CLI, journal, or owner-reconciliation mutation. Missing locks, unknown identities, mixed version/SRI pairs, and authorization-to-reservation or authorization-to-journal mismatches fail before writable Host activation. Once provider apply begins, unavailable mutation recovery must remain nonterminal and locked rather than issue a failed receipt.

## Evidence and failure rules

A complete release runner must start the real Web Host and browser Client, use loopback Connection RPC for authorization and mutation, independently recompute plan and receipt hashes, verify every journal link and terminal checkpoint, and inspect exact official Profile and Center-owned state after each operation. It must separate setup downloads from product-runtime network evidence and admit only explicitly pinned fixture origins during the measured journey. Provider credentials, endpoint overrides, telemetry, raw task text, and private catalog data must be absent from receipts and logs.

A missing official rc.2 service, early Host exit, stale catalog, rejected or replayed grant, owner-revision drift, mismatched material, missing or tampered metadata-cache generation, missing Loader/Tool/Skill/continuation evidence, recovery-binding drift, or teardown residue fails closed. The lane must also run the controlled separately invoked official-CLI A→B→A ordering and require `recovery-required` rather than false terminal success; a Center-only target lock is insufficient. This receipt is limited to the tested ordering and does not claim every possible process interleaving. A read-only Store pass is useful evidence but cannot satisfy this lane.

Any legacy fixture that expects `profileTransactions`, a local DSH HEAD, six upstream Host owners, or a Host PR is a rejection case only. It must never be reported as a prerequisite or a compatibility receipt.

## Composite release evidence

The final release decision composes independent receipts rather than widening any one runner:

1. The complete official-rc.2 lifecycle receipt binds the packed artifact, browser journey, child lifecycles, recovery, controlled ABA ordering, and keyless Agent continuation.
2. The runtime-release receipt proves Host boot, Client boot, RPC registration, exact official DSH tree preservation, and, when a previous artifact is supplied, a distinct previous-to-current Center update in one Profile.
3. The public-release receipt requires exactly the CI tarball, `SHA256SUMS`, and pack attestation as Release assets, downloads and byte-binds all three, verifies the explicit immutable Release and every asset with GitHub CLI, and then proves official-CLI install, optional update, and removal against the runtime receipt.
4. The public-catalog receipt derives its expected coordinates from the exact committed `catalog/public/plugins.json`, verifies those canonical bytes at the fixed Pages URL, and proves a non-degraded runtime refresh from the packaged bootstrap to its exact signed adjacent successor.
5. The CI receipt binds the declared Ubuntu and macOS jobs to the exact release commit and downloads the sole `main`-push Node 22 release-candidate artifact. It verifies the Actions archive digest, run id and attempt, a bounded path-safe ZIP with exactly the tarball, `SHA256SUMS`, and self-digested attestation, each entry's digest and size, the source commit, packed manifest, bundled pnpm tree, and tarball bytes. The downloader accepts only the fixed GitHub API URL followed by one admitted GitHub Actions or Azure Blob storage redirect. Runtime, public-release, and composite receipts cross-bind the current CI artifact; an update also requires the previous artifact's independent CI receipt, while a bootstrap records it as `null`.
6. The post-publication verifier always runs from the workflow-dispatch `github.sha` checked out on protected `main`, records the protected-ref assertion plus that post-publication run id and attempt, and binds the verifier commit to its own exact successful `main`-push CI receipt. The published target commit remains independent. A distinct verifier commit is admitted only to backfill the immutable `0.1.0-rc.0` bootstrap; rc.1 and stable require the target and verifier commit to be identical. For an update, the workflow downloads the exact previous release-ready receipt plus its original target and verifier CI receipt bytes from a caller-supplied successful run id, binds the Actions run path, head commit and attempt plus all three receipt digests, and then verifies the previous version, immutable Release, catalog transition, CI, and acceptance evidence. A regenerated CI receipt does not substitute for those prior bytes. The required sequence is rc.0 `r8→r9`, rc.1 with packaged `r9` and deployed `r10`, then stable directly from rc.1 with packaged `r10` and deployed `r11`.

Public Release, Pages, and completed CI claims require their corresponding generated receipts. Source files, configured workflows, repository settings, or local tests cannot satisfy those external observations.

## Proof boundary

A pass proves the exact packed Center on the exact official rc.2 artifact and the platforms named by the receipt. It does not prove arbitrary catalog safety, third-party service correctness, successful completion of every resumed task, a live provider, an untested process interleaving, an untested platform, or a different DSH release. Those claims require their own evidence.
