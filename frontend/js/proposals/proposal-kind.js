// The proposal kind: who decides a published proposal and whether it binds (proposal-kinds.md).
// Pure: no DOM, no network. The kind is publish metadata only; any design can have any kind.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalKind = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const OWNER_DEAL = 'owner-deal';
    const OWNER_VOTE = 'owner-vote';
    const COMMUNITY_VOTE = 'community-vote';
    const KINDS = Object.freeze([OWNER_DEAL, OWNER_VOTE, COMMUNITY_VOTE]);
    // Preselected in the publish step: the least-committal kind (decision 7).
    const DEFAULT_PUBLISH_KIND = COMMUNITY_VOTE;

    /**
     * The kind of a record. A record without one is an owner deal: every record published before
     * kinds existed went through the binding path. An unknown value is no kind at all (null), so
     * no kind-specific behaviour applies; validation refuses it at publish.
     */
    function kindOf(record) {
        if (!record || typeof record !== 'object') return null;
        if (record.kind === undefined || record.kind === null) return OWNER_DEAL;
        return KINDS.includes(record.kind) ? record.kind : null;
    }

    const isOwnerVote = record => kindOf(record) === OWNER_VOTE;
    const isCommunityVote = record => kindOf(record) === COMMUNITY_VOTE;
    // Both votes never execute, transfer or hold money.
    const isNonBinding = record => isOwnerVote(record) || isCommunityVote(record);

    // The owner offers their own parcels: today's sale offer and the attested owner offer.
    function isOwnerSaleOffer(record) {
        if (!record || typeof record !== 'object') return false;
        return record.goal === 'ownership-transfer-from-me'
            || record.proposalRole === 'owner-offer'
            || record.ownershipTransferProposal?.direction === 'from-me';
    }

    const positive = value => typeof value === 'number' ? value > 0 : Number(value) > 0;

    /** What is wrong with a record's kind and its terms, as [{ code, message }]; empty when fine. */
    function kindErrors(record) {
        const errors = [];
        if (!record || typeof record !== 'object') return [{ code: 'no-record', message: 'No proposal record.' }];
        if (record.kind !== undefined && record.kind !== null && !KINDS.includes(record.kind)) {
            errors.push({ code: 'unknown-kind', message: `Unknown proposal kind "${record.kind}".` });
            return errors;
        }
        if (isNonBinding(record)) {
            if (positive(record.offer)) errors.push({ code: 'vote-has-offer', message: 'A vote carries no offer.' });
            if (positive(record.budget)) errors.push({ code: 'vote-has-budget', message: 'A vote carries no budget.' });
            if (record.depositEnabled === true) errors.push({ code: 'vote-has-deposit', message: 'A vote carries no deposit.' });
            if (isOwnerSaleOffer(record)) {
                errors.push({ code: 'sale-offer-is-owner-deal', message: 'An owner\'s sale offer is an owner deal.' });
            }
        }
        return errors;
    }

    return Object.freeze({
        KINDS,
        OWNER_DEAL,
        OWNER_VOTE,
        COMMUNITY_VOTE,
        DEFAULT_PUBLISH_KIND,
        kindOf,
        isOwnerVote,
        isCommunityVote,
        isNonBinding,
        isOwnerSaleOffer,
        kindErrors
    });
});
