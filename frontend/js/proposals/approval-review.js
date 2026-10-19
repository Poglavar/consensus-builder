// What one abstract party is asked to accept: the land (or lease) they contribute, what a land
// readjustment gives them back, their cash, the conditions, and how far the proposal is from passing
// before and after their decision. An authority sees the same terms and progress. Pure (no DOM);
// proposals/approval-panel.js renders it.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApprovalReview = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const approval = () => root.ProposalApproval || (typeof require === 'function' ? require('./approval.js') : null);
    const deal = () => root.ReparcellizationDeal || (typeof require === 'function' ? require('../reparcellization-deal.js') : null);
    const allocation = () => root.ReparcellizationAllocation
        || (typeof require === 'function' ? require('../reparcellization-allocation.js') : null);

    const shareValue = share => {
        const [n, d] = String(share).split('/').map(Number);
        return n / d;
    };

    // The tally the parties would show with exactly these approvals, and what is missing: each test
    // (heads or area, with what it needs), each required authority decision, and who has not yet
    // approved among the holders the tests count.
    function progress(proposal, acceptedOwnerIds = []) {
        const A = approval();
        const state = A.inspect(proposal);
        const tally = A.tally(proposal, acceptedOwnerIds);
        const policy = state.context.policy;
        const regime = state.context.regime || null;
        if (!state.ready) return { ready: false, reason: state.reason, policy, regime, passed: false };
        const yes = new Set(acceptedOwnerIds.filter(id => state.partyIds.includes(id)));
        const parcelsOf = id => state.parcels.filter(parcel => parcel.owners.some(owner => owner.ownerId === id)
            || (parcel.leases || []).some(lease => lease.holders.some(holder => holder.ownerId === id))).map(parcel => parcel.parcelId);
        // Holders whose approval some test counts (a public body outside every "private" test is heard, not counted).
        const counted = new Set(tally.tests.flatMap(test => {
            const pool = test.of === 'owners' ? state.ownerIds : test.of === 'leaseholders' ? state.leaseholderIds : [...state.ownerIds, ...state.leaseholderIds];
            return pool.filter(id => test.scope === 'all' || !state.publicIds.includes(id));
        }));
        return {
            ready: true, reason: null, policy, regime,
            tests: tally.tests, authorities: tally.authorities,
            supportMet: tally.supportMet, authorityMet: tally.authorityMet, passed: tally.passed,
            totalOwners: tally.totalOwners, acceptedOwners: tally.acceptedOwners,
            totalAreaM2: tally.totalAreaM2, acceptedAreaM2: tally.acceptedAreaM2,
            acceptedParcelIds: tally.acceptedParcelIds,
            outstanding: [...counted].sort().filter(id => !yes.has(id)).map(ownerId => ({ ownerId, parcelIds: parcelsOf(ownerId) })),
            // A co-owned parcel's area counts only once every co-owner has accepted.
            coOwned: state.parcels.filter(parcel => parcel.owners.length > 1).map(parcel => ({
                parcelId: parcel.parcelId, areaM2: parcel.areaM2, counts: tally.acceptedParcelIds.includes(parcel.parcelId),
                owners: parcel.owners.map(owner => ({ ownerId: owner.ownerId, share: owner.share, accepted: yes.has(owner.ownerId) }))
            }))
        };
    }

    // A readjustment's allocation for this owner, from its own ledger row and output plots. An owner
    // with no ledger row has nothing assigned in this plan; that is shown, never guessed.
    function readjustmentReceipt(proposal, ownerId, turf) {
        const plan = proposal.reparcellization || {};
        const row = (plan.ownerShares || []).find(owner => String(owner?.ownerKey || '').trim() === ownerId) || null;
        const impact = allocation().ownerImpact({ ...(row || {}), ownerKey: ownerId, contributedArea: row?.contributedArea ?? null },
            plan.polygons || [], turf);
        return {
            inLedger: !!row,
            plots: impact.plots.map(plot => ({
                ...plot,
                coRecipientIds: (plan.polygons[plot.index].owners || []).map(owner => String(owner.ownerKey || '').trim())
                    .filter(key => key && key !== ownerId)
            })),
            assignedAreaM2: impact.assignedAreaM2,
            contributedAreaM2: impact.contributedAreaM2,
            areaChangeM2: impact.areaChangeM2,
            cashCents: impact.cashOfferCents,
            payCents: impact.cashPaymentCents
        };
    }

    function conditions(proposal) {
        const context = approval().contextContent(proposal);
        let totalCashCents = null;
        let money = null;
        if (deal().isReadjustment(proposal)) {
            try {
                const content = deal().content(proposal);
                totalCashCents = content.terms.totalCashCents;
                money = deal().schedule(content);
            } catch (_) { totalCashCents = null; money = null; }
        }
        const expires = proposal.expiresAt == null ? null : new Date(proposal.expiresAt);
        const offer = Number(proposal.offer);
        return {
            policy: context.policy,
            regime: context.regime || null,
            lens: context.lens,
            rightsSource: context.rights?.source || null,
            isConditional: proposal.isConditional === true,
            expiresAt: expires && Number.isFinite(expires.getTime()) ? expires.toISOString() : null,
            totalCashCents,
            // The balanced schedule (reparcellization-deal.js schedule): owners' nets and the sponsor.
            money,
            cashOffered: totalCashCents == null ? Number.isFinite(offer) && offer > 0 : totalCashCents > 0,
            // An absent funding flag is not funding (reparcellization-validation.js says the same).
            fundingConfirmed: proposal.funded === true,
            depositPercent: proposal.depositEnabled === true && Number.isFinite(proposal.depositPercent) ? proposal.depositPercent : null
        };
    }

    /**
     * @param {object} proposal
     * @param {string} ownerId abstract party from the proposal's rights snapshot or rules: an owner,
     *   a leaseholder or a required authority
     * @param {{ acceptedOwnerIds?: string[], turf?: object }} options turf measures readjustment plots
     */
    function ownerReview(proposal, ownerId, { acceptedOwnerIds = [], turf = null } = {}) {
        const state = approval().inspect(proposal);
        if (!state.ready || !state.partyIds.includes(ownerId)) return null;
        const kind = approval().partyOf(ownerId, state).kind;
        const contributes = state.parcels.filter(parcel => parcel.owners.some(owner => owner.ownerId === ownerId)).map(parcel => {
            const share = parcel.owners.find(owner => owner.ownerId === ownerId).share;
            return {
                parcelId: parcel.parcelId, share, parcelAreaM2: parcel.areaM2,
                shareAreaM2: parcel.areaM2 == null ? null : parcel.areaM2 * shareValue(share),
                coOwnerIds: parcel.owners.map(owner => owner.ownerId).filter(id => id !== ownerId)
            };
        });
        // Leases this party holds. The plan's ledger reallocates ownership; a lease's holders approve
        // under the rules but get no plot from the ledger, which the review says plainly.
        const leases = state.parcels.flatMap(parcel => (parcel.leases || [])
            .filter(lease => lease.holders.some(holder => holder.ownerId === ownerId)).map(lease => {
                const share = lease.holders.find(holder => holder.ownerId === ownerId).share;
                const leaseAreaM2 = lease.areaM2 ?? parcel.areaM2;
                return {
                    parcelId: parcel.parcelId, leaseId: lease.leaseId, share, leaseAreaM2,
                    shareAreaM2: leaseAreaM2 == null ? null : leaseAreaM2 * shareValue(share),
                    coHolderIds: lease.holders.map(holder => holder.ownerId).filter(id => id !== ownerId)
                };
            }));
        const knownAreas = contributes.every(row => row.shareAreaM2 != null);
        const accepted = acceptedOwnerIds.filter(id => id !== ownerId);
        return {
            ownerId,
            kind,
            ownerIds: state.ownerIds,
            contributes,
            leases,
            contributedAreaM2: knownAreas ? contributes.reduce((sum, row) => sum + row.shareAreaM2, 0) : null,
            receives: kind === 'owner' && deal().isReadjustment(proposal) && turf ? readjustmentReceipt(proposal, ownerId, turf) : null,
            conditions: conditions(proposal),
            alreadyAccepted: acceptedOwnerIds.includes(ownerId),
            progressWithout: progress(proposal, accepted),
            progressWith: progress(proposal, [...accepted, ownerId])
        };
    }

    return { progress, ownerReview, conditions };
});
