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

    it('never leaves its allowed graph, enters on red, or overlaps a queue during an animated run', () => {
        const network = Traffic.createNetwork(data);
        const sim = new Traffic.Simulation(network, { count: 220, seed: 97 });
        const violations = [];
        let entries = 0;
        for (let tick = 0; tick < 650; tick++) {
            const before = new Map(sim.cars.map(car => [car.id, {
                mode: car.mode, laneId: car.laneId, connectionId: car.connectionId, changeTo: car.change?.to
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
        expect(entries).toBeGreaterThan(200);
        expect(sim.crossings).toBeGreaterThan(40);
        expect(sim.laneChanges).toBeGreaterThan(0);
    }, 15000);
});
