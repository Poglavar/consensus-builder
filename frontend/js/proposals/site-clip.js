// Keep generated geometry inside its source site EXACTLY (PARCEL-OPTIONAL.md: a design traced from
// parcels must bind exactly those parcels at tolerance 0). Generators that need a healing ±buffer or a
// projection round trip finish here: the result is intersected, in WGS84, with the exact site, so
// every vertex on the boundary comes from the site itself instead of from turf.buffer's arcs.
//
// Pure: no DOM. `turf` is options.turf, the browser global, globalThis.turf, or require('@turf/turf').
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__siteClip = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // Holes in a union of abutting parcels narrower than this are cadastral micro-gaps (nobody's
    // ground), not enclosed neighbours; robustUnion's ±0.1 m dissolve buffer heals exactly these.
    const MICRO_GAP_WIDTH_M = 0.2;

    function T(options) {
        if (options && options.turf) return options.turf;
        if (typeof turf !== 'undefined' && turf) return turf; // eslint-disable-line no-undef
        if (global && global.turf) return global.turf;
        try { return typeof require === 'function' ? require('@turf/turf') : null; } catch (_) { return null; }
    }

    function geometryOf(value) {
        const g = value && value.type === 'Feature' ? value.geometry : value;
        return g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? g : null;
    }

    function polygonsOf(geometry) {
        const g = geometryOf(geometry);
        if (!g) return [];
        return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    }

    function fromPolygons(polygons, properties) {
        if (!polygons.length) return null;
        const geometry = polygons.length === 1
            ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons };
        return { type: 'Feature', properties: properties || {}, geometry };
    }

    // Remove repeated vertices and zero-width spikes (a vertex where the ring turns straight back on
    // itself). Polygon clipping leaves such spikes along shared edges; they enclose no ground but make
    // JSTS (turf.buffer) reject the polygon. Planar test in degrees scaled by cos(lat).
    function despikeRing(ring) {
        if (!Array.isArray(ring) || ring.length < 4) return null;
        let pts = ring.slice(0, -1);
        const k = Math.cos(((pts[0] && pts[0][1]) || 0) * Math.PI / 180);
        const same = (a, b) => Math.abs((a[0] - b[0]) * k) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;
        let changed = true;
        while (changed && pts.length >= 3) {
            changed = false;
            const out = [];
            for (const p of pts) if (!out.length || !same(out[out.length - 1], p)) out.push(p);
            while (out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
            if (out.length !== pts.length) changed = true;
            pts = out;
            for (let i = 0; i < pts.length && pts.length >= 3; i++) {
                const a = pts[(i - 1 + pts.length) % pts.length];
                const b = pts[i];
                const c = pts[(i + 1) % pts.length];
                const ux = (b[0] - a[0]) * k, uy = b[1] - a[1];
                const vx = (c[0] - b[0]) * k, vy = c[1] - b[1];
                const cross = ux * vy - uy * vx;
                const dot = ux * vx + uy * vy;
                const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
                if (dot < 0 && Math.abs(cross) <= 1e-9 * lu * lv) {
                    pts.splice(i, 1);
                    changed = true;
                    i--;
                }
            }
        }
        if (pts.length < 3) return null;
        return pts.concat([pts[0].slice()]);
    }

    function despike(value) {
        const feature = value && value.type === 'Feature' ? value : { type: 'Feature', properties: {}, geometry: value };
        const polygons = [];
        for (const rings of polygonsOf(feature)) {
            const shell = despikeRing(rings[0]);
            if (!shell) continue;
            polygons.push([shell, ...rings.slice(1).map(despikeRing).filter(Boolean)]);
        }
        return fromPolygons(polygons, feature.properties);
    }

    // Plain union (no buffer): the vertices of the result are the parcels' own vertices and the exact
    // intersections of their edges. null when any piece fails to union (the caller decides).
    function exactUnion(features, options) {
        const t = T(options);
        if (!t) throw new Error('site-clip: turf is not available');
        let acc = null;
        for (const raw of features || []) {
            const g = geometryOf(raw);
            if (!g) continue;
            const f = { type: 'Feature', properties: {}, geometry: g };
            if (!acc) { acc = f; continue; }
            let next = null;
            try { next = t.union(acc, f); } catch (_) { return null; }
            if (!next || !next.geometry) return null;
            acc = next;
        }
        return acc ? despike(acc) : null;
    }

    // Fill holes no wider than `maxWidthM` (micro-gaps between abutting parcels); keep real holes
    // (an enclosed parcel that is not part of the site).
    function fillMicroHoles(feature, options) {
        const t = T(options);
        const maxWidthM = options && Number.isFinite(options.maxWidthM) ? options.maxWidthM : MICRO_GAP_WIDTH_M;
        const polygons = polygonsOf(feature).map(rings => [rings[0], ...rings.slice(1).filter(hole => {
            let eroded = null;
            try { eroded = t.buffer(t.polygon([hole]), -maxWidthM / 2, { units: 'meters' }); } catch (_) { eroded = null; }
            return !!(eroded && eroded.geometry && t.area(eroded) > 0);
        })]);
        return fromPolygons(polygons, feature && feature.properties);
    }

    // The exact site of a set of parcels: their plain union with micro-gaps filled.
    function siteOfParcels(features, options) {
        const union = exactUnion(features, options);
        return union ? fillMicroHoles(union, options) : null;
    }

    // `feature` ∩ `site`, in WGS84, keeping `feature`'s properties. null when nothing is left.
    function clipToSite(feature, site, options) {
        const t = T(options);
        if (!t) throw new Error('site-clip: turf is not available');
        const g = geometryOf(feature);
        const s = geometryOf(site);
        if (!g || !s) return null;
        const clipped = t.intersect({ type: 'Feature', properties: {}, geometry: g }, { type: 'Feature', properties: {}, geometry: s });
        if (!clipped || !clipped.geometry) return null;
        const cleaned = despike(clipped);
        if (!cleaned || !(t.area(cleaned) > 0)) return null;
        cleaned.properties = Object.assign({}, (feature && feature.properties) || {});
        return cleaned;
    }

    return { MICRO_GAP_WIDTH_M, despikeRing, despike, exactUnion, fillMicroHoles, siteOfParcels, clipToSite };
});
