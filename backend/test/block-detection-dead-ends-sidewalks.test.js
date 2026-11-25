// "Select whole block": a street mapped a few metres short of the next way still divides blocks, and a
// sidewalk, footpath or driveway touching a lot does not make it street ground.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';

const require = createRequire(import.meta.url);
const turf = turfModule.default || turfModule;
const model = require('../../frontend/js/urban-blocks-model.js');
const detection = require('../../frontend/js/parcels/block-detection.js');
const M = 1 / 111320; // degrees per metre near the equator
const at = ([x, y]) => [x * M, y * M];
const way = (id, points, properties = { highway: 'residential' }) => ({ type: 'Feature', id, properties, geometry: { type: 'LineString', coordinates: points.map(at) } });
const lot = (id, x0, y0, x1, y1) => turf.polygon([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(at)], { parcelId: id });

// A 100 × 100 m loop of streets, and a middle street from the east side that stops `gapM` short of
// the west side. Lots south of it and one lot north of it.
function fixture(gapM, extra = []) {
    const loop = way('loop', [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]);
    const middle = way('middle', [[100, 50], [gapM, 50]]);
    return {
        boundaries: { complete: true, features: [loop, middle, ...extra] },
        lots: [lot('south-a', 5, 5, 50, 45), lot('south-b', 50, 5, 95, 45), lot('north', 5, 55, 95, 95)]
    };
}

async function block(f, seedId = 'south-a') {
    return detection.detect({ seed: f.lots.find(l => l.properties.parcelId === seedId), turf, model, limit: 100,
        fetchBoundaries: async () => f.boundaries,
        loadParcels: async () => ({ complete: true, features: f.lots }) });
}

describe('block enclosure with a street mapped short of the next way', () => {
    it('closes a street that stops 3.4 m short, so the lots across it are another block', async () => {
        const result = await block(fixture(3.4));
        expect(result.ids.slice().sort()).toEqual(['south-a', 'south-b']);
    });

    it('leaves a cul-de-sac that ends well inside the block open', async () => {
        const result = await block(fixture(40));
        expect(result.ids.slice().sort()).toEqual(['north', 'south-a', 'south-b']);
    });
});

describe('ways that touch a lot without taking it', () => {
    it.each(['footway', 'path', 'steps', 'cycleway'])('keeps the lots a %s cuts across from street to street', async highway => {
        // A sidewalk mapped 8 m inside the south street, through the south lots' frontage.
        const f = fixture(3.4, [way('sidewalk', [[0, 8], [100, 8]], { highway })]);
        expect((await block(f)).ids.slice().sort()).toEqual(['south-a', 'south-b']);
    });

    it('keeps a lot a driveway runs into', async () => {
        const f = fixture(3.4, [way('driveway', [[70, 0], [70, 20]], { highway: 'service' })]);
        expect((await block(f)).ids.slice().sort()).toEqual(['south-a', 'south-b']);
    });

    it('still treats a lot a street runs into as street ground', async () => {
        const f = fixture(3.4, [way('spur', [[30, 0], [30, 20]])]);
        const result = await block(f, 'south-b');
        expect(result.ids).toEqual(['south-b']);
    });
});
