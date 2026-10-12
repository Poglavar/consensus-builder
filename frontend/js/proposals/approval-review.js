// What one abstract owner is asked to accept: the land they contribute, what a land readjustment
// gives them back, their cash, the conditions, and how far the proposal is from passing before and
// after their acceptance. Pure (no DOM); proposals/approval-panel.js renders it.
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

    // The smallest owner count that meets a rule, exactly (shares of a headcount are integers).
    function ownersNeeded(total, policy) {
        if (policy.type === 'unanimous') return total;
        const rule = policy.owners;
        const product = BigInt(total) * BigInt(rule.numerator), den = BigInt(rule.denominator);
        return Number(rule.strict ? product / den + 1n : (product + den - 1n) / den);
    }

    // The tally an electorate would show with exactly these owners accepted, and what is missing.
    function progress(proposal, acceptedOwnerIds = []) {
        const A = approval();
        const state = A.inspect(proposal);
        const tally = A.tally(proposal, acceptedOwnerIds);
        const policy = state.context.policy;
        if (!state.ready) return { ready: false, reason: state.reason, policy, passed: false };
        const yes = new Set(acceptedOwnerIds.filter(id => state.ownerIds.includes(id)));
        const parcelsOf = id => state.parcels.filter(parcel => parcel.owners.some(owner => owner.ownerId === id)).map(parcel => parcel.parcelId);
        return {
            ready: true, reason: null, policy,
            totalOwners: tally.totalOwners, acceptedOwners: tally.acceptedOwners,
            ownersNeeded: ownersNeeded(tally.totalOwners, policy),
            totalAreaM2: tally.totalAreaM2, acceptedAreaM2: tally.acceptedAreaM2,
            areaNeededM2: tally.totalAreaM2 == null ? null
                : policy.type === 'unanimous' ? tally.totalAreaM2 : tally.totalAreaM2 * policy.area.numerator / policy.area.denominator,
            areaStrict: policy.type === 'threshold' && policy.area.strict,
            ownerThresholdMet: tally.ownerThresholdMet, areaThresholdMet: tally.areaThresholdMet, passed: tally.passed,
            acceptedParcelIds: tally.acceptedParcelIds,
            outstanding: state.ownerIds.filter(id => !yes.has(id)).map(ownerId => ({ ownerId, parcelIds: parcelsOf(ownerId) })),
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
     * @param {string} ownerId abstract owner from the proposal's rights snapshot
     * @param {{ acceptedOwnerIds?: string[], turf?: object }} options turf measures readjustment plots
     */
    function ownerReview(proposal, ownerId, { acceptedOwnerIds = [], turf = null } = {}) {
        const state = approval().inspect(proposal);
        if (!state.ready || !state.ownerIds.includes(ownerId)) return null;
        const contributes = state.parcels.filter(parcel => parcel.owners.some(owner => owner.ownerId === ownerId)).map(parcel => {
            const share = parcel.owners.find(owner => owner.ownerId === ownerId).share;
            return {
                parcelId: parcel.parcelId, share, parcelAreaM2: parcel.areaM2,
                shareAreaM2: parcel.areaM2 == null ? null : parcel.areaM2 * shareValue(share),
                coOwnerIds: parcel.owners.map(owner => owner.ownerId).filter(id => id !== ownerId)
            };
        });
        const knownAreas = contributes.every(row => row.shareAreaM2 != null);
        const accepted = acceptedOwnerIds.filter(id => id !== ownerId);
        return {
            ownerId,
            ownerIds: state.ownerIds,
            contributes,
            contributedAreaM2: knownAreas ? contributes.reduce((sum, row) => sum + row.shareAreaM2, 0) : null,
            receives: deal().isReadjustment(proposal) && turf ? readjustmentReceipt(proposal, ownerId, turf) : null,
            conditions: conditions(proposal),
            alreadyAccepted: acceptedOwnerIds.includes(ownerId),
            progressWithout: progress(proposal, accepted),
            progressWith: progress(proposal, [...accepted, ownerId])
        };
    }

    return { ownersNeeded, progress, ownerReview, conditions };
});
