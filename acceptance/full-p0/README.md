# Extended candidate-lifecycle P0 acceptance on latest official DSH

English | [中文](README.zh.md)

This directory specifies the extended writable candidate-lifecycle receipt for the independent Extension Center. It is not the current latest-DSH compatibility gate.

## Current status

This extended lane remains `Pending`/RED because the immutable packaged bootstrap contains the previously admitted rc.2 candidates, while current policy correctly requires alpha.3 candidate evidence. Do not relabel or locally re-sign that historical catalog. `pnpm run test:compat:latest` runs the implemented packed-artifact, official-CLI, real Host+Client Store compatibility lane in [`../store-only`](../store-only/README.md); that receipt can pass independently of this future writable-candidate lane.

## Exact target

- Official Host: `@deepseek-ai/dsh@0.1.2-alpha.3` from `https://registry.npmjs.org/`.
- Audited source identity: tag `dsh-v0.1.2-alpha.3`, commit `dd6322d604e00eec1ba5e0c8541159906a21094a`.
- Center distribution: a local deterministic `.tgz` produced by `pnpm run verify:pack`. Publishing the Center to npm is not a prerequisite or a claimed result.
- Standard installation path: `dsh plugin --profile web add <absolute-packed-center-path> --ignore-scripts --save-exact`.
- Ownership: official DSH owns Profile dependencies, lock data, `node_modules`, Bundle membership, and Loader rows. The Center owns its catalog, plans, grants, journals, receipts, retained artifacts, MCP desired state, Skill material, recovery coordination, and continuation claims.

The Center does not manage its own installation. Users update, downgrade, or remove it only through the official `dsh plugin --profile web ...` command.

## Future run after alpha.3 candidate admission

```sh
node acceptance/full-p0/verify-latest-dsh.mjs
```

After every required candidate has protected, reviewed alpha.3 admission evidence, this runner creates an isolated official DSH installation, packs the current Center, installs it with the official CLI, starts the real Web Host and browser Client, runs the writable lifecycle journey, removes the Center with the official CLI, and writes:

```text
.artifacts/acceptance/full-p0-latest-dsh/receipt.json
```

It rejects a modified Host package, workspace import, unpacked Center source tree, mock-only runtime, moving package reference, inherited provider credential, or product-runtime network access outside the admitted fixture origins.

## Required journey

The terminal receipt binds the exact Center tarball, official DSH package identity and integrity, catalog revision, isolated state roots, plan digests, operation journals, and terminal receipts. It proves:

1. Store search and task-driven Capability RAG use the same verified signed catalog and create candidate-bound immutable plans.
2. Every mutation waits for an unexpired, single-use, loopback human grant.
3. A child Plugin completes install, configure, update, rollback, uninstall, restore, and purge; all Profile membership changes run through the official Plugin CLI.
4. An MCP connection completes configure, enable, handshake and Tool visibility, update, disable, restore, remove, and purge through the official MCP Client integration.
5. A Skill completes install, configure, registry visibility, update, disable, enable, restore, uninstall, and purge through the official Skill registry.
6. Task-originated acquisition replays only the model response edge while the real Agent, Session log, Tool dispatch, managed Skill, continuation claim, and exactly-once continuation path execute.
7. Fault injection, controlled external-CLI ABA, and packed break-glass recovery preserve journals and recover only the approved target.
8. Removing child Plugins and the Center through the official CLI leaves the official DSH package tree byte-for-byte unchanged outside declared Profile package-manager state.

## Proof boundary

A future pass sets `p0Status` to `latest-dsh-lifecycle-proven` and `releaseClaim` to `latest-official-dsh-compatible`. Until that receipt exists, no writable candidate-lifecycle claim is made. The receipt would prove the exact packed Center against the exact official DSH release and platform named by it; it would not prove a different DSH release, untested platforms, a distinct Center-version update, arbitrary third-party safety, every possible process interleaving, or live-provider behavior.
