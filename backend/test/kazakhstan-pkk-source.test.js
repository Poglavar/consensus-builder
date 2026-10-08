// Checks the Astana public view's native projection, identity, paging and bounded reads.
import { describe, expect, it, vi } from 'vitest';
import proj4 from 'proj4';
import { createKazakhstanPkkSource } from '../parcels/kazakhstan-pkk-source.js';

const ENDPOINT = 'https://map.gov4c.kz/geoserver/wfs';
const PREFIX = 'KZ-ASTANA-PKK-';
const SOURCE_CRS = 'EPSG:32642';
const SOURCE_CRS_URN = 'urn:ogc:def:crs:EPSG::32642';
const CENTER = [71.4304, 51.1282];
const CENTER_METRIC = proj4('EPSG:4326', SOURCE_CRS, CENTER);
const BOUNDS = [71.4302, 51.1280, 71.4306, 51.1284];

function geometryAt([x, y] = CENTER_METRIC, size = 5) {
    const ring = [[x - size, y - size], [x + size, y - size], [x + size, y + size], [x - size, y + size], [x - size, y - size]];
    return { type: 'MultiPolygon', coordinates: [[ring]] };
}

function row(gid, kadNomer, geometry = geometryAt(), featureId = `u_view.${gid}`) {
    return { type: 'Feature', id: featureId, geometry,
        properties: { gid, kad_nomer: kadNomer, address_ru: 'must not be returned' } };
}

function response(features, matched = features.length, extra = {}) {
    const payload = { type: 'FeatureCollection', features, totalFeatures: matched, numberMatched: matched,
        numberReturned: features.length, crs: { type: 'name', properties: { name: SOURCE_CRS_URN } }, ...extra };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json;charset=utf-8' } });
}

function makeSource(pages, override = {}) {
    const fetchImpl = vi.fn();
    for (const item of pages) fetchImpl.mockResolvedValueOnce(item);
    const descriptor = { id: 'astana-egkn-pkk', endpoint: ENDPOINT, featureType: 'egkn:u_view',
        districtId: 254, idPrefix: PREFIX, idField: 'kad_nomer', outFields: ['gid', 'kad_nomer'],
        pageSize: 2, maxFeatures: 10, maxBboxKm2: 2, ...override };
    return { source: createKazakhstanPkkSource(descriptor, { fetchImpl }), fetchImpl };
}

