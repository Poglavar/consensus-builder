import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LaneTopologyView = require('../../frontend/js/lane-topology-view.js');

function graphFixture() {
    return {
        nodes: [
            { id: 'n0', degree: 1 },
            { id: 'n1', degree: 2 },
            { id: 'n2', degree: 2 },
            { id: 'n3', degree: 1 }
        ],
        lanes: [
            {
                id: 'a', fromNode: 'n0', toNode: 'n1',
                geometry: { type: 'LineString', coordinates: [[15.96, 45.8], [15.961, 45.8]] }
            },
            {
                id: 'b', fromNode: 'n1', toNode: 'n2',
                geometry: { type: 'LineString', coordinates: [[15.96102, 45.80001], [15.962, 45.801]] }
            },
            {
                id: 'c', fromNode: 'n2', toNode: 'n3',
                geometry: { type: 'LineString', coordinates: [[15.96201, 45.80102], [15.963, 45.80102]] }
            }
        ],
        connections: [
            {
                id: 'ab', nodeId: 'n1', fromLaneId: 'a', toLaneId: 'b',
                geometry: { type: 'LineString', coordinates: [[15.961, 45.8], [15.96102, 45.80001]] }
            },
            {
                id: 'bc', nodeId: 'n2', fromLaneId: 'b', toLaneId: 'c',
                geometry: { type: 'LineString', coordinates: [[15.962, 45.801], [15.96201, 45.80102]] }
            }
        ]
    };
}

describe('lane topology viewer model', () => {
    it('traces only a lane and its immediate predecessors and successors', () => {
        const index = LaneTopologyView.createIndex(graphFixture());
        const focus = LaneTopologyView.focusLane(index, 'b');

        expect([...focus.laneIds].sort()).toEqual(['a', 'b', 'c']);
        expect([...focus.connectionIds].sort()).toEqual(['ab', 'bc']);
        expect([...focus.nodeIds].sort()).toEqual(['n1', 'n2']);
    });

    it('isolates the movements and lanes at one junction', () => {
        const index = LaneTopologyView.createIndex(graphFixture());
        const focus = LaneTopologyView.focusNode(index, 'n1');

        expect([...focus.laneIds].sort()).toEqual(['a', 'b']);
        expect([...focus.connectionIds]).toEqual(['ab']);
        expect([...focus.nodeIds]).toEqual(['n1']);
    });

    it('builds a smooth connector that preserves exact lane endpoints', () => {
        const graph = graphFixture();
        const index = LaneTopologyView.createIndex(graph);
        const curve = LaneTopologyView.connectionCurve(graph.connections[0], index, 12);

        expect(curve).toHaveLength(13);
        expect(curve[0][0]).toBeCloseTo(15.961, 10);
        expect(curve[0][1]).toBeCloseTo(45.8, 10);
        expect(curve.at(-1)[0]).toBeCloseTo(15.96102, 10);
        expect(curve.at(-1)[1]).toBeCloseTo(45.80001, 10);
        expect(curve.slice(1, -1).some(point => point[1] !== curve[0][1])).toBe(true);
    });

    it('keeps a tight turn inside the angle formed by its two lane tangents', () => {
        const graph = {
            nodes: [{ id: 'corner', degree: 2 }],
            lanes: [
                {
                    id: 'in', fromNode: 'west', toNode: 'corner',
                    geometry: {
                        type: 'LineString',
                        coordinates: [[14.99998, 45], [15, 45]]
                    }
                },
                {
                    id: 'out', fromNode: 'corner', toNode: 'north',
                    geometry: {
                        type: 'LineString',
                        coordinates: [[15.00002, 45.00002], [15.00002, 45.00004]]
                    }
                }
            ],
            connections: [{
                id: 'turn',
                nodeId: 'corner',
                fromLaneId: 'in',
                toLaneId: 'out',
                type: 'turn'
            }]
        };
        const index = LaneTopologyView.createIndex(graph);
        const curve = LaneTopologyView.connectionCurve(graph.connections[0], index, 24);

        expect(Math.min(...curve.map(point => point[0]))).toBeGreaterThanOrEqual(15);
        expect(Math.max(...curve.map(point => point[0]))).toBeLessThanOrEqual(15.00002);
        expect(Math.min(...curve.map(point => point[1]))).toBeGreaterThanOrEqual(45);
        expect(Math.max(...curve.map(point => point[1]))).toBeLessThanOrEqual(45.00002);
    });

    it('does not cut lanes at harmless degree-two OSM way boundaries', () => {
        const graph = graphFixture();
        const display = LaneTopologyView.buildDisplayGraph(graph);

        expect(display.lanes.map(lane => lane.geometry.coordinates))
            .toEqual(graph.lanes.map(lane => lane.geometry.coordinates));
        expect(display.display.nodeSetbacksM).toEqual({});
    });

    it('cuts lanes back to portals at a real junction and connects those portals', () => {
        const graph = {
            nodes: [
                { id: 'west', degree: 1 },
                { id: 'corner', degree: 3 },
                { id: 'north', degree: 1 },
                { id: 'east', degree: 1 }
            ],
            lanes: [
                {
                    id: 'in', fromNode: 'west', toNode: 'corner', width: 3.2, offset: -1.8,
                    geometry: {
                        type: 'LineString',
                        coordinates: [[14.9998, 45], [15, 45]]
                    }
                },
                {
                    id: 'out', fromNode: 'corner', toNode: 'north', width: 3.2, offset: 1.8,
                    geometry: {
                        type: 'LineString',
                        coordinates: [[15.00002, 45.00002], [15.00002, 45.0002]]
                    }
                },
                {
                    id: 'cross', fromNode: 'corner', toNode: 'east', width: 3, offset: 0,
                    geometry: {
                        type: 'LineString',
                        coordinates: [[15, 45.00001], [15.0002, 45.00001]]
                    }
                }
            ],
            connections: [{
                id: 'turn',
                nodeId: 'corner',
                fromLaneId: 'in',
                toLaneId: 'out',
                type: 'turn'
            }]
        };
        const display = LaneTopologyView.buildDisplayGraph(graph);
        const displayIndex = LaneTopologyView.createIndex(display);
        const incoming = displayIndex.lanes.get('in').geometry.coordinates;
        const outgoing = displayIndex.lanes.get('out').geometry.coordinates;
        const curve = LaneTopologyView.connectionCurve(display.connections[0], displayIndex);

        expect(incoming.at(-1)[0]).toBeLessThan(15);
        expect(outgoing[0][1]).toBeGreaterThan(45.00002);
        expect(curve[0]).toEqual(incoming.at(-1));
        expect(curve.at(-1)).toEqual(outgoing[0]);
        expect(display.display.nodeSetbacksM.corner).toBeGreaterThanOrEqual(5.5);
    });

    it('places direction arrows by travelled distance rather than vertex count', () => {
        const point = LaneTopologyView.pointAlong([
            [15, 45],
            [15.0001, 45],
            [15.001, 45]
        ], .5);

        expect(point.point[0]).toBeCloseTo(15.0005, 6);
        expect(point.before).toEqual([15.0001, 45]);
        expect(point.after).toEqual([15.001, 45]);
    });
});
