// Canonical accessors for a proposal's two INDEPENDENT status axes. These used to be crammed into a
// single overloaded `status` field, which let a marketplace/on-chain transition silently un-apply a
// road (and vice-versa). Every read of proposal status must go through one of these two functions so
// the axes can never be confused again:
//
//   getLifecycleStatus(p) -> 'Active' | 'Executed' | 'Cancelled' | 'Expired' | 'draft'
//       The marketplace / on-chain lifecycle (mirrors the Solidity/Solana ProposalStatus enum).
//
//   isApplied(p, sub)     -> boolean
//       Whether this proposal's geometry is stamped onto the map — drawn, and cutting the buildings
//       under it. This is the axis the carve gate (corridor-carve.js) reads. `sub` is an optional
//       sub-proposal (roadProposal / buildingProposal / structureProposal / reparcellization).
//
// Both read the NEW fields (proposal.lifecycleStatus, proposal.applied, sub.applied) when present and
// otherwise DERIVE from the legacy `status` strings, so old localStorage rows and old API responses
// keep working until the backfill/normalize upgrades them in place. The legacy derivation mirrors
// backend/scripts/split-status-applied.js deriveApplied so the browser and the server agree.
//
// Dependency-light (no DOM, no proposalStorage) so the same file loads in the browser and in node
// tests, exactly like corridor-carve.js.

const APPLIED_LIKE = new Set(['applied', 'executed']);

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

// Whether this proposal (optionally a specific sub-proposal) is applied to the map. The explicit
// boolean wins on either the sub-proposal or the proposal (they are kept in sync, so an OR mirrors
// the old `carveAppliedLike(rp.status, proposal.status)` gate). Only pre-split rows with NO boolean
// on either fall through to the legacy status derivation.
//
// The demolition-rescue heuristic that flips a stuck 'Active'/'unapplied' road (like proposal 474)
// to applied lives ONLY in the one-time backfill (backend/scripts/split-status-applied.js), NOT
// here — otherwise a deliberately un-applied road that still carries its records would refuse to
// give its buildings back. Steady state relies on the explicit boolean instead.
function isApplied(proposal, sub) {
    const subFlag = sub && typeof sub.applied === 'boolean' ? sub.applied : undefined;
    const propFlag = proposal && typeof proposal.applied === 'boolean' ? proposal.applied : undefined;
    if (subFlag === true || propFlag === true) return true;
    if (subFlag === false || propFlag === false) return false;
    return deriveAppliedFromLegacy(proposal, sub);
}

// Legacy fallback for rows the split has not upgraded yet: the old application semantics, where a
// status of 'applied' or 'executed' (on the sub-proposal or the proposal) meant on-the-map.
function deriveAppliedFromLegacy(proposal, sub) {
    if (!proposal) return false;
    if (proposal.supersededByProposalId) return false;
    const life = norm(proposal.status);
    if (life === 'cancelled' || life === 'expired') return false;
    if (sub && APPLIED_LIKE.has(norm(sub.status))) return true;
    if (APPLIED_LIKE.has(life)) return true;
    return ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
        .some(k => proposal[k] && APPLIED_LIKE.has(norm(proposal[k].status)));
}

if (typeof window !== 'undefined') {
    window.getLifecycleStatus = getLifecycleStatus;
    window.isApplied = isApplied;
}

// Node-visible for unit tests and any backend consumer; the browser loads this as a classic script.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getLifecycleStatus,
        canonicalLifecycle,
        isApplied,
        deriveAppliedFromLegacy
    };
}
