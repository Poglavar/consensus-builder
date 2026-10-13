import { describe, expect, it } from 'vitest';
import Geometry from '../../frontend/traffic/geometry.js';

const { path, sample, build } = Geometry;
const J = 'junction';

function lane(id, { y, fromNode, toNode, ordinal, x0 = 0, x1 = 100 }) {
    return {
        id,
        sectionId: `section-${fromNode}-${toNode}`,
        direction: 'forward',
        fromNode,
        toNode,
        ordinal,
        path: path([[x0, y], [x1, y]])
    };
}

function movement(id, fromLaneId, toLaneId, type = 'continue') {
    return { id, fromLaneId, toLaneId, nodeId: J, type, path: path([[100, 0], [100, 0]]) };
}

function pointAt(p, s) {
    const pose = sample(p, s);
    return [pose.x, pose.y];
}

function angleAtStart(p) {
    const a = pointAt(p, 0);
    const b = pointAt(p, Math.min(0.25, p.length / 10));
    return Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0])) * 180 / Math.PI;
}

function angleAtEnd(p) {
    const a = pointAt(p, Math.max(0, p.length - Math.min(0.25, p.length / 10)));
    const b = pointAt(p, p.length);
    return Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0])) * 180 / Math.PI;
}

function noBacktracking(p) {
    const n = Math.max(20, Math.ceil(p.length / 2));
    const points = Array.from({ length: n + 1 }, (_, i) => pointAt(p, p.length * i / n));
    return points.slice(1).every((point, i) => point[0] >= points[i][0] - 1e-6);
}

function endpoints(p) {
    return [pointAt(p, 0), pointAt(p, p.length)];
}

function expectSamePoint(a, b, tolerance = 1e-5) {
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(tolerance);
}

function splitFixture() {
    const lanes = new Map([
        ['in-0', lane('in-0', { y: 1.75, fromNode: 'west', toNode: J, ordinal: 0 })],
        ['in-1', lane('in-1', { y: -1.75, fromNode: 'west', toNode: J, ordinal: 1 })],
        ['out-0', lane('out-0', { y: 3.5, fromNode: J, toNode: 'east', ordinal: 0, x0: 100, x1: 200 })],
        ['out-1', lane('out-1', { y: 0, fromNode: J, toNode: 'east', ordinal: 1, x0: 100, x1: 200 })],
        ['out-2', lane('out-2', { y: -3.5, fromNode: J, toNode: 'east', ordinal: 2, x0: 100, x1: 200 })]
    ]);
    const connections = new Map([
        ['m0', movement('m0', 'in-0', 'out-0')],
        ['m1', movement('m1', 'in-1', 'out-1', 'split')],
        ['m2', movement('m2', 'in-1', 'out-2', 'split')]
    ]);
    return { lanes, connections, nodes: new Map([[J, { id: J, degree: 2 }]]) };
}

function mergeFixture() {
    const lanes = new Map([
        ['in-0', lane('in-0', { y: 3.5, fromNode: 'west', toNode: J, ordinal: 0 })],
        ['in-1', lane('in-1', { y: 0, fromNode: 'west', toNode: J, ordinal: 1 })],
        ['in-2', lane('in-2', { y: -3.5, fromNode: 'west', toNode: J, ordinal: 2 })],
        ['out-0', lane('out-0', { y: 1.75, fromNode: J, toNode: 'east', ordinal: 0, x0: 100, x1: 200 })],
        ['out-1', lane('out-1', { y: -1.75, fromNode: J, toNode: 'east', ordinal: 1, x0: 100, x1: 200 })]
    ]);
    const connections = new Map([
        ['m0', movement('m0', 'in-0', 'out-0')],
        ['m1', movement('m1', 'in-1', 'out-0', 'merge')],
        ['m2', movement('m2', 'in-2', 'out-1')]
    ]);
    return { lanes, connections, nodes: new Map([[J, { id: J, degree: 2 }]]) };
}

