# Unified Extension Center P0 product specification

Status: extended product specification, 2026-09-01. The current completion gate is latest-official-DSH compatibility; writable child-extension lifecycle and public-release evidence below are future, non-blocking gates.

English | [中文](p0-product-spec.zh.md)

Compatibility target: the unmodified official DeepSeek Harness source tag `dsh-v0.1.2-alpha.3` at commit `dd6322d604e00eec1ba5e0c8541159906a21094a`. The Center is distributed as a deterministic GitHub-hosted tarball and installed with the standard official Plugin CLI; publishing the Center to npm is not required. Stable Center `0.1.0` evidence remains historical and scoped only to official DSH `0.1.1-rc.2`.

The Extension Center is an independently released DSH bundle. Its Host code, Web Client, admitted catalog, discovery, plans, grants, journals, receipts, verification, recovery coordination, and durable continuation claims all ship from this repository. Official DSH is not patched. The Center itself and every admitted child Plugin Bundle, whether Host-only or Host+Client, are installed, updated, downgraded, and removed only through the official `dsh plugin --profile <profile> ...` CLI. The Center may stage and retain exact archives but never writes Profile package-manager state directly. See the [plugin-only architecture](plugin-only-architecture.md) for the implementation boundary and [Capability RAG research](capability-rag-research.md) for the source evidence behind the discovery model.

The current completion gate installs the exact packed artifact with the standard official Plugin CLI, runs the real Host and Web Client Store path, removes it with the same CLI, and proves the official DSH package and isolated install trees are unchanged. The writable child-extension lifecycle, recovery, deterministic Agent continuation, public Release, and Pages deployment sections below remain the extended product roadmap and must not be inferred from that compatibility receipt. Historical stable evidence stays scoped to its recorded official DSH version.

## Problem

An ordinary DSH user currently encounters Plugin packages, MCP connections, and Skills through different discovery sources, configuration methods, lifecycle language, and evidence. A task may also fail because the Agent lacks a capability even though the user does not know which extension family or package could supply it.

The missing product is not a larger list of repositories. It is a trustworthy acquisition loop that can find a relevant capability, explain its source and authority, obtain exact authorization, manage it through its real lifecycle, verify that DSH can use it, recover from failure, and then continue the user's original task.

## Proposal

Ship one Extension Center with two equal entrances:

1. **Task-driven acquisition:** the Agent detects a capability gap, checks already-visible capabilities, retrieves an eligible catalog candidate locally, asks the Center to prepare one exact plan, waits for a separate human grant, verifies the acquired contribution, and continues the original Session.
2. **Extension Store:** the user browses, searches, filters, compares, installs, configures, updates, disables where meaningful, restores, uninstalls, and purges admitted extensions without entering model context.

Both entrances use the same signed catalog revision, eligibility policy, inventory facts, Center-owned plans, human authorization, journals, receipts, verification recipes, recovery coordination, and continuation claims. Physical execution remains type-specific: admitted child Plugin Bundle package membership changes use the official Plugin CLI, pure Plugin configuration uses the official Loader, MCP connections use the official MCP Client, and Skills use the official Skill registry.

P0 succeeds when a non-expert can answer five questions for every action:

- What capability was found, and from which admitted source?
- What code, process, network, instruction, credential, or data authority will change?
- What exact state will be created, replaced, disabled, restored, removed, or retained?
- What evidence proves that the selected DSH scope can use the result?
- How can the user recover if the Center or Web UI cannot load?

## Product and repository boundary

- The product lives only in this repository and is released as one packed Host+Web Client bundle.
- The compatibility target is exact official DSH `0.1.2-alpha.3`; acceptance installs the deterministic packed Center through the official CLI into an isolated official Host rather than a checkout or modified package.
- For every admitted child Plugin Bundle, the Center stages and pins exact archives and owns the operation evidence. Only the official Plugin CLI writes Profile dependencies, lock data, `node_modules`, Bundle membership, and package-membership Loader rows; pure configuration replaces the managed row through the official Loader. The Center never writes package-manager locations directly.
- Managed MCP connections are Center-owned desired-state records that mount the official MCP Client.
- Managed Skills are Center-owned files and records projected through the official Skill registry.
- Task continuation is a Center-owned durable single-use claim implemented with official Agent, Session, and persistence services.
- The Center never lists itself as a managed child and never self-updates or self-removes.
- Missing official extension points fail one action closed with a precise capability reason; they do not trigger a Host patch.

