# Ordinary-user registry acceptance

This fail-closed lane verifies the delivery path an ordinary user receives from the official DSH Plugin CLI and one alpha Skill lifecycle through the real Extension Center UI. It does not accept a checkout, local archive, filesystem dependency, or downloaded GitHub Release tarball as production evidence. This lane cannot prove the unified product P0 by itself: Plugin, MCP, and Agent acquisition/continuation evidence remain separate mandatory inputs, so its product-level `p0Status` stays `red` even when its protected Skill `laneStatus` is `proven`.

The production default targets official DSH `0.1.2-alpha.1`, installs immutable bootstrap release `dsh-plugin-extension-center@0.2.0-alpha.0`, and resolves the public `@next` tag to an exact newer registry target before updating:

```sh
node acceptance/ordinary-user/run.mjs
```

Registry mode first requires official DSH, the exact previous Center version, and a strictly newer Center target to exist on `https://registry.npmjs.org/`. It resolves any caller-supplied tag such as `@next` to an exact version and integrity before mutation, installs official DSH into an isolated project, creates a fresh DSH home, and exercises these public commands:

```sh
dsh plugin --profile web add dsh-plugin-extension-center@0.2.0-alpha.0 --ignore-scripts --save-exact
dsh plugin --profile web list --depth 0
dsh --profile web --dump-config
dsh plugin --profile web add dsh-plugin-extension-center@next --ignore-scripts --save-exact
dsh plugin --profile web list --depth 0
dsh --profile web --dump-config
dsh web --no-open --port 0
dsh plugin --profile web remove dsh-plugin-extension-center
```

The second `plugin add` is the same mutable-tag command documented for users: the CLI delegates plugin verbs to pnpm and reconciles Bundle membership after each successful command. The lane resolves `@next` to one version and integrity immediately before the call, executes the literal `@next` spec, resolves it again immediately afterward, and refuses to pass if the tag moved. The installed dependency, lock integrity, Bundle layer, and package version must all change from the immutable previous release to those exact preflight bytes.

The browser check runs only after the update. It requires one loaded Extension Center Client entry and bundle request, the first-level `Extensions` button, the `Extension Store` dialog, its Store, Installed, Updates, and Activity & Recovery tabs, the Configuration filter, and the exact alpha candidate. The same Playwright page then selects the user scope, clicks Review install, edits the typed Skill form, reviews and approves each exact plan, and drives Configure, Update, both Uninstalls, Restore, and Purge from the visible lifecycle controls. Removal must clear the dependency, Bundle list entry, installed package, plugin list entry, and composed-config layer. The independently installed official DSH package tree must remain unchanged.

Receipt schema 3 requires the fixed signed, alpha-compatible `wiki-page-writer` successor pair to cross the real authenticated management surface in one live Host: catalog and inventory discovery; UI-driven Install; Configure with an observed `userInvocable` and configuration-revision change; exact-version Update with changed artifact coordinates and bytes; inventory verification after every write; Uninstall; committed Restore; a final Uninstall and Purge; and one final inventory read. The runner opens the exact token-bearing URL printed by official DSH, retains the resulting HttpOnly browser session, and requires missing and invalid sessions to return 401 and a wrong Origin to return 403. It observes the authenticated UI's `intent/preview`, exact `plan/decide`, and `lifecycle/request` exchanges instead of issuing those mutations through its verification helper; that helper admits only catalog, inventory, configuration, operation, and receipt-verification reads. Purge must leave no managed bytes or rollback state and must expose Install again. It deliberately retains one non-recoverable history row with `candidateRef: null`, `desired: removed`, `materialized: absent`, `effective: inactive`, and `agentVisibility: not-visible`; cleanup absence does not mean erasing lifecycle history. If the verified catalog lacks either exact artifact with compatibility evidence for DSH `0.1.2-alpha.1`, the lane records `ORDINARY-USER-MANAGEMENT-CANDIDATE-PENDING`, remains RED, and exits `2`. A direct authenticated RPC mutation fails immediately with `ORDINARY-USER-MANAGEMENT-DIRECT-MUTATION`; an incomplete accessible UI sequence fails with `ORDINARY-USER-MANAGEMENT-LIFECYCLE-MISSING`. The synthetic complete receipt in `support.test.mjs` tests only the receipt schema; it is not runtime or release evidence.

