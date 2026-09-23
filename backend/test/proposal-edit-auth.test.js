// Security contract of the proposal API (audit 2026-09): edit tokens on every PATCH, unprovable
// client claims dropped on the free upload, deterministic single-row addressing (row id first), and
// capped list limits. Route-level, against a mock pool; the id-collision tests use a tiny
// table-backed fake that applies the WHERE/ORDER BY/LIMIT the route sends, so a query without an
// explicit precedence returns whatever row the "heap" holds first — exactly the prod bug.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';
import { validProposalBody, insertResult, updateResult, proposalDbRow, summaryDbRow } from './helpers/fixtures.js';
import { hashEditToken, MAX_SUMMARY_LIMIT, MAX_PARCEL_PROPOSALS_LIMIT } from '../routes/proposals.js';

vi.mock('../thumbnails/proposal-thumbnail.js', () => ({
    generateAndStoreProposalThumbnail: vi.fn(async () => null)
}));

const TOKEN = 'the-uploaders-token';
const HASH = hashEditToken(TOKEN);
const HEADER = 'X-Proposal-Edit-Token';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createTestApp(pool);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const updates = () => pool.getCalls().filter(call => /^\s*UPDATE proposal/.test(call.sql));

describe('POST /proposals issues an edit token', () => {
    it('returns a random token once and stores only its sha256', async () => {
        pool.setResults([insertResult(), updateResult(), insertResult(), updateResult()]);

        const first = await request(app).post('/proposals').send(validProposalBody());
        const second = await request(app).post('/proposals').send(validProposalBody({ proposalId: 'another' }));

        expect(first.status).toBe(201);
        expect(first.body.editToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
        expect(second.body.editToken).not.toBe(first.body.editToken);

        const insert = pool.getCalls()[0];
        expect(insert.sql).toContain('edit_token_hash');
        expect(insert.params[38]).toBe(hashEditToken(first.body.editToken));
        // The token itself is never written anywhere.
        expect(JSON.stringify(insert.params)).not.toContain(first.body.editToken);
    });
});

describe('POST /proposals drops claims the free route cannot prove', () => {
    const forgedAgent = {
        persona: 'densifier-01',
        wallet: 'AgentWallet111111111111111111111111111111111',
        paid: { id: 'x', amount: '0.05', tx: 'ForgedSettlementSignature' }
    };

    it('ignores a client-supplied paid-agent stamp', async () => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app).post('/proposals').send(validProposalBody({ agent: forgedAgent }));

        expect(res.status).toBe(201);
        const params = pool.getCalls()[0].params;
        expect(JSON.parse(params[32])).not.toHaveProperty('agent');
        expect(params[36]).toBeNull(); // agent_payment_id — only the x402 route sets it
    });

    it('stamps the server clock as created_at; the client value is kept only as authoredAt', async () => {
        pool.setResults([insertResult(), updateResult()]);
        const before = Date.now();

        const res = await request(app).post('/proposals').send(validProposalBody({ createdAt: '2001-01-01T00:00:00.000Z' }));

        expect(res.status).toBe(201);
        const params = pool.getCalls()[0].params;
        const createdAt = params[12];
        expect(createdAt).toBeInstanceOf(Date);
        expect(createdAt.getTime()).toBeGreaterThanOrEqual(before);
        const stored = JSON.parse(params[32]);
        expect(stored.createdAt).toBe(createdAt.toISOString());
        expect(stored.authoredAt).toBe('2001-01-01T00:00:00.000Z');
    });

    it('does not keep a future "authored" time', async () => {
        pool.setResults([insertResult(), updateResult()]);

        await request(app).post('/proposals').send(validProposalBody({ createdAt: '2999-01-01T00:00:00.000Z', authoredAt: 'x' }));

        expect(JSON.parse(pool.getCalls()[0].params[32])).not.toHaveProperty('authoredAt');
    });

    it('resets an Executed lifecycle to Active and drops owner acceptances', async () => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app).post('/proposals').send(validProposalBody({
            lifecycleStatus: 'Executed',
            executedAt: '2026-09-01T00:00:00.000Z',
            acceptedParcelIds: ['HR-1234-5678', 'HR-1234-5679'],
            ownerAcceptances: { 'HR-1234-5678': { accepted: true } }
        }));

        expect(res.status).toBe(201);
        const params = pool.getCalls()[0].params;
        expect(params[7]).toBe('Active');
        expect(params[22]).toBeNull();
        expect(params[23]).toBeNull();
        const stored = JSON.parse(params[32]);
        expect(stored.lifecycleStatus).toBe('Active');
        expect(stored).not.toHaveProperty('executedAt');
        expect(stored).not.toHaveProperty('acceptedParcelIds');
        expect(stored).not.toHaveProperty('ownerAcceptances');
    });

    it('keeps author-controlled lifecycle states and the on-chain pointer', async () => {
        pool.setResults([insertResult(), updateResult()]);
        const onchain = { proposalId: 'ProposalPda111', chainId: 'solana-devnet', transactionHash: 'sig' };

        await request(app).post('/proposals').send(validProposalBody({ lifecycleStatus: 'Cancelled', onchain }));

        const params = pool.getCalls()[0].params;
        expect(params[7]).toBe('Cancelled');
        expect(JSON.parse(params[30])).toEqual(onchain);
    });
});

