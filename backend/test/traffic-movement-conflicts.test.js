// Exercises swept movement conflicts and safe queue/receiving clearances with finite routes.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import Geometry from '../../frontend/traffic/geometry.js';

const require = createRequire(import.meta.url);
const Collision = require('../../frontend/traffic/collision.js');
const { Index } = require('../../frontend/traffic/movement-conflicts.js');

function connection(id, fromLaneId, toLaneId, points) {
    return { id, fromLaneId, toLaneId, path: Geometry.path(points) };
}

function junction({ approachA, connectorA, exitA, approachB, connectorB, exitB, sharedExit = false }) {
    const lanes = new Map();
    const addLane = (id, fromNode, toNode, points, outgoing = []) => lanes.set(id, {
        id, fromNode, toNode, path: Geometry.path(points), outgoing, exitRoutes: []
    });
    addLane('in-a', 'west', 'junction', approachA, ['move-a']);
    addLane('in-b', 'south', 'junction', approachB, ['move-b']);
    addLane('out-a', 'junction', sharedExit ? 'east' : 'east', exitA);
    addLane('out-b', 'junction', sharedExit ? 'east' : 'north', exitB);
    const moves = new Map([
        ['move-a', { ...connection('move-a', 'in-a', 'out-a', connectorA), nodeId: 'junction' }],
        ['move-b', { ...connection('move-b', 'in-b', 'out-b', connectorB), nodeId: 'junction' }]
    ]);
    const network = {
        junctionGroups: new Map([['junction', 'junction-group'], ['west', 'west'], ['south', 'south'],
            ['east', 'east'], ['north', 'north']]),
        lanes,
        connections: moves,
        nodes: new Map([['junction', { incoming: ['in-a', 'in-b'] }]])
    };
    return { index: new Index(network), first: moves.get('move-a'), second: moves.get('move-b') };
}

