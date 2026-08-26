# dsh-plugin-extension-center

[English](README.md) | 中文

[![CI](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml/badge.svg)](https://github.com/striveh/dsh-plugin-extension-center/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

这是一个独立社区插件项目，目标是为 DeepSeek Harness 提供本机统一扩展中心。P0 有两个一等获取入口：Agent 可以识别任务能力缺口并用本地 Capability RAG 检索准入候选，用户也可以在扩展商店中浏览、搜索、比较并自主获取同一目录里的扩展。两条路径汇合到同一个准入目录、政策、Host-owned transaction engine、owner 验证、inventory 与回执 schema；每项动作分别获得自己的准确不可变计划。每个可写目录候选还必须覆盖发现、安装、配置、准确更新、验证、卸载与失败恢复；只有扩展真实 owner 支持时才提供启用和停用。产品不合并 DSH Plugin、MCP Server 与 Skill 的生命周期，也不把“安装成功”冒充为“代码安全”。

本项目不是 DeepSeek Harness 官方 Release。产品代码、目录政策、测试、兼容性声明和 Release 都归本仓库所有；DSH monorepo 只作为宿主，不承载产品实现。

状态（2026-08-26）：独立项目已经实现签名离线商店、带未过期 last-good 缓存的可配置在线签名目录刷新、只产生线索的发现与 threshold-signing pipeline、归一化已安装 inventory、不可变计划与 loopback 人工批准、逐目标 journal 与恢复、Plugin/MCP/Skill 类型化 provider、任务优先的本地 Capability RAG、受信 MCP 配置队列，以及绑定原任务的持久续行。界面把商店获取与已安装对象的生命周期动作分开，并准确展示目录新鲜度、connection 与 artifact 的 ownership、权限、验证、恢复和回执。Host/Client focused tests、确定性目录 fault tests 与 rc.2 packed 只读浏览器验收已通过。新的 operation evidence 会锁定 package 自带的独立恢复 executable；它不加载 Center runtime 就能请求准确 Profile 恢复。已发布 rc.2 没有 Profile transaction `list`/`restore`/`restore-receipt` Consumer，因此这条路径会按设计 fail closed。已部署签名远端 revision 及其独立生成的准入 receipt、本地可写 Host 崩溃恢复、已发布 Release 安装、真实 provider 任务完成与普通用户可用性仍是独立发布门禁。

公开的 `main` 分支是开发源码预览，不是稳定 Release 或 npm 发布。Manifest 有意保留 `private: true`，用于在可写兼容版本仍为 `TBD` 时阻止误发 npm；这不限制采用 MIT 许可证的 GitHub 源码。只有已发布 Host 与下述外部 P0 门禁通过后，才能创建有效的 `v0.1.0` tag 或 Release。

- [P0 产品规格与验收路径](docs/p0-product-spec.zh.md)
- [P0 product specification and acceptance path](docs/p0-product-spec.md)
- [能力发现与扩展商店研究](docs/capability-rag-research.zh.md)
- [Capability discovery and Extension Store research](docs/capability-rag-research.md)
- [目录发现、准入与签名](docs/catalog-operations.zh.md)
- [Catalog discovery, admission, and signing](docs/catalog-operations.md)
- [rc.2 签名离线商店验收](acceptance/store-only/README.zh.md)
- [rc.2 signed offline Store acceptance](acceptance/store-only/README.md)

已审计的发布基线仍是不可变的 `dsh-v0.1.1-rc.2` Release。它支持只读商店 lane，但不包含三个新的可写 owner，因此永久保留为负兼容 lane。另一份本地 DSH HEAD 已实现 Profile transaction、dynamic MCP connection 与 durable task-continuation dispatch，供集成验收使用；它不是已发布 Release，也不改写 rc.2 历史。可写兼容版本保持 **TBD**，直到某个准确 DSH Release 发布这些 owner，并且同一 packed Bundle 在未经修改的该 Release 上通过 artifact、浏览器、恢复、生命周期与真实任务门禁。

## 开发版本检出

公开 `main` 只用于源码审查和开发。验证 rc.2 只读商店 lane 时，应锁定一个审查过的准确 commit，不能依赖移动分支：

```sh
dsh plugin --profile web add github:striveh/dsh-plugin-extension-center#<reviewed-commit-sha>
dsh --profile web --dump-config
dsh web
```

仓库提交确定性 `lib/` 构建产物，并且不声明 package lifecycle script，因此从 GitHub 安装时不会执行项目构建。已发布 DSH `0.1.1-rc.2` 必须把生命周期操作显示为不可用；不能把本地可写 Host 的结果作为已发布兼容声明。

开发与验证命令：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run pack:preview
pnpm exec playwright install chromium
pnpm run test:acceptance:store
pnpm run test:acceptance:host-negative
```

本地可写 Host lane 还要求另一份已构建且具备全部六项 owner 的 DSH checkout，它只构成该准确 checkout 的发布证据。证据与发布规则见[贡献指南](CONTRIBUTING.md)，私密漏洞报告路径见[安全政策](SECURITY.md)。

## 在线目录刷新

`catalogTrustedOrigin` 只接受一个 canonical HTTPS origin；Host 始终请求固定 `/plugins.json` 路径，并且只接纳通过 package 固定签名根验证的完整 envelope。`catalogFetchTimeoutMs` 限制每次请求，`catalogRefreshIntervalMs` 控制可选后台刷新。启动、loopback `catalog/refresh` 动作、商店与任务 Capability RAG 共用同一份 admitted snapshot。商店检索文本与任务内容绝不会进入请求。刷新失败时只能继续使用未过期且已验证的 bootstrap 或 last-good snapshot，并报告 `source`、`freshness`、`degradedReason` 与 `lastRefreshAtMs`；snapshot 过期后 fail closed。

## Break-glass Profile 恢复

Host 启动时会把构建后的无依赖恢复 CLI 原子复制到 `$DSH_HOME/extension-center/recovery/<package-version>/<platform>-<arch>/break-glass.mjs`。每个已消费 operation 都会记录该准确绝对路径与 SHA-256、公开 DSH CLI 的准确路径与 SHA-256，以及 canonical Host home。如果 Center 或 Web 无法加载，可运行 `node <pinned-break-glass.mjs> <center-root> <operation-id>`。它先验证自身 bytes、Host CLI bytes、canonical Host home、journal chain、`CURRENT` head、plan evidence 与任何已有 receipt。Host 调用只会在 scrubbed environment 中把锁定的 home 注入为 `DSH_HOME`；ambient `DSH_HOME` 不能选择另一个 Profile store。随后它以已验证 operation id 推导的确定性 mutation identity 查询 Host 的确切 Profile restore receipt。committed receipt 必须匹配 journal generation/tree pin，并且当前 inventory 必须是 receipt 的准确 after-snapshot，或从该 snapshot 产生的唯一合法 boot-acknowledgement transition；任何无关 drift 都会被拒绝。只有 `not-found` 才允许校验当前 selector 并调用新 restore。因此即使恢复后的 generation 已被 acknowledge，响应丢失或调用方被杀死后的重试也不会发布第二次 transition。它不导入 Center runtime，也不直接写 Profile。成功只表示 `profile restored; Center journal reconciliation pending`；仍需在 Center 恢复启动后对保留 journal 做 reconciliation。

不可变 rc.2 Host 是负向 lane：其通用 `dsh plugin` 只转发 pnpm 参数，不实现准确 JSON `list`、generation `restore` 与 mutation-bound `restore-receipt` 协议，因此恢复会 fail closed，且不会声称已恢复。完整恢复仍以未来已发布 DSH Release 提供该公开 Profile transaction Consumer，并通过 packed crash-path 验收为门禁。

## 许可证

[MIT](LICENSE)。DeepSeek Harness 与 DeepSeek 名称归各自权利人所有。
