// Ownership flow (rethink-proposals.md §9, §12 step 2): what a proposal's FORMATION takes from each
// BASE cadastral parcel, and where the ownership of the taken ground goes. One declared word per
// typology — road/park/square/lake/station form public ground, a freeform building forms the
// proposer's parcel, a reparcellization redistributes per its own mapping, decide-later consumes
// fabric but defers the ownership decision. Content-only typologies (rules, votes, transfers,
// as-is) have no formation and therefore no flow.
//
// Also home of the EFFECT fingerprint (§11): the hash of what a proposal DOES to the ground —
// footprint + per-parcel cession — as opposed to proposalContentFingerprint, which hashes what the
// proposal SAYS. Consent binds to the effect: an edit that leaves the effect unchanged keeps
// acceptances standing, a material change voids them (see execution.js). Inputs are STORED fields
// only (geometry, goal, the stamped flow) — never live map state — so the hash is identical on
// every machine and across sessions.
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
        'reparcellization': 'mapping',
        'decide-later': 'undecided'
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

    // --- effect fingerprint -----------------------------------------------------------------

    function stableStringifyLocal(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(stableStringifyLocal).join(',') + ']';
        const keys = Object.keys(value).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringifyLocal(value[k])).join(',') + '}';
    }

    // Same ~64-bit two-variant djb2 rendered base36 as proposalContentHash in sharing.js; kept
    // local so this module stays pure and namespaced (no bare globals).
    function effectHashString(str) {
        let h1 = 5381;
        let h2 = 52711;
        for (let i = 0; i < str.length; i += 1) {
            const c = str.charCodeAt(i);
            h1 = ((h1 << 5) + h1 + c) | 0;
            h2 = (((h2 << 5) + h2) ^ c) | 0;
        }
        return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
    }

    // Sub-meter surveyor drift must not void consent, so coordinates are quantised to ~0.1 m
    // (1e-6 deg ≈ 0.11 m at the equator, less at Zagreb's latitude) before hashing.
    function roundCoords(node) {
        if (Array.isArray(node)) {
            if (node.length && typeof node[0] === 'number') {
                return node.map(n => Math.round(n * 1e6) / 1e6);
            }
            return node.map(roundCoords);
        }
        return node;
    }

    // Authored tunnel choices are part of the effect. Demolition is derived from the footprint at
    // apply time and must never make consent hashes browser-dependent.
    function collectImpactModes(proposal) {
        const tunnelled = [];
        ['roadProposal', 'structureProposal', 'buildingProposal'].forEach(key => {
            const sub = proposal && proposal[key];
            if (!sub || typeof sub !== 'object') return;
            const definition = sub.definition && typeof sub.definition === 'object' ? sub.definition : null;
            const tunnels = definition && definition.tunnels;
            (Array.isArray(tunnels) ? tunnels : []).forEach(record => {
                (record && Array.isArray(record.buildingIds) ? record.buildingIds : [])
                    .forEach(buildingId => tunnelled.push(String(buildingId)));
            });
        });
        if (!tunnelled.length) return null;
        return { tunnelled: Array.from(new Set(tunnelled)).sort() };
    }

    // The hash of the proposal's EFFECT: footprint + per-parcel cession + where ownership goes.
    // Null when the proposal has no footprint (content-only) — callers fall back to the content
    // fingerprint for those, since an offer's "effect" is its terms.
    // The flow input is the STAMPED proposal.ownershipFlow when present (frozen at publish, stable
    // everywhere); opts.ownershipFlow lets the accept path supply a freshly computed one for
    // never-published local proposals.
    function effectFingerprintOf(proposal, options) {
        const api = planOrder();
        const opts = options || {};
        if (!api || !proposal) return null;
        let footprint = null;
        try { footprint = api.footprintOf(proposal); } catch (_) { footprint = null; }
        if (!footprint || !footprint.geometry) return null;

        const flow = Array.isArray(proposal.ownershipFlow) ? proposal.ownershipFlow
            : (Array.isArray(opts.ownershipFlow) ? opts.ownershipFlow : []);
        const effect = {
            goal: String(proposal.goal === undefined || proposal.goal === null ? '' : proposal.goal).trim(),
            footprint: {
                type: footprint.geometry.type,
                coordinates: roundCoords(footprint.geometry.coordinates)
            },
            flow: flow
                .filter(entry => entry && entry.parcelId)
                .map(entry => ({
                    parcelId: String(entry.parcelId),
                    cededM2: Math.round(Number(entry.cededM2) || 0),
                    destination: String(entry.destination || '')
                }))
                .sort((a, b) => a.parcelId.localeCompare(b.parcelId))
        };
        const modes = collectImpactModes(proposal);
        if (modes) effect.modes = modes;
        return 'e-' + effectHashString(stableStringifyLocal(effect));
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

    // --- consent validity against the current effect (§12 step 4) ---------------------------

    // A record from before the mechanism carries no hash and stays valid; so does any record when
    // the current hash cannot be computed (no basis to lapse on).
    function isAcceptanceRecordValid(record, currentHash) {
        if (!record || !record.effectHash || !currentHash) return true;
        return record.effectHash === currentHash;
    }

    // Recompute which owner acceptances still count against `currentHash`, and rebuild the
    // proposal's acceptedParcelIds from them. Records are never deleted — consent history is
    // immutable — they just stop (or resume) counting. Only parcels governed by an
    // ownerAcceptances entry are touched; ids accepted through the plain path are left alone.
    function refreshAcceptanceValidity(proposal, currentHash) {
        if (!proposal || !proposal.ownerAcceptances || typeof proposal.ownerAcceptances !== 'object') {
            return { lapsedOwners: 0 };
        }
        let lapsedOwners = 0;
        const validParcelIds = [];
        Object.entries(proposal.ownerAcceptances).forEach(([entryParcelId, entry]) => {
            if (!entry) return;
            const acceptedKeys = Array.isArray(entry.acceptedOwnerKeys) ? entry.acceptedOwnerKeys : [];
            const validKeys = acceptedKeys.filter(key => {
                const valid = isAcceptanceRecordValid(entry.acceptedBy && entry.acceptedBy[key], currentHash);
                if (!valid) lapsedOwners += 1;
                return valid;
            });
            const ownerOrder = (Array.isArray(entry.ownerOrder) && entry.ownerOrder.length > 0)
                ? entry.ownerOrder
                : acceptedKeys;
            const fullyAccepted = ownerOrder.length > 0
                ? ownerOrder.every(key => validKeys.includes(key))
                : validKeys.length > 0;
            if (fullyAccepted) validParcelIds.push(String(entryParcelId));
        });
        const governed = new Set(Object.keys(proposal.ownerAcceptances).map(String));
        proposal.acceptedParcelIds = (Array.isArray(proposal.acceptedParcelIds) ? proposal.acceptedParcelIds : [])
            .map(String)
            .filter(id => !governed.has(id) || validParcelIds.includes(id));
        validParcelIds.forEach(id => {
            if (!proposal.acceptedParcelIds.includes(id)) proposal.acceptedParcelIds.push(id);
        });
        return { lapsedOwners };
    }

    const api = {
        DESTINATION_BY_GOAL,
        destinationForGoal,
        hasFormation,
        computeOwnershipFlow,
        effectFingerprintOf,
        compareOwnershipFlows,
        isAcceptanceRecordValid,
        refreshAcceptanceValidity
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__ownershipFlow = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
