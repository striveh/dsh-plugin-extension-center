import type { CatalogEntry } from './catalog-contract.ts';
/** Exact Filesystem MCP releases understood by this Extension Center build. */
export declare const FILESYSTEM_MCP_CANDIDATES: readonly [Readonly<{
    candidateRef: "mcp:io.github.domdomegg/filesystem-mcp@1.2.2";
    name: "io.github.domdomegg/filesystem-mcp";
    artifactId: "filesystem-mcp";
    version: "1.2.2";
    integrity: "sha512:KYYXCwSWD63MpPrownqLtWJgPcQ4TQkHE6Zp/1ESH8m77/F68wbNN4lcYVI8HtjWr02HBHton+87r6s47h4WJg==";
    sizeBytes: 7211;
}>, Readonly<{
    candidateRef: "mcp:io.github.domdomegg/filesystem-mcp@1.3.0";
    name: "io.github.domdomegg/filesystem-mcp";
    artifactId: "filesystem-mcp";
    version: "1.3.0";
    integrity: "sha512:xL84LD46WmZUGGWdU2Rf6i/oDtMMdwiJ3k3I5bkku51khl7cS88SLKfkUFNa9478GtHjT46wTqTyly7aoNmneQ==";
    sizeBytes: 7223;
}>];
/** Exact Skill artifacts and pre-authorization review bodies understood by this build. */
export declare const SKILL_CANDIDATES: readonly [Readonly<{
    candidateRef: "skill:github-awesome-copilot/documentation-writer@d0d9d9f014abb27bf0d8321851867500a3a46bba";
    name: "documentation-writer";
    artifactId: "skills/documentation-writer/SKILL.md";
    version: "d0d9d9f014abb27bf0d8321851867500a3a46bba";
    integrity: "sha256:7e8244988c9f4eb63bf8c0edf160578544621eb96e5e51e2d848f1401c5de8f1";
    sizeBytes: 2748;
    reviewBody: null;
}>, Readonly<{
    candidateRef: "skill:microsoft-skills/wiki-page-writer@6142f8e60ac58372845c0fcdd2dbf043cd1bb698";
    name: "wiki-page-writer";
    artifactId: ".github/plugins/deep-wiki/skills/wiki-page-writer/SKILL.md";
    version: "6142f8e60ac58372845c0fcdd2dbf043cd1bb698";
    integrity: "sha256:7929f8adf896dbbf1fd744493f643c55a6812f0418d6cd89b3284f8f924d0c8f";
    sizeBytes: 5807;
    reviewBody: "---\nname: wiki-page-writer\ndescription: Generates rich technical documentation pages with dark-mode Mermaid diagrams, source code citations, and first-principles depth. Use when writing documentation, generating wiki pages, creating technical deep-dives, or documenting specific components or systems.\n---\n\n# Wiki Page Writer\n\nYou are a senior documentation engineer that generates comprehensive technical documentation pages with evidence-based depth.\n\n## When to Activate\n\n- User asks to document a specific component, system, or feature\n- User wants a technical deep-dive with diagrams\n- A wiki catalogue section needs its content generated\n\n## Source Repository Resolution (MUST DO FIRST)\n\nBefore generating any page, you MUST determine the source repository context:\n\n1. **Check for git remote**: Run `git remote get-url origin` to detect if a remote exists\n2. **Ask the user**: _\"Is this a local-only repository, or do you have a source repository URL (e.g., GitHub, Azure DevOps)?\"_\n   - Remote URL provided → store as `REPO_URL`, use **linked citations**: `[file:line](REPO_URL/blob/BRANCH/file#Lline)`\n   - Local-only → use **local citations**: `(file_path:line_number)`\n3. **Determine default branch**: Run `git rev-parse --abbrev-ref HEAD`\n4. **Do NOT proceed** until source repo context is resolved\n\n## Depth Requirements (NON-NEGOTIABLE)\n\n1. **TRACE ACTUAL CODE PATHS** — Do not guess from file names. Read the implementation.\n2. **EVERY CLAIM NEEDS A SOURCE** — File path + function/class name.\n3. **DISTINGUISH FACT FROM INFERENCE** — If you read the code, say so. If inferring, mark it.\n4. **FIRST PRINCIPLES** — Explain WHY something exists before WHAT it does.\n5. **NO HAND-WAVING** — Don't say \"this likely handles...\" — read the code.\n\n## Procedure\n\n1. **Plan**: Determine scope, audience, and documentation budget based on file count\n2. **Analyze**: Read all relevant files; identify patterns, algorithms, dependencies, data flow\n3. **Write**: Generate structured Markdown with diagrams and citations\n4. **Validate**: Verify file paths exist, class names are accurate, Mermaid renders correctly\n\n## Mandatory Requirements\n\n### VitePress Frontmatter\nEvery page must have:\n```\n---\ntitle: \"Page Title\"\ndescription: \"One-line description\"\n---\n```\n\n### Mermaid Diagrams\n- **Minimum 3–5 per page** (scaled by scope: small=3, medium=4, large=5+)\n- **Use at least 2 different diagram types** — don't repeat the same type. Mix `graph`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, `erDiagram`, `flowchart` as appropriate\n- Use `autonumber` in all `sequenceDiagram` blocks\n- **Dark-mode colors (MANDATORY)**: node fills `#2d333b`, borders `#6d5dfc`, text `#e6edf3`\n- Subgraph backgrounds: `#161b22`, borders `#30363d`, lines `#8b949e`\n- If using inline `style`, use dark fills with `,color:#e6edf3`\n- Do NOT use `<br/>` (use `<br>` or line breaks)\n- **Diagram selection**: structure → graph; behavior → sequence/state; data → ER; decisions → flowchart\n\n### Citations\n- Every non-trivial claim needs a citation with the resolved format:\n  - **Remote repo**: `[src/path/file.ts:42](REPO_URL/blob/BRANCH/src/path/file.ts#L42)`\n  - **Local repo**: `(src/path/file.ts:42)`\n  - **Line ranges**: `[src/path/file.ts:42-58](REPO_URL/blob/BRANCH/src/path/file.ts#L42-L58)`\n- Minimum 5 different source files cited per page\n- If evidence is missing: `(Unknown – verify in path/to/check)`\n- **Mermaid diagrams**: Add a `<!-- Sources: file_path:line, file_path:line -->` comment block immediately after each diagram\n- **Tables**: Include a \"Source\" column with linked citations when listing components, APIs, or configurations\n\n### Structure\n- Overview (explain WHY) → Architecture → Components → Data Flow → Implementation → References → Related Pages\n- **Use tables aggressively** — prefer tables over prose for any structured information (APIs, configs, components, comparisons)\n- **Summary tables first**: Start each major section with an at-a-glance summary table before details\n- Use comparison tables when introducing technologies or patterns — always compare side-by-side\n- Include a \"Source\" column with linked citations in tables listing code artifacts\n- Use bold for key terms, inline code for identifiers and paths\n- Include pseudocode in a familiar language when explaining complex code paths\n- **Progressive disclosure**: Start with the big picture, then drill into specifics — don't front-load details\n\n### Cross-References Between Wiki Pages\n- **Inline links**: When mentioning a concept, component, or pattern covered on another wiki page, link to it inline using relative Markdown links: `[Component Name](../NN-section/page-name.md)` or `[Section Title](../NN-section/page-name.md#heading-anchor)`\n- **Related Pages section**: End every page with a \"Related Pages\" section listing connected wiki pages:\n  ```markdown\n  ## Related Pages\n\n  | Page | Relationship |\n  |------|-------------|\n  | [Authentication](../02-architecture/authentication.md) | Handles token validation used by this API |\n  | [Data Models](../03-data-layer/models.md) | Defines the entities processed here |\n  | [Contributor Guide](../onboarding/contributor-guide.md) | Setup instructions for this module |\n  ```\n- **Link format**: Use relative paths from the current file — VitePress resolves `.md` links to routes automatically\n- **Anchor links**: Link to specific sections with `#kebab-case-heading` anchors (e.g., `[error handling](../02-architecture/overview.md#error-handling)`)\n- **Bidirectional where possible**: If page A links to page B, page B should link back to page A\n\n### VitePress Compatibility\n- Escape bare generics outside code fences: `` `List<T>` `` not bare `List<T>`\n- No `<br/>` in Mermaid blocks\n- All hex colors must be 3 or 6 digits\n";
}>, Readonly<{
    candidateRef: "skill:microsoft-skills/wiki-page-writer@67ae723a23ba880e3e5c8a3e5e2320092024476e";
    name: "wiki-page-writer";
    artifactId: ".github/plugins/deep-wiki/skills/wiki-page-writer/SKILL.md";
    version: "67ae723a23ba880e3e5c8a3e5e2320092024476e";
    integrity: "sha256:f1270ea4123116e846bf2dc7a53a9e396ed43d694cdb7be22b9a35da9a40feb6";
    sizeBytes: 5869;
    reviewBody: string;
}>];
/** One exact Filesystem MCP release identity. */
export type FilesystemMcpCandidate = typeof FILESYSTEM_MCP_CANDIDATES[number];
/** One exact Skill artifact identity and review body. */
export type SkillCandidate = typeof SKILL_CANDIDATES[number];
/** Resolve only an exact Filesystem MCP candidate/version pair admitted by this build. */
export declare function filesystemMcpCandidate(candidateRef: string, version: string): FilesystemMcpCandidate | null;
/** Resolve only an exact Filesystem MCP candidate reference admitted by this build. */
export declare function filesystemMcpCandidateRef(candidateRef: string): FilesystemMcpCandidate | null;
/** Resolve only an exact Skill candidate/version pair admitted by this build. */
export declare function skillCandidate(candidateRef: string, version: string): SkillCandidate | null;
/** Return the one package-reviewed update successor, or null when this build admits no exact update. */
export declare function candidateUpdateSuccessor(candidateRef: string): string | null;
/** Remove only exact package-declared predecessors from task-driven new-acquisition retrieval. */
export declare function taskAcquisitionCandidates(entries: readonly CatalogEntry[], scopeKey: string, outcomeTags: readonly string[]): readonly CatalogEntry[];
//# sourceMappingURL=kind-candidates.d.ts.map
