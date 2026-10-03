// Verifies executable US source contracts, complete paging and durable row identity separately
// from display numbers; real parcel services can return different polygons with the same label.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createParcelSource, parcelSourceCatalog, parcelSourceForCity } from '../parcels/sources.js';
import { setupParcelSourcesRoute } from '../routes/parcel-sources.js';
import { computeBinding } from '../proposals/binding.js';

const samples = [
    { city: 'miami', nativeId: '{C9D13CB3-3718-4F70-B8BB-CA6F9FE127F4}', number: '0101120201070', center: [-80.1936, 25.7749] },
    { city: 'los_angeles', nativeId: '5149001915', number: '5149001915', center: [-118.2437, 34.0522] },
    { city: 'washington_dc', nativeId: '{1B157667-518C-4B56-9DFC-1DAEC1559EAB}', number: '0114E   0800', center: [-77.0425, 38.91025] }
];
const GUID2 = '{F8FE44A9-5C12-462B-9A17-2CC61B39E6FA}';
function polygon([x, y], delta = 0) {
    return { type: 'Polygon', coordinates: [[[x + delta, y], [x + delta + .0001, y], [x + delta + .0001, y + .0001], [x + delta, y + .0001], [x + delta, y]]] };
}
function feature(descriptor, objectId, nativeId, number, geometry) {
    return { type: 'Feature', properties: {
        OBJECTID: objectId, [descriptor.idField]: nativeId,
        ...(descriptor.parcelNumberField ? { [descriptor.parcelNumberField]: number } : {})
    }, geometry };
}
function response(features, exceededTransferLimit = false) {
    return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features, exceededTransferLimit }) };
}
afterEach(() => vi.unstubAllGlobals());

for (const sample of samples) describe(`${sample.city} live source`, () => {
    const descriptor = parcelSourceCatalog.sources.find(source => source.cityIds.includes(sample.city));
    const canonicalId = descriptor.idPrefix + sample.nativeId;
    const geometry = polygon(sample.center);
    const parcel = feature(descriptor, 10, sample.nativeId, sample.number, geometry);
    it('queries all pages in WGS84 and preserves native identity and display text', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(response([parcel], true)).mockResolvedValueOnce(response([]));
        const source = createParcelSource(descriptor, { fetchImpl });
        const [x, y] = sample.center;
        const result = await source.queryBounds([x - .001, y - .001, x + .001, y + .001]);
        expect(result.complete).toBe(true);
        expect(result.features[0]).toMatchObject({ id: canonicalId, properties: { sourceParcelId: sample.nativeId, parcelNumber: sample.number } });
        const urls = fetchImpl.mock.calls.map(([url]) => new URL(url));
        expect(urls.map(url => url.searchParams.get('resultOffset'))).toEqual(['0', '1']);
        urls.forEach(url => {
            expect(url.searchParams.get('outSR')).toBe('4326');
            expect(url.searchParams.get('orderByFields')).toBe('OBJECTID');
        });
        const evidence = JSON.parse(readFileSync(new URL(`../../world-parcels/${descriptor.evidenceFile}`, import.meta.url), 'utf8'));
        expect(evidence.sourceId).toBe(descriptor.id);
        expect(evidence.endpoint).toBe(descriptor.endpoint);
    });
    it('round-trips punctuation and leading zeros through the HTTP gateway and exact quoted SQL', async () => {
        const fetchImpl = vi.fn(async () => response([parcel]));
        const app = express();
        setupParcelSourcesRoute(app, { sources: [descriptor], fetchImpl });
        const res = await request(app).get(`/parcel-sources/${descriptor.id}`).query({ ids: canonicalId });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ complete: true, absentIds: [] });
        expect(res.body.features[0].id).toBe(canonicalId);
        expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('where')).toBe(`${descriptor.idField} IN ('${sample.nativeId}')`);
    });
    it('uses the configured source for authoritative proposal binding', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => response([parcel])));
        const db = { query: vi.fn(async () => { throw new Error('Live source binding must not query imported parcel tables'); }) };
        const { binding } = await computeBinding(db, { city: sample.city, site: geometry });
        expect(db.query).not.toHaveBeenCalled();
        expect(binding).toMatchObject({ coverage: 'complete', source: `server:${descriptor.id}` });
        expect(binding.parcels.map(item => item.parcelId)).toEqual([canonicalId]);
    });
});

describe('row identity and business labels', () => {
    it.each(['washington_dc', 'miami'])('keeps spatially distinct %s rows with the same display number', async city => {
        const { descriptor } = parcelSourceForCity(city);
        const sample = samples.find(row => row.city === city);
        const number = city === 'miami' ? '0101120201070' : '1223    0815';
        const rows = [
            feature(descriptor, 1, sample.nativeId, number, polygon(sample.center)),
            feature(descriptor, 2, GUID2, number, polygon(sample.center, .0002))
        ];
        const source = createParcelSource(descriptor, { fetchImpl: async () => response(rows) });
        const [x, y] = sample.center;
        const result = await source.queryBounds([x - .001, y - .001, x + .001, y + .001]);
        expect(result.features.map(row => row.id)).toEqual([descriptor.idPrefix + sample.nativeId, descriptor.idPrefix + GUID2]);
        expect(result.features.map(row => row.properties.parcelNumber)).toEqual([number, number]);
    });
    it('rejects a changed geometry under the same stable ID', async () => {
        const { descriptor } = parcelSourceForCity('washington_dc');
        const sample = samples.find(row => row.city === 'washington_dc');
        const rows = [
            feature(descriptor, 1, sample.nativeId, sample.number, polygon(sample.center)),
            feature(descriptor, 2, sample.nativeId, sample.number, polygon(sample.center, .0002))
        ];
        const source = createParcelSource(descriptor, { fetchImpl: async () => response(rows) });
        await expect(source.queryBounds([-77.0435, 38.9095, -77.0415, 38.911])).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });
    it('falls back to the stable ID for a missing display number without changing identity', async () => {
        const { descriptor } = parcelSourceForCity('washington_dc');
        const sample = samples.find(row => row.city === 'washington_dc');
        const source = createParcelSource(descriptor, { fetchImpl: async () => response([feature(descriptor, 1, sample.nativeId, null, polygon(sample.center))]) });
        const result = await source.queryIds([descriptor.idPrefix + sample.nativeId]);
        expect(result.features[0].properties.parcelNumber).toBe(sample.nativeId);
        expect(result.features[0].id).toBe(descriptor.idPrefix + sample.nativeId);
    });
});
