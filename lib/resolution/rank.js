import { canonicalSha256, immutableJsonClone } from "../domain/index.js";
const TAG = /^[a-z0-9]+(?:[./-][a-z0-9]+)*$/;
function normalizedTags(values) {
    return Object.freeze([...new Set(values.map(value => value.trim().toLowerCase()).filter(value => TAG.test(value)))].sort());
}
function canonicalNeed(value) {
    return immutableJsonClone({
        ...value,
        outcomeTags: normalizedTags(value.outcomeTags),
        inputModalities: [...new Set(value.inputModalities)].sort(),
        outputModalities: [...new Set(value.outputModalities)].sort(),
        requiredDataAccess: [...new Set(value.requiredDataAccess)].sort(),
        maximumAuthority: [...new Set(value.maximumAuthority)].sort(),
    });
}
function existingSatisfies(need, capability) {
    if (!capability.visible || !capability.observationComplete)
        return false;
    const tags = new Set(normalizedTags(capability.outcomeTags));
    const access = new Set(capability.dataAccess);
    return need.outcomeTags.every(tag => tags.has(tag))
        && need.requiredDataAccess.every(item => access.has(item));
}
function managementAction(row) {
    if (row.materialized !== 'absent' && row.configurationRevision === null && row.actions.configure.status === 'available') {
        return 'configure';
    }
    if (row.materialized !== 'absent' && row.desired === 'disabled' && row.actions.enable.status === 'available') {
        return 'enable';
    }
    if (row.effective === 'activation-failed' && row.actions.restore.status === 'available')
        return 'restore';
    if (row.updateObservation.status === 'available' && row.actions.update.status === 'available')
        return 'update';
    return undefined;
}
function inventoryMatches(need, row) {
    if (row.candidateRef === null)
        return false;
    const tags = normalizedTags(row.candidateRef.split(/[:@/_-]/u));
    return need.outcomeTags.some(tag => tags.includes(tag));
}
function authorityFlags(entry) {
    return Object.freeze([...new Set(entry.permissions
            .filter(permission => permission.access !== 'none')
            .map(permission => `${permission.kind}:${permission.access}`))].sort());
}
function maximumAllows(need, flags) {
    const maximum = new Set(need.maximumAuthority);
    return flags.every((flag) => {
        if (flag.startsWith('network:'))
            return maximum.has('network');
        if (flag === 'filesystem:read')
            return maximum.has('filesystem-read');
        if (flag === 'filesystem:write')
            return maximum.has('filesystem-write');
        if (flag.startsWith('subprocess:'))
            return maximum.has('subprocess');
        return true;
    });
}
function retrieve(input, need) {
    const values = [];
    for (const entry of input.catalog) {
        const policy = input.policy.get(entry.candidateRef);
        if (policy?.status !== 'eligible' || !entry.compatibility.platforms.includes(need.platform))
            continue;
        const flags = authorityFlags(entry);
        if (!maximumAllows(need, flags))
            continue;
        const tags = normalizedTags(entry.tags);
        const matchedTags = need.outcomeTags.filter(tag => tags.includes(tag));
        if (matchedTags.length === 0)
            continue;
        const requiredAccessCoverage = need.requiredDataAccess.filter((required) => {
            if (required === 'network')
                return flags.some(flag => flag.startsWith('network:'));
            if (required === 'filesystem-read')
                return flags.includes('filesystem:read') || flags.includes('filesystem:write');
            if (required === 'filesystem-write')
                return flags.includes('filesystem:write');
            return flags.some(flag => flag.startsWith('subprocess:'));
        }).length;
        const score = matchedTags.length * 100
            + requiredAccessCoverage * 20
            + (entry.scopes.length === 1 ? 5 : 0)
            - flags.length;
        values.push(Object.freeze({
            candidateRef: entry.candidateRef,
            kind: entry.kind,
            artifactRevision: entry.artifact.version,
            matchedTags: Object.freeze(matchedTags),
            score,
            authorityFlags: flags,
            scopes: Object.freeze([...entry.scopes].sort()),
            policy,
        }));
    }
    return values.sort((left, right) => right.score - left.score || left.candidateRef.localeCompare(right.candidateRef));
}
function materiallyDifferent(left, right) {
    return left.kind !== right.kind
        || left.authorityFlags.join('\u0000') !== right.authorityFlags.join('\u0000')
        || left.scopes.join('\u0000') !== right.scopes.join('\u0000');
}
/**
 * Resolve existing capability, existing management, or an admitted local catalog candidate in that order.
 * @param input Complete current-scope and catalog observations with deterministic policy results.
 * @returns Closed decision without executable installation material or untrusted prose.
 */
export function resolveCapability(input) {
    const need = canonicalNeed(input.need);
    const needDigest = canonicalSha256(need);
    const existing = [...input.existing]
        .filter(capability => existingSatisfies(need, capability))
        .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))[0];
    if (existing !== undefined) {
        return Object.freeze({ decision: 'use-existing', needDigest, capabilityId: existing.capabilityId });
    }
    if (!input.inventoryComplete)
        return Object.freeze({ decision: 'discovery-unavailable', needDigest });
    const management = input.inventory
        .filter(row => inventoryMatches(need, row))
        .map(row => ({ row, action: managementAction(row) }))
        .filter((value) => value.action !== undefined)
        .sort((left, right) => left.row.targetKey.localeCompare(right.row.targetKey))[0];
    if (management !== undefined) {
        return Object.freeze({
            decision: 'management-required',
            needDigest,
            extensionRef: management.row.targetKey,
            action: management.action,
        });
    }
    if (!input.catalogComplete)
        return Object.freeze({ decision: 'discovery-unavailable', needDigest });
    const maximumCandidates = Math.max(1, Math.min(3, Math.trunc(input.maximumCandidates)));
    const candidates = retrieve(input, need).slice(0, maximumCandidates);
    if (candidates.length === 0)
        return Object.freeze({ decision: 'no-eligible-candidate', needDigest });
    const best = candidates[0];
    const alternatives = candidates.slice(1).filter(candidate => candidate.score * 1.25 >= best.score && materiallyDifferent(best, candidate));
    if (alternatives.length > 0) {
        return Object.freeze({ decision: 'choice-required', needDigest, candidates: Object.freeze([best, ...alternatives]) });
    }
    return Object.freeze({ decision: 'acquisition-candidate', needDigest, candidate: best });
}
//# sourceMappingURL=rank.js.map
