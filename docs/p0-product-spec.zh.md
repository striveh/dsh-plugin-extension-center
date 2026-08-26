# 统一扩展中心 P0 产品规格

状态：已实现的发布候选——正式发布仍被下述已发布 Host 与外层验收门禁阻塞

实现快照（2026-08-26）：独立项目已经实现签名离线商店、严格 Host/Client RPC、只产生线索的公共发现与目录签名工具、三类归一化 inventory、不可变计划与独立 loopback 决策、operation journal、类型化生命周期 provider、冷恢复、existing-first 本地 Capability RAG、不透明任务获取面、受信 MCP 配置、任务批准队列，以及原任务续行绑定。不可变的已发布 rc.2 浏览器 lane 保持只读，并作为 Host 负基线通过。另一份本地 DSH HEAD 为可写集成提供六个 owner surface，但它不是已发布兼容目标。带独立准入 receipt 的已部署签名远端 revision、packed 本地 HEAD 可写浏览器 lane、未来未经修改 Release lane、真实 provider 任务证据与普通用户可用性在对应回执通过前仍未证明。

[English](p0-product-spec.md) | 中文

项目：`dsh-plugin-extension-center`（暂定名）

交付形态：独立社区 DSH 可安装 Bundle，同时包含 Host 与 Web Client 两个运行面

