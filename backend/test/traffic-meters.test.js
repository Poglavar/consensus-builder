import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const G = require('../../frontend/traffic/geometry.js');
const { LaneIndex, profile, Counters } = require('../../frontend/traffic/meters.js');

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
    it('counts every crossed lane by actual direction, including movement that skips the line', () => {
        const index = fixture(), counters = new Counters(), meter = counters.add(profile(index, index.hit([50, -6])), 0);
        counters.observe({ id: 1 }, { x: 40, y: -6 }, { x: 60, y: -6 }, 5);
        counters.observe({ id: 2 }, { x: 60, y: 3 }, { x: 40, y: 3 }, 6);
        counters.observe({ id: 3 }, { x: 60, y: -3 }, { x: 40, y: -3 }, 7); // wrong-way movement
        counters.observe({ id: 4 }, { x: 40, y: 20 }, { x: 60, y: 20 }, 7); // another road
        expect([...meter.counts.values()]).toEqual([1, 0, 1, 0]);
        expect(counters.rows(meter, 30).map(r => r.rate)).toEqual([2, 0, 2, 0]);
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
