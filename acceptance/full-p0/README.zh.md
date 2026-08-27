# 基于官方 DSH rc.2 的完整 P0 验收

[English](README.md) | 中文

本目录定义独立扩展中心的 Release 验收要求。完整 lane 使用官方 CLI，把 packed Center 安装到隔离且未经修改的 `@deepseek-ai/dsh@0.1.1-rc.2` 环境，并通过真实 Host 与 Web Client 运行 Plugin、MCP、Skill 与 Continuation 旅程。缺少绑定待审 Release 的一份生命周期终态通过 receipt，以及分别通过的公开 Release、Pages 与 CI receipt 时，不成立 P0 主张。

## 准确目标

- Center artifact：从已提交 `lib/` 产物生成且不声明 package lifecycle script 的准确确定性 tarball。Release 决策使用的必须是准确 `main` push Node 22 CI job 随 `SHA256SUMS` 与自摘要 attestation 一起上传的 tarball。
- Host artifact：官方 `@deepseek-ai/dsh@0.1.1-rc.2`，已审计 commit 为 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。
- Center 安装：通过已发布 CLI 执行 `dsh plugin --profile web add <packed-center-artifact>`。
- 子扩展所有权：扩展中心拥有准确暂存与保留的 Plugin archive、plan、grant、journal、receipt、验证、恢复编排与 continuation claim。对每个已准入 child Plugin Bundle，无论是 Host-only 还是 Host+Client，只有官方 Profile package manager 拥有 dependency、lock 数据、`node_modules`、Bundle membership 与最终 Loader row；MCP desired state 与 Skill 物料仍由扩展中心拥有。
- 官方观测：Loader 与声明的 consumer、MCP Client 握手与 Tool 可见性、Skill registry 可见性，以及 Agent/Session continuation dispatch。

扩展中心自身不进入自己的管理 inventory；更新、降级和卸载只能由用户通过官方 `dsh plugin --profile web ...` 命令完成。

## 运行

```sh
node --test acceptance/full-p0/support.test.mjs
node --test acceptance/full-p0/receipt-binding.test.mjs
pnpm run test:acceptance:official-rc2
```

Runner 必须从隔离的官方 rc.2 安装中解析 CLI 与全部 Host package。DSH 源码 checkout、修改过的 Host package、workspace import、未打包的 Center 源码树或仅 mock 的 runtime 都必须被拒绝，不能成为 Release evidence。

## 证据类别

- `Lifecycle`：该完整 runner 的终态 receipt 覆盖准确未修改官方 rc.2 artifact 上的浏览器授权与变更、分类型 Plugin/MCP/Skill operation、受控外部 CLI ABA 顺序、packed break-glass recovery 与原任务续行。
- `Bootstrap release`：rc.0 把前一 Center artifact、前一 CI receipt、前一 release-ready receipt 与前一 evidence run 明确记录为 `null`。其 package 内置签名目录 revision `rN` 仍必须从 Pages 刷新到已提交且已签名的准确相邻后继 `rN+1`，并通过公开 GitHub Release 安装、绑定准确 commit 的 Ubuntu/macOS CI 与确定性 pack attestation 验证。
- `Update release`：此后的每个 prerelease 或 stable release 必须证明不同前一版本到当前版本的 Center artifact 更新，并绑定前一 Release 的准确成功 post-publication receipt。前一 receipt 已部署的 `rN` 必须成为当前 artifact 的 package 内置 bootstrap；当前 Pages deployment 则必须是已签名的相邻后继 `rN+1`。
- `External`：Release、Pages 与 CI 状态只能来自绑定准确已发布 commit 和 asset 的生成 receipt。Repository setting、源码文件、已配置 workflow 与本地测试输出只是输入，不是发布证据。
- `Advisory`：live provider compatibility smoke 不阻塞 P0，也不能替代确定性的无密钥 Agent receipt。

## 必跑旅程

一份完整 receipt 必须绑定准确 Center tarball、官方 Host package identity、catalog revision、隔离状态根、browser origin、plan digest、operation journal 与终态证据。Release lane 必须证明：

