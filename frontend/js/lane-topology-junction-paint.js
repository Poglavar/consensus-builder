// Paints the inside of a junction: the carriageway surface that closes the hole the portal setbacks
// leave, and the guide lines ("crte vodilje") that carry movements across it.
//
// The surface is geometry — every junction has one. The guide lines are TOPOLOGY, and a junction with
// no solved connections gets none: markings invented from a guess would make an unsolved junction
// look solved, which is the one thing this tool must never do.
//
// Everything reads the DISPLAY graph, whose lanes are already trimmed to the portals, so a lane's
// endpoint at a node IS the portal position. That keeps the paving, the section paint and the guide
// lines agreeing on where the junction starts without any of them recomputing a setback.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LaneTopologyJunctionPaint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MIN_JUNCTION_DEGREE = 3;

    // Resolved lazily so script order cannot matter: the view module may load after this one.
    function viewApi() {
        if (typeof globalThis !== 'undefined' && globalThis.LaneTopologyView) {
            return globalThis.LaneTopologyView;
        }
        if (typeof require === 'function') {
            try { return require('./lane-topology-view.js'); } catch (_) { /* browser-only build */ }
        }
        return null;
    }

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    function coordinatesOf(lane) {
        const coordinates = lane?.geometry?.coordinates;
        return Array.isArray(coordinates) && coordinates.length >= 2 ? coordinates : null;
    }

    // Where a lane meets a node, and which way it is heading there. `at` is the coordinate on the
    // portal; `inward` is the neighbouring coordinate, so callers get a heading without re-deriving it.
    function laneEndAtNode(lane, nodeId) {
        const coordinates = coordinatesOf(lane);
        if (!coordinates) return null;
        if (lane.toNode === nodeId) {
            return { at: coordinates[coordinates.length - 1], inward: coordinates[coordinates.length - 2] };
        }
        if (lane.fromNode === nodeId) {
            return { at: coordinates[0], inward: coordinates[1] };
        }
        return null;
    }

    function midpoint(a, b) {
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }

    // Monotone chain. A junction interior is convex enough that a hull is the honest "good-enough
    // crossroads" treatment this codebase already settled on for corridors without corner geometry.
    function convexHull(points) {
        const unique = [];
        const seen = new Set();
        points.forEach(point => {
            const key = `${point[0].toFixed(4)},${point[1].toFixed(4)}`;
            if (seen.has(key)) return;
            seen.add(key);
            unique.push(point);
        });
        if (unique.length < 3) return unique;
        unique.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const half = source => {
            const chain = [];
            source.forEach(point => {
                while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) {
                    chain.pop();
                }
                chain.push(point);
            });
            chain.pop();
            return chain;
        };
        return [...half(unique), ...half([...unique].reverse())];
    }

    // The two outer corners of one lane where it meets the portal: its endpoint pushed half a lane
    // width to either side, across its own heading. The paving reaches the kerb, not the lane centre.
    function lanePortalCorners(lane, nodeId, projection) {
        const ends = laneEndAtNode(lane, nodeId);
        if (!ends) return [];
        const at = projection.project(ends.at);
        const inward = projection.project(ends.inward);
        const dx = at[0] - inward[0];
        const dy = at[1] - inward[1];
        const length = Math.hypot(dx, dy);
        if (length < 1e-6) return [];
        const half = Math.max(1.4, (finite(lane.width) ?? 3) / 2);
        const normal = [-dy / length, dx / length];
        return [
            [at[0] + normal[0] * half, at[1] + normal[1] * half],
            [at[0] - normal[0] * half, at[1] - normal[1] * half]
        ];
    }

    function junctionSurfaces(displayGraph) {
        const view = viewApi();
        if (!view || !displayGraph) return [];
        const junctionNodes = (displayGraph.nodes || [])
            .filter(node => Number(node?.degree) >= MIN_JUNCTION_DEGREE);
        if (!junctionNodes.length) return [];

        const lanesByNode = new Map();
        (displayGraph.lanes || []).forEach(lane => {
            [lane.fromNode, lane.toNode].forEach(nodeId => {
                if (!nodeId) return;
                if (!lanesByNode.has(nodeId)) lanesByNode.set(nodeId, []);
                lanesByNode.get(nodeId).push(lane);
            });
        });

        const surfaces = [];
        junctionNodes.forEach(node => {
            const lanes = lanesByNode.get(node.id) || [];
            if (lanes.length < 2) return;
            const anchors = lanes
                .map(lane => laneEndAtNode(lane, node.id)?.at)
                .filter(Boolean);
            if (anchors.length < 2) return;
            const projection = view.localProjection(anchors);
            const corners = lanes.flatMap(lane => lanePortalCorners(lane, node.id, projection));
            if (corners.length < 3) return;
            // Approaches stacked on one another collapse to fewer than three distinct corners, and a
            // hull with no area is the degenerate case — there is nothing here to pave.
            const hull = convexHull(corners);
            if (hull.length < 3) return;
            const xs = hull.map(point => point[0]);
            const ys = hull.map(point => point[1]);
            const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
            surfaces.push({
                nodeId: node.id,
                degree: Number(node.degree),
                spanM: span,
                ring: hull.map(point => projection.unproject(point))
            });
        });
        return surfaces;
    }

    // Adjacent in the cross-section: no third lane of the same section sits between these two.
    function areAdjacent(laneA, laneB, lanesBySection) {
        const offsetA = finite(laneA.offset);
        const offsetB = finite(laneB.offset);
        if (offsetA === null || offsetB === null || offsetA === offsetB) return false;
        const low = Math.min(offsetA, offsetB);
        const high = Math.max(offsetA, offsetB);
        return !(lanesBySection.get(laneA.sectionId) || []).some(lane => {
            const offset = finite(lane.offset);
            return offset !== null && offset > low && offset < high;
        });
    }

    function guideLinesForNode(node, connections, index, lanesBySection, view) {
        const lines = [];
        const movements = new Map();
        connections.forEach(connection => {
            const fromLane = index.lanes.get(connection.fromLaneId);
            const toLane = index.lanes.get(connection.toLaneId);
            if (!fromLane || !toLane) return;
            if (connection.type === 'turn') {
                const coordinates = view.connectionCurve(connection, index);
                if (Array.isArray(coordinates) && coordinates.length >= 2) {
                    lines.push({
                        nodeId: node.id,
                        kind: 'turn',
                        connectionIds: [connection.id],
                        coordinates
                    });
                }
                return;
            }
            // Through movements are graded as a group: a divider only exists BETWEEN two of them.
            const key = `${fromLane.sectionId}->${toLane.sectionId}`;
            if (!movements.has(key)) movements.set(key, []);
            movements.get(key).push({ connection, fromLane, toLane });
        });

        movements.forEach(group => {
            const sorted = group
                .filter(item => finite(item.fromLane.offset) !== null && finite(item.toLane.offset) !== null)
                .sort((left, right) => left.fromLane.offset - right.fromLane.offset);
            for (let position = 0; position + 1 < sorted.length; position += 1) {
                const left = sorted[position];
                const right = sorted[position + 1];
                if (!areAdjacent(left.fromLane, right.fromLane, lanesBySection)) continue;
                if (!areAdjacent(left.toLane, right.toLane, lanesBySection)) continue;
                const leftEnd = laneEndAtNode(left.fromLane, node.id);
                const rightEnd = laneEndAtNode(right.fromLane, node.id);
                const leftStart = laneEndAtNode(left.toLane, node.id);
                const rightStart = laneEndAtNode(right.toLane, node.id);
                if (!leftEnd || !rightEnd || !leftStart || !rightStart) continue;
                const coordinates = view.curveBetween(
                    midpoint(leftEnd.at, rightEnd.at),
                    midpoint(leftEnd.inward, rightEnd.inward),
                    midpoint(leftStart.at, rightStart.at),
                    midpoint(leftStart.inward, rightStart.inward),
                    { turn: false }
                );
                if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
                lines.push({
                    nodeId: node.id,
                    kind: 'through',
                    connectionIds: [left.connection.id, right.connection.id],
                    coordinates
                });
            }
        });
        return lines;
    }

    function junctionGuideLines(displayGraph) {
        const view = viewApi();
        if (!view || !displayGraph) return [];
        const index = view.createIndex(displayGraph);
        const lanesBySection = new Map();
        (displayGraph.lanes || []).forEach(lane => {
            if (lane.sectionId == null) return;
            if (!lanesBySection.has(lane.sectionId)) lanesBySection.set(lane.sectionId, []);
            lanesBySection.get(lane.sectionId).push(lane);
        });
        const lines = [];
        (displayGraph.nodes || [])
            .filter(node => Number(node?.degree) >= MIN_JUNCTION_DEGREE)
            .forEach(node => {
                const connections = index.connectionsByNode.get(node.id) || [];
                if (!connections.length) return;
                lines.push(...guideLinesForNode(node, connections, index, lanesBySection, view));
            });
        return lines;
    }

    function buildJunctionPaint(displayGraph) {
        return {
            surfaces: junctionSurfaces(displayGraph),
            guideLines: junctionGuideLines(displayGraph)
        };
    }

    return {
        MIN_JUNCTION_DEGREE,
        convexHull,
        junctionSurfaces,
        junctionGuideLines,
        buildJunctionPaint
    };
});
