// Reproduces blocked bypasses, safe backing around a bus and restarting from a short queue gap.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Traffic = require('../../frontend/traffic/simulation.js');
const Collision = require('../../frontend/traffic/collision.js');
const Drivers = require('../../frontend/traffic/drivers.js');
const Vehicles = require('../../frontend/traffic/vehicles.js');
const Surface = require('../../frontend/traffic/surface.js');
const Maneuvers = require('../../frontend/traffic/maneuvers.js');
const { Simulation, createNetwork, path } = Traffic;
const ORIGIN = [15.98, 45.81];
const METRES_PER_DEGREE = 111320;
const xScale = METRES_PER_DEGREE * Math.cos(ORIGIN[1] * Math.PI / 180);
const geo = ([x, y]) => [ORIGIN[0] + x / xScale, ORIGIN[1] + y / METRES_PER_DEGREE];

function lane(id, fromNode, toNode, start, end, options = {}) {
    return {
        id, sectionId: options.sectionId || `section-${id}`, sourceWayId: `way-${id}`,
        fromNode, toNode, direction: options.direction || 'forward', type: 'driving', access: 'yes',
        highway: 'residential', stripIndex: options.stripIndex ?? 0, ordinal: options.ordinal ?? 0,
        change: options.change ?? 'no', maxSpeed: 30, width: 3.5, points: [geo(start), geo(end)]
    };
}

function connection(lanes, id, fromLaneId, toLaneId, nodeId) {
    const from = lanes.find(item => item.id === fromLaneId), to = lanes.find(item => item.id === toLaneId);
    return { id, fromLaneId, toLaneId, nodeId, points: [from.points.at(-1), to.points[0]] };
}

function makeNetwork() {
    const lanes = [
        lane('lane-0', 'west', 'east', [-80, 0], [80, 0], { sectionId: 'wide-road', stripIndex: 0, ordinal: 0, change: 'yes' }),
        lane('lane-1', 'west', 'east', [-80, 3.5], [80, 3.5], { sectionId: 'wide-road', stripIndex: 1, ordinal: 1, change: 'yes' }),
        lane('return-0', 'east', 'west', [80, -18], [-80, -18], { direction: 'backward' }),
        lane('return-1', 'east', 'west', [80, -28], [-80, -28], { direction: 'backward' })
    ];
    const moves = [];
    for (let index = 0; index < 2; index++) {
        moves.push(connection(lanes, `out-${index}`, `lane-${index}`, `return-${index}`, 'east'));
        moves.push(connection(lanes, `back-${index}`, `return-${index}`, `lane-${index}`, 'west'));
    }
    const surfaceLanes = [{ id: 'wide-pavement', width: 8, points: [geo([-80, 1.75]), geo([80, 1.75])] }];
    const nodes = ['west', 'east'].map(id => ({ id, degree: 4 }));
    const coords = lanes.flatMap(item => item.points);
    const bbox = [Math.min(...coords.map(p => p[0])) - .01, Math.min(...coords.map(p => p[1])) - .01,
        Math.max(...coords.map(p => p[0])) + .01, Math.max(...coords.map(p => p[1])) + .01];
    return createNetwork({ bbox, nodes, lanes, connections: moves, signals: [], surfaceLanes });
}

function vehicle(id, laneId, s, { type = 'car', cruise = 8, speed = 0, driver = {} } = {}) {
    return {
        id, laneId, mode: 'lane', s, speed, cruise, color: id % 7, next: null,
        state: 'changing', change: null, maneuver: null, stoppedFor: 0, cooldown: Infinity,
        clearance: null, blockedFor: 0, waitingFor: null, collisionBlocker: null,
        vehicleType: type, driver: { ...Drivers.create(() => .5), ...driver }
    };
}

