# 能力发现与扩展商店研究

状态：产品证据基线，2026-08-25

[English](capability-rag-research.md) | 中文

本文记录统一扩展中心设计所依据的外部证据，并区分来源事实、综合判断与产品决策。除固定 commit 的来源外，链接均于 2026-08-25 访问且之后可能变化；产品规格仍是规范性文件。

## 研究问题

DSH 应该怎样同时支持用户主动浏览扩展商店，以及 Agent 在完成已有任务时发现、获取并使用缺失的 Plugin、MCP Server 或 Skill，又不产生两套管理系统，也不把模型变成一个未经审查的包安装器？

## 现有产品与开放生态证据

| 来源 | 已验证行为 | 产品推论 |
|---|---|---|
| [VS Code Agent Tools](https://code.visualstudio.com/docs/agents/concepts/tools) | 模型会在当前 Session 已有工具中自主选择。VS Code 建议缩小工具集合，并把可用性与审批分开。 | DSH 应检索一个任务相关的小能力集合，而不是把整个目录描述塞进模型上下文。 |
| [VS Code Approvals and Permissions](https://code.visualstudio.com/docs/agents/run/approvals) | 工具可以单次或按更大范围审批；外部结果可能因提示注入而需要结果后复核；高自治模式带明确警告。 | 新扩展会引入代码、进程、网络或指令权限。P0 对一个准确计划只进行一次人工授权，并把检索到的文案当作不可信数据。 |
| [Claude Code 插件发现](https://code.claude.com/docs/en/discover-plugins)与[插件提示](https://code.claude.com/docs/en/plugin-hints) | 用户浏览并安装 marketplace 插件。Claude 可以建议匹配的 LSP 插件，CLI 也可以发出安装提示，但产品明确不会自动安装；已安装插件可以在 Session 内 reload。 | 任务触发的建议有价值，但候选选择、安装授权与运行时生效是不同状态。DSH 可以让 Agent 发起准确请求，同时把确认权留在模型之外。 |
| [OpenClaw ClawHub Skill `935c555`](https://github.com/openclaw/openclaw/blob/935c555c98d6b38af76faa6a0b1370353d1828df/skills/clawhub/SKILL.md) | 模型侧指令要求在声称能力不存在前先搜索、验证所选第三方 Skill、取得用户批准、安装准确版本，并依靠 watcher 在下一 agent turn 刷新 Skill。 | 这是最接近目标闭环的公开先例。DSH 应保留 existing-first、verify、人工授权与 next-turn 模式，同时把变更移出模型命令。扩展中心拥有 plan 与 evidence；每个已准入 child Plugin Bundle 的 package membership 变更仍使用官方 Plugin CLI，纯配置则使用官方 Loader。 |
| [OpenHands 对话内 Skill 安装](https://docs.openhands.dev/overview/skills/adding) | 用户可以在 `/add-skill` 中提供 GitHub URL；当前官方页面称 OpenHands 会 fetch、write、verify 并让 Skill 立即可用。 | 对话内获取可行，但用户提供 coordinate 不是普通用户发现。由于 activation 主张会随产品 surface 与 Release 变化，DSH 仍须验证当前任务可见性，而不能相信安装结果。 |
| [Claude Code Plugin Reference](https://code.claude.com/docs/en/plugins-reference)、[Cursor Agent Skills](https://prod.cursor.com/docs/skills)与[OpenHands Skills](https://docs.openhands.dev/overview/skills) | 已安装 Skill 先以摘要暴露，Agent 可以在任务匹配时调用。OpenHands 明确说明 Skill 本身不授予权限，也不安装依赖。 | 必须先匹配已有能力。获取缺失 Skill 是独立生命周期操作，不能由模型相关性自动推出。 |
| [Agent Skills 规范](https://agentskills.io/specification) | Skill 具有有界的发现元数据，并按需加载指令、reference、script 与 asset。 | 检索索引应先使用标准化摘要，只对短名单补齐完整证据。完整 Skill 指令在计划阶段审查，不能成为检索指令。 |
| [Cursor Plugins](https://prod.cursor.com/docs/plugins) | Plugin 在一个管理面统一承载 Skill 和 MCP，同时明显区分官方与社区发现来源。 | 中心可以统一导航和获取入口，但不能假装 Plugin、MCP、Skill 拥有相同运行 owner 或信任等级。 |
| [OpenAI 的 ChatGPT/Codex Plugins](https://help.openai.com/en/articles/20001256-plugins-in-codex/) | Plugin Directory 是主要发现入口，但安装与使用仍受套餐、角色、App 设置、动作控制和源系统权限约束。 | “找到”不等于“可准入”“已安装”“已授权”或“可用”。候选、策略、凭据、运行与任务证据必须分开。 |
| [DSH Capability Resolver `v0.1.0`](https://github.com/striveh/dsh-capability-resolver/tree/b2676e4fb311a0df2eaa17bdce2d6929317c1ea0)与[社区目录](https://awesome-dsh-plugin.com/plugins.json) | 这个非官方 DSH 插件读取一个固定公开目录，将用户任务留在本地 Host，并在本地排序标准化候选。它声明为只读：不安装、启用、禁用、更新或执行候选。 | 将其 need-first 发现与安全模型投影复用为原型证据。独立扩展中心负责准入、商店、plan、grant、evidence、恢复编排与续行，不会变成第二个物理 Plugin package manager。 |
| [官方 MCP Registry 公告](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/)、[发布指南](https://modelcontextprotocol.io/registry/quickstart)与[条款](https://modelcontextprotocol.io/registry/terms-of-service) | Registry 仍是 preview 的元数据目录，不托管 artifact；它被设计为 opinionated public/private subregistry 的上游，并且不保证安全、准确或可用。 | MCP Registry 是目录摄取来源，不是可写事实。扩展中心必须生成 DSH 专用准入快照，补充准确 artifact、兼容性、权限和验证数据。 |

**对所抽样产品的综合判断：**用户自主目录已经是成熟获取路径，Agent 也越来越能选择已经存在的能力。仍不常见的是：任务上下文缺能力流程与商店共享同一目录、政策、生命周期状态和回执，并在获取后证明原任务续行。因此，P0 把扩展商店与 Agent 辅助获取保留为平等入口，而不是用任一入口取代另一个。

## 社区信号

以下 issue 与讨论只是定性信号，不能用来推断问题发生率。

| 信号 | 用户报告 | 设计响应 |
|---|---|---|
| [Codex issue #34321](https://github.com/openai/codex/issues/34321) | Plugin 可以同时显示 installed、enabled，但缓存中的 Skill 已缺失，模型完全不可见；Session 内重装也不会追溯修改已经生成的 prompt。 | 绝不使用单一“已安装”徽标；分别验证物料、owner 注册、当前 Agent 可见性，以及是否需要新 step 或新 Session。 |
| [Claude Code issue #43745](https://github.com/anthropics/claude-code/issues/43745) | 自定义 marketplace 的 Installed 与 Discover 状态可能不一致，更新也可能停留在旧缓存。 | 每次观察绑定来源 revision 与 freshness；更新和 inventory 必须读取相同 owner 事实。 |
| [Claude Code issue #81551](https://github.com/anthropics/claude-code/issues/81551) | reload 摘要可能报告 0 Skills，但实际调用正常，从而诱发不必要的重装排查。 | 状态文案必须指出准确 observation，不能把不完整计数器变成健康结论。 |
| [VS Code issue #311166](https://github.com/microsoft/vscode/issues/311166) | 社区提案报告 Skill 无法正式声明所需 Tool、MCP Server 或 hook，因此依赖缺失可能表现为静默的部分工作。 | 目录准入与运行验证必须包含 capability dependency；仅有 Skill 文件不足以证明可用。 |
| [OpenHands docs-update issue #646](https://github.com/OpenHands/docs/issues/646) | 该 issue 描述 Agent Canvas v1.6 在添加 Skill 后要求用户开启新 conversation，因为该 surface 每个 conversation 只加载一次 Skill；这与当前官方 Adding Skills 页面所称“立即可用”冲突。 | 把 activation timing 视为依赖 surface 与 Release 的社区证据，而不是当前产品事实。DSH 在 owner visibility 与 continuation test 通过前不接受任一主张。 |
| [Claude Code Skills 讨论](https://www.reddit.com/r/ClaudeAI/comments/1vqv6pp/how_are_you_guys_discovering_new_claude_skills/) | 参与者描述自己在 GitHub 与 Reddit 偶然找到 Skill，并希望有人过滤噪声。 | 社区发现可以丰富 lead queue；热度和轶事只能作为排序信号，不能成为准入或安全证据。 |

## 产品决策：双入口来源模型

发现分成两个平面。

### 运行时检索平面

1. **当前 Agent scope：**准确 Session、工作目录与 Agent scope 下的 qualified Tool schema 和官方 merged Skill catalog。任务路径先检查这里；商店把匹配条目标成已安装或可见。
2. **受管运行证据：**扩展中心自有 operation inventory，以及官方 Profile package manager、Skill、MCP Tool、Loader 与声明 consumer 的 observation。
3. **准入目录快照：**依据 Bundle-pinned catalog root 验证 versioned snapshot 与 offline bootstrap，再由 Agent 和商店共同在本机匹配。原始任务文本、商店查询、Session 标识、凭据、cookie 与 workspace 内容绝不进入目录请求。
4. **外部线索：**只有用户明确要求审查时才在 runtime 获取其显式 URL，并保持 `external-only`。任意 Web/community discovery 属于 catalog ingestion，不进入任务或商店检索。

Trust root 声明 catalog、可信 key id 与 threshold、最低 revision 和最大 age。Canonical snapshot 带单调 revision、issued/expiry time、entries/previous-revision digest、key id 与 signature。Unknown/revoked key、threshold 不足、tamper、rollback、链断裂或 freeze 都在建立索引前 fail closed；root rotation 只能通过更新且 integrity-pinned 的 Extension Center Release 进入。

### 目录摄取平面

独立项目定期从官方 MCP Registry、具备 DSH 兼容元数据的准确 npm/GitHub Release、Agent Skills 兼容仓库与 registry、维护者提交、社区 issue/activity signal 中发现公开候选。摄取流程会标准化主张、解析准确版本或内容 revision、记录许可证和发布者、扫描 manifest 与 lifecycle script、推导权限、运行兼容与验证 fixture，最终发布带签名的不可变目录 revision。社区文案只用于策展取证，绝不是可执行安装指南。

因此，该目录是一个 opinionated DSH subregistry。上游条目只表示“候选线索”；目录准入表示“取得本 revision 所声明准确生命周期的一键候选资格”；两者都不表示“安全”。

## 产品决策：Capability RAG 与商店检索

Agent 获得的是一个狭窄的模型工具，而不是原始目录。商店把同一标准化索引呈现为结构化的用户搜索与比较，不让内容经过模型。

1. Agent 从用户已有任务中在本机导出 `CapabilityNeed`：目标结果、输入输出形式、目标 scope、所需数据访问、平台限制和最大可接受权限。operation journal 不复制原始任务。
2. resolver 先搜索当前 Agent 可见的 Tool 与 Skill。
3. 仍有缺口时，resolver 在标准化目录字段的本地结构化/语义索引中搜索。匹配考虑 outcome tag、所提供 Tool/Skill、兼容性、配置就绪度、权限、来源 freshness 和生命周期完整性。
4. 只补齐最高排名的标准化合格字段：closed enum、capability tag、不透明 id、pinned revision、authority flag 和一个有界 catalog-authored factual summary。Publisher README、error、shell string 与社区帖子永远不会成为模型指令，只能作为转义后的 browser review data。
5. 确定性策略过滤先于模型排序。只有准确 revision、integrity、目标 DSH 范围、权限、配置路径、验证 recipe 与完整受管生命周期都已准入的候选，才能进入一键获取。
6. 结果只能是 `use-existing`、`management-required`、`acquisition-candidate`、`choice-required`、`no-eligible-candidate`、`discovery-unavailable` 或 `external-only`。`management-required` 是指向一个准确人工生命周期动作的 terminal handoff，且不创建 acquisition intent；只有 fresh 且 complete 的 observation 才能返回 `no-eligible-candidate`。

这才是检索增强的能力解析：模型基于带来源的检索事实推理，而不是凭权重记忆包名或编造安装命令。

商店使用同一个确定性 eligibility filter，但允许用户浏览全部准入匹配、筛选并比较最多三个候选。用户选择可以解决取舍，但不能绕过 trust、compatibility、lifecycle、integrity 或 authority policy。两个入口使用相同的 Host-side Center intent schema、授权、journal、receipt、验证与恢复编排。只有 candidate、scope、operation 与 desired state 相同时，它们的规范化 mutation 与 authority core 才必须相同；origin、task-only continuation、idempotency 与 plan identity 按请求独立。人工 MCP Install 与任务组合 Install-and-Enable 共享准入与扩展中心自有 MCP state，但不伪装成同一个 intent 或 plan；已准入 child Plugin Bundle 的 package membership 变更使用官方 Plugin CLI，纯配置则使用官方 Loader。

## 产品决策：自治边界

| Agent 动作 | P0 |
|---|---|
| 判断当前任务存在能力缺口 | 自主 |
| 检查当前 Agent 可见能力 | 自主、只读 |
| 查询固定目录快照并排序合格候选 | 自主、只读 |
| 当策略和证据产生唯一实质性赢家时选择候选 | 自主 |
| 用不透明标识请 Host 准备准确获取计划 | Agent 自主发起 |
| 批准新的代码、进程、网络、指令或凭据权限 | 仅人类，对一个准确计划单次授权 |
| 向变更路径提供包名、URL、shell command 或 secret | 禁止 |
| 人工确认后执行安装 | 扩展中心编排的类型化操作，绝不是模型执行；每个已准入 child Plugin Bundle 的 package membership 变更使用官方 Plugin CLI |
| 验证当前 Agent 可见性并继续原任务 | owner evidence 通过后自主 |
| 从任意 Web 或社区搜索结果直接安装 | 禁止；结果保持 `external-only` |
| 记住宽泛安装授权或替未来候选批准 | P0 排除 |

模型侧获取请求只接受 `resolutionId`、`candidateRef` 和 `continuationId`。Host 必须在相同 catalog、inventory、policy、scope、expiry 与 integrity revision 下重新解析这些不透明值，生成不可变计划，并等待已认证 DSH Web 浏览器会话中的独立用户决定。Agent 无法调用该决定 endpoint。

## 产品决策：续行

对于 Skill 或 MCP connection，扩展中心自有 lifecycle engine 可以等待确认、改变自有 desired state、验证官方 registry winner 或 MCP Tool set、重新读取准确 Agent 可见能力，并为同一 objective 派发新的 step。MCP engine 在扩展中心自有 fiber 内挂载和释放已发布 rc.2 MCP Client，不需要新增官方 mutation service。商店来源的获取没有 continuation claim。

受管 Plugin 可能需要真实 Host restart，因为 Node 与 Web module cache 会阻止同进程证明。扩展中心保留带 cancellation/supersession fence 的 durable single-use claim，官方 Plugin CLI 拥有所选 Profile dependency 与 package 安装。下一次 boot 中，扩展中心验证该准确 dependency、Loader contribution 与声明 consumer，再通过官方 Agent 与 Session 服务最多派发一次绑定 continuation message；它不承诺 exactly-once task completion。

安装成功与任务成功始终是两个事实。只有新能力已经真实用于原任务，并且任务级 observable 通过，原任务才算完成。
