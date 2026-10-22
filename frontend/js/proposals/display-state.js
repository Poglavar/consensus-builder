// proposals/display-state.js — the ONE derivation of what a proposal's badges and map action show:
// its display rung (docs/design-language.md: Draft, Published or Execution recorded),
// the lifecycle modifier, whether "Applied" is shown, and whether Apply or Unapply is offered. The
// details panel, the proposals list (and every list that reuses its ladder) and the agent dialog all
// read it, so one proposal never reads one way in the panel and another in a list.
//
// Rules (lifecycle = the record's canonical lifecycleStatus, proposals/status.js):
//   - A published design (its CID, DesignSync.publishedCid) is Published; a local key alone says
//     nothing about publication. Designs are not minted: an agreement is, and its chain status is
//     its account's (plan-design-agreement.md, M3).
//   - A Cancelled proposal is withdrawn: it cannot stand on a map, so it shows no "Applied" and is
//     offered neither Apply nor Unapply, whatever this browser's applied flag says.
//
// Pure (no DOM, no storage): the browser loads it as a classic script after status.js and reads it
// as window.__proposalDisplayState; node tests require it.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__proposalDisplayState = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const lifecycleOf = (root && typeof root.getLifecycleStatus === 'function')
        ? root.getLifecycleStatus
        : require('./status.js').getLifecycleStatus;
    const lifecycleEvidence = (root && root.ProposalLifecycleEvidence)
        || require('./lifecycle-evidence.js');

    // Lifecycle keys (proposals/lifecycle.js getProposalLifecycleKey) that add a modifier badge to the
    // rung, with the badge tone each uses.
    const MODIFIER_TONES = Object.freeze({
        unknown: 'cb-badge--expired',
        cancelled: 'cb-badge--expired',
        expired: 'cb-badge--expired',
        'awaiting-funding': 'cb-badge--published'
    });

    const RUNG_LABELS = Object.freeze({
        executed: ['panel.proposal.lifecycle.executed', 'Execution recorded'],
        'execution-unverified': ['panel.proposal.lifecycle.executionUnverified', 'Execution reported; verification unavailable'],
        published: ['common.lifecycle.published', 'Published'],
        draft: ['common.lifecycle.draft', 'Draft']
    });

    // Whether the proposal may stand on a map at all. Only a withdrawn (Cancelled) proposal may not.
    function isApplicable(proposal) {
        return lifecycleOf(proposal) !== 'Cancelled';
    }

    // inputs: { applied, lifecycleKey, serial } — this browser's applied flag, the lifecycle key
    // (funding aware) and the published CID. Each defaults to the browser global that
    // owns it, so callers in the app pass only what they already hold.
    function of(proposal, inputs = {}) {
        const lifecycle = lifecycleOf(proposal);
        const appliedOnMap = typeof inputs.applied === 'boolean'
            ? inputs.applied
            : (root && typeof root.isProposalApplied === 'function'
                ? !!root.isProposalApplied(proposal)
                : proposal?.applied === true);
        const lifecycleKey = inputs.lifecycleKey !== undefined
            ? inputs.lifecycleKey
            : (root && typeof root.getProposalLifecycleKey === 'function'
                ? root.getProposalLifecycleKey(proposal)
                : lifecycle.toLowerCase());
        const serial = inputs.serial !== undefined
            ? inputs.serial
            : (root && root.DesignSync ? root.DesignSync.publishedCid(proposal) : null);

        const applicable = lifecycle !== 'Cancelled';
        const executionObserved = lifecycleEvidence.hasObservedStatus(proposal, 'Executed');
        const rung = lifecycle === 'Executed' ? (executionObserved ? 'executed' : 'execution-unverified')
            : serial ? 'published' : 'draft';
        const modifier = Object.prototype.hasOwnProperty.call(MODIFIER_TONES, lifecycleKey) ? lifecycleKey : null;
        return {
            lifecycle,
            rung,
            published: !!serial,
            applied: applicable && appliedOnMap,
            mapAction: applicable ? (appliedOnMap ? 'unapply' : 'apply') : null,
            modifier,
            modifierTone: modifier ? MODIFIER_TONES[modifier] : null
        };
    }

    function rungLabel(rung, translate) {
        const [key, fallback] = RUNG_LABELS[rung] || RUNG_LABELS.draft;
        return typeof translate === 'function' ? translate(key, fallback) : fallback;
    }

    // The lifecycle field has no uniform durable proof of execution: it does not establish verified
    // payment, title registration or physical realization.
    function rungHint(rung, translate) {
        const label = rung === 'executed' || rung === 'execution-unverified'
            ? ['panel.proposal.lifecycle.executedHint', 'This record reports execution. The status alone does not verify payment, legal registration or physical construction.']
            : null;
        return label ? (typeof translate === 'function' ? translate(...label) : label[1]) : '';
    }

    return Object.freeze({ of, isApplicable, rungLabel, rungHint, MODIFIER_TONES });
});
