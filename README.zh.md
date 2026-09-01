# DSH 统一扩展中心

[English](README.md) | 中文

这是面向官方 DeepSeek Harness 的独立 Host+Web 插件。它在不修改、不 fork DSH 的前提下增加一个统一扩展中心。

## 产品范围

扩展中心为用户和 Agent 提供一条统一的 Plugin、MCP connection 与 Skill 管理路径：

- 从本机已验证的签名目录发现能力，既支持商店搜索，也支持任务驱动 Capability RAG；
- 在变更前展示来源、准确物料身份、权限、依赖、配置、冲突、重启要求与验证证据；
- 通过强类型生命周期完成安装、配置、更新、启用/禁用、恢复、卸载与永久清除；
- 保留不可变 plan、一次性人工授权、journal、receipt、rollback point 与 break-glass recovery 证据；
- Agent 因任务请求能力时，在安装并验证后向原任务 exactly-once 续行。

Agent 可以自主识别并排序候选，但不能向变更 Tool 提供 package coordinate、URL、command、credential 或 approval。Host 只从签名目录和当前 inventory 解析这些事实；每一项具体写操作都由用户单独授权。

## 兼容目标

当前已审查目标是未经修改的官方 DSH `0.1.2-alpha.3`：tag `dsh-v0.1.2-alpha.3`，commit `dd6322d604e00eec1ba5e0c8541159906a21094a`。插件只使用该版本公开的 Bundle patch、Host Connection RPC、Client Connection RPC 与 Web slot 接口。

把本插件发布到 npm 不是完成条件。受支持的交付物是本仓库生成的确定性 tarball，并通过官方通用 Plugin CLI 安装。官方 DSH 始终是外部、未经修改的依赖。

## 像普通用户一样安装

安装当前官方 DSH，并确保 `pnpm` 在 `PATH`：

```sh
pnpm add --global @deepseek-ai/dsh@0.1.2-alpha.3
```

下载或构建 GitHub 上的 Center tarball，再使用普通 Plugin 命令安装：

```sh
dsh plugin --profile web add /绝对路径/dsh-plugin-extension-center-0.2.0-alpha.1.tgz --ignore-scripts --save-exact
dsh web
```

从源码 checkout 生成相同的用户交付物时，不把源码目录直接安装进 DSH：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run verify:pack
```

Tarball 位于 `.artifacts/release-candidate/`。在 registry channel 出现前，更新就是添加准确的新 tarball；卸载仍使用同一个官方 Profile package manager：

```sh
dsh plugin --profile web add /绝对路径/dsh-plugin-extension-center-更新版本.tgz --ignore-scripts --save-exact
dsh plugin --profile web remove dsh-plugin-extension-center
```

## 验证

```sh
pnpm test
pnpm run verify:pack
pnpm run test:compat:latest
```

`test:compat:latest` 会构建并打包 Center，通过标准 Plugin CLI 安装到隔离的官方 DSH `0.1.2-alpha.3` Web Profile，启动真实 Host 与浏览器 Client，验证商店界面与 Connection RPC，并确认官方 DSH package tree 未被改动。Receipt 写入 `.artifacts/acceptance/store-only/receipt.json`。

随包签名 revision 11 目录是历史 rc.2 数据，保持不可变。它可以安全用于离线查看，但不会被悄悄改写成 alpha.3 兼容。Alpha.3 child candidate 的可写生命周期必须拥有各自经过审查的签名准入 receipt；在此之前 UI 会 fail closed。这个限制不阻止证明独立 Center 本身可通过官方方式安装并运行在最新版 DSH 上。

## 架构与产品契约

- [P0 产品规格](docs/p0-product-spec.zh.md)
- [纯插件架构](docs/plugin-only-architecture.zh.md)
- [目录发现与运维](docs/catalog-operations.zh.md)
- [最新版 DSH 兼容性验收](acceptance/store-only/README.zh.md)
- [扩展完整 P0 生命周期门禁](acceptance/full-p0/README.zh.md)
- [安全策略](SECURITY.md)
- [发布历史](CHANGELOG.md)

任何受支持路径都不会修改官方 DSH 源码或 package 文件，不会直接写 Profile package-manager 状态，也不要求 Host PR。
