// ArcGIS layers whose labels repeat get outline-derived references: labels are shown, never used as identity.
import { describe, expect, it, vi } from 'vitest';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';
import { GEOMETRY_IDENTITY_KIND } from '../parcels/geometry-identity.js';

const descriptor = {
    adapter: 'arcgis', id: 'in-mh-ncscm-czmp-survey-plots',
    endpoint: 'https://gisportal.ncscm.res.in/server/rest/services/CZMP_STATES_2019/CZMP_Maharashtra19/MapServer/5',
    identityKind: GEOMETRY_IDENTITY_KIND, lookupCellSize: 0.0025, objectIdField: 'OBJECTID', idPrefix: 'IN-MH-CZMP-',
    parcelNumberField: 'lable', outFields: ['OBJECTID', 'VILLAGE', 'TYPE', 'WARD', 'lable'], pageSize: 1000, maxFeatures: 2000, maxBboxKm2: 1
};
const square = (west, south, size = 0.0002) => ({ type: 'Polygon',
    coordinates: [[[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]]] });
const row = (objectId, label, geometry) => ({ type: 'Feature', id: objectId,
    properties: { OBJECTID: objectId, VILLAGE: 'MATUNGA', TYPE: 'CTS', WARD: 'F/N', lable: label }, geometry });
const answer = features => ({ ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features, exceededTransferLimit: false }) });

function provider(rows) {
    const calls = [];
    const fetchImpl = vi.fn(async url => { calls.push(new URL(url)); return answer(rows()); });
    return { fetchImpl, calls };
}

describe('ArcGIS outline identity', () => {
    it('gives a repeated label two references and shows the label on both', async () => {
        const first = square(72.8401, 19.0151), second = square(72.8431, 19.0181);
        const { fetchImpl } = provider(() => [row(1, '9', first), row(2, '9', second)]);
        const result = await createArcgisParcelSource(descriptor, { fetchImpl }).queryBounds([72.840, 19.015, 72.845, 19.020]);
        expect(result.identityKind).toBe(GEOMETRY_IDENTITY_KIND);
        expect(result.features).toHaveLength(2);
        expect(new Set(result.features.map(feature => feature.id)).size).toBe(2);
        for (const feature of result.features) {
            expect(feature.id).toMatch(/^IN-MH-CZMP-g1~-?\d+~-?\d+~[0-9a-f]{64}$/);
            expect(feature.properties.parcelNumber).toBe('9');
            expect(feature.properties.sourceProperties).toMatchObject({ VILLAGE: 'MATUNGA', TYPE: 'CTS', lable: '9' });
            expect(feature.properties.parcelIdentityKind).toBe(GEOMETRY_IDENTITY_KIND);
        }
    });

    it('keeps both labels when two rows carry the same outline', async () => {
        const shape = square(72.8401, 19.0151);
        const { fetchImpl } = provider(() => [row(1, '54', shape), row(2, '54A', shape)]);
        const result = await createArcgisParcelSource(descriptor, { fetchImpl }).queryBounds([72.840, 19.015, 72.845, 19.020]);
        expect(result.features).toHaveLength(1);
        expect(result.features[0].properties.parcelNumber).toBe('54 / 54A');
    });

    it('re-reads a reference from the cell around its vertex and reports a changed outline as absent', async () => {
        let shape = square(72.8401, 19.0151);
        const { fetchImpl, calls } = provider(() => [row(1, '9', shape)]);
        const source = createArcgisParcelSource(descriptor, { fetchImpl });
        const [parcel] = (await source.queryBounds([72.840, 19.015, 72.845, 19.020])).features;
        const exact = await source.queryIds([parcel.id]);
        expect(exact.features.map(feature => feature.id)).toEqual([parcel.id]);
        expect(exact.absentIds).toEqual([]);
        const [west, south, east, north] = calls[1].searchParams.get('geometry').split(',').map(Number);
        expect(east - west).toBeLessThan(0.003);
        expect(west <= 72.8401 && 72.8401 <= east && south <= 19.0151 && 19.0151 <= north).toBe(true);
        shape = square(72.8401, 19.0151, 0.00021);
        expect((await source.queryIds([parcel.id])).absentIds).toEqual([parcel.id]);
    });

    it('reads outlines through object-ID lists in Esri JSON for servers without GeoJSON or offsets', async () => {
        const shape = square(72.8401, 19.0151);
        const esri = { features: [{ attributes: { OBJECTID: 7, VILLAGE: 'MATUNGA', TYPE: 'CTS', WARD: 'F/N', lable: '12' },
            geometry: { rings: shape.coordinates.map(ring => [...ring].reverse()) } }], geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 } };
        const calls = [];
        const fetchImpl = vi.fn(async url => {
            const u = new URL(url); calls.push(u);
            if (u.searchParams.get('returnCountOnly')) return { ok: true, status: 200, json: async () => ({ count: 1 }) };
            if (u.searchParams.get('returnIdsOnly')) return { ok: true, status: 200, json: async () => ({ objectIdFieldName: 'OBJECTID', objectIds: [esri.features[0].attributes.OBJECTID] }) };
            return { ok: true, status: 200, json: async () => esri };
        });
        const source = createArcgisParcelSource({ ...descriptor, queryFormat: 'esri-json', boundsQueryMode: 'object-ids' }, { fetchImpl });
        const result = await source.queryBounds([72.840, 19.015, 72.845, 19.020]);
        expect(result.features.map(feature => feature.properties.parcelNumber)).toEqual(['12']);
        expect(result.features[0].id).toMatch(/^IN-MH-CZMP-g1~/);
        expect(calls.at(-1).searchParams.get('objectIds')).toBe('7');
        expect(calls.every(u => !u.searchParams.get('where') || u.searchParams.get('where') === '1=1')).toBe(true);
        // Transport IDs may change without changing the outline's saved reference.
        const parcelId = result.features[0].id;
        esri.features[0].attributes.OBJECTID = 81;
        const exact = await source.queryIds([parcelId]);
        expect(exact.features.map(feature => feature.id)).toEqual([parcelId]);
        expect(exact.absentIds).toEqual([]);
        expect(exact.complete).toBe(true);
        expect(calls.at(-1).searchParams.get('objectIds')).toBe('81');
        esri.features[0].geometry.rings = square(72.8401, 19.0151, 0.00021).coordinates.map(ring => [...ring].reverse());
        expect((await source.queryIds([parcelId])).absentIds).toEqual([parcelId]);
    });

    it('rejects a native ID field or query modes alongside outline identity', () => {
        const fetchImpl = async () => answer([]);
        expect(() => createArcgisParcelSource({ ...descriptor, idField: 'OBJECTID' }, { fetchImpl })).toThrow(/Invalid ArcGIS/);
        expect(() => createArcgisParcelSource({ ...descriptor, idsQueryMode: 'object-ids' }, { fetchImpl })).toThrow(/Invalid ArcGIS/);
        expect(() => createArcgisParcelSource({ ...descriptor, lookupCellSize: 0.01 }, { fetchImpl })).toThrow(/Invalid ArcGIS/);
        const { identityKind, lookupCellSize, ...plain } = descriptor;
        expect(() => createArcgisParcelSource({ ...plain, lookupCellSize }, { fetchImpl })).toThrow(/Invalid ArcGIS/);
        expect(() => createArcgisParcelSource(plain, { fetchImpl })).toThrow(/Invalid ArcGIS/);
    });
});
