// Checks directed movements, signals, following gaps and permitted lane changes without a browser.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Traffic = require('../../frontend/traffic/simulation.js');
const { Simulation, createNetwork, laneChangeAllowed, signalState, sample, GAP } = Traffic;

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
        change: options.change || 'yes', maxSpeed: options.maxSpeed ?? 30,
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

function transitionNetwork(kind = 'split', signal = false) {
    const lanes = [];
    const connections = [];
    const addLane = (id, from, to, y, sectionId) => lanes.push(lane(id, from, to,
        [from === 'junction' ? 100 : 0, y], [to === 'junction' ? 100 : 200, y],
        { sectionId, maxSpeed: 60 }));
    const addMove = (id, fromLaneId, toLaneId, type) => {
        const from = lanes.find(item => item.id === fromLaneId);
        const to = lanes.find(item => item.id === toLaneId);
        connections.push({ id, fromLaneId, toLaneId, nodeId: 'junction', type,
            points: [from.points.at(-1), to.points[0]] });
    };

    if (kind === 'split') {
        addLane('in-0', 'west', 'junction', 1.75, 'incoming');
        addLane('in-1', 'west', 'junction', -1.75, 'incoming');
        addLane('out-0', 'junction', 'east', 3.5, 'outgoing');
        addLane('out-1', 'junction', 'east', 0, 'outgoing');
        addLane('out-2', 'junction', 'east', -3.5, 'outgoing');
        addMove('continue', 'in-0', 'out-0', 'continue');
        addMove('split-a', 'in-1', 'out-1', 'split');
        addMove('split-b', 'in-1', 'out-2', 'split');
    } else {
        addLane('in-0', 'west', 'junction', 3.5, 'incoming');
        addLane('in-1', 'west', 'junction', 0, 'incoming');
        addLane('in-2', 'west', 'junction', -3.5, 'incoming');
        addLane('out-0', 'junction', 'east', 1.75, 'outgoing');
        addLane('out-1', 'junction', 'east', -1.75, 'outgoing');
        addMove('merge-a', 'in-0', 'out-0', 'merge');
        addMove('merge-b', 'in-1', 'out-0', 'merge');
        addMove('continue', 'in-2', 'out-1', 'continue');
    }

    const fixture = data(lanes, connections, { junction: 2 });
    if (signal) fixture.signals.push({ id: 'outgoing-signal', point: geo([120, kind === 'split' ? 3.5 : 1.75]),
        controls: [{ laneId: 'out-0', fraction: .2 }] });
    return createNetwork(fixture);
}

function poseDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function circulatingNetwork() {
    const lanes = [
        lane('a', 'south-west', 'south-east', [0, 0], [100, 0], { sectionId: 'south' }),
        lane('b', 'south-east', 'north-east', [100, 0], [100, 100]),
        lane('c', 'north-east', 'north-west', [100, 100], [0, 100]),
        lane('d', 'north-west', 'south-west', [0, 100], [0, 0]),
        lane('bypass', 'south-east', 'north-west', [100, 0], [0, 100]),
        lane('feeder', 'west', 'south-west', [-100, 0], [0, 0]),
        lane('branch', 'south-east', 'outside', [100, 0], [200, 0]),
        lane('dead-end', 'outside', 'boundary', [200, 0], [300, 0]),
        lane('trap-a', 'outside', 'loop-tip', [200, 0], [250, 0]),
        lane('trap-b', 'loop-tip', 'outside', [250, 0], [200, 0]),
        lane('adjacent-trap', 'south-west', 'south-east', [0, -3], [100, -3], {
            sectionId: 'south', stripIndex: 1, ordinal: 1
        })
    ];
    const pairs = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['a', 'bypass'],
        ['bypass', 'd'], ['feeder', 'a'],
        ['a', 'branch'], ['branch', 'dead-end'], ['adjacent-trap', 'branch'],
        ['branch', 'trap-a'], ['trap-a', 'trap-b'], ['trap-b', 'trap-a']];
    const moves = pairs.map(([fromId, toId]) => {
        const from = lanes.find(item => item.id === fromId), to = lanes.find(item => item.id === toId);
        return { id: `${fromId}-${toId}`, fromLaneId: fromId, toLaneId: toId,
            nodeId: from.toNode, points: [from.points.at(-1), to.points[0]] };
    });
    return createNetwork(data(lanes, moves));
}

