# 统一扩展中心 P0 产品规格

状态：扩展产品规格，2026-09-01。当前完成门禁是最新版官方 DSH 兼容；下述 child extension 可写生命周期与公开 Release 证据属于未来、非阻断门禁。

[English](p0-product-spec.md) | 中文

兼容性目标：未经修改的官方 DeepSeek Harness 源码 tag `dsh-v0.1.2-alpha.3`，对应 commit `dd6322d604e00eec1ba5e0c8541159906a21094a`。Center 以 GitHub 托管的确定性 tarball 分发，并通过官方通用 Plugin CLI 安装；Center 不需要发布到 npm。Stable Center `0.1.0` 证据仍是历史证据，只适用于官方 DSH `0.1.1-rc.2`。

扩展中心是独立发布的 DSH Bundle。它的 Host 代码、Web Client、准入目录、发现、plan、grant、journal、receipt、验证、恢复编排与持久化续行 claim 都由本仓库交付，不修改官方 DSH。扩展中心自身与每个已准入 child Plugin Bundle，无论是 Host-only 还是 Host+Client，都只能通过官方 `dsh plugin --profile <profile> ...` CLI 安装、更新、降级和卸载。扩展中心可以暂存并保留准确 archive，但绝不直接写 Profile package-manager 状态。实现边界见[纯插件架构](plugin-only-architecture.zh.md)，发现模型的来源证据见[能力发现与扩展商店研究](capability-rag-research.zh.md)。

当前完成门禁使用官方通用 Plugin CLI 安装准确 packed artifact，运行真实 Host 与 Web Client Store 路径，再用同一 CLI 卸载，并证明官方 DSH package tree 与隔离安装 tree 未变化。下述 child extension 可写生命周期、恢复、确定性 Agent 续行、公开 Release 与 Pages 部署仍是扩展产品路线，不能从兼容 receipt 推导出来。历史 stable 证据继续只适用于其记录的官方 DSH 版本。

## Problem

普通 DSH 用户目前要从不同发现来源、配置方法、生命周期术语和证据中分别理解 Plugin package、MCP connection 与 Skill。任务也可能因为 Agent 缺少能力而失败，但用户并不知道哪类扩展或哪个 package 能提供该能力。

缺少的产品不是更大的仓库列表，而是一条可信获取闭环：找到相关能力、解释来源与权限、取得准确授权、按真实生命周期管理、验证 DSH 确实可用、失败后可恢复，并继续用户原任务。

## Proposal

交付一个具有两个平等入口的扩展中心：

1. **任务驱动获取：**Agent 识别能力缺口，先检查已有可见能力，再在本机检索合格目录候选，请扩展中心准备一个准确计划，等待独立人工授权，验证新 contribution，然后续行原 Session。
2. **扩展商店：**用户可以浏览、搜索、筛选、比较、安装、配置、更新，在真实生命周期支持时禁用扩展，以及恢复、卸载和永久清除扩展；这些动作不进入模型上下文。

两个入口共享同一份签名目录 revision、资格政策、inventory 事实、扩展中心自有 plan、人工授权、journal、receipt、验证 recipe、恢复编排与续行 claim。物理执行仍按类型区分：已准入 child Plugin Bundle 的 package membership 变更使用官方 Plugin CLI，纯 Plugin 配置使用官方 Loader，MCP connection 使用官方 MCP Client，Skill 使用官方 Skill registry。

P0 成功意味着非专业用户能针对每项动作回答五个问题：

- 找到了什么能力，来自哪个已准入来源？
- 哪些代码、进程、网络、指令、凭据或数据权限会变化？
- 会准确创建、替换、禁用、恢复、移除或保留什么状态？
- 什么证据证明所选 DSH scope 能使用结果？
- 如果扩展中心或 Web UI 无法加载，怎样恢复？

## 产品与仓库边界

- 产品只存在于本仓库，并以一个 packed Host+Web Client Bundle 发布。
- 兼容性目标是准确官方 DSH `0.1.2-alpha.3`；验收通过官方 CLI 把确定性 packed Center 安装到隔离的官方 Host，而不是使用 checkout 或修改过的 package。
- 对每个已准入 child Plugin Bundle，扩展中心暂存并锁定准确 archive，拥有 operation evidence。只有官方 Plugin CLI 可以写入 Profile dependency、lock 数据、`node_modules`、Bundle membership 与 package-membership Loader row；纯配置通过官方 Loader 替换受管 row。扩展中心绝不直接写 package-manager 位置。
- 受管 MCP connection 是扩展中心自有 desired-state record，用于挂载官方 MCP Client。
- 受管 Skill 是扩展中心自有文件与记录，通过官方 Skill registry 投影。
- 任务续行是扩展中心自有的持久化一次性 claim，使用官方 Agent、Session 与持久化服务实现。
- 扩展中心绝不把自身列为受管子扩展，也不自我更新或自我卸载。
- 缺失官方扩展点时，只用准确 capability reason 拒绝该项动作，绝不转而要求 Host patch。

