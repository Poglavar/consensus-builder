// A single request must never be able to take the API down, and public reads must be bounded.
//
// Express 4 ignores the promise an async handler returns, so on Node 15+ a rejection outside a
// try/catch exited the whole process: `GET /city-stats/snapshots?city=a&city=b` did it with
// `.trim is not a function`. These tests drive the REAL app (createApp) so they exercise the
// forwarding wrapper, the global error handler, the input caps and the Canton flag together.

import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, installUnhandledRejectionLogger, isCantonEnabled } from '../index.js';
import { forwardAsyncErrors } from '../utils/async-routes.js';
import { MAX_UNDER_VERTICES } from '../routes/parcels.js';
import { setupParcelBgRoute } from '../routes/parcel-bg.js';
import { createRouteApp } from './helpers/create-route-app.js';

function recordingPool(handler = async () => ({ rows: [] })) {
    const calls = [];
    return {
        calls,
        query: async (sql, params) => {
            calls.push({ sql, params });
            return handler(sql, params);
        },
        connect: async () => ({ query: async () => ({ rows: [] }), release: () => { } }),
        on: () => { },
        end: async () => { }
    };
}

function app(pool = recordingPool(), env = {}) {
    return createApp({ env: { NODE_ENV: 'test', USE_CORS_ALLOWLIST: 'false', ...env }, pool }).app;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('async handler rejections reach the error handler', () => {
    it('answers a repeated query parameter with 400 instead of crashing', async () => {
        const pool = recordingPool();
        const res = await request(app(pool)).get('/city-stats/snapshots?city=a&city=b');

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/city/);
        expect(pool.calls).toHaveLength(0);
    });

    it('answers a nested query parameter on /city-stats/data with 400', async () => {
        const res = await request(app()).get('/city-stats/data?metric[x]=1');
        expect(res.status).toBe(400);
    });

    it('turns a rejecting handler into a 500 and keeps serving', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        // GET /plans/:slug awaits pool.query with no try/catch of its own.
        let fail = true;
        const pool = recordingPool(async () => {
            if (fail) throw new Error('database offline');
            return { rows: [] };
        });
        const server = app(pool);

        const failed = await request(server).get('/plans/some-plan');
        expect(failed.status).toBe(500);
        expect(failed.body).toEqual({ error: 'Internal server error' });

        fail = false;
        const next = await request(server).get('/plans/some-plan');
        expect(next.status).toBe(404);
        const health = await request(server).get('/health');
        expect(health.status).toBe(200);
    });

    it('forwards rejections from plain async middleware registered on a wrapped app', async () => {
        const bare = forwardAsyncErrors(express());
        bare.get('/boom', async () => { throw new Error('async boom'); });
        bare.use((err, _req, res, _next) => res.status(500).json({ caught: err.message }));

        const res = await request(bare).get('/boom');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ caught: 'async boom' });
    });

    it('keeps the settings getter working on a wrapped app', () => {
        const bare = forwardAsyncErrors(express());
        bare.set('answer', 42);
        expect(bare.get('answer')).toBe(42);
    });

    it('answers malformed JSON with 400, not 500', async () => {
        const res = await request(app())
            .post('/parcels/under')
            .set('Origin', 'http://localhost:5173')
            .set('Content-Type', 'application/json')
            .send('{"geometry":');
        expect(res.status).toBe(400);
    });
});

describe('unhandledRejection logger', () => {
    it('logs a timestamped line with the stack and does not swallow silently', () => {
        const target = new EventEmitter();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        installUnhandledRejectionLogger(target);
        installUnhandledRejectionLogger(target); // idempotent: one listener

        expect(target.listenerCount('unhandledRejection')).toBe(1);
        target.emit('unhandledRejection', new Error('stray promise'));

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const [line, detail] = errorSpy.mock.calls[0];
        expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\] UNHANDLED REJECTION #\d+:/);
        expect(String(detail)).toContain('stray promise');
    });
});

