import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { setupParcelSourcesRoute } from '../routes/parcel-sources.js';
import { encodeCustomSource, decodeCustomSource } from '../parcels/custom-source-config.js';
import { withSourceCooldown } from '../parcels/sources.js';

const descriptor = { adapter: 'arcgis', endpoint: 'https://parcels.example.org/FeatureServer/0',
    cityIds: ['toronto'], metricSrid: 32617, idField: 'PARCEL_ID', objectIdField: 'OBJECTID',
    idType: 'integer', outFields: ['PARCEL_ID', 'OBJECTID'] };
const bbox = [-79.38, 43.65, -79.379, 43.651];
const parcel = { type: 'Feature', properties: { PARCEL_ID: 12, OBJECTID: 3 },
    geometry: { type: 'Polygon', coordinates: [[[-79.38, 43.65], [-79.379, 43.65], [-79.379, 43.651], [-79.38, 43.65]]] } };
const okFetch = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features: [parcel], exceededTransferLimit: false }) }));
function app(options = {}) { const app = express(); app.use(express.json()); setupParcelSourcesRoute(app, { sources: [], ...options }); return app; }

describe('custom parcel source gateway', () => {
    it('checks the final source identity before returning a portable configuration', async () => {
        const publicFetch = okFetch();
        const discover = vi.fn(async () => ({ descriptor, attempts: [{ adapter: 'arcgis', status: 'verified' }] }));
        const response = await request(app({ publicFetch, discover })).post('/parcel-sources/discover')
            .send({ url: descriptor.endpoint, city: 'toronto', bbox });
        expect(response.status).toBe(200);
        expect(response.body.source.id).toMatch(/^custom\./);
        expect(response.body.source).toEqual(decodeCustomSource(response.body.source.id));
        expect(response.body.parcelCount).toBe(1);
        expect(discover.mock.calls[0][0]).toMatchObject({ city: 'toronto', metricSrid: 32617, bbox });
        expect(publicFetch).toHaveBeenCalledOnce();
        // A newly created app can reconstruct source metadata without a registration cache or DB.
        const info = await request(app()).get('/parcel-sources/' + response.body.source.id + '/info');
        expect(info.status).toBe(200);
        expect(info.body.source.idPrefix).toBe(response.body.source.idPrefix);
    });
    it('keeps a provider failure distinct from no available adapter', async () => {
        const attempts = [{ adapter: 'arcgis', status: 'failed' }];
        for (const [code, upstreamStatus, status] of [['no-available-adapter', undefined, 422], ['parcel-source-blocked', 403, 502], ['parcel-source-rate-limited', 429, 502]]) {
            const discover = async () => { throw Object.assign(new Error('Check failed.'), { code, upstreamStatus, status, retryAfterSeconds: 42, attempts }); };
            const response = await request(app({ discover })).post('/parcel-sources/discover').send({ url: descriptor.endpoint, city: 'toronto', bbox });
            expect(response.status).toBe(status);
            expect(response.body).toMatchObject({ code, attempts, retryAfterSeconds: 42 });
            expect(response.headers['retry-after']).toBe('42');
            expect(response.body.features).toBeUndefined();
        }
    });
    it.each([
        { url: 'http://parcels.example.org', city: 'toronto', bbox },
        { url: 'https://127.0.0.1', city: 'toronto', bbox },
        { url: 'https://public.example/' + 'x'.repeat(2000), city: 'toronto', bbox },
        { url: descriptor.endpoint, city: 'toronto/other', bbox },
        { url: descriptor.endpoint, city: 'toronto', bbox: [-79, 43, -78, 44] }
    ])('rejects an unsafe setup before contacting providers (%j)', async body => {
        const discover = vi.fn();
        const response = await request(app({ discover })).post('/parcel-sources/discover').send(body);
        expect(response.status).toBe(400); expect(discover).not.toHaveBeenCalled();
    });
    it.each([403, 429, 503])('passes provider HTTP %s failure details through the normal gateway', async upstreamStatus => {
        const source = { ...descriptor, id: 'sample', idPrefix: 'SAMPLE-' };
        const fetchImpl = vi.fn(async () => ({ status: upstreamStatus, ok: false, headers: new Headers({ 'Retry-After': '45' }) }));
        const application = app({ sources: [source], fetchImpl });
        const first = await request(application).get('/parcel-sources/sample?bbox=' + bbox.join(','));
        const expectedCode = upstreamStatus === 403 ? 'parcel-source-blocked' : upstreamStatus === 429 ? 'parcel-source-rate-limited' : 'parcel-source-unavailable';
        expect(first.status).toBe(502); expect(first.body).toMatchObject({ code: expectedCode, upstreamStatus });
        expect(first.body.features).toBeUndefined();
        expect(first.headers['retry-after']).toBeTruthy();
        const second = await request(application).get('/parcel-sources/sample?ids=SAMPLE-12');
        expect(second.body.code).toBe(expectedCode); expect(fetchImpl).toHaveBeenCalledOnce();
    });
    it('resumes reads after cooldown without retaining false absence', async () => {
        let time = 0;
        const failure = Object.assign(new Error('blocked'), { status: 502, code: 'parcel-source-blocked', upstreamStatus: 403 });
        const raw = { queryBounds: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ complete: true, features: [parcel] }), queryIds: vi.fn(), queryGeometry: vi.fn() };
        const provider = withSourceCooldown(raw, { now: () => time });
        await expect(provider.queryBounds(bbox)).rejects.toMatchObject({ code: 'parcel-source-blocked' });
        await expect(provider.queryIds(['SAMPLE-12'])).rejects.toMatchObject({ code: 'parcel-source-blocked' });
        expect(raw.queryIds).not.toHaveBeenCalled();
        time = 61000;
        await expect(provider.queryBounds(bbox)).resolves.toMatchObject({ complete: true, features: [parcel] });
        expect(raw.queryBounds).toHaveBeenCalledTimes(2);
    });
    it('does not erase a new rate limit when an older concurrent request succeeds', async () => {
        let release;
        const raw = { queryBounds: () => new Promise(resolve => { release = resolve; }), queryIds: async () => { throw Object.assign(new Error('limited'), { code: 'parcel-source-rate-limited', retryAfterSeconds: 10 }); }, queryGeometry: vi.fn() };
        const provider = withSourceCooldown(raw, { now: () => 0 });
        const pending = provider.queryBounds(bbox);
        await expect(provider.queryIds(['A'])).rejects.toMatchObject({ code: 'parcel-source-rate-limited' });
        release({ complete: true, features: [] }); await pending;
        await expect(provider.queryGeometry(parcel.geometry)).rejects.toMatchObject({ code: 'parcel-source-rate-limited' });
        expect(raw.queryGeometry).not.toHaveBeenCalled();
    });
    it('rejects tampered source tokens instead of treating them as empty coverage', async () => {
        const id = encodeCustomSource(descriptor);
        const response = await request(app()).get('/parcel-sources/' + id.slice(0, -2) + 'aa?bbox=' + bbox.join(','));
        expect(response.status).toBe(400); expect(response.body.features).toBeUndefined();
    });
});
