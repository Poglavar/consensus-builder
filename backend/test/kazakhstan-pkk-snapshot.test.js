// The Kazakhstan cadastre's saved copies: a failed live read (refused, unreachable or late) is answered
// from the district copy in the provider's own page shape, through the parcel adapter and the relay.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import proj4 from 'proj4';
import { createKazakhstanPkkSource, kazakhstanPkkProjection } from '../parcels/kazakhstan-pkk-source.js';
import { createPkkSnapshotStore, parseSnapshotQuery, snapshotFileName, withPkkSnapshotFallback } from '../parcels/kazakhstan-pkk-snapshot.js';
import { parcelSourceCatalog } from '../parcels/sources.js';
import { createParcelProviderRelayRouter } from '../routes/parcel-provider-relay.js';

const ENDPOINT = 'https://map.gov4c.kz/geoserver/egkn/u_view/wfs';
const GK13 = kazakhstanPkkProjection(13).definition;
const [cx, cy] = proj4('EPSG:4326', GK13, [76.9702, 43.4126]);
const square = (x, y, size = 5) => ({ type: 'MultiPolygon', coordinates: [[[[x - size, y - size], [x + size, y - size], [x + size, y + size], [x - size, y + size], [x - size, y - size]]]] });
const parcel = (gid, kad, x, y) => ({ type: 'Feature', id: `u_view.fid-${gid}`, geometry: square(x, y),
    properties: { gid, district_id: 364, kad_nomer: kad, address_ru: 'обл. Алматинская' } });
// Three parcels near the centre, one 2 km away.
const SAVED = [parcel(30, '030461441521', cx, cy), parcel(10, '030461441522', cx + 20, cy), parcel(20, '030461441523', cx, cy + 20),
    parcel(40, '030461441524', cx + 2000, cy)];
const read = params => `${ENDPOINT}?${new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typename: 'egkn:u_view',
    outputFormat: 'application/json', propertyname: 'gid,kad_nomer,geom', sortBy: 'gid', viewparams: 'district_id:364', ...params })}`;
