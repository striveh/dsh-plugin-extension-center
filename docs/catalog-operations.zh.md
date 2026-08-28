# 目录发现、准入与签名

[English](catalog-operations.md) | 中文

扩展中心把公共发现与可写商店准入分开。运行期商店检索与任务 Capability RAG 只读取同一份在本机验证的签名 snapshot。它们不会浏览社区网站、把任务文本发给 registry、执行上游 install 字段，也不会允许模型提供 package coordinate。

## 线索发现

`pnpm catalog:discover -- --out <new-leads.json>` 会对四个固定公共输入执行有界、无凭据的采集：

- 非官方 [DSH 社区目录](https://awesome-dsh-plugin.com/plugins.json)，用于 Plugin 线索；
- 分页的 [MCP 官方 Registry API](https://registry.modelcontextprotocol.io/v0.1/servers)，用于带准确版本的 MCP 线索；
- 一项固定的 GitHub `agent-skill` topic repository search，用于 Skill repository 线索；
- 另一项具有独立来源标识的固定 GitHub `agent-skills` topic repository search；它覆盖 `microsoft/skills` 等仓库，同时不会把 provenance 与单数 topic response 合并。

请求只用 HTTPS、拒绝重定向、只接受 JSON，并限制 response byte 与 MCP page 数量；结果写入新的 exclusive owner-only report。有界 MCP batch 会保留 `mcpNextCursor`；下一次调用通过 `--mcp-cursor` 继续，也可以通过 `--mcp-updated-since` 使用官方 Registry 的增量过滤。这个 continuation 是安全的，因为 lead report 只是 curation input，不是目录完整性主张。社区 description、README summary、默认分支和自由文本 install string 都会被丢弃。报告只保留闭集线索字段、来源文档 digest、上游 registry 能提供的固定版本 hint，以及非权威活动 signal。无效行只生成带 digest 的 rejection record。线索不能进入商店或任务 resolver。

定时发现 workflow 还会重新获取当前签名目录里的每个 artifact，把 Plugin Release tag 解析到已准入 Git commit，检查准确 MCP Registry version 仍为 active，并重新校验固定 commit 的 Skill 内容。它输出独立、由 digest 绑定的 source-freshness receipt；该过程不会准入 lead、不会替代人工 authority review，也不认证第三方代码安全。

当前 `awesome-dsh-plugin.com/plugins.json` 是有价值的社区线索源，但它使用自己的未签名目录 schema，不是 `catalogTrustedUrl` 接受的签名 `{ envelope, signatures }` 文档，绝不能直接配置为受信运行期 URL。

## 准入证据

发布过程读取 curator 编写的 admission document 与准确本地 artifact file。每个 entry 必须绑定至少一条 extension kind 与 upstream repository 都一致的已知线索，使用不可变 source/artifact coordinate，并让五项可写 P0 动作——安装、配置、更新、卸载与恢复——全部可用。

每项 admission 还要嵌入四份绑定准确 candidate 的 receipt：

- 对 stable 通用 publisher，准确 candidate source revision 必须在未经修改的官方 DSH `0.1.1-rc.2` artifact 上通过五项动作 lifecycle fixture；下文受保护的 alpha 专用流程改为要求其准确官方 alpha receipt；
- 至少包含一个明确 platform result 的 compatibility receipt；
- 带 canonical authority digest 的人工 authority review；
- 报告整个 dependency graph 没有 install lifecycle script 的扫描 receipt。

publisher 会重新 hash 本地 artifact，并拒绝 size 或 integrity 不匹配。它校验这些 receipt，但不会制造其主张或执行未经审查的上游代码；fixture、compatibility、authority review 与 dependency scan 系统仍是彼此独立的证据生产方。

Package build 还必须知道如何为候选构造准确的授权前审查证据。因此，Plugin 与 Skill admission 只允许 package-pinned identity，且必须绑定 kind、candidate reference、extension name、artifact id、revision、integrity 与 size。MCP admission 使用类型化 runtime-bound review recipe，并在准确 allowlisted descriptor preflight 通过前保持 runtime ineligible。Publisher 会拒绝缺少上述 recipe 的 admission，runtime catalog verifier 与 Store/task 共享 policy 会在候选成为 writable 前再次检查。添加新 Plugin 或 Skill 必须在新 Extension Center build 中交付其 review record；仅有 signed catalog entry 不能让它可执行。

## 官方 alpha Wiki Skill 准入

Alpha 路径是受保护的固定候选专用流程，不是开放式 curator 表单。它只能把准确已提交且已签名的公开 revision 11 相邻推进到 revision 12，把 rc.2 entry set 替换为 package 已审查的 `microsoft/skills` `wiki-page-writer` 两个 commit：`6142f8e60ac58372845c0fcdd2dbf043cd1bb698` 与 `67ae723a23ba880e3e5c8a3e5e2320092024476e`，并把它们的 compatibility 和所需 Host dependency 设为准确官方 DSH `0.1.2-alpha.1`、commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`。成功的 stable post-publication run `33130950000` 已证明公开 r11 部署与刷新，alpha package 现已内置该准确 r11 前序；准确前序 preflight 已通过。这只关闭 r11 前置条件。r12 lifecycle、admission、review、Pages 部署、runtime refresh 与 registry 普通用户证据仍是 `Pending`/RED。搜索结果、用户 URL、模型输出或测试 fixture 都不能改变这些坐标，也不能替代这些 receipt。

两个 Wiki entry 都保留 `configuration.required: false`；v1 无需先配置即可 eligible 且 ready。Lifecycle producer 仍会执行可选 Configure 动作，以证明受支持的写路径及 Update/Restore 的配置保留行为，但不会把该 Skill 重新描述成必须配置。

`Prepare official-alpha catalog admission` workflow 只能在受保护 `main` 的 `catalog-release` environment 中运行。签名步骤要生成待审查 artifact 前，workflow 会从成功的 `Produce official-alpha Wiki Skill lifecycle receipt` workflow run 下载一份准确 receipt，并验证 receipt file digest、workflow path、repository、与 admission checkout 相同的受保护 main commit、run id 与 attempt、成功 conclusion、未经修改的官方 DSH tag 与 commit、准确 r12 document 与 entries digest、当前目录有效期，以及安装 v1、配置、更新到 v2、卸载、恢复 v2 和最终卸载这六次 committed write。Producer 会使用同一 catalog builder 生成仅用于开发验收的隔离签名 r12 输入，启动准确官方 alpha 源码，用一次性登录 URL 建立 HttpOnly 浏览器管理 session，并从该认证页面发出每次管理 RPC；它只上传不含 secret 的 schema-2 lifecycle receipt。Receipt 从当前、由 TLS 保护的 GitHub HTTP `Date` 派生 `catalogObservedAt` 与 `catalogIssuedAt`；admission 复用已记录时间，不接受 dispatcher 传入的时间。每次已提交 write 都绑定 `operationId`、`journalHeadDigest`、`journalEventCount`、`inventoryRevision`、`managedRevision`、`configurationRevision`、`materialIntegrity`、`ownerRevisionDigest`、`ownerEvidenceDigest`，以及 plan、receipt、before/after、mutation 与 verification digest。临时签名输入不是生产 catalog artifact，绝不会复制进 package、`catalog/public`、Pages 或 admission artifact。

最终 receipt 字段是 `activeCandidateAbsent`，并不声称 inventory row 或恢复材料已经消失。最终 Uninstall 必须让候选变为 inactive 且不可见，同时保留 tombstone 和 Restore 使用的准确 rollback material。该 producer 不执行也不声称 Purge；这项破坏性证明由独立的普通用户生命周期负责。

两个 workflow 都会独立重新获取固定 GitHub search `repo:microsoft/skills topic:agent-skills`、两个准确 commit 与完整 tree record，以及两个准确 raw `SKILL.md`。Verifier 会绑定预期 tree/blob id、5,807/5,869 字节大小、SHA-256 `7929f8adf896dbbf1fd744493f643c55a6812f0418d6cd89b3284f8f924d0c8f` 与 `f1270ea4123116e846bf2dc7a53a9e396ed43d694cdb7be22b9a35da9a40feb6`、Git blob id、regular-file mode、规范化祖先路径和 package 内 authority-review body。出现 symlink、submodule、截断 tree、path escape、package manifest、可执行脚本、script directory、byte 变化、metadata 缺失、生命周期操作失败或不同前序时，流程都会在写出 admission artifact 前失败。受管 Skill artifact 是一份准确 raw `SKILL.md`，不是 repository tarball；无关的 repository archive byte 不会被误当成安装物料。

Admission workflow 只上传 canonical 签名 `plugins.json`、状态为 `prepared-for-review` 的 evidence record 与 checksum；它不会 commit、deploy 或改写 Profile。维护者必须通过 pull request 审查并提交准确 byte，再由独立 Pages 部署与 runtime refresh receipt 证明发布。生产 npm 安装 lane 与普通用户 Store 生命周期仍是后续独立门禁。在真实 lifecycle producer run、catalog signing run、pull-request commit、Pages receipt 与 registry 普通用户 receipt 全部存在前，alpha catalog admission、部署与普通用户使用都保持 `Pending`；包括 `tests/support/alpha-catalog.ts` 在内的单元测试 fixture 不能满足其中任何门禁。

## 不可变发布

`pnpm catalog:publish -- ...` 会用外部 JSON trust root 校验上一份签名文档，准入经审查条目，创建带上一 envelope digest 的唯一下一 revision，用传入的 Ed25519 private-key file 对 canonical JSON 签名，并自行验证设定的 threshold。它分别写入新的签名文档和 evidence index；两个输出路径都不能已存在。Private key byte 只从有界 regular file 读取，绝不打印、写入目录或保存在本仓库。

参数示例：

```sh
pnpm catalog:publish -- \
  --leads leads-2026-08-26.json \
  --admissions admissions-2026-08-26.json \
  --artifact-root ./admission-artifacts \
  --previous plugins-r6.json \
  --root catalog-root.json \
  --key release-1=/secure/release-1.pk8.pem \
  --issued-at 2026-08-26T00:00:00.000Z \
  --expires-at 2026-09-25T00:00:00.000Z \
  --out plugins-r7.json \
  --evidence-out plugins-r7.evidence.json
```

package 只包含公开运行期 trust root 与离线 bootstrap。真实远端 revision 仍需要由 operator 控制的 key ceremony、独立生成的 receipt、把准确签名文件部署为 `/plugins.json`，以及部署后的刷新 receipt。本地 pipeline test 不证明这项运维发布门禁。

当前公开 root 只有一个可信 Ed25519 key，且 `threshold: 1`，因此实际策略是 one-of-one。Pipeline 支持更大的 threshold 与多个 key id，但在后续 packaged root 真正配置独立 key 前，该机制不是多方保护。

如果只需生成保持条目不变的后继 revision，`pnpm catalog:rollover -- --previous <committed-plugins.json> ...` 会读取并验证准确的前置文档，保留已准入条目，只签署下一 revision，并单独写入 evidence record。人工 `Prepare signed catalog successor` workflow 会在 `catalog-release` environment 中执行该操作，上传待审查的签名文档、evidence 和 checksum；它不提交也不部署输出。维护者必须审查 artifact，通过 pull request 提交准确签名 byte 与 evidence，再由 Pages workflow 验证并部署受保护 `main` 上的输入。

此后的每个 Center Release 都必须先把前一个成功版本的公开文档提升为当前 package 内置 bootstrap，再签署另一个后继。Post-publication workflow 用准确 Actions run id 绑定前一个成功的 release-ready receipt；如果前一次已部署目录与当前 package 内置 bootstrap 在 revision、entries、envelope 与 signature-set 坐标上不完全相同，更新会被拒绝。历史 rc.0 使用 receipt schema 2；恢复候选 rc.2 与后续版本使用 schema 3，使 rc.1 事故保持传递绑定。当前 deployment 必须是准确的相邻签名后继。rc.1 携带 package 内置 `r9` 并部署了 `r10`，但保留 cache 的 rc.0 更新在 composite receipt 生成前失败。恢复候选 rc.2 保持 `r9→r10`，把 rc.0 作为最后一个成功前序并把 rc.1 绑定为不可变 `not-release-ready` 事故，并生成 stable 使用的成功 receipt。Stable `v0.1.0` 内置 `r10`、部署签名 `r11`，并在 post-publication run `33130950000` 中证明该迁移。当前 alpha 源码把该已证明 r11 文档提升为 package 内置 bootstrap；这次提升不是 r12 lifecycle、admission、部署、刷新或 registry 证据。

## 公开 revision 11

`catalog/public/plugins.json` 中已提交的 Pages 输入曾是 stable package 内置 bootstrap revision 10 的 entry-preserving 准确后继，现在也是当前 alpha package bootstrap。Revision 11 使用 key id `bootstrap-2026-08-26-8`、前一 envelope digest `sha256:3ad9e4423ec7ab339a0a1ecafb1f7471c327092cb1db05eecfada5fb3e5351c0`、entries digest `sha256:da9f5a4f703462cb27de0df26e265c3461dd85a51f0b5a2deecb76ee22d9de86`、canonical document digest `sha256:e44452094f3067bbca5672ab2d6052ea60dfcdd877ee0842f91803ae66bcd8e5`，签发时间为 `2026-08-27T20:25:05.000Z`，过期时间为 `2027-08-27T20:25:05.000Z`。包含结尾换行的 canonical 文件 SHA-256 为 `38a5414c2da581bf0014a2769c9842375b0d0822b77f89e5159b27b3042fc58e`；alpha 前序 preflight 已接受该准确 r11 bootstrap。

人工 Pages workflow 只从 `main` 运行，根据 package 内置 bootstrap 与准确已提交后继推导预期 revision，验证该相邻签名迁移后再复制准确 canonical byte。它没有签名 secret，也不能构造其他 revision。Stable post-publication run `33130950000` 已在受保护 `main` commit `6d95545652e15c57b9e13390095a7172e65034b3` 上成功完成。其 Actions artifact digest 为 `sha256:7dbc3145d376f75ed4ff8763af46290f7daff5a0be9dcf446fd017f02a23c2c0`，release-ready receipt digest 为 `sha256:cdc27dfcb5768b8fe14c082553b5120e98d050748015df0311d1e610edf27994`，public-catalog receipt digest 为 `sha256:4bb66be8eef541eaebde8e0ee56ad09225f6f288948365d08c00c9d3159ad700`。Public-catalog receipt 把 `https://striveh.github.io/dsh-plugin-extension-center/plugins.json` 绑定到上述准确 revision-11 file SHA-256。这只证明 stable 官方 rc.2 版本线的 Release、Pages 部署、同 root 更新与 runtime refresh；alpha r12 与 registry 证据仍为 `Pending`/RED。
