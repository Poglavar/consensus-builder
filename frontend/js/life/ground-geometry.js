// Ground geometry for the 3D model view: the roadbed every street's carriageway covers, sunk a kerb
// below the pavement, the kerb walls along its edges, the lane lines painted on it, and the pavement
// plane everything else stands on ("everything that is not a car lane is sidewalk, up to the
// buildings"). Input is the life graph's carriageway list (centreline points, half-width, lane
// layout and the drop below the pavement, true metres), so the asphalt is exactly the surface the
// schematic cars drive on; output is plain typed arrays a thin THREE layer uploads. Pure: no DOM,
// no THREE.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.__groundGeometry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const NODE_SNAP_M = 0.5;      // same vertex snap as life-graph: shared vertices are one junction
    const MITRE_LIMIT = 2;        // a joint sharper than this is a round join: square ends plus a disc
    const DISC_SEGMENTS = 16;
    const MIN_SEGMENT_M = 0.01;
    const KERB_STEP_M = 1;        // kerb edges are sampled this often against the asphalt around them
    const KERB_TOL_M = 0.05;      // a sample this far inside any asphalt is in a junction opening
    const KERB_REFINE = 5;        // bisections that pin an opening's end to about 3 cm
    const INDEX_CELL_M = 32;
    const MARK_HALF_M = 0.06;     // lane lines are 12 cm wide
    const MARK_DASH_M = 3;        // a lane separator is dashed 3 m on, 6 m off; a centre line is solid
    const MARK_GAP_M = 6;
    const MARK_LIFT_M = 0.01;     // lines float this far above the asphalt

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
    // capped and the vertex reported in `capped`, where the caller splits the ribbon and rounds the
    // bend with a disc instead.
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

    // Cut a polyline at the vertices ribbonEdges would cap, so every piece is a plain mitred ribbon
    // that ends square at the sharp bend; a disc at the bend turns the two square ends into a round
    // join. (A symmetric cap pinched the ribbon to its centreline at hairpins.)
    function splitAtSharpBends(points, half) {
        const { capped } = ribbonEdges(points, half);
        if (!capped.length) return { pieces: [points], bends: [] };
        const pieces = [];
        let start = 0;
        capped.forEach(i => { pieces.push(points.slice(start, i + 1)); start = i; });
        pieces.push(points.slice(start));
        return { pieces: pieces.filter(p => p.length >= 2), bends: capped.map(i => points[i]) };
    }

    // Growable flat triangle list. Every triangle is emitted counter-clockwise seen from above, so a
    // front-side material never culls a quad that a sharp inner bend turned inside out. Each vertex
    // records how far it was sunk, so `finish` can also hand back the lid: the same triangles at
    // pavement level, which the renderer draws into the stencil buffer to cut the pavement.
    function createTriangleList() {
        const positions = [];
        const lid = [];
        const indices = [];
        let dropped = 0;
        function vertex(p, drop) {
            const z = p[2] || 0;
            positions.push(p[0], p[1], z - drop);
            lid.push(p[0], p[1], z);
            return positions.length / 3 - 1;
        }
        function triangle(a, b, c) {
            const ax = positions[a * 3], ay = positions[a * 3 + 1];
            const area2 = (positions[b * 3] - ax) * (positions[c * 3 + 1] - ay) - (positions[b * 3 + 1] - ay) * (positions[c * 3] - ax);
            if (Math.abs(area2) < 1e-9) { dropped++; return; }
            if (area2 > 0) indices.push(a, b, c); else indices.push(a, c, b);
        }
        // The rim points of a disc of radius r about (x, y), closed, for the kerb walker.
        function discRim(x, y, z, r) {
            const rim = [];
            for (let i = 0; i <= DISC_SEGMENTS; i++) {
                const t = ((i % DISC_SEGMENTS) / DISC_SEGMENTS) * Math.PI * 2;
                rim.push([x + Math.cos(t) * r, y + Math.sin(t) * r, z]);
            }
            return rim;
        }
        function disc(x, y, z, r, drop) {
            const centre = vertex([x, y, z], drop);
            const rim = discRim(x, y, z, r).slice(0, DISC_SEGMENTS).map(p => vertex(p, drop));
            for (let i = 0; i < DISC_SEGMENTS; i++) triangle(centre, rim[i], rim[(i + 1) % DISC_SEGMENTS]);
        }
        // A flat strip of half-width `half` from a to b (a lane line or one dash of it).
        function quad(a, b, half) {
            const { left, right } = ribbonEdges([a, b], half);
            const l0 = vertex(left[0], 0), l1 = vertex(left[1], 0), r0 = vertex(right[0], 0), r1 = vertex(right[1], 0);
            triangle(l0, r0, r1);
            triangle(l0, r1, l1);
        }
        // One mitred ribbon; returns its edges (sunk z) for the kerb walker.
        function ribbon(points, half, drop) {
            const { left, right } = ribbonEdges(points, half);
            const l = left.map(p => vertex(p, drop)), r = right.map(p => vertex(p, drop));
            for (let i = 0; i < points.length - 1; i++) {
                triangle(l[i], r[i], r[i + 1]);
                triangle(l[i], r[i + 1], l[i + 1]);
            }
            const sunk = p => [p[0], p[1], (p[2] || 0) - drop];
            return { left: left.map(sunk), right: right.map(sunk) };
        }
        function finish() {
            const index = new Uint32Array(indices);
            return {
                roadbed: { positions: new Float32Array(positions), indices: index, triangles: index.length / 3, dropped },
                lid: { positions: new Float32Array(lid), indices: index, triangles: index.length / 3 }
            };
        }
        return { vertex, triangle, disc, discRim, ribbon, quad, finish };
    }

    // Growable list of vertical quads (the kerb walls), with the normal of each quad's geometric
    // front face; a two-sided material lights the back face by flipping it.
    function createWallList() {
        const positions = [], normals = [], indices = [];
        let lengthM = 0;
        function wall(a, b, height) {
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const len = Math.hypot(dx, dy);
            if (len < MIN_SEGMENT_M || !(height > 0)) return;
            const nx = dy / len, ny = -dx / len;
            const base = positions.length / 3;
            positions.push(a[0], a[1], a[2], b[0], b[1], b[2], b[0], b[1], b[2] + height, a[0], a[1], a[2] + height);
            for (let i = 0; i < 4; i++) normals.push(nx, ny, 0);
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            lengthM += len;
        }
        function finish() {
            return {
                positions: new Float32Array(positions), normals: new Float32Array(normals),
                indices: new Uint32Array(indices), triangles: indices.length / 3, lengthM
            };
        }
        return { wall, finish };
    }

    // Everything the asphalt covers, for clipping the kerb and the lane lines: each way as its segment
    // strips plus a disc of its half-width at every interior vertex (the join), and the junction
    // discs. A coarse grid keyed by bounding box keeps a sample's visit to what lies around it.
    // `inside` is strict by KERB_TOL_M, so a way's own edge (exactly half-width out) never counts as
    // inside itself; `exceptWay` skips one way's own asphalt (a lane line lies inside its own way).
    function createAsphaltIndex(ways, discs) {
        const cells = new Map();
        const cellKey = (cx, cy) => cx + ':' + cy;
        function insert(item, minX, minY, maxX, maxY) {
            for (let cx = Math.floor(minX / INDEX_CELL_M); cx <= Math.floor(maxX / INDEX_CELL_M); cx++) {
                for (let cy = Math.floor(minY / INDEX_CELL_M); cy <= Math.floor(maxY / INDEX_CELL_M); cy++) {
                    const key = cellKey(cx, cy);
                    if (!cells.has(key)) cells.set(key, []);
                    cells.get(key).push(item);
                }
            }
        }
        ways.forEach((way, wayIndex) => {
            const limit = way.half - KERB_TOL_M;
            for (let i = 0; i < way.pts.length - 1; i++) {
                const a = way.pts[i], b = way.pts[i + 1];
                insert({ ax: a[0], ay: a[1], dx: b[0] - a[0], dy: b[1] - a[1], limit, way: wayIndex },
                    Math.min(a[0], b[0]) - way.half, Math.min(a[1], b[1]) - way.half, Math.max(a[0], b[0]) + way.half, Math.max(a[1], b[1]) + way.half);
            }
            for (let i = 1; i < way.pts.length - 1; i++) {
                const p = way.pts[i];
                insert({ x: p[0], y: p[1], limit, way: wayIndex }, p[0] - way.half, p[1] - way.half, p[0] + way.half, p[1] + way.half);
            }
        });
        discs.forEach(d => insert({ x: d.x, y: d.y, limit: d.r - KERB_TOL_M, way: null }, d.x - d.r, d.y - d.r, d.x + d.r, d.y + d.r));
        function inside(x, y, exceptWay) {
            const bucket = cells.get(cellKey(Math.floor(x / INDEX_CELL_M), Math.floor(y / INDEX_CELL_M)));
            if (!bucket) return false;
            for (const item of bucket) {
                if (exceptWay !== undefined && item.way === exceptWay) continue;
                if (item.dx === undefined) {
                    if (Math.hypot(x - item.x, y - item.y) < item.limit) return true;
                    continue;
                }
                const len2 = item.dx * item.dx + item.dy * item.dy;
                const t = ((x - item.ax) * item.dx + (y - item.ay) * item.dy) / len2;
                const tolT = KERB_TOL_M / Math.sqrt(len2);   // strict at the ends too: a dead-end cap is not inside
                if (t < tolT || t > 1 - tolT) continue;
                if (Math.abs((x - item.ax) * item.dy - (y - item.ay) * item.dx) / Math.sqrt(len2) < item.limit) return true;
            }
            return false;
        }
        return { inside };
    }

    // The runs of one polyline that lie outside the asphalt (except `exceptWay`'s own): sampled every
    // KERB_STEP_M against the index, each run end bisected onto the asphalt boundary, then handed to
    // `emit(a, b)` with z interpolated. A kerb edge (a ribbon side, a dead-end cap or a disc rim)
    // becomes walls this way, so a side street opens the main street's kerb exactly across its own
    // width; a lane line becomes paint that stops at every junction.
    function runsAlong(edge, index, exceptWay, emit) {
        for (let i = 0; i < edge.length - 1; i++) {
            const a = edge[i], b = edge[i + 1];
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (len < MIN_SEGMENT_M) continue;
            const at = t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t];
            const insideAt = t => { const p = at(t); return index.inside(p[0], p[1], exceptWay); };
            const boundary = (tOut, tIn) => {
                for (let k = 0; k < KERB_REFINE; k++) { const m = (tOut + tIn) / 2; if (insideAt(m)) tIn = m; else tOut = m; }
                return tOut;
            };
            const steps = Math.max(1, Math.ceil(len / KERB_STEP_M));
            let prevT = 0, prevIn = insideAt(0), runStart = prevIn ? null : 0;
            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                const nowIn = insideAt(t);
                if (nowIn !== prevIn) {
                    if (nowIn) { emit(at(runStart), at(boundary(prevT, t))); runStart = null; }
                    else runStart = boundary(t, prevT);
                }
                prevT = t; prevIn = nowIn;
            }
            if (runStart !== null) emit(at(runStart), at(1));
        }
    }

    // A ribbon piece's parallel at a signed offset (positive to the left of travel, like the life
    // graph's lane offsets); pieces have no capped joints, so the ribbon edge is a clean offset.
    function offsetPiece(piece, offset) {
        if (!offset) return piece.map(p => p.slice());
        const edges = ribbonEdges(piece, Math.abs(offset));
        return offset > 0 ? edges.left : edges.right;
    }

    // Paint one run of a lane line from a to b: solid, or dashed from the run's start. Returns the
    // painted length.
    function paintRun(list, a, b, dashed) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < MIN_SEGMENT_M) return 0;
        if (!dashed) { list.quad(a, b, MARK_HALF_M); return len; }
        const at = d => [a[0] + (b[0] - a[0]) * d / len, a[1] + (b[1] - a[1]) * d / len, a[2] + (b[2] - a[2]) * d / len];
        let painted = 0;
        for (let s = 0; s < len; s += MARK_DASH_M + MARK_GAP_M) {
            const e = Math.min(len, s + MARK_DASH_M);
            if (e - s < MIN_SEGMENT_M) break;
            list.quad(at(s), at(e), MARK_HALF_M);
            painted += e - s;
        }
        return painted;
    }

    function polylineLength(points) {
        let len = 0;
        for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
        return len;
    }

    // The same openings as the parcel ground, cut into the pavement itself. Work in the local
    // metric frame; subtraction and triangulation are supplied by the scene's geometry libraries.
    function buildPavementGeometry(bounds, openings, { difference, triangulate }) {
        const [x0, y0, x1, y1] = bounds;
        let surface = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [
            [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
        ] } };
        for (const opening of openings) {
            surface = difference(surface, opening);
            if (!surface) return null;
        }
        const polygons = surface.geometry.type === 'Polygon' ? [surface.geometry.coordinates] : surface.geometry.coordinates;
        const positions = [], indices = [];
        for (const polygon of polygons) {
            const rings = polygon.map(ring => {
                const points = ring.map(point => [point[0], point[1]]);
                if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
                return points;
            });
            const offset = positions.length / 3;
            const triangles = triangulate(rings[0], rings.slice(1));
            rings.flat().forEach(([x, y]) => positions.push(x, y, 0));
            triangles.forEach(triangle => indices.push(...triangle.map(index => index + offset)));
        }
        return { positions: new Float32Array(positions), indices: new Uint32Array(indices), triangles: indices.length / 3 };
    }

    // `carriageways`: [{ pts: [[x, y, z?], …], halfWidth, drop?, lanes? }] in true metres (the life
    // graph's surface.carriageways; `drop` sinks that way's asphalt below its centreline z and is its
    // kerb height, 0 or absent for flush; `lanes` [{ offset, dir }] are the lane centres left-positive
    // of the centreline, and every boundary between two lanes gets a line: solid between opposing
    // directions, dashed between lanes of one direction). `bounds`: [minX, minY, maxX, maxY] of the
    // pavement plane, or null for no plane. Returns typed-array parts: `roadbed` (sunk asphalt), `lid`
    // (the roadbed at pavement level, for the stencil), `kerb` (walls, with normals), `markings` (lane
    // lines) and `plane` (pavement), plus stats.
    function buildGroundGeometry(input) {
        const ways = [];
        (input && Array.isArray(input.carriageways) ? input.carriageways : []).forEach(c => {
            const half = Number(c && c.halfWidth);
            if (!(half > 0)) return;
            const pts = dedupe(c.pts);
            const drop = Number.isFinite(c.drop) && c.drop > 0 ? c.drop : 0;
            const lanes = (Array.isArray(c.lanes) ? c.lanes : []).filter(l => l && Number.isFinite(l.offset)).map(l => ({ offset: l.offset, dir: l.dir < 0 ? -1 : 1 }));
            if (pts.length >= 2) ways.push({ pts, half, drop, lanes });
        });

        // Where a way ends on another way's vertex, the two ribbons meet with notched corners; a
        // disc as wide as the widest way there, as deep as the deepest, fills the junction. A dead
        // end stays square.
        const use = new Map();      // node key → number of ways touching it
        const widest = new Map();   // node key → the widest half-width there
        const deepest = new Map();  // node key → the largest drop there
        ways.forEach(way => {
            const seen = new Set();
            way.pts.forEach(p => {
                const key = nodeKey(p[0], p[1]);
                if (seen.has(key)) return;
                seen.add(key);
                use.set(key, (use.get(key) || 0) + 1);
                widest.set(key, Math.max(widest.get(key) || 0, way.half));
                deepest.set(key, Math.max(deepest.get(key) || 0, way.drop));
            });
        });

        const list = createTriangleList();
        const junctions = new Map();  // node key → { x, y, z, r, drop }
        const kerbEdges = [];         // { edge, height }
        let roundedBends = 0;
        let roadAreaM2 = 0;
        ways.forEach(way => {
            const { pieces, bends } = splitAtSharpBends(way.pts, way.half);
            roundedBends += bends.length;
            roadAreaM2 += polylineLength(way.pts) * way.half * 2;
            const sides = pieces.map(piece => list.ribbon(piece, way.half, way.drop));
            bends.forEach(p => {
                list.disc(p[0], p[1], p[2], way.half, way.drop);
                kerbEdges.push({ edge: list.discRim(p[0], p[1], p[2] - way.drop, way.half), height: way.drop });
            });
            sides.forEach(side => {
                kerbEdges.push({ edge: side.left, height: way.drop });
                kerbEdges.push({ edge: side.right, height: way.drop });
            });
            // Dead ends get a kerb across; ends on a junction are open into it.
            const first = sides[0], last = sides[sides.length - 1];
            [[way.pts[0], first.left[0], first.right[0]], [way.pts[way.pts.length - 1], last.left[last.left.length - 1], last.right[last.right.length - 1]]].forEach(([p, l, r]) => {
                const key = nodeKey(p[0], p[1]);
                if ((use.get(key) || 0) < 2) { kerbEdges.push({ edge: [l, r], height: way.drop }); return; }
                if (junctions.has(key)) return;
                junctions.set(key, { x: p[0], y: p[1], z: p[2], r: widest.get(key), drop: deepest.get(key) });
            });
        });
        junctions.forEach(j => {
            list.disc(j.x, j.y, j.z, j.r, j.drop);
            kerbEdges.push({ edge: list.discRim(j.x, j.y, j.z - j.drop, j.r), height: j.drop });
        });
        const { roadbed, lid } = list.finish();

        const index = createAsphaltIndex(ways, Array.from(junctions.values()));
        const walls = createWallList();
        kerbEdges.forEach(k => { if (k.height > 0) runsAlong(k.edge, index, undefined, (a, b) => walls.wall(a, b, k.height)); });
        const kerb = walls.finish();

        // Lane lines: one per boundary between adjacent lanes, on the sunk surface, stopping at every
        // other way's asphalt and at the junction discs.
        const marks = createTriangleList();
        let markingM = 0;
        ways.forEach((way, wayIndex) => {
            const lanes = way.lanes.slice().sort((p, q) => p.offset - q.offset);
            if (lanes.length < 2) return;
            const lift = MARK_LIFT_M - way.drop;
            const { pieces } = splitAtSharpBends(way.pts, way.half);
            for (let i = 0; i < lanes.length - 1; i++) {
                const offset = (lanes[i].offset + lanes[i + 1].offset) / 2;
                const dashed = lanes[i].dir === lanes[i + 1].dir;
                pieces.forEach(piece => {
                    const line = offsetPiece(piece, offset).map(p => [p[0], p[1], (p[2] || 0) + lift]);
                    runsAlong(line, index, wayIndex, (a, b) => { markingM += paintRun(marks, a, b, dashed); });
                });
            }
        });
        const markings = marks.finish().roadbed;

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
            roadbed, lid, kerb, markings, plane,
            stats: {
                ways: ways.length, triangles: roadbed.triangles + (plane ? 2 : 0), junctions: junctions.size,
                roundedBends, roadAreaM2: Math.round(roadAreaM2), dropped: roadbed.dropped,
                kerbM: Math.round(kerb.lengthM), kerbTriangles: kerb.triangles,
                markingM: Math.round(markingM), markingTriangles: markings.triangles
            }
        };
    }

    return {
        buildGroundGeometry, buildPavementGeometry, ribbonEdges, splitAtSharpBends, nodeKey,
        NODE_SNAP_M, MITRE_LIMIT, DISC_SEGMENTS, KERB_TOL_M, MARK_HALF_M, MARK_DASH_M, MARK_GAP_M, MARK_LIFT_M
    };
});
