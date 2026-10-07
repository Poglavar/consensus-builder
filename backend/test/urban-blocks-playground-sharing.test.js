// Headless contracts for candidate previews, deterministic layout sharing and geometric restore.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';

const require = createRequire(import.meta.url);
const turf = turfModule.default || turfModule;
const subdivision = require('../../frontend/js/urban-blocks-subdivision.js');
const links = require('../../frontend/js/urban-blocks-links.js');

const METRES_PER_DEGREE = 111_195;
const ll = ([x, y]) => [x / METRES_PER_DEGREE, y / METRES_PER_DEGREE];
const road = (id, points, properties = {}) => ({
    type: 'Feature', id,
    properties: { highway: 'residential', ...properties },
    geometry: { type: 'LineString', coordinates: points.map(ll) }
});
const block = turf.polygon([[ll([0, 0]), ll([140, 0]), ll([140, 140]), ll([0, 140]), ll([0, 0])]]);
const roads = turf.featureCollection([
    // Curved alley reaches an interior dead end and connects to a T junction on the far side.
    road('alley', [[0, 70], [25, 70], [50, 60], [70, 60]]),
    road('right-boundary', [[140, 0], [140, 140]]),
    road('right-tee', [[190, 70], [140, 70]])
]);
const options = { targetAreaM2: 10000, maxSideM: 150, perimeterStepM: 150 };
const linkBase = {
    baseUrl: 'https://example.test/path?lang=hr&backend=staging',
    city: 'explore', blockId: 'osm-block-a13f', bbox: turf.bbox(block), targetSideM: 100
};

afterEach(() => vi.restoreAllMocks());

function previewKindsAndPoints(preview, kind) {
    return preview.candidates.features.filter(feature => feature.properties.kind === kind)
        .map(feature => feature.geometry.coordinates);
}

