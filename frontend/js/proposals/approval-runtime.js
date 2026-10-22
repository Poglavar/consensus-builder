// Thin browser adapter from pluggable rights/authority providers to the pure approval model.
// The current profile is the actor and its provider names the signer (the profile or a wallet);
// uploads and caller display metadata grant no authority.
//
// Every function takes an agreement-like object (ProposalApproval's decision functions): the
// engine's subject { cadastreParcelIds, approvalConfig, lens }, `agreementCid` once the agreement is
// proposed, the receipts `ownerApprovals` / `ownerApprovalHistory` (written back here), and
// `lifecycleStatus` when it is known. A decision signs the CID, which commits to the terms, so no
// terms hash is passed. Without a CID nothing counts and nobody can decide.
// M2: the browser flow (the agreement panel) passes { ...AgreementRecord.approvalSubject(agreement),
// agreementCid: AgreementRecord.publishedCid(agreement, designCidOf), ownerApprovals,
// ownerApprovalHistory, lifecycleStatus } and keeps the receipts this writes back.
(function (root) {
    'use strict';
    const api = () => root.ProposalApproval;
    const verifyReceipt = (agreement, receipt) => root.ProposalApprovalAuthorities?.verifyReceipt(agreement, receipt) === true;
    const validIds = agreement => api().validOwnerIds(agreement, verifyReceipt);
    const uses = agreement => !!agreement && agreement.approvalConfig != null;
    // The CID a decision on this agreement signs, or null while it has none.
    function subjectOf(agreement) {
        try { return api().subjectOf(agreement); }
        catch (error) {
            if (error.code !== 'invalid-proposal-approval') throw error;
            return null;
        }
    }
    function inspect(agreement) {
        try { return api().inspect(agreement); }
        catch (error) {
            if (error.code !== 'invalid-proposal-approval') throw error;
            return { ready: false, reason: 'invalid-rights', ownerIds: [], leaseholderIds: [], authorityIds: [], partyIds: [], publicIds: [], parcels: [], missingParcelIds: [], error };
        }
    }
    // "Owner A", "Leaseholder A" or "Authority", translated. Takes the agreement's inspect() state, or
    // a plain owner id list where only owners are named.
    function label(id, idsOrState) {
        const state = Array.isArray(idsOrState) ? { ownerIds: idsOrState, leaseholderIds: [], authorityIds: [] } : idsOrState;
        const party = api().partyOf(id, state) || { kind: 'owner', letter: '' };
        const key = party.kind === 'authority' ? (party.letter ? 'proposalApproval.authorityLabelLettered' : 'proposalApproval.authorityLabel')
            : party.kind === 'leaseholder' ? 'proposalApproval.leaseholderLabel' : 'proposalApproval.ownerLabel';
        const translated = root.i18n?.t?.(key, { label: party.letter });
        return translated && translated !== key ? translated : api().partyLabel(id, state);
    }
    function evidence(agreement, ownerId, actor) {
        return root.ProposalApprovalAuthorities?.resolve(agreement, ownerId, actor) || null;
    }
    function state(agreement, parcelId, actor) {
        const rights = inspect(agreement);
        const parcel = rights.parcels.find(row => row.parcelId === String(parcelId));
        const yes = new Set(rights.ready ? validIds(agreement) : []);
        const decidable = rights.ready && !!subjectOf(agreement);
        return {
            ownershipResolved: rights.ready, reason: rights.reason,
            entries: (parcel?.owners || []).map(owner => {
                const receipt = agreement.ownerApprovals?.[owner.ownerId];
                const authorization = decidable ? evidence(agreement, owner.ownerId, actor) : null;
                return {
                    key: owner.ownerId, ownerId: owner.ownerId,
                    displayName: label(owner.ownerId, rights.ownerIds), shareText: owner.share, shareDetail: '',
                    accepted: yes.has(owner.ownerId),
                    acceptedAt: receipt?.decidedAt || null, acceptedByAgentId: receipt?.actorId || null,
                    acceptedByName: '', slotType: 'abstract', agentId: null,
                    canAccept: !!authorization && !yes.has(owner.ownerId),
                    canUndo: !!authorization && yes.has(owner.ownerId) && receipt?.actorId === authorization.actorId
                };
            })
        };
    }
    function refresh(agreement) {
        const rights = inspect(agreement);
        if (!rights.ready) {
            agreement.acceptedParcelIds = [];
            return { lapsedOwners: Object.keys(agreement.ownerApprovals || {}).length, ownershipResolved: false };
        }
        const accepted = validIds(agreement);
        const tally = api().tally(agreement, accepted);
        agreement.acceptedParcelIds = tally.acceptedParcelIds;
        return { ...tally, ownershipResolved: true, lapsedOwners: Object.keys(agreement.ownerApprovals || {}).length - accepted.length };
    }
    function summary(agreement) {
        const rights = inspect(agreement);
        const tally = refresh(agreement);
        const yes = new Set(rights.ready ? validIds(agreement) : []);
        return {
            ...tally, totalOwners: rights.ready ? rights.ownerIds.length : 0, acceptedOwners: rights.ready ? rights.ownerIds.filter(id => yes.has(id)).length : 0,
            entries: rights.ready ? rights.ownerIds.map(id => ({
                key: id, displayName: label(id, rights.ownerIds), accepted: yes.has(id),
                parcelIds: rights.parcels.filter(parcel => parcel.owners.some(owner => owner.ownerId === id)).map(parcel => parcel.parcelId)
            })) : []
        };
    }
    // One signed decision on the agreement's CID. Errors: ownership-unresolved, not-proposed (no CID
    // yet), unknown-owner, authority-unresolved, terms-changed (the agreement-like object was given
    // another CID while the wallet signed) and agreement-closed.
    async function decide(agreement, parcelId, ownerId, actor, withdraw = false) {
        if (typeof withdraw !== 'boolean') throw new TypeError('decide(agreement, parcelId, ownerId, actor, withdraw): withdraw is a boolean.');
        const rights = inspect(agreement);
        if (!rights.ready) return { error: 'ownership-unresolved' };
        const subject = subjectOf(agreement);
        if (!subject) return { error: 'not-proposed' };
        // Checked before the wallet is asked to sign, and again after, in case it closed meanwhile.
        const closed = () => (!withdraw && agreement.lifecycleStatus === 'Executed')
            || ['Cancelled', 'Expired'].includes(agreement.lifecycleStatus);
        if (closed()) return { error: 'agreement-closed' };
        // A holder decides from one of its parcels (or for a lease only, or as an authority, from none).
        const parcel = parcelId == null ? null : rights.parcels.find(row => row.parcelId === String(parcelId));
        const id = ownerId || (parcel?.owners.length === 1 ? parcel.owners[0].ownerId : null);
        const onParcel = !!parcel && [...parcel.owners, ...(parcel.leases || []).flatMap(lease => lease.holders)].some(holder => holder.ownerId === id);
        if (!id || !rights.partyIds.includes(id) || (parcelId != null && !onParcel)) return { error: 'unknown-owner' };
        const authorization = evidence(agreement, id, actor);
        if (!authorization) return { error: 'authority-unresolved' };
        const receipt = { ownerId: id, actorId: authorization.actorId, evidence: authorization.evidence,
            providerId: authorization.providerId, decision: withdraw ? 'withdraw' : 'approve', decidedAt: new Date().toISOString() };
        const decisionProof = await root.ProposalApprovalAuthorities.signDecision(agreement, receipt, actor);
        if (subjectOf(agreement) !== subject) return { error: 'terms-changed' };
        if (closed()) return { error: 'agreement-closed' };
        const result = api().recordDecision(agreement, {
            ...receipt, withdraw, decisionProof, verifyReceipt
        });
        // Publish only the consent delta; do not replace the live agreement or its unrelated fields.
        agreement.ownerApprovals = result.agreement.ownerApprovals;
        if (result.agreement.ownerApprovalHistory) agreement.ownerApprovalHistory = result.agreement.ownerApprovalHistory;
        agreement.acceptedParcelIds = result.agreement.acceptedParcelIds;
        return { ...result.tally, ownerId: id };
    }
    // Parties (owners, leaseholders, authorities) the current profile can act for right now.
    function authorizedOwnerIds(agreement, actor) {
        const rights = inspect(agreement);
        return rights.ready && subjectOf(agreement) ? rights.partyIds.filter(id => !!evidence(agreement, id, actor)) : [];
    }
    root.ProposalApprovalRuntime = { uses, inspect, state, refresh, summary, decide, label, validIds, authorizedOwnerIds };
})(typeof window !== 'undefined' ? window : globalThis);