## Target user

The primary user understands outcomes such as “let the Agent query this service” or “add a code-review workflow” but should not need to know Profile package-manager state, Cordis Loader rows, MCP client composition, Skill registry precedence, or journal recovery. Advanced evidence remains inspectable without becoming the default path.

## Acquisition journeys

### Task-driven acquisition

1. Derive a local `CapabilityNeed` from the active task without copying raw task text into the catalog, journal, or receipt.
2. Search Tools and Skills visible to the exact Agent scope, then search Center-managed runtime evidence.
3. If the gap remains, query the local index of one verified catalog snapshot. Store queries, task text, workspace data, credentials, cookies, and Session ids never become catalog requests.
4. Return `use-existing`, `management-required`, `acquisition-candidate`, `choice-required`, `no-eligible-candidate`, `discovery-unavailable`, or `external-only`.
5. When deterministic evidence produces one material winner, the Agent may select it and initiate a plan request using only opaque ids. Otherwise it asks the user to choose among at most three eligible candidates.
6. The Host-side Center re-resolves the candidate, current inventory, target scope, policy, catalog revision, and integrity before minting a plan. Any supplied target key must equal the canonical candidate, profile, scope, and extension identity before managed state is read.
7. The user reviews that exact plan in an authenticated DSH Web browser session and decides once. The Agent cannot call the decision action.
8. The Center executes the approved typed operation and verifies the matching official observation. Every admitted child Plugin Bundle package membership change is delegated only to the exact official Plugin CLI action bound by the plan; pure configuration uses the plan-bound official Loader row replacement on the same Host process.
9. The Center consumes one task-bound continuation claim and dispatches one continuation to the original Session. A restart-required Plugin remains pending until a later official Host boot verifies the selected official Profile dependency and declared consumer.
10. Task completion is recorded only after the acquired capability is actually used and its task-level observable passes.

### User-directed Store

1. Open the first-level **Extensions** entry and see Store, Installed, Updates, Activity, and Recovery.
2. Search and filter one verified catalog by extension kind, capability, publisher, source class, platform, scope, authority, lifecycle completeness, and configuration readiness.
3. Compare no more than three candidates using catalog-authored normalized facts. Publisher prose and community text are escaped review data, never instructions.
4. Preview an exact action plan and its authority delta.
5. Decide once in the authenticated DSH Web Client.
6. Watch mutation, restart requirement, verification, and recovery state as distinct steps.
7. Inspect the content-addressed receipt and the exact runtime evidence.
8. Manage the result from Installed. Store-originated actions never create a task continuation claim.

## Discovery and source model

Discovery has two planes.

### Catalog ingestion

The project pipeline may discover leads from:

- the official MCP Registry and compatible opinionated subregistries;
- exact npm or GitHub releases that declare DSH Plugin compatibility;
- Agent Skills-compatible repositories and registries;
- maintainer submissions and user-submitted review requests;
- community issue, activity, maintenance, and incident signals.

An upstream listing, repository topic, popularity count, README, or Agent suggestion is only a lead. Admission resolves an exact immutable version, publisher and license, integrity, DSH compatibility, authority, dependencies, scripts, configuration path, lifecycle coverage, recovery material, and verification recipe. The pipeline then publishes an immutable revision that satisfies the packaged signature threshold. No single discovery source has install authority. The initial P0 root is explicitly one-of-one (`threshold: 1` with one key); multi-key threshold protection is a later root change, not a current claim.

### Runtime retrieval

The Store and Agent read only an unexpired admitted snapshot or an unexpired verified last-good snapshot. Runtime discovery never performs arbitrary Web search and immediately installs the result. An explicit user URL remains `external-only` until the normal ingestion and admission process produces a signed candidate.

