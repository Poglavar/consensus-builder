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

    // Remove a node from every plot that uses it. Refused when any affected ring would drop below
    // a triangle — a plot with two corners is not a plot.
    function removeNode(plots, topology, nodeId) {
        const geometries = clonePlotGeometries(plots);
        const node = (topology && topology.nodes || []).find(n => n.id === nodeId);
        if (!node) return { geometries, removed: false, reason: 'unknown-node' };

        const tolerance = (topology && topology.tolerance) || DEFAULT_TOLERANCE;
        const same = (p, q) => Math.abs(p[0] - q[0]) <= tolerance && Math.abs(p[1] - q[1]) <= tolerance;

        // A closed ring of a triangle has 4 coordinates; removing one leaves 3 → degenerate.
        const wouldDegenerate = geometries.some(geometry => {
            if (!geometry) return false;
            const min = isClosedGeometry(geometry) ? 4 : 2;   // triangle+closure, or a two-point line
            return ringsOf(geometry).some(ring => {
                const hits = ring.filter(c => same(c, node.coord)).length;
                return hits > 0 && (ring.length - hits) < min;
            });
        });
        if (wouldDegenerate) return { geometries, removed: false, reason: 'would-degenerate' };

        geometries.forEach(geometry => {
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
        });
        return { geometries, removed: true, reason: null };
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
        isClosedGeometry, shapesToPlots, plotsToShapes
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__plotTopology = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
