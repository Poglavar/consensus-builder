import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';
import { setupFeedbackRoute, validateFeedback } from '../routes/feedback.js';
const require = createRequire(import.meta.url);
const { pageLink } = require('../../frontend/js/feedback.js');
const translations = require('../../frontend/js/feedback-translations.js');
const id = '7489c4d1-0804-4f51-b34d-114907452e72';
const body = { reportId: id, kind: 'bug', message: 'Road comparison is disabled.', pageUrl: 'https://urbangametheory.xyz/agreements/example', source: 'web' };
function appWith(pool, options) { const app = express(); app.use(express.json()); setupFeedbackRoute(app, pool, options); return app; }
function store() {
    const saved = new Map();
    return { query: vi.fn(async (_sql, args) => {
        const previous = saved.get(args[0]);
        if (previous && JSON.stringify(previous) !== JSON.stringify(args)) return { rows: [] };
        saved.set(args[0], args);
        return { rows: [{ id: args[0], created_at: '2026-10-23T00:00:00.000Z' }] };
    }) };
}
describe('private feedback inbox', () => {
    it('stores a report and returns a private receipt; retrying the same ID does not create another report', async () => {
        const pool = store(), app = appWith(pool);
        for (let n = 0; n < 2; n++) {
            const res = await request(app).post('/feedback').send(body);
            expect(res.status).toBe(201); expect(res.headers['cache-control']).toBe('no-store');
            expect(res.body).toEqual({ report: { id, status: 'received', createdAt: '2026-10-23T00:00:00.000Z' } });
            expect(JSON.stringify(res.body)).not.toContain(body.message);
        }
        expect(pool.query.mock.calls[0][0]).toContain('ON CONFLICT (id)');
        expect(pool.query.mock.calls[0][1]).toEqual([id, body.kind, body.message, body.pageUrl, body.source]);
        expect((await request(app).get('/feedback')).status).toBe(404);
        expect((await request(app).get(`/feedback/${id}`)).status).toBe(404);
        expect((await request(app).post('/feedback').send({ ...body, message: 'Different report' })).status).toBe(409);
    });
    it.each([{ ...body, kind: 'other' }, { ...body, message: ' ' }, { ...body, message: 'x'.repeat(8001) },
        { ...body, reportId: 'not-uuid' }, { ...body, reportId: 5 }, { ...body, pageUrl: 'javascript:alert(1)' },
        { ...body, pageUrl: 'https://user:password@example.test/' }, { ...body, source: 'unknown' }])('refuses invalid input before storage', async invalid => {
        const pool = store();
        expect((await request(appWith(pool)).post('/feedback').send(invalid)).status).toBe(400);
        expect(pool.query).not.toHaveBeenCalled();
    });
    it('keeps unavailable storage explicit and rate limits submissions', async () => {
        const pool = { query: vi.fn(async () => { throw new Error('database unavailable'); }) };
        const app = appWith(pool, { requestLimit: 1 });
        const failed = await request(app).post('/feedback').send(body);
        expect(failed.status).toBe(503); expect(failed.body.code).toBe('feedback-unavailable');
        expect((await request(app).post('/feedback').send(body)).status).toBe(429);
        expect(pool.query).toHaveBeenCalledTimes(1);
    });
    it('removes private draft fragments and limits automatically attached page context', () => {
        expect(validateFeedback({ ...body, pageUrl: 'https://urbangametheory.xyz/designs#draft=private' }).value.pageUrl).toBe('https://urbangametheory.xyz/designs');
        expect(pageLink('https://app.example/?city=birmingham&at=52,-1,17&token=private#draft=private')).toBe('https://app.example/?city=birmingham&at=52%2C-1%2C17');
        expect(pageLink('https://user:password@app.example/')).toBe('');
    });
    it('provides every feedback string in all four app languages', () => {
        for (const lang of ['es', 'hr', 'sr']) expect(Object.keys(translations[lang]).sort()).toEqual(Object.keys(translations.en).sort());
    });
});