The Agent receives a bounded retrieval result with closed enums, capability tags, opaque ids, pinned revisions, authority flags, and one catalog-authored factual summary. It does not receive arbitrary publisher instructions. This is Capability RAG: the model reasons over retrieved, source-backed facts instead of memorizing package names or inventing installation commands.

## Autonomy and authorization

| Action | P0 authority |
|---|---|
| Detect a capability gap | Agent autonomous |
| Inspect current capabilities and query the admitted snapshot | Agent autonomous, read-only |
| Select one candidate when policy and evidence produce one material winner | Agent autonomous |
| Initiate a plan request using opaque ids | Agent autonomous |
| Approve new code, process, network, instruction, credential, or data authority | Human only, one exact plan, one use |
| Supply a package name, URL, command, credential, or approval to the mutation tool | Forbidden |
| Execute an admitted lifecycle action after approval | Center-coordinated typed operation; every admitted child Plugin Bundle package membership change uses the official Plugin CLI, while pure configuration uses the official Loader |
| Verify visibility and continue the original task | Agent autonomous after exact evidence |
| Install directly from arbitrary Web or community results | Forbidden |
| Remember a broad grant for future extensions | Excluded from P0 |

Every writable action has its own immutable plan and single-use grant. Installation does not authorize later configuration, update, enable, disable, restore, uninstall, or purge. Repeated intent with the same target and desired state may be idempotent, but it still preserves the original plan and grant evidence.

## Unified inventory without flattened truth

One inventory row links catalog identity, managed target, exact scope, owner revision, source freshness, operation history, and recovery points. Its visible state is a projection of independent dimensions:

- material: absent, staged, selected version, retained versions, or drifted;
- configuration: missing, valid, invalid, credential-required, or external;
- activation: enabled, disabled, restart-required, or not applicable;
- runtime: unobserved, starting, healthy, degraded, failed, or unavailable;
- contribution: Loader consumer, MCP Tool set, Skill winner, or none;
- update: none, exact version available, blocked, or unknown;
- recovery: none, recoverable, recovering, recovered, or recovery-failed;
- task: not requested, waiting for approval, waiting for capability, resumed, used, or failed.

The UI never converts package presence or a durable record into a generic “installed and working” badge. Every status names the observation and its freshness.

## Type-specific lifecycle mapping

| Kind | Install and configure | Update | Disable/enable | Uninstall, restore, purge | Required verification |
|---|---|---|---|---|---|
| Plugin | Stage and verify an exact archive, then invoke official `dsh plugin --profile ... add` so the Profile package manager owns the installed dependency; apply later typed configuration by replacing the managed row through the official Loader | Invoke the official CLI with a distinct admitted archive and verify the new Profile dependency after restart | Not offered in P0 unless the admitted Plugin exposes a stable activation mechanism | Invoke the official CLI for remove or exact retained-version rollback; purge deletes only Center-retained archives through a separate plan | Archive digest, official Profile dependency and installed bytes, Loader contribution, a required Host restart after package membership changes, same-Host Loader verification after pure configuration, and one declared real consumer |
| MCP | Create a Center-owned desired-state record and mount the official MCP Client with admitted command, environment references, and scope | Replace the admitted connection spec with a revision fence | Dispose or remount only the Center-owned fiber | Remove, restore, or purge the owned record and material independently | MCP handshake, exact qualified Tool set, scope, and current desired/observed revision |
| Skill | Materialize Center-owned Skill content and register its summary, scope, and invocation flags through the official registry | Atomically select a newly admitted content revision | Change the Center-owned registry projection | Remove, restore, or purge owned content and registration independently | Exact registry winner, content revision, scope, and invocation flags |

Discovery, exact-version installation, configuration, update, verification, uninstallation, and failure recovery are mandatory admission fields for every one-click P0 candidate. Enable/disable appears only where the real lifecycle can prove it. Restore names an immutable rollback point; it is never an alias for enable.

## Plans, operations, and receipts

An immutable plan binds the protocol version, intent origin, catalog and inventory revisions, target kind and id, scope, operation, exact desired state, artifact integrity, authority before/after/delta, configuration references, verification recipe, restart behavior, rollback point, expiry, and canonical digest.