function expectTaperedResult(fixture) {
    const originals = [...fixture.lanes.values()].map(item => item.path.points.map(p => [...p]));
    const originalConnections = [...fixture.connections.values()].map(item => item.path.points.map(p => [...p]));
    const result = build(fixture.lanes, fixture.connections, fixture.nodes);
    expect(result.lanes).toBeInstanceOf(Map);
    expect(result.connections).toBeInstanceOf(Map);
    expect([...result.connections.keys()]).toEqual([...fixture.connections.keys()]);
    expect([...result.connections.values()].map(c => [c.id, c.fromLaneId, c.toLaneId]))
        .toEqual([...fixture.connections.values()].map(c => [c.id, c.fromLaneId, c.toLaneId]));

    const tapered = [...result.connections.values()].filter(c => c.geometryKind === 'taper');
    expect(tapered.length).toBeGreaterThan(0);
    for (const connection of tapered) {
        expect(connection.path.length).toBeGreaterThanOrEqual(20);
        expect(noBacktracking(connection.path)).toBe(true);
        expect(angleAtStart(connection.path)).toBeLessThan(6);
        expect(angleAtEnd(connection.path)).toBeLessThan(6);
        const [start, end] = endpoints(connection.path);
        expect(end[0] - start[0]).toBeGreaterThanOrEqual(20);
        const points = Array.from({ length: 21 }, (_, i) => pointAt(connection.path, connection.path.length * i / 20));
        expect(Math.max(...points.map(p => Math.abs(p[1])))).toBeLessThan(5);
        const incoming = result.lanes.get(connection.fromLaneId);
        const outgoing = result.lanes.get(connection.toLaneId);
        expectSamePoint(pointAt(incoming.path, incoming.path.length), pointAt(connection.path, 0));
        expectSamePoint(pointAt(outgoing.path, 0), pointAt(connection.path, connection.path.length));
    }

    // Routes sharing this straight arm retain their lateral order at both ends.
    const byId = result.connections;
    for (const [above, below] of [['m0', 'm1'], ['m1', 'm2']]) {
        const upper = byId.get(above);
        const lower = byId.get(below);
        if (!upper?.path || !lower?.path) continue;
        for (let step = 0; step <= 20; step++) {
            const fraction = step / 20;
            const upperPoint = pointAt(upper.path, upper.path.length * fraction);
            const lowerPoint = pointAt(lower.path, lower.path.length * fraction);
            expect(upperPoint[1] - lowerPoint[1]).toBeGreaterThanOrEqual(-1e-4);
        }
    }

    expect([...fixture.lanes.values()].map(item => item.path.points)).toEqual(originals);
    expect([...fixture.connections.values()].map(item => item.path.points)).toEqual(originalConnections);
}

