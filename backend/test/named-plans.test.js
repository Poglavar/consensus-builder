// Named snapshots survive a new client/server instance and never acquire agreement terms or unpublished members.
import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { canonicalBytes, cidOf } from '../cid.js';
import { setupPlansRoute } from '../routes/plans.js';
const require = createRequire(import.meta.url);
const PlanRecord = require('../../frontend/js/plan-record.js');
const NamedPlans = require('../../frontend/js/named-plans.js');
const MapShare = require('../../frontend/js/map-share.js');
const Cid = require('../../frontend/js/cid.js');
const a = cidOf(Buffer.from('design a')), b = cidOf(Buffer.from('design b'));
const view = { at: '52.47935,-1.87943,18', city: 'birmingham', language: 'en', mode: 'model',
    camera: { targetLat: 52.47935, targetLng: -1.87943, headingDeg: 80, pitchRad: -0.6, range: 200 },
    settings: { existing: 'ghost', proposed: 'solid' } };
const content = PlanRecord.create('Digbeth Green Quarter', [a, b], view);
const cid = cidOf(canonicalBytes(content));

function server({ records = new Map(), designs = [a, b], pin = vi.fn(async ({ cid }) => ({ cid })) } = {}) {
    const pool = { query: vi.fn(async (sql, params) => {
        if (sql.startsWith('SELECT cid, content')) return { rows: records.has(params[0]) ? [records.get(params[0])] : [] };
        if (sql.startsWith('SELECT cid FROM consensus.design')) return { rows: designs.map(cid => ({ cid })) };
        if (sql.startsWith('INSERT INTO consensus.plan')) { records.set(params[0], { cid: params[0], content: JSON.parse(params[1]) }); return { rows: [] }; }
        throw new Error(`Unexpected query: ${sql}`);
    }) };
    const app = express(); app.use(express.json());
    setupPlansRoute(app, { pool, pinBytes: pin, uploadRateLimiter: (_req, _res, next) => next() });
    return { app, records, pin, pool };
}

describe('named plan records and API', () => {
    it('reports exhausted storage quota without saving a partially published plan', async () => {
        const { app, records } = server({ pin: async () => { throw Object.assign(new Error('Storage account quota exhausted'), { code: 'pinning-quota-exhausted' }); } });
        const response = await request(app).post('/plans').send({ content });
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ code: 'pinning-quota-exhausted', next: { action: expect.stringContaining('Restore quota') } });
        expect(records.size).toBe(0);
    });
    it('addresses the exact title, selected versions and view, excluding the backend override', () => {
        expect(PlanRecord.create(' Digbeth Green Quarter ', [b, a, b], { ...view, backend: 'https://api.example' })).toEqual(content);
        for (const changed of [PlanRecord.create('Another name', [a, b], view), PlanRecord.create(content.title, [a], view),
            PlanRecord.create(content.title, [a, b], { ...view, at: '52,-1,17' })]) expect(cidOf(canonicalBytes(changed))).not.toBe(cid);
        expect(content).not.toHaveProperty('rule');
    });
    it.each([
        { ...content, title: ' ' }, { ...content, title: 'x'.repeat(161) }, { ...content, designCids: [] },
        { ...content, designCids: [a, a] }, { ...content, rule: {} },
        { ...content, view: { ...content.view, backend: 'https://api.example' } },
        { ...content, view: { ...content.view, at: '90,0,18' } },
        { ...content, view: { ...content.view, camera: { ...view.camera, range: -1 } } },
        { ...content, view: { ...content.view, settings: { backend: 'https://api.example' } } }
    ])('refuses malformed or extra data before pinning', async bad => {
        const { app, pin } = server();
        expect((await request(app).post('/plans').send({ content: bad })).status).toBe(400);
        expect(pin).not.toHaveBeenCalled();
    });
    it('pins canonical content, persists it, reads it after restart and makes repeated saves idempotent', async () => {
        const { app, records, pin } = server();
        const first = await request(app).post('/plans').send({ content });
        expect(first.status).toBe(201); expect(first.body).toEqual({ cid, content });
        expect(pin).toHaveBeenCalledWith({ cid, bytes: canonicalBytes(content), name: `plan-${cid}` });
        expect((await request(app).post('/plans').send({ content })).status).toBe(200);
        expect(pin).toHaveBeenCalledTimes(1);
        expect((await request(server({ records }).app).get(`/plans/${cid}`)).body).toEqual(first.body);
    });
    it('refuses missing designs and pin failures without persisting a plan', async () => {
        const missing = server({ designs: [a] });
        const response = await request(missing.app).post('/plans').send({ content });
        expect(response.status).toBe(409); expect(response.body.missing).toEqual([b]);
        expect(missing.pin).not.toHaveBeenCalled(); expect(missing.records.size).toBe(0);
        const badPin = server({ pin: async () => ({ cid: a }) });
        expect((await request(badPin.app).post('/plans').send({ content })).status).toBe(503);
        expect(badPin.records.size).toBe(0);
    });
    it('distinguishes invalid and missing links', async () => {
        const { app } = server();
        expect((await request(app).get('/plans/invalid')).status).toBe(400);
        expect((await request(app).get(`/plans/${cid}`)).status).toBe(404);
    });
});

