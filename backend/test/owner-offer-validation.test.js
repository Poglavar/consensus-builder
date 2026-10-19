// Owner offers on the server: proposalRole is a closed enum ('owner-offer' or absent), stored on the
// record, served in /proposals/summary, and documented in the agent recipe schema.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';
import { proposalRoleValidator, PROPOSAL_ROLES } from '../routes/proposals.js';
import { validProposalBody, insertResult, updateResult, summaryDbRow } from './helpers/fixtures.js';

vi.mock('../thumbnails/proposal-thumbnail.js', () => ({
    generateAndStoreProposalThumbnail: vi.fn(async () => null)
}));

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createTestApp(pool);
});

function storedProposalData() {
    const insert = pool.getCalls().find(call => call.sql.includes('INSERT INTO proposal'));
    const json = insert.params.find(param => typeof param === 'string' && param.includes('"cadastreParcelIds"'));
    return JSON.parse(json);
}

describe('proposalRoleValidator', () => {
    it('accepts only owner-offer, and absent/null as an ordinary proposal', () => {
        expect(PROPOSAL_ROLES).toEqual(['owner-offer']);
        expect(proposalRoleValidator('owner-offer')).toEqual({ ok: true, value: 'owner-offer' });
        expect(proposalRoleValidator(undefined)).toEqual({ ok: true, value: null });
        expect(proposalRoleValidator(null)).toEqual({ ok: true, value: null });
        for (const bad of ['owner', 'Owner-Offer', ' owner-offer', '', 'proposer', 1, true, ['owner-offer'], { role: 'owner-offer' }]) {
            const result = proposalRoleValidator(bad);
            expect(result.ok).toBe(false);
            expect(result.error).toMatch(/proposalRole must be one of: owner-offer/);
        }
    });
});

describe('POST /proposals with proposalRole', () => {
    it('stores owner-offer on the record', async () => {
        pool.setResults([insertResult(), updateResult()]);
        const res = await request(app).post('/proposals').send(validProposalBody({ proposalRole: 'owner-offer' }));
        expect(res.status).toBe(201);
        expect(storedProposalData().proposalRole).toBe('owner-offer');
    });

    it('keeps an ordinary proposal free of a role', async () => {
        pool.setResults([insertResult(), updateResult()]);
        const res = await request(app).post('/proposals').send(validProposalBody());
        expect(res.status).toBe(201);
        expect(storedProposalData()).not.toHaveProperty('proposalRole');
    });

    it.each(['bid', 'OWNER-OFFER', 42])('refuses proposalRole %p with 400 before touching the database', async role => {
        const res = await request(app).post('/proposals').send(validProposalBody({ proposalRole: role }));
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/proposalRole/);
        expect(pool.getCalls()).toHaveLength(0);
    });
});

describe('GET /proposals/summary proposalRole', () => {
    it('serves a known role and nulls anything else', async () => {
        pool.setResult({ rows: [
            summaryDbRow({ id: 1, proposal_id: 'p-1', proposal_role: 'owner-offer' }),
            summaryDbRow({ id: 2, proposal_id: 'p-2' }),
            summaryDbRow({ id: 3, proposal_id: 'p-3', proposal_role: 'forged' })
        ] });
        const res = await request(app).get('/proposals/summary');
        expect(res.status).toBe(200);
        expect(res.body.proposals.map(p => p.proposalRole)).toEqual(['owner-offer', null, null]);
        expect(pool.getCalls()[0].sql).toMatch(/proposal_data->>'proposalRole' AS proposal_role/);
    });
});

describe('agent recipe schema', () => {
    it('documents proposalRole as the owner-offer enum', () => {
        const schema = JSON.parse(readFileSync(new URL('../routes/agent-recipe-schema.json', import.meta.url), 'utf8'));
        expect(schema.properties.proposalRole.type).toBe('string');
        expect(schema.properties.proposalRole.enum).toEqual(PROPOSAL_ROLES);
    });
});
