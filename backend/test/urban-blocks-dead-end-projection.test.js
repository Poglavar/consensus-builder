// A connected dead-end tip can extend its last road segment to the first opposite boundary.
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
    type: 'Feature', id,
    properties: { highway: 'residential', ...properties },
    geometry: { type: 'LineString', coordinates: points.map(ll) }
});
const roads = (...features) => turf.featureCollection(features);
const rectangle = (size, holes = []) => turf.polygon([
    [[0, 0], [size, 0], [size, size], [0, size], [0, 0]].map(ll),
    ...holes.map(ring => ring.map(ll))
]);
const block = rectangle(140);
const options = { targetAreaM2: 10000, maxSideM: 150, perimeterStepM: 150 };

function preview(inputBlock, inputRoads) {
    return subdivision.preview({ block: inputBlock, roads: inputRoads, options }, turf, model);
}

function deadEndProjections(result) {
    return result.candidates.features.filter(feature => feature.properties.kind === 'dead-end-projection');
}

function projectionAt(result, point) {
    return deadEndProjections(result).find(feature => distance(local(feature.geometry.coordinates), point) < 0.03);
}

describe('urban block dead-end tip projections', () => {
    it('projects a connected tip from its source to the opposite outer boundary and leaves perimeter anchors unchanged', () => {
        const inputRoads = roads(road('left-alley', [[0, 70], [60, 70]]));
        const result = preview(block, inputRoads);
        const projections = deadEndProjections(result);
        const projection = projectionAt(result, [140, 70]);

        expect(result.stats.deadEndCount).toBe(1);
        expect(result.stats.deadEndProjectionCount).toBe(1);
        expect(projections).toHaveLength(1);
        expect(projection).toBeDefined();
        expect(projection.properties.projectionSources).toHaveLength(1);
        const source = projection.properties.projectionSources[0];
        expect(source.sourceId).toEqual(expect.any(String));
        expect(distance(local(source.sourcePoint), [60, 70])).toBeLessThan(0.03);
        expect(source.lengthM).toBeCloseTo(80, 2);

        const fallbackIds = new Set(projections.map(feature => feature.properties.id));
        for (const fallback of result.candidates.features.filter(feature => feature.properties.kind === 'perimeter')) {
            expect(fallbackIds.has(fallback.properties.provenance?.sourceId)).toBe(false);
            expect(['t', 'dead-end-root', 'perimeter']).toContain(fallback.properties.provenance?.sourceKind);
        }
    });

    it('deduplicates coincident landings while preserving each dead-end source and gap length', () => {
        const inputRoads = roads(
            road('level-alley', [[0, 70], [60, 70]]),
            road('sloped-alley', [[0, 120], [40, 100], [56, 91], [60, 90]])
        );
        const result = preview(block, inputRoads);
        const projections = deadEndProjections(result);
        const projection = projectionAt(result, [140, 70]);

        expect(result.stats.deadEndCount).toBe(2);
        expect(projections).toHaveLength(1);
        expect(projection.properties.projectionSources).toHaveLength(2);
        const sources = projection.properties.projectionSources.slice().sort((a, b) => a.sourcePoint[1] - b.sourcePoint[1]);
        expect(distance(local(sources[0].sourcePoint), [60, 70])).toBeLessThan(0.03);
        expect(distance(local(sources[1].sourcePoint), [60, 90])).toBeLessThan(0.03);
        expect(sources.map(source => source.lengthM).sort((a, b) => a - b)[0]).toBeCloseTo(80, 2);
        expect(sources.map(source => source.lengthM).sort((a, b) => a - b)[1]).toBeCloseTo(Math.sqrt(6800), 2);
    });

    it('follows the last alley segment and stops at the first boundary hit across a concavity', () => {
        const outer = [[0, 0], [200, 0], [200, 200], [150, 200], [150, 50], [50, 50], [50, 200], [0, 200], [0, 0]];
        const concaveBlock = turf.polygon([outer.map(ll)]);
        const inputRoads = roads(road('curved-left-alley', [[0, 60], [10, 70], [20, 65], [25, 60], [30, 60]]));
        const result = preview(concaveBlock, inputRoads);
        const projections = deadEndProjections(result);

        expect(projections).toHaveLength(1);
        expect(distance(local(projections[0].geometry.coordinates), [50, 60])).toBeLessThan(0.03);
        expect(distance(local(projections[0].geometry.coordinates), [30, 50])).toBeGreaterThan(10);
        expect(distance(local(projections[0].geometry.coordinates), [200, 60])).toBeGreaterThan(100);
    });

    it('does not project through a hole or from disconnected and grade-separated dead ends', () => {
        const holedBlock = rectangle(140, [[[80, 60], [100, 60], [100, 80], [80, 80], [80, 60]]]);
        const throughHole = preview(holedBlock, roads(road('hole-approach', [[0, 70], [60, 70]])));
        expect(deadEndProjections(throughHole)).toHaveLength(0);

        for (const isolated of [
            road('disconnected', [[40, 70], [60, 70]]),
            road('bridge-alley', [[0, 70], [60, 70]], { bridge: 'yes' }),
            road('tunnel-alley', [[0, 70], [60, 70]], { tunnel: 'yes' })
        ]) {
            expect(deadEndProjections(preview(block, roads(isolated)))).toHaveLength(0);
        }
    });

    it('plans and restores the 80 m connector while retaining the 60 m alley approach', () => {
        const inputRoads = roads(road('left-alley', [[0, 70], [60, 70]]));
        const planned = subdivision.plan({ block, roads: inputRoads, options }, turf, model);
        const chosen = planned.layouts[0];
        expect(chosen.cuts.features).toHaveLength(1);
        const cut = chosen.cuts.features[0];
        expect(new Set([cut.properties.fromKind, cut.properties.toKind])).toEqual(new Set(['dead-end', 'dead-end-projection']));
        expect(cut.properties.lengthM).toBeCloseTo(80, 2);
        expect(cut.properties.splitPath).toHaveLength(3);
        expect(distance(local(cut.properties.splitPath[0]), [0, 70])).toBeLessThan(0.03);
        expect(distance(local(cut.properties.splitPath[1]), [60, 70])).toBeLessThan(0.03);
        expect(distance(local(cut.properties.splitPath[2]), [140, 70])).toBeLessThan(0.03);
        expect(chosen.pieces.features).toHaveLength(2);
        expect(chosen.pieces.features.every(piece => piece.properties.acceptable)).toBe(true);
        expect(chosen.stats.addedLengthM).toBeCloseTo(80, 2);

        const bbox = turf.bbox(block);
        const sharedUrl = links.build({
            baseUrl: 'https://example.test/path?lang=hr&backend=staging',
            city: 'explore', blockId: 'osm-block-a13f', bbox, targetSideM: 100,
            subdivision: { options, layout: chosen }
        });
        const parsed = links.parse(sharedUrl);
        expect(parsed.subdivision.cuts).toHaveLength(1);
        expect(new Set([parsed.subdivision.cuts[0].fromKind, parsed.subdivision.cuts[0].toKind]))
            .toEqual(new Set(['dead-end', 'dead-end-projection']));
        const restored = subdivision.restore({ block, subdivision: parsed.subdivision }, turf);
        const layout = restored.layouts[0];

        expect(layout.cuts.features).toHaveLength(1);
        expect(layout.cuts.features[0].properties.fromKind).toBe(cut.properties.fromKind);
        expect(layout.cuts.features[0].properties.toKind).toBe(cut.properties.toKind);
        expect(layout.cuts.features[0].properties.splitPath).toEqual(parsed.subdivision.cuts[0].path);
        expect(layout.cuts.features[0].properties.lengthM).toBeCloseTo(80, 1);
        expect(layout.stats.addedLengthM).toBeCloseTo(80, 1);
        expect(layout.pieces.features).toHaveLength(2);
        expect(layout.pieces.features.reduce((sum, piece) => sum + turf.area(piece), 0)).toBeCloseTo(turf.area(block), 1);
        expect(turf.intersect(layout.pieces.features[0], layout.pieces.features[1])).toBeNull();
    });
});
