// Additive corridor growth. A drawing that connects to an existing road MERGES INTO that road:
// the established proposal keeps its identity and stays applied, and only the ground the corridor
// NEWLY covers is re-formed. Nothing already on the map is unapplied and re-derived, so no slice
// is re-minted and no other proposal is disturbed (rethink-proposals.md §15.1 — drawing is
// additive; only the affected parcels are touched).
// Pure: geometry and plain records in, a plan out. The caller performs the map/storage mutation
// (proposals/apply/road-grow.js).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (root) root.__corridorGrow = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Below this, a "piece" is a sliver of floating-point noise along a shared edge, not ground.
    const MIN_PIECE_AREA_M2 = 1;

    function timeOf(proposal) {
        const parsed = proposal && proposal.createdAt ? Date.parse(proposal.createdAt) : NaN;
        // An undated record cannot claim seniority over a dated one.
        return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
    }

    // The new stroke merges INTO the established road, never the other way round: the host is the
    // OLDEST body the drawing touched. It keeps its proposalId, its name, its terms, its
    // acceptances and — crucially — its applied fabric; everything else folds into it.
    function pickMergeHost(proposals) {
        const list = (Array.isArray(proposals) ? proposals : []).filter(Boolean);
        if (!list.length) return null;
        let host = list[0];
        let best = timeOf(host);
        for (let i = 1; i < list.length; i += 1) {
            const t = timeOf(list[i]);
            if (t < best) { host = list[i]; best = t; }
        }
        return host;
    }

    // Order the touched bodies host-first, so a merged definition is built by extending the
    // established road rather than by rebuilding it behind the newcomer.
    function orderHostFirst(proposals, host) {
        const list = (Array.isArray(proposals) ? proposals : []).filter(Boolean);
        if (!host) return list.slice();
        return [host, ...list.filter(p => p !== host)];
    }

    function featureOf(geometry) {
        if (!geometry || !geometry.type) return null;
        if (geometry.type === 'Feature') return geometry.geometry ? geometry : null;
        return { type: 'Feature', properties: {}, geometry };
    }

    function geometryOf(feature) {
        if (!feature) return null;
        if (feature.type === 'Feature') return feature.geometry || null;
        return feature.type ? feature : null;
    }

    function areaOf(geometry, turf) {
        const feature = featureOf(geometry);
        if (!feature || !turf || typeof turf.area !== 'function') return 0;
        try { return turf.area(feature) || 0; } catch (_) { return 0; }
    }

    // One entry per contiguous polygon: a parcel is ONE piece of ground, so a cut that lands in
    // two disconnected places mints two parcels (the same rule the id subsystem enforces).
    function geometryPieces(geometry, turf, minAreaM2 = MIN_PIECE_AREA_M2) {
        const geom = geometryOf(geometry);
        if (!geom) return [];
        const polygons = geom.type === 'Polygon' ? [geom.coordinates]
            : (geom.type === 'MultiPolygon' ? geom.coordinates : []);
        return polygons
            .map(rings => ({ coords: rings, area: areaOf({ type: 'Polygon', coordinates: rings }, turf) }))
            .filter(piece => Array.isArray(piece.coords[0]) && piece.coords[0].length >= 4 && piece.area >= minAreaM2)
            .sort((a, b) => b.area - a.area);
    }

    function unionGeometries(geometries, turf) {
        const parts = (Array.isArray(geometries) ? geometries : []).map(featureOf).filter(Boolean);
        if (!parts.length || !turf || typeof turf.union !== 'function') return null;
        let merged = parts[0];
        for (let i = 1; i < parts.length; i += 1) {
            try {
                const next = turf.union(merged, parts[i]);
                if (next) merged = next;
            } catch (_) { /* keep what merged so far */ }
        }
        return geometryOf(merged);
    }

    // The ground the grown corridor covers that its previous footprints did not: the ONLY ground a
    // merge has to re-form. Returns null when the drawing adds nothing (it ran entirely inside the
    // roads it joined), which is a legitimate no-op rather than an error.
    //
    // The bodies being merged are re-outlined as ONE network, so the union's edge wanders by
    // millimetres against the outlines it replaces. Growing the old ground by `edgeToleranceM`
    // before subtracting keeps that redrawing out of the delta: without it a merge mints
    // hair-thin corridor parcels down the length of the road it joined, and re-cuts parcels it
    // never actually took ground from.
    function newGroundGeometry(newSurface, existingSurfaces, turf, edgeToleranceM = 0.1) {
        const target = featureOf(newSurface);
        if (!target) return null;
        const existing = unionGeometries(existingSurfaces, turf);
        if (!existing) return geometryOf(target);
        if (!turf || typeof turf.difference !== 'function') return null;
        let held = featureOf(existing);
        if (edgeToleranceM > 0 && typeof turf.buffer === 'function') {
            try {
                const grown = turf.buffer(held, edgeToleranceM, { units: 'meters' });
                if (grown && grown.geometry) held = grown;
            } catch (_) { /* an unbuffered subtraction still beats no answer */ }
        }
        let delta = null;
        try { delta = turf.difference(target, held); } catch (_) { return null; }
        const geom = geometryOf(delta);
        if (!geom) return null;
        return areaOf(geom, turf) >= MIN_PIECE_AREA_M2 ? geom : null;
    }

    /**
     * How the live fabric under `newGround` is re-formed.
     *
     * @param {object} input
     * @param {object} input.newGround  GeoJSON geometry — the corridor's new ground
     * @param {Array}  input.parcels    [{ id, geometry }] — the VISIBLE parcels near it
     * @param {object} input.turf
     * @param {number} [input.minAreaM2]
     * @returns {{corridorPieces: Array, cuts: Array}} corridorPieces become the corridor's own new
     *          parcels; each cut names a parcel the corridor takes ground from, with the remainder
     *          pieces its owner keeps (empty when the corridor consumes it whole).
     */
    function planCorridorGrowth(input) {
        const opts = input || {};
        const turf = opts.turf;
        const minAreaM2 = Number.isFinite(opts.minAreaM2) ? opts.minAreaM2 : MIN_PIECE_AREA_M2;
        const ground = featureOf(opts.newGround);
        const empty = { corridorPieces: [], cuts: [] };
        if (!ground || !turf || typeof turf.intersect !== 'function' || typeof turf.difference !== 'function') {
            return empty;
        }

        const cuts = [];
        (Array.isArray(opts.parcels) ? opts.parcels : []).forEach(parcel => {
            const parcelFeature = featureOf(parcel && parcel.geometry);
            if (!parcel || !parcel.id || !parcelFeature) return;

            let overlap = null;
            try { overlap = turf.intersect(parcelFeature, ground); } catch (_) { return; }
            const takenArea = areaOf(geometryOf(overlap), turf);
            // Touching along an edge is not taking ground: leave the parcel exactly as it is.
            if (takenArea < minAreaM2) return;

            let remainder = null;
            try { remainder = turf.difference(parcelFeature, ground); } catch (_) { remainder = null; }
            const remainders = geometryPieces(geometryOf(remainder), turf, minAreaM2);
            cuts.push({
                parcelId: String(parcel.id),
                takenArea,
                consumed: remainders.length === 0,
                remainders
            });
        });

        return { corridorPieces: geometryPieces(geometryOf(ground), turf, minAreaM2), cuts };
    }

    // Continue this proposal's slice numbering instead of restarting at 1 — a grown road keeps its
    // existing children, so a fresh count would mint ids that collide with them.
    function nextSyntheticIndexByRoot(existingIds, token) {
        const next = {};
        const safeToken = token === undefined || token === null ? '' : String(token);
        if (!safeToken) return next;
        (Array.isArray(existingIds) ? existingIds : []).forEach(raw => {
            const id = raw === undefined || raw === null ? '' : String(raw);
            const marker = '#' + safeToken + '-';
            const at = id.lastIndexOf(marker);
            if (at <= 0) return;
            const root = id.slice(0, at);
            const index = Number(id.slice(at + marker.length));
            if (!root || !Number.isFinite(index)) return;
            next[root] = Math.max(next[root] || 1, index + 1);
        });
        return next;
    }

    return {
        MIN_PIECE_AREA_M2,
        pickMergeHost,
        orderHostFirst,
        geometryPieces,
        unionGeometries,
        newGroundGeometry,
        planCorridorGrowth,
        nextSyntheticIndexByRoot
    };
});
