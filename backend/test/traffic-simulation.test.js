// Checks directed movements, signals, following gaps and permitted lane changes without a browser.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Traffic = require('../../frontend/traffic/simulation.js');
const { Simulation, createNetwork, laneChangeAllowed, signalState, GAP } = Traffic;

const ORIGIN = [15.98, 45.81];
const METRES_PER_DEGREE = 111320;
const xScale = METRES_PER_DEGREE * Math.cos(ORIGIN[1] * Math.PI / 180);
const geo = ([x, y]) => [ORIGIN[0] + x / xScale, ORIGIN[1] + y / METRES_PER_DEGREE];

function lane(id, fromNode, toNode, start, end, options = {}) {
    return {
        id, sectionId: options.sectionId || `section-${id}`, sourceWayId: `way-${id}`,
        fromNode, toNode, direction: options.direction || 'forward',
        type: 'driving', access: 'yes', highway: 'residential',
        stripIndex: options.stripIndex ?? 0, ordinal: options.ordinal ?? 0,
        change: options.change || 'yes', maxSpeed: 30,
        points: [geo(start), geo(end)]
    };
}

function connection(id, fromLaneId, toLaneId, nodeId, bend) {
    return { id, fromLaneId, toLaneId, nodeId, points: [geo(bend[0]), geo(bend[1]), geo(bend[2])] };
}

function data(lanes, connections, degrees = {}) {
    const nodeIds = new Set(lanes.flatMap(item => [item.fromNode, item.toNode]));
    return {
        bbox: [ORIGIN[0] - .01, ORIGIN[1] - .01, ORIGIN[0] + .01, ORIGIN[1] + .01],
        nodes: [...nodeIds].map(id => ({ id, degree: degrees[id] ?? 2 })),
        lanes, connections, signals: []
    };
}

function car(id, laneId, s, next = null, speed = 0) {
    return { id, laneId, mode: 'lane', s, speed, cruise: 8, color: 0,
        next, state: 'driving', change: null, stoppedFor: 0, cooldown: Infinity, clearance: null };
}

function connectedNetwork({ signal = false, mapped = signal } = {}) {
    const lanes = [
        lane('in', 'west', 'junction', [-100, 0], [0, 0], { sectionId: 'a-west' }),
        lane('out', 'junction', 'east', [0, 0], [100, 0], { sectionId: 'b-east' })
    ];
    if (signal) {
        lanes.push(lane('cross-in', 'north', 'junction', [0, 100], [0, 0], { sectionId: 'z-north' }));
        lanes.push(lane('cross-out', 'junction', 'south', [0, 0], [0, -100], { sectionId: 'z-south' }));
    }
    const connections = [connection('move-in-out', 'in', 'out', 'junction', [[0, 0], [1, 2], [0, 0]])];
    if (signal) connections.push(connection('move-cross', 'cross-in', 'cross-out', 'junction', [[0, 0], [2, 1], [0, 0]]));
    const fixture = data(lanes, connections, { junction: signal ? 3 : 2 });
    if (mapped) fixture.signals.push({ id: 'osm-node:123', point: geo([0, 0]), controls: [
        { laneId: 'in', fraction: 1 }, { laneId: 'cross-in', fraction: 1 }
    ] });
    return createNetwork(fixture);
}

