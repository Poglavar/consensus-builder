// Exercises the shipped, compressed Zagreb graph and audits actual movements over many steps.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Traffic = require('../../frontend/traffic/simulation.js');
const data = JSON.parse(gunzipSync(readFileSync(new URL('../../frontend/traffic/data/central.json.gz', import.meta.url))));

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

    it('keeps every default car progressing through a twenty-minute run', () => {
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
        }
        expect(blocked).toBe(0);
        expect(sim.cars.map(car => car.id)).toEqual(original);
        expect(sim.cars.filter(car => sim.time - lastMoved.get(car.id) > 120).map(car => car.id)).toEqual([]);
        expect(sim.crossings).toBeGreaterThan(10000);
    }, 60000);

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
                if (previous?.mode === 'lane' && car.mode === 'connection') {
                    entries++;
                    const connection = network.connections.get(car.connectionId);
                    const lane = network.lanes.get(previous.laneId);
                    if (connection.fromLaneId !== lane.id || !lane.outgoing.includes(connection.id)) violations.push('invented exit');
                    if (Traffic.signalState(network, lane, sim.time, true) !== 'green') violations.push('red entry');
                }
                if (previous?.mode === 'connection' && car.mode === 'lane') {
                    if (network.connections.get(previous.connectionId).toLaneId !== car.laneId) violations.push('wrong receiving lane');
                }
                if (previous?.mode === 'lane' && car.mode === 'lane' && previous.laneId !== car.laneId) {
                    if (previous.changeTo !== car.laneId || !Traffic.laneChangeAllowed(
                        network.lanes.get(previous.laneId), network.lanes.get(car.laneId))) violations.push('illegal lane change');
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
        expect(sim.laneChanges).toBeGreaterThan(0);
    }, 15000);
});
