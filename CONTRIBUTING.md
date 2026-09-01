# Contributing

`dsh-plugin-extension-center` is an independent community plugin. Official DSH remains an unmodified external dependency.

## Development baseline

- Node.js `22.19.x` or a newer version admitted by `package.json`
- pnpm `11.21.0`
- official DSH `0.1.2-alpha.3`, tag `dsh-v0.1.2-alpha.3`, commit `dd6322d604e00eec1ba5e0c8541159906a21094a`

Run:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run verify:pack
pnpm exec playwright install chromium
pnpm run test:compat:latest
```

Build artifacts under `lib/` are part of the GitHub distribution and must change with source. Do not add `prepare`, `preinstall`, `install`, or `postinstall`; users must not have to authorize package code execution during installation.

## Product and security invariants

- Store browsing and task-driven discovery share one admitted signed catalog, policy evaluator, immutable-plan format, authorization flow, operation journal, verification, receipt, recovery coordination, and continuation path.
- Discovery sources produce leads, not install authority. A model cannot supply a package, URL, command, credential, redirect, or approval.
- Plugin, MCP, and Skill lifecycle states remain type-specific. Package presence, configuration, activation, runtime health, Tool visibility, task success, and recovery are separate facts.
- Every mutation requires an exact, unexpired, single-use human grant bound to a plan digest and inventory revision.
- Child Plugin Profile membership changes run only through the official `dsh plugin --profile` CLI. The Center never writes Profile dependencies, lock data, `node_modules`, Bundle membership, or Loader rows directly.
- MCP, Skill, Agent, Session, and persistence integration uses the corresponding official DSH services.
- Logs, journals, receipts, UI evidence, fixtures, and issues exclude credentials, task text, private catalog rows, cookies, authorization headers, and provider payloads.
- Recovery verifies its bound Center state, Node, supervisor, bundled pnpm, official DSH package tree, Profile before-state, archive, journal, and provider snapshot before using the official CLI. Drift fails closed.
- The signed revision 11 bootstrap is immutable historical rc.2 data. Do not relabel or re-sign it. New alpha.3 candidate claims require a reviewed signed admission.

## Change evidence

Pull requests state the user-visible result, affected extension kinds and lifecycle actions, authority and recovery impact, sensitive-data impact, exact DSH target, commands actually run, and anything still unverified. Product-visible changes include the owning Host and Client tests plus the packed journey that reaches the changed behavior.

The current completion gate is compatibility with the exact latest reviewed official DSH using a deterministic GitHub-hosted tarball and the ordinary official Plugin CLI. Publishing this plugin to npm is not required. Do not publish it to the `@deepseek-ai` scope.

The public catalog is a separate signed artifact. Discovery produces a bounded lead report. Admission requires reviewed immutable coordinates, external signing material, an adjacent revision, and a separately reviewed commit; Pages deployment cannot sign or alter the catalog.