describe('public reads are bounded', () => {
    it('clamps /parcel-bg to a server-side LIMIT when no ?limit is given', async () => {
        const pool = recordingPool();
        await request(createRouteApp(setupParcelBgRoute, pool)).get('/parcel-bg?cadmun=70106');

        expect(pool.calls[0].sql).toMatch(/LIMIT \$\d+/);
        expect(pool.calls[0].params.at(-1)).toBe(5001);
    });

    it('clamps an oversized ?limit and flags a truncated answer', async () => {
        const row = {
            cadmun_code: '70106', parcel_num: '1', raw_feature: {},
            geometry: { type: 'Point', coordinates: [20.4, 44.8] }
        };
        const pool = recordingPool(async () => ({ rows: Array.from({ length: 5001 }, () => row) }));
        const res = await request(createRouteApp(setupParcelBgRoute, pool)).get('/parcel-bg?cadmun=70106&limit=999999');

        expect(pool.calls[0].params.at(-1)).toBe(5001);
        expect(res.status).toBe(200);
        expect(res.body.features).toHaveLength(5000);
        expect(res.body.truncated).toBe(true);
    });

    it('refuses a world-sized bbox on a city parcel source', async () => {
        const pool = recordingPool();
        const res = await request(createRouteApp(setupParcelBgRoute, pool)).get('/parcel-bg?bbox=-170,-80,170,80');

        expect(res.status).toBe(400);
        expect(pool.calls).toHaveLength(0);
    });

    it('refuses /road-parcels over a whole-region bbox and /planned-road without one', async () => {
        const server = app();
        expect((await request(server).get('/road-parcels?bbox=13,42,19,46.5')).status).toBe(400);
        expect((await request(server).get('/govt-plan?bbox=13,42,19,46.5')).status).toBe(400);
        expect((await request(server).get('/planned-road')).status).toBe(400);
    });
});

describe('POST /parcels/under validates its input before any SQL', () => {
    const post = (server, body) => request(server).post('/parcels/under').set('Origin', 'http://localhost:5173').send(body);

    it('refuses a geometry over the vertex cap', async () => {
        const pool = recordingPool();
        const ring = Array.from({ length: MAX_UNDER_VERTICES + 10 }, (_, i) => [15.9 + (i % 100) * 1e-5, 45.8 + Math.floor(i / 100) * 1e-5]);
        ring.push(ring[0]);
        const res = await post(app(pool), { geometry: { type: 'Polygon', coordinates: [ring] } });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/vertices/);
        expect(pool.calls).toHaveLength(0);
    });

    it('refuses an srid outside the allowlist', async () => {
        const pool = recordingPool();
        const geometry = { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.8]]] };
        const res = await post(app(pool), { geometry, srid: 900913 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/srid/);
        expect(pool.calls).toHaveLength(0);
    });

    it('refuses a continent-sized extent and non-numeric coordinates', async () => {
        const pool = recordingPool();
        const server = app(pool);
        const huge = { type: 'Polygon', coordinates: [[[-10, 35], [30, 35], [30, 60], [-10, 35]]] };
        const junk = { type: 'Polygon', coordinates: [[['a', 45.8], [15.91, 45.8], [15.91, 45.81], ['a', 45.8]]] };

        expect((await post(server, { geometry: huge })).status).toBe(400);
        expect((await post(server, { geometry: junk })).status).toBe(400);
        expect(pool.calls).toHaveLength(0);
    });

    it('still serves an ordinary footprint, with parcel geometry made valid inside the intersection', async () => {
        const pool = recordingPool(async sql => (sql.includes('count(*)') ? { rows: [{ parcels: 1 }] } : { rows: [{ rows: [], footprint_m2: 1, coverage: 1 }] }));
        const geometry = { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.901, 45.8], [15.901, 45.801], [15.9, 45.8]]] };
        const res = await post(app(pool), { geometry });

        expect(res.status).toBe(200);
        const full = pool.calls.find(call => call.sql.includes('taken_m2'));
        expect(full.sql).toContain('ST_Intersection(ST_MakeValid(p.geom), i.g)');
        // The index predicate keeps the raw column so the GIST index still applies.
        expect(full.sql).toContain('p.geom && parts.part');
    });
});

describe('Canton flag', () => {
    it('is off unless CANTON_ENABLED is exactly true', () => {
        expect(isCantonEnabled({})).toBe(false);
        expect(isCantonEnabled({ CANTON_ENABLED: 'false' })).toBe(false);
        expect(isCantonEnabled({ CANTON_ENABLED: 'TRUE' })).toBe(true);
    });

    it('does not register /canton/* when disabled', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => { });
        const server = app(recordingPool(), { CANTON_ENABLED: 'false' });

        expect((await request(server).get('/canton/ledger-end')).status).toBe(404);
        expect((await request(server).get('/canton/proposals?party=x')).status).toBe(404);
        expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/Canton disabled/));
    });

    it('registers them again when enabled (validation answers without touching the ledger)', async () => {
        const server = app(recordingPool(), { CANTON_ENABLED: 'true' });
        expect((await request(server).get('/canton/proposals')).status).toBe(400);
    });
});
