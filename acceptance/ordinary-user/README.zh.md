# 普通用户注册表验收

> 这是保留供审计的历史 npm 时代验收 lane，不属于当前兼容或完成门禁。当前验收使用确定性 packed artifact，并通过 `pnpm run test:compat:latest` 对最新版已审查官方 DSH 运行。

这条 fail-closed lane 验证普通用户通过官方 DSH Plugin CLI 获得的交付路径，以及一个从真实 Extension Center UI 完成的 alpha Skill 生命周期。生产证据不接受源码 checkout、本地 archive、文件系统依赖或下载的 GitHub Release tarball。这条 lane 本身不能证明统一产品 P0：Plugin、MCP 与 Agent 获取/续行仍是独立必需证据，所以即使受保护运行的 Skill `laneStatus` 为 `proven`，产品级 `p0Status` 仍保持 `red`。

生产默认目标是官方 DSH `0.1.2-alpha.3`：先安装不可变 bootstrap 版本 `dsh-plugin-extension-center@0.2.0-alpha.0`，再把公开 `@next` tag 解析成准确且更高的新版本后更新：

```sh
node acceptance/ordinary-user/run.mjs
```

Registry mode 首先要求官方 DSH、准确的 Center 前序版本和严格更高的 Center 目标都已存在于 `https://registry.npmjs.org/`。它会在变更前把 `@next` 等调用方 tag 解析成准确 version 与 integrity，把官方 DSH 安装进隔离 project，创建全新的 DSH home，然后执行这些公开命令：

```sh
dsh plugin --profile web add dsh-plugin-extension-center@0.2.0-alpha.0 --ignore-scripts --save-exact
dsh plugin --profile web list --depth 0
dsh --profile web --dump-config
dsh plugin --profile web add dsh-plugin-extension-center@next --ignore-scripts --save-exact
dsh plugin --profile web list --depth 0
dsh --profile web --dump-config
dsh web --no-open --port 0
dsh plugin --profile web remove dsh-plugin-extension-center
```

第二次 `plugin add` 使用文档提供给用户的同一条 mutable-tag 命令：CLI 把 plugin verb 委托给 pnpm，并在每次成功后协调 Bundle membership。Lane 会在调用前立即把 `@next` 解析成一组 version 与 integrity，执行字面上的 `@next` spec，在调用后立即再次解析；tag 在此期间移动就会失败。只有 installed dependency、lock integrity、Bundle layer 与 package version 都从不可变前序版本变成 preflight 锁定的准确 bytes 时，这条 lane 才能通过。

浏览器检查只在更新后运行。它要求一个 Extension Center Client entry 与 bundle request 已加载，一级 `Extensions` 按钮、`Extension Store` 对话框、Store、Installed、Updates、Activity & Recovery 四个 tab、Configuration filter 和准确 alpha 候选都可见。同一个 Playwright page 随后会选择 user scope，点击 Review install，编辑强类型 Skill 表单，审查并批准每个准确 plan，再从可见生命周期控件执行 Configure、Update、两次 Uninstall、Restore 与 Purge。卸载必须清除 dependency、Bundle list entry、installed package、plugin list entry 与 composed-config layer。独立安装的官方 DSH package tree 必须保持不变。

Receipt schema 3 要求固定、签名且兼容 alpha 的 `wiki-page-writer` 前后版本在同一个真实 Host 中经过认证的管理 surface：catalog 与 inventory 发现；UI 驱动的 Install；Configure 并观察 `userInvocable` 与 configuration revision 改变；使用不同 artifact coordinates 和 bytes 的准确版本 Update；每次写入后的 inventory 验证；Uninstall；已提交 Restore；最终 Uninstall 与 Purge；以及一次最终 inventory 读取。Runner 会打开官方 DSH 输出的准确含 token URL，保留由此生成的 HttpOnly browser session，并要求缺少 session 和错误 session 返回 401、错误 Origin 返回 403。Runner 观察认证 UI 发出的 `intent/preview`、准确 `plan/decide` 与 `lifecycle/request`，不会通过验证 helper 直接发起这些 mutation；该 helper 只准入 catalog、inventory、configuration、operation 与 receipt verification 读取。Purge 必须删除 managed bytes 与 rollback state，并重新暴露 Install。它会保留一条不可恢复的历史记录，其中 `candidateRef: null`、`desired: removed`、`materialized: absent`、`effective: inactive`、`agentVisibility: not-visible`；清理物料不等于擦除生命周期历史。若已验证 catalog 缺少任一准确 artifact，或其兼容性证据未声明 DSH `0.1.2-alpha.3`，lane 会记录 `ORDINARY-USER-MANAGEMENT-CANDIDATE-PENDING`，保持 RED，并以状态 `2` 退出。直接认证 RPC mutation 会立即以 `ORDINARY-USER-MANAGEMENT-DIRECT-MUTATION` 失败；不完整的可访问 UI 序列会以 `ORDINARY-USER-MANAGEMENT-LIFECYCLE-MISSING` 失败。`support.test.mjs` 中的 synthetic complete receipt 只测试 receipt schema，不是 runtime 或 release 证据。

