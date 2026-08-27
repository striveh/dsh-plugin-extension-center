# dsh-plugin-extension-center

[English](README.md) | 中文

[![CI](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml/badge.svg)](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

这是一个独立社区插件项目，目标是为 DeepSeek Harness 提供本机统一扩展中心。P0 有两个一等获取入口：Agent 可以识别任务能力缺口并用本地 Capability RAG 检索准入候选，用户也可以在扩展商店中浏览、搜索、比较并自主获取同一目录里的扩展。两条路径汇合到同一个准入目录、政策、扩展中心自有发现与获取控制面、验证、inventory 与回执 schema；每项动作分别获得自己的准确不可变计划。每个可写目录候选还必须覆盖发现、安装、配置、准确更新、验证、卸载与失败恢复；只有扩展真实 owner 支持时才提供启用和停用。产品不合并 DSH Plugin、MCP Server 与 Skill 的生命周期，也不把“安装成功”冒充为“代码安全”。

本项目不是 DeepSeek Harness 官方 Release。产品代码、目录政策、测试、兼容性声明和 Release 都归本仓库所有；DSH monorepo 只作为宿主，不承载产品实现。

状态（2026-08-28）：源码实现了签名商店、带未过期 last-good 缓存的签名目录刷新、只产生线索的发现与 threshold signing、归一化 inventory、不可变计划与 loopback 人工批准、逐目标 journal 与 receipt、Plugin/MCP/Skill 类型化操作、任务优先的本地 Capability RAG、恢复编排以及持久化续行 claim。对每个已准入 child Plugin Bundle，无论是 Host-only 还是 Host+Client，扩展中心都会暂存并锁定准确 archive，并把 package membership 变更委托给官方 `dsh plugin --profile` CLI；只有官方 Profile package manager 可以写入 Profile dependency、lock 数据、`node_modules`、Bundle membership 与 package-membership Loader row。纯配置通过官方 Loader 在同一个 Host 进程替换并验证准确受管 row。MCP stdio connection 挂载官方 MCP Client，Skill 通过官方 registry 投影，续行使用官方 Agent 与 Session 服务。设计中不存在 fork 专用 package 或 DSH Host PR。准确边界见[纯插件架构](docs/plugin-only-architecture.zh.md)。

证据按 receipt 划分。发布前验收要求准确 packed artifact 通过完整官方 rc.2 生命周期、浏览器、受控 ABA、break-glass、故障、确定性 Replay Agent、Ubuntu 与 macOS lane。`0.1.0-rc.0` bootstrap 把 previous Center、CI、release-ready 与 evidence-run 输入记录为 `null`，不声明从更早 Center Release 更新。后续候选必须证明不同前一版本到当前版本的真实 artifact 更新，把前一次已部署签名目录提升为当前 package bootstrap，并部署其准确相邻签名后继。公开 Release 安装、Pages 刷新与跨边界完成状态只由各自通过的 post-publication 与 composite receipt 建立。Replay 只替换模型响应这一条边，官方 Agent、Session、Tool dispatch、扩展中心受管 Skill、continuation 与 receipt 路径仍正常运行。Live provider 运行只是非阻塞兼容性 smoke，既不阻断 P0，也不能替代确定性 receipt。

公开的 `main` 分支是开发源码预览，不是稳定 Release 或 npm 发布。Manifest 有意保留 `private: true` 以阻止误发 npm；这不限制采用 MIT 许可证的 GitHub 源码或经过审查的 GitHub Release asset。GitHub Release、公开 Pages 目录或已完成 CI lane 的状态只由对应准确版本的 receipt 记录，绝不能从源码文件、workflow、repository setting 或本地测试中推断。

Release provenance 以 byte 为准。只有准确 `main` push 的 Node 22 CI job 上传的确定性 tarball、`SHA256SUMS` 和自摘要 pack attestation 可作为 Release 候选。CI verifier 会绑定 Actions archive digest、run id 与 attempt、只含三个准确 entry 的 ZIP payload、source commit、packed manifest、bundled pnpm tree 和 tarball byte；下载只允许固定 GitHub API，以及随后一次准入的 GitHub Actions 或 Azure Blob storage redirect。Runtime、公开 Release 与复合 receipt 都必须绑定同一个已 attested tarball。Repository Release immutability 与受保护 `v*` tag 会阻止后续修改；这些 repository policy 不能替代任何具体 Release 的 receipt。

- [P0 产品规格与验收路径](docs/p0-product-spec.zh.md)
- [P0 product specification and acceptance path](docs/p0-product-spec.md)
- [能力发现与扩展商店研究](docs/capability-rag-research.zh.md)
- [Capability discovery and Extension Store research](docs/capability-rag-research.md)
- [目录发现、准入与签名](docs/catalog-operations.zh.md)
- [Catalog discovery, admission, and signing](docs/catalog-operations.md)
- [rc.2 签名离线商店验收](acceptance/store-only/README.zh.md)
- [rc.2 signed offline Store acceptance](acceptance/store-only/README.md)
- [基于官方 rc.2 的完整 P0 验收](acceptance/full-p0/README.zh.md)
- [full P0 acceptance on official rc.2](acceptance/full-p0/README.md)

正在验证的兼容性目标是不可变的官方 `dsh-v0.1.1-rc.2` Release，对应 commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。扩展中心消费其已发布的 Plugin CLI、Loader、Tool、Skill、MCP Client、Agent、Session、Connection RPC 与 Web Client 扩展点。只有 packed Bundle 在未经修改的该 Release 上通过相应 lane，兼容性主张才有效。

## 安装已发布的候选版本

只有匹配的 GitHub Release 已存在且公开 Release receipt 通过后，下列坐标才有效；否则 Release 安装主张不可用，开发版本 checkout 不能替代它。对于已发布候选，应从不可变 GitHub Release asset 安装扩展中心，不能依赖移动分支。官方 DSH Plugin CLI 会把 Profile package management 委托给 pnpm，因此 `PATH` 中必须存在 `pnpm`：

```sh
curl -fLO https://github.com/striveh/dsh-plugin-extension-center/releases/download/v0.1.0-rc.1/dsh-plugin-extension-center-0.1.0-rc.1.tgz
curl -fLO https://github.com/striveh/dsh-plugin-extension-center/releases/download/v0.1.0-rc.1/SHA256SUMS
shasum -a 256 -c SHA256SUMS
dsh plugin --profile web add ./dsh-plugin-extension-center-0.1.0-rc.1.tgz --ignore-scripts --save-exact
dsh plugin --profile web list --depth 0
dsh --profile web --dump-config
dsh web
```

更新、降级或移除扩展中心前先停止 Host。更新或降级时，把新的准确本地 archive 传给同一个 `add` 命令；移除也只能通过官方 Profile package manager 完成，然后重启 DSH：

```sh
dsh plugin --profile web remove dsh-plugin-extension-center
```

运行时配置属于官方 Loader patch，应写入 `$DSH_HOME/profiles/web/cordis.patch.yml` 或相应的 home-level patch。Loader patch 会替换匹配 row 的完整配置，因此修改一个字段时也必须重述所有需要保留的字段，并用 `dsh --profile web --dump-config` 确认结果。默认 Bundle 配置只信任准确的公开 `plugins.json` URL，有意不声明任何 `mcpRuntimes` allowlist。Artifact acquisition 会拒绝 initial URL 和 redirect URL 中的所有 IPv4 与 IPv6 literal。它默认最多允许一次 redirect，跨 origin 跳转只能到 `objects.githubusercontent.com` 或 `release-assets.githubusercontent.com`；下载会把已消费 authorization 绑定到不可变 plan 中捕获的签名坐标，并校验准入 byte size 与 digest。部署方可以把 `maximumArtifactRedirects` 收紧为零，并缩小或清空 `allowedArtifactRedirectHosts`。Hostname 与 DNS 仍不可信：该 URL 检查不解析域名，也不声称防御 DNS rebinding。用户通过该 Loader row 配置准确 executable path、digest、version、fixed arguments 与 working directory 前，MCP candidate 始终不可写。P0 mutation 与 recovery 支持 macOS 和 Linux，在 Windows 上 fail closed。

## 开发版本检出

公开 `main` 只用于源码审查和开发。验证 packed rc.2 商店纵切时，应锁定一个审查过的准确 commit，不能依赖移动分支：

```sh
dsh plugin --profile web add github:striveh/dsh-plugin-extension-center#<reviewed-commit-sha>
dsh --profile web --dump-config
dsh web
```

仓库提交确定性 `lib/` 构建产物，并且不声明 package lifecycle script，因此从 GitHub 安装时不会执行项目构建。扩展中心自身必须只通过这个官方 CLI 从外部安装、更新、降级或卸载；运行中的扩展中心不会自我修改。`0.1.0-rc.0` bootstrap 有意不携带前一 Center artifact 或 release-ready receipt，并证明目录 `r8→r9`。从 `0.1.0-rc.1` 开始，每个 Release receipt 必须绑定并运行不同的前一与当前 artifact 以及准确成功的前一 post-publication receipt；rc.1 提升 `r9` 并部署 `r10`，stable 必须直接从 rc.1 晋级、提升 `r10` 并部署 `r11`。

开发与验证命令：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run pack:preview
pnpm exec playwright install chromium
pnpm run test:acceptance:store
pnpm run test:acceptance:official-rc2
```

证据与发布规则见[贡献指南](CONTRIBUTING.md)，私密漏洞报告路径见[安全政策](SECURITY.md)。

## 在线目录刷新

`catalogTrustedUrl` 只接受一个准确的 canonical HTTPS URL；Host 只接纳通过 package 固定签名根验证的完整 envelope。`catalogFetchTimeoutMs` 限制每次请求，`catalogRefreshIntervalMs` 控制可选后台刷新。启动、loopback `catalog/refresh` 动作、商店与任务 Capability RAG 共用同一份 admitted snapshot。商店检索文本与任务内容绝不会进入请求。刷新失败时只能继续使用未过期且已验证的 bootstrap 或 last-good snapshot，并报告 `source`、`freshness`、`degradedReason` 与 `lastRefreshAtMs`；snapshot 过期后 fail closed。

## Break-glass 扩展中心恢复

源码会把无依赖恢复 CLI 安装到 `$DSH_HOME/extension-center/recovery/<package-version>/<platform>-<arch>/break-glass.mjs`。恢复绑定 schema v5 与 official-execution binding v2 会固定该文件和 Center root，同时固定 canonical Node executable、版本与 digest，POSIX supervisor，私有 bundled `pnpm@11.21.0` package、registry SRI、完整 tree、entrypoint、shim 与 shell，以及准确官方 rc.2 package、entrypoint 与已安装 production-dependency closure。对已安装 Profile，扩展中心严格读取变更前的准确 `package.json`、`pnpm-lock.yaml`、`node_modules/.modules.yaml` 与引用的已安装 package manifest，再从这些本地事实合成 owner-only、content-addressed 的 pnpm 11 abbreviated/full metadata-cache generation。被绑定的 generation identity 覆盖 Profile digest、现有 canonical store、生成文件、固定 pnpm runtime 与 cache manifest；每次使用前都重新验证 manifest 与文件 digest。Binding 存入 Plugin provider recovery snapshot，因此正常 rollback 与独立 break-glass recovery 会验证并使用同一 generation。Cache 缺失、被更改、经由 symlink 替换或与 binding 不匹配时，会在下一次官方 CLI Profile 写入前 fail closed。执行期继续 offline 且禁用 lifecycle script；该 cache 不是网络预热，也不声称能获取不可用的 package byte。只有同时没有 lock 且没有 `node_modules` 安装的 Profile 才使用扩展中心私有的 per-Profile store。独立 process-group supervisor 会在 timeout 或 parent 丢失（包括 parent `SIGKILL`）后终止完整 mutation subtree；execution lease 会在该 subtree 仍存活时阻止 stale-lock reclaim。该变更与恢复路径只支持 macOS 和 Linux，在 Windows 上 fail closed。Provider apply 一旦开始，mutation recovery 不可用时会保留锁并进入 `recovery-required`，不会签发 failed receipt。启动会在 owner 初始化前读取 retired Center 与 owner sidecar 状态；仍被任一 projection 引用的 retired failed Plugin journal 会被隔离，缺少准确 target lock 时阻止可写激活。DSH 停止时，break-glass recovery 会验证 journal 绑定的 provider snapshot，只调用已绑定的官方 CLI 恢复准确 Profile before-state，验证结果后才提交 Center state。它绝不直接写入 Profile dependency、lock 数据、`node_modules`、Bundle membership 或 Loader row，也不导入已损坏的 Center runtime。后续官方 DSH 启动必须验证所选 Profile dependency、Loader contribution 与声明 consumer，恢复终态证据才有效。准确完整生命周期 receipt 记录某个 Release candidate 的 packed break-glass 执行是否通过；源码本身不构成该主张。

## 许可证

[MIT](LICENSE)。DeepSeek Harness 与 DeepSeek 名称归各自权利人所有。