Until official DSH `0.1.2-alpha.1`, Center `0.2.0-alpha.0`, and a strictly newer Center target under `@next` are all published, the default exits `2` and writes a receipt with `status: "pending"`, `laneStatus: "red"`, and `p0Status: "red"`. Publication alone is insufficient: the verified catalog must also contain the exact alpha-compatible Skill successor pair. The runner requires exact `pnpm@11.21.0`, because the official DSH Plugin CLI delegates package mutations to `pnpm` on `PATH`. A missing predecessor, a target that still resolves to the predecessor, or missing signed alpha candidates cannot produce a proven lane. Missing publication or admission is never converted into a local rehearsal pass. A lifecycle or invalid-evidence failure exits `1`; a complete local registry run exits `0` with `laneStatus: "not-proven-local"`, while `laneStatus: "proven"` additionally requires the protected Actions provenance and artifact binding described below. Product P0 remains RED until separately attested Plugin, MCP, and Agent acquisition/continuation evidence is cross-bound with this Skill lane.

The protected publication workflow additionally supplies `--expected-center-target-version` and `--expected-center-target-integrity`. The runner requires both together and refuses the lifecycle unless both the pre-install and post-install resolutions of `@next` match those already verified publication bytes.

## Development source launcher

Development mode can run the same lifecycle against one exact official DSH source commit. The initial Center must be an exact registry version or immutable GitHub shorthand; the target must resolve to a distinct immutable artifact. GitHub shorthands end in a lowercase 40-character commit:

```sh
node acceptance/ordinary-user/run.mjs \
  --mode development \
  --dsh-version 0.1.2-alpha.1 \
  --dsh-source-root /absolute/path/to/deepseek-harness \
  --dsh-commit cd5ef8148158c3a752a658978873241fdf8e2bbc \
  --center-initial-spec github:striveh/dsh-plugin-extension-center#0123456789abcdef0123456789abcdef01234567 \
  --center-target-spec github:striveh/dsh-plugin-extension-center#89abcdef0123456789abcdef0123456789abcdef
```

A development run can record `laneStatus: "not-proven-development"` only after the same real management sequence completes against an exact official DSH source commit and immutable Center inputs. Its `p0Status` remains `red`. Missing alpha candidates remain Pending/RED. Even complete development evidence cannot substitute for publication and registry installation.

`--dsh-command` plus repeatable `--dsh-arg` is available for a preinstalled launcher. It also cannot produce production P0 proof because the runner cannot bind that executable to its registry installation.

## Receipt

The default receipt is `.artifacts/acceptance/ordinary-user/receipt.json`; `--receipt` selects another destination. The receipt contains only validated package and signed-catalog coordinates, candidate and artifact identities, ordered RPC method names, immutable plan and terminal receipt digests, owner-state projections, versions, registry integrity, booleans, counts, stable failure codes, an optional immutable source commit, and a canonical self-digest. Missing management fields default to non-proven values. Local paths, arbitrary environment values, subprocess output, URLs outside the fixed public registry, authorization data, cookies, and underlying error diagnostics are excluded and mechanically rejected before writing.

A local registry run can report `laneStatus: "not-proven-local"`, but only an exact protected-main `workflow_dispatch` from `ordinary-user.yml` or `npm-publish.yml` can report `laneStatus: "proven"`. That claim records the exact repository id, workflow file/ref, commit, run id, and attempt. The workflow uploads the primary receipt artifact, takes the upload service's archive SHA-256 and artifact id, and writes a second self-digested Actions evidence document that binds those coordinates to the receipt digest. `actions-evidence.mjs verify-actions` independently verifies the GitHub run JSON, artifact-list JSON, downloaded ZIP bytes, receipt, and evidence document; copying or recomputing a local JSON file is insufficient. The receipt's `productCoverage` keeps Plugin, MCP, and Agent acquisition/continuation as `pending`, so Actions provenance cannot promote the overall `p0Status` above `red`.

Run the pure input and receipt checks with:

```sh
node --test acceptance/ordinary-user/support.test.mjs
```

`.github/workflows/ordinary-user.yml` runs those deterministic checks for every push and pull request. Its manual protected-main job installs Chromium, runs only the audited default registry coordinates, and uploads the validated receipt plus its archive-binding evidence. The Skill lane cannot turn green until `laneStatus` is `proven`; `Pending` cannot be selected as a green outcome, and this job never claims the separate product P0 gate.
