// Keeps Athens' live ArcGIS city entry aligned with its bounded sample and native Greek KAEK IDs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createParcelSource, parcelSourceCatalog, parcelSourceForCity, parcelSourceForIds } from '../parcels/sources.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(read('../../frontend/js/city-config.js'), createContext(cityContext));

const sourceId = 'gr-ktimatologio-active-parcels-arcgis';
const cityId = 'athens';
const descriptor = parcelSourceCatalog.sources.find(source => source.id === sourceId);
const rows = [
    { objectId: 1297965, kaek: '05009ΕΚ52001', x: 23.7291, y: 37.9900 },
    { objectId: 1297966, kaek: '050096064001', x: 23.7292, y: 37.9901 },
    { objectId: 1297967, kaek: '050096064002', x: 23.7293, y: 37.9902 }
].map(({ objectId, kaek, x, y }) => ({
    type: 'Feature', id: objectId,
    properties: { OBJECTID: objectId, KAEK: kaek },
    geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 0.0001, y], [x + 0.0001, y + 0.0001], [x, y + 0.0001], [x, y]]] }
}));

function sourceResponse(features, exceededTransferLimit = false) {
    return Response.json({ type: 'FeatureCollection', features, exceededTransferLimit });
}

function mockArcgisFetch() {
    const calls = [];
    const fetchImpl = vi.fn(async (input, options = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const params = options.method === 'POST' ? new URLSearchParams(options.body) : url.searchParams;
        calls.push({ url, params });
        const where = params.get('where') || '1=1';
        let matched = rows;
        if (where.includes('KAEK IN')) {
            const ids = [...where.matchAll(/'([^']*)'/g)].map(match => match[1]);
            matched = rows.filter(row => ids.includes(row.properties.KAEK));
        }
        const offset = Number(params.get('resultOffset') || 0);
        const limit = Number(params.get('resultRecordCount') || 2000);
        return sourceResponse(matched.slice(offset, offset + limit), offset + limit < matched.length);
    });
    return { fetchImpl, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('Athens active-cadastre source', () => {
    it('registers the verified Athens entry with a narrow, owner-free field set', () => {
        expect(descriptor).toMatchObject({
            id: sourceId, adapter: 'arcgis', idField: 'KAEK', idType: 'string', objectIdField: 'OBJECTID',
            idPrefix: 'GR-ATHENS-KAEK-', outFields: ['OBJECTID', 'KAEK'], countryCode: 'GR',
            metricSrid: 32634, cityIds: [cityId], maxBboxKm2: 0.25, maxFeatures: 2500
        });
        expect(Object.keys(descriptor)).not.toContain('ownerField');
        expect(parcelSourceForCity(cityId).descriptor.id).toBe(sourceId);
        expect(parcelSourceForIds([descriptor.idPrefix + rows[0].properties.KAEK]).descriptor.id).toBe(sourceId);

        const city = cityContext.CityConfigManager.getCityConfig(cityId);
        expect(city).toMatchObject({
            id: cityId,
            label: 'Athens, Greece',
            map: { defaultCenter: [37.99008, 23.72948] },
            projection: { metricCrs: 'EPSG:32634' },
            parcels: {
                source: 'parcel-source', sourceId, idPrefix: descriptor.idPrefix,
                requiresBackend: true, ownership: false, liveRadiusKm: 0.1
            }
        });
        expect(city.parcels.attribution).toContain('https://maps.ktimatologio.gr/');
        expect(city.parcels.attribution).toContain('broader coverage and currentness unverified');
    });

    it('pages WGS84 parcel polygons and resolves an exact nonnumeric Greek KAEK', async () => {
        const { fetchImpl, calls } = mockArcgisFetch();
        const source = createParcelSource({ ...descriptor, pageSize: 2, maxFeatures: 10 }, { fetchImpl });
        const viewport = await source.queryBounds([23.7289, 37.9898, 23.7300, 37.9905]);

        expect(viewport.complete).toBe(true);
        expect(viewport.features.map(feature => feature.properties.sourceParcelId)).toEqual(rows.map(row => row.properties.KAEK));
        expect(viewport.features.map(feature => feature.properties.parcelId)).toEqual(rows.map(row => descriptor.idPrefix + row.properties.KAEK));
        expect(new Set(viewport.features.map(feature => feature.properties.sourceProperties.OBJECTID)).size).toBe(3);
        expect(viewport.features.every(feature => feature.geometry.type === 'Polygon')).toBe(true);
        expect(calls.slice(0, 2).map(call => call.params.get('resultOffset'))).toEqual(['0', '2']);
        expect(calls[0].params.get('outFields')).toBe('OBJECTID,KAEK');
        expect(calls[0].params.get('outSR')).toBe('4326');

        const exact = await source.queryIds([descriptor.idPrefix + '05009ΕΚ52001']);
        expect(exact).toMatchObject({ complete: true, absentIds: [] });
        expect(exact.features).toHaveLength(1);
        expect(exact.features[0].properties).toMatchObject({
            parcelId: descriptor.idPrefix + '05009ΕΚ52001',
            sourceParcelId: '05009ΕΚ52001',
            sourceProperties: { OBJECTID: 1297965, KAEK: '05009ΕΚ52001' }
        });
        expect(calls[2].params.get('where')).toBe("KAEK IN ('05009ΕΚ52001')");
    });
});