describe('Astana official PKK parcel source', () => {
    it('projects a bounded WGS84 bbox to UTM and projects returned geometry back', async () => {
        const { source, fetchImpl } = makeSource([response([row(5884914, '21320072529')])]);
        const result = await source.queryBounds(BOUNDS);
        expect(result).toMatchObject({ sourceId: 'astana-egkn-pkk', complete: true, returnsWGS84: true });
        expect(result.features).toHaveLength(1);
        expect(result.features[0].id).toBe(`${PREFIX}21320072529`);
        expect(result.features[0].properties).toMatchObject({
            sourceParcelId: '21320072529', parcelNumber: '21320072529',
            sourceProperties: { gid: 5884914, kad_nomer: '21320072529' }
        });
        expect(JSON.stringify(result)).not.toContain('address_ru');
        const params = new URL(fetchImpl.mock.calls[0][0]).searchParams;
        expect(params.get('service')).toBe('WFS');
        expect(params.get('version')).toBe('2.0.0');
        expect(params.get('typename')).toBe('egkn:u_view');
        expect(params.get('viewparams')).toBe('district_id:254');
        expect(params.get('srsname')).toBe(SOURCE_CRS);
        expect(params.get('propertyname')).toBe('gid,kad_nomer,geom');
        expect(params.get('sortBy')).toBe('gid');
        expect(params.get('count')).toBe('2');
        expect(params.get('startIndex')).toBe('0');
        expect(params.get('bbox')).toMatch(/,EPSG:32642$/);
        const expectedCorners = [[BOUNDS[0], BOUNDS[1]], [BOUNDS[0], BOUNDS[3]], [BOUNDS[2], BOUNDS[1]], [BOUNDS[2], BOUNDS[3]]]
            .map(point => proj4('EPSG:4326', SOURCE_CRS, point));
        const expectedBbox = [Math.min(...expectedCorners.map(p => p[0])), Math.min(...expectedCorners.map(p => p[1])),
            Math.max(...expectedCorners.map(p => p[0])), Math.max(...expectedCorners.map(p => p[1]))];
        expect(params.get('bbox')).toBe(`${expectedBbox.join(',')},${SOURCE_CRS}`);
        const [lon, lat] = result.features[0].geometry.coordinates[0][0][0];
        const expectedPoint = proj4(SOURCE_CRS, 'EPSG:4326', [CENTER_METRIC[0] - 5, CENTER_METRIC[1] - 5]);
        expect(lon).toBeCloseTo(expectedPoint[0], 8);
        expect(lat).toBeCloseTo(expectedPoint[1], 8);
        expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
            Accept: 'application/json', Referer: 'https://map.gov4c.kz/egkn/', 'User-Agent': 'Mozilla/5.0'
        });
    });

    it('pages in stable gid order and verifies all reported match and return counts', async () => {
        const { source, fetchImpl } = makeSource([
            response([row(5884914, '21320072529'), row(5884915, '21320072530')], 3),
            response([row(5884916, '21320072531')], 3)
        ]);
        const result = await source.queryBounds(BOUNDS);
        expect(result.features.map(feature => feature.id)).toEqual([
            `${PREFIX}21320072529`, `${PREFIX}21320072530`, `${PREFIX}21320072531`
        ]);
        const urls = fetchImpl.mock.calls.map(([url]) => new URL(url));
        expect(urls.map(url => url.searchParams.get('startIndex'))).toEqual(['0', '2']);
        expect(urls.map(url => url.searchParams.get('sortBy'))).toEqual(['gid', 'gid']);
        expect(urls.every(url => url.searchParams.get('viewparams') === 'district_id:254')).toBe(true);
    });

    it('uses exact no-bbox kad_nomer filters and returns absence only after a complete read', async () => {
        const { source, fetchImpl } = makeSource([response([row(5884914, '21320072529')])]);
        const result = await source.queryIds([`${PREFIX}21320072529`, `${PREFIX}21320072599`]);
        expect(result.features.map(feature => feature.id)).toEqual([`${PREFIX}21320072529`]);
        expect(result.absentIds).toEqual([`${PREFIX}21320072599`]);
        const params = new URL(fetchImpl.mock.calls[0][0]).searchParams;
        expect(params.has('bbox')).toBe(false);
        expect(params.get('viewparams')).toBe('district_id:254');
        expect(params.get('filter')).toContain('<fes:ValueReference>kad_nomer</fes:ValueReference>');
        expect(params.get('filter')).toContain('<fes:Literal>21320072529</fes:Literal>');
        expect(params.get('filter')).toContain('<fes:Literal>21320072599</fes:Literal>');
    });

    it('splits 80-ID lookups into URI-safe filters under one operation deadline', async () => {
        const ids = Array.from({ length: 80 }, (_, index) => `${PREFIX}${String(900000000 + index)}`);
        const pages = [];
        for (let offset = 0; offset < ids.length; offset += 20) {
            pages.push(response(ids.slice(offset, offset + 20).map((id, index) => row(5900000 + offset + index, id.slice(PREFIX.length))), 20));
        }
        const { source, fetchImpl } = makeSource(pages, { pageSize: 1000, maxFeatures: 1000 });
        const result = await source.queryIds(ids);

        expect(result.features.map(feature => feature.id)).toEqual(ids);
        expect(result.absentIds).toEqual([]);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        const calls = fetchImpl.mock.calls;
        for (const [url] of calls) {
            const filter = new URL(url).searchParams.get('filter');
            expect(filter.match(/<fes:Literal>/g)).toHaveLength(20);
            expect(url.length).toBeLessThan(4096);
        }
        expect(new Set(calls.map(([, options]) => options.signal)).size).toBe(1);
    });

    it('rejects a repeated stable gid even if GeoServer changes its feature.id', async () => {
        const { source } = makeSource([
            response([row(5884914, '21320072529', geometryAt(), 'u_view.random-1'), row(5884915, '21320072530')], 3),
            response([row(5884914, '21320072529', geometryAt(), 'u_view.random-2')], 3)
        ]);
        await expect(source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });

    it('rejects changing counts, malformed return counts, wrong CRS, and conflicting native keys', async () => {
        const changing = makeSource([response([row(5884914, '21320072529')], 2), response([row(5884915, '21320072530')], 3)]);
        await expect(changing.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
        const wrongReturnCount = makeSource([response([], 0, { numberReturned: 1 })]);
        await expect(wrongReturnCount.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
        const wrongCrs = makeSource([response([], 0, { crs: { type: 'name', properties: { name: 'EPSG:4326' } } })]);
        await expect(wrongCrs.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
        const conflict = makeSource([response([row(5884914, '21320072529'), row(5884915, '21320072529', geometryAt(CENTER_METRIC, 6))], 2)]);
        await expect(conflict.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
    });

    it('allows null or omitted CRS only for complete empty responses with zero counts', async () => {
        const nullCrs = makeSource([response([], 0, { crs: null })]);
        await expect(nullCrs.source.queryBounds(BOUNDS)).resolves.toMatchObject({ complete: true, features: [] });
        const noCrsPayload = { type: 'FeatureCollection', features: [], totalFeatures: 0, numberMatched: 0, numberReturned: 0 };
        const noCrs = makeSource([new Response(JSON.stringify(noCrsPayload), { status: 200 })]);
        await expect(noCrs.source.queryBounds(BOUNDS)).resolves.toMatchObject({ complete: true, features: [] });
        const nonempty = makeSource([response([row(5884914, '21320072529')], 1, { crs: null })]);
        await expect(nonempty.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
    });

    it('keeps rotated-UTM envelope hits whose returned WGS84 envelope extends beyond the input bbox', async () => {
        const bounds = [71.43, 51.128, 71.431, 51.129];
        const projectedCorners = [[bounds[0], bounds[1]], [bounds[0], bounds[3]], [bounds[2], bounds[1]], [bounds[2], bounds[3]]]
            .map(point => proj4('EPSG:4326', SOURCE_CRS, point));
        const minX = Math.min(...projectedCorners.map(point => point[0]));
        const minY = Math.min(...projectedCorners.map(point => point[1]));
        const wedge = geometryAt([minX + 2, minY + 2], 0.5);
        const wgsCorner = proj4(SOURCE_CRS, 'EPSG:4326', [minX + 1.5, minY + 1.5]);
        expect(wgsCorner[0]).toBeLessThan(bounds[0]);
        const { source } = makeSource([response([row(5884914, '21320072529', wedge)])]);
        const result = await source.queryBounds(bounds);
        expect(result.features).toHaveLength(1);
    });

    it('filters provider BBOX overfetch only after counting and validating complete pages', async () => {
        const outside = geometryAt([CENTER_METRIC[0] + 1000, CENTER_METRIC[1]], 5);
        const { source, fetchImpl } = makeSource([
            response([row(5884914, '21320072529', outside), row(5884915, '21320072530')], 3),
            response([row(5884916, '21320072531')], 3)
        ]);
        const result = await source.queryBounds(BOUNDS);
        expect(result.complete).toBe(true);
        expect(result.features.map(feature => feature.id)).toEqual([`${PREFIX}21320072530`, `${PREFIX}21320072531`]);
        expect(fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.get('startIndex'))).toEqual(['0', '2']);

        const invalidOutside = makeSource([response([row(5884914, '', outside)])]);
        await expect(invalidOutside.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
        const incomplete = makeSource([response([row(5884914, '21320072529', outside), row(5884915, '21320072530')], 3)]);
        incomplete.fetchImpl.mockRejectedValueOnce(new Error('interrupted'));
        await expect(incomplete.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
    });

    it('enforces byte and row caps and does not report absence after an interrupted later page', async () => {
        const large = makeSource([response([row(5884914, '21320072529', geometryAt(), 'x'.repeat(2000))])], { maxResponseBytes: 1024 });
        await expect(large.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
        const pages = Array.from({ length: 5 }, (_, index) => response([
            row(5884914 + index * 2, `21320072${String(500 + index * 2)}`),
            row(5884915 + index * 2, `21320072${String(501 + index * 2)}`)
        ], 11));
        pages.push(response([row(5884924, '21320072510')], 11));
        const overLimit = makeSource(pages);
        await expect(overLimit.source.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });

        const incomplete = makeSource([response([row(5884914, '21320072529'), row(5884915, '21320072530')], 3)]);
        incomplete.fetchImpl.mockRejectedValueOnce(Object.assign(new Error('interrupted'), { code: 'ECONNRESET' }));
        await expect(incomplete.source.queryIds([
            `${PREFIX}21320072529`, `${PREFIX}21320072530`, `${PREFIX}21320072599`
        ])).rejects.toMatchObject({ status: 502 });
    });

    it('rejects unsafe caller IDs before network I/O and maps timeout errors', async () => {
        const invalid = makeSource([]);
        await expect(invalid.source.queryIds([`${PREFIX}21320072' OR 1=1`])).rejects.toMatchObject({ status: 400 });
        expect(invalid.fetchImpl).not.toHaveBeenCalled();
        const descriptor = { id: 'astana-timeout', endpoint: ENDPOINT, featureType: 'egkn:u_view', districtId: 254,
            idPrefix: PREFIX, pageSize: 2, maxFeatures: 10 };
        const fetchImpl = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
        const timedOut = createKazakhstanPkkSource(descriptor, { fetchImpl });
        await expect(timedOut.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 504, code: 'parcel-source-unavailable' });
    });

    it('filters queryGeometry results by actual intersection after bounded source retrieval', async () => {
        const footprint = { type: 'Polygon', coordinates: [[[71.4303, 51.1281], [71.4305, 51.1281], [71.4305, 51.1283], [71.4303, 51.1283], [71.4303, 51.1281]]] };
        const { source } = makeSource([response([row(5884914, '21320072529')])]);
        const result = await source.queryGeometry(footprint);
        expect(result.features).toHaveLength(1);
    });
});
