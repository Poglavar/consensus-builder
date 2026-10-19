// Opt-in ArcGIS reader for join views that repeat identical complete parcel rows.
import { describe, expect, it, vi } from 'vitest';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const descriptor = {
    adapter: 'arcgis', id: 'test-identical-join-rows',
    endpoint: 'https://example.test/arcgis/rest/services/parcels/MapServer/0',
    idField: 'PARCEL_ID', objectIdField: 'PARCEL_ID', idPrefix: 'TEST-PARCEL-',
    outFields: ['PARCEL_ID'], pageSize: 1, idBatchSize: 2, maxFeatures: 10,
    boundsQueryMode: 'distinct-ids', idsQueryMode: 'distinct-ids',
    nativeGeometryMode: 'identical-join-rows'
};

const polygon = (west, south, east, north) => ({ type: 'Polygon', coordinates: [[
    [west, south], [east, south], [east, north], [west, north], [west, south]
]] });
const response = payload => ({ ok: true, status: 200, json: async () => payload });
const fc = (features, exceededTransferLimit = false) => ({ type: 'FeatureCollection', features, exceededTransferLimit });

function fetchFor({ ids = [1, 2], rows = null, driftRawCount = false, changingManifest = false,
    limitOnFirstPage = false, duplicateManifest = false, shortManifest = false, badDistinctCount = false,
    badDistinctId = false, finalManifestLimit = false, truncateRaw = false, rawLimit = false,
    rawTransferFlag = false, emptyTransferFlag = false, unexpectedRawId = false,
    ignoreDistinctPredicate = false, driftDistinctCount = false } = {}) {
    const calls = [];
    let manifestGeneration = 0;
    let distinctCountCalls = 0;
    let rawCountCalls = 0;
    const geometries = rows || [
        { type: 'Feature', properties: { PARCEL_ID: 1 }, geometry: polygon(-79.3838, 43.6522, -79.3832, 43.6528) },
        { type: 'Feature', properties: { PARCEL_ID: 1 }, geometry: polygon(-79.3838, 43.6522, -79.3832, 43.6528) },
        { type: 'Feature', properties: { PARCEL_ID: 2 }, geometry: polygon(-79.3828, 43.6522, -79.3822, 43.6528) }
    ];
    const idsFromWhere = search => {
        const match = search.get('where')?.match(/PARCEL_ID IN \(([^)]+)\)/);
        return match ? new Set(match[1].split(',').map(Number)) : null;
    };
    const fetchImpl = vi.fn(async url => {
        const search = new URL(url).searchParams;
        calls.push(search);
        if (search.get('returnCountOnly') === 'true' && search.get('returnDistinctValues') === 'true') {
            distinctCountCalls++;
            const requested = idsFromWhere(search);
            const matches = requested && !ignoreDistinctPredicate ? ids.filter(value => requested.has(value)) : ids;
            if (driftDistinctCount && distinctCountCalls > 1) return response({ count: matches.length - 1 });
            return response({ count: badDistinctCount ? 'not-a-count' : matches.length });
        }
        if (search.get('returnDistinctValues') === 'true') {
            const offset = Number(search.get('resultOffset'));
            if (offset === 0) manifestGeneration++;
            const requested = idsFromWhere(search);
            let manifest = requested && !ignoreDistinctPredicate ? ids.filter(value => requested.has(value)) : ids;
            if (changingManifest && manifestGeneration >= 2) manifest = ids.map(value => value + 10);
            if (duplicateManifest) manifest = [1, 1];
            if (badDistinctId) manifest = [1, 'bad'];
            let page = manifest.slice(offset, offset + Number(search.get('resultRecordCount')));
            if (shortManifest && offset > 0) page = [];
            return response({ features: page.map(value => ({ attributes: { PARCEL_ID: value } })),
                exceededTransferLimit: finalManifestLimit || (limitOnFirstPage && offset === 0) });
        }
        if (search.get('returnCountOnly') === 'true') {
            rawCountCalls++;
            const requested = idsFromWhere(search);
            const matches = requested ? geometries.filter(feature => requested.has(feature.properties.PARCEL_ID)) : geometries;
            return response({ count: rawLimit ? 11 : driftRawCount && rawCountCalls > 1 ? matches.length - 1 : matches.length });
        }
        const requested = idsFromWhere(search);
        let matches = requested ? geometries.filter(feature => requested.has(feature.properties.PARCEL_ID)) : geometries;
        if (truncateRaw) matches = matches.slice(0, Math.max(0, matches.length - 1));
        if (unexpectedRawId) matches = matches.map(feature => ({ ...feature, properties: { PARCEL_ID: 999 } }));
        return response(fc(matches, matches.length === 0 ? emptyTransferFlag : rawTransferFlag));
    });
    return { fetchImpl, calls };
}

