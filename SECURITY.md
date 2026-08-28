# Security policy

## Supported versions

Security fixes target the current stable release and `main`; immutable prereleases receive fixes only through a newer release. Stable `0.1.0` belongs only to the unmodified official DSH `0.1.1-rc.2` evidence line. The `0.2.0-alpha.1` source targets exact official DSH `0.1.2-alpha.1`, but the Center alpha packages and their required official DSH coordinate are absent from npm as of 2026-08-28. Source, workflow, or modified-Host state is not registry or release evidence.

| Version | Security support | DSH compatibility |
| --- | --- | --- |
| `0.2.0-alpha.1` | In development; not a published npm release | Target under verification: exact official DSH `0.1.2-alpha.1` |
| `0.1.0` | Published stable security fixes | Limited to official DSH `0.1.1-rc.2`; each compatibility claim requires that version's exact receipt |
| `0.1.0-rc.2` | No fixes; immutable successful predecessor | Successful recovery evidence; superseded only by a newer version with passing receipts |
| `0.1.0-rc.1` | No fixes; immutable failed candidate | Its post-publication update failed and produced no release-ready receipt |
| `0.1.0-rc.0` | No fixes; immutable bootstrap | Historical bootstrap superseded by the successful rc.2 recovery receipt |
| `main` | Development fixes | No compatibility inherited from a published version without a new exact-commit receipt |

Stable historical support is bound by successful post-publication run `33130950000` on protected `main` commit `6d95545652e15c57b9e13390095a7172e65034b3`, Actions artifact digest `sha256:7dbc3145d376f75ed4ff8763af46290f7daff5a0be9dcf446fd017f02a23c2c0`, release-ready receipt digest `sha256:cdc27dfcb5768b8fe14c082553b5120e98d050748015df0311d1e610edf27994`, and public-catalog receipt digest `sha256:4bb66be8eef541eaebde8e0ee56ad09225f6f288948365d08c00c9d3159ad700`. The catalog receipt binds public revision 11 to exact file SHA-256 `38a5414c2da581bf0014a2769c9842375b0d0822b77f89e5159b27b3042fc58e`. This evidence applies only to stable on official rc.2; alpha r12 lifecycle, admission, deployment, runtime refresh, npm registry, Plugin, MCP, and Agent acquisition/continuation remain unproven.

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
- a model, remote catalog, unauthenticated caller, or payload-claimed transport authority approving or directly executing a mutation;
- a plan-hash, expiry, single-use, inventory-revision, target-lock, owner-verification, journal-chain, receipt, or recovery integrity bypass;
- task text, search text, secrets, cookies, authorization headers, private extension data, or provider content leaving the documented local scope or entering evidence;
- Plugin, MCP, or Skill state being reported as installed, configured, active, connected, verified, restored, or task-successful without matching evidence from the official Profile package manager and Loader contribution for a child Plugin, the official MCP Client or Skill registry for MCP and Skill, and the Agent or Session service for continuation;
- MCP stdio or HTTPS escaping the documented executable, environment, origin, header, redirect, size, timeout, teardown, or tool-generation restrictions;
- Skill traversal, symlink, script execution, external revision conflict, or deletion outside the owned root;
- unsafe rendering, unbounded catalog/RPC/journal data, stale or unsigned catalog fallback, or one malformed candidate compromising the full catalog;
- normal or break-glass Plugin mutation accepting a changed bound Node executable/version, supervisor, private `pnpm@11.21.0` package/shim/shell, the official DSH package/version/entrypoint/production dependency closure declared by the exact receipt, wrong Center root or `hostHome`, Profile-local package-manager execution control, mismatched retained archive, tampered journal, drifted official Profile state, a missing or changed provider-bound metadata-cache generation, a live orphan mutation subtree, committing Center state before the official CLI restores and verifies the Profile before-state, a direct Profile write, or duplicate restore; or
- an rc.0 pnpm 11.7.0 authorization being executed, returned as a recovery command, rewritten as current history, mixed with the current registry SRI, or allowed to reconcile a Plugin owner before its exact unfinished or failed-but-owner-referenced operation is quarantined;
- a published archive differing from the exact `main`-push Node 22 CI tarball, `SHA256SUMS`, self-digested attestation, or reviewed source identity; containing an install-time lifecycle script; or embedding a checkout path or credential.

Also report a GitHub Release asset whose digest differs from `SHA256SUMS`; a CI artifact whose Actions digest, run id or attempt, exact three-entry ZIP payload, source commit, packed manifest, bundled pnpm tree, or tarball bytes fail their attestation; a public catalog whose signature, predecessor, revision, or canonical bytes differ from the committed deployment input; a compromised catalog signing key; a Pages deployment that serves different bytes; or a forged lifecycle or deployment receipt. A receipt may rely on Release immutability or protected `v*` tags only when it records those repository controls for the exact run. The Release, Pages, CI, runtime, and composite status of each version still requires its own external receipt.

Artifact URL validation rejects all IP literals but does not resolve hostnames. A hostname resolving to a private address or changing through DNS rebinding is outside this guarantee; hostnames and DNS remain untrusted.

Documented unavailable states, Windows mutation/recovery refusal, restart requirements, local lexical-ranking limitations, rejected community leads, the rc.2 external CLI's lack of a lock or compare-and-swap token, unproven ABA behavior, same-user mutation between a completed verification and the following process use, and other unproven release gates are not vulnerabilities by themselves when represented accurately.