describe('traffic simulation', () => {
    it('moves a car only over an explicit lane connection', () => {
        const network = connectedNetwork();
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const sourceLength = network.lanes.get('in').path.length;
        const vehicle = car(1, 'in', sourceLength - 1, 'move-in-out');
        sim.cars.push(vehicle);

        sim.advance(2);

        expect(['connection', 'out']).toContain(vehicle.mode === 'connection' ? vehicle.mode : vehicle.laneId);
        expect(vehicle.laneId).not.toBe('cross-in');
    });

    it('holds at a red signal and proceeds when its approach turns green', () => {
        const network = connectedNetwork({ signal: true });
        const approach = network.lanes.get('in');
        const sim = new Simulation(network, { count: 0, signals: true, laneChangeRate: 0 });
        const redTime = Array.from({ length: 480 }, (_, index) => index * .1)
            .find(time => signalState(network, approach, time, true) === 'red');
        const greenTime = Array.from({ length: 480 }, (_, index) => index * .1)
            .find(time => signalState(network, approach, time, true) === 'green');
        expect(redTime).toBeTypeOf('number');
        expect(greenTime).toBeTypeOf('number');

        const vehicle = car(1, 'in', approach.path.length - 1, 'move-in-out');
        sim.cars.push(vehicle);
        sim.time = redTime - .1;
        sim.advance(.1);
        expect(vehicle.mode).toBe('lane');
        expect(vehicle.state).toBe('red');

        sim.time = greenTime - .1;
        vehicle.speed = 0;
        sim.advance(1.5);
        expect(vehicle.mode === 'connection' || vehicle.laneId === 'out').toBe(true);
        expect(sim.crossings + Number(vehicle.mode === 'connection')).toBeGreaterThan(0);
    });

    it('does not invent signals at an untagged crossroads', () => {
        const network = connectedNetwork({ signal: true, mapped: false });
        const lane = network.lanes.get('in');
        expect(network.signals.size).toBe(0);
        for (let time = 0; time < 50; time++) expect(signalState(network, lane, time)).toBe('green');
        const sim = new Simulation(network, { count: 0, laneChangeRate: 0 });
        const vehicle = car(1, 'in', lane.path.length - 1, 'move-in-out');
        sim.cars.push(vehicle);
        sim.advance(2);
        expect(vehicle.mode === 'connection' || vehicle.laneId === 'out').toBe(true);
    });

    it('stops at a mapped signal inside a lane and does not stop there again after passing it', () => {
        const fixture = data([
            lane('in', 'west', 'junction', [-100, 0], [0, 0]),
            lane('out', 'junction', 'east', [0, 0], [100, 0])
        ], [connection('move-in-out', 'in', 'out', 'junction', [[0, 0], [1, 1], [0, 0]])]);
        fixture.signals.push({ id: 'osm-node:456', point: geo([-65, 0]), controls: [{ laneId: 'in', fraction: .35 }] });
        const network = createNetwork(fixture), approach = network.lanes.get('in');
        const at = (time, position = 0) => signalState(network, approach, time, true, position);
        const redTime = Array.from({ length: 480 }, (_, i) => i * .1).find(time => at(time) === 'red' && at(time + 2) === 'red');
        const greenTime = Array.from({ length: 480 }, (_, i) => i * .1).find(time => at(time) === 'green' && at(time + 2) === 'green');
        const stop = approach.signals[0].stopS;
        const vehicle = car(1, 'in', stop - .5, 'move-in-out', 4);
        const sim = new Simulation(network, { count: 0, laneChangeRate: 0 });
        sim.cars.push(vehicle);
        sim.time = redTime;
        sim.advance(2);
        expect(vehicle.s).toBeCloseTo(stop, 5);
        expect(vehicle.speed).toBe(0);
        expect(vehicle.state).toBe('red');
        sim.time = greenTime;
        sim.advance(2);
        expect(vehicle.s).toBeGreaterThan(stop + 1);
        const passed = vehicle.s;
        sim.time = redTime;
        sim.advance(1);
        expect(vehicle.s).toBeGreaterThan(passed);
        expect(vehicle.state).toBe('driving');
    });

    it('does not snap across a red stop position just before a lane endpoint', () => {
        const fixture = data([lane('in', 'a', 'b', [0, 0], [100, 0])], []);
        fixture.signals.push({ id: 'osm-node:789', point: geo([99.995, 0]), controls: [{ laneId: 'in', fraction: .99995 }] });
        const network = createNetwork(fixture), approach = network.lanes.get('in');
        const redTime = Array.from({ length: 480 }, (_, i) => i * .1).find(time =>
            signalState(network, approach, time, true, 0) === 'red'
            && signalState(network, approach, time + 2, true, 0) === 'red');
        const vehicle = car(1, 'in', approach.path.length - .03, null, 1);
        const sim = new Simulation(network, { count: 0 });
        sim.cars.push(vehicle);
        sim.time = redTime;
        sim.advance(2);
        expect(vehicle.s).toBeCloseTo(approach.signals[0].stopS, 6);
        expect(vehicle.s).toBeLessThan(approach.path.length - .004);
        expect(vehicle.state).toBe('red');
    });

    it('keeps a following car at least one safety gap behind a queue', () => {
        const network = connectedNetwork();
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const leading = car(1, 'in', 60, null, 5);
        const trailing = car(2, 'in', 48, null, 5);
        sim.cars.push(leading, trailing);

        sim.advance(1);

        expect(leading.s - trailing.s).toBeGreaterThanOrEqual(GAP - .001);
    });

    it('keeps the same car stopped at a missing exit instead of deleting or respawning it', () => {
        const terminal = createNetwork(data([
            lane('terminal', 'west', 'junction', [-100, 0], [0, 0])
        ], [], { junction: 3 }));
        const sim = new Simulation(terminal, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(1, 'terminal', terminal.lanes.get('terminal').path.length - 1);
        sim.cars.push(vehicle);

        const nextId = sim.nextId;
        for (let tick = 0; tick < 300; tick++) sim.advance(.1);

        expect(sim.cars).toEqual([vehicle]);
        expect(sim.cars[0]).toBe(vehicle);
        expect(sim.nextId).toBe(nextId);
        expect(sim.crossings).toBe(0);
        expect(vehicle.mode).toBe('lane');
        expect(vehicle.laneId).toBe('terminal');
        expect(vehicle.state).toBe('blocked');
        expect(vehicle.speed).toBe(0);
        expect(vehicle.s).toBeCloseTo(terminal.lanes.get('terminal').path.length, 5);
    });

    it('produces repeatable seeded traffic', () => {
        const network = connectedNetwork();
        const first = new Simulation(network, { count: 3, seed: 37, signals: false });
        const second = new Simulation(network, { count: 3, seed: 37, signals: false });
        const shape = sim => sim.cars.map(({ id, laneId, s, cruise, color, next }) =>
            ({ id, laneId, s, cruise, color, next }));
        expect(shape(first)).toEqual(shape(second));

        first.advance(1.2);
        second.advance(1.2);
        expect(shape(first)).toEqual(shape(second));
    });

    it('allows lane changes only to adjacent lanes going the same way under mapped rules', () => {
        const source = lane('source', 'a', 'b', [0, 0], [100, 0], {
            sectionId: 'oneway', ordinal: 1, stripIndex: 1, change: 'yes'
        });
        const makeTarget = (id, overrides = {}) => ({
            ...source, id, ordinal: 0, stripIndex: 0, ...overrides
        });

        expect(laneChangeAllowed(source, makeTarget('left'))).toBe(true);
        expect(laneChangeAllowed({ ...source, change: 'no' }, makeTarget('left'))).toBe(false);
        expect(laneChangeAllowed({ ...source, change: 'not_left' }, makeTarget('left'))).toBe(false);
        expect(laneChangeAllowed({ ...source, change: 'not_right' }, makeTarget('left'))).toBe(true);
        expect(laneChangeAllowed({ ...source, change: 'only_left' }, makeTarget('left'))).toBe(true);
        expect(laneChangeAllowed({ ...source, change: 'only_right' }, makeTarget('left'))).toBe(false);
        expect(laneChangeAllowed(source, makeTarget('far', { ordinal: -1, stripIndex: -1 }))).toBe(false);
        expect(laneChangeAllowed(source, makeTarget('other-section', { sectionId: 'another' }))).toBe(false);
        expect(laneChangeAllowed(source, makeTarget('opposite', { direction: 'backward' }))).toBe(false);
    });
});
