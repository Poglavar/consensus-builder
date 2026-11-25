// Validate model bounds without a browser, canvas, or graphics context.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { dimensionsFromBounds, projectedFootprint, MAX_FOOTPRINT_TRIANGLES } = require('../../frontend/js/building-model-geometry.js');

const soup = triangles => new Float64Array(triangles.flat(2));
const WALL_SLIVERS = [[[0,0],[3.1,0],[3.1,7.3]],[[0,0],[3.1,7.3],[0,7.3]],[[0.0000012,0.0000011],[3.0999964,0.0000046],[3.0999987,0.000001]],[[1e-7,0.0000048],[-0.0000034,-0.0000023],[3.1000041,-0.000004]],[[0.0000048,0.000003],[3.1000018,-1e-7],[3.1000049,0.0000013]],[[-0.0000043,-0.000002],[-0.0000037,-0.0000028],[3.1000015,-0.000003]],[[0.000003,-0.0000048],[3.1000029,0],[3.0999991,0.0000048]],[[-0.0000028,-0.0000028],[0.0000042,0.0000026],[3.0999956,-0.000003]],[[-0.0000022,0.000004],[3.0999974,3e-7],[3.0999976,-0.0000036]],[[-0.000003,-0.000005],[-9e-7,-0.0000043],[3.1000028,0.0000034]],[[3.0999967,0.0000036],[3.0999999,7.2999956],[3.100001,7.2999965]],[[3.1000005,0.0000037],[3.100003,-0.000002],[3.099996,7.2999965]],[[3.0999988,0.0000017],[3.1000018,7.3000004],[3.0999968,7.3000001]],[[3.0999975,-0.0000027],[3.099999,-0.0000024],[3.1,7.300001]],[[3.0999988,-0.0000038],[3.0999973,7.3000043],[3.0999964,7.299997]],[[3.0999958,-0.0000023],[3.1000018,0.0000031],[3.1000008,7.2999996]],[[3.0999986,-0.0000033],[3.0999986,7.299996],[3.0999957,7.3000042]],[[3.1000044,0.0000043],[3.0999975,0.0000016],[3.1000038,7.2999963]],[[-0.0000041,7.2999957],[3.1,7.3000002],[3.1000014,7.3000034]],[[0.0000013,7.3000045],[-0.0000026,7.3000042],[3.0999981,7.3000006]],[[0.0000012,7.2999964],[3.1000047,7.2999954],[3.0999955,7.2999989]],[[-6e-7,7.3000046],[-0.0000035,7.2999951],[3.100001,7.3000017]],[[0.0000012,7.3000041],[3.1000004,7.299998],[3.0999986,7.2999982]],[[-0.0000047,7.3000028],[-0.0000017,7.2999977],[3.1000018,7.2999968]],[[-0.0000032,7.2999999],[3.0999955,7.2999986],[3.1000049,7.2999979]],[[0.000004,7.3000048],[-0.0000021,7.3000028],[3.1000027,7.2999977]],[[0.0000041,0.0000014],[0.0000035,7.3000039],[-0.0000036,7.3000046]],[[-0.0000046,-0.0000041],[1e-7,0.0000047],[0.000002,7.2999995]],[[-4e-7,-6e-7],[0.0000032,7.2999965],[0.0000034,7.2999961]],[[-0.0000032,0.000001],[-0.0000044,-7e-7],[0.0000026,7.3000029]],[[-7e-7,-0.000004],[0.0000045,7.2999988],[-0.0000018,7.3000017]],[[9e-7,6e-7],[0.0000037,-5e-7],[0.0000018,7.2999974]],[[-0.0000033,-0.000004],[-0.0000037,7.2999973],[0,7.3000023]],[[0.000001,-7e-7],[0.000002,-0.0000015],[0.0000024,7.2999965]]];
const planarRingArea = ring => Math.abs(ring.slice(0, -1).reduce((sum, point, index) => {
    const next = ring[index + 1];
    return sum + point[0] * next[1] - next[0] * point[1];
}, 0)) / 2;
const planarPolygonArea = feature => feature.geometry.coordinates.reduce((area, ring, index) =>
    area + (index === 0 ? 1 : -1) * planarRingArea(ring), 0);

describe('imported building dimensions', () => {
    it('uses X/Z for the footprint and Y for height, regardless of model origin', () => {
        expect(dimensionsFromBounds({ min: { x: -8, y: 50, z: -10 }, max: { x: 8, y: 62, z: 10 } }))
            .toEqual({ width: 16, length: 20, height: 12 });
    });

    it('preserves the placement minimum of one metre and rounds to tenths', () => {
        expect(dimensionsFromBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 0.3, y: 12.34, z: 20.26 } }))
            .toEqual({ width: 1, length: 20.3, height: 12.3 });
    });

    it.each([NaN, Infinity, -Infinity])('rejects nonfinite coordinates (%s)', value => {
        expect(dimensionsFromBounds({ min: { x: value, y: 0, z: 0 }, max: { x: 8, y: 12, z: 10 } })).toBeNull();
    });

    it('rejects empty bounds and overflowing dimensions', () => {
        expect(dimensionsFromBounds({ min: { x: 9, y: 0, z: 0 }, max: { x: 8, y: 12, z: 10 } })).toBeNull();
        expect(dimensionsFromBounds({ min: { x: -1e308, y: 0, z: 0 }, max: { x: 1e308, y: 12, z: 10 } })).toBeNull();
    });
});

