import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupDocsRoute } from '../routes/docs.js';
import { createRouteApp } from './helpers/create-route-app.js';

afterEach(() => {
    vi.restoreAllMocks();
});

function createDocsPool() {
    const calls = [];
    const client = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql.includes('FROM information_schema.tables')) {
                return {
                    rows: [{ table_name: 'parcel', table_comment: 'Parcel table' }],
                    rowCount: 1
                };
            }
            if (sql.includes('FROM information_schema.columns')) {
                return {
                    rows: [{
                        column_name: 'id',
                        data_type: 'integer',
                        is_nullable: 'NO',
                        column_default: null,
                        character_maximum_length: null,
                        numeric_precision: 32,
                        numeric_scale: 0,
                        column_comment: null
                    }],
                    rowCount: 1
                };
            }
            if (sql.includes('FROM information_schema.table_constraints')) {
                return { rows: [], rowCount: 0 };
            }
            if (sql.includes('FROM pg_indexes')) {
                return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
        },
        release() { }
    };

    return {
        calls,
        async connect() {
            return client;
        }
    };
}

async function loadFreshDocsRoute() {
    vi.resetModules();
    return import('../routes/docs.js');
}

describe('GET /docs', () => {
    it('renders the markdown documentation as html', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool());

        const res = await request(app).get('/docs');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.text).toContain('<title>Consensus Builder API Documentation</title>');
        expect(res.text).toContain('GET /docs/database');
    });

    it('replaces date placeholders in rendered markdown', async () => {
        vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('03/28/2026');
        vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
            if (String(filePath).endsWith('docs.md')) {
                return '# Updated $(date)';
            }
            return fs.readFileSync.wrappedMethod.call(fs, filePath, encoding);
        });

        const app = createRouteApp(setupDocsRoute, createDocsPool());
        const res = await request(app).get('/docs');

        expect(res.status).toBe(200);
        expect(res.text).toContain('Updated 03/28/2026');
    });

    it('returns 500 when markdown documentation cannot be read', async () => {
        vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
            if (String(filePath).endsWith('docs.md')) {
                throw new Error('docs missing');
            }
            return fs.readFileSync.wrappedMethod.call(fs, filePath, encoding);
        });

        const app = createRouteApp(setupDocsRoute, createDocsPool());
        const res = await request(app).get('/docs');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: 'Failed to load documentation'
        });
    });
});

describe('GET /docs/api', () => {
    it('returns the api schema json', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool());

        const res = await request(app).get('/docs/api');

        expect(res.status).toBe(200);
        expect(res.body.title).toBe('Consensus Builder API Schema');
        expect(res.body.definitions).toHaveProperty('PostGISGeometry');
    });

    it('returns 500 when the api schema cannot be loaded', async () => {
        vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
            if (String(filePath).endsWith('api-schema.json')) {
                throw new Error('schema missing');
            }
            return fs.readFileSync.wrappedMethod.call(fs, filePath, encoding);
        });

        const app = createRouteApp(setupDocsRoute, createDocsPool());
        const res = await request(app).get('/docs/api');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: 'Failed to load API schema'
        });
    });

    it('returns 500 when the api schema contains invalid json', async () => {
        vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
            if (String(filePath).endsWith('api-schema.json')) {
                return '{bad json';
            }
            return fs.readFileSync.wrappedMethod.call(fs, filePath, encoding);
        });

        const app = createRouteApp(setupDocsRoute, createDocsPool());
        const res = await request(app).get('/docs/api');

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to load API schema');
    });
});

