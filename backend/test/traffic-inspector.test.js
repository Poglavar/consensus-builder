// Pure tests for the selected-car inspector; fixtures use a tiny directed road graph.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Traffic = require('../../frontend/traffic/simulation.js');
const Collision = require('../../frontend/traffic/collision.js');
const { Simulation, createNetwork, signalAspect } = Traffic;

const ORIGIN = [15.98, 45.81];
const METRES_PER_DEGREE = 111320;
const xScale = METRES_PER_DEGREE * Math.cos(ORIGIN[1] * Math.PI / 180);
const geo = ([x, y]) => [ORIGIN[0] + x / xScale, ORIGIN[1] + y / METRES_PER_DEGREE];

function lane(id, fromNode, toNode, start, end, sectionId = id) {
    return {
        id, sectionId, sourceWayId: `way-${id}`, fromNode, toNode,
        direction: 'forward', type: 'driving', access: 'yes', highway: 'residential',
        width: 3.5, ordinal: 0, stripIndex: 0, change: 'yes', maxSpeed: 50,
        points: [geo(start), geo(end)]
    };
}

function fixture({ signals = [], withExit = false, length = 100 } = {}) {
    const lanes = [lane('approach', 'west', 'junction', [0, 0], [length, 0], 'main-road')];
    const connections = [];
    if (withExit) {
        lanes.push(lane('exit', 'junction', 'east', [length, 0], [length + 100, 0], 'exit-road'));
        connections.push({ id: 'move', fromLaneId: 'approach', toLaneId: 'exit', nodeId: 'junction',
            points: [geo([length, 0]), geo([length, 0])] });
    }
    const nodeIds = new Set(lanes.flatMap(item => [item.fromNode, item.toNode]));
    return createNetwork({
        bbox: [ORIGIN[0] - .01, ORIGIN[1] - .01, ORIGIN[0] + .01, ORIGIN[1] + .01],
        nodes: [...nodeIds].map(id => ({ id, degree: id === 'junction' ? 3 : 2 })),
        lanes, connections, signals
    });
}

function movementFixture() {
    const lanes = [
        lane('approach', 'west', 'junction', [0, 0], [46, 0], 'main-road'),
        lane('exit', 'junction', 'east', [54, 0], [100, 0], 'main-exit'),
        lane('cross-approach', 'south', 'junction', [50, -50], [50, -4], 'cross-road'),
        lane('cross-exit', 'junction', 'north', [50, 4], [50, 50], 'cross-exit'),
        lane('parallel-approach', 'west-parallel', 'parallel-junction', [0, 10], [46, 10], 'parallel-road'),
        lane('parallel-exit', 'parallel-junction', 'east-parallel', [54, 10], [100, 10], 'parallel-exit')
    ];
    const connection = (id, fromLaneId, toLaneId, nodeId, points) => ({
        id, fromLaneId, toLaneId, nodeId, points: points.map(geo)
    });
    const connections = [
        connection('main', 'approach', 'exit', 'junction', [[46, 0], [50, 0], [54, 0]]),
        connection('cross', 'cross-approach', 'cross-exit', 'junction', [[50, -4], [50, 0], [50, 4]]),
        connection('parallel', 'parallel-approach', 'parallel-exit', 'parallel-junction', [[46, 10], [50, 10], [54, 10]]),
        connection('same-path', 'approach', 'exit', 'junction', [[46, 0], [50, 0], [54, 0]])
    ];
    const nodeIds = new Set(lanes.flatMap(item => [item.fromNode, item.toNode]));
    return createNetwork({
        bbox: [ORIGIN[0] - .01, ORIGIN[1] - .01, ORIGIN[0] + .01, ORIGIN[1] + .01],
        nodes: [...nodeIds].map(id => ({ id, degree: id.includes('junction') ? 4 : 2 })),
        lanes, connections, signals: []
    });
}

function car(id, s, next = null, overrides = {}) {
    return { id, laneId: 'approach', mode: 'lane', s, speed: 0, cruise: 8, color: 0,
        next, state: 'queue', change: null, cooldown: Infinity, clearance: null, ...overrides };
}

function simFor(network, cars = [], signals = true) {
    const sim = new Simulation(network, { count: 0, seed: 91, signals });
    sim.cars.push(...cars);
    return sim;
}

function timeWhen(network, signalId, aspect) {
    const signal = [...network.signals.values()].find(item => item.sourceIds.includes(signalId));
    const phase = signal.phases[0];
    for (let time = 0; time < 240; time += .1) {
        if (signalAspect(signal, phase, time) === aspect) return time;
    }
    throw new Error(`No ${aspect} interval found for ${signalId}`);
}

