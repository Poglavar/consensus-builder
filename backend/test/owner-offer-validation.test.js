// Owner offers on the server: proposalRole ('owner-offer' or absent) is served in /proposals/summary
// only when known, and documented in the agent recipe schema.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';
import { PROPOSAL_ROLES } from '../routes/proposals.js';
import { summaryDbRow } from './helpers/fixtures.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createTestApp(pool);
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