describe('GET /docs/database', () => {
    it('returns generated database schema json', async () => {
        const pool = createDocsPool();
        const { setupDocsRoute: freshSetupDocsRoute } = await loadFreshDocsRoute();
        const app = createRouteApp(freshSetupDocsRoute, pool);

        const res = await request(app).get('/docs/database');

        expect(res.status).toBe(200);
        expect(res.body.title).toBe('Consensus Builder Database Schema');
        expect(res.body.tables).toHaveProperty('parcel');
        expect(res.body.tables.parcel.columns).toHaveProperty('id');
    });

    it('includes constraint and index metadata and releases the db client', async () => {
        const { setupDocsRoute: freshSetupDocsRoute } = await loadFreshDocsRoute();
        const release = vi.fn();
        const client = {
            async query(sql, params) {
                if (sql.includes('FROM information_schema.tables')) {
                    return {
                        rows: [{ table_name: 'proposal', table_comment: 'Proposal table' }],
                        rowCount: 1
                    };
                }
                if (sql.includes('FROM information_schema.columns')) {
                    return {
                        rows: [{
                            column_name: 'budget',
                            data_type: 'numeric',
                            is_nullable: 'NO',
                            column_default: '0',
                            character_maximum_length: null,
                            numeric_precision: 12,
                            numeric_scale: 2,
                            column_comment: 'Available budget'
                        }],
                        rowCount: 1
                    };
                }
                if (sql.includes('FROM information_schema.table_constraints')) {
                    return {
                        rows: [{
                            constraint_name: 'proposal_parent_id_fkey',
                            constraint_type: 'FOREIGN KEY',
                            column_name: 'parent_id',
                            foreign_table_name: 'proposal',
                            foreign_column_name: 'id'
                        }],
                        rowCount: 1
                    };
                }
                if (sql.includes('FROM pg_indexes')) {
                    return {
                        rows: [{
                            indexname: 'proposal_budget_idx',
                            indexdef: 'CREATE INDEX proposal_budget_idx ON proposal (budget)'
                        }],
                        rowCount: 1
                    };
                }
                return { rows: [], rowCount: 0 };
            },
            release
        };
        const pool = {
            async connect() {
                return client;
            }
        };
        const app = createRouteApp(freshSetupDocsRoute, pool);

        const res = await request(app).get('/docs/database');

        expect(res.status).toBe(200);
        expect(res.body.tables.proposal.columns.budget).toEqual({
            type: 'numeric',
            nullable: false,
            default: '0',
            comment: 'Available budget',
            precision: 12,
            scale: 2
        });
        expect(res.body.tables.proposal.constraints['FOREIGN KEY']).toEqual([
            {
                name: 'proposal_parent_id_fkey',
                column: 'parent_id',
                references: {
                    table: 'proposal',
                    column: 'id'
                }
            }
        ]);
        expect(res.body.tables.proposal.indexes).toEqual({
            proposal_budget_idx: {
                definition: 'CREATE INDEX proposal_budget_idx ON proposal (budget)'
            }
        });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('serves cached database schema when refresh fails after a successful load', async () => {
        const { setupDocsRoute: freshSetupDocsRoute } = await loadFreshDocsRoute();
        const warmPool = createDocsPool();
        const warmApp = createRouteApp(freshSetupDocsRoute, warmPool);
        const warmRes = await request(warmApp).get('/docs/database');

        expect(warmRes.status).toBe(200);

        const failingPool = {
            async connect() {
                throw new Error('db offline');
            }
        };
        const app = createRouteApp(freshSetupDocsRoute, failingPool);

        const res = await request(app).get('/docs/database');

        expect(res.status).toBe(200);
        expect(res.body).toEqual(warmRes.body);
    });

    it('reuses the warm cache without reconnecting while the cache is fresh', async () => {
        const { setupDocsRoute: freshSetupDocsRoute } = await loadFreshDocsRoute();
        const pool = createDocsPool();
        const connectSpy = vi.spyOn(pool, 'connect');
        const app = createRouteApp(freshSetupDocsRoute, pool);

        const first = await request(app).get('/docs/database');
        const second = await request(app).get('/docs/database');

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when schema generation fails and no cache exists', async () => {
        const { setupDocsRoute: freshSetupDocsRoute } = await loadFreshDocsRoute();
        const failingPool = {
            async connect() {
                throw new Error('db unavailable');
            }
        };
        const app = createRouteApp(freshSetupDocsRoute, failingPool);

        const res = await request(app).get('/docs/database');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: 'Failed to load database schema'
        });
    });
});

