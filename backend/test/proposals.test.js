import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';
import {
    proposalDbRow,
    summaryDbRow,
} from './helpers/fixtures.js';

let pool;
let app;

function getRouteHandler(appInstance, routePath, method) {
    const layer = appInstance._router.stack.find(stackLayer => (
        stackLayer.route
        && stackLayer.route.path === routePath
        && stackLayer.route.methods?.[method]
    ));

    return layer?.route?.stack?.at(-1)?.handle;
}

beforeEach(() => {
    pool = createMockPool();
    app = createTestApp(pool);
});

describe('POST /proposals/batch', () => {
    it('returns full records in requested order, deduplicated, with explicit misses', async () => {
        const first = proposalDbRow({ id: 11, proposal_id: 'proposal-a', name: 'A' });
        const second = proposalDbRow({ id: 22, proposal_id: 'proposal-b', name: 'B' });
        // Database order is deliberately different from request order.
        pool.setResult({ rows: [second, first], rowCount: 2 });

        const res = await request(app)
            .post('/proposals/batch')
            .send({ ids: ['proposal-a', 'missing', 'proposal-b', 'proposal-a'] });

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
        expect(res.body.items.map(item => item.id)).toEqual(['proposal-a', 'missing', 'proposal-b']);
        expect(res.body.items[0].proposal).toMatchObject({ id: 11, proposalId: 'proposal-a', name: 'A' });
        expect(res.body.items[1].proposal).toBeNull();
        expect(res.body.items[2].proposal).toMatchObject({ id: 22, proposalId: 'proposal-b', name: 'B' });
        expect(pool.getCalls()[0].params).toEqual([[], ['proposal-a', 'missing', 'proposal-b']]);
    });

    it('does not resolve a numeric authored id when only the other row has that proposal_id', async () => {
        pool.setResult({ rows: [proposalDbRow({ id: 9, proposal_id: '1' })], rowCount: 1 });

        const res = await request(app).post('/proposals/batch').send({ ids: [1] });

        expect(res.status).toBe(200);
        expect(res.body.items[0].proposal).toBeNull();
        expect(pool.getCalls()[0].params).toEqual([['1'], []]);
    });

    it('partitions row IDs (numbers or digit strings) and authored IDs into separate query parameters', async () => {
        const row = proposalDbRow({ id: 11, proposal_id: 'authored-a' });
        const authored = proposalDbRow({ id: 22, proposal_id: '22' });
        pool.setResult({ rows: [authored, row], rowCount: 2 });

        const res = await request(app).post('/proposals/batch').send({ ids: [11, '22', 'authored-a'] });

        expect(res.status).toBe(200);
        expect(res.body.items.map(item => item.proposal)).toMatchObject([
            { id: 11, proposalId: 'authored-a' },
            { id: 22, proposalId: '22' },
            { id: 11, proposalId: 'authored-a' },
        ]);
        expect(pool.getCalls()[0].params).toEqual([['11', '22'], ['authored-a']]);
    });

    it('validates a non-empty bounded identifier list', async () => {
        const empty = await request(app).post('/proposals/batch').send({ ids: [] });
        expect(empty.status).toBe(400);

        const tooMany = await request(app)
            .post('/proposals/batch')
            .send({ ids: Array.from({ length: 1001 }, (_, index) => String(index + 1)) });
        expect(tooMany.status).toBe(400);

        const invalid = await request(app).post('/proposals/batch').send({ ids: ['ok', ''] });
        expect(invalid.status).toBe(400);
    });
});

