// Unit tests for the city-model face sanitizer that prevents duplicate surfaces from z-fighting.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {
    cleanRing,
    polygonArea3D,
    hasRenderableArea,
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

describe('clipped footprint extrusion', () => {
    const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
    const start = source.indexOf('    function arrayOfLngLatRingsToShape(');
    const end = source.indexOf('    function polygonFeatureToMeshes(', start);
    class Vector2 {
        constructor(x, y) { this.x = x; this.y = y; }
    }
    class Shape {
        constructor(points) { this.points = points; this.holes = []; }
    }
    const makeShape = vm.runInNewContext(source.slice(start, end) + '\narrayOfLngLatRingsToShape', {
        THREE: { Vector2, Shape, Path: Shape },
        coordsToXY: point => point,
        meshSanitize: { hasRenderableArea },
        window: {}
    });

    it('rejects a bent microscopic remainder even after consecutive vertices are cleaned', () => {
        // A parcel cut doubles back around a corner; its span and area alone look valid.
        const ribbon = [[0, 0], [0, 40], [6, 40], [0.00003, 40], [0.00003, 0], [0, 0]];
        expect(polygonArea3D(ribbon.map(([x, y]) => [x, y, 0]))).toBeGreaterThan(0.0001);
        expect(makeShape([ribbon])).toBeNull();
        expect(makeShape([[...ribbon].reverse()])).toBeNull();
        expect(makeShape([ribbon.map(([x, y]) => [x + 200, y - 300])])).toBeNull();
    });

    it('rejects both real rounding strips from the tower parcel cut', () => {
        const strips = [
            [[-1.880435910357619, 52.47959022860053], [-1.8803498522884183, 52.47929223390292],
                [-1.880293697652809, 52.47929827949319], [-1.880349852, 52.479292234],
                [-1.880435909898898, 52.47959022864991], [-1.880435910357619, 52.47959022860053]],
            [[-1.8801583443015117, 52.479479021626574], [-1.8801118030599053, 52.47931786220744],
                [-1.88011180269757, 52.47931786224645], [-1.8801583443015117, 52.479479021626574]]
        ];
        const project = ([lng, lat]) => [
            6378137 * (lng + 1.88) * Math.PI / 180,
            6378137 * (Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))
                - Math.log(Math.tan(Math.PI / 4 + 52.479 * Math.PI / 360)))
        ];
        strips.forEach(ring => expect(makeShape([ring.map(project)])).toBeNull());
    });

    it('keeps real narrow slices and courtyard holes while omitting collapsed holes', () => {
        const narrow = [[0, 0], [1, 0], [1, 40], [0, 40], [0, 0]];
        expect(makeShape([narrow]).points).toHaveLength(4);
        const outer = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]];
        const courtyard = [[5, 5], [5, 10], [10, 10], [10, 5], [5, 5]];
        const collapsed = [[1, 1], [1, 15], [1.00003, 15], [1.00003, 1], [1, 1]];
        const shape = makeShape([outer, courtyard, collapsed]);
        expect(shape.points).toHaveLength(4);
        expect(shape.holes).toHaveLength(1);
        expect(shape.holes[0].points).toHaveLength(4);
    });
});
