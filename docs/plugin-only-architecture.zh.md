# 纯插件架构

本文定义扩展中心适配 DeepSeek Harness `0.1.1-rc.2` 的实现边界。正在验证的兼容性目标是未修改的官方源码 `deepseek-ai/deepseek-harness@b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` 及其已发布的 `0.1.1-rc.2` 包。

## 产品边界

DSH 始终是官方 Host。扩展中心是一个独立安装的 DSH Bundle，不得依赖 DSH 源码补丁、仅存在于 fork 的包或官方 Host PR。Host 半端、Web Client 半端、目录发现与准入、计划与授权、journal 与 receipt、验证、恢复编排、续行和验收测试全部由本仓库发布。

扩展中心自身只能通过官方外部命令 `dsh plugin --profile <profile> ...` 安装、更新或卸载；正在运行的扩展中心不得替换或卸载自己。

通过扩展中心获取的扩展使用扩展中心自有控制记录与按类型区分的物理 owner：

- 扩展中心会暂存、验证并保留准确的准入 Plugin archive，拥有已授权 operation、journal、receipt、恢复选择与验证证据。每个已准入 child Plugin Bundle（无论是 Host-only 还是 Host+Client）的 package membership 变更都使用官方 `dsh plugin --profile` CLI；只有官方 Profile package manager 可以写入 dependency、lock 数据、`node_modules`、Bundle membership 与最终 Loader row。纯配置通过官方 Loader 替换准确受管 row，并在同一个 Host 进程完成验证。扩展中心绝不直接写 package-manager 位置，也不修改官方 DSH 代码。安装、更新、卸载和恢复必须等后续 Host boot 验证准确官方 Profile dependency、Loader contribution 与声明 consumer 后，才能签发成功终态。
- MCP connection 由扩展中心自有的持久化 desired-state provider 管理。启用记录挂载官方 `@deepseek-ai/dsh-mcp-client`；禁用、更新、移除、恢复和永久清除只处置扩展中心拥有的 Fiber 与记录。
- Skill 继续由扩展中心拥有文件和记录，并通过官方 `ctx.skills` registry 投影；作用域和调用开关仍是 Skill 独有状态。
- 原任务续行由扩展中心自有的持久化 claim store 与官方 Agent、Session、持久化服务完成。通过验证的一次性 claim 只能恢复原 Session，且不保留原任务文本。

Plugin、MCP 和 Skill 的状态保持独立；商店发现、策略、审阅、授权、收据和恢复仅共享同一个产品界面。

## 官方扩展点

实现只能依赖 rc.2 的公开行为：

- 官方 `dsh plugin --profile` CLI，用于每个已准入 child Plugin Bundle 的安装、更新、降级与移除。
- Cordis Loader 的公开配置与观测方法，用于应用并验证 Profile-managed Plugin contribution 的纯配置，绝不直接安装 package。
- `ctx.tools` 与 `ctx.skills` 的注册及随 Fiber 释放的 disposer。
- `@deepseek-ai/dsh-mcp-client`，用于一个已准入 MCP connection 的运行时。
- `ctx.agentPresets`、`ctx.agents`、Session、Session 持久化以及公开 Agent/Session lifecycle event，用于同一 Session 的续行与 reconciliation。
- `@deepseek-ai/dsh-client-connection` 的仅 loopback RPC channel，以及扩展中心 UI 的 `dsh.client` Web Bundle 声明。

缺少任一服务时，扩展中心必须用准确 capability projection 拒绝获取；不得转而安装 Host 补丁。

## 所有权与恢复

每项动作都有且只有一个扩展中心自有 operation record、单调 revision、不可变已批准 plan、逐 target 锁、append-only journal、验证结果和内容寻址 receipt。扩展中心的 archive 存储采用私有目录、no-follow 读取、canonical path、排他创建和原子 pointer 替换。调用官方 Plugin CLI 之前，扩展中心会对已观测的 Profile dependency 加 revision fence，并拒绝外来或已漂移 target。官方 Profile package manager 始终是 dependency、lock、`node_modules`、Bundle membership 与 Loader row 的物理 owner。rc.2 外部 CLI 不向扩展中心提供 lock 或 compare-and-swap token，因此逐 target 锁只能串行化 Center operation。验收会运行一个受控的外部 CLI ABA 顺序，并要求进入 `recovery-required` 而不是虚假成功；该 receipt 不声称覆盖所有可能的进程交错。