describe('PATCH routes require the edit token', () => {
    const routes = [
        ['name', '/proposals/7/name', { name: 'New name' }],
        ['screenshot', '/proposals/7/screenshot', { screenshotUrl: 'https://evil.example/x.png' }],
        ['epoch', '/proposals/7/epoch', { epochYear: 2045 }]
    ];

    it.each(routes)('%s: no token → 403 without touching the database', async (_label, path, body) => {
        const res = await request(app).patch(path).send(body);

        expect(res.status).toBe(403);
        expect(pool.getCalls()).toHaveLength(0);
    });

    it.each(routes)('%s: wrong token → 403 and nothing is updated', async (_label, path, body) => {
        pool.setResults([{ rows: [{ id: 7, edit_token_hash: HASH }], rowCount: 1 }]);

        const res = await request(app).patch(path).set(HEADER, 'not-the-token').send(body);

        expect(res.status).toBe(403);
        expect(updates()).toHaveLength(0);
    });

    it.each(routes)('%s: legacy row without a token hash → 403, whatever token is sent', async (_label, path, body) => {
        pool.setResults([{ rows: [{ id: 7, edit_token_hash: null }], rowCount: 1 }]);

        const res = await request(app).patch(path).set(HEADER, TOKEN).send(body);

        expect(res.status).toBe(403);
        expect(updates()).toHaveLength(0);
    });

    it.each(routes)('%s: right token → 200, written to that one row by primary key', async (_label, path, body) => {
        pool.setResults([
            { rows: [{ id: 7, edit_token_hash: HASH }], rowCount: 1 },
            { rows: [{ id: 7, proposal_id: 'c2-abc', name: 'New name', title: 'New name', screenshot_url: 'u', epoch_year: 2045 }], rowCount: 1 }
        ]);

        const res = await request(app).patch(path).set(HEADER, TOKEN).send(body);

        expect(res.status).toBe(200);
        expect(updates()).toHaveLength(1);
        expect(updates()[0].sql).toContain('WHERE id = $2 AND edit_token_hash = $3');
        expect(updates()[0].params.slice(1)).toEqual([7, HASH]);
    });
});

describe('PATCH /proposals/epochs writes only entries with a matching token', () => {
    it('updates the authorized rows and names the forbidden and missing ones', async () => {
        pool.setResults([
            {
                rows: [
                    { id: 1, proposal_id: 'c2-mine', edit_token_hash: HASH },
                    { id: 2, proposal_id: 'c2-theirs', edit_token_hash: hashEditToken('someone-else') },
                    { id: 3, proposal_id: 'c2-legacy', edit_token_hash: null }
                ],
                rowCount: 3
            },
            { rows: [{ id: 1, proposal_id: 'c2-mine', epoch_year: 2045 }], rowCount: 1 }
        ]);

        const res = await request(app).patch('/proposals/epochs').send({
            epochs: [
                { id: '1', epochYear: 2045, editToken: TOKEN },
                { id: 'c2-theirs', epochYear: 2055, editToken: TOKEN },
                { id: '3', epochYear: 2035 },
                { id: 'nope', epochYear: 2035, editToken: TOKEN }
            ]
        });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ requested: 4, updated: 1, missing: ['nope'], forbidden: ['c2-theirs', '3'] });
        const write = updates()[0];
        expect(write.params).toEqual([[1], [2045], [HASH]]);
        expect(write.sql).toContain('WHERE p.id = v.id AND p.edit_token_hash = v.token_hash');
    });

    it('answers 403 and writes nothing when no entry is authorized', async () => {
        pool.setResults([{ rows: [{ id: 2, proposal_id: 'c2-theirs', edit_token_hash: HASH }], rowCount: 1 }]);

        const res = await request(app).patch('/proposals/epochs').send({ epochs: [{ id: '2', epochYear: 2045 }] });

        expect(res.status).toBe(403);
        expect(res.body.forbidden).toEqual(['2']);
        expect(updates()).toHaveLength(0);
    });
});

// prod: row 45 carries the legacy proposal_id "51"; row 51 is a different proposal, which the list
// labels "#51" and whose share link is /proposals/51.
describe('an id that is both a row id and another row\'s proposal_id', () => {
    const row45 = proposalDbRow({ id: 45, proposal_id: '51', name: 'Row 45', edit_token_hash: hashEditToken('token-45') });
    const row51 = proposalDbRow({ id: 51, proposal_id: 'c2-row51', name: 'Row 51', edit_token_hash: hashEditToken('token-51') });

    function tablePool(table) {
        const calls = [];
        return {
            calls,
            getCalls: () => calls,
            async query(sql, params) {
                calls.push({ sql, params });
                const key = String(params[0]);
                if (/^\s*UPDATE proposal/.test(sql)) {
                    const target = table.find(row => row.id === params[1] && row.edit_token_hash === params[2]);
                    return { rows: target ? [{ ...target, name: params[0], title: params[0] }] : [], rowCount: target ? 1 : 0 };
                }
                let rows = table.filter(row => row.proposal_id === key || String(row.id) === key);
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
        expect(res.headers['x-proposal-id']).toBe('51');
    });

    it('the legacy row stays reachable by its own row id and by a non-colliding proposal_id', async () => {
        const tableApp = createTestApp(tablePool([row51, row45]));

        expect((await request(tableApp).get('/proposals/45')).body).toMatchObject({ id: 45 });
        expect((await request(tableApp).get('/proposals/c2-row51')).body).toMatchObject({ id: 51 });
    });

    it('PATCH /proposals/51/name authorizes against row 51 and can only ever write that row', async () => {
        const table = [row45, row51];
        const tableApp = createTestApp(tablePool(table));

        const wrongRowToken = await request(tableApp).patch('/proposals/51/name').set(HEADER, 'token-45').send({ name: 'Hijack' });
        expect(wrongRowToken.status).toBe(403);

        const ok = await request(tableApp).patch('/proposals/51/name').set(HEADER, 'token-51').send({ name: 'Renamed' });
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ id: 51, name: 'Renamed' });
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
