import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import proj4 from 'proj4';
import { bbox } from '@turf/turf';
import { createKeralaParcelSource, parseKeralaWktPolygon } from '../parcels/kerala-source.js';

const descriptor = {
    id: 'kerala-entebhoomi-ilms-map-proxy',
    endpoint: 'https://entebhoomi.kerala.gov.in/web/ilms/map',
    idPrefix: 'IN-KL-ENTEBHOOMI-010309-',
    outFields: ['parcel_gid', 'survey_no', 'block_no'],
    parcelNumberField: 'survey_no',
    maxBboxKm2: 1,
    maxFeatures: 1000,
    maxResponseBytes: 2 * 1024 * 1024
};
const fixture = JSON.parse(readFileSync(new URL('../../world-parcels/research/growth-top20-integration-2026-10-07/kerala-parcel-sample.geojson', import.meta.url), 'utf8'));
const sample = fixture.features[0];
const nativeId = sample.properties.parcel_gid;
const sourceId = `${descriptor.idPrefix}${nativeId}`;
const toMetric = coordinates => {
    if (Array.isArray(coordinates) && coordinates.length >= 2 && coordinates.slice(0, 2).every(Number.isFinite)) {
        return proj4('EPSG:4326', 'EPSG:32643', coordinates.slice(0, 2));
    }
    return coordinates.map(toMetric);
};
const metricFeature = { ...sample, geometry: { ...sample.geometry, coordinates: toMetric(sample.geometry.coordinates) } };
const metricCollection = { type: 'FeatureCollection', features: [metricFeature] };
const exactWkt = 'MULTIPOLYGON Z (((710442.6720688 957049.9373916 -60.4406827,710426.8136571 957045.7075762 -63.2145232,710413.5454337 957045.9038837 -68.1364894,710412.8074108 957012.6034679 -66.9822552,710426.1892932 956977.0552644 -68.1374735,710430.6872584 956977.1907215 -68.1374278,710442.6720688 957049.9373916 -60.4406827)))';

const page = '<html><head><meta name="_csrf_header" content="X-CSRF-TOKEN"><meta name="_csrf" content="csrf-value"></head><body><select id="districtGid"><option value="dfd75e07-cae4-45e8-875b-6292909b8089">Thiruvananthapuram</option></select></body></html>';
const mapConfig = key => ({ location_code: '010309', fgb_url: `https://bhunaksha.entebhoomi.kerala.gov.in/bhunaksha_v5_emaps/core/v2/map/export/fgb/010309?auth_key=${key}` });
function makeFetch({ exportResponses = [new Response(JSON.stringify(metricCollection), { headers: { 'content-type': 'application/geo+json' } })], exactResponses = [], now = () => 1 } = {}) {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
        const parsed = new URL(url);
        calls.push({ url: parsed, options });
        if (parsed.pathname === '/web/ilms/map') return new Response(page, { headers: { 'set-cookie': 'session=stub; Path=/' } });
        if (parsed.pathname === '/web/taluk/gid') return Response.json({ dataPojo: { talukids: [{ gid: '56d4cd54-4ad1-469a-bdbf-202951b95c39', talukName: 'Nedumangad' }] } });
        if (parsed.pathname === '/web/village/gid') return Response.json({ dataPojo: { villageids: [{ gid: 'ce6185fb-b497-4803-a49d-4a0a8925aef8', villageName: 'Manikkal' }] } });
        if (parsed.pathname === '/web/ilms/map/view') return new Response(`<div id="initdata" value='${JSON.stringify(mapConfig(`key-${calls.filter(call => call.url.pathname === '/web/ilms/map/view').length}`))}'></div>`);
        if (parsed.pathname === '/bhunaksha_v5_emaps/core/v2/map/export/geojson/010309') return exportResponses.shift();
        if (parsed.pathname === '/web/proxy/mapinfo/feature_info/010309') return exactResponses.shift() || Response.json([]);
        throw new Error(`Unexpected test URL: ${parsed.pathname}`);
    });
    return { fetchImpl, calls, now };
}

