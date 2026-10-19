// Closed OSM road areas describe pedestrian space, not road-centreline topology.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';

const require = createRequire(import.meta.url);
const turf = turfModule.default || turfModule;
const model = require('../../frontend/js/urban-blocks-model.js');
const subdivision = require('../../frontend/js/urban-blocks-subdivision.js');
const links = require('../../frontend/js/urban-blocks-links.js');
const METRES_PER_DEGREE = Math.PI * 6371008.8 / 180;
const ll = ([x, y]) => [x / METRES_PER_DEGREE, y / METRES_PER_DEGREE];
const local = ([lon, lat]) => [lon * METRES_PER_DEGREE, lat * METRES_PER_DEGREE];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const road = (id, points, properties = {}) => ({
    type: 'Feature', id, properties: { highway: 'residential', ...properties },
    geometry: { type: 'LineString', coordinates: points.map(ll) }
});
const roads = turf.featureCollection([
    road('north-south-centreline', [[100, -40], [100, 40], [100, 160]]),
    road('west-joining-arm', [[-40, 40], [100, 40]]),
    // Closed highway area around the corridor. Its east edge follows the block's east notch edge.
    road('pedestrian-corridor-area', [[90, -40], [110, -40], [110, 160], [90, 160], [90, -40]],
        { highway: 'pedestrian', area: 'yes' })
]);
const block = turf.polygon([[
    [0, 0], [80, 0], [80, 160], [110, 160], [110, 0], [240, 0], [240, 240], [0, 240], [0, 0]
].map(ll)]);
const options = { targetAreaM2: 40000, maxSideM: 300, perimeterStepM: 150 };

function projectionAt(features, kind, point) {
    return features.find(feature => feature.properties.kind === kind
        && distance(local(feature.geometry.coordinates), point) < 0.03);
}

