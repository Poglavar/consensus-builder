// The browser's direct DGU cadastre reader (frontend/js/parcels/dgu-live.js), used when our server
// cannot serve Croatian parcels: id filters, our server's property shape, paging, and the
// footprint take/coverage the /parcels/under endpoint would have answered.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const dgu = require('../../frontend/js/parcels/dgu-live.js');

// Test geometry stays in WGS84 on both sides: an identity "projection" keeps the arithmetic visible.
const identity = collection => collection;
const box = ([w, s, e, n]) => [w, s, e, n].join(',');
const square = (x, y, d) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const raw = (ko, number, geometry, cestica) => ({ type: 'Feature', id: `DKP_CESTICE.${cestica}`, geometry,
    properties: { CESTICA_ID: cestica, MATICNI_BROJ_KO: ko, BROJ_CESTICE: number, IZVORNO_MJERILO: 1000, GEOM: geometry } });

describe('DGU id filters', () => {
    it('finds HR-<KO>-<number> by both fields and HR-<id> by CESTICA_ID', () => {
        expect(dgu.idClause('HR-335649-5472/5')).toBe('<And><PropertyIsEqualTo><PropertyName>MATICNI_BROJ_KO</PropertyName><Literal>335649</Literal></PropertyIsEqualTo>'
            + '<PropertyIsEqualTo><PropertyName>BROJ_CESTICE</PropertyName><Literal>5472/5</Literal></PropertyIsEqualTo></And>');
        expect(dgu.idClause('HR-37733738')).toBe('<PropertyIsEqualTo><PropertyName>CESTICA_ID</PropertyName><Literal>37733738</Literal></PropertyIsEqualTo>');
        expect(dgu.idClause('BA-12')).toBeNull();
        const url = new URL(dgu.idsUrl(['HR-335649-5472/5', 'HR-335649-1']));
        expect(url.searchParams.get('FILTER')).toMatch(/^<Filter><Or><And>.*<\/And><And>.*<\/And><\/Or><\/Filter>$/);
        expect(url.searchParams.get('typeName')).toBe('oss:DKP_CESTICE');
        expect(url.searchParams.get('token')).toBeTruthy();
        expect(dgu.idsUrl(['BA-12'])).toBeNull();
    });
});

