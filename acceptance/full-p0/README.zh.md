# 基于最新版官方 DSH 的扩展候选全生命周期 P0 验收

[English](README.md) | 中文

本目录规定独立扩展中心的可写候选全生命周期 receipt；它不是当前最新版 DSH 兼容门禁。

## 当前状态

该扩展 lane 仍为 `Pending`/RED：不可变的 package bootstrap 包含此前在 rc.2 上准入的候选，而当前 policy 正确要求 alpha.3 候选证据。不得重标版本或在本地重签这份历史目录。`pnpm run test:compat:latest` 运行 [`../store-only`](../store-only/README.zh.md) 中已经实现的 packed artifact、官方 CLI、真实 Host+Client 商店兼容 lane；这份兼容 receipt 可以独立于未来的可写候选 lane 通过。

## 准确目标

- 官方 Host：来自 `https://registry.npmjs.org/` 的 `@deepseek-ai/dsh@0.1.2-alpha.3`。
- 已审计源码身份：tag `dsh-v0.1.2-alpha.3`，commit `dd6322d604e00eec1ba5e0c8541159906a21094a`。
- Center 分发：由 `pnpm run verify:pack` 生成的本地确定性 `.tgz`。把 Center 发布到 npm 既不是前置条件，也不是本 receipt 的结论。
- 通用安装路径：`dsh plugin --profile web add <packed-center-绝对路径> --ignore-scripts --save-exact`。
- 所有权：官方 DSH 拥有 Profile dependency、lock、`node_modules`、Bundle membership 与 Loader row；扩展中心拥有目录、plan、grant、journal、receipt、保留 artifact、MCP desired state、Skill 物料、恢复编排与 continuation claim。

扩展中心不管理自身安装。用户只能通过官方 `dsh plugin --profile web ...` 命令更新、降级或卸载它。

## alpha.3 候选完成准入后的未来运行方式

```sh
node acceptance/full-p0/verify-latest-dsh.mjs
```

所有必需候选都具备受保护且经审查的 alpha.3 准入证据后，runner 才会创建隔离的官方 DSH 安装，打包当前 Center，通过官方 CLI 安装，启动真实 Web Host 与浏览器 Client，运行可写生命周期，再通过官方 CLI 移除 Center，并写出：

```text
.artifacts/acceptance/full-p0-latest-dsh/receipt.json
```

修改过的 Host package、workspace import、未打包的 Center 源码、仅 mock 的 runtime、移动 package reference、继承的 provider credential，以及不在准入 fixture origin 内的产品运行期网络访问都会被拒绝。

## 必跑旅程

终态 receipt 绑定准确 Center tarball、官方 DSH package identity 与 integrity、catalog revision、隔离状态根、plan digest、operation journal 和终态 receipt。它证明：

1. 商店搜索与任务驱动 Capability RAG 使用同一份已验证签名目录，并产生绑定候选的不可变 plan。
2. 每次变更都等待未过期、一次性、loopback 人工授权。
3. Child Plugin 完成安装、配置、更新、回滚、卸载、恢复与清除；所有 Profile membership 变更都通过官方 Plugin CLI。
4. MCP connection 通过官方 MCP Client 集成完成配置、启用、握手与 Tool 可见性、更新、禁用、恢复、移除与清除。
5. Skill 通过官方 Skill registry 完成安装、配置、registry 可见性、更新、禁用、启用、恢复、卸载与清除。
6. 任务来源获取只 replay 模型响应这一条边；真实 Agent、Session log、Tool dispatch、受管 Skill、continuation claim 与 exactly-once 原任务续行路径正常执行。
7. 故障注入、受控外部 CLI ABA 与 packed break-glass recovery 保持 journal 完整，并且只恢复已批准 target。
8. 通过官方 CLI 移除 child Plugin 与 Center 后，除声明的 Profile package-manager 状态外，官方 DSH package tree 逐字节保持不变。

## 证明边界

未来通过后，receipt 的 `p0Status` 为 `latest-dsh-lifecycle-proven`，`releaseClaim` 为 `latest-official-dsh-compatible`。在这份 receipt 存在前，不作可写候选全生命周期已证明的主张。该 receipt 只会证明其中准确 packed Center、准确官方 DSH release 与所列平台，不证明其他 DSH release、未测试平台、不同 Center 版本更新、任意第三方安全性、所有可能的进程交错或 live-provider 行为。