The Center reads one catalog snapshot while rechecking a plan. The live catalog and owner revisions remain mandatory through the single-use consumption decision. After consumption, the immutable plan, operation authorization, durable intent payload, journal, and provider snapshot are the provider execution and recovery authority; catalog rollover or candidate removal cannot block rollback. Terminal receipt repair and lock release use the consumed plan, authorization, and terminal journal even if a failed operation's intent is unavailable, while task-continuation bookkeeping retries separately from the intent payload. Plugin rollback completion orders exact restored-state verification, durable terminal receipt publication, transient absent-state proof removal, and target-lock release. Startup recovery retains the lock when provider proof is unavailable before receipt publication and completes proof cleanup or unlock from the durable receipt afterward.

The authenticated DSH Web Client shows the plan before it issues a candidate-bound decision. The request does not carry a secret grant and does not prove a human principal; Connection has already applied Host/Origin/Fetch-Site trust checks and browser-session cookie authentication. The Center rechecks plan expiry, exact digest, target, action, scope, inventory revision, and decision identity, then consumes the resulting operation authorization once. Denial and cancellation are terminal facts, not errors to retry silently.

Each target has one Center operation owner and monotonic revision. For `managedPlugins`, this ownership covers plans, journals, receipts, retained archives, recovery selection, and evidence; the official Profile package manager remains the physical Plugin owner:

- `managedPlugins`
- `managedMcpConnections`
- `managedSkills`
- `taskContinuations`

The operation journal is append-only and hash-linked. A terminal receipt binds the plan digest, grant evidence, catalog and owner revisions, provider snapshot before/after, verification observations, journal head, recovery executable identity, terminal status, and any retained rollback point. Receipts contain no credential values, raw task text, private catalog rows, cookies, authorization headers, or provider payloads.

Installation success, runtime visibility, and task success remain separate receipt facts.

## Continuation

A task resolver mints a secret-free opaque `continuationId` bound to the original Session, originating user-message reference, derived need digest, selected candidate, scope, catalog and inventory revisions, expiry, and cancellation/supersession fence. After approval it also binds the plan, operation, and expected runtime evidence without changing the id.

The Center consumes the claim only after the operation is committed, the exact contribution is visible to the original Agent scope, the source task is active, and the claim has not been replayed. Dispatch is at most once; task completion is not promised exactly once. Plugin restart keeps the claim durable until the next official Host boot re-establishes Center state and verifies the selected consumer.

## Recovery outside the Web UI

Every operation records an absent-state or managed-version rollback point before mutation. The package copies a dependency-free, hash-pinned recovery module to a versioned Center state directory. When the Center or Web cannot load, the user stops DSH and invokes that exact module with `node` and the Center operation id.

