// Verifies canonical parcel identity, complete ArcGIS paging and geometry/error handling.
import { describe, expect, it, vi } from 'vitest';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const descriptor = {
    adapter: 'arcgis',
    id: 'ca-on-toronto',
    endpoint: 'https://gis.toronto.ca/arcgis/rest/services/cot_geospatial27/FeatureServer/36',
    idField: 'PARCELID',
    objectIdField: 'OBJECTID',
    idPrefix: 'CA-ON-TORONTO-',
    outFields: ['OBJECTID', 'PARCELID'],
    pageSize: 2,
    maxFeatures: 10
};

const polygon = (west, south, east, north) => ({
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});

function feature(objectId, parcelId, geometry = polygon(-79.3838, 43.6522, -79.3832, 43.6528)) {
    return { type: 'Feature', id: objectId, properties: { OBJECTID: objectId, PARCELID: parcelId }, geometry };
}

function response(features, exceededTransferLimit = false) {
    return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features, exceededTransferLimit }) };
}

function makeFetch(pages) {
    const calls = [];
    const fetchImpl = vi.fn(async url => {
        const parsed = new URL(url);
        calls.push(parsed);
        const page = pages[calls.length - 1];
        if (page instanceof Error) throw page;
        return page;
    });
    return { fetchImpl, calls };
}

