import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupGeoRoute } from '../routes/geo.js';
import { createRouteApp } from './helpers/create-route-app.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('GET /geo/default-city', () => {
    it('returns the default city for private IPs', async () => {
        const app = createRouteApp(setupGeoRoute);

        const res = await request(app)
            .get('/geo/default-city')
            .set('x-forwarded-for', '127.0.0.1');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            cityId: 'zagreb',
            source: 'default',
            reason: 'private_or_missing_ip'
        });
    });

    it('maps external IP country codes to supported cities', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ country_code: 'RS' })
        }));

        const app = createRouteApp(setupGeoRoute);

        const res = await request(app)
            .get('/geo/default-city')
            .set('x-forwarded-for', '8.8.8.8');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            cityId: 'belgrade',
            source: 'ipapi',
            countryCode: 'RS'
        });
    });

    it('falls back to the default city on lookup failure', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

        const app = createRouteApp(setupGeoRoute);

        const res = await request(app)
            .get('/geo/default-city')
            .set('x-forwarded-for', '8.8.4.4');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            cityId: 'zagreb',
            source: 'default',
            reason: 'lookup_failed'
        });
    });

    it('uses cached geo results for repeated public IPs', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ country_code: 'HR' })
        });
        vi.stubGlobal('fetch', fetchMock);

        const app = createRouteApp(setupGeoRoute);

        const first = await request(app)
            .get('/geo/default-city')
            .set('x-forwarded-for', '9.9.9.9');
        const second = await request(app)
            .get('/geo/default-city')
            .set('x-forwarded-for', '9.9.9.9');

        expect(first.status).toBe(200);
        expect(first.body).toEqual({
            cityId: 'zagreb',
            source: 'ipapi',
            countryCode: 'HR'
        });
        expect(second.status).toBe(200);
        expect(second.body).toEqual({
            cityId: 'zagreb',
            source: 'cache',
            countryCode: 'HR'
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to the default city for unsupported countries while preserving ipapi source', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ country_code: 'US' })
        }));

        const app = createRouteApp(setupGeoRoute);

        const res = await request(app)
            .get('/geo/default-city')
            .set('x-forwarded-for', '4.4.4.4');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            cityId: 'zagreb',
            source: 'ipapi',
            countryCode: 'US'
        });
    });

    it('normalizes IPv6-mapped addresses from x-real-ip headers', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ country_code: 'AR' })
        }));

        const app = createRouteApp(setupGeoRoute);

        const res = await request(app)
            .get('/geo/default-city')
            .set('x-real-ip', '::ffff:3.3.3.3');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            cityId: 'buenos_aires',
            source: 'ipapi',
            countryCode: 'AR'
        });
    });

    it('uses the first forwarded ip when multiple public addresses are present', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ country_code: 'HR' })
        }));

        const app = createRouteApp(setupGeoRoute);

        const res = await request(app)
            .get('/geo/default-city')
            .set('x-forwarded-for', '8.8.8.8, 1.1.1.1');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            cityId: 'zagreb',
            source: 'ipapi',
            countryCode: 'HR'
        });
    });

    it('falls back to x-real-ip when x-forwarded-for is empty', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ country_code: 'RS' })
        }));

        const app = createRouteApp(setupGeoRoute);

        const res = await request(app)
            .get('/geo/default-city')
            .set('x-forwarded-for', '   ')
            .set('x-real-ip', '2.2.2.2');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            cityId: 'belgrade',
            source: 'ipapi',
            countryCode: 'RS'
        });
    });

    it('treats public lookups with missing country codes as default-city ipapi responses', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({})
        }));

        const app = createRouteApp(setupGeoRoute);

        const res = await request(app)
            .get('/geo/default-city')
            .set('x-forwarded-for', '5.5.5.5');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            cityId: 'zagreb',
            source: 'ipapi',
            countryCode: null
        });
    });
});