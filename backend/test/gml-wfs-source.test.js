import { describe, it, expect, vi } from 'vitest';
import proj4 from 'proj4';
import { createGmlWfsParcelSource } from '../parcels/gml-wfs-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { SAXONY_GML_SCHEMA, POZNAN_GML_SCHEMA } from '../parcels/gml-parcel-reader.js';

const NS = 'http://mapserver.gis.umn.edu/mapserver';
const GML = 'http://www.opengis.net/gml/3.2';
const ID1 = '146501_1.0001.31/1';
const ID2 = '146501_1.0001.31/2';
const ID3 = '146501_1.0001.31/3';
const PREFIX = 'PL-LODZ-';
const descriptor = {
    adapter: 'gml-wfs', id: 'lodz-gml-wfs', endpoint: 'https://igeodeta.log.lodz.pl/cgi-bin/lodz-egib',
    featureType: 'ms:dzialki', idField: 'ID_DZIALKI', geometryField: 'msGeometry', responseCrs: 'EPSG:3857',
    idPrefix: PREFIX, idType: 'string', parcelNumberField: 'ID_DZIALKI', outFields: ['ID_DZIALKI'],
    maxBboxKm2: 25, pageSize: 2, maxFeatures: 20
};
const DRESDEN_ID = '140209___00622001002';
const dresdenDescriptor = {
    adapter: 'gml-wfs', id: 'dresden-saxony-gml-wfs', endpoint: 'https://geodienste.sachsen.de/aaa/public_alkis/vereinf/wfs',
    featureType: 'ave:Flurstueck', idField: 'flstkennz', geometryField: 'geometrie', responseCrs: 'EPSG:25833',
    idPrefix: 'DE-SN-', idType: 'string', parcelNumberField: 'flstkennz', outFields: ['flstkennz'],
    maxBboxKm2: 25, pageSize: 2, maxFeatures: 20
};
const POZNAN_ID = '306401_1.0051.AR_44.27/14';
const POZNAN_PREFIX = 'PL-POZNAN-';
const poznanDescriptor = {
    adapter: 'gml-wfs', id: 'poznan-gml-wfs', endpoint: 'https://portal.geopoz.poznan.pl/wmsegib',
    featureType: 'ms:dzialki', idField: 'ID_DZIALKI', geometryField: 'MSGEOMETRY', responseCrs: 'EPSG:2177',
    idPrefix: POZNAN_PREFIX, idType: 'string', parcelNumberField: 'ID_DZIALKI', outFields: ['ID_DZIALKI'],
    maxBboxKm2: 1, pageSize: 2, maxFeatures: 20
};
function dresdenMember(id, offset = 0) {
    const x = 412476.5 + offset, y = 5655152.5;
    return `<wfs:member><ave:Flurstueck><ave:geometrie><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::25833" srsDimension="2"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>${x} ${y} ${x + 4} ${y} ${x + 4} ${y + 4} ${x} ${y + 4} ${x} ${y}</g:posList></g:LinearRing></g:exterior></g:Polygon></g:surfaceMember></g:MultiSurface></ave:geometrie><ave:flstkennz>${id}</ave:flstkennz><ave:lagebeztxt>not retained</ave:lagebeztxt></ave:Flurstueck></wfs:member>`;
}
function dresdenCollection(ids, matched = ids.length) {
    return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ave="${SAXONY_GML_SCHEMA.featureNamespace}" xmlns:g="http://www.opengis.net/gml/3.2" numberMatched="${matched}" numberReturned="${ids.length}">${ids.map((id, index) => dresdenMember(id, index * 6)).join('')}</wfs:FeatureCollection>`;
}
function poznanMember(id, offset = 0, extras = '') {
    const [east, north] = proj4('EPSG:4326', 'EPSG:2177').forward([16.9139953760299, 52.4033374848812]);
    const n = north + offset, e = east;
    const ring = `${n - 5} ${e - 5} ${n - 5} ${e + 5} ${n + 5} ${e + 5} ${n + 5} ${e - 5} ${n - 5} ${e - 5}`;
    return `<wfs:member><ms:dzialki><ms:MSGEOMETRY><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::2177" srsDimension="2"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>${ring}</g:posList></g:LinearRing></g:exterior></g:Polygon></g:surfaceMember></g:MultiSurface></ms:MSGEOMETRY><ms:ID_DZIALKI>${id}</ms:ID_DZIALKI>${extras}</ms:dzialki></wfs:member>`;
}
function poznanCollection(ids, matched = ids.length) {
    const matchAttribute = matched === null ? '' : `numberMatched="${matched}"`;
    return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="${POZNAN_GML_SCHEMA.featureNamespace}" xmlns:g="http://www.opengis.net/gml/3.2" ${matchAttribute} numberReturned="${ids.length}">${ids.map((id, index) => poznanMember(id.id ?? id, index * 20, id.extras ?? '')).join('')}</wfs:FeatureCollection>`;
}

function member(id, delta = 0, crs = 'EPSG:3857') {
    const x = 2165000 + delta, y = 6750000;
    return `<wfs:member><ms:dzialki><ms:msGeometry><g:Polygon srsName="${crs}" srsDimension="2"><g:exterior><g:LinearRing><g:posList>${x} ${y} ${x + 10} ${y} ${x + 10} ${y + 10} ${x} ${y + 10} ${x} ${y}</g:posList></g:LinearRing></g:exterior></g:Polygon></ms:msGeometry><ms:ID_DZIALKI>${id}</ms:ID_DZIALKI><ms:NUMER_DZIALKI>must not be returned</ms:NUMER_DZIALKI></ms:dzialki></wfs:member>`;
}
function collection(ids, matched = ids.length, crs = 'EPSG:3857') {
    const matchAttribute = matched === null ? '' : `numberMatched="${matched}"`;
    return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="${NS}" xmlns:g="${GML}" ${matchAttribute} numberReturned="${ids.length}">${ids.map((item, index) => member(item.id ?? item, item.delta ?? index * 20, crs)).join('')}</wfs:FeatureCollection>`;
}
function xmlResponse(body, status = 200) {
    return new Response(body, { status, headers: { 'content-type': 'application/gml+xml; version=3.2' } });
}
function hitResponse(matched) {
    return xmlResponse(`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="${matched}" numberReturned="0"/>`);
}
function filterIds(url) {
    return [...url.searchParams.get('filter').matchAll(/<fes:Literal>([^<]+)<\/fes:Literal>/g)].map(match => match[1]);
}

