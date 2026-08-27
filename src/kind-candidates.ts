import type { CatalogEntry } from './catalog-contract.ts'
import { CAPABILITY_RESOLVER_CANDIDATES } from './resolver-candidates.ts'

const DOCUMENTATION_WRITER_REF = 'skill:github-awesome-copilot/documentation-writer@d0d9d9f014abb27bf0d8321851867500a3a46bba'
const WIKI_PAGE_WRITER_DESCRIPTION = 'Generates rich technical documentation pages with dark-mode Mermaid diagrams, source code citations, and first-principles depth. Use when writing documentation, generating wiki pages, creating technical deep-dives, or documenting specific components or systems.'
const WIKI_PAGE_WRITER_V1_BODY = `---
name: wiki-page-writer
description: Generates rich technical documentation pages with dark-mode Mermaid diagrams, source code citations, and first-principles depth. Use when writing documentation, generating wiki pages, creating technical deep-dives, or documenting specific components or systems.
---

# Wiki Page Writer

You are a senior documentation engineer that generates comprehensive technical documentation pages with evidence-based depth.

## When to Activate

- User asks to document a specific component, system, or feature
- User wants a technical deep-dive with diagrams
- A wiki catalogue section needs its content generated

## Source Repository Resolution (MUST DO FIRST)

Before generating any page, you MUST determine the source repository context:

1. **Check for git remote**: Run \`git remote get-url origin\` to detect if a remote exists
2. **Ask the user**: _"Is this a local-only repository, or do you have a source repository URL (e.g., GitHub, Azure DevOps)?"_
   - Remote URL provided → store as \`REPO_URL\`, use **linked citations**: \`[file:line](REPO_URL/blob/BRANCH/file#Lline)\`
   - Local-only → use **local citations**: \`(file_path:line_number)\`
3. **Determine default branch**: Run \`git rev-parse --abbrev-ref HEAD\`
4. **Do NOT proceed** until source repo context is resolved

## Depth Requirements (NON-NEGOTIABLE)

1. **TRACE ACTUAL CODE PATHS** — Do not guess from file names. Read the implementation.
2. **EVERY CLAIM NEEDS A SOURCE** — File path + function/class name.
3. **DISTINGUISH FACT FROM INFERENCE** — If you read the code, say so. If inferring, mark it.
4. **FIRST PRINCIPLES** — Explain WHY something exists before WHAT it does.
5. **NO HAND-WAVING** — Don't say "this likely handles..." — read the code.

## Procedure

1. **Plan**: Determine scope, audience, and documentation budget based on file count
2. **Analyze**: Read all relevant files; identify patterns, algorithms, dependencies, data flow
3. **Write**: Generate structured Markdown with diagrams and citations
4. **Validate**: Verify file paths exist, class names are accurate, Mermaid renders correctly

## Mandatory Requirements

### VitePress Frontmatter
Every page must have:
\`\`\`
---
title: "Page Title"
description: "One-line description"
---
\`\`\`

### Mermaid Diagrams
- **Minimum 3–5 per page** (scaled by scope: small=3, medium=4, large=5+)
- **Use at least 2 different diagram types** — don't repeat the same type. Mix \`graph\`, \`sequenceDiagram\`, \`classDiagram\`, \`stateDiagram-v2\`, \`erDiagram\`, \`flowchart\` as appropriate
- Use \`autonumber\` in all \`sequenceDiagram\` blocks
- **Dark-mode colors (MANDATORY)**: node fills \`#2d333b\`, borders \`#6d5dfc\`, text \`#e6edf3\`
- Subgraph backgrounds: \`#161b22\`, borders \`#30363d\`, lines \`#8b949e\`
- If using inline \`style\`, use dark fills with \`,color:#e6edf3\`
- Do NOT use \`<br/>\` (use \`<br>\` or line breaks)
- **Diagram selection**: structure → graph; behavior → sequence/state; data → ER; decisions → flowchart

### Citations
- Every non-trivial claim needs a citation with the resolved format:
  - **Remote repo**: \`[src/path/file.ts:42](REPO_URL/blob/BRANCH/src/path/file.ts#L42)\`
  - **Local repo**: \`(src/path/file.ts:42)\`
  - **Line ranges**: \`[src/path/file.ts:42-58](REPO_URL/blob/BRANCH/src/path/file.ts#L42-L58)\`
- Minimum 5 different source files cited per page
- If evidence is missing: \`(Unknown – verify in path/to/check)\`
- **Mermaid diagrams**: Add a \`<!-- Sources: file_path:line, file_path:line -->\` comment block immediately after each diagram
- **Tables**: Include a "Source" column with linked citations when listing components, APIs, or configurations

### Structure
- Overview (explain WHY) → Architecture → Components → Data Flow → Implementation → References → Related Pages
- **Use tables aggressively** — prefer tables over prose for any structured information (APIs, configs, components, comparisons)
- **Summary tables first**: Start each major section with an at-a-glance summary table before details
- Use comparison tables when introducing technologies or patterns — always compare side-by-side
- Include a "Source" column with linked citations in tables listing code artifacts
- Use bold for key terms, inline code for identifiers and paths
- Include pseudocode in a familiar language when explaining complex code paths
- **Progressive disclosure**: Start with the big picture, then drill into specifics — don't front-load details

### Cross-References Between Wiki Pages
- **Inline links**: When mentioning a concept, component, or pattern covered on another wiki page, link to it inline using relative Markdown links: \`[Component Name](../NN-section/page-name.md)\` or \`[Section Title](../NN-section/page-name.md#heading-anchor)\`
- **Related Pages section**: End every page with a "Related Pages" section listing connected wiki pages:
  \`\`\`markdown
  ## Related Pages

  | Page | Relationship |
  |------|-------------|
  | [Authentication](../02-architecture/authentication.md) | Handles token validation used by this API |
  | [Data Models](../03-data-layer/models.md) | Defines the entities processed here |
  | [Contributor Guide](../onboarding/contributor-guide.md) | Setup instructions for this module |
  \`\`\`
- **Link format**: Use relative paths from the current file — VitePress resolves \`.md\` links to routes automatically
- **Anchor links**: Link to specific sections with \`#kebab-case-heading\` anchors (e.g., \`[error handling](../02-architecture/overview.md#error-handling)\`)
- **Bidirectional where possible**: If page A links to page B, page B should link back to page A

### VitePress Compatibility
- Escape bare generics outside code fences: \`\` \`List<T>\` \`\` not bare \`List<T>\`
- No \`<br/>\` in Mermaid blocks
- All hex colors must be 3 or 6 digits
`
const WIKI_PAGE_WRITER_V2_BODY = WIKI_PAGE_WRITER_V1_BODY.replace(
  `description: ${WIKI_PAGE_WRITER_DESCRIPTION}\n---\n`,
  `description: ${WIKI_PAGE_WRITER_DESCRIPTION}\nlicense: MIT\nmetadata:\n  author: Microsoft\n  version: "1.0.0"\n---\n`,
)

