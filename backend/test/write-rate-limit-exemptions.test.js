// The write rate limiter must not count read-only endpoints that happen to use POST.
//
// Two endpoints take a POST purely because their input is too big for a query string: /buildings/near
// and /parcels/under. Both are reads. /parcels/under was being counted as a write, and the shape of
// that mistake was ugly: a fabric replay asks it once per applied formation, so a plan of twenty
// roads spends twenty of the fifty-per-fifteen-minutes budget every time a road is finished. Four
// finishes exhausted it; after that the ground fetches 429'd, the fabric was not loaded, and the
// coverage gate refused members with "could not re-apply and were set aside" — intermittently, on a
// rolling window that healed itself, which is exactly how it was reported.
//
// So this drives the REAL middleware stack past the limit rather than reading the allowlist, and
// checks a genuine write is still limited — an exemption that leaked to every POST would be worse
// than the bug.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, WRITE_RATE_LIMIT } from '../index.js';

const WRITE_LIMIT = WRITE_RATE_LIMIT;   // read, never restated

// A pool that answers everything with nothing: this test is about the middleware in front of the
// routes, not about what they return.
const stubPool = {
    query: async () => ({ rows: [] }),
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => { } }),
    on: () => { },
    end: async () => { }
};

function app() {
    // createApp hands back { app, pool }; supertest wants the express app itself.
    return createApp({ env: { ...process.env, NODE_ENV: 'test' }, pool: stubPool }).app;
}

// An origin check sits IN FRONT of the limiter and 403s any POST without one, so a request that
// forgets the header never reaches the thing under test — and an assertion of "no 429" would then
// pass on a wall of 403s. Every request here carries an allowed origin, and every test asserts the
// requests were actually served.
async function hammer(server, path, body, times) {
    const codes = [];
    for (let i = 0; i < times; i += 1) {
        const res = await request(server).post(path).send(body).set('Origin', 'http://localhost:5583');
        codes.push(res.status);
    }
    return codes;
}

const served = codes => codes.filter(code => code !== 403 && code !== 429).length;

describe('read-only POSTs are not rationed as writes', () => {
    it('serves /parcels/under well past the write budget', async () => {
        const geometry = { type: 'Polygon', coordinates: [[[15.9, 43.73], [15.91, 43.73], [15.91, 43.74], [15.9, 43.73]]] };
        const codes = await hammer(app(), '/parcels/under', { geometry }, WRITE_LIMIT + 10);
        expect(codes).not.toContain(403);
        expect(codes).not.toContain(429);
        expect(served(codes)).toBe(WRITE_LIMIT + 10);
    }, 30000);

    it('serves /buildings/near past it too, as it always did', async () => {
        const codes = await hammer(app(), '/buildings/near', { lat: 43.73, lng: 15.9, radius: 100 }, WRITE_LIMIT + 5);
        expect(codes).not.toContain(429);
        expect(served(codes)).toBe(WRITE_LIMIT + 5);
    }, 30000);
});

describe('genuine writes are still rationed', () => {
    it('starts refusing an actual write endpoint once the budget is spent', async () => {
        const codes = await hammer(app(), '/proposals', { title: 'x' }, WRITE_LIMIT + 5);
        expect(codes).toContain(429);
        // The first fifty got through: the limiter rations, it does not simply block.
        expect(codes.slice(0, WRITE_LIMIT)).not.toContain(429);
    }, 30000);
});
