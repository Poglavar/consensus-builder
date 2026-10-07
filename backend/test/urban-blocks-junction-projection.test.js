// Circumference T junctions project to the drawn block boundary before subdivision.
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
const road = (id, points, properties = {}) => ({
    type: 'Feature', id,
    properties: { highway: 'residential', ...properties },
    geometry: { type: 'LineString', coordinates: points.map(ll) }
});
const roads = (...features) => turf.featureCollection(features);
const rectangle = size => turf.polygon([[...[ [0, 0], [size, 0], [size, size], [0, size], [0, 0] ].map(ll)]]);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function enclosingLoopRoads({ extras = true, oblique = true } = {}) {
    const features = [
        // This is a closed road-centreline face, with a harmless degree-two shape vertex.
        road('enclosing-loop', [[-10, -10], [30, -10], [150, -10], [150, 150], [-10, 150], [-10, -10]]),
        road('south-stem', [[70, -35], [70, -10.2], [70, -10]]),
        road('north-stem', [[70, 175], [70, 150]])
    ];
    if (oblique) features.push(
        // Oblique external arm at a side junction.
        road('east-oblique-arm', [[151, 60], [150, 70]]),
        // At this external corner, the inward continuation of the arm points outside the block.
        road('corner-oblique-arm', [[160, 140], [150, 150]]),
        // A second real junction projects to the same drawn corner as the external corner node.
        road('near-corner-top-arm', [[145, 175], [145, 150]])
    );
    if (extras) features.push(
        // A nearby crossing is outside the enclosing loop and must not become a block anchor.
        road('nearby-cross-east-west', [[20, -20], [40, -20]]),
        road('nearby-cross-north-south', [[30, -30], [30, -15]]),
        // A three-way road junction on the drawn boundary is not on the enclosing loop.
        road('boundary-only-main', [[0, 70], [25, 70]]),
        road('boundary-only-arm-a', [[0, 70], [25, 50]]),
        road('boundary-only-arm-b', [[0, 70], [25, 90]]),
        // Grade-separated intersections at the loop do not add ground junctions.
        road('bridge-at-loop', [[40, -35], [40, -10]], { bridge: 'yes' }),
        road('tunnel-at-loop', [[50, 175], [50, 150]], { tunnel: 'yes' })
    );
    return roads(...features);
}

function preview(block, inputRoads) {
    return subdivision.preview({ block, roads: inputRoads, options: { targetAreaM2: 10000, maxSideM: 150 } }, turf, model);
}

function candidateAt(candidates, projectedPoint) {
    return candidates.find(candidate => distance(local(candidate.geometry.coordinates), projectedPoint) < 0.03);
}

function assertProjection(candidate, junction, projectedPoint, offsetM) {
    expect(candidate).toBeDefined();
    expect(candidate.properties).toMatchObject({ kind: 't', junctionPoint: expect.any(Array), projectionDistanceM: expect.any(Number) });
    expect(distance(local(candidate.properties.junctionPoint), junction)).toBeLessThan(0.03);
    expect(distance(local(candidate.geometry.coordinates), projectedPoint)).toBeLessThan(0.03);
    expect(candidate.properties.projectionDistanceM).toBeCloseTo(offsetM, 2);
}