describe('createArcgisParcelSource', () => {
    it('projects every viewport corner to the provider CRS while retaining WGS84 geometry and native exact IDs', async () => {
        const ground = feature(1, '1001', polygon(-119.769, 39.161, -119.768, 39.162));
        const { fetchImpl, calls } = makeFetch([response([ground]), response([ground])]);
        const source = createArcgisParcelSource({ ...descriptor, boundsSrid: 26911,
            boundsProjection: '+proj=utm +zone=11 +datum=NAD83 +units=m +no_defs' }, { fetchImpl });
        const result = await source.queryBounds([-119.77, 39.16, -119.7675, 39.1625]);
        expect(calls[0].searchParams.get('inSR')).toBe('26911');
        expect(calls[0].searchParams.get('outSR')).toBe('4326');
        // Independent PROJ reference, allowing metre-scale datum realization differences.
        // The two diagonal corners clip the north/south edges by more than six metres.
        const expected = [260663.638393, 4338180.233561, 260888.148227, 4338464.335733];
        calls[0].searchParams.get('geometry').split(',').map(Number)
            .forEach((value, i) => expect(Math.abs(value - expected[i])).toBeLessThan(2));
        expect(result.features[0].geometry).toEqual(ground.geometry);
        const exact = await source.queryIds([result.features[0].id]);
        expect(calls[1].searchParams.has('geometry')).toBe(false);
        expect(exact.features).toEqual(result.features);
        expect(() => createArcgisParcelSource({ ...descriptor, boundsSrid: 26911 })).toThrow();
        expect(() => createArcgisParcelSource({ ...descriptor, boundsProjection: '+proj=utm +zone=11' })).toThrow();
    });
    it('pages a bounded query in object-id order and emits namespaced canonical IDs', async () => {
        const { fetchImpl, calls } = makeFetch([
            response([feature(1, '1001'), feature(2, '1002')], true),
            response([feature(3, '1003')])
        ]);
        const source = createArcgisParcelSource(descriptor, { fetchImpl });

        const result = await source.queryBounds([-79.384, 43.652, -79.383, 43.653]);

        expect(result.type).toBe('FeatureCollection');
        expect(result.complete).toBe(true);
        expect(result.features.map(item => item.id)).toEqual([
            'CA-ON-TORONTO-1001', 'CA-ON-TORONTO-1002', 'CA-ON-TORONTO-1003'
        ]);
        expect(result.features[0].properties).toMatchObject({ sourceId: 'ca-on-toronto', sourceParcelId: '1001' });
        expect(result.features[0].properties.sourceProperties).toEqual({ OBJECTID: 1, PARCELID: '1001' });
        expect(calls).toHaveLength(2);
        for (const url of calls) {
            expect(url.searchParams.get('f')).toBe('geojson');
            expect(url.searchParams.get('inSR')).toBe('4326');
            expect(url.searchParams.get('outSR')).toBe('4326');
            expect(url.searchParams.get('orderByFields')).toBe('OBJECTID');
            expect(url.searchParams.get('outFields')).toBe('OBJECTID,PARCELID');
        }
        expect(calls[0].searchParams.get('resultOffset')).toBe('0');
        expect(calls[1].searchParams.get('resultOffset')).toBe('2');
    });

    it('uses the native parcel ID for canonical-ID lookup and reports absences only after complete paging', async () => {
        const { fetchImpl, calls } = makeFetch([
            response([feature(7, '7007'), feature(8, '8008')], true),
            response([feature(9, '9009')])
        ]);
        const source = createArcgisParcelSource(descriptor, { fetchImpl });

        const result = await source.queryIds([
            'CA-ON-TORONTO-7007', 'CA-ON-TORONTO-8008', 'CA-ON-TORONTO-9009', 'CA-ON-TORONTO-4040'
        ]);

        expect(result.features.map(item => item.id)).toEqual([
            'CA-ON-TORONTO-7007', 'CA-ON-TORONTO-8008', 'CA-ON-TORONTO-9009'
        ]);
        expect(result.absentIds).toEqual(['CA-ON-TORONTO-4040']);
        expect(result.complete).toBe(true);
        expect(calls[0].searchParams.get('where')).toContain('PARCELID IN');
        expect(calls[0].searchParams.get('where')).toContain('7007');
        expect(calls[0].searchParams.get('where')).toContain('9009');
    });

    it('rejects foreign, malformed, or empty IDs without making a request', async () => {
        const { fetchImpl } = makeFetch([]);
        const source = createArcgisParcelSource(descriptor, { fetchImpl });

        await expect(source.queryIds(['CA-ON-TORONTO-1', 'CA-ON-TORONTO-2 OR 1=1']))
            .rejects.toThrow(/id/i);
        await expect(source.queryIds(['US-NY-1'])).rejects.toThrow(/id/i);
        await expect(source.queryIds([])).rejects.toThrow(/id/i);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('uses a search envelope and then removes features that do not intersect the requested geometry', async () => {
        const target = { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0, 0.01], [0, 0]]] };
        const { fetchImpl, calls } = makeFetch([response([
            feature(1, '1001', polygon(0.001, 0.001, 0.002, 0.002)),
            feature(2, '1002', polygon(0.008, 0.008, 0.009, 0.009))
        ])]);
        const source = createArcgisParcelSource(descriptor, { fetchImpl });

        const result = await source.queryGeometry(target);

        expect(result.features.map(item => item.properties.sourceParcelId)).toEqual(['1001']);
        expect(result.complete).toBe(true);
        const envelope = calls[0].searchParams.get('geometry').split(',').map(Number);
        expect(envelope).toEqual([0, 0, 0.01, 0.01]);
        expect(calls[0].searchParams.get('geometryType')).toBe('esriGeometryEnvelope');
    });

    it('fails closed on upstream errors, malformed polygons, missing native IDs, or truncated paging', async () => {
        const sourceFor = page => createArcgisParcelSource(descriptor, { fetchImpl: makeFetch([page]).fetchImpl });
        const upstreamError = { ok: true, status: 200, json: async () => ({ error: { message: 'service unavailable' } }) };
        await expect(sourceFor(upstreamError).queryBounds([-79.384, 43.652, -79.383, 43.653]))
            .rejects.toThrow();
        await expect(sourceFor(response([feature(1, 'broken', { type: 'LineString', coordinates: [[0, 0], [1, 1]] })]))
            .queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow();
        await expect(sourceFor(response([feature(1, null)]))
            .queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow();

        const { fetchImpl } = makeFetch([response([feature(1, '1001'), feature(2, '1002')], true)]);
        const truncated = createArcgisParcelSource({ ...descriptor, maxFeatures: 2 }, { fetchImpl });
        await expect(truncated.queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/complete|limit|page/i);
    });

    it('rejects malformed feature collections and empty pages that claim more results', async () => {
        const malformed = {
            ok: true, status: 200,
            json: async () => ({ type: 'FeatureCollection', features: 'not-an-array', exceededTransferLimit: false })
        };
        for (const page of [malformed, response([], true)]) {
            const source = createArcgisParcelSource(descriptor, { fetchImpl: makeFetch([page]).fetchImpl });
            await expect(source.queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow();
        }
    });

    it('rejects repeated object IDs across pages and duplicate parcel IDs with conflicting geometry', async () => {
        const repeatedPages = makeFetch([
            response([feature(1, '1001'), feature(2, '1002')], true),
            response([feature(2, '1003')])
        ]);
        const repeatedSource = createArcgisParcelSource(descriptor, { fetchImpl: repeatedPages.fetchImpl });
        await expect(repeatedSource.queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/object ID/i);

        const conflictingPages = makeFetch([
            response([feature(1, '1001'), feature(2, '1002')], true),
            response([feature(3, '1001', polygon(-79.38, 43.65, -79.379, 43.651))])
        ]);
        const conflictingSource = createArcgisParcelSource(descriptor, { fetchImpl: conflictingPages.fetchImpl });
        await expect(conflictingSource.queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/conflicting geometry/i);
    });

    it('supports MultiPolygon footprints and excludes parcel features inside a polygon hole', async () => {
        const multipolygon = {
            type: 'MultiPolygon',
            coordinates: [
                [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]],
                [[[0.02, 0], [0.03, 0], [0.03, 0.01], [0.02, 0.01], [0.02, 0]]]
            ]
        };
        const holedPolygon = {
            type: 'Polygon',
            coordinates: [
                [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]],
                [[0.003, 0.003], [0.007, 0.003], [0.007, 0.007], [0.003, 0.007], [0.003, 0.003]]
            ]
        };
        const { fetchImpl } = makeFetch([response([
            feature(1, '1001', polygon(0.001, 0.001, 0.002, 0.002)),
            feature(2, '1002', polygon(0.004, 0.004, 0.005, 0.005)),
            feature(3, '1003', polygon(0.021, 0.001, 0.022, 0.002))
        ])]);
        const source = createArcgisParcelSource(descriptor, { fetchImpl });

        const result = await source.queryGeometry(holedPolygon);

        expect(result.features.map(item => item.properties.sourceParcelId)).toEqual(['1001']);
        // The multi-part footprint is accepted and its envelope is bounded to the component extents.
        const multipartSource = createArcgisParcelSource(descriptor, { fetchImpl: makeFetch([response([])]).fetchImpl });
        await expect(multipartSource.queryGeometry(multipolygon)).resolves.toMatchObject({ type: 'FeatureCollection', complete: true });
    });
});

