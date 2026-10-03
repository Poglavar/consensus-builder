// Tests passthrough providers and proves source conditions never gate canonical reads or binding.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { parcelSourceForCity } from '../parcels/sources.js';
import { setupParcelSourcesRoute } from '../routes/parcel-sources.js';
import { computeBinding } from '../proposals/binding.js';

const samples = [
    { city: 'bamako', id: '00103010001', lat: 12.6765, lon: -8.04225, metricSrid: 32629 },
    { city: 'luanda', id: '11111111-2222-3333-4444-555555555555', lat: -8.83675, lon: 13.234, metricSrid: 32733 },
    { city: 'lima', id: '{11111111-2222-3333-4444-555555555555}', lat: -12.015, lon: -76.96825, metricSrid: 32718 }
];
function rawParcel(descriptor, sample) {
    const { lat, lon } = sample;
    return { type: 'Feature', id: 'fixture.1', properties: {
        OBJECTID: 1, [descriptor.idField]: sample.id,
        ...(descriptor.parcelNumberField ? { [descriptor.parcelNumberField]: 42 } : {})
    }, geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + .0001, lat],
        [lon + .0001, lat + .0001], [lon, lat + .0001], [lon, lat]]] } };
}
const response = raw => ({ ok: true, status: 200, json: async () => ({ type: 'FeatureCollection',
    features: [raw], totalFeatures: 1, numberMatched: 1, numberReturned: 1, exceededTransferLimit: false }) });
afterEach(() => vi.unstubAllGlobals());
describe.each(samples)('$city passthrough provider', sample => {
    it.each([undefined, 'Reuse conditions unconfirmed', 'Commercial reuse restricted'])('serves complete native-ID reads regardless of notice: %s', async licenceNote => {
        const { descriptor } = parcelSourceForCity(sample.city);
        const configured = { ...descriptor, licenceNote, licenceUrl: undefined };
        const raw = rawParcel(configured, sample);
        const fetchImpl = vi.fn(async () => response(raw));
        const app = express();
        setupParcelSourcesRoute(app, { sources: [configured], fetchImpl });
        const id = configured.idPrefix + sample.id;
        const result = await request(app).get(`/parcel-sources/${configured.id}`).query({ ids: id });
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ complete: true, absentIds: [], returnsWGS84: true });
        expect(result.body.features[0]).toMatchObject({ id, properties: { sourceParcelId: sample.id } });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });
    it('uses the same provider and city metric CRS for binding without imported parcel tables', async () => {
        const { descriptor } = parcelSourceForCity(sample.city);
        expect(descriptor.metricSrid).toBe(sample.metricSrid);
        const raw = rawParcel(descriptor, sample);
        vi.stubGlobal('fetch', vi.fn(async url => {
            const params = new URL(url).searchParams;
            if (params.has('returnCountOnly')) return { ok: true, json: async () => ({ count: 1 }) };
            if (params.has('returnIdsOnly')) return { ok: true, json: async () => ({ objectIdFieldName: 'OBJECTID', objectIds: [1] }) };
            return response(raw);
        }));
        const db = { query: vi.fn(async () => { throw new Error('unexpected parcel database read'); }) };
        const { binding } = await computeBinding(db, { city: sample.city, site: raw.geometry });
        expect(db.query).not.toHaveBeenCalled();
        expect(binding).toMatchObject({ coverage: 'complete', source: `server:${descriptor.id}` });
        expect(binding.parcels.map(p => p.parcelId)).toContain(descriptor.idPrefix + sample.id);
    });
});