1. 商店搜索与任务驱动 Capability RAG 读取同一份已验证签名目录，并产生绑定候选的不可变计划。
2. 每项变更都等待未过期且一次性使用的 loopback 人工授权；模型侧输入不能包含 package name、URL、shell command、credential 或 approval。
3. 受管 Plugin 完成 v1 安装与必需 Host 重启、同 Host Loader 配置、v2 更新与重启、声明 consumer 验证、回滚到保留版本、卸载与 break-glass recovery。扩展中心暂存并锁定准确 archive，但每个已准入 child Plugin Bundle 的 Profile membership 变更都通过官方 `dsh plugin --profile` CLI；纯配置使用官方 Loader API。扩展中心绝不直接写 Profile dependency、lock 数据、`node_modules`、Bundle membership 或 Loader row。
4. 受管 MCP connection 通过扩展中心自有 desired-state record 挂载官方 MCP Client，并完成配置、启用、握手与 Tool 可见性、更新、禁用、恢复、移除和永久清除。
5. 受管 Skill 使用扩展中心自有文件与官方 Skill registry，完成安装、配置、registry 可见性、更新、禁用、启用、恢复、卸载和永久清除。
6. 任务来源的获取使用官方 DSH Replay，并且只替换模型响应这一条边。真实官方 Agent、Session log、Tool dispatch、扩展中心受管 Skill 加载与使用、持久化 continuation claim 及 receipt 路径必须验证所获取能力，并且只向原 Session 派发一次续行；商店来源的获取不创建 continuation claim。
7. 注入的 commit 前后故障必须保持 journal chain 完整，且只恢复已批准 target：直接恢复扩展中心自有 MCP、Skill 或 continuation 状态，child Plugin 则只通过官方 CLI 恢复。对已安装 Profile，扩展中心必须从变更前的准确 manifest、lock、modules metadata、已安装 manifest 与 canonical store 合成 owner-only、content-addressed pnpm 11 abbreviated/full metadata generation。Provider recovery snapshot 必须绑定 generation identity、manifest 与文件 digest，使正常与 break-glass 路径在下一次 Profile 写入前重新验证同一组本地事实。执行期保持 offline 且禁用 lifecycle script；物料缺失或变更必须 fail closed，cache 不联系 registry，也不承诺不可用的 byte。只有同时没有 lock 与 `node_modules` 安装的 fresh Profile 才使用扩展中心私有 store。正常与 break-glass 的官方 CLI 执行都必须在 `START` 前发布并刷盘 Profile execution lease，通过准确持久化 dispatch marker 绑定成功的管道写入回调，只接受在单调 deadline 前观察到的一条有界私有 child outcome，由存活的 supervisor 负责 process-group 终止，在 detached group 被证明静默前保留任一残余记录，并在释放 Profile lock 前按顺序刷盘每次删除。Break-glass schema v5 与 official-execution binding v2 还必须固定 Node、supervisor、私有 bundled pnpm、官方 package 及 production closure、entrypoint 与 `hostHome`，拒绝 Profile execution control，终止 orphan process group，通过该 CLI 恢复准确 Profile before-state，验证后才提交 Center state。部分 observation 绝不能变成成功 receipt；Windows mutation 与 recovery 必须 fail closed。
8. 使用官方 CLI 移除 child Plugin 与扩展中心后，官方 DSH 源码与 package tree 保持不变，预期 Profile package-manager 变化有明确记录，且只保留用户明确选择保留的数据。
9. 准确 rc.0 pnpm 11.7.0 version/SRI pair 只作为持久历史读取。只有 journal 前 reservation 的已消费 plan、每个非终态 journal、仍待 finalize 的 Plugin rollback，以及仍被 Center 或 owner sidecar 状态引用的 failed Plugin journal，都必须保留准确 target lock，显示不可执行的隔离提示，并且不发生 provider、Loader、Node、pnpm、官方 CLI、journal 或 owner reconciliation 变更。缺少锁、未知 identity、混合 version/SRI pair、authorization 与 reservation 或 journal 不匹配时，必须在可写 Host 激活前失败。Provider apply 一旦开始，mutation recovery 不可用时必须保持非终态和锁定，不能签发 failed receipt。

## 证据与失败规则

完整 Release runner 必须启动真实 Web Host 与 browser Client，使用 loopback Connection RPC 完成授权与变更，独立重算 plan/receipt hash，验证每个 journal link 与终态 checkpoint，并在每步操作后检查准确官方 Profile 与扩展中心自有状态。它必须把 setup download 与产品运行期网络证据分开，并在受测旅程中只准入显式锁定的 fixture origin。Provider credential、endpoint override、telemetry、原始任务文本和私有目录数据不能进入 receipt 或 log。

