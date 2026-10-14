import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Engine = require('../../frontend/traffic/simulation.js');
const Scenario = require('../../frontend/traffic/scenario.js');
const Geometry = require('../../frontend/traffic/geometry.js');
const Meters = require('../../frontend/traffic/meters.js');
const { Simulation, createNetwork, laneChangeAllowed, sample } = Engine;
const { Editor, compile, chunk, BUFFER } = Scenario;

const ORIGIN = [15.98, 45.81];
const METRES_PER_DEGREE = 111320;
const xScale = METRES_PER_DEGREE * Math.cos(ORIGIN[1] * Math.PI / 180);
const geo = ([x, y]) => [ORIGIN[0] + x / xScale, ORIGIN[1] + y / METRES_PER_DEGREE];

function lane(id, direction, ordinal, fromNode, toNode, points) {
    return { id, sectionId: 'arterial', sourceWayId: 'way-arterial', direction,
        type: 'driving', access: 'yes', highway: 'primary', width: 3.5,
        stripIndex: ordinal, ordinal, change: 'yes', maxSpeed: 40,
        fromNode, toNode, points: points.map(geo) };
}

function link(id, fromLaneId, toLaneId, nodeId, points) {
    return { id, fromLaneId, toLaneId, nodeId, type: 'continue', points: points.map(geo) };
}

function loopNetwork(laneCount = 2) {
    const lanes = [], connections = [];
    for (let i = 0; i < laneCount; i++) {
        const offset = i * 3.5;
        const east = `east-${i}`, west = `west-${i}`;
        lanes.push(lane(east, 'forward', i, 'west-node', 'east-node', [[0, offset], [200, offset]]));
        lanes.push(lane(west, 'backward', i, 'east-node', 'west-node', [[200, 20 + offset], [0, 20 + offset]]));
        const eastArc = Array.from({ length: 9 }, (_, step) => {
            const angle = -Math.PI / 2 + Math.PI * step / 8;
            return [200 + 10 * Math.cos(angle), 10 + offset + 10 * Math.sin(angle)];
        });
        const westArc = Array.from({ length: 9 }, (_, step) => {
            const angle = Math.PI / 2 + Math.PI * step / 8;
            return [10 * Math.cos(angle), 10 + offset + 10 * Math.sin(angle)];
        });
        connections.push(link(`east-turn-${i}`, east, west, 'east-node', eastArc));
        connections.push(link(`west-turn-${i}`, west, east, 'west-node', westArc));
    }
    const nodeIds = [...new Set(lanes.flatMap(item => [item.fromNode, item.toNode]))];
    return createNetwork({
        bbox: [ORIGIN[0] - .02, ORIGIN[1] - .02, ORIGIN[0] + .02, ORIGIN[1] + .02],
        nodes: nodeIds.map(id => ({ id, degree: 2 })), lanes, connections, signals: []
    });
}

function car(id, laneId, s, next, speed = 4) {
    return { id, laneId, mode: 'lane', s, next, speed, cruise: 8, color: 1,
        state: 'driving', change: null, stoppedFor: 0, cooldown: Infinity,
        clearance: null, previousPose: null };
}

function fragmentAt(network, laneId, station) {
    return network.fragments.get(laneId).find(item => station >= item.startS - 1e-5 && station < item.endS - 1e-5);
}

function routeTo(network, startId, isTarget) {
    const queue = [{ laneId: startId, moves: [] }], seen = new Set([startId]);
    for (let i = 0; i < queue.length; i++) {
        const current = queue[i];
        if (isTarget(network.lanes.get(current.laneId))) return current.moves;
        for (const id of network.lanes.get(current.laneId).routes) {
            const move = network.connections.get(id);
            if (seen.has(move.toLaneId)) continue;
            seen.add(move.toLaneId);
            queue.push({ laneId: move.toLaneId, moves: [...current.moves, move] });
        }
    }
    return null;
}