// Provider-specific SQL formatting must not alter the published native GUID namespace.
describe('ArcGIS brace-wrapped GUID query literals', () => {
    const guid = '05117aa3-c470-1d9a-4c3e-b1ea4498d021';
    const sourceDescriptor = { ...descriptor, id: 'ao-test', idPrefix: 'AO-TEST-',
        idField: 'GlobalID_1', idType: 'string', outFields: ['OBJECTID', 'GlobalID_1'], idQueryBraces: true };
    const raw = { ...feature(1, 1), properties: { OBJECTID: 1, GlobalID_1: guid } };
    it('wraps only the query literal and preserves the exact native ID in returned ground', async () => {
        const { fetchImpl, calls } = makeFetch([response([raw])]);
        const result = await createArcgisParcelSource(sourceDescriptor, { fetchImpl }).queryIds(['AO-TEST-' + guid]);
        expect(calls[0].searchParams.get('where')).toBe(`GlobalID_1 IN ('{${guid}}')`);
        expect(result).toMatchObject({ complete: true, absentIds: [] });
        expect(result.features[0]).toMatchObject({ id: 'AO-TEST-' + guid, properties: { sourceParcelId: guid } });
    });
    it.each(['already{braced}', "x' OR 1=1", '{' + guid + '}', '12345'])('rejects non-GUID canonical tails %s before fetch', async tail => {
        const fetchImpl = vi.fn();
        await expect(createArcgisParcelSource(sourceDescriptor, { fetchImpl }).queryIds(['AO-TEST-' + tail]))
            .rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('rejects a provider response that supplies a non-GUID native key', async () => {
        const fetchImpl = vi.fn(async () => response([{ ...raw, properties: { OBJECTID: 1, GlobalID_1: 'not-a-guid' } }]));
        await expect(createArcgisParcelSource(sourceDescriptor, { fetchImpl }).queryBounds([-79.384, 43.652, -79.383, 43.653]))
            .rejects.toThrow('invalid native parcel ID');
    });
    it('rejects numeric or nonboolean formatting descriptors', () => {
        expect(() => createArcgisParcelSource({ ...sourceDescriptor, idType: 'integer' })).toThrow('Invalid ArcGIS');
        expect(() => createArcgisParcelSource({ ...sourceDescriptor, idQueryBraces: 'true' })).toThrow('Invalid ArcGIS');
    });
});

describe('ArcGIS native parcels stored as multiple geometric rows', () => {
    const partsDescriptor = { ...descriptor, idType: 'string', nativeGeometryMode: 'parts',
        boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', pageSize: 1 };
    const rows = [feature(1, '00100'), feature(2, '00100', polygon(-79.381, 43.6522, -79.3804, 43.6528))];
    function partsFetch({ missing = false, incomplete = false, features = rows } = {}) {
        return vi.fn(async url => {
            const p = new URL(url).searchParams;
            const nativeRead = !p.has('geometry');
            const ids = nativeRead ? (missing ? [] : [1, 2]) : [1];
            const payload = p.has('returnCountOnly') ? { count: ids.length }
                : p.has('returnIdsOnly') ? { objectIds: incomplete && nativeRead ? [1] : ids, objectIdFieldName: 'OBJECTID' }
                    : { type: 'FeatureCollection', features: features.filter(row => p.get('objectIds').split(',').includes(String(row.properties.OBJECTID))), exceededTransferLimit: false };
            return { ok: true, status: 200, json: async () => payload };
        });
    }

    it('expands a viewport component to the complete native parcel, preserving stable geometry on exact reads', async () => {
        const fetchImpl = partsFetch();
        const source = createArcgisParcelSource(partsDescriptor, { fetchImpl });
        const bounds = await source.queryBounds([-79.384, 43.652, -79.383, 43.653]);
        const exact = await source.queryIds(['CA-ON-TORONTO-00100']);
        expect(bounds.features).toEqual(exact.features);
        expect(bounds).toMatchObject({ complete: true, sourceRows: 2, viewportSourceRows: 1 });
        expect(bounds.features).toHaveLength(1);
        expect(bounds.features[0]).toMatchObject({ id: 'CA-ON-TORONTO-00100', geometry: { type: 'MultiPolygon' },
            properties: { sourceParcelId: '00100', sourcePartCount: 2 } });
        expect(bounds.features[0].geometry.coordinates).toHaveLength(2);
        expect(fetchImpl.mock.calls.some(([url]) => new URL(url).searchParams.get('where') === "PARCELID IN ('00100')")).toBe(true);
    });

    it.each([{ missing: true }, { incomplete: true }])('fails the viewport when the complete native parcel cannot be resolved: %j', async options => {
        const source = createArcgisParcelSource(partsDescriptor, { fetchImpl: partsFetch(options) });
        await expect(source.queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/changed|object-ID/);
    });

    it('dissolves overlapping components after explicitly bounded coordinate normalization', async () => {
        const features = [rows[0], feature(2, '00100', polygon(-79.38350000001, 43.65220000001, -79.38290000001, 43.65280000001))];
        const source = createArcgisParcelSource({ ...partsDescriptor, partsCoordinatePrecision: 9 }, { fetchImpl: partsFetch({ features }) });
        const result = await source.queryIds(['CA-ON-TORONTO-00100']);
        expect(result.features).toHaveLength(1);
        expect(result.features[0].geometry.type).toBe('Polygon');
        expect(result.features[0].properties.sourcePartCount).toBe(2);
        const ring = result.features[0].geometry.coordinates[0];
        expect([Math.min(...ring.map(p => p[0])), Math.max(...ring.map(p => p[0]))]).toEqual([-79.3838, -79.3829]);
        expect([Math.min(...ring.map(p => p[1])), Math.max(...ring.map(p => p[1]))]).toEqual([43.6522, 43.6528]);
    });

    it('rejects a component which collapses under the configured precision rather than publishing empty ground', async () => {
        const tiny = feature(1, '00100', polygon(-79.38380000001, 43.65220000001, -79.38380000002, 43.65220000002));
        const source = createArcgisParcelSource({ ...partsDescriptor, partsCoordinatePrecision: 9 }, { fetchImpl: partsFetch({ features: [tiny, rows[1]] }) });
        await expect(source.queryIds(['CA-ON-TORONTO-00100'])).rejects.toThrow(/precision conversion/);
        expect(() => createArcgisParcelSource({ ...partsDescriptor, partsCoordinatePrecision: 6 })).toThrow(/Invalid ArcGIS/);
        expect(() => createArcgisParcelSource({ ...descriptor, partsCoordinatePrecision: 9 })).toThrow(/Invalid ArcGIS/);
    });

    it('bounds complete component reads and requires manifest modes for this explicit representation', async () => {
        const source = createArcgisParcelSource({ ...partsDescriptor, maxFeatures: 1 }, { fetchImpl: partsFetch() });
        await expect(source.queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/limit/);
        expect(() => createArcgisParcelSource({ ...partsDescriptor, idsQueryMode: 'offset' })).toThrow(/Invalid ArcGIS/);
        expect(() => createArcgisParcelSource({ ...partsDescriptor, nativeGeometryMode: 'unknown' })).toThrow(/Invalid ArcGIS/);
    });
});

describe('ArcGIS object-ID native-key query mode', () => {
    const nativeDescriptor = { ...descriptor, idType: 'string', idsQueryMode: 'object-ids',
        attributeExclusions: { PARCELID: ['UNASSIGNED'] } };
    const jsonResponse = payload => ({ ok: true, status: 200, json: async () => payload });

    it('resolves native IDs through complete manifests without unsupported offset/order parameters', async () => {
        const { fetchImpl, calls } = makeFetch([
            jsonResponse({ count: 3 }), jsonResponse({ objectIds: [7, 8, 9], objectIdFieldName: 'OBJECTID' }),
            response([feature(7, '00100'), feature(8, '00101')]), response([feature(9, '00102')])
        ]);
        const result = await createArcgisParcelSource(nativeDescriptor, { fetchImpl }).queryIds([
            'CA-ON-TORONTO-00100', 'CA-ON-TORONTO-00101', 'CA-ON-TORONTO-00102', 'CA-ON-TORONTO-00999'
        ]);
        expect(result).toMatchObject({ complete: true, absentIds: ['CA-ON-TORONTO-00999'] });
        expect(result.features.map(f => f.properties.sourceParcelId)).toEqual(['00100', '00101', '00102']);
        expect(calls[0].searchParams.get('where')).toBe("(PARCELID <> 'UNASSIGNED') AND (PARCELID IN ('00100','00101','00102','00999'))");
        expect(calls[1].searchParams.get('where')).toBe(calls[0].searchParams.get('where'));
        expect(calls.every(url => !url.searchParams.has('resultOffset') && !url.searchParams.has('orderByFields'))).toBe(true);
        expect(calls.slice(2).map(url => url.searchParams.get('objectIds'))).toEqual(['7,8', '9']);
    });

    it('reports absence only for a complete zero-count manifest and fails on a mismatched manifest', async () => {
        const source = pages => createArcgisParcelSource(nativeDescriptor, { fetchImpl: makeFetch(pages).fetchImpl });
        await expect(source([jsonResponse({ count: 0 }), jsonResponse({ objectIds: null })])
            .queryIds(['CA-ON-TORONTO-00100'])).resolves.toMatchObject({ complete: true, features: [], absentIds: ['CA-ON-TORONTO-00100'] });
        await expect(source([jsonResponse({ count: 2 }), jsonResponse({ objectIds: [7] })])
            .queryIds(['CA-ON-TORONTO-00100'])).rejects.toThrow(/object-ID/);
    });

    it('rejects unexpected native IDs even when the returned OID belongs to the manifest', async () => {
        const { fetchImpl } = makeFetch([jsonResponse({ count: 1 }), jsonResponse({ objectIds: [7] }), response([feature(7, '00200')])]);
        await expect(createArcgisParcelSource(nativeDescriptor, { fetchImpl }).queryIds(['CA-ON-TORONTO-00100']))
            .rejects.toThrow(/unexpected parcels/);
        expect(() => createArcgisParcelSource({ ...descriptor, idsQueryMode: 'invalid' })).toThrow(/Invalid ArcGIS/);
    });
});

describe('ArcGIS object-ID bounds query mode', () => {
    const objectIdDescriptor = { ...descriptor, boundsQueryMode: 'object-ids', pageSize: 2, maxFeatures: 10 };
    const bounds = [-79.384, 43.652, -79.383, 43.653];
    const jsonResponse = payload => ({ ok: true, status: 200, json: async () => payload });

    it('checks the bounded count before requesting IDs or geometry when the count exceeds the limit', async () => {
        const { fetchImpl, calls } = makeFetch([jsonResponse({ count: 11 })]);
        const source = createArcgisParcelSource(objectIdDescriptor, { fetchImpl });

        await expect(source.queryBounds(bounds)).rejects.toThrow(/limit/i);

        expect(calls).toHaveLength(1);
        expect(calls[0].searchParams.get('returnCountOnly')).toBe('true');
        expect(calls[0].searchParams.has('returnIdsOnly')).toBe(false);
        expect(calls[0].searchParams.has('objectIds')).toBe(false);
        expect(calls[0].searchParams.get('returnGeometry')).not.toBe('true');
    });

    it.each([
        ['count mismatch', 3, { objectIds: [1, 2] }],
        ['duplicate IDs', 3, { objectIds: [1, 2, 2] }],
        ['malformed IDs', 2, { objectIds: [1, '2'] }],
        ['truncated manifest', 3, { objectIds: [1, 2], exceededTransferLimit: true }],
        ['missing empty manifest', 0, {}],
        ['null nonempty manifest', 1, { objectIds: null }],
        ['foreign object-ID field', 1, { objectIds: [1], objectIdFieldName: 'OTHER_OID' }]
    ])('rejects a %s before starting geometry requests', async (_label, count, manifest) => {
        const { fetchImpl, calls } = makeFetch([jsonResponse({ count }), jsonResponse(manifest)]);
        const source = createArcgisParcelSource(objectIdDescriptor, { fetchImpl });

        await expect(source.queryBounds(bounds)).rejects.toThrow(/object-id|object ID|invalid/i);

        expect(calls).toHaveLength(2);
        expect(calls[0].searchParams.get('returnCountOnly')).toBe('true');
        expect(calls[1].searchParams.get('returnIdsOnly')).toBe('true');
        expect(calls.every(url => !url.searchParams.has('objectIds'))).toBe(true);
    });

    it.each([[], null])('returns a complete empty collection for a zero count and explicit empty manifest %s', async objectIds => {
        const { fetchImpl, calls } = makeFetch([
            jsonResponse({ count: 0 }), jsonResponse({ objectIds, objectIdFieldName: 'OBJECTID' })
        ]);
        const source = createArcgisParcelSource(objectIdDescriptor, { fetchImpl });

        await expect(source.queryBounds(bounds)).resolves.toMatchObject({
            type: 'FeatureCollection', complete: true, sourceId: objectIdDescriptor.id, returnsWGS84: true, features: []
        });
        expect(calls).toHaveLength(2);
    });

    it('retrieves count-bounded OID batches without spatial, ordering, or offset parameters and preserves native parcel IDs', async () => {
        const { fetchImpl, calls } = makeFetch([
            jsonResponse({ count: 3 }),
            jsonResponse({ objectIds: [30, 10, 20], objectIdFieldName: 'OBJECTID' }),
            response([feature(30, '00100'), feature(10, '00101')]),
            response([feature(20, '00102')])
        ]);
        const source = createArcgisParcelSource({
            ...objectIdDescriptor, idType: 'string', idPattern: '^0[0-9]{4}$', idPrefix: 'CA-ON-TORONTO-'
        }, { fetchImpl });

        const result = await source.queryBounds(bounds);

        expect(result.complete).toBe(true);
        expect(result.features.map(item => item.properties.sourceParcelId)).toEqual(['00100', '00101', '00102']);
        expect(result.features.map(item => item.id)).toEqual([
            'CA-ON-TORONTO-00100', 'CA-ON-TORONTO-00101', 'CA-ON-TORONTO-00102'
        ]);
        expect(result.features.map(item => item.properties.sourceProperties.OBJECTID)).toEqual([30, 10, 20]);
        expect(calls).toHaveLength(4);
        for (const url of calls.slice(2)) {
            expect(url.searchParams.has('objectIds')).toBe(true);
            expect(url.searchParams.has('geometry')).toBe(false);
            expect(url.searchParams.has('geometryType')).toBe(false);
            expect(url.searchParams.has('spatialRel')).toBe(false);
            expect(url.searchParams.has('orderByFields')).toBe(false);
            expect(url.searchParams.has('resultOffset')).toBe(false);
            expect(url.searchParams.has('returnGeometry')).toBe(true);
        }
        expect(calls.slice(2).map(url => url.searchParams.get('objectIds'))).toEqual(['30,10', '20']);
    });

    it.each([
        ['missing', [feature(1, '1001')], [1, 2]],
        ['extra', [feature(1, '1001'), feature(99, '1099')], [1]],
        ['repeated', [feature(1, '1001'), feature(1, '1002')], [1, 2]]
    ])('rejects %s object IDs in an exact geometry batch', async (_label, features, objectIds) => {
        const { fetchImpl } = makeFetch([
            jsonResponse({ count: objectIds.length }), jsonResponse({ objectIds }), response(features)
        ]);
        const source = createArcgisParcelSource({ ...objectIdDescriptor, pageSize: 10 }, { fetchImpl });

        await expect(source.queryBounds(bounds)).rejects.toThrow(/object.?ID/i);
    });

    it('rejects canonical parcel IDs with conflicting geometry across separate OID batches', async () => {
        const conflictingGeometry = polygon(-79.38, 43.65, -79.379, 43.651);
        const { fetchImpl } = makeFetch([
            jsonResponse({ count: 2 }), jsonResponse({ objectIds: [1, 2] }),
            response([feature(1, '1001')]), response([feature(2, '1001', conflictingGeometry)])
        ]);
        const source = createArcgisParcelSource({ ...objectIdDescriptor, pageSize: 1 }, { fetchImpl });

        await expect(source.queryBounds(bounds)).rejects.toThrow(/conflicting geometry/i);
    });

    it('fails on count, manifest, and exact-geometry request errors including timeouts', async () => {
        const timeout = new Error('aborted');
        timeout.name = 'TimeoutError';
        const cases = [
            [new Error('count unavailable')],
            [jsonResponse({ count: 1 }), new Error('manifest unavailable')],
            [jsonResponse({ count: 1 }), jsonResponse({ objectIds: [1] }), timeout]
        ];
        for (const pages of cases) {
            const source = createArcgisParcelSource(objectIdDescriptor, { fetchImpl: makeFetch(pages).fetchImpl });
            await expect(source.queryBounds(bounds)).rejects.toThrow();
        }
    });
});


it('uses form POST for long native-ID queries without dropping any IDs or geometry parameters', async () => {
    const guids = Array.from({ length: 80 }, (_, i) => `${String(i).padStart(8, '0')}-2222-3333-4444-555555555555`);
    const fetchImpl = vi.fn(async () => response(guids.map((guid, i) => ({ ...feature(i + 1, 1),
        properties: { OBJECTID: i + 1, GlobalID_1: guid } }))));
    const source = createArcgisParcelSource({ ...descriptor, idField: 'GlobalID_1', idType: 'string',
        idQueryBraces: true, outFields: ['OBJECTID', 'GlobalID_1'], pageSize: 100, maxFeatures: 100 }, { fetchImpl });
    const result = await source.queryIds(guids.map(id => descriptor.idPrefix + id));
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(descriptor.endpoint + '/query');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(options.body);
    for (const guid of guids) expect(body.get('where')).toContain(`'{${guid}}'`);
    expect(body.get('outSR')).toBe('4326');
    expect(body.get('returnGeometry')).toBe('true');
    expect(result).toMatchObject({ complete: true, absentIds: [] });
    expect(result.features.map(f => f.id)).toEqual(guids.map(id => descriptor.idPrefix + id));
});

// Title-index mirrors may publish explicit non-title placeholders alongside native title IDs.
describe('fixed native attribute exclusions', () => {
    const titleDescriptor = { ...descriptor, idType: 'string', attributeExclusions: { PARCELID: ['No LR Title Detected'] } };
    it('applies the same fixed source scope to bounds and exact lookups', async () => {
        const { fetchImpl, calls } = makeFetch([response([feature(1, '12345')]), response([feature(1, '12345')])]);
        const source = createArcgisParcelSource(titleDescriptor, { fetchImpl });
        await source.queryBounds([-79.384, 43.652, -79.383, 43.653]);
        await source.queryIds(['CA-ON-TORONTO-12345']);
        expect(calls[0].searchParams.get('where')).toBe("PARCELID <> 'No LR Title Detected'");
        expect(calls[1].searchParams.get('where')).toBe("(PARCELID <> 'No LR Title Detected') AND (PARCELID IN ('12345'))");
    });
    it.each(['No LR Title Detected', null, undefined])('rejects excluded or missing keys if the provider ignores SQL: %s', async value => {
        const { fetchImpl } = makeFetch([response([feature(1, value)])]);
        const source = createArcgisParcelSource(titleDescriptor, { fetchImpl });
        await expect(source.queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/configured ground status/);
    });
    it('requires filtered fields in the published provenance and safely escapes literals', async () => {
        expect(() => createArcgisParcelSource({ ...titleDescriptor, attributeExclusions: { unpublished: ['x'] } })).toThrow(/attribute filter/);
        const { fetchImpl, calls } = makeFetch([response([])]);
        await createArcgisParcelSource({ ...titleDescriptor, attributeExclusions: { PARCELID: ["O'Brien"] } }, { fetchImpl })
            .queryBounds([-79.384, 43.652, -79.383, 43.653]);
        expect(calls[0].searchParams.get('where')).toBe("PARCELID <> 'O''Brien'");
    });
});

describe('explicit non-null source scope', () => {
    const scoped = { ...descriptor, attributeNotNull: ['PARCELID'] };
    it('constrains bounds, exact IDs and footprint reads to identified records', async () => {
        const row = feature(1, 12345);
        const { fetchImpl, calls } = makeFetch([response([row]), response([row]), response([row])]);
        const source = createArcgisParcelSource(scoped, { fetchImpl });
        await source.queryBounds([-79.384, 43.652, -79.383, 43.653]);
        await source.queryIds(['CA-ON-TORONTO-12345']);
        await source.queryGeometry(row.geometry);
        expect(calls.map(call => call.searchParams.get('where'))).toEqual([
            'PARCELID IS NOT NULL',
            "(PARCELID IS NOT NULL) AND (PARCELID IN (12345))",
            'PARCELID IS NOT NULL'
        ]);
    });
    it.each([null, undefined])('fails unavailable if a provider ignores the non-null scope: %s', async native => {
        const { fetchImpl } = makeFetch([response([feature(1, native)])]);
        await expect(createArcgisParcelSource(scoped, { fetchImpl })
            .queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/configured ground status/);
    });
    it.each([null, 'PARCELID', ['unpublished'], ['PARCELID) OR 1=1'], [42]])('rejects unsafe or unreadable field declarations: %j', fields => {
        expect(() => createArcgisParcelSource({ ...descriptor, attributeNotNull: fields })).toThrow(/attribute filter/);
    });
    it('does not turn an empty native key into an identified parcel', async () => {
        const { fetchImpl } = makeFetch([response([feature(1, '')])]);
        await expect(createArcgisParcelSource({ ...scoped, idType: 'string' }, { fetchImpl })
            .queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/invalid native parcel ID/);
    });
});

describe('explicit current lifecycle scope', () => {
    const scoped = { ...descriptor, outFields: [...descriptor.outFields, 'ENDDATE'], attributeNull: ['ENDDATE'] };
    const current = () => { const row = feature(1, 12345); row.properties.ENDDATE = null; return row; };
    it('uses current-only scope for viewport, exact IDs and footprint reads', async () => {
        const row = current();
        const { fetchImpl, calls } = makeFetch([response([row]), response([row]), response([row])]);
        const source = createArcgisParcelSource(scoped, { fetchImpl });
        await source.queryBounds([-79.384, 43.652, -79.383, 43.653]);
        await source.queryIds(['CA-ON-TORONTO-12345']);
        await source.queryGeometry(row.geometry);
        expect(calls.map(call => call.searchParams.get('where'))).toEqual([
            'ENDDATE IS NULL', '(ENDDATE IS NULL) AND (PARCELID IN (12345))', 'ENDDATE IS NULL'
        ]);
    });
    it.each([0, 1720000000000, undefined])('rejects ended or omitted lifecycle attributes if the provider ignores scope: %s', async date => {
        const row = current();
        if (date === undefined) delete row.properties.ENDDATE;
        else row.properties.ENDDATE = date;
        const { fetchImpl } = makeFetch([response([row])]);
        await expect(createArcgisParcelSource(scoped, { fetchImpl })
            .queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/configured ground status/);
    });
    it.each([null, 'ENDDATE', ['unpublished'], ['ENDDATE) OR 1=1'], [42]])('rejects unsafe or unreadable lifecycle declarations: %j', fields => {
        expect(() => createArcgisParcelSource({ ...scoped, attributeNull: fields })).toThrow(/attribute filter/);
    });
    it('rejects contradictory null and non-null source scopes', () => {
        expect(() => createArcgisParcelSource({ ...scoped, attributeNotNull: ['ENDDATE'] })).toThrow(/attribute filter/);
    });
});
