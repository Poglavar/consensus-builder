// Routes the proposal panel's betting action to its pool or explains the missing prerequisite.
(function attachProposalBetEntry(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalBetEntry = api;
})(typeof window !== 'undefined' ? window : globalThis, function proposalBetEntryFactory(root) {
    'use strict';

    function availability({ nftInfo = null, approvalSetup = false, proposal = {} } = {}) {
        if (approvalSetup) return 'approval';
        if (proposal.supersededBy || ['executed', 'cancelled', 'expired', 'superseded'].includes(String(proposal.lifecycleStatus || proposal.status || '').toLowerCase())) return 'closed';
        if (!nftInfo?.tokenId) return 'mint';
        const chain = String(nftInfo.chain || nftInfo.chainId || '');
        return chain.startsWith('solana') ? 'pool' : 'chain';
    }

    function open({ proposal, nftInfo, approvalSetup, onMint }) {
        const route = availability({ proposal, nftInfo, approvalSetup });
        if (route === 'pool') {
            return root.BetsDialog.open({ proposalAccount: String(nftInfo.tokenId),
                proposalId: proposal.proposalId, title: proposal.title || proposal.name || '',
                lifecycleStatus: proposal.lifecycleStatus || 'Active' });
        }
        const t = (key, fallback) => {
            const value = root.i18n?.t?.(key);
            return value && value !== key ? value : fallback;
        };
        const body = root.document.createElement('div');
        const append = (tag, key, fallback, parent = body) => {
            const node = root.document.createElement(tag);
            node.textContent = t(key, fallback);
            parent.appendChild(node);
            return node;
        };
        const actions = [];
        if (route === 'mint') {
            append('p', 'panel.proposal.bet.mintFirst', 'This proposal needs to be minted on Solana before anyone can bet on its outcome.');
            const steps = body.appendChild(root.document.createElement('ol'));
            append('li', 'panel.proposal.bet.connect', 'Connect your Solana wallet before minting this proposal.', steps);
            append('li', 'panel.proposal.bet.mint', 'Open Share and choose Mint. Follow the wallet prompts and any parcel prerequisites.', steps);
            append('li', 'panel.proposal.bet.return', 'Return to this proposal and choose Bet on outcome. Open the pool if needed, then choose Yes or No and enter your stake.', steps);
            actions.push({ id: 'mint', label: t('panel.proposal.bet.openMint', 'Open minting options'), role: 'primary', onClick: onMint });
        } else if (route === 'approval') {
            append('p', 'panel.proposal.bet.approval', 'Betting is not available for proposals with ownership and approval rules yet. Those decisions do not settle a betting pool.');
        } else if (route === 'closed') {
            append('p', 'ownerAudit.betClosed', 'This proposal is settled, closed or superseded. New bets are unavailable; view existing positions in Bets.');
        } else {
            append('p', 'panel.proposal.bet.chain', 'Betting is currently available only for proposals minted on Solana. This proposal was minted on another chain.');
        }
        actions.push({ id: 'close', label: t('common.close', 'Close'), role: 'secondary' });
        return root.CbDialog.open({ title: t('panel.proposal.actions.betOutcome', 'Bet on outcome'),
            className: 'proposal-bet-help', size: 'md', body, actions });
    }

    function presentation(options, translate) {
        const route = availability(options);
        const key = route === 'approval' ? 'panel.proposal.bet.approval' : route === 'closed' ? 'ownerAudit.betClosed' : route === 'mint' ? 'panel.proposal.bet.mintFirst' : route === 'chain' ? 'panel.proposal.bet.chain' : null;
        const fallback = route === 'approval' ? 'Betting is unavailable for this proposal’s ownership and approval rules.'
            : route === 'closed' ? 'New bets are unavailable on closed or superseded proposals.'
            : route === 'mint' ? 'Mint on Solana before betting.' : 'Betting requires a Solana proposal.';
        return { route, disabled: ['approval', 'closed', 'chain'].includes(route), hint: key ? translate(key, fallback) : '' };
    }
    return { availability, presentation, open };
});
