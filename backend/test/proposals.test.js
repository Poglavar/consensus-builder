import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';
import {
    validProposalBody,
    insertResult,
    updateResult,
    proposalDbRow,
    summaryDbRow,
} from './helpers/fixtures.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createTestApp(pool);
});

describe('POST /proposals', () => {
    it('creates a proposal and returns 201', async () => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app)
            .post('/proposals')
            .send(validProposalBody());

        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty('id', 1);
        expect(res.body).toHaveProperty('proposalId', 'test-proposal-001');
        expect(res.body).toHaveProperty('createdAt');

        const calls = pool.getCalls();
        expect(calls).toHaveLength(2);
        expect(calls[0].sql).toContain('INSERT INTO proposal');
        expect(calls[1].sql).toContain('UPDATE proposal');
    });

    it('returns 500 when proposal body causes a DB error', async () => {
        pool.setResults([]);
        pool.query = async () => {
            throw new Error('connection refused');
        };

        const res = await request(app)
            .post('/proposals')
            .send(validProposalBody());

        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Internal server error/);
    });

    it('returns 409 on duplicate proposal_id', async () => {
        const uniqueViolation = new Error('unique violation');
        uniqueViolation.code = '23505';
        uniqueViolation.detail = '(proposal_id)=(test-proposal-001)';

        pool.setResults([]);
        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('INSERT INTO proposal')) {
                throw uniqueViolation;
            }
            return { rows: [{ id: 99, proposal_id: 'test-proposal-001' }] };
        };

        const res = await request(app)
            .post('/proposals')
            .send(validProposalBody());

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already exists/);
        expect(res.body).toHaveProperty('id', 99);
        expect(res.body).toHaveProperty('proposalId', 'test-proposal-001');
    });

    it('normalizes city codes', async () => {
        const cases = [
            ['zg', 'zagreb'],
            ['zgb', 'zagreb'],
            ['bg', 'belgrade'],
            ['ba', 'buenos_aires'],
            ['caba', 'buenos_aires'],
            ['ar-ba', 'buenos_aires'],
        ];

        for (const [input, expected] of cases) {
            pool.reset();
            pool.setResults([insertResult(), updateResult()]);

            await request(app)
                .post('/proposals')
                .send(validProposalBody({ city: input }));

            const insertParams = pool.getCalls()[0].params;
            // city is the 2nd param ($2) in the INSERT
            expect(insertParams[1]).toBe(expected);
        }
    });

    it('resolves proposalId from alternate field names', async () => {
        pool.setResults([
            insertResult({ proposal_id: 'from-id-field' }),
            updateResult(),
        ]);

        await request(app)
            .post('/proposals')
            .send({ id: 'from-id-field', type: 'parcel' });

        const insertParams = pool.getCalls()[0].params;
        // proposalId is the 1st param ($1)
        expect(insertParams[0]).toBe('from-id-field');
    });
});

describe('GET /proposals/:id', () => {
    it('returns a proposal when found', async () => {
        const row = proposalDbRow();
        pool.setResult({ rows: [row], rowCount: 1 });

        const res = await request(app).get('/proposals/test-proposal-001');

        expect(res.status).toBe(200);
        // Column values override proposal_data
        expect(res.body.name).toBe('Test Proposal');
        expect(res.body.city).toBe('zagreb');
        expect(res.body.offer).toBe(1.5);
        // proposal_data extra fields are preserved
        expect(res.body.extra).toBe('field');
        // id and proposalId come from columns
        expect(res.body.id).toBe(1);
        expect(res.body.proposalId).toBe('test-proposal-001');
    });

    it('returns 404 when not found', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/proposals/nonexistent');

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });
});

describe('HEAD /proposals/:id', () => {
    it('returns metadata headers when found', async () => {
        const updated = new Date('2026-01-20T10:00:00Z');
        pool.setResult({
            rows: [{ id: 5, proposal_id: 'hdr-test', updated_at: updated, created_at: updated }],
        });

        const res = await request(app).head('/proposals/hdr-test');

        expect(res.status).toBe(200);
        expect(res.headers['x-proposal-id']).toBe('5');
        expect(res.headers['x-proposal-proposalid']).toBe('hdr-test');
        expect(res.headers['last-modified']).toBeDefined();
        expect(res.headers['etag']).toContain('hdr-test');
    });

    it('returns 404 when not found', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).head('/proposals/nope');

        expect(res.status).toBe(404);
    });
});

describe('GET /proposals/count', () => {
    it('returns count with filters', async () => {
        pool.setResult({ rows: [{ count: '42' }] });

        const res = await request(app)
            .get('/proposals/count?city=zg&status=applied');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(42);
        expect(res.body.city).toBe('zagreb');
        expect(res.body.status).toBe('applied');

        const call = pool.getCalls()[0];
        expect(call.sql).toContain('COUNT(*)');
        expect(call.params).toContain('zagreb');
        expect(call.params).toContain('applied');
    });

    it('returns count with no filters', async () => {
        pool.setResult({ rows: [{ count: '100' }] });

        const res = await request(app).get('/proposals/count');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(100);
        expect(pool.getCalls()[0].params).toHaveLength(0);
    });
});

describe('GET /proposals/summary', () => {
    it('returns paginated proposals', async () => {
        pool.setResult({
            rows: [
                summaryDbRow({ id: 1, proposal_id: 'p-1' }),
                summaryDbRow({ id: 2, proposal_id: 'p-2' }),
            ],
        });

        const res = await request(app)
            .get('/proposals/summary?limit=5&offset=10');

        expect(res.status).toBe(200);
        expect(res.body.proposals).toHaveLength(2);
        expect(res.body.limit).toBe(5);
        expect(res.body.offset).toBe(10);
        expect(res.body.count).toBe(3); // from total_count window function

        const call = pool.getCalls()[0];
        expect(call.params).toContain(5);
        expect(call.params).toContain(10);
    });
});

describe('GET /proposals?parcel_id=', () => {
    it('finds proposals by parcel containment', async () => {
        const row = proposalDbRow();
        pool.setResult({ rows: [row] });

        const res = await request(app)
            .get('/proposals?parcel_id=HR-1234-5678');

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('parcelId', 'HR-1234-5678');
        expect(res.body.proposals).toHaveLength(1);

        const call = pool.getCalls()[0];
        expect(call.sql).toContain('ancestor_parcel_ids @>');
        expect(call.sql).toContain('descendant_parcel_ids @>');
        expect(call.params).toContain(JSON.stringify(['HR-1234-5678']));
    });

    it('returns 400 when parcel_id is missing', async () => {
        const res = await request(app).get('/proposals');

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/parcel_id.*required/i);
    });
});