## Target user

主要用户能理解“让 Agent 查询这个服务”或“增加代码审查工作流”之类目标，但不应被要求理解 Profile package-manager 状态、Cordis Loader row、MCP Client 组合、Skill registry precedence 或 journal recovery。高级证据仍可检查，但不成为默认操作路径。

## 获取旅程

### 任务驱动获取

1. 从当前任务在本机导出 `CapabilityNeed`，不把原始任务文本复制到目录、journal 或 receipt。
2. 先搜索准确 Agent scope 可见的 Tool 与 Skill，再搜索扩展中心受管 runtime 证据。
3. 仍有缺口时，只查询一份已验证目录 snapshot 的本地索引。商店查询、任务文本、workspace 数据、credential、cookie 与 Session id 永远不成为目录请求。
4. 返回 `use-existing`、`management-required`、`acquisition-candidate`、`choice-required`、`no-eligible-candidate`、`discovery-unavailable` 或 `external-only`。
5. 确定性证据产生一个实质性赢家时，Agent 可以选择它，并且只用 opaque id 发起 plan request；否则要求用户从最多三个合格候选中选择。
6. Host 内的扩展中心根据相同 candidate、当前 inventory、target scope、policy、catalog revision 与 integrity 重新解析，再生成计划。任何请求提供的 target key 都必须在读取受管状态前准确等于 candidate、profile、scope 与 extension 的规范 identity。
7. 用户在已认证的 DSH Web 浏览器会话中审查准确计划并单次决定；Agent 无法调用决定动作。
8. 扩展中心执行已批准的类型化操作，并验证匹配的官方 observation。每个已准入 child Plugin Bundle 的 package membership 变更只能委托给 plan 绑定的准确官方 Plugin CLI 动作；纯配置在同一个 Host 进程中使用 plan 绑定的官方 Loader row replacement。
9. 扩展中心消费一个任务绑定的 continuation claim，并向原 Session 派发一次续行。需要重启的 Plugin 会保持 pending，直到后续官方 Host boot 验证所选官方 Profile dependency 与声明 consumer。
10. 只有新能力真实用于原任务且任务级 observable 通过后，才记录任务完成。

### 用户自主商店

1. 打开一级**扩展**入口，看到商店、已安装、更新、活动与恢复。
2. 根据扩展类型、能力、发布者、来源类别、平台、scope、权限、生命周期完整性和配置就绪度搜索和筛选一份已验证目录。
3. 使用目录提供的标准化事实比较不超过三个候选。发布者文案和社区文本只是转义后的审查数据，绝不是指令。
4. 预览准确动作计划及其权限变化。
5. 在已认证的 DSH Web Client 中单次决定。
6. 把变更、重启要求、验证和恢复状态作为不同步骤观察。
7. 检查内容寻址 receipt 与准确 runtime evidence。
8. 从“已安装”管理结果。商店来源的动作永远不创建 task continuation claim。

## 发现与来源模型

发现分为两个平面。

### 目录摄取

项目 pipeline 可以从以下来源发现线索：

- 官方 MCP Registry 与兼容的 opinionated subregistry；
- 声明 DSH Plugin 兼容性的准确 npm 或 GitHub Release；
- Agent Skills 兼容仓库与 registry；
- 维护者提交和用户提交的审查请求；
- 社区 issue、activity、maintenance 与 incident signal。

上游条目、仓库 topic、热度、README 或 Agent 建议都只是线索。准入必须解析准确不可变版本、publisher 与 license、integrity、DSH compatibility、authority、dependency、script、configuration path、lifecycle coverage、recovery material 与 verification recipe，再由 pipeline 发布满足 packaged signature threshold 的不可变 catalog revision。任何单一发现来源都没有安装权。初始 P0 root 明确是 one-of-one（一个 key 且 `threshold: 1`）；multi-key threshold protection 是后续 root 变更，不是当前主张。

### 运行时检索

商店与 Agent 只能读取未过期的准入 snapshot，或未过期且已验证的 last-good snapshot。Runtime discovery 不会执行任意 Web 搜索并立刻安装结果。用户显式提供的 URL 必须保持 `external-only`，直到正常摄取与准入流程生成签名候选。

