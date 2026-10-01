// POST/GET /cities/requests (routes/city-requests.js) with a stubbed pool: validation, the upsert
// it issues, the listing, and the per-IP rate limit.
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { setupCityRequestsRoute, validateCityRequest } from '../routes/city-requests.js';

function stubPool() {
    const rows = new Map();
    const calls = [];
    return {
        calls,
        rows,
        async query(sql, params) {
            calls.push({ sql, params });
            if (/^\s*INSERT/i.test(sql)) {
                const [placeKey, name, country, lat, lon] = params;
                const now = new Date('2026-10-01T00:00:00Z').toISOString();
                const prev = rows.get(placeKey);
                const row = prev
                    ? { ...prev, request_count: prev.request_count + 1 }
                    : { place_key: placeKey, name, country, lat, lon, request_count: 1, first_requested_at: now, last_requested_at: now };
                rows.set(placeKey, row);
                return { rows: [row] };
            }
            const limit = params[0];
            return { rows: [...rows.values()].sort((a, b) => b.request_count - a.request_count).slice(0, limit) };
        }
    };
}

function appWith(pool, options) {
    const app = express();
    app.use(express.json());
    setupCityRequestsRoute(app, pool, options);
    return app;
}

const tokyo = { placeKey: 'geonames:1850147', name: 'Tokyo', country: 'Japan', lat: 35.6895, lon: 139.6917 };

describe('validateCityRequest', () => {
    it('accepts a well-formed place and trims text', () => {
        expect(validateCityRequest({ ...tokyo, name: '  Tokyo ' }).value).toEqual({ ...tokyo, name: 'Tokyo' });
    });

    it.each([
        [{ ...tokyo, placeKey: '' }, /placeKey/],
        [{ ...tokyo, placeKey: 'drop table; --' }, /placeKey/],
        [{ ...tokyo, name: '' }, /name/],
        [{ ...tokyo, lat: '35' }, /lat/],
        [{ ...tokyo, lat: 91 }, /lat/],
        [{ ...tokyo, lon: null }, /lon/],
        [{ ...tokyo, lon: Number.NaN }, /lon/]
    ])('rejects %j', (body, message) => {
        expect(validateCityRequest(body).error).toMatch(message);
    });
});

describe('/cities/requests', () => {
    it('counts repeated requests for the same place and lists the top ones', async () => {
        const pool = stubPool();
        const app = appWith(pool);
        const first = await request(app).post('/cities/requests').send(tokyo);
        expect(first.status).toBe(201);
        expect(first.body.request).toMatchObject({ placeKey: tokyo.placeKey, requestCount: 1 });
        const second = await request(app).post('/cities/requests').send(tokyo);
        expect(second.body.request.requestCount).toBe(2);
        await request(app).post('/cities/requests').send({ placeKey: 'country:FR', name: 'France', lat: 46.6, lon: 2.4 });
        expect(pool.calls[0].sql).toMatch(/ON CONFLICT \(place_key\) DO UPDATE/);
        expect(pool.calls[0].params).toEqual([tokyo.placeKey, 'Tokyo', 'Japan', tokyo.lat, tokyo.lon]);

        const list = await request(app).get('/cities/requests?limit=5');
        expect(list.status).toBe(200);
        expect(list.body.requests.map(r => [r.placeKey, r.requestCount])).toEqual([[tokyo.placeKey, 2], ['country:FR', 1]]);
        expect(pool.calls.at(-1).params).toEqual([5]);
    });

    it('rejects an invalid body without touching the database', async () => {
        const pool = stubPool();
        const res = await request(appWith(pool)).post('/cities/requests').send({ placeKey: 'x', name: 'X', lat: 200, lon: 0 });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_request');
        expect(pool.calls).toHaveLength(0);
    });

    it('rate limits POSTs per client', async () => {
        const app = appWith(stubPool(), { requestLimit: 2 });
        expect((await request(app).post('/cities/requests').send(tokyo)).status).toBe(201);
        expect((await request(app).post('/cities/requests').send(tokyo)).status).toBe(201);
        const limited = await request(app).post('/cities/requests').send(tokyo);
        expect(limited.status).toBe(429);
        expect((await request(app).get('/cities/requests')).status).toBe(200); // reads are not limited
    });

    it('reports a database failure as a 500', async () => {
        const app = appWith({ query: async () => { throw new Error('down'); } });
        expect((await request(app).post('/cities/requests').send(tokyo)).status).toBe(500);
        expect((await request(app).get('/cities/requests')).status).toBe(500);
    });
});
