// The selected proposal.
//
// "A proposal is selected" was already a fact the app relied on — it just had no owner. It lived in
// `window.currentlyHighlightedProposal` (written from seven places, read from thirty), alongside
// `window.selectedParcelInProposal` and `proposalHighlightState.activeProposalId`, each cleared by
// whatever happened to remember to. Anything wanting to *react* to the selection had nowhere to listen,
// so behaviour that should follow it — which proposal the 3D camera frames, what the details panel
// shows, what Escape dismisses — was instead inferred from whatever else was lying around.
//
// This module owns that state. The two old globals are redefined as views of it, so every existing read
// and write keeps working while there is exactly one place the selection changes, and one place to
// subscribe.

(function (global) {
    'use strict';

    const listeners = new Set();

    // parcelId is which parcel of the proposal the user came in through, when they arrived by clicking
    // one. It is a property of the selection, not a separate global.
    let state = { key: null, proposal: null, parcelId: null };

    function keyOf(proposal) {
        if (!proposal) return null;
        try {
            if (typeof global.getProposalKey === 'function') {
                const key = global.getProposalKey(proposal);
                if (key) return String(key);
            }
        } catch (_) { }
        const fallback = proposal.proposalId || proposal.hash || null;
        return fallback ? String(fallback) : null;
    }

    function notify() {
        const snapshot = { ...state };
        listeners.forEach((listener) => {
            try {
                listener(snapshot.proposal, snapshot);
            } catch (error) {
                console.warn('[ProposalSelection] listener threw', error);
            }
        });
    }

    const ProposalSelection = {
        get: () => state.proposal,
        getKey: () => state.key,
        getParcelId: () => state.parcelId,
        has: () => !!state.proposal,

        // Is `key` the selected proposal? Accepts an id, a hash, or a proposal object.
        is(key) {
            if (!key || !state.key) return false;
            const other = (typeof key === 'object') ? keyOf(key) : String(key);
            return !!other && other === state.key;
        },

        // Select a proposal. Re-selecting the same one with a fresher object (the details panel does
        // this after a status change) updates the object without churning the parcel or the listeners
        // that only care about identity.
        select(proposal, options = {}) {
            if (!proposal) return this.clear();
            const key = keyOf(proposal);
            const sameProposal = key && key === state.key;

            state = {
                key,
                proposal,
                parcelId: (options.parcelId !== undefined)
                    ? (options.parcelId === null ? null : String(options.parcelId))
                    : (sameProposal ? state.parcelId : null)
            };
            notify();
            return state.proposal;
        },

        // Which parcel of the selected proposal the user is looking at.
        setParcelId(parcelId) {
            const next = (parcelId === null || parcelId === undefined) ? null : String(parcelId);
            if (next === state.parcelId) return;
            state = { ...state, parcelId: next };
            notify();
        },

        clear() {
            if (!state.proposal && !state.parcelId && !state.key) return null;
            state = { key: null, proposal: null, parcelId: null };
            notify();
            return null;
        },

        subscribe(listener) {
            if (typeof listener !== 'function') return () => { };
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };

    global.ProposalSelection = ProposalSelection;

    // The old globals become views. Assigning to them still works — it routes through the module — so
    // the existing call sites need no change, and a future one can drop them without a flag day.
    Object.defineProperty(global, 'currentlyHighlightedProposal', {
        configurable: true,
        get: () => state.proposal,
        set: (proposal) => { proposal ? ProposalSelection.select(proposal) : ProposalSelection.clear(); }
    });

    Object.defineProperty(global, 'selectedParcelInProposal', {
        configurable: true,
        get: () => state.parcelId,
        set: (parcelId) => ProposalSelection.setParcelId(parcelId)
    });
})(typeof window !== 'undefined' ? window : globalThis);