Recovery binding schema v5 contains official-execution binding v2 and pins the recovery bytes, canonical Center root, canonical Node executable/version/digest, process-group supervisor, private bundled `pnpm@11.21.0` SRI/tree/entrypoint/shim/POSIX shell, and the exact official DSH `0.1.2-alpha.3` package/entrypoint/installed production-dependency closure, `hostHome`, and timeout. Normal and standalone execution verify every pin, reject Profile package-manager execution controls, and use a minimal environment. For an installed Profile, the Center strictly parses the exact pre-mutation `package.json`, `pnpm-lock.yaml`, `node_modules/.modules.yaml`, and referenced installed package manifests, then synthesizes owner-only pnpm 11 abbreviated and full registry metadata into a content-addressed generation. Its bound identity covers the Profile digests, existing canonical store, generated files, cache manifest, and pinned pnpm runtime. The Plugin provider recovery snapshot carries the binding, so normal rollback and standalone break-glass use and re-verify the same generation. Missing, changed, symlinked, or mismatched cache material fails before the next official CLI Profile write. Execution remains offline with lifecycle scripts disabled; the generated metadata is not a network prewarm and cannot supply unavailable package bytes. Only a Profile with neither lock nor `node_modules` installation uses a Center-private per-Profile store. The supervisor terminates the mutation process group on timeout or parent loss, including parent `SIGKILL`; a live execution record blocks lease recovery until that group is gone. This mutation and recovery path fails closed on Windows. Recovery also verifies the journal chain, current pointer, plan evidence, provider snapshot, and retained archives. It can restore Center-owned MCP, Skill, and continuation state directly. When the Center or Host cannot start, an admitted child Plugin Bundle rollback invokes only the bound official Plugin CLI to restore the exact Profile before-state, verifies the result, and only then commits Center state. Provider apply is an ambiguity threshold: if mutation recovery cannot prove the result after dispatch begins, the operation remains `recovery-required` with its target lock. Exact rc.0 pnpm 11.7.0 version/SRI pairs are accepted only by durable readers. Unfinished history, including a consumed plan with only its pre-journal reservation, remains locked and shows a non-executable quarantine notice. Before owner initialization, a failed retired Plugin journal that entered apply with a provider snapshot is compared against the Center and raw owner sidecar projections; an exact durable operation reference is also quarantined and a missing exact lock blocks writable activation. Current execution, explicit recovery, owner reconciliation, and standalone break-glass all reject the retired pair before provider or process activity. Unknown and mixed pairs fail as corruption. Recovery never writes Profile dependencies, lock data, `node_modules`, Bundle membership, or Loader rows directly. The next normal official DSH boot verifies the selected Profile dependency and declared consumer before terminal recovery evidence is valid.

## Trust and security rules

- Catalog discovery produces leads; only threshold-signed admission produces eligible candidates.
- The catalog signing root is pinned by the Center release. Unknown/revoked keys, insufficient threshold, rollback, chain break, freeze, expiry, or tamper fail closed.
- Artifact integrity, publisher identity, compatibility, dependencies, scripts, authority, configuration, lifecycle completeness, and verification are reviewed independently.
- Package lifecycle scripts are rejected. No install step executes publisher-provided shell text.
- Center archive paths are canonical, no-follow, private, and atomically selected. A foreign or revision-drifted official Profile dependency blocks mutation.
- Credential values remain in the official/user-selected credential provider. Plans and receipts carry only references and authority facts.
- Artifact acquisition rejects all IPv4 and IPv6 literals in initial and redirect URLs. Hostnames, DNS changes, and MCP Tool results remain untrusted; the URL check does not resolve names and does not claim DNS-rebinding protection. Network authority is explicit and exact.
- Recovery and normal mutation share the same ownership manifest. They cannot write outside Center-owned roots and MCP/Skill registrations; every admitted child Plugin Bundle package membership change is performed only by the official Plugin CLI, while pure configuration uses the official Loader.

## Official DSH 0.1.2-alpha.3 extension points

The bundle consumes only public behavior exposed by exact official DSH `0.1.2-alpha.3`:

- the official `dsh plugin --profile` CLI for every admitted child Plugin Bundle package change;
- Cordis Loader observation and public configuration methods for verifying Profile-managed Plugin contributions;
- effect-scoped `ctx.tools` and `ctx.skills` registrations;
- `@deepseek-ai/dsh-mcp-client` for admitted MCP connection runtimes;
- official Agent, Session, and persistence services for continuation;
- the Connection-authenticated `@deepseek-ai/dsh-client-connection` browser RPC channel and the `dsh.client` Web bundle declaration; release acceptance uses the official Web Profile on its default loopback bind.

The Center's services and operation owners are private product internals, not new official DSH Service Definitions. Center-owned MCP and Skill contributions dispose with their owning fibers; every admitted child Plugin Bundle remains under the official Profile package manager until an approved official CLI action changes it.

## P0 exclusions

- Automatically approving or silently installing any new authority.
- Direct installation from model output, arbitrary Web search, a repository topic, or popularity ranking.
- Generic YAML, package, credential, or schema editing.
- Downloading or installing an arbitrary MCP server package. P0 manages the connection lifecycle over an exact Host-preprovisioned runtime whose executable path, digest, version, arguments, working directory, and descriptor match the packaged review record. The external runtime package and its dependency closure remain Host-owned.
- Pretending that all Plugins can be enabled or disabled without a real owned mechanism.
- Bypassing the official Plugin package manager, adopting a foreign Profile dependency, or merging unrelated files.
- Self-management by the running Center.
- Patching, copying, or replacing the official DSH Host or Web application.
- Treating legacy `profileTransactions`, local DSH HEAD, six upstream Host-owner, or Host PR fixtures as product prerequisites; they are rejection cases only.
- Claiming arbitrary third-party code is safe, or that successful acquisition guarantees task success.