describe('live traffic lane scenarios', () => {
    it('reopens only the selected span when switching between 5m and 10m chunks', () => {
        const base = loopNetwork(), sim = new Simulation(base, { count: 0 });
        const editor = new Editor(base, sim), lane = base.lanes.get('east-0');
        editor.toggle(chunk(lane, 80, 10));
        editor.toggle(chunk(lane, 85, 5));
        expect(editor.closures.map(c => [c.start, c.end])).toEqual([[80, 85]]);
        editor.toggle(chunk(lane, 85, 5));
        expect(editor.closures.map(c => [c.start, c.end])).toEqual([[80, 85], [85, 90]]);
        editor.toggle(chunk(lane, 80, 10));
        expect(editor.closures).toEqual([]);
    });
    it.each([[5, 80, 85], [10, 80, 90]])('removes the %im selected span plus the 2.5m safety buffer', (length, start, end) => {
        const base = loopNetwork();
        const selected = chunk(base.lanes.get('east-0'), 80, length);
        expect(selected).toMatchObject({ start, end });
        const network = compile(base, [{ ...selected, status: 'active' }]);
        const expandedStart = Math.max(0, start - BUFFER), expandedEnd = end + BUFFER;
        const openParts = network.fragments.get('east-0');
        expect(openParts.some(part => part.startS < expandedEnd && part.endS > expandedStart)).toBe(false);
        expect(openParts.reduce((sum, part) => sum + part.endS - part.startS, 0))
            .toBeCloseTo(base.lanes.get('east-0').path.length - (expandedEnd - expandedStart), 5);
    });

    it('creates only legal adjacent same-direction bypasses that stay clear of closed spans', () => {
        const base = loopNetwork(3);
        const closures = [
            { ...chunk(base.lanes.get('east-0'), 80), status: 'active' },
            { ...chunk(base.lanes.get('east-1'), 130), status: 'active' }
        ];
        const network = compile(base, closures);
        const bypasses = [...network.connections.values()].filter(move => move.type === 'bypass');
        expect(bypasses.length).toBeGreaterThan(0);
        for (const move of bypasses) {
            const from = network.lanes.get(move.fromLaneId), to = network.lanes.get(move.toLaneId);
            const source = base.lanes.get(from.baseLaneId), target = base.lanes.get(to.baseLaneId);
            expect(laneChangeAllowed(source, target)).toBe(true);
            expect(Math.abs(source.ordinal - target.ordinal)).toBe(1);
            for (const closure of closures) {
                const closedLane = base.lanes.get(closure.laneId);
                for (let s = 0; s <= move.path.length; s += .5) {
                    const p = sample(move.path, s), hit = Geometry.nearest(closedLane.path, [p.x, p.y]);
                    if (hit.s >= closure.start - BUFFER && hit.s <= closure.end + BUFFER) {
                        expect(hit.distance).toBeGreaterThan(1.8);
                    }
                }
            }
        }
        const start = fragmentAt(network, 'east-0', 56);
        const route = routeTo(network, start.id, lane => lane.baseLaneId === 'east-2' && lane.startS >= closures[1].end + BUFFER);
        const laneHops = route?.filter(move => move.type === 'bypass').map(move => [
            network.lanes.get(move.fromLaneId).baseLaneId,
            network.lanes.get(move.toLaneId).baseLaneId
        ]);
        expect(laneHops).toEqual([['east-0', 'east-1'], ['east-1', 'east-2']]);
    });

    it('routes a car around one closed lane and returns it to that lane after the closure', () => {
        const base = loopNetwork();
        const sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const editor = new Editor(base, sim);
        editor.toggle(chunk(base.lanes.get('east-0'), 80));
        expect(editor.closures[0].status).toBe('active');
        const source = fragmentAt(sim.network, 'east-0', 56);
        const vehicle = car(41, source.id, 56 - source.startS, null, 8);
        vehicle.next = sim.chooseRoute(source, vehicle);
        sim.cars.push(vehicle);
        let usedBypass = false, returned = false;
        for (let tick = 0; tick < 900; tick++) {
            sim.advance(.1);
            if (vehicle.returnLaneId === 'east-0') usedBypass = true;
            const current = sim.network.lanes.get(vehicle.laneId);
            if (usedBypass && vehicle.returnLaneId == null && current.baseLaneId === 'east-0'
                && current.startS >= editor.closures[0].end + BUFFER) { returned = true; break; }
        }
        const stopped = sim.network.lanes.get(vehicle.laneId);
        expect(usedBypass, JSON.stringify({ mode: vehicle.mode, laneId: vehicle.laneId, connectionId: vehicle.connectionId,
            s: vehicle.s, next: vehicle.next, state: vehicle.state, routes: stopped.routes,
            outgoing: stopped.outgoing.map(id => sim.network.connections.get(id)),
            fragments: sim.network.fragments.get('east-0').map(item => ({ id: item.id, startS: item.startS, endS: item.endS, routes: item.routes })) })).toBe(true);
        expect(returned).toBe(true);
        expect(vehicle.laneId).toContain('east-0');
    });

    it('makes two adjacent detours, measures the lane actually used, and returns after the barriers', () => {
        const base = loopNetwork(3);
        const closures = [{ laneId: 'east-0', start: 80, end: 140 }, { laneId: 'east-1', start: 100, end: 140 }];
        const network = compile(base, closures), sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const source = fragmentAt(network, 'east-0', 20), vehicle = car(19, source.id, 20 - source.startS, null, 8);
        vehicle.next = sim.chooseRoute(source, vehicle); sim.cars.push(vehicle);
        const index = new Meters.LaneIndex(base), counters = new Meters.Counters();
        const station = sample(base.lanes.get('east-0').path, 120);
        const meter = counters.add(Meters.profile(index, index.hit([station.x, station.y])), 0);
        sim.listeners.add((car, before, after, time) => counters.observe(car, before, after, time));
        let returned = false;
        for (let tick = 0; tick < 700; tick++) {
            sim.advance(.1);
            const lane = network.lanes.get(vehicle.laneId);
            if (vehicle.mode === 'lane' && lane.baseLaneId === 'east-0' && lane.startS + vehicle.s > 170) { returned = true; break; }
        }
        expect(sim.cars).toEqual([vehicle]);
        expect(returned).toBe(true);
        expect(sim.laneChanges).toBeGreaterThanOrEqual(4);
        expect(meter.counts.get('east-0')).toBe(0);
        expect(meter.counts.get('east-1')).toBe(0);
        expect(meter.counts.get('east-2')).toBe(1);
    });

    it('keeps live car identity, clock, pose, speed and counters when compiling an edit', () => {
        const base = loopNetwork();
        const sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(9, 'east-0', 35, 'east-turn-0', 6.5);
        sim.cars.push(vehicle);
        sim.time = 31.4;
        sim.crossings = 7;
        sim.laneChanges = 3;
        const beforePose = sim.pose(vehicle), beforeSpeed = vehicle.speed;
        const editor = new Editor(base, sim);
        editor.toggle(chunk(base.lanes.get('east-0'), 120));
        expect(editor.closures[0].status).toBe('active');
        expect(sim.cars[0]).toBe(vehicle);
        expect(vehicle.id).toBe(9);
        expect(sim.time).toBe(31.4);
        expect(vehicle.speed).toBe(beforeSpeed);
        expect(sim.crossings).toBe(7);
        expect(sim.laneChanges).toBe(3);
        const afterPose = sim.pose(vehicle);
        expect(Math.hypot(afterPose.x - beforePose.x, afterPose.y - beforePose.y)).toBeLessThan(1e-5);
    });

    it('keeps a closure pending until an occupied span clears, then activates it', () => {
        const base = loopNetwork();
        const sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(12, 'east-0', 80, 'east-turn-0', 8);
        sim.cars.push(vehicle);
        const editor = new Editor(base, sim);
        editor.toggle(chunk(base.lanes.get('east-0'), 80));
        expect(editor.closures[0].status).toBe('pending');
        for (let tick = 0; tick < 180 && editor.closures[0].status === 'pending'; tick++) {
            sim.advance(.1);
            editor.update();
        }
        expect(editor.closures[0].status).toBe('active');
        const current = sim.network.lanes.get(vehicle.laneId);
        expect(editor.busy(editor.closures[0])).toBe(false);
        expect(vehicle.mode === 'connection' || current.baseLaneId !== 'east-0'
            || (current.startS || 0) + vehicle.s > editor.closures[0].end + BUFFER).toBe(true);
        expect(sim.cars[0]).toBe(vehicle);
    });

    it('reopens a lane during an active connection without changing the in-flight geometry', () => {
        const base = loopNetwork();
        const sim = new Simulation(base, { count: 0, signals: false, laneChangeRate: 0 });
        const vehicle = car(22, 'east-0', 0, 'east-turn-0', 5);
        vehicle.mode = 'connection';
        vehicle.connectionId = 'east-turn-0';
        vehicle.s = sim.network.connections.get(vehicle.connectionId).path.length / 2;
        vehicle.previousPose = sim.pose(vehicle);
        sim.cars.push(vehicle);
        const editor = new Editor(base, sim);
        editor.toggle(chunk(base.lanes.get('east-0'), 100));
        expect(editor.closures[0].status).toBe('active');
        const before = sim.pose(vehicle), beforeS = vehicle.s;
        editor.clear();
        const after = sim.pose(vehicle);
        expect(sim.cars[0]).toBe(vehicle);
        expect(vehicle.mode).toBe('connection');
        expect(vehicle.s).toBe(beforeS);
        expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1e-5);
    });
});
