// Input and metre movement invariants for pointer-independent geometry editing.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
const require = createRequire(import.meta.url);
const coordinates = require('../../frontend/js/geometry-edit/coordinates.js');

describe('geometry coordinate input', () => {
    it('rejects empty, missing, nonfinite and out-of-world values without turning them into zero', () => {
        for (const value of ['', ' ', null, undefined, 'NaN', Infinity]) {
            expect(coordinates.parse(value, 51)).toBeNull();
            expect(coordinates.parse(-0.1, value)).toBeNull();
        }
        expect(coordinates.parse('181', '0')).toBeNull();
        expect(coordinates.parse('0', '-91')).toBeNull();
        expect(coordinates.parse('0', '0')).toEqual([0, 0]);
        expect(coordinates.parse('-0.1', '51.5')).toEqual([-0.1, 51.5]);
    });
    it('moves by the selected metre distance in each compass direction', () => {
        const point = [-0.1, 51.5], original = point.slice();
        for (const direction of ['north', 'south', 'east', 'west']) {
            const next = coordinates.nudge(point, direction, 2.5, turf);
            expect(turf.distance(point, next, { units: 'meters' })).toBeCloseTo(2.5, 5);
            if (direction === 'north') expect(next[1]).toBeGreaterThan(point[1]);
            if (direction === 'south') expect(next[1]).toBeLessThan(point[1]);
            if (direction === 'east') expect(next[0]).toBeGreaterThan(point[0]);
            if (direction === 'west') expect(next[0]).toBeLessThan(point[0]);
        }
        expect(point).toEqual(original);
        for (const distance of [0, -1, NaN, Infinity, 1001]) expect(coordinates.nudge(point, 'north', distance, turf)).toBeNull();
        expect(coordinates.nudge(point, 'unknown', 1, turf)).toBeNull();
    });
    it('translates every point equally while preserving ring closure and the source', () => {
        const ring = [[-.1, 51.5], [-.09, 51.5], [-.09, 51.51], [-.1, 51.5]], before = structuredClone(ring);
        const moved = coordinates.translate(ring, [-.1, 51.5], [-.099, 51.501]);
        moved.forEach((point, i) => { expect(point[0] - ring[i][0]).toBeCloseTo(.001, 8); expect(point[1] - ring[i][1]).toBeCloseTo(.001, 8); });
        expect(moved[0]).toEqual(moved.at(-1));
        expect(ring).toEqual(before);
        expect(coordinates.translate([[179, 0], [180, 0]], [179, 0], [180, 0])).toBeNull();
    });
});
