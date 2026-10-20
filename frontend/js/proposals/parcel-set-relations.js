// Declared-reference set relations (same / contains / inside / overlap), not geometry or conflicts.
// Land-fork lineage records how a counterproposal's declaration differs from its origin's.
(function (global) {
    'use strict';

    function proposalKey(proposal) {
        const value = proposal?.proposalId ?? proposal?.id ?? proposal?.tokenId ?? null;
        return value === null || value === undefined ? '' : String(value);
    }

    function normalizeParcelIds(proposal) {
        const source = proposal?.cadastreParcelIds;
        return Array.from(new Set(
            (Array.isArray(source) ? source : [])
                .map(value => String(value ?? '').trim())
                .filter(Boolean)
        )).sort();
    }

    function parcelSourceOf(proposal) {
        const parcelSetValue = proposal?.parcelSet?.parcelSource;
        const bindingValue = proposal?.binding?.parcelSource;
        const normalize = source => {
            if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
            if (Object.keys(source).some(key => !['sourceId', 'snapshotId'].includes(key))) return null;
            if (typeof source.sourceId !== 'string' || !source.sourceId.trim()) return null;
            if (source.snapshotId !== null && source.snapshotId !== undefined
                && (typeof source.snapshotId !== 'string' || !source.snapshotId.trim())) return null;
            return { sourceId: source.sourceId.trim(), snapshotId: source.snapshotId?.trim() || null };
        };
        const setSource = normalize(parcelSetValue);
        const bindingSource = normalize(bindingValue);
        if ((parcelSetValue != null && !setSource) || (bindingValue != null && !bindingSource)) return null;
        if (setSource && bindingSource && (setSource.sourceId !== bindingSource.sourceId
            || setSource.snapshotId !== bindingSource.snapshotId)) return null;
        return setSource || bindingSource;
    }

    function sameParcelSource(left, right) {
        return !!left && !!right && left.sourceId === right.sourceId
            && left.snapshotId === right.snapshotId;
    }

    function sameDeclaredReferences(targetIds, candidateIds) {
        // The set hash is derived publication metadata; it cannot override the actual declaration.
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
        if (!sameParcelSource(parcelSourceOf(target), parcelSourceOf(candidate))) return null;
        const targetJurisdiction = String(target?.parcelSet?.jurisdiction || '').trim().toLowerCase();
        const candidateJurisdiction = String(candidate?.parcelSet?.jurisdiction || '').trim().toLowerCase();
        if (targetJurisdiction && candidateJurisdiction && targetJurisdiction !== candidateJurisdiction) return null;
        const targetAuthority = String(target?.parcelSet?.authority || '').trim();
        const candidateAuthority = String(candidate?.parcelSet?.authority || '').trim();
        if (targetAuthority && candidateAuthority && targetAuthority !== candidateAuthority) return null;

        const candidateSet = new Set(candidateIds);
        const sharedParcelIds = targetIds.filter(id => candidateSet.has(id));
        if (!sharedParcelIds.length) return null;

        const sameSet = sameDeclaredReferences(targetIds, candidateIds);
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
        const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : Infinity;
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

    // Every proposal id over one canonical parcel set, so activity can be filtered by land, not proposal.
    function proposalIdsForParcelSet(proposals, setHash) {
        if (typeof setHash !== 'string' || !setHash) return [];
        return (Array.isArray(proposals) ? proposals : [])
            .filter(proposal => parcelSourceOf(proposal) && proposal?.parcelSet?.setHash === setHash)
            .map(proposalKey)
            .filter(Boolean);
    }

    // How a fork's parcel set relates to its origin's, phrased from the ORIGIN's point of view via
    // classifyParcelSetRelation(origin, fork): 'contains-target' there means the fork includes the
    // whole origin set. Renamed here so a stored lineage reads without knowing which side was target.
    const FORK_RELATION_BY_KIND = {
        same: 'same',
        'contains-target': 'contains-origin',
        'inside-target': 'inside-origin',
        overlap: 'overlap'
    };

    function describeLandFork(origin, forkParcelIds, forkParcelSource = null) {
        const originIds = normalizeParcelIds(origin);
        const forkIds = normalizeParcelIds({ cadastreParcelIds: forkParcelIds });
        if (!originIds.length || !forkIds.length || !sameParcelSource(parcelSourceOf(origin), forkParcelSource)) return null;
        const relation = classifyParcelSetRelation(origin, {
            cadastreParcelIds: forkIds,
            parcelSet: { parcelSource: forkParcelSource }
        });
        const sharedCount = relation ? relation.sharedCount : 0;
        const kind = relation ? FORK_RELATION_BY_KIND[relation.kind] : 'disjoint';
        return {
            relation: kind,
            sameSet: kind === 'same',
            originCount: originIds.length,
            forkCount: forkIds.length,
            sharedCount,
            addedCount: forkIds.length - sharedCount,
            removedCount: originIds.length - sharedCount
        };
    }

    // The lineage a published counterproposal records when it sits on different land than its
    // origin. An identical set returns null: that is a plain counterproposal, nothing to record.
    function buildLandForkLineage(origin, forkParcelIds, forkParcelSource = null) {
        const description = describeLandFork(origin, forkParcelIds, forkParcelSource);
        if (!description || description.sameSet || !proposalKey(origin)) return null;
        const originSetHash = typeof origin?.parcelSet?.setHash === 'string' && origin.parcelSet.setHash
            ? origin.parcelSet.setHash
            : null;
        return {
            originSetHash,
            relation: description.relation,
            originParcelCount: description.originCount,
            sharedParcelCount: description.sharedCount,
            addedParcelCount: description.addedCount,
            removedParcelCount: description.removedCount
        };
    }

    // The i18n key + params that describe a land-fork lineage (or a live description) in words.
    function landForkSummaryMessage(lineage) {
        if (!lineage || typeof lineage !== 'object') return null;
        const relation = lineage.relation;
        const params = {
            origin: Number(lineage.originParcelCount ?? lineage.originCount) || 0,
            shared: Number(lineage.sharedParcelCount ?? lineage.sharedCount) || 0,
            added: Number(lineage.addedParcelCount ?? lineage.addedCount) || 0,
            removed: Number(lineage.removedParcelCount ?? lineage.removedCount) || 0
        };
        const messages = {
            same: ['panel.proposal.landFork.relationSame', 'Same parcels as the original'],
            'contains-origin': ['panel.proposal.landFork.relationContains', 'All {{origin}} original parcels plus {{added}} more'],
            'inside-origin': ['panel.proposal.landFork.relationInside', '{{shared}} of the {{origin}} original parcels'],
            overlap: ['panel.proposal.landFork.relationOverlap', '{{shared}} parcels shared with the original, {{added}} added, {{removed}} removed'],
            disjoint: ['panel.proposal.landFork.relationDisjoint', 'No parcels in common with the original']
        };
        const entry = messages[relation];
        if (!entry) return null;
        return { key: entry[0], fallback: entry[1], params };
    }

    const api = {
        proposalKey, normalizeParcelIds, parcelSourceOf, classifyParcelSetRelation, findParcelSetRelations,
        proposalIdsForParcelSet, describeLandFork, buildLandForkLineage, landForkSummaryMessage
    };
    global.ParcelSetRelations = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