/** Exact Filesystem MCP releases understood by this Extension Center build. */
export const FILESYSTEM_MCP_CANDIDATES = Object.freeze([
  Object.freeze({
    candidateRef: 'mcp:io.github.domdomegg/filesystem-mcp@1.2.2',
    name: 'io.github.domdomegg/filesystem-mcp',
    artifactId: 'filesystem-mcp',
    version: '1.2.2',
    integrity: 'sha512:KYYXCwSWD63MpPrownqLtWJgPcQ4TQkHE6Zp/1ESH8m77/F68wbNN4lcYVI8HtjWr02HBHton+87r6s47h4WJg==',
    sizeBytes: 7_211,
  }),
  Object.freeze({
    candidateRef: 'mcp:io.github.domdomegg/filesystem-mcp@1.3.0',
    name: 'io.github.domdomegg/filesystem-mcp',
    artifactId: 'filesystem-mcp',
    version: '1.3.0',
    integrity: 'sha512:xL84LD46WmZUGGWdU2Rf6i/oDtMMdwiJ3k3I5bkku51khl7cS88SLKfkUFNa9478GtHjT46wTqTyly7aoNmneQ==',
    sizeBytes: 7_223,
  }),
] as const)

/** Exact Skill artifacts and pre-authorization review bodies understood by this build. */
export const SKILL_CANDIDATES = Object.freeze([
  Object.freeze({
    candidateRef: DOCUMENTATION_WRITER_REF,
    name: 'documentation-writer',
    artifactId: 'skills/documentation-writer/SKILL.md',
    version: 'd0d9d9f014abb27bf0d8321851867500a3a46bba',
    integrity: 'sha256:7e8244988c9f4eb63bf8c0edf160578544621eb96e5e51e2d848f1401c5de8f1',
    sizeBytes: 2_748,
    reviewBody: null,
  }),
  Object.freeze({
    candidateRef: 'skill:microsoft-skills/wiki-page-writer@6142f8e60ac58372845c0fcdd2dbf043cd1bb698',
    name: 'wiki-page-writer',
    artifactId: '.github/plugins/deep-wiki/skills/wiki-page-writer/SKILL.md',
    version: '6142f8e60ac58372845c0fcdd2dbf043cd1bb698',
    integrity: 'sha256:7929f8adf896dbbf1fd744493f643c55a6812f0418d6cd89b3284f8f924d0c8f',
    sizeBytes: 5_807,
    reviewBody: WIKI_PAGE_WRITER_V1_BODY,
  }),
  Object.freeze({
    candidateRef: 'skill:microsoft-skills/wiki-page-writer@67ae723a23ba880e3e5c8a3e5e2320092024476e',
    name: 'wiki-page-writer',
    artifactId: '.github/plugins/deep-wiki/skills/wiki-page-writer/SKILL.md',
    version: '67ae723a23ba880e3e5c8a3e5e2320092024476e',
    integrity: 'sha256:f1270ea4123116e846bf2dc7a53a9e396ed43d694cdb7be22b9a35da9a40feb6',
    sizeBytes: 5_869,
    reviewBody: WIKI_PAGE_WRITER_V2_BODY,
  }),
] as const)