Agent 只获得有界检索结果：closed enum、capability tag、opaque id、pinned revision、authority flag 和一段目录提供的事实摘要，不接收任意 publisher instruction。这就是 Capability RAG：模型根据检索到且有来源的事实推理，而不是依赖权重记住 package name 或编造安装命令。

## 自主性与授权

| 动作 | P0 权限 |
|---|---|
| 识别能力缺口 | Agent 自主 |
| 检查当前能力并查询准入 snapshot | Agent 自主、只读 |
| 当 policy 与证据产生一个实质性赢家时选择候选 | Agent 自主 |
| 使用 opaque id 发起 plan request | Agent 自主 |
| 批准新的代码、进程、网络、指令、凭据或数据权限 | 仅人类，对一个准确计划单次有效 |
| 向变更 Tool 提供 package name、URL、command、credential 或 approval | 禁止 |
| 授权后执行已准入生命周期动作 | 扩展中心编排的类型化操作；每个已准入 child Plugin Bundle 的 package membership 变更使用官方 Plugin CLI，纯配置使用官方 Loader |
| 验证可见性并续行原任务 | 准确证据通过后由 Agent 自主完成 |
| 直接安装任意 Web 或社区结果 | 禁止 |
| 记住面向未来扩展的宽泛授权 | P0 排除 |

每项可写动作分别拥有不可变计划和一次性 grant。安装不自动授权后续配置、更新、启用、禁用、恢复、卸载或永久清除。目标与 desired state 相同的重复 intent 可以幂等，但仍保留最初计划与授权证据。

## 统一 Inventory，但不压平事实

一个 inventory row 关联 catalog identity、managed target、准确 scope、owner revision、source freshness、operation history 与 recovery point。它的可见状态由独立维度投影：

- material：absent、staged、selected version、retained versions 或 drifted；
- configuration：missing、valid、invalid、credential-required 或 external；
- activation：enabled、disabled、restart-required 或 not applicable；
- runtime：unobserved、starting、healthy、degraded、failed 或 unavailable；
- contribution：Loader consumer、MCP Tool set、Skill winner 或 none；
- update：none、exact version available、blocked 或 unknown；
- recovery：none、recoverable、recovering、recovered 或 recovery-failed；
- task：not requested、waiting for approval、waiting for capability、resumed、used 或 failed。

UI 绝不把 package presence 或 durable record 转成泛化的“已安装且正常”徽标。每个状态都必须说明观测对象与 freshness。

## 分类型生命周期映射

| 类型 | 安装与配置 | 更新 | 禁用/启用 | 卸载、恢复、永久清除 | 必需验证 |
|---|---|---|---|---|---|
| Plugin | 暂存并验证准确 archive，再调用官方 `dsh plugin --profile ... add`，由 Profile package manager 拥有已安装 dependency；后续 typed configuration 通过官方 Loader 替换受管 row | 用不同的已准入 archive 调用官方 CLI，并在重启后验证新 Profile dependency | 除非准入 Plugin 暴露稳定 activation mechanism，否则 P0 不提供 | 调用官方 CLI 执行 remove 或回滚到准确保留版本；purge 通过独立 plan 且只删除 Center-retained archive | Archive digest、官方 Profile dependency 与已安装 bytes、Loader contribution、package membership 变更后的必需 Host restart、纯配置后的同 Host Loader 验证，以及一个声明的真实 consumer |
| MCP | 创建扩展中心自有 desired-state record，使用准入 command、environment reference 与 scope 挂载官方 MCP Client | 在 revision fence 下替换准入 connection spec | 只 dispose 或 remount 扩展中心自有 fiber | 独立移除、恢复或永久清除自有记录与物料 | MCP handshake、准确 qualified Tool set、scope 与当前 desired/observed revision |
| Skill | 落盘扩展中心自有 Skill 内容，通过官方 registry 注册摘要、scope 与 invocation flag | 原子选择新准入 content revision | 改变扩展中心自有 registry projection | 独立移除、恢复或永久清除自有内容与 registration | 准确 registry winner、content revision、scope 与 invocation flag |

每个一键 P0 候选都必须具备发现、准确版本安装、配置、更新、验证、卸载和失败恢复字段。只有真实生命周期能够证明时才显示启用/禁用。Restore 指向一个不可变 rollback point，绝不是 enable 的别名。

## 计划、Operation 与 Receipt

不可变计划绑定 protocol version、intent origin、catalog/inventory revision、target kind/id、scope、operation、准确 desired state、artifact integrity、authority before/after/delta、configuration reference、verification recipe、restart behavior、rollback point、expiry 与 canonical digest。

