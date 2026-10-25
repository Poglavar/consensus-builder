// Validate the event ingest and aggregate route contracts without a live database.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { setupBetsEventsRoute, validateBetEvents } from '../routes/bets-events.js';

const VISITOR = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const SIMULATION = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const OCCURRED = '2026-10-24T22:15:30.123+04:00';

function event(overrides = {}) {
    return {
        id: EVENT, visitorId: VISITOR, sessionId: SESSION, actorMode: 'visitor',
        occurredAt: OCCURRED, name: 'action_status', action: 'stake', side: 'yes',
        result: 'confirmed', asset: 'devnet-usdc', entryPoint: 'bets-sheet',
        agreementAccount: ACCOUNT, agreementCid: 'bafybeigdyrzt5sfp7udm7hu76uh6y26nfujvy2m4h74bs2v7t3cw5z5v6i',
        city: 'london', ...overrides
    };
}

function appFor({ insertRows = [{ id: EVENT }], metricsRow = { visitors: 4, sessions: 6, return_visitors: 2, event_counts: { entry: 4, stake: 2 } }, rateLimiter = (_req, _res, next) => next() } = {}) {
    const queries = [];
    const client = {
        query: vi.fn(async (sql, params) => {
            queries.push({ sql: String(sql), params });
            if (String(sql).includes('INSERT INTO consensus.bet_event')) return { rows: insertRows };
            if (String(sql).includes('WITH scoped AS')) return { rows: [metricsRow] };
            return { rows: [] };
        }),
        release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client), query: client.query };
    const app = express();
    app.use(express.json());
    setupBetsEventsRoute(app, pool, { rateLimiter, now: () => new Date('2026-10-25T00:00:00.000Z') });
    return { app, pool, client, queries };
}

describe('POST /bets/events', () => {
    it('validates and atomically stores an allowlisted event with the caller observation time', async () => {
        const { app, client, queries } = appFor();
        const response = await request(app).post('/bets/events').send({ events: [event()] });

        expect(response.status).toBe(202);
        expect(response.body).toEqual({ accepted: 1 });
        expect(queries.map(query => query.sql.trim())).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
        const insert = queries.find(query => query.sql.includes('INSERT INTO consensus.bet_event'));
        const stored = JSON.parse(insert.params[0])[0];
        expect(stored).toMatchObject({ occurred_at: OCCURRED, actor_mode: 'visitor', name: 'action_status', action: 'stake' });
        expect(Object.keys(stored).sort()).toEqual([
            'action', 'actor_mode', 'agreement_account', 'agreement_cid', 'asset', 'city', 'entry_point',
            'error_code', 'id', 'name', 'occurred_at', 'result', 'session_id', 'side', 'simulation_run', 'visitor_id'
        ].sort());
        expect(client.release).toHaveBeenCalledOnce();
    });

    it('accepts explicitly labelled simulated events only with a simulation run slug', async () => {
        const simulated = event({ id: SIMULATION, actorMode: 'simulated', simulationRun: 'journey-42' });
        expect(validateBetEvents({ events: [simulated] }).error).toBeUndefined();
        expect(validateBetEvents({ events: [event({ actorMode: 'simulated' })] }).error).toMatch(/simulationRun/);
        expect(validateBetEvents({ events: [simulated, event({ id: '55555555-5555-4555-8555-555555555555' })] }).error).toBeUndefined();
    });

    it('makes identical retries idempotent with event-id conflict equality checks', async () => {
        const { app, queries } = appFor({ insertRows: [{ id: EVENT }] });
        const response = await request(app).post('/bets/events').send({ events: [event()] });
        expect(response.status).toBe(202);
        expect(response.body.accepted).toBe(1);
        const insert = queries.find(query => query.sql.includes('INSERT INTO consensus.bet_event'));
        expect(insert.sql).toContain('ON CONFLICT (id) DO UPDATE SET id = existing.id');
        expect(insert.sql).toContain('existing.occurred_at = EXCLUDED.occurred_at');
        expect(insert.sql).toContain('existing.result IS NOT DISTINCT FROM EXCLUDED.result');
    });

    it.each([
        ['unknown fields', event({ walletAddress: ACCOUNT })],
        ['arbitrary event names', event({ name: 'raw-url:https://example.test' })],
        ['invalid UUIDs', event({ visitorId: 'visitor-1' })],
        ['invalid account addresses', event({ agreementAccount: 'wallet address' })],
        ['invalid timestamps', event({ occurredAt: 'yesterday' })],
        ['invalid action results', event({ result: 'wallet-signature-text' })],
        ['invalid entry point', event({ entryPoint: '../private/path' })]
    ])('rejects %s without storing', async (_label, invalid) => {
        const { app, client } = appFor();
        const response = await request(app).post('/bets/events').send({ events: [invalid] });
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_events');
        expect(client.query).not.toHaveBeenCalled();
    });

    it('enforces the 1–20 batch bound and rejects repeated event ids in one batch', () => {
        expect(validateBetEvents({ events: [] }).error).toMatch(/1–20/);
        expect(validateBetEvents({ events: Array.from({ length: 21 }, (_, i) => event({ id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}` })) }).error).toMatch(/1–20/);
        expect(validateBetEvents({ events: [event(), event()] }).error).toMatch(/unique/);
    });

    it('rejects conflicting reuse of an event id without partial commit', async () => {
        const { app, queries } = appFor({ insertRows: [] });
        const response = await request(app).post('/bets/events').send({ events: [event()] });
        expect(response.status).toBe(409);
        expect(response.body.error).toBe('event_id_conflict');
        expect(queries.map(query => query.sql.trim())).toContain('ROLLBACK');
    });
});

describe('GET /bets/metrics', () => {
    it('defaults to visitor metrics, scopes by server receipt time and returns aggregates only', async () => {
        const { app, queries } = appFor();
        const response = await request(app).get('/bets/metrics');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            label: 'Anonymous browser activity', mode: 'visitor',
            window: { since: '2026-09-25T00:00:00.000Z', basis: 'server received_at' },
            visitors: 4, sessions: 6, returnVisitors: 2, eventCounts: { entry: 4, stake: 2 }, funnel: []
        });
        expect(queries[0].sql).toContain('actor_mode = $1 AND received_at >= $2::timestamptz');
        expect(queries[0].params).toEqual(['visitor', '2026-09-25T00:00:00.000Z']);
        expect(JSON.stringify(response.body)).not.toContain(VISITOR);
        expect(JSON.stringify(response.body)).not.toContain(SESSION);
    });

    it('supports the separate simulated mode and a caller since window', async () => {
        const { app, queries } = appFor();
        const response = await request(app).get('/bets/metrics?mode=simulated&since=2026-10-01');
        expect(response.status).toBe(200);
        expect(response.body.mode).toBe('simulated');
        expect(response.body.window).toEqual({ since: '2026-10-01T00:00:00.000Z', basis: 'server received_at' });
        expect(queries[0].params[0]).toBe('simulated');
    });

    it.each(['/bets/metrics?mode=all', '/bets/metrics?since=not-a-date'])('rejects invalid metric filters: %s', async path => {
        const { app, pool } = appFor();
        const response = await request(app).get(path);
        expect(response.status).toBe(400);
        expect(pool.query).not.toHaveBeenCalled();
    });
});
