# Capability discovery and Extension Store research

Status: product evidence baseline, 2026-08-25

English | [中文](capability-rag-research.zh.md)

This note records the external evidence used to design the Unified Extension Center. It separates source facts, synthesis, and product decisions. Unless a commit is pinned, linked sources were accessed on 2026-08-25 and may change; the product specification remains normative.

## Research question

How should DSH support both a user who intentionally browses an Extension Store and an Agent that discovers a missing Plugin, MCP server, or Skill while completing an existing task, without creating two management systems or turning the model into an unreviewed package installer?

## Evidence from current products and open ecosystems

| Source | Verified behavior | Product implication |
|---|---|---|
| [VS Code agent tools](https://code.visualstudio.com/docs/agents/concepts/tools) | The model autonomously selects among tools already available to the session. VS Code recommends narrowing the available set and separates tool availability from approval. | DSH should retrieve a small task-relevant capability set rather than put every catalog description in model context. |
| [VS Code approvals and permissions](https://code.visualstudio.com/docs/agents/run/approvals) | Tool calls can be approved once or with broader scopes; external results can require post-result review because they may contain prompt injection. Higher-autonomy modes carry explicit warnings. | A new extension is new code, process, network, or instruction authority. P0 uses one exact, one-shot human approval and treats retrieved prose as untrusted data. |
| [Claude Code plugin discovery](https://code.claude.com/docs/en/discover-plugins) and [plugin hints](https://code.claude.com/docs/en/plugin-hints) | Users browse and install marketplace plugins. Claude may suggest the matching LSP plugin or surface a CLI-emitted hint, but the product explicitly does not install that plugin automatically. Installed plugins can be reloaded in-session. | Task-triggered recommendation is useful, but selection, installation authority, and runtime activation are different states. DSH can let the Agent initiate an exact request while keeping confirmation outside the model. |
| [OpenClaw's ClawHub Skill at `935c555`](https://github.com/openclaw/openclaw/blob/935c555c98d6b38af76faa6a0b1370353d1828df/skills/clawhub/SKILL.md) | Its model-facing instructions say to search before declaring a requested capability unavailable, verify the selected third-party Skill, obtain user approval, install an exact version, and rely on a watcher to refresh Skills on the next agent turn. | This is the closest public precedent for the desired loop. DSH should preserve its existing-first, verify, human-grant, and next-turn pattern while moving mutation out of model-run commands. The Center owns the plan and evidence; every admitted child Plugin Bundle package membership change still uses the official Plugin CLI, while pure configuration uses the official Loader. |
| [OpenHands chat Skill installation](https://docs.openhands.dev/overview/skills/adding) | A user can supply a GitHub URL in `/add-skill`; the current official page says OpenHands fetches, writes, verifies, and makes the Skill immediately available. | In-chat acquisition is feasible, but user-supplied coordinates are not ordinary-user discovery. Because activation claims vary by product surface and release, DSH still verifies current-task visibility rather than trusting an install result. |
| [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference), [Cursor Agent Skills](https://prod.cursor.com/docs/skills), and [OpenHands Skills](https://docs.openhands.dev/overview/skills) | Installed Skills are advertised by summary and can be invoked by the agent when task context matches. OpenHands explicitly says a Skill does not grant permissions or install dependencies by itself. | Existing-capability matching comes first. Acquiring a missing Skill is a separate lifecycle operation, not an implication of model relevance. |
| [Agent Skills specification](https://agentskills.io/specification) | A Skill has bounded discovery metadata and progressively loaded instructions, references, scripts, and assets. | The retrieval index should use normalized summaries first and hydrate full candidate evidence only for the short list. Full Skill instructions are reviewed at planning, not used as search instructions. |
| [Cursor Plugins](https://prod.cursor.com/docs/plugins) | Plugins unify Skills and MCP servers in a management surface, while official and community discovery sources remain visibly distinct. | The center can unify navigation and acquisition without pretending Plugin, MCP, and Skill have the same runtime owner or trust level. |
| [OpenAI Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256-plugins-in-codex/) | The Plugin Directory is the primary discovery surface; installation and use still depend on plan, role, app setup, action controls, and underlying source-system permissions. | “Found” is not “eligible,” “installed,” “authorized,” or “usable.” Candidate, policy, credential, runtime, and task evidence stay separate. |
| [DSH Capability Resolver `v0.1.0`](https://github.com/striveh/dsh-capability-resolver/tree/b2676e4fb311a0df2eaa17bdce2d6929317c1ea0) and the [community catalog](https://awesome-dsh-plugin.com/plugins.json) | This unofficial DSH plugin fetches one fixed public catalog, keeps the user's task on the local Host, and ranks normalized candidates locally. Its declared scope is read-only: it does not install, enable, disable, update, or execute a candidate. | Reuse its need-first discovery and safe model projection as prototype evidence. The independent Extension Center must own admission, the Store, plans, grants, evidence, recovery coordination, and continuation without becoming a second physical Plugin package manager. |
| [Official MCP Registry announcement](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/), [publishing guide](https://modelcontextprotocol.io/registry/quickstart), and [terms](https://modelcontextprotocol.io/registry/terms-of-service) | The Registry is a preview metadata catalog, not an artifact host. It is designed as an upstream source for opinionated public or private subregistries, and it gives no safety, accuracy, or availability warranty. | The MCP Registry is an ingestion source, not writable truth. The Extension Center must materialize a DSH-specific admitted snapshot with exact artifact coordinates, compatibility, authority, and verification data. |

**Synthesis from the sampled products:** user-directed directories are a proven acquisition path, and agents increasingly select capabilities that are already present. What remains uncommon is a task-contextual missing-capability flow that shares the same catalog, policy, lifecycle state, and receipts with the Store and then proves continuation. P0 therefore keeps the Extension Store and Agent-assisted acquisition as equal entrances rather than replacing either one.

## Community signals

These issue reports and discussions are qualitative signals, not prevalence measurements.

| Signal | What was reported | Design response |
|---|---|---|
| [Codex issue #34321](https://github.com/openai/codex/issues/34321) | A plugin could be reported installed and enabled while its cached Skill payload was missing and invisible to the model; an in-session reinstall did not retroactively change the rendered prompt. | Never use one `installed` badge. Verify material, owner registration, current Agent visibility, and whether a new step/session is required. |
| [Claude Code issue #43745](https://github.com/anthropics/claude-code/issues/43745) | Custom marketplace Installed and Discover views could disagree, and updates could remain stale in cache. | Bind every observation to source revision and freshness; update and inventory use the same authoritative owner evidence. |
| [Claude Code issue #81551](https://github.com/anthropics/claude-code/issues/81551) | A reload summary could report zero Skills even though invocation worked, encouraging unnecessary reinstall attempts. | Status copy names the exact observation and never turns an incomplete counter into a health verdict. |
| [VS Code issue #311166](https://github.com/microsoft/vscode/issues/311166) | A community proposal reports that Skills cannot formally declare required Tools, MCP servers, or hooks, so missing dependencies can appear as silent partial behavior. | Catalog admission and runtime verification must include capability dependencies; a Skill file being present is insufficient. |
| [OpenHands docs-update issue #646](https://github.com/OpenHands/docs/issues/646) | The issue describes an Agent Canvas v1.6 flow that asked users to start a new conversation after adding a Skill because that surface loaded Skills once per conversation. This conflicts with the current official Adding Skills page's “immediately available” claim. | Treat activation timing as surface- and release-specific community evidence, not current product truth. DSH accepts neither claim without owner visibility and continuation tests. |
| [Claude Code skills discussion](https://www.reddit.com/r/ClaudeAI/comments/1vqv6pp/how_are_you_guys_discovering_new_claude_skills/) | Participants described finding Skills randomly across GitHub and Reddit and wanting curation that filters noise. | Community discovery can enrich a lead queue, but popularity and anecdotes are ranking signals only, never admission or safety evidence. |

## Product decision: dual-entry source model

Discovery has two planes.

### Runtime retrieval plane

1. **Current Agent scope:** qualified Tool schemas and the official merged Skill catalog for the exact Session, working directory, and Agent scope. The task path checks this first; the Store labels matching items installed or visible.
2. **Managed runtime evidence:** Center-owned operation inventory plus official Profile package-manager, Skill, MCP Tool, Loader, and declared-consumer observations.
3. **Admitted catalog snapshot:** a versioned snapshot and offline bootstrap verified against the Bundle-pinned catalog root, then matched locally by both Agent and Store. Raw task text, Store queries, Session identifiers, credentials, cookies, and workspace content never enter a catalog request.
4. **External lead:** only an explicit user-supplied URL is fetched at runtime after the user asks to review it, and it remains `external-only`. Arbitrary Web/community discovery belongs to catalog ingestion, not task or Store retrieval.

The trust root names the catalog, trusted key ids and threshold, minimum revision, and maximum age. A canonical snapshot carries a monotonic revision, issue/expiry times, entries and previous-revision digests, key ids, and signatures. Unknown or revoked keys, insufficient threshold, tamper, rollback, broken chain, or freeze fail closed before indexing; root rotation enters only through a newer integrity-pinned Extension Center release.

### Catalog ingestion plane

The independent project periodically discovers public candidates from the Official MCP Registry, exact npm/GitHub release metadata for DSH-compatible Plugins, Agent Skills-compatible repositories and registries, maintainer submissions, and community issue/activity signals. Ingestion normalizes claims, resolves exact versions or content revisions, records licenses and publishers, scans manifests and lifecycle scripts, derives authority, runs compatibility and verification fixtures, and publishes a signed immutable catalog revision. Community text is evidence for curation, never executable installation guidance.

The catalog is therefore an opinionated DSH subregistry. An upstream listing means “candidate lead”; catalog admission means “eligible for the exact lifecycle stated by this revision”; neither means “safe.”

## Product decision: Capability RAG and Store retrieval

The Agent receives a narrow model-facing resolver, not the raw catalog. The Store renders the same normalized index as structured user-facing search and comparison without sending it through the model.

1. The Agent derives a local `CapabilityNeed` from the user's existing task: intended outcome, input/output modality, target scope, required data access, platform constraints, and maximum acceptable authority. The raw task is not duplicated into an operation journal.
2. The resolver searches current Agent-visible Tools and Skills first.
3. If a gap remains, the resolver searches a local structured and semantic index over normalized catalog fields. Search considers outcome tags, provided Tools/Skills, compatibility, configuration readiness, authority, source freshness, and lifecycle completeness.
4. It hydrates only the top eligible normalized fields: closed enums, capability tags, opaque ids, pinned revisions, authority flags, and one bounded catalog-authored factual summary. Publisher README text, errors, shell strings, and community posts never become model instructions and appear only as escaped browser review data.
5. Deterministic policy filters run before model ranking. A candidate cannot be proposed for one-click acquisition unless its exact revision, integrity, target DSH range, authority, configuration path, verification recipe, and full managed lifecycle are admitted.
6. The result is one of `use-existing`, `management-required`, `acquisition-candidate`, `choice-required`, `no-eligible-candidate`, `discovery-unavailable`, or `external-only`. `management-required` is a terminal handoff to one exact human-managed lifecycle action and creates no acquisition intent; `no-eligible-candidate` is valid only for a fresh, complete observation.

This is retrieval-augmented capability resolution: the model reasons over retrieved, source-backed capability facts rather than relying on memorized package names or inventing install commands.

The Store uses the same deterministic eligibility filter but lets the user browse all admitted matches, filter, and compare up to three candidates. User choice may resolve a trade-off but cannot override trust, compatibility, lifecycle, integrity, or authority policy. Both entrances use the same Host-side Center intent schema, authorization, journal, receipt, verification, and recovery coordination. Only when candidate, scope, operation, and desired state match must their canonical mutation and authority core match; origin, task-only continuation, idempotency, and plan identity remain per request. Manual MCP Install and task-composed Install-and-Enable share admission and Center-owned MCP state without pretending to be the same intent or plan; admitted child Plugin Bundle package membership changes use the official Plugin CLI, while pure configuration uses the official Loader.

## Product decision: autonomy boundary

| Agent action | P0 |
|---|---|
| Detect that the current task lacks a capability | Autonomous |
| Inspect capabilities visible to the current Agent | Autonomous, read-only |
| Query the fixed catalog snapshot and rank eligible candidates | Autonomous, read-only |
| Select one candidate when policy and evidence produce one material winner | Autonomous |
| Ask the Host to prepare an exact acquisition plan by opaque identifiers | Autonomous initiation |
| Approve new code, process, network, instruction, or credential authority | Human only, one exact plan, one use |
| Supply a package name, URL, shell command, or secret to the mutation path | Forbidden |
| Install after confirmation | Center-coordinated typed operation, never model execution; every admitted child Plugin Bundle package membership change uses the official Plugin CLI |
| Verify current Agent visibility and continue the original task | Autonomous after owner evidence |
| Install directly from arbitrary web or community search results | Forbidden; result remains `external-only` |
| Remember a broad install grant or approve future candidates | Excluded from P0 |

The model-facing acquisition request accepts only `resolutionId`, `candidateRef`, and `continuationId`. The Host re-resolves those opaque values against the same catalog, inventory, policy, scope, expiry, and integrity revision, mints the immutable plan, and waits for a separate decision from an authenticated DSH Web browser session. The Agent cannot call that decision endpoint.

## Product decision: continuation

For a Skill or MCP connection, the Center-owned lifecycle engine may wait for confirmation, mutate its desired state, verify the official registry winner or MCP Tool set, re-read the exact Agent-visible capability set, and dispatch a new step for the same objective. The MCP engine mounts and disposes the published rc.2 MCP Client inside Center-owned fibers; it does not require a new official mutation service. Store-originated acquisition has no continuation claim.

A managed Plugin may require a real Host restart because Node and Web module caches can prevent same-process proof. The Center retains a durable single-use claim with cancellation and supersession fences, while the official Plugin CLI owns the selected Profile dependency and package installation. On the next boot the Center verifies that exact dependency, Loader contribution, and declared consumer, then dispatches the bound continuation message at most once through the official Agent and Session services. It does not promise exactly-once task completion.

Installation success and task success remain independent. The original task is complete only after the newly visible capability is actually used and its task-level observable passes.