## Extended acceptance roadmap

Gate A is the current compatibility completion path. Gates B through E are future product-lifecycle and public-release evidence; they are deliberately non-blocking for the current independent-plugin compatibility claim. Within the extended roadmap, later gates do not waive earlier failures.

### Gate A — exact artifact and official Host

1. Build from a clean reviewed commit and commit deterministic `lib/` output.
2. Pack twice and require identical bytes and SHA-256. Inspect every archive entry and reject lifecycle scripts or undeclared executables.
3. Bind the deterministic tarball and packed manifest to the exact source commit, runner digest, lockfile digest, and artifact SHA-256 in local compatibility evidence.
4. CI upload, download, archive-digest, and run-identity cross-binding are optional extended public-release provenance. They do not block the current compatibility gate.
5. Install the exact Center tarball through the official CLI into isolated DSH, Agents, workspace, and home directories using exact official `dsh@0.1.2-alpha.3` only; a Center npm coordinate is not required.
6. Record the official package identities and audited commit. Reject source checkouts, workspace imports, patched packages, adjacent repositories, and unpacked Center code.
7. Boot the real Host and browser Client through the published entry points.

### Gate B — dual discovery and authorization

1. Verify bootstrap and refreshed catalog signatures, threshold, revision chain, issue/expiry times, and last-good fallback.
2. Prove Store search and task Capability RAG return the same eligible candidate facts for the same need without sending query or task content to a remote origin.
3. Prove existing capability wins before acquisition, ambiguity asks for choice, and stale/incomplete observation cannot claim no candidate.
4. Prove model input contains only opaque acquisition ids and cannot call confirmation.
5. Prove grant denial, expiry, replay, wrong scope, wrong target, wrong revision, and plan drift fail closed before mutation.

### Gate C — complete managed lifecycles

Use pinned synthetic Plugin, MCP, and Skill fixtures with real official extension points:

1. Plugin: discover → v1 install → restart/consumer verification → same-Host configure/Loader verification → v2 update → restart/consumer verification → managed-version restore → uninstall → absent-state restore → final uninstall/purge.
2. MCP: discover → install/configure → enable → handshake/Tool verification → update → disable → restore → remove → purge.
3. Skill: discover → install/configure → registry verification → update → disable → enable → restore → uninstall → purge.
4. After every step, compare inventory projection, Center-owned archives and records, official Profile dependency and installed bytes, owner revision, Loader/fiber/registry observation, journal chain, receipt, and recovery point.
5. Prove an unrelated pre-existing path or owner blocks mutation and remains byte-identical.
6. Run the controlled external-CLI ABA scenario on the exact official Profile: after an approved Plugin operation reaches `restart-required`, bind replacement-Host reconciliation, perform A→B and B→A changes through separately invoked official CLI processes, then resume the Center operation. It must enter `recovery-required` rather than publish false success. The receipt proves this exact ordering, not every possible process interleaving.

### Gate D — recovery and original-task continuation

1. Inject faults before material selection, after selection but before runtime verification, after runtime verification but before receipt publication, during restart reconciliation, and during recovery.
2. Run the schema-v5 hash-pinned break-glass module with the Center or Host unable to start. Prove its official-execution binding v2 verifies Node, the supervisor, private bundled pnpm, and the bound official DSH `0.1.2-alpha.3` package tree, production closure, entrypoint, and `hostHome`; invokes the exact official Plugin CLI rollback to the admitted absent-state or retained-version before-state; verifies the Profile result before committing Center state; and fails on any binding, executable, journal, pointer, plan, Profile revision, or archive drift without writing Profile state directly.
3. Start a task through the official Agent and use official DSH Replay to force a deterministic capability gap and model tool-call sequence. Replay may replace only model responses; capability resolution, authenticated browser decision, operation execution, Session logging, Tool dispatch, acquired Skill use, continuation, and receipt evidence must use the real official paths. Prove one continuation reaches the original Session.
4. For Plugin, restart the official Host and prove the durable claim is consumed only after the selected consumer is visible.
5. Prove denial, cancellation, supersession, wrong Session, replay, failed verification, and Store-originated operations cannot dispatch continuation.
6. Use the acquired capability and separately record the task-level observable.

