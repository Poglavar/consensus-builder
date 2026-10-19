// GET /activity/cities: the per-city proposal counts behind the globe's painted dots and label
// badges — published rows only, city codes folded into ids, largest first.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { cityProposalCounts, setupAgentActivityRoute } from '../routes/agent-activity.js';

describe('cityProposalCounts', () => {
    it('folds city codes into ids, drops rows without a city, and orders largest first', () => {
        const rows = [
            { city: 'zagreb', proposals: 200 }, { city: 'ZG', proposals: 31 }, { city: 'sibenik', proposals: 275 },
            { city: null, proposals: 6 }, { city: 'belgrade', proposals: 0 }, { city: 'split', proposals: '1' },
            { city: 'lima', proposals: 1 }
        ];
        expect(cityProposalCounts(rows)).toEqual([
            { id: 'sibenik', proposals: 275 }, { id: 'zagreb', proposals: 231 },
            { id: 'lima', proposals: 1 }, { id: 'split', proposals: 1 }
        ]);
        expect(cityProposalCounts()).toEqual([]);
    });
});

describe('GET /activity/cities', () => {
    it('counts published proposals grouped by city and lets the browser cache it briefly', async () => {
        const calls = [];
        const pool = { query: async (sql, params = []) => {
            calls.push({ sql, params });
            return { rows: [{ city: 'zagreb', proposals: 231 }, { city: 'san_francisco', proposals: 5 }] };
        } };
        const app = express();
        setupAgentActivityRoute(app, pool, { book: {}, idls: {}, decode: () => null });

        const response = await request(app).get('/activity/cities');

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('public, max-age=60');
        expect(response.body).toEqual({ cities: [{ id: 'zagreb', proposals: 231 }, { id: 'san_francisco', proposals: 5 }] });
        expect(calls).toHaveLength(1);
        expect(calls[0].sql).toMatch(/GROUP BY city/);
        expect(calls[0].sql).toMatch(/<> 'draft'/);
        expect(calls[0].sql).toMatch(/city IS NOT NULL/);
    });

    it('answers 500 without a body of counts when the database read fails', async () => {
        const pool = { query: async () => { throw new Error('connection refused'); } };
        const app = express();
        setupAgentActivityRoute(app, pool, { book: {}, idls: {}, decode: () => null });

        const response = await request(app).get('/activity/cities');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'Failed to count proposals per city' });
    });
});