Catalog 与 owner revision 在已批准 plan 被消费前充当实时准入 fence。消费会生成持久执行授权。此后的 provider 执行、重启收敛、回滚与 break-glass 对账只依赖已消费 plan 与 authorization、准确持久 intent payload、journal 和 provider snapshot。即使导致变更前失败的 intent 已不可用，终态 receipt 补全与 target lock 释放仍只使用已消费 plan、authorization 与终态 journal；task continuation bookkeeping 会在 intent payload 可读时单独重试。Plugin rollback 会先验证准确恢复状态，再持久化终态 receipt，随后删除临时 absent-state proof，最后释放 target lock。每次删除权威 record 都必须先同步其父目录，才能进入下一个 lifecycle phase；同步失败会明确报错，并保留 operation fence 供启动恢复。Receipt 已持久化时，启动恢复会重试 proof 删除；缺少 receipt 且 provider proof 不可用时必须保留锁。后续 catalog revision 或候选删除不能阻断已授权回滚。Catalog 删除不是紧急撤销机制。

独立恢复程序由本包拥有并进行 hash pin，不依赖 Center 或 Host 成功启动。恢复绑定 schema v5 内含 official-execution binding v2：它固定 recovery bytes 与 Center root、canonical Node executable/版本/digest、本包自有 process-group supervisor、私有 bundled `pnpm@11.21.0` 的 registry SRI/完整 tree/entrypoint/shim/POSIX shell，以及准确官方 rc.2 package、entrypoint、`hostHome`、timeout 与递归解析的已安装 production-dependency closure。正常 mutation 与独立恢复都会验证全部 pin，要求准确官方 Profile workspace，拒绝 `.npmrc`、pnpmfile 与 manifest execution field，并以 per-operation XDG/config directory 构造 minimal environment。对已安装 Profile，扩展中心严格解析变更前的准确 manifest、pnpm 11 lock/modules metadata 与引用的已安装 package manifest。它把合成的 owner-only pnpm abbreviated/full registry metadata 写入 content-addressed generation，generation identity 绑定这些源 digest、现有 canonical store、每个生成文件、cache manifest 与固定 pnpm runtime。Plugin provider recovery snapshot 携带该 binding；正常 rollback 与独立 break-glass 因此会在使用前验证同一 generation。Cache 物料缺失、被更改、经由 symlink 替换或与 binding 不匹配时，会在下一次官方 CLI Profile 写入前 fail closed。Package-manager execution 保持 offline 且禁用 lifecycle script；generation 不联系 registry，也不承诺获取不可用的 package byte。只有同时没有 lock 与 `node_modules` 安装的 Profile 才获得扩展中心私有的 per-Profile store。Supervisor 会在 timeout、caller signal 或 caller stdin 丢失（包括 caller `SIGKILL`）时终止完整 mutation process group；准确 execution record 会在该 process group 仍存活时阻止 stale-lock recovery。Mutation 与 recovery 只支持 macOS 和 Linux，在 Windows 上 fail closed。随后 recovery 验证 journal 绑定的 provider before-state，调用已绑定官方 CLI 恢复该准确 Profile state，验证结果后才提交 Center control state。Provider apply 一旦开始，无法取得 mutation proof 的操作会保留准确锁并进入 `recovery-required`，不会生成 failed receipt。准确 rc.0 pnpm 11.7.0 version/SRI pair 只作为持久历史读取。启动会在 owner reconciliation 前交叉核对其 consumed authorization 与 journal 或 journal 前 reservation，并在不初始化 owner 的前提下读取 Center 与 owner sidecar projection；任何未完成 operation、仍待 finalize 的 Plugin rollback，以及仍被持久 owner 状态引用的 failed Plugin journal，都保留准确 target lock，不返回 recovery command，也不能进入 provider、Loader、Node、pnpm 或官方 CLI 执行。未知或混合 runtime identity 属于 corruption，不是兼容输入。扩展中心不调用 fork 专用协议，不修改 DSH 源码或 package，也不直接写 Profile dependency、lock、`node_modules`、Bundle membership 或 Loader 状态。

