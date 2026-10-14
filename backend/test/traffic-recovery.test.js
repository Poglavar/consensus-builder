// Stuck-vehicle recovery stays in the same flow, respects physical constraints, and preserves identity.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Traffic = require('../../frontend/traffic/simulation.js');
const Geometry = require('../../frontend/traffic/geometry.js');
const Collision = require('../../frontend/traffic/collision.js');
const Scenario = require('../../frontend/traffic/scenario.js');
const { Simulation, createNetwork, laneChangeAllowed, sample } = Traffic;
const { Editor, chunk } = Scenario;

const ORIGIN = [15.98, 45.81];
const METRES_PER_DEGREE = 111320;
const xScale = METRES_PER_DEGREE * Math.cos(ORIGIN[1] * Math.PI / 180);
const geo = ([x, y]) => [ORIGIN[0] + x / xScale, ORIGIN[1] + y / METRES_PER_DEGREE];

function lane(id, y, ordinal, options = {}) {
    return { id, sectionId: options.sectionId || 'arterial', sourceWayId: options.sourceWayId || 'way-arterial',
        fromNode: options.fromNode || 'west', toNode: options.toNode || 'east', direction: options.direction || 'forward',
        type: 'driving', access: 'yes', highway: 'primary', width: 3.5, stripIndex: ordinal, ordinal,
        change: options.change || 'yes', maxSpeed: 40, points: [geo([0, y]), geo([200, y])] };
}

function network({ signal = false } = {}) {
    const lanes = [
        lane('left', 0, 0),
        lane('blocked', -3.5, 1, { change: 'no' }),
        lane('right', -7, 2)
    ];
    // A separate section creates a legal circulation target for the left lane.
    lanes.push({ id: 'return', sectionId: 'return-road', sourceWayId: 'way-return', fromNode: 'east', toNode: 'west',
        direction: 'backward', type: 'driving', access: 'yes', highway: 'primary', width: 3.5,
        stripIndex: 0, ordinal: 0, change: 'yes', maxSpeed: 40, points: [geo([200, 20]), geo([0, 20])] });
    const connections = [
        { id: 'left-return', fromLaneId: 'left', toLaneId: 'return', nodeId: 'east', points: [geo([200, 0]), geo([200, 20])] },
        { id: 'return-left', fromLaneId: 'return', toLaneId: 'left', nodeId: 'west', points: [geo([0, 20]), geo([0, 0])] }
    ];
    const fixture = { bbox: [ORIGIN[0] - .02, ORIGIN[1] - .02, ORIGIN[0] + .02, ORIGIN[1] + .02],
        nodes: [{ id: 'west', degree: 2 }, { id: 'east', degree: 2 }], lanes, connections, signals: [] };
    if (signal) fixture.signals.push({ id: 'target-red', point: geo([190, 0]), controls: [{ laneId: 'left', fraction: .95 }] });
    return createNetwork(fixture);
}

