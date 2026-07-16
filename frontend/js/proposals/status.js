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
//       the sole steady-state source of truth. `sub` is accepted only to migrate pre-split records.
//
// Both read the NEW fields (proposal.lifecycleStatus, proposal.applied, sub.applied) when present and
// otherwise DERIVE from the legacy `status` strings, so old localStorage rows and old API responses
// keep working until the backfill/normalize upgrades them in place. The legacy derivation mirrors
// backend/scripts/split-status-applied.js deriveApplied so the browser and the server agree.
//
// Dependency-light (no DOM, no proposalStorage) so the same file loads in the browser and in node
// tests, exactly like corridor-carve.js.

const APPLIED_LIKE = new Set(['applied', 'executed']);
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
    if (typeof proposal.lifecycleStatus === 'string' && proposal.lifecycleStatus.trim()) {
        return canonicalLifecycle(proposal.lifecycleStatus);
    }
    return canonicalLifecycle(proposal.status);
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

// Whether this proposal is applied to this browser's map. Once a root boolean exists it is
// authoritative: a stale nested flag can never override it. Nested flags and legacy status strings
// are consulted only for an unnormalised, pre-split record with no root boolean.
//
// The demolition-rescue heuristic that flips a stuck 'Active'/'unapplied' road (like proposal 474)
// to applied lives ONLY in the one-time backfill (backend/scripts/split-status-applied.js), NOT
// here — otherwise a deliberately un-applied road that still carries its records would refuse to
// give its buildings back. Steady state relies on the explicit boolean instead.
function isApplied(proposal, sub) {
    const propFlag = proposal && typeof proposal.applied === 'boolean' ? proposal.applied : undefined;
    if (propFlag !== undefined) return propFlag;
    return deriveAppliedFromLegacy(proposal, sub);
}

// Legacy fallback for rows the split has not upgraded yet: the old application semantics, where a
// status of 'applied' or 'executed' (on the sub-proposal or the proposal) meant on-the-map.
function deriveAppliedFromLegacy(proposal, sub) {
    if (!proposal) return false;
    if (proposal.supersededByProposalId) return false;
    const life = norm(proposal.status);
    if (life === 'cancelled' || life === 'expired') return false;
    if (sub && typeof sub.applied === 'boolean') return sub.applied;
    for (const key of STATUS_SUB_KEYS) {
        if (proposal[key] && typeof proposal[key].applied === 'boolean') return proposal[key].applied;
    }
    if (sub && APPLIED_LIKE.has(norm(sub.status))) return true;
    if (APPLIED_LIKE.has(life)) return true;
    return STATUS_SUB_KEYS
        .some(k => proposal[k] && APPLIED_LIKE.has(norm(proposal[k].status)));
}

// Upgrade one record to the steady-state two-axis shape. This is intentionally mutating: the
// storage boundary calls it once and persists the canonical form, eliminating split-brain reads.
function normalizeProposalStatusAxes(proposal) {
    if (!proposal || typeof proposal !== 'object') return proposal;
    const applied = typeof proposal.applied === 'boolean'
        ? proposal.applied
        : deriveAppliedFromLegacy(proposal);
    proposal.lifecycleStatus = getLifecycleStatus(proposal);
    proposal.applied = applied;
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
        deriveAppliedFromLegacy,
        normalizeProposalStatusAxes,
        setProposalApplied,
        stripProposalAppliedState,
        parkProposalForImport,
        STATUS_SUB_KEYS
    };
}
