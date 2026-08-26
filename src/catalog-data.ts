import type { CatalogEntry, CatalogEnvelope, CatalogRoot, CatalogSignature } from './catalog-contract.ts'

const admittedLifecycle = {
  install: { status: 'available' },
  configure: { status: 'available' },
  update: { status: 'available' },
  uninstall: { status: 'available' },
  restore: { status: 'available' },
} as const

/** Curated entries in bootstrap revision 6. Free-form upstream text is not included. */
export const BOOTSTRAP_CATALOG_ENTRIES: readonly CatalogEntry[] = [{
  candidateRef: 'plugin:dsh-capability-resolver@0.1.0',
  kind: 'plugin',
  name: 'dsh-capability-resolver',
  displayName: { en: 'DSH Capability Resolver', zh: 'DSH 能力解析器' },
  summary: {
    en: 'Checks current DSH capabilities and ranks candidates from one fixed community catalog without installing them.',
    zh: '检查当前 DSH 能力，并从一个固定社区目录在本机排序候选；不会执行安装。',
  },
  publisher: { name: 'striveh', status: 'community' },
  license: {
    spdx: 'MIT',
    status: 'verified',
    sourceUrl: 'https://raw.githubusercontent.com/striveh/dsh-capability-resolver/b2676e4fb311a0df2eaa17bdce2d6929317c1ea0/LICENSE',
  },
  source: {
    type: 'github-release',
    label: 'GitHub Release v0.1.0',
    url: 'https://github.com/striveh/dsh-capability-resolver/releases/tag/v0.1.0',
    upstreamUrl: 'https://github.com/striveh/dsh-capability-resolver',
    revision: 'b2676e4fb311a0df2eaa17bdce2d6929317c1ea0',
    admittedAt: '2026-08-25T07:00:00.000Z',
  },
  artifact: {
    id: 'dsh-capability-resolver',
    version: '0.1.0',
    integrity: 'sha256:895e1e44ee9edaff0c4982c671379bbc3122e2c0189250e9870ee70102f2c27e',
    sizeBytes: 92128,
    acquisitionUrl: 'https://github.com/striveh/dsh-capability-resolver/releases/download/v0.1.0/dsh-capability-resolver-0.1.0.tgz',
  },
  compatibility: {
    status: 'compatible',
    dsh: '0.1.1-rc.2',
    platforms: ['darwin', 'linux', 'windows'],
    detail: {
      en: 'The release declares and tests the exact DSH 0.1.1-rc.2 Host and Web Client contracts.',
      zh: '该 Release 声明并测试了准确的 DSH 0.1.1-rc.2 Host 与 Web Client 接口。',
    },
  },
  components: [
    { en: 'Host discovery provider', zh: 'Host 发现 provider' },
    { en: 'Web settings view', zh: 'Web 设置视图' },
    { en: 'Model-facing read-only resolver tool', zh: '模型可见只读解析工具' },
  ],
  permissions: [{
    phase: 'acquisition', kind: 'network', access: 'send',
    detail: {
      en: 'The Center downloads the integrity-pinned asset, then real Loader validation runs its in-process code with the Host user\'s network authority.',
      zh: '中心下载 integrity-pinned 物料，随后真实 Loader 验证会以 Host 用户网络权限运行其进程内代码。',
    },
  }, {
    phase: 'acquisition', kind: 'filesystem', access: 'write',
    detail: {
      en: 'Real Loader validation executes the candidate before commit; that code can read or change files accessible to the Host user.',
      zh: '真实 Loader 验证会在提交前执行候选代码；该代码可以读取或修改 Host 用户可访问的文件。',
    },
  }, {
    phase: 'acquisition', kind: 'subprocess', access: 'execute',
    detail: {
      en: 'Validation code can start child processes with the Host user\'s authority; the validator is not an OS sandbox.',
      zh: '验证代码可以使用 Host 用户权限启动子进程；验证器不是操作系统沙箱。',
    },
  }, {
    phase: 'acquisition', kind: 'credentials', access: 'read',
    detail: {
      en: 'The validator removes ambient credential environment variables, but candidate code can still reach credential files available to the Host user.',
      zh: '验证器会移除环境中的凭据变量，但候选代码仍可访问 Host 用户可读取的凭据文件。',
    },
  }, {
    phase: 'runtime', kind: 'network', access: 'send',
    detail: {
      en: 'The admitted behavior GETs one fixed catalog, but in-process Plugin code has the Host user\'s network authority.',
      zh: '准入行为只 GET 一个固定目录，但进程内 Plugin 代码具有 Host 用户的网络权限。',
    },
  }, {
    phase: 'runtime', kind: 'filesystem', access: 'write',
    detail: {
      en: 'In-process Plugin code can read or change files accessible to the Host user; DSH does not OS-confine it.',
      zh: '进程内 Plugin 代码可以读取或修改 Host 用户可访问的文件；DSH 不对它实施操作系统级隔离。',
    },
  }, {
    phase: 'runtime', kind: 'subprocess', access: 'execute',
    detail: {
      en: 'In-process Plugin code can start child processes with the Host user\'s authority.',
      zh: '进程内 Plugin 代码可以使用 Host 用户权限启动子进程。',
    },
  }, {
    phase: 'runtime', kind: 'credentials', access: 'read',
    detail: {
      en: 'The resolver declares no credential requirement, but in-process Plugin code can reach credentials available to the Host process.',
      zh: '解析器声明不需要凭据，但进程内 Plugin 代码可以访问 Host 进程可用的凭据。',
    },
  }, {
    phase: 'runtime', kind: 'model-context', access: 'send',
    detail: {
      en: 'A bounded safe projection of candidate identifiers can enter model context.',
      zh: '候选标识的有界安全投影可以进入模型上下文。',
    },
  }],
  dependencies: [{ kind: 'host', id: '@deepseek-ai/dsh', version: '0.1.1-rc.2', required: true }],
  scopes: ['profile:web'],
  configuration: {
    required: false,
    credentials: 'none',
    fields: [
      { en: 'Fresh catalog cache lifetime', zh: '目录新鲜缓存时长' },
      { en: 'Stale catalog cache lifetime', zh: '目录陈旧缓存时长' },
      { en: 'Catalog fetch timeout', zh: '目录获取超时' },
      { en: 'Maximum catalog bytes', zh: '目录最大字节数' },
      { en: 'Maximum catalog entries', zh: '目录最大条目数' },
      { en: 'Maximum task characters', zh: '任务最大字符数' },
      { en: 'Maximum returned candidates', zh: '最大返回候选数' },
      { en: 'Maximum current capability matches', zh: '最大当前能力匹配数' },
      { en: 'Maximum candidate description characters', zh: '候选描述最大字符数' },
      { en: 'Maximum matched terms', zh: '最大匹配词数' },
    ],
  },
  conflicts: [],
  restart: {
    required: true,
    detail: { en: 'Profile Bundle membership changes require an external Host restart.', zh: 'Profile Bundle 成员变更需要外部重启 Host。' },
  },
  lifecycle: admittedLifecycle,
  verification: [{
    claim: { en: 'Release artifact integrity', zh: 'Release 物料完整性' },
    status: 'verified',
    detail: {
      en: 'The admitted SHA-256 matches the immutable GitHub Release asset metadata.',
      zh: '准入 SHA-256 与不可变 GitHub Release asset 元数据一致。',
    },
  }, {
    claim: { en: 'Runtime task result', zh: '运行时任务结果' },
    status: 'unknown',
    detail: {
      en: 'Acquisition and task continuation are not executed by this rc.2 preview.',
      zh: '这个 rc.2 预览不会执行获取和任务续行。',
    },
  }],
  retainedData: {
    en: 'The plugin keeps an in-memory last-good catalog cache and no installation database.',
    zh: '该插件保留内存中的 last-good 目录缓存，不创建安装数据库。',
  },
  tags: ['discovery', 'catalog', 'capability', 'plugin'],
}, {
  candidateRef: 'mcp:io.github.domdomegg/filesystem-mcp@1.3.0',
  kind: 'mcp',
  name: 'io.github.domdomegg/filesystem-mcp',
  displayName: { en: 'Filesystem MCP', zh: '文件系统 MCP' },
  summary: {
    en: 'Adds a managed connection to an exact, Host-preprovisioned filesystem MCP runtime for user-selected roots.',
    zh: '为 Host 预置且版本准确的文件系统 MCP runtime 添加受管连接，并限定到用户选择的目录。',
  },
  publisher: { name: 'domdomegg', status: 'upstream-registry' },
  license: {
    spdx: 'MIT',
    status: 'publisher-declared',
    sourceUrl: 'https://raw.githubusercontent.com/domdomegg/filesystem-mcp/v1.3.0/package.json',
  },
  source: {
    type: 'mcp-registry',
    label: 'Official MCP Registry metadata',
    url: 'https://registry.modelcontextprotocol.io/?q=io.github.domdomegg%2Ffilesystem-mcp',
    upstreamUrl: 'https://github.com/domdomegg/filesystem-mcp',
    revision: '1.3.0',
    admittedAt: '2026-08-25T07:00:00.000Z',
  },
  artifact: {
    id: 'filesystem-mcp',
    version: '1.3.0',
    integrity: 'sha512:xL84LD46WmZUGGWdU2Rf6i/oDtMMdwiJ3k3I5bkku51khl7cS88SLKfkUFNa9478GtHjT46wTqTyly7aoNmneQ==',
    sizeBytes: 7223,
    acquisitionUrl: 'https://registry.npmjs.org/filesystem-mcp/-/filesystem-mcp-1.3.0.tgz',
  },
  compatibility: {
    status: 'compatible',
    dsh: '0.1.1-rc.2',
    platforms: ['darwin', 'linux', 'windows'],
    detail: {
      en: 'The admitted package exposes stdio; writable use additionally requires an exact Host runtime allowlist match and the dynamic MCP owner.',
      zh: '准入包提供 stdio；可写使用还需要准确匹配 Host runtime allowlist，并具备动态 MCP owner。',
    },
  },
  components: [{ en: 'One managed stdio connection to an external runtime', zh: '一个连接外部 runtime 的受管 stdio 连接' }],
  permissions: [{
    phase: 'acquisition', kind: 'network', access: 'none',
    detail: {
      en: 'P0 does not download the server package; the Host must already expose an integrity-pinned runtimeRef.',
      zh: 'P0 不下载服务器包；Host 必须已经提供 integrity-pinned runtimeRef。',
    },
  }, {
    phase: 'runtime', kind: 'filesystem', access: 'write',
    detail: {
      en: 'Reads and writes only the roots selected during configuration; those roots are not selected by the Agent.',
      zh: '只读写配置时由用户选择的目录；Agent 不能替用户选择这些目录。',
    },
  }, {
    phase: 'runtime', kind: 'subprocess', access: 'execute',
    detail: { en: 'Starts a local npm package as a Host process.', zh: '在 Host 上启动本地 npm 包进程。' },
  }, {
    phase: 'runtime', kind: 'credentials', access: 'none',
    detail: { en: 'The admitted stdio descriptor declares no credential.', zh: '准入 stdio descriptor 未声明凭据。' },
  }],
  dependencies: [
    { kind: 'host', id: '@deepseek-ai/dsh', version: '0.1.1-rc.2', required: true },
    { kind: 'runtime', id: 'filesystem-mcp', version: '1.3.0', required: true },
    { kind: 'runtime', id: 'node', version: '>=18', required: true },
  ],
  scopes: ['profile:web'],
  configuration: {
    required: true,
    credentials: 'none',
    fields: [
      { en: 'Host-provisioned runtime', zh: 'Host 预置 runtime' },
      { en: 'Connection name', zh: '连接名称' },
      { en: 'Allowed filesystem roots', zh: '允许访问的文件系统目录' },
      { en: 'Tool-call timeout', zh: 'Tool 调用超时' },
      { en: 'Reconnect policy', zh: '重连策略' },
    ],
  },
  conflicts: [{
    en: 'A server name must not collide with another configured MCP instance.',
    zh: 'Server name 不能与另一个已配置 MCP instance 冲突。',
  }],
  restart: {
    required: false,
    detail: { en: 'The dynamic MCP owner applies and verifies the connection in the current Host.', zh: '动态 MCP owner 在当前 Host 中应用并验证连接。' },
  },
  lifecycle: admittedLifecycle,
  verification: [{
    claim: { en: 'Registry and npm coordinates', zh: 'Registry 与 npm 坐标' },
    status: 'verified',
    detail: {
      en: 'Version 1.3.0 and its npm integrity were re-resolved during catalog admission.',
      zh: '目录准入时重新解析了 1.3.0 版本及其 npm integrity。',
    },
  }, {
    claim: { en: 'MCP handshake and tool generation', zh: 'MCP 握手与 Tool generation' },
    status: 'unknown',
    detail: {
      en: 'The exact preprovisioned runtime and its Tool generation must be observed on the target Host.',
      zh: '必须在目标 Host 上观测准确的预置 runtime 及其 Tool generation。',
    },
  }],
  retainedData: {
    en: 'The center retains connection recovery data; the external runtime remains Host-owned, and file changes inside configured roots are not undone.',
    zh: '扩展中心保留连接恢复数据；外部 runtime 仍由 Host 持有，配置目录内的文件变更不会被撤销。',
  },
  tags: ['filesystem', 'files', 'mcp', 'stdio'],
}, {
  candidateRef: 'skill:github-awesome-copilot/documentation-writer@d0d9d9f014abb27bf0d8321851867500a3a46bba',
  kind: 'skill',
  name: 'documentation-writer',
  displayName: { en: 'Documentation Writer', zh: '技术文档写作 Skill' },
  summary: {
    en: 'A single-file Agent Skill for planning and writing tutorials, how-to guides, reference, and explanation documents.',
    zh: '用于规划和撰写教程、操作指南、参考与解释型文档的单文件 Agent Skill。',
  },
  publisher: { name: 'github/awesome-copilot', status: 'community' },
  license: {
    spdx: 'MIT',
    status: 'verified',
    sourceUrl: 'https://raw.githubusercontent.com/github/awesome-copilot/d0d9d9f014abb27bf0d8321851867500a3a46bba/LICENSE',
  },
  source: {
    type: 'github-content',
    label: 'Pinned GitHub content',
    url: 'https://github.com/github/awesome-copilot/tree/d0d9d9f014abb27bf0d8321851867500a3a46bba/skills/documentation-writer',
    upstreamUrl: 'https://github.com/github/awesome-copilot',
    revision: 'd0d9d9f014abb27bf0d8321851867500a3a46bba',
    admittedAt: '2026-08-25T07:00:00.000Z',
  },
  artifact: {
    id: 'skills/documentation-writer/SKILL.md',
    version: 'd0d9d9f014abb27bf0d8321851867500a3a46bba',
    integrity: 'sha256:7e8244988c9f4eb63bf8c0edf160578544621eb96e5e51e2d848f1401c5de8f1',
    sizeBytes: 2748,
    acquisitionUrl: 'https://raw.githubusercontent.com/github/awesome-copilot/d0d9d9f014abb27bf0d8321851867500a3a46bba/skills/documentation-writer/SKILL.md',
  },
  compatibility: {
    status: 'compatible',
    dsh: '0.1.1-rc.2',
    platforms: ['darwin', 'linux', 'windows'],
    detail: {
      en: 'The pinned artifact is one bounded SKILL.md file with valid discovery metadata and no scripts or assets.',
      zh: '固定物料是一个有界 SKILL.md，具有有效发现元数据，不含脚本或 assets。',
    },
  },
  components: [{ en: 'One SKILL.md file', zh: '一个 SKILL.md 文件' }],
  permissions: [{
    phase: 'acquisition', kind: 'network', access: 'read',
    detail: {
      en: 'Downloads one exact content-addressed SKILL.md after a future confirmed plan.',
      zh: '未来确认计划后，只下载一个准确且内容寻址的 SKILL.md。',
    },
  }, {
    phase: 'runtime', kind: 'model-context', access: 'send',
    detail: {
      en: 'Its metadata and instructions enter model context when DSH selects the Skill.',
      zh: 'DSH 选择该 Skill 时，其元数据与指令会进入模型上下文。',
    },
  }, {
    phase: 'runtime', kind: 'subprocess', access: 'none',
    detail: { en: 'The admitted revision contains no script.', zh: '准入 revision 不包含脚本。' },
  }],
  dependencies: [{ kind: 'host', id: '@deepseek-ai/dsh', version: '0.1.1-rc.2', required: true }],
  scopes: ['user', 'project'],
  configuration: { required: false, credentials: 'none', fields: [] },
  conflicts: [{
    en: 'An existing Skill with the same name and different content must block promotion.',
    zh: '存在同名但内容不同的 Skill 时必须阻止 promotion。',
  }],
  restart: {
    required: false,
    detail: { en: 'A future owner must prove the merged Skill winner before claiming live visibility.', zh: '未来 owner 必须证明 merged Skill winner，才能声称实时可见。' },
  },
  lifecycle: admittedLifecycle,
  verification: [{
    claim: { en: 'Pinned content digest and file set', zh: '固定内容 digest 与文件集' },
    status: 'verified',
    detail: {
      en: 'Admission observed one file and recorded its SHA-256 at the exact commit.',
      zh: '准入在准确 commit 观察到一个文件并记录其 SHA-256。',
    },
  }, {
    claim: { en: 'Target Agent visibility', zh: '目标 Agent 可见性' },
    status: 'unknown',
    detail: {
      en: 'The rc.2 preview does not write a Skill root or claim a merged registry winner.',
      zh: 'rc.2 预览不写入 Skill root，也不声称 merged registry winner。',
    },
  }],
  retainedData: {
    en: 'A future managed install would retain the pinned Skill file until uninstall or purge.',
    zh: '未来的受管安装会保留固定 Skill 文件，直到卸载或清除。',
  },
  tags: ['documentation', 'writing', 'diataxis', 'skill'],
}]

