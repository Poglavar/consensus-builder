// A single request must never be able to take the API down, and public reads must be bounded.
//
// Express 4 ignores the promise an async handler returns, so on Node 15+ a rejection outside a
// try/catch exited the whole process: `GET /city-stats/snapshots?city=a&city=b` did it with
// `.trim is not a function`. These tests drive the REAL app (createApp) so they exercise the
// forwarding wrapper, the global error handler, the input caps and the write gate together.

import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, installUnhandledRejectionLogger, READ_ONLY_POST_PATHS } from '../index.js';
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

    it('turns a failing query into a 500 and keeps serving', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        // Every route now catches its own query failures (the last one that did not, GET /plans/:slug,
        // went with the named plans); a rejection that escapes a handler is checked on a bare wrapped
        // app below.
        const designPath = '/designs/bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
        let fail = true;
        const pool = recordingPool(async () => {
            if (fail) throw new Error('database offline');
            return { rows: [] };
        });
        const server = app(pool);

        const failed = await request(server).get(designPath);
        expect(failed.status).toBe(500);
        expect(failed.body).toEqual({ error: 'Internal server error' });

        fail = false;
        const next = await request(server).get(designPath);
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

    it('still serves an ordinary footprint, made valid before it is subdivided', async () => {
        const pool = recordingPool(async sql => (sql.includes('count(*)') ? { rows: [{ parcels: 1 }] } : { rows: [] }));
        const geometry = { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.901, 45.8], [15.901, 45.801], [15.9, 45.8]]] };
        const res = await post(app(pool), { geometry });

        expect(res.status).toBe(200);
        const candidates = pool.calls.find(call => !call.sql.includes('count(*)'));
        expect(candidates.sql).toContain('ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1::text)');
        // The index predicate keeps the raw column so the GIST index still applies.
        expect(candidates.sql).toContain('p.geom && parts.part');
    });
});

// The agent docs send headless callers to POST /parcels/under and /buildings/footprints. They send no
// Origin, and the gate used to 403 every POST without one — a read included. Writes keep the gate.
describe('the Origin gate lets read-only POSTs through and still stops writes', () => {
    const square = { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.901, 45.8], [15.901, 45.801], [15.9, 45.8]]] };

    it('answers the documented parcel search to a caller with no Origin or Referer', async () => {
        const pool = recordingPool(async sql => (sql.includes('count(*)')
            ? { rows: [{ parcels: 1 }] }
            : { rows: [{ cestica_id: 7, broj_cestice: '2379', maticni_broj_ko: '335240', parcelid: 'HR-335240-2379', geometry: square, calculated_area: 120 }] }));
        const res = await request(app(pool)).post('/parcels/under').send({ geometry: square });

        expect(res.status).toBe(200);
        expect(res.body.features.map(feature => feature.properties.parcelId)).toEqual(['HR-335240-2379']);
    });

    it('reaches the handler of every read-only POST without an Origin', async () => {
        // An empty body is invalid on each of them, so each handler answers its own 400: proof the
        // request got past the gate, whose refusal is 403 { error: 'Forbidden' }.
        const server = app();
        expect(READ_ONLY_POST_PATHS).toContain('/buildings/footprints');
        // A read whose input fits a URL is a GET, not a POST on this list: 3D scenery (asked again on
        // every pan in model mode; as POSTs counted as writes it ran out the budget and the green
        // stopped following the view) and the source checks.
        for (const path of ['/decor/near', '/decor/water', '/decor/green',
            '/parcel-sources/discover', '/building-sources/discover', '/imagery-sources/discover']) {
            expect(READ_ONLY_POST_PATHS.has(path), path).toBe(false);
        }
        for (const path of READ_ONLY_POST_PATHS) {
            const res = await request(server).post(path).send({});
            expect(res.status, path).toBe(400);
            expect(res.body.error, path).not.toBe('Forbidden');
        }
    });

    it('still refuses a write without an Origin, before any SQL', async () => {
        const pool = recordingPool();
        const server = app(pool);
        // The publish routes write (the index) or spend our pinning quota: none is a read.
        for (const path of ['/designs', '/agreements', '/pins']) {
            const res = await request(server).post(path).send({ cid: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq', content: {} });
            expect(res.status, path).toBe(403);
            expect(res.body, path).toEqual({ error: 'Forbidden' });
        }
        expect(pool.calls).toHaveLength(0);
    });
});