describe('urban block road-area candidate topology', () => {
    it('uses the area footprint to project centerline junctions without treating its outline as a road', () => {
        const before = structuredClone(block);
        const result = subdivision.preview({ block, roads, options }, turf, model);
        const candidates = result.candidates.features;
        const tCandidates = candidates.filter(feature => feature.properties.kind === 't');
        const deadEnds = candidates.filter(feature => feature.properties.kind === 'dead-end');
        const tAtEastNotch = projectionAt(candidates, 't', [110, 40]);
        const deadEndAtTip = projectionAt(candidates, 'dead-end', [100, 160]);
        const deadEndProjection = projectionAt(candidates, 'dead-end-projection', [100, 240]);

        expect(result.stats.tCount).toBe(1);
        expect(tCandidates).toHaveLength(1);
        expect(tAtEastNotch).toBeDefined();
        expect(distance(local(tAtEastNotch.properties.junctionPoint), [100, 40])).toBeLessThan(0.03);
        expect(tAtEastNotch.properties.projectionDistanceM).toBeCloseTo(10, 2);
        expect(tCandidates.some(feature => distance(local(feature.geometry.coordinates), [100, 160]) < 0.03)).toBe(false);

        expect(result.stats.deadEndCount).toBe(1);
        expect(deadEnds).toHaveLength(1);
        expect(deadEndAtTip).toBeDefined();
        expect(result.stats.deadEndProjectionCount).toBe(1);
        expect(deadEndProjection).toBeDefined();
        expect(deadEndProjection.properties.projectionSources).toHaveLength(1);
        expect(distance(local(deadEndProjection.properties.projectionSources[0].sourcePoint), [100, 160])).toBeLessThan(0.03);
        expect(deadEndProjection.properties.projectionSources[0].lengthM).toBeCloseTo(80, 2);
        expect(block).toEqual(before);
    });

    it('keeps the real source of an alley ending before the block edge and counts only the interior cut', () => {
        const outsideTipRoads = turf.featureCollection([
            road('north-south-centreline', [[100, -40], [100, 40], [100, 150]]), ...roads.features.slice(1)
        ]);
        const preview = subdivision.preview({ block, roads: outsideTipRoads, options }, turf, model);
        const landing = projectionAt(preview.candidates.features, 'dead-end-projection', [100, 240]);
        expect(projectionAt(preview.candidates.features, 'dead-end', [100, 160])).toBeDefined();
        expect(landing).toBeDefined();
        expect(distance(local(landing.properties.projectionSources[0].sourcePoint), [100, 150])).toBeLessThan(0.03);
        expect(landing.properties.projectionSources[0].lengthM).toBeCloseTo(90, 2);
        const layout = subdivision.plan({ block, roads: outsideTipRoads, options }, turf, model).layouts[0];
        expect(layout.cuts.features).toHaveLength(1);
        expect(layout.stats.addedLengthM).toBeCloseTo(80, 1);
        const path = layout.cuts.features[0].properties.splitPath.map(local);
        expect(path).toHaveLength(2);
        expect(distance(path[0], [100, 160])).toBeLessThan(0.03);
        expect(distance(path[1], [100, 240])).toBeLessThan(0.03);
    });

    it('does not project a junction across any uncovered gap outside the street footprint', () => {
        const uncoveredRoads = turf.featureCollection([
            ...roads.features.slice(0, 2),
            road('short-pedestrian-corridor-area', [[90, -40], [108, -40], [108, 160], [90, 160], [90, -40]],
                { highway: 'pedestrian', area: 'yes' })
        ]);
        const result = subdivision.preview({ block, roads: uncoveredRoads, options }, turf, model);

        expect(result.stats.tCount).toBe(0);
        expect(result.candidates.features.some(feature => feature.properties.kind === 't')).toBe(false);
    });

    it('creates no natural candidates from pedestrian footprint-only data', () => {
        const footprintOnly = turf.featureCollection([roads.features[2]]);
        const result = subdivision.preview({ block, roads: footprintOnly, options }, turf, model);

        expect(result.stats).toMatchObject({ tCount: 0, deadEndCount: 0, deadEndProjectionCount: 0, fallbackCount: 0 });
        expect(result.candidates.features).toHaveLength(0);
    });

    it('splits from the boundary dead tip, counts only the new interior span, and shares/restores the cut', () => {
        const before = structuredClone(block);
        const planned = subdivision.plan({ block, roads, options }, turf, model);
        const chosen = planned.layouts[0];
        const deadEndCut = chosen.cuts.features.find(cut => [cut.properties.fromKind, cut.properties.toKind]
            .includes('dead-end-projection'));

        expect(deadEndCut).toBeDefined();
        expect(new Set([deadEndCut.properties.fromKind, deadEndCut.properties.toKind]))
            .toEqual(new Set(['dead-end', 'dead-end-projection']));
        expect(deadEndCut.properties.splitPath).toHaveLength(2);
        expect(distance(local(deadEndCut.properties.splitPath[0]), [100, 160])).toBeLessThan(0.03);
        expect(distance(local(deadEndCut.properties.splitPath[1]), [100, 240])).toBeLessThan(0.03);
        expect(deadEndCut.properties.lengthM).toBeCloseTo(80, 1);
        expect(chosen.stats.addedLengthM).toBeCloseTo(80, 1);
        expect(chosen.pieces.features).toHaveLength(2);
        expect(chosen.pieces.features.reduce((sum, piece) => sum + turf.area(piece), 0)).toBeCloseTo(turf.area(block), 1);
        expect(turf.intersect(chosen.pieces.features[0], chosen.pieces.features[1])).toBeNull();
        expect(block).toEqual(before);

        const bbox = turf.bbox(block);
        const sharedUrl = links.build({ baseUrl: 'https://example.test/path?lang=hr&backend=staging',
            city: 'explore', blockId: 'osm-block-a13f', bbox, targetSideM: 200,
            subdivision: { options, layout: chosen } });
        const parsed = links.parse(sharedUrl);
        expect(parsed.subdivision.cuts).toHaveLength(chosen.cuts.features.length);
        const restored = subdivision.restore({ block, subdivision: parsed.subdivision }, turf);
        const restoredLayout = restored.layouts[0];

        expect(restoredLayout.cuts.features).toHaveLength(chosen.cuts.features.length);
        const restoredDeadEndCut = restoredLayout.cuts.features.find(cut => [cut.properties.fromKind, cut.properties.toKind]
            .includes('dead-end-projection'));
        expect(restoredDeadEndCut).toBeDefined();
        expect(restoredDeadEndCut.properties.fromKind).toBe(deadEndCut.properties.fromKind);
        expect(restoredDeadEndCut.properties.toKind).toBe(deadEndCut.properties.toKind);
        expect(restoredDeadEndCut.properties.lengthM).toBeCloseTo(80, 1);
        expect(restoredLayout.stats.addedLengthM).toBeCloseTo(80, 1);
        expect(restoredLayout.pieces.features).toHaveLength(2);
        expect(restoredLayout.pieces.features.reduce((sum, piece) => sum + turf.area(piece), 0)).toBeCloseTo(turf.area(block), 1);
        expect(turf.intersect(restoredLayout.pieces.features[0], restoredLayout.pieces.features[1])).toBeNull();
    });

    it('clips a boundary crossing between road vertices before projecting an internal dead end', () => {
        const square = turf.polygon([[[0, 0], [140, 0], [140, 140], [0, 140], [0, 0]].map(ll)]);
        const crossingRoads = turf.featureCollection([
            road('crossing-entry-alley', [[-20, 70], [20, 70], [60, 70]])
        ]);
        const localOptions = { targetAreaM2: 10000, maxSideM: 150, perimeterStepM: 150 };
        const result = subdivision.plan({ block: square, roads: crossingRoads, options: localOptions }, turf, model);
        const cut = result.layouts[0].cuts.features.find(feature => [feature.properties.fromKind, feature.properties.toKind]
            .includes('dead-end-projection'));

        expect(cut).toBeDefined();
        expect(cut.properties.lengthM).toBeCloseTo(80, 1);
        const splitPath = cut.properties.splitPath.map(local);
        const expectedPath = [[0, 70], [20, 70], [60, 70], [140, 70]];
        expect(splitPath).toHaveLength(expectedPath.length);
        splitPath.forEach((point, i) => expect(distance(point, expectedPath[i])).toBeLessThan(0.03));
        expect(splitPath.every(point => point[0] >= -0.03)).toBe(true);
        expect(result.layouts[0].stats.addedLengthM).toBeCloseTo(80, 1);
        expect(result.layouts[0].pieces.features.reduce((sum, piece) => sum + turf.area(piece), 0))
            .toBeCloseTo(turf.area(square), 1);
        expect(turf.intersect(result.layouts[0].pieces.features[0], result.layouts[0].pieces.features[1])).toBeNull();
    });
});
