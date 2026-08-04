// Keep a parcellation tiling its pool, by REPAIR rather than by refusal.
//
// The editor used to answer an edit that would tear the layout by declining it — "that node is
// where three plots meet, removing it would leave land belonging to none of them". That is the
// wrong answer. Removing a boundary node is not an error: the boundary it helped define simply
// stops existing, and the land goes to whatever plot remains around it. Remove every node and you
// should be left with one plot covering the whole pool, not a wall of refusals.
//
// So the invariant is enforced here instead: after any geometry change, the plots are clipped to
// the pool, overlaps are resolved, and any land left over is absorbed into the plot it borders
// most. Land is never orphaned, and no edit has to be forbidden to keep that true.
//
// turf is injected rather than imported so this stays testable without a browser.
(function (global, factory) {
    'use strict';
    const api = factory();
    if (typeof window !== 'undefined') window.__plotHeal = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Slivers below this are rounding, not land. Absorbing them individually would cost more than
    // it is worth, and they are invisible at any usable zoom.
    const DEFAULT_MIN_PIECE_M2 = 0.5;

    function feature(geometry) {
        if (!geometry) return null;
        if (geometry.type === 'Feature') return geometry.geometry ? geometry : null;
        return { type: 'Feature', properties: {}, geometry };
    }

    function geometryOf(value) {
        if (!value) return null;
        if (value.type === 'Feature') return value.geometry || null;
        return value;
    }

    // Split a MultiPolygon into its parts so each piece can be attached to its own neighbour — a
    // gap that appears in two places is two decisions, not one.
    function explode(turf, geometry) {
        const geom = geometryOf(geometry);
        if (!geom) return [];
        if (geom.type === 'Polygon') return [geom];
        if (geom.type === 'MultiPolygon') {
            return (geom.coordinates || []).map(coordinates => ({ type: 'Polygon', coordinates }));
        }
        return [];
    }

    function safeArea(turf, geometry) {
        const f = feature(geometry);
        if (!f) return 0;
        try { return turf.area(f) || 0; } catch (_) { return 0; }
    }

    function safeIntersect(turf, a, b) {
        try { return geometryOf(turf.intersect(feature(a), feature(b))); } catch (_) { return null; }
    }

    function safeDifference(turf, a, b) {
        try { return geometryOf(turf.difference(feature(a), feature(b))); } catch (_) { return null; }
    }

    function safeUnion(turf, a, b) {
        try { return geometryOf(turf.union(feature(a), feature(b))); } catch (_) { return null; }
    }

    function unionAll(turf, geometries) {
        let acc = null;
        for (const geometry of geometries) {
            if (!geometry) continue;
            if (!acc) { acc = geometry; continue; }
            acc = safeUnion(turf, acc, geometry) || acc;
        }
        return acc;
    }

    // Which existing plot should swallow this leftover piece? The one it shares the most boundary
    // with — measured by how much of the piece a small buffer of the plot covers, which is robust
    // to the near-misses that produced the gap in the first place.
    function bestNeighbourFor(turf, piece, geometries, options) {
        const pieceArea = safeArea(turf, piece);
        if (!pieceArea) return -1;
        let bestIndex = -1;
        let bestScore = 0;
        // Grow the piece slightly so a plot that merely touches its edge still registers.
        let probe = piece;
        try {
            const grown = turf.buffer(feature(piece), (options && options.probeMeters) || 0.5, { units: 'meters' });
            if (grown && grown.geometry) probe = grown.geometry;
        } catch (_) { /* buffering is an optimisation, not a requirement */ }
        geometries.forEach((geometry, index) => {
            if (!geometry) return;
            const shared = safeIntersect(turf, probe, geometry);
            const score = shared ? safeArea(turf, shared) : 0;
            if (score > bestScore) { bestScore = score; bestIndex = index; }
        });
        if (bestIndex >= 0) return bestIndex;
        // Nothing touches it (an island). Give it to the largest plot rather than dropping it.
        let largest = -1;
        let largestArea = 0;
        geometries.forEach((geometry, index) => {
            const area = safeArea(turf, geometry);
            if (area > largestArea) { largestArea = area; largest = index; }
        });
        return largest;
    }

    // Clip to the pool, resolve overlaps, absorb leftovers. Returns new geometries in the same
    // order as the input; a plot that ends up with nothing at all becomes null, which the caller
    // reads as "this plot has been dissolved into its neighbours".
    function healTiling(geometries, pool, deps, options) {
        const turf = (deps && deps.turf) || (typeof window !== 'undefined' ? window.turf : null);
        const opts = options || {};
        const minPiece = Number.isFinite(opts.minPieceM2) ? opts.minPieceM2 : DEFAULT_MIN_PIECE_M2;
        const list = (Array.isArray(geometries) ? geometries : []).map(geometryOf);
        const poolGeometry = geometryOf(pool);
        if (!turf || !poolGeometry || !list.length) {
            return { geometries: list, changed: false, clipped: 0, overlaps: 0, gapsFilled: 0, gapArea: 0 };
        }

        let clipped = 0;
        let overlaps = 0;
        let gapsFilled = 0;
        let gapArea = 0;

        // 1. Nothing may lie outside the pool.
        const inside = list.map(geometry => {
            if (!geometry) return null;
            const within = safeIntersect(turf, geometry, poolGeometry);
            if (!within) return null;
            if (safeArea(turf, within) + 1e-9 < safeArea(turf, geometry)) clipped++;
            return within;
        });

        // 2. No two plots may claim the same land. Earlier plots keep it; later ones give it up.
        const resolved = [];
        let accumulated = null;
        inside.forEach(geometry => {
            if (!geometry) { resolved.push(null); return; }
            if (!accumulated) {
                resolved.push(geometry);
                accumulated = geometry;
                return;
            }
            const overlap = safeIntersect(turf, geometry, accumulated);
            if (overlap && safeArea(turf, overlap) > minPiece) {
                overlaps++;
                const trimmed = safeDifference(turf, geometry, accumulated);
                resolved.push(trimmed);
                if (trimmed) accumulated = safeUnion(turf, accumulated, trimmed) || accumulated;
                return;
            }
            resolved.push(geometry);
            accumulated = safeUnion(turf, accumulated, geometry) || accumulated;
        });

        // 3. Whatever is still unclaimed goes to the plot it borders most. This is the step that
        //    makes removing a node safe: the boundary disappears and the land joins its neighbour.
        const covered = accumulated || unionAll(turf, resolved.filter(Boolean));
        if (covered) {
            const leftover = safeDifference(turf, poolGeometry, covered);
            explode(turf, leftover).forEach(piece => {
                const area = safeArea(turf, piece);
                if (area < minPiece) return;
                const index = bestNeighbourFor(turf, piece, resolved, opts);
                if (index < 0) return;
                const merged = resolved[index] ? safeUnion(turf, resolved[index], piece) : piece;
                if (!merged) return;
                resolved[index] = merged;
                gapsFilled++;
                gapArea += area;
            });
        }

        const changed = clipped > 0 || overlaps > 0 || gapsFilled > 0
            || resolved.some((geometry, index) => !geometry !== !list[index]);
        return { geometries: resolved, changed, clipped, overlaps, gapsFilled, gapArea };
    }

    return { healTiling, DEFAULT_MIN_PIECE_M2 };
});