describe('strict Łódź WFS2 GML source', () => {
    it('requests only the whitelisted ID and geometry, projects bounded pages, and requires complete counts', async () => {
        const requests = [];
        const fetchImpl = vi.fn(async url => {
            const parsed = new URL(url); requests.push(parsed);
            if (parsed.searchParams.get('resultType') === 'hits') return hitResponse(3);
            const start = Number(parsed.searchParams.get('startIndex'));
            return start === 0 ? xmlResponse(collection([ID1, ID2], 'unknown')) : xmlResponse(collection([{ id: ID3, delta: 1000 }], 'unknown'));
        });
        const source = createGmlWfsParcelSource(descriptor, { fetchImpl });
        const result = await source.queryBounds([19.448, 51.721, 19.450, 51.724]);
        expect(result.complete).toBe(true);
        expect(result.features).toHaveLength(2);
        expect(result.features.every(feature => Object.keys(feature.properties.sourceProperties).join() === 'ID_DZIALKI')).toBe(true);
        expect(result.features.map(feature => feature.properties.sourceParcelId)).toEqual([ID1, ID2]);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        const filters = requests.map(request => request.searchParams.get('filter'));
        expect(new Set(filters).size).toBe(1);
        expect(requests.every(request => request.searchParams.get('bbox') === null)).toBe(true);
        const spatialFilter = filters[0];
        expect(spatialFilter).toContain('<fes:Intersects>');
        expect(spatialFilter).toContain('<fes:ValueReference>ms:msGeometry</fes:ValueReference>');
        expect(spatialFilter).toContain(`xmlns:gml="${GML}"`);
        expect(spatialFilter).toContain(`srsName="urn:ogc:def:crs:EPSG::3857"`);
        const posList = /<gml:posList srsDimension="2">([\s\S]*?)<\/gml:posList>/.exec(spatialFilter)?.[1];
        const coordinates = posList?.trim().split(/\s+/).map(Number);
        const southwest = proj4('EPSG:4326', 'EPSG:3857').forward([19.448, 51.721]);
        const northeast = proj4('EPSG:4326', 'EPSG:3857').forward([19.450, 51.724]);
        const expectedRing = [southwest[0], southwest[1], northeast[0], southwest[1], northeast[0], northeast[1], southwest[0], northeast[1], southwest[0], southwest[1]];
        expect(coordinates).toHaveLength(10);
        coordinates.forEach((value, index) => expect(value).toBeCloseTo(expectedRing[index], 7));
        for (const request of requests) {
            expect(request.origin + request.pathname).toBe('https://igeodeta.log.lodz.pl/cgi-bin/lodz-egib');
            expect(request.searchParams.get('version')).toBe('2.0.0');
            expect(request.searchParams.get('typeNames')).toBe('ms:dzialki');
            expect(request.searchParams.get('srsName')).toBe('urn:ogc:def:crs:EPSG::3857');
            expect(request.searchParams.get('propertyName')).toBe('ms:ID_DZIALKI,ms:msGeometry');
            expect(request.searchParams.get('sortBy')).toBe('ms:ID_DZIALKI');
            expect(request.searchParams.get('filter')).toBe(spatialFilter);
        }
        expect(requests[1].searchParams.get('count')).toBe('2');
        expect(requests[2].searchParams.get('startIndex')).toBe('2');
        expect(requests[3].searchParams.get('resultType')).toBe('hits');
    });

    it('uses exact FES2 ID equality and reports absence only after the full matched set was read', async () => {
        const requests = [];
        const fetchImpl = vi.fn(async url => {
            const parsed = new URL(url); requests.push(parsed);
            if (parsed.searchParams.get('resultType') === 'hits') return hitResponse(1);
            return xmlResponse(collection([ID1], 1));
        });
        const source = createGmlWfsParcelSource(descriptor, { fetchImpl });
        const result = await source.queryIds([`${PREFIX}${ID1}`, `${PREFIX}${ID2}`]);
        expect(result.features).toHaveLength(1);
        expect(result.absentIds).toEqual([`${PREFIX}${ID2}`]);
        const filter = requests[0].searchParams.get('filter');
        expect(filter).toContain('<fes:Or>');
        expect(filter).toContain('<fes:ValueReference>ms:ID_DZIALKI</fes:ValueReference>');
        expect(filter).toContain(`<fes:Literal>${ID1}</fes:Literal>`);
        expect(filter).toContain(`<fes:Literal>${ID2}</fes:Literal>`);
        expect(requests[0].searchParams.get('propertyName')).toBe('ms:ID_DZIALKI,ms:msGeometry');
    });

    it('splits 20 exact IDs into bounded batches and aggregates only completed results', async () => {
        const ids = Array.from({ length: 20 }, (_, index) => `146501_1.0001.${index + 1}/${index + 1}`);
        const missing = ids[7];
        const requests = [];
        const fetchImpl = vi.fn(async rawUrl => {
            const url = new URL(rawUrl); requests.push(url);
            const batchIds = filterIds(url);
            const returnedIds = batchIds.filter(id => id !== missing);
            if (url.searchParams.get('resultType') === 'hits') return hitResponse(returnedIds.length);
            return xmlResponse(collection(returnedIds, returnedIds.length));
        });
        const source = createGmlWfsParcelSource({ ...descriptor, pageSize: 100 }, { fetchImpl });
        const result = await source.queryIds(ids.map(id => `${PREFIX}${id}`));
        expect(result.complete).toBe(true);
        expect(result.features).toHaveLength(19);
        expect(result.numberMatched).toBe(19);
        expect(result.absentIds).toEqual([`${PREFIX}${missing}`]);
        const filters = [...new Set(requests.map(url => url.searchParams.get('filter')))];
        expect(filters).toHaveLength(3);
        expect(filters.map(filter => [...filter.matchAll(/<fes:Literal>/g)].length)).toEqual([8, 8, 4]);
        expect(requests.every(url => url.href.length < 8000 && url.searchParams.get('bbox') === null)).toBe(true);
        for (const filter of filters) {
            const calls = requests.filter(url => url.searchParams.get('filter') === filter);
            expect(calls.some(url => url.searchParams.get('resultType') === 'hits')).toBe(true);
            expect(calls.some(url => url.searchParams.has('count'))).toBe(true);
            expect(new Set(calls.map(url => url.searchParams.get('sortBy')))).toEqual(new Set(['ms:ID_DZIALKI']));
        }
    });

    it('shares byte and time budgets across ID batches and rejects the entire lookup if a later batch fails', async () => {
        const ids = Array.from({ length: 16 }, (_, index) => `146501_1.0001.${index + 1}/${index + 1}`);
        const hitBytes = new TextEncoder().encode(await hitResponse(8).text()).byteLength;
        const pageBytes = Math.max(...await Promise.all([ids.slice(0, 8), ids.slice(8, 16)].map(async batch =>
            new TextEncoder().encode(await xmlResponse(collection(batch, 8)).text()).byteLength)));
        const oneBatchBytes = hitBytes * 2 + pageBytes;
        const budgeted = createGmlWfsParcelSource({ ...descriptor, pageSize: 100,
            maxResponseBytes: pageBytes, maxTotalResponseBytes: oneBatchBytes }, {
            fetchImpl: async url => new URL(url).searchParams.get('resultType') === 'hits'
                ? hitResponse(8) : xmlResponse(collection(filterIds(new URL(url)), 8))
        });
        await expect(budgeted.queryIds(ids.map(id => `${PREFIX}${id}`))).rejects.toThrow(/byte limit/);

        const baseTime = Date.now();
        let elapsed = 0, timedCalls = 0;
        const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => baseTime + elapsed);
        const timed = createGmlWfsParcelSource({ ...descriptor, pageSize: 100 }, {
            fetchImpl: async url => {
                timedCalls++;
                const parsed = new URL(url);
                const response = parsed.searchParams.get('resultType') === 'hits'
                    ? hitResponse(filterIds(parsed).length) : xmlResponse(collection(filterIds(parsed), filterIds(parsed).length));
                elapsed += 12000;
                return response;
            }
        });
        try {
            await expect(timed.queryIds(ids.map(id => `${PREFIX}${id}`))).rejects.toThrow(/timed out/);
            expect(timedCalls).toBe(5);
        } finally { dateNow.mockRestore(); }

        let calls = 0;
        const failing = createGmlWfsParcelSource({ ...descriptor, pageSize: 100 }, {
            fetchImpl: async url => {
                calls++;
                const parsed = new URL(url);
                if (calls === 5) return new Response('upstream error', { status: 500 });
                return parsed.searchParams.get('resultType') === 'hits'
                    ? hitResponse(filterIds(parsed).length) : xmlResponse(collection(filterIds(parsed), filterIds(parsed).length));
            }
        });
        await expect(failing.queryIds(ids.slice(0, 9).map(id => `${PREFIX}${id}`))).rejects.toThrow(/HTTP 500/);
        expect(calls).toBe(5);
    });

    it('rejects partial counts, changed response CRS, unsafe IDs, and descriptor drift', async () => {
        const fetchImpl = vi.fn(async url => new URL(url).searchParams.get('resultType') === 'hits'
            ? hitResponse(1) : xmlResponse(collection([ID1], 2)));
        const source = createGmlWfsParcelSource(descriptor, { fetchImpl });
        await expect(source.queryIds([`${PREFIX}${ID1}`])).rejects.toThrow(/page counts/);

        const omittedCount = createGmlWfsParcelSource(descriptor, { fetchImpl: async url => new URL(url).searchParams.get('resultType') === 'hits'
            ? hitResponse(1) : xmlResponse(collection([ID1], null)) });
        await expect(omittedCount.queryIds([`${PREFIX}${ID1}`])).rejects.toThrow(/page counts/);

        const wrongCrs = createGmlWfsParcelSource(descriptor, { fetchImpl: async url => new URL(url).searchParams.get('resultType') === 'hits'
            ? hitResponse(1) : xmlResponse(collection([ID1], 1, 'EPSG:2177')) });
        await expect(wrongCrs.queryIds([`${PREFIX}${ID1}`])).rejects.toThrow(/coordinate system/);
        await expect(source.queryIds([`${PREFIX}<bad>`])).rejects.toThrow(/Invalid parcel ID/);
        expect(() => createGmlWfsParcelSource({ ...descriptor, endpoint: 'https://other.example/wfs' }, { fetchImpl })).toThrow(/descriptor/);
    });

    it('rejects conflicting geometry for a repeated native ID across pages', async () => {
        const fetchImpl = vi.fn(async url => {
            const parsed = new URL(url);
            if (parsed.searchParams.get('resultType') === 'hits') return hitResponse(2);
            return Number(parsed.searchParams.get('startIndex')) === 0
                ? xmlResponse(collection([ID1], 2)) : xmlResponse(collection([{ id: ID1, delta: 15 }], 2));
        });
        const source = createGmlWfsParcelSource({ ...descriptor, pageSize: 1 }, { fetchImpl });
        await expect(source.queryIds([`${PREFIX}${ID1}`])).rejects.toThrow(/conflicting geometry/);
    });

    it('does not claim requested IDs absent when the complete match set repeats one native identity', async () => {
        const fetchImpl = vi.fn(async url => {
            const parsed = new URL(url);
            if (parsed.searchParams.get('resultType') === 'hits') return hitResponse(2);
            return xmlResponse(collection([ID1], 2));
        });
        const source = createGmlWfsParcelSource({ ...descriptor, pageSize: 1 }, { fetchImpl });
        await expect(source.queryIds([`${PREFIX}${ID1}`, `${PREFIX}${ID2}`])).rejects.toThrow(/repeated a native parcel identity/);
    });

    it('rejects identical duplicate native identities in viewport pages', async () => {
        const fetchImpl = vi.fn(async url => new URL(url).searchParams.get('resultType') === 'hits'
            ? hitResponse(2) : xmlResponse(collection([{ id: ID1, delta: 0 }, { id: ID1, delta: 0 }], 2)));
        const source = createGmlWfsParcelSource(descriptor, { fetchImpl });
        await expect(source.queryBounds([19.448, 51.721, 19.450, 51.724])).rejects.toThrow(/repeated a native parcel identity/);
    });

    it('requires numeric hit counts before and after pages and fails when they change', async () => {
        let hitCall = 0;
        const fetchImpl = vi.fn(async url => {
            if (new URL(url).searchParams.get('resultType') === 'hits') return hitResponse(++hitCall === 1 ? 1 : 2);
            return xmlResponse(collection([ID1], 1));
        });
        const source = createGmlWfsParcelSource(descriptor, { fetchImpl });
        await expect(source.queryIds([`${PREFIX}${ID1}`])).rejects.toThrow(/match count changed/);
        expect(hitCall).toBe(2);
    });

    it('enforces the aggregate response byte budget and never follows an HTTP redirect', async () => {
        const hitBytes = new TextEncoder().encode(await hitResponse(1).text()).byteLength;
        const pageBytes = new TextEncoder().encode(await xmlResponse(collection([ID1], 1)).text()).byteLength;
        const aggregateBytes = hitBytes * 2 + pageBytes;
        const limited = createGmlWfsParcelSource({ ...descriptor, maxResponseBytes: Math.max(hitBytes, pageBytes), maxTotalResponseBytes: aggregateBytes - 1 }, {
            fetchImpl: async url => new URL(url).searchParams.get('resultType') === 'hits' ? hitResponse(1) : xmlResponse(collection([ID1], 1))
        });
        await expect(limited.queryIds([`${PREFIX}${ID1}`])).rejects.toThrow(/byte limit/);

        const fetchImpl = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://other.example/' } }));
        const noRedirect = createGmlWfsParcelSource(descriptor, { fetchImpl });
        await expect(noRedirect.queryIds([`${PREFIX}${ID1}`])).rejects.toThrow(/HTTP 302/);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    });

    it('enforces the per-response byte limit and request timeout', async () => {
        const oversized = createGmlWfsParcelSource({ ...descriptor, maxResponseBytes: 100, maxTotalResponseBytes: 1000 }, {
            fetchImpl: async () => hitResponse(1)
        });
        await expect(oversized.queryIds([`${PREFIX}${ID1}`])).rejects.toThrow(/byte limit/);

        const timedOutFetch = vi.fn(async (_url, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')), { once: true });
        }));
        const timedOut = createGmlWfsParcelSource({ ...descriptor, timeoutMs: 100 }, { fetchImpl: timedOutFetch });
        await expect(timedOut.queryIds([`${PREFIX}${ID1}`])).rejects.toMatchObject({ status: 504 });
        expect(timedOutFetch).toHaveBeenCalledTimes(1);
    });

    it('wires the adapter factory without enabling a catalog source', () => {
        const source = createParcelSource(descriptor, { fetchImpl: async () => hitResponse(0) });
        expect(source).toHaveProperty('queryBounds');
        expect(source).toHaveProperty('queryIds');
        expect(source).toHaveProperty('queryGeometry');
    });
});

