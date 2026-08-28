# 目录发现、准入与签名

[English](catalog-operations.md) | 中文

扩展中心把公共发现与可写商店准入分开。运行期商店检索与任务 Capability RAG 只读取同一份在本机验证的签名 snapshot。它们不会浏览社区网站、把任务文本发给 registry、执行上游 install 字段，也不会允许模型提供 package coordinate。

## 线索发现

`pnpm catalog:discover -- --out <new-leads.json>` 会对三个固定公共输入执行有界、无凭据的采集：

- 非官方 [DSH 社区目录](https://awesome-dsh-plugin.com/plugins.json)，用于 Plugin 线索；
- 分页的 [MCP 官方 Registry API](https://registry.modelcontextprotocol.io/v0.1/servers)，用于带准确版本的 MCP 线索；
- 一项固定的 GitHub `agent-skill` topic repository search，用于 Skill repository 线索。

请求只用 HTTPS、拒绝重定向、只接受 JSON，并限制 response byte 与 MCP page 数量；结果写入新的 exclusive owner-only report。有界 MCP batch 会保留 `mcpNextCursor`；下一次调用通过 `--mcp-cursor` 继续，也可以通过 `--mcp-updated-since` 使用官方 Registry 的增量过滤。这个 continuation 是安全的，因为 lead report 只是 curation input，不是目录完整性主张。社区 description、README summary、默认分支和自由文本 install string 都会被丢弃。报告只保留闭集线索字段、来源文档 digest、上游 registry 能提供的固定版本 hint，以及非权威活动 signal。无效行只生成带 digest 的 rejection record。线索不能进入商店或任务 resolver。

定时发现 workflow 还会重新获取当前签名目录里的每个 artifact，把 Plugin Release tag 解析到已准入 Git commit，检查准确 MCP Registry version 仍为 active，并重新校验固定 commit 的 Skill 内容。它输出独立、由 digest 绑定的 source-freshness receipt；该过程不会准入 lead、不会替代人工 authority review，也不认证第三方代码安全。

当前 `awesome-dsh-plugin.com/plugins.json` 是有价值的社区线索源，但它使用自己的未签名目录 schema，不是 `catalogTrustedUrl` 接受的签名 `{ envelope, signatures }` 文档，绝不能直接配置为受信运行期 URL。

## 准入证据

发布过程读取 curator 编写的 admission document 与准确本地 artifact file。每个 entry 必须绑定至少一条 extension kind 与 upstream repository 都一致的已知线索，使用不可变 source/artifact coordinate，并让五项可写 P0 动作——安装、配置、更新、卸载与恢复——全部可用。

每项 admission 还要嵌入四份绑定准确 candidate 的 receipt：

- 准确 candidate source revision 在未经修改的官方 DSH `0.1.1-rc.2` artifact 上通过五项动作的 lifecycle fixture；
- 至少包含一个明确 platform result 的 compatibility receipt；
- 带 canonical authority digest 的人工 authority review；
- 报告整个 dependency graph 没有 install lifecycle script 的扫描 receipt。

publisher 会重新 hash 本地 artifact，并拒绝 size 或 integrity 不匹配。它校验这些 receipt，但不会制造其主张或执行未经审查的上游代码；fixture、compatibility、authority review 与 dependency scan 系统仍是彼此独立的证据生产方。

Package build 还必须知道如何为候选构造准确的授权前审查证据。因此，Plugin 与 Skill admission 只允许 package-pinned identity，且必须绑定 kind、candidate reference、extension name、artifact id、revision、integrity 与 size。MCP admission 使用类型化 runtime-bound review recipe，并在准确 allowlisted descriptor preflight 通过前保持 runtime ineligible。Publisher 会拒绝缺少上述 recipe 的 admission，runtime catalog verifier 与 Store/task 共享 policy 会在候选成为 writable 前再次检查。添加新 Plugin 或 Skill 必须在新 Extension Center build 中交付其 review record；仅有 signed catalog entry 不能让它可执行。

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

此后的每个 Center Release 都必须先把前一个成功版本的公开文档提升为当前 package 内置 bootstrap，再签署另一个后继。Post-publication workflow 用准确 Actions run id 绑定前一个成功的 release-ready receipt；如果前一次已部署目录与当前 package 内置 bootstrap 在 revision、entries、envelope 与 signature-set 坐标上不完全相同，更新会被拒绝。历史 rc.0 使用 receipt schema 2；恢复候选 rc.2 与后续版本使用 schema 3，使 rc.1 事故保持传递绑定。当前 deployment 必须是准确的相邻签名后继。rc.1 携带 package 内置 `r9` 并部署了 `r10`，但保留 cache 的 rc.0 更新在 composite receipt 生成前失败。恢复候选 rc.2 保持 `r9→r10`，把 rc.0 作为最后一个成功前序并把 rc.1 绑定为不可变 `not-release-ready` 事故，并生成 stable 使用的成功 receipt。本次 stable 源码把 `r10` 放入 package 并提交签名 `r11`；源码修改、本地测试、Pages 配置或更早 receipt 都不能替代 stable 自身的 post-publication receipt。

## 公开 revision 11

`catalog/public/plugins.json` 中已提交的 Pages 输入是 package 内置 bootstrap revision 10 的 entry-preserving 准确后继。Revision 11 使用 key id `bootstrap-2026-08-26-8`、前一 envelope digest `sha256:3ad9e4423ec7ab339a0a1ecafb1f7471c327092cb1db05eecfada5fb3e5351c0`、entries digest `sha256:da9f5a4f703462cb27de0df26e265c3461dd85a51f0b5a2deecb76ee22d9de86`、canonical document digest `sha256:e44452094f3067bbca5672ab2d6052ea60dfcdd877ee0842f91803ae66bcd8e5`，签发时间为 `2026-08-27T20:25:05.000Z`，过期时间为 `2027-08-27T20:25:05.000Z`。包含结尾换行的 canonical 文件 SHA-256 为 `38a5414c2da581bf0014a2769c9842375b0d0822b77f89e5159b27b3042fc58e`。

人工 Pages workflow 只从 `main` 运行，根据 package 内置 bootstrap 与准确已提交后继推导预期 revision，验证该相邻签名迁移后再复制准确 canonical byte。它没有签名 secret，也不能构造其他 revision。已提交 revision 是发布输入，不是部署证据。只有 `https://striveh.github.io/dsh-plugin-extension-center/plugins.json` 以 HTTP 200 返回这些 revision-11 byte，且 runtime 记录同一 Center root 中从 rc.2 更新到 stable 并成功完成 revision 10 到 11 刷新后，stable 才算完成。