宿主审计基线：[DeepSeek Harness `dsh-v0.1.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e)

可写 P0 兼容基线：**TBD——首个同时通过 Profile transaction、dynamic MCP connection 与 durable task-continuation capability gate 的已发布 DSH 版本**

## Problem

DSH 已经提供三类扩展背后的机制，却没有贯穿它们的普通用户流程。Profile Plugin 是包管理器依赖与 Bundle 层，MCP Server 是已配置的 `dsh-mcp-client` 实例，Skill 则来自分层 provider registry。用户目前必须理解 pnpm、Profile 组合、Cordis 配置行、文件系统根、凭据和重启行为，才能分清“磁盘上存在”和“当前 Agent 真正可用”。

现有界面有意停在统一变更操作之前。Plugin Inventory 是没有来源和动作的 Loader 即时投影，Plugin 设置只编辑已挂载 Host Plugin 显式暴露的 namespace，而 `dsh plugin` 会先把参数转发给 pnpm，再对齐 Bundle 成员。这些底层 owner 都是正确的，但它们没有提供统一的发现、安装、配置、更新、卸载、验证与恢复路径。

如果把三类扩展压成一个“已安装”开关，产品反而会更不诚实。Skill 会改变模型指令并可能引用资源，MCP Server 会启动宿主进程或把工具数据发送到远程 origin，Plugin 则会在 DSH Host 或浏览器里运行第三方代码。它们的来源、作用域、生效证据、凭据风险与回滚机制都不同。

## Proposal

把面向本机单用户的**统一扩展中心**作为独立社区插件项目构建和发布。用户把它发布的 Bundle 安装进普通 DSH Web Profile。P0 提供两个一等获取入口。在 Agent 辅助路径中，Agent 识别任务能力缺口、检查当前 Agent 已经能用什么、从准入目录检索一个有证据的小候选集、发起一个准确获取请求、等待独立人工确认、验证真正 owner，并继续原任务。在用户自主路径中，用户无需先创建 Agent 任务，就能打开扩展商店，从同一准入目录浏览、搜索、筛选、比较并获取扩展。两条路径汇合到同一个 inventory、不可变计划事务引擎、owner evidence、operation journal 与回执；商店还负责配置、准确更新、卸载与恢复，全程不需要编辑 YAML 或手工运行 pnpm。

P0 统一入口、状态语言、信任说明、操作日志与回执，但不统一 Skill、MCP Server 和 Profile Plugin 的生命周期。现有机制仍是权威：Skill provider registry 负责 Skill 的实际可见性，MCP client 负责连接与工具注册，Profile package、Bundle 顺序、Loader 与真实启动负责 Plugin 状态。扩展中心记录操作与恢复点，但不成为第二套扩展事实来源。

产品承诺保持狭窄：本机用户既可以只陈述一次任务，让 Agent 找到并请求一个缺失的准入能力，也可以在商店中主动选择一个合格扩展。用户对一个准确计划授权后，由 owner 获取并验证它；任务来源的流程随后使用它并完成原任务。两种路径都可以继续配置、验证、明确更新与卸载 managed extension，在真实 owner 支持时使用 enable 或 disable；失败时回到完全相同的 DSH 管理前置状态；任何没有验证的主张继续明确显示为未验证。

对本产品而言，可写 P0 就是五阶段生命周期，而不是一个名为“inventory + install”的实现里程碑。read-only rc.2 preview 可以独立发布，但不能被验收或宣传为可写 P0；无法对准入候选完成 configure、update、uninstall 与 recovery 的 partial writer 继续保持阻塞。

### 项目与仓库边界

- 产品源码、目录数据、事务引擎、恢复命令、Host 代码、Client 代码、测试、文档、CI、包版本、安全策略和 Release 都归独立 `dsh-plugin-extension-center` 仓库所有。
- 已经独立发布的社区 `dsh-capability-resolver` 保持只读 prototype 与 protocol reference，不能扩展成 installer。扩展中心 packed Bundle 必须自己贡献兼容 resolver 运行面，使普通用户全新安装时不必先发现并安装第二个插件。任何复用 package 都由本独立项目锁定并作为 artifact dependency 随包发布。
- 一个发布包同时声明 `dsh.bundle.patch` 与 Web Client export。它通过普通 `dsh plugin --profile web ...` 路径安装、更新和移除，不复制进 DSH monorepo，也不进入 DSH 内置 Bundle。
- DSH 仓库不拥有扩展中心页面、目录、provider 实现、operation journal、产品 Release 或兼容性声明。插件必须标明自己是社区项目，不得暗示 DeepSeek 背书。
- 插件只消费已发布的 DSH package export，以及受支持的 Cordis、Profile Bundle、Host、RPC 和 Client 扩展点。它不 import DSH workspace 源码路径，不 patch 内置 Web 代码，构建与运行时也不依赖旁边存在一份 DSH checkout。
- 如果 P0 缺少必要的 Host 能力，应在 DSH 中单独提出最小且通用的 API，并以这个外部插件作为真实 consumer。产品实现与发布仍留在独立仓库；插件只对已经发布该 API 的 DSH 版本声明支持。
- 扩展中心不能更新、停用或移除自己的 Bundle。它自身的生命周期继续由通用 DSH CLI 管理，使损坏的控制面可以在不加载它的情况下被移除。

### P0 宿主兼容决策

- `dsh-v0.1.1-rc.2` 是已经审计的负基线，不是可写 P0 兼容声明。它要求 Web Client 使用 lazy-CJS factory，但对应 `clientBundle` preset 尚未发布；因此独立项目维护 version-pinned build configuration，并在真实浏览器中验证打包后的 Client。这足以支持准确 Release 的 read-only preview，但不足以支撑下述完整生命周期。
- Host 与 Client 通过插件自有、带协议版本且仅限 loopback 的 Connection RPC channel 通信。该 channel、wire validation 和 disposer 都随同一个 Bundle 发布；产品 namespace 不加入 DSH `api-remotes` assembly。若已发布 Connection API 无法承载某项 P0 操作，则该操作保持阻塞，直到 DSH 先发布通用树外贡献 API。
- 已发布 rc.2 的 `dsh plugin` 路径会把参数转发给 pnpm 再对齐 Bundle 成员，并未发布 exclusive Profile transaction。另一份本地 DSH HEAD 现在提供通用 Profile generation owner，负责 revision fence、stage、validate、commit、boot acknowledgement 与 last-good restore；独立插件只消费公开 package export，不 import workspace source。相关 package 在准确 DSH Release 发布前，这份实现不能成为兼容声明。
- P0 中的 Profile restart 仍由外部 launcher 执行。扩展中心记录 `restart-required`、展示准确影响并在下一次 reconnect 后验证；它不终止或监督自己的 Host。通用 Plugin disable/enable 在稳定 Host owner 发布前保持 `unavailable(reason)`，也不是五阶段生命周期的必需项。
- 已发布 `dsh-v0.1.1-rc.2` 能持久化 Session 历史，但没有通用 durable continuation owner。本地 DSH HEAD 现在把 single-use claim 绑定到原始 Session 与 user-message reference，重新检查 cancel/supersession，并且只在准确 verifier evidence 后至多派发一次相同 continuation message id。这是 at-most-once dispatch 保证，不是 exactly-once task completion 主张；在对应 package 发布前仍属于 Release gate。
- 在已发布 rc.2 中，`ctx.skills.snapshot()` 发布 merged winner，`dsh-mcp-client` 发布 tool，但没有 dynamic connection mutation owner。本地 DSH HEAD 现在提供 revision-fenced dynamic connection owner，并暴露 desired/observed state 与 qualified Tool-generation evidence。P0 只管理到准确 Host 预置且无认证 runtime 的 connection；它不会下载、安装、更新或持有目录中的 server package。认证 MCP 在 formal credential-reference owner 发布前继续阻塞。

### Target user

- 在自己的电脑上运行 `dsh web`，并控制当前 Harness home 与 Web Profile 的用户。
- 知道自己想要什么结果，但不应理解 pnpm、Cordis Loader 配置行、patch 层或 Skill 根的用户。
- 愿意确认清晰展示的代码、进程、网络与凭据风险，而秘密值和内部配置语法始终不对其暴露的用户。

P0 不面向远程管理员、共享多用户 Host、组织策略管理员或扩展开发者。

### 两个一等获取旅程

两条旅程都不是备用路径。它们共享同一个准入目录 revision、资格政策、生命周期 owner、Host-owned transaction engine、inventory 与回执 schema，因此从任一路径获取的条目都会立即被另一路径管理。每项动作分别获得自己的不可变计划；只有候选、scope、operation 与 desired state 都相同时，才要求规范化 mutation 与 authority payload 相同。

#### A. Agent 辅助任务旅程

1. 用户只用普通任务语言描述想要的结果，不需要说出 extension、resolver、store、package 或 install command。
2. 在声称任务无法完成前，Agent 在本机导出 `CapabilityNeed`，并检查准确的当前 Agent scope 可见 Tool 与 Skill。若现有能力已经满足需求，Agent 直接使用，不能访问目录。
3. 仍有缺口时，Agent 调用只读 resolver。Host 在一个 fresh admitted catalog snapshot 的本地索引中搜索；原始任务、Session 标识、workspace 内容、cookie 与凭据绝不进入目录请求。
4. 只有一个准确候选同时通过 compatibility、authority、configuration readiness、lifecycle、freshness 与 evidence policy 时，resolver 才返回 `acquisition-candidate`。实质不同的并列候选返回 `choice-required`；未经准入的 Web 结果保持 `external-only`。
5. Agent 可以只用 resolver 生成的 `resolutionId`、不透明 `candidateRef` 与单次 `continuationId` 调用 `capability_request_acquisition`。它不能提交 package name、URL、command、configuration body 或 secret。
6. Host 在相同 catalog 与 inventory revision 下重新解析这些标识并生成不可变计划。回环浏览器展示准确来源、revision、integrity、目标 scope、完整权限差异、初始配置、重启行为、检查、回滚限制与 plan hash。此时不能发生 artifact fetch、凭据解析、执行、文件写入、进程启动或 Profile 变更。
7. 人类确认或拒绝这一个准确计划。Agent 不能调用确认 RPC、复用授权、把它扩大到未来版本，也不能把任务意图当成批准。
8. 确认后，真正 provider 获取并验证扩展。Skill 或 MCP 路径在返回 Agent 前重新读取官方 winner 或 Tool generation。Plugin 通过必需的 Profile transaction owner 提交，并一直保持 `restart-required`，直到外部 launcher 重启且准确声明的 consumer 可观察。
9. 对实时 Skill 或 MCP contribution，下一个模型 step 重新读取当前能力并继续同一个用户 turn。对 Plugin restart，通用 DSH continuation owner 必须在重新检查 durable claim 后，于新 turn 中至多一次派发绑定的 continuation message；没有该已发布 Host 能力时，流程必须诚实停在 `restart-required`，不能满足完整 P0。
10. Agent 真正使用新可见能力并完成原任务。安装成功、运行可见、续行与任务成功分别记录。

#### B. 用户自主扩展商店旅程

1. 用户无需创建 Agent 任务，直接打开一级**扩展**入口；**商店**是默认视图。它还基于同一个 inventory 与 journal 提供**已安装**、**更新**和**活动与恢复**视图。
2. 用户按策展的结果类别浏览，或搜索并按 Plugin、MCP、Skill、兼容性、来源类型、目标 scope、配置就绪度、权限与生命周期可用性筛选。搜索文本只在本地目录索引中计算，不发送给来源站点或 analytics service。
3. 结果卡区分合格、已安装、因明确原因不可用和 `external-only`。用户可以在多个合格候选之间主动选择不同取舍，但不能绕过 compatibility、trust root、integrity、lifecycle 或 policy rejection。
4. 用户打开详情，并可比较最多三个候选。比较面展示 publisher 与 upstream source、目录准入 revision、准确 artifact 或 content revision 与 integrity、包含组件、DSH 范围、平台与外部前置条件、配置与凭据就绪度、权限与数据目的地、重启行为、完整生命周期可用性、验证证据、保留数据，以及所有未知主张。
5. 用户选择一个准确候选与 scope。Host 按照与任务旅程相同的 schema 和 policy 导出商店 `AcquisitionIntent` 与不可变计划，由用户确认或拒绝。operation 或 desired state 可以不同——例如人工 MCP Install 与 Enable 分离，而准入的任务组合请求 `install` 且 `desired=enabled`。商店来源的 operation 没有 `continuationId` 或 task receipt，除非用户随后明确启动一个新任务。
6. 真正 owner 执行并验证计划。商店分别展示物料状态、运行状态、当前 Agent 可见性与验证等级；下载或写入完成本身绝不能变成 `active`。
7. 已获取条目立即出现在**已安装**，并把 Configure、Verify、Update、Enable、Disable、Uninstall、Restore 或 Purge 分别显示为 `available`、`unavailable(reason)` 或 `external(read-only)`。**更新**只展示准确观测目标，绝不自动应用。
8. 模型工具被禁用时，商店仍须完整可用。稍后任务再次需要同一条目时必须短路为 `use-existing`；任务与商店路径不能创建重复物料、owner、grant 或回执。

## P0 product scope

### Unified inventory

每一行都展示扩展类型、显示名、owner、来源、可观察时准确的当前版本或内容 revision（否则显示 `unknown(reason)`）、可用时一个观测到的准确更新目标、目标作用域、期望状态、实际状态、健康状态、重启要求、最近验证、最近错误、恢复可用性，以及每一项生命周期动作与可用性原因。界面只对具名且已发布的 observation scope 识别 visibility；没有该 scope 时报告 Agent visibility `unknown`，不能把 Profile-global presence 当成可用。

Plugin inventory 必须把依赖存在、Bundle 成员、Loader 配置、实际启用状态与 Fiber phase 保留为不同事实。Loader 配置行永远不能称作已安装。只有 explicit center adapter 或 receipt 声明 parent relationship，且具名 runtime contribution 可观察时，由 Plugin 贡献的 Skill 或 MCP Server 才作为 child 展示；rc.2 不公开权威的 Fiber-to-tool 或 Fiber-to-Skill attribution。其他可能 child 一律显示 `owner: unknown` 并保持 external，不能根据名称推断。

由 CLI、外部文件、其他 Plugin、bundled provider、custom Skill root 或 runtime registration 创建的条目在 P0 中可见但只读。扩展中心只变更自己持有操作日志与恢复点的对象。扩展中心自身属于系统条目，不能更新、禁用或移除自己。

### 双入口发现与扩展商店

任务驱动发现与用户自主商店发现都是 P0 一等入口。Agent 路径只在普通任务暴露能力缺口后开始，不进行后台监视。独立的**扩展**入口默认打开商店，无需先创建 Agent 任务，并把商店、已安装、更新、活动与恢复作为一级视图。

商店可以按策展的结果类别浏览，按名称、能力、发布者与标签搜索，并按类型、DSH 与平台兼容性、来源类型、scope、配置就绪度、权限和生命周期可用性筛选；比较最多三个跨类型候选。浏览、搜索、筛选、排序与比较都只使用本地准入快照，不上传查询，也不进行网络 fallback。比较字段缺失时显示 `未声明`，不能静默消失。

两个入口使用同一证据顺序：

1. 准确当前 Agent scope 与工作目录下的 qualified Tool schema 和官方 merged Skill catalog；Agent 必须先据此短路现有能力，商店则据此标注已安装或当前可见；
2. center-owned inventory，以及可能已存在但损坏、禁用、被 shadow、过期或对当前 Agent 不可见物料的官方 owner evidence；
3. 从 configured allowlisted origin 获取、带签名且版本化的 admitted catalog snapshot，并在本机匹配；以及
4. 用户明确要求审查后才获取的显式 user-supplied URL，并且只能作为 `external-only` 线索。任意 Web 与社区发现只存在于 catalog ingestion plane，绝不进入 runtime task 或商店检索。

allowlisted origin 与来源自报 digest 都不是 trust root。Bundle 随包发布 `catalog-root` metadata，以及一个供离线商店使用的 signed bootstrap snapshot。Root metadata 包含 catalog id、可信 public-key id、threshold、最低可接受 revision 与最大 age。每个 canonical snapshot envelope 包含单调 revision、签发与过期时间、entries digest、previous-revision digest、signing-key id 和 threshold signature。Host 在建立索引前验证 threshold、key、canonical digest、单调 revision、previous-revision link、expiry 与 configured catalog id。Root key 轮换、撤销或提高最低 revision 只能通过一个更新且 integrity-pinned 的 Extension Center Release 进入；catalog payload 不能增加自己的 trust key。签名无效、未知或已撤销 key、digest mismatch、revision rollback、链断裂或过期/frozen snapshot 都返回 `discovery-unavailable`。Bootstrap 或未过期 verified last-good snapshot 只有在仍满足 Bundle root metadata 时才能使用。

独立项目把目录构建为 opinionated DSH subregistry。摄取流程可以读取官方 MCP Registry、声明 DSH compatibility 的准确 npm/GitHub Release、Agent Skills 兼容公开 registry 与仓库、维护者提交，以及社区 issue/activity signal。它会标准化主张、记录 publisher 与 license、锁定准确 artifact 或内容 revision、扫描 manifest 与 lifecycle script、推导权限、运行兼容与验证 fixture，再发布带签名的不可变 revision。上游 listing 只是线索；只有 DSH-specific lifecycle record 完成准入后，才能成为可写候选。

运行时任务匹配采用本地 Capability RAG。Agent 导出有界 `CapabilityNeed`，包含 outcome、输入输出形式、scope、平台限制、所需数据访问与最大权限。resolver 搜索标准化 outcome tag、所提供 Tool/Skill、compatibility、configuration readiness、authority、source freshness 与 lifecycle completeness，只补齐一个很小的合格短名单。商店搜索相同的标准化记录，但允许用户比较所有合格匹配，而不要求模型选出唯一赢家。完整 README、Skill 指令、目录 shell string 与社区帖子永远不会被当成模型指令。需求文本与商店查询都不会进入目录 URL、request body、header、analytics event 或第二次 model request。

确定性策略过滤先于模型选择或商店获取。任务解析结果只能是：

- `use-existing`：当前 Agent 可见能力已经满足需求，不需要目录或变更；
- `management-required`：现有物料当前不可用，并且 owner evidence 指向一个准确的人工 configure、enable、update 或 restore 动作；
- `acquisition-candidate`：存在一个实质占优、可写且准确的合格候选；
- `choice-required`：两个以上候选在权限、数据目的地、scope、成本或结果上存在实质差异；
- `no-eligible-candidate`：fresh 且 complete 的 observation 没有找到准入候选；
- `discovery-unavailable`：当前 scope、catalog freshness、network/cache 或 policy evidence 不完整；以及
- `external-only`：找到了来源，但尚未通过目录准入。

商店卡展示名称、类型、一句话结果、publisher、准确 revision、compatibility、组件摘要、权限摘要与当前状态。详情和比较进一步展示完整 artifact identifier、digest、来源、组件与 Tool 清单、可测量时的 context cost estimate、Host/OS/runtime 与扩展依赖、scope、安装期与运行期权限、配置与凭据前置条件、重叠与硬冲突、签名状态、生命周期可用性和证据。候选文案、热度、下载量、star、review 与目录 badge 都是第三方或社区主张，只能辅助策展或并列排序，不能创造安装资格。UI 分别标注 upstream source、catalog admission、artifact pinning、compatibility、authority、runtime evidence 与 task evidence；其中任何一项都不代表安全或官方背书。stale、incomplete 或失败的 observation 不能变成成功空结果，也不能生成获取计划。

P0 是受控扩展商店与获取服务，不是开放发布 marketplace。评分、支付、流行度排行、任意发布、批量更新和社区治理都不在范围内。设计所依据的证据与对照记录在[能力发现与扩展商店研究](capability-rag-research.zh.md)。

### 全生命周期管理

发现、安装、配置、更新与卸载是 P0 的一等阶段，不能被压缩成一个通用 CRUD API。

| 阶段 | 普通用户获得的结果 | P0 要求 |
|---|---|---|
| 发现 | 从原始任务或人工搜索中找到已有可用能力或准入候选 | 先搜索准确 Agent scope，再搜索本地目录索引；返回明确 freshness/completeness 与 decision semantics；展示 upstream evidence、admission revision、compatibility、authority、准确版本或 revision，以及后续每项动作是否可用 |
| 安装 | 建立一个由扩展中心拥有且可恢复的扩展 | 只获取或注册准确准入的内容，创建 owner-specific record，校验初始配置，为所有变更写 journal，并在真正的消费方证明前拒绝标记 `active` |
| 配置 | 无需编辑 YAML 或文件即可改变支持的行为 | 使用带 Save 与 Discard 的 staged draft、revision fencing、owner validation、仅秘密引用、不可变计划，并为每次提交生成回执 |
| 更新 | 明确移动到一个准确准入的目标 | 只在用户显式选择后执行；比较 artifact 或 content、依赖、script、authority、release note、配置 schema 与迁移结果；新状态证明可用前保留旧的可用状态 |
| 卸载 | 停止扩展并移除扩展中心拥有的内容 | 先撤销 runtime contribution，只移除 center-owned row、file、dependency 与 artifact；在 ownership 允许时提供独立的保留或清除选项，验证不存在，并披露仍保留的远程或 owner 数据 |

enable、disable、restore 与永久 data purge 是拥有独立计划与回执的辅助写操作。`verify` 只刷新 owner evidence，不生成 mutation plan，也永远不调用任意 MCP tool。`rollback` 是失败事务的内部阶段；面向用户的恢复动作统一叫 `restore`。P0 不提供通用 `repair` 动作：UI 必须先把修复建议解析为 configure、update、enable 或 restore，才能进入 planning。Inventory 把每项动作显示为 `available`、`unavailable(reason)` 或 `external(read-only)`，因此缺少 owner capability 不会被误认为成功的空操作。

进入 P0 可写目录要求每个适用的发现、安装、配置、更新与卸载阶段都能实现并验证。owner 可以明确声明没有任何配置；这会满足 Configure，而不是虚构表单。缺少其他任一必要 owner capability 的候选仍可作为 incomplete 或 external 被发现，但不能生成一键安装计划。

### 不可变计划与人工确认

每次变更都从 Host 生成的计划开始；该计划绑定当前 inventory revision，并对规范化内容计算 hash。计划会过期且只能使用一次。计划包含：

- 操作类型（`install`、`configure`、`update`、`enable`、`disable`、`uninstall`、`restore` 或 `purge`）、扩展类型、owner、目标 Profile 或 Skill root 与期望状态；
- 精确 artifact 名称、版本或 revision、integrity 和来源；
- Profile manifest、lockfile、Bundle list、patch row、Skill 文件与凭据引用的变更；
- 依赖与 lifecycle script 发现、Bundle manifest 与 patch 条目、权限变化、configuration-adapter hash/version、schema digest、owner revision、normalized diff 或 migration result，以及重启要求；
- 对于 MCP stdio，包含准确 Host 预置的 executable、executable digest、固定参数、工作目录与用户选择的规范化 root；对于 HTTP，包含规范化 HTTPS origin、准确 endpoint、`authentication=none`、禁止重定向与强制数据外发警告；浏览器和 Agent 只能选择 Host 白名单中的不透明 `runtimeRef`，不能提交 command、URL、header、environment 字段或 secret；
- 将执行的分类型结构与运行检查；
- 对于卸载或清除，包含准确移除的 center-owned 内容、保留的 owner 或远程数据、credential-record 选择，以及是否仍可恢复；
- last-good 恢复点与回滚限制；以及
- 扩展中心无法验证的每一项主张。

在 Host 内部，两个入口都规范化为一个不可提交的 `AcquisitionIntent`：`origin`（`store` 或 `task`）、扩展类型与 id、准确 version 或 content revision、digest、scope、`operation`、`desired`、准入 capability set、authority delta、policy result 与 idempotency key，另有只在 `task` 来源存在的可选 `continuationId`。Host 从不透明 resolver reference 或在当前 catalog 中重新解析的商店选择导出它；Agent 与 browser 都不能填写其 coordinate、digest、authority、desired state 或 policy 字段。它的规范化 mutation core 是 candidate、revision、digest、scope、operation、desired state、准入 capability、authority delta 与 policy result。当这些输入相同时，商店与任务必须产生相同 core 以及相同 transaction mutation 与 verification step；provenance field、idempotency key、plan id 与 plan hash 可以不同。人工商店 MCP Install 与任务组合 MCP acquisition 的 desired state 有意不同，因此不声称 intent 或 plan 相同。该 intent 不是授权，而是 Host 能够据以生成 acquisition plan 的唯一内部记录。

只有持有本地管理通道的回环 Web client 可以确认并提交计划。仅通过 trusted-host admission 不足以获得安装权限。Host 必须在变更前最后一刻再次检查计划 id、hash、过期时间、Profile revision、catalog revision、resolution、continuation 与目标 ownership。目录描述与安装字符串只是数据，永远不能成为可执行输入。

P0 暴露两个狭窄的模型侧获取工具：

- `capability_resolve` 完全只读。它接收本机导出的 need 与当前 observation scope。对于 `acquisition-candidate`，Host 返回绑定候选的 `resolutionId`、不透明 `candidateRef` 与 single-use `continuationId`；三者绑定同一个 Session、user-message reference、need digest、scope、catalog/inventory revision、expiry 与 cancellation/supersession fence。模型可见 evidence 仅限 closed enum、normalized capability tag、不透明 id、pinned revision、authority flag 和一个限制长度的 catalog-authored factual summary。Publisher README、error、install prose 与社区文本只能作为转义后的 browser review data。该工具绝不返回可执行 install string。
- `capability_request_acquisition` 只接受 `resolutionId`、`candidateRef` 与 `continuationId`。它可以请 Host 生成 pending plan 并等待独立 loopback decision，但没有 confirmation 参数，也不接受 package、URL、command、configuration、scope escalation、credential、update、uninstall 或 recovery 输入。

对于 `choice-required`，当前 task attempt 以该 terminal outcome 结束。比较面可以收集人类的候选选择，但选择只会创建一个新的 task attempt、重新运行资格检查，并生成新的 candidate-bound resolution 与 continuation id；它不是获取授权。随后 Agent 仍须发起正常请求，由用户另行确认其准确不可变计划。

对于 `management-required`，当前 task attempt 以该 terminal outcome、一个不透明 extension reference，以及 configure、enable、update 或 restore 中唯一一个建议动作结束。它不创建 acquisition intent 或 mutation plan。用户可以在**扩展**中通过正常的准确计划与确认启动该生命周期动作；完成后绝不重新打开已经终结的 attempt。用户选择**重试原任务**时只创建新的 `taskAttemptId`，保留原 Session 与 user-message reference，并重新执行 existing-first resolution。如果新 attempt 返回 `use-existing`，该任务结果保持终态，实际续跑由一条独立的 Host durable continuation claim 管理。活动页把中心的严格 retry binding 与准确 Host claim 关联后，分别显示 Host 的 `pending`、`ready`、`consumed`、`claimed`、`canceled`、`superseded`、`expired` 或 `invalid`；中断的 reservation 显示为 `reconciling`，Host owner 缺失则显示为 `unavailable`。它绝不把 task outcome 改写成 continuation state。如果新 attempt 返回 `acquisition-candidate`，才生成正常的 resolution、candidate 与 acquisition-continuation identifier。Agent 不能启动或确认该管理动作。

调用请求工具不等于授权，在人工确认前不会产生任何 acquisition side effect。Agent 可以自主发起该请求，并在 owner 验证后使用新能力；它不能批准变更、调用 loopback confirmation RPC、通过 shell 或 package-manager tool 安装，也不能发起独立 configure、update、enable、disable、uninstall、restore 或 purge。任务合格 MCP 是唯一例外：完整 zero-secret 配置与权限已经进入准入候选和确认页时，可以形成一个准确且 `desired=enabled` 的 `install` plan；disabled row 只是 staging phase，回执分别记录 register、configure、connect 与 verify。它不会授予可复用的 Enable 操作。其他生命周期操作仍由管理界面中的人类发起。

Capability preflight 未找到所有必需的可写 Host owner 时，read-only preview 不注册 `capability_request_acquisition`；商店获取控件显示 `unavailable(host-capability)`，Host 也不能生成 acquisition intent 或 plan。仅仅注册一个稍后失败的模型工具，不能算合格的 read-only preview。

### 任务获取与续行

Agentic acquisition 使用独立于扩展 operation journal 的状态机。其可变 phase 为 `checking-existing → resolving → awaiting-approval → acquiring → verifying-visibility → restart-required | ready-to-resume → resuming`，并且只能以 `use-existing`、`continued`、`choice-required`、`management-required`、`no-eligible-candidate`、`discovery-unavailable`、`external-only`、`rejected`、`canceled`、`recovery-required`、`resume-conflict` 或 `failed` 之一及一个有界 reason 结束一次。terminal task record 不能再次转移。扩展操作可以成功，而 task outcome 是 `canceled` 或 `resume-conflict`；两条记录不能互相覆盖。

一键任务路径的准入条件比人工管理更严格。候选必须具备准确 artifact/content revision 与 integrity、兼容的已发布 DSH 范围、确定性 zero-secret 初始配置、没有 unresolved external runtime 或 credential、没有 lifecycle script、已知 authority delta、唯一 target scope、完整 owner-backed lifecycle 与确定性 runtime visibility recipe。任何需要用户选择、secret、任意 executable、未审查 URL 或实质更大权限的候选都返回 `choice-required` 或 `external-only`，不能静默默认。

Host 在绑定候选的 resolver response 中生成无秘密、single-use 的 `continuationId`，时间早于 Agent 请求获取。它最初绑定原始 Session 与 user-message reference、derived-need digest、observation scope、catalog/inventory revision、所选 candidate、expiry 与 cancellation/supersession fence；随后 Host 在不改变 id 的前提下继续绑定已接受 plan/operation identifier 与预期 runtime evidence。它不复制原始任务或目录文案。wrong-session、wrong-resolution、expired、replayed、canceled 或 superseded claim 都会被拒绝。续行前，Host 必须证明操作成功、预期 contribution 对准确 Agent scope 可见、源任务未取消也未被取代，并且 claim 尚未消费。

只有已发布 owner 能把新 winner 或 qualified Tool generation 实时暴露给当前 Agent 时，Skill 与 MCP acquisition 才能在下一个 model step 继续。Plugin acquisition 一定要执行真实外部 Profile restart。完整 P0 需要一个通用 DSH continuation owner，在 reconnect 并完成权威 cancel/supersession 复查后，从 durable claim 打开新 turn，并至多一次派发绑定的 continuation message。当前 rc.2 没有这项保证；扩展中心必须把 turn 结束在 `restart-required`，把 claim 保留为不可执行证据，并要求用户显式开启新 turn，而不能声称自动续行。

任务续行在使用前重新进入 capability resolution。它不能假设安装回执已经证明当前可见，也不能重放 acquisition request。只有新能力真正被调用后，原任务才能进入 `continued`；只有任务专用外部 observable 通过后，才能标为 task-verified。

### 分类型生命周期映射

| 类型 | 发现 | 安装 | 配置 | 更新 | 卸载 | `active` 生效证据 |
|---|---|---|---|---|---|---|
| Skill | 把 explicit observation scope 的官方 merged winner 同白名单中的准确内容 revision 比较，并说明 center-owned user entry 当前是否为 winner；P0 不声称可见隐藏 loser chain | 把校验后的文件原子写入一个由扩展中心拥有的用户 `$DSH_HOME/skills` 条目 | 只修改 `disable-model-invocation` 与 `user-invocable`；指令正文可审查，但 P0 不提供 authoring | 展示正文、manifest、asset、link 与 executable file diff；仅在本地 revision 仍匹配时替换为准确 revision，然后重新读取 merged winner | 把 center-owned user entry 移入可恢复回收站，再读取当前是没有 winner 还是露出了不同 winner；永久清除是第二项操作 | 官方 filesystem provider 返回完整 merged observation，`get()` 加载 winning exact definition，并且每个预期调用入口都可加载它 |
| MCP | 把当前 qualified tool 与严格的 Host 白名单 stdio 或 Streamable HTTPS descriptor、descriptor digest、executable precondition 或远程数据目的地、权限与支持平台比较 | 通过 dynamic MCP owner 注册一条初始禁用且由扩展中心拥有的 connection；HTTP 只使用固定远程 endpoint，stdio 则先证明准确 external executable 字节已经存在 | 选择一个不透明 `runtimeRef`；只编辑 `serverName`、规范化 stdio root、`toolCallTimeoutMs` 与 reconnect policy。command、固定参数、cwd、origin、endpoint、authentication、redirect、自定义 header 与 environment 字段都不是用户输入 | 应用一个准确 Host descriptor revision，重连并比较同步后的 tool generation，同时保留上一 descriptor 与 connection 用于回滚；该操作不更新 stdio executable 或远程服务 | dispose connection、停止重连、撤销工具、等待 stdio child 退出，再移除 center-owned connection；external executable 或远程服务保持不变 | 官方 MCP client 完成 initialize 与 `tools/list`，预期 qualified tool 存在于 `ctx.tools`，禁用或 disposal 会撤销工具并让 stdio child 达到静止 |
| Plugin | 展示白名单中的固定 registry artifact、integrity、Bundle entry、声明的 settings owner 与准确 DSH compatibility | 要求必需的 Profile transaction owner 在隔离 generation 中加入 dependency 与 Bundle membership，拒绝 lifecycle script，启动 staging，并以 `restart-required` 提交 | 通过 owner 提供的 Extension Center adapter 挂载 live Plugin 自有的 settings card 与 namespace，使用其 validator 与 revision fence；没有该 adapter 时，只提供 external link 或显示 Configure unavailable 及原因 | 选择固定版本；Profile owner 重新审查 integrity、dependency、script、Bundle、authority 变化与 settings-schema migration，启动 staging、commit，并等待外部重启后观察新消费方 | 要求 Profile owner 移除 center-owned dependency 与 Bundle membership，等待外部重启，并证明 Loader 与声明的 child 不存在；默认保留 owner settings，只能通过独立计划删除 owner 声明的数据 | 解析后的 artifact 与 Bundle 在 staging 中通过校验，准确 Profile 通过发布入口重启，Loader 达到预期状态，并且一个真正声明的消费方可观察 |

Plugin P0 只接受白名单 registry 中的固定版本。moving tag、任意 Git URL、本地 path、用户 tarball，以及依赖图中需要 `preinstall`、`install`、`postinstall` 或 `prepare` script 的 package 都会被一键路径拒绝。Plugin 更新是一次全新的授权，不能沿用安装授权。一个可写目录候选必须提供 plugin-owned Extension Center configuration adapter，或明确声明它没有用户配置。该 adapter 保留 owner UI、validator、credential control 与 revision，但会在保存前把 normalized diff 交给 Host-minted plan。已有 settings card 若没有该 adapter，只能作为 `external(read-only)` link，而不是中心管理的 Configure。配置绝不能退化成 raw YAML 或自动生成的通用 schema editor：只有 live owner 明确声明没有可配置项时才能展示 **No configurable options**；缺少或无法配对的 namespace、card 或 adapter 时必须展示 **Configure unavailable**。测试使用本地 `.tgz` fixture 作为锁定 registry artifact 的确定性替身；它不是产品输入入口。

Plugin configuration integration 是随目标 Plugin 打包、带版本且可选的 Host/Client contribution。它声明 adapter version、目标 Plugin version range、schema digest，以及对 user layer 与 credential reference 的确定性 validation 或 migration；browser owner card 提供 normalized proposed diff 与 live owner revision。Update plan 绑定 source/target artifact hash、adapter hash/version、schema digest、owner revision、normalized diff 与 staged migration result，并在 commit 前最后一刻重新检查 live owner。已配置 Plugin 的 staged target adapter 若无法在 promotion 前验证或迁移旧配置，Update 必须为 `unavailable(reason)`。该 adapter 由 effect 拥有，并且对目标 Plugin core 保持可选：目标 Plugin 的 tool、service 与普通 UI contribution 在没有 `ctx.extensionCenter` 或 center Client slot 时也必须加载。目录准入拒绝把 core activation 依赖中心的 Plugin；移除中心只撤销其 configuration integration。

通用 Plugin `disable` 与 `enable` 在 P0 中保持 `unavailable(reason)`：保留 dependency 但移除 Bundle membership 无法在 rc.2 reconciliation 下保持稳定，扩展中心也不会发明第二种 activation format。Plugin `restore` 只有通过必需的 Profile transaction owner 才可用，并恢复完整的具名 rollback point——artifact、dependency resolution、Bundle order、patch row 与 owner settings。它绝不能被当成 enable 的别名。

MCP P0 只支持现有 stdio 与 Streamable HTTP transport，并且只支持 Tools。它管理的是 connection definition，而不是 server runtime：**Install** 注册一条 center-owned connection，**Update** 选择一个准确 Host descriptor revision，**Uninstall** 在静止 disposal 后移除 connection。它永远不下载、构建、升级或删除 stdio executable，也不声称安装或更新 HTTP service。只有准确 canonical executable path、digest、固定参数与工作目录全部解析成功时，stdio 候选才能生成计划；用户配置只能增加规范化 root。HTTP 候选由规范化且无凭据的 HTTPS origin、准确 endpoint、强制数据外发说明、`authentication=none`、无自定义 header 或 environment credential，以及 fail-closed 禁止重定向策略组成。Host 拥有这个严格 descriptor union，并只暴露不透明 `runtimeRef` 选项；模型与浏览器都不能提交任意 command 或 URL。descriptor digest 贯穿 plan、durable state、inventory evidence、journal 与 receipt 重新绑定。每个 owner request 都携带准确解析后的 transport，以及从 `{operationId, phase, descriptorDigest}` 稳定派生且符合 Host 规则的 mutation id；Host receipt 还绑定结果 desired-record digest。任何 drift 都会在 mutation 前拒绝。P0 不会自动调用任意 MCP 工具作为健康检查。

人工商店管理继续把 MCP Install、Configure 与 Enable 作为不同的用户可见生命周期动作。已确认的人工 Install 必须由 owner 落地，而不是只写扩展中心占位记录：它通过 dynamic MCP owner 写入唯一严格禁用的 desired row，验证准确 owner revision 与 transport、observed disabled 状态和零 Tool，再签发普通 operation receipt。Configure 是更新该 owner row 的独立 immutable plan，Enable 则是后续单独授权的 plan。任务来源的 MCP acquisition 是更严格的组合：只有一个已准入、zero-secret、固定单一 scope 且没有 unresolved runtime 的 descriptor 才能生成一个 `desired=enabled` 的 atomic `install` plan。其 disabled row 是 staging，不是新的 lifecycle operation kind。确认前不能写 row、启动进程、发起 DNS/HTTP handshake 或解析凭据。确认后，已发布的 dynamic MCP owner 通过事务创建 disabled row、应用准确初始配置、启动或连接、完成 `initialize` 与 `tools/list`，再发布预期 qualified Tool generation。任何失败都要撤销 Tool、取消 retry、让 child 或 connection 静止、移除 staged row，并恢复此前 authority state。该 grant 不能复用于后续 Enable、重新配置、新 origin 或不同 descriptor revision。

Skill 安装与更新绝不会执行其中的 script。确认页展示完整文件清单、指令正文、调用开关、symlink，以及 script 或可执行 asset 的存在。更新是手工移动到白名单中的一个固定内容 revision；任何外部字节变化都会拒绝更新，P0 不合并也不覆盖这些编辑。路径穿越、跳出选定 root 的链接、畸形 frontmatter 与冲突的外部 revision 都会在提交前拒绝。项目 `.dsh/skills`、项目 `.agents/skills`、用户 `.agents/skills`、custom root、bundled Skill 与 runtime provider contribution 都是只读的；project write 要等待已发布的明确 workspace/Agent selector。

### State model

UI 永远不能把“已请求”“已物化”“已生效”和“已验证”压缩成一个 badge。

| Field | Values | Meaning |
|---|---|---|
| `desired` | `enabled`, `disabled`, `removed` | 用户已提交的意图 |
| `materialized` | `absent`, `installed`, `configured` | DSH 管理文件或依赖是否存在 |
| `effective` | `inactive`, `restart-required`, `starting`, `active`, `degraded`, `activation-failed`, `unknown` | owner runtime 当前真正证明的状态 |
| `agentVisibility` | `visible`, `not-visible`, `unknown` | 准确当前 Agent scope 是否能发现预期 Skill 或 Tool contribution |
| `verification` | `unverified`, `structural`, `runtime`, `task` | 已完成的最高证据层级 |
| `rollback` | `available`, `running`, `used`, `unavailable`, `failed` | 恢复能力与结果 |
| `ownership` | `center`, `external`, `system`, `parent-plugin` | 该行是否接受直接变更 |
| `operationKind` | `install`, `configure`, `update`, `enable`, `disable`, `uninstall`, `restore`, `purge` | 当前或最近一次操作的生命周期意图 |
| `updateObservation` | `unknown`, `none`, `available` | 只表示目录观测；`available` 必须包含一个准确目标，绝不能改变 desired 或 effective state |
| `taskPhase` | `none`, `checking-existing`, `resolving`, `awaiting-approval`, `acquiring`, `verifying-visibility`, `restart-required`, `ready-to-resume`, `resuming` | terminal outcome 之前可变的原始任务进度 |
| `taskOutcome` | `none`, `use-existing`, `continued`, `choice-required`, `management-required`, `no-eligible-candidate`, `discovery-unavailable`, `external-only`, `rejected`, `canceled`, `recovery-required`, `resume-conflict`, `failed` | 带有界 reason 的 single-assignment terminal result，独立于扩展 operation outcome |

操作遵循 `planning → awaiting-confirmation → staging → verifying → committing → succeeded`。任何 staging、verification 或 commit 失败都进入 `rolling-back → rolled-back`；只有恢复失败才进入 `recovery-required`。进程结果独立记录 timeout、signal 与 exit code。

配置草稿和观察到的更新都不会改变运行中的扩展。配置或更新操作在目标 owner 接受已提交 revision 且所需运行检查通过之前，仍以此前的 material、configuration 与 effective evidence 为权威；失败时恢复这三个旧值，而不能发布混合状态。

分类型细节仍然可见：Plugin 行保留 Loader Fiber phase；MCP 行保留 configured transport、last observed tool generation，以及 live detail 是否 unavailable；Skill 行保留 snapshot completeness、winning source、center-owned material state、validation 与独立的模型/用户调用策略。P0 绝不能虚构 owning rc.2 service 没有发布的 MCP reconnect state 或 Skill loser chain。

### Receipts and task verification

每次操作都生成持久且无秘密值的回执，其中包含操作类型、计划 hash、来源与 integrity、作用域、变更前和目标状态、配置与迁移结果、实际提交的 DSH 管理变更、保留数据与凭据选择、真正运行的检查、重启要求、运行观测、回滚点与结果，以及仍未验证的主张。回执能跨浏览器刷新与 Host 重启恢复。

Agent 发起的获取另有一份无秘密 task receipt，只包含 Session/user-message reference、derived-need digest、resolution/candidate identifier、catalog/inventory revision、plan/operation/continuation identifier、人工 decision、visibility observation、resume outcome 与 task observable。它绝不保存原始用户任务、检索到的社区文案、秘密值或模型 chain-of-thought。拒绝、取消、过期与 replay 各自只产生一条 terminal decision record，并且没有 acquisition side effect。

扩展中心使用准确标签：**结构验证通过**、**隔离 Profile 已启动**、**当前 Profile 已运行**、**MCP 握手与工具同步完成**、**Skill 对目标 Agent 可见**和**用户任务结果已验证**。任何较早标签都不能暗示后一个标签。

任务验证是一条显式的普通 DSH task，外部可观察结果由用户选择，或来自目录自有的确定性 recipe。在任务驱动路径中，它就是原始用户任务，而不是替代性的“测试扩展”提示。扩展中心可以把回执与相应 Session 证据关联，但不能虚构通用 oracle。没有外部结果或预期调用序列时，扩展保持 runtime-verified，任务则只是完成但没有产品级验证结果。

### Recovery outside the Web UI

- 变更前，每个已发布 operation owner 记录自己准确的 DSH 管理文件、hash、Bundle 顺序、凭据引用与 recovery point。对于 Plugin，必需的 Profile transaction owner——而不是扩展中心 browser 或 rc.2 磁盘编辑器——创建并验证隔离 generation。
- Profile owner 只 promotion 经过验证的 generation，并返回具名 last-good point。真正运行的 Profile 仍显示 `restart-required`，直到外部 launcher 完成真实重启且扩展中心重新连接。
- 中断事务在下一次 Host 启动时从 journal 恢复，并完成回滚或进入 `recovery-required`；它永远不能仅凭文件猜测 `active`。
- 一条位于回执锁定绝对恢复路径的固定 break-glass CLI 可以列出 pending receipt，并在不加载 installed package 或待修 Web Bundle 的情况下要求已发布 Profile owner 恢复指定 last-good generation。

回滚只保证 DSH 管理状态。它不能撤销远程 grant、网络请求或第三方代码产生的副作用；回执必须说明这一限制。

### 独立项目生命周期

- Product-owned durable state 位于 installed package 与 Profile generation 之外的 `$DSH_HOME/extension-center/`：private operation journal、secret-free receipt、ownership manifest 与 last-good recovery point 分别使用带版本的子目录与 hash。安装与更新把构建后的独立恢复模块原子复制为 `$DSH_HOME/extension-center/recovery/<center-version>/<platform>-<arch>/break-glass.mjs` 下的 owner-only executable，校验其 packed-artifact hash，并在每个可能需要它的 journal 中锁定该绝对路径与 hash；恢复过程永远不从 `node_modules` 导入代码。该 package 不声明 npm `bin`：公开 Profile transaction owner 会拒绝 package binary，恢复只通过准确的 `node` 调用运行复制后的 hash-pinned module。
- 扩展中心自身的 inventory 行保持只读，并展示准确的通用 DSH CLI 安装、更新、降级与移除命令。它的 UI 永远不尝试自我变更。
- 扩展中心 `vN-1 → vN` 验收通过通用 CLI 升级；先迁移 plugin-owned durable state 的副本，再发布新状态，并证明 Host 与 Client protocol version 一致，然后完成一次真实 managed operation。stale browser Client 会收到明确的 reload-required 响应，不能对更新后的 Host 提交变更。
- 自身升级失败时，在 Web 之外重新安装准确的上一 artifact。产品 rollback 代码可以恢复扩展中心管理的其他扩展，但不能声称运行中的损坏 package 能恢复自己。
- 文档中的 generic removal 路径要求扩展中心 idle，不存在进行中的 staging、promotion 或 rollback，并且 operation lock 已释放。操作中被外部强制移除属于 external interference：恢复由持久 journal 与 hash-pinned recovery executable 拥有，而不是由已经消失的 browser page 拥有。
- 通用移除会撤销 Host service、Connection channel、Client graph row、style、listener、timer 与 process，并且不改变已管理扩展或用户 patch。journal、receipt、ownership data、recovery point 与仍被它们引用的 recovery executable 默认保留；单独的显式 purge 在任何 pending operation 或 retained recovery point 仍引用目标版本时必须拒绝。
- 重装时，只有 ownership manifest、authoritative bytes、准确 revision 与预期 runtime owner 全部仍匹配，对象才重新获得 `center` ownership。中心缺席期间被修改的对象变为 `external(read-only)`；重装永远不自动 adopt、overwrite 或 rollback。

## Trust and authority

| Kind | Authority the user grants | Required P0 disclosure |
|---|---|---|
| Skill | 指令可以改变模型决策，并引用本地 script 或 asset | 完整来源、正文、文件清单、目标作用域、调用开关，以及“目录准入不等于指令审计”的说明 |
| MCP | Stdio 启动宿主进程；HTTP 把工具输入发送到远程 origin | 准确白名单 command 或规范化 HTTPS origin、固定参数、cwd、executable 或 descriptor digest、明确的零认证与禁止重定向策略、数据外发警告、已发现工具，以及“已连接不等于安全结论”的说明 |
| Plugin | 第三方 Host 或 Client 代码以当前用户的进程权限运行 | 准确 artifact、依赖与 script 发现、Bundle 行、同进程权限警告、重启要求，以及“运行成功不等于代码审计”的说明 |

秘密值永远不能出现在 inventory、plan、浏览器读取响应、patch 文件、command 参数、日志、Session event、snapshot、error 或 receipt 中。配置只携带引用；credential owner 只在需要值的操作中解析。移除扩展时可以单独删除由扩展中心拥有的本地 credential record，但绝不能声称远程 authorization 已被 revoke。

不可信名称、描述、README 文本、tool schema 和 error 都以转义纯文本呈现。spawned process 获得经过清理的 ambient environment，并只加入明确批准的引用。临时目录保持私有，文件仅 owner 可读写且以 exclusive create 创建，路径随机化。Teardown 先关闭 notification listener，请求 child 优雅停止，在有界 grace period 后杀死仍存活的 child，最后等待并确认进程退出。

## Ownership and extension points

外部 package 声明插件自有的 `ctx.extensionCenter` service，负责 normalized catalog snapshot、本地 Store search、Capability RAG、acquisition request、provider registration、不可变 plan、operation serialization、receipt 与 recovery orchestration；它不是新的 DSH core Service Definition。Bundle 通过普通 Tool registration 向准确 Agent scope 贡献只读 resolver 与不透明 acquisition-request Tool；确认仍是独立 loopback Client 动作。三个 provider 实现都位于独立仓库，并适配已发布的 DSH owner，而不是绕过它们：Skill provider 拥有准确文件并观察 filesystem provider 与 Skill registry；MCP provider 拥有扩展中心生成的配置行并观察 DSH client 与必需的 dynamic connection owner；Profile provider 调用必需的已发布 Profile transaction owner 来完成 staging、Bundle reconciliation、commit 与 generation rollback，再观察一次外部重启。Profile transaction、dynamic MCP connection mutation 与自动跨重启续行在 rc.2 中保持 unavailable。该 package 通过已发布 Client 扩展机制注册一级**扩展**入口，其默认商店视图与已安装、更新、活动与恢复并列。

每个 provider 负责 provenance、分类型 detail，以及 discover、install、configure、update、enable、disable、uninstall、restore 与 purge 的逐对象 capability map。每项可写 capability 都要提供 plan、apply、verify 与 rollback，或者明确不可逆结果；每项 unavailable 或 external capability 都要给出稳定原因。manager 负责每个目标 Profile、MCP row 或 Skill root 同时只运行一项操作、idempotency、revision fencing、event ordering 与 durable receipt。Provider registration 和每项 status contribution 都是 Cordis effect，其 disposer 会撤销相应行并达到静止。

Profile `package.json`、lockfile、Bundle list、user patch、Skill root、credential provider、Loader、`ctx.tools` 与 `ctx.skills` 仍是权威 runtime state。admitted catalog 只拥有 candidate eligibility；上游 registry 与社区来源只拥有自己的主张。operation journal 只记录扩展中心尝试了什么以及如何恢复；continuation owner 拥有可恢复任务状态。Managed Plugin Configure 只通过产品带版本的 configuration-adapter contribution 挂载 live owner card；该 adapter 保留 owner field、validator、credential control 与 revision，同时把 normalized proposed diff 送入 planning。普通 owner card 若没有 adapter，就保持 external deep-link。MCP 与 Skill 表单是扩展中心基于其已发布配置提供的 adapter。扩展中心绝不能成为通用 schema 或 YAML editor。

该 package 消费现有的 [Profile Bundle 分发机制](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.zh.md)和公开 Client 扩展机制。它不修改 DSH 内置设置实现，不 fork Web 应用，也不会与[模型编写的临时 Cordis Plugin](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.zh.md)合并；后者的信任、ownership 与 lifetime 完全不同。

## P0 exclusions

把一个 center-owned 扩展手工更新到白名单中的一个准确版本或 revision 属于 P0。以下更宽泛或没有 owner 的行为不属于 P0：

- 任意 npm package、Git URL、path、tarball、shell install command 或 lifecycle-script allowlisting。
- Moving tag、自动更新、后台更新、批量动作、依赖自动修复或自动解决冲突。
- Marketplace 评分、评论、支付、流行度排序、官方认证或安全 badge。
- 托管语义搜索，或把用户原始需求、Session metadata、workspace 内容或凭据发送给目录、repository host、analytics service 或第二个模型。本地 Capability RAG 属于 P0。
- 模型批准变更、没有准确人工 decision 的无人值守安装、Agent 访问 confirmation RPC、session-wide install authority 或持久记忆 install grant。Agent 只用不透明标识发起请求属于 P0。
- 从任意 Web/社区结果、用户 URL、目录文案、package name 或 shell command 直接获取；这些来源在后续不可变目录 revision 正式准入前保持 `external-only`。
- 跨 Profile 操作、远程 Host、共享多用户管理、组织 RBAC 或跨设备同步。
- 编辑 Agent Preset 内联配置，或改变 sandbox 与 permission policy。
- Skill authoring、富文本编辑、自动上游合并，或修改 `.agents`、custom、bundled 与 runtime Skill 来源。
- 在没有已发布的明确 workspace 与 Agent selector 时写入 project-scoped Skill；P0 只写自己拥有的用户 `$DSH_HOME/skills` 条目。
- MCP Resources、Prompts、OAuth orchestration、远程 grant revoke 或任意工具试调用。
- 在 rc.2 上创建 authenticated MCP、使用 center-owned credential wrapper，或在 UI 中声称未暴露的 connecting/reconnecting/exhausted state。
- Plugin 在 Bundle 成员变化后的热启用，或通用 process supervisor；重启保持显式。
- 直接修改不受支持的 rc.2 Profile internal，或把 pnpm-forwarding CLI 描述成 atomic transaction/generation owner。
- 完整 Skill loser 或 precedence graph；P0 只观察官方 merged winner，以及自己的准确条目是否成为 winner。
- 自动接管或修改由 CLI、文件、runtime 或 Plugin 拥有的扩展。
- 声称目录准入、artifact 锁定、运行激活或任务完成能够证明代码安全。
- 把扩展中心产品 package、UI、目录数据或 Release 机制加入 DSH monorepo。
- fork、复制或 patch DSH 内置 Web component，而不是使用已发布扩展点。

## Alternatives considered

**在 DSH monorepo 内实现扩展中心。** 这会把产品迭代、目录政策、发布节奏和社区信任决策绑定到 DSH core。独立 Bundle 才是产品；DSH 只作为宿主，并且只发布通用扩展点。

**Fork 或 patch DSH Web 应用。** 这样能更快得到一个页面，却会让每次 DSH 更新都变成合并工作，并绕过受支持的 Client plugin lifecycle。P0 通过已发布扩展点注册；遇到不支持的 DSH 版本时明确拒绝，而不是 patch 它。

**在所有扩展之上提供一个通用 CRUD 接口。** 这会让实现看起来更小，却抹掉用户真正需要的事实：Profile 重启、MCP 进程与网络权限、Skill 作用域与 shadowing，以及 parent-Plugin ownership。该 proposal 统一导航和操作，但保留分类型 provider 与证据。

**通过 Remote 暴露现有 `dsh plugin` pnpm 转发器。** 从浏览器转发任意 package-manager 参数会绕过来源准入、不可变计划、build-script policy、staging、revision fencing 与 recovery。Profile provider 只能在针对已解析 artifact 的有界事务中调用同一个 package manager。

**让 Agent 浏览 Web 并运行安装命令。** 这看起来更自主，却会让不可信文案选择代码、进程、网络与指令权限，把任务上下文泄漏给任意来源，并让 replay 与 recovery 无法证明。P0 允许 Agent 发现和发起，但只有准入的不透明候选才能进入 Host-minted plan，也只有 loopback 人类能够授权。

**要求用户在每个任务前先逛目录。** 这会复现 marketplace 摩擦，并假设用户已经知道自己缺什么。Agent 辅助路径从任务开始，先查现有能力，检索一个窄候选集，再回到同一个目标。地位平等的商店路径则在用户明确希望先探索、比较或获取时随时可用。

**交付 inventory 与安装，但不做 rollback。** 失败的 Plugin 可能让安装它的 Web UI 无法再次启动，而 MCP 或 Skill 写入也可能替换此前可用配置。因此，在 Web UI 之外的 recovery 真正工作并证明旧 Profile 可启动之前，可写 P0 必须保持阻塞。

**把 connection 或 Loader activation 当成任务成功。** 运行证据只能证明消费方存在，不能证明它解决了用户需求。产品将任务验证独立保留；没有外部 oracle 时，最高诚实状态就是 `runtime`。

## Acceptance path

### Acceptance Red A——任务驱动获取与续行

实现前先在独立仓库增加一个 keyless 外层黑盒场景。它运行真实 packed Bundle、Loader、resolver、Extension Center Host/Client、loopback RPC、浏览器、Skill registry、dynamic MCP owner、filesystem、Session persistence、approval/cancellation 与确定性 script model；只有 catalog/artifact edge 与模型是 fixture。该场景起始为 Red，因为产品 artifact、模型侧 acquisition request、Profile transaction owner、dynamic MCP connection owner 与 durable cross-restart continuation owner 都不存在。

1. 从空的隔离 Harness home 启动一个未经修改的受支持 DSH Release，只安装 packed Extension Center Bundle，不提供 shell 或通用 filesystem escape tool，也不预装 fixture Skill。固定目录含一个正确 Skill 候选与一个 decoy；高熵答案只存在于正确 Skill 正文，绝不出现在目录元数据或模型 fixture。
2. 用户只说：“请按 Acme Q7 值班规则，把告警 `E17/P3` 转成应急口令，只输出口令。”提示中不得出现 resolver、extension、Skill、marketplace、install 或 candidate。
3. 证明 Agent 先检查准确当前 scope。独立 preinstalled lane 必须使用现有 Skill，不产生 catalog request、plan、confirmation、download 或 write。
4. 缺能力 lane 的固定 snapshot GET 不得包含 task marker、用户文本、Session id、cookie、credential、workspace content 或 secret。Host 验证 pinned root、threshold signature、digest、单调 revision、chain 与 expiry 后，本地检索才能返回 fresh `acquisition-candidate`。模型 evidence 只包含有界标准化字段与不透明标识，不能包含 raw install string 或 publisher/community prose。
5. Agent 选择正确准确的 `candidateRef` 并调用 `capability_request_acquisition`。loopback decision 前，外部 ledger 必须证明 artifact read/download、extraction、credential resolution、process execution、file/Profile mutation 与 restart 全部为零。
6. 浏览器展示来源、content revision、integrity、目标 Skill root、完整 file/executable manifest、invocation policy、authority、verification recipe、plan hash 与原任务 continuation intent。浏览器而不是 Agent 单次允许准确计划。
7. 中心原子安装 Skill，再通过官方 `snapshot()`、`get()` owner 与 model-invocable surface 证明准确 revision 在原 Agent scope 成为 winner。只有这些 observation 通过，请求才能返回 `installed-and-runtime-verified`。
8. 同一 Session、同一 turn 的下一模型 step 重新读取能力、加载新 Skill，并在不创建或复制新 user message 的情况下继续原任务。最终答案必须等于 Skill 高熵 fixture；Session evidence 必须证明获取前 Skill 不存在、使用前已经存在，并且真实被调用。
9. 运行 `use-existing`、`choice-required`、`management-required`、fresh `no-eligible-candidate`、冷启动网络故障、stale last-good catalog、伪造或未知 key 签名、digest tamper、revision rollback、frozen/expired snapshot、恶意目录文案、selection 后独立 confirmation、wrong-session/wrong-resolution claim、token replay、并发 superseding task 与 secret-sentinel 分支。对于 `choice-required`，选择必须让旧 attempt 保持 terminal，并先创建新的 candidate-bound attempt，才能请求获取。对于 `management-required`，一个不可用的 managed fixture 让 attempt 以唯一人工动作结束，且不创建 acquisition intent 或 plan；完成该动作再选择重试时，创建新 attempt 并执行 existing-first resolution。确认前 reject、cancel 或 expire 必须让每个 acquisition side-effect ledger 保持为零。确认后但 commit 前取消可以留下 fetch 或 staging observation，但必须静止并清除全部临时物料，且 authority state 不变。commit 后任务取消保留诚实安装的 extension 与 operation receipt，但禁止续行。每个 task outcome 只能终结一次，query marker 与 secret 都不能跨越禁止边界。
10. 运行一个答案只存在于固定 unauthenticated streamable HTTP MCP Tool 后面的同 turn 任务。一个准确准入 descriptor 包含完整 zero-secret 配置与单一 scope。确认前不能有 Profile write、DNS、handshake 或 Tool。确认后，dynamic MCP owner 原子暂存 disabled row、连接、观察准确 qualified Tool generation，Agent 再调用它完成原任务。initialize 失败、意外 Tool list、取消或 disposal race 必须撤销 Tool、connection、retry 与 staged row；以后再次 Enable 需要新的人工计划。该 lane 在已发布 DSH Host 提供通用 dynamic MCP owner 前保持 Red。
11. 运行一个答案只存在于固定 Plugin contribution 的黑盒任务。准确人工确认后，Profile owner 提交 `restart-required` 与 durable continuation claim。外部 launcher 重启 Profile；通用 DSH continuation owner 证明准确 consumer，从原 objective 打开一个新 turn，并在无需用户重发任务的情况下对绑定 continuation message 保证 at-most-once dispatch。任务是否完成必须再由独立 Session evidence 证明。cancel、replay、supersession、failed boot 与 missing-consumer lane 均不得续行。该 lane 在已发布 DSH Host 提供通用能力之前保持 Red。

动态 Skill 与 MCP lane 分别证明同 turn 获取与使用；Plugin lane 证明跨重启任务续行，三者不能互相替代。真实 DeepSeek provider 变体让每个普通语言任务在至少三个全新 Session 中无重试通过。没有 provider key 时允许 self-skip，但 Release receipt 保持 **Provider E2E Pending**。

### Acceptance Red B——用户自主扩展商店

增加一个禁用模型侧工具和全部外部网络的主 keyless 浏览器黑盒 lane。它使用 packed Bundle、signed bootstrap snapshot、真实 Host/Client RPC、catalog verifier、transaction engine、owner registry 与 filesystem，并且必须独立于任何 Agent 任务通过。另设一个 paired convergence sub-lane，只在另一个隔离 home 中明确启用真实 resolver 与 acquisition-request surface；它不能削弱 Store-only 门禁：

1. 从干净 Harness home 启动后，一级**扩展**入口默认打开商店，并提供商店、已安装、更新、活动与恢复。用户无需 chat、model、API key、package coordinate、YAML 或 pnpm，就能浏览、搜索、筛选、比较并开始获取。
2. 网络被拒绝时，signed bootstrap snapshot 提供确定性的策展类别和准确 Plugin、MCP、Skill fixture。按名称、结果、发布者、标签与全部已声明筛选项搜索得到可复现结果；不能产生 DNS、HTTP、telemetry 或 fallback search。
3. 为同一结果比较三个跨类型候选。卡片、详情与比较展示每个必需的来源、revision、digest、组件、compatibility、dependency、authority、configuration、scope、conflict、lifecycle、restart、evidence 与 retention 字段；缺失数据明确显示 `未声明`。
4. 候选级失败——moving reference、不兼容 Host/OS、unresolved runtime、不完整 lifecycle、hard conflict 与 `external-only` lead——都不能暴露 Acquire。每条已准入记录保留准确且可行动的原因。
5. Snapshot envelope 级失败——tampered digest、无效、未知或已撤销 key、signature threshold 不足、rollback、revision link 断裂、expiry 或 freeze——必须在建立索引前生成一个全局 `discovery-unavailable` 状态。不能渲染 rejected payload 中的任何 candidate；商店只能渲染独立满足 pinned root 的 bootstrap 或 last-good snapshot。
6. 选择合格候选与 scope 时，Client 只能发送不透明 selection identifier。Host 重新解析并在内部导出 `AcquisitionIntent`；browser 提交的 coordinate、version、digest、authority、desired state 与 plan 字段都被忽略或拒绝。打开或取消准确 confirmation 时，每个 acquisition side-effect ledger 都保持为零。
7. 汇合验证在同一个 signed snapshot 与空 inventory 上启动两个全新隔离 home。商店 home 选择一个准确 Skill，其 `scope=user`、`operation=install`、`desired=enabled`；任务 home 则由 deterministic script model 通过真实 resolver 与 request tool 选择相同输入。两边都停在确认前。它们的规范化 mutation 与 authority core，以及 transaction mutation 与 verification step 必须相同；origin、continuation、idempotency、plan id 与 plan hash 可以不同。拒绝两边并证明零副作用。
8. 在一个新的商店 lane 中确认固定 Skill plan，证明官方 owner winner 与当前 scope visibility，再刷新浏览器。已安装分别展示 material、effective、visibility、verification、configuration、update、recovery state 与回执；商店卡变为已安装，但不产生重复 row。
9. 另做一次 post-install existing-first 检查：启用 resolver 并提交相同 need。它必须在访问 catalog 前返回 `use-existing`，且不创建 acquisition intent、plan、authority、operation 或 receipt。
10. 在 rc.2 负基线上，相同商店仍可浏览和比较，但每项 mutation 都显示 `unavailable(host-capability)`，`capability_request_acquisition` 不存在，也不能生成 intent 或 plan。在 `<p0-host-release>` 上，获取只能经过已发布 owner。
11. 重启 Host 与 Client，证明准确 revision、scope、configuration、runtime evidence、receipt、Store/Installed 关系与进行中或 terminal operation 都从 owner 和 journal 重建，而不是来自 browser cache。
12. 仅用键盘即可到达搜索、筛选、比较、详情、确认与恢复；reject 或 failure 后焦点回到来源卡片，状态不只依赖颜色表达。

### Acceptance Red C——完整生命周期与恢复

再增加一个外层黑盒 capability lane 与浏览器场景。capability lane 把 packed artifact 安装到 rc.2 负基线，分别证明 Profile transaction、dynamic MCP connection 与 durable continuation capability 不可用，并证明所有写动作 fail closed；然后要求一个发布全部三项所需 Host capability 的准确 `<p0-host-release>`。当前该 lane 保持 red，因为这样的受支持 Host Release 与产品 artifact 都尚不存在。gate 可满足后，浏览器场景从空的隔离 Harness home 开始，并驱动以下完整纵切：

1. 构建并打包 `dsh-plugin-extension-center`；检查 tarball，证明其中包含构建后的 Host、Client、Bundle patch、恢复命令和文档，同时不含 DSH 源码 checkout 或安装 lifecycle script。
2. 针对干净且未经修改的 `dsh-v0.1.1-rc.2`，证明 capability preflight 分别报告 Profile transaction、dynamic MCP connection 与 durable continuation owner 不可用，不注册 acquisition request tool，也不能生成 write intent 或 plan。然后通过 `dsh plugin --profile web add <artifact>` 把同一准确 tarball 安装进干净且未经修改的 `<p0-host-release>`；记录其准确 tag 与 commit，检查 Profile manifest、lockfile、Bundle list、`--dump-config`、全部三项已发布 capability，以及真实 Web boot。
3. 打开 Extensions，观察三类空 managed group 与只读 system contribution。分别提交一个已被当前 tool 或 Skill 满足的需求，以及一个存在白名单候选的需求；验证前者推荐现有能力，后者展示固定来源与 revision，并且每一行都为各项生命周期动作显示 `available`、`unavailable(reason)` 或 `external(read-only)`。
4. 完成 Skill 全周期：安装 user-scoped v1，通过 staged draft 配置两个调用策略，在一个 explicitly selected observation scope 中启用并调用，审查完整内容 diff 后更新到固定 v2，再验证官方 registry 返回 v2。planning 与 commit 之间发生外部编辑时必须拒绝且不 merge、不覆盖；invalid v3 必须保留或恢复可用 v2。
5. 针对隔离 Host 中已经存在的固定 unauthenticated executable fixture 完成 stdio MCP 全周期：选择其不透明 `runtimeRef`，安装一条初始禁用的 center-owned connection，配置 `serverName`、规范化 root、timeout 与 reconnect，然后启用。验证 initialize、tool discovery，以及一次具有外部结果的普通 guarded call；证明 executable path、digest、固定参数、cwd 与 external bytes 都被准确绑定且保持不变。该 lane 不存在 command、authentication、header 或 environment 控件。
6. 把 stdio connection 更新到固定 Host 白名单 v2 descriptor，并证明旧 tool generation 被替换且没有重复。planning 后发生 descriptor drift 必须在 owner mutation 前失败；失败 v3 必须恢复 v2 descriptor、connection 与工具，并且不修改 executable。
7. 通过不透明 `runtimeRef` 安装并配置本地 unauthenticated Streamable HTTPS fixture，展示其规范化 origin、准确 endpoint 与数据外发警告，单独确认其 Enable plan，并证明第一次 handshake 与 tool generation 只在该 plan 提交后发生。执行一次确定性的 guarded call，再更新其固定 descriptor revision，并禁用和恢复它。证明 HTTP、非规范化或携带凭据的 coordinates、authentication、自定义 header、environment secret，以及任何不是 fail-closed rejection 的 redirect policy 都会被拒绝；回执必须说明远程服务本身既没有被安装，也没有被更新。
8. 安装预构建的目标 Plugin v1 artifact；验证 plan 与 staged Profile，然后要求重启，而不是把它报告为 active。通过 DSH 发布入口优雅停止并重启同一个 Profile；浏览器重连后观察目标 Plugin 的真实 tool 或 UI contribution。
9. 从 Plugin 详情打开 owner-provided adapter 与 settings card，stage 并保存一项设置，再观察声明的 live 或 restart 行为。planning 与 commit 之间发生并发 owner-settings revision 或 adapter hash/version 变化时必须拒绝，并保留 browser draft 与 v1 runtime；扩展中心不能暴露通用配置写入器。
10. 目标 Plugin v2 fixture 会改变 settings schema；在审查 artifact、dependency、script、Bundle、authority、release note、adapter 与 schema 差异后更新到该固定版本。promotion 前执行 staged v2 adapter 的确定性 validation 或 migration，外部重启并观察 v2 行为；target adapter 缺失或 incompatible 时，Update 必须在 mutation 前 unavailable。
11. 运行两个不同的 Plugin v3 故障。Fixture A 含 invalid patch 或 apply，在 staging 中失败且从未 promotion。Fixture B 通过 staging，然后由 harness 在 promotion 后、首次 promoted boot commit 前 kill process 或破坏 generation。Web Bundle 不可用时，通过固定 break-glass executable 恢复 v2，再次启动，并分别记录 `staging-validation-failed` 与 `post-promotion-recovery` receipt。
12. 禁用并恢复 Skill 与两个 MCP server，证明下游 contribution 消失并恢复，且没有重复项、stale tool、reconnect loop 或 orphan process。对于 Plugin，验证通用 Disable 与 Enable 明确 unavailable，再通过 Profile owner 恢复具名 v2 rollback point，并在所需外部重启后观察 consumer。
13. managed fixture 仍然生效且没有 operation 运行时，通过通用 DSH CLI 移除扩展中心自身并重启未经修改的 Profile。证明目标 Plugin 的 configuration adapter 消失，但其 core consumer、unauthenticated MCP tool 与 Skill 仍然工作。中心缺席期间，外部修改一条独立 ownership-sentinel Skill row；重装后，从 DSH owner 重建未变化对象，把 drifted sentinel 分类为 `external(read-only)`，恢复 operation history，并证明 adapter 返回且无重复。在一份单独的隔离 fault copy 中，让 journal 停在 `recovery-required`，由外层 harness 强制移除 package、重启，再执行 receipt-pinned recovery path；该命令必须验证自身 hash，不导入 package 代码，经 published owner 恢复，并启动 last-good consumer。
14. 卸载 Plugin、Skill 与两个 MCP row。逐项审查准确的 runtime withdrawal、center-owned 内容、保留的 settings 或 remote data、credential-record 选择与 rollback 状态；在需要时重启，并证明扩展不存在，同时无关 Bundle 顺序、settings、credential、external executable 字节与 workspace 文件逐字节不变。
15. 在至少一项 install、configure、update 与 uninstall 操作中刷新浏览器或重启 Host。从 journal 继续或确定性回滚同一 operation 与 receipt；重放已使用的 plan 不能改变状态。
16. 每个 UI 断言之后都检查 Host 与 filesystem 状态；DOM 不能自我认证成功。

提交的 fixture 保持本地且确定。它们只 mock catalog/network 与 model boundary，而不 mock Loader、filesystem、MCP transport、package management、RPC 或 browser composition。

另一个外层 artifact-upgrade Red 只使用 packed artifact：通过通用 CLI 安装 Extension Center v1 → 更新到 v2 → stale v1 Client commit 被拒绝 → 完成一次真实 v2 management operation → 准确降级到 v1 → 完成一次真实 v1 operation。它记录 Host/Client protocol version，不能复用任一 build 的 source process。

### Focused verification

| Layer | Required evidence | Failure condition |
|---|---|---|
| Repository boundary | 打包 artifact 在独立 checkout 中构建，只消费已发布 DSH export，并安装进未经修改的受支持 Release | 构建或运行时解析 DSH workspace path、要求修改 DSH 源码，或 patch 内置 Web 文件 |
| Inventory | 确定性的三类合并，带 owner、scope、provenance、准确当前与更新 revision、desired/effective state、官方 Skill winner、显式声明的 child、只读分类，以及逐动作 availability 与原因 | scan 顺序改变输出、child owner 在没有证据时被推断、Loader row 被标成 installed，或不支持的动作消失/显示为可写 |
| Capability RAG | existing-first search、有界 `CapabilityNeed`、fixed-origin snapshot fetch、本地检索、top-candidate hydration、freshness/completeness semantics、不透明 reference、来源证据，以及原始任务/不可信指令不跨 catalog/model 边界 | Agent 编造 package、原始任务离开 Host、stale/partial data 变成 no-match、目录文案变成指令，或 external-only lead 变成可写 |
| Agent acquisition request | 模型工具 schema 只接受 resolution/candidate/continuation identifier；Host re-resolution、确认前零 side effect、准确 loopback decision、single-use authority、cancel/reject/replay 行为与官方 post-install visibility | Agent 提交 coordinate/config/secret、能访问 confirmation、人工 decision 前 mutation 已开始，或准确 Agent visibility 证明前返回安装成功 |
| Plans and authorization | canonical hash、expiry、single use、revision fence、loopback enforcement、转义不可信文本，以及 install、configure、update、enable、disable、uninstall、restore、purge 八类写动作的完整拒绝矩阵 | remote、expired、hash-changed、revision-stale、replayed、wrong-action、wrong-target、wrong-Profile、wrong-owner 或 wrong-scope plan 触发 download、extraction、credential resolution、execution、write 或 restart |
| Configuration ownership | staged Save/Discard、owner validation、adapter hash/version 与 schema digest 绑定、offline target validation 或 migration、并发 revision 拒绝且保留 draft、secret reference、明确的 no-options/unavailable 状态，以及 adapter/core lifecycle independence | Plugin 字段绕过 owner 写入、暴露 raw YAML、静默丢弃 draft、validation 失败仍改变 runtime state，或移除中心时撤销目标 Plugin core |
| Skill provider | 完整 merged-winner discovery、原子 install、invocation-policy configuration、exact-revision update、content diff、external-edit conflict、registry snapshot/get、disable、trash、restore 与 purge，并且不声称隐藏 candidate | invalid 或 disabled content 仍可调用、update merge/覆盖外部编辑、uninstall 后 managed winner 仍 active，或 UI 虚构 loser chain |
| MCP provider | 两种 transport、明确的 external-runtime precondition、descriptor install、无认证的支持配置、authority re-confirmation、fixed descriptor update、tool-generation observation、uninstall 与 quiescent disposal；不可用的 live instance detail 保持明确 | secret 穿越读取边界、修改 external runtime、旧 tool generation 残留、child process 在 teardown 后存活，或中心声称未公开的 reconnect phase |
| Profile provider | fail-closed rc.2 capability probe、必需的已发布 transaction owner、固定 artifact/integrity、script 拒绝、隔离 generation、owner-settings handoff、configuration migration、external-restart state、fixed update、uninstall 与 restore，并明确 Disable/Enable unavailable | 扩展中心编辑不受支持的 Profile format、监督自身重启、pnpm 成功或文件存在在真实 boot 与 consumer observation 前就变成 `active`，或 uninstall 删除未声明的 owner data |
| Operation journal | 对每个 mutation kind 的逐目标串行与 idempotent retry、commit ordering、重启恢复、before/after hash、retention decision 与有界 receipt | 并发写交错、中断状态被猜测、旧/新混合状态成为权威，或失败 operation 发布成功 |
| Task continuation | dynamic contribution re-read、durable Plugin claim、原 Session/user-message 绑定、need digest、cancellation/supersession fence、外部重启重检、single consumption、新 turn resume、真实 capability use 与独立 task observable | 任务在 visibility 前续行、续行两次、重放 acquisition、取消/取代后仍恢复、把原始任务复制进 journal，或把安装当成任务完成 |
| Host/Client protocol | 带版本且仅限 loopback 的 Connection channel、严格 wire validation、business error code、push ordering、lifecycle action availability、staged draft、keyboard 与 focus 行为、详细进度、重启文案与 receipt recovery | 产品 RPC 要求修改 DSH `api-remotes`、browser 直接写文件、不支持的动作消失，或刷新后丢失 draft/operation |
| Independent bundle lifecycle | 打包安装、`vN-1 → vN`、准确降级、移除、状态迁移、版本错配拒绝、默认数据保留，以及在强制移除 package 后仍工作的 hash-pinned recovery copy | UI 自我变更、stale Client 对新 Host 提交、移除后代码仍 active、卸载删除已管理/用户状态，或 recovery 导入已移除 package |
| Lifecycle | effect-owned registration、HMR disposal、child/process quiescence、late-callback containment 与无重复行 | reload 泄漏 tool、listener、row、timer、process 或 pending operation |

Package test 覆盖 parser、state machine、conflict、fault branch 与 disposal。组装 Web 场景使用真实 HTTP/SSE/RPC 与 Profile composition，为 inventory、plan、restart-required、failure、rollback 与 receipt 状态捕获 ARIA golden；browser error 与 warning 会触发失败，并且测试会在 React 之外重新读取真实世界。

### Fault injection

| Fault | Required outcome |
|---|---|
| Catalog 冷启动失败、stale cache、incomplete snapshot 或 revision 变化 | 返回 `discovery-unavailable`；不能转成 no-match、可写 candidate 或 acquisition plan |
| forged、threshold 不足、unknown-key 或 revoked-key signature、digest tamper、revision rollback、previous link 断裂或 expired/frozen snapshot | 建立索引前拒绝 snapshot；不产生 candidate、intent、plan、artifact request 或 last-good downgrade，并保留准确 trust-root 原因 |
| Catalog、publisher、user URL 或 community field 含 prompt injection 或 shell text | 模型可见输出保持 closed normalized field；文案仅作为转义后的人类审查数据，绝不进入模型指令或执行；无法隔离所需证据时 candidate 保持不合格 |
| 确认前 reject、cancel、expire、wrong-session/wrong-resolution 或 token replay | 只记录一条 terminal decision，且每个 acquisition side-effect ledger 保持为零；不能有 late approval、write、process、connection 或 task continuation |
| 确认后、commit 前取消 | 可以存在 fetch 与 staging evidence，但临时物料、process、connection、retry 与 row 都被清除或静止；权威 extension state 与操作前逐字节相同 |
| operation commit 后或 restarting 期间原任务取消或被取代 | 诚实 commit 的 extension 与 operation receipt 保留；continuation claim 以 `canceled` 或 `resume-conflict` 结束，原任务绝不续行 |
| pnpm 缺失、fetch 失败、integrity mismatch 或非零 exit | active Profile 文件不变；operation 失败，且不会出现 `restart-required` 或 `active` |
| 已接受依赖图中的任意 lifecycle script | P0 拒绝 artifact，绝不扩大 `allowBuilds` |
| 无效 Bundle patch 或 Plugin apply 失败 | staging 或 boot 失败，恢复 previous generation，并用此前 consumer 成功启动该 generation |
| stale Plugin settings revision、changed adapter hash/version、owner validation 失败或 v2 configuration migration 失败 | 用户 draft 保持可见，旧版本与 settings 仍是权威，并且不发布 restart 或新版本主张 |
| 在 prepare、stage、verify、promote 与 rollback 每个边界 kill | 下一次启动确定完成恢复，或以 break-glass command 报告 `recovery-required` |
| MCP executable 不存在、HTTP 401、initialize timeout 或无效 tool list | 不出现虚假 tool，且状态标明失败阶段；存在 last-good 配置时它保持可用，首次安装时则保持 absent 且没有 row 或 tool |
| planning 后 MCP descriptor、executable digest、固定参数、cwd、所选 root、HTTPS origin/endpoint、外发说明、零认证或禁止重定向策略发生变化 | 在 artifact、配置行、连接、网络或 tool 变化前拒绝确认；必须生成新的 authority plan |
| MCP crash loop | 官方 Host log 证明有界 attempt 与 exhaustion，tool 被撤销；扩展中心只报告 `degraded` 或 `unknown` 并说明 live connection detail unavailable，不能虚构 attempt state |
| MCP reconnect 中 Disable | pending retry 被取消，后续 Host log 的新 attempt 为零，tool 被撤销，并且 disposal 等待 child exit |
| Skill YAML 畸形、重名、越界 symlink、watcher 失败或并发编辑 | invalid entry 不成为权威；conflict 或 incomplete 可见，外部字节保留 |
| Skill local revision 在 update 或移入回收站前发生变化 | 扩展中心拒绝替换或移除，不执行 merge，并保留每一个外部字节 |
| uninstall 期间 kill，或 MCP call in-flight 时卸载 | recovery 完成 withdrawal 或恢复此前可用状态；consumer、reconnect 或 child 仍存在时，任何行都不能报告 absent |
| purge 指向 owner、remote、external、system 或 parent-Plugin data | plan unavailable 或被拒绝；只有明确 center-owned 的本地 record 可以删除 |
| 同一 Profile 或 Skill root 上两个 write | manager 串行化，或返回稳定 conflict；每个 operation 保留独立 receipt |
| 在每个 MCP credential field 中注入 secret sentinel | 该值不出现在 browser payload、config、argv、log、Session event、snapshot、error、receipt 或临时文件中 |
| Task、Store query 与 secret sentinel 穿越 catalog/acquisition request | task 与 Store-query marker 不出现在任何 catalog/artifact request；secret 不出现在 model input/output、Session、HTTP、plan、UI、argv、log、journal、receipt 或临时文件中 |

进程观测独立报告 `timedOut`、`signal` 与 `exitCode`。rollback 断言会重新运行发布 executable 与真实 consumer；仅比较文件不算通过。

### Artifact, browser, and task gates

- 从干净 checkout 运行独立项目自己的 typecheck、unit、coverage、build、package inspection 与 browser lane。打包准确 Release Candidate，并且只测试其中 built entry；源码 import 不满足安装验收。
- 检查打包后的 manifest：`dsh.bundle`、Web Client export、准确 peer dependency range、受支持 DSH engine range、包含文件、不存在安装 lifecycle script，并且不依赖未发布 DSH workspace package。
- 把最终 `lib/client.js` 检查为 lazy-CJS registration factory，并通过真实 Client module system 从 tarball 加载。证明所有产品 RPC descriptor 与 codec 都随 artifact 发布、Connection channel 不需要 DSH `api-remotes` 产品条目就能自注册，并且 Client disposal 会移除插件自有 style。
- 在隔离环境中针对每个声明支持的 DSH Release 安装、启动、更新和移除 artifact。`dsh-v0.1.1-rc.2` 是必跑负 lane，分别证明 Profile transaction、dynamic MCP connection 与 durable continuation owner 不可用；完整必跑 lane 使用发布全部三项已接受通用 owner 的准确未来 `<p0-host-release>`。moving DSH branch 可以作为提示性信号，但不能替代任一 Release lane。
- 在禁用外部网络的条件下运行三条商店验收 lane：主 Store-only lane 禁用模型工具，覆盖一级入口、signed offline bootstrap、浏览/搜索/筛选、三项比较、完整披露、候选级拒绝、snapshot 级 fail-closed、不透明选择、确认前零副作用、owner 验证、持久化与键盘/focus；paired pre-commit lane 只为比较 intent core 启用真实 resolver 与 request tool；post-install lane 只为证明 existing-first `use-existing` 且不创建新 acquisition record 而启用 resolver。
- 使用普通语言 prompt、existing-first short circuit、fixed-origin privacy ledger、恶意/decoy candidate、不透明 acquisition request、确认前零 side effect、准确 loopback decision、当前 Agent visibility 证明、same-turn Skill/MCP continuation 与 cross-restart Plugin continuation 运行任务驱动 Red；同时检查 extension receipt 与独立 task phase/outcome。
- 执行扩展中心 `vN-1 → vN → 准确降级 → 移除 → 重装`，覆盖 durable-state migration、Host/Client version skew、默认 journal 保留、显式 purge 行为，以及每次接受升级或降级后的一项真实管理操作。
- 执行 Skill discover → v1 install → invocation-policy configure → v2 update → external-edit conflict → disable/restore → trash/restore → purge；每一步都检查 snapshot completeness、merged winner、`get()`、两个调用入口与 center-owned content hash，但不期待隐藏 candidate。
- 执行 stdio 与 HTTP MCP discover → register → full configure → enable → fixed descriptor update → disable/restore → uninstall；覆盖一个已经存在的固定 stdio executable、v1/v2 descriptor、authority-diff reapproval、failed-v3 rollback、tool-generation replacement、零凭据证据、quiescent disposal 与 external-runtime 字节不变证据。
- 执行 Plugin discover → v1 install → owner configuration → 带 settings validation 或 migration 的 v2 update → manual restore → staging-v3 与 post-promotion 两类 recovery → uninstall；证明 Disable/Enable unavailable，并在每个 generation 检查 manifest、lockfile、Bundle 顺序、`--dump-config`、owner settings revision、boot 与真实 consumer。
- 对 install、configure、update、enable、disable、uninstall、restore 与 purge 每一类写动作执行 remote、expired、hash-changed、revision-stale、replayed、wrong-action、wrong-target、wrong-Profile、wrong-owner 与 wrong-scope plan 矩阵。每次拒绝都证明除了 rejected receipt 外没有 download、extraction、credential resolution、execution、write 或 restart。
- 使用 [DSH 测试策略](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/testing.zh.md)选择宿主证据；每项模型或人类可见的 catalog/tool 变更都在外部项目提供 keyless transcript 或真实 runnable example。只有存在独立 Host API 变更时，才在对应 DSH change 中运行 DSH 仓库门禁。
- 证明 teardown 后不存在 MCP child、监听 port、临时 credential、stale generation lock 或 late notification。
- 运行不点名 extension 或 tool 的真实 DeepSeek provider task：一条动态获取并使用 Skill，一条动态获取并使用 unauthenticated MCP Tool，另一条跨越 Plugin restart continuation gate 后使用 v2 Plugin contribution。每条任务都写入确定性 workspace receipt；从外部重新读取并计算 file hash，同时检查 resolution、approval、visibility、continuation 与 use sequence。
- 没有 provider key 时，真实任务可以按仓库策略 self-skip，但发布回执保持 **Provider E2E Pending**，不能声称 P0 已完整验收。
- 把验收通过的 commit 发布为独立、不可变的 package version 与 GitHub Release，并提供安装、更新、移除、兼容性、恢复、隐私和非官方项目文档。只有 repository、本地 tarball 或源码构建绿灯都不能替代 Release 验收。

最终发布回执分别记录独立插件 commit/package version 与准确 DSH Release/commit，并包含 catalog root 与 signed snapshot revision、ingestion evidence、fixture/artifact hash、准确 command 与 platform、原始 Acceptance Red 失败、reviewed snapshot diff、每项 fault result、商店 offline/search/compare/convergence 结果、existing-first/privacy/retrieval 结果、acquisition/continuation receipt、每一类型的 discover/install/configure/update/uninstall receipt、v1/v2/v3 recovery receipt、data/credential retention decision、自移除/重装结果、secret scan、真实任务 Session 与输出 hash，以及每一项仍未验证主张。

## Acceptance criteria

- 产品从独立仓库发布为一个可安装 Host+Client Bundle；未经修改的受支持 DSH Release 能通过公开机制安装、启动、更新和移除它。
- DSH monorepo 不加入任何扩展中心产品实现、目录、测试 fixture 或 Release artifact。任何必要 DSH API 变更都是单独的通用 Host proposal，并且必须先发布，插件才能声明兼容。
- `dsh-v0.1.1-rc.2` 只通过负兼容 lane：Profile transaction、dynamic MCP connection 与 durable continuation owner 分别不可用；不产生 acquisition request tool、write intent、plan、mutation、connection 或 resume。可写 P0 只有在某个准确已发布 DSH Host 提供并通过全部三项通用 capability gate 后才能发布或声明兼容。
- 每一项 center-owned Plugin Profile mutation 都经过已发布 Profile owner；每一项 MCP desired-connection mutation 都经过已发布 dynamic MCP owner。Profile restart 保持明确 external-launcher boundary。P0 不编辑不受支持的 Profile internal，也不提供通用 Plugin Disable/Enable 或 restart supervisor。
- **扩展**是一级入口，其默认商店无需 task、model、API key 或实时网络即可工作。它浏览、搜索、筛选和比较本机验证的 signed catalog，展示全部必需证据与 unknown，并与任务获取共享 Host-derived intent schema 与 transaction engine。只有 candidate、scope、operation 与 desired state 都相同时，规范化 mutation 与 authority field 才必须相同。
- 目录准入要求 bundle-pinned trust root、threshold signature、canonical digest、单调 linked revision 与未过期 snapshot。Unknown/revoked key、tamper、rollback、freeze、incomplete evidence 与 external-only lead 都不能创建 intent 或 plan。
- 从普通语言任务开始，Agent 先检查当前 scoped capability，只从 fresh admitted catalog 检索，最多自主选择一个实质占优候选，并且只用不透明标识发起获取。它绝不编造 coordinate 或执行 catalog/community guidance。
- 人类确认准确 loopback plan 之前，每个 acquisition side-effect ledger 都为空。确认前 reject、cancel、expire、stale evidence、prompt injection、replay 与 superseding task 都不能安装或恢复任何内容。确认后但 commit 前取消必须清理并静止 staging，且权威 state 不变；成功 commit 后取消则保留 extension 与 receipt，但禁止 task resume。
- 确认后，动态可见的 Skill 或 MCP capability 先完成 owner 验证，再为原 objective 派发新的 Agent step。Plugin 路径还要先跨越外部重启与准确 consumer gate。continuation owner 保证绑定 message 的 at-most-once dispatch；任务完成由独立证据证明，绝不描述为 exactly once。
- 在一级扩展界面中，每个 Skill、MCP 与 Plugin fixture 都能完成发现 → 安装 → 配置 → 验证 → 准确更新 → 必要时恢复 → 卸载，而用户无需编写 YAML 或调用 pnpm；Skill 与 MCP 另外证明启用/停用，Plugin 则把通用 Enable/Disable 显示为 unavailable 并说明原因。
- Configure 要么进入 live owner-backed form，要么展示可行动的 unavailable 原因；只有 owner 明确声明时才能展示 **No configurable options**。每次保存都使用 revision fencing，并在拒绝时保留此前 runtime state。
- 每次更新都在 dependency、authority、content 与 configuration-migration diff 后，显式移动到一个准确的白名单版本或 revision。P0 不执行自动或后台更新。
- 每次卸载都证明 owner runtime contribution 已撤销，只移除 center-owned 内容，记录保留的 settings、data、remote state 与 credential，并如实展示 recovery 或不可逆 purge。
- 每项变更都必须确认一个准确的 immutable plan；没有确认就没有 write、execution、credential resolution 或 restart。
- 每项 effective-state 主张都来自官方 Skill registry、MCP client/tool registry、Loader、built Profile boot 或具名外部任务结果，而不是 manager 自报。
- 每项失败或未 commit mutation 都恢复先前 DSH 管理状态并证明其可用；否则可写发布保持阻塞，唯一可交付模式是 read-only inventory。成功 commit 后的 cancel 或 supersession 则保留诚实 extension state 与 receipt，同时禁止任务续行。
- 每项 secret-sentinel scan 为空；在 formal credential-reference resolution 完成前，认证 MCP 保持禁用。
- P0 MCP golden path 全部 unauthenticated，只暴露配置、官方 tool-generation evidence 与明确的 unknown live detail；它们不声称 server runtime update 或未公开的 reconnect state。
- 每项 unknown-source、externally managed、system、parent-owned 或 stale-revision mutation 都会被拒绝，并且不改变目标字节。
- 至少五名未阅读 DSH 文档的普通用户中有四名能从 outcome-only task 开始，正确理解准确获取卡、批准或拒绝，并在不说出 extension、不编辑 YAML、不运行 pnpm、重启后不重发任务的情况下得到任务结果。在独立商店研究中，五名用户至少四名能在无任务时进入扩展、浏览或搜索、比较候选、解释实质权限差异，并获取预期合格条目。另一个生命周期研究保持相同通过率：参与者在十五分钟内完成一个指定扩展的发现 → 安装 → 配置 → 验证 → 更新 → 卸载旅程，并整体覆盖三种类型。
- 完整流程支持键盘操作、不只依赖颜色表达、失败后焦点回到对应动作，并且有用错误细节能跨刷新保留。
- 独立项目的 focused test、coverage、built artifact smoke、browser lane、compatibility matrix、package inspection、Release smoke 与适用 real-provider lane 全部通过，且输出经过审查。若存在独立 DSH Host change，该 change 另行通过 DSH 仓库要求的门禁。

## Risks

- 当前没有已发布 DSH Host 同时满足 Profile transaction、dynamic MCP connection 与 durable task-continuation gate，因此完整可写 P0 依赖三项独立通用 Host capability。在某个准确 Release 通过全部三条 lane 前，只有只读 resolver/商店/management preview 与 `dsh-v0.1.1-rc.2` 负基线可以交付。
- 已发布 DSH 扩展点可能在 release candidate 之间变化。准确 peer range、逐 Release compatibility matrix、fail-loud startup check 与独立 Release 用来收敛影响；不支持的 DSH 版本保持不支持，而不是加入 source-path shim。
- admitted immutable catalog snapshot 即使从多个 registry 与社区摄取，仍会降低生态覆盖。P0 接受这一代价，以保持来源解析、权限、生命周期支持与 integrity 的确定性；任意 Web 线索在后续目录 revision 准入前保持 external。
- Bundled trust root 与 offline bootstrap 可能在用户更新扩展中心前过期，或需要紧急 key revoke。P0 会 fail closed 为 `discovery-unavailable`；宁可显示空的不可写商店，也不接受 unknown key、旧 revision 或 frozen snapshot。
- Capability RAG 可能遗漏有用扩展或排错候选。existing-first search、确定性 eligibility filter、小型 evidence-backed shortlist、`choice-required` 与 task-level proof 用来收敛错误；模型置信度永远不能扩大权限。
- Cross-restart continuation 的 owner 过弱时可能重复或复活过时任务。single-use claim、cancellation/supersession fence、准确 consumer 重验证与独立 task receipt 都是发布门禁；缺少任一项就停在 `restart-required`。
- 要求完整且由 owner 支撑的生命周期，会进一步缩小可写目录覆盖。有用户配置却没有 compatible adapter 或明确 no-options declaration 的 Plugin、executable precondition 未解析的 MCP descriptor，或没有固定更新来源的扩展仍保持可见，但不能宣传为 one-click managed。
- P0 不获取或更新 stdio MCP runtime。这让控制面保持有界，但意味着许多社区 server 仍是 external prerequisite；UI 必须区分 managed connection revision 与 external executable version。
- Package-manager 与 Profile generation 操作可能较慢并占用大量磁盘。progress 与 cancellation 需要明确状态，generation cleanup 不能删除 last-good recovery point。
- Plugin 激活后仍可能以同一用户权限执行任意动作。Staging 与 boot check 检测兼容性失败，而不是恶意行为；UI 不能暗示不存在的 sandbox。
- MCP credential 需要新的 formal reference adapter。在该路径存在之前交付认证配置会违反仓库 credential doctrine，因此属于 no-go。
- Skill 可能以结构检查无法预测的方式影响模型。正文审查、调用开关与任务证据只能降低不确定性，不能变成 instruction-security 主张。
- 并发 CLI 或手工文件变更可能使 plan 或 rollback point 失效。Revision fencing 会 fail closed；P0 选择拒绝，而不是合并外部编辑。
- 控制面 Plugin 可能破坏自己管理的 Web surface。Break-glass CLI 与 last-good generation 是发布要求，不能推迟为后续运维文档。
- Task verification 不可能通用。没有确定性 external oracle 时，产品保留 runtime evidence，并让 task status 保持 unverified。
- 卸载无法安全删除未声明的 Plugin data，也无法 revoke 远程 MCP authorization。显式 center ownership 之外默认保留，回执必须展示这些残留，而不能承诺 clean slate。