describe('ArcGIS identical join rows mode', () => {
    it('pages and double-checks distinct IDs, then retains one geometry for exactly identical complete join rows', async () => {
        const { fetchImpl, calls } = fetchFor({ limitOnFirstPage: true });
        const source = createArcgisParcelSource(descriptor, { fetchImpl });
        const result = await source.queryBounds([-79.384, 43.652, -79.382, 43.653]);

        expect(result).toMatchObject({ complete: true, returnsWGS84: true, sourceRows: 3 });
        expect(result.features.map(feature => feature.id)).toEqual(['TEST-PARCEL-1', 'TEST-PARCEL-2']);
        expect(result.features).toHaveLength(2);
        expect(result.features[0].properties.sourceProperties).toEqual({ PARCEL_ID: 1 });
        expect(calls.filter(params => params.get('returnDistinctValues') === 'true' && params.get('returnCountOnly') !== 'true'))
            .toHaveLength(4);
        expect(calls.filter(params => params.get('returnDistinctValues') === 'true')
            .every(params => params.get('outFields') === 'PARCEL_ID' && params.get('returnGeometry') === 'false')).toBe(true);
        const geometryRead = calls.find(params => params.get('returnGeometry') === 'true');
        expect(geometryRead.get('where')).toBe('(1=1) AND (PARCEL_ID IN (1,2))');
        expect(geometryRead.has('geometry')).toBe(false);
        expect(geometryRead.get('outFields')).toBe('PARCEL_ID');
    });

    it('reports exact absence only after complete zero manifests and a raw empty geometry read', async () => {
        const { fetchImpl, calls } = fetchFor({ ids: [] });
        const result = await createArcgisParcelSource(descriptor, { fetchImpl }).queryIds(['TEST-PARCEL-404']);
        expect(result).toMatchObject({ complete: true, features: [], absentIds: ['TEST-PARCEL-404'], sourceRows: 0 });
        expect(calls.filter(params => params.get('returnCountOnly') === 'true' && params.get('returnDistinctValues') === 'true'))
            .toHaveLength(3);
        const exactRead = calls.find(params => params.get('returnGeometry') === 'true');
        expect(exactRead.get('where')).toBe('(1=1) AND (PARCEL_ID IN (404))');
        expect(exactRead.get('resultRecordCount')).toBe('1');
        expect(exactRead.get('outFields')).toBe('PARCEL_ID');
        expect(calls.filter(params => params.get('returnCountOnly') === 'true' && params.get('returnDistinctValues') !== 'true'))
            .toHaveLength(2);
    });

    it('checks requested absent IDs together with present IDs in one exact raw-row batch', async () => {
        const { fetchImpl, calls } = fetchFor({ ids: [1] });
        const result = await createArcgisParcelSource(descriptor, { fetchImpl })
            .queryIds(['TEST-PARCEL-1', 'TEST-PARCEL-404']);
        expect(result).toMatchObject({ complete: true, absentIds: ['TEST-PARCEL-404'] });
        expect(result.features.map(feature => feature.id)).toEqual(['TEST-PARCEL-1']);
        expect(calls.find(params => params.get('returnGeometry') === 'true').get('where'))
            .toBe('(1=1) AND (PARCEL_ID IN (1,404))');
    });

    it('rejects distinct IDs outside the requested exact key set and missing native IDs in geometry rows', async () => {
        const ignoredFilter = fetchFor({ ids: [1, 2], ignoreDistinctPredicate: true });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: ignoredFilter.fetchImpl })
            .queryIds(['TEST-PARCEL-1'])).rejects.toThrow(/unexpected distinct native IDs/);
        expect(ignoredFilter.calls.some(params => params.get('returnGeometry') === 'true')).toBe(false);

        const missingNative = fetchFor({ rows: [
            { type: 'Feature', properties: { PARCEL_ID: 1 }, geometry: polygon(-79.3838, 43.6522, -79.3832, 43.6528) },
            { type: 'Feature', properties: { PARCEL_ID: 1 }, geometry: polygon(-79.3838, 43.6522, -79.3832, 43.6528) },
            { type: 'Feature', properties: { PARCEL_ID: 1 }, geometry: polygon(-79.3838, 43.6522, -79.3832, 43.6528) }
        ] });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: missingNative.fetchImpl })
            .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(/omitted a distinct native parcel ID/);
    });

    it('rejects an empty exact read that is missing an explicit untruncated response flag', async () => {
        const { fetchImpl } = fetchFor({ ids: [], emptyTransferFlag: undefined });
        const unflagged = vi.fn(async url => {
            const params = new URL(url).searchParams;
            if (params.get('returnGeometry') === 'true') return response({ type: 'FeatureCollection', features: [] });
            return fetchImpl(url);
        });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: unflagged })
            .queryIds(['TEST-PARCEL-404'])).rejects.toThrow(/incomplete exact geometry rows/);
        const truncated = fetchFor({ ids: [], emptyTransferFlag: true });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: truncated.fetchImpl })
            .queryIds(['TEST-PARCEL-404'])).rejects.toThrow(/incomplete exact geometry rows/);
    });

    it('fails closed on bad paging, changing manifests, raw-row drift, and conflicting duplicate geometry', async () => {
        const shortPage = vi.fn(async url => new URL(url).searchParams.get('returnCountOnly') === 'true'
            ? response({ count: 2 }) : response({ features: [], exceededTransferLimit: false }));
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: shortPage })
            .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(/incomplete distinct-ID paging/);

        const changed = fetchFor({ changingManifest: true });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: changed.fetchImpl })
            .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(/membership changed/);

        const drift = fetchFor({ driftRawCount: true });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: drift.fetchImpl })
            .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(/raw rows changed/);

        const conflictingRows = [
            { type: 'Feature', properties: { PARCEL_ID: 1 }, geometry: polygon(-79.3838, 43.6522, -79.3832, 43.6528) },
            { type: 'Feature', properties: { PARCEL_ID: 1 }, geometry: polygon(-79.3837, 43.6522, -79.3831, 43.6528) },
            { type: 'Feature', properties: { PARCEL_ID: 2 }, geometry: polygon(-79.3828, 43.6522, -79.3822, 43.6528) }
        ];
        const conflict = fetchFor({ rows: conflictingRows });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: conflict.fetchImpl })
            .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(/conflicting geometry/);

        const missingRow = fetchFor({ truncateRaw: true });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: missingRow.fetchImpl })
            .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(/incomplete exact geometry rows/);
        const extraRow = fetchFor({ unexpectedRawId: true });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: extraRow.fetchImpl })
            .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(/unexpected native parcel ID/);
        const transferred = fetchFor({ rawTransferFlag: true });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: transferred.fetchImpl })
            .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(/incomplete exact geometry rows/);
        const limited = fetchFor({ rawLimit: true });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: limited.fetchImpl })
            .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(/invalid raw-row count/);
    });

    it('rejects malformed, duplicate, short, or truncated distinct-ID pages and malformed counts', async () => {
        const cases = [
            [fetchFor({ badDistinctCount: true }), /invalid distinct-ID count/],
            [fetchFor({ badDistinctId: true }), /invalid distinct parcel IDs/],
            [fetchFor({ duplicateManifest: true }), /duplicate or invalid distinct parcel IDs/],
            [fetchFor({ shortManifest: true }), /incomplete distinct-ID paging/],
            [fetchFor({ finalManifestLimit: true }), /incomplete distinct-ID paging/]
        ];
        for (const [fixture, message] of cases) {
            await expect(createArcgisParcelSource(descriptor, { fetchImpl: fixture.fetchImpl })
                .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(message);
        }
        const drift = fetchFor({ driftDistinctCount: true });
        await expect(createArcgisParcelSource(descriptor, { fetchImpl: drift.fetchImpl })
            .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(/membership changed/);
        expect(drift.calls.filter(params => params.get('returnDistinctValues') === 'true'
            && params.get('returnCountOnly') !== 'true')).toHaveLength(2);
    });

    it('enforces the distinct-manifest page budget before fetching any ID pages', async () => {
        const ids = Array.from({ length: 129 }, (_, index) => index + 1);
        const fixture = fetchFor({ ids });
        const source = createArcgisParcelSource({ ...descriptor, maxFeatures: 1000 }, { fetchImpl: fixture.fetchImpl });
        await expect(source.queryBounds([-79.384, 43.652, -79.382, 43.653]))
            .rejects.toThrow(/distinct-ID manifest exceeds the request budget/);
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0].get('returnCountOnly')).toBe('true');
    });

    it('requires the strict opt-in mode combination and leaves the default offset reader intact', async () => {
        for (const invalid of [
            { ...descriptor, boundsQueryMode: 'offset' },
            { ...descriptor, idsQueryMode: 'object-ids' },
            { ...descriptor, outFields: ['PARCEL_ID', 'OWNER'] },
            { ...descriptor, idType: 'string' },
            { ...descriptor, objectIdField: 'OBJECTID' },
            { ...descriptor, attributeFilters: { PARCEL_ID: 1 } },
            { ...descriptor, queryFormat: 'esri-json' },
            { ...descriptor, responseSrid: 3857 },
            { ...descriptor, responseSrid: 3857, geometryPrecision: 6 }
        ]) expect(() => createArcgisParcelSource(invalid)).toThrow(/Invalid ArcGIS/);

        const ordinary = { ...descriptor, boundsQueryMode: undefined, idsQueryMode: undefined,
            nativeGeometryMode: undefined, outFields: ['OBJECTID', 'PARCEL_ID'], objectIdField: 'OBJECTID' };
        const calls = [];
        const fetchImpl = vi.fn(async url => {
            const search = new URL(url).searchParams;
            calls.push(search);
            return response(fc([{ type: 'Feature', id: 7, properties: { OBJECTID: 7, PARCEL_ID: 17 },
                geometry: polygon(-79.3838, 43.6522, -79.3832, 43.6528) }]));
        });
        await createArcgisParcelSource(ordinary, { fetchImpl }).queryBounds([-79.384, 43.652, -79.382, 43.653]);
        expect(calls).toHaveLength(1);
        expect(calls[0].get('orderByFields')).toBe('OBJECTID');
        expect(calls[0].has('returnDistinctValues')).toBe(false);

        const duplicateObjectIds = vi.fn(async () => response(fc([
            { type: 'Feature', id: 7, properties: { OBJECTID: 7, PARCEL_ID: 17 },
                geometry: polygon(-79.3838, 43.6522, -79.3832, 43.6528) },
            { type: 'Feature', id: 7, properties: { OBJECTID: 7, PARCEL_ID: 18 },
                geometry: polygon(-79.3828, 43.6522, -79.3822, 43.6528) }
        ])));
        await expect(createArcgisParcelSource(ordinary, { fetchImpl: duplicateObjectIds })
            .queryBounds([-79.384, 43.652, -79.382, 43.653])).rejects.toThrow(/object ID/i);
    });
});
