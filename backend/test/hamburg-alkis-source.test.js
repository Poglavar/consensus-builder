// Protect the narrow public WFS contract: stable complete geometry and safe IDs only.
import { describe, expect, it, vi } from 'vitest';
import { createHamburgAlkisParcelSource } from '../parcels/hamburg-alkis-source.js';

const descriptor = {
    id: 'de-hh-alkis-flurstueck', adapter: 'hamburg-alkis-wfs',
    endpoint: 'https://geodienste.hamburg.de/WFS_HH_ALKIS_vereinfacht', featureType: 'ave:Flurstueck',
    idField: 'flstkennz', idPrefix: 'DE-HH-ALKIS-', idPattern: '^02[0-9_]{18}$',
    outFields: ['flstkennz', 'oid'], maxBboxKm2: 1, maxFeatures: 5000
};
const key1 = '020302___00717______';
const key2 = '020302___01391______';
const polygon = (x = 9.99) => ({ type: 'Polygon', coordinates: [[[x, 53.57], [x + 0.001, 53.57], [x + 0.001, 53.571], [x, 53.571], [x, 53.57]]] });
const feature = (key, transportId, geometry = polygon()) => ({ type: 'Feature', id: transportId,
    properties: { flstkennz: key, oid: `OID-${key}`, lagebeztxt: 'sensitive address', owner: 'sensitive owner' }, geometry });
const hits = (count, body = {}) => new Response(`<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="${count}" numberReturned="0"/>`, body);
const collection = features => new Response(JSON.stringify({ type: 'FeatureCollection', features }));
const bounds = [9.99, 53.57, 9.991, 53.571];
function scriptedFetch(steps) {
    const fetchImpl = vi.fn(async url => {
        const step = steps.shift();
        if (!step) throw new Error(`Unexpected request: ${url}`);
        return typeof step === 'function' ? step(new URL(url)) : step;
    });
    return fetchImpl;
}

