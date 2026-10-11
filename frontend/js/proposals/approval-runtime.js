// Thin browser adapter from pluggable rights/authority providers to the pure approval model.
// The current profile is the actor; proposal uploads and caller display metadata grant no authority.
(function (root) {
    'use strict';
    const api = () => root.ProposalApproval;
    const verifyReceipt = (proposal, receipt) => root.ProposalApprovalAuthorities?.verifyReceipt(proposal, receipt) === true;
    const validIds = (proposal, hash) => api().validOwnerIds(proposal, hash, verifyReceipt);
    const uses = proposal => !!proposal && (proposal.goal === 'reparcellization' || !!proposal.reparcellization || proposal.approvalConfig != null);
    function inspect(proposal) {
        try { return api().inspect(proposal); }
        catch (error) {
            if (error.code !== 'invalid-proposal-approval') throw error;
            return { ready: false, reason: 'invalid-rights', ownerIds: [], parcels: [], missingParcelIds: [], error };
        }
    }
    function label(id, ids) {
        const fallback = api().ownerLabel(id, ids);
        const letter = fallback.replace(/^Owner\s*/, '');
        const translated = root.i18n?.t?.('proposalApproval.ownerLabel', { label: letter });
        return translated && translated !== 'proposalApproval.ownerLabel' ? translated : fallback;
    }
    function evidence(proposal, ownerId, actor) {
        return root.ProposalApprovalAuthorities?.resolve(proposal, ownerId, actor) || null;
    }
    function state(proposal, parcelId, actor, hash) {
        const rights = inspect(proposal);
        const parcel = rights.parcels.find(row => row.parcelId === String(parcelId));
        const yes = new Set(rights.ready ? validIds(proposal, hash) : []);
        return {
            ownershipResolved: rights.ready, reason: rights.reason,
            entries: (parcel?.owners || []).map(owner => {
                const receipt = proposal.ownerApprovals?.[owner.ownerId];
                const authorized = rights.ready && hash && !!evidence(proposal, owner.ownerId, actor);
                return {
                    key: owner.ownerId, ownerId: owner.ownerId,
                    displayName: label(owner.ownerId, rights.ownerIds), shareText: owner.share, shareDetail: '',
                    accepted: yes.has(owner.ownerId), termsChanged: !!receipt?.effectHash && !!hash && receipt.effectHash !== hash,
                    acceptedAt: receipt?.acceptedAt || null, acceptedByAgentId: receipt?.actorId || null,
                    acceptedByName: '', slotType: 'abstract', agentId: null,
                    canAccept: !!authorized && !yes.has(owner.ownerId),
                    canUndo: !!authorized && yes.has(owner.ownerId) && receipt?.actorId === actor?.id
                };
            })
        };
    }
    function refresh(proposal, hash) {
        const rights = inspect(proposal);
        if (!rights.ready) {
            proposal.acceptedParcelIds = [];
            return { lapsedOwners: Object.keys(proposal.ownerApprovals || {}).length, ownershipResolved: false };
        }
        const accepted = validIds(proposal, hash);
        const tally = api().tally(proposal, accepted);
        proposal.acceptedParcelIds = tally.acceptedParcelIds;
        return { ...tally, ownershipResolved: true, lapsedOwners: Object.keys(proposal.ownerApprovals || {}).length - accepted.length };
    }
    function summary(proposal, hash) {
        const rights = inspect(proposal);
        const tally = refresh(proposal, hash);
        const yes = new Set(rights.ready ? validIds(proposal, hash) : []);
        return {
            ...tally, totalOwners: rights.ready ? rights.ownerIds.length : 0, acceptedOwners: yes.size,
            entries: rights.ready ? rights.ownerIds.map(id => ({
                key: id, displayName: label(id, rights.ownerIds), accepted: yes.has(id),
                parcelIds: rights.parcels.filter(parcel => parcel.owners.some(owner => owner.ownerId === id)).map(parcel => parcel.parcelId)
            })) : []
        };
    }
    async function decide(proposal, parcelId, ownerId, actor, hash, withdraw = false, currentHash = () => hash) {
        const rights = inspect(proposal);
        if (!rights.ready) return { error: 'ownership-unresolved' };
        const parcel = rights.parcels.find(row => row.parcelId === String(parcelId));
        const id = ownerId || (parcel?.owners.length === 1 ? parcel.owners[0].ownerId : null);
        if (!id || !parcel?.owners.some(owner => owner.ownerId === id)) return { error: 'unknown-owner' };
        const authorization = evidence(proposal, id, actor);
        if (!authorization) return { error: 'authority-unresolved' };
        const receipt = { ownerId: id, actorId: actor.id, effectHash: hash, evidence: authorization.evidence,
            providerId: authorization.providerId, decision: withdraw ? 'withdraw' : 'approve', acceptedAt: new Date().toISOString() };
        const decisionProof = await root.ProposalApprovalAuthorities.signDecision(proposal, receipt, actor);
        if (currentHash() !== hash || (!withdraw && proposal.lifecycleStatus === 'Executed')
            || ['Cancelled', 'Expired'].includes(proposal.lifecycleStatus)) return { error: 'terms-changed' };
        const result = api().recordDecision(proposal, {
            ...receipt, withdraw, decisionProof, verifyReceipt
        });
        // Publish only the consent delta; do not replace the live proposal or its unrelated fields.
        proposal.ownerApprovals = result.proposal.ownerApprovals;
        if (result.proposal.ownerApprovalHistory) proposal.ownerApprovalHistory = result.proposal.ownerApprovalHistory;
        proposal.acceptedParcelIds = result.proposal.acceptedParcelIds;
        return { ...result.tally, ownerId: id };
    }
    root.ProposalApprovalRuntime = { uses, inspect, state, refresh, summary, decide, label, validIds };
})(typeof window !== 'undefined' ? window : globalThis);