### Gate E — removal and release receipt

1. Remove every admitted child Plugin Bundle and the Center through the official CLI; remove MCP and Skill state through their Center-owned typed operations.
2. Prove the official DSH source and package tree remain unchanged. Record every expected Profile package-manager change and reject any direct Center write to Profile dependencies, lock data, `node_modules`, Bundle membership, or Loader rows.
3. Retain only user-approved recovery data and prove a clean reinstall can either recognize or explicitly discard it.
4. Bind artifact SHA-256, official Host package identities, catalog revision, platform, browser journey, operation receipts, recovery evidence, continuation evidence, test commands, logs, and remaining uncertainty into one sanitized release receipt.
5. Repeat the required artifact lane on every declared platform. A different DSH release needs a separate compatibility receipt.
6. Download the exact public Release asset, prove official-CLI install/update/remove with the runtime receipt, fetch the fixed Pages catalog URL and prove its exact signed revision refresh, and bind passing CI jobs to the exact release commit. The CI, runtime, public-release, and composite receipts must all cross-bind the same exact `main`-push Node 22 attested tarball. Repository Release immutability and protected `v*` tags prevent later mutation but do not prove an external item; each item requires its own passing receipt. The `0.1.0-rc.0` bootstrap records previous artifact, CI, release-ready, and evidence-run inputs as `null`. Every later release must bind a distinct last successful predecessor artifact and its CI receipt plus that predecessor's exact successful post-publication run; that receipt's deployed catalog must equal the current packaged bootstrap, and the new public catalog must be its exact signed adjacent successor. A published failed candidate is retained as terminal incident evidence and never substitutes for the successful predecessor.

## Focused verification

Unit and integration tests must cover at least:

- catalog canonicalization, signature threshold, rotation, rollback, freeze, expiry, last-good selection, and cross-process monotonic cache commits;
- Capability RAG retrieval, deterministic policy, ambiguity, external-only leads, and existing-first behavior;
- plan canonicalization, authority diff, grant binding, idempotency, revision fences, and per-target serialization;
- separate Plugin/MCP/Skill inventory projections and stale observation handling;
- Center archive, official Profile dependency and installed-byte, Loader, restart, MCP handshake/Tool, Skill registry, and continuation evidence codecs;
- journal hash chains, checkpoints, receipt binding, rollback selection, retained-version limits, and cleanup;
- official Web-Profile loopback binding; Host/Origin/Fetch-Site/media-type rejection; missing, expired, or wrong-authority browser cookies; replay, timeout, disconnect, cancellation, teardown, and sensitive-data redaction;
- Host and Client protocol compatibility against the packed artifact.

## Fault injection

At minimum, acceptance must reject or recover from:

- catalog tamper, unknown signer, insufficient threshold, rollback, expiry, refresh timeout, poisoned cache, out-of-order cross-process refresh, and writer-process crash;
- artifact hash mismatch, archive traversal, symlink escape, unexpected lifecycle script, missing dependency, and incompatible platform;
- concurrent plans, owner revision drift, target lock loss, the controlled separately invoked official-CLI ABA sequence, crash at every journal phase, partial pointer replacement, and disk-full simulation;
- official Plugin CLI add/update/remove failure, required restart not performed, missing declared consumer, MCP early exit or Tool drift, and Skill winner conflict;
- denial, grant replay, wrong origin/session/scope/target/revision, expired continuation, cancellation, supersession, and duplicate dispatch;
- recovery executable drift, wrong Center root, broken journal link, unknown current pointer, unrelated path collision, and cleanup failure.

## Release acceptance criteria

