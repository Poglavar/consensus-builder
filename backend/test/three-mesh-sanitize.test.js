// Unit tests for the city-model face sanitizer that prevents duplicate surfaces from z-fighting.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    cleanRing,
    polygonArea3D,
    prepareFaceRings,
    appendUniqueTriangle
} = require('../../frontend/js/three-mesh-sanitize.js');

describe('three mesh sanitation', () => {
    it('collapses closing/repeated vertices and rejects a degenerate face', () => {
        const lineFace = [
            [0, 0, 0],
            [10, 0, 0],
            [10, 0, 0],
            [0, 0, 0],
            [0, 0, 0]
        ];
        expect(cleanRing(lineFace)).toEqual([[0, 0, 0], [10, 0, 0]]);
        expect(prepareFaceRings([lineFace])).toBeNull();
    });

    it('treats opposite windings of the same surface as one face', () => {
        const front = [[0, 0, 0], [10, 0, 0], [10, 0, 5], [0, 0, 5], [0, 0, 0]];
        const back = [...front.slice(0, -1)].reverse();
        back.push(back[0]);
        const seenFaceKeys = new Set();

        expect(prepareFaceRings([front], { seenFaceKeys })).not.toBeNull();
        expect(prepareFaceRings([back], { seenFaceKeys })).toBeNull();
        expect(seenFaceKeys.size).toBe(1);
    });

    it('keeps parallel surfaces separated by more than the mesh tolerance', () => {
        const low = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
        const high = low.map(([x, y]) => [x, y, 0.05]);
        const seenFaceKeys = new Set();

        expect(prepareFaceRings([low], { seenFaceKeys })).not.toBeNull();
        expect(prepareFaceRings([high], { seenFaceKeys })).not.toBeNull();
        expect(seenFaceKeys.size).toBe(2);
    });

    it('deduplicates triangles independent of winding and drops zero-area output', () => {
        const triangle = [[0, 0, 0], [5, 0, 0], [0, 5, 0]];
        const positions = [];
        const seenTriangleKeys = new Set();

        expect(appendUniqueTriangle(positions, triangle, { seenTriangleKeys })).toBe(true);
        expect(appendUniqueTriangle(positions, [...triangle].reverse(), { seenTriangleKeys })).toBe(false);
        expect(appendUniqueTriangle(positions, [[0, 0, 0], [1, 0, 0], [2, 0, 0]], { seenTriangleKeys })).toBe(false);
        expect(positions).toHaveLength(9);
        expect(polygonArea3D(triangle)).toBeCloseTo(12.5);
    });
});