/** Packaged trust root. The private signing key is not part of this repository. */
export const BOOTSTRAP_CATALOG_ROOT: CatalogRoot = {
  catalogId: 'dsh-extension-center-public',
  minimumRevision: 6,
  maximumAgeMs: 366 * 24 * 60 * 60 * 1000,
  threshold: 1,
  keys: [{
    keyId: 'bootstrap-2026-08-25-6',
    algorithm: 'ed25519',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA0Kr1n12i96xOZnD1lqwtlb3qHTOT0cD7tDZsTbGOfHY=\n-----END PUBLIC KEY-----\n',
  }],
}

/** Immutable bootstrap catalog shipped for fully offline Store discovery. */
export const BOOTSTRAP_CATALOG_ENVELOPE: CatalogEnvelope = {
  catalogId: 'dsh-extension-center-public',
  revision: 6,
  issuedAt: '2026-08-25T10:15:00.000Z',
  expiresAt: '2027-08-25T10:15:00.000Z',
  previousRevisionDigest: 'sha256:a7c608a1e2df649aa8e9dda7d9b276ef28a4504d48d4bf02eda228d67092802d',
  entriesDigest: 'sha256:cf753732e6a453c13373d9af2bca99257b74e1f8112420504eea20ce42b9afc2',
  entries: BOOTSTRAP_CATALOG_ENTRIES,
}

/** Threshold signature for the immutable bootstrap envelope. */
export const BOOTSTRAP_CATALOG_SIGNATURES: readonly CatalogSignature[] = [{
  keyId: 'bootstrap-2026-08-25-6',
  algorithm: 'ed25519',
  value: 'xbQ1GkIVBgau1u5KRcleGM7hN1F1IdD++zeaRCDO++RXFYZg58Rxr6NCCF0GAl9sy1hMLotsG0ndUI7C0ij+Cw==',
}]
