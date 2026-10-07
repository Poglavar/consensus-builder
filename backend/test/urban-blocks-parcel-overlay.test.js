import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';

const turf = turfModule.default || turfModule;
const model = createRequire(import.meta.url)('../../frontend/js/urban-blocks-model.js');
const square = (id, bbox) => ({ ...turf.bboxPolygon(bbox), id });
const block = square('block', [0, 0, 10, 10]);
block.geometry.coordinates.push([[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]]);

describe('loaded cadastral borders in an urban block', () => {
    it('includes intersecting and spanning parcels but excludes a courtyard, distant geometry and non-polygons', () => {
        const crossing = square('crossing', [-10, 1, 1, 2]);
        const multi = turf.multiPolygon([
            square('inside-part', [8, 8, 9, 9]).geometry.coordinates,
            square('outside-part', [20, 20, 21, 21]).geometry.coordinates
        ]);
        multi.id = 'multi';
        const parcels = [square('inside', [1, 1, 2, 2]), crossing, multi,
            square('courtyard', [4.2, 4.2, 5.8, 5.8]), square('distant', [11, 1, 12, 2]), turf.point([2, 2])];
        const before = JSON.stringify({ block, parcels });
        const result = model.parcelsInBlock(block, parcels, turf);
        expect(result.features.map(parcel => parcel.id)).toEqual(['inside', 'crossing', 'multi']);
        expect(turf.booleanPointInPolygon(turf.pointOnFeature(crossing), block)).toBe(false);
        expect(JSON.stringify({ block, parcels })).toBe(before);
        expect(result.features[1]).toBe(crossing);
    });

    it('does not require cadastral data to inspect a block', () => {
        expect(model.parcelsInBlock(block, [], turf)).toEqual(turf.featureCollection([]));
    });
});