describe('strict Saxony/Dresden WFS2 GML source', () => {
    it('projects WGS84 bounds to EPSG:25833, sends exact allowlisted GML fields, checks counts, and queries exact native IDs', async () => {
        const requests = [];
        const fetchImpl = vi.fn(async raw => {
            const url = new URL(raw); requests.push(url);
            if (url.searchParams.get('resultType') === 'hits') return hitResponse(3);
            return Number(url.searchParams.get('startIndex')) === 2
                ? xmlResponse(dresdenCollection(['140209___00622001004'], 3))
                : xmlResponse(dresdenCollection([DRESDEN_ID, '140209___00622001003'], 3));
        });
        const source = createGmlWfsParcelSource(dresdenDescriptor, { fetchImpl });
        const bounds = [13.7515, 51.0412, 13.7517, 51.0414];
        const result = await source.queryBounds(bounds);
        expect(result.complete).toBe(true);
        expect(result.features).toHaveLength(3);
        expect(result.sourceId).toBe('dresden-saxony-gml-wfs');
        expect(result.features[0].properties.sourceParcelId).toBe(DRESDEN_ID);
        expect(result.features.every(feature => Object.keys(feature.properties.sourceProperties).join() === 'flstkennz')).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        expect(requests[1].searchParams.get('count')).toBe('2');
        expect(requests[2].searchParams.get('startIndex')).toBe('2');
        expect(requests[2].searchParams.get('count')).toBe('1');
        const filter = requests[0].searchParams.get('filter');
        expect(filter).toContain('<fes:ValueReference>ave:geometrie</fes:ValueReference>');
        expect(filter).toContain(`xmlns:ave="${SAXONY_GML_SCHEMA.featureNamespace}"`);
        expect(filter).toContain('xmlns:gml="http://www.opengis.net/gml/3.2"');
        expect(filter).toContain('srsName="urn:ogc:def:crs:EPSG::25833"');
        const listed = /<gml:posList srsDimension="2">([\s\S]*?)<\/gml:posList>/.exec(filter)[1].trim().split(/\s+/).map(Number);
        const edges = [];
        for (let step = 0; step <= 16; step++) {
            const t = step / 16;
            edges.push([bounds[0] + (bounds[2] - bounds[0]) * t, bounds[1]], [bounds[0] + (bounds[2] - bounds[0]) * t, bounds[3]]);
            edges.push([bounds[0], bounds[1] + (bounds[3] - bounds[1]) * t], [bounds[2], bounds[1] + (bounds[3] - bounds[1]) * t]);
        }
        const projected = edges.map(point => proj4('EPSG:4326', 'EPSG:25833').forward(point));
        const expected = [Math.min(...projected.map(point => point[0])), Math.min(...projected.map(point => point[1])),
            Math.max(...projected.map(point => point[0])), Math.max(...projected.map(point => point[1]))];
        expect(listed[0]).toBeCloseTo(expected[0], 5); expect(listed[1]).toBeCloseTo(expected[1], 5);
        expect(listed[2]).toBeCloseTo(expected[2], 5); expect(listed[5]).toBeCloseTo(expected[3], 5);
        for (const url of requests) {
            expect(url.origin + url.pathname).toBe(dresdenDescriptor.endpoint);
            expect(url.searchParams.get('version')).toBe('2.0.0');
            expect(url.searchParams.get('typeNames')).toBe('ave:Flurstueck');
            expect(url.searchParams.get('srsName')).toBe('urn:ogc:def:crs:EPSG::25833');
            expect(url.searchParams.get('propertyName')).toBe('ave:flstkennz,ave:geometrie');
            expect(url.searchParams.get('sortBy')).toBe('ave:flstkennz A');
            expect(url.searchParams.get('namespaces')).toBe(`xmlns(ave,${SAXONY_GML_SCHEMA.featureNamespace})`);
        }

        requests.length = 0;
        fetchImpl.mockClear();
        const idFetch = async raw => {
            const url = new URL(raw); requests.push(url);
            if (url.searchParams.get('resultType') === 'hits') return hitResponse(1);
            return xmlResponse(dresdenCollection([DRESDEN_ID], 1));
        };
        const idSource = createGmlWfsParcelSource(dresdenDescriptor, { fetchImpl: idFetch });
        const byId = await idSource.queryIds([`DE-SN-${DRESDEN_ID}`]);
        expect(byId.features).toHaveLength(1);
        expect(byId.absentIds).toEqual([]);
        expect(requests[0].searchParams.get('filter')).toContain('<fes:ValueReference>ave:flstkennz</fes:ValueReference>');
        expect(requests[0].searchParams.get('filter')).toContain(`<fes:Literal>${DRESDEN_ID}</fes:Literal>`);
        expect(requests[0].searchParams.get('propertyName')).toBe('ave:flstkennz,ave:geometrie');
    });

    it('rejects descriptor drift and native IDs outside the selected source prefix', async () => {
        const fetchImpl = async () => hitResponse(0);
        expect(() => createGmlWfsParcelSource({ ...dresdenDescriptor, responseCrs: 'EPSG:3857' }, { fetchImpl })).toThrow(/descriptor/);
        const source = createGmlWfsParcelSource(dresdenDescriptor, { fetchImpl });
        await expect(source.queryIds(['PL-LODZ-146501_1.0001.31/1'])).rejects.toThrow(/Invalid parcel ID/);
    });
});