const refused = () => new Response('<html>403 Forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } });

let directory;
beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pkk-copy-'));
    fs.writeFileSync(path.join(directory, snapshotFileName(364)), zlib.gzipSync(JSON.stringify({
        type: 'FeatureCollection', districtId: 364, snapshotDate: '2026-11-27T05:51:13.102Z', numberMatched: SAVED.length, features: SAVED })));
});
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('Kazakhstan cadastre saved copies', () => {
    it('reads only the adapter\'s own u_view reads', () => {
        expect(parseSnapshotQuery(read({ bbox: '1,2,3,4', count: '2', startIndex: '2' }))).toMatchObject({ districtId: 364, bbox: [1, 2, 3, 4], count: 2, startIndex: 2, fields: ['gid', 'kad_nomer'] });
        expect(parseSnapshotQuery(read({}).replace('u_view/wfs', 'freelands_view/wfs'))).toBeNull();
        expect(parseSnapshotQuery(read({ viewparams: 'nothing' }))).toBeNull();
    });

    it('passes a live answer through untouched and never opens the copy', async () => {
        const store = { answer: vi.fn() };
        const live = new Response('{"features":[]}', { status: 200 });
        const fetchWithCopy = withPkkSnapshotFallback(async () => live, { store });
        expect(await fetchWithCopy(read({}))).toBe(live);
        expect(store.answer).not.toHaveBeenCalled();
    });

    it('answers a refused read from the copy: the area, by gid, paged, with only the asked fields, and says so', async () => {
        const fetchWithCopy = withPkkSnapshotFallback(async () => refused(), { store: createPkkSnapshotStore({ directory }) });
        const box = [cx - 50, cy - 50, cx + 50, cy + 50].join(',');
        const first = await fetchWithCopy(read({ bbox: box, count: '2', startIndex: '0' }));
        expect(first.status).toBe(200);
        expect(first.headers.get('x-parcel-snapshot')).toBe('2026-11-27T05:51:13.102Z');
        const page = await first.json();
        expect(page).toMatchObject({ numberMatched: 3, numberReturned: 2 });
        expect(page.features.map(feature => feature.properties)).toEqual([{ gid: 10, kad_nomer: '030461441522' }, { gid: 20, kad_nomer: '030461441523' }]);
        const second = await (await fetchWithCopy(read({ bbox: box, count: '2', startIndex: '2' }))).json();
        expect(second.features.map(feature => feature.properties.gid)).toEqual([30]);
        const filter = '<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0"><fes:PropertyIsEqualTo><fes:ValueReference>kad_nomer</fes:ValueReference><fes:Literal>030461441524</fes:Literal></fes:PropertyIsEqualTo></fes:Filter>';
        const byNumber = await (await fetchWithCopy(read({ filter, count: '20' }))).json();
        expect(byNumber.features.map(feature => feature.properties.gid)).toEqual([40]);
    });

    it('answers an unreachable or late cadastre from the copy, and leaves a district without a copy failing as before', async () => {
        const store = createPkkSnapshotStore({ directory });
        const unreachable = withPkkSnapshotFallback(async () => { throw new TypeError('fetch failed'); }, { store });
        expect((await unreachable(read({ count: '10' }))).headers.get('x-parcel-snapshot')).toBeTruthy();
        const hanging = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
        const late = withPkkSnapshotFallback(hanging, { store, liveBudgetMs: 20 });
        expect((await late(read({ count: '10' }))).status).toBe(200);
        const noCopy = await withPkkSnapshotFallback(async () => refused(), { store })(read({ viewparams: 'district_id:254' }));
        expect(noCopy.status).toBe(403);
        await expect(withPkkSnapshotFallback(async () => { throw new TypeError('fetch failed'); }, { store })(read({ viewparams: 'district_id:254' })))
            .rejects.toThrow('fetch failed');
    });

    it('gives the parcel adapter the copy\'s parcels when the cadastre refuses it', async () => {
        const descriptor = { id: 'kz-alatau-pkk', endpoint: ENDPOINT, featureType: 'egkn:u_view', districtId: 364, idPrefix: 'KZ-ALATAU-PKK-',
            idField: 'kad_nomer', outFields: ['gid', 'kad_nomer'], pageSize: 1000, maxFeatures: 10000, maxBboxKm2: 2 };
        const fetchImpl = withPkkSnapshotFallback(async () => refused(), { store: createPkkSnapshotStore({ directory }) });
        const result = await createKazakhstanPkkSource(descriptor, { fetchImpl }).queryBounds([76.9696, 43.4122, 76.9708, 43.4130]);
        expect(result.features.map(feature => feature.properties.parcelNumber).sort()).toEqual(['030461441521', '030461441522', '030461441523']);
    });

    it('relays a copy\'s answer with its date and keeps it out of browser and Cloudflare caches', async () => {
        const pkk = parcelSourceCatalog.sources.find(source => source.id === 'kz-alatau-pkk');
        const relayFetch = vi.fn(async () => new Response('{"type":"FeatureCollection","features":[]}', { status: 200,
            headers: { 'content-type': 'application/json', 'x-parcel-snapshot': '2026-11-27T05:51:13.102Z' } }));
        const router = createParcelProviderRelayRouter({ sources: [pkk], relayFetch });
        const layer = router.stack.find(entry => entry.route?.methods?.get);
        const query = { url: read({ count: '10' }), referer: 'https://map.gov4c.kz/egkn/' };
        const req = Object.assign(new EventEmitter(), { params: { sourceId: pkk.id }, query, originalUrl: `/parcel-provider-relay/${pkk.id}?${new URLSearchParams(query)}` });
        const res = Object.assign(new EventEmitter(), { headers: {}, statusCode: 200, headersSent: false, writableEnded: false,
            status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; this.writableEnded = true; return this; },
            setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, write() { return true; },
            end() { this.writableEnded = true; }, destroy() {} });
        await layer.route.stack.at(-1).handle(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-parcel-snapshot']).toBe('2026-11-27T05:51:13.102Z');
    });
});
