import { describe, expect, it } from 'vitest';
import Geometry from '../../frontend/traffic/geometry.js';
import TrafficSurface from '../../frontend/traffic/surface.js';

function lane(id, fromNode, toNode, points, width = 6, type = 'driving') {
    return { id, fromNode, toNode, points, width, type };
}

function network(lanes, nodes = new Map(), connections = new Map()) {
    return {
        lanes: new Map(lanes.map(item => [item.id, { ...item, path: Geometry.path(item.points) }])),
        nodes,
        connections,
        project: point => point
    };
}

function insideConvexPolygon(point, polygon) {
    let sign = 0;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
        if (Math.abs(cross) < 1e-8) continue;
        const next = Math.sign(cross);
        if (sign && next !== sign) return false;
        sign = next;
    }
    return true;
}

function isRoad(surface, point) {
    const paths = [...surface.lanes, ...(surface.connections || [])];
    return paths.some(item => Geometry.nearest(item.path, point).distance <= (item.width || 3) / 2)
        || (surface.junctions || []).some(item => insideConvexPolygon(point, item.points));
}

describe('traffic road surfaces', () => {
    it('keeps mapped roadbeds when movements are missing or forbidden', () => {
        const sourceLanes = [
            lane('car-lane', 'west', 'junction', [[-20, 0], [0, 0]], 6),
            lane('bus-lane', 'junction', 'east', [[0, 0], [20, 0]], 3.5, 'bus')
        ];
        const missing = TrafficSurface.build(network(sourceLanes), sourceLanes);
        const forbidden = TrafficSurface.build(network(sourceLanes, new Map(), new Map([
            ['blocked', { id: 'blocked', fromLaneId: 'car-lane', toLaneId: 'bus-lane', forbidden: true }]
        ])), sourceLanes);

        expect(missing.lanes.map(item => item.id)).toEqual(['car-lane', 'bus-lane']);
        expect(forbidden.lanes.map(item => item.id)).toEqual(['car-lane', 'bus-lane']);
        expect(forbidden.lanes.map(item => item.path.points)).toEqual(missing.lanes.map(item => item.path.points));
    });

    it('leaves empty corners between perpendicular arms unpaved when no movement passes through them', () => {
        const junction = 'junction';
        const sourceLanes = [
            lane('incoming', 'west', junction, [[-30, 0], [-12, 0]], 3),
            lane('north', junction, 'north-end', [[0, 12], [0, 30]], 3),
            lane('east', junction, 'east-end', [[0, 0], [30, 0]], 3)
        ];
        const graph = network(sourceLanes, new Map([[junction, { id: junction, point: [0, 0], degree: 3 }]]));
        const surface = TrafficSurface.build(graph, sourceLanes);

        expect(isRoad(surface, [-6, 6])).toBe(false);
        for (const point of [[-20, 0], [0, 20], [20, 0]]) expect(isRoad(surface, point)).toBe(true);
    });

    it('paints a real curved turn only within its lane footprint, keeping its empty outside corner', () => {
        const sourceLanes = [
            lane('incoming', 'west', 'junction', [[-30, 0], [-12, 0]], 3),
            lane('north', 'junction', 'north-end', [[0, 12], [0, 30]], 3),
            lane('east', 'junction', 'east-end', [[0, 0], [30, 0]], 3)
        ];
        const graph = network(sourceLanes, new Map([['junction', { degree: 3, point: [0, 0] }]]));
        const turn = Geometry.taper({ x: -12, y: 0, angle: 0 }, { x: 0, y: 12, angle: Math.PI / 2 });
        graph.connections.set('turn', { id: 'turn', fromLaneId: 'incoming', toLaneId: 'north', path: turn });
        const surface = TrafficSurface.build(graph, sourceLanes), middle = Geometry.sample(turn, turn.length / 2);

        expect(surface.connections[0].path).toBe(turn);
        expect(isRoad(surface, [middle.x, middle.y])).toBe(true);
        expect(isRoad(surface, [-6, 6])).toBe(false);
    });

    it.each([[2, 3], [3, 2]])('retains the physical lane fan of a %s-to-%s width transition', (beforeCount, afterCount) => {
        const makeSide = (count, incoming) => Array.from({ length: count }, (_, ordinal) => {
            const y = ((count - 1) / 2 - ordinal) * 3;
            return { ...lane(`${incoming ? 'in' : 'out'}-${ordinal}`, incoming ? 'west' : 'junction',
                incoming ? 'junction' : 'east', incoming ? [[0, y], [100, y]] : [[100, y], [200, y]], 3),
                ordinal, sectionId: incoming ? 'before' : 'after', direction: 'forward' };
        });
        const sourceLanes = [...makeSide(beforeCount, true), ...makeSide(afterCount, false)];
        const moves = (beforeCount === 2 ? [[0, 0], [1, 1], [1, 2]] : [[0, 0], [1, 0], [2, 1]])
            .map(([from, to], i) => ({ id: `move-${i}`, fromLaneId: `in-${from}`, toLaneId: `out-${to}`,
                nodeId: 'junction', type: beforeCount < afterCount ? 'split' : 'merge', path: Geometry.path([[100, 0], [100, 0]]) }));
        const graph = network(sourceLanes, new Map([['junction', { degree: 2 }]]), new Map(moves.map(move => [move.id, move])));
        Object.assign(graph, Geometry.build(graph.lanes, graph.connections, graph.nodes));
        const surface = TrafficSurface.build(graph, sourceLanes);

        expect(surface.connections).toHaveLength(3);
        for (const connection of surface.connections) {
            expect(connection.geometryKind).toBe('taper');
            for (const fraction of [.25, .5, .75]) {
                const pose = Geometry.sample(connection.path, connection.path.length * fraction);
                expect(isRoad(surface, [pose.x, pose.y])).toBe(true);
            }
        }
        const outside = surface.connections[0];
        for (const fraction of [.25, .5, .75]) {
            const pose = Geometry.sample(outside.path, outside.path.length * fraction);
            expect(isRoad(surface, [pose.x - Math.sin(pose.angle) * 2, pose.y + Math.cos(pose.angle) * 2])).toBe(false);
        }
    });

    it('keeps a full physical road across unresolved and forbidden junction portals', () => {
        const source = lane('mapped', 'west', 'east', [[-30, 0], [0, 0], [30, 0]], 3);
        const graph = network([{ ...source, points: [[-20, 0], [20, 0]] }]);
        graph.connections.set('blocked', { id: 'blocked', fromLaneId: source.id, toLaneId: source.id, forbidden: true });

        const result = TrafficSurface.build(graph, [source]);

        expect(result.lanes[0].path.points).toEqual(source.points);
        expect(result.connections).toEqual([]);
        for (const point of [[-29, 0], [-25, 0], [25, 0], [29, 0]]) expect(isRoad(result, point)).toBe(true);
        expect(isRoad(result, [0, 4])).toBe(false);
        expect(graph.lanes.get(source.id).path.points).toEqual([[-20, 0], [20, 0]]);
    });

    it('replaces only a borrowed taper run while retaining the other full junction endpoint', () => {
        const source = lane('mapped', 'transition', 'junction', [[0, 0], [50, 0]], 3);
        const graph = network([{ ...source, points: [[4, 0], [40, 0]] }]);
        graph.lanes.get(source.id).startTrim = 4;
        graph.lanes.get(source.id).endTrim = 0;
        const result = TrafficSurface.build(graph, [source]);

        expect(isRoad(result, [1, 0])).toBe(false);
        expect(isRoad(result, [6, 0])).toBe(true);
        expect(isRoad(result, [49, 0])).toBe(true);
        expect(result.lanes[0].path.points).toEqual([[4, 0], [50, 0]]);
    });
});
