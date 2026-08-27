# Security policy

## Supported versions

Security fixes target the current prerelease and `main`. The only claimed compatibility target is the packed Extension Center running on the unmodified official DSH `0.1.1-rc.2` artifact documented in the README; a source checkout or modified Host is not release evidence.

| Version | Security support | DSH compatibility |
| --- | --- | --- |
| `0.1.0-rc.2` | Prerelease security fixes | Only the official DSH `0.1.1-rc.2` artifact bound by that version's receipts |
| `0.1.0-rc.1` | No fixes; immutable failed candidate | Its post-publication update failed and produced no release-ready receipt |
| `0.1.0-rc.0` | No fixes; immutable bootstrap | Last successful release-ready bootstrap; upgrade only after a newer version has passing receipts |
| `main` | Development fixes | No compatibility inherited from a published version without a new exact-commit receipt |

## Report a vulnerability privately

Use GitHub private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Advisories** → **Report a vulnerability**.
3. Include the affected commit or artifact digest, a synthetic reproduction, impact, and any suggested mitigation.

Do not open a public issue containing a working exploit, credentials, private keys, authorization material, user task text, configured private extensions, private catalog data, proprietary source, or DSH session/provider payloads. If private reporting is unavailable, open a public issue without vulnerability details and ask the maintainer to enable a private contact path.

## Relevant security boundaries

A useful report may show:

- arbitrary packages, Git references, paths, commands, URLs, credentials, redirects, environment variables, or lifecycle scripts admitted outside the signed catalog policy;
- an artifact initial or redirect URL containing any IPv4 or IPv6 literal being accepted;
- a model, remote catalog, or non-loopback caller approving or directly executing a mutation;
- a plan-hash, expiry, single-use, inventory-revision, target-lock, owner-verification, journal-chain, receipt, or recovery integrity bypass;
- task text, search text, secrets, cookies, authorization headers, private extension data, or provider content leaving the documented local scope or entering evidence;
- Plugin, MCP, or Skill state being reported as installed, configured, active, connected, verified, restored, or task-successful without matching evidence from the official Profile package manager and Loader contribution for a child Plugin, the official MCP Client or Skill registry for MCP and Skill, and the Agent or Session service for continuation;
- MCP stdio or HTTPS escaping the documented executable, environment, origin, header, redirect, size, timeout, teardown, or tool-generation restrictions;
- Skill traversal, symlink, script execution, external revision conflict, or deletion outside the owned root;
- unsafe rendering, unbounded catalog/RPC/journal data, stale or unsigned catalog fallback, or one malformed candidate compromising the full catalog;
- normal or break-glass Plugin mutation accepting a changed bound Node executable/version, supervisor, private `pnpm@11.21.0` package/shim/shell, official rc.2 package/entrypoint/production dependency closure, wrong Center root or `hostHome`, Profile-local package-manager execution control, mismatched retained archive, tampered journal, drifted official Profile state, a missing or changed provider-bound metadata-cache generation, a live orphan mutation subtree, committing Center state before the official CLI restores and verifies the Profile before-state, a direct Profile write, or duplicate restore; or
- an rc.0 pnpm 11.7.0 authorization being executed, returned as a recovery command, rewritten as current history, mixed with the current registry SRI, or allowed to reconcile a Plugin owner before its exact unfinished or failed-but-owner-referenced operation is quarantined;
- a published archive differing from the exact `main`-push Node 22 CI tarball, `SHA256SUMS`, self-digested attestation, or reviewed source identity; containing an install-time lifecycle script; or embedding a checkout path or credential.

Also report a GitHub Release asset whose digest differs from `SHA256SUMS`; a CI artifact whose Actions digest, run id or attempt, exact three-entry ZIP payload, source commit, packed manifest, bundled pnpm tree, or tarball bytes fail their attestation; a public catalog whose signature, predecessor, revision, or canonical bytes differ from the committed deployment input; a compromised catalog signing key; a Pages deployment that serves different bytes; or a forged lifecycle or deployment receipt. Repository Release immutability and protected `v*` tags prevent later mutation, while the Release, Pages, CI, runtime, and composite status of each version is established only by its own external receipts.

Artifact URL validation rejects all IP literals but does not resolve hostnames. A hostname resolving to a private address or changing through DNS rebinding is outside this guarantee; hostnames and DNS remain untrusted.

Documented unavailable states, Windows mutation/recovery refusal, restart requirements, local lexical-ranking limitations, rejected community leads, the rc.2 external CLI's lack of a lock or compare-and-swap token, unproven ABA behavior, same-user mutation between a completed verification and the following process use, and other unproven release gates are not vulnerabilities by themselves when represented accurately.