在官方 DSH `0.1.2-alpha.3`、Center `0.2.0-alpha.0` 和 `@next` 下严格更高的 Center target 全部发布前，默认命令以状态 `2` 退出，并写入 `status: "pending"`、`laneStatus: "red"`、`p0Status: "red"` 的 receipt。仅发布 package 仍不充分：已验证 catalog 还必须包含准确的 alpha-compatible Skill 前后版本。Runner 要求准确的 `pnpm@11.21.0`，因为官方 DSH Plugin CLI 会把 package mutation 委托给 `PATH` 上的 pnpm。缺少前序版本、目标仍解析到前序版本或缺少签名 alpha 候选都不能证明该 lane。发布或准入缺失绝不会被本地 rehearsal 变成通过。生命周期或证据无效以状态 `1` 退出；完整本地 registry run 以状态 `0` 和 `laneStatus: "not-proven-local"` 结束，`laneStatus: "proven"` 还必须具备下述受保护 Actions provenance 与 artifact binding。只有再交叉绑定 Plugin、MCP 与 Agent 获取/续行证据，产品 P0 才能离开 RED。

受保护的发布 workflow 还会传入 `--expected-center-target-version` 与 `--expected-center-target-integrity`。Runner 要求两者同时出现；只有安装前和安装后两次解析 `@next` 都与已验证发布 bytes 相同时，才会继续生命周期。

## 开发源码 launcher

Development mode 可以在一个准确官方 DSH source commit 上运行同一条生命周期。初始 Center 必须是准确 registry 版本或不可变 GitHub shorthand，目标必须解析成不同的不可变 artifact。GitHub shorthand 必须以一个小写 40 字符 commit 结尾：

```sh
node acceptance/ordinary-user/run.mjs \
  --mode development \
  --dsh-version 0.1.2-alpha.3 \
  --dsh-source-root /absolute/path/to/deepseek-harness \
  --dsh-commit dd6322d604e00eec1ba5e0c8541159906a21094a \
  --center-initial-spec github:striveh/dsh-plugin-extension-center#0123456789abcdef0123456789abcdef01234567 \
  --center-target-spec github:striveh/dsh-plugin-extension-center#89abcdef0123456789abcdef0123456789abcdef
```

只有同一条真实管理序列在准确官方 DSH source commit 与不可变 Center 输入上完成后，development run 才能记录 `laneStatus: "not-proven-development"`；其 `p0Status` 仍为 `red`。缺少 alpha 候选仍是 Pending/RED。即使开发证据完整，也不能替代发布与 registry 安装。

预安装 launcher 可以使用 `--dsh-command` 和可重复的 `--dsh-arg`。由于 runner 无法把该 executable 绑定到 registry installation，它同样不能生成生产 P0 证明。

## Receipt

默认 receipt 路径是 `.artifacts/acceptance/ordinary-user/receipt.json`；`--receipt` 可以选择另一个位置。Receipt 只包含已验证 package 与签名 catalog coordinates、candidate 与 artifact identity、有序 RPC method names、immutable plan 与 terminal receipt digest、owner-state projection、version、registry integrity、boolean、count、稳定 failure code、可选的不可变 source commit 和 canonical self-digest。缺失的管理字段默认是不通过值。写入前会机械拒绝 local path、任意 environment value、subprocess output、固定公开 registry 以外的 URL、authorization data、cookie 与底层 error diagnostics。

本地 registry run 可以报告 `laneStatus: "not-proven-local"`，只有来自 `ordinary-user.yml` 或 `npm-publish.yml`、准确受保护 main 的 `workflow_dispatch` 才能报告 `laneStatus: "proven"`。该声明记录准确 repository id、workflow file/ref、commit、run id 与 attempt。Workflow 上传主 receipt artifact 后，读取 upload service 返回的 archive SHA-256 与 artifact id，再写入第二份 self-digested Actions evidence document，把这些坐标与 receipt digest 绑定。`actions-evidence.mjs verify-actions` 会独立验证 GitHub run JSON、artifact-list JSON、下载的 ZIP bytes、receipt 和 evidence document；复制或重新计算本地 JSON 不构成证明。Receipt 的 `productCoverage` 会把 Plugin、MCP 与 Agent 获取/续行保留为 `pending`，因此 Actions provenance 不能把整体 `p0Status` 从 `red` 提升。

运行纯 input 与 receipt 检查：

```sh
node --test acceptance/ordinary-user/support.test.mjs
```

`.github/workflows/ordinary-user.yml` 会在每次 push 与 pull request 上运行这些确定性检查。其受保护 main 手动 job 会安装 Chromium，只运行已审计的默认 registry coordinates，并上传已验证 receipt 及其 archive-binding evidence。Skill lane 在 `laneStatus` 成为 `proven` 前不能变绿，`Pending` 也不能被选择成绿色结果；该 job 不会宣称独立的产品 P0 gate 已完成。
