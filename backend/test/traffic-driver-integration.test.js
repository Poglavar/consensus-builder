// Checks driver spacing, giving way and physical turnarounds through the real simulation loop.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Traffic = require('../../frontend/traffic/simulation.js');
const Collision = require('../../frontend/traffic/collision.js');
const Drivers = require('../../frontend/traffic/drivers.js');
const { Simulation, createNetwork } = Traffic;
const ORIGIN = [15.98, 45.81];
const METRES_PER_DEGREE = 111320;
const xScale = METRES_PER_DEGREE * Math.cos(ORIGIN[1] * Math.PI / 180);
const geo = ([x, y]) => [ORIGIN[0] + x / xScale, ORIGIN[1] + y / METRES_PER_DEGREE];

function lane(id, fromNode, toNode, start, end, options = {}) {
    return {
        id, sectionId: options.sectionId || `section-${id}`, sourceWayId: `way-${id}`,
        fromNode, toNode, direction: options.direction || 'forward', type: 'driving', access: 'yes',
        highway: 'residential', stripIndex: options.stripIndex ?? 0, ordinal: options.ordinal ?? 0,
        change: 'no', maxSpeed: options.maxSpeed ?? 30, width: options.width ?? 3.5,
        points: [geo(start), geo(end)]
    };
}

function connection(lanes, id, fromLaneId, toLaneId, nodeId) {
    const from = lanes.find(item => item.id === fromLaneId), to = lanes.find(item => item.id === toLaneId);
    return { id, fromLaneId, toLaneId, nodeId, points: [from.points.at(-1), to.points[0]] };
}

function networkFor(lanes, connections = [], extra = {}) {
    const nodes = new Map();
    for (const item of lanes) for (const id of [item.fromNode, item.toNode]) nodes.set(id, { id, degree: 2 });
    for (const move of connections) nodes.get(move.nodeId).degree = Math.max(3, nodes.get(move.nodeId).degree);
    const coords = lanes.flatMap(item => item.points);
    const bounds = [Math.min(...coords.map(p => p[0])) - .01, Math.min(...coords.map(p => p[1])) - .01,
        Math.max(...coords.map(p => p[0])) + .01, Math.max(...coords.map(p => p[1])) + .01];
    return createNetwork({ bbox: bounds, nodes: [...nodes.values()], lanes, connections, signals: [], ...extra });
}

function vehicle(id, laneId, s, { type = 'car', speed = 0, cruise = 8, driver = {} } = {}) {
    return {
        id, laneId, mode: 'lane', s, speed, cruise, color: id % 7, next: null,
        state: 'driving', change: null, maneuver: null, stoppedFor: 0, cooldown: Infinity,
        clearance: null, blockedFor: 0, waitingFor: null, collisionBlocker: null,
        vehicleType: type, driver: { ...Drivers.create(() => .5), ...driver }
    };
}

