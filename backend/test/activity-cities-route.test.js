// GET /activity/cities: the per-city agreement counts behind the globe's painted dots and label badges
// (routes/agent-activity.js) — agreements in the index grouped by city, city codes trimmed and lower-cased into ids,
// largest first.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { cityAgreementCounts, setupAgentActivityRoute } from '../routes/agent-activity.js';

describe('cityAgreementCounts', () => {
    it('folds city codes into ids (trimmed, lower-cased, no alias lookup), drops rows without a city or a count, and orders largest first', () => {
        const rows = [
            { city: 'zagreb', agreements: 200 }, { city: ' Zagreb ', agreements: 31 }, { city: 'sibenik', agreements: 275 },
            { city: null, agreements: 6 }, { city: 'belgrade', agreements: 0 }, { city: 'split', agreements: '1' },
            { city: 'lima', agreements: 1 }, { city: 'oslo', agreements: 'many' }
        ];
        expect(cityAgreementCounts(rows)).toEqual([
            { id: 'sibenik', agreements: 275 }, { id: 'zagreb', agreements: 231 },
            { id: 'lima', agreements: 1 }, { id: 'split', agreements: 1 }
        ]);
        expect(cityAgreementCounts()).toEqual([]);
    });
});

describe('GET /activity/cities', () => {
    it('counts the index\'s agreements grouped by city and lets the browser cache it briefly', async () => {
        const calls = [];
        const pool = { query: async (sql, params = []) => {
            calls.push({ sql, params });
            return { rows: [{ city: 'zagreb', agreements: 231 }, { city: 'san_francisco', agreements: 5 }] };
        } };
        const app = express();
        setupAgentActivityRoute(app, pool, { book: {}, idls: {}, decode: () => null });

        const response = await request(app).get('/activity/cities');

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('public, max-age=60');
        expect(response.body).toEqual({ cities: [{ id: 'zagreb', agreements: 231 }, { id: 'san_francisco', agreements: 5 }] });
        expect(calls).toHaveLength(1);
        expect(calls[0].sql).toMatch(/FROM consensus\.agreement/);
        expect(calls[0].sql).toMatch(/GROUP BY city/);
        expect(calls[0].sql).toMatch(/city IS NOT NULL/);
    });

    it('answers 500 without a body of counts when the database read fails', async () => {
        const pool = { query: async () => { throw new Error('connection refused'); } };
        const app = express();
        setupAgentActivityRoute(app, pool, { book: {}, idls: {}, decode: () => null });

        const response = await request(app).get('/activity/cities');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'Failed to count agreements per city' });
    });
});