扩展中心复核一个 plan 时只读取一份 catalog snapshot。实时 catalog 与 owner revision 在一次性消费 decision 完成前始终是必需 fence。消费完成后，不可变 plan、operation authorization、持久 intent payload、journal 与 provider snapshot 成为 provider 执行和恢复依据；catalog rollover 或候选删除不能阻断回滚。即使失败 operation 的 intent 已不可用，终态 receipt 补全与锁释放仍使用已消费 plan、authorization 与终态 journal；task continuation bookkeeping 会从 intent payload 单独重试。Plugin rollback 完成顺序固定为准确恢复状态验证、终态 receipt 持久化、临时 absent-state proof 删除与 target lock 释放。启动恢复在 receipt 发布前 provider proof 不可用时保留锁，在 receipt 已持久化后完成 proof 清理或解锁。

已认证 DSH Web Client 在签发绑定候选的 decision 前展示计划。请求不携带秘密 grant，也不能证明真人身份；Connection 已经执行 Host/Origin/Fetch-Site 信任检查和浏览器会话 cookie 认证。扩展中心重新检查 plan expiry、准确 digest、target、action、scope、inventory revision 与 decision identity，再一次性消费产生的 operation authorization。拒绝与取消是终态事实，不能被静默重试。

每个 target 只有一个扩展中心 operation owner 和一个单调 revision。对 `managedPlugins`，该 owner 覆盖 plan、journal、receipt、retained archive、recovery selection 与 evidence；官方 Profile package manager 仍是 Plugin 物理 owner：

- `managedPlugins`
- `managedMcpConnections`
- `managedSkills`
- `taskContinuations`

Operation journal append-only 且 hash-linked。终态 receipt 绑定 plan digest、grant evidence、catalog/owner revision、provider snapshot before/after、verification observation、journal head、recovery executable identity、terminal status 与任何保留 rollback point。Receipt 不包含 credential value、原始任务文本、私有 catalog row、cookie、authorization header 或 provider payload。

安装成功、runtime 可见性与任务成功始终是不同 receipt 事实。

## 续行

任务 resolver 生成不含 secret 的 opaque `continuationId`，绑定原 Session、起始 user-message reference、derived need digest、selected candidate、scope、catalog/inventory revision、expiry 与 cancellation/supersession fence。授权后，它还绑定 plan、operation 与预期 runtime evidence，但 id 不变。

只有 operation 已 committed、准确 contribution 对原 Agent scope 可见、源任务仍 active 且 claim 未 replay 时，扩展中心才消费 claim。Dispatch 最多一次，但不承诺 task completion exactly once。Plugin restart 会保持 claim 持久化，直到下一次官方 Host boot 恢复扩展中心状态并验证所选 consumer。

## Web UI 外恢复

每个 operation 在变更前记录 absent-state 或 managed-version rollback point。Package 会把无依赖、hash-pinned recovery module 复制到带版本的扩展中心状态目录。扩展中心或 Web 无法加载时，用户停止 DSH，并通过 `node` 调用该准确 module 和 Center operation id。

恢复绑定 schema v5 内含 official-execution binding v2，并固定 recovery bytes、canonical Center root、canonical Node executable/版本/digest、process-group supervisor、私有 bundled `pnpm@11.21.0` 的 SRI/tree/entrypoint/shim/POSIX shell，以及准确官方 DSH `0.1.2-alpha.3` package/entrypoint/已安装 production-dependency closure、`hostHome` 与 timeout。正常执行和独立恢复都会验证全部 pin、拒绝 Profile package-manager execution control，并使用 minimal environment。对已安装 Profile，扩展中心严格解析变更前的准确 `package.json`、`pnpm-lock.yaml`、`node_modules/.modules.yaml` 与引用的已安装 package manifest，再把合成的 owner-only pnpm 11 abbreviated/full registry metadata 写入 content-addressed generation。其绑定 identity 覆盖 Profile digest、现有 canonical store、生成文件、cache manifest 与固定 pnpm runtime。Plugin provider recovery snapshot 携带该 binding，因此正常 rollback 与独立 break-glass 使用并重新验证同一 generation。Cache 物料缺失、被更改、经由 symlink 替换或与 binding 不匹配时，会在下一次官方 CLI Profile 写入前 fail closed。执行期保持 offline 且禁用 lifecycle script；生成的 metadata 不是网络预热，也不能提供不可用的 package byte。只有同时没有 lock 与 `node_modules` 安装的 Profile 才使用扩展中心私有的 per-Profile store。Supervisor 会在 timeout 或 parent 丢失（包括 parent `SIGKILL`）时终止 mutation process group；live execution record 会阻止 lease recovery，直到该 group 消失。该 mutation 与 recovery 路径在 Windows 上 fail closed。恢复过程还会验证 journal chain、current pointer、plan evidence、provider snapshot 与 retained archive。它可以直接恢复扩展中心自有 MCP、Skill 与 continuation 状态。Center 或 Host 无法启动时，已准入 child Plugin Bundle rollback 只调用已绑定官方 Plugin CLI 恢复准确 Profile before-state，验证结果后才提交 Center state。Provider apply 是 ambiguity threshold：dispatch 开始后，mutation recovery 无法证明结果时，操作必须以准确 target lock 保持 `recovery-required`。准确 rc.0 pnpm 11.7.0 version/SRI pair 只允许 durable reader 读取；未完成历史（包括只有 journal 前 reservation 的已消费 plan）保持锁定，只显示不可执行的隔离提示。Owner 初始化前，还必须把已进入 apply 且持有 provider snapshot 的 retired failed Plugin journal 与 Center 和原始 owner sidecar projection 对比；准确持久 operation reference 同样被隔离，缺少准确锁时阻止可写激活。当前执行、显式恢复、owner reconciliation 与独立 break-glass 都会在 provider 或进程活动前拒绝 retired pair；未知或混合 pair 按 corruption 失败。Recovery 绝不直接写 Profile dependency、lock 数据、`node_modules`、Bundle membership 或 Loader row。下一次正常启动官方 DSH 后，必须验证所选 Profile dependency 与声明 consumer，恢复终态证据才有效。

