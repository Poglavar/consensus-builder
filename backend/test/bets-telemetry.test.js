// Browser funnel delivery: acknowledged persistence, retry identity and test/visitor separation.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { validateBetEvents } from '../routes/bets-events.js';
const require = createRequire(import.meta.url);
const { create, errorResult } = require('../../frontend/js/bets/bets-telemetry.js');
const storage = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }; };
const saved = body => ({ ok: true, json: async () => ({ accepted: JSON.parse(body).events.length }) });

describe('betting journey delivery', () => {
    it('keeps unknown confirmation separate from rejection and confirmed failure', () => {
        expect(errorResult({ code: 'CONFIRMATION_UNKNOWN' })).toBe('unknown');
        expect(errorResult({ code: 'CONFIRMATION_FAILED' })).toBe('failed');
        expect(errorResult({ code: 4001 })).toBe('cancelled');
        expect(errorResult({ code: 'USER_REJECTED' })).toBe('cancelled');
    });
    it('sends only allowed fields with source time and a stable browser/session identity', async () => {
        const batches = [];
        const client = create({ storage: storage(), sessionStorage: storage(), uuid: randomUUID,
            fetch: async (url, options) => { batches.push({ url, ...options }); return saved(options.body); },
            baseUrl: () => 'https://api.example.test/', now: () => new Date('2026-10-25T12:00:00Z') });
        client.track('market_open', { entryPoint: 'dialog', wallet: 'private-wallet', fullUrl: 'private-url' });
        client.track('entry', { entryPoint: 'sheet' }); // returning to a sheet is not a new page entry
        await client.flush();
        const events = batches.flatMap(batch => JSON.parse(batch.body).events);
        expect(events.map(event => event.name)).toEqual(['entry', 'market_open']);
        expect(new Set(events.map(event => event.visitorId)).size).toBe(1);
        expect(events[1]).toMatchObject({ actorMode: 'visitor', occurredAt: '2026-10-25T12:00:00.000Z' });
        expect(events[1]).not.toHaveProperty('wallet');
        expect(events[1]).not.toHaveProperty('fullUrl');
        expect(batches.every(batch => batch.url === 'https://api.example.test/bets/events')).toBe(true);
        for (const batch of batches) expect(validateBetEvents(JSON.parse(batch.body)).error).toBeUndefined();
        expect(client.pendingCount()).toBe(0);
    });

    it('retains a failed request and retries the exact event IDs, even after reload', async () => {
        const local = storage(), session = storage(), attempts = [];
        const options = { storage: local, sessionStorage: session, uuid: randomUUID, baseUrl: () => '',
            fetch: async (_url, request) => { attempts.push(JSON.parse(request.body).events); return { ok: false, status: 503 }; } };
        const first = create(options);
        first.track('quote', { side: 'yes', asset: 'points' });
        await first.flush();
        expect(first.pendingCount()).toBe(2);
        const reloaded = create({ ...options, fetch: async (_url, request) => { attempts.push(JSON.parse(request.body).events); return saved(request.body); } });
        await reloaded.flush();
        expect(attempts.at(-1)[0]).toEqual(attempts[0][0]);
        expect(reloaded.pendingCount()).toBe(0);
    });

    it('does not discard events after an incomplete persistence acknowledgement', async () => {
        const client = create({ storage: storage(), sessionStorage: storage(), uuid: randomUUID, baseUrl: () => '',
            fetch: async () => ({ ok: true, json: async () => ({ accepted: 0 }) }) });
        client.track('close'); await client.flush();
        expect(client.pendingCount()).toBe(2);
    });

    it('keeps each simulated persona separate from ordinary visitor IDs and sessions', async () => {
        const local = storage(), session = storage(), events = [];
        const options = { storage: local, sessionStorage: session, uuid: randomUUID, baseUrl: () => '',
            fetch: async (_url, request) => { events.push(...JSON.parse(request.body).events); return saved(request.body); } };
        for (const simulationRun of [null, 'curious-resident', 'returning-bettor']) {
            const client = create({ ...options, simulationRun });
            client.track('entry'); await client.flush();
        }
        expect(events.map(event => event.actorMode)).toEqual(['visitor', 'simulated', 'simulated']);
        expect(new Set(events.map(event => event.visitorId)).size).toBe(3);
        expect(events[1].simulationRun).toBe('curious-resident');
        expect(validateBetEvents({ events }).error).toBeUndefined();
    });

    it('keeps the visitor across new sessions without treating a reload as another session', async () => {
        const local = storage(), session = storage(), events = [];
        const options = { storage: local, sessionStorage: session, uuid: randomUUID, baseUrl: () => '',
            fetch: async (_url, request) => { events.push(...JSON.parse(request.body).events); return saved(request.body); } };
        for (const sessionStorage of [session, session, storage()]) {
            const client = create({ ...options, sessionStorage }); client.track('entry'); await client.flush();
        }
        expect(new Set(events.map(event => event.visitorId)).size).toBe(1);
        expect(events[0].sessionId).toBe(events[1].sessionId);
        expect(events[2].sessionId).not.toBe(events[0].sessionId);
    });

    it('recognizes a return after 30 idle minutes in the same tab and preserves unsent prior events', async () => {
        let at = Date.parse('2026-10-25T12:00:00Z');
        const local = storage(), session = storage(), events = [];
        const options = { storage: local, sessionStorage: session, uuid: randomUUID, baseUrl: () => '', now: () => new Date(at) };
        const first = create({ ...options, fetch: async () => ({ ok: false, status: 503 }) });
        first.track('market_open'); await first.flush();
        at += 30 * 60 * 1000;
        const returned = create({ ...options, fetch: async (_url, request) => { events.push(...JSON.parse(request.body).events); return saved(request.body); } });
        returned.track('market_open'); await returned.flush();
        const visits = events.filter(event => event.name === 'market_open');
        expect(visits).toHaveLength(2);
        expect(visits[1].visitorId).toBe(visits[0].visitorId);
        expect(visits[1].sessionId).not.toBe(visits[0].sessionId);
        expect(visits[0].occurredAt).toBe('2026-10-25T12:00:00.000Z');
        expect(returned.pendingCount()).toBe(0);
    });
});
