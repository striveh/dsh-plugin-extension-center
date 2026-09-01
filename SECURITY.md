# Security policy

## Supported versions

Security fixes target `main` and the latest GitHub-distributed Center artifact. The current source target is the exact unmodified official DSH `0.1.2-alpha.3`. Historical `0.1.0` receipts apply only to official DSH `0.1.1-rc.2` and do not establish current compatibility.

The project does not require an npm publication. A compatibility claim must bind the deterministic Center tarball, official DSH package version and registry integrity, audited source commit, standard Plugin CLI installation, real Host and Client observation, removal, and an unchanged official DSH package tree.

## Report a vulnerability privately

Use GitHub private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Advisories** → **Report a vulnerability**.
3. Include the affected commit or artifact digest, a synthetic reproduction, impact, and any suggested mitigation.

Do not open a public issue containing a working exploit, credential, private key, authorization material, user task text, private extension data, proprietary source, or DSH Session/provider payload.

## Relevant security boundaries

Please report any path that:

- admits arbitrary packages, Git references, paths, commands, URLs, credentials, redirects, environment variables, or lifecycle scripts outside signed catalog policy;
- lets a model, remote catalog, unauthenticated caller, or payload-claimed transport approve or execute a mutation;
- bypasses plan digest, expiry, single use, inventory revision, target lock, owner verification, journal chain, receipt, or recovery binding;
- reports Plugin, MCP, or Skill state without matching evidence from the official Profile package manager and Loader, official MCP Client, or official Skill registry;
- leaks task text, secrets, cookies, authorization headers, private catalog data, or provider content;
- escapes documented MCP transport, Skill path, artifact redirect, size, timeout, teardown, or Tool-generation restrictions;
- accepts a changed bound Node, supervisor, bundled pnpm, official DSH package tree, Profile state, retained archive, journal, or provider recovery snapshot;
- directly writes official DSH source/package files or Profile package-manager state;
- mutates, weakens, or silently relabels the packaged signed catalog; or
- produces a GitHub artifact whose tarball, checksum, attestation, source commit, or receipt identity differs from the reviewed bytes.

Artifact URL validation rejects IP literals but does not resolve hostnames; DNS and hostnames remain untrusted. Documented unavailable states, Windows mutation/recovery refusal, restart requirements, and a signed candidate not yet admitted for the current DSH release are not vulnerabilities when represented accurately and fail closed.
