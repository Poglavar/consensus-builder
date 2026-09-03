// Creation-time connectivity expands every MultiPolygon before testing the selection graph. A
// single feature entry is not proof that the ground is one place.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const { areParcelsContiguous } = require('../../frontend/js/proposals/reparcel.js');

const ring = (west, south, east, north) => [
    [west, south], [east, south], [east, north], [west, north], [west, south]
];

let previousTurf;

beforeEach(() => {
    previousTurf = globalThis.turf;
    globalThis.turf = turf;
});

afterEach(() => {
    if (previousTurf === undefined) delete globalThis.turf;
    else globalThis.turf = previousTurf;
});

describe('parcel selection contiguity', () => {
    it('rejects two distant polygons even when they arrive as one selected feature', () => {
        const selected = {
            type: 'Feature',
            properties: { parcelId: 'HR-330264-641' },
            geometry: {
                type: 'MultiPolygon',
                coordinates: [
                    [ring(15.87, 43.74, 15.871, 43.741)],
                    [ring(15.88, 43.75, 15.881, 43.751)]
                ]
            }
        };

        expect(areParcelsContiguous([selected])).toEqual(expect.objectContaining({
            contiguous: false,
            components: 2,
            connectedCount: 1
        }));
    });

    it('keeps a polygon with a courtyard hole as one connected area', () => {
        const selected = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [
                    ring(15.87, 43.74, 15.88, 43.75),
                    ring(15.873, 43.743, 15.875, 43.745)
                ]
            }
        };

        expect(areParcelsContiguous([selected])).toEqual({ contiguous: true, components: 1 });
    });

    it('accepts neighbouring parcel features as one connected selection', () => {
        const west = turf.polygon([ring(15.87, 43.74, 15.871, 43.741)]);
        const east = turf.polygon([ring(15.871, 43.74, 15.872, 43.741)]);

        expect(areParcelsContiguous([west, east], { bufferMeters: 0 })).toEqual(expect.objectContaining({
            contiguous: true,
            components: 2,
            connectedCount: 2
        }));
    });
});