describe('traffic recovery replanning', () => {
    function retreat(sim, bus, progress) {
        const route = sim.network.lanes.get(bus.laneId).path;
        const a = Traffic.sample(route, 80), b = Traffic.sample(route, 76.8);
        bus.maneuver = { kind: 'yield', segments: [{ gear: -1, path: path([[a.x, a.y], [b.x, b.y]]) }],
            index: 0, s: progress, travelled: progress, stops: [],
            landing: { mode: 'lane', laneId: bus.laneId, connectionId: null, s: 76.8, next: 'out-0' } };
        bus.s = 80 - progress;
    }

    it('finishes a bus retreat despite a non-overlapping adjacent lane-change reservation', () => {
        const sim = new Simulation(makeNetwork(), { count: 0, signals: false, laneChangeRate: 0 });
        const bus = vehicle(186, 'lane-0', 80, { type: 'bus', driver: { patience: Infinity, reaction: Infinity } });
        const adjacent = vehicle(129, 'lane-1', 74.4, { cruise: 0, driver: { patience: Infinity, reaction: Infinity } });
        adjacent.change = { to: 'lane-0', progress: 0, duration: Infinity };
        adjacent.next = 'out-1'; bus.next = 'out-0';
        retreat(sim, bus, 3.1877659);
        sim.cars.push(bus, adjacent);
        const before = sim.pose(bus);
        expect(Collision.overlaps(before, sim.pose(adjacent))).toBe(false);
        expect(sim.carOccupancies(adjacent).some(([id, s]) => id === bus.laneId && Math.abs(s - 76.8) < Traffic.GAP)).toBe(true);

        sim.advance(.1);

        expect(bus.maneuver).toBeNull();
        expect(bus.lastManeuver.kind).toBe('yield');
        expect(Math.hypot(sim.pose(bus).x - before.x, sim.pose(bus).y - before.y)).toBeCloseTo(.0122341, 5);
        const landed = bus.s;
        sim.advance(.5);
        expect(bus.s).toBeGreaterThan(landed);
        expect(Collision.overlaps(sim.pose(bus), sim.pose(adjacent))).toBe(false);
    });

    it('keeps an unfinished retreat outside an actual vehicle body at the landing', () => {
        const sim = new Simulation(makeNetwork(), { count: 0, signals: false, laneChangeRate: 0 });
        const bus = vehicle(186, 'lane-0', 80, { type: 'bus', driver: { patience: Infinity, reaction: Infinity } });
        const rear = vehicle(129, 'lane-0', 68.4, { cruise: 0, driver: { patience: Infinity, reaction: Infinity } });
        rear.next = 'out-0'; bus.next = 'out-0';
        retreat(sim, bus, 3);
        sim.cars.push(bus, rear);
        expect(Collision.overlaps(sim.pose(bus), sim.pose(rear))).toBe(false);
        for (let tick = 0; tick < 50; tick++) {
            sim.advance(.1);
            expect(Collision.overlaps(sim.pose(bus), sim.pose(rear))).toBe(false);
        }
        expect(bus.maneuver).not.toBeNull();
        expect(bus.collisionBlocker).toBe(rear.id);
        expect(bus.lastManeuver).toBeUndefined();
    });

    it('lets a stopped follower start moving when a stopped leader is just beyond its gap', () => {
        const network = makeNetwork();
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const follower = vehicle(8, 'lane-0', 70, { speed: 0, cruise: 8, driver: {
            gap: .9575, headway: 1.073855, reaction: 0, patience: 12, stuckFor: 0
        } });
        const leader = vehicle(9, 'lane-0', 0, {
            speed: 0, cruise: 0, driver: { gap: .8, headway: .8 }
        });
        leader.s = follower.s + Drivers.gap(follower, leader) + .214;
        follower.next = 'out-0'; leader.next = 'out-0';
        sim.cars.push(follower, leader);
        const initialS = follower.s;

        sim.advance(.1);

        expect(follower.s).toBeGreaterThan(initialS);
        expect(follower.speed).toBeGreaterThan(0);
    });

    it('backs a car out of a bus-blocked recovery path and safely passes in an adjacent lane', () => {
        const network = makeNetwork();
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0, physicalNetwork: network });
        const surface = Surface.build(network, network.data.surfaceLanes);
        const roadSpace = new Maneuvers.Space([...surface.lanes, ...surface.connections]);
        const stalled = vehicle(1, 'lane-1', 79.8, { driver: {
            gap: .8, headway: .6, reaction: 0, patience: 12, stuckFor: 255, nextTryAt: 0
        } });
        const recoveryPath = path([[-12, 3.5], [-8, 3.1], [-4, 1.3], [0, 0]]
            .map(point => network.project(geo(point))));
        stalled.change = {
            to: 'lane-0', toConnectionId: null, toS: network.lanes.get('lane-0').path.length / 2,
            path: recoveryPath, s: recoveryPath.length - .08, progress: .99, recovery: true,
            blockerId: 2
        };
        const bus = vehicle(2, 'lane-0', 88.9, { type: 'bus', cruise: 0, driver: { gap: 1 } });
        stalled.next = 'out-1'; bus.next = 'out-0';
        sim.cars.push(stalled, bus);
        sim.time = 255;
        const initial = sim.pose(stalled);
        expect(initial).toMatchObject({ length: Vehicles.get('car').length, width: Vehicles.get('car').width });
        expect(Collision.overlaps(initial, sim.pose(bus))).toBe(false);
        expect(roadSpace.contains(initial, Vehicles.get(stalled.vehicleType))).toBe(true);

        let reverseSeen = false;
        let reverseTravel = 0;
        let maximumStep = 0;
        let previous = initial;
        let previousGear = stalled.maneuver?.segments[stalled.maneuver.index]?.gear ?? 1;
        for (let tick = 0; tick < 1200; tick++) {
            sim.advance(.1);
            const pose = sim.pose(stalled);
            maximumStep = Math.max(maximumStep, Math.hypot(pose.x - previous.x, pose.y - previous.y));
            expect(Collision.overlaps(pose, sim.pose(bus))).toBe(false);
            expect(roadSpace.contains(pose, Vehicles.get(stalled.vehicleType))).toBe(true);
            reverseSeen ||= stalled.maneuver?.segments.some(segment => segment.gear < 0) || false;
            const gear = stalled.maneuver?.segments[stalled.maneuver.index]?.gear ?? 1;
            if (gear === -1 && previousGear === -1) {
                const dx = pose.x - previous.x, dy = pose.y - previous.y;
                reverseTravel += Math.max(0, -(dx * Math.cos(previous.angle) + dy * Math.sin(previous.angle)));
            }
            previousGear = gear;
            previous = pose;
            if (stalled.maneuverCompletedAt && sim.time > stalled.maneuverCompletedAt + .1
                && stalled.mode === 'lane' && !stalled.change && stalled.laneId !== 'lane-0'
                && sim.pose(stalled).x > sim.pose(bus).x + Vehicles.get(bus.vehicleType).length / 2) break;
        }

        expect(reverseSeen, JSON.stringify({ time: sim.time, laneId: stalled.laneId, mode: stalled.mode,
            change: stalled.change && { to: stalled.change.to, blockerId: stalled.change.blockerId, s: stalled.change.s, length: stalled.change.path.length },
            maneuver: stalled.maneuver && { kind: stalled.maneuver.kind, index: stalled.maneuver.index, s: stalled.maneuver.s,
                gears: stalled.maneuver.segments.map(segment => segment.gear) },
            planning: stalled.planning, task: !!sim.planningTask, queued: sim.planningQueue?.map(car => car.id),
            stuckFor: stalled.driver.stuckFor, patience: stalled.driver.patience, nextTryAt: stalled.driver.nextTryAt,
            lanes: ['lane-0', 'lane-1'].map(id => ({ id, routes: network.lanes.get(id).routes, neighbours: network.lanes.get(id).neighbours })) })).toBe(true);
        expect(reverseTravel).toBeGreaterThan(.5);
        // At 8 m/s, a normal 100 ms tick can move the car 0.8 m; reject
        // discontinuities while allowing that physically plausible travel.
        expect(maximumStep).toBeLessThan(1);
        expect(stalled.mode).toBe('lane');
        expect(stalled.change).toBeNull();
        expect(['lane-1'], JSON.stringify({ laneId: stalled.laneId, lastManeuver: stalled.lastManeuver,
            completedAt: stalled.maneuverCompletedAt, position: sim.pose(stalled), bus: sim.pose(bus) })).toContain(stalled.laneId);
        expect(sim.pose(stalled).x).toBeGreaterThan(sim.pose(bus).x + Vehicles.get(bus.vehicleType).length / 2);
    });

    it('waits safely when a bus ahead and a close follower leave no room to reverse', () => {
        const network = makeNetwork();
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0, physicalNetwork: network });
        const stalled = vehicle(3, 'lane-1', 79.8, { driver: {
            gap: .8, headway: .6, reaction: 0, patience: 12, stuckFor: 255, nextTryAt: 0
        } });
        const recoveryPath = path([[-12, 3.5], [-8, 3.1], [-4, 1.3], [0, 0]]
            .map(point => network.project(geo(point))));
        stalled.change = {
            to: 'lane-0', toConnectionId: null, toS: network.lanes.get('lane-0').path.length / 2,
            path: recoveryPath, s: recoveryPath.length - .08, progress: .99, recovery: true,
            blockerId: 4
        };
        const bus = vehicle(4, 'lane-0', 88.9, { type: 'bus', cruise: 0, driver: { gap: 1 } });
        const rearCar = vehicle(5, 'lane-0', 74.5, { cruise: 0, driver: { gap: .8 } });
        const rearLaneCar = vehicle(6, 'lane-1', 74.5, { cruise: 0, driver: { gap: .8 } });
        const frontLaneCar = vehicle(7, 'lane-1', 85.5, { cruise: 0, driver: { gap: .8 } });
        stalled.next = 'out-1'; bus.next = 'out-0'; rearCar.next = 'out-0';
        rearLaneCar.next = 'out-1'; frontLaneCar.next = 'out-1';
        sim.cars.push(stalled, bus, rearCar, rearLaneCar, frontLaneCar);
        sim.time = 255;

        const initial = sim.pose(stalled);
        for (const other of sim.cars.filter(car => car !== stalled)) {
            expect(Collision.overlaps(initial, sim.pose(other))).toBe(false);
        }
        let searchStarted = false, searchFailed = false;
        for (let tick = 0; tick < 1200; tick++) {
            const search = sim.planningTask?.search;
            sim.advance(.1);
            for (const other of sim.cars.filter(car => car !== stalled)) {
                expect(Collision.overlaps(sim.pose(stalled), sim.pose(other))).toBe(false);
            }
            searchStarted ||= stalled.planning;
            if (search?.done && !search.result) searchFailed = true;
            if (searchFailed && !stalled.planning && !stalled.maneuver
                && sim.driverState(stalled).maneuver === 'waiting') break;
        }

        const state = sim.driverState(stalled);
        expect(searchStarted).toBe(true);
        expect(searchFailed).toBe(true);
        expect(stalled.maneuver).toBeNull();
        expect(stalled.planning).toBe(false);
        expect(state.maneuver).toBe('waiting');
        expect(Math.hypot(sim.pose(stalled).x - initial.x, sim.pose(stalled).y - initial.y)).toBeLessThan(.5);
    });
});
