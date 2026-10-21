// proposals/lifecycle.js — the proposal lifecycle status as the UI shows it (key, label, badge
// class). Extracted from proposals.js. A design has no deadline (plan-design-agreement.md): the
// status is the record's own lifecycle, never computed from a date.
// Pure/leaf helpers; any cross-module calls resolve as runtime globals (all proposal scripts loaded).

// The canonical lifecycle accessor from proposals/status.js — a global in the browser (status.js
// loads first), required directly in node tests. `typeof` on an undeclared name is safe.
const lifecyclePhaseOf = (typeof getLifecycleStatus === 'function')
    ? getLifecycleStatus
    : require('./status.js').getLifecycleStatus;

function lifecycleEvidenceModel() {
    if (typeof window !== 'undefined' && window.ProposalLifecycleEvidence) return window.ProposalLifecycleEvidence;
    return typeof require === 'function' ? require('./lifecycle-evidence.js') : null;
}

function hasObservedLifecycleEvidence(proposal, status) {
    const model = lifecycleEvidenceModel();
    return model?.hasObservedStatus?.(proposal, status) === true;
}

function getProposalLifecycleKey(proposal) {
    const lifecycleField = lifecyclePhaseOf(proposal).toLowerCase();
    if (lifecycleField === 'executed') {
        return hasObservedLifecycleEvidence(proposal, 'Executed') ? 'executed' : 'execution-unverified';
    }
    // Missing evidence and explicit draft or terminal states are the record's own.
    if (['unknown', 'draft', 'cancelled', 'expired'].includes(lifecycleField)) return lifecycleField;
    // Funding readiness does not establish owner consent and cannot override a terminal state.
    if (proposal.funded === false && proposal.ownershipTransferProposal?.direction === 'from-me') {
        return 'awaiting-funding';
    }
    return 'active';
}

function getProposalLifecycleLabel(key) {
    const t = getProposalI18nHelper();
    switch (key) {
        case 'executed':
            return t('panel.proposal.lifecycle.executed', 'Execution recorded');
        case 'execution-unverified':
            return t('panel.proposal.lifecycle.executionUnverified', 'Execution reported; verification unavailable');
        case 'expired':
            return t('panel.proposal.lifecycle.expired', 'Expired');
        case 'cancelled':
            return t('panel.proposal.lifecycle.cancelled', 'Withdrawn');
        case 'awaiting-funding':
            return t('panel.proposal.lifecycle.awaitingFunding', 'Awaiting funding');
        case 'draft':
            return t('common.lifecycle.draft', 'Draft');
        case 'active':
            return t('panel.proposal.lifecycle.active', 'Active');
        default:
            return t('panel.proposal.lifecycle.unknown', 'Status unknown');
    }
}

function getProposalLifecycleClass(key) {
    switch (key) {
        case 'executed':
            return 'executed';
        case 'execution-unverified':
            return 'unknown';
        case 'expired':
            return 'expired';
        case 'cancelled':
            return 'cancelled';
        case 'awaiting-funding':
            return 'active';
        case 'unknown':
            return 'unknown';
        case 'draft':
            return 'draft';
        default:
            return 'active';
    }
}

// Export the pure classification helper for headless unit tests (browser leaves `module` undefined,
// so this is a no-op there and the functions remain plain globals).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getProposalLifecycleKey
    };
}
