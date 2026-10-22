// Ownership flow (rethink-proposals.md §9, §12 step 2): what a proposal's FORMATION takes from each
// BASE cadastral parcel, and where the ownership of the taken ground goes. One declared word per
// typology — road/park/square/lake/station form public ground, a freeform building forms the
// proposer's parcel, a parcel layout redraws borders and carries ownership over. Content-only
// typologies (rules, votes, transfers, as-is) have no formation and therefore no flow.
//
// Also compares a publish-time flow with the one re-derived here (replay fidelity, §11). Owners
// decide on agreements, not on designs (plan-design-agreement.md, M2), so no per-design consent
// binds to the flow. A parcel layout changes borders, never ownership (M1 (a)): its flow is its
// footprint like any other formation's; who ends up with which plot is its agreement's.
//
// Pure: plain objects in and out, no DOM, no map. `turf` resolves via plan-order.js.

(function (global) {
    'use strict';

    const planOrder = () => (global && global.__planOrder)
        ? global.__planOrder
        : (typeof require === 'function' ? require('./plan-order.js') : null);

    // Where the ownership of formed ground goes, per typology. A goal absent from this map has no
    // formation: it draws on, offers about, or legislates over parcels it does not re-form.
    const DESTINATION_BY_GOAL = Object.freeze({
        'road-track': 'public',
        'park': 'public',
        'square': 'public',
        'lake': 'public',
        'station': 'public',
        'single': 'proposer',
        'buildings': 'proposer',
        'parcel-layout': 'carry-over'
    });

    function destinationForGoal(goal) {
        const key = String(goal === undefined || goal === null ? '' : goal).trim();
        return DESTINATION_BY_GOAL[key] || null;
    }

    function hasFormation(goal) {
        return destinationForGoal(goal) !== null;
    }

    // The flow itself: per crossed base parcel, how much ground the formation takes (m²) and where
    // its ownership goes. `baseParcels` is [{ id, feature }] — the caller's loaded cadastre.
    // Returns [] for content-only proposals and for footprints that touch nothing measurable.
    function computeOwnershipFlow(proposal, baseParcels, options) {
        const api = planOrder();
        const opts = options || {};
        if (!api || !proposal || !Array.isArray(baseParcels)) return [];
        const goal = opts.goal !== undefined ? opts.goal : proposal.goal;
        const destination = destinationForGoal(goal);
        if (!destination) return [];
        const footprint = api.footprintOf(proposal);
        if (!footprint) return [];
        return api.computeBaseAncestry(footprint, baseParcels, opts)
            .map(hit => ({ parcelId: hit.id, cededM2: hit.area, destination }));
    }

    // --- replay fidelity (§11 first rung) ---------------------------------------------------

    // Does this proposal take the SAME ground here as when it was published? `stamped` is the
    // publish-time ownership flow; `live` is the flow re-derived against the receiver's cadastre.
    // Sub-tolerance drift is surveyor noise, not a divergence (the doc's open tolerance question,
    // answered pragmatically: 5 m² or 5%, whichever is larger). A parcel missing from `live` only
    // counts as REMOVED when the receiver actually has that parcel loaded (`knownParcelIds`) —
    // an unloaded parcel is unknown, not absent.
    function compareOwnershipFlows(stamped, live, options) {
        const opts = options || {};
        const tolM2 = Number.isFinite(opts.toleranceM2) ? opts.toleranceM2 : 5;
        const tolPct = Number.isFinite(opts.tolerancePct) ? opts.tolerancePct : 0.05;
        const known = opts.knownParcelIds instanceof Set ? opts.knownParcelIds
            : (Array.isArray(opts.knownParcelIds) ? new Set(opts.knownParcelIds.map(String)) : null);
        const toMap = (flow) => {
            const map = new Map();
            (Array.isArray(flow) ? flow : []).forEach(entry => {
                if (entry && entry.parcelId) {
                    map.set(String(entry.parcelId), {
                        cededM2: Math.round(Number(entry.cededM2) || 0),
                        destination: String(entry.destination || '')
                    });
                }
            });
            return map;
        };
        const before = toMap(stamped);
        const after = toMap(live);
        const withinTolerance = (a, b) => Math.abs(a - b) <= Math.max(tolM2, tolPct * Math.max(a, b));

        const added = [];
        const removed = [];
        const changed = [];
        before.forEach((entry, parcelId) => {
            const now = after.get(parcelId);
            if (!now) {
                if (entry.cededM2 > tolM2 && (!known || known.has(parcelId))) {
                    removed.push({ parcelId, wasM2: entry.cededM2 });
                }
                return;
            }
            if (!withinTolerance(entry.cededM2, now.cededM2)) {
                changed.push({ parcelId, wasM2: entry.cededM2, nowM2: now.cededM2 });
            } else if (entry.destination && now.destination && entry.destination !== now.destination) {
                changed.push({ parcelId, wasM2: entry.cededM2, nowM2: now.cededM2, destination: now.destination });
            }
        });
        after.forEach((entry, parcelId) => {
            if (!before.has(parcelId) && entry.cededM2 > tolM2) {
                added.push({ parcelId, nowM2: entry.cededM2 });
            }
        });
        return { same: !added.length && !removed.length && !changed.length, added, removed, changed };
    }

    const api = {
        DESTINATION_BY_GOAL,
        destinationForGoal,
        hasFormation,
        computeOwnershipFlow,
        compareOwnershipFlows
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__ownershipFlow = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
