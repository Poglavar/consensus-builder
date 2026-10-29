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

    // Polygon-clip failures are typed and counted in one place (parcel-arrangement.js clipHealth).
    function clipFailureApi() {
        const api = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('../parcel-arrangement.js') : null);
        if (!api || typeof api.clipFailure !== 'function') throw new Error('parcel-arrangement.js (clip failures) is not loaded');
        return api;
    }

    // Whether a road really takes ground or merely abuts it, and whether a carved piece is still
    // ground, is the one shared rule (geometry-tolerances.js reachesInto / isGround), the rule
    // binding and ancestry use. An abutting take, which must never be trimmed, is not ground.
    function groundApi() {
        return (typeof window !== 'undefined' && window.GeometryTolerances)
            || (typeof require === 'function' ? require('../../geometry-tolerances.js') : null);
    }

    return {
    // §15b (decision 2026-08-06): one partition, latest wins. A later taking never rewrites a
    // formation's record; the pieces derived from it are carved instead (_groundAfterLaterCorridors
    // below), so un-applying the taker gives the ground back.
    // The ground a road TAKES — and it must be the SAME geometry the CUT consumes, or a check
    // against it misses takings the fabric already performed. That is the FULL corridor polygon:
    // the resolver and the parcel cut consume via
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
        } catch (error) {
            // A taking that cannot be built takes nothing here, and says so (projections.md §3).
            console.error(`[${new Date().toISOString()}] [apply/road] the taking footprint of ${proposalData && (proposalData.proposalId || proposalData.id)} could not be built`, error);
        }
        return null;
    },

    // The ground a formation keeps once the corridors applied AFTER it in the formation order have
    // taken theirs: one rule for every formed piece a road can cross — a park/square/lake body and
    // each plot of a parcel layout or subdivision, on cadastral and on open ground alike (the
    // road tool's "Build through": the road cuts through and the rest stays as it is). On cadastral
    // ground the arrangement already cut the parcels under the road, so the formation would no
    // longer find its ground there; on open ground nothing is arranged, so without this the road
    // and the formation would both cover the ribbon. Every replay asks this, so the result is a
    // function of the plan (records + order), never of apply timing: the record stays as authored,
    // only the applied pieces are carved, and unapplying the road gives the ground back. An EARLIER
    // road is not carved here — a newer formation over it is still refused.
    //
    // Takes the same geometry the corridor cut consumes (plan-order footprintOf, as
    // _appliedCorridorTakes), clipped through the arrangement's snapped clipper; crumbs that are not
    // ground (geometry-tolerances.js isGround) are dropped. `geometries` is a list (one per piece); returns
    // { geometries, corridorIds } — each entry the carved geometry, or null when the corridors take
    // all of it; the input list unchanged and [] when no later corridor crosses any of them.
    _groundAfterLaterCorridors(record, geometries, options = {}) {
        const list = Array.isArray(geometries) ? geometries : [];
        const unchanged = { geometries: list, corridorIds: [] };
        const turfRef = (typeof turf !== 'undefined') ? turf : null;
        const root = (typeof window !== 'undefined') ? window : globalThis;
        const order = root.__planOrder;
        const arrangement = root.__parcelArrangement;
        if (!turfRef || !list.length || !record || !order || typeof order.compareFormationOrder !== 'function') return unchanged;
        const clip = (operation, a, b) => (arrangement && typeof arrangement.clip === 'function')
            ? arrangement.clip(operation, a, b)
            : turfRef[operation](a, b);
        const store = options?._parcelMutation?.proposals
            || (typeof proposalStorage !== 'undefined' ? proposalStorage : null);
        const all = store && typeof store.peekAllProposals === 'function'
            ? store.peekAllProposals()
            : (store && typeof store.getAllProposals === 'function' ? store.getAllProposals() : []);
        const selfKey = String(record.proposalId ?? '');
        const claims = [];
        for (const p of all) {
            if (!p || String(p.proposalId) === selfKey) continue;
            if (!(p.roadProposal && p.roadProposal.definition)) continue;
            if (typeof isProposalCurrentlyApplied === 'function' && !isProposalCurrentlyApplied(p)) continue;
            if (order.compareFormationOrder(p, record) <= 0) continue;
            let claim = null;
            try {
                const footprint = typeof order.footprintOf === 'function' ? order.footprintOf(p) : null;
                claim = footprint && footprint.geometry ? footprint.geometry : this._takingFootprintOf(p);
            } catch (_) { claim = this._takingFootprintOf(p); }
            if (!claim) continue;
            let box = null;
            try { box = turfRef.bbox(claim); } catch (_) { box = null; }
            claims.push({ id: String(p.proposalId), feature: { type: 'Feature', properties: {}, geometry: claim }, box });
        }
        if (!claims.length) return unchanged;
        // Import order and formation replay order can differ. Use the same geometric clip order
        // as cadastral arrangement so a formation's remaining ground keeps its agreement hash.
        const orderedClaims = clipFailureApi().orderClips(claims, claim => claim.feature);
        const ground = groundApi();
        const disjoint = (a, b) => !!a && !!b && (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]);
        const corridorIds = new Set();
        const carved = list.map(geometry => {
            if (!geometry || !/Polygon/.test(String(geometry.type || ''))) return geometry;
            let body = { type: 'Feature', properties: {}, geometry };
            let cut = false;
            for (const claim of orderedClaims) {
                let box = null;
                try { box = turfRef.bbox(body); } catch (_) { box = null; }
                if (disjoint(box, claim.box)) continue;
                // A clip that fails throws a typed ClipFailure: zero would leave the later
                // corridor's ribbon inside this formation, two proposals owning the same ground.
                if (!ground.reachesInto(turfRef, body, claim.feature, 0, {
                    site: 'apply-road.groundAfterLaterCorridors',
                    proposalId: record.proposalId,
                    takeId: claim.id
                })) continue;
                corridorIds.add(claim.id);
                cut = true;
                const rest = clip('difference', body, claim.feature);
                if (!rest || !rest.geometry || !ground.isGround(turfRef, rest)) return null;
                body = { type: 'Feature', properties: {}, geometry: rest.geometry };
            }
            if (!cut) return geometry;
            // Drop the clipper's debris so the piece is only real ground.
            const polygons = body.geometry.type === 'MultiPolygon'
                ? body.geometry.coordinates
                : [body.geometry.coordinates];
            const kept = polygons.filter(coordinates => ground.isGround(turfRef, { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } }));
            if (!kept.length) return null;
            return kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept };
        });
        if (!corridorIds.size) return unchanged;
        return { geometries: carved, corridorIds: Array.from(corridorIds) };
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
    // "Stands on" is the shared rule (geometry-tolerances.js isGround of the overlap), widened only
    // by `options.toleranceM`, the taking design's own allowance.
    // A road applied AFTER a structure is not "placed" for it: replay carves that road's ground out
    // of the formation first (_groundAfterLaterCorridors), so only earlier roads remain here.
    _appliedRoadOverlappedByTaking(takenGeometry, excludeProposalId, options = {}) {
        try {
            const turfRef = (typeof turf !== 'undefined') ? turf : null;
            if (!turfRef || !takenGeometry) return null;
            const ground = groundApi();
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
                const claimFeature = { type: 'Feature', properties: {}, geometry: claim };
                // A clip that fails throws a typed ClipFailure: zero would let a take stand on an
                // applied road unchecked.
                const hit = clipFailureApi().clipWith(turfRef, 'intersect', taken, claimFeature, {
                    site: 'apply-road.appliedRoadOverlappedByTaking',
                    proposalId: excludeKey || null,
                    takeId: p.proposalId
                });
                // Abutting a street is normal composition and leaves no ground in the overlap;
                // anything that is ground is a real take.
                if (ground.isGround(turfRef, hit, options.toleranceM)) return { proposal: p, overlapM2: turfRef.area(hit) || 0 };
            }
        } catch (error) {
            // A clip that could not be done refuses the take; it is not "no road here".
            if (error && error.name === 'ClipFailure') throw error;
            console.warn('[_appliedRoadOverlappedByTaking] road-overlap pre-check failed', error);
        }
        return null;
    },
    };
});