describe('traffic movement conflict ranges', () => {
    it('finds finite station ranges where perpendicular vehicle bodies cross', () => {
        const first = connection('east-west', 'east-in', 'west-out', [[-10, 0], [10, 0]]);
        const second = connection('south-north', 'south-in', 'north-out', [[0, -10], [0, 10]]);
        const result = new Index({}).ranges(first, second);

        expect(result).not.toBeNull();
        for (const range of [result.first, result.second]) {
            expect(Number.isFinite(range.start)).toBe(true);
            expect(Number.isFinite(range.end)).toBe(true);
            expect(range.start).toBeLessThanOrEqual(10);
            expect(range.end).toBeGreaterThanOrEqual(10);
            expect(range.end).toBeGreaterThan(range.start);
        }
    });

    it('includes corner rotation in static conflict ranges for a short kink', () => {
        const first = connection('short-kink', 'in-a', 'out-a', [[0, 0], [1, 0], [1, 1]]);
        const second = connection('short-crossing', 'in-b', 'out-b', [[4.86, 2.72], [4.91, 2.72]]);
        const atCorner = { x: 1, y: 0, angle: .6 };
        const other = { x: 4.86, y: 2.72, angle: 0 };

        // The distance samples and endpoint orientations alone miss the body overlap.
        expect(Collision.overlaps({ ...atCorner, angle: 0 }, other)).toBe(false);
        expect(Collision.overlaps({ ...atCorner, angle: Math.PI / 2 }, other)).toBe(false);
        expect(Collision.overlaps(atCorner, other)).toBe(true);

        const conflict = new Index({}).ranges(first, second);
        expect(conflict).not.toBeNull();
        expect(conflict.first.start).toBeLessThanOrEqual(1);
        expect(conflict.first.end).toBeGreaterThanOrEqual(1);
        expect(conflict.second.start).toBe(0);
    });

    it('returns null for separated parallel paths and same-path followers or splits', () => {
        const index = new Index({});
        const parallelA = connection('parallel-a', 'lane-a', 'out-a', [[0, 0], [30, 0]]);
        const parallelB = connection('parallel-b', 'lane-b', 'out-b', [[0, 5], [30, 5]]);
        const samePath = connection('same-path', 'lane-c', 'out-c', [[0, 0], [30, 0]]);
        const splitSibling = connection('split-sibling', 'lane-c', 'out-d', [[0, 0], [0, 30]]);

        expect(index.ranges(parallelA, parallelB)).toBeNull();
        expect(index.ranges(samePath, samePath)).toBeNull();
        expect(index.ranges(samePath, splitSibling)).toBeNull();
    });

    it('does not treat consecutive connectors on a shared lane as a movement conflict', () => {
        const index = new Index({});
        const intoShared = connection('into-shared', 'approach', 'short-shared-lane', [[-5, 0], [0, 0]]);
        const outOfShared = connection('out-of-shared', 'short-shared-lane', 'exit', [[2, 0], [7, 0]]);

        expect(index.ranges(intoShared, outOfShared)).toBeNull();
        expect(index.ranges(outOfShared, intoShared)).toBeNull();
    });

    it('detects intersecting merge movements that share a receiving lane', () => {
        const first = connection('merge-a', 'approach-a', 'merged-lane', [[-12, 0], [0, 0]]);
        const second = connection('merge-b', 'approach-b', 'merged-lane', [[0, -12], [0, 0]]);

        expect(new Index({}).ranges(first, second)).not.toBeNull();
    });

    it('finds nonlocal self-conflicts on a looping trajectory but ignores ordinary following', () => {
        const makePlan = (id, points, exitPoint) => {
            const [startX, startY] = points[0];
            const network = {
                junctionGroups: new Map([['junction', 'physical-junction'], ['outside', 'outside']]),
                lanes: new Map([
                    ['approach', { fromNode: 'outside', toNode: 'junction',
                        path: Geometry.path([[startX - 20, startY], [startX, startY]]) }],
                    ['exit-lane', { fromNode: 'junction', toNode: 'outside', exitRoutes: [],
                        path: Geometry.path([points.at(-1), exitPoint]) }]
                ]),
                connections: new Map()
            };
            const move = { ...connection(id, 'approach', 'exit-lane', points), nodeId: 'junction' };
            return new Index(network).trajectory(move);
        };
        const loop = makePlan('loop', [[-10, 0], [0, 0], [10, 0], [10, 10], [0, 10], [0, -10]], [0, -17]);
        const straight = makePlan('straight', [[0, 20], [30, 20]], [37, 20]);

        expect(new Index({}).ranges(loop, loop)).not.toBeNull();
        expect(new Index({}).ranges(straight, straight)).toBeNull();
    });

    it('swaps cached station ranges on reverse queries without repeating OBB tests', () => {
        const first = connection('cross-a', 'a-in', 'a-out', [[-12, 0], [12, 0]]);
        const second = connection('cross-b', 'b-in', 'b-out', [[0, -12], [0, 12]]);
        const index = new Index({});
        const overlaps = vi.spyOn(Collision, 'overlaps');
        try {
            const forward = index.ranges(first, second);
            const checks = overlaps.mock.calls.length;
            const reverse = index.ranges(second, first);

            expect(forward).not.toBeNull();
            expect(reverse).toEqual({ first: forward.second, second: forward.first });
            expect(overlaps.mock.calls.length).toBe(checks);
        } finally {
            overlaps.mockRestore();
        }
    });

    it('holds a curved approach outside the swept conflict with a parked crossing vehicle', () => {
        const { index, first, second } = junction({
            approachA: [[-25, -7], [-15, -7], [-10, -3], [-5, 0]],
            connectorA: [[-5, 0], [5, 0], [15, 0]],
            exitA: [[15, 0], [30, 0]],
            approachB: [[0, -25], [0, -15], [0, -5]],
            connectorB: [[0, -5], [2, 2], [8, 8], [15, 0]],
            exitB: [[15, 0], [30, 0]]
        });
        const firstPlan = index.trajectory(first, []);
        const secondPlan = index.trajectory(second, []);
        const conflict = index.ranges(firstPlan, secondPlan);
        const clearance = index.entryClearance(first);
        const connectorStart = firstPlan.connectionOffsets.get(first.id);
        const queuePose = Geometry.sample(firstPlan.path, connectorStart - clearance.hold);
        const collidingParkedPair = [];
        for (let stationA = conflict.first.start; stationA <= conflict.first.end; stationA += .5) {
            for (let stationB = conflict.second.start; stationB <= conflict.second.end; stationB += .5) {
                const poseA = Geometry.sample(firstPlan.path, stationA);
                const poseB = Geometry.sample(secondPlan.path, stationB);
                if (Collision.overlaps(poseA, poseB)) collidingParkedPair.push([poseA, poseB]);
            }
        }

        expect(conflict).not.toBeNull();
        expect(collidingParkedPair.length).toBeGreaterThan(0);
        expect(connectorStart - clearance.hold).toBeLessThan(conflict.first.start);
        expect(index.overlapsBody(secondPlan, queuePose)).toBe(false);
    });

    it('requires downstream clearance for a shared merge while separated parallel exits need none', () => {
        const shared = junction({
            approachA: [[-25, 0], [-5, 0]],
            connectorA: [[-5, 0], [5, 0], [15, 0]],
            exitA: [[15, 0], [35, 0]],
            approachB: [[0, -25], [0, -5]],
            connectorB: [[0, -5], [5, 0], [15, 0]],
            exitB: [[15, 0], [35, 0]],
            sharedExit: true
        });
        const parallel = junction({
            approachA: [[-25, 0], [-5, 0]],
            connectorA: [[-5, 0], [15, 0]],
            exitA: [[15, 0], [35, 0]],
            approachB: [[-25, 5], [-5, 5]],
            connectorB: [[-5, 5], [15, 5]],
            exitB: [[15, 5], [35, 5]]
        });

        expect(shared.index.entryClearance(shared.first).exit).toBeGreaterThan(0);
        expect(parallel.index.ranges(parallel.index.trajectory(parallel.first, []),
            parallel.index.trajectory(parallel.second, []))).toBeNull();
        expect(parallel.index.entryClearance(parallel.first).exit).toBe(0);
    });
});
