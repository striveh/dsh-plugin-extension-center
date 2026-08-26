import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { catalogReviewEvidenceSupport } from "../catalog.js";
import { canonicalSha256, immutableJsonClone } from "../domain/index.js";
import { openRegularNoFollow } from "../host/index.js";
import { pluginConfigurationReview } from "../providers/index.js";
const PLUGIN_MANIFEST_BODY = '{"name":"dsh-capability-resolver","version":"0.1.0","description":"Read-only local capability and community plugin discovery for DeepSeek Harness Web","license":"MIT","type":"module","sideEffects":["./lib/client.js"],"main":"lib/index.js","types":"lib/types/index.d.ts","exports":{".":{"types":"./lib/types/index.d.ts","default":"./lib/index.js"},"./client":{"types":"./lib/types/client/index.d.ts","default":"./lib/client.js"},"./types":{"types":"./lib/types/types.d.ts","default":"./lib/types.js"},"./cordis.patch.yml":"./cordis.patch.yml","./package.json":"./package.json"},"files":["lib","docs","compatibility","cordis.patch.yml","README.md","README.zh.md","CHANGELOG.md","CONTRIBUTING.md","SECURITY.md","LICENSE"],"engines":{"node":"^22.19.0 || >=24","dsh":"0.1.1-rc.2"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"},"client":{"platform":"web","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-settings-plugins","@deepseek-ai/dsh-client-ui-primitives","@deepseek-ai/dsh-client-ui-slots"]}},"keywords":["dsh-plugin","deepseek-harness","plugin-discovery","capability-discovery","local-first","developer-tools"],"repository":{"type":"git","url":"git+https://github.com/striveh/dsh-capability-resolver.git"},"bugs":{"url":"https://github.com/striveh/dsh-capability-resolver/issues"},"homepage":"https://github.com/striveh/dsh-capability-resolver#readme","peerDependencies":{"@deepseek-ai/cordis":"4.0.1","@deepseek-ai/cordis-plugin-loader":"1.0.2","@deepseek-ai/dsh-client-connection":"0.1.1-rc.2","@deepseek-ai/dsh-client-locale":"0.1.1-rc.2","@deepseek-ai/dsh-client-runtime":"0.1.1-rc.2","@deepseek-ai/dsh-client-ui-primitives":"0.1.1-rc.2","@deepseek-ai/dsh-client-ui-settings":"0.1.1-rc.2","@deepseek-ai/dsh-client-ui-settings-plugins":"0.1.1-rc.2","@deepseek-ai/dsh-client-ui-slots":"0.1.1-rc.2","@deepseek-ai/dsh-skill":"0.1.1-rc.2","@deepseek-ai/dsh-tools":"0.1.1-rc.2","@deepseek-ai/schemastery":"3.18.1","react":"^18.2.0"},"peerDependenciesMeta":{"@deepseek-ai/dsh-client-connection":{"optional":true},"@deepseek-ai/dsh-client-locale":{"optional":true},"@deepseek-ai/dsh-client-runtime":{"optional":true},"@deepseek-ai/dsh-client-ui-primitives":{"optional":true},"@deepseek-ai/dsh-client-ui-settings":{"optional":true},"@deepseek-ai/dsh-client-ui-settings-plugins":{"optional":true},"@deepseek-ai/dsh-client-ui-slots":{"optional":true},"react":{"optional":true}},"devDependencies":{"@deepseek-ai/cordis":"4.0.1","@deepseek-ai/cordis-plugin-loader":"1.0.2","@deepseek-ai/dsh-client-connection":"0.1.1-rc.2","@deepseek-ai/dsh-client-locale":"0.1.1-rc.2","@deepseek-ai/dsh-client-runtime":"0.1.1-rc.2","@deepseek-ai/dsh-client-test-runtime":"0.1.1-rc.2","@deepseek-ai/dsh-client-ui-primitives":"0.1.1-rc.2","@deepseek-ai/dsh-client-ui-settings":"0.1.1-rc.2","@deepseek-ai/dsh-client-ui-settings-plugins":"0.1.1-rc.2","@deepseek-ai/dsh-client-ui-slots":"0.1.1-rc.2","@deepseek-ai/dsh-skill":"0.1.1-rc.2","@deepseek-ai/dsh-tools":"0.1.1-rc.2","@deepseek-ai/schemastery":"3.18.1","@testing-library/react":"^16.3.0","@types/node":"^24.13.3","@types/react":"~18.3.1","@types/react-dom":"^18.3.7","@vitest/coverage-v8":"^4.1.8","jsdom":"^26.1.0","lightningcss":"^1.33.0","react":"^18.2.0","react-dom":"^18.2.0","tsdown":"0.22.2","typescript":"^6.0.3","vitest":"^4.1.8"},"scripts":{"clean":"node scripts/clean.mjs","clean:client-build":"node scripts/clean-client-build.mjs","typecheck":"tsc -p tsconfig.host.json --noEmit && tsc -p tsconfig.client.json --noEmit","build":"pnpm run clean && tsc -p tsconfig.host.json && tsc -p tsconfig.client.json && tsdown && pnpm run clean:client-build","test":"vitest run","test:maintenance":"node --test scripts/*.test.mjs","test:coverage":"vitest run --coverage","verify:artifacts":"node scripts/verify-committed-artifacts.mjs","verify:package":"node scripts/verify-package.mjs","verify:compatibility":"node scripts/verify-compatibility.mjs","verify":"pnpm run typecheck && pnpm run test && pnpm run test:maintenance && pnpm run verify:artifacts && pnpm run verify:package && pnpm run verify:compatibility"}}';
const PLUGIN_FILES = Object.freeze([
    'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'README.zh.md', 'SECURITY.md',
    'compatibility/dsh.json', 'cordis.patch.yml', 'docs/design.md', 'docs/design.zh.md',
    'docs/privacy-and-trust.md', 'docs/privacy-and-trust.zh.md', 'lib/catalog.js', 'lib/catalog.js.map',
    'lib/client.js', 'lib/client.js.map', 'lib/index.js', 'lib/index.js.map', 'lib/ranking.js',
    'lib/ranking.js.map', 'lib/resolver.js', 'lib/resolver.js.map', 'lib/rpc.js', 'lib/rpc.js.map',
    'lib/tool.js', 'lib/tool.js.map', 'lib/types.js', 'lib/types.js.map', 'lib/types/catalog.d.ts',
    'lib/types/catalog.d.ts.map', 'lib/types/client/CapabilityResolverSettingsTab.d.ts',
    'lib/types/client/CapabilityResolverSettingsTab.d.ts.map', 'lib/types/client/api.d.ts',
    'lib/types/client/api.d.ts.map', 'lib/types/client/controller.d.ts', 'lib/types/client/controller.d.ts.map',
    'lib/types/client/index.d.ts', 'lib/types/client/index.d.ts.map', 'lib/types/client/locales.d.ts',
    'lib/types/client/locales.d.ts.map', 'lib/types/client/model.d.ts', 'lib/types/client/model.d.ts.map',
    'lib/types/client/store.d.ts', 'lib/types/client/store.d.ts.map', 'lib/types/index.d.ts',
    'lib/types/index.d.ts.map', 'lib/types/ranking.d.ts', 'lib/types/ranking.d.ts.map',
    'lib/types/resolver.d.ts', 'lib/types/resolver.d.ts.map', 'lib/types/rpc.d.ts', 'lib/types/rpc.d.ts.map',
    'lib/types/tool.d.ts', 'lib/types/tool.d.ts.map', 'lib/types/types.d.ts', 'lib/types/types.d.ts.map',
    'package.json',
].sort());
const PLUGIN_PATCH_BODY = `- insert:
    - id: dsh-capability-resolver
      name: dsh-capability-resolver
      config:
        freshCacheMs: 900000
        staleCacheMs: 86400000
        fetchTimeoutMs: 5000
        maxCatalogBytes: 8388608
        maxCatalogEntries: 5000
        maxTaskChars: 2000
        maxResults: 8
        maxCurrentMatches: 8
        maxDescriptionChars: 600
        maxMatchedTerms: 12
`;
const PLUGIN_SCRIPTS = Object.freeze([
    'build', 'clean', 'clean:client-build', 'test', 'test:coverage', 'test:maintenance', 'typecheck',
    'verify', 'verify:artifacts', 'verify:compatibility', 'verify:package',
]);
const PLUGIN_PEERS = Object.freeze({
    '@deepseek-ai/cordis': '4.0.1',
    '@deepseek-ai/cordis-plugin-loader': '1.0.2',
    '@deepseek-ai/dsh-client-connection': '0.1.1-rc.2',
    '@deepseek-ai/dsh-client-locale': '0.1.1-rc.2',
    '@deepseek-ai/dsh-client-runtime': '0.1.1-rc.2',
    '@deepseek-ai/dsh-client-ui-primitives': '0.1.1-rc.2',
    '@deepseek-ai/dsh-client-ui-settings': '0.1.1-rc.2',
    '@deepseek-ai/dsh-client-ui-settings-plugins': '0.1.1-rc.2',
    '@deepseek-ai/dsh-client-ui-slots': '0.1.1-rc.2',
    '@deepseek-ai/dsh-skill': '0.1.1-rc.2',
    '@deepseek-ai/dsh-tools': '0.1.1-rc.2',
    '@deepseek-ai/schemastery': '3.18.1',
    react: '^18.2.0',
});
const SKILL_BODY = `---
name: documentation-writer
description: 'Diátaxis Documentation Expert. An expert technical writer specializing in creating high-quality software documentation, guided by the principles and structure of the Diátaxis technical documentation authoring framework.'
---

# Diátaxis Documentation Expert

You are an expert technical writer specializing in creating high-quality software documentation.
Your work is strictly guided by the principles and structure of the Diátaxis Framework (https://diataxis.fr/).

## GUIDING PRINCIPLES

1. **Clarity:** Write in simple, clear, and unambiguous language.
2. **Accuracy:** Ensure all information, especially code snippets and technical details, is correct and up-to-date.
3. **User-Centricity:** Always prioritize the user's goal. Every document must help a specific user achieve a specific task.
4. **Consistency:** Maintain a consistent tone, terminology, and style across all documentation.

## YOUR TASK: The Four Document Types

You will create documentation across the four Diátaxis quadrants. You must understand the distinct purpose of each:

- **Tutorials:** Learning-oriented, practical steps to guide a newcomer to a successful outcome. A lesson.
- **How-to Guides:** Problem-oriented, steps to solve a specific problem. A recipe.
- **Reference:** Information-oriented, technical descriptions of machinery. A dictionary.
- **Explanation:** Understanding-oriented, clarifying a particular topic. A discussion.

## WORKFLOW

You will follow this process for every documentation request:

1. **Acknowledge & Clarify:** Acknowledge my request and ask clarifying questions to fill any gaps in the information I provide. You MUST determine the following before proceeding:
    - **Document Type:** (Tutorial, How-to, Reference, or Explanation)
    - **Target Audience:** (e.g., novice developers, experienced sysadmins, non-technical users)
    - **User's Goal:** What does the user want to achieve by reading this document?
    - **Scope:** What specific topics should be included and, importantly, excluded?

2. **Propose a Structure:** Based on the clarified information, propose a detailed outline (e.g., a table of contents with brief descriptions) for the document. Await my approval before writing the full content.

3. **Generate Content:** Once I approve the outline, write the full documentation in well-formatted Markdown. Adhere to all guiding principles.

## CONTEXTUAL AWARENESS

- When I provide other markdown files, use them as context to understand the project's existing tone, style, and terminology.
- DO NOT copy content from them unless I explicitly ask you to.
- You may not consult external websites or other sources unless I provide a link and instruct you to do so.
`;
function bytesDigest(value) {
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
async function optionalFileDigest(path) {
    let handle;
    try {
        handle = await openRegularNoFollow(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    try {
        return `sha256:${createHash('sha256').update(await handle.readFile()).digest('hex')}`;
    }
    finally {
        await handle.close();
    }
}
async function managedBody(version) {
    if (version === null || version === undefined)
        return null;
    const handle = await openRegularNoFollow(version.materialPath);
    try {
        const bytes = await handle.readFile();
        if (bytes.length > 1024 * 1024)
            throw new Error('managed Skill review body exceeds the P0 bound');
        return bytes.toString('utf8');
    }
    finally {
        await handle.close();
    }
}
function currentForOperation(record, operation) {
    if (operation === 'restore')
        return record?.removed ?? record?.lastGood ?? null;
    return record?.current ?? null;
}
function invocation(version) {
    if (version === null || typeof version.kindState !== 'object' || version.kindState === null || Array.isArray(version.kindState)) {
        return Object.freeze({ model: null, user: null });
    }
    const state = version.kindState;
    return Object.freeze({
        model: typeof state.modelInvocable === 'boolean' ? state.modelInvocable : null,
        user: typeof state.userInvocable === 'boolean' ? state.userInvocable : null,
    });
}
function check(code, phase) {
    return Object.freeze({ code, phase });
}
function commonMaterials(kind, operation, record) {
    const existing = record?.current ?? record?.removed ?? record?.lastGood ?? null;
    const digest = existing === null ? null : canonicalSha256(existing);
    if (kind === 'plugin')
        return Object.freeze({
            removed: operation === 'uninstall' ? [
                { kind: 'profile-dependency', id: record?.extensionId ?? 'dsh-capability-resolver', digest },
                { kind: 'bundle-row', id: record?.extensionId ?? 'dsh-capability-resolver', digest },
            ] : [],
            retained: operation === 'uninstall' ? [
                { kind: 'plugin-settings', id: record?.targetKey ?? 'plugin-settings', digest },
                { kind: 'recovery-point', id: record?.profileId ?? 'profile', digest },
            ] : [],
        });
    if (kind === 'skill')
        return Object.freeze({
            removed: ['uninstall', 'purge'].includes(operation)
                ? [{ kind: 'skill-file', id: existing?.materialPath ?? 'SKILL.md', digest }]
                : [],
            retained: operation === 'uninstall'
                ? [{ kind: 'recovery-point', id: existing?.materialPath ?? 'SKILL.md', digest }]
                : [],
        });
    return Object.freeze({
        removed: operation === 'uninstall' || operation === 'purge'
            ? [{ kind: 'connection-row', id: record?.extensionId ?? 'mcp-connection', digest }]
            : [],
        retained: [
            { kind: 'external-runtime', id: existing?.materialPath ?? 'host-runtime', digest: null },
            { kind: 'remote-data', id: record?.extensionId ?? 'mcp-remote-effects', digest: null },
        ],
    });
}
function rollbackPoint(record) {
    const version = record?.current ?? null;
    return version === null
        ? { kind: 'absent-state', id: 'absent', digest: canonicalSha256(null) }
        : { kind: 'managed-version', id: version.candidateRef, digest: canonicalSha256(version) };
}
function configInvocation(value) {
    const input = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
    return Object.freeze({ model: input.modelInvocable !== false, user: input.userInvocable !== false });
}
async function pluginEvidence(input) {
    if (catalogReviewEvidenceSupport(input.entry) !== 'package-pinned')
        throw new Error('Plugin has no package-pinned review record');
    const schema = pluginConfigurationReview();
    const before = currentForOperation(input.managed, input.operationKind);
    const afterVersion = ['uninstall', 'purge'].includes(input.operationKind) ? null : input.entry.artifact.version;
    const materials = commonMaterials('plugin', input.operationKind, input.managed);
    const rollback = input.profile.activeGeneration === null
        ? { kind: 'absent-state', id: `profile:${input.profileId}:absent-generation`, digest: input.profile.treeDigest }
        : { kind: 'profile-generation', id: input.profile.activeGeneration, digest: input.profile.treeDigest };
    const dependencies = [
        { kind: 'profile', id: input.entry.artifact.id, beforeVersion: before?.artifactRevision ?? null, afterVersion, required: true },
        ...input.entry.dependencies.map(item => ({ ...item, beforeVersion: null, afterVersion: item.version })),
        ...Object.entries(PLUGIN_PEERS).map(([id, version]) => ({
            kind: 'peer', id, beforeVersion: null, afterVersion: version, required: true,
        })),
    ];
    const checks = [
        check('catalog-admission', 'planning'), check('owner-revision', 'planning'), check('review-record', 'planning'),
        check('artifact-integrity', 'prepare'), check('plugin-manifest', 'prepare'), check('plugin-dependencies', 'prepare'),
        check('plugin-lifecycle-scripts', 'prepare'), check('plugin-bundle', 'prepare'), check('plugin-settings-schema', 'prepare'),
        check('profile-lockfile', 'apply'), check('owner-mutation', 'apply'), check('isolated-profile-boot', 'external-restart'),
        check('loader-consumer', 'external-restart'),
    ];
    return immutableJsonClone({
        schemaVersion: 1,
        kind: 'plugin',
        operationKind: input.operationKind,
        checks,
        ...materials,
        credentialChoice: 'not-applicable',
        rollbackPoint: rollback,
        rollbackLimits: ['dsh-managed-state-only', 'third-party-side-effects-not-reversed', 'restart-required-before-runtime-proof'],
        notProven: ['catalog-admission-is-not-security-audit', 'target-lockfile-bytes-before-staging', 'third-party-code-side-effects', 'post-restart-consumer', 'user-task-outcome'],
        manifest: {
            packageName: input.entry.artifact.id,
            beforeVersion: before?.artifactRevision ?? null,
            afterVersion,
            body: PLUGIN_MANIFEST_BODY,
            manifestDigest: canonicalSha256(JSON.parse(PLUGIN_MANIFEST_BODY)),
            files: PLUGIN_FILES,
            fileManifestDigest: canonicalSha256(PLUGIN_FILES),
        },
        dependencies,
        lockfile: {
            path: 'pnpm-lock.yaml',
            beforeDigest: await optionalFileDigest(join(input.profile.effectivePath, 'pnpm-lock.yaml')),
            packageName: input.entry.artifact.id,
            beforeVersion: before?.artifactRevision ?? null,
            afterVersion,
            targetIntegrity: afterVersion === null ? null : input.entry.artifact.integrity,
        },
        bundles: [{
                id: input.entry.artifact.id,
                action: input.operationKind === 'uninstall' ? 'remove' : input.operationKind === 'restore' ? 'restore'
                    : before === null ? 'add' : 'retain',
                patchDigest: bytesDigest(PLUGIN_PATCH_BODY),
                patchBody: PLUGIN_PATCH_BODY,
            }],
        scripts: {
            before: before === null ? [] : PLUGIN_SCRIPTS,
            after: afterVersion === null ? [] : PLUGIN_SCRIPTS,
            forbiddenLifecycle: [],
        },
        settings: {
            adapterVersion: schema.adapterVersion,
            adapterDigest: schema.adapterDigest,
            schemaDigest: schema.schemaDigest,
            ownerRevision: input.ownerRevision,
            migration: 'not-required',
            schema: schema.schema,
            migrationChanges: [],
            diffDigest: canonicalSha256({ operation: input.operationKind, configuration: input.configuration }),
        },
    });
}
async function skillEvidence(input) {
    if (catalogReviewEvidenceSupport(input.entry) !== 'package-pinned')
        throw new Error('Skill has no package-pinned review record');
    const prior = currentForOperation(input.managed, input.operationKind);
    const before = await managedBody(prior);
    const targetBody = ['install', 'update'].includes(input.operationKind) ? SKILL_BODY
        : input.operationKind === 'restore' ? await managedBody(input.managed?.removed ?? input.managed?.lastGood)
            : ['uninstall', 'purge'].includes(input.operationKind) ? null : before;
    const beforeInvocation = invocation(prior);
    const configured = configInvocation(input.configuration);
    const afterInvocation = targetBody === null ? { model: null, user: null }
        : ['configure', 'install', 'update'].includes(input.operationKind) ? configured : beforeInvocation;
    const materials = commonMaterials('skill', input.operationKind, input.managed);
    const change = before === null ? 'add' : targetBody === null
        ? input.operationKind === 'purge' ? 'purge' : 'remove'
        : before === targetBody ? 'retain' : input.operationKind === 'restore' ? 'restore' : 'replace';
    return immutableJsonClone({
        schemaVersion: 1,
        kind: 'skill',
        operationKind: input.operationKind,
        checks: [
            check('catalog-admission', 'planning'), check('owner-revision', 'planning'), check('review-record', 'planning'),
            check('artifact-integrity', 'prepare'), check('skill-file-manifest', 'prepare'), check('skill-frontmatter', 'prepare'),
            check('skill-body', 'prepare'), check('skill-links', 'prepare'), check('skill-executables', 'prepare'),
            check('invocation-policy', 'prepare'), check('owner-mutation', 'apply'), check('merged-skill-winner', 'verify'),
        ],
        ...materials,
        credentialChoice: 'not-applicable',
        rollbackPoint: rollbackPoint(input.managed),
        rollbackLimits: input.operationKind === 'purge'
            ? ['dsh-managed-state-only', 'workspace-files-not-restored', 'purge-irreversible']
            : ['dsh-managed-state-only', 'workspace-files-not-restored'],
        notProven: ['catalog-admission-is-not-security-audit', 'user-task-outcome'],
        files: [{
                path: prior?.materialPath ?? 'SKILL.md',
                change,
                beforeDigest: before === null ? null : bytesDigest(before),
                afterDigest: targetBody === null ? null : bytesDigest(targetBody),
                sizeBytes: Buffer.byteLength(targetBody ?? before ?? '', 'utf8'),
                executableBefore: false,
                executableAfter: false,
                linkBefore: null,
                linkAfter: null,
            }],
        body: {
            before,
            after: targetBody,
            beforeDigest: before === null ? null : bytesDigest(before),
            afterDigest: targetBody === null ? null : bytesDigest(targetBody),
        },
        invocation: {
            beforeModelInvocable: beforeInvocation.model,
            beforeUserInvocable: beforeInvocation.user,
            afterModelInvocable: afterInvocation.model,
            afterUserInvocable: afterInvocation.user,
        },
    });
}
function mcpEvidence(input) {
    if (catalogReviewEvidenceSupport(input.entry) !== 'runtime-bound')
        throw new Error('MCP has no runtime-bound review recipe');
    if (input.runtime === null)
        throw new Error('MCP review requires an exact runtime preflight');
    const materials = commonMaterials('mcp', input.operationKind, input.managed);
    return immutableJsonClone({
        schemaVersion: 1,
        kind: 'mcp',
        operationKind: input.operationKind,
        checks: [
            check('catalog-admission', 'planning'), check('owner-revision', 'planning'), check('mcp-runtime-integrity', 'planning'),
            check('mcp-descriptor', 'prepare'), check('mcp-secret-absence', 'prepare'), check('owner-mutation', 'apply'),
            check('mcp-initialize', 'verify'), check('mcp-tools-list', 'verify'), check('mcp-tool-generation', 'verify'),
            check('quiescent-disposal', 'verify'),
        ],
        ...materials,
        credentialChoice: 'not-applicable',
        rollbackPoint: rollbackPoint(input.managed),
        rollbackLimits: ['dsh-managed-state-only', 'remote-grants-not-revoked', 'third-party-side-effects-not-reversed', 'external-runtime-not-restored'],
        notProven: ['catalog-admission-is-not-security-audit', 'remote-side-effects', 'external-runtime-state', 'user-task-outcome'],
        descriptor: input.runtime.reviewDescriptor,
        runtime: {
            ownership: input.runtime.reviewDescriptor.transport === 'stdio' ? 'host' : 'remote',
            version: input.runtime.version,
            digest: input.runtime.runtimeDigest,
            action: 'none',
        },
        credentials: 'none',
        dataEgress: input.runtime.reviewDescriptor.transport === 'stdio' ? 'local-process' : 'remote-origin',
    });
}
/** Build package-pinned evidence without downloading or executing a candidate before approval. */
export async function buildPlanReviewEvidence(input) {
    return input.entry.kind === 'plugin' ? await pluginEvidence(input)
        : input.entry.kind === 'skill' ? await skillEvidence(input)
            : mcpEvidence(input);
}
//# sourceMappingURL=review-evidence.js.map
