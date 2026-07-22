// Unit tests for frontend/js/square-shape.js — the plaza-vs-paving compactness check that drives the
// square editor's "this is not a square" warning. turf is set on the global in THIS realm so its
// internal instanceof checks hold across the boundary.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

globalThis.turf = turf;

const require = createRequire(import.meta.url);
const { assessSquareShape } = require('../../frontend/js/square-shape.js');

// A rectangle in degrees around Zagreb; widthDeg × heightDeg. ~0.0009° ≈ 100 m.
function rect(widthDeg, heightDeg, west = 15.97, south = 45.81) {
    return turf.polygon([[
        [west, south],
        [west + widthDeg, south],
        [west + widthDeg, south + heightDeg],
        [west, south + heightDeg],
        [west, south]
    ]]);
}

describe('assessSquareShape', () => {
    it('treats a roughly square plaza as a square', () => {
        const result = assessSquareShape(rect(0.0009, 0.0009));
        expect(result.isSquareLike).toBe(true);
        // A square's Polsby–Popper compactness is ~0.785.
        expect(result.compactness).toBeGreaterThan(0.7);
    });

    it('flags a long thin paved strip as NOT a square', () => {
        const result = assessSquareShape(rect(0.006, 0.0006)); // ~10:1
        expect(result.isSquareLike).toBe(false);
        expect(result.compactness).toBeLessThan(0.5);
    });

    it('accepts a mild 2:1 plaza but rejects a 6:1 ribbon', () => {
        expect(assessSquareShape(rect(0.0018, 0.0009)).isSquareLike).toBe(true);
        expect(assessSquareShape(rect(0.0054, 0.0009)).isSquareLike).toBe(false);
    });

    it('honours a custom compactness threshold', () => {
        const shape = rect(0.0018, 0.0009); // ~2:1, compactness ~0.7
        expect(assessSquareShape(shape, { minCompactness: 0.9 }).isSquareLike).toBe(false);
    });

    it('returns null for geometry it cannot assess', () => {
        expect(assessSquareShape(null)).toBeNull();
        expect(assessSquareShape({ type: 'Point', coordinates: [15.97, 45.81] })).toBeNull();
    });

    it('reads a MultiPolygon via its largest part', () => {
        const mp = turf.multiPolygon([
            rect(0.0009, 0.0009).geometry.coordinates,
            rect(0.00005, 0.00005, 16.0, 45.9).geometry.coordinates
        ]);
        expect(assessSquareShape(mp).isSquareLike).toBe(true);
    });
});