describe('named plan browser transport', () => {
    it('hydrates a bare link once, preserving explicit transport/view overrides', () => {
        const href = `https://app.example/plans/${cid}?backend=https%3A%2F%2Fapi.example`;
        const restored = NamedPlans.restoreUrl(href, view, MapShare);
        expect(new URL(restored).searchParams.get('city')).toBe('birmingham');
        expect(new URL(restored).searchParams.has('3d')).toBe(true);
        expect(new URL(restored).searchParams.get('backend')).toBe('https://api.example');
        expect(NamedPlans.restoreUrl(restored, view, MapShare)).toBe(restored);
        const explicit = NamedPlans.restoreUrl(href + '&at=51,0,16&photo', view, MapShare);
        expect(new URL(explicit).searchParams.get('at')).toBe('51,0,16');
        expect(new URL(explicit).searchParams.has('3d')).toBe(false);
    });
    const client = fetch => NamedPlans.browser({ location: new URL('https://app.example/?backend=https%3A%2F%2Fapi.example'),
        PlanRecord, Cid, MapShare, fetch, resolveBackendBaseUrl: () => 'https://api.example', resolveFrontendBaseUrl: () => 'https://app.example' });
    it('verifies a GET of the durable record before reporting a saved link', async () => {
        const fetch = vi.fn(async () => Response.json({ cid, content }));
        const api = client(fetch);
        expect((await api.save(content)).link).toBe(`https://app.example/plans/${cid}?backend=https%3A%2F%2Fapi.example`);
        expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(['POST', 'GET']);
        expect(api.current).toEqual({ cid, content });
    });
    it('does not claim success when read-back fails or content differs from the CID', async () => {
        const api = client(vi.fn().mockResolvedValueOnce(Response.json({ cid, content })).mockResolvedValueOnce(Response.json({ error: 'Not found' }, { status: 404 })));
        await expect(api.save(content)).rejects.toThrow('Not found'); expect(api.current).toBeNull();
        const altered = client(async () => Response.json({ cid, content: { ...content, title: 'Changed' } }));
        await expect(altered.save(content)).rejects.toThrow('does not match');
    });
    it('waits for route startup before using helpers loaded later in the page', async () => {
        const location = new URL(`https://app.example/plans/${cid}`);
        location.replace = vi.fn();
        const win = { location, PlanRecord, Cid, MapShare, fetch: vi.fn(async () => Response.json({ cid, content })) };
        const api = NamedPlans.browser(win);
        expect(win.fetch).not.toHaveBeenCalled();
        win.resolveBackendBaseUrl = () => 'https://api.example';
        await api.open();
        expect(location.replace).toHaveBeenCalledWith(expect.stringContaining('city=birmingham'));
    });
});
