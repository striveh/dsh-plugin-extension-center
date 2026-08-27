# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and stable releases will use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-rc.1] - 2026-08-28

### Changed

- Promote the exact deployed signed catalog revision 9 into the packaged offline bootstrap and commit its reviewed entry-preserving revision-10 successor without changing any admitted entry.

### Fixed

- Upgrade the private bundled recovery runtime from pnpm 11.7.0 to 11.21.0 and rebind its registry integrity, closing the high-severity `GHSA-qrv3-253h-g69c` path-traversal advisory before another candidate is published. Exact rc.0 records remain readable history, while unfinished operations and failed Plugin journals still referenced by durable owner state retain their target quarantine and never expose or execute the retired runtime. Provider apply ambiguity now remains nonterminal instead of issuing an unsafe failed receipt.
- Pass verifier flags directly through pnpm 11 in post-publication and catalog-discovery workflows so the strict CLI decoders receive no synthetic `--` argument.
- Keep the Profile lease durable through official CLI dispatch, a monotonic private child outcome, detached-process-group shutdown, and exact marker cleanup in both normal and standalone break-glass execution; the supervisor owns group termination through its hard-kill deadline, so resistant descendants cannot outlive it and the caller never signals a reaped group leader.
- Enforce the fixed rc.0 to rc.1 to stable promotion sequence and revalidate the embedded stage and artifact history of every previous release-ready receipt.
- Read the official CLI's captured `--dump-config` stdout when verifying an installed Center Profile, so post-publication runtime acceptance reaches the Host, Client, removal, and composite receipt gates instead of failing on the command-result wrapper.
- Invoke official Plugin CLI removal with the exact rc.2 argument list, omitting the add-only pnpm `--ignore-scripts` option that `pnpm remove` rejects.
- Reuse the P0 Profile-removal surface audit in release verification, preserving exact manifest, lock, and composed-config restoration while admitting only declared package-manager internals and rejecting residual Center resolution links.
- Load each Release artifact's manifest authority from its own exact source commit, so rc.0 backfill and later update verification do not compare historical packages with the protected-main verifier manifest.
- Give the four subprocess-heavy standalone recovery tests the same explicit 15-second test budget as adjacent recovery cases, preventing loaded Node 22 CI from applying Vitest's unrelated five-second default.
- Bind public-release package-manager execution to the lock-installed `pnpm` dependency instead of the self-updated GitHub Action launcher, whose executable intentionally lives outside a package root.
- Resolve each Release tag through the bounded Git refs endpoint instead of the commit endpoint, whose rc.0 response includes a 300-file patch projection larger than the metadata limit.
- Validate GitHub's current signed Release v0.2 predicate, verified release-service identity, database id, tag-ref commit, statement, and exact asset subjects instead of the superseded v0.1 projection.
- Bind independent official DSH installs across receipts by exact package version, audited source, registry, and registry integrity while retaining each install tree digest as its own before/after mutation guard; pnpm-generated `.bin` shims embed the isolated install root and are not cross-install byte identities.

## [0.1.0-rc.0] - 2026-08-27

### Added

- Initial public development source for the independent DeepSeek Harness Unified Extension Center.
- A signed offline Store, strict live signed-catalog refresh, lead-only community discovery pipeline, and local task-first Capability RAG.
- Center-owned discovery, admission, immutable plans, loopback human approval, per-target journals, secret-free receipts, recovery coordination, and durable original-task continuation binding.
- Typed Plugin, MCP, and Skill providers with distinct lifecycle and verification semantics.
- Store, Installed, Updates, and Activity & Recovery Web surfaces with explicit unavailable, unverified, and recovery states.
- Packed Store discovery and complete plugin-only release acceptance lanes for the unmodified official DSH rc.2 artifact.
- Center-staged and integrity-pinned Plugin archives delegated to the official Plugin CLI, MCP desired-state fibers over the official MCP Client, Skill projections through the official registry, and durable Continuation claims over official Agent and Session services.
- A keyless official DSH Replay acceptance path that replaces only model responses while exercising the real Agent, Session, Tool, Skill, continuation, and receipt path.
- Owner-only, content-addressed pnpm 11 metadata generations synthesized from exact installed-Profile pre-state and bound through Plugin provider recovery snapshots for both normal and break-glass offline execution.
- Exact `main`-push Node 22 deterministic tarball, `SHA256SUMS`, and self-digested attestation production, plus Actions artifact/run/attempt verification and runtime/public/composite receipt cross-binding.

### Changed

- Limit Plugin rollback points to absent state or an exact retained version; every admitted child Plugin Bundle, whether Host-only or Host+Client, changes its Profile only through the official `dsh plugin --profile` CLI.
- Bind every recovery operation with schema v5 and official-execution binding v2 to the canonical Center root, hash-pinned standalone executable, Node and supervisor, private bundled pnpm, journal chain, retained archives, fenced official Profile observation, and exact official rc.2 package tree, production closure, entrypoint, and `hostHome`.
- Restore and verify the exact child Plugin Profile before-state through the bound official CLI before committing Center state during break-glass recovery.
- Publish writable management only after the Center's Plugin, MCP, Skill, and Continuation engines recover their own state and the required official rc.2 extension points are observable.
- Require Plugin completion to cross a restart requirement whenever module caches prevent same-process proof, then verify the exact official Profile dependency, Loader contribution, and declared consumer.
- Independently recompute immutable plan, receipt, journal-chain, terminal checkpoint, and projection evidence so a fully rehashed but semantically inconsistent operation fails closed.
- Reject backward break-glass journal time and evidence on nonterminal events before any Center-owned state is restored.
- Reject every IPv4 and IPv6 literal in artifact initial and redirect URLs while keeping hostname resolution and DNS rebinding outside the claimed protection.
- Use one live catalog snapshot through plan consumption, then keep execution, rollback, restart settlement, receipt repair, and lock release independent of later catalog rollover or candidate removal.
- Synchronize parent directories after authoritative record deletion so a failed filesystem flush remains fenced for startup recovery instead of releasing a target lock.

### Release gates

- Every release remains conditional on exact packed-artifact lifecycle, browser, recovery, continuation, deterministic-pack, and platform receipts against the unmodified official DSH rc.2 artifact.
- `0.1.0-rc.0` is the bootstrap candidate and records previous Center, CI, release-ready, and evidence-run inputs as `null`; it does not claim an update from an earlier Center Release and proves only catalog `r8→r9`. rc.1 must bind rc.0's successful composite receipt, promote deployed `r9` into its packaged bootstrap, and deploy signed `r10`; stable must bind rc.1, promote `r10`, and deploy `r11`. Public Release, Pages, catalog-source, runtime, and composite claims require their own passing receipts. Live-provider execution is an advisory compatibility smoke rather than a release blocker. Source, workflows, repository policy, and local tests do not close those external claims.

[Unreleased]: https://github.com/striveh/dsh-plugin-extension-center/compare/v0.1.0-rc.1...HEAD
[0.1.0-rc.1]: https://github.com/striveh/dsh-plugin-extension-center/compare/v0.1.0-rc.0...v0.1.0-rc.1
[0.1.0-rc.0]: https://github.com/striveh/dsh-plugin-extension-center/releases/tag/v0.1.0-rc.0