describe('urban block road-junction projection', () => {
    it('projects each T on the enclosing road loop once and rejects unrelated, shape, and grade-separated nodes', () => {
        const result = preview(rectangle(140), enclosingLoopRoads());
        const candidates = result.candidates.features.filter(feature => feature.properties.kind === 't');

        expect(result.stats.tCount).toBe(5);
        expect(candidates).toHaveLength(5);
        assertProjection(candidateAt(candidates, [70, 0]), [70, -10], [70, 0], 10);
        assertProjection(candidateAt(candidates, [70, 140]), [70, 150], [70, 140], 10);
        assertProjection(candidateAt(candidates, [140, 70]), [150, 70], [140, 70], 10);
        const cornerCandidates = candidates.filter(candidate => distance(local(candidate.geometry.coordinates), [140, 140]) < 0.03);
        expect(cornerCandidates).toHaveLength(2);
        assertProjection(cornerCandidates.find(candidate => distance(local(candidate.properties.junctionPoint), [150, 150]) < 0.03),
            [150, 150], [140, 140], Math.sqrt(200));
        assertProjection(cornerCandidates.find(candidate => distance(local(candidate.properties.junctionPoint), [145, 150]) < 0.03),
            [145, 150], [140, 140], Math.sqrt(125));
        expect(candidates.some(candidate => distance(local(candidate.geometry.coordinates), [30, 0]) < 0.03)).toBe(false);
        expect(candidates.some(candidate => distance(local(candidate.geometry.coordinates), [0, 70]) < 0.03)).toBe(false);
    });

    it('keeps zero-offset on-boundary junctions at their original coordinates', () => {
        const block = rectangle(140);
        const onBoundaryRoads = roads(
            road('boundary-loop', [[0, 0], [140, 0], [140, 140], [0, 140], [0, 0]]),
            road('south-stem', [[70, -30], [70, 0]]),
            road('north-stem', [[70, 170], [70, 140]])
        );
        const result = preview(block, onBoundaryRoads);
        const candidates = result.candidates.features.filter(feature => feature.properties.kind === 't');

        expect(candidates).toHaveLength(2);
        assertProjection(candidateAt(candidates, [70, 0]), [70, 0], [70, 0], 0);
        assertProjection(candidateAt(candidates, [70, 140]), [70, 140], [70, 140], 0);
    });

    it('uses projected endpoints for subdivision and preserves the drawn block geometry', () => {
        const block = rectangle(140);
        const inputRoads = enclosingLoopRoads({ extras: false, oblique: false });
        const result = subdivision.plan({ block, roads: inputRoads,
            options: { targetAreaM2: 10000, maxSideM: 150 } }, turf, model);
        const layout = result.layouts[0];
        expect(layout.cuts.features).toHaveLength(1);
        const endpointA = local(layout.cuts.features[0].geometry.coordinates[0]);
        const endpointB = local(layout.cuts.features[0].geometry.coordinates.at(-1));

        expect(result.stats.tCount).toBe(2);
        expect([endpointA, endpointB].some(point => distance(point, [70, 0]) < 0.03)).toBe(true);
        expect([endpointA, endpointB].some(point => distance(point, [70, 140]) < 0.03)).toBe(true);
        expect(layout.cuts.features[0].properties.lengthM).toBeCloseTo(140, 1);
        expect(layout.stats.addedLengthM).toBeCloseTo(140, 1);
        expect(layout.pieces.features).toHaveLength(2);
        expect(layout.pieces.features.reduce((sum, piece) => sum + turf.area(piece), 0)).toBeCloseTo(turf.area(block), 1);
        for (const piece of layout.pieces.features) {
            const outside = turf.difference(piece, block);
            expect(outside ? turf.area(outside) : 0).toBeLessThanOrEqual(0.1);
        }
        expect(turf.intersect(layout.pieces.features[0], layout.pieces.features[1])).toBeNull();
    });

    it('keeps corner T junctions whose incoming arm points outside when planning a diagonal cut', () => {
        const block = rectangle(140);
        const inputRoads = roads(
            road('boundary-loop', [[0, 0], [140, 0], [140, 140], [0, 140], [0, 0]]),
            road('southwest-corner-arm', [[-30, 30], [0, 0]]),
            road('northeast-corner-arm', [[170, 110], [140, 140]])
        );
        const result = subdivision.plan({ block, roads: inputRoads,
            options: { targetAreaM2: 10000, maxSideM: 200 } }, turf, model);
        const layout = result.layouts[0];
        expect(layout.cuts.features).toHaveLength(1);
        const cut = layout.cuts.features[0];
        const endpoints = cut.geometry.coordinates.map(local);

        expect(result.stats.tCount).toBe(2);
        expect(cut.properties).toMatchObject({ kind: 't', fromKind: 't', toKind: 't' });
        expect(endpoints.some(point => distance(point, [0, 0]) < 0.03)).toBe(true);
        expect(endpoints.some(point => distance(point, [140, 140]) < 0.03)).toBe(true);
        expect(cut.properties.lengthM).toBeCloseTo(Math.sqrt(2) * 140, 1);
        expect(layout.pieces.features).toHaveLength(2);
        expect(layout.pieces.features.every(piece => piece.properties.acceptable)).toBe(true);
        expect(layout.pieces.features.every(piece => piece.properties.areaM2 <= 10000.1)).toBe(true);
        expect(layout.pieces.features.reduce((sum, piece) => sum + turf.area(piece), 0)).toBeCloseTo(turf.area(block), 1);
        expect(turf.intersect(layout.pieces.features[0], layout.pieces.features[1])).toBeNull();
    });
});
