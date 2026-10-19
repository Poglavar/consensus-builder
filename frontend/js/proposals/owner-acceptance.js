// Per-parcel owner-acceptance bookkeeping for a proposal: who the owners of a parcel are, in what
// order, which of them have accepted, and by whom. Pure over the proposal object — no DOM, no map —
// so it is unit-tested headless and shared by proposals/core.js, data.js and execution.js.
//
// normalizeOwnerAcceptances keeps decisions separate from the declared roster. The current roster
// comes only from explicit, non-placeholder slots passed to ensureOwnerAcceptanceEntry. Historical
// decision metadata survives roster changes; it cannot create an owner or a parcel-level tally.

(function (global) {
    'use strict';

    function normalizeOwnerAcceptances(ownerAcceptances = {}) {
        const normalized = {};
        if (!ownerAcceptances || typeof ownerAcceptances !== 'object') {
            return normalized;
        }
        Object.entries(ownerAcceptances).forEach(([parcelId, entry]) => {
            if (parcelId === undefined || parcelId === null) {
                return;
            }
            const normalizedParcelId = parcelId.toString();
            const owners = entry?.owners && typeof entry.owners === 'object' ? entry.owners : {};
            const ownerOrder = Array.isArray(entry && entry.ownerOrder)
                ? entry.ownerOrder.filter(key => typeof key === 'string' && key.length > 0)
                : Object.keys(owners);
            const acceptedOwnerKeys = Array.isArray(entry && entry.acceptedOwnerKeys)
                ? Array.from(new Set(entry.acceptedOwnerKeys.map(key => key && key.toString()).filter(Boolean)))
                : [];
            const acceptedBy = entry?.acceptedBy && typeof entry.acceptedBy === 'object' ? entry.acceptedBy : {};

            // A decision key never supplies a missing owner declaration.
            const currentOrder = [...new Set(ownerOrder)].filter(key => owners[key]?.placeholder !== true);

            normalized[normalizedParcelId] = {
                owners,
                ownerOrder: currentOrder,
                acceptedOwnerKeys,
                acceptedBy,
                ...(Array.isArray(entry?.acceptanceHistory) ? { acceptanceHistory: entry.acceptanceHistory } : {})
            };
        });
        return normalized;
    }

    function currentOwnerSlots(slots) {
        const seen = new Set();
        return (Array.isArray(slots) ? slots : []).filter(slot => {
            if (!slot || typeof slot.key !== 'string' || !slot.key.trim() || slot.placeholder === true || seen.has(slot.key)) return false;
            seen.add(slot.key);
            return true;
        });
    }

    function ensureOwnerAcceptanceEntry(proposal, parcelId, ownerSlots = []) {
        if (!proposal) {
            return null;
        }
        if (!proposal.ownerAcceptances || typeof proposal.ownerAcceptances !== 'object') {
            proposal.ownerAcceptances = {};
        }

        const normalizedParcelId = parcelId ? parcelId.toString() : null;
        if (!normalizedParcelId) {
            return null;
        }

        if (!proposal.ownerAcceptances[normalizedParcelId]) {
            proposal.ownerAcceptances[normalizedParcelId] = {
                owners: {},
                ownerOrder: [],
                acceptedOwnerKeys: [],
                acceptedBy: {}
            };
        }

        const entry = proposal.ownerAcceptances[normalizedParcelId];
        const currentSlots = currentOwnerSlots(ownerSlots);
        entry.ownerOrder = currentSlots.map(slot => slot.key);
        entry.owners = Object.fromEntries(currentSlots.map((slot, index) => [slot.key, {
            key: slot.key,
            displayName: slot.displayName || slot.name || `Owner ${index + 1}`,
            shareText: slot.shareText || '',
            shareDetail: slot.shareDetail || '',
            type: slot.type || 'unknown',
            agentId: slot.agentId || null,
            placeholder: false
        }]));

        if (!Array.isArray(entry.acceptedOwnerKeys)) {
            entry.acceptedOwnerKeys = [];
        }
        entry.acceptedOwnerKeys = Array.from(new Set(entry.acceptedOwnerKeys.map(key => key && key.toString()).filter(Boolean)));
        if (!entry.acceptedBy || typeof entry.acceptedBy !== 'object') {
            entry.acceptedBy = {};
        }

        proposal.ownerAcceptances[normalizedParcelId] = entry;
        return entry;
    }

    const api = { normalizeOwnerAcceptances, currentOwnerSlots, ensureOwnerAcceptanceEntry };

    if (typeof window !== 'undefined') {
        window.normalizeOwnerAcceptances = normalizeOwnerAcceptances;
        window.ensureOwnerAcceptanceEntry = ensureOwnerAcceptanceEntry;
        window.ProposalOwnerAcceptance = api;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