## 信任与安全规则

- 目录发现只产生线索；只有 threshold-signed 准入才能产生合格候选。
- Catalog signing root 由 Center Release 固定。Unknown/revoked key、threshold 不足、rollback、chain break、freeze、expiry 或 tamper 都 fail closed。
- Artifact integrity、publisher identity、compatibility、dependency、script、authority、configuration、lifecycle completeness 与 verification 分别审查。
- 拒绝 package lifecycle script；安装过程不执行 publisher 提供的 shell text。
- 扩展中心 archive path 必须 canonical、no-follow、private 且原子选择。外来或 revision 已漂移的官方 Profile dependency 必须阻断变更。
- Credential value 留在官方或用户选择的 credential provider 中；plan 与 receipt 只携带引用和权限事实。
- Artifact acquisition 会拒绝 initial URL 和 redirect URL 中的所有 IPv4 与 IPv6 literal。Hostname、DNS 变化与 MCP Tool result 始终不可信；该 URL 检查不解析域名，也不声称防御 DNS rebinding。Network authority 必须显式且准确。
- Recovery 与正常 mutation 共享同一 ownership manifest。它们不能写出扩展中心自有 root 与 MCP/Skill registration；每个已准入 child Plugin Bundle 的 package membership 变更只由官方 Plugin CLI 执行，纯配置则使用官方 Loader。

## 官方 DSH 0.1.2-alpha.3 扩展点

Bundle 只消费准确官方 DSH `0.1.2-alpha.3` 暴露的公开行为：

- 官方 `dsh plugin --profile` CLI，用于每个已准入 child Plugin Bundle 的 package 变更；
- Cordis Loader 的观测与公开配置方法，用于验证 Profile-managed Plugin contribution；
- 随 effect 释放的 `ctx.tools` 与 `ctx.skills` registration；
- 用于准入 MCP connection runtime 的 `@deepseek-ai/dsh-mcp-client`；
- 用于续行的官方 Agent、Session 与持久化服务；
- 经 Connection 认证的 `@deepseek-ai/dsh-client-connection` 浏览器 RPC channel 与 `dsh.client` Web Bundle declaration；Release 验收使用默认绑定 loopback 的官方 Web Profile。

扩展中心 service 与 operation owner 是产品内部实现，不是新增官方 DSH Service Definition。扩展中心自有 MCP 与 Skill contribution 随其 fiber 释放；每个已准入 child Plugin Bundle 继续归官方 Profile package manager 管理，直到已批准官方 CLI 动作改变它。

## P0 排除项

- 自动批准或静默安装任何新权限。
- 直接安装模型输出、任意 Web 搜索、仓库 topic 或热度排序结果。
- 通用 YAML、package、credential 或 schema editor。
- 下载和安装任意 MCP server package。P0 管理准确 Host-preprovisioned runtime 上的 connection lifecycle；其 executable path、digest、version、argument、working directory 与 descriptor 必须匹配 packaged review record。外部 runtime package 与 dependency closure 仍由 Host 所有。
- 在没有真实自有机制时假装所有 Plugin 都能启用或禁用。
- 绕过官方 Plugin package manager、接管外来 Profile dependency，或合并不相关文件。
- 运行中的扩展中心自我管理。
- Patch、复制或替换官方 DSH Host 或 Web 应用。
- 把 legacy `profileTransactions`、本地 DSH HEAD、六个上游 Host owner 或 Host PR fixture 当作产品前置条件；它们只能作为拒绝用例。
- 声称任意第三方代码安全，或把获取成功当成任务成功。