describe('strict Poznań WFS2 GML source', () => {
    it('projects the WUP viewport in EPSG:2177 axis order, omits unsupported sortBy, and retains only ID and geometry', async () => {
        const requests = [];
        const fetchImpl = vi.fn(async raw => {
            const url = new URL(raw); requests.push(url);
            if (url.searchParams.get('resultType') === 'hits') return hitResponse(1);
            return xmlResponse(poznanCollection([{ id: POZNAN_ID, extras: '<ms:KW>discarded</ms:KW><ms:OWNER>discarded</ms:OWNER>' }], 'unknown'));
        });
        const source = createParcelSource(poznanDescriptor, { fetchImpl });
        const bounds = [16.913, 52.403, 16.914, 52.404];
        const result = await source.queryBounds(bounds);
        expect(result.complete).toBe(true);
        expect(result.features).toHaveLength(1);
        expect(result.features[0].id).toBe(`${POZNAN_PREFIX}${POZNAN_ID}`);
        expect(result.features[0].properties.sourceProperties).toEqual({ ID_DZIALKI: POZNAN_ID });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        const filter = requests[0].searchParams.get('filter');
        expect(filter).toContain('<fes:ValueReference>ms:MSGEOMETRY</fes:ValueReference>');
        expect(filter).toContain(`xmlns:ms="${POZNAN_GML_SCHEMA.featureNamespace}"`);
        expect(filter).toContain('srsName="urn:ogc:def:crs:EPSG::2177"');
        const listed = /<gml:posList srsDimension="2">([\s\S]*?)<\/gml:posList>/.exec(filter)[1].trim().split(/\s+/).map(Number);
        const projected = [];
        for (let step = 0; step <= 16; step++) {
            const t = step / 16;
            projected.push([bounds[0] + (bounds[2] - bounds[0]) * t, bounds[1]], [bounds[0] + (bounds[2] - bounds[0]) * t, bounds[3]]);
            projected.push([bounds[0], bounds[1] + (bounds[3] - bounds[1]) * t], [bounds[2], bounds[1] + (bounds[3] - bounds[1]) * t]);
        }
        const xy = projected.map(point => proj4('EPSG:4326', 'EPSG:2177').forward(point));
        const minE = Math.min(...xy.map(point => point[0])), maxE = Math.max(...xy.map(point => point[0]));
        const minN = Math.min(...xy.map(point => point[1])), maxN = Math.max(...xy.map(point => point[1]));
        const expected = [minN,minE,minN,maxE,maxN,maxE,maxN,minE,minN,minE];
        expect(listed).toHaveLength(expected.length);
        listed.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 5));
        for (const url of requests) {
            expect(url.origin + url.pathname).toBe(poznanDescriptor.endpoint);
            expect(url.searchParams.get('typeNames')).toBe('ms:dzialki');
            expect(url.searchParams.get('srsName')).toBe('urn:ogc:def:crs:EPSG::2177');
            expect(url.searchParams.get('propertyName')).toBe('ms:ID_DZIALKI,ms:MSGEOMETRY');
            expect(url.searchParams.has('sortBy')).toBe(false);
            expect(url.searchParams.get('filter')).toBe(filter);
        }
    });

    it('reads exact underscore/slash IDs in complete bounded batches and confirms explicit absence', async () => {
        const requests = [];
        const absent = '999999999999';
        const fetchImpl = vi.fn(async raw => {
            const url = new URL(raw); requests.push(url);
            const ids = [...url.searchParams.get('filter').matchAll(/<fes:Literal>([^<]+)<\/fes:Literal>/g)].map(match => match[1]);
            if (url.searchParams.get('resultType') === 'hits') return hitResponse(ids.includes(absent) ? 0 : ids.length);
            return xmlResponse(poznanCollection(ids.filter(id => id !== absent)));
        });
        const source = createGmlWfsParcelSource(poznanDescriptor, { fetchImpl });
        const present = await source.queryIds([`${POZNAN_PREFIX}${POZNAN_ID}`]);
        expect(present.complete).toBe(true);
        expect(present.absentIds).toEqual([]);
        expect(present.features.map(feature => feature.properties.sourceParcelId)).toEqual([POZNAN_ID]);
        expect(requests.some(url => url.searchParams.get('filter').includes(`<fes:Literal>${POZNAN_ID}</fes:Literal>`))).toBe(true);
        const missing = await source.queryIds([`${POZNAN_PREFIX}${absent}`]);
        expect(missing.complete).toBe(true);
        expect(missing.features).toEqual([]);
        expect(missing.absentIds).toEqual([`${POZNAN_PREFIX}${absent}`]);
    });

    it('rejects descriptor drift, extra attributes, unsafe IDs and incomplete page counts', async () => {
        const fetchImpl = async url => new URL(url).searchParams.get('resultType') === 'hits' ? hitResponse(1) : xmlResponse(poznanCollection([POZNAN_ID], 2));
        expect(() => createGmlWfsParcelSource({ ...poznanDescriptor, endpoint: 'https://other.example/wfs' }, { fetchImpl })).toThrow(/descriptor/);
        expect(() => createGmlWfsParcelSource({ ...poznanDescriptor, outFields: ['ID_DZIALKI','KW'] }, { fetchImpl })).toThrow(/descriptor/);
        const source = createGmlWfsParcelSource(poznanDescriptor, { fetchImpl });
        await expect(source.queryIds([`${POZNAN_PREFIX}<unsafe>`])).rejects.toThrow(/Invalid parcel ID/);
        await expect(source.queryIds([`${POZNAN_PREFIX}${POZNAN_ID}`])).rejects.toThrow(/page counts/);
    });
});
