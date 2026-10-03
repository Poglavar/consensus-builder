// The Bogotá source keeps LotCodigo's leading zeroes in the canonical parcel ID; OBJECTID is only
// the ArcGIS pagination key. These tests exercise the executable catalog entry without network I/O.
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../parcels/https-json-fetch.js', () => ({
    createHttpsJsonFetch: () => (...args) => globalThis.fetch(...args)
}));
import { createParcelSource, parcelSourceCatalog, parcelSourceForCity } from '../parcels/sources.js';
import { computeBinding } from '../proposals/binding.js';

const descriptor = parcelSourceCatalog.sources.find(source => source.cityIds.includes('bogota'));
const PREFIX = 'CO-BOGOTA-';
const SITE = {
    type: 'Polygon',
    coordinates: [[[-74.083, 4.6095], [-74.08, 4.6095], [-74.08, 4.613], [-74.083, 4.613], [-74.083, 4.6095]]]
};
const POLYGON = {
    type: 'Polygon',
    coordinates: [[[-74.0829, 4.6096], [-74.0801, 4.6096], [-74.0801, 4.6129], [-74.0829, 4.6129], [-74.0829, 4.6096]]]
};

function feature(objectId, nativeId, geometry = POLYGON) {
    return {
        type: 'Feature', id: objectId, properties: { OBJECTID: objectId, LotCodigo: nativeId, ManzCodigo: '006106001' }, geometry
    };
}

function page(features, exceededTransferLimit) {
    const payload = { type: 'FeatureCollection', features };
    if (typeof exceededTransferLimit === 'boolean') payload.exceededTransferLimit = exceededTransferLimit;
    return { ok: true, status: 200, json: async () => payload };
}

function fetchPages(pages) {
    const calls = [];
    const fetchImpl = vi.fn(async url => {
        calls.push(new URL(url));
        return pages[calls.length - 1];
    });
    vi.stubGlobal('fetch', fetchImpl);
    return { fetchImpl, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('Bogotá live parcel source', () => {
    it('uses the dated CAR mirror descriptor and pages GeoJSON in OBJECTID order without losing padded IDs', async () => {
        expect(descriptor).toMatchObject({
            id: 'co-bogota-uaecd-lote', endpoint: 'https://sig.car.gov.co/arcgis/rest/services/VISOR/Capas_base/FeatureServer/9',
            idField: 'LotCodigo', idType: 'string', idPattern: '^[0-9]{12}$', objectIdField: 'OBJECTID', idPrefix: PREFIX,
            cityIds: ['bogota'], metricSrid: 32618, dataVersion: '2021-12',
            caCertificate: './certificates/geotrust-ev-rsa-ca-g2.pem'
        });
        const { calls } = fetchPages([
            page([feature(10, '006106001009')], true),
            page([feature(11, '006106001099')])
        ]);
        const source = parcelSourceForCity('bogota');

        const result = await source.adapter.queryBounds([-74.083, 4.609, -74.08, 4.613]);

        expect(result.complete).toBe(true);
        expect(result.features.map(item => item.id)).toEqual([
            `${PREFIX}006106001009`, `${PREFIX}006106001099`
        ]);
        expect(result.features[0].properties.sourceProperties).toMatchObject({
            OBJECTID: 10, LotCodigo: '006106001009', ManzCodigo: '006106001'
        });
        expect(calls).toHaveLength(2);
        for (const url of calls) {
            expect(url.pathname).toBe(`${new URL(descriptor.endpoint).pathname}/query`);
            expect(url.searchParams.get('f')).toBe('geojson');
            expect(url.searchParams.get('outSR')).toBe('4326');
            expect(url.searchParams.get('orderByFields')).toBe('OBJECTID');
            expect(url.searchParams.get('geometry')).toBe('-74.083,4.609,-74.08,4.613');
        }
        expect(calls.map(url => url.searchParams.get('resultOffset'))).toEqual(['0', '1']);
    });

    it('queries exact LotCodigo string literals and returns explicit absent IDs', async () => {
        const found = '006106001009';
        const missing = '006106001099';
        const { calls } = fetchPages([page([feature(10, found)])]);
        const source = parcelSourceForCity('bogota');

        const result = await source.adapter.queryIds([`${PREFIX}${found}`, `${PREFIX}${missing}`]);

        expect(calls[0].searchParams.get('where')).toBe("LotCodigo IN ('006106001009','006106001099')");
        expect(result.features.map(item => item.id)).toEqual([`${PREFIX}${found}`]);
        expect(result.absentIds).toEqual([`${PREFIX}${missing}`]);
        expect(result.complete).toBe(true);
    });

    it('rejects foreign and malformed IDs before provider I/O', async () => {
        const { fetchImpl } = fetchPages([]);
        const source = parcelSourceForCity('bogota');

        await expect(source.adapter.queryIds(['CA-ON-TORONTO-12'])).rejects.toMatchObject({ status: 400 });
        await expect(source.adapter.queryIds([`${PREFIX}123`])).rejects.toMatchObject({ status: 400 });
        await expect(source.adapter.queryIds([`${PREFIX}12345678901x`])).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects numeric LotCodigo values and incomplete pagination instead of coercing or claiming absence', async () => {
        const { fetchImpl } = fetchPages([page([feature(10, 6106001009)])]);
        const source = parcelSourceForCity('bogota');
        await expect(source.adapter.queryBounds([-74.083, 4.609, -74.08, 4.613]))
            .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        fetchPages([page([], true)]);
        await expect(parcelSourceForCity('bogota').adapter.queryBounds([-74.083, 4.609, -74.08, 4.613]))
            .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });

    it('continues a full page when the provider omits exceededTransferLimit', async () => {
        const { fetchImpl, calls } = fetchPages([
            page([feature(10, '006106001009')]),
            page([])
        ]);
        const source = createParcelSource({ ...descriptor, pageSize: 1 }, { fetchImpl });

        const result = await source.queryBounds([-74.083, 4.609, -74.08, 4.613]);

        expect(result.complete).toBe(true);
        expect(result.features.map(item => item.id)).toEqual([`${PREFIX}006106001009`]);
        expect(calls.map(url => url.searchParams.get('resultOffset'))).toEqual(['0', '1']);
    });

    it('selects Bogotá by city for authoritative binding without issuing Croatian database queries', async () => {
        fetchPages([page([feature(10, '006106001009', SITE)])]);
        const db = { query: vi.fn(async () => { throw new Error('Bogotá binding must not query the HR parcel database'); }) };

        const { binding } = await computeBinding(db, {
            site: SITE, city: 'bogota', toleranceM: 0.15,
            now: () => new Date('2026-10-02T15:00:00.000Z')
        });

        expect(db.query).not.toHaveBeenCalled();
        expect(binding).toMatchObject({
            source: 'server:co-bogota-uaecd-lote', coverage: 'complete', toleranceM: 0.15,
            unknownM2: 0, computedAt: '2026-10-02T15:00:00.000Z'
        });
        expect(binding.parcels.map(item => item.parcelId)).toEqual([`${PREFIX}006106001009`]);
    });
});
