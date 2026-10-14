// Exercises an offline fixture read back from the traffic API and audits actual movements.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Traffic = require('../../frontend/traffic/simulation.js');
const Collision = require('../../frontend/traffic/collision.js');
const data = process.env.TRAFFIC_TEST_NETWORK
    ? JSON.parse(readFileSync(process.env.TRAFFIC_TEST_NETWORK))
    : JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/traffic-network.json.gz', import.meta.url))));

describe('exported traffic preview', () => {
    it('carries actual saved answers and an internally consistent directed graph', () => {
        const lanes = new Map(data.lanes.map(lane => [lane.id, lane]));
        expect(lanes.size).toBe(data.lanes.length);
        expect(new Set(data.connections.map(connection => connection.id)).size).toBe(data.connections.length);
        expect(data.source.savedJunctions.length).toBeGreaterThan(0);
        expect(data.source.osmSnapshotId).toBeDefined();
        expect(data.signals.length).toBeGreaterThan(0);
        expect(new Set(data.signals.map(signal => signal.id)).size).toBe(data.signals.length);
        for (const signal of data.signals) {
            expect(signal.id).toMatch(/^osm-node:\d+$/);
            expect(signal.point.every(Number.isFinite)).toBe(true);
            for (const control of signal.controls) {
                const lane = lanes.get(control.laneId);
                expect(lane).toBeDefined();
                expect(signal.sourceWayIds).toContain(String(lane.sourceWayId));
                expect(['both', lane.direction]).toContain(signal.direction);
                expect(control.fraction).toBeGreaterThanOrEqual(0);
                expect(control.fraction).toBeLessThanOrEqual(1);
            }
        }
        expect(data.connections.some(connection => connection.solutionId && connection.source === 'codex')).toBe(true);
        const invalid = data.connections.filter(connection => {
            const from = lanes.get(connection.fromLaneId), to = lanes.get(connection.toLaneId);
            return !from || !to || from.toNode !== connection.nodeId || to.fromNode !== connection.nodeId
                || JSON.stringify(connection.points[0]) !== JSON.stringify(from.points.at(-1))
                || JSON.stringify(connection.points.at(-1)) !== JSON.stringify(to.points[0]);
        });
        expect(invalid).toEqual([]);
        expect(JSON.stringify(data)).not.toMatch(/\/Users\/|\/home\/|sourceFile|@gmail\.com/);
    });

    it('lets both cars from the reported Miramarska median use their saved exits', () => {
        const network = Traffic.createNetwork(data);
        const sim = new Traffic.Simulation(network, { count: 0, signals: false, laneChangeRate: 0 });
        const nodeId = 'osm-node:1449370111';
        const approaches = [0, 1].map(ordinal => [...network.lanes.values()].find(lane =>
            String(lane.sourceWayId) === '924732205' && lane.toNode === nodeId && lane.ordinal === ordinal));
        expect(network.nodes.get(nodeId).unresolved).toBe(true);
        for (const [index, lane] of approaches.entries()) {
            const movement = lane.outgoing.map(id => network.connections.get(id)).find(connection =>
                String(network.lanes.get(connection.toLaneId).sourceWayId) === '285567739');
            expect(movement).toBeDefined();
            expect(movement.solutionId).toBe('139');
            expect(data.source.savedPartialJunctions.some(item => item.nodeId === nodeId
                && item.solutionId === '139' && item.laneIds.includes(lane.id))).toBe(true);
            sim.cars.push({ id: index + 1, laneId: lane.id, mode: 'lane', s: lane.path.length,
                speed: 0, cruise: 8, color: index, next: movement.id, state: 'blocked',
                change: null, cooldown: Infinity, clearance: null });
        }
        const original = [...sim.cars];
        const originalPositions = original.map(car => sim.pose(car));
        const traversed = new Set();
        for (let tick = 0; tick < 100; tick++) {
            sim.advance(.1);
            for (const car of sim.cars) if (car.mode === 'connection'
                && network.connections.get(car.connectionId).nodeId === nodeId) traversed.add(car.id);
        }
        expect(sim.cars).toHaveLength(2);
        expect([...traversed].sort()).toEqual([1, 2]);
        for (const [index, car] of sim.cars.entries()) {
            expect(car).toBe(original[index]);
            const position = sim.pose(car), start = originalPositions[index];
            expect(Math.hypot(position.x - start.x, position.y - start.y)).toBeGreaterThan(5);
        }
    });

    it('retains the saved Savska exits and coordinates the wide, split junction as one controller', () => {
        const network = Traffic.createNetwork(data);
        for (const nodeId of ['osm-node:21285211', 'osm-node:1603960938']) {
            const saved = data.connections.filter(move => move.nodeId === nodeId && move.solutionId === '2009');
            expect(saved.length).toBeGreaterThan(5);
            expect(data.source.savedPartialJunctions.some(item => item.nodeId === nodeId && item.solutionId === '2009')).toBe(true);
            expect(network.nodes.get(nodeId).unresolved).toBe(true);
        }
        const controller = [...network.controllers.values()].find(item => item.cluster?.nodes.has('osm-node:21285211'));
        expect(controller.cluster.nodes.has('osm-node:1603960938')).toBe(true);
        const heads = [...network.signals.values()].filter(head => head.controllerId === controller.id);
        expect(heads).toHaveLength(4);
        for (let time = 0; time < 116; time += .5) {
            const aspects = Object.fromEntries(heads.map(head => [head.direction, Traffic.signalAspect(head, head.phase, time)]));
            expect(aspects.N).toBe(aspects.S);
            expect(aspects.E).toBe(aspects.W);
            expect(aspects.N === 'green' && aspects.E === 'green').toBe(false);
        }
    });

    it('replaces the Vukovarska endpoint weave and Lučićeva lane split with continuous road paths', () => {
        const network = Traffic.createNetwork(data);
        const targetNodes = new Set(['osm-node:2892273952', 'osm-node:2287954173']);
        const moves = [...network.connections.values()].filter(move => targetNodes.has(move.nodeId));
        expect(moves.length).toBeGreaterThan(5);
        for (const move of moves) {
            expect(move.geometryKind).toBe('taper');
            expect(move.path.length).toBeGreaterThan(25);
            const from = network.lanes.get(move.fromLaneId), to = network.lanes.get(move.toLaneId);
            const a = Traffic.sample(from.path, from.path.length), b = Traffic.sample(to.path, 0);
            const axis = [Math.cos(a.angle), Math.sin(a.angle)];
            const start = Traffic.sample(move.path, 0), end = Traffic.sample(move.path, move.path.length);
            expect(Math.hypot(start.x - a.x, start.y - a.y)).toBeLessThan(1e-6);
            expect(Math.hypot(end.x - b.x, end.y - b.y)).toBeLessThan(1e-6);
            expect(Math.abs(start.angle - a.angle)).toBeLessThan(.01);
            expect(Math.abs(end.angle - b.angle)).toBeLessThan(.01);
            for (let i = 1; i < move.path.points.length; i++) {
                const p = move.path.points[i], previous = move.path.points[i - 1];
                expect((p[0] - previous[0]) * axis[0] + (p[1] - previous[1]) * axis[1]).toBeGreaterThan(0);
            }
        }
        expect([...network.connections.keys()]).toEqual(data.connections.map(move => move.id));
        const displacedSignals = [];
        for (const lane of network.lanes.values()) for (const stop of lane.sourceStops) {
            const before = Traffic.sample(lane.rawPath, stop.sourceS);
            const after = Traffic.sample(lane.path, stop.station);
            if (Math.hypot(before.x - after.x, before.y - after.y) > .001) displacedSignals.push(lane.id);
        }
        expect(displacedSignals).toEqual([]);
    });

    it('keeps every default car progressing through a twenty-minute run', async () => {
        const network = Traffic.createNetwork(data);
        const sim = new Traffic.Simulation(network, { count: 440, seed: 52 });
        const original = sim.cars.map(car => car.id);
        const lastMoved = new Map(original.map(id => [id, 0]));
        const previous = new Map(sim.cars.map(car => [car.id, { laneId: car.laneId, mode: car.mode, s: car.s }]));
        let blocked = 0;
        for (let tick = 0; tick < 12000; tick++) {
            sim.advance(.1);
            for (const car of sim.cars) {
                const before = previous.get(car.id);
                if (car.laneId !== before.laneId || car.mode !== before.mode || Math.abs(car.s - before.s) > .001) {
                    lastMoved.set(car.id, sim.time);
                }
                before.laneId = car.laneId; before.mode = car.mode; before.s = car.s;
                if (car.state === 'blocked') blocked++;
            }
            if (tick % 250 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        expect(blocked).toBe(0);
        expect(sim.cars.map(car => car.id)).toEqual(original);
        // A reserved physical junction can span several mapped signal phases.
        // Follow any long queue to its release instead of mistaking its red-light
        // snapshot for a deadlock. The same vehicle must actually move, without reset.
        const queued = new Map(sim.cars.filter(car => sim.time - lastMoved.get(car.id) > 120)
            .map(car => [car.id, sim.pose(car)]));
        for (let tick = 0; queued.size && tick < 1200; tick++) {
            sim.advance(.1);
            for (const car of sim.cars) {
                const before = queued.get(car.id);
                if (before && Math.hypot(sim.pose(car).x - before.x, sim.pose(car).y - before.y) > 2) queued.delete(car.id);
                if (car.state === 'blocked') blocked++;
            }
            if (tick % 250 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        expect([...queued.keys()]).toEqual([]);
        expect(blocked).toBe(0);
        expect(sim.cars.map(car => car.id)).toEqual(original);
        expect(sim.crossings).toBeGreaterThan(10000);
    }, 180000);

    it('never leaves its allowed graph, enters on red, or overlaps a queue during an animated run', () => {
        const network = Traffic.createNetwork(data);
        const sim = new Traffic.Simulation(network, { count: 220, seed: 97 });
        const originalCars = sim.cars.map(car => car.id);
        const violations = [];
        let entries = 0;
        for (let tick = 0; tick < 650; tick++) {
            const before = new Map(sim.cars.map(car => [car.id, {
                mode: car.mode, laneId: car.laneId, s: car.s, connectionId: car.connectionId, changeTo: car.change?.to
            }]));
            sim.advance(.1);
            const crossingByNode = new Map();
            for (const car of sim.cars) {
                const previous = before.get(car.id);
                const pose = sim.pose(car);
                if (![car.s, pose.x, pose.y, pose.angle].every(Number.isFinite)) violations.push('nonfinite position');
                if (previous?.mode === 'connection' && car.mode === 'lane' && !car.traversed?.length) {
                    if (network.connections.get(previous.connectionId).toLaneId !== car.laneId) violations.push('wrong receiving lane');
                }
                if (previous?.mode === 'lane' && car.mode === 'lane' && previous.laneId !== car.laneId
                    && !car.traversed?.length && (previous.changeTo !== car.laneId || !Traffic.laneChangeAllowed(
                        network.lanes.get(previous.laneId), network.lanes.get(car.laneId)))) violations.push('illegal lane change');
                let expectedLaneId = previous?.mode === 'connection'
                    ? network.connections.get(previous.connectionId)?.toLaneId : previous?.laneId;
                for (const connectionId of car.traversed || []) {
                    entries++;
                    const connection = network.connections.get(connectionId);
                    const lane = connection && network.lanes.get(connection.fromLaneId);
                    if (!connection || !lane || connection.fromLaneId !== expectedLaneId
                        || !lane.outgoing.includes(connectionId)) {
                        violations.push('broken traversed connection chain');
                        break;
                    }
                    if (Traffic.signalState(network, lane, sim.time, true, lane.path.length) !== 'green') violations.push('red entry');
                    expectedLaneId = connection.toLaneId;
                }
                if (previous?.mode === 'lane' && car.mode === 'lane' && previous.laneId === car.laneId) {
                    for (const control of network.lanes.get(car.laneId).signals) {
                        if (previous.s <= control.stopS + 1e-6 && car.s > control.stopS + 1e-6
                            && Traffic.signalAspect(network.signals.get(control.signalId), control.phase, sim.time) !== 'green') {
                            violations.push('passed mapped stop position on red');
                        }
                    }
                }
                if (car.mode === 'connection') {
                    const nodeId = network.connections.get(car.connectionId).nodeId;
                    if (network.nodes.get(nodeId).degree >= 3) crossingByNode.set(nodeId, (crossingByNode.get(nodeId) || 0) + 1);
                }
            }
            const bodies = new Collision.Index();
            for (const car of sim.cars) bodies.set(car.id, sim.pose(car));
            const checkedPairs = new Set();
            for (const car of sim.cars) {
                const pose = bodies.positions.get(car.id);
                for (const otherId of bodies.nearby(pose)) {
                    if (otherId === car.id) continue;
                    const pair = car.id < otherId ? `${car.id}:${otherId}` : `${otherId}:${car.id}`;
                    if (checkedPairs.has(pair)) continue;
                    checkedPairs.add(pair);
                    if (Collision.overlaps(pose, bodies.positions.get(otherId))) violations.push('vehicle footprint collision');
                }
            }
            if ([...crossingByNode.values()].some(count => count > 1)) violations.push('conflicting crossings');
            for (const [id, occupants] of sim.occupants()) {
                if (!network.lanes.has(id)) continue;
                const ordered = occupants.filter(item => item.s >= 0).sort((a, b) => a.s - b.s);
                for (let i = 1; i < ordered.length; i++) {
                    if (ordered[i].car.id !== ordered[i - 1].car.id && ordered[i].s - ordered[i - 1].s < Traffic.GAP - .01) violations.push('queue overlap');
                }
            }
            if (violations.length) break;
        }
        expect(violations).toEqual([]);
        expect(sim.cars.map(car => car.id)).toEqual(originalCars);
        expect(entries).toBeGreaterThan(200);
        expect(sim.crossings).toBeGreaterThan(40);
    }, 15000);
});