describe('traffic simulation', () => {
    it('keeps permitted turns but excludes dead ends and one-way feeders from circulating routes', () => {
        const network = circulatingNetwork();
        expect(network.lanes.get('a').outgoing).toEqual(['a-b', 'a-bypass', 'a-branch']);
        expect(network.lanes.get('a').routes).toEqual(['a-b', 'a-bypass']);
        expect(network.lanes.get('feeder').outgoing).toEqual(['feeder-a']);
        for (const id of ['feeder', 'branch', 'dead-end', 'adjacent-trap']) {
            expect(network.lanes.get(id).routes).toEqual([]);
            expect(network.spawnLanes.some(item => item.id === id)).toBe(false);
        }
        expect(network.lanes.get('trap-a').routes).toEqual(['trap-a-trap-b']);
        expect(network.lanes.get('trap-b').routes).toEqual(['trap-b-trap-a']);
        expect(network.lanes.get('trap-a').region).not.toBe(network.lanes.get('a').region);
        expect(network.lanes.get('a').adjacent).toEqual([]);
        expect(new Simulation(connectedNetwork(), { count: 5 }).cars).toEqual([]);
    });

    it('keeps the same cars circulating without missing exits or accumulating in another region', () => {
        const network = circulatingNetwork();
        const sim = new Simulation(network, { count: 20, seed: 7, signals: false, laneChangeRate: 0 });
        const original = sim.cars.map(vehicle => vehicle.id);
        const regions = new Map(sim.cars.map(vehicle => [vehicle.id, network.lanes.get(vehicle.laneId).region]));
        const transitions = new Map(original.map(id => [id, 0]));
        const violations = [];
        expect(original).toHaveLength(20);
        expect(new Set(regions.values()).size).toBe(2);
        for (let tick = 0; tick < 1500; tick++) {
            const before = new Map(sim.cars.map(vehicle => [vehicle.id, vehicle.laneId]));
            sim.advance(.1);
            for (const vehicle of sim.cars) {
                const current = network.lanes.get(vehicle.laneId);
                if (!current.routes.length) violations.push({ tick, id: vehicle.id, reason: 'no route' });
                if (current.region !== regions.get(vehicle.id)) violations.push({ tick, id: vehicle.id, reason: 'region changed' });
                if (vehicle.state === 'blocked') violations.push({ tick, id: vehicle.id, reason: 'blocked' });
                if (before.get(vehicle.id) !== vehicle.laneId) transitions.set(vehicle.id, transitions.get(vehicle.id) + 1);
            }
        }
        expect(violations).toEqual([]);
        expect(sim.cars.map(vehicle => vehicle.id)).toEqual(original);
        expect(Math.min(...transitions.values())).toBeGreaterThan(5);
    });

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

    it('gives the oldest queued approach the crossing priority without bypassing its red signal', () => {
        const network = connectedNetwork({ signal: true });
        const incoming = network.lanes.get('in');
        const crossIncoming = network.lanes.get('cross-in');
        const redTime = Array.from({ length: 4800 }, (_, index) => index * .1)
            .find(time => signalState(network, incoming, time, true) === 'red'
                && signalState(network, crossIncoming, time, true) === 'green');
        expect(redTime).toBeTypeOf('number');

        const sim = new Simulation(network, { count: 0, signals: true, laneChangeRate: 0 });
        const older = car(1, 'in', incoming.path.length - .01, 'move-in-out', 0);
        const newer = car(2, 'cross-in', crossIncoming.path.length - .01, 'move-cross', 0);
        older.queuedAt = redTime - 30;
        newer.queuedAt = redTime - 1;
        // Process the competing green approach first to make priority independent of array order.
        sim.cars.push(newer, older);
        sim.time = redTime;

        sim.advance(.1);

        expect(signalState(network, incoming, sim.time, true)).toBe('red');
        expect(older.mode).toBe('lane');
        expect(newer.mode).toBe('lane');

        for (let tick = 0; tick < 1200 && older.mode !== 'connection'; tick++) sim.advance(.1);

        expect(signalState(network, incoming, sim.time, true)).toBe('green');
        expect(older.mode).toBe('connection');
        expect(older.connectionId).toBe('move-in-out');
        expect(newer.mode).toBe('lane');
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

    it('uses long aligned 2-to-3 and 3-to-2 tapers and keeps straight taper speed uncapped', () => {
        const split = transitionNetwork('split');
        const merge = transitionNetwork('merge');
        for (const network of [split, merge]) {
            for (const movement of network.connections.values()) {
                expect(movement.geometryKind).toBe('taper');
                expect(movement.path.length).toBeGreaterThanOrEqual(28);
            }
        }
        expect(split.connections.get('continue').geometryKind).toBe('taper');
        expect(split.connections.get('split-a').geometryKind).toBe('taper');
        expect(merge.connections.get('merge-a').geometryKind).toBe('taper');

        const approach = split.lanes.get('in-0');
        expect(approach.endTrim + split.lanes.get('out-0').startTrim).toBeCloseTo(28, 1);
        const sim = new Simulation(split, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(1, 'in-0', approach.path.length - .2, 'continue', 10);
        vehicle.cruise = 10;
        sim.cars.push(vehicle);
        const modes = new Set();
        let taperSpeed = 0;
        for (let tick = 0; tick < 52; tick++) {
            const before = sim.pose(vehicle);
            sim.advance(.1);
            const after = sim.pose(vehicle);
            expect(poseDistance(before, after)).toBeLessThanOrEqual(1.1);
            modes.add(vehicle.mode === 'lane' ? vehicle.laneId : 'connection');
            if (vehicle.mode === 'connection') taperSpeed = Math.max(taperSpeed, vehicle.speed);
        }
        expect(modes).toContain('connection');
        expect(modes).toContain('out-0');
        expect(taperSpeed).toBeGreaterThan(6);
    });

    it('lets a follower enter the same long taper before its leader clears it, preserving GAP', () => {
        const network = transitionNetwork('split');
        const source = network.lanes.get('in-1');
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const leader = car(1, 'in-1', source.path.length - 15, 'split-a', 10);
        const follower = car(2, 'in-1', source.path.length - 27, 'split-a', 10);
        leader.cruise = follower.cruise = 10;
        sim.cars.push(leader, follower);
        let followedOnTaper = false;
        for (let tick = 0; tick < 55; tick++) {
            const before = new Map(sim.cars.map(vehicle => [vehicle.id, sim.pose(vehicle)]));
            sim.advance(.1);
            for (const vehicle of sim.cars) expect(poseDistance(before.get(vehicle.id), sim.pose(vehicle))).toBeLessThanOrEqual(1.1);
            const onTaper = sim.cars.filter(vehicle => vehicle.mode === 'connection' && vehicle.connectionId === 'split-a');
            if (onTaper.length === 2) {
                followedOnTaper = true;
                expect(Math.abs(onTaper[0].s - onTaper[1].s)).toBeGreaterThanOrEqual(GAP - .001);
            }
            const sourceOccupants = sim.occupants().get('in-1') || [];
            const positions = sourceOccupants.map(entry => entry.s).sort((a, b) => a - b);
            if (positions.length === 2) expect(positions[1] - positions[0]).toBeGreaterThanOrEqual(GAP - .001);
        }
        expect(followedOnTaper).toBe(true);
    });

    it('keeps source spacing when followers take separate outgoing branches', () => {
        const network = transitionNetwork('split');
        const source = network.lanes.get('in-1');
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const leader = car(1, 'in-1', source.path.length - 15, 'split-a', 10);
        const follower = car(2, 'in-1', source.path.length - 27, 'split-b', 10);
        leader.cruise = follower.cruise = 10;
        sim.cars.push(leader, follower);
        let bothBranchesOccupied = false;
        let followerRemainsClearAfterLeaderExits = false;
        for (let tick = 0; tick < 80; tick++) {
            const before = new Map(sim.cars.map(vehicle => [vehicle.id, sim.pose(vehicle)]));
            sim.advance(.1);
            for (const vehicle of sim.cars) expect(poseDistance(before.get(vehicle.id), sim.pose(vehicle))).toBeLessThanOrEqual(1.1);
            const sourceOccupants = sim.occupants().get('in-1') || [];
            const positions = sourceOccupants.map(entry => entry.s).sort((a, b) => a - b);
            if (positions.length === 2) expect(positions[1] - positions[0]).toBeGreaterThanOrEqual(GAP - .001);
            if (leader.mode === 'connection' && follower.mode === 'connection'
                && leader.connectionId !== follower.connectionId) bothBranchesOccupied = true;
            if (leader.mode === 'lane' && leader.laneId === 'out-1'
                && follower.mode === 'connection' && follower.connectionId === 'split-b') {
                followerRemainsClearAfterLeaderExits = true;
                expect(poseDistance(sim.pose(leader), sim.pose(follower))).toBeGreaterThanOrEqual(GAP - .001);
            }
        }
        expect(bothBranchesOccupied).toBe(true);
        expect(followerRemainsClearAfterLeaderExits).toBe(true);
    });

    it('maps an outgoing signal to the same world position after transition trimming', () => {
        const network = transitionNetwork('split', true);
        const outgoing = network.lanes.get('out-0');
        const controlFraction = .2;
        expect(outgoing.startTrim).toBeGreaterThan(0);
        expect(outgoing.signals[0].stopS).toBeCloseTo(controlFraction * outgoing.rawPath.length - outgoing.startTrim, 5);
        const stop = sample(outgoing.path, outgoing.signals[0].stopS);
        const world = network.unproject([stop.x, stop.y]);
        expect(world[0]).toBeCloseTo(network.signals.get('outgoing-signal').point[0], 8);
        expect(world[1]).toBeCloseTo(network.signals.get('outgoing-signal').point[1], 8);
    });

    it('requires room for the crossing reservation and following gap before entering a lane', () => {
        const network = connectedNetwork();
        const sim = new Simulation(network, { count: 0, signals: false });
        const approaching = car(1, 'in', network.lanes.get('in').path.length - 1, 'move-in-out');
        const leader = car(2, 'out', 12, null);
        const movement = network.connections.get('move-in-out');

        expect(sim.canEnter(approaching, movement, new Map([['out', [{ car: leader, s: 12 }]]]))).toBe(false);
        expect(sim.canEnter(approaching, movement, new Map([['out', [{ car: leader, s: GAP * 2 + .001 }]]]))).toBe(true);
    });

    it('takes another explicit clear exit in the same circulation region when queued', () => {
        const network = circulatingNetwork();
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const source = network.lanes.get('a');
        const queued = car(1, 'a', source.path.length - .01, 'a-b', 0);
        const leader = car(2, 'b', 12, 'b-c', 0);
        sim.cars.push(queued, leader);

        expect(source.routes).toContain('a-bypass');
        expect(network.lanes.get('bypass').region).toBe(source.region);
        sim.advance(.1);

        expect(queued.mode).toBe('connection');
        expect(queued.connectionId).toBe('a-bypass');
        expect(network.lanes.get('bypass').region).toBe(source.region);
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
        const network = circulatingNetwork();
        const first = new Simulation(network, { count: 3, seed: 37, signals: false });
        const second = new Simulation(network, { count: 3, seed: 37, signals: false });
        const shape = sim => sim.cars.map(({ id, laneId, s, cruise, color, next }) =>
            ({ id, laneId, s, cruise, color, next }));
        expect(first.cars).toHaveLength(3);
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
