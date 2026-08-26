# rc.2 signed offline Store acceptance

English | [中文](README.zh.md)

This is the implemented read-only discovery slice on the path to Acceptance Red B in the [P0 specification](../../docs/p0-product-spec.md#acceptance-red-b--user-directed-extension-store). It is a non-xfail outer black-box command. Passing it proves the rc.2 signed offline Store journey described below; it does not make Acceptance Red B or writable P0 green.

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

`pnpm test` builds the Host and lazy-CJS Client artifacts, verifies catalog signatures and fail-closed parsing, exercises the source UI state, validates the built Client ABI and disposal behavior, and verifies the deterministic runner helpers. `pnpm test:acceptance:store` must exit zero only when the final tarball supplies one first-level **Extensions** button, one named Store-default dialog, and the verified catalog journey.

The browser lane requires the packaged Host to verify the Ed25519 bootstrap catalog and the Client to read it through the private loopback channel. It then verifies exactly one pinned Plugin, MCP server, and Skill candidate, local text search, type filtering, three-way comparison, exact integrity/configuration/activation disclosures, and disabled per-candidate acquisition. It also requires one labelled tablist, four correctly associated tabs and panels, default Store selection, click and Arrow/Home/End navigation, focus containment that excludes hidden panels, Escape close and focus return, Store-default reset after reopening, `unavailable(host-capability)`, and native-disabled Install, Configure, Update, Uninstall, and Restore controls.

The generic rc.2 Connection carrier uses HTTP POST for unary reads. The lane therefore admits only exact, protocol-versioned `catalog/list`, `inventory/list`, fixed bootstrap-MCP `configuration/options`, `operation/list`, `operation/receipts`, `approval/list`, and `task-attempt/list` envelopes on their matching `/dsh-extension-center/<method>` paths; every other same-origin non-read request fails. Any acquisition intent or plan request, browser WebSocket frame, external browser request, proxy-aware Host request, mutable Host/Profile state change, console warning/error, or secret-canary evidence also fails. The original first red artifact set is preserved once at `.artifacts/acceptance/store-only-original-red/`; each current run writes its receipt, packed tarball, composed config, Host log, ARIA snapshot, Store screenshot, comparison screenshot, and detail screenshot under `.artifacts/acceptance/store-only/`.

## Current proof boundary

The passing receipt identifies its scope as `rc2-signed-offline-store-slice` and keeps `p0Status: not-proven`. Together, the focused tests and packed acceptance evidence prove packed-artifact loading on an unmodified published Host, Host signature verification, strict Client response validation, the local discovery journey above, and no observed Store-interaction mutation. The receipt alone covers the packed positive journey and interaction guardrails; the focused tests cover tamper, expiry, and malformed-response rejection. Neither evidence set implements or proves live catalog ingestion or refresh, normalized inventory, any lifecycle provider, task-driven acquisition, managed-record persistence, restore execution, real-provider behavior, release installation, or the complete accessibility matrix.

Network evidence combines browser routing with a proxy-aware Host ledger; it is not a kernel-level network jail for every possible third-party transport. Mutable-state comparison excludes the already-installed immutable `node_modules` tree and covers the isolated DSH home, Agents home, and Profile files outside that dependency tree.