P0 is releasable only when all statements are true:

- One packed artifact installs and removes through the exact official DSH `0.1.2-alpha.3` CLI without modifying official DSH code.
- Store and Agent acquisition use one admitted catalog and one policy path.
- Discovery sources are visible, source facts are fresh, and leads cannot bypass admission.
- Plugin, MCP, and Skill each cover discovery, install, configure, exact update, runtime verification, uninstall, and recovery; enable/disable is truthful per kind.
- Every mutation has one exact human grant, immutable plan, revision fence, journal, receipt, and rollback point.
- Every admitted child Plugin Bundle package lifecycle uses Center-pinned archives and the official Plugin CLI; only the official Profile package manager writes dependencies, lock data, `node_modules`, Bundle membership, and package-membership Loader rows. Pure configuration replaces and verifies the exact managed row through the official Loader on the same Host process.
- Every installed-Profile Plugin mutation uses an owner-only, content-addressed pnpm 11 abbreviated and full metadata generation derived from the exact pre-state and bound through the provider recovery snapshot; normal and break-glass paths re-verify the same generation, remain offline with lifecycle scripts disabled, and fail before the next Profile write on missing or changed cache material. A fresh Profile with neither lock nor `node_modules` installation uses the Center-private store.
- MCP and Skill runtime evidence comes from the official MCP Client and Skill registry.
- A restart-required Plugin is not reported complete before a later boot verifies the declared consumer.
- One task-driven acquisition uses the keyless official Replay gate, resumes the original Session exactly once at dispatch level, and separately proves capability use through the real Agent, Session, Tool, Skill, continuation, and receipt path.
- Break-glass recovery works with the Center or Host unable to start, verifies its schema-v5 official-execution binding v2, restores the exact child Plugin Profile before-state through the official Plugin CLI before committing Center state, and never writes Profile state directly.
- A receipt proves that the controlled separately invoked official-CLI ABA sequence cannot publish false terminal success; a Center-only target lock is insufficient, and the claim does not extend to untested interleavings.
- The public Release contains exactly the deterministic tarball, `SHA256SUMS`, and pack attestation from the `main`-push Node 22 CI artifact with identical digest and size for every file. The public-release receipt binds the concrete immutable Release and three GitHub asset attestations. Runtime and composite receipts bind the current CI receipt; updates also bind the previous Release's exact CI receipt, while bootstrap records previous CI as `null`.
- Browser UI, Host RPC, provider behavior, packed artifact, public Release installation, public signed-catalog refresh, exact-commit CI, and declared-platform receipts are all present. Live-provider execution remains advisory and non-blocking.
- Logs and durable evidence contain no secrets, raw tasks, private catalog rows, authorization headers, or provider payloads.
- Any unavailable evidence is labelled `Pending`, `Unavailable`, or `Unresolved`; it is not inferred from unit tests.

## Risks

- **Catalog compromise:** reduce blast radius with threshold signatures, immutable revisions, short expiry, fixed trust roots, and independent admission evidence.
- **Prompt or description injection:** expose only normalized catalog facts to the Agent; render untrusted prose as escaped review data.
- **Lifecycle drift:** bind actions to owner revisions and verify official runtime observations after every mutation and restart.
- **Overlapping ownership:** fail closed on foreign or drifted official Profile dependencies, installed bytes, Loader contributions, registry winners, or Center archives.
- **External CLI concurrency:** the official DSH `0.1.2-alpha.3` CLI exposes no lock or compare-and-swap token to the Center. The controlled ABA lane proves one adversarial ordering fails safely; its receipt must not be generalized to every possible interleaving.
- **Restart ambiguity:** keep restart-required Plugin package operations and their continuation claims pending until the exact consumer is observed on a later boot; pure configuration completes only after same-Host Loader verification.
- **Recovery corruption:** pin the standalone executable and every journal/material digest; never depend on the failing runtime.
- **False task success:** keep acquisition, runtime visibility, capability use, and task outcome as separate evidence.
- **Host-version drift:** compatibility is exact-version evidence. No result from a patched or moving source tree broadens the official DSH `0.1.2-alpha.3` claim.
