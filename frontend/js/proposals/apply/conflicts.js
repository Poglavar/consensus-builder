// Shared sequencing for conflicts that must leave the map before a replacement can be applied.
// Map/storage mutations are intentionally serial: applying the replacement while an async unapply
// is still running can let the old completion remove state the replacement just wrote.
(function attachProposalApplyConflicts(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyConflicts = api;
})(typeof window !== 'undefined' ? window : globalThis, function proposalApplyConflictsFactory() {
    'use strict';

    async function unapplyConflictsSequentially(manager, proposals, options = {}) {
        const conflicts = Array.isArray(proposals) ? proposals : [];
        for (const proposal of conflicts) {
            if (!proposal || proposal.proposalId === undefined || proposal.proposalId === null) continue;
            let result;
            if (manager && typeof manager.unapplyWholeFamily === 'function') {
                result = await manager.unapplyWholeFamily(
                    proposal.proposalId,
                    new Set(),
                    { skipRestoreSource: true, ...(options || {}) }
                );
            } else if (manager && typeof manager.unapplyProposal === 'function') {
                result = await manager.unapplyProposal(
                    proposal.proposalId,
                    { skipConfirm: true, skipRestoreSource: true, ...(options || {}) }
                );
            } else {
                return false;
            }
            if (result === false) return false;
        }
        return true;
    }

    return { unapplyConflictsSequentially };
});
