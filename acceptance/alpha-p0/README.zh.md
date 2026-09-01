# Alpha 产品 P0 复合门禁

> 这是保留供审计的历史 npm 时代复合设计，不属于当前兼容或完成门禁。当前目标是让独立 packed 插件在最新版已审查、未经修改的官方 DSH 上运行。

这个 verifier 是最终 fail-closed 产品绑定器。普通用户 receipt 通过，只能证明官方 DSH registry 安装与 Skill UI 全生命周期；它的 `laneStatus: "proven"` 会刻意保持 `p0Status: "red"`。只有下表每一行都通过且所有不可变产品身份一致，产品 P0 才能变为 proven。

该门禁属于仓库验收工具，不是 runtime 功能或 catalog 候选，也不会进入发布插件的 payload。

| Lane | 准确接收的证据 |
| --- | --- |
| 官方 DSH registry 安装 | ordinary-user schema 3，以及独立获取的 Actions run、artifact metadata 与 archive bytes |
| Center package 与 provenance | `DSH-CENTER-NPM-PROVENANCE` schema 1，以及独立获取的 registry metadata、tarball 与 npm provenance |
| 签名 catalog | `P0-ALPHA-SIGNED-CATALOG-ACTIVATION` schema 1，包含真实签名 envelope/signatures、公开读取字节、Plugin/MCP/Skill 后继对与实时 runtime refresh |
| Plugin 全生命周期 | `P0-ALPHA-PLUGIN-UI-LIFECYCLE` schema 1，包含准确七项 UI 授权操作及 provider/recovery digest |
| MCP 全生命周期 | `P0-ALPHA-MCP-UI-LIFECYCLE` schema 1，包含准确七项 UI 授权操作及预置 runtime digest |
| Skill UI 全生命周期 | 同一份经过独立验证的 ordinary-user schema 3 receipt |
| Agent 获取与续行 | `P0-ALPHA-AGENT-CAPABILITY-ACQUISITION-CONTINUATION` schema 1，覆盖能力缺口、准确选择、人工授权、获取、runtime 使用以及对原 Session 的一次续行 |

官方 alpha Wiki Skill lifecycle schema 2 只会被接收并标记为 `development-only`。它明确不能证明公开部署或 registry 安装，因此不能满足 signed-catalog lane。

每条生产 lane 都绑定准确 source commit、workflow run/attempt、receipt digest 与 package 或 Actions artifact digest。Composite 还会交叉检查官方 DSH、Center npm version/integrity/tarball/source commit，以及签名 catalog revision/document/entries 身份。Signed-catalog lane 会使用这个准确 Center build 内置的 trust root 重新运行现有 catalog verifier，并对 canonical 公开文档字节计算 digest；缺少真实文档的重哈希投影仍然无效。Lifecycle producer 必须通过现有 full-P0 terminal receipt 验证路径派生 operation、journal、inventory、owner-state 与 recovery digest。Self-digest 可以发现 producer 产出后的替换，但自身不能认证外部事实。在 composite 接收并独立验证对应 GitHub API run metadata、artifact metadata、下载 archive bytes、registry metadata、tarball 与 npm provenance 之前，每份 schema 合法的生产 receipt 都标记为 `externally-unverified`，不能把 P0 变绿。因此 schema 1 始终输出 RED，并拒绝经过重哈希的全 proven 声明。

运行：

```sh
pnpm run verify:alpha-p0-composite -- \
  --ordinary-user /绝对路径/ordinary-user.json \
  --ordinary-actions /绝对路径/ordinary-actions-evidence.json \
  --npm-provenance /绝对路径/npm-provenance.json \
  --catalog /绝对路径/catalog-activation.json \
  --plugin /绝对路径/plugin-lifecycle.json \
  --mcp /绝对路径/mcp-lifecycle.json \
  --agent /绝对路径/agent-acquisition.json \
  --receipt /绝对路径/composite-receipt.json
```

退出码 `0` 预留给未来能独立认证每条 lane 与 binding 的版本。退出码 `2` 表示已写出 canonical receipt，但其中 `p0Status: "red"`，缺失或外部未验证证据列在 `notProven`。退出码 `1` 表示 verifier 本身无法运行。截至 2026-08-28，Plugin、MCP、Agent、signed-catalog activation receipt 及其外部验证输入都不存在，因此真实结果必须是 RED。
