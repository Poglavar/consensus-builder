// Exercises WFS axis order, count-backed paging, ID lookup and failure behavior without network I/O.
import { describe, it, expect, vi } from 'vitest';
import { createWfsParcelSource } from '../parcels/wfs-source.js';

const descriptor = {
    id: 'fr-ign-parcellaire-express', endpoint: 'https://data.geopf.fr/wfs/ows',
    featureType: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle', idField: 'idu', idType: 'string',
    idPattern: '^[0-9A-Z]{14}$', idPrefix: 'FR-PCI-', outFields: ['idu', 'numero'], pageSize: 2, maxFeatures: 10
};
const BOUNDS = [2.355, 48.8486, 2.356, 48.8494];
const GEOMETRY = { type: 'Polygon', coordinates: [[[2.355, 48.8486], [2.356, 48.8486], [2.356, 48.8494], [2.355, 48.8494], [2.355, 48.8486]]] };
function feature(oid, native = '75105000AD0011', geometry = GEOMETRY) {
    return { type: 'Feature', id: `parcelle.${oid}`, properties: { idu: native, numero: typeof native === 'string' ? native.slice(-4) : null, ignored: 'drop' }, geometry };
}
function page(features, matched = features.length, extra = {}) {
    return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features, numberMatched: matched, numberReturned: features.length, ...extra }) };
}
function source(pages, override = {}) {
    const fetchImpl = vi.fn(); pages.forEach(payload => fetchImpl.mockResolvedValueOnce(payload));
    return { adapter: createWfsParcelSource({ ...descriptor, ...override }, { fetchImpl }), fetchImpl };
}

describe('WFS parcel adapter', () => {
    it('uses explicit longitude/latitude CRS and pages until the known match count is reached', async () => {
        const { adapter, fetchImpl } = source([
            page([feature(1), feature(2, '75105000AD0012')], 3, { links: [{ rel: 'next', href: 'http://localhost/unsafe' }] }),
            page([feature(3, '75105000AD0013')], 3)
        ]);
        const result = await adapter.queryBounds(BOUNDS);
        expect(result).toMatchObject({ complete: true, returnsWGS84: true, sourceId: descriptor.id });
        expect(result.features.map(f => f.id)).toEqual(['FR-PCI-75105000AD0011', 'FR-PCI-75105000AD0012', 'FR-PCI-75105000AD0013']);
        const urls = fetchImpl.mock.calls.map(([url]) => new URL(url));
        expect(urls.map(url => url.searchParams.get('startIndex'))).toEqual(['0', '2']);
        urls.forEach(url => {
            expect(url.origin).toBe('https://data.geopf.fr');
            expect(url.pathname).toBe('/wfs/ows');
            expect(url.searchParams.get('bbox')).toBe('2.355,48.8486,2.356,48.8494,CRS:84');
            expect(url.searchParams.get('srsName')).toBe('CRS:84');
            expect(url.searchParams.get('sortBy')).toBe('idu');
        });
        expect(result.features[0].properties.sourceProperties).toEqual({ idu: '75105000AD0011', numero: '0011' });
    });
    it('returns explicit absences after an exact-ID read', async () => {
        const { adapter, fetchImpl } = source([page([feature(1)])]);
        const result = await adapter.queryIds(['FR-PCI-75105000AD0011', 'FR-PCI-75105000AD9999']);
        expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('cql_filter')).toBe("idu IN ('75105000AD0011','75105000AD9999')");
        expect(result.absentIds).toEqual(['FR-PCI-75105000AD9999']);
        expect(result.complete).toBe(true);
    });
    it('does not turn a provider that ignored its ID filter into apparent absence', async () => {
        const { adapter } = source([page([feature(1, '75105000AD0012')])]);
        await expect(adapter.queryIds(['FR-PCI-75105000AD0011'])).rejects.toMatchObject({ status: 502 });
    });
    it('rejects foreign or malformed IDs and oversized areas before I/O', async () => {
        const { adapter, fetchImpl } = source([]);
        for (const ids of [['US-DC-12'], ['FR-PCI-x'], ["FR-PCI-75105000AD0011' OR 1=1"], []]) await expect(adapter.queryIds(ids)).rejects.toMatchObject({ status: 400 });
        expect(() => adapter.queryBounds([2, 48, 4, 50])).toThrow(/area is too large/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each([
        ['unknown count', [page([feature(1)], 'unknown')]],
        ['missing count', [page([feature(1)], undefined, { numberMatched: undefined })]],
        ['wrong returned count', [page([feature(1)], 1, { numberReturned: 2 })]],
        ['changing count', [page([feature(1)], 2), page([feature(2, '75105000AD0012')], 3)]],
        ['empty partial page', [page([], 1)]],
        ['repeated page', [page([feature(1)], 2), page([feature(1)], 2)]],
        ['missing native ID', [page([feature(1, null)])]],
        ['invalid geometry', [page([feature(1, '75105000AD0011', { type: 'MultiPolygon', coordinates: [null] })])]],
        ['limit exceeded', [page([feature(1)], 11)]]
    ])('fails closed on %s', async (_name, pages) => {
        const { adapter } = source(pages);
        await expect(adapter.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });
    it('rejects spatially different polygons claiming one durable ID', async () => {
        const different = { type: 'Polygon', coordinates: [[[2.3551, 48.8486], [2.356, 48.8486], [2.356, 48.8494], [2.3551, 48.8494], [2.3551, 48.8486]]] };
        const { adapter } = source([page([feature(1), feature(2, '75105000AD0011', different)])]);
        await expect(adapter.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
    });
    it('filters an envelope response by the actual proposal footprint', async () => {
        const outside = { type: 'Polygon', coordinates: [[[2.3557, 48.8491], [2.3558, 48.8491], [2.3558, 48.8492], [2.3557, 48.8492], [2.3557, 48.8491]]] };
        const inside = { type: 'Polygon', coordinates: [[[2.3551, 48.8487], [2.3552, 48.8487], [2.3552, 48.8488], [2.3551, 48.8488], [2.3551, 48.8487]]] };
        const triangle = { type: 'Polygon', coordinates: [[[2.355, 48.8486], [2.356, 48.8486], [2.355, 48.8494], [2.355, 48.8486]]] };
        const { adapter } = source([page([feature(1, '75105000AD0011', inside), feature(2, '75105000AD0012', outside)])]);
        const result = await adapter.queryGeometry(triangle);
        expect(result.complete).toBe(true);
        expect(result.features.map(f => f.id)).toEqual(['FR-PCI-75105000AD0011']);
    });
    it('rejects malformed caller geometry as input rather than provider failure', async () => {
        const { adapter, fetchImpl } = source([]);
        await expect(adapter.queryGeometry({ type: 'MultiPolygon', coordinates: [null] })).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('maps HTTP and parser failures without publishing a complete empty cell', async () => {
        const http = source([{ ok: false, status: 503 }]);
        await expect(http.adapter.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
        const xml = source([{ ok: true, json: async () => { throw new SyntaxError('WFS ExceptionReport'); } }]);
        await expect(xml.adapter.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
    });
});
