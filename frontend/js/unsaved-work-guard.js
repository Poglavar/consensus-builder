// Warns on leaving the app if there is applied local work that has NOT been uploaded or minted, so a
// localStorage wipe cannot silently lose it. The browser shows its own generic "leave site?" prompt
// (the text cannot be customized); we only arm it when there is genuinely unsaved local work, so a
// clean session leaves without a prompt. This is the "exit gate" companion to the share gate, which
// already blocks including un-uploaded proposals in a share link.
(function (global) {
    'use strict';

    // Applied on the map, and neither uploaded (has a server id) nor minted (on-chain) — i.e. it lives
    // only in this browser's storage. A minted/uploaded road that was edited counts here too: editing
    // detaches its published pointers (see runLocalCorridorGeometryUpdate), so the fork is unsaved
    // until re-uploaded/minted.
    function isUnsavedLocalWork(proposal) {
        if (!proposal) return false;
        if (typeof isProposalCurrentlyApplied === 'function' && !isProposalCurrentlyApplied(proposal)) return false;
        const serverId = (typeof getServerProposalId === 'function') ? getServerProposalId(proposal) : proposal.serverProposalId;
        if (serverId) return false;
        if (typeof isProposalMinted === 'function' && isProposalMinted(proposal)) return false;
        return true;
    }

    function hasUnsavedLocalWork() {
        try {
            const all = (typeof proposalStorage !== 'undefined' && proposalStorage
                && typeof proposalStorage.getAllProposals === 'function') ? proposalStorage.getAllProposals() : [];
            return all.some(isUnsavedLocalWork);
        } catch (_) {
            return false;
        }
    }

    global.addEventListener('beforeunload', function (event) {
        if (!hasUnsavedLocalWork()) return;
        // Setting returnValue is what actually arms the native prompt in current browsers.
        event.preventDefault();
        event.returnValue = '';
    });

    // Exposed so a future in-app "you have N un-uploaded proposals" banner can reuse the same check.
    global.hasUnsavedLocalWork = hasUnsavedLocalWork;
})(typeof window !== 'undefined' ? window : globalThis);