describe('traffic selected-car inspector', () => {
    it('reports the exact red signal controlling the current stop', () => {
        const network = fixture({ withExit: true, length: 200, signals: [
            { id: 'passed-signal', point: geo([50, 0]), controls: [{ laneId: 'approach', fraction: .25 }] },
            { id: 'controlling-signal', point: geo([100, 0]), controls: [{ laneId: 'approach', fraction: .5 }] }
        ] });
        const approach = network.lanes.get('approach');
        const control = approach.signals.find(item => network.signals.get(item.signalId).sourceIds.includes('controlling-signal'));
        const head = network.signals.get(control.signalId);
        const vehicle = car(1, control.stopS - .1, 'move');
        const sim = simFor(network, [vehicle]);
        sim.time = timeWhen(network, 'controlling-signal', 'red');

        const reason = sim.inspectCar(vehicle);
        expect(reason.kind).toBe('signal');
        expect(reason.signal).toMatchObject({ id: head.id, sourceIds: ['controlling-signal'],
            direction: 'E', aspect: 'red' });
        expect(reason.signal.distance).toBeCloseTo(.1, 5);
        expect(reason.signal.point).toEqual(head.point);
        expect(head.sourcePoints).toContainEqual(geo([100, 0]));
    });

    it('reports a nearer following car instead of a red signal farther ahead', () => {
        const network = fixture({ signals: [
            { id: 'far-red', point: geo([90, 0]), controls: [{ laneId: 'approach', fraction: .9 }] }
        ] });
        const vehicle = car(1, 20);
        const leader = car(2, 27);
        const sim = simFor(network, [vehicle, leader]);
        sim.time = timeWhen(network, 'far-red', 'red');

        const reason = sim.inspectCar(vehicle);
        expect(reason).toMatchObject({ kind: 'following', carId: 2 });
        expect(reason.distance).toBe(0);
        expect(reason.signal).toMatchObject({ sourceIds: ['far-red'], aspect: 'red' });
    });

    it('reports the other car when perpendicular movements occupy the same conflict window', () => {
        const network = movementFixture();
        const main = network.connections.get('main');
        const cross = network.connections.get('cross');
        const conflict = network.movementConflicts.ranges(main, cross);
        expect(conflict).not.toBeNull();

        const vehicle = car(1, conflict.first.start - .55, 'main', {
            mode: 'connection', connectionId: 'main', enteredAt: 1
        });
        const blocker = car(72, conflict.second.start + .1, null, {
            laneId: 'cross-approach', mode: 'connection', connectionId: 'cross', enteredAt: 0
        });
        const sim = simFor(network, [vehicle, blocker], false);

        expect(sim.inspectCar(vehicle)).toMatchObject({ kind: 'collision', carId: 72 });
    });

    it('does not treat near-parallel movements or same-path followers as geometric conflicts', () => {
        const network = movementFixture();
        const main = network.connections.get('main');
        const parallel = network.connections.get('parallel');
        const samePath = network.connections.get('same-path');
        expect(network.movementConflicts.ranges(main, parallel)).toBeNull();
        expect(network.movementConflicts.ranges(main, samePath)).toBeNull();

        const vehicle = car(1, 2, 'main', { mode: 'connection', connectionId: 'main', enteredAt: 1 });
        for (const [otherId, connectionId, laneId] of [[2, 'parallel', 'parallel-approach'], [3, 'same-path', 'approach']]) {
            const other = car(otherId, 2, null, { mode: 'connection', connectionId, laneId, enteredAt: 0 });
            const sim = simFor(network, [vehicle, other], false);
            expect(sim.limits(vehicle, sim.occupants()).conflict).toEqual({ distance: Infinity, carId: null });
            expect(sim.inspectCar(vehicle).kind).not.toBe('collision');
            if (connectionId === 'same-path') expect(sim.inspectCar(vehicle)).toMatchObject({ kind: 'following', carId: 3 });
        }
    });

    it('names the car blocking receiving space beyond a junction', () => {
        const network = fixture({ withExit: true });
        const vehicle = car(1, network.lanes.get('approach').path.length, 'move');
        const blocker = { ...car(72, 3), laneId: 'exit', next: null };
        const sim = simFor(network, [vehicle, blocker]);

        expect(sim.inspectCar(vehicle)).toMatchObject({ kind: 'exit', carId: 72 });
    });

    it('reports a lane-closure gate and a recorded physical collision blocker', () => {
        const network = fixture({ withExit: true });
        const vehicle = car(1, network.lanes.get('approach').path.length, 'move');
        const sim = simFor(network, [vehicle]);
        sim.gates.push({ distance: () => 0, blocksEntry: () => true });
        expect(sim.inspectCar(vehicle)).toMatchObject({ kind: 'closure' });

        sim.gates.length = 0;
        vehicle.collisionBlocker = 88;
        expect(sim.inspectCar(vehicle)).toMatchObject({ kind: 'collision', carId: 88 });
    });

    it('records and inspects a real collision rollback without losing either car', () => {
        const approach = lane('approach', 'west', 'east', [0, 0], [100, 0], 'east-west');
        const perpendicular = lane('perpendicular', 'south', 'north', [24.6, -100], [24.6, 0], 'north-south');
        const nodeIds = ['west', 'east', 'south', 'north'];
        const network = createNetwork({
            bbox: [ORIGIN[0] - .01, ORIGIN[1] - .01, ORIGIN[0] + .01, ORIGIN[1] + .01],
            nodes: nodeIds.map(id => ({ id, degree: 2 })),
            lanes: [approach, perpendicular], connections: [], signals: []
        });
        const vehicle = car(1, 20, null, { speed: 4.5 });
        const parked = { ...car(88, network.lanes.get('perpendicular').path.length), laneId: 'perpendicular' };
        const sim = simFor(network, [vehicle, parked], false);

        expect(Collision.overlaps(sim.pose(vehicle), sim.pose(parked))).toBe(false);
        for (let tick = 0; tick < 30 && vehicle.collisionBlocker == null; tick++) sim.advance(.1);

        expect(vehicle.speed).toBe(0);
        expect(vehicle.collisionBlocker).toBe(88);
        expect(sim.inspectCar(vehicle)).toMatchObject({ kind: 'collision', carId: 88 });
        expect(sim.cars.map(item => item.id)).toEqual([1, 88]);
        expect(Collision.overlaps(sim.pose(vehicle), sim.pose(parked))).toBe(false);
    });

    it('distinguishes no permitted exit, ready-to-move, and moving states', () => {
        const network = fixture();
        const stopped = car(1, 20);
        const terminal = car(2, network.lanes.get('approach').path.length);
        const moving = car(3, 30, null, { speed: 4.5 });
        const sim = simFor(network, [stopped, terminal, moving]);

        expect(sim.inspectCar(stopped)).toMatchObject({ kind: 'starting' });
        expect(sim.inspectCar(terminal)).toMatchObject({ kind: 'noExit' });
        expect(sim.inspectCar(moving)).toMatchObject({ kind: 'moving', speed: 16.2 });
    });

    it('ignores passed controls and all controls when signals are switched off', () => {
        const network = fixture({ signals: [
            { id: 'behind', point: geo([25, 0]), controls: [{ laneId: 'approach', fraction: .25 }] }
        ] });
        const vehicle = car(1, 75);
        const enabled = simFor(network, [vehicle]);
        expect(enabled.signalAhead(vehicle)).toBeNull();
        expect(enabled.inspectCar(vehicle)).toMatchObject({ kind: 'starting', signal: null });

        const connectionCar = car(3, 75, 'move', { mode: 'connection', connectionId: 'move', s: .1 });
        const connected = simFor(fixture({ withExit: true, signals: [
            { id: 'not-on-connector', point: geo([90, 0]), controls: [{ laneId: 'approach', fraction: .9 }] }
        ] }), [connectionCar]);
        expect(connected.signalAhead(connectionCar)).toBeNull();

        const disabled = simFor(network, [car(2, 0)], false);
        expect(disabled.signalAhead(disabled.cars[0])).toBeNull();
        expect(disabled.inspectCar(disabled.cars[0])).toMatchObject({ kind: 'starting', signal: null });
    });

    it('includes mapped signals on the target lane during a lane change using its distance scale', () => {
        const target = lane('target', 'west', 'junction', [0, 4], [120, 4], 'main-road');
        target.ordinal = 1;
        target.stripIndex = 1;
        const laneSignals = createNetwork({
            bbox: [ORIGIN[0] - .01, ORIGIN[1] - .01, ORIGIN[0] + .01, ORIGIN[1] + .01],
            nodes: [{ id: 'west', degree: 2 }, { id: 'junction', degree: 2 }, { id: 'east', degree: 2 }],
            lanes: [lane('approach', 'west', 'junction', [0, 0], [100, 0], 'main-road'), target],
            connections: [], signals: [{ id: 'target-lane-signal', point: geo([96, 4]),
                controls: [{ laneId: 'target', fraction: .8 }] }]
        });
        const vehicle = car(1, 50, null, { change: { to: 'target', progress: .4, duration: 3.2 } });
        const sim = simFor(laneSignals, [vehicle]);

        const signal = sim.signalAhead(vehicle);
        expect(signal.sourceIds).toEqual(['target-lane-signal']);
        expect(signal.id).toMatch(/^signal:/);
        const control = laneSignals.lanes.get('target').signals[0];
        const ratio = laneSignals.lanes.get('target').path.length / laneSignals.lanes.get('approach').path.length;
        expect(signal.distance).toBeCloseTo((control.stopS - vehicle.s * ratio) / ratio, 6);
    });

    it('does not mutate simulation time, cars, or randomness during inspection', () => {
        const network = fixture({ withExit: true, signals: [
            { id: 'read-only-signal', point: geo([80, 0]), controls: [{ laneId: 'approach', fraction: .8 }] }
        ] });
        const vehicle = car(1, 80, 'move');
        const blocker = { ...car(2, 15), laneId: 'exit' };
        const sim = simFor(network, [vehicle, blocker]);
        sim.time = timeWhen(network, 'read-only-signal', 'red');
        const control = simFor(network);
        const expectedRandom = control.random();
        const before = JSON.stringify({ time: sim.time, cars: sim.cars, crossings: sim.crossings, nextId: sim.nextId });

        sim.inspectCar(vehicle);
        sim.inspectCar(vehicle);

        expect(sim.random()).toBe(expectedRandom);
        expect(JSON.stringify({ time: sim.time, cars: sim.cars, crossings: sim.crossings, nextId: sim.nextId })).toBe(before);
    });
});