## 扩展验收路线

Gate A 是当前兼容完成路径。Gate B 到 Gate E 是未来产品生命周期与公开 Release 证据，明确不阻断当前独立插件兼容声明。在扩展路线内部，后续 gate 不会豁免前面的失败。

### Gate A——准确 Artifact 与官方 Host

1. 从干净且审查过的 commit 构建，并提交确定性 `lib/` 产物。
2. 打包两次并要求 bytes 与 SHA-256 完全一致；检查每个 archive entry，拒绝 lifecycle script 或未声明 executable。
3. 在准确 `main` push 上，要求 Node 22 CI job 上传该确定性 tarball、`SHA256SUMS` 与一份自摘要 attestation，并绑定 source commit、run id/attempt、packed manifest、bundled pnpm tree 与 artifact 坐标。
4. 通过固定 GitHub API 与最多一次准入的 GitHub Actions 或 Azure Blob storage redirect 下载准确 Actions artifact。必须验证声明的 Actions archive digest，并要求有界 ZIP 只包含 tarball、`SHA256SUMS` 与 attestation。
5. 只使用准确官方 `dsh@0.1.2-alpha.3`，通过官方 CLI 把已 attested Center tarball 安装到隔离的 DSH、Agents、workspace 与 home 目录；不要求 Center npm 坐标。
6. 记录官方 package identity 与已审计 commit；拒绝 source checkout、workspace import、patched package、相邻仓库和未打包 Center code。
7. 通过已发布入口启动真实 Host 与 browser Client。

### Gate B——双入口发现与授权

1. 验证 bootstrap/refreshed catalog signature、threshold、revision chain、issue/expiry time 与 last-good fallback。
2. 证明商店搜索与任务 Capability RAG 对同一需要返回相同合格候选事实，且不会把 query 或 task content 发到远端。
3. 证明现有能力优先于获取，歧义必须要求选择，过期或不完整 observation 不能声称没有候选。
4. 证明模型输入只包含 opaque acquisition id 且不能调用 confirmation。
5. 证明 grant denial、expiry、replay、wrong scope、wrong target、wrong revision 与 plan drift 都在变更前 fail closed。

### Gate C——完整受管生命周期

使用固定 synthetic Plugin、MCP 与 Skill fixture，并连接真实官方扩展点：

1. Plugin：discover → v1 install → restart/consumer verification → 同 Host configure/Loader verification → v2 update → restart/consumer verification → managed-version restore → uninstall → absent-state restore → final uninstall/purge。
2. MCP：discover → install/configure → enable → handshake/Tool verification → update → disable → restore → remove → purge。
3. Skill：discover → install/configure → registry verification → update → disable → enable → restore → uninstall → purge。
4. 每一步都比较 inventory projection、扩展中心自有 archive 与 record、官方 Profile dependency 与已安装 bytes、owner revision、Loader/fiber/registry observation、journal chain、receipt 与 recovery point。
5. 证明不相关既有 path 或 owner 会阻断变更且保持 byte-identical。
6. 在准确官方 Profile 上运行受控外部 CLI ABA 场景：已批准 Plugin operation 到达 `restart-required` 后，绑定替代 Host reconciliation，通过其他进程分别调用官方 CLI 完成 A→B 与 B→A，再恢复扩展中心 operation。它必须进入 `recovery-required`，不能发布虚假成功。Receipt 只证明这一准确顺序，不证明所有可能的进程交错。

### Gate D——恢复与原任务续行

1. 分别在 material selection 前、selection 后但 runtime verification 前、verification 后但 receipt publication 前、restart reconciliation 期间和 recovery 期间注入故障。
2. 在 Center 或 Host 无法启动时运行 schema-v5 hash-pinned break-glass module；证明其 official-execution binding v2 验证 Node、supervisor、私有 bundled pnpm，以及已绑定官方 DSH `0.1.2-alpha.3` package tree、production closure、entrypoint 与 `hostHome`，调用准确官方 Plugin CLI 回滚到已准入 absent-state 或 retained-version before-state，验证 Profile 结果后才提交 Center state，并在任一 binding、executable、journal、pointer、plan、Profile revision 或 archive drift 时失败，绝不直接写 Profile 状态。
3. 通过官方 Agent 启动任务，并使用官方 DSH Replay 确定性制造能力缺口与模型 tool-call 序列。Replay 只能替换模型响应；能力解析、已认证浏览器决定、operation 执行、Session log、Tool dispatch、已获取 Skill 的使用、continuation 与 receipt evidence 必须走真实官方路径。证明一次 continuation 到达原 Session。
4. 对 Plugin 重启官方 Host，证明 durable claim 只在 selected consumer 可见后被消费。
5. 证明 denial、cancellation、supersession、wrong Session、replay、failed verification 与 Store-originated operation 都不能 dispatch continuation。
6. 使用已获取能力，并单独记录 task-level observable。