function inConnectionNetwork() {
    const lanes = [
        { id: 'approach', sectionId: 'approach', sourceWayId: 'way-approach', fromNode: 'west', toNode: 'junction',
            direction: 'forward', type: 'driving', access: 'yes', highway: 'primary', width: 3.5, stripIndex: 0, ordinal: 0,
            change: 'yes', maxSpeed: 40, points: [geo([-100, -5.5]), geo([-3.5, -5.5])] },
        { id: 'out-left', sectionId: 'outbound', sourceWayId: 'way-outbound', fromNode: 'junction', toNode: 'far',
            direction: 'forward', type: 'driving', access: 'yes', highway: 'primary', width: 3.5, stripIndex: 0, ordinal: 0,
            change: 'yes', maxSpeed: 40, points: [geo([0, 0]), geo([100, 0])] },
        { id: 'out-blocked', sectionId: 'outbound', sourceWayId: 'way-outbound', fromNode: 'junction', toNode: 'far',
            direction: 'forward', type: 'driving', access: 'yes', highway: 'primary', width: 3.5, stripIndex: 1, ordinal: 1,
            change: 'yes', maxSpeed: 40, points: [geo([0, -5.5]), geo([100, -5.5])] },
        { id: 'return', sectionId: 'return-road', sourceWayId: 'way-return', fromNode: 'far', toNode: 'junction',
            direction: 'backward', type: 'driving', access: 'yes', highway: 'primary', width: 3.5, stripIndex: 0, ordinal: 0,
            change: 'yes', maxSpeed: 40, points: [geo([100, 20]), geo([0, 20])] }
    ];
    const connections = [
        { id: 'enter-blocked', fromLaneId: 'approach', toLaneId: 'out-blocked', nodeId: 'junction',
            points: [geo([-3.5, -5.5]), geo([0, -5.5])] },
        { id: 'left-return', fromLaneId: 'out-left', toLaneId: 'return', nodeId: 'far',
            points: [geo([100, 0]), geo([100, 20])] },
        { id: 'return-left', fromLaneId: 'return', toLaneId: 'out-left', nodeId: 'junction',
            points: [geo([0, 20]), geo([0, 0])] }
    ];
    return createNetwork({ bbox: [ORIGIN[0] - .02, ORIGIN[1] - .02, ORIGIN[0] + .02, ORIGIN[1] + .02],
        nodes: [{ id: 'west', degree: 1 }, { id: 'junction', degree: 3 }, { id: 'far', degree: 2 }], lanes, connections, signals: [] });
}

function car(id, laneId, s, speed = 0) {
    return { id, laneId, mode: 'lane', s, next: null, speed, cruise: 8, color: 1,
        state: 'driving', change: null, stoppedFor: 0, blockedFor: 0, cooldown: Infinity, clearance: null };
}

function overlap(sim, a, b) {
    const pa = sim.pose(a), pb = sim.pose(b);
    return Collision.overlaps(pa, pb);
}

