// Does an edit to a parcellation's plots leave a layout? Each edit owns its whole result: moving,
// inserting and removing a shared node keep the plots tiling the pool on their own, because every
// plot on a boundary carries the same node (plot-topology.js), and cuts and carves account for
// every piece they make. Nothing tidies up after an edit. checkTiling confirms the edit kept the
// invariant — the plots cover the land they covered before, once each, and none folds over itself —
// and a failure means the edit is refused, never patched: dragging a node across a neighbour's
// boundary folds a plot, and that drag simply does not happen.
//
// turf is injected so this stays testable without a browser.
(function (global, factory) {
    'use strict';
    const api = factory();
    if (typeof window !== 'undefined') window.__plotEdit = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Whether an overlap, a gap or a part outside is land or debris from the boolean operations is
    // the shared rule (geometry-tolerances.js isGround), the one the apply checks with.
    function groundApi() {
        return (typeof window !== 'undefined' && window.GeometryTolerances)
            || (typeof require === 'function' ? require('../geometry-tolerances.js') : null);
    }

    function feature(geometry) {
        if (!geometry) return null;
        if (geometry.type === 'Feature') return geometry.geometry ? geometry : null;
        return { type: 'Feature', properties: {}, geometry };
    }

    function geometryOf(value) {
        if (!value) return null;
        if (value.type === 'Feature') return value.geometry || null;
        if (value.geometry && value.type === undefined) return value.geometry;
        return value;
    }

    function area(turf, geometry) {
        return geometry ? Math.abs(turf.area(feature(geometry))) : 0;
    }

    // The shared parcel clip (parcel-arrangement.js clipWith) with the injected turf: the same grid
    // as every other stage, and a failure is a typed ClipFailure.
    function clipWith(turf, operation, a, b) {
        const api = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('./parcel-arrangement.js') : null);
        return api.clipWith(turf, operation, a, b, { site: `plot-edit.${operation}` });
    }

    // turf 6 boolean operations take two features and return a feature, or null when nothing is left.
    function intersect(turf, a, b) {
        if (!a || !b) return null;
        return geometryOf(clipWith(turf, 'intersect', feature(a), feature(b)));
    }

    function difference(turf, a, b) {
        if (!a) return null;
        if (!b) return a;
        return geometryOf(clipWith(turf, 'difference', feature(a), feature(b)));
    }

    function unionAll(turf, geometries) {
        let union = null;
        for (const geometry of geometries) {
            if (!geometry) continue;
            union = union ? geometryOf(clipWith(turf, 'union', feature(union), feature(geometry))) : geometry;
        }
        return union;
    }

    function boxesMeet(turf, a, b) {
        if (!a || !b) return false;
        const x = turf.bbox(feature(a));
        const y = turf.bbox(feature(b));
        return !(x[2] < y[0] || y[2] < x[0] || x[3] < y[1] || y[3] < x[1]);
    }

    function changedIndices(before, after) {
        const indices = [];
        const count = Math.max(before.length, after.length);
        for (let i = 0; i < count; i++) {
            if (JSON.stringify(before[i] || null) !== JSON.stringify(after[i] || null)) indices.push(i);
        }
        return indices;
    }

    // The plots an edit can have affected: the ones it changed, and the ones whose bounds meet where
    // a changed plot was or now is.
    function affectedIndices(turf, before, after, changed) {
        const affected = new Set(changed);
        const seeds = [];
        changed.forEach(index => {
            if (before[index]) seeds.push(before[index]);
            if (after[index]) seeds.push(after[index]);
        });
        const count = Math.max(before.length, after.length);
        for (let i = 0; i < count; i++) {
            if (affected.has(i)) continue;
            const geometry = after[i] || before[i];
            if (seeds.some(seed => boxesMeet(turf, seed, geometry))) affected.add(i);
        }
        return Array.from(affected).sort((a, b) => a - b);
    }

    /**
     * Did the edit keep the plots tiling the land they held? `before` and `after` are aligned index
     * for index: after[i] null is a plot the edit dissolved, before[i] null is one it created. Only
     * the plots the edit could have reached are checked. With `pool`, the whole layout is checked
     * against it instead, for edits that rebuild the list (a carve) and have no aligned predecessor.
     * An overlap, gap or part outside fails the check when it is ground (geometry-tolerances.js).
     * Returns { ok, folded: [i], gap, overlap, outside, overlaps: [[i, j, m²]] }, areas in m².
     */
    function checkTiling(before, after, deps, options) {
        const turf = deps && deps.turf;
        const opts = options || {};
        const isGround = geometry => !!geometry && groundApi().isGround(turf, feature(geometry));
        const to = (after || []).map(geometryOf);
        let indices;
        let held;
        if (opts.pool) {
            indices = to.map((_, index) => index);
            held = geometryOf(opts.pool);
        } else {
            const from = (before || []).map(geometryOf);
            const changed = changedIndices(from, to);
            if (!changed.length) return { ok: true, folded: [], gap: 0, overlap: 0, outside: 0, overlaps: [] };
            indices = affectedIndices(turf, from, to, changed);
            held = unionAll(turf, indices.map(index => from[index]));
        }
        // A self-intersecting ring has no meaningful area, so a fold is reported before any measuring.
        const folded = indices.filter(index => to[index] && turf.kinks(feature(to[index])).features.length > 0);
        if (folded.length) return { ok: false, folded, gap: 0, overlap: 0, outside: 0, overlaps: [] };
        const plots = indices.map(index => to[index]).filter(Boolean);
        const overlaps = [];
        let overlap = 0;
        for (let i = 0; i < indices.length; i++) {
            for (let j = i + 1; j < indices.length; j++) {
                const a = to[indices[i]];
                const b = to[indices[j]];
                if (!a || !b || !boxesMeet(turf, a, b)) continue;
                const sharedGeometry = intersect(turf, a, b);
                const shared = area(turf, sharedGeometry);
                if (isGround(sharedGeometry)) overlaps.push([indices[i], indices[j], shared]);
                overlap += shared;
            }
        }
        const covered = unionAll(turf, plots);
        const outsideGeometry = difference(turf, covered, held);
        const gapGeometry = difference(turf, held, covered);
        const ok = overlaps.length === 0 && !isGround(outsideGeometry) && !isGround(gapGeometry);
        return { ok, folded, gap: area(turf, gapGeometry), overlap, outside: area(turf, outsideGeometry), overlaps };
    }

    // How much land an edit actually moved, per plot. An edit still has to be REPORTABLE: removing a
    // node where three plots meet transferred 3,940 m² between owners with nothing on screen to say
    // so, and the only evidence was a number in a list that had quietly changed.
    function areaShift(before, after, deps) {
        const turf = deps && deps.turf;
        const from = (Array.isArray(before) ? before : []).map(geometryOf);
        const to = (Array.isArray(after) ? after : []).map(geometryOf);
        const perPlot = [];
        let moved = 0;
        const dissolved = [];
        if (!turf) return { perPlot, moved, dissolved };
        const count = Math.max(from.length, to.length);
        for (let index = 0; index < count; index++) {
            const was = area(turf, from[index]);
            const now = area(turf, to[index]);
            const delta = now - was;
            if (was > 0 && !to[index]) dissolved.push(index);
            if (Math.abs(delta) < 1e-6) continue;
            perPlot.push({ index, before: was, after: now, delta });
            // Land taken from one plot and given to another is counted once, not twice.
            if (delta > 0) moved += delta;
        }
        perPlot.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
        return { perPlot, moved, dissolved };
    }

    return { checkTiling, areaShift };
});
