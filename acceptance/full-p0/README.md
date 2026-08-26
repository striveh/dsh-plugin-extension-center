# Full P0 Host Owner Acceptance Red

English | [中文](README.zh.md)

This directory owns the immutable published-Host negative lane on the path from the signed Store to writable P0. The runner installs the final Extension Center tarball into an isolated Web Profile on the exact current published Host, starts the real Web Host, reads the verified catalog through one generic Connection RPC, and checks all six required Host owners without issuing a write request.

## Exact target

- Extension form: the tarball produced by `pnpm pack`, installed as a Host+Web Client Bundle.
- Host package: exact `@deepseek-ai/dsh@0.1.1-rc.2` from this project's installed dependencies.
- Audited Host source: commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`dsh-v0.1.1-rc.2`).
- Required owners, in stable order: Profile transaction, dynamic MCP connection, durable continuation, Skill registry, Tool registry, and Loader observation.

The current Host is intentionally the negative compatibility baseline. Its first stable product failure is:

```text
P0-RED-HOST-PROFILE-TRANSACTION-OWNER-MISSING
```

## Run

```sh
node --test acceptance/full-p0/support.test.mjs
node acceptance/full-p0/host-owner-gate.mjs
DSH_LOCAL_HEAD_ROOT=../deepseek-harness pnpm run test:acceptance:local-head
```

The support suite must exit zero. `host-owner-gate.mjs` must currently exit non-zero with the stable failure above and write `.artifacts/acceptance/full-p0-host-owner-gate/receipt.json`. A missing tarball role, broken Host boot, malformed RPC response, external request, state mutation, or teardown failure is `invalid`, not the expected product Red.

## Read-only preflight

The packed artifact installation is isolated setup performed before observation begins. After the real Host reports readiness, the runner hashes mutable DSH home, Agents home, workspace, and Profile state while excluding dependency trees. It then sends exactly one request:

```text
POST /dsh-extension-center/catalog/list
method = catalog/list
payload = { "protocolVersion": 1 }
```

The correlated response must expose a verified signed catalog revision and the six owner booleans. The runner hashes the same state again and requires byte-identical mutable state. Provider credentials and endpoint overrides are removed, telemetry is disabled, and proxy-aware non-loopback Host traffic is recorded and rejected. No acquisition, intent, plan, confirmation, install, configure, update, uninstall, or restore method is sent.

## Proof boundary

A future pass proves only that the packed Extension Center can observe the six readiness gates on an exact Host artifact. Boolean presence is not owner behavior evidence and does not make the complete P0 green. Profile generation promotion/rollback, live MCP tool-generation ownership, durable single-use cross-restart continuation, lifecycle actions, task acquisition, recovery, package update/removal, and real-provider tasks require their own Acceptance lanes.

The final P0 compatibility claim must target an exact published DSH release that supplies and behaviorally proves all six owners. A moving branch or local Host checkout cannot replace that release lane.

## Local HEAD positive lane

`verify-local-head.mjs` is a separate development receipt, not a replacement for the immutable published-Host lane. It reads the configured DSH checkout without changing it, requires its built CLI and owner packages, records the exact commit plus a digest and count of dirty entries, rejects a packed Center that declares a package `bin`, installs the packed Center through the Profile transaction CLI into isolated DSH/Agents/home directories, and boots the real Web Host. It then probes all six owners and executes exact single-use Store preview, approval, lifecycle, receipt, and inventory checks for a pinned Skill through install, configure, disable, enable, uninstall, restore, a second uninstall required by purge, and purge. The lane checks independent inventory dimensions, invocation configuration, the real merged-registry winner, exact managed material, post-purge material absence, and all eight terminal receipts in durable operation inventory. The receipt also reports the exact number of successful stable gates and required-owner predicates. Missing build outputs, unavailable owners, rejected acquisition, non-committed receipts, or mismatched material fail closed and leave `.artifacts/acceptance/full-p0-local-head/receipt.json` plus sanitized logs.

The lane needs network access to the exact signed Skill artifact when it is absent from the isolated content-addressed cache. The signed catalog does not expose a second revision of that Skill, so update remains explicitly unproven here and is covered only by unit and fault lanes. The runner removes provider credentials and provider endpoint overrides, disables telemetry, and never starts a model task. A pass proves this one local Host checkout and packed artifact only; published installation, Plugin restart, a live preprovisioned MCP runtime, task continuation with a real model, provider E2E, and the platform matrix remain separate evidence.