describe('traffic standstill recovery', () => {
    it('moves a blocked car off a no-change lane with no route and onto a routed same-flow lane', () => {
        const base = network(), sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(382, 'blocked', 198.5);
        sim.cars.push(vehicle);
        const poses = [], recoveryTargets = [];
        let blockedSince = null, recoveredAt = null;
        for (let tick = 0; tick < 120; tick++) {
            sim.advance(.1);
            poses.push(sim.pose(vehicle));
            if (vehicle.blockedFor > 0 && blockedSince == null) blockedSince = sim.time - vehicle.blockedFor;
            if (vehicle.change?.recovery) recoveryTargets.push(vehicle.change.to);
            if (vehicle.change?.recovery && recoveredAt == null) recoveredAt = sim.time;
            if (!vehicle.change && vehicle.laneId === 'left') break;
        }

        expect(laneChangeAllowed(base.lanes.get('blocked'), base.lanes.get('left'))).toBe(false);
        expect(base.lanes.get('blocked').routes).toEqual([]);
        expect(base.lanes.get('left').routes).toContain('left-return');
        expect(vehicle.id).toBe(382);
        expect(vehicle.laneId).toBe('left');
        expect(vehicle.next).toBe('left-return');
        expect(vehicle.change).toBeNull();
        expect(sim.cars).toEqual([vehicle]);
        expect(recoveryTargets.length).toBeGreaterThan(0);
        expect(recoveryTargets.every(id => id === 'left')).toBe(true);
        expect(blockedSince).not.toBeNull();
        expect(recoveredAt - blockedSince).toBeGreaterThanOrEqual(.9);
        for (let i = 1; i < poses.length; i++) {
            expect(Math.hypot(poses[i].x - poses[i - 1].x, poses[i].y - poses[i - 1].y)).toBeLessThan(1);
        }
    });

    it('uses one-hop same-flow recovery twice to reach a routed lane through a dead-end neighbor', () => {
        const base = network(), sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(52, 'right', 200);
        sim.cars.push(vehicle);
        const hops = [];
        for (let tick = 0; tick < 400 && vehicle.laneId !== 'left'; tick++) {
            sim.advance(.1);
            if (vehicle.change?.recovery && vehicle.change.to !== hops.at(-1)) hops.push(vehicle.change.to);
        }
        expect(base.lanes.get('right').routes).toEqual([]);
        expect(base.lanes.get('blocked').routes).toEqual([]);
        expect(vehicle.laneId).toBe('left');
        expect(hops).toEqual(['blocked', 'left']);
        for (const [fromId, toId] of [['right', hops[0]], ['blocked', hops[1]]]) {
            const from = base.lanes.get(fromId), to = base.lanes.get(toId);
            expect(from.sectionId).toBe(to.sectionId);
            expect(from.direction).toBe(to.direction);
            expect(Math.abs(from.ordinal - to.ordinal)).toBe(1);
        }
        expect(vehicle.id).toBe(52);
        expect(vehicle.next).toBe('left-return');
    });

    it('waits for a stationary but routable target car, then recovers after it is released', () => {
        const base = network(), sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(1, 'blocked', 198.5), occupant = car(2, 'left', 199.5);
        occupant.next = 'left-return';
        sim.cars.push(vehicle, occupant);
        const targetGate = { distance: candidate => candidate.id === occupant.id ? 0 : Infinity };
        sim.gates.push(targetGate);
        for (let tick = 0; tick < 100; tick++) {
            sim.advance(.1);
            expect(overlap(sim, vehicle, occupant)).toBe(false);
        }
        expect(occupant.laneId).toBe('left');
        expect(occupant.next).toBe('left-return');
        expect(vehicle.laneId).not.toBe('left');
        sim.gates.splice(sim.gates.indexOf(targetGate), 1);
        for (let tick = 0; tick < 160 && vehicle.laneId !== 'left'; tick++) {
            sim.advance(.1);
            expect(overlap(sim, vehicle, occupant)).toBe(false);
        }
        expect(vehicle.laneId).toBe('left');
        expect(vehicle.next).toBe('left-return');
    });

    it('recovers from a blocked connector onto a parallel routed receiving lane', () => {
        const base = inConnectionNetwork(), sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const movement = base.connections.get('enter-blocked');
        const vehicle = car(23, 'approach', movement.path.length - .1);
        vehicle.mode = 'connection'; vehicle.connectionId = movement.id; vehicle.next = movement.id;
        const blocker = car(24, 'out-blocked', 4.7);
        sim.cars.push(vehicle, blocker);
        const connectorGate = { distance: candidate => candidate.id === vehicle.id
            && candidate.mode === 'connection' && !candidate.change?.recovery ? 0 : Infinity };
        const blockerGate = { distance: candidate => candidate.id === blocker.id ? 0 : Infinity };
        sim.gates.push(connectorGate, blockerGate);
        for (let tick = 0; tick < 40 && !vehicle.change?.recovery; tick++) {
            sim.advance(.1);
            expect(overlap(sim, vehicle, blocker)).toBe(false);
        }
        expect(vehicle.mode).toBe('connection');
        expect(vehicle.change?.recovery).toBe(true);
        sim.gates.splice(sim.gates.indexOf(blockerGate), 1);
        for (let tick = 0; tick < 240 && vehicle.laneId !== 'out-left'; tick++) {
            sim.advance(.1);
            expect(overlap(sim, vehicle, blocker)).toBe(false);
        }
        expect(vehicle.id).toBe(23);
        expect(vehicle.mode).toBe('lane');
        expect(vehicle.laneId).toBe('out-left');
        expect(vehicle.next).toBe('left-return');
    });

    it('does not recover through a red target signal', () => {
        const base = network({ signal: true }), sim = new Simulation(base, { count: 0, signals: true, laneChangeRate: 0 });
        const target = base.lanes.get('left'), control = target.signals[0];
        expect(control).toBeDefined();
        const signal = base.signals.get(control.signalId);
        const redStart = Array.from({ length: 1200 }, (_, index) => index / 10).find(time =>
            Traffic.signalAspect(signal, control.phase, time + 0.1) === 'red'
                && Traffic.signalAspect(signal, control.phase, time + 8) === 'red');
        expect(redStart).toBeDefined();
        sim.time = redStart;
        const vehicle = car(8, 'blocked', 180);
        sim.cars.push(vehicle);
        const actualBlock = { distance: candidate => candidate.id === vehicle.id
            && candidate.laneId === 'blocked' && !candidate.change?.recovery ? 0 : Infinity };
        sim.gates.push(actualBlock);
        let started = false;
        for (let tick = 0; tick < 120; tick++) {
            sim.advance(.1);
            started ||= !!vehicle.change?.recovery || vehicle.laneId === 'left';
            expect(Traffic.signalAspect(signal, control.phase, sim.time)).toBe('red');
            const pose = sim.pose(vehicle), projection = Geometry.nearest(target.path, [pose.x, pose.y]);
            expect(projection.s).toBeLessThanOrEqual(control.stopS + .03);
            if (vehicle.laneId === 'left' && !vehicle.change?.recovery) break;
        }
        expect(started).toBe(true);
        expect(vehicle.laneId).toBe('left');
        expect(vehicle.s).toBeGreaterThan(control.stopS - .5);
        expect(vehicle.s).toBeLessThanOrEqual(control.stopS + .03);
    });

    it('refuses a recovery path through an active closure barrier', () => {
        const base = network(), sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const barrier = { pose: sample(base.lanes.get('left').path, 200), length: 1, width: 3.5 };
        sim.network.closureBlocks = [barrier];
        const vehicle = car(16, 'blocked', 200);
        sim.cars.push(vehicle);
        for (let tick = 0; tick < 100; tick++) {
            sim.advance(.1);
            expect(Collision.overlapsRectangle(sim.pose(vehicle), barrier.pose, barrier.length, barrier.width)).toBe(false);
        }
        expect(vehicle.change?.recovery).not.toBe(true);
        expect(vehicle.laneId).toBe('blocked');
    });

    it('does not sidestep a red stop line by joining the neighboring connector', () => {
        const base = network({ signal: true }), sim = new Simulation(base, { count: 0, signals: true });
        const target = base.lanes.get('left'), control = target.signals[0];
        control.stopS = target.path.length - 2;
        const end = sample(target.path, target.path.length);
        base.connections.get('left-return').path = Geometry.path([[end.x, end.y], [end.x + 12, end.y]]);
        sim.time = Array.from({ length: 1200 }, (_, index) => index / 10).find(time =>
            Traffic.signalAspect(base.signals.get(control.signalId), control.phase, time) === 'red');
        const vehicle = car(19, 'blocked', control.stopS);
        vehicle.blockedFor = 2;
        sim.cars.push(vehicle);
        sim.tryRecovery(vehicle, sim.occupants());
        expect(vehicle.change).toBeNull();
        expect(vehicle.mode).toBe('lane');
        expect(vehicle.laneId).toBe('blocked');
    });

    it('does not replay prior-tick traversed links after a recovery collision rollback', () => {
        const base = network(), sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(31, 'blocked', 100, 8), blocker = car(32, 'left', 104.5, 0);
        sim.cars.push(vehicle, blocker);
        const holdBlocker = { distance: candidate => candidate.id === blocker.id ? 0 : Infinity };
        sim.gates.push(holdBlocker);
        const start = sim.pose(vehicle), end = sample(base.lanes.get('left').path, 108);
        vehicle.change = { recovery: true, to: 'left', toConnectionId: null, toS: 108,
            path: Geometry.taper(start, end), s: 0, progress: 0 };
        vehicle.traversed = ['prior-connection'];
        expect(overlap(sim, vehicle, blocker)).toBe(false);
        let rolledBack = false;
        for (let tick = 0; tick < 30 && !rolledBack; tick++) {
            const before = vehicle.s;
            sim.advance(.1);
            expect(vehicle.traversed).toEqual([]);
            rolledBack = vehicle.s - before < .01;
        }
        expect(rolledBack).toBe(true);
        expect(overlap(sim, vehicle, blocker)).toBe(false);
    });

    it('records a connector once when a collision retry keeps only partial cross-boundary travel', () => {
        const lanes = [
            { ...lane('approach', 0, 0, { fromNode: 'west', toNode: 'junction' }), points: [geo([-20, 0]), geo([0, 0])] },
            { ...lane('outgoing', 0, 0, { fromNode: 'junction', toNode: 'far' }), points: [geo([.5, 0]), geo([20, 0])] },
            { ...lane('return', 20, 0, { fromNode: 'far', toNode: 'west', direction: 'backward' }),
                points: [geo([20, 20]), geo([-20, 20])] },
            { ...lane('crossing', 0, 0, { fromNode: 'north', toNode: 'south' }),
                points: [geo([3.5, 10]), geo([3.5, -10])] }
        ];
        const connections = [
            { id: 'approach-outgoing', fromLaneId: 'approach', toLaneId: 'outgoing', nodeId: 'junction',
                points: [geo([0, 0]), geo([.5, 0])] },
            { id: 'outgoing-return', fromLaneId: 'outgoing', toLaneId: 'return', nodeId: 'far',
                points: [geo([20, 0]), geo([20, 20])] },
            { id: 'return-approach', fromLaneId: 'return', toLaneId: 'approach', nodeId: 'west',
                points: [geo([-20, 20]), geo([-20, 0])] }
        ];
        const base = createNetwork({ bbox: [ORIGIN[0] - .01, ORIGIN[1] - .01, ORIGIN[0] + .01, ORIGIN[1] + .01],
            nodes: [{ id: 'west', degree: 2 }, { id: 'junction', degree: 2 }, { id: 'far', degree: 2 }],
            lanes, connections, signals: [] });
        const sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(41, 'approach', 19.8, 8);
        vehicle.next = 'approach-outgoing';
        const blocker = car(42, 'crossing', 8);
        sim.cars.push(vehicle, blocker);

        expect(overlap(sim, vehicle, blocker)).toBe(false);
        expect(Collision.overlaps(sample(base.lanes.get('outgoing').path, .1), sim.pose(blocker))).toBe(true);
        sim.advance(.1);

        expect(vehicle.mode).toBe('connection');
        expect(vehicle.connectionId).toBe('approach-outgoing');
        expect(vehicle.s).toBeGreaterThan(0);
        expect(vehicle.s).toBeLessThan(base.connections.get('approach-outgoing').path.length);
        expect(vehicle.traversed).toEqual(['approach-outgoing']);
        expect(overlap(sim, vehicle, blocker)).toBe(false);
    });

    it('keeps a live recovery path intact while a closure edit is pending', () => {
        const base = network(), sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(17, 'blocked', 200);
        sim.cars.push(vehicle);
        for (let tick = 0; tick < 30 && !vehicle.change?.recovery; tick++) sim.advance(.1);
        expect(vehicle.change?.recovery).toBe(true);
        const editor = new Editor(base, sim), currentNetwork = sim.network;
        editor.toggle(chunk(base.lanes.get('left'), 150));
        expect(editor.update()).toBe(false);
        expect(sim.network).toBe(currentNetwork);
        expect(vehicle.change?.recovery).toBe(true);
        expect(Number.isFinite(sample(vehicle.change.path, vehicle.change.s).x)).toBe(true);
        expect(Geometry.nearest(vehicle.change.path, [sim.pose(vehicle).x, sim.pose(vehicle).y]).distance).toBeLessThan(1e-6);
    });
});