// M2 (plan-design-agreement.md) removed every write into the proposal table and the slug-named plans: the
// routes are not registered at all, so each answers the app's 404, even with an allowed Origin. Plans
// came back as immutable CID-addressed plan/v1 records (7e9803af8, routes/plans.js; named-plans.test.js).
describe('removed publication routes', () => {
    it.each([
        ['post', '/proposals'], ['post', '/proposals/mirror'], ['post', '/proposals/prepare'], ['post', '/proposals/binding'],
        ['post', '/agent/proposals'], ['post', '/agent/binding'], ['post', '/agent/prepare'],
        ['patch', '/proposals/41/screenshot'], ['patch', '/proposals/41/epoch'], ['patch', '/proposals/epochs'], ['patch', '/proposals/41/name'],
        ['get', '/proposals/41/binding-drift'], ['get', '/proposals/41/owner-decisions'], ['post', '/proposals/41/owner-decisions'],
        ['post', '/proposals/41/owner-decisions/bundle'],
        ['post', '/walrus/upload'], ['post', '/reparcellization/validate']
    ])('%s %s is gone', async (method, path) => {
        const pool = recordingPool();
        const res = await request(app(pool))[method](path).set('Origin', 'http://localhost:5173').send({});
        expect(res.status).toBe(404);
        expect(pool.calls).toHaveLength(0);
    });

    it('refuses an old slug-named plan as an invalid plan link before querying', async () => {
        const pool = recordingPool();
        const res = await request(app(pool)).get('/plans/borovje').set('Origin', 'http://localhost:5173');
        expect(res.status).toBe(400);
        expect(pool.calls).toHaveLength(0);
    });

    it('lists the design reads, and no write, among the read-only POSTs', () => {
        expect(READ_ONLY_POST_PATHS).toContain('/designs/batch');
        expect(READ_ONLY_POST_PATHS).toContain('/designs/binding');
        for (const write of ['/designs', '/agreements', '/pins', '/proposals', '/proposals/binding']) expect(READ_ONLY_POST_PATHS.has(write), write).toBe(false);
    });
});

describe('removed routes', () => {
    // The Canton routes were deleted in M3 (plan-design-agreement.md): no flag brings them back.
    it('serves no /canton/* route, whatever CANTON_ENABLED says', async () => {
        const server = app(recordingPool(), { CANTON_ENABLED: 'true' });
        expect((await request(server).get('/canton/ledger-end')).status).toBe(404);
        expect((await request(server).get('/canton/proposals')).status).toBe(404);
    });
});

describe('POST /agreements/:cid/onchain through the real app', () => {
    const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
    const body = { chain: 'solana', cluster: 'devnet', account: '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj' };

    it('is a write: refused without an allowed Origin before the route runs', async () => {
        const pool = recordingPool();
        const res = await request(app(pool, { NODE_ENV: 'production' })).post(`/agreements/${CID}/onchain`).send(body);
        expect(res.status).toBe(403);
        expect(pool.calls).toHaveLength(0);
    });

    it('reaches the route with an allowed Origin, which reads the index (an unknown agreement is 404)', async () => {
        const pool = recordingPool();
        const res = await request(app(pool)).post(`/agreements/${CID}/onchain`).set('Origin', 'https://urbangametheory.xyz').send(body);
        expect([res.status, res.body.code]).toEqual([404, 'agreement-not-found']);
        expect(pool.calls.map(call => call.params)).toEqual([[CID]]);
    });
});