describe('Kerala Ente Bhoomi cadastral parcel source', () => {
    it('projects bounded GeoJSON to WGS84 and filters parcels to the requested bbox', async () => {
        const { fetchImpl, calls } = makeFetch();
        const adapter = createKeralaParcelSource(descriptor, { fetchImpl });
        const box = bbox(sample);
        const result = await adapter.queryBounds(box);
        expect(result).toMatchObject({ complete: true, returnsWGS84: true, sourceId: descriptor.id });
        expect(result.features).toHaveLength(1);
        expect(result.features[0].id).toBe(sourceId);
        expect(result.features[0].geometry).toEqual(sample.geometry);
        expect(result.features[0].properties.sourceProperties).toEqual(sample.properties);
        const exportCall = calls.find(call => call.url.pathname.endsWith('/geojson/010309'));
        expect(exportCall.url.searchParams.get('auth_key')).toMatch(/^key-/);
        const body = JSON.parse(exportCall.options.body);
        expect(body).toMatchObject({ map_type: 'GENERIC_MAP', layer_code: 'LAND_PARCEL', srs: 'EPSG:32643', limit: 1000 });
        expect(body.bbox.split(',').map(Number)).toHaveLength(4);
        expect(calls.filter(call => call.url.pathname === '/web/ilms/map')).toHaveLength(1);
        expect(calls.at(-1).options.headers.Cookie).toBe('session=stub');
    });

    it('filters a bounded parcel response against the submitted proposal geometry', async () => {
        const adapter = createKeralaParcelSource(descriptor, makeFetch());
        const result = await adapter.queryGeometry(sample.geometry);
        expect(result.complete).toBe(true);
        expect(result.features.map(feature => feature.id)).toEqual([sourceId]);
    });

    it('parses projected WKT Z and exact-IDs through the exact parcel lookup', async () => {
        const { fetchImpl, calls } = makeFetch({ exactResponses: [Response.json([{
            locationCode: '010309', attributes: { parcel_gid: nativeId, survey_no: '41', block_no: '27', owner: 'must be discarded' }, geom: exactWkt
        }])] });
        const result = await createKeralaParcelSource(descriptor, { fetchImpl }).queryIds([sourceId]);
        expect(result.absentIds).toEqual([]);
        expect(result.features).toHaveLength(1);
        expect(result.features[0].geometry.type).toBe('MultiPolygon');
        expect(result.features[0].geometry.coordinates[0][0][0]).toEqual(sample.geometry.coordinates[0][0][0]);
        expect(result.features[0].properties.sourceProperties).toEqual({ parcel_gid: nativeId, survey_no: '41', block_no: '27' });
        const exactCall = calls.find(call => call.url.pathname.endsWith('/feature_info/010309'));
        expect(JSON.parse(exactCall.options.body)).toMatchObject({ map_type: 'GENERIC_MAP', layer_code: 'LAND_PARCEL', attributes: { parcel_gid: nativeId } });
    });

    it('returns only explicitly confirmed absence and fails closed for empty or malformed 200 exports', async () => {
        const emptyExact = makeFetch({ exactResponses: [Response.json([])] });
        expect((await createKeralaParcelSource(descriptor, emptyExact).queryIds([sourceId])).absentIds).toEqual([sourceId]);
        for (const response of [new Response('', { status: 200 }), new Response('<html>error</html>', { status: 200, headers: { 'content-type': 'text/html' } })]) {
            const source = createKeralaParcelSource(descriptor, makeFetch({ exportResponses: [response] }));
            await expect(source.queryBounds(bbox(sample))).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        }
    });

    it('maps interrupted response streams to stable provider errors without upstream details', async () => {
        const interrupted = new Response(new ReadableStream({ start(controller) {
            controller.error(new TypeError('https://provider.invalid/?auth_key=secret-token'));
        } }), { headers: { 'content-type': 'application/geo+json' } });
        const source = createKeralaParcelSource(descriptor, makeFetch({ exportResponses: [interrupted] }));
        let failure;
        try { await source.queryBounds(bbox(sample)); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: 'parcel-source-unavailable', status: 502, message: 'Kerala parcel provider response was interrupted.' });
        expect(failure.message).not.toContain('secret-token');

        const timeoutResponse = new Response(new ReadableStream({ start(controller) {
            controller.error(Object.assign(new Error('private timeout detail'), { name: 'TimeoutError' }));
        } }), { headers: { 'content-type': 'application/geo+json' } });
        await expect(createKeralaParcelSource(descriptor, makeFetch({ exportResponses: [timeoutResponse] })).queryBounds(bbox(sample)))
            .rejects.toMatchObject({ code: 'parcel-source-unavailable', status: 504, message: 'Kerala parcel provider timed out.' });
    });

    it('refreshes an expired viewer key once, then retries the bounded export', async () => {
        const expired = new Response('', { status: 403 });
        const { fetchImpl, calls } = makeFetch({ exportResponses: [expired,
            new Response(JSON.stringify(metricCollection), { headers: { 'content-type': 'application/geo+json' } })] });
        const result = await createKeralaParcelSource(descriptor, { fetchImpl }).queryBounds(bbox(sample));
        expect(result.features).toHaveLength(1);
        expect(calls.filter(call => call.url.pathname === '/web/ilms/map')).toHaveLength(2);
        expect(calls.filter(call => call.url.pathname.endsWith('/geojson/010309'))).toHaveLength(2);
    });

    it('refreshes an expired exact-ID session once and preserves blocked/rate-limited failures', async () => {
        const exactRow = { locationCode: '010309', attributes: { parcel_gid: nativeId, survey_no: '41', block_no: '27' }, geom: exactWkt };
        const refreshed = makeFetch({ exactResponses: [new Response('', { status: 403 }), Response.json([exactRow])] });
        const positive = await createKeralaParcelSource(descriptor, refreshed).queryIds([sourceId]);
        expect(positive.features).toHaveLength(1);
        expect(refreshed.calls.filter(call => call.url.pathname === '/web/ilms/map')).toHaveLength(2);
        expect(refreshed.calls.filter(call => call.url.pathname.endsWith('/feature_info/010309'))).toHaveLength(2);

        const limited = makeFetch({ exactResponses: [new Response('', { status: 429, headers: { 'retry-after': '7' } })] });
        await expect(createKeralaParcelSource(descriptor, limited).queryIds([sourceId])).rejects.toMatchObject({
            code: 'parcel-source-rate-limited', upstreamStatus: 429, retryAfterSeconds: 7
        });

        const foreign = makeFetch({ exactResponses: [Response.json([{
            locationCode: '010309', attributes: { parcel_gid: '00000000-0000-0000-0000-000000000000' }, geom: exactWkt
        }])] });
        await expect(createKeralaParcelSource(descriptor, foreign).queryIds([sourceId])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it('rejects invalid IDs, oversized windows, truncation flags and excessive features', async () => {
        const { fetchImpl } = makeFetch();
        const adapter = createKeralaParcelSource(descriptor, { fetchImpl });
        await expect(adapter.queryIds(['OTHER-' + nativeId])).rejects.toMatchObject({ status: 400 });
        await expect(adapter.queryBounds([76, 8, 77, 9])).rejects.toMatchObject({ status: 400 });
        const truncated = makeFetch({ exportResponses: [Response.json({ ...metricCollection, exceededTransferLimit: true })] });
        await expect(createKeralaParcelSource(descriptor, truncated).queryBounds(bbox(sample))).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        const exactLimit = makeFetch();
        await expect(createKeralaParcelSource({ ...descriptor, maxFeatures: 1 }, exactLimit).queryBounds(bbox(sample))).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        expect(() => createKeralaParcelSource({ ...descriptor, outFields: [...descriptor.outFields, 'owner'] })).toThrow(/Invalid Kerala/);
        expect(() => createKeralaParcelSource({ ...descriptor, maxBboxKm2: Number.NaN })).toThrow(/Invalid Kerala/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('parses valid polygon WKT with two-dimensional ordinates', () => {
        expect(parseKeralaWktPolygon('POLYGON ((0 0,1 0,1 1,0 0))')).toEqual({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] });
        expect(() => parseKeralaWktPolygon('POLYGON (((0 0,1 0,1 1,0 0)))')).toThrow(expect.objectContaining({ code: 'parcel-source-unavailable' }));
    });

    it('rejects excessively nested GeoJSON before recursive reprojection', async () => {
        const malformed = { type: 'FeatureCollection', features: [{
            type: 'Feature', properties: { parcel_gid: nativeId }, geometry: { type: 'Polygon', coordinates: [[[[[1, 2]]]]] }
        }] };
        await expect(createKeralaParcelSource(descriptor, makeFetch({ exportResponses: [Response.json(malformed)] })).queryBounds(bbox(sample)))
            .rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });
});
