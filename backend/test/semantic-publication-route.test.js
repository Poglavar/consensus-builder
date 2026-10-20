import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jsonld from 'jsonld';
import { createTestApp } from './helpers/create-app.js';
import { createMockPool } from './helpers/mock-pool.js';
import { proposalDbRow } from './helpers/fixtures.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { setupEnsPlansRoute } from '../routes/ens-plans.js';
import { NAMESPACE } from '../semantics/vocabulary.js';
import { memberHash } from '../plans/plan-hash.js';

const canonicalBase = 'https://publication.example/api';
let pool, app;
beforeEach(() => {
    vi.stubEnv('PUBLIC_API_BASE_URL', canonicalBase);
    pool = createMockPool();
    app = createTestApp(pool);
});
afterEach(() => vi.unstubAllEnvs());

describe('published JSON-LD detail routes', () => {
    it('uses canonical serialization and the resolved row ID even when requested by authored ID', async () => {
        pool.setResult({ rows: [proposalDbRow({ id: 42, proposal_id: 'authored-ref', lifecycle_status: null, onchain_data: null,
            proposal_data: { goal: 'park', site: { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0]]] },
                lifecycleStatus: 'Executed', applied: true, executedAt: '2026-01-01', ownerApprovals: { unverified: true }, onchain: { chainType: 'solana', chainId: 'solana-devnet', contractAddress: 'stale', proposalId: 'stale' } }
        })], rowCount: 1 });
        const response = await request(app).get('/proposals/authored-ref?format=jsonld').set('Host', 'spoofed.example');
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('application/ld+json');
        expect(response.body['@id']).toBe(`${canonicalBase}/proposals/42#proposal`);
        expect(response.body['cb:authoredProposalId']).toBe('authored-ref');
        expect(response.body['cb:recordedLifecycle']['@id']).toBe('cb:lifecycle-Unknown');
        const rdf = await jsonld.toRDF(response.body, { format: 'application/n-quads' });
        expect(rdf).not.toMatch(/spoofed|stale|unverified|applied|executedAt/);
        expect(rdf).toContain(`${NAMESPACE}Proposal`);
    });

    it('requires a pinned base only for the semantic representation', async () => {
        vi.stubEnv('PUBLIC_API_BASE_URL', '');
        pool.setResult({ rows: [proposalDbRow()], rowCount: 1 });
        const semantic = await request(app).get('/proposals/1?format=jsonld').set('Host', 'spoofed.example');
        expect(semantic.status).toBe(503);
        expect(semantic.body.code).toBe('semantic-public-base-unconfigured');
        pool.setResult({ rows: [proposalDbRow()], rowCount: 1 });
        const ordinary = await request(app).get('/proposals/1');
        expect(ordinary.status).toBe(200);
        expect(ordinary.body.proposalId).toBe('test-proposal-001');
        expect(ordinary.body['@context']).toBeUndefined();
    });

    it('retains not-found and canonical-record validation on semantic requests', async () => {
        pool.setResult({ rows: [], rowCount: 0 });
        expect((await request(app).get('/proposals/999?format=jsonld')).status).toBe(404);
        pool.setResult({ rows: [proposalDbRow({ cadastre_parcel_ids: null })], rowCount: 1 });
        expect((await request(app).get('/proposals/1?format=jsonld')).status).toBe(422);
        pool.setResult({ rows: [proposalDbRow({ proposal_data: { site: { type: 'Polygon', coordinates: [] } } })], rowCount: 1 });
        const invalidSite = await request(app).get('/proposals/1?format=jsonld');
        expect(invalidSite.status).toBe(422);
        expect(invalidSite.body.code).toBe('semantic-record-invalid');
    });

    it('serves plan commitments in order, including a missing member, through the same plan read', async () => {
        const member = { id: 2, proposal_id: 'member-two', goal: 'park' };
        const row = { slug: 'example-plan', proposal_ids: ['2', '1'], member_hashes: { 2: memberHash(member), 1: 'a'.repeat(64) }, plan_hash: 'b'.repeat(64) };
        const store = { plan: vi.fn(async () => row), members: vi.fn(async () => [member]), supersededBy: vi.fn(async () => []) };
        const planApp = createRouteApp(application => setupEnsPlansRoute(application, null, { store }));
        const response = await request(planApp).get('/plans/example-plan?format=jsonld').set('Host', 'spoofed.example');
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('application/ld+json');
        expect(response.body['@id']).toBe(`${canonicalBase}/plans/example-plan#plan`);
        expect(store.members).toHaveBeenCalledWith(['2', '1']);
        const memberships = response.body['cb:memberships']['@list'];
        expect(memberships.map(entry => entry['cb:memberMissing'])).toEqual([false, true]);
        expect(memberships[1]['cb:member']['@id']).toBe(`${canonicalBase}/proposals/1#proposal`);
        expect(await jsonld.toRDF(response.body, { format: 'application/n-quads' })).not.toContain('spoofed');
        vi.stubEnv('PUBLIC_API_BASE_URL', '');
        expect((await request(planApp).get('/plans/example-plan?format=jsonld')).status).toBe(503);
        expect((await request(planApp).get('/plans/example-plan')).status).toBe(200);
    });

    it('keeps missing and malformed named plans out of the semantic graph', async () => {
        const store = { plan: vi.fn(async () => null) };
        const planApp = createRouteApp(application => setupEnsPlansRoute(application, null, { store }));
        expect((await request(planApp).get('/plans/missing-plan?format=jsonld')).status).toBe(404);
        store.plan.mockResolvedValue({ slug: 'broken-plan', proposal_ids: ['1'], member_hashes: {}, plan_hash: 'a'.repeat(64) });
        expect((await request(planApp).get('/plans/broken-plan?format=jsonld')).status).toBe(422);
    });
});
