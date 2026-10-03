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
