// What a corridor TAKES, and whether some other formation's take runs over one. Mixed into
// ProposalManager via Object.assign; `this` is ProposalManager at call time.
//
// A road no longer cuts anything. It is a take, and the cadastral parcels it crosses are re-derived
// from the cadastre and every take over them (proposals/parcel-arrangement.js) — so the chained cut
// that used to live here, along with its crossroads holder rule, is gone. What remains is the pair
// of questions the OTHER formation types still ask about corridors: what ground does this corridor
// claim, and would my take sever one.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyRoad = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Below this, two polygons are not meaningfully related — the same measured-noise floor
    // plan-order.js uses for ancestry. It is NOT a tolerance for cut debris: the fabric is read at
    // full precision now (see cadastre-ancestry.js), so ground a road actually cut leaves exactly
    // zero overlap and mere adjacency measures exactly zero. Used below to tell a real take of
    // corridor ground from an abutting one, which must never be trimmed.
    const MIN_REAL_OVERLAP_M2 = 0.25;

    return {
    // §15b (decision 2026-08-06): one partition, latest wins — the taker AMENDS the taken.
    // After a formation successfully takes ground, every OTHER applied formation whose plan
    // still claims that ground is amended immediately: its authored plots are clipped by the
    // taken footprint, loudly. V1 amends reparcellization victims (their polygons ARE their
    // plan); corridor trimming of a road victim is the recorded follow-up. Amendment is
    // idempotent — re-clipping an already-clipped plan reports no change — and permanent:
    // un-applying the taker later frees the ground to base remainders, never back to the plan.
    // The ground a formation TAKES, per type — and it must be the SAME geometry the CUT
    // consumes, or the amend pass misses takings the fabric already performed. For roads that
    // is the FULL corridor polygon: the resolver and the parcel cut consume via
    // footprintOf → definition.polygon, tunnels included (Cibona's tunnelled roads consumed
    // the plots above them while the surface footprint overlapped those plots by 0 m², so
    // Subdivide 2042 was never amended and re-applied once per reload). The full corridor is
    // authoritative taking/cut geometry; a tunnel changes presentation only.
    _takingFootprintOf(proposalData) {
        try {
            if (!proposalData) return null;
            const definition = proposalData.roadProposal && proposalData.roadProposal.definition;
            if (definition) {
                if (definition.polygon) return definition.polygon;
                return (typeof corridorSurfaceFootprintForDefinition === 'function')
                    ? corridorSurfaceFootprintForDefinition(definition)
                    : null;
            }
            if (proposalData.reparcellization && Array.isArray(proposalData.reparcellization.polygons)) {
                const claimed = proposalData.reparcellization.polygons
                    .map(slice => slice && slice.geometry)
                    .filter(g => g && /Polygon/.test(g.type));
                if (!claimed.length) return null;
                return claimed.length === 1 ? claimed[0] : {
                    type: 'MultiPolygon',
                    coordinates: claimed.flatMap(g => g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates])
                };
            }
        } catch (_) { }
        return null;
    },

    // A road, once placed, IS a parcel, and nothing else may be built on it. Not "may not cut it
    // in two" — may not stand on it at all: a square laid across a street, a building overhanging
    // the carriageway, a park swallowing a junction are all the same mistake, and the fabric has no
    // way to represent two proposals owning the same ground.
    //
    // This replaces a narrower rule that refused only takes which DISCONNECTED a road, measured by
    // trimming the road's CENTERLINE. That leaked the centerline into a decision the parcel owns:
    // a road whose parcel no longer follows its centerline — one shaped by an edit, a migration or
    // drawn by hand — was judged on a line that is not its ground. The test is now the parcel
    // itself, so a derived corridor and a hand-drawn polygon behave identically.
    //
    // Roads still take from everything else; this is the one direction that is closed. Returns
    // { proposal, overlapM2 } for the first applied road the taking would stand on, else null.
    _appliedRoadOverlappedByTaking(takenGeometry, excludeProposalId, options = {}) {
        try {
            const turfRef = (typeof turf !== 'undefined') ? turf : null;
            if (!turfRef || !takenGeometry) return null;
            const taken = takenGeometry.type === 'Feature'
                ? takenGeometry
                : { type: 'Feature', properties: {}, geometry: takenGeometry };
            if (!taken.geometry) return null;
            const excludeKey = excludeProposalId === undefined || excludeProposalId === null
                ? '' : String(excludeProposalId);
            const store = options?._parcelMutation?.proposals
                || (typeof proposalStorage !== 'undefined' ? proposalStorage : null);
            // Read-only scan: the draft's peek hands out shared records without marking them
            // touched, so an overlap check does not turn into a rewrite of every row.
            const all = store && typeof store.peekAllProposals === 'function'
                ? store.peekAllProposals()
                : (store && typeof store.getAllProposals === 'function' ? store.getAllProposals() : []);
            for (const p of all) {
                if (!p) continue;
                if (excludeKey && String(p.proposalId) === excludeKey) continue;
                if (!(p.roadProposal && p.roadProposal.definition)) continue;
                if (typeof isProposalCurrentlyApplied === 'function' && !isProposalCurrentlyApplied(p)) continue;
                // The road's PARCEL: its stored polygon when it has one, the corridor it would cut
                // otherwise. Same geometry the cut consumes, so the guard cannot disagree with it.
                const claim = this._takingFootprintOf(p);
                if (!claim) continue;
                let overlapM2 = 0;
                try {
                    const hit = turfRef.intersect(taken, { type: 'Feature', properties: {}, geometry: claim });
                    overlapM2 = hit ? (turfRef.area(hit) || 0) : 0;
                } catch (_) { overlapM2 = 0; }
                // Abutting a street is normal composition and measures exactly zero now that the
                // fabric is read at full precision; anything above the noise floor is a real take.
                if (overlapM2 >= MIN_REAL_OVERLAP_M2) return { proposal: p, overlapM2 };
            }
        } catch (error) {
            console.warn('[_appliedRoadOverlappedByTaking] road-overlap pre-check failed', error);
        }
        return null;
    },
    };
});