官方 rc.2 服务缺失、Host 提前退出、目录过期、授权被拒或 replay、owner revision 漂移、物料不一致、metadata-cache generation 缺失或被篡改、Loader/Tool/Skill/continuation 证据缺失、恢复绑定漂移或 teardown 残留都必须 fail closed。该 lane 还必须运行受控的其他进程官方 CLI A→B→A 顺序，并要求进入 `recovery-required` 而不是虚假终态成功；仅有 Center target lock 不足以证明。该 receipt 只覆盖受测顺序，不声称覆盖所有可能的进程交错。只读商店通过是有用证据，但不能满足该通道。

任何仍期待 `profileTransactions`、本地 DSH HEAD、六个上游 Host owner 或 Host PR 的 legacy fixture 都只能作为拒绝用例，绝不能被报告成前置条件或兼容性 receipt。

## 复合 Release 证据

最终 Release 决策组合彼此独立的 receipt，不扩大任何单个 runner 的主张：

这些 receipt 之间的官方 Host identity 是准确的 DSH package name 与 version、audited source commit、registry 和 registry integrity。每个 lane 都在自己的 lifecycle 前对完整 installed package tree 取指纹，结束后重新计算，并要求两者完全相同；这些 lane-local fingerprint 继续通过 input receipt digest 绑定。它们不会在不同 fresh installation 之间比较，因为 pnpm 生成的 `.bin` shim 会嵌入各自的隔离安装路径。

1. 完整官方 rc.2 生命周期 receipt 绑定 packed artifact、浏览器旅程、子扩展生命周期、恢复、受控 ABA 顺序与无密钥 Agent 续行。
2. Runtime Release receipt 证明 Host 启动、Client 启动、RPC 注册、准确官方 DSH tree 保持不变；提供前一 artifact 时，还会在同一 Profile 中证明不同前一版本到当前版本的扩展中心更新。
3. 公开 Release receipt 要求 Release asset 准确且仅为 CI tarball、`SHA256SUMS` 与 pack attestation，下载并逐一绑定三个 asset 的 byte，使用 GitHub CLI 验证显式 immutable Release 与每个 asset，再结合 runtime receipt 证明官方 CLI install、可选 update 与 remove。
4. 公开目录 receipt 从准确已提交的 `catalog/public/plugins.json` 推导预期坐标，在固定 Pages URL 验证该 canonical byte，并证明 runtime 从 package 内置 bootstrap 刷新到其准确签名相邻后继且未进入 degraded fallback。
5. CI receipt 把声明的 Ubuntu 与 macOS job 绑定到准确 Release commit，并下载唯一的 `main` push Node 22 Release-candidate artifact。它验证 Actions archive digest、run id 与 attempt、有界且 path-safe 的准确三 entry ZIP、每个 entry 的 digest 与 size、source commit、packed manifest、bundled pnpm tree 与 tarball byte。Downloader 只接受固定 GitHub API URL，以及随后一次准入的 GitHub Actions 或 Azure Blob storage redirect。Runtime、公开 Release 与复合 receipt 交叉绑定当前 CI artifact；更新还必须提供前一 artifact 的独立 CI receipt，bootstrap 则把它明确记录为 `null`。
6. Post-publication verifier 始终从受保护 `main` 上 workflow dispatch 的 `github.sha` 检出并运行，记录 protected-ref assertion 以及该 post-publication run id 与 attempt，并把 verifier commit 绑定到它自己的准确成功 `main` push CI receipt；已发布 target commit 保持独立。只有 immutable `0.1.0-rc.0` bootstrap 的补录允许 verifier commit 与 target commit 不同；rc.1 与 stable 要求二者完全相同。对更新 Release，workflow 使用调用者提供的成功 run id 下载准确前一 release-ready receipt，以及它原始 target 与 verifier CI receipt byte，绑定 Actions run path、head commit、attempt 和三个 receipt digest，再验证前一 version、immutable Release、目录迁移、CI 与验收 evidence；重新生成的 CI receipt 不能替代这些前序 byte。强制序列是 rc.0 `r8→r9`，rc.1 package 内置 `r9` 并部署 `r10`，随后 stable 直接从 rc.1 晋级、package 内置 `r10` 并部署 `r11`。

公开 Release、Pages 与已完成 CI 主张必须具备各自的生成 receipt。源码文件、已配置 workflow、repository setting 或本地测试不能满足这些外部观测。

## 证明边界

通过只证明 receipt 所绑定的准确官方 rc.2 artifact、准确 packed Center 与所列平台。它不证明任意目录候选安全、第三方服务正确、每个续行任务最终成功、live provider、未经测试的进程交错、未测试平台或其他 DSH Release；这些主张必须分别取得证据。
