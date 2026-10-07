// Geometry-level contracts for the urban-block subdivision experiment, without a browser.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';

const require = createRequire(import.meta.url);
const turf = turfModule.default || turfModule;
const model = require('../../frontend/js/urban-blocks-model.js');
const subdivision = require('../../frontend/js/urban-blocks-subdivision.js');

// Keep fixtures near the equator, where this conversion is a close match for local metre axes.
const METRES_PER_DEGREE = 111_195;
const ll = ([x, y]) => [x / METRES_PER_DEGREE, y / METRES_PER_DEGREE];
const road = (id, points, properties = {}) => ({
    type: 'Feature', id,
    properties: { highway: 'residential', ...properties },
    geometry: { type: 'LineString', coordinates: points.map(ll) }
});
const roads = (...features) => turf.featureCollection(features);
const ring = points => points.map(ll);
const rectangle = (width, height = width, holes = []) => turf.polygon([
    ring([[0, 0], [width, 0], [width, height], [0, height], [0, 0]]),
    ...holes.map(ring)
]);
const rectangleAtLatitude = (latitude, width, height = width) => {
    const y = latitude * Math.PI / 180;
    const origin = [15, latitude];
    const point = ([x, north]) => [origin[0] + x / (METRES_PER_DEGREE * Math.cos(y)), origin[1] + north / METRES_PER_DEGREE];
    return turf.polygon([[point([0, 0]), point([width, 0]), point([width, height]),
        point([0, height]), point([0, 0])]]);
};
const limits = { targetAreaM2: 10000, maxSideM: 150 };

function teeRoads() {
    return roads(
        // Each stem meets the middle of an unsplit boundary way; nodeRoads must add the junction.
        road('top-boundary', [[0, 140], [140, 140]]),
        road('top-stem', [[70, 190], [70, 140]]),
        road('bottom-boundary', [[0, 0], [140, 0]]),
        road('bottom-stem', [[70, -50], [70, 0]])
    );
}

function teeRoadsFor(width, height) {
    const x = width / 2;
    return roads(
        road('top-boundary-large', [[0, height], [width, height]]),
        road('top-stem-large', [[x, height + 50], [x, height]]),
        road('bottom-boundary-large', [[0, 0], [width, 0]]),
        road('bottom-stem-large', [[x, -50], [x, 0]])
    );
}

function teeRoadsAtLatitude(latitude, width, height) {
    const y = latitude * Math.PI / 180;
    const origin = [15, latitude];
    const point = ([x, north]) => [origin[0] + x / (METRES_PER_DEGREE * Math.cos(y)), origin[1] + north / METRES_PER_DEGREE];
    const line = (id, points) => ({ type: 'Feature', id, properties: { highway: 'residential' },
        geometry: { type: 'LineString', coordinates: points.map(point) } });
    const x = width / 2;
    return roads(
        line('top-boundary', [[0, height], [width, height]]),
        line('top-stem', [[x, height + 50], [x, height]]),
        line('bottom-boundary', [[0, 0], [width, 0]]),
        line('bottom-stem', [[x, -50], [x, 0]])
    );
}

function assertNoAreaOverlap(features) {
    for (let i = 0; i < features.length; i++) for (let j = i + 1; j < features.length; j++) {
        expect(turf.intersect(features[i], features[j])).toBeNull();
    }
}

function areaOutside(feature, boundary) {
    const outside = turf.difference(feature, boundary);
    return outside ? turf.area(outside) : 0;
}

function assertLabelPointStrictlyInside(feature) {
    const labelPoint = feature.properties.labelPoint;
    expect(labelPoint).toHaveLength(2);
    expect(labelPoint.every(Number.isFinite)).toBe(true);
    expect(turf.booleanPointInPolygon(turf.point(labelPoint), feature, { ignoreBoundary: true })).toBe(true);
    for (const hole of feature.geometry.coordinates.slice(1)) {
        expect(turf.booleanPointInPolygon(turf.point(labelPoint), turf.polygon([hole]))).toBe(false);
    }
}

