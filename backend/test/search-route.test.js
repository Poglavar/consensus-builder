// The search endpoint reads only plan/design metadata and binds literal search strings safely.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupSearchRoute } from '../routes/search.js';

function fixture() {
    const pool = { query: vi.fn(async sql => ({ rows: sql.includes('consensus.plan')
        ? [{ cid: 'plan-cid', title: 'River plan', city: 'explore', design_count: 3 }]
        : [{ cid: 'design-cid', title: 'River park', city: 'explore', author: 'Studio North', goal: 'park' }] })) };
    const app = express();
    setupSearchRoute(app, { pool });
    return { app, pool };
}
afterEach(() => vi.restoreAllMocks());

describe('GET /search', () => {
    it('returns plans and designs without content, binding or geometry downloads', async () => {
        const { app, pool } = fixture();
        const response = await request(app).get('/search').query({ q: ' River ' });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            plans: [{ cid: 'plan-cid', title: 'River plan', city: 'explore', designCount: 3 }],
            designs: [{ cid: 'design-cid', title: 'River park', city: 'explore', author: 'Studio North', goal: 'park' }]
        });
        for (const [sql, params] of pool.query.mock.calls) {
            expect(params).toEqual(['River', '%River%', 20]);
            expect(sql).not.toMatch(/SELECT\s+\*|\bbinding\b|\bgeometry\b/);
            expect(sql).toContain('LIMIT $3');
        }
    });
    it('binds wildcard characters literally and never interpolates SQL input', async () => {
        const { app, pool } = fixture();
        const query = "50%_\\'; DROP TABLE ignored;--";
        expect((await request(app).get('/search').query({ q: query, limit: '5' })).status).toBe(200);
        for (const [sql, params] of pool.query.mock.calls) {
            expect(sql).not.toContain(query);
            expect(params).toEqual([query, "%50\\%\\_\\\\'; DROP TABLE ignored;--%", 5]);
        }
    });
    it.each([{ q: '' }, { q: 'a' }, { q: 'a'.repeat(201) }, { q: ['ab', 'cd'] },
        { q: 'ab', limit: '0' }, { q: 'ab', limit: '51' }, { q: 'ab', limit: '2.5' }, { q: 'ab', limit: 'no' }])
    ('rejects malformed queries before reading the index: %j', async query => {
        const { app, pool } = fixture();
        expect((await request(app).get('/search').query(query)).status).toBe(400);
        expect(pool.query).not.toHaveBeenCalled();
    });
    it('reports a failed source as unavailable instead of caching a partial success', async () => {
        const { app, pool } = fixture();
        pool.query.mockRejectedValueOnce(new Error('unavailable'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const response = await request(app).get('/search?q=River');
        expect(response.status).toBe(503);
        expect(response.body.code).toBe('search-unavailable');
        expect(response.body).not.toHaveProperty('plans');
    });
});
