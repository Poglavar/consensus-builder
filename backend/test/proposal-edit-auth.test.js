// Security contract of the proposal API (audit 2026-09): disjoint row/authored identifier
// namespaces, the paid-agent stamp served only for paid rows, and capped list limits. The edit-token
// PATCH routes this file was named for went with the server's proposal writes (plan-design-agreement.md
// M2); the API is read-only. Route-level,
// against a mock pool; the id-collision tests use a tiny table-backed fake that applies the route's
// WHERE/LIMIT, including the ambiguous query this contract replaces, so crossing identifier
// namespaces fails the regression checks.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';
import { proposalDbRow, summaryDbRow } from './helpers/fixtures.js';
import { MAX_SUMMARY_LIMIT, MAX_PARCEL_PROPOSALS_LIMIT } from '../routes/proposals.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createTestApp(pool);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('an id that is both a row id and another row\'s proposal_id', () => {
    const row45 = proposalDbRow({ id: 45, proposal_id: '51', name: 'Row 45' });
    const row51 = proposalDbRow({ id: 51, proposal_id: 'c2-row51', name: 'Row 51' });

    function tablePool(table) {
        const calls = [];
        return {
            calls,
            getCalls: () => calls,
            async query(sql, params) {
                calls.push({ sql, params });
                const key = String(params[0]);
                let rows;
                if (/WHERE id::text = \$1 LIMIT 1/.test(sql)) {
                    rows = table.filter(row => String(row.id) === key);
                } else if (/WHERE proposal_id = \$1 LIMIT 1/.test(sql)) {
                    rows = table.filter(row => row.proposal_id === key);
                } else {
                    rows = table.filter(row => row.proposal_id === key || String(row.id) === key);
                }
                if (/ORDER BY \(id::text = \$1\) DESC/.test(sql)) {
                    rows = rows.slice().sort((a, b) => Number(String(b.id) === key) - Number(String(a.id) === key));
                }
                if (/LIMIT 1/.test(sql)) rows = rows.slice(0, 1);
                return { rows, rowCount: rows.length };
            }
        };
    }

    // Heap order puts the legacy row first, as it was on prod.
    it.each([[[row45, row51]], [[row51, row45]]])('GET /proposals/51 opens row 51 whatever the table order', async (table) => {
        const tableApp = createTestApp(tablePool(table));

        const res = await request(tableApp).get('/proposals/51');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: 51, name: 'Row 51' });
    });

    it('HEAD /proposals/51 describes row 51', async () => {
        const tableApp = createTestApp(tablePool([row45, row51]));

        const res = await request(tableApp).head('/proposals/51');

        expect(res.status).toBe(200);
        expect(res.headers['x-proposal-row-id']).toBe('51');
        expect(res.headers['x-proposal-authored-id']).toBe('c2-row51');
    });

    it('addresses rows by row ID and nonnumeric authored ID', async () => {
        const tableApp = createTestApp(tablePool([row51, row45]));

        expect((await request(tableApp).get('/proposals/45')).body).toMatchObject({ id: 45 });
        expect((await request(tableApp).get('/proposals/c2-row51')).body).toMatchObject({ id: 51 });
    });

    it('returns missing for numeric reads instead of finding an authored numeric alias', async () => {
        const backing = tablePool([row45]);
        const tableApp = createTestApp(backing);
        expect((await request(tableApp).get('/proposals/51')).status).toBe(404);
        expect((await request(tableApp).head('/proposals/51')).status).toBe(404);
        // Nothing writes a proposal any more: the rename route is gone.
        expect((await request(tableApp).patch('/proposals/45/name').send({ name: 'Renamed' })).status).toBe(404);
        expect(backing.calls.some(call => /^\s*UPDATE/.test(call.sql))).toBe(false);
    });
});

describe('the paid-agent stamp is served only for rows with a settled payment', () => {
    const agent = { persona: 'p', wallet: 'W', paid: { tx: 'T' } };

    it('GET /proposals/:id omits a stamp on a row without agent_payment_id', async () => {
        pool.setResult({ rows: [proposalDbRow({ agent_payment_id: null, proposal_data: { agent } })], rowCount: 1 });

        const res = await request(app).get('/proposals/1');

        expect(res.status).toBe(200);
        expect(res.body).not.toHaveProperty('agent');
        expect(pool.getCalls()[0].sql).toContain('agent_payment_id');
    });

    it('GET /proposals/:id keeps the stamp on a paid row', async () => {
        pool.setResult({ rows: [proposalDbRow({ agent_payment_id: 'pay-1', proposal_data: { agent } })], rowCount: 1 });

        const res = await request(app).get('/proposals/1');

        expect(res.body.agent).toEqual(agent);
    });
});

describe('list limits are capped', () => {
    it('/proposals/summary never asks the database for more than MAX_SUMMARY_LIMIT rows', async () => {
        pool.setResult({ rows: [summaryDbRow()] });

        const res = await request(app).get('/proposals/summary?limit=100000000');

        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(MAX_SUMMARY_LIMIT);
        expect(pool.getCalls()[0].params.at(-2)).toBe(MAX_SUMMARY_LIMIT);
    });

    it('/proposals?parcel_id never asks for more than MAX_PARCEL_PROPOSALS_LIMIT rows', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).get('/proposals?parcel_id=HR-1&limit=100000000');

        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(MAX_PARCEL_PROPOSALS_LIMIT);
        expect(pool.getCalls()[0].params.at(-2)).toBe(MAX_PARCEL_PROPOSALS_LIMIT);
    });
});
