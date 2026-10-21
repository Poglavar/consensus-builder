// Warns on leaving the app if there is applied local work that has NOT been published or minted, so
// a localStorage wipe cannot silently lose it. The browser shows its own generic "leave site?" prompt
// (the text cannot be customized); we only arm it when there is genuinely unsaved local work, so a
// clean session leaves without a prompt. This is the "exit gate" companion to the share panel, whose
// link names only published designs.
(function (global) {
    'use strict';

    // Applied on the map, and neither published nor minted — i.e. it lives only in this browser's
    // storage. "Published" means the design still hashes to the CID it was published as at this
    // index (DesignSync.publishedCid), so an edit of a published design, which derives a new
    // design, counts as unsaved until it is published or minted in turn.
    function isUnsavedLocalWork(proposal) {
        if (!proposal) return false;
        if (typeof isProposalCurrentlyApplied === 'function' && !isProposalCurrentlyApplied(proposal)) return false;
        if (global.DesignSync.publishedCid(proposal)) return false;
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
        // preventDefault() + a NON-EMPTY returnValue is what reliably arms the native prompt across
        // browsers (an empty string does not trigger it in some). The text itself is ignored.
        event.preventDefault();
        event.returnValue = 'You have local proposals that are not uploaded or minted.';
    });

    // Exposed so a future in-app "you have N un-uploaded proposals" banner can reuse the same check.
    global.hasUnsavedLocalWork = hasUnsavedLocalWork;
})(typeof window !== 'undefined' ? window : globalThis);