describe('GET /proposals/:id', () => {
    it('returns 400 when invoked without a route id param', async () => {
        const handler = getRouteHandler(app, '/proposals/:id', 'get');
        const req = { params: {} };
        const res = {
            statusCode: 200,
            body: undefined,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                this.body = payload;
                return this;
            }
        };

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid proposal id. Must be provided.' });
    });

    it('preserves falsey db flags instead of falling back to proposal_data values', async () => {
        const row = proposalDbRow({
            decay_enabled: false,
            deposit_enabled: false,
            is_conditional: false,
            proposal_data: {
                decayEnabled: true,
                depositEnabled: true,
                isConditional: true
            }
        });
        pool.setResult({ rows: [row], rowCount: 1 });

        const res = await request(app).get('/proposals/test-proposal-001');

        expect(res.status).toBe(200);
        expect(res.body.decayEnabled).toBe(false);
        expect(res.body.depositEnabled).toBe(false);
        expect(res.body.isConditional).toBe(false);
    });

    it('returns a proposal when fetched by numeric id', async () => {
        const row = proposalDbRow({ proposal_id: 'db-id-proposal' });
        pool.setResult({ rows: [row], rowCount: 1 });

        const res = await request(app).get('/proposals/1');

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(1);
        expect(res.body.proposalId).toBe('db-id-proposal');
    });

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

    it('returns a road proposal with cross-city parcels (e.g. Split parcels in Zagreb city)', async () => {
        const splitParcelIds = ['HR-330779-12971', 'HR-330779-13020', 'HR-330779-13049'];
        const splitChildIds = [
            'HR-330779-12971_abc123_1', 'HR-330779-12971_abc123_2',
            'HR-330779-13020_abc123_1', 'HR-330779-13020_abc123_2',
        ];
        const roadDefinition = {
            width: 6,
            points: [
                { lat: 43.508, lng: 16.440 },
                { lat: 43.509, lng: 16.441 },
                { lat: 43.510, lng: 16.442 },
            ],
            polygon: {
                type: 'Polygon',
                coordinates: [[[16.4399, 43.5079], [16.4411, 43.5101], [16.4421, 43.5101], [16.4409, 43.5079], [16.4399, 43.5079]]]
            }
        };
        const row = proposalDbRow({
            city: 'zagreb',
            type: 'road-track',
            cadastre_parcel_ids: splitParcelIds,
            descendant_parcel_ids: splitChildIds,
            road_proposal: {
                definition: roadDefinition,
                childParcelIds: splitChildIds,
                status: 'applied',
            },
            proposal_data: {
                goal: 'road-track',
                childParcelIds: splitChildIds,
            }
        });
        pool.setResult({ rows: [row], rowCount: 1 });

        const res = await request(app).get('/proposals/test-proposal-001');

        expect(res.status).toBe(200);
        expect(res.body.city).toBe('zagreb');
        expect(res.body.roadProposal).toBeDefined();
        expect(res.body.roadProposal.definition.polygon).toBeDefined();
        expect(res.body.roadProposal.definition.polygon.type).toBe('Polygon');
        expect(res.body.roadProposal.definition.points).toHaveLength(3);
        expect(res.body.roadProposal.childParcelIds).toBeUndefined();
        expect(res.body.cadastreParcelIds).toEqual(splitParcelIds);
        expect(res.body.parentParcelIds).toBeUndefined();
        expect(res.body.childParcelIds).toBeUndefined();
    });

    it('returns row-backed proposal data when proposal_data is null', async () => {
        pool.setResult({
            rows: [proposalDbRow({
                proposal_data: null,
                road_proposal: { width: 5 },
                cadastre_parcel_ids: ['HR-1'],
                descendant_parcel_ids: ['HR-2'],
                parent_proposal_ids: ['parent-1'],
                child_proposal_ids: ['child-1'],
                lens: ['planning'],
                bounds: [1, 2, 3, 4],
                onchain_data: { txHash: '0x1' }
            })],
            rowCount: 1
        });

        const res = await request(app).get('/proposals/test-proposal-001');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            id: 1,
            proposalId: 'test-proposal-001',
            roadProposal: { width: 5 },
            cadastreParcelIds: ['HR-1'],
            lens: ['planning'],
            bounds: [1, 2, 3, 4],
            onchain: { txHash: '0x1' }
        });
        expect(res.body).not.toHaveProperty('onchainData');
        expect(res.body).not.toHaveProperty('childParcelIds');
        expect(res.body).not.toHaveProperty('parentProposals');
        expect(res.body).not.toHaveProperty('childProposals');
    });

    it('uses JSON for nullable authored fields but not cleared chain attachment or unknown lifecycle', async () => {
        pool.setResult({
            rows: [proposalDbRow({
                name: null,
                title: null,
                description: null,
                author: null,
                type: null,
                status: null,
                offer: null,
                offer_currency: null,
                budget: null,
                budget_currency: null,
                created_at: null,
                expires_at: null,
                updated_at: null,
                cadastre_parcel_ids: ['PARENT'],
                descendant_parcel_ids: null,
                accepted_parcel_ids: null,
                owner_acceptances: null,
                road_proposal: null,
                building_proposal: null,
                structure_proposal: null,
                reparcellization: null,
                parent_proposal_ids: null,
                child_proposal_ids: null,
                lens: null,
                bounds: null,
                onchain_data: null,
                proposal_data: {
                    name: 'JSON name',
                    title: 'JSON title',
                    description: 'JSON description',
                    author: 'json-author',
                    type: 'road',
                    lifecycleStatus: 'draft',
                    offer: 12,
                    offerCurrency: 'USD',
                    budget: 34,
                    budgetCurrency: 'EUR',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    expiresAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-01-15T00:00:00.000Z',
                    cadastreParcelIds: ['PARENT'],
                    childParcelIds: ['CHILD'],
                    acceptedParcelIds: ['PARENT'],
                    ownerAcceptances: { PARENT: true },
                    roadProposal: { width: 4 },
                    buildingProposal: { height: 8 },
                    structureProposal: { floors: 2 },
                    reparcellization: { merge: true },
                    parentProposals: ['parent-proposal'],
                    childProposals: ['child-proposal'],
                    lens: ['mobility'],
                    bounds: [1, 2, 3, 4],
                    onchain: { txHash: '0xabc' },
                    onchainData: { txHash: '0xabc' }
                }
            })],
            rowCount: 1
        });

        const res = await request(app).get('/proposals/test-proposal-001');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            name: 'JSON name',
            title: 'JSON title',
            description: 'JSON description',
            author: 'json-author',
            type: 'road',
            lifecycleStatus: 'Unknown',
            offer: 12,
            offerCurrency: 'USD',
            budget: 34,
            budgetCurrency: 'EUR',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-02-01T00:00:00.000Z',
            updatedAt: '2026-01-15T00:00:00.000Z',
            cadastreParcelIds: ['PARENT'],
            roadProposal: { width: 4 },
            buildingProposal: { height: 8 },
            structureProposal: { floors: 2 },
            reparcellization: { merge: true },
            lens: ['mobility'],
            bounds: [1, 2, 3, 4],
            onchain: null
        });
        expect(res.body).not.toHaveProperty('acceptedParcelIds');
        expect(res.body).not.toHaveProperty('ownerAcceptances');
        expect(res.body).not.toHaveProperty('onchainData');
        expect(res.body).not.toHaveProperty('childParcelIds');
        expect(res.body).not.toHaveProperty('parentProposals');
        expect(res.body).not.toHaveProperty('childProposals');
    });

    it('preserves explicit zero and empty db values when reading a proposal', async () => {
        pool.setResult({
            rows: [proposalDbRow({
                title: '',
                description: '',
                offer: '0',
                budget: '0',
                decay_percent: 0,
                decay_duration_ms: 0,
                deposit_percent: 0,
                proposal_data: {
                    title: 'fallback title',
                    description: 'fallback description',
                    offer: 9,
                    budget: 12,
                    decayPercent: 5,
                    decayDurationMs: 10,
                    depositPercent: 15
                }
            })],
            rowCount: 1
        });

        const res = await request(app).get('/proposals/test-proposal-001');

        expect(res.status).toBe(200);
        expect(res.body.title).toBe('');
        expect(res.body.description).toBe('');
        expect(res.body.offer).toBe(0);
        expect(res.body.budget).toBe(0);
        expect(res.body.decayPercent).toBe(0);
        expect(res.body.decayDurationMs).toBe(0);
        expect(res.body.depositPercent).toBe(0);
    });

    it('returns 404 when not found', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/proposals/nonexistent');

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });

    it('returns 500 when proposal lookup fails', async () => {
        pool.query = async () => {
            throw new Error('lookup failed');
        };

        const res = await request(app).get('/proposals/test-proposal-001');

        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Internal server error/);
    });
});