describe('projected model footprint', () => {
    it('unions triangles into an L-shaped concave Polygon', () => {
        const triangles = soup([
            [[0,0],[4,0],[4,2]], [[0,0],[4,2],[0,2]],
            [[0,2],[2,2],[2,4]], [[0,2],[2,4],[0,4]]
        ]);
        const result = projectedFootprint(triangles);
        expect(result.geometry.type).toBe('Polygon');
        expect(result.geometry.coordinates).toHaveLength(1);
        expect(result.geometry.coordinates[0].length).toBeGreaterThan(5);
        expect(planarPolygonArea(result)).toBeCloseTo(12, 5);
    });

    it('preserves a courtyard as an interior ring', () => {
        const triangles = soup([
            [[0,0],[4,0],[4,1]], [[0,0],[4,1],[0,1]],
            [[0,3],[4,3],[4,4]], [[0,3],[4,4],[0,4]],
            [[0,1],[1,1],[1,3]], [[0,1],[1,3],[0,3]],
            [[3,1],[4,1],[4,3]], [[3,1],[4,3],[3,3]]
        ]);
        const result = projectedFootprint(triangles);
        expect(result.geometry.type).toBe('Polygon');
        expect(result.geometry.coordinates).toHaveLength(2);
        expect(planarPolygonArea(result)).toBeCloseTo(12, 5);
    });

    it('takes either winding, repeated triangles and zero-area triangles', () => {
        const triangles = soup([
            [[0,0],[2,0],[0,2]], [[0,2],[2,0],[0,0]],
            [[0,0],[1,1],[2,2]]
        ]);
        const result = projectedFootprint(triangles);
        expect(result.geometry.type).toBe('Polygon');
        expect(planarPolygonArea(result)).toBeCloseTo(2, 5);
    });

    // A slab and its walls seen from above: the walls are slivers whose corners differ by micrometres,
    // as an exported building's are. The pairwise Turf union threw on exactly this soup.
    it('outlines a slab with the slivers of its walls', () => {
        const result = projectedFootprint(soup(WALL_SLIVERS));
        expect(result.geometry.coordinates).toHaveLength(1);
        expect(planarPolygonArea(result)).toBeCloseTo(3.1 * 7.3, 3);
    });

    it('ignores parts and holes under 1 m² as mesh noise, and keeps a small model whole', () => {
        const square = (x, y, size) => [[[x,y],[x + size,y],[x + size,y + size]], [[x,y],[x + size,y + size],[x,y + size]]];
        // A 10 m square with a 0.5 m post beside it and a 0.6 m gap in it.
        const posted = projectedFootprint(soup([
            [[0,0],[10,0],[10,4]], [[0,0],[10,4],[0,4]], [[0,4.6],[10,4.6],[10,10]], [[0,4.6],[10,10],[0,10]],
            [[0,4],[4,4],[4,4.6]], [[0,4],[4,4.6],[0,4.6]], [[4.6,4],[10,4],[10,4.6]], [[4.6,4],[10,4.6],[4.6,4.6]],
            ...square(12, 0, 0.5)
        ]));
        expect(posted.geometry.coordinates).toHaveLength(1);
        // The post is dropped and the gap filled.
        expect(planarPolygonArea(posted)).toBeCloseTo(100, 5);
        // A courtyard of 2 m × 2 m stays a hole.
        expect(projectedFootprint(soup([
            [[0,0],[6,0],[6,2]], [[0,0],[6,2],[0,2]], [[0,4],[6,4],[6,6]], [[0,4],[6,6],[0,6]],
            [[0,2],[2,2],[2,4]], [[0,2],[2,4],[0,4]], [[4,2],[6,2],[6,4]], [[4,2],[6,4],[4,4]]
        ])).geometry.coordinates).toHaveLength(2);
        // A model smaller than 1 m² is still a footprint, and two such parts are still separate.
        expect(planarPolygonArea(projectedFootprint(soup(square(0, 0, 0.5))))).toBeCloseTo(0.25, 5);
        expect(() => projectedFootprint(soup([...square(0, 0, 0.5), ...square(2, 0, 0.5)])))
            .toThrow(expect.objectContaining({ code: 'disconnected' }));
    });

    it('rejects empty, invalid and disconnected output with explicit error codes', () => {
        expect(() => projectedFootprint(new Float64Array())).toThrow(expect.objectContaining({ code: 'empty' }));
        expect(() => projectedFootprint(soup([[[0,0],[1,0],[NaN,1]]])))
            .toThrow(expect.objectContaining({ code: 'empty' }));
        expect(() => projectedFootprint(soup([
            [[0,0],[1,0],[0,1]], [[4,0],[5,0],[4,1]]
        ]))).toThrow(expect.objectContaining({ code: 'disconnected' }));
    });

    it('has an explicit triangle-work budget', () => {
        expect(MAX_FOOTPRINT_TRIANGLES).toBe(250000);
        const tooMany = new Float64Array((MAX_FOOTPRINT_TRIANGLES + 1) * 6);
        expect(() => projectedFootprint(tooMany)).toThrow(expect.objectContaining({ code: 'complex' }));
    });
});
