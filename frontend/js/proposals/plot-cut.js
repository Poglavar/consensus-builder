// Cutting a parcellation, treated as an operation on its boundary GRAPH rather than on each
// polygon separately.
//
// The old split tool pushed both ends of the drawn line a quarter of the pool's bounding box
// outward and then split every plot the extended line crossed. That made every cut global: there
// was no way to divide one plot, because the tool's only way of guaranteeing a cut actually
// separates something was to make it reach past everything.
//
// Here the line is exactly what was drawn, trimmed to the stretch that does work. A new boundary
// needs a node at each end, so the line has to meet the existing fabric in at least two places —
// ANCHORS: a crossing with a boundary, or an end placed on an existing node. It runs between the
// outermost two and no further; with fewer than two it implies no boundary at all and nothing is
// created. Carrying a loose end onward "to the first thing it meets" was the previous answer and
// it is gone — it put the line somewhere the user had not drawn it.
//
// The second half is conformance. Where the cut crosses or lands on an edge, a node must appear in
// EVERY ring that carries that edge, not only in the plots that end up split. Miss the neighbour on
// the far side of a T-junction and the two sides no longer share an edge: buildTopology reads
// A–X–B on one side and A–B on the other, dragging X moves one of them, and a gap opens along a
// boundary that looked fine. insertNodesIntoRings is what prevents that, and it is why the noding
// pass runs over every plot before anything is split.
//
// Pure: coordinates in, coordinates out. turf is injected, so this is testable without a browser.
(function (global, factory) {
    'use strict';
    const api = factory();
    if (typeof window !== 'undefined') window.__plotCut = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Snap radii, in SCREEN pixels. A radius in degrees is an ellipse on the ground whose size
    // changes with every zoom step, so snapping would feel different at every scale; a radius in
    // pixels is the distance the user's eye is actually judging.
    const DEFAULT_NODE_PX = 11;
    const DEFAULT_EDGE_PX = 7;
    // A crossing this close to an existing node is that node. Inserting a vertex there instead
    // would leave a sub-pixel edge that nothing can grab and nobody meant to create.
    const DEFAULT_MERGE_PX = 3;
    // The grid buildTopology quantises to; two coordinates closer than this are one vertex.
    const VERTEX_TOLERANCE = 1e-7;

    function geometryOf(value) {
        if (!value) return null;
        if (value.type === 'Feature') return value.geometry || null;
        if (value.geometry) return value.geometry.type === 'Feature' ? value.geometry.geometry : value.geometry;
        return value;
    }

    function ringsOf(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return geometry.coordinates || [];
        if (geometry.type === 'MultiPolygon') {
            return (geometry.coordinates || []).reduce((acc, poly) => acc.concat(poly), []);
        }
        return [];
    }

    function scaleOf(context, options) {
        const scale = (options && options.scale) || (context && context.scale) || null;
        const x = scale && Number.isFinite(scale.x) && scale.x ? Math.abs(scale.x) : 1;
        const y = scale && Number.isFinite(scale.y) && scale.y ? Math.abs(scale.y) : 1;
        return { x, y };
    }

    // Distance in pixels between two lng/lat coordinates, given degrees-per-pixel on each axis.
    // Longitude and latitude degrees are different lengths on the ground (at Zagreb's latitude a
    // degree of longitude is ~0.7 of a degree of latitude), so a raw hypot over degrees measures
    // something the user cannot see.
    function pixelDistance(a, b, scale) {
        if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
        const s = scale && Number.isFinite(scale.x) ? scale : { x: 1, y: 1 };
        return Math.hypot((a[0] - b[0]) / s.x, (a[1] - b[1]) / s.y);
    }

    // Foot of the perpendicular from p onto segment a–b, computed in pixel space so it is the
    // point the user sees as nearest, and returned in degrees.
    function projectOnSegment(p, a, b, scale) {
        const s = scale && Number.isFinite(scale.x) ? scale : { x: 1, y: 1 };
        const vx = (b[0] - a[0]) / s.x;
        const vy = (b[1] - a[1]) / s.y;
        const len2 = vx * vx + vy * vy;
        if (!len2) return { t: 0, coord: [a[0], a[1]], distance: pixelDistance(p, a, s) };
        let t = (((p[0] - a[0]) / s.x) * vx + ((p[1] - a[1]) / s.y) * vy) / len2;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        const coord = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        return { t, coord, distance: pixelDistance(p, coord, s) };
    }

    // Distance from p to segment a–b in DEGREES, for "does this coordinate lie on this ring
    // segment" — a question about the geometry, not about the screen.
    function distanceToSegmentDeg(p, a, b) {
        const vx = b[0] - a[0];
        const vy = b[1] - a[1];
        const len2 = vx * vx + vy * vy;
        if (!len2) return { t: 0, distance: Math.hypot(p[0] - a[0], p[1] - a[1]) };
        let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        const x = a[0] + vx * t;
        const y = a[1] + vy * t;
        return { t, distance: Math.hypot(p[0] - x, p[1] - y) };
    }

    // Where two segments meet, if they do. Both parameters come back so a caller can prefer the
    // NEAREST hit along a ray and can tell a crossing in the middle from one at an endpoint.
    function segmentIntersection(p1, p2, p3, p4) {
        const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
        if (!d) return null; // parallel, or one of them has no length
        const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
        const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
        if (t < 0 || t > 1 || u < 0 || u > 1) return null;
        return { t, u, coord: [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])] };
    }

    // Every line a cut can meet: the topology's edges, plus the pool outline. The outline is
    // included even though the plots normally tile it, because when they do not, a cut ending in
    // the gap would otherwise find nothing to terminate on.
    function segmentsFor(context) {
        if (!context) return [];
        if (context.__segments) return context.__segments;
        const topology = context.topology;
        const nodes = (topology && topology.nodes) || [];
        const byId = new Map(nodes.map(n => [n.id, n]));
        const out = [];
        ((topology && topology.edges) || []).forEach(edge => {
            const a = byId.get(edge.a);
            const b = byId.get(edge.b);
            if (!a || !b) return;
            out.push({
                edgeId: edge.id, a: a.coord, b: b.coord,
                plots: edge.plots || [], onBoundary: !!edge.onBoundary
            });
        });
        ringsOf(geometryOf(context.pool)).forEach(ring => {
            for (let i = 0; i < ring.length - 1; i++) {
                out.push({ edgeId: null, a: ring[i], b: ring[i + 1], plots: [], onBoundary: true });
            }
        });
        try { Object.defineProperty(context, '__segments', { value: out, enumerable: false }); }
        catch (_) { context.__segments = out; }
        return out;
    }

    // What a point would attach to. A node beats an edge even when the edge is nearer: attaching to
    // a node is the stronger commitment — it needs no new vertex anywhere — and a corner is what
    // someone aiming at a corner meant.
    function snapPoint(coord, context, options) {
        const opts = options || {};
        const free = { kind: 'free', coord: Array.isArray(coord) ? [coord[0], coord[1]] : null, nodeId: null, edgeId: null, distance: Infinity };
        if (!Array.isArray(coord) || coord.length < 2 || !context) return free;
        const scale = scaleOf(context, opts);
        const nodePx = Number.isFinite(opts.nodePx) ? opts.nodePx : DEFAULT_NODE_PX;
        const edgePx = Number.isFinite(opts.edgePx) ? opts.edgePx : DEFAULT_EDGE_PX;

        let bestNode = null;
        ((context.topology && context.topology.nodes) || []).forEach(node => {
            const distance = pixelDistance(coord, node.coord, scale);
            if (distance > nodePx) return;
            if (!bestNode || distance < bestNode.distance) bestNode = { node, distance };
        });
        if (bestNode) {
            return {
                kind: 'node', coord: [bestNode.node.coord[0], bestNode.node.coord[1]],
                nodeId: bestNode.node.id, edgeId: null, distance: bestNode.distance
            };
        }

        let bestEdge = null;
        segmentsFor(context).forEach(segment => {
            const hit = projectOnSegment(coord, segment.a, segment.b, scale);
            if (hit.distance > edgePx) return;
            if (!bestEdge || hit.distance < bestEdge.hit.distance) bestEdge = { segment, hit };
        });
        if (bestEdge) {
            return {
                kind: 'edge', coord: bestEdge.hit.coord,
                nodeId: null, edgeId: bestEdge.segment.edgeId, distance: bestEdge.hit.distance
            };
        }
        return free;
    }

    // Where a polyline crosses the existing fabric — the nodes a cut is about to create. Reported
    // before the cut is committed so they can be drawn, and used after to node the rings.
    function crossingsOf(points, context, options) {
        const opts = options || {};
        const scale = scaleOf(context, opts);
        const mergePx = Number.isFinite(opts.mergePx) ? opts.mergePx : DEFAULT_MERGE_PX;
        const pts = Array.isArray(points) ? points.filter(p => Array.isArray(p) && p.length >= 2) : [];
        if (pts.length < 2 || !context) return [];
        const segments = segmentsFor(context);
        const nodes = (context.topology && context.topology.nodes) || [];
        const out = [];
        const alreadyThere = coord => nodes.some(node => pixelDistance(coord, node.coord, scale) <= mergePx)
            || out.some(hit => pixelDistance(coord, hit.coord, scale) <= mergePx);

        for (let i = 0; i < pts.length - 1; i++) {
            segments.forEach(segment => {
                const hit = segmentIntersection(pts[i], pts[i + 1], segment.a, segment.b);
                if (!hit) return;
                // A crossing that falls on one of the cut's OWN vertices is that vertex, to the
                // last bit. Recomputing it would give a coordinate a few 1e-15 away, and a node
                // that is a hair off the line it is supposed to node does not node it at all.
                const atStart = pixelDistance(hit.coord, pts[i], scale) <= mergePx;
                const atEnd = pixelDistance(hit.coord, pts[i + 1], scale) <= mergePx;
                const coord = atStart ? pts[i] : (atEnd ? pts[i + 1] : hit.coord);
                if (alreadyThere(coord)) return;
                out.push({
                    coord, edgeId: segment.edgeId, plots: segment.plots, onBoundary: segment.onBoundary,
                    segment: i, t: hit.t, onVertex: atStart || atEnd
                });
            });
        }
        return out;
    }

    function dedupe(points, tolerance) {
        const tol = Number.isFinite(tolerance) ? tolerance : VERTEX_TOLERANCE;
        const out = [];
        (Array.isArray(points) ? points : []).forEach(p => {
            if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
            const prev = out[out.length - 1];
            if (prev && Math.abs(prev[0] - p[0]) <= tol && Math.abs(prev[1] - p[1]) <= tol) return;
            out.push([p[0], p[1]]);
        });
        return out;
    }

    // Where a drawn line meets what is already there, in order along the line. Each anchor carries
    // its position — segment index plus how far into that segment — so the line can be trimmed to
    // the stretch between the outermost two.
    //
    // An end dropped onto an existing NODE is an anchor without being a crossing: the node is
    // already there, so crossingsOf deliberately reports nothing for it. That is what makes "start
    // at that corner and cross one boundary" a complete instruction — one anchor from each.
    function anchorsFor(points, snaps, crossings) {
        const anchors = [];
        const add = (position, coord, kind) => {
            if (anchors.some(a => Math.abs(a.position - position) <= 1e-9)) return;
            anchors.push({ position, coord, kind });
        };
        (snaps || []).forEach((snap, index) => {
            if (snap && snap.kind === 'node' && points[index]) add(index, points[index], 'node');
        });
        (crossings || []).forEach(hit => add(hit.segment + hit.t, hit.coord, hit.onVertex ? 'edge' : 'crossing'));
        anchors.sort((a, b) => a.position - b.position);
        return anchors;
    }

    // Snap the drawn points, then trim the line to the part that does work. Returns the line as it
    // will actually be drawn, what each end attached to, and every coordinate that becomes a node.
    //
    // The line is NEVER carried past what the user drew. It is what lies between the first and the
    // last ANCHOR — a place where it genuinely meets the existing fabric, which is either a crossing
    // with a boundary or an end placed on an existing node. Two anchors are the minimum, because a
    // boundary needs a node at each end; anything beyond them, and anything short of two of them,
    // is a line the user drew across open ground and no new boundary is implied by it.
    //
    // `options.frozen[i]` marks a point the user placed with Shift held: it is taken exactly where
    // it was clicked, snapping and all.
    function resolveCut(points, context, deps, options) {
        const opts = options || {};
        const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : VERTEX_TOLERANCE;
        // Dedupe the points and their Shift flags together. Dropping a repeated click from one
        // list and not the other would shift every later flag by one, so the wrong vertex would be
        // the frozen one — invisible until a point mysteriously refused to snap.
        const raw = [];
        const rawFrozen = [];
        const frozenIn = Array.isArray(opts.frozen) ? opts.frozen : [];
        (Array.isArray(points) ? points : []).forEach((p, index) => {
            if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
            const prev = raw[raw.length - 1];
            if (prev && Math.abs(prev[0] - p[0]) <= tolerance && Math.abs(prev[1] - p[1]) <= tolerance) return;
            raw.push([p[0], p[1]]);
            rawFrozen.push(!!frozenIn[index]);
        });
        if (raw.length < 2) return { ok: false, reason: 'too-few', points: raw, ends: [], crossings: [], insertions: [] };

        const snaps = raw.map((p, index) => (rawFrozen[index]
            ? { kind: 'free', coord: [p[0], p[1]], nodeId: null, edgeId: null }
            : snapPoint(p, context, opts)));

        // Snapping can pull two clicks onto the same node; that is one point, not a zero-length
        // segment, and its snap goes with it.
        const pts = [];
        const kept = [];
        snaps.forEach(snap => {
            const prev = pts[pts.length - 1];
            if (prev && Math.abs(prev[0] - snap.coord[0]) <= tolerance
                && Math.abs(prev[1] - snap.coord[1]) <= tolerance) return;
            pts.push([snap.coord[0], snap.coord[1]]);
            kept.push(snap);
        });
        if (pts.length < 2) return { ok: false, reason: 'too-few', points: pts, ends: [], crossings: [], insertions: [] };

        const crossings = crossingsOf(pts, context, opts);
        const anchors = anchorsFor(pts, kept, crossings);
        if (anchors.length < 2) {
            return { ok: false, reason: 'no-anchors', points: pts, ends: [], crossings, insertions: [], anchors };
        }

        // Trim to the anchored stretch, keeping the bends the user drew in between. The coordinates
        // are the SAME objects the crossings carry: polygonize keys its nodes by exact coordinate,
        // so a vertex in the ring three femtodegrees off the line's own endpoint leaves the line
        // dangling and no face can be assembled.
        const first = anchors[0];
        const last = anchors[anchors.length - 1];
        const marks = anchors.map(a => ({ position: a.position, coord: a.coord }));
        pts.forEach((coord, index) => {
            if (index > first.position && index < last.position) marks.push({ position: index, coord });
        });
        marks.sort((a, b) => a.position - b.position);
        const trimmed = [];
        marks.forEach(mark => {
            const prev = trimmed[trimmed.length - 1];
            if (prev && Math.abs(prev[0] - mark.coord[0]) <= tolerance
                && Math.abs(prev[1] - mark.coord[1]) <= tolerance) return;
            trimmed.push(mark.coord);
        });
        if (trimmed.length < 2) {
            return { ok: false, reason: 'no-anchors', points: pts, ends: [], crossings, insertions: [], anchors };
        }

        const ends = [
            { index: 0, kind: first.kind, coord: first.coord },
            { index: trimmed.length - 1, kind: last.kind, coord: last.coord }
        ];
        return { ok: true, reason: null, points: trimmed, ends, crossings, anchors, insertions: trimmed };
    }

    // Put a vertex at each given coordinate into every ring whose boundary passes through it. This
    // is what keeps the subdivision conforming: a T-junction has to exist on BOTH sides of the edge
    // it lands on, or the two plots stop sharing that edge and drift apart on the next drag.
    function insertNodesIntoRings(geometries, coords, tolerance) {
        const tol = Number.isFinite(tolerance) ? tolerance : VERTEX_TOLERANCE;
        const list = (Array.isArray(geometries) ? geometries : [])
            .map(g => (g ? JSON.parse(JSON.stringify(geometryOf(g))) : null));
        const wanted = (Array.isArray(coords) ? coords : [])
            .filter(c => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]));
        if (!wanted.length) return list;

        let inserted = 0;
        list.forEach(geometry => {
            if (!geometry) return;
            ringsOf(geometry).forEach(ring => {
                // Backwards, so a splice never disturbs a segment index still to be visited.
                for (let i = ring.length - 2; i >= 0; i--) {
                    const a = ring[i];
                    const b = ring[i + 1];
                    const additions = [];
                    wanted.forEach(coord => {
                        if (Math.abs(coord[0] - a[0]) <= tol && Math.abs(coord[1] - a[1]) <= tol) return;
                        if (Math.abs(coord[0] - b[0]) <= tol && Math.abs(coord[1] - b[1]) <= tol) return;
                        const hit = distanceToSegmentDeg(coord, a, b);
                        if (hit.distance > tol || hit.t <= 0 || hit.t >= 1) return;
                        // The same coordinate twice would leave a repeated vertex, and a ring with
                        // one of those will not polygonize.
                        if (additions.some(add => Math.abs(add.coord[0] - coord[0]) <= tol
                            && Math.abs(add.coord[1] - coord[1]) <= tol)) return;
                        additions.push({ t: hit.t, coord: [coord[0], coord[1]] });
                    });
                    if (!additions.length) continue;
                    additions.sort((x, y) => x.t - y.t);
                    ring.splice(i + 1, 0, ...additions.map(x => x.coord));
                    inserted += additions.length;
                }
            });
        });
        list.inserted = inserted;
        return list;
    }

    // A point halfway ALONG a line, not halfway between its ends: for a bent cut those are
    // different places, and the second one can sit outside the polygon the line runs through.
    function midOfLine(feature, turf) {
        try { return turf.along(feature, turf.length(feature) / 2); }
        catch (_) {
            const coords = feature.geometry.coordinates;
            return turf.midpoint(turf.point(coords[0]), turf.point(coords[coords.length - 1]));
        }
    }

    // Make a layout say what it already means: where one plot's corner sits partway along a
    // neighbour's edge, give the neighbour that vertex too.
    //
    // Two plots only SHARE an edge when both rings carry the same two consecutive nodes. Where a
    // neighbour has an extra vertex along the same line, the two sides are different edges with one
    // plot each — so there is no boundary between them for anything to act on. That is why some
    // boundaries could be erased and others, looking identical, could not, and it is also why a
    // drag of a node on such a line opens a gap. Inserting a vertex on a segment does not move the
    // segment, so this adds no area; on the Borovje plan one pass fixed all 46 and it converges
    // there (a second pass adds nothing).
    function conformGeometries(geometries, tolerance) {
        const list = Array.isArray(geometries) ? geometries : [];
        const vertices = [];
        list.forEach(value => {
            ringsOf(geometryOf(value)).forEach(ring => (ring || []).forEach(coord => vertices.push(coord)));
        });
        return insertNodesIntoRings(list, vertices, tolerance);
    }

    function polygonFeaturesOf(geometry, turf) {
        const geom = geometryOf(geometry);
        if (!geom) return [];
        try {
            if (geom.type === 'Polygon') return [turf.polygon(geom.coordinates)];
            if (geom.type === 'MultiPolygon') return geom.coordinates.map(c => turf.polygon(c));
        } catch (_) { /* a malformed part simply has no faces */ }
        return [];
    }

    // Cut a closed ring at the given coordinates into open arcs. The coordinates must already BE
    // vertices of the ring (insertNodesIntoRings puts them there), so this is bookkeeping, not
    // geometry — which is the point: turf's lineSplit will not split a ring at a place the cut
    // merely TOUCHES, and after termination touching is the normal case, not the exception.
    function splitRingAt(ring, marks, tol) {
        const last = ring.length - 1; // a closed ring repeats its first coordinate
        const at = [];
        for (let i = 0; i < last; i++) {
            if (marks.some(m => Math.abs(m[0] - ring[i][0]) <= tol && Math.abs(m[1] - ring[i][1]) <= tol)) at.push(i);
        }
        if (at.length < 2) return null;
        const arcs = [];
        for (let m = 0; m < at.length; m++) {
            const from = at[m];
            const to = at[(m + 1) % at.length];
            const arc = [ring[from]];
            let i = (from + 1) % last;
            for (let guard = 0; guard <= last; guard++) {
                arc.push(ring[i]);
                if (i === to) break;
                i = (i + 1) % last;
            }
            if (arc.length >= 2) arcs.push(arc);
        }
        return arcs;
    }

    // Cut an open polyline at the given coordinates, which are already among its vertices.
    function splitLineAt(points, marks, tol) {
        const isMark = p => marks.some(m => Math.abs(m[0] - p[0]) <= tol && Math.abs(m[1] - p[1]) <= tol);
        const pieces = [];
        let current = [points[0]];
        for (let i = 1; i < points.length; i++) {
            current.push(points[i]);
            if (isMark(points[i]) && i < points.length - 1) {
                pieces.push(current);
                current = [points[i]];
            }
        }
        if (current.length >= 2) pieces.push(current);
        return pieces;
    }

    // Divide a ring with a chord that runs from one of its vertices to another.
    //
    // This is bookkeeping, not geometry, and that is the whole point. The two faces are built from
    // the ring's own coordinates and the chord's own coordinates — nothing is intersected, nothing
    // is invented, the shared boundary is literally the same numbers on both sides, and the two
    // areas add up to the original exactly. Handing the same job to polygonize meant depending on
    // two independently-computed coordinates agreeing to the last bit, which they do not: a node
    // three femtodegrees off the chord it is meant to node leaves the chord dangling, and a face
    // silently goes missing along with its land.
    // Where a coordinate sits on a ring, as a position `segment index + t`. The endpoints of a cut
    // do not have to be vertices already — locating them here is what makes the split independent
    // of whether the noding pass happened to put a vertex at that exact spot.
    function locateOnRing(ring, coord, tol) {
        let best = null;
        for (let i = 0; i < ring.length - 1; i++) {
            const hit = distanceToSegmentDeg(coord, ring[i], ring[i + 1]);
            if (hit.distance > tol) continue;
            if (!best || hit.distance < best.distance) best = { position: i + hit.t, distance: hit.distance };
        }
        return best;
    }

    function splitRingByChord(ring, chord, tol) {
        const last = ring.length - 1; // a closed ring repeats its first coordinate
        const A = chord[0];
        const B = chord[chord.length - 1];
        const from = locateOnRing(ring, A, tol);
        const to = locateOnRing(ring, B, tol);
        if (!from || !to) return null;
        const span = (to.position - from.position + last) % last;
        if (span <= 0 || span >= last) return null; // both ends in the same place: no chord

        // Walk the ring forward from one end of the chord to the other, starting and finishing at
        // the chord's OWN coordinates so both faces quote the same numbers along their new border.
        const arc = (start, end, startCoord, endCoord) => {
            const out = [startCoord];
            const total = (end - start + last) % last;
            for (let step = 1; step <= last; step++) {
                const index = (Math.floor(start) + step) % last;
                const forward = (index - start + last) % last;
                if (forward >= total || forward <= 0) continue;
                out.push(ring[index]);
            }
            out.push(endCoord);
            return out;
        };
        const arcA = arc(from.position, to.position, A, B);
        const arcB = arc(to.position, from.position, B, A);
        const forwardChord = chord.slice();
        const backwardChord = chord.slice().reverse();
        const first = arcA.concat(backwardChord.slice(1));
        const second = arcB.concat(forwardChord.slice(1));
        if (first.length < 4 || second.length < 4) return null;
        return [first, second];
    }

    // Exact split of one polygon by an already-noded cut, sharing the boundary rather than leaving
    // a kerf. Both sides are cut at the SAME coordinates, so the faces meet along one line rather
    // than along two that happen to coincide.
    function splitPolygonByLine(polygon, line, deps, options) {
        const turf = deps && deps.turf;
        const opts = options || {};
        const tol = Number.isFinite(opts.tolerance) ? opts.tolerance : VERTEX_TOLERANCE;
        if (!turf || typeof turf.polygonize !== 'function') return null;
        try {
            const rings = ringsOf(polygon.geometry || polygon);
            const cutPoints = (line.geometry ? line.geometry.coordinates : line) || [];
            if (cutPoints.length < 2 || !rings.length) return null;

            // The cut's vertices that lie on this polygon's boundary: where it enters, leaves, or
            // runs over a corner of it.
            const marks = cutPoints.filter(p => rings.some(ring => {
                for (let i = 0; i < ring.length - 1; i++) {
                    if (distanceToSegmentDeg(p, ring[i], ring[i + 1]).distance <= tol) return true;
                }
                return false;
            }));
            if (marks.length < 2) return null; // it cannot divide what it does not cross

            const inner = splitLineAt(cutPoints, marks, tol).filter(piece => {
                try { return turf.booleanPointInPolygon(midOfLine(turf.lineString(piece), turf), polygon); }
                catch (_) { return false; }
            });
            if (!inner.length) return null; // the line never enters this polygon

            const holes = rings.slice(1);

            // The ordinary case, and the only one worth being exact about: one chord, entering the
            // outer ring at one vertex and leaving it at another. Two faces, by walking the ring.
            if (inner.length === 1) {
                const halves = splitRingByChord(rings[0], inner[0], tol);
                // A hole the chord runs through cannot be dealt out whole. Refuse the cut rather
                // than guess — a wrong answer here invents land.
                const throughHole = holes.some(hole => inner[0].some(p => {
                    for (let i = 0; i < hole.length - 1; i++) {
                        if (distanceToSegmentDeg(p, hole[i], hole[i + 1]).distance <= tol) return true;
                    }
                    return false;
                }));
                if (halves && !throughHole) {
                    const faces = halves.map(coords => {
                        const shell = turf.polygon([coords]);
                        // Each hole belongs to whichever half encloses it — that is what keeps the
                        // areas adding up when a plot has one.
                        const mine = holes.filter(hole => {
                            try { return turf.booleanPointInPolygon(turf.point(hole[0]), shell); }
                            catch (_) { return false; }
                        });
                        return mine.length ? turf.polygon([coords].concat(mine)) : shell;
                    }).filter(face => {
                        try { return Math.abs(turf.area(face)) > 0; } catch (_) { return false; }
                    });
                    if (faces.length === 2) return faces;
                }
            }

            // A cut that enters and leaves more than once still assembles from the noded graph —
            // but only for a plot without holes. With holes, polygonize reads every hole ring as an
            // ordinary edge and hands back the holes THEMSELVES as faces: on one Borovje plot that
            // turned 17,383 m² into 29,158. There is no land to be had by guessing here.
            if (holes.length) return null;

            const edges = [];
            const arcs = splitRingAt(rings[0], marks, tol);
            if (arcs) arcs.forEach(arc => edges.push(turf.lineString(arc)));
            else edges.push(turf.lineString(rings[0]));
            inner.forEach(piece => edges.push(turf.lineString(piece)));

            const faces = turf.polygonize(turf.featureCollection(edges));
            if (!faces || !faces.features || faces.features.length < 2) return null;
            const inside = faces.features.filter(face => {
                try { return turf.booleanPointInPolygon(turf.pointOnFeature(face), polygon); }
                catch (_) { return false; }
            });
            if (inside.length < 2) return null;
            // Assembling faces from a graph can double-count; if the pieces do not add up to what
            // was cut, the split is wrong and saying so beats shipping the land twice.
            const before = Math.abs(turf.area(polygon));
            const after = inside.reduce((sum, face) => sum + Math.abs(turf.area(face)), 0);
            if (before > 0 && Math.abs(after - before) > Math.max(1, before * 0.001)) return null;
            return inside;
        } catch (_) {
            return null;
        }
    }

    // The whole operation: resolve the line, node every ring against it, then split the plots it
    // actually divides.
    //
    // Returns `results` as a flat list of { sourceIndex, geometry } in plot order, so the caller can
    // carry each piece's owners over from the plot it came from. A plot that was not split still
    // appears — with its rings noded — because that noding is the half of the cut that keeps the
    // neighbours in step.
    function cutPlots(plots, points, context, deps, options) {
        const turf = deps && deps.turf;
        const opts = options || {};
        if (!turf) return { ok: false, reason: 'no-turf', results: [], crossings: [], ends: [], added: 0, nodesAdded: 0 };

        const resolution = resolveCut(points, context, deps, opts);
        if (!resolution.ok) {
            return { ok: false, reason: resolution.reason, results: [], crossings: [], ends: resolution.ends, added: 0, nodesAdded: 0 };
        }

        const geometries = insertNodesIntoRings(
            (Array.isArray(plots) ? plots : []).map(geometryOf), resolution.insertions, opts.tolerance);
        const nodesAdded = geometries.inserted || 0;

        let line = null;
        try { line = turf.lineString(resolution.points); } catch (_) { line = null; }
        if (!line) {
            return { ok: false, reason: 'invalid-line', results: [], crossings: resolution.crossings, ends: resolution.ends, added: 0, nodesAdded };
        }

        const results = [];
        let didSplit = false;
        geometries.forEach((geometry, sourceIndex) => {
            if (!geometry) return;
            const parts = polygonFeaturesOf(geometry, turf);
            if (!parts.length) { results.push({ sourceIndex, geometry }); return; }
            const faces = [];
            let split = false;
            parts.forEach(part => {
                const pieces = splitPolygonByLine(part, line, deps, opts);
                if (pieces && pieces.length >= 2) { split = true; pieces.forEach(p => faces.push(p.geometry)); }
                else faces.push(part.geometry);
            });
            if (!split) { results.push({ sourceIndex, geometry }); return; }
            didSplit = true;
            faces.forEach(face => results.push({ sourceIndex, geometry: face }));
        });

        if (!didSplit) {
            return { ok: false, reason: 'no-split', results: [], crossings: resolution.crossings, ends: resolution.ends, added: 0, nodesAdded };
        }
        return {
            ok: true, reason: null, results,
            crossings: resolution.crossings, ends: resolution.ends, points: resolution.points,
            added: results.length - geometries.filter(Boolean).length,
            nodesAdded
        };
    }

    // ── Erasing a boundary ───────────────────────────────────────────────────────────────────────
    //
    // The inverse of a cut, and the reason it is phrased as a BOUNDARY rather than as one edge: two
    // plots that share a chain of edges are separated by the whole chain, and deleting one link of
    // it would leave a polygon with a slit rather than two plots merged. So the unit of erasure is
    // "every edge these two plots share", which is what the user is pointing at when they point at
    // the line between them.
    function boundaryGroups(topology) {
        const groups = new Map();
        ((topology && topology.edges) || []).forEach(edge => {
            const plots = (edge.plots || []).slice().sort((a, b) => a - b);
            if (plots.length !== 2) return;      // the pooled outline, or a dangling interior line
            if (edge.onBoundary) return;
            const key = plots.join('|');
            let group = groups.get(key);
            if (!group) {
                group = { key, plots, edges: [] };
                groups.set(key, group);
            }
            group.edges.push(edge);
        });
        return Array.from(groups.values());
    }

    // The polylines a boundary group is drawn as, for hover and hit-testing.
    function boundaryPaths(group, topology) {
        const byId = new Map(((topology && topology.nodes) || []).map(n => [n.id, n]));
        return (group && group.edges ? group.edges : []).map(edge => {
            const a = byId.get(edge.a);
            const b = byId.get(edge.b);
            if (!a || !b) return null;
            return [a.coord.slice(), b.coord.slice()];
        }).filter(Boolean);
    }

    return {
        DEFAULT_NODE_PX, DEFAULT_EDGE_PX, DEFAULT_MERGE_PX, VERTEX_TOLERANCE,
        pixelDistance, projectOnSegment, segmentIntersection, segmentsFor,
        snapPoint, crossingsOf, anchorsFor, resolveCut,
        insertNodesIntoRings, conformGeometries, splitPolygonByLine, cutPlots,
        boundaryGroups, boundaryPaths
    };
});
