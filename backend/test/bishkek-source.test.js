// Checks the unwired Bishkek candidate's category scope, stable paging and exact-code reads.
import { describe, expect, it, vi } from 'vitest';
import { createBishkekCadastreSource } from '../parcels/bishkek-source.js';

const ENDPOINT = 'https://cadastre.kg/svc-portal/map/proxy.do?http://localhost/o2map/services/wfs?';
const ID_PREFIX = 'KG-BISHKEK-CADASTRE-ENI-AREA-';
const BOUNDS = [74.569, 42.874, 74.571, 42.875];
const GEOMETRY = { type: 'MultiPolygon', coordinates: [[[[74.5697, 42.8745], [74.5699, 42.8745], [74.5699, 42.8747], [74.5697, 42.8747], [74.5697, 42.8745]]]] };
const SAFE = ['PROPCODE', 'NAZNACHENI', 'STS', 'DATEINS', 'DATEUPD', 'THE_GEOM'];

function row(code, fid = code, geometry = GEOMETRY, overrides = {}) {
    return { type: 'Feature', id: `ENI_AREA.${fid}`, geometry, properties: {
        PROPCODE: code, NAZNACHENI: 'земельный участок', STS: -9999,
        DATEINS: '2021-03-23 12:41:49', DATEUPD: '2026-09-12 06:55:58',
        OWNER_NAME: 'must never pass through', ...overrides
    } };
}

function response(payload) {
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' } });
}

function page(rows) { return response({ type: 'FeatureCollection', crs: 'EPSG:4326', features: rows }); }

function makeSource(wfsResponses, override = {}) {
    const fetchImpl = vi.fn();
    for (const item of wfsResponses) fetchImpl.mockResolvedValueOnce(item);
    const descriptor = {
        id: 'bishkek-official-cadastre', endpoint: ENDPOINT, idPrefix: ID_PREFIX,
        outFields: SAFE, attributeFilters: { NAZNACHENI: 'земельный участок' },
        pageSize: 2, maxFeatures: 10, maxBboxKm2: 2, ...override
    };
    return { source: createBishkekCadastreSource(descriptor, { fetchImpl }), fetchImpl };
}

function query(url) {
    // The proxy's fixed `?http://localhost/...?...` prefix is intentionally retained verbatim.
    return new URLSearchParams(url.slice(url.lastIndexOf('?') + 1));
}

