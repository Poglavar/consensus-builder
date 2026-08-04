// A parcellation is a planar subdivision, not a bag of independent polygons: neighbouring plots
// SHARE their boundary. This module reads a plot list as nodes and edges, so dragging a node moves
// every plot that touches it and the layout stays gap-free — editing a boundary, rather than
// redrawing whole plots and hoping the neighbour matches.
// Pure: coordinate arrays in, coordinate arrays out. No map, no DOM.
(function (global) {
    'use strict';

    // Coordinates that differ by less than this are the same node. Plot rings come from cutting
    // operations whose outputs agree to ~1e-9 degrees but rarely bit-for-bit.
    const DEFAULT_TOLERANCE = 1e-7;

    function ringsOf(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return geometry.coordinates || [];
        if (geometry.type === 'MultiPolygon') {
            return (geometry.coordinates || []).reduce((acc, poly) => acc.concat(poly), []);
        }
        // Open shapes go through the same machinery: a road centreline is a sequence of nodes with
        // shared junctions, which is the same problem as a plot boundary with shared corners.
        if (geometry.type === 'LineString') return [geometry.coordinates || []];
        if (geometry.type === 'MultiLineString') return geometry.coordinates || [];
        return [];
    }

    function isClosedGeometry(geometry) {
        const type = geometry && geometry.type;
        return type === 'Polygon' || type === 'MultiPolygon';
    }

    function geometryOf(plot) {
        if (!plot) return null;
        if (plot.geometry) return plot.geometry.type === 'Feature' ? plot.geometry.geometry : plot.geometry;
        if (plot.type === 'Feature') return plot.geometry;
        return null;
    }

    function keyFor(coord, tolerance) {
        // Quantise to the tolerance grid so near-identical vertices land in one bucket.
        const q = v => Math.round(v / tolerance) * tolerance;
        return `${q(coord[0]).toFixed(9)},${q(coord[1]).toFixed(9)}`;
    }

    // Build the node/edge graph of a plot list.
    //   nodes: [{ id, coord: [lng, lat], plots: [plotIndex…], refs: [{plot, ring, vertex}…] }]
    //   edges: [{ id, a: nodeId, b: nodeId, plots: [plotIndex…] }]
    // A node's `plots` having more than one entry means moving it re-shapes several plots at once.
    function buildTopology(plots, options) {
        const opts = options || {};
        const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_TOLERANCE;
        const list = Array.isArray(plots) ? plots : [];

        const nodesByKey = new Map();
        const edgesByKey = new Map();

        const nodeIdFor = (coord, plotIndex, ringIndex, vertexIndex) => {
            const key = keyFor(coord, tolerance);
            let node = nodesByKey.get(key);
            if (!node) {
                node = { id: nodesByKey.size, key, coord: [coord[0], coord[1]], plots: [], refs: [] };
                nodesByKey.set(key, node);
            }
            if (node.plots.indexOf(plotIndex) === -1) node.plots.push(plotIndex);
            node.refs.push({ plot: plotIndex, ring: ringIndex, vertex: vertexIndex });
            return node;
        };

        list.forEach((plot, plotIndex) => {
            const rings = ringsOf(geometryOf(plot));
            const closed = isClosedGeometry(geometryOf(plot));
            rings.forEach((ring, ringIndex) => {
                // A closed ring repeats its first coordinate, so a triangle is 4 entries; an open
                // line needs only two points to have an edge.
                if (!Array.isArray(ring) || ring.length < (closed ? 4 : 2)) return;
                // A ring repeats its first coordinate as its last; index them all so every
                // reference is rewritten on a move, but walk edges over the open sequence.
                const nodes = ring.map((coord, vertexIndex) => nodeIdFor(coord, plotIndex, ringIndex, vertexIndex));
                for (let i = 0; i < nodes.length - 1; i++) {
                    const a = nodes[i];
                    const b = nodes[i + 1];
                    if (a.id === b.id) continue;
                    const edgeKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
                    let edge = edgesByKey.get(edgeKey);
                    if (!edge) {
                        edge = { id: edgesByKey.size, a: Math.min(a.id, b.id), b: Math.max(a.id, b.id), plots: [] };
                        edgesByKey.set(edgeKey, edge);
                    }
                    if (edge.plots.indexOf(plotIndex) === -1) edge.plots.push(plotIndex);
                }
            });
        });

        return {
            tolerance,
            nodes: Array.from(nodesByKey.values()),
            edges: Array.from(edgesByKey.values())
        };
    }

    function clonePlotGeometries(plots) {
        return (Array.isArray(plots) ? plots : []).map(plot => {
            const geometry = geometryOf(plot);
            return geometry ? JSON.parse(JSON.stringify(geometry)) : null;
        });
    }

    // Move one node to a new coordinate. Returns new geometries (input untouched) — every plot
    // referencing that node follows, which is the whole point: the shared boundary stays shared.
    function moveNode(plots, topology, nodeId, newCoord) {
        const geometries = clonePlotGeometries(plots);
        const node = (topology && topology.nodes || []).find(n => n.id === nodeId);
        if (!node || !Array.isArray(newCoord) || newCoord.length < 2) return geometries;

        node.refs.forEach(ref => {
            const geometry = geometries[ref.plot];
            if (!geometry) return;
            const rings = ringsOf(geometry);
            const ring = rings[ref.ring];
            if (!ring || !ring[ref.vertex]) return;
            ring[ref.vertex] = [newCoord[0], newCoord[1]];
            // Keep a CLOSED ring closed when its first or last vertex moved. An open line's ends
            // are two different places and must stay independent.
            if (!isClosedGeometry(geometry)) return;
            if (ref.vertex === 0) ring[ring.length - 1] = [newCoord[0], newCoord[1]];
            if (ref.vertex === ring.length - 1) ring[0] = [newCoord[0], newCoord[1]];
        });
        return geometries;
    }

    // Insert a vertex on an edge, in every plot that shares it, so the boundary stays common.
    function insertNodeOnEdge(plots, topology, edgeId, coord) {
        const geometries = clonePlotGeometries(plots);
        const edge = (topology && topology.edges || []).find(e => e.id === edgeId);
        const nodes = (topology && topology.nodes) || [];
        const a = nodes.find(n => n.id === (edge && edge.a));
        const b = nodes.find(n => n.id === (edge && edge.b));
        if (!edge || !a || !b || !Array.isArray(coord)) return geometries;

        const tolerance = (topology && topology.tolerance) || DEFAULT_TOLERANCE;
        const same = (p, q) => Math.abs(p[0] - q[0]) <= tolerance && Math.abs(p[1] - q[1]) <= tolerance;

        geometries.forEach(geometry => {
            if (!geometry) return;
            ringsOf(geometry).forEach(ring => {
                for (let i = 0; i < ring.length - 1; i++) {
                    const matches = (same(ring[i], a.coord) && same(ring[i + 1], b.coord))
                        || (same(ring[i], b.coord) && same(ring[i + 1], a.coord));
                    if (!matches) continue;
                    ring.splice(i + 1, 0, [coord[0], coord[1]]);
                    return; // one insertion per ring per pass
                }
            });
        });
        return geometries;
    }

    // Remove a node from every shape that uses it.
    //
    // Removing a node is always allowed. It is not an error even when several plots share it, and
    // not even when it leaves a plot with too few corners to be a polygon: the boundary it defined
    // stops existing, and the land belongs to whatever remains around it. A plot reduced past a
    // triangle is DISSOLVED (its geometry becomes null) rather than the removal being refused —
    // plot-heal.js then hands its land to the neighbours, so nothing is ever orphaned. Take the
    // idea to its end and removing every internal node leaves one plot covering the whole pool,
    // which is exactly right.
    //
    // Opt in with `options.dissolveDegenerate`. It is opt-in because it only makes sense where
    // something ABSORBS the freed land: a parcellation heals afterwards, but a road centreline has
    // no neighbour to give its points to, so there the old refusal is still the right answer.
    function removeNode(plots, topology, nodeId, options) {
        const opts = options || {};
        const geometries = clonePlotGeometries(plots);
        const node = (topology && topology.nodes || []).find(n => n.id === nodeId);
        if (!node) return { geometries, removed: false, reason: 'unknown-node' };

        const tolerance = (topology && topology.tolerance) || DEFAULT_TOLERANCE;
        const same = (p, q) => Math.abs(p[0] - q[0]) <= tolerance && Math.abs(p[1] - q[1]) <= tolerance;
        const minCoords = geometry => (isClosedGeometry(geometry) ? 4 : 2);

        if (opts.dissolveDegenerate !== true) {
            // A closed ring of a triangle has 4 coordinates; removing one leaves 3 → degenerate.
            const wouldDegenerate = geometries.some(geometry => {
                if (!geometry) return false;
                return ringsOf(geometry).some(ring => {
                    const hits = ring.filter(c => same(c, node.coord)).length;
                    return hits > 0 && (ring.length - hits) < minCoords(geometry);
                });
            });
            if (wouldDegenerate) return { geometries, removed: false, reason: 'would-degenerate' };
        }

        const dissolved = [];
        geometries.forEach((geometry, index) => {
            if (!geometry) return;
            ringsOf(geometry).forEach(ring => {
                for (let i = ring.length - 1; i >= 0; i--) {
                    if (same(ring[i], node.coord)) ring.splice(i, 1);
                }
                // Re-close: splicing may have removed the repeated first/last coordinate.
                if (isClosedGeometry(geometry) && ring.length && !same(ring[0], ring[ring.length - 1])) {
                    ring.push([ring[0][0], ring[0][1]]);
                }
            });
            // Drop the parts that are no longer shapes, and the whole geometry when nothing is left.
            const survivor = pruneDegenerateParts(geometry, minCoords(geometry));
            geometries[index] = survivor;
            if (!survivor) dissolved.push(index);
        });
        return { geometries, removed: true, reason: null, dissolved };
    }

    // Strip rings/parts that no longer have enough coordinates to be a shape. Returns null when
    // nothing usable is left, which the caller reads as "this plot is gone".
    function pruneDegenerateParts(geometry, minCoords) {
        if (!geometry) return null;
        if (geometry.type === 'Polygon') {
            const rings = (geometry.coordinates || []).filter((ring, index) => (
                index === 0 ? ring.length >= minCoords : ring.length >= minCoords
            ));
            if (!rings.length || rings[0].length < minCoords) return null;
            return { type: 'Polygon', coordinates: rings };
        }
        if (geometry.type === 'MultiPolygon') {
            const parts = (geometry.coordinates || [])
                .map(part => part.filter(ring => ring.length >= minCoords))
                .filter(part => part.length && part[0].length >= minCoords);
            if (!parts.length) return null;
            return { type: 'MultiPolygon', coordinates: parts };
        }
        if (geometry.type === 'LineString') {
            return (geometry.coordinates || []).length >= minCoords ? geometry : null;
        }
        if (geometry.type === 'MultiLineString') {
            const lines = (geometry.coordinates || []).filter(line => line.length >= minCoords);
            return lines.length ? { type: 'MultiLineString', coordinates: lines } : null;
        }
        return geometry;
    }

    // ── The pool boundary is not part of the design ──────────────────────────────────────────────
    //
    // A readjustment subdivides a POOL of input parcels. Two invariants: the outputs tile the pool
    // exactly, and the pool's own outline belongs to the neighbours — you change it by choosing
    // different inputs, never by dragging. Treating every output vertex as free breaks the second
    // silently: drag a vertex that sits on the outline and the plan quietly takes or gives land
    // outside itself, which is a boundary agreement with a third party, not a readjustment.
    //
    // So a node is one of three things:
    //   interior         — only cut edges meet there; free
    //   boundary-edge    — where a cut LANDS on the outline; slides ALONG its segment (this is the
    //                      split ratio, a real design choice) but can never leave it
    //   boundary-corner  — a corner inherited from the outline itself; locked
    //
    // Note what is NOT locked: an output border that happens to run along a former INTERNAL parcel
    // line. That line dissolved into the interior when the parcels were pooled, so it is ordinary
    // design. Only the outer rings of the union (and the rings of any hole) are off-limits.

    function boundaryIndexOf(boundary, options) {
        const opts = options || {};
        const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_TOLERANCE;
        const geometry = boundary && boundary.type === 'Feature' ? boundary.geometry : boundary;
        const rings = ringsOf(geometry).filter(ring => Array.isArray(ring) && ring.length > 1);
        const segments = [];
        rings.forEach((ring, ringIndex) => {
            for (let i = 0; i < ring.length - 1; i++) {
                segments.push({ ring: ringIndex, index: i, a: ring[i], b: ring[i + 1] });
            }
        });
        return { rings, segments, tolerance };
    }

    // Distance from p to segment ab, plus where along it the foot of the perpendicular falls.
    // Degrees throughout: this asks whether two coordinates coincide, not how far apart they are.
    function projectOnSegment(p, a, b) {
        const vx = b[0] - a[0];
        const vy = b[1] - a[1];
        const len2 = vx * vx + vy * vy;
        if (!len2) return { t: 0, point: [a[0], a[1]], distance: Math.hypot(p[0] - a[0], p[1] - a[1]) };
        let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        const point = [a[0] + vx * t, a[1] + vy * t];
        return { t, point, distance: Math.hypot(p[0] - point[0], p[1] - point[1]) };
    }

    // Which of the three classes a coordinate falls into. A coordinate that is BOTH near a segment
    // and near one of its endpoints is a corner — the stricter answer wins, because locking a node
    // that should have slid is a nuisance while sliding one that should have been locked is the bug.
    function classifyAgainstBoundary(coord, boundaryIndex) {
        if (!boundaryIndex || !Array.isArray(boundaryIndex.segments) || !coord) return { kind: 'interior' };
        const tolerance = boundaryIndex.tolerance || DEFAULT_TOLERANCE;
        let best = null;
        for (const segment of boundaryIndex.segments) {
            const hit = projectOnSegment(coord, segment.a, segment.b);
            if (hit.distance > tolerance) continue;
            if (!best || hit.distance < best.hit.distance) best = { segment, hit };
        }
        if (!best) return { kind: 'interior' };
        const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tolerance;
        if (near(coord, best.segment.a) || near(coord, best.segment.b)) {
            return { kind: 'boundary-corner', ring: best.segment.ring, segment: best.segment.index };
        }
        return {
            kind: 'boundary-edge',
            ring: best.segment.ring,
            segment: best.segment.index,
            a: [best.segment.a[0], best.segment.a[1]],
            b: [best.segment.b[0], best.segment.b[1]]
        };
    }

    // Annotate a topology in place: every node gets `.boundary`, every edge gets `.onBoundary`.
    // An edge counts as on the boundary when both ends AND its midpoint are — two cuts can meet
    // the outline at either end without the edge between them running along it.
    function annotateBoundary(topology, boundaryIndex) {
        if (!topology) return topology;
        const nodes = topology.nodes || [];
        nodes.forEach(node => { node.boundary = classifyAgainstBoundary(node.coord, boundaryIndex); });
        const byId = new Map(nodes.map(n => [n.id, n]));
        (topology.edges || []).forEach(edge => {
            const a = byId.get(edge.a);
            const b = byId.get(edge.b);
            // An edge with a plot on BOTH sides is an internal boundary, wherever it happens to
            // run. Deciding this on geometry alone marked a dividing line that follows the pooled
            // outline as part of the outline itself — so its nodes looked like they had no cuts
            // meeting them, a bend in the middle of that line was mistaken for the end of one, and
            // removing it destroyed the whole line.
            if ((edge.plots || []).length > 1) { edge.onBoundary = false; return; }
            if (!a || !b || !isOnBoundary(a) || !isOnBoundary(b)) { edge.onBoundary = false; return; }
            const mid = [(a.coord[0] + b.coord[0]) / 2, (a.coord[1] + b.coord[1]) / 2];
            edge.onBoundary = classifyAgainstBoundary(mid, boundaryIndex).kind !== 'interior';
        });
        return topology;
    }

    function isOnBoundary(node) {
        const kind = node && node.boundary && node.boundary.kind;
        return kind === 'boundary-corner' || kind === 'boundary-edge';
    }

    function nodeIsDraggable(node) {
        return !(node && node.boundary && node.boundary.kind === 'boundary-corner');
    }

    // Where a drag of this node is actually allowed to land. A boundary node is pinned to the
    // SEGMENT it sits on rather than to the outline as a whole: sliding past a corner would cut
    // that corner off the plan, so the one gesture that could still change the pool's area is
    // simply not reachable.
    function constrainNodeDrop(node, coord) {
        const info = node && node.boundary;
        if (!info || info.kind === 'interior') return coord;
        if (info.kind === 'boundary-corner') return node.coord.slice();
        if (!Array.isArray(info.a) || !Array.isArray(info.b)) return coord;
        return projectOnSegment(coord, info.a, info.b).point;
    }

    // Midpoints of every edge — the "insert a node here" targets.
    function edgeMidpoints(topology) {
        const nodes = (topology && topology.nodes) || [];
        const byId = new Map(nodes.map(n => [n.id, n]));
        return ((topology && topology.edges) || []).map(edge => {
            const a = byId.get(edge.a);
            const b = byId.get(edge.b);
            if (!a || !b) return null;
            return {
                edgeId: edge.id,
                coord: [(a.coord[0] + b.coord[0]) / 2, (a.coord[1] + b.coord[1]) / 2],
                shared: edge.plots.length > 1
            };
        }).filter(Boolean);
    }

    // Shape-level entry points for callers that do not hold GeoJSON — road editing keeps its
    // centrelines as arrays of {lat, lng}. `shapes` is [{ points: [[lng, lat]…], closed }].
    function shapesToPlots(shapes) {
        return (Array.isArray(shapes) ? shapes : []).map(shape => {
            const points = (shape && Array.isArray(shape.points)) ? shape.points : [];
            if (shape && shape.closed) {
                const ring = points.slice();
                if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
                    ring.push([ring[0][0], ring[0][1]]);
                }
                return { geometry: { type: 'Polygon', coordinates: [ring] } };
            }
            return { geometry: { type: 'LineString', coordinates: points.slice() } };
        });
    }

    function plotsToShapes(geometries, shapes) {
        return (Array.isArray(geometries) ? geometries : []).map((geometry, index) => {
            const closed = !!(shapes && shapes[index] && shapes[index].closed);
            const ring = ringsOf(geometry)[0] || [];
            const points = closed && ring.length > 1 ? ring.slice(0, -1) : ring.slice();
            return { points, closed };
        });
    }

    const api = {
        DEFAULT_TOLERANCE, buildTopology, moveNode, insertNodeOnEdge, removeNode, edgeMidpoints,
        isClosedGeometry, shapesToPlots, plotsToShapes,
        boundaryIndexOf, classifyAgainstBoundary, annotateBoundary, isOnBoundary,
        nodeIsDraggable, constrainNodeDrop, projectOnSegment
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__plotTopology = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
