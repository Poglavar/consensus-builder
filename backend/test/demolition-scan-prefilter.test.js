// "Applying proposal Block …" ran for 35 s after the blocks were already on screen, and the same
// step cost 23 ms early in the replay and 241 ms late. Nothing about the proposals changed between
// those two moments — what changed was how much of the city had loaded.
//
// findBuildingTunnelIntersections asked a full polygon intersection of the proposal's footprint
// against EVERY loaded building, so its cost was the size of the pool rather than the size of the
// proposal. A proposal touches a handful of buildings; nearly every pair is disjoint, and a
// disjoint pair is the most expensive kind to establish that way.
//
// These tests assert the ANSWER is unchanged and the WORK is not — a prefilter that quietly dropped
// a real hit would be far worse than the slowness it cures.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
globalThis.turf = turf;
globalThis.window = globalThis.window || globalThis;
const tunnel = require('../../frontend/js/corridor-tunnel.js');
const find = tunnel.findBuildingTunnelIntersections
    || (globalThis.window.__corridorTunnel && globalThis.window.__corridorTunnel.findBuildingTunnelIntersections);

/** A square building of `side` metres (approx) with its lower-left corner at lng/lat. */
function box(lng, lat, side = 0.0002, props = {}) {
    return turf.polygon([[
        [lng, lat], [lng + side, lat], [lng + side, lat + side], [lng, lat + side], [lng, lat]
    ]], props);
}

describe('the demolition scan asks the box before it clips', () => {
    it('is reachable — otherwise everything below is vacuously true', () => {
        expect(typeof find).toBe('function');
    });

    it('finds a building the footprint actually covers', () => {
        const footprint = box(15.87, 43.75, 0.0006);
        const hits = find(footprint, [box(15.8702, 43.7502)], turf);
        expect(hits).toHaveLength(1);
        expect(hits[0].area).toBeGreaterThan(2);
    });

    it('finds every overlapping building, not just the first', () => {
        const footprint = box(15.87, 43.75, 0.0010);
        const buildings = [box(15.8701, 43.7501), box(15.8704, 43.7504), box(15.8707, 43.7507)];
        expect(find(footprint, buildings, turf)).toHaveLength(3);
    });

    it('is not fooled by a building whose BOX overlaps but whose shape does not', () => {
        // The prefilter may only reject; anything it lets through still faces the real clip. An
        // L-shape and a square can share a bounding box and touch nowhere.
        const footprint = turf.polygon([[
            [15.870, 43.750], [15.8710, 43.750], [15.8710, 43.7502], [15.8702, 43.7502],
            [15.8702, 43.7510], [15.870, 43.7510], [15.870, 43.750]
        ]]);
        const inTheNotch = box(15.8704, 43.7504, 0.0004);
        expect(find(footprint, [inTheNotch], turf)).toHaveLength(0);
    });

    it('ignores a building nowhere near it', () => {
        expect(find(box(15.87, 43.75, 0.0006), [box(15.89, 43.77)], turf)).toHaveLength(0);
    });

    it('still honours the 2 m² floor rather than reporting a graze', () => {
        // A building clipped by less than the record-writing threshold must not become a hit, or it
        // prompts for a demolition that never gets recorded.
        const footprint = turf.polygon([[
            [15.870, 43.750], [15.87001, 43.750], [15.87001, 43.7510], [15.870, 43.7510], [15.870, 43.750]
        ]]);
        const grazed = box(15.870005, 43.7505, 0.0004);
        const hits = find(footprint, [grazed], turf);
        hits.forEach(hit => expect(hit.area).toBeGreaterThanOrEqual(2));
    });

    it('gives the SAME answer whether the pool is 3 buildings or 3,000', () => {
        // The point of the change: the answer depends on the proposal, the cost should too.
        const footprint = box(15.87, 43.75, 0.0010);
        const real = [box(15.8701, 43.7501), box(15.8704, 43.7504)];
        const faraway = Array.from({ length: 3000 }, (_, i) =>
            box(15.90 + (i % 60) * 0.0003, 43.80 + Math.floor(i / 60) * 0.0003));

        const small = find(footprint, real, turf).map(h => h.id).sort();
        const huge = find(footprint, real.concat(faraway), turf).map(h => h.id).sort();
        expect(huge).toEqual(small);
    });

    it('rejects a building it cannot touch for about the price of reading its box', () => {
        // A ratio, not a clock: an absolute millisecond threshold is only ever right on the machine
        // it was tuned on, and a contended laptop inflates every reading together.
        //
        // Both sides here do the same amount of work over the SAME 3,000 buildings, so the ratio is
        // stable in a way that comparing 2 buildings against 3,000 is not — that version measured
        // mostly fixed overhead in its denominator and failed one run in three.
        //
        // The claim under test: rejecting a disjoint building should cost roughly what reading its
        // bounding box costs, not what clipping it costs.
        const footprint = box(15.87, 43.75, 0.0010);
        const faraway = Array.from({ length: 3000 }, (_, i) =>
            box(15.90 + (i % 60) * 0.0003, 43.80 + Math.floor(i / 60) * 0.0003));

        const time = (run) => {
            run(); run();                                    // warm the JIT on both paths
            const started = process.hrtime.bigint();
            for (let i = 0; i < 5; i += 1) run();
            return Math.max(Number(process.hrtime.bigint() - started) / 1e6, 0.01);
        };
        const bboxMs = time(() => faraway.forEach(f => turf.bbox(f)));
        const scanMs = time(() => find(footprint, faraway, turf));

        // Measured on these five-vertex squares: with the prefilter ~2-4x the bbox cost; without
        // it, ~20x and upwards. Real footprints carry more vertices, which widens the gap rather
        // than narrowing it. 8 sits between the two with room on both sides.
        expect(scanMs / bboxMs).toBeLessThan(8);
    });
});