describe('traffic lane geometry transitions', () => {
    it('builds a smooth, non-crossing 2-to-3 split with a long enough taper', () => {
        expectTaperedResult(splitFixture());
    });

    it('builds a smooth 3-to-2 merge with a long enough taper', () => {
        expectTaperedResult(mergeFixture());
    });

    it('removes the degenerate loop from a coincident straight continuation', () => {
        const lanes = new Map([
            ['in', lane('in', { y: 0, fromNode: 'west', toNode: J, ordinal: 0 })],
            ['out', lane('out', { y: 0, fromNode: J, toNode: 'east', ordinal: 0, x0: 100, x1: 200 })]
        ]);
        const loop = path([[100, 0], [100.5, 0], [99.5, 0], [100, 0]]);
        expect(loop.length).toBeGreaterThan(1);
        const connections = new Map([['straight', { ...movement('straight', 'in', 'out'), path: loop }]]);
        const result = build(lanes, connections, new Map([[J, { degree: 2 }]]));
        const connected = result.connections.get('straight');
        expect(connected.geometryKind).toBe('continuation');
        expect(connected.path.length).toBeLessThan(1e-5);
        for (const fraction of [0, 0.5, 1]) {
            const pose = sample(connected.path, connected.path.length * fraction);
            expect([pose.x, pose.y, pose.angle].every(Number.isFinite)).toBe(true);
        }
    });

    it('cleans a coincident straight loop without trimming a shared source or changing its turn', () => {
        const lanes = new Map([
            ['in', lane('in', { y: 0, fromNode: 'west', toNode: J, ordinal: 0 })],
            ['out', lane('out', { y: 0, fromNode: J, toNode: 'east', ordinal: 0, x0: 100, x1: 200 })],
            ['turn-out', lane('turn-out', { y: 0, fromNode: J, toNode: 'north', ordinal: 0, x0: 100, x1: 200 })]
        ]);
        const loop = path([[100, 0], [100.5, 0], [99.5, 0], [100, 0]]);
        const turnPath = path([[100, 0], [104, 4], [108, 11]]);
        const connections = new Map([
            ['straight', { ...movement('straight', 'in', 'out'), path: loop }],
            ['turn', { ...movement('turn', 'in', 'turn-out', 'turn'), path: turnPath }]
        ]);
        const result = build(lanes, connections, new Map([[J, { degree: 2 }]]));

        expect(result.connections.get('straight').geometryKind).toBe('continuation');
        expect(result.connections.get('straight').path.length).toBeLessThan(1e-5);
        expect(result.connections.get('turn').geometryKind).toBeUndefined();
        expect(result.connections.get('turn').path).toBe(turnPath);
        for (const [id, original] of lanes) {
            expect(result.lanes.get(id).startTrim).toBe(0);
            expect(result.lanes.get(id).endTrim).toBe(0);
            expect(result.lanes.get(id).path).toBe(original.path);
        }
    });

    it('bridges near-coincident section ends forward and preserves heading when a turn blocks trimming', () => {
        const lanes = new Map([
            ['in', lane('in', { y: 0, fromNode: 'west', toNode: J, ordinal: 0 })],
            ['out', lane('out', { y: 0, fromNode: J, toNode: 'east', ordinal: 0, x0: 99.94, x1: 199.94 })]
        ]);
        const loop = path([[100, 0], [100.5, 0], [99.5, 0], [99.94, 0]]);
        const straight = movement('straight', 'in', 'out');
        straight.path = loop;
        const result = build(lanes, new Map([['straight', straight]]), new Map([[J, { degree: 2 }]]));
        const incoming = result.lanes.get('in'), outgoing = result.lanes.get('out');
        const connected = result.connections.get('straight');
        expect(connected.geometryKind).toBe('continuation');
        expect(connected.path.length).toBeGreaterThan(3);
        const [start, end] = endpoints(connected.path);
        expect(end[0] - start[0]).toBeGreaterThan(3);
        expect(noBacktracking(connected.path)).toBe(true);
        for (let step = 0; step <= 20; step++) {
            expect(sample(connected.path, connected.path.length * step / 20).angle).toBeCloseTo(0, 5);
        }
        expectSamePoint(pointAt(incoming.path, incoming.path.length), start);
        expectSamePoint(pointAt(outgoing.path, 0), end);

        const blockedLanes = new Map([
            ['in', lane('in', { y: 0, fromNode: 'west', toNode: J, ordinal: 0 })],
            ['out', lane('out', { y: 0, fromNode: J, toNode: 'east', ordinal: 0, x0: 99.94, x1: 199.94 })],
            ['turn-out', lane('turn-out', { y: 0, fromNode: J, toNode: 'north', ordinal: 0, x0: 100, x1: 200 })]
        ]);
        const turnPath = path([[100, 0], [104, 4], [108, 11]]);
        const blockedConnections = new Map([
            ['straight', { ...movement('straight', 'in', 'out'), path: loop }],
            ['turn', { ...movement('turn', 'in', 'turn-out', 'turn'), path: turnPath }]
        ]);
        const blocked = build(blockedLanes, blockedConnections, new Map([[J, { degree: 2 }]]));
        const shortLink = blocked.connections.get('straight');
        expect(blocked.lanes.get('in').endTrim).toBe(0);
        expect(blocked.lanes.get('out').startTrim).toBe(0);
        expect(shortLink.path.length).toBeLessThan(.2);
        for (const distance of [0, shortLink.path.length / 2, shortLink.path.length]) {
            expect(sample(shortLink.path, distance).angle).toBeCloseTo(0, 5);
        }
        expect(blocked.connections.get('turn').path).toBe(turnPath);
    });

    it('leaves genuine degree-3 turns unchanged', () => {
        const lanes = new Map([
            ['in', lane('in', { y: 0, fromNode: 'west', toNode: J, ordinal: 0 })],
            ['out', lane('out', { y: 0, fromNode: J, toNode: 'north', ordinal: 0, x0: 100, x1: 200 })]
        ]);
        const turnPath = path([[100, 0], [105, 5], [110, 10]]);
        const connections = new Map([['turn', { ...movement('turn', 'in', 'out', 'turn'), path: turnPath }]]);
        const result = build(lanes, connections, new Map([[J, { degree: 3 }]]));
        expect(result.connections.get('turn').geometryKind).toBeUndefined();
        expect(result.connections.get('turn').path).toBe(turnPath);
    });

    it('keeps incoming stop positions and limits transition trim for an early outgoing signal', () => {
        const fixture = splitFixture();
        const result = build(fixture.lanes, fixture.connections, fixture.nodes, [
            { controls: [{ laneId: 'in-0', fraction: 1 }, { laneId: 'out-0', fraction: 0.1 }] }
        ]);
        expect(result.lanes.get('in-0').endTrim).toBe(0);
        expect(result.lanes.get('out-0').startTrim).toBeLessThanOrEqual(10);
        expect(result.lanes.get('out-0').path.length).toBeGreaterThan(0);
    });

    it('keeps positive lane lengths when transitions at both ends compete for a short section', () => {
        const left = 'left-junction';
        const right = 'right-junction';
        const lanes = new Map([
            ['west', lane('west', { y: 3.5, fromNode: 'far-west', toNode: left, ordinal: 0, x0: -88, x1: 12 })],
            ['short', lane('short', { y: 0, fromNode: left, toNode: right, ordinal: 0, x0: 12, x1: 24 })],
            ['east', lane('east', { y: -3.5, fromNode: right, toNode: 'far-east', ordinal: 0, x0: 24, x1: 124 })]
        ]);
        const connections = new Map([
            ['enter-short', { ...movement('enter-short', 'west', 'short'), nodeId: left }],
            ['leave-short', { ...movement('leave-short', 'short', 'east'), nodeId: right }]
        ]);
        const nodes = new Map([[left, { degree: 2 }], [right, { degree: 2 }]]);
        const result = build(lanes, connections, nodes);
        for (const item of result.lanes.values()) expect(item.path.length).toBeGreaterThan(0);
        expect(result.lanes.get('short').startTrim).toBeGreaterThan(0);
        expect(result.lanes.get('short').endTrim).toBeGreaterThan(0);
    });
});
