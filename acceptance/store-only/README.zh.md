# 最新版官方 DSH 签名离线商店验收

[English](README.md) | 中文

这是 [P0 Gate B](../../docs/p0-product-spec.zh.md) 的已实现非变更式商店检查纵切。它是非 xfail 的外层黑盒命令。通过它会证明下述 packed 最新版官方 DSH 签名离线商店旅程；完整 Plugin、MCP、Skill、Continuation、恢复与任务要求由[完整 P0 验收](../full-p0/README.zh.md)定义。

## 准确目标与交付形式

- 插件形式：独立、可安装的 Host+Client Bundle。
- Host package：准确 `@deepseek-ai/dsh@0.1.2-alpha.3`。
- 已审计 Host source：准确 commit `dd6322d604e00eec1ba5e0c8541159906a21094a`（`dsh-v0.1.2-alpha.3`）。
- 产品输入：从本仓库重新执行 `pnpm pack` 得到的 tarball，绝不 import `src/`、旁边的 checkout 或 Vite development server。
- 运行环境：空的临时 DSH/Agents home、本地 tarball 安装到 Web Profile、真实配置组合、真实 Web 启动和 headless Chromium。

## 运行

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run test:compat:latest
```

`pnpm test` 会构建 Host 与 lazy-CJS Client artifact，验证目录签名与 fail-closed 解析，测试源码 UI 状态，验证已构建 Client ABI 与卸载行为，并检查确定性 runner helper。`pnpm run test:compat:latest` 只有在最终 tarball 通过官方 CLI 安装、提供唯一一级**扩展**按钮与唯一具名且默认打开商店的对话框、完成不提交写请求的经过验证目录旅程，并通过同一个官方 CLI 移除后才能以零退出。

浏览器 lane 要求打包后的 Host 验证 Ed25519 bootstrap 目录，Client 再通过私有 loopback channel 读取它。随后验证两个锁定版本的 Plugin 候选、两个锁定版本的 MCP Server 候选、三个锁定版本的 Skill 候选、本地文本搜索、类型筛选、三项比较，以及准确 integrity/配置/激活披露。Plugin 与 Skill 显示生命周期入口 UI；该 lane 打开一个具名 Skill 计划草稿、检查焦点，然后在不提交授权和 mutation 的情况下关闭。它不证明任一入口可以完成生命周期。每个准确 MCP `candidateRef` 都必须拥有自己的禁用卡片入口、禁用详情入口以及五项 unavailable 生命周期披露，直到 Host 为该版本配置一个准确准入的 runtime；receipt 会从这些实际观测卡片生成两项 unavailable 记录。它还要求一个具名 tablist、四个正确关联的 tab 与 panel、默认 Store 选中、click 与 Arrow/Home/End 导航、排除隐藏 panel 的焦点约束、Escape 关闭和焦点返回，以及重新打开后恢复默认 Store。

最新版已审查官方 DSH Connection carrier 使用 HTTP POST 承载 unary read，并使用认证 `/api/remote.mux` WebSocket 承载只读 stream。从 `page.goto` 前一刻直到 Chromium context 关闭，lane 只允许协议版本准确的 `catalog/list`、`inventory/list`、固定 bootstrap MCP 且 `operationKind: install` 的 `configuration/options`、`operation/list`、`operation/receipts`、`approval/list` 与 `task-attempt/list` envelope，且路径必须匹配 `/dsh-extension-center/<method>`；其他任何 Extension Center 非读 request 都会失败。WebSocket 只允许 `$events`、`workspace/follow` 与 `session/control` 的准确空参数 open，以及对本次 browser session 已打开 stream id 的 cancel；其他 frame 都会失败。Runner 会在 navigation 前对 Center-owned 状态树取 hash，并在 context 关闭后再次验证，因此 client mount 和延迟到关闭时的 mutation 不能落入未观测的 baseline 或尾部。Runner 会先生成并校验产品 tarball，再开启拒绝 proxy；从官方 `dsh --version` 检查开始，官方 CLI 安装、Profile 组合、Web 启动与 browser 交互期间的任何 proxy-aware Host request 都会让该 lane 失败。验收 Profile 会省略 `catalogTrustedUrl`，因此该 lane 只读取随包签名 bootstrap；可安装 Bundle 仍保留已发布在线目录作为默认值。任何 acquisition intent 或 plan request、外部 browser request、可变 Center-managed 状态变化、console warning/error 或 secret-canary evidence也会失败。schema-6 receipt 要求打包前的源码树干净且已提交，绑定 Git tree 与验收程序字节，在 teardown 后复核同一绑定，并同时要求 Web 直接子进程关闭与 POSIX 进程组停止。它会记录最后执行阶段，并在最终证据发现额外违规时保留此前失败。原始首次 Red artifact 只保留一次，位于 `.artifacts/acceptance/store-only-original-red/`；当前每次运行都会在 `.artifacts/acceptance/store-only/` 写入 receipt、packed tarball、组合配置、Host log、ARIA snapshot、商店截图、比较截图与详情截图。

## 当前证明边界

通过的 receipt 把自身范围标记为 `latest-official-dsh-unmodified-host-offline-store-ui`，并报告 `p0Status: store-ui-smoke-proven`。Focused tests 与 packed acceptance evidence 共同证明准确 packed artifact 通过官方 CLI 安装和移除、在隔离的准确官方 Host package 上加载、Host 签名验证、Client 严格响应校验、上述本地发现旅程、一个未提交的生命周期草稿、Store 交互期无观测变更，以及官方 DSH package tree 未被改动。该纵切不证明在线目录刷新、授权提交、受管子扩展生命周期变更、任务驱动获取、provider E2E、恢复执行、原任务续行、公开 Release 安装或完整可访问性矩阵。

网络证据由 browser routing 与 proxy-aware Host ledger 共同构成，还不是覆盖每种第三方 transport 的 kernel-level network jail。完整的隔离 DSH home、Agents home、workspace 与 Profile 比较从官方 onboarding 完成后开始，到 context 关闭后结束；另一项独立 Center-owned 状态比较从 page navigation 前开始。两项比较都会排除已安装且不变的 `node_modules` 树。
