// Per-parcel owner-acceptance bookkeeping for a proposal: who the owners of a parcel are, in what
// order, which of them have accepted, and by whom. Pure over the proposal object — no DOM, no map —
// so it is unit-tested headless and shared by proposals/core.js, data.js and execution.js.
//
// normalizeOwnerAcceptances rebuilds the record into its canonical shape (owners / ownerOrder /
// acceptedOwnerKeys / acceptedBy) and folds accepted keys back into the order. ensureOwnerAcceptance-
// Entry adds/updates owner slots for one parcel, purges legacy placeholder owners once real slots
// arrive (guarded by the placeholder-looking display name, so a real named owner is never dropped),
// and — when asked — back-fills owner acceptances from proposal.acceptedParcelIds.

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
            const owners = entry && typeof entry.owners === 'object' ? entry.owners : {};
            const ownerOrder = Array.isArray(entry && entry.ownerOrder)
                ? entry.ownerOrder.filter(key => typeof key === 'string' && key.length > 0)
                : Object.keys(owners);
            const acceptedOwnerKeys = Array.isArray(entry && entry.acceptedOwnerKeys)
                ? Array.from(new Set(entry.acceptedOwnerKeys.map(key => key && key.toString()).filter(Boolean)))
                : [];
            const acceptedBy = entry && typeof entry.acceptedBy === 'object' ? entry.acceptedBy : {};

            // Ensure ownerOrder also contains any accepted keys
            acceptedOwnerKeys.forEach(key => {
                if (!ownerOrder.includes(key)) {
                    ownerOrder.push(key);
                }
            });

            normalized[normalizedParcelId] = {
                owners,
                ownerOrder,
                acceptedOwnerKeys,
                acceptedBy
            };
        });
        return normalized;
    }

    function ensureOwnerAcceptanceEntry(proposal, parcelId, ownerSlots = [], options = {}) {
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
        const ownerOrderSet = new Set(entry.ownerOrder || []);

        const ownerSlotsArray = Array.isArray(ownerSlots) ? ownerSlots : [];
        ownerSlotsArray.forEach(slot => {
            if (!slot || !slot.key) {
                return;
            }
            const normalizedOwner = {
                key: slot.key,
                displayName: slot.displayName || slot.name || `Owner ${ownerOrderSet.size + 1}`,
                shareText: slot.shareText || '',
                shareDetail: slot.shareDetail || '',
                type: slot.type || 'unknown',
                agentId: slot.agentId || null,
                placeholder: !!slot.placeholder
            };
            entry.owners[slot.key] = {
                ...(entry.owners[slot.key] || {}),
                ...normalizedOwner
            };
            if (!ownerOrderSet.has(slot.key)) {
                entry.ownerOrder.push(slot.key);
                ownerOrderSet.add(slot.key);
            }
        });

        const hasNonPlaceholderSlots = ownerSlotsArray.some(slot => slot && !slot.placeholder);
        if (hasNonPlaceholderSlots) {
            const placeholderKeys = Object.keys(entry.owners || {}).filter(key => {
                const owner = entry.owners[key];
                if (!owner) return false;
                if (owner.placeholder) return true;
                const display = (owner.displayName || '').toLowerCase();
                const share = (owner.shareText || '').trim();
                const looksLegacyPlaceholder = owner.type === 'unknown'
                    && !owner.agentId
                    && (!display || display.includes('parcel owner') || display.includes('unknown owner'))
                    && (!share || share === '100%' || share === '1');
                return looksLegacyPlaceholder;
            });
            if (placeholderKeys.length > 0) {
                placeholderKeys.forEach(key => {
                    delete entry.owners[key];
                    if (entry.acceptedBy && entry.acceptedBy[key]) {
                        delete entry.acceptedBy[key];
                    }
                });
                entry.ownerOrder = (entry.ownerOrder || []).filter(key => !placeholderKeys.includes(key));
                entry.acceptedOwnerKeys = (entry.acceptedOwnerKeys || []).filter(key => !placeholderKeys.includes(key));
                placeholderKeys.forEach(key => ownerOrderSet.delete(key));
            }
        }

        if (!Array.isArray(entry.acceptedOwnerKeys)) {
            entry.acceptedOwnerKeys = [];
        }
        entry.acceptedOwnerKeys = Array.from(new Set(entry.acceptedOwnerKeys.map(key => key && key.toString()).filter(Boolean)));
        entry.acceptedOwnerKeys.forEach(key => {
            if (!ownerOrderSet.has(key)) {
                entry.ownerOrder.push(key);
                ownerOrderSet.add(key);
            }
        });

        if (!entry.acceptedBy || typeof entry.acceptedBy !== 'object') {
            entry.acceptedBy = {};
        }

        const shouldSync = options.syncWithParcelAcceptance !== false;
        const parcelAccepted = shouldSync
            ? Array.isArray(proposal.acceptedParcelIds) && proposal.acceptedParcelIds.includes(normalizedParcelId)
            : false;

        if (parcelAccepted && entry.acceptedOwnerKeys.length === 0 && entry.ownerOrder.length > 0) {
            entry.ownerOrder.forEach(key => {
                if (!entry.acceptedOwnerKeys.includes(key)) {
                    entry.acceptedOwnerKeys.push(key);
                    if (!entry.acceptedBy[key]) {
                        entry.acceptedBy[key] = {
                            agentId: null,
                            username: null,
                            acceptedAt: proposal.executedAt || proposal.updatedAt || new Date().toISOString()
                        };
                    }
                }
            });
        }

        proposal.ownerAcceptances[normalizedParcelId] = entry;
        return entry;
    }

    const api = { normalizeOwnerAcceptances, ensureOwnerAcceptanceEntry };

    if (typeof window !== 'undefined') {
        window.normalizeOwnerAcceptances = normalizeOwnerAcceptances;
        window.ensureOwnerAcceptanceEntry = ensureOwnerAcceptanceEntry;
        window.ProposalOwnerAcceptance = api;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
