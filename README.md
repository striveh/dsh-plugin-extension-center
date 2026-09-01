# DSH Extension Center

English | [中文](README.zh.md)

An independent Host+Web plugin for the official DeepSeek Harness. It adds one Extension Center without changing or forking DSH.

## Product scope

The Center gives users and Agents one managed path for Plugin, MCP connection, and Skill capabilities:

- discover from a locally verified signed catalog, either through Store search or task-driven Capability RAG;
- review provenance, exact artifact identity, permissions, dependencies, configuration, conflicts, restart requirements, and verification evidence before mutation;
- install, configure, update, enable or disable, restore, uninstall, and purge through a typed lifecycle;
- retain immutable plans, single-use human grants, journals, receipts, rollback points, and break-glass recovery evidence;
- continue the original task exactly once after an Agent-requested capability is installed and verified.

The Agent may identify and rank candidates autonomously, but it cannot supply package coordinates, URLs, commands, credentials, or approval to a mutation tool. The Host resolves those facts from the signed catalog and current inventory; a user grants each concrete write separately.

## Compatibility target

The current reviewed target is the unmodified official DSH `0.1.2-alpha.3`, tag `dsh-v0.1.2-alpha.3`, commit `dd6322d604e00eec1ba5e0c8541159906a21094a`. The plugin uses the public Bundle patch, Host Connection RPC, Client Connection RPC, and Web slot contracts exposed by that release.

Publishing this plugin to npm is not a completion requirement. The supported delivery artifact is the deterministic tarball produced by this repository and installed with the standard official Plugin CLI. Official DSH remains an external, unmodified dependency.

## Install like a user

Install the current official DSH and ensure `pnpm` is on `PATH`:

```sh
pnpm add --global @deepseek-ai/dsh@0.1.2-alpha.3
```

Download or build the GitHub-hosted Center tarball, then install it through the ordinary Plugin command:

```sh
dsh plugin --profile web add /absolute/path/dsh-plugin-extension-center-0.2.0-alpha.1.tgz --ignore-scripts --save-exact
dsh web
```

For a source checkout, create the same user-facing artifact without installing the source tree into DSH:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run verify:pack
```

The tarball is written under `.artifacts/release-candidate/`. Until a registry channel exists, update by adding the exact newer tarball; removal uses the same official Profile package manager:

```sh
dsh plugin --profile web add /absolute/path/dsh-plugin-extension-center-NEWER.tgz --ignore-scripts --save-exact
dsh plugin --profile web remove dsh-plugin-extension-center
```

## Verification

```sh
pnpm test
pnpm run verify:pack
pnpm run test:compat:latest
```

`test:compat:latest` builds and packs the Center, installs it into an isolated official DSH `0.1.2-alpha.3` Web Profile with the standard Plugin CLI, boots the real Host and browser Client, verifies the Store surface and Connection RPC, and checks that the official DSH package tree is unchanged. Its receipt is written to `.artifacts/acceptance/store-only/receipt.json`.

The packaged signed revision 11 catalog is historical rc.2 data and remains immutable. It is safe for offline inspection but is not silently relabelled as alpha.3-compatible. Exact alpha.3 child-candidate lifecycle claims require their own reviewed, signed admission receipt; until then the UI fails closed for mutation. This does not block proving that the independent Center itself installs and runs on the latest official DSH.

## Architecture and product contract

- [P0 product specification](docs/p0-product-spec.md)
- [Plugin-only architecture](docs/plugin-only-architecture.md)
- [Catalog discovery and operations](docs/catalog-operations.md)
- [Latest-DSH compatibility acceptance](acceptance/store-only/README.md)
- [Extended full-P0 lifecycle gate](acceptance/full-p0/README.md)
- [Security policy](SECURITY.md)
- [Release history](CHANGELOG.md)

No supported path edits official DSH source or package files, writes Profile package-manager state directly, or requires a Host PR.