Artifact acquisition 会拒绝 initial URL 和 redirect URL 中的所有 IPv4 与 IPv6 literal，把已消费 authorization 绑定到不可变 plan 中捕获的签名坐标，并验证准入 size 与 digest。Hostname 和 DNS 仍不可信，因为该检查不解析域名；它不声称防御 DNS rebinding。

## Release provenance

唯一合格的 Release 候选是准确 `main` push 的 Node 22 CI job 上传的确定性 tarball、`SHA256SUMS` 与自摘要 attestation。CI verifier 绑定 GitHub Actions archive digest、run id 与 attempt、有界且只含三个准确 entry 的 ZIP payload、每个 entry 的 byte digest 与 size、source commit、packed manifest、bundled pnpm tree 与 tarball byte；它只接受固定 GitHub API artifact URL，以及随后一次准入的 GitHub Actions 或 Azure Blob storage redirect。公开 Release 必须准确且仅包含这三个 byte 完全相同的 asset，受保护的轻量 tag 必须直接指向 Release commit。公开 verifier 通过有界 Git refs metadata 解析该 tag，再使用 GitHub CLI 2.88.1 或更高版本验证显式 tag 与每个已下载 asset；它只准入当前签名 Release v0.2 predicate 与已验证的 GitHub release-service identity，并记录具体 Release id、tag ref digest、签名 statement、bundle digest 与逐 asset verification result。更新还把前一 Release 绑定到它自己的准确 CI receipt；`0.1.0-rc.0` bootstrap 把 previous CI evidence 明确记录为 `null`。Runtime、公开 Release 与复合 receipt 交叉绑定这些准确 artifact。Repository Release immutability 与受保护 `v*` tag 会阻止后续修改，但不能建立某个具体 Release 的状态。

## 当前证明状态

证明按 receipt 拆分，不依赖会随时间变化的状态段落。发布前证据覆盖准确 packed artifact 的商店、真实浏览器变更、分类型 Plugin/MCP/Skill 生命周期、受控 ABA 处理、packed break-glass recovery、故障矩阵、无密钥官方 Replay Agent 路径，以及绑定准确 commit 的 Ubuntu/macOS lane。Replay 只替换模型响应；官方 Agent、Session、Tool dispatch、扩展中心受管 Skill、continuation 与 receipt 路径仍为真实执行。`0.1.0-rc.0` bootstrap 不携带前一 Center artifact 或 release-ready receipt；后续 Release 必须绑定准确成功的前一 post-publication receipt、运行不同前一版本到当前版本的 Center 更新、把前一次已部署签名目录提升为 package bootstrap，并且只部署下一签名 revision。公开 Release 安装、Pages 部署与刷新、CI artifact provenance 与复合主张都要求各自的外部 receipt。Live provider 运行只是 advisory compatibility smoke，不阻塞 P0。源码实现、repository policy 与 unit coverage 不能替代任何 receipt。

## P0 验收

发布门必须把一个 packed 扩展中心物料通过已发布的官方 `dsh@0.1.1-rc.2` 安装到隔离 Profile，然后必须证明：

1. 商店发现与任务驱动检索使用同一个已验证目录。
2. Plugin 安装、准确更新、卸载、恢复、重启验证和 break-glass package recovery 使用扩展中心锁定的 archive 与官方 Plugin CLI；纯配置通过官方 Loader 在同一个 Host 进程应用并验证，扩展中心不直接写 package-manager 状态。
3. MCP 配置、启用、更新、禁用、移除、恢复、永久清除、握手与 Tool 可见性通过官方 MCP Client 完成。
4. Skill 安装、配置、更新、禁用、启用、卸载、恢复、永久清除与 registry 可见性通过官方 Skill registry 完成。
5. 经批准的任务能力获取通过无密钥官方 Replay 门禁，经真实 Agent、Session、Tool、Skill、continuation 与 receipt 路径产生已验证能力证据，并且只向原 Session 派发一次 continuation。
6. 使用官方 CLI 移除 child Plugin 与扩展中心后，官方 DSH 源码与 package tree 保持不变，预期 Profile package-manager 变化有明确记录，且只保留用户明确选择保留的扩展中心恢复数据。

修改过的 DSH checkout、未打包源码、仅 mock 的 owner 或只读商店结果都不能满足此门。Live provider smoke 可以增加兼容性证据，但不能替代确定性 Replay receipt。
