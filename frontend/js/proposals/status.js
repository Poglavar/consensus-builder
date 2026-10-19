// Canonical accessors for a proposal's two INDEPENDENT status axes. These used to be crammed into a
// single overloaded `status` field, which let a marketplace/on-chain transition silently un-apply a
// road (and vice-versa). Every read of proposal status must go through one of these two functions so
// the axes can never be confused again:
//
//   getLifecycleStatus(p) -> 'Active' | 'Executed' | 'Cancelled' | 'Expired' | 'draft'
//       The marketplace / on-chain lifecycle (mirrors the Solidity/Solana ProposalStatus enum).
//
//   isApplied(p, sub)     -> boolean
//       Whether this proposal's geometry is stamped onto THIS browser's map. The root boolean is
//       the sole source of truth; nested status is never consulted.
//
// Both read only the canonical fields (proposal.lifecycleStatus and proposal.applied). Legacy rows
// are converted once by migrate-tessellation.js; live code never guesses or heals their meaning.
//
// Dependency-light (no DOM, no proposalStorage) so the same file loads in the browser and in node
// tests, exactly like corridor-carve.js.

const STATUS_SUB_KEYS = Object.freeze([
    'roadProposal',
    'buildingProposal',
    'structureProposal',
    'reparcellization',
    'decideLaterProposal'
]);

function norm(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
}

// Canonical marketplace/on-chain lifecycle value. Legacy application words ('applied'/'unapplied')
// that leaked into the old `status` field collapse to 'Active' — they were never a lifecycle state.
function getLifecycleStatus(proposal) {
    if (!proposal) return 'Active';
    return canonicalLifecycle(proposal.lifecycleStatus);
}

function canonicalLifecycle(value) {
    switch (norm(value)) {
        case 'executed': return 'Executed';
        case 'cancelled': return 'Cancelled';
        case 'expired': return 'Expired';
        case 'draft': return 'draft';
        // 'active', 'applied', 'unapplied', '' and anything unrecognised are all a live proposal.
        default: return 'Active';
    }
}

// The root boolean is the only application state. The optional second argument remains accepted so
// old call sites cannot accidentally turn nested state into authority.
function isApplied(proposal) {
    return proposal?.applied === true;
}

// Canonicalise records created by current code. This deliberately does not infer legacy state;
// migration owns that conversion.
function normalizeProposalStatusAxes(proposal) {
    if (!proposal || typeof proposal !== 'object') return proposal;
    proposal.lifecycleStatus = getLifecycleStatus(proposal);
    proposal.applied = proposal.applied === true;
    delete proposal.status;
    STATUS_SUB_KEYS.forEach(key => {
        const sub = proposal[key];
        if (!sub || typeof sub !== 'object') return;
        delete sub.applied;
        delete sub.appliedAt;
        delete sub.status;
    });
    return proposal;
}

function setProposalApplied(proposal, applied, options = {}) {
    if (!proposal || typeof proposal !== 'object') return false;
    proposal.applied = applied === true;
    if (proposal.applied && options.stamp !== false) {
        proposal.appliedAt = options.appliedAt || new Date().toISOString();
    } else if (!proposal.applied) {
        delete proposal.appliedAt;
    }
    STATUS_SUB_KEYS.forEach(key => {
        const sub = proposal[key];
        if (!sub || typeof sub !== 'object') return;
        delete sub.applied;
        delete sub.appliedAt;
        delete sub.status;
    });
    return proposal.applied;
}

// Server/chain/share payloads must not carry a browser's local visibility choice.
function stripProposalAppliedState(proposal) {
    if (!proposal || typeof proposal !== 'object') return proposal;
    delete proposal.applied;
    delete proposal.appliedAt;
    STATUS_SUB_KEYS.forEach(key => {
        const sub = proposal[key];
        if (!sub || typeof sub !== 'object') return;
        delete sub.applied;
        delete sub.appliedAt;
    });
    return proposal;
}

function parkProposalForImport(proposal) {
    normalizeProposalStatusAxes(proposal);
    setProposalApplied(proposal, false, { stamp: false });
    return proposal;
}

if (typeof window !== 'undefined') {
    window.getLifecycleStatus = getLifecycleStatus;
    window.isApplied = isApplied;
    window.normalizeProposalStatusAxes = normalizeProposalStatusAxes;
    window.setProposalApplied = setProposalApplied;
    window.stripProposalAppliedState = stripProposalAppliedState;
    window.parkProposalForImport = parkProposalForImport;
}

// Node-visible for unit tests and any backend consumer; the browser loads this as a classic script.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getLifecycleStatus,
        canonicalLifecycle,
        isApplied,
        normalizeProposalStatusAxes,
        setProposalApplied,
        stripProposalAppliedState,
        parkProposalForImport,
        STATUS_SUB_KEYS
    };
}