describe('urban block subdivision playground sharing', () => {
    it('always generates every preview category; visibility flags do not filter candidates', () => {
        const planSpy = vi.spyOn(subdivision, 'plan');
        const hidden = subdivision.preview({ block, roads, options: {
            ...options, showTJunctions: false, showDeadEnds: false, showPerimeter: false
        } }, turf, require('../../frontend/js/urban-blocks-model.js'));
        const visible = subdivision.preview({ block, roads, options: {
            ...options, showTJunctions: true, showDeadEnds: true, showPerimeter: true
        } }, turf, require('../../frontend/js/urban-blocks-model.js'));

        expect(new Set(hidden.candidates.features.map(feature => feature.properties.kind)))
            .toEqual(new Set(['t', 'dead-end', 'dead-end-projection', 'perimeter']));
        expect(hidden).toEqual(visible);
        expect(hidden.stats).toMatchObject({ tCount: 1, deadEndCount: 1, deadEndProjectionCount: 1 });
        expect(hidden.stats.fallbackCount).toBeGreaterThan(0);
        expect(planSpy).not.toHaveBeenCalled();
    });

    it('keeps natural preview points stable while perimeter spacing moves fallback points', () => {
        const model = require('../../frontend/js/urban-blocks-model.js');
        const sparse = subdivision.preview({ block, roads, options: { ...options, perimeterStepM: 50 } }, turf, model);
        const wide = subdivision.preview({ block, roads, options: { ...options, perimeterStepM: 300 } }, turf, model);

        expect(previewKindsAndPoints(sparse, 't')).toEqual(previewKindsAndPoints(wide, 't'));
        expect(previewKindsAndPoints(sparse, 'dead-end')).toEqual(previewKindsAndPoints(wide, 'dead-end'));
        expect(previewKindsAndPoints(sparse, 'dead-end-projection')).toEqual(previewKindsAndPoints(wide, 'dead-end-projection'));
        expect(previewKindsAndPoints(sparse, 'perimeter')).not.toEqual(previewKindsAndPoints(wide, 'perimeter'));
    });

    it('round-trips a chosen curved dead-end layout without running the search again', () => {
        const model = require('../../frontend/js/urban-blocks-model.js');
        const planSpy = vi.spyOn(subdivision, 'plan');
        const planned = subdivision.plan({ block, roads, options }, turf, model);
        const chosen = planned.layouts[0];
        expect(chosen.cuts.features.some(cut => cut.properties.fromKind === 'dead-end'
            || cut.properties.toKind === 'dead-end')).toBe(true);

        const url = links.build({ ...linkBase, subdivision: { options, layout: chosen } });
        const parsed = links.parse(url);
        expect(parsed).toMatchObject({ blockId: linkBase.blockId, subdivision: { options } });
        expect(parsed.subdivision.cuts).toHaveLength(chosen.cuts.features.length);

        const restored = subdivision.restore({ block, subdivision: parsed.subdivision }, turf);
        expect(planSpy).toHaveBeenCalledTimes(1);
        expect(restored.stats).toEqual({ restored: true });
        expect(restored.layouts).toHaveLength(1);
        const layout = restored.layouts[0];
        expect(layout.pieces.features).toHaveLength(chosen.pieces.features.length);
        expect(layout.cuts.features).toHaveLength(chosen.cuts.features.length);
        expect(Math.abs(layout.stats.addedLengthM - chosen.stats.addedLengthM)).toBeLessThanOrEqual(0.02);
        expect(layout.pieces.features.reduce((sum, piece) => sum + turf.area(piece), 0))
            .toBeCloseTo(turf.area(block), 1);

        for (let i = 0; i < chosen.cuts.features.length; i++) {
            const source = chosen.cuts.features[i].properties;
            const shared = parsed.subdivision.cuts[i];
            const result = layout.cuts.features[i].properties;
            expect(shared.connectorIndex).toBe(source.connectorIndex);
            expect(shared.fromKind).toBe(source.fromKind);
            expect(shared.toKind).toBe(source.toKind);
            expect(shared.path).toHaveLength(source.splitPath.length);
            shared.path.forEach((point, index) => {
                expect(Math.abs(point[0] - source.splitPath[index][0]) * METRES_PER_DEGREE).toBeLessThanOrEqual(0.01);
                expect(Math.abs(point[1] - source.splitPath[index][1]) * METRES_PER_DEGREE).toBeLessThanOrEqual(0.01);
            });
            expect(result.connectorIndex).toBe(source.connectorIndex);
            expect(Math.abs(result.lengthM - source.lengthM)).toBeLessThanOrEqual(0.02);
            expect(result.splitPath).toEqual(shared.path);
        }
    });

    it('shares and restores a valid empty layout without changing the plain-link shape', () => {
        const emptyLayout = { cuts: turf.featureCollection([]) };
        const sharedUrl = links.build({ ...linkBase, subdivision: { options, layout: emptyLayout } });
        const parsedShared = links.parse(sharedUrl);
        expect(parsedShared.subdivision).toEqual({ options, cuts: [] });
        expect(subdivision.restore({ block, subdivision: parsedShared.subdivision }, turf).layouts[0].cuts.features)
            .toHaveLength(0);

        const plainUrl = links.build(linkBase);
        expect(links.parse(plainUrl)).toEqual({
            blockId: linkBase.blockId, bbox: linkBase.bbox, targetSideM: 100, city: linkBase.city
        });
    });

    it('shares area caps directly and converts previously issued square-size links on arrival', () => {
        for (const targetAreaM2 of [1000, 5625, 15000, 50000]) {
            const settings = { ...options, targetAreaM2 };
            const url = links.build({ ...linkBase, subdivision: { options: settings, layout: { cuts: turf.featureCollection([]) } } });
            const payload = JSON.parse(new URLSearchParams(new URL(url).hash.slice(1)).get('splits'));
            expect(payload.slice(0, 2)).toEqual([2, [targetAreaM2, 150, 150]]);
            expect(links.parse(url).subdivision.options).toEqual(settings);
        }
        const previous = new URL(links.build(linkBase));
        previous.hash = new URLSearchParams({ splits: JSON.stringify([1, [75, 150, 150], []]) }).toString();
        const decoded = links.parse(previous.toString());
        expect(decoded.subdivision.options).toEqual({ targetAreaM2: 5625, maxSideM: 150, perimeterStepM: 150 });
        expect(subdivision.restore({ block, subdivision: decoded.subdivision }, turf).layouts[0].pieces.features[0].properties.acceptable).toBe(false);
    });

    it('keeps valid block identity while rejecting malformed sharing payloads', () => {
        const plain = new URL(links.build(linkBase));
        const malformed = [
            '[1,[125,150,150],[]]',
            '[2,[100,150,150],[]]',
            '[2,[50125,150,150],[]]',
            '[2,[10001,150,150],[]]',
            '[3,[10000,150,150],[]]',
            JSON.stringify([1, [100, 150, 150], Array.from({ length: 49 }, () => [2, 2, 0, [0, 0, 1, 1]])]),
            JSON.stringify([1, [100, 150, 150], [[2, 2, 0, Array(1026).fill(0)]]]),
            JSON.stringify([1, [100, 150, 150], [[2, 2, 0, [-2, 0, 0, 1]]]]),
            JSON.stringify([1, [100, 150, 150], [[2, 2, 0, [0, 0, null, 1]]]]),
            JSON.stringify([1, [100, 150, 150], [[8, 2, 0, [0, 0, 1, 1]]]]),
            '{not-json'
        ];
        for (const payload of malformed) {
            const url = new URL(plain);
            url.hash = new URLSearchParams({ splits: payload }).toString();
            expect(links.parse(url.toString())).toMatchObject({
                blockId: linkBase.blockId, bbox: linkBase.bbox, subdivision: null, subdivisionError: true
            });
        }
    });

    it('rejects malformed build layouts and invalid restored split paths', () => {
        const malformedLayout = { cuts: turf.featureCollection([
            { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { fromKind: 'unknown' } }
        ]) };
        expect(() => links.build({ ...linkBase, subdivision: { options, layout: malformedLayout } })).toThrow();

        const invalidCuts = [
            [{ fromKind: 'unknown', toKind: 't', connectorIndex: 0, path: [ll([0, 70]), ll([140, 70])] }],
            [{ fromKind: 't', toKind: 't', connectorIndex: 0, path: [ll([0, 70]), ll([70, 90]), ll([0, 70])] }],
            [{ fromKind: 't', toKind: 't', connectorIndex: 0, path: [ll([0, 20]), ll([100, 120]), ll([40, 120]), ll([100, 40]), ll([140, 20])] }],
            [{ fromKind: 't', toKind: 't', connectorIndex: 0, path: [[NaN, 0], ll([140, 70])] }],
            Array.from({ length: 49 }, () => ({ fromKind: 't', toKind: 't', connectorIndex: 0, path: [ll([0, 70]), ll([140, 70])] }))
        ];
        for (const cuts of invalidCuts) {
            expect(() => subdivision.restore({ block, subdivision: { options, cuts } }, turf)).toThrow();
        }
    });
});