describe('Bishkek cadastre WFS source', () => {
    it('uses category-scoped BBOX paging and safe output properties', async () => {
        const { source, fetchImpl } = makeSource([page([row('1-01-02-0011-0889', 1), row('1-01-02-0011-0890', 2)]), page([])]);
        const result = await source.queryBounds(BOUNDS);
        expect(result).toMatchObject({ sourceId: 'bishkek-official-cadastre', complete: true, returnsWGS84: true });
        expect(result.features.map(feature => feature.id)).toEqual([
            `${ID_PREFIX}1-01-02-0011-0889`, `${ID_PREFIX}1-01-02-0011-0890`
        ]);
        expect(result.features[0].properties.sourceProperties).toEqual({
            PROPCODE: '1-01-02-0011-0889', NAZNACHENI: 'земельный участок', STS: -9999,
            DATEINS: '2021-03-23 12:41:49', DATEUPD: '2026-09-12 06:55:58'
        });
        expect(JSON.stringify(result)).not.toContain('OWNER_NAME');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const [firstUrl, terminalUrl] = fetchImpl.mock.calls.map(([url]) => url);
        const first = query(firstUrl), terminal = query(terminalUrl);
        for (const params of [first, terminal]) {
            expect(firstUrl).toContain(ENDPOINT);
            expect(params.get('service')).toBe('WFS');
            expect(params.get('version')).toBe('1.1.0');
            expect(params.get('typename')).toBe('ENI_AREA');
            expect(params.get('outputFormat')).toBe('application/json');
            expect(params.get('srsname')).toBe('EPSG:4326');
            expect(params.get('propertyname')).toBe(SAFE.join(','));
            expect(params.get('filter')).toContain('<ogc:PropertyName>NAZNACHENI</ogc:PropertyName>');
            expect(params.get('filter')).toContain('<ogc:Literal>земельный участок</ogc:Literal>');
            expect(params.get('bbox')).toBe(`${BOUNDS.join(',')},EPSG:4326`);
            expect(params.get('startIndex')).toBeTruthy();
            expect(params.get('sortBy')).toBe('PROPCODE+A');
        }
        expect(first.get('maxFeatures')).toBe('2');
        expect(first.get('startIndex')).toBe('0');
        expect(terminal.get('startIndex')).toBe('2');
        const wfsOptions = fetchImpl.mock.calls[0][1];
        expect(wfsOptions.headers.Referer).toBe('https://cadastre.kg/svc-portal/map/main.do');
        expect(wfsOptions.headers.Cookie).toBeUndefined();
    });

    it('reads all pages to a short terminal page before reporting absent native codes', async () => {
        const { source, fetchImpl } = makeSource([
            page([row('1-01-02-0011-0889', 1), row('1-01-02-0011-0890', 2)]), page([])
        ]);
        const result = await source.queryIds([
            `${ID_PREFIX}1-01-02-0011-0889`, `${ID_PREFIX}1-01-02-0011-0890`, `${ID_PREFIX}1-01-02-0011-0999`
        ]);
        expect(result.features.map(feature => feature.id)).toEqual([
            `${ID_PREFIX}1-01-02-0011-0889`, `${ID_PREFIX}1-01-02-0011-0890`
        ]);
        expect(result.absentIds).toEqual([`${ID_PREFIX}1-01-02-0011-0999`]);
        const params = query(fetchImpl.mock.calls[0][0]);
        expect(params.has('bbox')).toBe(false);
        expect(params.get('filter')).toContain('<ogc:PropertyName>NAZNACHENI</ogc:PropertyName>');
        expect(params.get('filter')).toContain('<ogc:PropertyName>PROPCODE</ogc:PropertyName>');
        expect(params.get('filter')).toContain('<ogc:Literal>1-01-02-0011-0889</ogc:Literal>');
        expect(params.get('filter')).toContain('<ogc:Literal>1-01-02-0011-0999</ogc:Literal>');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('rejects any returned feature outside the land-plot category', async () => {
        const { source } = makeSource([page([row('1-01-02-0011-0889', 1, GEOMETRY, { NAZNACHENI: 'помещение' })])]);
        await expect(source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });

    it('rejects a duplicate row FID even when the response otherwise looks complete', async () => {
        const repeated = row('1-01-02-0011-0889', 1);
        const { source } = makeSource([page([repeated, row('1-01-02-0011-0890', 2)]), page([repeated])]);
        await expect(source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });

    it('deduplicates identical native-code records but rejects conflicting geometries', async () => {
        const same = makeSource([page([
            row('1-01-02-0011-0889', 1), row('1-01-02-0011-0889', 2)
        ]), page([])]);
        await expect(same.source.queryBounds(BOUNDS)).resolves.toMatchObject({ features: [expect.objectContaining({ id: `${ID_PREFIX}1-01-02-0011-0889` })] });
        const different = { type: 'MultiPolygon', coordinates: [[[[74.5698, 42.8745], [74.5701, 42.8745], [74.5701, 42.8747], [74.5698, 42.8747], [74.5698, 42.8745]]]] };
        const conflict = makeSource([page([
            row('1-01-02-0011-0889', 1), row('1-01-02-0011-0889', 2, different)
        ])]);
        await expect(conflict.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });

    it('rejects oversized pages, rows past the cap, invalid CRS, and malformed IDs before traffic', async () => {
        const tooMany = makeSource([page([row('1-01-02-0011-0889', 1), row('1-01-02-0011-0890', 2), row('1-01-02-0011-0891', 3)])]);
        await expect(tooMany.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
        const fullPages = Array.from({ length: 5 }, (_, pageIndex) => page(Array.from({ length: 2 }, (_, itemIndex) => {
            const index = pageIndex * 2 + itemIndex;
            return row(`1-01-02-0011-${String(index).padStart(4, '0')}`, index + 1);
        })));
        fullPages.push(page([row('1-01-02-0011-0010', 11)]));
        const overRowCap = makeSource(fullPages);
        await expect(overRowCap.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
        const wrongCrs = makeSource([response({ type: 'FeatureCollection', crs: 'EPSG:3857', features: [] })]);
        await expect(wrongCrs.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
        const invalidId = makeSource([]);
        await expect(invalidId.source.queryIds([`${ID_PREFIX}x' OR '1'='1`])).rejects.toMatchObject({ status: 400 });
        expect(invalidId.fetchImpl).not.toHaveBeenCalled();
    });

    it('enforces response byte caps and never reports absence when a later page fails', async () => {
        const large = makeSource([page([row('1-01-02-0011-0889', 1, GEOMETRY, { large: 'x'.repeat(1500) })])], {
            maxResponseBytes: 1024
        });
        await expect(large.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });

        const incomplete = makeSource([page([row('1-01-02-0011-0889', 1), row('1-01-02-0011-0890', 2)])]);
        incomplete.fetchImpl.mockRejectedValueOnce(Object.assign(new Error('network interrupted'), { code: 'ECONNRESET' }));
        await expect(incomplete.source.queryIds([
            `${ID_PREFIX}1-01-02-0011-0889`, `${ID_PREFIX}1-01-02-0011-0890`, `${ID_PREFIX}1-01-02-0011-0999`
        ]))
            .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        expect(incomplete.fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('maps an upstream timeout to a bounded gateway error', async () => {
        const descriptor = { id: 'bishkek-timeout-test', endpoint: ENDPOINT, idPrefix: ID_PREFIX,
            pageSize: 2, maxFeatures: 10, maxBboxKm2: 2 };
        const fetchImpl = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
        const source = createBishkekCadastreSource(descriptor, { fetchImpl });
        await expect(source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 504, code: 'parcel-source-unavailable' });
    });

    it('uses footprint intersection after envelope-selected whole-shape responses', async () => {
        const footprint = { type: 'Polygon', coordinates: [[[74.56972, 42.87452], [74.56988, 42.87452], [74.56988, 42.87468], [74.56972, 42.87468], [74.56972, 42.87452]]] };
        const containingHole = { type: 'Polygon', coordinates: [
            [[74.569, 42.874], [74.571, 42.874], [74.571, 42.875], [74.569, 42.875], [74.569, 42.874]],
            [[74.5697, 42.8745], [74.5697, 42.8747], [74.5699, 42.8747], [74.5699, 42.8745], [74.5697, 42.8745]]
        ] };
        const { source } = makeSource([page([row('1-01-02-0011-0889', 1, containingHole)])]);
        const result = await source.queryGeometry(footprint);
        expect(result.features).toEqual([]);
    });
});
