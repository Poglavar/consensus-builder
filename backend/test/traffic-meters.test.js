import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const G = require('../../frontend/traffic/geometry.js');
const { LaneIndex, profile, Counters } = require('../../frontend/traffic/meters.js');
const { createNetwork, Simulation } = require('../../frontend/traffic/simulation.js');

function fixture() {
    const lanes = new Map();
    for (const [id, y, angle, ordinal, sectionId, name] of [
        ['e0', -3, 0, 0, 'east', 'Avenue'], ['e1', -6, 0, 1, 'east', 'Avenue'],
        ['w0', 3, Math.PI, 0, 'west', 'Avenue'], ['w1', 6, Math.PI, 1, 'west', 'Avenue'],
        ['other', 20, 0, 0, 'other', 'Side street']
    ]) lanes.set(id, { id, width: 3, ordinal, sectionId, name, highway: 'primary',
        path: G.path(angle ? [[100, y], [0, y]] : [[0, y], [100, y]]) });
    return new LaneIndex({ lanes });
}
function movingLanesNetwork() {
    const origin = [15.98, 45.81], xScale = 111320 * Math.cos(origin[1] * Math.PI / 180);
    const geo = ([x, y]) => [origin[0] + x / xScale, origin[1] + y / 111320];
    const specs = [
        ['east-0', 'west-a', 'east-a', -3, true, 0], ['east-1', 'west-b', 'east-b', -6, true, 1],
        ['west-0', 'east-c', 'west-c', 3, false, 0], ['west-1', 'east-d', 'west-d', 6, false, 1]
    ];
    const lanes = specs.map(([id, fromNode, toNode, y, east, ordinal]) => ({
        id, fromNode, toNode, sectionId: east ? 'eastbound' : 'westbound', sourceWayId: 'test-way',
        direction: east ? 'forward' : 'backward', type: 'driving', access: 'yes', highway: 'primary',
        name: 'Test Avenue', stripIndex: 0, ordinal, change: 'no', maxSpeed: 36,
        points: (east ? [[0, y], [100, y]] : [[100, y], [0, y]]).map(geo)
    }));
    const nodes = [...new Set(lanes.flatMap(lane => [lane.fromNode, lane.toNode]))].map(id => ({ id, degree: 2 }));
    return createNetwork({ bbox: [15.97, 45.8, 15.99, 45.82], nodes, lanes, connections: [], signals: [] });
}
describe('road flow meters', () => {
    it('snaps perpendicular to the whole named road including its opposite carriageway', () => {
        const index = fixture(), hit = index.hit([50, -6]);
        expect(hit.lane.id).toBe('e1');
        const shape = profile(index, hit);
        expect(shape.lanes.map(l => l.laneId)).toEqual(['e1', 'e0', 'w0', 'w1']);
        expect(shape.lanes.map(l => l.direction)).toEqual(['E', 'E', 'W', 'W']);
        expect(shape.center).toEqual([50, 0]);
        expect(shape.ends[0][0]).toBeCloseTo(shape.ends[1][0]);
        expect(index.hit([50, 50])).toBeNull();
    });
    it('keeps adjacent diagonal lanes at 44 and 46 degrees in the same flow direction', () => {
        const angle = 44 * Math.PI / 180, tangent = [Math.cos(angle), Math.sin(angle)];
        const normal = [-tangent[1], tangent[0]], makeLane = (id, heading, offset, sectionId) => {
            const direction = [Math.cos(heading), Math.sin(heading)];
            const center = [normal[0] * offset, normal[1] * offset];
            return { id, width: 3, ordinal: 0, sectionId, name: 'Diagonal Avenue', highway: 'primary',
                path: G.path([[center[0] - direction[0] * 60, center[1] - direction[1] * 60],
                    [center[0] + direction[0] * 60, center[1] + direction[1] * 60]]) };
        };
        const index = new LaneIndex({ lanes: new Map([
            ['main', makeLane('main', angle, 0, 'main')],
            ['adjacent-44', makeLane('adjacent-44', 44 * Math.PI / 180, 4, 'adjacent-a')],
            ['adjacent-46', makeLane('adjacent-46', 46 * Math.PI / 180, -4, 'adjacent-b')]
        ]) });
        const shape = profile(index, index.hit([0, 0]));

        expect(shape.lanes.map(lane => lane.laneId)).toEqual(['adjacent-46', 'main', 'adjacent-44']);
        expect(shape.lanes.map(lane => lane.direction)).toEqual(['E', 'E', 'E']);
        expect(shape.lanes.find(lane => lane.laneId === 'adjacent-46').angle).toBeCloseTo(46 * Math.PI / 180);
    });
    it('counts every crossed lane by actual direction, including movement that skips the line', () => {
        const index = fixture(), counters = new Counters(), meter = counters.add(profile(index, index.hit([50, -6])), 0);
        counters.observe({ id: 1 }, { x: 40, y: -6 }, { x: 60, y: -6 }, 5);
        counters.observe({ id: 2 }, { x: 60, y: 3 }, { x: 40, y: 3 }, 6);
        counters.observe({ id: 3 }, { x: 60, y: -3 }, { x: 40, y: -3 }, 7); // wrong-way movement
        counters.observe({ id: 4 }, { x: 40, y: 20 }, { x: 60, y: 20 }, 7); // another road
        expect([...meter.counts.values()]).toEqual([1, 0, 1, 0]);
        expect(counters.rows(meter, 30).map(r => r.rate)).toEqual([2, 0, 2, 0]);
        expect(counters.directions(meter).map(({ direction, count }) => [direction, count])).toEqual([['E', 1], ['W', 1]]);
    });
    it('counts live crossings from every lane in a directed simulation and aggregates both directions', () => {
        const network = movingLanesNetwork(), simulation = new Simulation(network, { count: 0, signals: false });
        const index = new LaneIndex(network), hit = index.hit([50, -6]);
        const counters = new Counters(), meter = counters.add(profile(index, hit), 0);
        simulation.listeners.add((car, before, after, time) => counters.observe(car, before, after, time));
        for (const [id, laneId, s] of [['east-0-car', 'east-0', 45], ['east-1-car', 'east-1', 45],
            ['west-0-car', 'west-0', 45], ['west-1-car', 'west-1', 45]]) {
            simulation.cars.push({ id, laneId, mode: 'lane', s, speed: 8, cruise: 8, color: 0, next: null,
                state: 'driving', change: null, stoppedFor: 0, cooldown: Infinity, clearance: null });
        }
        for (let step = 0; step < 30; step++) simulation.step();

        expect([...meter.counts.values()]).toEqual([1, 1, 1, 1]);
        expect(counters.directions(meter).map(({ direction, count }) => [direction, count])).toEqual([['E', 2], ['W', 2]]);
        expect(counters.rows(meter, simulation.time).every(row => row.rate >= 0 && Number.isFinite(row.rate))).toBe(true);
    });
    it('does not count stopping, exact-line duplicates or immediate oscillation twice', () => {
        const index = fixture(), counters = new Counters(), meter = counters.add(profile(index, index.hit([50, -6])), 0), car = { id: 1 };
        const p = x => ({ x, y: -6 });
        counters.observe(car, p(49), p(50), 1); counters.observe(car, p(50), p(50), 2);
        counters.observe(car, p(50), p(51), 3); counters.observe(car, p(49.9), p(50.1), 3.5);
        expect(meter.counts.get('e1')).toBe(1);
        counters.observe(car, p(49), p(51), 20); // a later circuit is counted again
        expect(meter.counts.get('e1')).toBe(2);
    });
    it('keeps totals across intervention baselines, expires the rate window, and resets only on request', () => {
        const index = fixture(), counters = new Counters(), meter = counters.add(profile(index, index.hit([50, -6])), 0);
        counters.observe({ id: 1 }, { x: 49, y: -6 }, { x: 51, y: -6 }, 5);
        counters.markIntervention(30);
        expect(meter.baseline.rates[0].rate).toBe(2);
        expect(meter.baseline.duration).toBe(30);
        expect(counters.rows(meter, 70)[0]).toMatchObject({ count: 1, rate: 0 });
        expect(meter.baseline.rates[0].rate).toBe(2);
        counters.reset(meter.id, 70);
        expect(meter.counts.get('e1')).toBe(0); expect(meter.baseline).toBeNull();
        counters.remove(meter.id); expect(counters.meters).toEqual([]);
    });
});
