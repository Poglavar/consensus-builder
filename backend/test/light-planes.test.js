// Light planes (frontend/js/planning/light-planes.js): a massing under or through a plane rising from a
// base, the angle by compass direction, intervening buildings that raise the line, and kept volume.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../../frontend/js/planning/light-planes.js');

const rect = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
// A base line along y = 0 from x = -20 to 30, sampled every metre.
const line = Array.from({ length: 51 }, (_, i) => [i - 20, 0]);
const box = (polygons, height, exemptBelowM = 0) => ({ polygons, topAt: () => height, exemptBelowM });

describe('light planes', () => {
    it('passes a building under a 20° plane and fails one that pierces it, by the nearest edge', () => {
        const plane = { base: line, baseHeightM: 0, angle: 20, raisers: [] };
        // 10 m away the plane stands 10·tan20° = 3.64 m high.
        expect(P.check(plane, box([rect(0, 10, 6, 16)], 3.5)).status).toBe('clear');
        const through = P.check(plane, box([rect(0, 10, 6, 16)], 4));
        expect(through.status).toBe('pierced');
        expect(through.clearM).toBeCloseTo(3.64 - 4, 1);
        expect(through.at[1]).toBeCloseTo(10, 5);
    });
    it('lets an intervening building raise the line until it clears its top (Create Mews 26a)', () => {
        const front = P.raiser([rect(-20, 2, 30, 8)], 9);
        const plane = { base: line, baseHeightM: 0, angle: 20, raisers: [front] };
        // Raised to touch the front house's top at its near edge (2 m): 9 + (20 − 2)·tan20° ≈ 15.55 m at 20 m.
        expect(P.check(plane, box([rect(0, 20, 6, 26)], 15)).status).toBe('clear');
        expect(P.check(plane, box([rect(0, 20, 6, 26)], 16)).status).toBe('pierced');
        expect(P.check({ ...plane, raisers: [] }, box([rect(0, 20, 6, 26)], 8)).status).toBe('pierced');
    });
    it('reads the angle by compass direction (Strong Suburbs 35.1)', () => {
        const angle = { northOfEastWest: 45, fromSouth: { base: 35, perDegree: 1 / 9 } };
        expect(P.degreesFor(angle, 0, 1)).toBe(45);
        expect(P.degreesFor(angle, 0, -1)).toBeCloseTo(35, 6);
        expect(P.degreesFor(angle, 1, 0)).toBeCloseTo(45, 6);
        expect(P.degreesFor(angle, 1, -1)).toBeCloseTo(40, 6);
        // A building 10 m south of the boundary: lines run due south at 35°, 7.0 m high there.
        const south = Array.from({ length: 51 }, (_, i) => [i - 20, 0]);
        const plane = { base: south, baseHeightM: 0, angle, raisers: [] };
        expect(P.check(plane, box([rect(0, -16, 6, -10)], 6.9)).status).toBe('clear');
        expect(P.check(plane, box([rect(0, -16, 6, -10)], 7.2)).status).toBe('pierced');
        // The same building north of the boundary gets 45°: 10 m high there.
        expect(P.check(plane, box([rect(0, 10, 6, 16)], 9.5)).status).toBe('clear');
    });
    it('never counts an existing building\'s kept volume, and is unknown when that height is unknown', () => {
        const plane = { base: line, baseHeightM: 0, angle: 70, raisers: [] };
        // At the boundary a 70° plane is 0 m high: a 7 m house standing there keeps its volume.
        expect(P.check(plane, box([rect(0, 0, 6, 6)], 7, 7)).status).toBe('clear');
        expect(P.check(plane, box([rect(0, 0, 6, 6)], 10, 7)).status).toBe('pierced');
        expect(P.check(plane, box([rect(0, 0, 6, 6)], 10, null)).status).toBe('unknown');
        expect(P.check(plane, { polygons: [rect(0, 0, 6, 6)], topAt: () => null, exemptBelowM: 0 }).status).toBe('unknown');
    });
    it('finds a block\'s outer edge: boundaries its plots do not share', () => {
        const plots = [{ polygons: [rect(0, 0, 10, 20)] }, { polygons: [rect(10, 0, 20, 20)] }];
        const edge = P.outerEdge(plots);
        expect(edge.some(([x, y]) => x === 10 && y > 1 && y < 19)).toBe(false);
        expect(edge.some(([x]) => x === 0)).toBe(true);
        expect(P.standsOn(plots[0].polygons, [rect(2, 2, 8, 8)])).toBe(true);
        expect(P.standsOn(plots[1].polygons, [rect(2, 2, 8, 8)])).toBe(false);
        expect(P.apart([rect(2, 2, 8, 8)], [rect(10, 0, 20, 20)])).toBeCloseTo(2, 6);
    });
});
