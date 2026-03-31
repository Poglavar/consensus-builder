import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeBoundsFromRings } from './helpers.js';

describe('computeBoundsFromRings', () => {
    test('should return null for empty rings array', () => {
        assert.strictEqual(computeBoundsFromRings([]), null);
    });

    test('should return null for array with empty rings', () => {
        // Current implementation might return Infinity if not handled
        const result = computeBoundsFromRings([[]]);
        assert.strictEqual(result, null);
    });

    test('should compute bounds for a single ring', () => {
        const rings = [[[0, 0], [10, 10], [0, 10], [0, 0]]];
        const expected = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
        assert.deepStrictEqual(computeBoundsFromRings(rings), expected);
    });

    test('should compute bounds for multiple rings', () => {
        const rings = [
            [[0, 0], [5, 5]],
            [[10, 10], [15, 15]]
        ];
        const expected = { minX: 0, minY: 0, maxX: 15, maxY: 15 };
        assert.deepStrictEqual(computeBoundsFromRings(rings), expected);
    });

    test('should handle negative coordinates', () => {
        const rings = [[[-10, -20], [5, 5]]];
        const expected = { minX: -10, minY: -20, maxX: 5, maxY: 5 };
        assert.deepStrictEqual(computeBoundsFromRings(rings), expected);
    });

    test('should handle identical coordinates', () => {
        const rings = [[[5, 5], [5, 5]]];
        const expected = { minX: 5, minY: 5, maxX: 5, maxY: 5 };
        assert.deepStrictEqual(computeBoundsFromRings(rings), expected);
    });

    test('should return null for rings with only empty arrays', () => {
        const result = computeBoundsFromRings([[], []]);
        assert.strictEqual(result, null);
    });
});
