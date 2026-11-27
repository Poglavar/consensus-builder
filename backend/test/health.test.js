import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createKzCadastreProbe, setupHealthRoute } from '../routes/health.js';
import { createRouteApp } from './helpers/create-route-app.js';

describe('GET /health', () => {
    it('returns ok status', async () => {
        const app = createRouteApp(setupHealthRoute);

        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok' });
        expect(res.headers['content-type']).toContain('application/json');
    });
});
describe('GET /health/kz-cadastre', () => {
    const page = count => new Response(JSON.stringify({ type: 'FeatureCollection', features: Array.from({ length: count }, (_, i) => ({ properties: { gid: i } })) }), { status: 200 });

    it('asks the live cadastre itself at the layer address with a browser User-Agent, and is ok when parcels come back', async () => {
        const fetchImpl = vi.fn(async () => page(12));
        const app = createRouteApp(setupHealthRoute, { kzCadastreProbe: createKzCadastreProbe({ fetchImpl }) });
        const res = await request(app).get('/health/kz-cadastre');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'ok', parcels: 12 });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(new URL(url).pathname).toBe('/geoserver/egkn/u_view/wfs');
        expect(init.headers['User-Agent']).toBe('Mozilla/5.0');
    });

    it('fails with the reason when the cadastre refuses, times out or answers no parcels, and asks at most every 10 minutes', async () => {
        let clock = 0;
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('forbidden', { status: 403 })).mockResolvedValueOnce(page(0))
            .mockRejectedValueOnce(Object.assign(new Error('late'), { name: 'TimeoutError' }));
        const probe = createKzCadastreProbe({ fetchImpl, now: () => clock });
        const app = createRouteApp(setupHealthRoute, { kzCadastreProbe: probe });
        const refused = await request(app).get('/health/kz-cadastre');
        expect(refused.status).toBe(503);
        expect(refused.body).toMatchObject({ status: 'blocked', httpStatus: 403 });
        expect((await request(app).get('/health/kz-cadastre')).body.httpStatus).toBe(403);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        clock += 10 * 60 * 1000;
        expect((await request(app).get('/health/kz-cadastre')).body).toMatchObject({ status: 'error', error: 'no parcels in the probe area' });
        clock += 10 * 60 * 1000;
        expect((await request(app).get('/health/kz-cadastre')).body).toMatchObject({ status: 'error', error: 'timed out' });
    });
});
