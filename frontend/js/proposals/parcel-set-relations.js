(function (global) {
    'use strict';

    function proposalKey(proposal) {
        const value = proposal?.proposalId ?? proposal?.id ?? proposal?.tokenId ?? null;
        return value === null || value === undefined ? '' : String(value);
    }

    function normalizeParcelIds(proposal) {
        const source = Array.isArray(proposal?.parcelSet?.parcelIds)
            ? proposal.parcelSet.parcelIds
            : proposal?.cadastreParcelIds;
        return Array.from(new Set(
            (Array.isArray(source) ? source : [])
                .map(value => String(value ?? '').trim())
                .filter(Boolean)
        )).sort();
    }

    function jurisdictionOf(proposal) {
        const value = proposal?.parcelSet?.jurisdiction ?? proposal?.city ?? '';
        return String(value || '').trim().toLowerCase();
    }

    function sameCanonicalSet(target, candidate, targetIds, candidateIds) {
        const targetHash = typeof target?.parcelSet?.setHash === 'string' ? target.parcelSet.setHash : '';
        const candidateHash = typeof candidate?.parcelSet?.setHash === 'string' ? candidate.parcelSet.setHash : '';
        if (targetHash && candidateHash) return targetHash === candidateHash;
        return targetIds.length === candidateIds.length
            && targetIds.every((id, index) => id === candidateIds[index]);
    }

    function classifyParcelSetRelation(target, candidate) {
        if (!target || !candidate || target === candidate) return null;
        const targetKey = proposalKey(target);
        const candidateKey = proposalKey(candidate);
        if (targetKey && candidateKey && targetKey === candidateKey) return null;

        const targetIds = normalizeParcelIds(target);
        const candidateIds = normalizeParcelIds(candidate);
        if (!targetIds.length || !candidateIds.length) return null;
        const targetJurisdiction = jurisdictionOf(target);
        const candidateJurisdiction = jurisdictionOf(candidate);
        if (targetJurisdiction && candidateJurisdiction && targetJurisdiction !== candidateJurisdiction) return null;

        const candidateSet = new Set(candidateIds);
        const sharedParcelIds = targetIds.filter(id => candidateSet.has(id));
        if (!sharedParcelIds.length) return null;

        const sameSet = sameCanonicalSet(target, candidate, targetIds, candidateIds);
        let kind = 'overlap';
        if (sameSet) kind = 'same';
        else if (sharedParcelIds.length === targetIds.length) kind = 'contains-target';
        else if (sharedParcelIds.length === candidateIds.length) kind = 'inside-target';

        const unionCount = new Set([...targetIds, ...candidateIds]).size;
        return {
            proposal: candidate,
            proposalId: candidateKey,
            kind,
            sharedParcelIds,
            sharedCount: sharedParcelIds.length,
            targetCount: targetIds.length,
            candidateCount: candidateIds.length,
            unionCount,
            overlapRatio: unionCount ? sharedParcelIds.length / unionCount : 0
        };
    }

    function findParcelSetRelations(target, candidates, options = {}) {
        const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 12;
        const rank = { same: 0, 'contains-target': 1, 'inside-target': 2, overlap: 3 };
        return (Array.isArray(candidates) ? candidates : [])
            .map(candidate => classifyParcelSetRelation(target, candidate))
            .filter(Boolean)
            .sort((left, right) => {
                const kindDiff = rank[left.kind] - rank[right.kind];
                if (kindDiff) return kindDiff;
                const sharedDiff = right.sharedCount - left.sharedCount;
                if (sharedDiff) return sharedDiff;
                return left.proposalId.localeCompare(right.proposalId);
            })
            .slice(0, limit);
    }

    const api = { proposalKey, normalizeParcelIds, jurisdictionOf, classifyParcelSetRelation, findParcelSetRelations };
    global.ParcelSetRelations = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
