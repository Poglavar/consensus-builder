// proposals/display-state.js — the ONE derivation of what a proposal's badges and map action show:
// its rung on the lifecycle ladder (docs/design-language.md: Draft → Published → Minted → Executed),
// the lifecycle modifier, whether "Applied" is shown, and whether Apply or Unapply is offered. The
// details panel, the proposals list (and every list that reuses its ladder) and the agent dialog all
// read it, so one proposal never reads one way in the panel and another in a list.
//
// Rules (lifecycle = the record's canonical lifecycleStatus, proposals/status.js):
//   - Minted means a mint record exists: the isMinted flag, an on-chain transaction, or an NFT/on-chain
//     token id under a contract. A numeric id is a server serial (Published), never a mint record.
//     The mint is a fact about the chain, so a cancelled proposal that was minted stays Minted and
//     carries the Cancelled modifier (the market resolves NO by reading that same NFT account).
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

    // Lifecycle keys (proposals/lifecycle.js getProposalLifecycleKey) that add a modifier badge to the
    // rung, with the badge tone each uses.
    const MODIFIER_TONES = Object.freeze({
        cancelled: 'cb-badge--expired',
        expired: 'cb-badge--expired',
        'vote-open': 'cb-badge--published',
        'vote-concluded': 'cb-badge--expired',
        'awaiting-funding': 'cb-badge--published'
    });

    const RUNG_LABELS = Object.freeze({
        executed: ['panel.proposal.lifecycle.executed', 'Executed'],
        minted: ['panel.proposal.lifecycle.minted', 'Minted'],
        published: ['common.lifecycle.published', 'Published'],
        draft: ['common.lifecycle.draft', 'Draft']
    });

    function present(value) {
        return value !== undefined && value !== null && String(value).trim() !== '';
    }

    // A mint record, as every mint path writes one (blockchain-sync.js, solana/blockchain-sync.js,
    // the agent record builder): the flag, the transaction, or a token id under a contract.
    function hasMintRecord(proposal) {
        if (!proposal || typeof proposal !== 'object') return false;
        if (proposal.isMinted === true) return true;
        const onchain = proposal.onchain || {};
        const nft = proposal.nft || {};
        if (present(onchain.transactionHash)) return true;
        const contract = nft.contract ?? onchain.contractAddress ?? proposal.contractAddress;
        const tokenId = nft.tokenId ?? onchain.proposalId;
        return present(contract) && present(tokenId);
    }

    // Whether the proposal may stand on a map at all. Only a withdrawn (Cancelled) proposal may not.
    function isApplicable(proposal) {
        return lifecycleOf(proposal) !== 'Cancelled';
    }

    // inputs: { applied, lifecycleKey, serial } — this browser's applied flag, the lifecycle key
    // (vote / expiry / funding aware) and the server serial. Each defaults to the browser global that
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
            : (root && typeof root.getSerialProposalId === 'function' ? root.getSerialProposalId(proposal) : null);

        const minted = hasMintRecord(proposal);
        const applicable = lifecycle !== 'Cancelled';
        const rung = lifecycle === 'Executed' ? 'executed'
            : minted ? 'minted'
                : serial ? 'published' : 'draft';
        const modifier = Object.prototype.hasOwnProperty.call(MODIFIER_TONES, lifecycleKey) ? lifecycleKey : null;
        return {
            lifecycle,
            rung,
            minted,
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

    return Object.freeze({ of, hasMintRecord, isApplicable, rungLabel, MODIFIER_TONES });
});