describe('traffic driver behavior in the simulation', () => {
    it('clears prior-tick traversals when every collision retry is blocked without movement', () => {
        const road = lane('stalled', 'west', 'east', [-100, 0], [100, 0]);
        const obstacle = lane('obstacle', 'obstacle-west', 'obstacle-east', [-100, 0], [100, 0]);
        const network = networkFor([road, obstacle]);
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const stopped = vehicle(1, road.id, 100, { speed: 8, cruise: 8 });
        const blocker = vehicle(2, obstacle.id, 104.6401, { speed: 0, cruise: 0 });
        stopped.traversed = ['stale-prior-connection'];
        sim.cars.push(stopped, blocker);

        expect(Collision.overlaps(sim.pose(stopped), sim.pose(blocker))).toBe(false);
        expect(Collision.overlaps({ ...sim.pose(stopped), x: .8 }, sim.pose(blocker))).toBe(true);
        sim.step();

        expect(stopped.s).toBeCloseTo(100, 5);
        expect(stopped.traversed).toEqual([]);
    });

    it('includes a mapped red stop 35 metres from a maneuver start in its crossing guard', () => {
        const road = lane('signal-road', 'west', 'east', [-50, 0], [100, 0]);
        const control = { id: 'far-red', point: geo([88, 0]),
            controls: [{ laneId: road.id, fraction: 88 / 150 }] };
        const network = networkFor([road], [], { signals: [control] });
        const sim = new Simulation(network, { count: 0, signals: true, laneChangeRate: 0 });
        const startPoint = network.project(geo([0, 0]));
        const stops = sim.localStops({ x: startPoint[0], y: startPoint[1], angle: 0 });
        const mapped = stops.flatMap(item => item.controls.map(stop => ({ lane: item.lane, ...stop })))
            .find(stop => stop.lane.id === road.id);
        expect(mapped).toBeDefined();
        expect(mapped.stopS - 50).toBeCloseTo(35.5, 2);
        const signal = network.signals.get(mapped.signalId);
        const redAt = Array.from({ length: 1200 }, (_, i) => i / 10)
            .find(time => Traffic.signalAspect(signal, mapped.phase, time) === 'red');
        expect(redAt).toBeDefined();
        sim.time = redAt;

        const car = vehicle(3, road.id, 50);
        expect(Traffic.signalAspect(signal, mapped.phase, sim.time)).toBe('red');
        expect(mapped.lane.signals).toContainEqual({ signalId: mapped.signalId, phase: mapped.phase, stopS: mapped.stopS });
        const before = network.project(geo([30, 0])), after = network.project(geo([40, 0]));
        expect(sim.maneuverBlocked(car, { x: after[0], y: after[1], angle: 0 },
            { x: before[0], y: before[1], angle: 0 }, false, stops)).toBe(true);
    });

    it('stops only the rear of two close, distinct approaches merging into one receiving lane', () => {
        const approaches = [
            lane('approach-rear', 'rear-start', 'junction', [-50, -2], [-8, -2]),
            lane('approach-front', 'front-start', 'junction', [0, -50], [0, -8]),
            lane('approach-distant', 'distant-start', 'junction', [-50, -12], [-8, -12])
        ];
        const receiving = lane('receiving', 'junction', 'far', [0, 0], [100, 0]);
        const lanes = [...approaches, receiving];
        const moves = approaches.map((source, i) => connection(lanes, `merge-${i}`, source.id, receiving.id, 'junction'));
        const network = networkFor(lanes, moves);
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const rear = vehicle(1, 'approach-rear', 4, { speed: 0 });
        rear.mode = 'connection'; rear.connectionId = 'merge-0'; rear.next = 'merge-0';
        const front = vehicle(2, 'approach-front', 4, { speed: 0 });
        front.mode = 'connection'; front.connectionId = 'merge-1'; front.next = 'merge-1';
        const distant = vehicle(3, 'approach-distant', 17, { speed: 0 });
        distant.next = 'merge-2';
        sim.cars.push(rear, front, distant);
        const occupied = sim.occupants();

        expect(Collision.overlaps(sim.pose(rear), sim.pose(front))).toBe(false);
        expect(Math.hypot(sim.pose(distant).x - sim.pose(front).x, sim.pose(distant).y - sim.pose(front).y)).toBeGreaterThan(15);
        const rearLimits = sim.limits(rear, occupied), frontLimits = sim.limits(front, occupied);
        expect(rearLimits.clearance).toBe(0);
        expect(rearLimits.leader).toBe(front.id);
        expect(frontLimits.clearance).toBe(Infinity);
        expect(frontLimits.leader).toBeNull();
    });

    it('uses typed body dimensions and driver spacing in a stopped queue', () => {
        const road = lane('queue', 'west', 'east', [-100, 0], [100, 0], { width: 6 });
        const network = networkFor([road]);
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const follower = vehicle(1, 'queue', 60, { speed: 0, driver: { gap: 2, headway: 1.2 } });
        const carLeader = vehicle(2, 'queue', 80, { speed: 0, cruise: 0, driver: { gap: 1 } });
        const busLeader = vehicle(3, 'queue', 80, { type: 'bus', speed: 0, cruise: 0, driver: { gap: 1 } });

        sim.cars.push(follower, carLeader);
        const carPose = sim.pose(carLeader);
        const carClearance = sim.limits(follower, sim.occupants()).clearance;
        sim.cars[1] = busLeader;
        const busPose = sim.pose(busLeader);
        const busClearance = sim.limits(follower, sim.occupants()).clearance;

        expect(carPose).toMatchObject({ length: 4.4, width: 1.8 });
        expect(busPose).toMatchObject({ length: 12, width: 2.5 });
        expect(busClearance).toBeLessThan(carClearance);
        expect(carClearance - busClearance).toBeCloseTo((12 - 4.4) / 2, 4);
    });

    it('lets the loser of a mutual wait retreat through clear rear space without teleporting or colliding', () => {
        const road = lane('approach', 'west', 'east', [-80, 0], [80, 0]);
        const network = networkFor([road]);
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const loser = vehicle(1, road.id, 45, { driver: { priority: .9, reaction: 0, stuckFor: 20, patience: 10 } });
        const winner = vehicle(2, road.id, 70, { driver: { priority: .1, reaction: 0, stuckFor: 20, patience: 10 } });
        loser.state = winner.state = 'queue';
        loser.waitingFor = winner.id;
        winner.waitingFor = loser.id;
        sim.cars.push(loser, winner);
        const initial = sim.pose(loser);

        sim.step();
        expect(loser.maneuver?.kind).toBe('yield');
        expect(loser.maneuver.segments.some(segment => segment.gear === -1)).toBe(true);

        let previous = sim.pose(loser);
        for (let tick = 0; tick < 60; tick++) {
            sim.advance(.1);
            const pose = sim.pose(loser);
            expect(Math.hypot(pose.x - previous.x, pose.y - previous.y)).toBeLessThan(.2);
            expect(Collision.overlaps(pose, sim.pose(winner))).toBe(false);
            previous = pose;
            if (loser.maneuverCompletedAt) break;
        }
        expect(sim.pose(loser).x).toBeLessThan(initial.x - .2);
    });

    it('advances an impatient driver through a physical multi-point turnaround', () => {
        const sectionId = 'wide-street';
        const roads = [
            lane('eastbound', 'west', 'east', [-80, 0], [80, 0], { sectionId, width: 3.5 }),
            lane('eastbound-loop', 'east', 'far', [80, 0], [150, 0], { sectionId, width: 3.5 }),
            lane('westbound', 'far', 'west', [150, -3.5], [-80, -3.5], { sectionId, direction: 'backward', width: 3.5 })
        ];
        const moves = [
            connection(roads, 'continue-east', 'eastbound', 'eastbound-loop', 'east'),
            connection(roads, 'turn-west', 'eastbound-loop', 'westbound', 'far'),
            connection(roads, 'loop-west', 'westbound', 'eastbound', 'west')
        ];
        const paved = [{ id: 'carriageway', width: 8, points: [geo([-80, -1.75]), geo([150, -1.75])] }];
        const network = networkFor(roads, moves, { surfaceLanes: paved });
        const sim = new Simulation(network, { count: 0, signals: false, laneChangeRate: 0, physicalNetwork: network });
        const lead = vehicle(1, 'eastbound', 77, { cruise: 0, driver: { priority: 0 } });
        const impatient = vehicle(2, 'eastbound', 60, { driver: {
            gap: .8, headway: .6, patience: 1, reaction: 0, stuckFor: 20, nextTryAt: 0
        } });
        impatient.next = 'continue-east';
        const gap = Drivers.gap(impatient, lead);
        impatient.s = lead.s - gap;
        lead.state = 'queue'; impatient.state = 'queue';
        impatient.blockedFor = 20;
        sim.cars.push(impatient, lead);

        const firstPose = sim.pose(impatient);
        let actualReverseTravel = 0;
        let reverseSeen = false, gearChanges = 0, maneuverKind = null, previous = firstPose;
        for (let tick = 0; tick < 1200; tick++) {
            sim.advance(.1);
            if (impatient.maneuver) {
                const gears = impatient.maneuver.segments.map(segment => segment.gear);
                maneuverKind ||= impatient.maneuver.kind;
                reverseSeen ||= gears.includes(-1);
                gearChanges = Math.max(gearChanges, gears.slice(1).filter((gear, index) => gear !== gears[index]).length);
            }
            const pose = sim.pose(impatient);
            if (impatient.maneuver?.segments[impatient.maneuver.index].gear === -1
                && Math.hypot(pose.x - previous.x, pose.y - previous.y) > .001) actualReverseTravel += Math.hypot(pose.x - previous.x, pose.y - previous.y);
            expect(Math.hypot(pose.x - previous.x, pose.y - previous.y)).toBeLessThan(.3);
            expect(Collision.overlaps(pose, sim.pose(lead))).toBe(false);
            previous = pose;
            if (impatient.maneuverCompletedAt && sim.time >= impatient.maneuverCompletedAt) break;
        }

        expect(network.data.surfaceLanes).toBe(paved);
        expect(reverseSeen).toBe(true);
        expect(actualReverseTravel).toBeGreaterThan(.5);
        expect(gearChanges).toBeGreaterThanOrEqual(1);
        expect(impatient.maneuverCompletedAt).toBeTypeOf('number');
        expect(maneuverKind).toBe('turnaround');
        expect(impatient.laneId).toBe('westbound');
        expect(Math.hypot(sim.pose(impatient).x - firstPose.x, sim.pose(impatient).y - firstPose.y)).toBeGreaterThan(3);
    });
});
