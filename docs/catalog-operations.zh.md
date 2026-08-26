# 目录发现、准入与签名

[English](catalog-operations.md) | 中文

扩展中心把公共发现与可写商店准入分开。运行期商店检索与任务 Capability RAG 只读取同一份在本机验证的签名 snapshot。它们不会浏览社区网站、把任务文本发给 registry、执行上游 install 字段，也不会允许模型提供 package coordinate。

## 线索发现

`pnpm catalog:discover -- --out <new-leads.json>` 会对三个固定公共输入执行有界、无凭据的采集：

- 非官方 [DSH 社区目录](https://awesome-dsh-plugin.com/plugins.json)，用于 Plugin 线索；
- 分页的 [MCP 官方 Registry API](https://registry.modelcontextprotocol.io/v0.1/servers)，用于带准确版本的 MCP 线索；
- 一项固定的 GitHub `agent-skill` topic repository search，用于 Skill repository 线索。

请求只用 HTTPS、拒绝重定向、只接受 JSON，并限制 response byte 与 MCP page 数量；结果写入新的 exclusive owner-only report。有界 MCP batch 会保留 `mcpNextCursor`；下一次调用通过 `--mcp-cursor` 继续，也可以通过 `--mcp-updated-since` 使用官方 Registry 的增量过滤。这个 continuation 是安全的，因为 lead report 只是 curation input，不是目录完整性主张。社区 description、README summary、默认分支和自由文本 install string 都会被丢弃。报告只保留闭集线索字段、来源文档 digest、上游 registry 能提供的固定版本 hint，以及非权威活动 signal。无效行只生成带 digest 的 rejection record。线索不能进入商店或任务 resolver。

当前 `awesome-dsh-plugin.com/plugins.json` 是有价值的社区线索源，但它使用自己的未签名目录 schema，不是 `catalogTrustedOrigin` 接受的签名 `{ envelope, signatures }` 文档，绝不能直接配置为受信运行期 origin。

## 准入证据

发布过程读取 curator 编写的 admission document 与准确本地 artifact file。每个 entry 必须绑定至少一条 extension kind 与 upstream repository 都一致的已知线索，使用不可变 source/artifact coordinate，并让五项可写 P0 动作——安装、配置、更新、卸载与恢复——全部可用。

每项 admission 还要嵌入四份绑定准确 candidate 的 receipt：

- 在 DSH `0.1.1-rc.2` 和准确 source revision 上通过五项动作的 lifecycle fixture；
- 至少包含一个明确 platform result 的 compatibility receipt；
- 带 canonical authority digest 的人工 authority review；
- 报告整个 dependency graph 没有 install lifecycle script 的扫描 receipt。

publisher 会重新 hash 本地 artifact，并拒绝 size 或 integrity 不匹配。它校验这些 receipt，但不会制造其主张或执行未经审查的上游代码；fixture、compatibility、authority review 与 dependency scan 系统仍是彼此独立的证据生产方。

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
