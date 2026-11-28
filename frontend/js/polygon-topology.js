// Ring topology of a polygon, the OGC simple-features rule: each ring is simple, and separate rings
// of one polygon may meet only at single points, without crossing there and without cutting the
// polygon's interior apart. A site merged from parcels has holes touching its outline at a corner,
// which is valid; Turf's kinks reports every such touch as a self-intersection.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PolygonTopology = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const CROSSING = 'Polygon boundaries intersect themselves.';
    const SHARED_EDGE = 'Polygon rings share an edge.';
    const CUT_APART = 'Polygon rings touch at more than one point and cut the polygon apart.';

    const key = point => `${point[0]},${point[1]}`;
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    // Sign of the turn a → b → c, measured from a so nearby coordinates subtract exactly.
    function orient(a, b, c) {
        const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        return value > 0 ? 1 : value < 0 ? -1 : 0;
    }
    // c lies on segment a–b, given that the three are collinear.
    const within = (a, b, c) => Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0])
        && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);

    // A ring's distinct vertices in order, open, without repeated consecutive points.
    function openRing(ring) {
        const points = [];
        for (const point of ring) if (!points.length || !same(points[points.length - 1], point)) points.push(point);
        if (points.length > 1 && same(points[0], points[points.length - 1])) points.pop();
        return points;
    }

    // How two segments meet: null, { error }, or { point } where they touch at one point.
    function meet(s, t) {
        const o1 = orient(s.a, s.b, t.a), o2 = orient(s.a, s.b, t.b);
        const o3 = orient(t.a, t.b, s.a), o4 = orient(t.a, t.b, s.b);
        if (o1 === 0 && o2 === 0) {
            // Collinear: apart, touching end to end, or overlapping along a stretch.
            const along = Math.abs(s.b[0] - s.a[0]) >= Math.abs(s.b[1] - s.a[1]) ? 0 : 1;
            const lo = Math.max(Math.min(s.a[along], s.b[along]), Math.min(t.a[along], t.b[along]));
            const hi = Math.min(Math.max(s.a[along], s.b[along]), Math.max(t.a[along], t.b[along]));
            if (lo > hi) return null;
            if (lo < hi) return { error: SHARED_EDGE };
            return { point: [s.a, s.b].find(p => p[along] === lo) };
        }
        if (o1 * o2 < 0 && o3 * o4 < 0) return { error: CROSSING };
        if (o1 === 0 && within(s.a, s.b, t.a)) return { point: t.a };
        if (o2 === 0 && within(s.a, s.b, t.b)) return { point: t.b };
        if (o3 === 0 && within(t.a, t.b, s.a)) return { point: s.a };
        if (o4 === 0 && within(t.a, t.b, s.b)) return { point: s.b };
        return null;
    }

    // The problem with one polygon's rings (shell first, then holes), or null when they are valid.
    function ringsProblem(rawRings) {
        const rings = rawRings.map(openRing);
        if (rings.some(ring => ring.length < 3)) return CROSSING;
        // Orientation decides which side of each edge the polygon's interior lies on.
        const leftInside = rings.map((ring, index) => {
            const origin = ring[0];
            let twice = 0;
            for (let i = 0; i < ring.length; i++) {
                const a = ring[i], b = ring[(i + 1) % ring.length];
                twice += (a[0] - origin[0]) * (b[1] - origin[1]) - (b[0] - origin[0]) * (a[1] - origin[1]);
            }
            return index === 0 ? twice > 0 : twice < 0;
        });
        const segments = [];
        rings.forEach((ring, r) => ring.forEach((a, i) => {
            const b = ring[(i + 1) % ring.length];
            segments.push({ r, i, a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
        }));
        segments.sort((s, t) => s.minX - t.minX);
        // contacts: point key → { point, rings: Map(ring → segment it lies inside, or null for a vertex) }
        const contacts = new Map();
        const vertexAt = rings.map(ring => new Map(ring.map((point, i) => [key(point), i])));
        for (let x = 0; x < segments.length; x++) {
            const s = segments[x];
            for (let y = x + 1; y < segments.length && segments[y].minX <= s.maxX; y++) {
                const t = segments[y];
                if (t.minY > s.maxY || t.maxY < s.minY) continue;
                if (s.r === t.r) {
                    const n = rings[s.r].length;
                    const next = (s.i + 1) % n === t.i, previous = (t.i + 1) % n === s.i;
                    if (next || previous) {
                        // Neighbours share a vertex; they may not fold back along each other.
                        const [first, second] = next ? [s, t] : [t, s];
                        if (orient(first.a, first.b, second.b) === 0
                            && (first.a[0] - first.b[0]) * (second.b[0] - first.b[0]) + (first.a[1] - first.b[1]) * (second.b[1] - first.b[1]) > 0) return CROSSING;
                        continue;
                    }
                }
                const hit = meet(s, t);
                if (!hit) continue;
                if (hit.error) return hit.error;
                if (s.r === t.r) return CROSSING;
                const id = key(hit.point);
                if (!contacts.has(id)) contacts.set(id, { point: hit.point, rings: new Map() });
                const contact = contacts.get(id);
                for (const segment of [s, t]) {
                    if (vertexAt[segment.r].has(id)) contact.rings.set(segment.r, null);
                    else if (!contact.rings.has(segment.r)) contact.rings.set(segment.r, segment);
                }
            }
        }
        // At each contact the rings' edges must alternate interior and exterior around the point:
        // otherwise two rings cross there, or a hole touches the outline from outside it.
        const parent = new Map();
        const find = node => { while (parent.get(node) !== node) node = parent.get(node); return node; };
        const join = (a, b) => {
            for (const node of [a, b]) if (!parent.has(node)) parent.set(node, node);
            const ra = find(a), rb = find(b);
            if (ra === rb) return false;
            parent.set(ra, rb);
            return true;
        };
        for (const [id, contact] of contacts) {
            const p = contact.point;
            const rays = [];
            for (const [r, segment] of contact.rings) {
                const ring = rings[r];
                let toward, back;
                if (segment) { toward = segment.b; back = segment.a; } else {
                    const i = vertexAt[r].get(id);
                    toward = ring[(i + 1) % ring.length];
                    back = ring[(i - 1 + ring.length) % ring.length];
                }
                // An edge leaving the point has the interior on its left when leftInside.
                rays.push({ to: toward, inside: leftInside[r] });
                rays.push({ to: back, inside: !leftInside[r] });
            }
            rays.forEach(ray => { ray.angle = Math.atan2(ray.to[1] - p[1], ray.to[0] - p[0]); });
            rays.sort((a, b) => a.angle - b.angle);
            for (let i = 0; i < rays.length; i++) {
                const next = rays[(i + 1) % rays.length];
                if (next.angle === rays[i].angle) return SHARED_EDGE;
                if (next.inside === rays[i].inside) return CROSSING;
            }
            // Rings and touch points form a graph; a cycle in it encloses part of the interior.
            for (const r of contact.rings.keys()) if (!join(`p:${id}`, `r:${r}`)) return CUT_APART;
        }
        return null;
    }

    // The problem with a Polygon or MultiPolygon's ring topology, or null when it is valid. Parts of
    // a MultiPolygon are checked one by one; whether they overlap is an area question for the caller.
    function problem(geometry) {
        const g = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
        if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) return 'Use polygon geometry.';
        const parts = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
        for (const rings of parts) {
            const found = ringsProblem(rings);
            if (found) return found;
        }
        return null;
    }

    return { problem, ringsProblem, messages: { CROSSING, SHARED_EDGE, CUT_APART } };
});