/** One exact Filesystem MCP release identity. */
export type FilesystemMcpCandidate = typeof FILESYSTEM_MCP_CANDIDATES[number]

/** One exact Skill artifact identity and review body. */
export type SkillCandidate = typeof SKILL_CANDIDATES[number]

/** Resolve only an exact Filesystem MCP candidate/version pair admitted by this build. */
export function filesystemMcpCandidate(
  candidateRef: string,
  version: string,
): FilesystemMcpCandidate | null {
  return FILESYSTEM_MCP_CANDIDATES.find(candidate =>
    candidate.candidateRef === candidateRef && candidate.version === version) ?? null
}

/** Resolve only an exact Filesystem MCP candidate reference admitted by this build. */
export function filesystemMcpCandidateRef(candidateRef: string): FilesystemMcpCandidate | null {
  return FILESYSTEM_MCP_CANDIDATES.find(candidate => candidate.candidateRef === candidateRef) ?? null
}

/** Resolve only an exact Skill candidate/version pair admitted by this build. */
export function skillCandidate(candidateRef: string, version: string): SkillCandidate | null {
  return SKILL_CANDIDATES.find(candidate =>
    candidate.candidateRef === candidateRef && candidate.version === version) ?? null
}

const UPDATE_SUCCESSORS = new Map<string, string>([
  [CAPABILITY_RESOLVER_CANDIDATES[0].candidateRef, CAPABILITY_RESOLVER_CANDIDATES[1].candidateRef],
  [FILESYSTEM_MCP_CANDIDATES[0].candidateRef, FILESYSTEM_MCP_CANDIDATES[1].candidateRef],
  [SKILL_CANDIDATES[1].candidateRef, SKILL_CANDIDATES[2].candidateRef],
])

/** Return the one package-reviewed update successor, or null when this build admits no exact update. */
export function candidateUpdateSuccessor(candidateRef: string): string | null {
  return UPDATE_SUCCESSORS.get(candidateRef) ?? null
}

/** Remove only exact package-declared predecessors from task-driven new-acquisition retrieval. */
export function taskAcquisitionCandidates(
  entries: readonly CatalogEntry[],
  scopeKey: string,
  outcomeTags: readonly string[],
): readonly CatalogEntry[] {
  const matching = entries.filter(entry => entry.scopes.includes(scopeKey as never)
    && outcomeTags.every(tag => entry.tags.includes(tag)))
  const byRef = new Map(matching.map(entry => [entry.candidateRef, entry]))
  return Object.freeze(entries.filter((entry) => {
    const successorRef = candidateUpdateSuccessor(entry.candidateRef)
    if (successorRef === null) return true
    const successor = byRef.get(successorRef)
    return successor === undefined || successor.kind !== entry.kind || successor.name !== entry.name
  }))
}