describe('agent quickstart docs', () => {
    const X402_ENV = {
        PUBLIC_API_BASE_URL: 'https://api.example.test',
        X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        X402_FACILITATOR_URL: 'https://x402.org/facilitator',
        X402_PAY_TO: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ',
        X402_PRICE_PROPOSAL: '$0.05',
        X402_PRICE_ORACLE_FACT: '$0.01'
    };

    it('GET /docs/agents renders the quickstart with the live price and base URL substituted', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool(), { env: X402_ENV });
        const res = await request(app).get('/docs/agents');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.text).toContain('<title>Agent quickstart');
        expect(res.text).toContain('$0.05');
        expect(res.text).toContain('$0.01');
        expect(res.text).toContain('https://api.example.test/agent/proposals');
        expect(res.text).toContain('https://api.example.test/agent/oracle/facts');
        expect(res.text).toContain('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
        expect(res.text).not.toContain('$(base)');
        expect(res.text).not.toContain('$(price)');
    });

    it('GET /docs/agents says when the price is not configured instead of printing a placeholder', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool(), { env: { PUBLIC_API_BASE_URL: 'https://api.example.test' } });
        const res = await request(app).get('/docs/agents');
        expect(res.status).toBe(200);
        expect(res.text).toContain('price not configured');
        expect(res.text).not.toContain('$(price)');
    });

    it('GET /docs/agents.json returns the recipe schema with the live x402 terms and endpoints', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool(), { env: X402_ENV });
        const res = await request(app).get('/docs/agents.json');
        expect(res.status).toBe(200);
        expect(res.body.schema.required).toEqual(['cadastreParcelIds']);
        expect(res.body.schema.properties.cadastreParcelIds.minItems).toBe(1);
        expect(res.body.x402).toMatchObject({
            enabled: true,
            network: X402_ENV.X402_NETWORK,
            payTo: X402_ENV.X402_PAY_TO,
            priceProposal: '$0.05',
            oracleFactsEnabled: true,
            priceOracleFact: '$0.01',
            paymentFlow: 'upfront'
        });
        expect(res.body.endpoints.submit).toBe('https://api.example.test/agent/proposals');
        expect(res.body.endpoints.oracleFact).toContain('/agent/oracle/facts?subject=');
        expect(res.body.endpoints.oracleFactDiscovery).toContain('resource=oracle-facts');
        expect(res.body.mcp).toMatchObject({
            transport: 'stdio', source: 'backend/agents/mcp-server.mjs', liveActionsEnabledByDefault: false
        });
        expect(res.body.mcp.tools).toEqual(expect.arrayContaining([
            'ugt_submit_proposal', 'ugt_pledge', 'ugt_donate', 'ugt_forecast', 'ugt_buy_verified_fact'
        ]));
        expect(res.body.market.programId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
        expect(res.body.proposalSupport).toMatchObject({
            programId: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
            cluster: 'devnet',
            status: 'https://api.example.test/agent/pledges/{proposalAccount}'
        });
        expect(res.body.proposalSupport.donations.active).toMatch(/escrow immediately/);
        expect(res.body.proposalSupport.pledges.active).toMatch(/unfunded/);
        expect(res.body.market.resolution).toMatchObject({
            yes: expect.stringMatching(/Executed/),
            no: expect.stringMatching(/Cancelled/),
            permissionless: true,
            deadline: null
        });
        expect(res.body.market.resolution.expired).toMatch(/not terminal/);
        expect(res.body.oracle.schema).toBe('https://api.example.test/oracle/recipe.schema.json');
        expect(res.body.oracle.externalMarket).toMatchObject({
            status: 'live_devnet',
            recipeId: 'court-parcel-operation-v1',
            verification: expect.stringContaining('direct SAS account'),
            proofMarket: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
            proofResolution: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
            proofClaim: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
            proof: expect.objectContaining({
                recipeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                attestation: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
                evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                yesStakeAtomic: '10000', noStakeAtomic: '10000', payoutAtomic: '20000', decimals: 6,
                chronology: expect.objectContaining({
                    classification: 'retrospective_integration', prospective: false,
                    marketOrderValid: true, attestationAfterClose: false
                })
            })
        });
        expect(res.body.oracle.externalMarket.prospectiveProof).toMatchObject({
            status: 'awaiting_post_close_evidence',
            recipeId: 'court-parcel-operation-v2',
            recipe: expect.stringContaining('/oracle/recipes/court-parcel-operation-v2'),
            schema: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
            schemaRegistration: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
            marketProgramUpgrade: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
            temporalGuard: expect.stringContaining('sourceObservedAt'),
            requirement: expect.stringContaining('open a market before its evidence exists')
        });
        expect(res.body.market.externalResolution).toMatchObject({
            status: 'live_devnet', account: 'ExternalMarket',
            proofMarket: res.body.oracle.externalMarket.proofMarket
        });
        expect(res.body.docs).toBe('https://api.example.test/docs/agents');
    });

    it('the /docs page links to the agent quickstart', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool(), { env: X402_ENV });
        const res = await request(app).get('/docs');
        expect(res.status).toBe(200);
        expect(res.text).toContain('href="/docs/agents"');
    });
});
