# dsh-plugin-extension-center

[English](README.md) | 中文

[![CI](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml/badge.svg)](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

这是一个独立社区插件项目，目标是为 DeepSeek Harness 提供本机统一扩展中心。P0 有两个一等获取入口：Agent 可以识别任务能力缺口并用本地 Capability RAG 检索准入候选，用户也可以在扩展商店中浏览、搜索、比较并自主获取同一目录里的扩展。两条路径汇合到同一个准入目录、政策、扩展中心自有发现与获取控制面、验证、inventory 与回执 schema；每项动作分别获得自己的准确不可变计划。每个可写目录候选还必须覆盖发现、安装、配置、准确更新、验证、卸载与失败恢复；只有扩展真实 owner 支持时才提供启用和停用。产品不合并 DSH Plugin、MCP Server 与 Skill 的生命周期，也不把“安装成功”冒充为“代码安全”。

本项目不是 DeepSeek Harness 官方 Release。产品代码、目录政策、测试、兼容性声明和 Release 都归本仓库所有；DSH monorepo 只作为宿主，不承载产品实现。

状态（2026-08-28）：源码实现了签名商店、带未过期 last-good 缓存的签名目录刷新、只产生线索的发现与 threshold signing、归一化 inventory、不可变计划与浏览器会话认证后的用户决定、逐目标 journal 与 receipt、Plugin/MCP/Skill 类型化操作、任务优先的本地 Capability RAG、恢复编排以及持久化续行 claim。对每个已准入 child Plugin Bundle，无论是 Host-only 还是 Host+Client，扩展中心都会暂存并锁定准确 archive，并把 package membership 变更委托给官方 `dsh plugin --profile` CLI；只有官方 Profile package manager 可以写入 Profile dependency、lock 数据、`node_modules`、Bundle membership 与 package-membership Loader row。纯配置通过官方 Loader 在同一个 Host 进程替换并验证准确受管 row。MCP stdio connection 挂载官方 MCP Client，Skill 通过官方 registry 投影，续行使用官方 Agent 与 Session 服务。设计中不存在 fork 专用 package 或 DSH Host PR。准确边界见[纯插件架构](docs/plugin-only-architecture.zh.md)。

证据按 receipt 划分。以下历史属于官方 rc.2 上的 stable `0.1.0`，不能证明新的 alpha 版本线。成功的 `0.1.0-rc.0` bootstrap 把 previous Center、CI、release-ready 与 evidence-run 输入记录为 `null`。不可变 rc.1 候选没有成功 composite receipt：它唯一一次 post-publication 尝试在真实同 Profile 更新中暴露了持久目录缓存换锚缺陷，因此保持为 `not-release-ready` 事故。恢复候选 rc.2 已直接从 rc.0 的最后一个成功 receipt 更新，在同一 Center root 中从 package 内置 `r9` 迁移到已部署 `r10`，绑定 rc.1 事故，并生成 stable 使用的成功前序 receipt。Stable package 内置 `r10` 并提交了签名后继 `r11`。Replay 只替换模型响应这一条边，官方 Agent、Session、Tool dispatch、扩展中心受管 Skill、continuation 与 receipt 路径仍正常运行。Live provider 运行只是非阻塞兼容性 smoke，既不阻断 P0，也不能替代确定性 receipt。

Stable `v0.1.0` 已有通过证明。Post-publication run `33130950000` 在受保护 `main` commit `6d95545652e15c57b9e13390095a7172e65034b3` 上成功完成；其 Actions artifact digest 为 `sha256:7dbc3145d376f75ed4ff8763af46290f7daff5a0be9dcf446fd017f02a23c2c0`。Release-ready receipt digest 为 `sha256:cdc27dfcb5768b8fe14c082553b5120e98d050748015df0311d1e610edf27994`，public-catalog receipt digest 为 `sha256:4bb66be8eef541eaebde8e0ee56ad09225f6f288948365d08c00c9d3159ad700`。该 catalog receipt 把公开 revision 11 绑定到准确文件 SHA-256 `38a5414c2da581bf0014a2769c9842375b0d0822b77f89e5159b27b3042fc58e`。这些 receipt 只证明官方 rc.2 版本线的 stable Release、公开目录、runtime/update 与 composite 状态。

公开的 `main` 分支是持续移动的开发源码，不是 Release 坐标或 npm 发布。Alpha manifest 可发布，只是为了让准确且经过审查的 artifact 最终能以 `next` tag 进入公开 registry；源码状态不构成发布证据。npm package、GitHub Release、公开 Pages 目录或已完成 CI lane 的状态只由对应准确版本的 receipt 记录，绝不能从源码文件、workflow、repository setting 或本地测试中推断。

Release provenance 以 byte 为准。只有准确 `main` push 的 Node 22 CI job 上传的确定性 tarball、`SHA256SUMS` 和自摘要 pack attestation 可作为 Release 候选。CI verifier 会绑定 Actions archive digest、run id 与 attempt、只含三个准确 entry 的 ZIP payload、source commit、packed manifest、bundled pnpm tree 和 tarball byte；下载只允许固定 GitHub API，以及随后一次准入的 GitHub Actions 或 Azure Blob storage redirect。Runtime、公开 Release 与复合 receipt 都必须绑定同一个已 attested tarball。只有 receipt 为准确运行记录 Release immutability 或受保护 `v*` tag 后，它才能依赖这些控制；repository policy 不能替代任何具体 Release 的 receipt。

- [P0 产品规格与验收路径](docs/p0-product-spec.zh.md)
- [P0 product specification and acceptance path](docs/p0-product-spec.md)
- [能力发现与扩展商店研究](docs/capability-rag-research.zh.md)
- [Capability discovery and Extension Store research](docs/capability-rag-research.md)
- [目录发现、准入与签名](docs/catalog-operations.zh.md)
- [Catalog discovery, admission, and signing](docs/catalog-operations.md)
- [普通用户注册表安装与完整生命周期验收](acceptance/ordinary-user/README.zh.md)
- [Ordinary-user registry installation and lifecycle acceptance](acceptance/ordinary-user/README.md)
- [rc.2 签名离线商店验收](acceptance/store-only/README.zh.md)
- [rc.2 signed offline Store acceptance](acceptance/store-only/README.md)
- [基于官方 rc.2 的完整 P0 验收](acceptance/full-p0/README.zh.md)
- [full P0 acceptance on official rc.2](acceptance/full-p0/README.md)

Alpha 正在验证的兼容性目标是官方 `dsh-v0.1.2-alpha.1`，对应 commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`。仓库提供了一个源码 checkpoint 流程，会先构建官方 Client 与 Web 产物，再运行 Host 与浏览器；但目前没有 receipt 把一次已完成运行绑定到该源码 commit 和 Center artifact，因此该 checkpoint 仍是未经证明的开发输入。官方 GitHub prerelease tag 已存在但没有 asset，npm 也没有发布 `@deepseek-ai/dsh@0.1.2-alpha.1`。Stable Center `0.1.0` 仍是历史证据，只适配不可变的官方 `dsh-v0.1.1-rc.2`，对应 commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。

必需 CI context `Alpha package contract checkpoint` 只聚合源码、构建、测试和确定性 package 检查，不建立对官方 alpha runtime 的兼容性结论。只有受保护的 registry 普通用户 receipt 才能证明它所覆盖的生产 lane。

## Alpha 证据矩阵

截至 2026-08-28，以下状态严格按证据划分。`Pending`/RED 表示缺少必需的外部 receipt；存在源码、workflow、fixture、本地 archive 或 synthetic receipt 不会改变该状态。

| 证据项 | 必需证据 | 当前状态 |
| --- | --- | --- |
| 官方 rc.2 上的 stable `0.1.0` | 该版本准确的历史 Release 与 composite receipt | 已证明的历史版本：成功 run `33130950000`、artifact digest `sha256:7dbc3145…c2c0`、release-ready receipt `sha256:cdc27dfc…994`、public-catalog receipt `sha256:4bb66be8…d700`。它不能证明任何 alpha 坐标或 lane。 |
| 官方 alpha 源码 checkpoint | 把准确官方源码 commit、Center artifact、Host 与浏览器运行绑定在一起的受保护运行 receipt 与 artifact 绑定 | 未证明的开发输入；流程存在，但没有已完成受保护运行的 receipt。 |
| 官方 DSH npm 坐标 | 公开且不可变的 `@deepseek-ai/dsh@0.1.2-alpha.1` version 与 integrity | `Pending`/RED；npm 没有该版本，GitHub prerelease 也没有 asset。 |
| Center `0.2.0-alpha.0` bootstrap | 公开且不可变的 npm Release，以及单独授权的 bootstrap 与 provenance 证据 | `Pending`/RED；npm 中没有该 package。 |
| `@next` 下的 Center `0.2.0-alpha.1` | 公开且不可变的 npm Release、provenance、signature audit 与准确 tag 绑定 | `Pending`/RED；npm 中没有该 package 和 tag。 |
| Alpha catalog `r11→r12` | 经 receipt 授权的 r11 alpha bootstrap；覆盖 catalog 时间以及 operation、journal、inventory、configuration、material 与 owner state 的受保护 schema-2 生命周期证据；审查并签名的 r12 commit；Pages bytes；runtime refresh receipt | r11 前提已证明：stable receipt 授权准确公开 byte，alpha package 现已内置同一份 r11，准确前序 preflight 已通过。r12 生命周期、准入、审查、部署、刷新与 registry 证明仍为 `Pending`/RED。 |
| Plugin 生命周期 | 在未经修改的官方 DSH 上通过 registry 安装的 alpha artifact，以及类型化生命周期、恢复与移除 receipt | `Pending`/RED；没有 alpha 生产 receipt。 |
| MCP 生命周期 | 签名 alpha candidate、准确 Host runtime 配置、connection/tool 验证、恢复与移除 receipt | `Pending`/RED；没有 alpha 生产 receipt。 |
| Skill 生命周期 | 来自真实 Playwright UI 生命周期的受保护 receipt schema 3，以及对应 Actions artifact 绑定 | `Pending`/RED；runner 与 schema 检查已存在，但 registry 与 catalog 前提缺失。未来即使 `laneStatus: "proven"`，产品 `p0Status` 仍是 `red`。 |
| Agent 获取与 composite P0 | 与 Plugin、MCP、Skill receipt 交叉绑定的原任务续行 receipt | `Pending`/RED；必需的 alpha 输入与 composite receipt 都不存在。 |

## Alpha 普通用户门禁

生产命令只使用官方 DSH Plugin CLI 与 npm registry，不需要 checkout、tarball、自定义安装器或 Host patch。只有矩阵中的 registry 前提发布后，该命令才能使用：

```sh
npm install --global pnpm@11.21.0 @deepseek-ai/dsh@0.1.2-alpha.1
pnpm --version
dsh plugin --profile web add dsh-plugin-extension-center@next --ignore-scripts --save-exact
dsh plugin --profile web list --depth 0
dsh --profile web --dump-config
dsh web
```

`pnpm run test:acceptance:ordinary-user` 要求准确的 `pnpm@11.21.0`，在隔离目录中安装准确的官方 DSH 与 Center registry package，把 `@next` 解析并绑定到不可变版本与 integrity，字面执行标准 `dsh plugin ... add dsh-plugin-extension-center@next` 命令，再次解析 tag 以拒绝移动，验证安装、列举、组合 Bundle、从 `0.2.0-alpha.0` 更新到更高版本、真实 Host 与浏览器 Client、卸载，并确认独立安装的官方 DSH package tree 没有变化。仅有这些交付检查不能证明扩展中心管理。Receipt schema 3 使用同一个真实 Playwright page 选择 user scope，点击可见的 Review install 控件，编辑强类型 Skill 表单，审查并批准每个准确 plan，再通过可见生命周期控件执行 Configure、准确 Update、两次 Uninstall、已提交 Restore 与 Purge。Runner 观察认证 UI 发出的 mutation exchange；其验证 helper 只准入 catalog、inventory、configuration、operation 与 receipt verification 读取。每次写入都绑定不可变 plan、准确批准、terminal operation journal 与 receipt、artifact bytes、configuration revision 和 owner state。Purge 必须删除 managed bytes 与 rollback state，同时保留一条 `candidateRef: null`、不可恢复且重新开放 Install 的历史记录。直接 RPC mutation 会立即以 `ORDINARY-USER-MANAGEMENT-DIRECT-MUTATION` 失败；不完整的可访问 UI 序列会以 `ORDINARY-USER-MANAGEMENT-LIFECYCLE-MISSING` 失败；缺少经过签名的 alpha 前后版本时会记录 `ORDINARY-USER-MANAGEMENT-CANDIDATE-PENDING` 并保持 RED。受保护且完整的 Skill 运行可以报告 `laneStatus: "proven"`，但在单独的 Plugin、MCP 与 Agent 获取/续行证据完成交叉绑定前，产品 `p0Status` 仍保持 `red`。Registry mode 也会拒绝文件路径、tarball、URL、可变 Git ref、源码 launcher、缺少前序版本以及未发布 package。截至 2026-08-28，官方 DSH alpha、Center `0.2.0-alpha.0` 和 `@next` 指向的 Center `0.2.0-alpha.1` 都未出现在 npm，因此默认 lane 必须是 `Pending`/RED；本地 archive 或源码 checkout 不能替代它。

只有在所有官方 alpha 依赖都已公开后，才能通过受控流程首次发布 `0.2.0-alpha.0`。随后要把 npm Trusted Publisher 绑定到本仓库的 `npm-publish.yml` 和受保护的 `npm-alpha-publication` environment。在不可逆的 alpha.1 发布前，workflow 会下载 alpha.0、验证其 registry integrity、要求 `next` 指向 alpha.0 且 `latest` 保持缺失或稳定，并在仓库 workspace 之外的隔离项目中完成安装。它会先查询 alpha.1：版本不存在时只发布一次；已经存在且 byte 相同时跳过发布并继续后验；byte 不同时 fail closed。后验要求 `latest` 保持不变且不指向任何 alpha，获取 registry attestation bundle，把其中准确 SHA-512 subject 绑定到本仓库、受保护 main workflow、commit、run 与 attempt，并要求独立 npm 安装通过 `npm audit signatures`，其中不能有 invalid 或 missing entry。安装与审计网络请求都有明确的单命令、单 fetch 超时和最多三次准入 attempt；只有 registry/network 与 attestation propagation 失败会重试，invalid 或 missing signature 会立即停止。确定性且不含 secret 的 receipt 会把 package integrity 与 tarball digest、provenance bundle digest、source/workflow identity、发布与验证 attempt、准确 npm 版本和 audit verdict 与普通用户 receipt 一起保存在 publication artifact 中。恢复已发布版本时只接纳同一 GitHub Actions run lineage 中的更早 attempt；新的 dispatch 不能继承该 trusted-publication 结论。随后生产级普通用户 lane 才固定到同一准确版本和 integrity；workflow 不能创建尚不存在的 npm package，也不能把 Pending receipt 变绿。Trusted Publishing 的 OIDC 不授权 `npm dist-tag`；如果已发布的 alpha.1 不再占有 `next`，授权维护者必须交互式恢复 `next` 后重跑同一个 Actions run，workflow 绝不会重发这个不可变版本。

Alpha policy 只准入签名兼容性证据准确声明 DSH `0.1.2-alpha.1` 的候选。Package 内的 stable catalog 仍可用于审查，但其中 rc.2 候选在各自经过 alpha 测试并被签入 alpha catalog 前，对 mutation 必须 fail closed。普通用户完整证明还需要一对真实且不可变的更新前后版本；没有真实更新目标的单个 Skill 不能满足 receipt。Center 启动成功、可见的商店卡片或 synthetic receipt fixture 都不是扩展生命周期 receipt。

受保护的 alpha catalog 路径把该更新前后版本固定为 `microsoft/skills` `wiki-page-writer` 的两个准确 commit。成功 stable run `33130950000` 已证明公开 r11 byte，并授权把它从公开前序提升为 alpha package bootstrap。Alpha package 现已内置 byte-exact r11，`acceptance/alpha-catalog/preflight.mjs` 的前序检查已通过；这只关闭 r11 前提。随后，独立 lifecycle producer 仍必须在未经修改的官方 alpha 源码上，对临时、隔离的签名 r12 输入执行完整生命周期；admission workflow 才能重建同一份确定性 r12 并上传待 pull-request 审查。其 schema-2 receipt 会记录 catalog observation time，并把每项 operation 绑定到 operation、journal、inventory、managed、configuration、material 与 owner-state 证据。Producer 从当前受 TLS 保护的 GitHub HTTP `Date` 推导 catalog 时间，admission 复用 receipt 中的 observed 与 issued time，不再接受 dispatcher 提供的时间戳。这些源码控制不能证明任一受保护 alpha workflow 已运行。两个 workflow 都不会 commit 或 deploy 文档，`tests/support/alpha-catalog.ts` 也绝不会成为生产输入。r12 lifecycle run、catalog 签名提案、经审查的 commit、Pages 部署、runtime refresh 与 registry 普通用户 receipt 目前全部仍为 `Pending`；详见[目录运维](docs/catalog-operations.zh.md)。

## 安装已发布的 stable Release `0.1.0`

已发布的 `v0.1.0` GitHub Release 与以下坐标已由成功 post-publication run `33130950000` 和 release-ready receipt `sha256:cdc27dfcb5768b8fe14c082553b5120e98d050748015df0311d1e610edf27994` 覆盖。它们只属于历史官方 rc.2 版本线，不能证明 alpha 兼容性。应从不可变 GitHub Release asset 安装扩展中心，不能依赖移动分支或开发 checkout。官方 DSH Plugin CLI 会把 Profile package management 委托给 pnpm，因此 `PATH` 中必须存在 `pnpm`：

```sh
curl -fLO https://github.com/striveh/dsh-plugin-extension-center/releases/download/v0.1.0/dsh-plugin-extension-center-0.1.0.tgz
curl -fLO https://github.com/striveh/dsh-plugin-extension-center/releases/download/v0.1.0/SHA256SUMS
shasum -a 256 -c SHA256SUMS
dsh plugin --profile web add ./dsh-plugin-extension-center-0.1.0.tgz --ignore-scripts --save-exact
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

公开 `main` 只用于源码审查和开发。验证 Alpha 与官方 DSH source tag 的兼容性时，应锁定一个审查过的准确 commit，不能依赖移动分支：

```sh
dsh plugin --profile web add github:striveh/dsh-plugin-extension-center#<reviewed-commit-sha>
dsh --profile web --dump-config
dsh web
```

仓库提交确定性 `lib/` 构建产物，并且不声明 package lifecycle script，因此从 GitHub 安装时不会执行项目构建。扩展中心自身必须只通过这个官方 CLI 从外部安装、更新、降级或卸载；运行中的扩展中心不会自我修改。成功的 `0.1.0-rc.0` bootstrap 证明目录 `r8→r9`。不可变 rc.1 候选虽已部署 `r10`，但真实 rc.0 到 rc.1 的同 Profile 更新失败，未生成 composite receipt。恢复候选 rc.2 把 rc.0 作为最后一个成功前序，证明保留的 r8 cache 可以经 package 内置 r9 迁移到公开 r10，把 rc.1 记录为失败候选，并提供 stable 晋级所需的成功前序 receipt。Stable package 内置 `r10` 并提交签名 `r11`；成功的 post-publication run `33130950000` 及其准确 receipt 已证明该历史 Release 与部署。

开发与验证命令：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run verify:pack
pnpm run test:acceptance:store
node --test acceptance/ordinary-user/support.test.mjs
```

历史官方 rc.2 runner 属于准确的 stable `v0.1.0` 源码版本线，当前 alpha checkout 不能复用它的结论。Alpha 的生产门禁是 `pnpm run test:acceptance:ordinary-user`；在准确公开的 DSH package、两个 Center alpha package 与签名 alpha catalog 全部可用前，该命令应返回 `Pending`/RED。

证据与发布规则见[贡献指南](CONTRIBUTING.md)，私密漏洞报告路径见[安全政策](SECURITY.md)。

## 在线目录刷新

`catalogTrustedUrl` 只接受一个准确的 canonical HTTPS URL；Host 只接纳通过 package 固定签名根验证的完整 envelope。`catalogFetchTimeoutMs` 限制每次请求，`catalogRefreshIntervalMs` 控制可选后台刷新。启动、经浏览器会话认证的 `catalog/refresh` 动作、商店与任务 Capability RAG 共用同一份 admitted snapshot；Connection 会在 RPC 分发前执行 Host、Origin、Fetch-Site 检查和绑定 authority 的浏览器会话 cookie 验证，请求 payload 本身不携带 transport authority 或人工身份。商店检索文本与任务内容绝不会进入请求。Package 更新时，扩展中心先验证完整历史签名 cache，再原子提升到 package 内置 bootstrap；同 revision 或更高 revision 冲突、断链、签名漂移、文件畸形或持久化替换失败都会中止启动，历史前缀不会暴露给 Store 或 Agent。所有持久 cache 读取、比较与替换都通过扩展中心自有 writer reservation 在多个 DSH 进程间串行化；网络请求位于 reservation 外，writer 会重新读取权威 chain，较晚完成的旧刷新不能覆盖更高的已验证 tip。进程退出后 SQLite 自动释放 reservation，下一 writer 无需删除用户状态即可正常恢复。网络刷新失败或落后时只能继续使用未过期且已验证的 bootstrap 或 last-good snapshot，并报告 `source`、`freshness`、`degradedReason` 与 `lastRefreshAtMs`；snapshot 过期后 fail closed。

## Break-glass 扩展中心恢复

源码会把无依赖恢复 CLI 安装到 `$DSH_HOME/extension-center/recovery/<package-version>/<platform>-<arch>/break-glass.mjs`。恢复绑定 schema v5 与 official-execution binding v2 会固定该文件和 Center root，同时固定 canonical Node executable、版本与 digest，POSIX supervisor，私有 bundled `pnpm@11.21.0` package、registry SRI、完整 tree、entrypoint、shim 与 shell，以及准确官方 `0.1.2-alpha.1` package、构建后的 `lib/bin.js` entrypoint 与已安装 production-dependency closure。对已安装 Profile，扩展中心严格读取变更前的准确 `package.json`、`pnpm-lock.yaml`、`node_modules/.modules.yaml` 与引用的已安装 package manifest，再从这些本地事实合成 owner-only、content-addressed 的 pnpm 11 abbreviated/full metadata-cache generation。被绑定的 generation identity 覆盖 Profile digest、现有 canonical store、生成文件、固定 pnpm runtime 与 cache manifest；每次使用前都重新验证 manifest 与文件 digest。Binding 存入 Plugin provider recovery snapshot，因此正常 rollback 与独立 break-glass recovery 会验证并使用同一 generation。Cache 缺失、被更改、经由 symlink 替换或与 binding 不匹配时，会在下一次官方 CLI Profile 写入前 fail closed。执行期继续 offline 且禁用 lifecycle script；该 cache 不是网络预热，也不声称能获取不可用的 package byte。只有同时没有 lock 且没有 `node_modules` 安装的 Profile 才使用扩展中心私有的 per-Profile store。独立 process-group supervisor 会在 timeout 或 parent 丢失（包括 parent `SIGKILL`）后终止完整 mutation subtree；execution lease 会在该 subtree 仍存活时阻止 stale-lock reclaim。该变更与恢复路径只支持 macOS 和 Linux，在 Windows 上 fail closed。Provider apply 一旦开始，mutation recovery 不可用时会保留锁并进入 `recovery-required`，不会签发 failed receipt。启动会在 owner 初始化前读取 retired Center 与 owner sidecar 状态；仍被任一 projection 引用的 retired failed Plugin journal 会被隔离，缺少准确 target lock 时阻止可写激活。DSH 停止时，break-glass recovery 会验证 journal 绑定的 provider snapshot，只调用已绑定的官方 CLI 恢复准确 Profile before-state，验证结果后才提交 Center state。它绝不直接写入 Profile dependency、lock 数据、`node_modules`、Bundle membership 或 Loader row，也不导入已损坏的 Center runtime。后续官方 DSH 启动必须验证所选 Profile dependency、Loader contribution 与声明 consumer，恢复终态证据才有效。准确完整生命周期 receipt 记录待审查 Release artifact 的 packed break-glass 执行是否通过；源码本身不构成该主张。

## 许可证

[MIT](LICENSE)。DeepSeek Harness 与 DeepSeek 名称归各自权利人所有。
