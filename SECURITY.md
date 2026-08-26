# Security policy

## Supported versions

There is no stable release yet. Security fixes target the public development branch, while compatibility remains limited to the exact lanes documented in the README: published DSH `0.1.1-rc.2` for read-only Store and expected-negative Host behavior, and an explicitly labelled local DSH checkout for non-release writable integration evidence.

## Report a vulnerability privately

Use GitHub private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Advisories** → **Report a vulnerability**.
3. Include the affected commit or artifact digest, a synthetic reproduction, impact, and any suggested mitigation.

Do not open a public issue containing a working exploit, credentials, private keys, authorization material, user task text, configured private extensions, private catalog data, proprietary source, or DSH session/provider payloads. If private reporting is unavailable, open a public issue without vulnerability details and ask the maintainer to enable a private contact path.

## Relevant security boundaries

A useful report may show:

- arbitrary packages, Git references, paths, commands, URLs, credentials, redirects, environment variables, or lifecycle scripts admitted outside the signed catalog policy;
- a model, remote catalog, or non-loopback caller approving or directly executing a mutation;
- a plan-hash, expiry, single-use, inventory-revision, target-lock, owner-verification, journal-chain, receipt, or recovery integrity bypass;
- task text, search text, secrets, cookies, authorization headers, private extension data, or provider content leaving the documented local scope or entering evidence;
- Plugin, MCP, or Skill state being reported as installed, configured, active, connected, verified, restored, or task-successful without the owning Host evidence;
- MCP stdio or HTTPS escaping the documented executable, environment, origin, header, redirect, size, timeout, teardown, or tool-generation restrictions;
- Skill traversal, symlink, script execution, external revision conflict, or deletion outside the owned root;
- unsafe rendering, unbounded catalog/RPC/journal data, stale or unsigned catalog fallback, or one malformed candidate compromising the full catalog;
- break-glass execution accepting changed executable bytes, a changed Host CLI, a mismatched Profile generation, a tampered journal, or duplicate restore; or
- a published archive differing from the reviewed source, containing an install-time lifecycle script, or embedding a checkout path or credential.

Documented unavailable states, the rc.2 expected-negative Host lane, local lexical ranking limitations, rejected community leads, and unproven external release gates are not vulnerabilities by themselves when represented accurately.