### Gate E——卸载与 Release Receipt

1. 通过官方 CLI 移除每个已准入 child Plugin Bundle 与扩展中心；通过扩展中心自有类型化操作移除 MCP 与 Skill 状态。
2. 证明官方 DSH 源码与 package tree 保持不变。记录每项预期 Profile package-manager 变化，并拒绝扩展中心对 Profile dependency、lock 数据、`node_modules`、Bundle membership 或 Loader row 的任何直接写入。
3. 只保留用户批准的恢复数据，并证明 clean reinstall 可以识别或显式丢弃它。
4. 把 artifact SHA-256、官方 Host package identity、catalog revision、platform、browser journey、operation receipt、recovery evidence、continuation evidence、test command、log 与剩余不确定性绑定到一份脱敏 Release receipt。
5. 在每个声明平台重复必跑 artifact lane。另一个 DSH Release 必须取得独立 compatibility receipt。
6. 下载准确公开 Release asset，结合 runtime receipt 证明官方 CLI install/update/remove；读取固定 Pages 目录 URL 并证明准确签名 revision refresh；把通过的 CI job 绑定到准确 Release commit。CI、runtime、公开 Release 与复合 receipt 必须交叉绑定同一个准确 `main` push Node 22 已 attested tarball。Repository Release immutability 与受保护 `v*` tag 会阻止后续修改，但不能证明外部事项；每项都要求自身通过的 receipt。`0.1.0-rc.0` bootstrap 把前一 artifact、CI、release-ready 与 evidence-run 输入记录为 `null`。后续每个 Release 都必须绑定不同的最后一个成功前序 artifact 及其 CI receipt，以及该成功前序的准确 post-publication run；该 receipt 的已部署目录必须等于当前 package bootstrap，而新的公开目录必须是其准确签名相邻后继。已发布但失败的 candidate 只保留为终态事故证据，绝不替代成功前序。

## Focused verification

Unit 与 integration test 至少覆盖：

- catalog canonicalization、signature threshold、rotation、rollback、freeze、expiry、last-good selection 与跨进程单调 cache commit；
- Capability RAG retrieval、deterministic policy、ambiguity、external-only lead 与 existing-first behavior；
- plan canonicalization、authority diff、grant binding、idempotency、revision fence 与逐 target serialization；
- 独立 Plugin/MCP/Skill inventory projection 与 stale observation handling；
- 扩展中心 archive、官方 Profile dependency 与已安装 byte、Loader、restart、MCP handshake/Tool、Skill registry 与 continuation evidence codec；
- journal hash chain、checkpoint、receipt binding、rollback selection、retained-version limit 与 cleanup；
- 官方 Web Profile 的 loopback 绑定；Host/Origin/Fetch-Site/media type 拒绝；缺失、过期或 authority 不匹配的浏览器 cookie；replay、timeout、disconnect、cancellation、teardown 与 sensitive-data redaction；
- packed artifact 上的 Host/Client protocol compatibility。

## Fault injection

验收至少必须拒绝或恢复以下情况：

- catalog tamper、unknown signer、threshold 不足、rollback、expiry、refresh timeout、poisoned cache、跨进程 refresh 乱序完成与 writer process crash；
- artifact hash mismatch、archive traversal、symlink escape、unexpected lifecycle script、missing dependency 与 incompatible platform；
- concurrent plan、owner revision drift、target lock loss、受控的其他进程官方 CLI ABA 序列、每个 journal phase crash、partial pointer replacement 与 disk-full simulation；
- 官方 Plugin CLI add/update/remove failure、未执行必需 restart、声明 consumer 缺失、MCP early exit 或 Tool drift、Skill winner conflict；
- denial、grant replay、wrong origin/session/scope/target/revision、expired continuation、cancellation、supersession 与 duplicate dispatch；
- recovery executable drift、wrong Center root、broken journal link、unknown current pointer、unrelated path collision 与 cleanup failure。

## Release 验收标准

只有下列陈述全部成立时才可发布 P0：

