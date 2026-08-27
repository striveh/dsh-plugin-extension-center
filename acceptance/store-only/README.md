# rc.2 signed offline Store acceptance

English | [中文](README.zh.md)

This is the implemented non-mutating Store inspection slice for [P0 Gate B](../../docs/p0-product-spec.md#gate-b--dual-discovery-and-authorization). It is a non-xfail outer black-box command. Passing it proves the packed rc.2 signed offline Store journey described below; the complete Plugin, MCP, Skill, Continuation, recovery, and task requirements are specified by the [full P0 acceptance](../full-p0/README.md).

## Exact target and delivery form

- Plugin form: independent installable Host+Client Bundle.
- Host package: exact `@deepseek-ai/dsh@0.1.1-rc.2`.
- Audited Host source: exact commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`dsh-v0.1.1-rc.2`).
- Product input: a fresh `pnpm pack` tarball from this repository, never `src/`, a sibling checkout, or a Vite development server.
- Runtime: empty temporary DSH and Agents homes, local tarball installation into the Web profile, real config composition, real Web boot, and headless Chromium.

## Run

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:acceptance:store
```

`pnpm test` builds the Host and lazy-CJS Client artifacts, verifies catalog signatures and fail-closed parsing, exercises the source UI state, validates the built Client ABI and disposal behavior, and verifies the deterministic runner helpers. `pnpm test:acceptance:store` must exit zero only when the final tarball supplies one first-level **Extensions** button, one named Store-default dialog, and the verified catalog journey without submitting a write request.

The browser lane requires the packaged Host to verify the Ed25519 bootstrap catalog and the Client to read it through the private loopback channel. It then verifies two pinned Plugin candidates, two pinned MCP server candidates, three pinned Skill candidates, local text search, type filtering, three-way comparison, and exact integrity/configuration/activation disclosures. Plugin and Skill display lifecycle-entry UI; the lane opens one named Skill plan draft, checks focus, and dismisses it without submitting authorization or mutation. It does not prove either entry can complete a lifecycle. Each exact MCP `candidateRef` must own its own disabled card entry, disabled detail entry, and five unavailable lifecycle disclosures until the Host is configured with one exact admitted runtime for that version; the receipt derives the two unavailable entries from those observed cards. It also requires one labelled tablist, four correctly associated tabs and panels, default Store selection, click and Arrow/Home/End navigation, focus containment that excludes hidden panels, Escape close and focus return, and Store-default reset after reopening.

The generic rc.2 Connection carrier uses HTTP POST for unary reads. From immediately before `page.goto` until Chromium context closure, the lane admits only exact, protocol-versioned `catalog/list`, `inventory/list`, fixed bootstrap-MCP `configuration/options` requests for `operationKind: install`, `operation/list`, `operation/receipts`, `approval/list`, and `task-attempt/list` envelopes on their matching `/dsh-extension-center/<method>` paths; every other Extension Center non-read request fails. The Center-owned state tree is hashed before navigation and again after context closure, so client-mount and delayed-close mutations cannot enter an unobserved baseline or tail. The runner creates and validates the product tarball before opening its rejecting proxy; from the official `dsh --version` check through official CLI installation, Profile composition, Web boot, and browser interaction, every proxy-aware Host request fails the lane. The acceptance Profile omits `catalogTrustedUrl` so this lane reads only the signed packaged bootstrap; the installable Bundle keeps its published online catalog default. Any acquisition intent or plan request, browser WebSocket frame, external browser request, mutable Center-managed state change, console warning/error, or secret-canary evidence also fails. The schema-5 receipt records the last execution phase and preserves a preceding failure when final evidence detects an additional violation. The original first red artifact set is preserved once at `.artifacts/acceptance/store-only-original-red/`; each current run writes its receipt, packed tarball, composed config, Host log, ARIA snapshot, Store screenshot, comparison screenshot, and detail screenshot under `.artifacts/acceptance/store-only/`.

## Current proof boundary

The passing receipt identifies its scope as `official-rc2-unmodified-host-offline-store-ui` and reports `p0Status: store-ui-smoke-proven`. Together, the focused tests and packed acceptance evidence prove packed-artifact loading on the exact isolated official Host package, Host signature verification, strict Client response validation, the local discovery journey above, one non-submitted lifecycle draft, and no observed Store-interaction mutation. This slice does not prove live catalog refresh, approval submission, managed lifecycle mutation, task-driven acquisition, provider E2E, recovery execution, original-task continuation, public release installation, or the complete accessibility matrix.

Network evidence combines browser routing with a proxy-aware Host ledger; it is not a kernel-level network jail for every possible third-party transport. The full isolated DSH home, Agents home, workspace, and Profile comparison starts after official onboarding and ends after context closure; a separate Center-owned state comparison starts before page navigation. Both exclude the already-installed immutable `node_modules` tree.
