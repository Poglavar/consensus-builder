// Checks native identity, status and metric binding across provider protocols through one parcel gateway.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createParcelSource, parcelSourceCatalog } from '../parcels/sources.js';
import { setupParcelSourcesRoute } from '../routes/parcel-sources.js';
import { computeBinding } from '../proposals/binding.js';

const samples = [
    { city: 'hong_kong', nativeId: 1800293576, number: 'KIL 11119 S.C', center: [114.1838, 22.315] },
    { city: 'berlin', nativeId: '11000181900016____', number: '11000181900016____', center: [13.405, 52.52] },
    { city: 'antwerp', nativeId: 4455664, number: '11811L3512/00S000', center: [4.401, 51.211] },
    { city: 'amsterdam', nativeId: '11460432670000', number: '4326', center: [4.9000, 52.3725] },
    { city: 'paris', nativeId: '75105000AD0011', number: '0011', center: [2.3556, 48.8491] },
    { city: 'melbourne', nativeId: '152244627', number: '1\\TP536413', center: [145.059, -37.8308] },
    { city: 'cape_town', nativeId: 'C0160007000951650000000000', number: '95165', center: [18.4194, -33.9258] }
];
function fixture(descriptor, sample, oid = 1) {
    const [x, y] = sample.center;
    return { type: 'Feature', id: `parcel.${oid}`, properties: {
        OBJECTID: oid, [descriptor.idField]: sample.nativeId,
        ...(descriptor.idNamespace ? { [descriptor.idNamespace.field]: descriptor.idNamespace.value } : {}),
        [descriptor.parcelNumberField]: sample.number,
        ...Object.fromEntries(Object.entries(descriptor.attributeFilters || {}).map(([field, value]) =>
            [field, Array.isArray(value) ? value[0] : value]))
    }, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + .0001, y], [x + .0001, y + .0001], [x, y + .0001], [x, y]]] } };
}
function response(features, more = false, matched = features.length) {
    return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features,
        links: [], totalFeatures: matched, properties: { exceededTransferLimit: more }, numberMatched: matched, numberReturned: features.length }) };
}
afterEach(() => vi.unstubAllGlobals());
for (const sample of samples) describe(`${sample.city} source contract`, () => {
    const descriptor = parcelSourceCatalog.sources.find(s => s.cityId === sample.city);
    const parcel = fixture(descriptor, sample);
    const id = descriptor.idPrefix + sample.nativeId;
    it('round-trips native identity and a separate display label through the HTTP gateway', async () => {
        const fetchImpl = vi.fn(async () => response([parcel]));
        const app = express(); setupParcelSourcesRoute(app, { sources: [descriptor], fetchImpl });
        const res = await request(app).get(`/parcel-sources/${descriptor.id}`).query({ ids: id });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ complete: true, absentIds: [], returnsWGS84: true });
        expect(res.body.features[0]).toMatchObject({ id, properties: { sourceParcelId: String(sample.nativeId), parcelNumber: sample.number } });
        const params = new URL(fetchImpl.mock.calls[0][0]).searchParams;
        const filter = params.get(descriptor.adapter === 'wfs' ? 'cql_filter' : descriptor.adapter === 'ogc-api' ? 'filter' : 'where');
        expect(filter).toContain(`${descriptor.idField} IN (${descriptor.idType === 'integer' ? sample.nativeId : `'${sample.nativeId}'`})`);
        for (const [field, value] of Object.entries(descriptor.attributeFilters || {})) {
            expect(filter).toContain(Array.isArray(value) ? `${field} IN (${value.map(v => `'${v}'`).join(',')})` : `${field} = '${value}'`);
        }
        const evidence = JSON.parse(readFileSync(new URL(`../../world-parcels/${descriptor.evidenceFile}`, import.meta.url), 'utf8'));
        expect(evidence).toMatchObject({ sourceId: descriptor.id, endpoint: descriptor.endpoint });
    });
    it('binds a real coordinate footprint with the provider metric CRS and no parcel database', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => response([parcel])));
        const db = { query: vi.fn(async () => { throw new Error('Live source must not read imported parcels'); }) };
        const { binding } = await computeBinding(db, { city: sample.city, site: parcel.geometry });
        expect(db.query).not.toHaveBeenCalled();
        expect(binding).toMatchObject({ coverage: 'complete', source: `server:${descriptor.id}` });
        expect(binding.parcels.map(p => p.parcelId)).toEqual([id]);
    });
});
describe('official source peculiarities', () => {
    const cape = parcelSourceCatalog.sources.find(s => s.cityId === 'cape_town');
    const melbourne = parcelSourceCatalog.sources.find(s => s.cityId === 'melbourne');
    it('pages a short ArcGIS response with a nested transfer flag before collapsing repeated address geometry', async () => {
        const sample = samples.find(s => s.city === 'cape_town');
        const fetchImpl = vi.fn().mockResolvedValueOnce(response([fixture(cape, sample, 1)], true))
            .mockResolvedValueOnce(response([fixture(cape, sample, 2)]));
        const result = await createParcelSource(cape, { fetchImpl }).queryIds([cape.idPrefix + sample.nativeId]);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('resultOffset')).toBe('1');
        expect(result.features).toHaveLength(1);
        expect(result.absentIds).toEqual([]);
    });
    it.each([['parcel_status', 'P'], ['parv_z_level', 'A1'], ['parv_z_level', 'B1']])('keeps excluded Victorian %s=%s records out of ground even if upstream ignores the filter', async (field, value) => {
        const parcel = fixture(melbourne, samples.find(s => s.city === 'melbourne'));
        parcel.properties[field] = value;
        const source = createParcelSource(melbourne, { fetchImpl: async () => response([parcel]) });
        await expect(source.queryIds([melbourne.idPrefix + parcel.properties.parcel_pfi])).rejects.toMatchObject({ status: 502 });
    });
    it('applies the same approved-record filter to viewport and footprint reads', async () => {
        const parcel = fixture(melbourne, samples.find(s => s.city === 'melbourne'));
        const fetchImpl = vi.fn(async () => response([parcel]));
        const source = createParcelSource(melbourne, { fetchImpl });
        await source.queryBounds([145.0585, -37.8312, 145.0595, -37.8304]);
        await source.queryGeometry(parcel.geometry);
        for (const [url] of fetchImpl.mock.calls) expect(new URL(url).searchParams.get('where')).toBe("parcel_status = 'A' AND parv_status = 'A' AND parv_z_level IN ('G','S')");
    });
});
