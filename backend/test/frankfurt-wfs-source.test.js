import { afterEach, describe, expect, it, vi } from 'vitest';
import proj4 from 'proj4';
import { createFrankfurtWfsParcelSource } from '../parcels/frankfurt-wfs-source.js';

const descriptor = {
    id: 'de-frankfurt-test', endpoint: 'https://geowebdienste.frankfurt.de/SGK_Flurstuecke',
    featureType: 'Amt62_Flurstuecke:Flurstueck', idField: 'FSK', idType: 'string', idPrefix: 'DE-FFM-',
    parcelNumberField: 'FSK', outFields: ['FSK', 'OBJECTID'], maxBboxKm2: 1, maxFeatures: 3000, pageSize: 2
};
const nativeCrs = 'urn:ogc:def:crs:EPSG::25832';
const crs = { type: 'name', properties: { name: 'EPSG:25832' } };
const wgs84Proj = '+proj=longlat +datum=WGS84 +no_defs +type=crs';
const nativeProj = '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs +type=crs';
const fsk1 = '06046311800027______';
const fsk2 = '060463118001230026__';
const fsk3 = '060463118001130019__';
const missingFsk = '99999999999999______';

function nativeSquare(lon, lat, size = 8) {
    const [x, y] = proj4(wgs84Proj, nativeProj, [lon, lat]);
    return { type: 'MultiPolygon', coordinates: [[[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]] };
}

function row({ objectId = 3807, fsk = fsk1, geometry = nativeSquare(8.6722, 50.1194), gmlId = `Flurstueck.${objectId}`, properties = {} } = {}) {
    return { type: 'Feature', properties: { GmlID: gmlId, OBJECTID: objectId, FSK: fsk, ...properties }, geometry };
}

const rows = [row(), row({ objectId: 3814, fsk: fsk2, geometry: nativeSquare(8.6725, 50.1195) }),
    row({ objectId: 3837, fsk: fsk3, geometry: nativeSquare(8.6728, 50.1196) })];
const hits = count => `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="${count}" numberReturned="0"></wfs:FeatureCollection>`;
const collection = (features, numberMatched) => JSON.stringify({ type: 'FeatureCollection', crs,
    ...(numberMatched === undefined ? {} : { numberMatched }), features });
const literals = filter => [...filter.matchAll(/<fes:Literal>([^<]*)<\/fes:Literal>/g)].map(match => match[1]);

function mockFetch({ countOverrides = [], pages, pageMatchedCounts = [], data = rows, ignoreFilter = false, onRequest } = {}) {
    const calls = [];
    let hitCalls = 0, pageCalls = 0;
    const fetchImpl = vi.fn(async (input, options = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const params = url.searchParams;
        calls.push({ url, options });
        onRequest?.(calls.length);
        const filter = params.get('filter');
        let matched = data;
        if (filter && !ignoreFilter) {
            const ids = literals(filter);
            matched = data.filter(feature => ids.includes(feature.properties.FSK));
        }
        if (params.get('resultType') === 'hits') {
            const index = hitCalls++;
            const count = countOverrides[index] ?? matched.length;
            return new Response(hits(count), { headers: { 'content-type': 'application/xml' } });
        }
        const index = pageCalls++;
        const requested = Number(params.get('count'));
        const offset = Number(params.get('startIndex'));
        const body = pages ? pages[index] : matched.slice(offset, offset + requested);
        return new Response(collection(body || [], pageMatchedCounts[index]), { headers: { 'content-type': 'application/json' } });
    });
    return { fetchImpl, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('Frankfurt cadastral WFS', () => {
    it('strictly binds the endpoint, feature type, safe identity fields, and limits', () => {
        expect(() => createFrankfurtWfsParcelSource({ ...descriptor, endpoint: 'https://example.com/wfs' })).toThrow(/descriptor/);
        expect(() => createFrankfurtWfsParcelSource({ ...descriptor, featureType: 'other:Layer' })).toThrow(/descriptor/);
        expect(() => createFrankfurtWfsParcelSource({ ...descriptor, outFields: ['FSK', 'owner', 'OBJECTID'] })).toThrow(/descriptor/);
        expect(() => createFrankfurtWfsParcelSource({ ...descriptor, maxFeatures: 3001 })).toThrow(/descriptor/);
    });

    it('queries native EPSG:25832 with bounded hits-before/pages/hits-after and strict safe fields', async () => {
        const { fetchImpl, calls } = mockFetch();
        const source = createFrankfurtWfsParcelSource(descriptor, { fetchImpl });
        const result = await source.queryBounds([8.671, 50.119, 8.674, 50.121]);

        expect(result).toMatchObject({ complete: true, sourceId: descriptor.id, returnsWGS84: true });
        expect(result.features).toHaveLength(3);
        expect(result.features.map(feature => feature.properties.sourceParcelId)).toEqual([fsk1, fsk2, fsk3]);
        expect(result.features.every(feature => feature.geometry.type === 'MultiPolygon')).toBe(true);
        expect(calls).toHaveLength(4); // hits, page 0, page 2, hits
        const countCalls = calls.filter(call => call.url.searchParams.get('resultType') === 'hits');
        expect(countCalls).toHaveLength(2);
        expect(countCalls.map(call => call.url.searchParams.get('outputFormat'))).toEqual(['GML32', 'GML32']);
        expect(countCalls[0].url.searchParams.get('bbox')).toBe(countCalls[1].url.searchParams.get('bbox'));
        for (const call of calls.slice(1, 3)) {
            expect(call.url.searchParams.get('srsName')).toBe(nativeCrs);
            expect(call.url.searchParams.get('propertyName')).toBe('SHAPE,FSK,OBJECTID');
            expect(call.url.searchParams.has('sortBy')).toBe(false); // server rejects SortBy despite advertising it
        }
        expect(calls[1].url.searchParams.get('startIndex')).toBe('0');
        expect(calls[2].url.searchParams.get('startIndex')).toBe('2');
        const nativeBox = calls[1].url.searchParams.get('bbox').split(',').slice(0, 4).map(Number);
        expect(nativeBox[0]).toBeGreaterThan(400000);
        expect(nativeBox[1]).toBeGreaterThan(5000000);
        expect(result.features[0].properties.sourceProperties).toEqual({ FSK: fsk1, OBJECTID: 3807 });
        expect(result.features[0].properties.cadMunicipalityName).toBeNull();
    });

    it('uses FES2 exact-ID equality, freshly confirms absence, and emits only safe source fields', async () => {
        const { fetchImpl, calls } = mockFetch();
        const source = createFrankfurtWfsParcelSource(descriptor, { fetchImpl });
        const result = await source.queryIds([`DE-FFM-${fsk1}`, `DE-FFM-${fsk2}`]);
        expect(result.absentIds).toEqual([]);
        expect(result.features.map(feature => feature.properties.sourceParcelId)).toEqual([fsk1, fsk2]);
        const exactRequest = calls.find(call => call.url.searchParams.has('filter'));
        const filter = exactRequest.url.searchParams.get('filter');
        expect(filter).toContain('<fes:Filter');
        expect(filter).toContain('<fes:Or>');
        expect(filter).toContain('<fes:ValueReference>FSK</fes:ValueReference>');
        expect(filter).toContain(`<fes:Literal>${fsk1}</fes:Literal>`);
        expect(filter).toContain(`<fes:Literal>${fsk2}</fes:Literal>`);
        expect(exactRequest.url.searchParams.get('propertyName')).toBe('SHAPE,FSK,OBJECTID');

        const absentMock = mockFetch();
        const absent = await createFrankfurtWfsParcelSource(descriptor, { fetchImpl: absentMock.fetchImpl }).queryIds([`DE-FFM-${missingFsk}`]);
        expect(absent).toMatchObject({ complete: true, features: [], absentIds: [`DE-FFM-${missingFsk}`] });
        expect(absentMock.fetchImpl).toHaveBeenCalledTimes(2); // no page; fresh zero-hit checks before and after
        expect(absentMock.calls.every(call => call.url.searchParams.get('filter')?.includes(missingFsk))).toBe(true);
    });

    it('does not silently discard native geometry and filters viewport candidates locally', async () => {
        const { fetchImpl } = mockFetch({ data: [
            row({ objectId: 3807, fsk: fsk1, geometry: nativeSquare(8.6722, 50.1194) }),
            row({ objectId: 3814, fsk: fsk2, geometry: nativeSquare(8.6728, 50.1198) })
        ] });
        const source = createFrankfurtWfsParcelSource(descriptor, { fetchImpl });
        const proposal = {
            type: 'Polygon', coordinates: [[[8.6720, 50.1192], [8.6730, 50.1192], [8.6720, 50.1202], [8.6720, 50.1192]]]
        };
        const result = await source.queryGeometry(proposal);
        expect(result.features.map(feature => feature.properties.sourceParcelId)).toEqual([fsk1]);
        expect(result.features[0].geometry.coordinates[0][0]).toHaveLength(5);
        expect(result.features[0].geometry.coordinates[0][0][0]).toHaveLength(2);
        expect(result.features[0].geometry.coordinates[0][0][0][0]).toBeCloseTo(8.6722, 4);
    });

    it('rejects repeated native FSKs in bounds and exact-ID responses', async () => {
        const duplicateRows = [row({ objectId: 3807, fsk: fsk1 }), row({ objectId: 3814, fsk: fsk1 })];
        const bounds = mockFetch({ data: duplicateRows });
        await expect(createFrankfurtWfsParcelSource({ ...descriptor, pageSize: 2 }, { fetchImpl: bounds.fetchImpl })
            .queryBounds([8.671, 50.119, 8.674, 50.121])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });

        const exact = mockFetch({ data: duplicateRows });
        await expect(createFrankfurtWfsParcelSource({ ...descriptor, pageSize: 2 }, { fetchImpl: exact.fetchImpl })
            .queryIds([`DE-FFM-${fsk1}`])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it('checks optional numberMatched against the total across pages', async () => {
        const valid = mockFetch({ pageMatchedCounts: [3, 3] });
        const result = await createFrankfurtWfsParcelSource(descriptor, { fetchImpl: valid.fetchImpl })
            .queryBounds([8.671, 50.119, 8.674, 50.121]);
        expect(result.features).toHaveLength(3);

        const invalid = mockFetch({ pageMatchedCounts: [2, 3] });
        await expect(createFrankfurtWfsParcelSource(descriptor, { fetchImpl: invalid.fetchImpl })
            .queryBounds([8.671, 50.119, 8.674, 50.121])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it('enforces one deadline across all requests', async () => {
        let now = 1000;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const { fetchImpl, calls } = mockFetch({ onRequest: () => { now += 20000; } });
        await expect(createFrankfurtWfsParcelSource(descriptor, { fetchImpl })
            .queryBounds([8.671, 50.119, 8.674, 50.121])).rejects.toMatchObject({ status: 504 });
        expect(calls).toHaveLength(3);
        nowSpy.mockRestore();
    });

    it('rejects an unexpected FSK in an exact-ID response', async () => {
        const wrong = row({ fsk: missingFsk });
        const { fetchImpl } = mockFetch({ data: [wrong], pages: [[wrong]], ignoreFilter: true });
        const source = createFrankfurtWfsParcelSource({ ...descriptor, pageSize: 5 }, { fetchImpl });
        await expect(source.queryIds([`DE-FFM-${fsk1}`])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it.each([
        { name: 'changing count', options: { countOverrides: [3, 2] } },
        { name: 'repeated page', options: { pages: [rows.slice(0, 2), [rows[1]]] } },
        { name: 'missing GmlID', options: { pages: [[row({ gmlId: '' }), ...rows.slice(1)]] } },
        { name: 'extra unrequested field', options: { pages: [[row({ properties: { UID: 'not-requested' } }), ...rows.slice(1)]] } },
        { name: 'wrong transport ID', options: { pages: [[row({ gmlId: 'Flurstueck.9999' }), ...rows.slice(1)]] } },
        { name: 'invalid geometry', options: { pages: [[row({ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] } }), ...rows.slice(1)]] } }
    ])('fails closed for $name', async ({ options }) => {
        const { fetchImpl } = mockFetch(options);
        const source = createFrankfurtWfsParcelSource({ ...descriptor, pageSize: 3 }, { fetchImpl });
        await expect(source.queryBounds([8.671, 50.119, 8.674, 50.121])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it('rejects incomplete pages and a CRS change before returning partial data', async () => {
        const incomplete = mockFetch({ pages: [rows.slice(0, 2), []] });
        await expect(createFrankfurtWfsParcelSource(descriptor, { fetchImpl: incomplete.fetchImpl })
            .queryBounds([8.671, 50.119, 8.674, 50.121])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });

        const wrongCrsHits = mockFetch();
        const wrongCrsFetch = vi.fn(async (input, options) => {
            const url = new URL(typeof input === 'string' ? input : input.url);
            if (url.searchParams.get('resultType') === 'hits') return wrongCrsHits.fetchImpl(input, options);
            return new Response(JSON.stringify({ type: 'FeatureCollection', crs: {
                type: 'name', properties: { name: 'EPSG:3857' }
            }, features: rows }), { headers: { 'content-type': 'application/json' } });
        });
        await expect(createFrankfurtWfsParcelSource({ ...descriptor, pageSize: 5 }, { fetchImpl: wrongCrsFetch })
            .queryBounds([8.671, 50.119, 8.674, 50.121])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        expect(wrongCrsFetch).toHaveBeenCalledTimes(2);

        const missingCrsHits = mockFetch();
        const missingCrsFetch = vi.fn(async (input, options) => {
            const url = new URL(typeof input === 'string' ? input : input.url);
            if (url.searchParams.get('resultType') === 'hits') return missingCrsHits.fetchImpl(input, options);
            return new Response(JSON.stringify({ type: 'FeatureCollection', features: rows }), { headers: { 'content-type': 'application/json' } });
        });
        await expect(createFrankfurtWfsParcelSource({ ...descriptor, pageSize: 5 }, { fetchImpl: missingCrsFetch })
            .queryBounds([8.671, 50.119, 8.674, 50.121])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        expect(missingCrsFetch).toHaveBeenCalledTimes(2);
    });

    it('bounds response bytes and maps upstream timeout and HTTP errors', async () => {
        const large = vi.fn(async () => new Response('x'.repeat(300), { headers: { 'content-type': 'application/xml' } }));
        await expect(createFrankfurtWfsParcelSource({ ...descriptor, maxResponseBytes: 256 }, { fetchImpl: large })
            .queryBounds([8.671, 50.119, 8.674, 50.121])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });

        const timeout = vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); });
        await expect(createFrankfurtWfsParcelSource(descriptor, { fetchImpl: timeout })
            .queryBounds([8.671, 50.119, 8.674, 50.121])).rejects.toMatchObject({ status: 504 });

        const blocked = vi.fn(async () => new Response('', { status: 403 }));
        await expect(createFrankfurtWfsParcelSource(descriptor, { fetchImpl: blocked })
            .queryBounds([8.671, 50.119, 8.674, 50.121])).rejects.toMatchObject({ code: 'parcel-source-blocked', upstreamStatus: 403 });
    });

    it('rejects invalid WGS84 query footprints and foreign or malformed exact IDs before I/O', async () => {
        const fetchImpl = vi.fn();
        const source = createFrankfurtWfsParcelSource(descriptor, { fetchImpl });
        await expect(source.queryBounds([8, 50, 9, 51])).rejects.toMatchObject({ status: 400 });
        await expect(source.queryGeometry({ type: 'Point', coordinates: [8.67, 50.11] })).rejects.toMatchObject({ status: 400 });
        await expect(source.queryIds(['OTHER-' + fsk1])).rejects.toMatchObject({ status: 400 });
        await expect(source.queryIds(['DE-FFM-not-a-key'])).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
