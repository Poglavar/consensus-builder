// What saving an edit of a record does to it: one's own local, unpublished record is edited in
// place; a published design (`published.cid`, proposals/design-sync.js) or a minted record is
// immutable, so the edit forks a new record that records where it came from (proposalOrigin, and
// origin.cid for a published source). Published lineage is that CID link (the details panel's
// "Forked from"); there is no lineage route or list of forks (plan-design-agreement.md,
// simplification 8).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.ProposalLineage = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const cidApi = () => root?.Cid || (typeof require === 'function' ? require('../cid.js') : null);

    // A published design or explicit mint evidence makes the record immutable. Generic hashes and
    // lifecycle labels do not establish publication.
    function isPublished(proposal) {
        if (!proposal || typeof proposal !== 'object') return false;
        try {
            if (typeof root?.isProposalImmutable === 'function' && root.isProposalImmutable(proposal)) return true;
            if (typeof root?.isProposalMinted === 'function' && root.isProposalMinted(proposal)) return true;
        } catch (_) { }
        const explicitValue = value => value !== undefined && value !== null && String(value).trim() !== '';
        return !!(proposal.published && cidApi()?.isCid(proposal.published.cid))
            || !!proposal.onchain?.transactionHash
            || !!proposal.onchainData
            || proposal.isMinted === true
            || explicitValue(proposal.tokenId)
            || explicitValue(proposal.chainProposalId);
    }

    // What saving an edit of `source` does. One's own local, unpublished record is edited in place:
    // same id, no new record. A published or minted record is immutable, so an edit forks a
    // counterproposal that records its proposalOrigin and leaves the source standing.
    // `fork: true` is the explicit Fork action, which always makes a new record.
    function editsInPlace(source, options = {}) {
        return !!source && typeof source === 'object' && options.fork !== true && !isPublished(source);
    }

    // The fields an in-place save keeps from the record it rewrites: its identity, its place in the
    // replay order (createdAt, plan-order.js) and its own lineage. A fork of a published proposal
    // stays that proposal's counterproposal however often it is edited. The defaulted fields come
    // from the record only where the edit says nothing: a design edit leaves the record's authoring
    // agent and lifecycle as they were.
    const KEPT_IDENTITY_KEYS = ['proposalId', 'createdAt'];
    const KEPT_LINEAGE_KEYS = ['proposalOrigin', 'landFork', 'proposalDraftId', 'proposalDraftRevision'];
    const DEFAULTED_KEYS = ['authorAgentId', 'lifecycleStatus'];
    const copyOf = value => JSON.parse(JSON.stringify(value));

    // The edited content (an editor's built proposal) with the identity of the record it rewrites.
    function inPlaceRecord(source, edited) {
        const out = copyOf(edited || {});
        [...KEPT_IDENTITY_KEYS, ...KEPT_LINEAGE_KEYS].forEach(key => {
            if (source && source[key] !== undefined && source[key] !== null) out[key] = copyOf(source[key]);
            else delete out[key];
        });
        DEFAULTED_KEYS.forEach(key => {
            if (out[key] === undefined && source && source[key] !== undefined && source[key] !== null) out[key] = copyOf(source[key]);
        });
        if (out.roadProposal && typeof out.roadProposal === 'object') {
            out.roadProposal.id = out.proposalId;
            out.roadProposal.proposalId = out.proposalId;
        }
        return out;
    }

    const t = (key, fallback, params) => {
        const helper = typeof root.getProposalI18nHelper === 'function' ? root.getProposalI18nHelper() : null;
        return helper ? helper(key, fallback, params || {}) : fallback;
    };

    // What saving an edit does, said on its button (editsInPlace above draws the line). A published
    // source gets a counterproposal; one's own local record is saved in place; an explicit Fork of a
    // local record is a new proposal beside it.
    function forkSubmitLabel(sourceId, options = {}) {
        const source = typeof root.getProposalByIdOrHash === 'function' && sourceId ? root.getProposalByIdOrHash(sourceId) : null;
        if (isPublished(source)) return t('proposalDrafts.actions.createCounterproposal', 'Create counterproposal');
        return editsInPlace(source, options)
            ? t('proposalDrafts.actions.saveChanges', 'Save changes')
            : t('proposalDrafts.actions.createProposal', 'Create proposal');
    }

    // The publication test is read as a global by the classic scripts (editor shell, sharing, copy).
    if (root && typeof root.document !== 'undefined') root.isPublishedProposalRecord = isPublished;

    return { isPublished, editsInPlace, inPlaceRecord, forkSubmitLabel };
});
