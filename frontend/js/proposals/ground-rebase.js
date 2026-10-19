// A stored proposal whose parcels no longer fit the cadastre in view: the register was updated, or
// a stand-in source is answering while the usual one is down. Proposals are geometry and their
// parcels are derived from it (decision 2026-10-17). So apply re-derives instead of giving up:
//   - a local draft nobody else has seen takes the parcels its geometry covers today, quietly, and
//     applies;
//   - a published or minted record is never changed. Apply refuses with an error, and the error
//     offers "New proposal with same geometry": a fork whose parcels come from its geometry on the
//     ground in view, approvals starting over. Nothing stops a fork onto stand-in ground; it can be
//     forked again once the usual source is back.
// Records drawn on an authored site keep their own site rule and are not re-based here.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalGroundRebase = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    // Apply failures that mean "the stored parcels and the geometry disagree on this ground".
    // Ground that cannot be loaded at all ('cadastral-ground-unavailable') is not one: there is
    // nothing to re-derive from.
    const GROUND_CHANGED_CODES = Object.freeze(new Set([
        'proposal-footprint-outside-cadastre',
        'cadastral-ground-absent',
        'formation-cadastre-unresolved',
        'formation-ground-unresolved',
        'formation-ground-incomplete',
        'building-no-parcels',
        'building-uncovered-ground'
    ]));

    function hasAuthoredSite(proposal) {
        return !!(proposal && proposal.site);
    }

    // What apply does after `failure` for `proposal`: 'rederive' (local draft), 'fork' (published
    // record: offer a new proposal) or null (not a ground change, or a site-drawn record).
    function rebaseRoute(proposal, failure, published) {
        if (!proposal || !failure || !GROUND_CHANGED_CODES.has(String(failure.code || ''))) return null;
        if (hasAuthoredSite(proposal)) return null;
        return published ? 'fork' : 'rederive';
    }

    function sameIds(a, b) {
        const left = Array.from(new Set((a || []).map(String))).sort();
        const right = Array.from(new Set((b || []).map(String))).sort();
        return left.length === right.length && left.every((id, i) => id === right[i]);
    }

    // deps: { currentIds(proposal) → Promise<ids>, setDraftIds(id, ids) → bool, apply(id) → Promise<bool> }.
    // Re-derives a local draft's parcels and applies it once more. 'unchanged' when its geometry
    // takes the same parcels as before (the failure was not the ground), 'empty' when it takes none.
    async function rederiveAndApply(proposal, deps) {
        const id = String(proposal.proposalId);
        const ids = await deps.currentIds(proposal);
        if (!ids.length) return { outcome: 'empty', ids };
        if (sameIds(ids, proposal.cadastreParcelIds)) return { outcome: 'unchanged', ids };
        if (!deps.setDraftIds(id, ids)) return { outcome: 'refused', ids };
        const applied = await deps.apply(id);
        return { outcome: applied === false ? 'failed' : 'applied', ids };
    }

    // deps: { currentIds, store (proposalDraftStore), stage(draftId) → Promise }. Opens the create
    // dialog for a fork of `proposal` with the parcels its geometry takes on the ground in view.
    async function forkOntoCurrentGround(proposal, deps) {
        const ids = await deps.currentIds(proposal);
        if (!ids.length) throw new Error(t('proposalGroundRebase.noParcels', 'This geometry covers no parcels on the ground in view.'));
        const draft = deps.store.createDraftFromProposal(proposal, { activate: true, forceNew: true });
        if (!draft) throw new Error('The proposal could not be copied into a draft.');
        deps.store.updateDraft(draft.id, { fields: { selectedParcelIds: ids, cadastreParcelIds: ids } });
        return deps.stage(draft.id);
    }

    function t(key, fallback, params) {
        const translated = root && root.i18n && typeof root.i18n.t === 'function' ? root.i18n.t(key, params) : null;
        const text = translated && translated !== key ? translated : fallback;
        return String(text).replace(/\{\{(\w+)\}\}/g, (_, name) => String((params || {})[name] ?? ''));
    }

    // The browser's own collaborators, resolved when used (they load after this file).
    function browserDeps() {
        return {
            currentIds: proposal => root.__cadastreAncestry.currentCadastreParcelIds(proposal),
            setDraftIds: (id, ids) => root.proposalStorage
                ? root.proposalStorage.setDraftCadastreParcelIds(id, ids)
                : (typeof proposalStorage !== 'undefined' && proposalStorage.setDraftCadastreParcelIds(id, ids)),
            apply: id => root.ProposalManager.applyProposal(id),
            store: root.proposalDraftStore,
            stage: draftId => root.stageProposalDraftForPublishing(draftId)
        };
    }

    // The "New proposal with same geometry" button under an apply error (details panel footer).
    function offerButtonHtml(proposalId, escape) {
        const label = t('proposalGroundRebase.fork', 'New proposal with same geometry');
        const hint = t('proposalGroundRebase.forkHint', 'Copy this proposal with the parcels its geometry covers on the ground shown now. The published proposal stays unchanged.');
        return `<button type="button" class="btn btn-ground-rebase" data-ground-rebase="${escape(proposalId)}" title="${escape(hint)}">`
            + `<i class="fas fa-code-branch" aria-hidden="true"></i> ${escape(label)}</button>`;
    }

    // The apply error under a proposal's actions (details panel footer), with the fork button when
    // the ground changed under a published record. `escape` is the caller's HTML escaper.
    function failureNoticeHtml(proposalId, message, offerFork, escape) {
        return `<div class="proposal-editor-approval-error proposal-map-action-error" data-proposal-map-action-error="${escape(proposalId)}" role="alert">`
            + `${escape(message)}${offerFork ? offerButtonHtml(proposalId, escape) : ''}</div>`;
    }

    async function forkFromButton(proposalId) {
        const storage = root.proposalStorage || (typeof proposalStorage !== 'undefined' ? proposalStorage : null);
        const proposal = storage && storage.getProposal(proposalId);
        if (!proposal) return null;
        try {
            if (typeof root.hideProposalDetailsPanel === 'function') root.hideProposalDetailsPanel();
            if (typeof root.closeProposalEditorShell === 'function') root.closeProposalEditorShell();
            return await forkOntoCurrentGround(proposal, browserDeps());
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [ground-rebase] fork of ${proposalId} failed`, error);
            const message = t('proposalGroundRebase.forkFailed', 'Could not start the new proposal: {{reason}}', { reason: error && error.message || String(error) });
            if (typeof root.showEphemeralMessage === 'function') root.showEphemeralMessage(message, 8000, 'error');
            return null;
        }
    }

    if (root && root.document && typeof root.document.addEventListener === 'function') {
        root.document.addEventListener('click', event => {
            const button = event.target && event.target.closest ? event.target.closest('[data-ground-rebase]') : null;
            if (!button) return;
            event.preventDefault();
            forkFromButton(button.dataset.groundRebase);
        });
    }

    return Object.freeze({ GROUND_CHANGED_CODES, rebaseRoute, sameIds, rederiveAndApply, forkOntoCurrentGround, browserDeps, offerButtonHtml, failureNoticeHtml, forkFromButton, t });
});
