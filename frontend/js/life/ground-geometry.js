// Ground geometry for the 3D model view: the roadbed every street's carriageway covers, as one flat
// triangle list, and the pavement plane everything else stands on ("everything that is not a car
// lane is sidewalk, up to the buildings"). Input is the life graph's carriageway list (centreline
// points and half-width in true metres), so the asphalt is exactly the surface the schematic cars
// drive on; output is plain typed arrays a thin THREE layer uploads. Pure: no DOM, no THREE.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.__groundGeometry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const NODE_SNAP_M = 0.5;      // same vertex snap as life-graph: shared vertices are one junction
    const MITRE_LIMIT = 2;        // a joint sharper than this is bevelled and rounded with a disc
    const DISC_SEGMENTS = 16;
    const MIN_SEGMENT_M = 0.01;

    function nodeKey(x, y) {
        return Math.round(x / NODE_SNAP_M) + ':' + Math.round(y / NODE_SNAP_M);
    }

    // Drop consecutive near-duplicates so no segment has zero length; keep z (0 when absent).
    function dedupe(points) {
        const out = [];
        for (const p of points || []) {
            if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
            const last = out[out.length - 1];
            if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < MIN_SEGMENT_M) continue;
            out.push([p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0]);
        }
        return out;
    }

    // Left and right edge of a ribbon `half` metres each side of a polyline. Joints are mitred so a
    // bend keeps its width; a mitre longer than MITRE_LIMIT × half (sharper than about 120°) is
    // capped and the vertex reported in `capped`, where the caller rounds it with a disc.
    function ribbonEdges(points, half) {
        const n = points.length;
        const normals = [];
        for (let i = 0; i < n - 1; i++) {
            const dx = points[i + 1][0] - points[i][0];
            const dy = points[i + 1][1] - points[i][1];
            const len = Math.hypot(dx, dy) || 1;
            normals.push([-dy / len, dx / len]);
        }
        const left = [], right = [], capped = [];
        for (let i = 0; i < n; i++) {
            let nx, ny, scale = 1;
            if (i === 0) { [nx, ny] = normals[0]; }
            else if (i === n - 1) { [nx, ny] = normals[n - 2]; }
            else {
                const a = normals[i - 1], b = normals[i];
                nx = a[0] + b[0]; ny = a[1] + b[1];
                const len = Math.hypot(nx, ny);
                if (len < 1e-6) { nx = a[0]; ny = a[1]; capped.push(i); }
                else {
                    nx /= len; ny /= len;
                    const cosHalf = Math.max(1e-6, nx * a[0] + ny * a[1]);
                    scale = 1 / cosHalf;
                    if (scale > MITRE_LIMIT) { scale = MITRE_LIMIT; capped.push(i); }
                }
            }
            const p = points[i];
            left.push([p[0] + nx * half * scale, p[1] + ny * half * scale, p[2]]);
            right.push([p[0] - nx * half * scale, p[1] - ny * half * scale, p[2]]);
        }
        return { left, right, capped };
    }

    // Growable triangle list. Every triangle is emitted counter-clockwise seen from above, so a
    // front-side material never culls a quad that a sharp inner bend turned inside out.
    function createTriangleList() {
        const positions = [];
        const indices = [];
        let dropped = 0;
        function vertex(p) { positions.push(p[0], p[1], p[2] || 0); return positions.length / 3 - 1; }
        function triangle(a, b, c) {
            const ax = positions[a * 3], ay = positions[a * 3 + 1];
            const area2 = (positions[b * 3] - ax) * (positions[c * 3 + 1] - ay) - (positions[b * 3 + 1] - ay) * (positions[c * 3] - ax);
            if (Math.abs(area2) < 1e-9) { dropped++; return; }
            if (area2 > 0) indices.push(a, b, c); else indices.push(a, c, b);
        }
        function disc(x, y, z, r) {
            const centre = vertex([x, y, z]);
            const rim = [];
            for (let i = 0; i < DISC_SEGMENTS; i++) {
                const t = (i / DISC_SEGMENTS) * Math.PI * 2;
                rim.push(vertex([x + Math.cos(t) * r, y + Math.sin(t) * r, z]));
            }
            for (let i = 0; i < DISC_SEGMENTS; i++) triangle(centre, rim[i], rim[(i + 1) % DISC_SEGMENTS]);
        }
        function ribbon(points, half) {
            const { left, right, capped } = ribbonEdges(points, half);
            const l = left.map(vertex), r = right.map(vertex);
            for (let i = 0; i < points.length - 1; i++) {
                triangle(l[i], r[i], r[i + 1]);
                triangle(l[i], r[i + 1], l[i + 1]);
            }
            capped.forEach(i => disc(points[i][0], points[i][1], points[i][2], half));
            return capped.length;
        }
        function finish() {
            return {
                positions: new Float32Array(positions),
                indices: new Uint32Array(indices),
                triangles: indices.length / 3,
                dropped
            };
        }
        return { vertex, triangle, disc, ribbon, finish };
    }

    function polylineLength(points) {
        let len = 0;
        for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
        return len;
    }

    // `carriageways`: [{ pts: [[x, y, z?], …], halfWidth }] in true metres (the life graph's
    // surface.carriageways). `bounds`: [minX, minY, maxX, maxY] of the pavement plane, or null for
    // no plane. Returns typed-array parts: `roadbed` (asphalt) and `plane` (pavement), plus stats.
    function buildGroundGeometry(input) {
        const ways = [];
        (input && Array.isArray(input.carriageways) ? input.carriageways : []).forEach(c => {
            const half = Number(c && c.halfWidth);
            if (!(half > 0)) return;
            const pts = dedupe(c.pts);
            if (pts.length >= 2) ways.push({ pts, half });
        });

        // Where a way ends on another way's vertex, the two ribbons meet with notched corners; a
        // disc as wide as the widest way there fills the junction. A dead end stays square.
        const use = new Map();      // node key → number of ways touching it
        const widest = new Map();   // node key → the widest half-width there
        ways.forEach(way => {
            const seen = new Set();
            way.pts.forEach(p => {
                const key = nodeKey(p[0], p[1]);
                if (seen.has(key)) return;
                seen.add(key);
                use.set(key, (use.get(key) || 0) + 1);
                widest.set(key, Math.max(widest.get(key) || 0, way.half));
            });
        });

        const list = createTriangleList();
        const junctions = new Set();
        let roundedBends = 0;
        let roadAreaM2 = 0;
        ways.forEach(way => {
            roundedBends += list.ribbon(way.pts, way.half);
            roadAreaM2 += polylineLength(way.pts) * way.half * 2;
            [way.pts[0], way.pts[way.pts.length - 1]].forEach(p => {
                const key = nodeKey(p[0], p[1]);
                if ((use.get(key) || 0) < 2 || junctions.has(key)) return;
                junctions.add(key);
                list.disc(p[0], p[1], p[2], widest.get(key));
            });
        });
        const roadbed = list.finish();

        let plane = null;
        const b = input && input.bounds;
        if (Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1]) {
            plane = {
                positions: new Float32Array([b[0], b[1], 0, b[2], b[1], 0, b[2], b[3], 0, b[0], b[3], 0]),
                indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
                triangles: 2
            };
        }

        return {
            roadbed, plane,
            stats: {
                ways: ways.length, triangles: roadbed.triangles + (plane ? 2 : 0), junctions: junctions.size,
                roundedBends, roadAreaM2: Math.round(roadAreaM2), dropped: roadbed.dropped
            }
        };
    }

    return { buildGroundGeometry, ribbonEdges, nodeKey, NODE_SNAP_M, MITRE_LIMIT, DISC_SEGMENTS };
});
