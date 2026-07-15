// The two genuinely-shared tail steps of every _apply<Type>Proposal method, extracted so they stop
// being copy-pasted 5×. NOT a pipeline — the per-type apply logic (road geometry, building rendering,
// park/lake surfaces, reparcellization) is legitimately different and stays in each module. These are
// only the identical boilerplate that ran at the end of each: persist the now-applied proposal, and
// refresh the proposal-related UI. Classic script: both are browser globals (the apply modules call
// them by bare name); the CommonJS export at the bottom is for the characterization tests.

// Flip the proposal to applied and write it through proposalStorage. _indexProposal when available
// (keeps the storage indexes coherent), else a plain map set; save() is guarded.
function persistAppliedProposal(proposalData, proposalId) {
    if (!proposalData) return;
    proposalData.applied = true;
    proposalData.updatedAt = new Date().toISOString();
    proposalData.proposalId = proposalData.proposalId || proposalId;
    if (typeof proposalStorage !== 'undefined' && proposalStorage) {
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        } else if (proposalStorage.proposals && typeof proposalStorage.proposals.set === 'function') {
            proposalStorage.proposals.set(proposalData.proposalId, proposalData);
        }
        if (typeof proposalStorage.save === 'function') proposalStorage.save();
    }
}

// Refresh the proposal-affected UI after an apply. Every call is guarded because these are optional
// globals in some load orders; a missing one must never abort the apply.
function refreshProposalUIAfterApply(statusMessage) {
    try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
    try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
    try { if (typeof refreshParcelStylesForAppliedProposals === 'function') refreshParcelStylesForAppliedProposals(); } catch (_) { }
    if (statusMessage && typeof updateStatus === 'function') {
        try { updateStatus(statusMessage); } catch (_) { }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { persistAppliedProposal, refreshProposalUIAfterApply };
}
