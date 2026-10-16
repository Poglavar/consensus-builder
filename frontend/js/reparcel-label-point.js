// Where a new plot's number goes in the land readjustment designer: the clearest spot inside the
// plot, away from its edges and nodes first and from the faint guide lines (old parcels, building
// outlines) second. Pure: GeoJSON lng/lat in, [lng, lat] out; the caller gives the label's radius
// in metres at the current zoom.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReparcelLabelPoint = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const M_PER_DEG_LAT = 110540;
    const M_PER_DEG_LNG = 111320;
    // Weights of the score; their sum is the score's Lipschitz bound, which the search relies on.
    const HARD_CAP = 2;      // edge clearance beyond two label radii adds only the mild term below
    const MORE_ROOM = 0.25;  // ...so a big plot still puts its number in its visual middle
    const SOFT = 0.75;       // stepping off a guide line, up to one label radius
    const CENTRAL = 0.05;    // a strip's number sits mid-strip rather than at one end
    const NODE = 0.6;        // a node's handle reaches this many label radii into the plot
    const LIPSCHITZ = 1 + MORE_ROOM + SOFT + CENTRAL;
    const MAX_VISITS = 1500;

    const polygonsOf = geometry => geometry?.type === 'Polygon' ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];

    function segmentDistance(p, a, b) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
        return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    }

    function inRing(p, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
    }

    const segmentsOf = rings => rings.flatMap(ring => ring.slice(1).map((b, i) => [ring[i], b]));
    const nearestSegment = (p, segments) => segments.reduce((best, [a, b]) => Math.min(best, segmentDistance(p, a, b)), Infinity);
    const nearestPoint = (p, points) => points.reduce((best, q) => Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1])), Infinity);

    // One polygon (outer ring + holes) in local metres; returns the best { point, score }.
    function bestInPolygon(rings, guides, radius) {
        const outer = rings[0];
        const edges = segmentsOf(rings);
        const nodes = rings.flatMap(ring => ring.slice(1));
        const xs = outer.map(p => p[0]), ys = outer.map(p => p[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const span = Math.max(maxX - minX, maxY - minY);
        if (!(span > 0)) return null;
        // Only the guide lines that can reach a label inside this plot.
        const reach = radius * 2;
        const near = guides.filter(([a, b]) => Math.max(a[0], b[0]) >= minX - reach && Math.min(a[0], b[0]) <= maxX + reach
            && Math.max(a[1], b[1]) >= minY - reach && Math.min(a[1], b[1]) <= maxY + reach);
        const centre = nodes.reduce((sum, p) => [sum[0] + p[0] / nodes.length, sum[1] + p[1] / nodes.length], [0, 0]);
        const evaluate = (point, half) => {
            const inside = inRing(point, outer) && !rings.slice(1).some(ring => inRing(point, ring));
            const edge = nearestSegment(point, edges) * (inside ? 1 : -1);
            const clearance = Math.min(edge, nearestPoint(point, nodes) - NODE * radius);
            const soft = near.length ? Math.min(nearestSegment(point, near), radius) : radius;
            const score = Math.min(clearance, HARD_CAP * radius) + MORE_ROOM * clearance + SOFT * soft
                - CENTRAL * Math.hypot(point[0] - centre[0], point[1] - centre[1]);
            // Outside the plot never wins, but the bound still uses the plain score, which is
            // what keeps the search exact near the edges.
            return { point, half, value: inside ? score : -Infinity, potential: score + LIPSCHITZ * half * Math.SQRT2 };
        };
        let best = { point: null, value: -Infinity };
        // Seeds just inside each edge, so a thin or bent plot has a candidate before the grid finds one.
        const winding = Math.sign(outer.slice(1).reduce((sum, p, i) => sum + (outer[i][0] * p[1] - p[0] * outer[i][1]), 0)) || 1;
        for (let i = 1; i < outer.length; i++) {
            const a = outer[i - 1], b = outer[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (!len) continue;
            const offset = Math.min(len / 4, span / 20);
            const seed = evaluate([(a[0] + b[0]) / 2 - (b[1] - a[1]) / len * winding * offset, (a[1] + b[1]) / 2 + (b[0] - a[0]) / len * winding * offset], 0);
            if (seed.value > best.value) best = seed;
        }
        const precision = Math.max(span / 400, radius / 20);
        const queue = [evaluate([(minX + maxX) / 2, (minY + maxY) / 2], span / 2)];
        for (let visits = 0; queue.length && visits < MAX_VISITS; visits++) {
            let top = 0;
            for (let i = 1; i < queue.length; i++) if (queue[i].potential > queue[top].potential) top = i;
            const cell = queue[top];
            queue[top] = queue[queue.length - 1];
            queue.pop();
            if (cell.value > best.value) best = cell;
            if (cell.potential - best.value <= precision) continue;
            const half = cell.half / 2;
            for (const dx of [-half, half]) for (const dy of [-half, half]) queue.push(evaluate([cell.point[0] + dx, cell.point[1] + dy], half));
        }
        return best.point ? { point: best.point, score: best.value } : null;
    }

    // geometry: the plot (Polygon or MultiPolygon). guides: GeoJSON geometries whose outlines the
    // label should avoid if it can. radiusM: the label's radius in metres at the current zoom.
    function labelPoint(geometry, { guides = [], radiusM = 1 } = {}) {
        const polygons = polygonsOf(geometry).filter(rings => rings[0]?.length >= 4);
        if (!polygons.length) return null;
        const first = polygons[0][0][0];
        const lat0 = first[1], lng0 = first[0], cos = Math.cos(lat0 * Math.PI / 180);
        const toLocal = ([lng, lat]) => [(lng - lng0) * M_PER_DEG_LNG * cos, (lat - lat0) * M_PER_DEG_LAT];
        const toLngLat = ([x, y]) => [lng0 + x / (M_PER_DEG_LNG * cos), lat0 + y / M_PER_DEG_LAT];
        const guideSegments = guides.flatMap(g => polygonsOf(g).flatMap(rings => segmentsOf(rings.map(ring => ring.map(toLocal)))));
        const radius = radiusM > 0 ? radiusM : 1;
        let best = null;
        for (const rings of polygons) {
            const found = bestInPolygon(rings.map(ring => ring.map(toLocal)), guideSegments, radius);
            if (found && (!best || found.score > best.score)) best = found;
        }
        return best ? toLngLat(best.point) : null;
    }

    return { labelPoint };
});
