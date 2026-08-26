# 完整 P0 Host Owner Acceptance Red

[English](README.md) | 中文

本目录负责从签名商店走向可写 P0 的不可变已发布 Host 负向通道。Runner 把最终 Extension Center tarball 安装到准确当前已发布 Host 的隔离 Web Profile，启动真实 Web Host，通过唯一一个通用 Connection RPC 读取已验证目录，并在不发送写请求的前提下检查全部六项必需 Host owner。

## 准确目标

- Extension 形态：由 `pnpm pack` 生成、作为 Host+Web Client Bundle 安装的 tarball。
- Host package：来自本项目已安装依赖的准确 `@deepseek-ai/dsh@0.1.1-rc.2`。
- 已审计 Host source：commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（`dsh-v0.1.1-rc.2`）。
- 按稳定顺序要求的 owner：Profile transaction、dynamic MCP connection、durable continuation、Skill registry、Tool registry 与 Loader observation。

当前 Host 有意作为负兼容基线。它的第一个稳定产品失败是：

```text
P0-RED-HOST-PROFILE-TRANSACTION-OWNER-MISSING
```

## 运行

```sh
node --test acceptance/full-p0/support.test.mjs
node acceptance/full-p0/host-owner-gate.mjs
DSH_LOCAL_HEAD_ROOT=/absolute/path/to/deepseek-harness-host pnpm run test:acceptance:local-head
```

Support suite 必须以零退出。`host-owner-gate.mjs` 当前必须以上述稳定失败非零退出，并写入 `.artifacts/acceptance/full-p0-host-owner-gate/receipt.json`。缺失 tarball role、Host 启动损坏、RPC 响应畸形、外部请求、状态变化或 teardown 失败都是 `invalid`，不是预期产品 Red。

## 只读 preflight

Packed artifact 安装是观测开始前完成的隔离 setup。真实 Host 报告 ready 后，Runner 对可变 DSH home、Agents home、workspace 与 Profile 状态计算摘要，并排除依赖树。然后只发送一个请求：

```text
POST /dsh-extension-center/catalog/list
method = catalog/list
payload = { "protocolVersion": 1 }
```

相关联响应必须展示已验证的签名目录 revision 与六个 owner boolean。Runner 随后重新计算同一状态的摘要，并要求可变状态逐字节相同。Provider credential 与 endpoint override 会被移除，telemetry 被禁用，遵守代理的非 loopback Host 流量会被记录并拒绝。Runner 不发送 acquisition、intent、plan、confirmation、install、configure、update、uninstall 或 restore method。

## 证明边界

未来通过本 lane 只证明 packed Extension Center 能在准确 Host artifact 上观察六项 readiness gate。Boolean 存在不是 owner 行为证据，也不能让完整 P0 转绿。Profile generation promotion/rollback、实时 MCP tool-generation ownership、durable single-use cross-restart continuation、生命周期动作、任务获取、恢复、package 更新/移除与真实 provider task 都需要各自的 Acceptance lane。

最终 P0 兼容声明必须针对准确已发布、同时提供并在行为上证明六项 owner 的 DSH release。Moving branch 或本地 Host checkout 不能替代该 Release lane。

## 本地 HEAD 正向通道

`verify-local-head.mjs` 是独立的开发态 receipt，不替代不可变的已发布 Host 通道。`DSH_LOCAL_HEAD_ROOT` 是必填项，必须指向本次接受验证的准确 checkout；Runner 不会回退到相邻的其他仓库。它只读取该 DSH checkout，不修改该项目；要求 CLI 与 owner package 已构建，要求 CLI realpath 保持在该 canonical checkout 内，并要求 format-v2 repository build record 通过匹配的源码内容与身份观测，把当前 checkout 绑定到当前 Host-side `lib` 产物。该通道会在开始前及生命周期结束后分别验证记录，并要求准确 record bytes 的 SHA-256 保持不变，同时记录准确 commit、dirty entry 数量与状态摘要。它拒绝声明 package `bin` 的 packed Center，把 packed Center 通过 Profile transaction CLI 和一个固定的调用方 mutation identity 安装到隔离 DSH/Agents/home 目录，并启动真实 Web Host。随后它探测六项 owner，并对固定 Skill 依次执行 install、configure、disable、enable、uninstall、restore、purge 前必需的再次 uninstall、purge；每一步都检查准确 single-use Store preview、approval、lifecycle、receipt 与 inventory。该通道同时检查互相独立的 inventory 状态、调用配置、真实 merged-registry winner、准确托管物料与 purge 后物料不存在。对于八项终态 operation，它会独立重算 immutable plan digest、计算每份 canonical receipt body 的 hash、交叉绑定 extension kind 与 operation kind、验证 durable inventory 中的唯一性、获取完整 operation、重算每个 journal event 与链接，并把终态 checkpoint 和 projection 绑定到返回的 receipt。Receipt 还会报告通过的稳定门槛与必需 owner predicate 的准确数量。缺少 build 输出、owner 不可用、acquisition 被拒、receipt 非 committed 或语义不一致、Web Host 提前退出、物料不匹配都会 fail closed，并留下 `.artifacts/acceptance/full-p0-local-head/receipt.json` 与脱敏日志。

隔离的内容寻址缓存没有物料时，本通道需要访问签名目录中准确固定的 Skill URL。签名目录没有提供该 Skill 的第二个 revision，因此 update 在此仍明确标记为未证明，只由 unit/fault 通道覆盖。Runner 会移除 provider credential 与 provider endpoint override、关闭 telemetry、不启动模型任务，并且只通过直接 HTTP Connection RPC 操作 Web Host；它不会加载或观测浏览器 Client/UI，也不执行 break-glass Profile `restore-receipt` 路径。Build record 只提供非对抗性端点检测，不提供编译器消费这些源码 bytes 的不可变或因果证明。通过仅证明该本地 Host checkout 与 packed artifact；已发布安装、浏览器 Client/UI 观测、break-glass 恢复、Plugin restart、真实预置 MCP runtime、真实模型任务续行、provider E2E、因果构建来源和平台矩阵仍需独立证据。
