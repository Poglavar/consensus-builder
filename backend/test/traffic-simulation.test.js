// Checks directed movements, signals, following gaps and permitted lane changes without a browser.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Traffic = require('../../frontend/traffic/simulation.js');
const Collision = require('../../frontend/traffic/collision.js');
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

function connectedNetwork({ signal = false, mapped = signal, separatedApproaches = false } = {}) {
    const inEnd = separatedApproaches ? [-15, 0] : [0, 0];
    const crossEnd = separatedApproaches ? [0, 15] : [0, 0];
    const lanes = [
        lane('in', 'west', 'junction', [-100, 0], inEnd, { sectionId: 'a-west' }),
        lane('out', 'junction', 'east', [0, 0], [100, 0], { sectionId: 'b-east' })
    ];
    if (signal) {
        lanes.push(lane('cross-in', 'north', 'junction', [0, 100], crossEnd, { sectionId: 'z-north' }));
        lanes.push(lane('cross-out', 'junction', 'south', [0, 0], [0, -100], { sectionId: 'z-south' }));
    }
    const inPath = separatedApproaches ? [inEnd, [-7.5, 0], [0, 0]] : [[0, 0], [1, 2], [0, 0]];
    const crossPath = separatedApproaches ? [crossEnd, [0, 7.5], [0, 0]] : [[0, 0], [2, 1], [0, 0]];
    const connections = [connection('move-in-out', 'in', 'out', 'junction', inPath)];
    if (signal) connections.push(connection('move-cross', 'cross-in', 'cross-out', 'junction', crossPath));
    const fixture = data(lanes, connections, { junction: signal ? 3 : 2 });
    if (mapped) fixture.signals.push({ id: 'osm-node:123', point: geo(separatedApproaches ? inEnd : [0, 0]), controls: [
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

function headForSource(network, sourceId) {
    return [...network.signals.values()].find(signal => signal.sourceIds.includes(sourceId));
}

function circulatingNetwork({ includeBypass = true } = {}) {
    const lanes = [
        lane('a', 'south-west', 'south-east', [0, 0], [100, 0], { sectionId: 'south' }),
        lane('b', 'south-east', 'north-east', [100, 0], [100, 100]),
        lane('c', 'north-east', 'north-west', [100, 100], [0, 100]),
        lane('d', 'north-west', 'south-west', [0, 100], [0, 0]),
        ...(includeBypass ? [lane('bypass', 'south-east', 'north-west', [100, 0], [0, 100])] : []),
        lane('feeder', 'west', 'south-west', [-100, 0], [0, 0]),
        lane('branch', 'south-east', 'outside', [100, 0], [200, 0]),
        lane('dead-end', 'outside', 'boundary', [200, 0], [300, 0]),
        lane('trap-a', 'outside', 'loop-tip', [200, 0], [250, 0]),
        lane('trap-b', 'loop-tip', 'outside', [250, 0], [200, 0]),
        lane('adjacent-trap', 'south-west', 'south-east', [0, -3], [100, -3], {
            sectionId: 'south', stripIndex: 1, ordinal: 1
        })
    ];
    // Model the trap SCC as a loop with two separated physical arms. A pair of
    // reverse-direction cars on one centerline would correctly block each other.
    lanes.find(item => item.id === 'trap-a').points = [geo([200, 0]), geo([220, 12]), geo([250, 0])];
    lanes.find(item => item.id === 'trap-b').points = [geo([250, 0]), geo([230, -12]), geo([200, 0])];
    const pairs = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'],
        ...(includeBypass ? [['a', 'bypass'], ['bypass', 'd']] : []), ['feeder', 'a'],
        ['a', 'branch'], ['branch', 'dead-end'], ['adjacent-trap', 'branch'],
        ['branch', 'trap-a'], ['trap-a', 'trap-b'], ['trap-b', 'trap-a']];
    const moves = pairs.map(([fromId, toId]) => {
        const from = lanes.find(item => item.id === fromId), to = lanes.find(item => item.id === toId);
        return { id: `${fromId}-${toId}`, fromLaneId: fromId, toLaneId: toId,
            nodeId: from.toNode, points: [from.points.at(-1), to.points[0]] };
    });
    return createNetwork(data(lanes, moves, { 'north-west': 3, 'south-east': 3 }));
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

    it('keeps manually placed cars circulating in each SCC without respawning or changing regions', () => {
        const network = circulatingNetwork({ includeBypass: false });
        const sim = new Simulation(network, { count: 0, seed: 7, signals: false, laneChangeRate: 0 });
        // The conflict footprint spans both trap nodes, so ordinary spawning
        // correctly excludes those lanes. Place traffic away from the endpoints
        // to exercise both existing SCCs without starting inside a collision area.
        expect(network.spawnLanes.some(item => ['trap-a', 'trap-b'].includes(item.id))).toBe(false);
        const placements = [
            ...['a', 'b', 'c', 'd'].flatMap(id => [15, 45, 75].map(s => [id, s])),
            ['a', 90], ['d', 90], ['trap-a', 20]
        ];
        for (const [index, [laneId, s]] of placements.entries()) {
            sim.cars.push(car(index + 1, laneId, s, network.lanes.get(laneId).routes[0]));
        }
        const original = sim.cars.map(vehicle => vehicle.id);
        const regions = new Map(sim.cars.map(vehicle => [vehicle.id, network.lanes.get(vehicle.laneId).region]));
        const transitions = new Map(original.map(id => [id, 0]));
        const violations = [];
        expect(original).toHaveLength(15);
        expect(sim.targetCount).toBe(0);
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

        const vehicle = car(1, 'in', approach.signals[0].stopS - .5, 'move-in-out');
        sim.cars.push(vehicle);
        sim.time = redTime - .1;
        sim.advance(.1);
        expect(vehicle.mode).toBe('lane');
        expect(vehicle.state).toBe('red');

        sim.time = greenTime - .1;
        vehicle.speed = 0;
        for (let tick = 0; tick < 100 && vehicle.mode !== 'connection'; tick++) sim.advance(.1);
        expect(vehicle.mode === 'connection' || vehicle.laneId === 'out').toBe(true);
        expect(sim.crossings + Number(vehicle.mode === 'connection')).toBeGreaterThan(0);
    });

    it('gives the oldest queued approach the crossing priority without bypassing its red signal', () => {
        const network = connectedNetwork({ signal: true, separatedApproaches: true });
        const incoming = network.lanes.get('in');
        const crossIncoming = network.lanes.get('cross-in');
        const redTime = Array.from({ length: 4800 }, (_, index) => index * .1)
            .find(time => signalState(network, incoming, time, true) === 'red'
                && signalState(network, crossIncoming, time, true) === 'green');
        expect(redTime).toBeTypeOf('number');

        const sim = new Simulation(network, { count: 0, signals: true, laneChangeRate: 0 });
        // Keep the two approaches physically separate while they queue. Starting
        // both centers at the shared junction point creates an initial OBB overlap.
        const older = car(1, 'in', incoming.signals[0].stopS - .01, 'move-in-out', 0);
        const newer = car(2, 'cross-in', crossIncoming.signals[0].stopS - .01, 'move-cross', 0);
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
        const vehicle = car(1, 'in', approach.signals[0].stopS - .03, null, 1);
        const sim = new Simulation(network, { count: 0 });
        sim.cars.push(vehicle);
        sim.time = redTime;
        sim.advance(2);
        expect(vehicle.s).toBeCloseTo(approach.signals[0].stopS, 6);
        expect(vehicle.s).toBeLessThan(approach.path.length - .004);
        expect(vehicle.state).toBe('red');
    });

    it('groups nearby mapped lights into one stop, then lets the same car continue through', () => {
        const lanes = [
            lane('in', 'west', 'junction', [-100, 0], [0, 0], { sectionId: 'approach' }),
            lane('out', 'junction', 'east', [0, 0], [100, 0]),
            lane('cross-in', 'north', 'junction', [0, 100], [0, 0]),
            lane('cross-out', 'junction', 'south', [0, 0], [0, -100])
        ];
        const fixture = data(lanes, [
            connection('move-in-out', 'in', 'out', 'junction', [[0, 0], [0, 0], [0, 0]]),
            connection('move-cross', 'cross-in', 'cross-out', 'junction', [[0, 0], [0, 0], [0, 0]])
        ], { junction: 4 });
        fixture.signals.push(
            { id: 'osm-node:signal-first', point: geo([-.5, 0]), kind: 'traffic_signals', controls: [{ laneId: 'in', fraction: .995 }] },
            { id: 'osm-node:signal-last', point: geo([0, 0]), kind: 'traffic_signals', controls: [{ laneId: 'in', fraction: 1 }] }
        );
        const network = createNetwork(fixture), approach = network.lanes.get('in');
        expect(approach.signals).toHaveLength(1);
        const [control] = approach.signals;
        const head = network.signals.get(control.signalId);
        expect(head.sourceIds).toEqual(['osm-node:signal-first', 'osm-node:signal-last']);
        const startTime = Array.from({ length: 1000 }, (_, i) => i * .1)
            .find(time => Traffic.signalAspect(head, control.phase, time) === 'green');
        expect(startTime).toBeTypeOf('number');

        const vehicle = car(1, 'in', control.stopS - .5, 'move-in-out', 4);
        const sim = new Simulation(network, { count: 0, laneChangeRate: 0 });
        sim.cars.push(vehicle);
        sim.time = startTime;
        let crossedGroupedStop = false;
        for (let tick = 0; tick < 100 && vehicle.mode !== 'connection'; tick++) {
            const previous = vehicle.s;
            sim.advance(.1);
            if (previous < control.stopS && vehicle.s >= control.stopS) {
                crossedGroupedStop = true;
                expect(Traffic.signalAspect(head, control.phase, sim.time)).toBe('green');
            }
        }
        expect(crossedGroupedStop).toBe(true);
        expect(vehicle.mode === 'connection' || vehicle.laneId === 'out').toBe(true);
        if (vehicle.mode === 'connection') expect(vehicle.connectionId).toBe('move-in-out');
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

    it('keeps an outgoing source point while placing its derived stop and head after transition trimming', () => {
        const network = transitionNetwork('split', true);
        const outgoing = network.lanes.get('out-0');
        const controlFraction = .2;
        expect(outgoing.startTrim).toBeGreaterThan(0);
        const sourceStation = outgoing.sourceStops.find(item =>
            Math.abs(item.sourceS - controlFraction * outgoing.rawPath.length) < 1e-6).station;
        expect(outgoing.signals[0].stopS).toBeCloseTo(Math.max(0, sourceStation - 2.5), 5);
        const head = headForSource(network, 'outgoing-signal');
        expect(head).toBeDefined();
        expect(head.sourcePoints).toContainEqual(geo([120, 3.5]));
        const stop = sample(outgoing.path, outgoing.signals[0].stopS);
        const headXY = network.project(head.point);
        const lateral = (headXY[0] - stop.x) * Math.sin(stop.angle)
            - (headXY[1] - stop.y) * Math.cos(stop.angle);
        expect(lateral).toBeCloseTo((outgoing.width || 3) / 2 + .8, 1);
    });

    it('requires room for the crossing reservation and following gap before entering a lane', () => {
        const network = connectedNetwork();
        const sim = new Simulation(network, { count: 0, signals: false });
        const approaching = car(1, 'in', network.lanes.get('in').path.length - 1, 'move-in-out');
        const leader = car(2, 'out', 9, null);
        const movement = network.connections.get('move-in-out');

        expect(sim.canEnter(approaching, movement, new Map([['out', [{ car: leader, s: 9 }]]]))).toBe(false);
        // The rear must clear the crossing by 3.2 m, in addition to the 7 m following gap.
        expect(sim.canEnter(approaching, movement, new Map([['out', [{ car: leader, s: 10.3 }]]]))).toBe(true);
    });

    it('checks the final exit lane before reserving a short internal connector', () => {
        const lanes = [
            lane('approach', 'west', 'junction', [-100, 0], [0, 0]),
            lane('tiny', 'junction', 'inner', [0, 0], [3, 0]),
            lane('ring', 'inner', 'junction', [3, 0], [0, 0]),
            lane('exit', 'inner', 'outside', [3, 0], [103, 0]),
            lane('return', 'outside', 'junction', [103, 0], [0, 0])
        ];
        const moves = [
            ['enter', 'approach', 'tiny', 'junction'], ['tiny-ring', 'tiny', 'ring', 'inner'],
            ['tiny-exit', 'tiny', 'exit', 'inner'], ['ring-return', 'ring', 'tiny', 'junction'],
            ['exit-return', 'exit', 'return', 'outside'], ['return-tiny', 'return', 'tiny', 'junction']
        ].map(([id, fromLaneId, toLaneId, nodeId]) => ({ id, fromLaneId, toLaneId, nodeId,
            points: [lanes.find(item => item.id === fromLaneId).points.at(-1),
                lanes.find(item => item.id === toLaneId).points[0]] }));
        const network = createNetwork(data(lanes, moves, { junction: 3, inner: 3, outside: 2 }));
        const group = 'shared-short-connector-area';
        const groups = new Map([...network.nodes.keys()].map(id => [id, id]));
        groups.set('junction', group); groups.set('inner', group);
        Traffic.refreshNetwork(network, groups);
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const approaching = car(1, 'approach', network.lanes.get('approach').path.length - 20, 'enter');
        const leader = car(2, 'exit', 9);
        sim.cars.push(approaching, leader);
        const blocked = sim.occupants();

        expect(network.lanes.get('tiny').exitRoutes).toContain('tiny-exit');
        expect(sim.receivingClear(approaching, network.connections.get('tiny-exit'), blocked)).toBe(false);
        expect(sim.canEnter(approaching, network.connections.get('enter'), blocked)).toBe(false);

        leader.s = 10.3;
        const clear = sim.occupants();
        expect(sim.receivingClear(approaching, network.connections.get('tiny-exit'), clear)).toBe(true);
        expect(sim.canEnter(approaching, network.connections.get('enter'), clear)).toBe(true);
    });

    it('uses a shared reservation rule for degree-two groups with a corner and a continuation', () => {
        const lanes = [
            lane('corner-in', 'west', 'junction', [-100, 0], [0, 0]),
            lane('corner-out', 'junction', 'east', [0, 0], [100, 0]),
            lane('through-in', 'north', 'junction', [0, 100], [0, 0]),
            lane('through-out', 'junction', 'south', [0, 0], [0, -100])
        ];
        const fixture = data(lanes, [
            { ...connection('corner', 'corner-in', 'corner-out', 'junction', [[0, 0], [2, 1], [0, 0]]), geometryKind: 'turn' },
            { ...connection('through', 'through-in', 'through-out', 'junction', [[0, 0], [0, 0], [0, 0]]), geometryKind: 'continuation' }
        ], { junction: 2 });
        const network = createNetwork(fixture);
        const group = network.junctionGroups.get('junction');
        const sim = new Simulation(network, { count: 0, signals: false });

        expect(network.junctionKeys.has(group)).toBe(true);
        expect(sim.needsReservation(network.connections.get('corner'))).toBe(true);
        expect(sim.needsReservation(network.connections.get('through'))).toBe(true);
    });

    it('chooses an exit route over an internal circulation and releases its group reservation', () => {
        const lanes = [
            lane('ring-one', 'a', 'b', [0, 0], [100, 0]),
            lane('ring-two', 'b', 'a', [100, 0], [0, 0]),
            lane('escape', 'b', 'c', [100, 0], [200, 0]),
            lane('return', 'c', 'a', [200, 0], [0, 0])
        ];
        const moves = [
            ['internal', 'ring-one', 'ring-two', 'b'], ['exit', 'ring-one', 'escape', 'b'],
            ['around', 'ring-two', 'ring-one', 'a'], ['escape-return', 'escape', 'return', 'c'],
            ['return-ring', 'return', 'ring-one', 'a']
        ].map(([id, fromLaneId, toLaneId, nodeId]) => ({ id, fromLaneId, toLaneId, nodeId,
            points: [lanes.find(item => item.id === fromLaneId).points.at(-1),
                lanes.find(item => item.id === toLaneId).points[0]] }));
        const network = createNetwork(data(lanes, moves, { a: 3, b: 3, c: 2 }));
        const group = 'shared-junction';
        const groups = new Map([...network.nodes.keys()].map(id => [id, id]));
        groups.set('a', group); groups.set('b', group);
        Traffic.refreshNetwork(network, groups);
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const source = network.lanes.get('ring-one');
        const vehicle = car(1, source.id, source.path.length - .1, 'internal');
        vehicle.traversed = [];
        sim.cars.push(vehicle);
        sim.reservations.set(group, vehicle.id);

        expect(source.routes).toContain('internal');
        expect(source.exitRoutes).toEqual(['exit']);
        expect(sim.chooseRoute(source)).toBe('exit');
        vehicle.next = sim.chooseRoute(source);
        sim.move(vehicle, .5, new Map());
        expect(vehicle.laneId).toBe('escape');
        expect(sim.reservations.get(group)).toBe(vehicle.id);
        sim.move(vehicle, 3, new Map());
        expect(vehicle.clearance).toBeNull();
        expect(sim.reservations.has(group)).toBe(false);
    });

    it('uses a longer clear exit when the preferred exit is queued, and rejects entry when both exits are queued', () => {
        function twoExitFixture({ blockLong = false } = {}) {
            const lanes = [
                lane('approach', 'west', 'a', [-100, 0], [0, 0]),
                lane('inside', 'a', 'b', [0, 0], [100, 0]),
                lane('short-exit', 'b', 'short-out', [100, 0], [100, 40]),
                lane('short-return', 'short-out', 'a', [100, 40], [0, 0]),
                lane('long-bridge', 'b', 'd', [100, 0], [200, 0]),
                lane('long-exit', 'd', 'long-out', [200, 0], [200, 60]),
                lane('long-return', 'long-out', 'a', [200, 60], [0, 0])
            ];
            const moves = [
                ['enter', 'approach', 'inside', 'a'],
                ['short-entry', 'inside', 'short-exit', 'b'],
                ['short-turn', 'short-exit', 'short-return', 'short-out'],
                ['short-close', 'short-return', 'inside', 'a'],
                ['long-entry', 'inside', 'long-bridge', 'b'],
                ['long-leave', 'long-bridge', 'long-exit', 'd'],
                ['long-turn', 'long-exit', 'long-return', 'long-out'],
                ['long-close', 'long-return', 'inside', 'a']
            ].map(([id, fromLaneId, toLaneId, nodeId]) => {
                const from = lanes.find(item => item.id === fromLaneId);
                const to = lanes.find(item => item.id === toLaneId);
                const point = from.points.at(-1);
                return { id, fromLaneId, toLaneId, nodeId, points: [point, point, to.points[0]] };
            });
            const graph = createNetwork(data(lanes, moves, { a: 3, b: 3, d: 2, 'short-out': 2, 'long-out': 2 }));
            const group = 'shared-exit-area';
            const groups = new Map([...graph.nodes.keys()].map(id => [id, id]));
            for (const id of ['a', 'b', 'd']) groups.set(id, group);
            Traffic.refreshNetwork(graph, groups);
            const sim = new Simulation(graph, { count: 0, signals: false, laneChangeRate: 0 });
            const approaching = car(1, 'approach', graph.lanes.get('approach').path.length - .1, 'enter');
            approaching.traversed = [];
            const shortQueue = car(2, 'short-exit', 9, 'short-turn');
            sim.cars.push(approaching, shortQueue);
            if (blockLong) sim.cars.push(car(3, 'long-bridge', 9, 'long-leave'));
            return { graph, sim, group, approaching, shortQueue };
        }

        const clearLong = twoExitFixture();
        const { graph, sim, group, approaching } = clearLong;
        const entry = graph.connections.get('enter');
        expect(graph.lanes.get('inside').exitRoutes).toEqual(['short-entry']);
        expect(sim.receivingClear(approaching, graph.connections.get('short-entry'), sim.occupants())).toBe(false);
        expect(sim.receivingClear(approaching, graph.connections.get('long-entry'), sim.occupants())).toBe(true);
        expect(sim.canEnter(approaching, entry, sim.occupants(), false)).toBe(true);
        expect(sim.chooseRoute(graph.lanes.get('inside'), approaching)).toBe('long-entry');

        approaching.next = 'enter';
        for (let step = 0; step < 500; step++) {
            sim.move(approaching, .5, sim.occupants());
            expect(Collision.overlaps(sim.pose(approaching), sim.pose(clearLong.shortQueue))).toBe(false);
            if (approaching.laneId === 'long-exit' && !sim.reservations.has(group)) break;
        }
        expect(approaching.traversed).toContain('long-entry');
        expect(approaching.traversed).not.toContain('short-entry');
        expect(approaching.laneId).toBe('long-exit');
        expect(approaching.s).toBeGreaterThanOrEqual(3.2);
        expect(sim.reservations.has(group)).toBe(false);

        const bothBlocked = twoExitFixture({ blockLong: true });
        expect(bothBlocked.graph.lanes.get('inside').exitRoutes).toEqual(['short-entry']);
        expect(bothBlocked.sim.receivingClear(bothBlocked.approaching, bothBlocked.graph.connections.get('long-entry'),
            bothBlocked.sim.occupants())).toBe(false);
        expect(bothBlocked.sim.canEnter(bothBlocked.approaching, bothBlocked.graph.connections.get('enter'),
            bothBlocked.sim.occupants(), false)).toBe(false);
    });

    it('takes another explicit clear exit in the same circulation region when queued', () => {
        const network = circulatingNetwork();
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const source = network.lanes.get('a');
        const queued = car(1, 'a', source.path.length - .01, 'a-b', 0);
        const leader = car(2, 'b', 9, 'b-c', 0);
        sim.cars.push(queued, leader);

        expect(source.routes).toContain('a-bypass');
        expect(network.lanes.get('bypass').region).toBe(source.region);
        sim.advance(.1);

        // The bypass connector is zero-length in this fixture, so the same tick
        // carries the car directly onto its receiving lane.
        expect(queued.mode).toBe('lane');
        expect(queued.laneId).toBe('bypass');
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

    it('freezes lane-change pose and heading when a moving car stops', () => {
        const source = lane('source', 'west', 'east', [0, 0], [100, 0], {
            sectionId: 'parallel', ordinal: 0, stripIndex: 0, maxSpeed: 60
        });
        const target = lane('target', 'west', 'east', [0, 3.5], [100, 3.5], {
            sectionId: 'parallel', ordinal: 1, stripIndex: 1, maxSpeed: 60
        });
        const sourceReturn = lane('source-return', 'east', 'west', [100, 0], [0, 0], { sectionId: 'source-return' });
        const targetReturn = lane('target-return', 'east', 'west', [100, 3.5], [0, 3.5], { sectionId: 'target-return' });
        const lanes = [source, target, sourceReturn, targetReturn];
        const connections = [
            ['source', 'source-return', 'east'], ['source-return', 'source', 'west'],
            ['target', 'target-return', 'east'], ['target-return', 'target', 'west']
        ].map(([fromLaneId, toLaneId, nodeId]) => ({ id: `${fromLaneId}-${toLaneId}`, fromLaneId, toLaneId,
            nodeId, points: [lanes.find(item => item.id === fromLaneId).points.at(-1),
                lanes.find(item => item.id === toLaneId).points[0]] }));
        const network = createNetwork(data(lanes, connections));
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(1, 'source', 40, 'source-source-return', 0);
        vehicle.change = { to: 'target', progress: .5, duration: 3.2, angle: .25 };
        sim.cars.push(vehicle);
        sim.gates.push({ distance: () => 0 });
        const before = sim.pose(vehicle);

        sim.advance(.1);

        const after = sim.pose(vehicle);
        expect(vehicle.speed).toBe(0);
        expect(vehicle.change.progress).toBe(.5);
        expect(vehicle.change.angle).toBe(.25);
        expect(after.x).toBeCloseTo(before.x, 8);
        expect(after.y).toBeCloseTo(before.y, 8);
        expect(after.angle).toBeCloseTo(before.angle, 8);
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

    it('completes a permitted lane change without replacing the vehicle', () => {
        const lanes = [
            lane('source', 'a', 'b', [0, 0], [100, 0], {
                sectionId: 'two-lane-road', ordinal: 0, stripIndex: 0, change: 'yes'
            }),
            lane('target', 'a', 'b', [0, 3.5], [100, 3.5], {
                sectionId: 'two-lane-road', ordinal: 1, stripIndex: 1, change: 'yes'
            }),
            lane('return', 'b', 'a', [100, 1.75], [0, 1.75], { sectionId: 'return-road' })
        ];
        const moves = [
            ['source-return', 'source', 'return', 'b'], ['target-return', 'target', 'return', 'b'],
            ['return-source', 'return', 'source', 'a'], ['return-target', 'return', 'target', 'a']
        ].map(([id, fromLaneId, toLaneId, nodeId]) => ({ id, fromLaneId, toLaneId, nodeId,
            points: [lanes.find(item => item.id === fromLaneId).points.at(-1),
                lanes.find(item => item.id === toLaneId).points[0]] }));
        const network = createNetwork(data(lanes, moves, { a: 3, b: 3 }));
        const sim = new Simulation(network, { count: 0, seed: 97, signals: false, laneChangeRate: 100 });
        const vehicle = car(97, 'source', 40, 'source-return', 8);
        vehicle.cooldown = 0;
        sim.cars.push(vehicle);

        expect(network.lanes.get('source').adjacent).toContain('target');
        expect(network.lanes.get('target').region).toBe(network.lanes.get('source').region);
        for (let tick = 0; tick < 50; tick++) sim.advance(.1);

        const target = network.lanes.get('target');
        const pose = sim.pose(vehicle), center = sample(target.path, vehicle.s);
        expect(sim.cars[0]).toBe(vehicle);
        expect(vehicle.id).toBe(97);
        expect(vehicle.laneId).toBe('target');
        expect(vehicle.change).toBeNull();
        expect(sim.laneChanges).toBe(1);
        expect([pose.x, pose.y, pose.angle].every(Number.isFinite)).toBe(true);
        expect(Math.hypot(pose.x - center.x, pose.y - center.y)).toBeLessThan(.01);
    });

    it('reserves a narrow bent two-way section but leaves a passable straight section separate', () => {
        const forward = lane('bent-forward', 'a', 'b', [0, 0], [30, 8.5], {
            sectionId: 'narrow-bent-section', direction: 'forward'
        });
        forward.points = [geo([0, 0]), geo([10, 0]), geo([30, 8.5])];
        forward.width = 2.75;
        const backward = lane('bent-backward', 'b', 'a', [28.924, 11.031], [0, 2.75], {
            sectionId: 'narrow-bent-section', direction: 'backward'
        });
        backward.points = [geo([28.924, 11.031]), geo([10, 2.75]), geo([0, 2.75])];
        backward.width = 2.75;
        const entryForwardLane = lane('entry-forward-lane', 'west', 'a', [-30, 0], [0, 0], { sectionId: 'entry-forward' });
        entryForwardLane.width = 3.5;
        const entryBackwardLane = lane('entry-backward-lane', 'east', 'b', [58.924, 11.031], [28.924, 11.031], { sectionId: 'entry-backward' });
        entryBackwardLane.width = 3.5;
        const entryForward = { ...connection('entry-forward', 'entry-forward-lane', 'bent-forward', 'a', [[0, 0], [0, 0], [0, 0]]), geometryKind: 'continuation' };
        const entryBackward = { ...connection('entry-backward', 'entry-backward-lane', 'bent-backward', 'b', [[28.924, 11.031], [28.924, 11.031], [28.924, 11.031]]), geometryKind: 'continuation' };
        const bent = createNetwork(data([forward, backward, entryForwardLane, entryBackwardLane],
            [entryForward, entryBackward], { a: 2, b: 2 }));
        const bentGroup = bent.junctionGroups.get('a');
        const sim = new Simulation(bent, { count: 0, signals: false });
        const frontCar = car(1, 'entry-forward-lane', 0, 'entry-forward');
        const backCar = car(2, 'entry-backward-lane', 0, 'entry-backward');
        sim.cars.push(frontCar, backCar);
        sim.reservations.set(bentGroup, frontCar.id);
        let bentBodiesOverlap = false;
        for (let a = 0; a <= bent.lanes.get('bent-forward').path.length && !bentBodiesOverlap; a += .25) {
            for (let b = 0; b <= bent.lanes.get('bent-backward').path.length; b += .25) {
                if (Collision.overlaps(sample(bent.lanes.get('bent-forward').path, a),
                    sample(bent.lanes.get('bent-backward').path, b))) {
                    bentBodiesOverlap = true;
                    break;
                }
            }
        }

        expect(bentBodiesOverlap).toBe(true);
        expect(bent.junctionGroups.get('a')).toBe(bent.junctionGroups.get('b'));
        expect(bent.lanes.get('bent-forward').conflictInterior).toBe(true);
        expect(bent.lanes.get('bent-backward').conflictInterior).toBe(true);
        expect(sim.needsReservation(bent.connections.get('entry-forward'))).toBe(true);
        expect(sim.needsReservation(bent.connections.get('entry-backward'))).toBe(true);
        expect(sim.canEnter(frontCar, bent.connections.get('entry-forward'), new Map())).toBe(true);
        expect(sim.canEnter(backCar, bent.connections.get('entry-backward'), new Map())).toBe(false);
        for (let tick = 0; tick < 100; tick++) {
            sim.advance(.1);
            expect(sim.cars.map(item => item.id)).toEqual([frontCar.id, backCar.id]);
            expect([sim.pose(frontCar), sim.pose(backCar)].every(pose =>
                [pose.x, pose.y, pose.angle].every(Number.isFinite))).toBe(true);
            expect(Collision.overlaps(sim.pose(frontCar), sim.pose(backCar))).toBe(false);
        }

        const straightForward = lane('straight-forward', 'left', 'right', [0, 30], [30, 30], {
            sectionId: 'wide-straight-section', direction: 'forward'
        });
        const straightBackward = lane('straight-backward', 'right', 'left', [30, 33], [0, 33], {
            sectionId: 'wide-straight-section', direction: 'backward'
        });
        straightForward.width = straightBackward.width = 2.75;
        const straight = createNetwork(data([straightForward, straightBackward], [], { left: 2, right: 2 }));
        expect(straight.junctionGroups.get('left')).not.toBe(straight.junctionGroups.get('right'));
        expect(straight.lanes.get('straight-forward').conflictInterior).toBe(false);
        expect(straight.lanes.get('straight-backward').conflictInterior).toBe(false);
    });
});
