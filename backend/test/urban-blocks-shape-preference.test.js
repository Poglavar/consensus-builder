// A larger side cap must not make a less coherent shape rank ahead of available rectangles.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';

const require = createRequire(import.meta.url);
const turf = turfModule.default || turfModule;
const model = require('../../frontend/js/urban-blocks-model.js');
const subdivision = require('../../frontend/js/urban-blocks-subdivision.js');
const METRES_PER_DEGREE = Math.PI * 6371008.8 / 180;
const ll = ([x, y]) => [x / METRES_PER_DEGREE, y / METRES_PER_DEGREE];
const local = ([lon, lat]) => [lon * METRES_PER_DEGREE, lat * METRES_PER_DEGREE];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const road = (id, points) => ({ type: 'Feature', id, properties: { highway: 'residential' },
    geometry: { type: 'LineString', coordinates: points.map(ll) } });

function rectangle(width, height) {
    return turf.polygon([[[0, 0], [width, 0], [width, height], [0, height], [0, 0]].map(ll)]);
}

function teeNetwork(width, height, junctions) {
    const ring = [[0, 0], [width, 0], [width, height], [0, height], [0, 0]];
    const features = [road('block-circumference', ring)];
    junctions.forEach(([x, y], index) => {
        if (x === 0 && y === 0) features.push(road(`corner-arm-${index}`, [[-30, 30], [0, 0]]));
        else if (x === width && y === height) features.push(road(`corner-arm-${index}`, [[width + 30, height - 30], [width, height]]));
        else if (x === 0) features.push(road(`side-arm-${index}`, [[-30, y], [0, y]]));
        else if (x === width) features.push(road(`side-arm-${index}`, [[width, y], [width + 30, y]]));
        else throw new Error(`Unsupported T junction ${x},${y}`);
    });
    return turf.featureCollection(features);
}

function plan(width, height, junctions, targetAreaM2, maxSideM) {
    const block = rectangle(width, height);
    const result = subdivision.plan({ block, roads: teeNetwork(width, height, junctions),
        options: { targetAreaM2, maxSideM, perimeterStepM: 150 } }, turf, model);
    return { block, result, layout: result.layouts[0] };
}

function localCutEndpoints(cut) {
    return cut.geometry.coordinates.map(local).map(point => point.map(value => Math.round(value * 10) / 10))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function assertAreaConservedAndDisjoint(layout, block) {
    expect(layout.pieces.features.reduce((sum, piece) => sum + turf.area(piece), 0)).toBeCloseTo(turf.area(block), 1);
    for (let i = 0; i < layout.pieces.features.length; i++) for (let j = i + 1; j < layout.pieces.features.length; j++) {
        const overlap = turf.intersect(layout.pieces.features[i], layout.pieces.features[j]);
        expect(overlap ? turf.area(overlap) : 0).toBeLessThanOrEqual(0.1);
    }
}

function assertAcceptedPiecesRespectHardCaps(layout, targetAreaM2, maxSideM) {
    for (const piece of layout.pieces.features) if (piece.properties.acceptable) {
        expect(piece.properties.areaM2).toBeLessThanOrEqual(targetAreaM2 + 0.1);
        expect(piece.properties.longestSideM).toBeLessThanOrEqual(maxSideM + 0.02);
    }
}

function expectRectangles(layout, expectedBoxes) {
    expect(layout.pieces.features).toHaveLength(expectedBoxes.length);
    const actualBoxes = layout.pieces.features.map(piece => {
        const [west, south, east, north] = turf.bbox(piece).map(value => value * METRES_PER_DEGREE);
        expect(Math.abs(turf.area(piece) - turf.area(turf.bboxPolygon(turf.bbox(piece))))).toBeLessThanOrEqual(0.1);
        return [west, south, east, north].map(value => Math.round(value * 10) / 10);
    }).sort((a, b) => a[1] - b[1]);
    expect(actualBoxes).toEqual(expectedBoxes.map(box => box.map(value => Math.round(value * 10) / 10)).sort((a, b) => a[1] - b[1]));
}

describe('urban block shape preference', () => {
    it('keeps the same straight rectangular split as the longest-side cap increases', () => {
        const junctions = [[0, 90], [100, 90], [0, 0], [100, 180]];
        const limits = [150, 275, 300].map(maxSideM => ({ maxSideM, ...plan(100, 180, junctions, 10000, maxSideM) }));

        for (const { maxSideM, block, layout } of limits) {
            expect(layout.cuts.features).toHaveLength(1);
            expect(layout.cuts.features[0].properties).toMatchObject({ kind: 't', fromKind: 't', toKind: 't' });
            expect(localCutEndpoints(layout.cuts.features[0])).toEqual([[0, 90], [100, 90]]);
            expect(layout.pieces.features.every(piece => piece.properties.acceptable)).toBe(true);
            expectRectangles(layout, [[0, 0, 100, 90], [0, 90, 100, 180]]);
            assertAreaConservedAndDisjoint(layout, block);
        }
        expect(limits.map(({ layout }) => localCutEndpoints(layout.cuts.features[0])))
            .toEqual([[[0, 90], [100, 90]], [[0, 90], [100, 90]], [[0, 90], [100, 90]]]);
        for (const { maxSideM, layout } of limits) assertAcceptedPiecesRespectHardCaps(layout, 10000, maxSideM);
    });

    it('uses at least three area-valid pieces when a 100 by 240 block exceeds a two-piece area cap', () => {
        const junctions = [[0, 80], [100, 80], [0, 160], [100, 160], [0, 0], [100, 240], [0, 120]];
        const { block, layout } = plan(100, 240, junctions, 10000, 300);

        expect(layout.pieces.features.length).toBeGreaterThanOrEqual(3);
        expect(layout.pieces.features.every(piece => piece.properties.acceptable)).toBe(true);
        expect(layout.pieces.features.every(piece => piece.properties.areaM2 <= 10000.1)).toBe(true);
        assertAcceptedPiecesRespectHardCaps(layout, 10000, 300);
        assertAreaConservedAndDisjoint(layout, block);
    });

    it('prefers the available crosswise rectangles over feasible corner-to-corner triangles', () => {
        const junctions = [[0, 120], [100, 120], [0, 0], [100, 240]];
        const { block, layout } = plan(100, 240, junctions, 22500, 275);

        expect(layout.cuts.features).toHaveLength(1);
        expect(layout.cuts.features[0].properties).toMatchObject({ kind: 't', fromKind: 't', toKind: 't' });
        expect(localCutEndpoints(layout.cuts.features[0])).toEqual([[0, 120], [100, 120]]);
        expect(layout.pieces.features.every(piece => piece.properties.acceptable)).toBe(true);
        expectRectangles(layout, [[0, 0, 100, 120], [0, 120, 100, 240]]);
        assertAcceptedPiecesRespectHardCaps(layout, 22500, 275);
        assertAreaConservedAndDisjoint(layout, block);
    });
});