describe('a region of many parts is clipped part by part', () => {
    // Six squares in a row as one MultiPolygon (a plan handed over whole). A building is clipped
    // against the parts whose boxes it touches only — exact, since a part whose box misses the
    // building cannot contribute — instead of against all six at once for every building nearby.
    const parts = [0, 1, 2, 3, 4, 5].map(i => box(15.870 + i * 0.001, 43.75, 0.0006).geometry.coordinates);
    const region = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: parts } };
    const counting = () => {
        const calls = [];
        return { calls, api: { ...turf, intersect: (a, b) => { calls.push(a.geometry.type === 'MultiPolygon' ? a.geometry.coordinates.length : 1); return turf.intersect(a, b); } } };
    };

    it('gives the same answer as clipping the whole region, with far less work', () => {
        const inThird = box(15.8722, 43.7502);              // inside part 3
        const inTheGap = box(15.8707, 43.7502);             // between parts 1 and 2: inside the region box, touching no part
        const farAway = box(15.9, 43.8);
        const { calls, api } = counting();
        const hits = find(region, [inThird, inTheGap, farAway], api);
        expect(hits).toHaveLength(1);
        expect(hits[0].area).toBeCloseTo(turf.area(inThird), 0);
        expect(calls).toEqual([1]);                          // one clip, against one part
        const whole = find({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: parts[2] } }, [inThird], turf);
        expect(hits[0].area).toBeCloseTo(whole[0].area, 6);
    });

    it('clips a building straddling two parts against both', () => {
        const straddling = box(15.8705, 43.7502, 0.0008);    // from part 1 into part 2
        const { calls, api } = counting();
        const hits = find(region, [straddling], api);
        expect(hits).toHaveLength(1);
        expect(calls).toEqual([2]);
        const both = turf.area(turf.intersect(region, straddling));
        expect(hits[0].area).toBeCloseTo(both, 6);
    });
});