describe('DGU features in our server\'s shape', () => {
    it('keeps the register keys as strings and builds the parcel id', () => {
        const feature = dgu.toParcelFeature(raw(335649, '5472/5', square(0, 0, 1), 37733738));
        expect(feature.properties).toEqual({ CESTICA_ID: '37733738', BROJ_CESTICE: '5472/5', MATICNI_BROJ_KO: '335649',
            parcelId: 'HR-335649-5472/5', groundSource: 'dgu-live' });
        expect(dgu.toParcelFeature({ type: 'Feature', geometry: square(0, 0, 1), properties: {} })).toBeNull();
    });

    it('falls back when our server is down or failing, never on its refusals or a cancelled request', () => {
        expect(dgu.shouldFallBack(Object.assign(new Error('down'), { status: 502, code: 'parcel-source-unavailable' }))).toBe(true);
        expect(dgu.shouldFallBack(Object.assign(new Error('timed out'), { status: 504 }))).toBe(true);
        expect(dgu.shouldFallBack(new TypeError('Failed to fetch'))).toBe(true);
        // Our server answered about the request itself: too many parcels, too big or invalid a shape.
        expect(dgu.shouldFallBack(Object.assign(new Error('The geometry covers 59311 parcels, over the 5000 limit.'), { status: 413 }))).toBe(false);
        expect(dgu.shouldFallBack(Object.assign(new Error('extent too large'), { status: 400 }))).toBe(false);
        const aborted = new AbortController();
        aborted.abort();
        expect(dgu.shouldFallBack(new Error('x'), aborted.signal)).toBe(false);
        expect(dgu.shouldFallBack(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    });
});

describe('createDguLive', () => {
    it('dispatches the browser fallback through a configured source with public metadata only', async () => {
        const runtime = require('../../frontend/js/source-runtime.js');
        const family = runtime.catalogue().abstractions.find(entry => entry.id === 'parcels');
        const source = family.sources.find(entry => entry.id === 'dgu-live-cadastre');
        expect(source).toMatchObject({ abstraction: 'parcels', adapter: 'dgu-live', kind: 'default',
            config: { endpoint: dgu.WFS_URL, typeName: 'oss:DKP_CESTICE', srsName: 'EPSG:3765' } });
        expect(Object.keys(source.config).sort()).toEqual(['endpoint', 'id', 'srsName', 'typeName']);
        expect(family.adapters.find(entry => entry.id === source.adapter)).toMatchObject({
            custom: false, required: ['fetchBbox', 'fetchIds', 'fetchUnder']
        });
        const requestJson = vi.fn(async () => ({ features: [raw(1, '1', square(0, 0, 1), 1)] }));
        const reader = dgu.createDguLive({ requestJson, toWgs84: identity, toDatasetBox: box, turf });
        expect(Object.keys(reader).sort()).toEqual(['fetchBbox', 'fetchIds', 'fetchUnder']);
        expect((await reader.fetchIds(['HR-1-1']))[0].properties.parcelId).toBe('HR-1-1');
        expect(requestJson).toHaveBeenCalledOnce();
        expect(new URL(requestJson.mock.calls[0][0]).searchParams.get('token')).toBeTruthy();
    });

    it('pages a box until the register says it has given every parcel', async () => {
        const asked = [];
        const pages = [
            { features: [raw(1, '1', square(0, 0, 1), 1), raw(1, '2', square(1, 0, 1), 2)], totalFeatures: 3 },
            { features: [raw(1, '3', square(2, 0, 1), 3)], totalFeatures: 3 }
        ];
        const reader = dgu.createDguLive({ requestJson: async url => { asked.push(new URL(url).searchParams.get('startIndex')); return pages.shift(); },
            toWgs84: identity, toDatasetBox: box, turf });
        const features = await reader.fetchBbox('0,0,3,1');
        expect(features.map(f => f.properties.parcelId)).toEqual(['HR-1-1', 'HR-1-2', 'HR-1-3']);
        expect(asked).toEqual(['0', '2']);
    });

    it('refuses an area over the parcel limit after its first page instead of reading it all', async () => {
        const requestJson = vi.fn(async () => ({ features: [raw(1, '1', square(0, 0, 1), 1)], totalFeatures: dgu.MAX_PARCELS + 1 }));
        const reader = dgu.createDguLive({ requestJson, toWgs84: identity, toDatasetBox: box, turf });
        await expect(reader.fetchBbox('0,0,9,9')).rejects.toMatchObject({ status: 413, code: 'parcel-area-too-large' });
        expect(requestJson).toHaveBeenCalledTimes(1);
    });

    it('answers a footprint with the parcels it takes area from and how much of it they cover', async () => {
        // Two unit parcels side by side; the footprint takes half of each, and a third parcel only touches it.
        const reader = dgu.createDguLive({
            requestJson: async () => ({ features: [raw(1, '1', square(0, 0, 0.001), 1), raw(1, '2', square(0.001, 0, 0.001), 2),
                raw(1, '3', square(0.0025, 0, 0.001), 3)], totalFeatures: 3 }),
            toWgs84: identity, toDatasetBox: box, turf
        });
        const footprint = { type: 'Polygon', coordinates: [[[0.0005, 0], [0.0015, 0], [0.0015, 0.001], [0.0005, 0.001], [0.0005, 0]]] };
        const answer = await reader.fetchUnder(footprint);
        expect(answer.features.map(f => f.properties.parcelId)).toEqual(['HR-1-1', 'HR-1-2']);
        const half = turf.area(turf.feature(footprint)) / 2;
        answer.features.forEach(f => expect(f.properties.taken_m2).toBeCloseTo(half, 0));
        expect(answer.coverage).toBeCloseTo(1, 3);
    });
});