describe('HEAD /proposals/:id', () => {
    it('returns 400 when id is missing', async () => {
        const res = await request(app).head('/proposals/');

        expect([404, 400]).toContain(res.status);
    });

    it('returns metadata headers when found', async () => {
        const updated = new Date('2026-01-20T10:00:00Z');
        pool.setResult({
            rows: [{ id: 5, proposal_id: 'hdr-test', updated_at: updated, created_at: updated }],
        });

        const res = await request(app).head('/proposals/hdr-test');

        expect(res.status).toBe(200);
        expect(res.headers['x-proposal-row-id']).toBe('5');
        expect(res.headers['x-proposal-authored-id']).toBe('hdr-test');
        expect(res.headers['x-proposal-id']).toBeUndefined();
        expect(res.headers['x-proposal-proposalid']).toBeUndefined();
        expect(res.headers['last-modified']).toBeDefined();
        expect(res.headers['etag']).toContain('hdr-test');
    });

    it('omits cache headers when timestamps are absent', async () => {
        pool.setResult({
            rows: [{ id: 5, proposal_id: 'hdr-test', updated_at: null, created_at: null }],
        });

        const res = await request(app).head('/proposals/hdr-test');

        expect(res.status).toBe(200);
        expect(res.headers['etag']).toBeUndefined();
        expect(res.headers['last-modified']).toBeUndefined();
        expect(res.headers['x-proposal-row-id']).toBe('5');
        expect(res.headers['x-proposal-authored-id']).toBe('hdr-test');
        expect(res.headers['x-proposal-id']).toBeUndefined();
        expect(res.headers['x-proposal-proposalid']).toBeUndefined();
    });

    it('uses created_at for cache headers when updated_at is absent', async () => {
        const created = new Date('2026-01-18T09:30:00Z');
        pool.setResult({
            rows: [{ id: 6, proposal_id: 'created-only', updated_at: null, created_at: created }],
        });

        const res = await request(app).head('/proposals/created-only');

        expect(res.status).toBe(200);
        expect(res.headers['last-modified']).toBe(created.toUTCString());
        expect(res.headers['etag']).toContain('created-only');
    });

    it('returns 404 when not found', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).head('/proposals/nope');

        expect(res.status).toBe(404);
    });

    it('returns 500 when metadata lookup fails', async () => {
        pool.query = async () => {
            throw new Error('head failed');
        };

        const res = await request(app).head('/proposals/hdr-test');

        expect(res.status).toBe(500);
    });
});

