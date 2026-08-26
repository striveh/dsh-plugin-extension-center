# rc.2 签名离线商店验收

[English](README.md) | 中文

这是 [P0 规格](../../docs/p0-product-spec.zh.md#acceptance-red-b用户自主扩展商店)中通往 Acceptance Red B 的已实现只读发现纵切。它是非 xfail 的外层黑盒命令。通过它会证明下述 rc.2 签名离线商店旅程，但不会让 Acceptance Red B 或可写 P0 转绿。

## 准确目标与交付形式

- 插件形式：独立、可安装的 Host+Client Bundle。
- Host package：准确 `@deepseek-ai/dsh@0.1.1-rc.2`。
- 已审计 Host source：准确 commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（`dsh-v0.1.1-rc.2`）。
- 产品输入：从本仓库重新执行 `pnpm pack` 得到的 tarball，绝不 import `src/`、旁边的 checkout 或 Vite development server。
- 运行环境：空的临时 DSH/Agents home、本地 tarball 安装到 Web Profile、真实配置组合、真实 Web 启动和 headless Chromium。

## 运行

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:acceptance:store
```

`pnpm test` 会构建 Host 与 lazy-CJS Client artifact，验证目录签名与 fail-closed 解析，测试源码 UI 状态，验证已构建 Client ABI 与卸载行为，并检查确定性 runner helper。`pnpm test:acceptance:store` 只有在最终 tarball 提供唯一一级**扩展**按钮、唯一具名且默认打开商店的对话框，以及经过验证的目录旅程时才能以零退出。

浏览器 lane 要求打包后的 Host 验证 Ed25519 bootstrap 目录，Client 再通过私有 loopback channel 读取它。随后验证准确各一个锁定版本的 Plugin、MCP Server 与 Skill 候选、本地文本搜索、类型筛选、三项比较、准确 integrity/配置/激活披露，以及每个候选禁用的获取动作。它还要求一个具名 tablist、四个正确关联的 tab 与 panel、默认 Store 选中、click 与 Arrow/Home/End 导航、排除隐藏 panel 的焦点约束、Escape 关闭和焦点返回、重新打开后恢复默认 Store、`unavailable(host-capability)`，以及原生 disabled 的安装、配置、更新、卸载与还原控件。

rc.2 通用 Connection carrier 使用 HTTP POST 承载 unary read，因此 lane 只允许协议版本准确的 `catalog/list`、`inventory/list`、固定 bootstrap MCP 的 `configuration/options`、`operation/list`、`operation/receipts`、`approval/list` 与 `task-attempt/list` envelope，且路径必须匹配 `/dsh-extension-center/<method>`；其他任何同源非读 request 都会失败。任何 acquisition intent 或 plan request、browser WebSocket frame、外部 browser request、遵守 proxy 的 Host request、可变 Host/Profile 状态变化、console warning/error 或 secret-canary evidence 也会失败。原始首次 Red artifact 只保留一次，位于 `.artifacts/acceptance/store-only-original-red/`；当前每次运行都会在 `.artifacts/acceptance/store-only/` 写入 receipt、packed tarball、组合配置、Host log、ARIA snapshot、商店截图、比较截图与详情截图。

## 当前证明边界

通过的 receipt 把自身范围标记为 `rc2-signed-offline-store-slice`，并保留 `p0Status: not-proven`。Focused tests 与 packed acceptance evidence 共同证明在未修改已发布 Host 上加载 packed artifact、Host 签名验证、Client 严格响应校验、上述本地发现旅程，以及 Store 交互期无观测变更。Receipt 自身覆盖打包后的正向旅程与交互 guardrail，focused tests 覆盖篡改、过期和畸形响应拒绝。两类证据都没有实现或证明实时目录摄取或刷新、归一化 inventory、任何生命周期 provider、任务内自主获取、受管记录持久化、还原执行、真实 provider 行为、Release 安装或完整可访问性矩阵。

网络证据由 browser routing 与 proxy-aware Host ledger 共同构成，还不是覆盖每种第三方 transport 的 kernel-level network jail。可变状态比较会排除已安装且不变的 `node_modules` 树，覆盖隔离的 DSH home、Agents home 以及该依赖树以外的 Profile 文件。