- 一个 packed artifact 通过准确官方 DSH `0.1.2-alpha.3` CLI 安装和卸载，且不修改官方 DSH 代码。
- 商店与 Agent 获取使用同一份准入目录和同一条 policy path。
- 发现来源可见、来源事实新鲜，线索不能绕过准入。
- Plugin、MCP、Skill 都覆盖发现、安装、配置、准确更新、runtime verification、卸载与恢复；启用/禁用按类型如实呈现。
- 每项变更都有一个准确人工 grant、不可变 plan、revision fence、journal、receipt 与 rollback point。
- 每个已准入 child Plugin Bundle 的 package 生命周期使用扩展中心锁定的 archive 与官方 Plugin CLI；只有官方 Profile package manager 可以写入 dependency、lock 数据、`node_modules`、Bundle membership 与 package-membership Loader row。纯配置通过官方 Loader 在同一个 Host 进程替换并验证准确受管 row。
- 每个已安装 Profile 的 Plugin mutation 使用由准确 pre-state 派生的 owner-only、content-addressed pnpm 11 abbreviated/full metadata generation，并通过 provider recovery snapshot 绑定；正常与 break-glass 路径重新验证同一 generation，保持 offline 且禁用 lifecycle script，并在 cache 物料缺失或变更时于下一次 Profile 写入前失败。只有同时没有 lock 与 `node_modules` 安装的 fresh Profile 才使用扩展中心私有 store。
- MCP 与 Skill runtime evidence 来自官方 MCP Client 与 Skill registry。
- 需要重启的 Plugin 在后续 boot 验证声明 consumer 前不能报告完成。
- 一项任务驱动获取使用无密钥官方 Replay 门禁，在 dispatch 层只续行原 Session 一次，并通过真实 Agent、Session、Tool、Skill、continuation 与 receipt 路径分别证明新能力被使用。
- Center 或 Host 无法启动时 break-glass recovery 仍可工作，验证 schema-v5 official-execution binding v2，通过官方 Plugin CLI 恢复准确 child Plugin Profile before-state 后才提交 Center state，且绝不直接写 Profile 状态。
- Receipt 必须证明受控的其他进程官方 CLI ABA 序列不能发布虚假终态成功；仅有 Center target lock 不足以证明，且主张不能扩大到未经测试的进程交错。
- 公开 Release 准确且仅包含来自 `main` push Node 22 CI artifact 的确定性 tarball、`SHA256SUMS` 与 pack attestation，每个文件的 digest 与 size 都完全一致。公开 Release receipt 绑定具体 immutable Release 与三个 GitHub asset attestation；runtime 与复合 receipt 绑定当前 CI receipt，更新还绑定前一 Release 的准确 CI receipt，bootstrap 则把 previous CI 记录为 `null`。
- Browser UI、Host RPC、provider behavior、packed artifact、公开 Release 安装、公开签名目录刷新、准确 commit CI 与声明平台 receipt 全部存在。Live provider 执行保持 advisory 且不阻塞。
- Log 与 durable evidence 不包含 secret、原始任务、私有 catalog row、authorization header 或 provider payload。
- 任一缺失证据必须标记为 `Pending`、`Unavailable` 或 `Unresolved`，不能从 unit test 推断。

## Risks

- **目录被攻破：**使用 threshold signature、immutable revision、短 expiry、固定 trust root 与独立 admission evidence 降低影响。
- **Prompt 或 description injection：**只向 Agent 暴露标准化目录事实，把不可信 prose 作为转义后的 review data。
- **生命周期漂移：**动作绑定 owner revision，每次 mutation 与 restart 后验证官方 runtime observation。
- **所有权重叠：**遇到外来或已漂移官方 Profile dependency、已安装 bytes、Loader contribution、registry winner 或扩展中心 archive 时 fail closed。
- **外部 CLI 并发：**官方 DSH `0.1.2-alpha.3` CLI 不向扩展中心提供 lock 或 compare-and-swap token。受控 ABA lane 证明一个对抗性顺序能够安全失败；receipt 不能被泛化为覆盖所有可能的进程交错。
- **重启歧义：**需要重启的 Plugin package operation 及其 continuation claim 保持 pending，直到后续 boot 观察准确 consumer；纯配置只有在同 Host Loader 验证后才完成。
- **恢复损坏：**固定独立 executable 与每个 journal/material digest；不依赖损坏 runtime。
- **虚假任务成功：**分别记录 acquisition、runtime visibility、capability use 与 task outcome。
- **Host 版本漂移：**兼容性以准确版本证据为准；patched 或 moving source tree 的结果不能扩大官方 DSH `0.1.2-alpha.3` 声明。