describe('GET /proposals/count', () => {
    it('returns count with filters', async () => {
        pool.setResult({ rows: [{ count: '42' }] });

        const res = await request(app)
            .get('/proposals/count?city=zg&lifecycle=Active');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(42);
        expect(res.body.city).toBe('zagreb');
        expect(res.body.lifecycle).toBe('Active');

        const call = pool.getCalls()[0];
        expect(call.sql).toContain('COUNT(DISTINCT id)');
        expect(call.params).toContain('zagreb');
        expect(call.params).toContain('Active');
    });

    it('returns count with no filters', async () => {
        pool.setResult({ rows: [{ count: '100' }] });

        const res = await request(app).get('/proposals/count');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(100);
        expect(pool.getCalls()[0].params).toHaveLength(0);
    });

    it('counts distinct proposals intersecting a validated viewport bbox without returning proposal rows', async () => {
        pool.setResult({ rows: [{ count: '3' }] });

        const res = await request(app).get('/proposals/count?city=explore&bbox=15.8,45.7,16.1,46.0');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            count: 3,
            city: null,
            lifecycle: null,
            type: null,
            author: null,
            bbox: [15.8, 45.7, 16.1, 46]
        });
        const call = pool.getCalls()[0];
        expect(call.sql).toContain('COUNT(DISTINCT id)');
        expect(call.sql).toContain('ST_Intersects(site, ST_MakeEnvelope');
        expect(call.sql).toContain('bounds->>');
        expect(call.sql).not.toContain('city =');
        expect(call.sql).not.toContain('SELECT *');
        expect(call.params).toEqual([15.8, 45.7, 16.1, 46]);
    });

    it('keeps city filtering when a viewport bbox accompanies a known city', async () => {
        pool.setResult({ rows: [{ count: '2' }] });

        const res = await request(app).get('/proposals/count?city=zg&bbox=15,45,16,46');

        expect(res.status).toBe(200);
        expect(res.body.city).toBe('zagreb');
        expect(pool.getCalls()[0].sql).toContain('city = $5');
        expect(pool.getCalls()[0].params).toEqual([15, 45, 16, 46, 'zagreb']);
    });

    it.each([
        'NaN,45,16,46',
        '181,45,182,46',
        '15,-91,16,46',
        '16,45,15,46',
        '15,47,16,46',
        '15,45,,46',
        '15,45,16',
        '15,45,16,46,17'
    ])('rejects invalid bbox %s', async (bbox) => {
        const res = await request(app).get(`/proposals/count?bbox=${encodeURIComponent(bbox)}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/bbox must be west,south,east,north/);
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('returns zero when the count query yields no rows and preserves unknown city codes', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).get('/proposals/count?city=custom-city&type=road&author=bob');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            count: 0,
            city: 'custom-city',
            lifecycle: null,
            type: 'road',
            author: 'bob'
        });
        expect(pool.getCalls()[0].params).toEqual(['custom-city', 'road', 'bob']);
    });

    it('defaults invalid pagination filter inputs', async () => {
        pool.setResult({ rows: [{ count: '7' }] });

        const res = await request(app).get('/proposals/count?city=bg&limit=bad&offset=-2');

        expect(res.status).toBe(200);
        expect(res.body.city).toBe('belgrade');
    });

    it('returns 500 when count lookup fails', async () => {
        pool.query = async () => {
            throw new Error('count failed');
        };

        const res = await request(app).get('/proposals/count?city=zg');

        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Internal server error/);
    });
});

describe('GET /proposals/counts', () => {
    it('returns per-parcel counts as a { counts } map', async () => {
        pool.setResult({
            rows: [
                { parcel_id: 'HR-1-100', n: 2 },
                { parcel_id: 'HR-1-101', n: 1 },
            ],
        });

        const res = await request(app).get('/proposals/counts?parcel_ids=HR-1-100,HR-1-101,HR-1-102&city=zg');

        expect(res.status).toBe(200);
        expect(res.body.counts).toEqual({ 'HR-1-100': 2, 'HR-1-101': 1 }); // 102 absent → 0
        const call = pool.getCalls()[0];
        expect(call.sql).toMatch(/cadastre_parcel_ids \?\| \$1/);
        expect(call.sql).not.toContain('descendant_parcel_ids');
        expect(call.params[0]).toEqual(['HR-1-100', 'HR-1-101', 'HR-1-102']);
        expect(call.params).toContain('zagreb'); // normalized city
    });

    it('dedupes the requested ids', async () => {
        pool.setResult({ rows: [] });
        await request(app).get('/proposals/counts?parcel_ids=A,A,B,B,B');
        expect(pool.getCalls()[0].params[0]).toEqual(['A', 'B']);
    });

    it('400s when parcel_ids is missing or empty', async () => {
        const res = await request(app).get('/proposals/counts');
        expect(res.status).toBe(400);
        const res2 = await request(app).get('/proposals/counts?parcel_ids=%20,%20');
        expect(res2.status).toBe(400);
    });

    it('returns 500 when the count query fails', async () => {
        pool.query = async () => { throw new Error('counts failed'); };
        const res = await request(app).get('/proposals/counts?parcel_ids=A');
        expect(res.status).toBe(500);
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

    it('includes agent provenance in lightweight summaries for the proposal card badge', async () => {
        const agent = {
            persona: 'densifier-01',
            wallet: 'AgentWallet111111111111111111111111111111111',
            paid: { amount: '0.05', tx: 'SettlementSignature111111111111111111111111111' }
        };
        pool.setResult({ rows: [summaryDbRow({ agent })] });

        const res = await request(app).get('/proposals/summary');

        expect(res.status).toBe(200);
        expect(res.body.proposals[0].agent).toEqual(agent);
        // Served only for rows with a settled x402 payment, never for a client-written stamp.
        expect(pool.getCalls()[0].sql).toMatch(/CASE WHEN agent_payment_id IS NOT NULL THEN proposal_data->'agent' END AS agent/);
    });

    it('includes the minted proposal account so autonomous supporters need no full-record scan', async () => {
        const onchain = { proposalId: 'ProposalPda1111111111111111111111111111111', chainId: 'solana-devnet' };
        pool.setResult({ rows: [summaryDbRow({ onchain_data: onchain })] });

        const res = await request(app).get('/proposals/summary?lifecycle=Active');

        expect(res.status).toBe(200);
        expect(res.body.proposals[0].onchain).toEqual(onchain);
        expect(pool.getCalls()[0].sql).toMatch(/onchain_data/);
    });

    it('serves the goal so the client does not re-derive it from the lossy type', async () => {
        pool.setResult({
            rows: [
                summaryDbRow({ id: 1, proposal_id: 'p-1', type: 'building', goal: 'buildings' }),
                summaryDbRow({ id: 2, proposal_id: 'p-2', type: 'structure', goal: 'park' }),
            ],
        });

        const res = await request(app).get('/proposals/summary');

        expect(res.status).toBe(200);
        expect(res.body.proposals.map(p => p.goal)).toEqual(['buildings', 'park']);
        // The SELECT must expose goal for the client mapper.
        expect(pool.getCalls()[0].sql).toMatch(/AS goal/);
    });

    it('does not infer an authored goal from the broad type or expose unknown goal keys', async () => {
        pool.setResult({ rows: [
            summaryDbRow({ id: 1, type: 'building', goal: 'invented-goal' }),
            summaryDbRow({ id: 2, type: 'road', goal: null })
        ] });

        const res = await request(app).get('/proposals/summary');

        expect(res.status).toBe(200);
        expect(res.body.proposals.map(proposal => proposal.goal)).toEqual([null, null]);
        expect(pool.getCalls()[0].sql).toMatch(/proposal_data->>'goal' AS goal/);
        expect(pool.getCalls()[0].sql).not.toMatch(/COALESCE\(proposal_data->>'goal', type\)/);
    });

    it('reports the server-derived effective status (expired reads Expired, not the stale value)', async () => {
        pool.setResult({
            rows: [
                summaryDbRow({ id: 1, proposal_id: 'p-1', status: 'Active', effective_status: 'Expired' }),
                summaryDbRow({ id: 2, proposal_id: 'p-2', status: 'Active', effective_status: 'Active' }),
            ],
        });

        const res = await request(app).get('/proposals/summary');

        expect(res.status).toBe(200);
        expect(res.body.proposals.map(p => p.lifecycleStatus)).toEqual(['Expired', 'Active']);
        // The SELECT must derive it server-side.
        expect(pool.getCalls()[0].sql).toMatch(/AS effective_status/);
        expect(pool.getCalls()[0].sql).toMatch(/expires_at <= now\(\)/);
    });

    it('projects qualified server lifecycle evidence into summaries', async () => {
        const chainMirror = {
            protocol: 'proposal-chain/1',
            ref: {
                chainType: 'solana', chainId: 'solana-devnet',
                contract: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg', tokenId: 'proposal-account'
            },
            verifiedAt: '2026-10-20T10:02:00.000Z',
            lifecycle: { status: 'Active', observedAt: '2026-10-20T09:59:00.000Z' }
        };
        const lifecycleEvent = {
            id: 'event-1', eventType: 'proposal_lifecycle',
            subject: { type: 'proposal', id: 'proposal-account' }, outcome: 'executed',
            observedAt: '2026-10-20T10:01:00.000Z',
            attester: { kind: 'solana_program', address: chainMirror.ref.contract },
            source: { chain: 'solana:devnet', transaction: 'signature-1', hash: `sha256:${'a'.repeat(64)}` },
            evidence: { proposalStatusByte: 1 }
        };
        pool.setResult({ rows: [summaryDbRow({
            effective_status: 'Executed', chain_mirror: chainMirror,
            lifecycle_event: lifecycleEvent, expires_at: null
        })] });

        const res = await request(app).get('/proposals/summary');

        expect(res.status).toBe(200);
        expect(res.body.proposals[0].lifecycleEvidence).toMatchObject({
            protocol: 'proposal-lifecycle-evidence/1', state: 'observed', status: 'Executed',
            source: 'land-event', observedAt: '2026-10-20T10:01:00.000Z'
        });
        expect(res.body.proposals[0].lifecycleEvidence.observations.at(-1)).toMatchObject({
            source: 'land-event', transaction: 'signature-1'
        });
        expect(pool.getCalls()[0].sql).toMatch(/proposal_data->'chainMirror' AS chain_mirror/);
        expect(pool.getCalls()[0].sql).toMatch(/event_type = 'proposal_lifecycle'/);
    });

    it('prefers display_title when display_name is absent', async () => {
        pool.setResult({
            rows: [{
                id: 1,
                proposal_id: 'p-1',
                city: 'zagreb',
                display_name: null,
                display_title: 'Only Title',
                author: null,
                type: null,
                status: null,
                created_at: new Date('2026-01-01T00:00:00Z'),
                total_count: '1'
            }]
        });

        const res = await request(app).get('/proposals/summary');

        expect(res.status).toBe(200);
        expect(res.body.proposals[0]).toMatchObject({
            name: 'Only Title',
            title: 'Only Title'
        });
    });

    it('applies normalized city filters and default pagination', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).get('/proposals/summary?city=zg&type=parcel&author=alice');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ proposals: [], count: 0, limit: 100, offset: 0 });
        expect(pool.getCalls()[0].params).toEqual(['zagreb', 'parcel', 'alice', 100, 0]);
    });

    it('filters summary rows to those declaring any of the given parcels (a Proposals tab)', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).get('/proposals/summary?city=zg&parcel_ids=HR-1, HR-2,,HR-1');

        expect(res.status).toBe(200);
        const call = pool.getCalls()[0];
        expect(call.sql).toContain('cadastre_parcel_ids ?| $2::text[]');
        expect(call.params).toEqual(['zagreb', ['HR-1', 'HR-2'], 100, 0]);
    });

    it('filters summary rows by bbox while retaining city, sorting, and pagination', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).get('/proposals/summary?city=zg&bbox=15.8,45.7,16.1,46&sort=created-asc&limit=20&offset=5');

        expect(res.status).toBe(200);
        const call = pool.getCalls()[0];
        expect(call.sql).toContain('ST_Intersects(site, ST_MakeEnvelope');
        expect(call.sql).toContain('bounds->>');
        expect(call.sql).toContain('city = $5');
        expect(call.sql).toContain('ORDER BY created_at ASC LIMIT $6 OFFSET $7');
        expect(call.params).toEqual([15.8, 45.7, 16.1, 46, 'zagreb', 20, 5]);
    });

    it('applies bbox across all cities for Explore and rejects invalid viewport bounds', async () => {
        pool.setResult({ rows: [] });
        const res = await request(app).get('/proposals/summary?city=explore&bbox=15,45,16,46');

        expect(res.status).toBe(200);
        expect(pool.getCalls()[0].sql).toContain('ST_Intersects(site, ST_MakeEnvelope');
        expect(pool.getCalls()[0].sql).not.toContain('city =');
        expect(pool.getCalls()[0].params).toEqual([15, 45, 16, 46, 100, 0]);

        pool.reset?.();
        const invalid = await request(app).get('/proposals/summary?bbox=15,91,16,92');
        expect(invalid.status).toBe(400);
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('filters by EFFECTIVE lifecycle (expired-but-stale rows excluded from ?lifecycle=Active)', async () => {
        pool.setResult({ rows: [] });
        await request(app).get('/proposals/summary?lifecycle=Active');
        const call = pool.getCalls()[0];
        // The WHERE clause derives the lifecycle, not a raw column compare.
        expect(call.sql).toMatch(/WHEN LOWER\(BTRIM\(COALESCE\(lifecycle_status, ''\)\)\) = 'active'[\s\S]*expires_at <= now\(\)[\s\S]*LOWER\(\$1\)/);
        expect(call.params).toContain('Active');
    });

    it('allows Unknown reads to be filtered without treating them as Active', async () => {
        pool.setResult({ rows: [] });
        const response = await request(app).get('/proposals/summary?lifecycle=Unknown');
        expect(response.status).toBe(200);
        expect(pool.getCalls()[0].params).toContain('Unknown');
        expect(pool.getCalls()[0].sql).toContain("ELSE 'Unknown'");
    });

    it('filters by the explicitly authored goal only', async () => {
        pool.setResult({ rows: [] });
        const res = await request(app).get('/proposals/summary?goal=park-square');
        expect(res.status).toBe(200);
        const call = pool.getCalls()[0];
        expect(call.sql).toMatch(/proposal_data->>'goal' = \$1/);
        expect(call.sql).not.toMatch(/COALESCE\(proposal_data->>'goal', type\)/);
        expect(call.params).toContain('park-square');
    });

    it('returns only canonical authored goals in the epoch plan', async () => {
        pool.setResult({ rows: [
            { id: 1, proposal_id: 'p-1', city: 'zagreb', display_name: 'Park', type: 'structure', goal: 'park', epoch_year: 2027, bounds: null, created_at: new Date('2026-10-01T10:00:00Z'), screenshot_url: null },
            { id: 2, proposal_id: 'p-2', city: 'zagreb', display_name: 'Unknown', type: 'building', goal: 'invented-goal', epoch_year: 2027, bounds: null, created_at: new Date('2026-10-02T10:00:00Z'), screenshot_url: null },
            { id: 3, proposal_id: 'p-3', city: 'zagreb', display_name: 'Legacy', type: 'road', goal: null, epoch_year: 2027, bounds: null, created_at: new Date('2026-10-03T10:00:00Z'), screenshot_url: null }
        ] });

        const res = await request(app).get('/proposals/epoch-plan?city=zagreb');

        expect(res.status).toBe(200);
        expect(res.body.epochs[0].proposals.map(proposal => proposal.goal)).toEqual(['park', null, null]);
        expect(pool.getCalls()[0].sql).toMatch(/proposal_data->>'goal' AS goal/);
        expect(pool.getCalls()[0].sql).not.toMatch(/COALESCE\(proposal_data->>'goal', type\)/);
    });

    it('free-text search matches name/title and author across all rows', async () => {
        pool.setResult({ rows: [] });
        const res = await request(app).get('/proposals/summary?q=ilica');
        expect(res.status).toBe(200);
        const call = pool.getCalls()[0];
        expect(call.sql).toMatch(/ILIKE/);
        expect(call.params).toContain('%ilica%');
    });

    it('honours a whitelisted sort and ignores an unknown one', async () => {
        pool.setResult({ rows: [] });
        await request(app).get('/proposals/summary?sort=value-desc');
        expect(pool.getCalls()[0].sql).toMatch(/ORDER BY NULLIF\(proposal_data->>'offer', ''\)::numeric DESC NULLS LAST/);

        pool.reset?.();
        pool.setResult({ rows: [] });
        await request(app).get('/proposals/summary?sort=; DROP TABLE proposal');
        // Unknown/injection sort falls back to the safe default.
        expect(pool.getCalls().at(-1).sql).toMatch(/ORDER BY created_at DESC/);
    });

    it('uses result length when total_count is absent', async () => {
        pool.setResult({
            rows: [
                {
                    id: 1,
                    proposal_id: 'p-1',
                    city: 'zagreb',
                    display_name: 'One',
                    display_title: 'One',
                    author: 'alice',
                    type: 'parcel',
                    status: 'draft',
                    created_at: new Date('2026-01-01T00:00:00Z')
                }
            ]
        });

        const res = await request(app).get('/proposals/summary');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
    });

    it('returns null summary fields when display values and timestamps are missing', async () => {
        pool.setResult({
            rows: [{
                id: 1,
                proposal_id: 'p-1',
                city: 'zagreb',
                display_name: null,
                display_title: null,
                author: '',
                type: '',
                status: '',
                created_at: null,
                total_count: '1'
            }]
        });

        const res = await request(app).get('/proposals/summary');

        expect(res.status).toBe(200);
        expect(res.body.proposals[0]).toMatchObject({
            name: null,
            title: null,
            author: null,
            type: null,
            lifecycleStatus: 'Unknown',
            createdAt: null
        });
    });

    it('returns 500 when summary lookup fails', async () => {
        pool.query = async () => {
            throw new Error('summary failed');
        };

        const res = await request(app).get('/proposals/summary?city=zg');

        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Internal server error/);
    });
});

describe('GET /proposals?parcel_id=', () => {
    it('applies explicit limit and offset with normalized city filters', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).get('/proposals?parcel_id=HR-1234-5678&city=bg&limit=5&offset=2');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            proposals: [],
            count: 0,
            limit: 5,
            offset: 2,
            parcelId: 'HR-1234-5678'
        });
        expect(pool.getCalls()[0].params).toEqual(['belgrade', '["HR-1234-5678"]', 5, 2]);
    });

    it('defaults invalid limit and offset values', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).get('/proposals?parcel_id=HR-1234-5678&limit=bad&offset=also-bad');

        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(100);
        expect(res.body.offset).toBe(0);
        expect(pool.getCalls()[0].params).toEqual(['["HR-1234-5678"]', 100, 0]);
    });

    it('defaults negative limit and offset values', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).get('/proposals?parcel_id=HR-1234-5678&city=bg&limit=-5&offset=-2');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            proposals: [],
            count: 0,
            limit: 100,
            offset: 0,
            parcelId: 'HR-1234-5678'
        });
        expect(pool.getCalls()[0].params).toEqual(['belgrade', '["HR-1234-5678"]', 100, 0]);
    });

    it('applies city filters and preserves proposal_data fallbacks', async () => {
        pool.setResult({
            rows: [{
                ...proposalDbRow({ proposal_id: 'city-filtered', proposal_data: { custom: true } }),
                descendant_parcel_ids: ['HR-1234-9999'],
                cadastre_parcel_ids: ['HR-1234-5678']
            }]
        });

        const res = await request(app).get('/proposals?parcel_id=HR-1234-5678&city=ba');

        expect(res.status).toBe(200);
        expect(res.body.proposals[0].custom).toBe(true);
        expect(res.body.proposals[0].id).toBe(1);
        expect(res.body.proposals[0].proposalId).toBe('city-filtered');
        expect(res.body.proposals[0].city).toBe('zagreb');
        expect(res.body.proposals[0].offer).toBe(1.5);
        expect(res.body.proposals[0].offerCurrency).toBe('ETH');
        expect(res.body.proposals[0].cadastreParcelIds).toEqual(['HR-1234-5678']);
        expect(res.body.proposals[0].parentParcelIds).toBeUndefined();
        expect(res.body.proposals[0].childParcelIds).toBeUndefined();
        expect(pool.getCalls()[0].params[0]).toBe('buenos_aires');
    });

    it('fills identifier fields from row data when proposal_data omits them', async () => {
        pool.setResult({
            rows: [{
                ...proposalDbRow({
                    id: 42,
                    proposal_id: 'db-only-id',
                    proposal_data: { title: 'Stored title only' }
                }),
                cadastre_parcel_ids: ['HR-1234-5678'],
                descendant_parcel_ids: null
            }]
        });

        const res = await request(app).get('/proposals?parcel_id=HR-1234-5678');

        expect(res.status).toBe(200);
        expect(res.body.proposals[0]).toMatchObject({
            id: 42,
            proposalId: 'db-only-id',
            city: 'zagreb',
            title: 'Test Proposal Title',
            cadastreParcelIds: ['HR-1234-5678']
        });
        expect(res.body.proposals[0].childParcelIds).toBeUndefined();
    });

    it('finds proposals by parcel containment', async () => {
        const row = proposalDbRow();
        pool.setResult({ rows: [row] });

        const res = await request(app)
            .get('/proposals?parcel_id=HR-1234-5678');

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('parcelId', 'HR-1234-5678');
        expect(res.body.proposals).toHaveLength(1);

        const call = pool.getCalls()[0];
        expect(call.sql).toContain('cadastre_parcel_ids @>');
        expect(call.sql).not.toContain('descendant_parcel_ids @>');
        expect(call.params).toContain(JSON.stringify(['HR-1234-5678']));
    });

    it('returns 400 when parcel_id is missing', async () => {
        const res = await request(app).get('/proposals');

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/parcel_id.*required/i);
    });

    it('returns 500 when parcel lookup query fails', async () => {
        pool.query = async () => {
            throw new Error('boom');
        };

        const res = await request(app).get('/proposals?parcel_id=HR-1234-5678');

        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Internal server error/);
    });

    it('falls back to row values when proposal_data is absent in parcel queries', async () => {
        pool.setResult({
            rows: [{
                ...proposalDbRow({
                    id: 77,
                    proposal_id: 'row-only',
                    proposal_data: null,
                    title: 'Row title only'
                }),
                cadastre_parcel_ids: ['HR-1234-5678'],
                descendant_parcel_ids: ['HR-9999-0001']
            }]
        });

        const res = await request(app).get('/proposals?parcel_id=HR-1234-5678');

        expect(res.status).toBe(200);
        expect(res.body.proposals[0]).toMatchObject({
            id: 77,
            proposalId: 'row-only',
            title: 'Row title only',
            cadastreParcelIds: ['HR-1234-5678']
        });
        expect(res.body.proposals[0].childParcelIds).toBeUndefined();
    });

    it('returns empty proposals with preserved raw parcel ids when an unknown city code is used', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).get('/proposals?parcel_id=123&city=experimental-city');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            proposals: [],
            count: 0,
            limit: 100,
            offset: 0,
            parcelId: '123'
        });
        expect(pool.getCalls()[0].params).toEqual(['experimental-city', '["123"]', 100, 0]);
    });

    it('preserves explicit zero values from row data in parcel queries', async () => {
        pool.setResult({
            rows: [{
                ...proposalDbRow({
                    proposal_id: 'zero-values',
                    offer: '0',
                    budget: '0',
                    proposal_data: {
                        offer: 99,
                        budget: 88,
                        cadastreParcelIds: ['HR-1234-5678'],
                        childParcelIds: ['fallback-child']
                    }
                }),
                cadastre_parcel_ids: ['HR-1234-5678'],
                descendant_parcel_ids: []
            }]
        });

        const res = await request(app).get('/proposals?parcel_id=HR-1234-5678');

        expect(res.status).toBe(200);
        expect(res.body.proposals[0]).toMatchObject({
            proposalId: 'zero-values',
            offer: 0,
            budget: 0,
            cadastreParcelIds: ['HR-1234-5678']
        });
        expect(res.body.proposals[0].childParcelIds).toBeUndefined();
    });
});
