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

describe('POST /proposals', () => {
    it('rejects non-object proposal payloads', async () => {
        const res = await request(app)
            .post('/proposals')
            .set('Content-Type', 'application/json')
            .send('"invalid"');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({});
    });

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

    it('returns generic 409 when duplicate lookup finds no existing row', async () => {
        const uniqueViolation = new Error('unique violation');
        uniqueViolation.code = '23505';

        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('INSERT INTO proposal')) {
                throw uniqueViolation;
            }
            return { rows: [] };
        };

        const res = await request(app)
            .post('/proposals')
            .send(validProposalBody());

        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'Proposal with this ID already exists' });
    });

    it('returns generic 409 when duplicate lookup itself fails', async () => {
        const uniqueViolation = new Error('unique violation');
        uniqueViolation.code = '23505';
        uniqueViolation.detail = '(proposal_id)=(test-proposal-001)';

        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('INSERT INTO proposal')) {
                throw uniqueViolation;
            }
            throw new Error('lookup failed');
        };

        const res = await request(app)
            .post('/proposals')
            .send(validProposalBody());

        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'Proposal with this ID already exists' });
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

    it('resolves proposalId from proposal_id and normalizes null collections', async () => {
        pool.setResults([
            insertResult({ proposal_id: 'from-proposal-id-field' }),
            updateResult(),
        ]);

        const res = await request(app)
            .post('/proposals')
            .send({
                proposal_id: 'from-proposal-id-field',
                type: 'parcel',
                parentParcelIds: null,
                childParcelIds: null,
                acceptedParcelIds: null,
                ownerAcceptances: null
            });

        expect(res.status).toBe(201);
        const insertParams = pool.getCalls()[0].params;
        expect(insertParams[0]).toBe('from-proposal-id-field');
        expect(insertParams[21]).toBeNull();
        expect(insertParams[22]).toBeNull();
        expect(insertParams[23]).toBeNull();
        expect(insertParams[24]).toBeNull();
    });

    it('falls back to a generated local proposal id when no id field is supplied', async () => {
        const originalNow = Date.now;
        Date.now = () => 1700000000000;
        pool.setResults([
            insertResult({ proposal_id: 'local-1700000000000' }),
            updateResult(),
        ]);

        try {
            const res = await request(app)
                .post('/proposals')
                .send({ type: 'parcel' });

            expect(res.status).toBe(201);
            expect(pool.getCalls()[0].params[0]).toBe('local-1700000000000');
        } finally {
            Date.now = originalNow;
        }
    });

    it('extracts duplicate proposal ids from database error details when the request body omits them', async () => {
        const uniqueViolation = new Error('unique violation');
        uniqueViolation.code = '23505';
        uniqueViolation.detail = '(proposal_id)=(derived-from-detail)';

        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('INSERT INTO proposal')) {
                throw uniqueViolation;
            }
            return { rows: [{ id: 123, proposal_id: 'derived-from-detail' }] };
        };

        const res = await request(app)
            .post('/proposals')
            .send({ type: 'parcel' });

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
            error: 'Proposal with this ID already exists',
            id: 123,
            proposalId: 'derived-from-detail'
        });
        expect(pool.getCalls()[1].params).toEqual(['derived-from-detail']);
    });

    it('preserves explicit false and zero values in validated fields', async () => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app)
            .post('/proposals')
            .send(validProposalBody({
                budget: 0,
                decayEnabled: false,
                decayPercent: 0,
                decayDurationMs: 0,
                depositEnabled: false,
                depositPercent: 0,
                isConditional: false
            }));

        expect(res.status).toBe(201);

        const insertParams = pool.getCalls()[0].params;
        expect(insertParams[10]).toBe(0);
        expect(insertParams[14]).toBe(false);
        expect(insertParams[15]).toBe(0);
        expect(insertParams[16]).toBe(0);
        expect(insertParams[17]).toBe(false);
        expect(insertParams[18]).toBe(0);
        expect(insertParams[19]).toBe(false);
    });

    it('serializes only non-empty collections and nested proposal objects into insert params', async () => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app)
            .post('/proposals')
            .send(validProposalBody({
                parentParcelIds: [],
                childParcelIds: ['HR-child-1'],
                acceptedParcelIds: ['HR-accepted-1'],
                ownerAcceptances: { alice: 'accepted' },
                roadProposal: { width: 5, type: 'primary' },
                buildingProposal: { height: 12 },
                structureProposal: { floors: 3 },
                reparcellization: { merge: true },
                parentProposals: ['parent-1'],
                childProposals: [],
                lens: ['planning', 'traffic'],
                bounds: [1, 2, 3, 4],
                onchain: { txHash: '0x1' }
            }));

        expect(res.status).toBe(201);

        const insertParams = pool.getCalls()[0].params;
        expect(insertParams[21]).toBeNull();
        expect(insertParams[22]).toBe(JSON.stringify(['HR-child-1']));
        expect(insertParams[23]).toBe(JSON.stringify(['HR-accepted-1']));
        expect(insertParams[24]).toBe(JSON.stringify({ alice: 'accepted' }));
        expect(insertParams[25]).toBe(JSON.stringify({ width: 5, type: 'primary' }));
        expect(insertParams[26]).toBe(JSON.stringify({ height: 12 }));
        expect(insertParams[27]).toBe(JSON.stringify({ floors: 3 }));
        expect(insertParams[28]).toBe(JSON.stringify({ merge: true }));
        expect(insertParams[31]).toBe(JSON.stringify(['parent-1']));
        expect(insertParams[32]).toBeNull();
        expect(insertParams[33]).toBe(JSON.stringify(['planning', 'traffic']));
        expect(insertParams[34]).toBe(JSON.stringify([1, 2, 3, 4]));
        expect(insertParams[35]).toBe(JSON.stringify({ txHash: '0x1' }));
    });

    it('falls back to snake_case currency fields when camelCase aliases are absent', async () => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app)
            .post('/proposals')
            .send(validProposalBody({
                offerCurrency: null,
                offer_currency: 'USD',
                budgetCurrency: null,
                budget_currency: 'EUR'
            }));

        expect(res.status).toBe(201);

        const insertParams = pool.getCalls()[0].params;
        expect(insertParams[9]).toBe('USD');
        expect(insertParams[11]).toBe('EUR');
    });

    it('prefers camelCase currency fields over snake_case aliases', async () => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app)
            .post('/proposals')
            .send(validProposalBody({
                offerCurrency: 'ETH',
                offer_currency: 'USD',
                budget: 42,
                budgetCurrency: 'CITY',
                budget_currency: 'EUR'
            }));

        expect(res.status).toBe(201);

        const insertParams = pool.getCalls()[0].params;
        expect(insertParams[9]).toBe('ETH');
        expect(insertParams[10]).toBe(42);
        expect(insertParams[11]).toBe('CITY');
    });

    it('rejects malformed proposal field types', async () => {
        const invalidBoolean = await request(app)
            .post('/proposals')
            .send(validProposalBody({ decayEnabled: 'true' }));

        expect(invalidBoolean.status).toBe(400);
        expect(invalidBoolean.body).toEqual({ error: 'decayEnabled must be a boolean.' });

        const invalidNumber = await request(app)
            .post('/proposals')
            .send(validProposalBody({ offer: 'not-a-number' }));

        expect(invalidNumber.status).toBe(400);
        expect(invalidNumber.body).toEqual({ error: 'offer must be a valid number.' });

        const invalidObject = await request(app)
            .post('/proposals')
            .send(validProposalBody({ roadProposal: [] }));

        expect(invalidObject.status).toBe(400);
        expect(invalidObject.body).toEqual({ error: 'roadProposal must be an object.' });

        const invalidBounds = await request(app)
            .post('/proposals')
            .send(validProposalBody({ bounds: [1, 2, 3] }));

        expect(invalidBounds.status).toBe(400);
        expect(invalidBounds.body).toEqual({ error: 'bounds must contain at least 4 items.' });

        const invalidDate = await request(app)
            .post('/proposals')
            .send(validProposalBody({ createdAt: 'not-a-date' }));

        expect(invalidDate.status).toBe(400);
        expect(invalidDate.body).toEqual({ error: 'createdAt must be a valid date.' });
    });

    it('rejects malformed identifier fields and array entries', async () => {
        const emptyIdentifier = await request(app)
            .post('/proposals')
            .send(validProposalBody({ proposalId: '   ' }));

        expect(emptyIdentifier.status).toBe(400);
        expect(emptyIdentifier.body).toEqual({ error: 'proposalId must not be empty.' });

        const nonScalarIdentifier = await request(app)
            .post('/proposals')
            .send(validProposalBody({ id: { bad: true } }));

        expect(nonScalarIdentifier.status).toBe(400);
        expect(nonScalarIdentifier.body).toEqual({ error: 'id must be a string or number.' });

        const invalidArrayEntry = await request(app)
            .post('/proposals')
            .send(validProposalBody({ parentProposals: ['parent-1', ''] }));

        expect(invalidArrayEntry.status).toBe(400);
        expect(invalidArrayEntry.body).toEqual({ error: 'parentProposals must not contain empty values.' });

        const invalidControlChars = await request(app)
            .post('/proposals')
            .send(validProposalBody({ childProposals: ['child-1', 'bad\u0000child'] }));

        expect(invalidControlChars.status).toBe(400);
        expect(invalidControlChars.body).toEqual({ error: 'childProposals contains invalid control characters.' });
    });

    it('rejects overlong and control-character identifier aliases', async () => {
        const tooLongId = await request(app)
            .post('/proposals')
            .send(validProposalBody({ proposal_id: 'a'.repeat(256) }));

        expect(tooLongId.status).toBe(400);
        expect(tooLongId.body).toEqual({ error: 'proposal_id must be at most 255 characters.' });

        const controlCharId = await request(app)
            .post('/proposals')
            .send(validProposalBody({ proposal_id: 'bad\u0000id' }));

        expect(controlCharId.status).toBe(400);
        expect(controlCharId.body).toEqual({ error: 'proposal_id contains invalid control characters.' });
    });

    it('rejects non-finite numeric identifier payloads', async () => {
        const res = await request(app)
            .post('/proposals')
            .set('Content-Type', 'application/json')
            .send('{"id":1e9999,"type":"parcel"}');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'id must be a string or number.' });
    });

    it('accepts numeric identifiers and prefers onchain over onchainData aliases', async () => {
        pool.setResults([
            insertResult({ proposal_id: '17' }),
            updateResult(),
        ]);

        const res = await request(app)
            .post('/proposals')
            .send({
                id: 17,
                type: 'parcel',
                onchainData: { contract: '0xabc' },
                onchain: { contract: '0xdef' }
            });

        expect(res.status).toBe(201);
        const insertParams = pool.getCalls()[0].params;
        expect(insertParams[0]).toBe('17');
        expect(insertParams[35]).toBe(JSON.stringify({ contract: '0xdef' }));
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
            ancestor_parcel_ids: splitParcelIds,
            descendant_parcel_ids: splitChildIds,
            road_proposal: {
                definition: roadDefinition,
                parentParcelIds: splitParcelIds,
                childParcelIds: splitChildIds,
                status: 'applied',
            },
            proposal_data: {
                goal: 'road-track',
                parentParcelIds: splitParcelIds,
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
        expect(res.body.roadProposal.childParcelIds).toEqual(splitChildIds);
        expect(res.body.parentParcelIds).toEqual(splitParcelIds);
        expect(res.body.childParcelIds).toEqual(splitChildIds);
    });

    it('returns row-backed proposal data when proposal_data is null', async () => {
        pool.setResult({
            rows: [proposalDbRow({
                proposal_data: null,
                road_proposal: { width: 5 },
                ancestor_parcel_ids: ['HR-1'],
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
            parentParcelIds: ['HR-1'],
            childParcelIds: ['HR-2'],
            parentProposals: ['parent-1'],
            childProposals: ['child-1'],
            lens: ['planning'],
            bounds: [1, 2, 3, 4],
            onchain: { txHash: '0x1' },
            onchainData: { txHash: '0x1' }
        });
    });

    it('falls back to proposal_data fields when db columns are null', async () => {
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
                ancestor_parcel_ids: null,
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
                    status: 'draft',
                    offer: 12,
                    offerCurrency: 'USD',
                    budget: 34,
                    budgetCurrency: 'EUR',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    expiresAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-01-15T00:00:00.000Z',
                    parentParcelIds: ['PARENT'],
                    childParcelIds: ['CHILD'],
                    acceptedParcelIds: ['ACCEPTED'],
                    ownerAcceptances: { alice: true },
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
            status: 'draft',
            offer: 12,
            offerCurrency: 'USD',
            budget: 34,
            budgetCurrency: 'EUR',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-02-01T00:00:00.000Z',
            updatedAt: '2026-01-15T00:00:00.000Z',
            parentParcelIds: ['PARENT'],
            childParcelIds: ['CHILD'],
            acceptedParcelIds: ['ACCEPTED'],
            ownerAcceptances: { alice: true },
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
        });
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
        expect(res.headers['x-proposal-id']).toBe('5');
        expect(res.headers['x-proposal-proposalid']).toBe('hdr-test');
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
        expect(res.headers['x-proposal-id']).toBe('5');
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

    it('returns zero when the count query yields no rows and preserves unknown city codes', async () => {
        pool.setResult({ rows: [] });

        const res = await request(app).get('/proposals/count?city=custom-city&type=road&author=bob');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            count: 0,
            city: 'custom-city',
            status: null,
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
            status: null,
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
                ancestor_parcel_ids: ['HR-1234-5678']
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
        expect(res.body.proposals[0].parentParcelIds).toEqual(['HR-1234-5678']);
        expect(res.body.proposals[0].childParcelIds).toEqual(['HR-1234-9999']);
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
                ancestor_parcel_ids: ['HR-1234-5678'],
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
            parentParcelIds: ['HR-1234-5678'],
            childParcelIds: null
        });
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
        expect(call.sql).toContain('ancestor_parcel_ids @>');
        expect(call.sql).toContain('descendant_parcel_ids @>');
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
                ancestor_parcel_ids: ['HR-1234-5678'],
                descendant_parcel_ids: ['HR-9999-0001']
            }]
        });

        const res = await request(app).get('/proposals?parcel_id=HR-1234-5678');

        expect(res.status).toBe(200);
        expect(res.body.proposals[0]).toMatchObject({
            id: 77,
            proposalId: 'row-only',
            title: 'Row title only',
            parentParcelIds: ['HR-1234-5678'],
            childParcelIds: ['HR-9999-0001']
        });
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
                        parentParcelIds: ['fallback-parent'],
                        childParcelIds: ['fallback-child']
                    }
                }),
                ancestor_parcel_ids: [],
                descendant_parcel_ids: []
            }]
        });

        const res = await request(app).get('/proposals?parcel_id=HR-1234-5678');

        expect(res.status).toBe(200);
        expect(res.body.proposals[0]).toMatchObject({
            proposalId: 'zero-values',
            offer: 0,
            budget: 0,
            parentParcelIds: [],
            childParcelIds: []
        });
    });
});
