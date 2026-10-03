// Locks complete OGC cursor reads, stable native identity and fixed-endpoint pagination security.
import { describe, expect, it, vi } from 'vitest';
import { createOgcApiParcelSource } from '../parcels/ogc-api-source.js';
const descriptor = {
    id: 'nl-test', adapter: 'ogc-api', endpoint: 'https://provider.example/collections/perceel/items',
    idField: 'lokaal', idType: 'string', idPattern: '^[0-9]{14}$', idPrefix: 'NL-BRK-',
    idNamespace: { field: 'namespace', value: 'NL.IMKAD.KadastraalObject' },
    outFields: ['lokaal', 'namespace', 'number', 'status'], parcelNumberField: 'number',
    attributeFilters: { status: 'G' }, pageSize: 2, maxFeatures: 6
};
const bounds = [4.899, 52.372, 4.901, 52.3735];
const polygon = (x = 4.9, y = 52.3725) => ({ type: 'Polygon', coordinates: [[[x, y], [x + .0001, y], [x + .0001, y + .0001], [x, y + .0001], [x, y]]] });
const row = (oid, native = `1146019337000${oid}`, geometry = polygon()) => ({
    type: 'Feature', id: `uuid.${oid}`, properties: { lokaal: native, namespace: descriptor.idNamespace.value, number: 1933 + oid, status: 'G', owner: 'not retained' }, geometry
});
function fetchPages(pages) {
    return vi.fn(async url => {
        const p = pages.shift();
        if (!p) throw new Error('Unexpected extra page');
        if (p.httpStatus) return { ok: false, status: p.httpStatus };
        const next = new URL(url);
        if (p.cursor) next.searchParams.set('cursor', p.cursor);
        if (p.mutateNext) p.mutateNext(next);
        const links = p.links ?? (p.cursor ? [{ rel: 'next', type: 'application/geo+json', href: next.href }] : []);
        return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features: p.features,
            numberReturned: p.features?.length, links, ...p.payload }) };
    });
}
describe('OGC API parcel adapter', () => {
    it('exhausts opaque cursor pages at the fixed endpoint and keeps native IDs separate from display integers', async () => {
        const fetchImpl = fetchPages([{ features: [row(1), row(2)], cursor: 'opaque|A' }, { features: [row(3)] }]);
        const result = await createOgcApiParcelSource(descriptor, { fetchImpl }).queryBounds(bounds);
        expect(result).toMatchObject({ complete: true, returnsWGS84: true, sourceId: 'nl-test' });
        expect(result.features.map(f => f.id)).toEqual([1, 2, 3].map(n => `NL-BRK-1146019337000${n}`));
        expect(result.features[0].properties.parcelNumber).toBe('1934');
        expect(result.features[0].properties.sourceProperties).not.toHaveProperty('owner');
        const urls = fetchImpl.mock.calls.map(([u]) => new URL(u));
        expect(urls[1].searchParams.get('cursor')).toBe('opaque|A');
        for (const url of urls) {
            expect(url.origin + url.pathname).toBe(descriptor.endpoint);
            expect(url.searchParams.get('bbox')).toBe(bounds.join(','));
            expect(url.searchParams.get('crs')).toContain('CRS84');
            expect(url.searchParams.get('bbox-crs')).toContain('CRS84');
            expect(url.searchParams.get('filter')).toBe("(status = 'G')");
        }
        expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    });
    it('quotes native CQL2 IDs, retains leading zeroes and reports absences only after the final cursor', async () => {
        const native = '00000000000001';
        const fetchImpl = fetchPages([{ features: [row(1, native)], cursor: 'A' }, { features: [] }]);
        const ids = [`NL-BRK-${native}`, 'NL-BRK-00000000000002'];
        const result = await createOgcApiParcelSource(descriptor, { fetchImpl }).queryIds(ids);
        expect(result.absentIds).toEqual([ids[1]]);
        expect(result.features[0].id).toBe(ids[0]);
        expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('filter')).toBe("(status = 'G') AND (lokaal IN ('00000000000001','00000000000002'))");
    });
    it('rejects invalid IDs and oversized or malformed caller geometry before I/O', async () => {
        const fetchImpl = vi.fn(); const a = createOgcApiParcelSource(descriptor, { fetchImpl });
        for (const ids of [[], ['XX-123'], ['NL-BRK-1 OR 1=1'], Array(81).fill('NL-BRK-00000000000001')]) await expect(a.queryIds(ids)).rejects.toMatchObject({ status: 400 });
        expect(() => a.queryBounds([0, 0, 10, 10])).toThrow(/large/);
        await expect(a.queryGeometry({ type: 'MultiPolygon', coordinates: [null] })).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each([
        ['origin', u => { u.hostname = 'internal.example'; }],
        ['scheme', u => { u.protocol = 'http:'; }],
        ['path', u => { u.pathname = '/admin'; }],
        ['credentials', u => { u.username = 'user'; }],
        ['fragment', u => { u.hash = 'x'; }],
        ['bbox', u => { u.searchParams.set('bbox', '0,0,1,1'); }],
        ['filter', u => { u.searchParams.delete('filter'); }],
        ['limit', u => { u.searchParams.set('limit', '10000'); }],
        ['duplicate key', u => { u.searchParams.append('f', 'json'); }],
        ['extra key', u => { u.searchParams.set('callback', 'anything'); }],
        ['missing cursor', u => { u.searchParams.delete('cursor'); }]
    ])('rejects a next link that changes %s before fetching it', async (_name, mutateNext) => {
        const fetchImpl = fetchPages([{ features: [row(1)], cursor: 'A', mutateNext }]);
        await expect(createOgcApiParcelSource(descriptor, { fetchImpl }).queryBounds(bounds)).rejects.toMatchObject({ status: 502 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it.each([
        ['unknown matches', [{ features: [], payload: { numberMatched: 'unknown' } }]],
        ['oversized page', [{ features: [row(1), row(2), row(3)] }]],
        ['return count', [{ features: [row(1)], payload: { numberReturned: 2 } }]],
        ['missing links', [{ features: [], payload: { links: undefined } }]],
        ['empty continuing page', [{ features: [], cursor: 'A' }]],
        ['repeated cursor', [{ features: [row(1)], cursor: 'A' }, { features: [row(2)], cursor: 'A' }]],
        ['repeated feature', [{ features: [row(1)], cursor: 'A' }, { features: [row(1)] }]],
        ['incomplete counts', [{ features: [row(1)], payload: { numberMatched: 2 } }]],
        ['changing counts', [{ features: [row(1)], cursor: 'A', payload: { numberMatched: 2 } }, { features: [row(2)], payload: { numberMatched: 3 } }]],
        ['invalid polygon', [{ features: [{ ...row(1), geometry: { type: 'Point', coordinates: [4.9, 52.3] } }] }]],
        ['native ID conflict', [{ features: [row(1), row(2, row(1).properties.lokaal, polygon(4.9003))] }]],
        ['bad namespace', [{ features: [{ ...row(1), properties: { ...row(1).properties, namespace: 'another register' } }] }]],
        ['excluded status', [{ features: [{ ...row(1), properties: { ...row(1).properties, status: 'V' } }] }]],
        ['missing native ID', [{ features: [{ ...row(1), properties: { ...row(1).properties, lokaal: null } }] }]],
        ['ambiguous next', [{ features: [row(1)], links: [{ rel: 'next', href: 'https://example.test' }, { rel: 'next', href: 'https://example.test' }] }]],
        ['provider HTTP error', [{ httpStatus: 503 }]]
    ])('fails closed for %s', async (_name, pages) => {
        await expect(createOgcApiParcelSource(descriptor, { fetchImpl: fetchPages(pages) }).queryBounds(bounds)).rejects.toMatchObject({ status: 502 });
    });
    it('bounds total work even when the provider omits numberMatched', async () => {
        const fetchImpl = fetchPages([{ features: [row(1), row(2)], cursor: 'A' }, { features: [row(3), row(4)] }]);
        await expect(createOgcApiParcelSource({ ...descriptor, maxFeatures: 3 }, { fetchImpl }).queryBounds(bounds)).rejects.toMatchObject({ status: 502 });
    });
    it('refuses unexpected ID-query results', async () => {
        await expect(createOgcApiParcelSource(descriptor, { fetchImpl: fetchPages([{ features: [row(1)] }]) })
            .queryIds(['NL-BRK-00000000000001'])).rejects.toMatchObject({ status: 502 });
    });
    it.each([[0, '0'], [null, '11460193370001'], ['0012', '0012']])('renders display value %s without changing native identity', async (number, expected) => {
        const feature = row(1); feature.properties.number = number;
        const r = await createOgcApiParcelSource(descriptor, { fetchImpl: fetchPages([{ features: [feature] }]) }).queryIds(['NL-BRK-11460193370001']);
        expect(r.features[0].properties.parcelNumber).toBe(expected);
        expect(r.features[0].id).toBe('NL-BRK-11460193370001');
    });
    it('uses an envelope and filters outside pieces from a footprint query', async () => {
        const target = { type: 'Polygon', coordinates: [[[4.9, 52.372], [4.901, 52.372], [4.9, 52.373], [4.9, 52.372]]] };
        const fetchImpl = fetchPages([{ features: [row(1, undefined, polygon(4.9001, 52.3721)), row(2, undefined, polygon(4.9008, 52.3728))] }]);
        const result = await createOgcApiParcelSource(descriptor, { fetchImpl }).queryGeometry(target);
        expect(result.features.map(f => f.id)).toEqual(['NL-BRK-11460193370001']);
        expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('bbox')).toBe('4.9,52.372,4.901,52.373');
    });
});

// Flemish GeoServer uses integer object identities and startIndex links, omitting terminal links.
describe('OGC API GeoServer pagination', () => {
    const grb = { id: 'grb-test', endpoint: 'https://provider.example/collections/ADP/items',
        idField: 'OIDN', idType: 'integer', pagination: 'startIndex', idPrefix: 'BE-GRB-ADP-',
        outFields: ['OIDN', 'UIDN', 'CAPAKEY'], parcelNumberField: 'CAPAKEY', pageSize: 2, maxFeatures: 6 };
    const record = oid => ({ type: 'Feature', id: `ADP.${oid + 100}`, properties: { OIDN: oid, UIDN: oid + 1000, CAPAKEY: '11811L3545/00P002' }, geometry: polygon() });
    const pages = entries => vi.fn(async url => {
        const entry = entries.shift();
        const next = new URL(url);
        if (entry.index !== undefined) next.searchParams.set('startIndex', String(entry.index));
        if (entry.mutateNext) entry.mutateNext(next);
        const payload = { type: 'FeatureCollection', features: entry.features, totalFeatures: 'unknown', numberReturned: entry.features.length };
        if (entry.index !== undefined) payload.links = [{ rel: 'next', type: 'application/json', href: next.href }];
        return { ok: true, json: async () => ({ ...payload, ...entry.payload }) };
    });
    it('pages at the exact returned offset and completes a short page without terminal links', async () => {
        const fetchImpl = pages([{ features: [record(4455997), record(4466121)], index: 2 }, { features: [record(4455664)] }]);
        const r = await createOgcApiParcelSource(grb, { fetchImpl }).queryBounds(bounds);
        expect(r.features.map(f => f.id)).toEqual(['BE-GRB-ADP-4455997', 'BE-GRB-ADP-4466121', 'BE-GRB-ADP-4455664']);
        expect(r.features[0].properties).toMatchObject({ sourceParcelId: '4455997', parcelNumber: '11811L3545/00P002', sourceProperties: { UIDN: 4456997 } });
        expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('startIndex')).toBe('2');
        expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.has('cursor')).toBe(false);
        expect(r.complete).toBe(true);
    });
    it('uses numeric CQL2 identifiers and preserves the cadastral association separately', async () => {
        const fetchImpl = pages([{ features: [record(4455997)] }]);
        const r = await createOgcApiParcelSource(grb, { fetchImpl }).queryIds(['BE-GRB-ADP-4455997', 'BE-GRB-ADP-4466121']);
        expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('filter')).toBe('(OIDN IN (4455997,4466121))');
        expect(r.absentIds).toEqual(['BE-GRB-ADP-4466121']);
    });
    it.each([1, 3, -1, 'abc', '02'])('rejects an incorrect next offset %s before I/O', async index => {
        const fetchImpl = pages([{ features: [record(1), record(2)], index }]);
        await expect(createOgcApiParcelSource(grb, { fetchImpl }).queryBounds(bounds)).rejects.toMatchObject({ status: 502 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it.each([undefined, []])('rejects a full uncounted page without continuation (%s)', async links => {
        await expect(createOgcApiParcelSource(grb, { fetchImpl: pages([{ features: [record(1), record(2)], payload: { links } }]) })
            .queryBounds(bounds)).rejects.toMatchObject({ status: 502 });
    });
    it('allows an empty final page after an exact multiple of the page size', async () => {
        const r = await createOgcApiParcelSource(grb, { fetchImpl: pages([{ features: [record(1), record(2)], index: 2 }, { features: [] }]) }).queryBounds(bounds);
        expect(r.features).toHaveLength(2);
        expect(r.complete).toBe(true);
    });
    it('rejects noncanonical numeric caller IDs and null or unsafe upstream identities', async () => {
        const fetchImpl = vi.fn(); const a = createOgcApiParcelSource(grb, { fetchImpl });
        for (const tail of ['01', '-1', '1.5', '9007199254740992']) await expect(a.queryIds([grb.idPrefix + tail])).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
        for (const OIDN of [null, -1, 9007199254740992]) {
            const f = record(1); f.properties.OIDN = OIDN;
            await expect(createOgcApiParcelSource(grb, { fetchImpl: pages([{ features: [f] }]) }).queryBounds(bounds)).rejects.toMatchObject({ status: 502 });
        }
    });
});

// NRW binds its cadastral x-ogc-role:id at the GeoJSON top level and uses counted offset links.
describe('OGC API named feature identity', () => {
    const nrw = { ...descriptor, idNamespace: undefined, attributeFilters: {}, idField: 'flstkennz', idFromFeatureId: true,
        idPrefix: 'DE-NRW-', idPattern: '^[0-9_]{20}$', outFields: ['flstkennz', 'number'], pagination: 'offset', profile: 'rfc7946' };
    const parcel = native => ({ type: 'Feature', id: native, properties: { number: '105' }, geometry: polygon(6.97, 51.48) });
    it('retains the documented native top-level ID and profile across exact offset pages', async () => {
        const ids = ['05344102100105______', '05344102100070______', '05344101700251______'];
        const fetchImpl = fetchPages([{ features: ids.slice(0, 2).map(parcel), cursor: '2', payload: { numberMatched: 3 }, mutateNext: u => { u.searchParams.delete('cursor'); u.searchParams.set('offset', '2'); } },
            { features: [parcel(ids[2])], payload: { numberMatched: 3 } }]);
        const r = await createOgcApiParcelSource(nrw, { fetchImpl }).queryIds(ids.map(id => 'DE-NRW-' + id));
        expect(r.features.map(f => f.id)).toEqual(ids.map(id => 'DE-NRW-' + id));
        expect(r.absentIds).toEqual([]);
        expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('offset')).toBe('2');
        expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('profile')).toBe('rfc7946');
        expect(fetchImpl.mock.calls[0][0]).not.toContain('+');
    });
    it('rejects disagreement between top-level and named property identity', async () => {
        const f = parcel('05344102100105______'); f.properties.flstkennz = '05344102100070______';
        await expect(createOgcApiParcelSource(nrw, { fetchImpl: fetchPages([{ features: [f] }]) }).queryIds(['DE-NRW-05344102100105______'])).rejects.toMatchObject({ status: 502 });
    });
    it('rejects an offset link which changes the requested GeoJSON profile', async () => {
        const fetchImpl = fetchPages([{ features: [parcel('05344102100105______')], cursor: '1', mutateNext: u => { u.searchParams.delete('cursor'); u.searchParams.set('offset', '1'); u.searchParams.set('profile', 'jsonfg'); } }]);
        await expect(createOgcApiParcelSource(nrw, { fetchImpl }).queryIds(['DE-NRW-05344102100105______'])).rejects.toMatchObject({ status: 502 });
    });
});
