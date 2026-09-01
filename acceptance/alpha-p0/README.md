# Alpha product P0 composite gate

> Historical npm-era composite design, retained for audit only. It is not the current compatibility or completion gate. The current target is the independent packed plugin running on the latest reviewed unmodified official DSH.

This verifier is the final fail-closed product binder. A successful ordinary-user receipt proves the official DSH registry installation and the Skill UI lifecycle only; its `laneStatus: "proven"` deliberately retains `p0Status: "red"`. Product P0 becomes proven only when every row below passes and every immutable product identity matches.

The gate is repository acceptance tooling, not a runtime feature or a catalog candidate, and it is not included in the published plugin payload.

| Lane | Exact accepted evidence |
| --- | --- |
| Official DSH registry installation | ordinary-user schema 3 plus independently fetched Actions run, artifact metadata, and archive bytes |
| Center package and provenance | `DSH-CENTER-NPM-PROVENANCE` schema 1 plus independently fetched registry metadata, tarball, and npm provenance |
| Signed catalog | `P0-ALPHA-SIGNED-CATALOG-ACTIVATION` schema 1, including the actual signed envelope/signatures, public fetch bytes, Plugin/MCP/Skill successor pairs, and live runtime refresh |
| Plugin lifecycle | `P0-ALPHA-PLUGIN-UI-LIFECYCLE` schema 1 with the exact seven UI-authorized operations and provider/recovery digests |
| MCP lifecycle | `P0-ALPHA-MCP-UI-LIFECYCLE` schema 1 with the exact seven UI-authorized operations and preprovisioned-runtime digests |
| Skill UI lifecycle | the same independently validated ordinary-user schema 3 receipt |
| Agent acquisition and continuation | `P0-ALPHA-AGENT-CAPABILITY-ACQUISITION-CONTINUATION` schema 1, covering gap detection, exact selection, human approval, acquisition, runtime use, and one continuation of the original Session |

The official-alpha Wiki Skill lifecycle schema 2 is accepted only as `development-only` evidence. It cannot satisfy the signed-catalog lane because it explicitly does not prove public deployment or registry installation.

Every production lane binds an exact source commit, workflow run and attempt, receipt digest, and package or Actions artifact digest. The composite also cross-checks official DSH, Center npm version/integrity/tarball/source commit, and signed catalog revision/document/entries identities. The signed-catalog lane re-runs the existing catalog verifier against the trust root packaged by this exact Center build and hashes the canonical public document bytes; a rehashed projection without that document is invalid. Lifecycle producers must derive operation, journal, inventory, owner-state, and recovery digests through the existing full-P0 terminal receipt verification path. Self-digests detect substitution after production; they do not authenticate external facts by themselves. Until the composite accepts and independently checks the corresponding GitHub API run metadata, artifact metadata, downloaded archive bytes, registry metadata, tarball, and npm provenance, every schema-valid production receipt remains `externally-unverified` and cannot turn P0 green. Schema 1 therefore always emits RED and rejects a rehashed all-proven claim.

Run:

```sh
pnpm run verify:alpha-p0-composite -- \
  --ordinary-user /absolute/path/ordinary-user.json \
  --ordinary-actions /absolute/path/ordinary-actions-evidence.json \
  --npm-provenance /absolute/path/npm-provenance.json \
  --catalog /absolute/path/catalog-activation.json \
  --plugin /absolute/path/plugin-lifecycle.json \
  --mcp /absolute/path/mcp-lifecycle.json \
  --agent /absolute/path/agent-acquisition.json \
  --receipt /absolute/path/composite-receipt.json
```

Exit code `0` is reserved for a future revision that independently authenticates every lane and binding. Exit code `2` means the canonical receipt was written with `p0Status: "red"`; missing or externally unverified evidence is listed under `notProven`. Exit code `1` means the verifier itself could not run. As of 2026-08-28 the Plugin, MCP, Agent, and signed-catalog activation receipts and their external-verification inputs do not exist, so the truthful result is RED.
