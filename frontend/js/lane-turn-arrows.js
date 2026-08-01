// Painted turn arrows (strelice) — the marking that tells you a lane is straight-only or turn-only.
// OSM states it per lane in turn:lanes; the graph carries it as lane.turn. Pure geometry: metres in
// a lane-local frame (+y along travel, +x to the driver's right), unprojected at the end.
//
// Drawn only on lanes approaching a JUNCTION. An arrow mid-block tells a driver nothing, and every
// turn assignment in OSM exists to describe what happens at the next intersection.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LaneTurnArrows = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MIN_JUNCTION_DEGREE = 3;
    // Back from the portal, so the arrow sits where a driver still has room to change lane.
    const ARROW_SETBACK_M = 9;
    // A lane with less running room than this would carry the arrow into the previous junction.
    const MIN_LANE_LENGTH_M = 14;
    const STEM_M = 3.2;
    const HEAD_M = 1.1;
    const HEAD_ANGLE_RAD = Math.PI * 0.22;

    // Lateral reach of a turning arrow's elbow, and how far up it turns.
    const TURN_REACH = Object.freeze({
        left: { x: -2.1, y: 4.3, elbow: 2.6 },
        right: { x: 2.1, y: 4.3, elbow: 2.6 },
        slight_left: { x: -1.2, y: 4.6, elbow: 3.0 },
        slight_right: { x: 1.2, y: 4.6, elbow: 3.0 },
        sharp_left: { x: -2.6, y: 3.4, elbow: 2.0 },
        sharp_right: { x: 2.6, y: 3.4, elbow: 2.0 },
        // A U-turn reaches back down the way it came.
        reverse: { x: -2.4, y: 2.0, elbow: 3.4 }
    });

    function viewApi() {
        if (typeof globalThis !== 'undefined' && globalThis.LaneTopologyView) {
            return globalThis.LaneTopologyView;
        }
        if (typeof require === 'function') {
            try { return require('./lane-topology-view.js'); } catch (_) { /* browser-only build */ }
        }
        return null;
    }

    // "left;through" is one lane permitting two movements, and it gets one arrow per movement.
    function movementsOf(turn) {
        if (typeof turn !== 'string') return [];
        return turn
            .split(';')
            .map(token => token.trim().toLowerCase())
            .filter(token => token && token !== 'none');
    }

    function headAt(tip, direction) {
        const angle = Math.atan2(direction[1], direction[0]);
        return [HEAD_ANGLE_RAD, -HEAD_ANGLE_RAD].map(offset => {
            const back = angle + Math.PI + offset;
            return [tip, [tip[0] + Math.cos(back) * HEAD_M, tip[1] + Math.sin(back) * HEAD_M]];
        });
    }

    function unit(from, to) {
        const dx = to[0] - from[0];
        const dy = to[1] - from[1];
        const length = Math.hypot(dx, dy);
        return length < 1e-9 ? [0, 1] : [dx / length, dy / length];
    }

    // One movement's glyph in the lane-local frame: a stem, and for a turn an elbow out to the side.
    function glyphFor(movement) {
        if (movement === 'through') {
            const tip = [0, STEM_M + 1.1];
            return [[[0, 0], tip], ...headAt(tip, [0, 1])];
        }
        const reach = TURN_REACH[movement];
        if (!reach) return null;
        const elbow = [0, reach.elbow];
        const tip = [reach.x, reach.y];
        return [[[0, 0], elbow, tip], ...headAt(tip, unit(elbow, tip))];
    }

    function laneEndAtNode(lane, nodeId) {
        const coordinates = lane?.geometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
        if (lane.toNode !== nodeId) return null;
        return coordinates;
    }

    // Walks back from the lane's downstream end to find the anchor and the heading there, so the
    // arrow follows a curving approach instead of pointing at the chord.
    function anchorAlong(coordinates, projection, setbackM) {
        const projected = coordinates.map(point => projection.project(point));
        let remaining = setbackM;
        for (let index = projected.length - 1; index > 0; index -= 1) {
            const to = projected[index];
            const from = projected[index - 1];
            const segment = Math.hypot(to[0] - from[0], to[1] - from[1]);
            if (segment < 1e-9) continue;
            if (segment >= remaining) {
                const ratio = remaining / segment;
                return {
                    at: [to[0] + (from[0] - to[0]) * ratio, to[1] + (from[1] - to[1]) * ratio],
                    forward: unit(from, to)
                };
            }
            remaining -= segment;
        }
        return { at: projected[0], forward: unit(projected[0], projected[projected.length - 1]) };
    }

    function polylineLengthM(coordinates, projection) {
        let total = 0;
        for (let index = 1; index < coordinates.length; index += 1) {
            const a = projection.project(coordinates[index - 1]);
            const b = projection.project(coordinates[index]);
            total += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        return total;
    }

    function buildTurnArrows(displayGraph, options) {
        const view = viewApi();
        if (!view || !displayGraph) return [];
        const setbackM = Number.isFinite(Number(options?.setbackM))
            ? Number(options.setbackM)
            : ARROW_SETBACK_M;
        const junctionNodes = new Set(
            (displayGraph.nodes || [])
                .filter(node => Number(node?.degree) >= MIN_JUNCTION_DEGREE)
                .map(node => node.id)
        );
        if (!junctionNodes.size) return [];

        const arrows = [];
        (displayGraph.lanes || []).forEach(lane => {
            if (!junctionNodes.has(lane.toNode)) return;
            const movements = movementsOf(lane.turn);
            if (!movements.length) return;
            const coordinates = laneEndAtNode(lane, lane.toNode);
            if (!coordinates) return;

            const projection = view.localProjection(coordinates);
            if (polylineLengthM(coordinates, projection) < MIN_LANE_LENGTH_M) return;
            const { at, forward } = anchorAlong(coordinates, projection, setbackM);
            // +x is the driver's right: rotate the heading by -90°.
            const right = [forward[1], -forward[0]];
            const toWorld = ([x, y]) => projection.unproject([
                at[0] + right[0] * x + forward[0] * y,
                at[1] + right[1] * x + forward[1] * y
            ]);

            movements.forEach(movement => {
                const glyph = glyphFor(movement);
                if (!glyph) return;
                arrows.push({
                    laneId: lane.id,
                    nodeId: lane.toNode,
                    movement,
                    turn: lane.turn,
                    shapes: glyph.map(stroke => stroke.map(toWorld))
                });
            });
        });
        return arrows;
    }

    return {
        MIN_JUNCTION_DEGREE,
        ARROW_SETBACK_M,
        MIN_LANE_LENGTH_M,
        movementsOf,
        buildTurnArrows
    };
});
