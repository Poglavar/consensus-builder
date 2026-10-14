import { describe, expect, it } from 'vitest';
import Geometry from '../../frontend/traffic/geometry.js';
import TrafficSurface from '../../frontend/traffic/surface.js';

function lane(id, fromNode, toNode, points, width = 6, type = 'driving') {
    return { id, fromNode, toNode, points, width, type };
}

function network(lanes, nodes = new Map(), connections = new Map()) {
    return {
        lanes: new Map(lanes.map(item => [item.id, { path: Geometry.path(item.points) }])),
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

    it('builds a finite convex junction hull that covers each portal width', () => {
        const junction = 'junction';
        const sourceLanes = [
            lane('east', 'west', junction, [[-20, 0], [0, 0]], 8),
            lane('north', 'north-start', junction, [[0, -20], [0, 0]], 4),
            lane('west', junction, 'east-end', [[0, 0], [20, 0]], 6),
            lane('south', junction, 'south-end', [[0, 0], [0, 20]], 10)
        ];
        const graph = network(sourceLanes, new Map([[junction, { id: junction, point: [0, 0], degree: 4 }]]));
        const surface = TrafficSurface.build(graph, sourceLanes);
        const polygon = surface.junctions.find(item => item.nodeId === junction)?.points;
        const portals = [[0, -4], [0, 4], [-2, 0], [2, 0], [0, -3], [0, 3], [-5, 0], [5, 0]];

        expect(polygon?.length).toBeGreaterThan(2);
        expect(polygon.flat().every(Number.isFinite)).toBe(true);
        for (const portal of portals) expect(insideConvexPolygon(portal, polygon)).toBe(true);
        for (let i = 0; i < polygon.length; i++) {
            const a = polygon[i], b = polygon[(i + 1) % polygon.length], c = polygon[(i + 2) % polygon.length];
            const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
            expect(cross).toBeGreaterThanOrEqual(-1e-8);
        }
    });

    it('reuses the already derived lane path when one is available', () => {
        const source = lane('derived', 'west', 'east', [[0, 2], [8, 2], [16, 2]]);
        const graph = network([source]);
        const route = graph.lanes.get(source.id).path;

        const result = TrafficSurface.build(graph, [source]);

        expect(result.lanes[0].path).toBe(route);
    });
});
