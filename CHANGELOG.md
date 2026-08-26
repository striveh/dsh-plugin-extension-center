# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and stable releases will use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial public development source for the independent DeepSeek Harness Unified Extension Center.
- A signed offline Store, strict live signed-catalog refresh, lead-only community discovery pipeline, and local task-first Capability RAG.
- Host-owned immutable plans, loopback human approval, per-target journals, secret-free receipts, recovery, and durable original-task continuation binding.
- Typed Plugin, MCP, and Skill providers with distinct lifecycle and verification semantics.
- Store, Installed, Updates, and Activity & Recovery Web surfaces with explicit unavailable, unverified, and recovery states.
- Packed rc.2 read-only Store acceptance, exact rc.2 Host-owner negative acceptance, and a separate local-DSH-HEAD lifecycle lane.

### Fixed

- Bind local-HEAD Profile installation and standalone break-glass restore to deterministic caller-owned mutation identities required by the writable Host.
- Resolve the exact Host restore receipt before break-glass selector checks, so retry after lost output or caller death cannot publish a second Profile revision.
- Accept the exact monotonic boot acknowledgement of a committed restore receipt while rejecting unrelated current-Profile drift.
- Pin the canonical Host home in every recovery binding and ignore ambient `DSH_HOME` during break-glass Host calls, preventing recovery against a different Profile store.
- Activate writable management only after one exact generation of all six Host owners completes recovery; owner replacement or loss now aborts that generation's setup and RPC work, withdraws writes, awaits tracked quiescence and reverse disposal, and only then permits a replacement generation while preserving read-only Store RPC.
- Bind the local-HEAD lane to format-v2 source/runtime build evidence and reverify the unchanged build record after Web teardown.
- Independently recompute immutable plan, receipt, journal-chain, terminal checkpoint, and projection evidence so a fully rehashed but semantically inconsistent operation fails closed.
- Reject backward break-glass journal time and evidence on nonterminal events before any Host process is spawned.

### Release gates

- No stable version is released. Writable compatibility remains `TBD` until an exact published DSH release contains and passes the required Host owners.
- A deployed signed remote catalog, independent admission receipts, packed Plugin restart and break-glass recovery, live MCP, distinct Skill update, real-model continuation, platform coverage, and ordinary-user usability remain unproven.

[Unreleased]: https://github.com/striveh/dsh-plugin-extension-center/commits/main
