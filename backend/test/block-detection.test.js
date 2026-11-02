import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';

const require = createRequire(import.meta.url);
const turf = turfModule.default || turfModule;
const model = require('../../frontend/js/urban-blocks-model.js');
const detection = require('../../frontend/js/parcels/block-detection.js');
const seed = turf.polygon([[[0.0045, 0.0045], [0.0055, 0.0045], [0.0055, 0.0055], [0.0045, 0.0055], [0.0045, 0.0045]]], { parcelId: 'seed' });
const roadsFor = tag => turf.featureCollection([
    [[0, 0], [0.01, 0]], [[0.01, 0], [0.01, 0.01]],
    [[0.01, 0.01], [0, 0.01]], [[0, 0.01], [0, 0]]
].map((coordinates, index) => ({ type: 'Feature', id: `${tag}-${index}`, properties: { ...tag, name: null },
    geometry: { type: 'LineString', coordinates } })));
const parcel = (id, x, y, width = 0.0002) => turf.polygon([[
    [x, y], [x + width, y], [x + width, y + width], [x, y + width], [x, y]
]], { parcelId: id });

async function run({ boundaryTag = { railway: 'rail' }, features = [seed], complete = true, boundaryComplete = true, extra = {} } = {}) {
    const fetchBoundaries = vi.fn(async () => ({ complete: boundaryComplete, features: roadsFor(boundaryTag).features }));
    const loadParcels = vi.fn(async () => ({ complete, features }));
    const result = await detection.detect({ seed, turf, model, limit: 100, fetchBoundaries, loadParcels,
        isCorridor: feature => feature.properties?.isCorridor === true
            || feature.properties?.isRoad === true || feature.properties?.isTrack === true, ...extra });
    return { result, fetchBoundaries, loadParcels };
}

describe('bounded source-enclosure parcel detection', () => {
    it.each([
        ['rail', { railway: 'rail' }],
        ['stream', { waterway: 'stream' }]
    ])('uses %s enclosure geometry and loads complete parcel ground', async (_name, boundaryTag) => {
        const second = parcel('second', 0.006, 0.006);
        const corridor = { ...parcel('road-parcel', 0.008, 0.008), properties: { parcelId: 'road-parcel', isRoad: true } };
        const { result, fetchBoundaries, loadParcels } = await run({ boundaryTag, features: [seed, second, corridor] });

        expect(fetchBoundaries).toHaveBeenCalled();
        expect(loadParcels).toHaveBeenCalledTimes(1);
        expect(result.isValid).toBe(true);
        expect(result.ids).toEqual(['seed', 'second']);
        expect(result.enclosure.geometry.type).toBe('Polygon');
    });

    it('returns exactly 100 preview IDs, with no selected IDs, when the enclosure is over the cap', async () => {
        const parcels = [seed];
        for (let row = 0; row < 10; row++) for (let col = 0; col < 11; col++) {
            parcels.push(parcel(`p-${String(row * 11 + col).padStart(3, '0')}`,
                0.0005 + col * 0.0008, 0.0005 + row * 0.0008));
        }
        const { result } = await run({ features: parcels });

        expect(result).toMatchObject({ isValid: false, invalidReason: 'parcel_limit_exceeded', count: 111, ids: [] });
        expect(result.previewIds).toHaveLength(100);
        expect(result.previewIds[0]).toBe('seed');
        expect(new Set(result.previewIds).size).toBe(100);
    });

    it('fails incomplete boundary or parcel coverage and reports an unbounded seed distinctly', async () => {
        await expect(run({ boundaryComplete: false })).rejects.toMatchObject({ code: 'block-boundaries-incomplete' });
        await expect(run({ complete: false })).rejects.toMatchObject({ code: 'block-parcels-incomplete' });

        const empty = async () => ({ complete: true, features: [] });
        const unbounded = await detection.detect({ seed, turf, model, limit: 100,
            fetchBoundaries: empty, loadParcels: vi.fn() });
        expect(unbounded).toMatchObject({ isValid: false, invalidReason: 'unbounded', ids: [], previewIds: [] });
    });
});