describe('Hamburg ALKIS WFS', () => {
    it('checks stable hits around sorted WFS2 pages and preserves curved WGS84 polygons', async () => {
        const curved = { type: 'Polygon', coordinates: [[[9.99, 53.57], [9.9902, 53.5701], [9.9904, 53.5703], [9.9902, 53.5705], [9.99, 53.57]]] };
        const fetchImpl = scriptedFetch([hits(2), collection([feature(key1, 'AVE_1', curved)]), collection([feature(key2, 'AVE_2')]), hits(2)]);
        const source = createHamburgAlkisParcelSource({ ...descriptor, pageSize: 1 }, { fetchImpl });
        const result = await source.queryBounds(bounds);
        expect(result.complete).toBe(true);
        expect(result.features.map(f => f.properties.sourceParcelId)).toEqual([key1, key2]);
        expect(result.features[0].geometry).toEqual(curved);
        expect(result.features[0].properties.sourceProperties).toEqual({ flstkennz: key1, oid: `OID-${key1}` });
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        const urls = fetchImpl.mock.calls.map(([url]) => new URL(url));
        expect(urls[0].searchParams.get('RESULTTYPE')).toBe('hits');
        expect(urls[1].searchParams.get('SRSNAME')).toBe('CRS:84');
        expect(urls[1].searchParams.get('COUNT')).toBe('1');
        expect(urls[2].searchParams.get('STARTINDEX')).toBe('1');
        expect(urls[3].searchParams.get('RESULTTYPE')).toBe('hits');
        for (const url of urls) expect(url.searchParams.get('TYPENAMES')).toBe('ave:Flurstueck');
        for (const url of urls) {
            expect(url.searchParams.has('BBOX')).toBe(false);
            expect(url.searchParams.get('FILTER')).toContain('<fes:Intersects>');
            expect(url.searchParams.get('FILTER')).toContain('9.99 53.57 9.991 53.57 9.991 53.571 9.99 53.571 9.99 53.57');
        }
    });

    it('records absence only from two stable zero-hit responses, even when zero GeoJSON omits features', async () => {
        const fetchImpl = scriptedFetch([hits(0), hits(0)]);
        const result = await createHamburgAlkisParcelSource(descriptor, { fetchImpl }).queryIds([`DE-HH-ALKIS-${key1}`]);
        expect(result).toMatchObject({ complete: true, features: [], absentIds: [`DE-HH-ALKIS-${key1}`] });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('uses bounded FES2 exact lookup, rejects unexpected IDs and reports legitimate missing IDs', async () => {
        const fetchImpl = scriptedFetch([hits(1), collection([feature(key1, 'AVE_1')]), hits(1)]);
        const source = createHamburgAlkisParcelSource(descriptor, { fetchImpl });
        const result = await source.queryIds([`DE-HH-ALKIS-${key1}`, `DE-HH-ALKIS-${key2}`]);
        expect(result.features.map(f => f.id)).toEqual([`DE-HH-ALKIS-${key1}`]);
        expect(result.absentIds).toEqual([`DE-HH-ALKIS-${key2}`]);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        const url = new URL(fetchImpl.mock.calls[0][0]);
        const filter = url.searchParams.get('FILTER');
        expect(filter).toContain('<fes:Or>');
        expect(filter).toContain(`<fes:Literal>${key1}</fes:Literal>`);
        expect(filter).toContain(`<fes:Literal>${key2}</fes:Literal>`);
        expect(filter).not.toContain('owner');

        const unexpected = scriptedFetch([hits(1), collection([feature(key2, 'AVE_2')])]);
        await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: unexpected })
            .queryIds([`DE-HH-ALKIS-${key1}`])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it.each([
        ['changed hit count', [hits(1), collection([feature(key1, 'AVE_1')]), hits(2)]],
        ['short page', [hits(2), collection([feature(key1, 'AVE_1')])]],
        ['duplicate transport and native IDs', [hits(2), collection([feature(key1, 'AVE_1'), feature(key1, 'AVE_1')])]],
        ['out-of-order sort', [hits(2), collection([feature(key2, 'AVE_2'), feature(key1, 'AVE_1')])]],
        ['invalid polygon', [hits(1), collection([feature(key1, 'AVE_1', { type: 'Point', coordinates: [0, 0] })])]]
    ])('rejects %s', async (_name, steps) => {
        await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: scriptedFetch(steps) }).queryBounds(bounds))
            .rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it('rejects unsafe hit XML, missing counts and changing counts', async () => {
        const bad = body => new Response(body, { headers: { 'Content-Type': 'application/xml' } });
        for (const body of [
            '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0"/>',
            '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="0" numberReturned="1"/>',
            '<x:FeatureCollection xmlns:x="urn:wrong" numberMatched="0" numberReturned="0"/>',
            '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:x="urn:x" x:numberMatched="0" numberReturned="0"/>',
            '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="0" numberReturned="0" unexpected="1"/>',
            '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="0" numberReturned="0"><wfs:member/></wfs:FeatureCollection>',
            '<!DOCTYPE x [<!ENTITY y "1">]><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="0"/>',
            '<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"/>',
            '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="unknown"/>'
        ]) await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: async () => bad(body) }).queryBounds(bounds))
            .rejects.toMatchObject({ code: 'parcel-source-unavailable' });

        await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: scriptedFetch([hits(1), hits(0)]) })
            .queryBounds(bounds)).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        const absentThenChanged = scriptedFetch([hits(0), hits(1)]);
        await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: absentThenChanged })
            .queryIds([`DE-HH-ALKIS-${key1}`])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        expect(absentThenChanged).toHaveBeenCalledTimes(2);
    });

    it('checks ordering across page boundaries and rejects missing page features', async () => {
        const unordered = scriptedFetch([hits(2), collection([feature(key2, 'AVE_2')]), collection([feature(key1, 'AVE_1')])]);
        await expect(createHamburgAlkisParcelSource({ ...descriptor, pageSize: 1 }, { fetchImpl: unordered })
            .queryBounds(bounds)).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        const omitted = scriptedFetch([hits(1), new Response(JSON.stringify({ type: 'FeatureCollection' }))]);
        await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: omitted }).queryBounds(bounds))
            .rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it('rejects duplicate native or transport IDs even when the other ID differs', async () => {
        for (const features of [
            [feature(key1, 'AVE_1'), feature(key1, 'AVE_2')],
            [feature(key1, 'AVE_1'), feature(key2, 'AVE_1')]
        ]) await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: scriptedFetch([hits(2), collection(features)]) })
            .queryBounds(bounds)).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it('rejects geometry outside the requested bbox and contradictory optional GeoJSON counts', async () => {
        const outside = polygon(9.993);
        await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: scriptedFetch([hits(1), collection([feature(key1, 'AVE_1', outside)])]) })
            .queryBounds(bounds)).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        const wrongMatched = scriptedFetch([hits(1), new Response(JSON.stringify({ type: 'FeatureCollection', numberMatched: 2, numberReturned: 1, features: [feature(key1, 'AVE_1')] }))]);
        await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: wrongMatched }).queryBounds(bounds))
            .rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        const wrongReturned = scriptedFetch([hits(1), new Response(JSON.stringify({ type: 'FeatureCollection', numberMatched: 1, numberReturned: 2, features: [feature(key1, 'AVE_1')] }))]);
        await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: wrongReturned }).queryBounds(bounds))
            .rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it('checks hit limits before requesting GeoJSON pages', async () => {
        const fetchImpl = scriptedFetch([hits(2)]);
        await expect(createHamburgAlkisParcelSource({ ...descriptor, maxFeatures: 1 }, { fetchImpl }).queryBounds(bounds))
            .rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('returns complete untrimmed parcel geometry intersecting the proposal only', async () => {
        const crossing = { type: 'Polygon', coordinates: [[[9.989, 53.5704], [9.991, 53.5704], [9.991, 53.5706], [9.989, 53.5706], [9.989, 53.5704]]] };
        const bboxOnly = { type: 'Polygon', coordinates: [[[9.9896, 53.57051], [9.9899, 53.57051], [9.9899, 53.57054], [9.9896, 53.57054], [9.9896, 53.57051]]] };
        const fetchImpl = scriptedFetch([hits(2), collection([feature(key1, 'AVE_1', crossing), feature(key2, 'AVE_2', bboxOnly)]), hits(2)]);
        const result = await createHamburgAlkisParcelSource(descriptor, { fetchImpl }).queryGeometry({
            type: 'Polygon', coordinates: [[[9.9895, 53.57045], [9.9905, 53.57045], [9.9905, 53.57055], [9.9900, 53.57055], [9.9900, 53.5705], [9.9895, 53.5705], [9.9895, 53.57045]]]
        });
        expect(result.features.map(feature => feature.id)).toEqual([`DE-HH-ALKIS-${key1}`]);
        expect(result.features[0].geometry).toEqual(crossing);
    });

    it('does not return a partial exact-ID batch when a later batch fails', async () => {
        const ids = Array.from({ length: 9 }, (_, index) => `DE-HH-ALKIS-${`02${String(index).padStart(18, '_')}`}`);
        const fetchImpl = scriptedFetch([hits(0), hits(0), new Response('', { status: 503 })]);
        await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl }).queryIds(ids))
            .rejects.toMatchObject({ upstreamStatus: 503 });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it.each([403, 429, 503])('preserves upstream HTTP %i', async status => {
        await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: async () => new Response('', { status }) })
            .queryBounds(bounds)).rejects.toMatchObject({ upstreamStatus: status,
                code: status === 403 ? 'parcel-source-blocked' : status === 429 ? 'parcel-source-rate-limited' : 'parcel-source-unavailable' });
    });

    it('enforces ID, descriptor, bbox, and response-byte bounds before publishing data', async () => {
        const fetchImpl = vi.fn();
        const source = createHamburgAlkisParcelSource(descriptor, { fetchImpl });
        await expect(source.queryIds(['DE-HH-ALKIS-020302___00717_____!'])).rejects.toMatchObject({ status: 400 });
        await expect(source.queryBounds([9, 53, 10, 54])).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(() => createHamburgAlkisParcelSource({ ...descriptor, endpoint: 'https://elsewhere.example/wfs' })).toThrow();
        await expect(createHamburgAlkisParcelSource(descriptor, { fetchImpl: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)) })
            .queryBounds(bounds)).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });
});
