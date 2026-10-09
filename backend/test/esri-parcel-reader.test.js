import { describe, expect, it, vi } from 'vitest';
import { parseEsriParcelCollection } from '../parcels/esri-parcel-reader.js';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const exterior = [[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]];
const hole = [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]];
const second = [[10, 0], [10, 1], [11, 1], [11, 0], [10, 0]];
const collection = rings => ({ geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 },
    features: [{ attributes: { OBJECTID: 1, KEY: '0001', unused: 'discard' }, geometry: { rings } }] });

describe('straight-ring Esri cadastral reader', () => {
    it('retains every exact coordinate and assigns unordered holes to their unique native exterior', () => {
        const raw = collection([hole, second, exterior]);
        const before = structuredClone(raw);
        const parsed = parseEsriParcelCollection(raw);
        expect(parsed.features[0].geometry).toEqual({ type: 'MultiPolygon', coordinates: [[second], [exterior, hole]] });
        expect(raw).toEqual(before);
        parsed.features[0].geometry.coordinates[0][0][0][0] = 20;
        expect(raw).toEqual(before);
    });
    it('preserves single polygons and explicit empty feature sets and transfer limits', () => {
        expect(parseEsriParcelCollection(collection([exterior])).features[0].geometry)
            .toEqual({ type: 'Polygon', coordinates: [exterior] });
        const empty = { ...collection([]), features: [], exceededTransferLimit: true };
        expect(parseEsriParcelCollection(empty)).toEqual({ type: 'FeatureCollection', features: [], exceededTransferLimit: true });
    });
    it.each([
        raw => { raw.geometryType = 'esriGeometryPolyline'; },
        raw => { delete raw.spatialReference; },
        raw => { raw.spatialReference = { wkid: 3857 }; },
        raw => { raw.spatialReference = { wkid: 3857, latestWkid: 4326 }; },
        raw => { raw.hasZ = true; },
        raw => { raw.hasM = true; },
        raw => { raw.features[0].geometry.spatialReference = { wkid: 4148 }; },
        raw => { raw.features[0].geometry.curveRings = [exterior]; },
        raw => { raw.features[0].geometry.rings = []; },
        raw => { raw.features[0].geometry.rings = [hole]; },
        raw => { raw.features[0].geometry.rings = [exterior.slice(0, -1)]; },
        raw => { raw.features[0].geometry.rings = [exterior.map(p => [...p, 0])]; },
        raw => { raw.features[0].geometry.rings = [exterior.map(p => [String(p[0]), p[1]])]; },
        raw => { raw.features[0].geometry.rings = [[[0, 0], [1, 1], [2, 2], [0, 0]]]; },
        raw => { raw.features[0].geometry.rings = [exterior, exterior, hole]; },
        raw => { raw.features[0].geometry.rings = [second, hole]; },
        raw => { raw.features[0].geometry.rings = [exterior, [[0, 1], [1, 1], [1, 2], [0, 2], [0, 1]]]; },
        raw => { raw.features[0].attributes = null; }
    ])('fails closed on unsupported CRS, curves, rings, hole assignments or attributes', mutate => {
        const raw = collection([exterior]);
        mutate(raw);
        expect(() => parseEsriParcelCollection(raw)).toThrow();
    });
});

describe('explicit Esri JSON ArcGIS parcel format', () => {
    const descriptor = { id: 'test-esri-json', endpoint: 'https://example.org/MapServer/0',
        idPrefix: 'TEST-', idField: 'KEY', objectIdField: 'OBJECTID', idType: 'string',
        outFields: ['OBJECTID', 'KEY'], queryFormat: 'esri-json', pageSize: 2, maxFeatures: 10 };
    const bounds = [0, 0, 0.001, 0.001];
    it('requests native curves rather than silently flattening and strips unrequested properties', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => collection([exterior]) }));
        const source = createArcgisParcelSource(descriptor, { fetchImpl });
        const result = await source.queryBounds(bounds);
        expect(result.features[0]).toMatchObject({ id: 'TEST-0001', geometry: { type: 'Polygon', coordinates: [exterior] },
            properties: { sourceProperties: { OBJECTID: 1, KEY: '0001' } } });
        const request = new URL(fetchImpl.mock.calls[0][0]);
        expect(request.searchParams.get('f')).toBe('json');
        expect(request.searchParams.get('returnTrueCurves')).toBe('true');
        expect(request.searchParams.get('outSR')).toBe('4326');
        expect(request.searchParams.get('outFields')).toBe('OBJECTID,KEY');
        expect((await source.queryIds(['TEST-0001'])).features).toEqual(result.features);
    });
    it('uses the existing complete manifest checks with native JSON pages', async () => {
        const raw = collection([exterior]);
        const fetchImpl = vi.fn(async url => {
            const query = new URL(url).searchParams;
            return { ok: true, json: async () => query.has('returnCountOnly') ? { count: 1 }
                : query.has('returnIdsOnly') ? { objectIds: [1] } : raw };
        });
        const result = await createArcgisParcelSource({ ...descriptor, boundsQueryMode: 'object-ids' }, { fetchImpl }).queryBounds(bounds);
        expect(result).toMatchObject({ complete: true, features: [{ id: 'TEST-0001' }] });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
    it('does not accept a truncated manifest page or curve-ring reply', async () => {
        const raw = collection([exterior]); raw.exceededTransferLimit = true;
        const fetchImpl = async url => {
            const query = new URL(url).searchParams;
            return { ok: true, json: async () => query.has('returnCountOnly') ? { count: 1 }
                : query.has('returnIdsOnly') ? { objectIds: [1] } : raw };
        };
        await expect(createArcgisParcelSource({ ...descriptor, boundsQueryMode: 'object-ids' }, { fetchImpl }).queryBounds(bounds))
            .rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        raw.exceededTransferLimit = false; raw.features[0].geometry.curveRings = [exterior];
        await expect(createArcgisParcelSource(descriptor, { fetchImpl }).queryBounds(bounds))
            .rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        expect(() => createArcgisParcelSource({ ...descriptor, queryFormat: 'guess' })).toThrow();
    });
});