describe('urban block subdivision geometry', () => {
    it('nodes boundary T junctions and joins them into an accepted cut', () => {
        const block = rectangle(140);
        const inputRoads = teeRoads();
        const originalBlock = structuredClone(block);
        const originalRoads = structuredClone(inputRoads);
        const result = subdivision.plan({ block, roads: inputRoads, options: limits }, turf, model);
        const layout = result.layouts[0];

        expect(result.stats.tCount).toBe(2);
        expect(layout.cuts.features).toHaveLength(1);
        expect(layout.cuts.features[0].properties).toMatchObject({ kind: 't', fromKind: 't', toKind: 't' });
        expect(layout.pieces.features).toHaveLength(2);
        expect(layout.pieces.features.every(piece => piece.properties.acceptable)).toBe(true);
        expect(layout.pieces.features.every(piece => piece.properties.areaM2 <= limits.targetAreaM2 + 0.1)).toBe(true);
        expect(layout.pieces.features.every(piece => piece.properties.longestSideM <= limits.maxSideM + 0.02)).toBe(true);
        expect(layout.pieces.features.reduce((sum, piece) => sum + turf.area(piece), 0)).toBeCloseTo(turf.area(block), 1);
        assertNoAreaOverlap(layout.pieces.features);
        expect(block).toEqual(originalBlock);
        expect(inputRoads).toEqual(originalRoads);
    });

    it('uses a boundary-connected cul-de-sac and rejects disconnected or grade-separated roads', () => {
        const block = rectangle(140);
        const connected = roads(
            road('cul-de-sac', [[0, 70], [70, 70]]),
            road('right-boundary', [[140, 0], [140, 140]]),
            road('right-tee', [[190, 70], [140, 70]])
        );
        const connectedResult = subdivision.plan({ block, roads: connected, options: limits }, turf, model);
        expect(connectedResult.stats.deadEndCount).toBe(1);
        expect(connectedResult.layouts[0].cuts.features[0].properties.kind).toBe('dead-end');

        const disconnected = subdivision.preview({ block, roads: roads(road('internal-only', [[40, 70], [100, 70]])),
            options: limits }, turf, model);
        expect(disconnected.stats.deadEndCount).toBe(0);
        expect(disconnected.candidates.features.some(point => point.properties.kind === 'dead-end')).toBe(false);

        const bridge = subdivision.preview({ block, roads: roads(road('overpass', [[0, 70], [70, 70]], { bridge: 'yes' })),
            options: limits }, turf, model);
        expect(bridge.stats.deadEndCount).toBe(0);
        expect(bridge.stats.tCount).toBe(0);
        expect(bridge.candidates.features).toHaveLength(0);
    });

    it('leaves an unanchored oversized block partial without inventing fallback cuts', () => {
        const block = rectangle(180);
        const result = subdivision.plan({ block, roads: roads(), options: limits }, turf, model);
        const layout = result.layouts[0];

        expect(result.stats.tCount).toBe(0);
        expect(result.stats.deadEndCount).toBe(0);
        expect(result.stats.fallbackCount).toBe(0);
        expect(layout.cuts.features).toHaveLength(0);
        expect(layout.pieces.features).toHaveLength(1);
        expect(layout.pieces.features[0].properties.acceptable).toBe(false);
        expect(turf.area(layout.pieces.features[0])).toBeCloseTo(turf.area(block), 2);
    });

    it('uses natural T anchors in a larger rectangle and conserves its area', () => {
        const block = rectangle(300, 200);
        const result = subdivision.plan({ block, roads: teeRoadsFor(300, 200), options: limits }, turf, model);
        const layout = result.layouts[0];

        expect(result.stats.tCount).toBe(2);
        expect(layout.cuts.features.length).toBeGreaterThan(0);
        expect(layout.pieces.features.reduce((sum, piece) => sum + turf.area(piece), 0)).toBeCloseTo(turf.area(block), 1);
        assertNoAreaOverlap(layout.pieces.features);
    });

    it('uses Turf area at high latitude and keeps accepted pieces within both limits', () => {
        const block = rectangleAtLatitude(45.8, 180);
        const result = subdivision.plan({ block, roads: teeRoadsAtLatitude(45.8, 180, 180), options: limits }, turf, model);

        expect(result.layouts.length).toBeGreaterThan(0);
        for (const layout of result.layouts) {
            expect(layout.cuts.features.length).toBeGreaterThan(0);
            for (const piece of layout.pieces.features) {
                expect(piece.properties.areaM2).toBeCloseTo(turf.area(piece), 5);
                if (piece.properties.acceptable) {
                    expect(piece.properties.areaM2).toBeLessThanOrEqual(limits.targetAreaM2 + 0.1);
                    expect(piece.properties.longestSideM).toBeLessThanOrEqual(limits.maxSideM + 0.02);
                }
            }
        }
    });

    it('leaves an already acceptable block whole', () => {
        const block = rectangle(50);
        const result = subdivision.plan({ block, roads: roads(), options: limits }, turf, model);

        expect(result.layouts[0].cuts.features).toHaveLength(0);
        expect(result.layouts[0].pieces.features).toHaveLength(1);
        expect(turf.area(result.layouts[0].pieces.features[0])).toBeCloseTo(turf.area(block), 2);
    });

    it('places returned plan and restored label points strictly inside concave and donut pieces', () => {
        const concave = turf.polygon([ring([[0, 0], [200, 0], [200, 100], [100, 100], [100, 200], [0, 200], [0, 0]])]);
        const donut = rectangle(200, 200, [[[80, 80], [120, 80], [120, 120], [80, 120], [80, 80]]]);
        const options = { targetAreaM2: 50000, maxSideM: 300, perimeterStepM: 150 };

        for (const sourceBlock of [concave, donut]) {
            const planned = subdivision.plan({ block: sourceBlock, roads: roads(), options }, turf, model);
            expect(planned.layouts[0].cuts.features).toHaveLength(0);
            for (const piece of planned.layouts[0].pieces.features) assertLabelPointStrictlyInside(piece);

            const restored = subdivision.restore({ block: sourceBlock, subdivision: { options, cuts: [] } }, turf);
            expect(restored.layouts[0].cuts.features).toHaveLength(0);
            for (const piece of restored.layouts[0].pieces.features) assertLabelPointStrictlyInside(piece);
        }
    });

    it('keeps the area limit and fitted longest rectangle side as separate acceptance limits', () => {
        const angle = Math.PI / 4;
        const rotate = ([x, y]) => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
        const sparse = [rotate([0, 0]), rotate([300, 0]), rotate([300, 20]), rotate([0, 20]), rotate([0, 0])];
        const dense = sparse.slice(0, -1).flatMap((start, i) => {
            const end = sparse[i + 1];
            return Array.from({ length: 10 }, (_, step) => start.map((value, axis) => value + (end[axis] - value) * step / 10));
        }).concat([sparse[0]]);
        const sparseMeasure = subdivision.measure([sparse], limits);
        const denseMeasure = subdivision.measure([dense], limits);

        expect(sparseMeasure.areaM2).toBeCloseTo(6000, 6);
        expect(sparseMeasure.longestSideM).toBeCloseTo(300, 6);
        expect(sparseMeasure.areaM2).toBeLessThan(limits.targetAreaM2);
        expect(sparseMeasure.acceptable).toBe(false);
        expect(denseMeasure.areaM2).toBeCloseTo(sparseMeasure.areaM2, 6);
        expect(denseMeasure.perimeterM).toBeCloseTo(sparseMeasure.perimeterM, 6);
        expect(denseMeasure.longestSideM).toBeCloseTo(sparseMeasure.longestSideM, 6);
        expect(denseMeasure.acceptable).toBe(false);
    });

    it('rejects a straight chord that leaves a concave block', () => {
        const options = { targetAreaM2: 10000, maxSideM: 500 };
        const outer = [[0, 0], [200, 0], [200, 100], [100, 100], [100, 200], [0, 200], [0, 0]];
        const parent = { rings: [outer], properties: subdivision.measure([outer], options) };

        // Both endpoints lie on the boundary, but their midpoint (125,125) is in the notch.
        expect(subdivision.splitFace(parent, [[200, 50], [50, 200]], options)).toBeNull();
        const valid = subdivision.splitFace(parent, [[0, 50], [200, 50]], options);
        expect(valid).toHaveLength(2);
        expect(valid.reduce((sum, piece) => sum + piece.properties.areaM2, 0)).toBeCloseTo(30000, 6);
    });

    it('samples exact fallback spacing from a T-junction along the outer perimeter', () => {
        const outer = [[0, 0], [140, 0], [140, 140], [0, 140], [0, 0]];
        const parent = { rings: [outer] };
        const anchor = [70, 140];
        const tJunction = { kind: 't', point: anchor, path: [anchor] };
        const stepM = 150;
        const candidates = subdivision.perimeterCandidates(parent, [tJunction], stepM);
        const perimeter = 560;
        const anchorAlong = 350;
        const along = point => {
            if (point[1] === 0) return point[0];
            if (point[0] === 140) return 140 + point[1];
            if (point[1] === 140) return 420 - point[0];
            return 560 - point[1];
        };

        expect(candidates.map(candidate => (along(candidate.point) - anchorAlong + perimeter) % perimeter))
            .toEqual([150, 300, 450]);
    });

    it('conserves every returned layout of a holed block without overlap or courtyard fill', () => {
        const block = rectangle(180, 180, [[[80, 80], [100, 80], [100, 100], [80, 100], [80, 80]]]);
        const anchoredRoads = roads(
            road('left-cul-de-sac', [[0, 40], [90, 40]]),
            road('right-boundary', [[180, 0], [180, 180]]),
            road('right-tee', [[220, 40], [180, 40]])
        );
        const result = subdivision.plan({ block, roads: anchoredRoads, options: limits }, turf, model);
        const sourceArea = turf.area(block);
        const holeCenter = turf.point(ll([90, 90]));

        expect(result.layouts.length).toBeGreaterThan(0);
        for (const layout of result.layouts) {
            const pieces = layout.pieces.features;
            const areaError = Math.abs(pieces.reduce((sum, piece) => sum + turf.area(piece), 0) - sourceArea);
            const toleranceM2 = Math.max(layout.stats.cutsCount * 0.1, sourceArea * 1e-6);

            expect(layout.cuts.features.length).toBeGreaterThan(0);
            expect(areaError).toBeLessThanOrEqual(toleranceM2);
            expect(pieces.every(piece => areaOutside(piece, block) <= 0.1)).toBe(true);
            expect(pieces.filter(piece => piece.geometry.coordinates.length === 2)).toHaveLength(1);
            expect(pieces.some(piece => turf.booleanPointInPolygon(holeCenter, piece))).toBe(false);
            assertNoAreaOverlap(pieces);
        }
    });
});
