import fs from 'fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // The schema names its database from DATABASE_URL (see db/connection.cjs); the password never leaves it.
    beforeEach(() => vi.stubEnv('DATABASE_URL', 'postgres://docs_user:docs_pw@localhost:5432/geodata'));
    afterEach(() => vi.unstubAllEnvs());

    it('returns generated database schema json', async () => {
        const pool = createDocsPool();
        const { setupDocsRoute: freshSetupDocsRoute } = await loadFreshDocsRoute();
        const app = createRouteApp(freshSetupDocsRoute, pool);

        const res = await request(app).get('/docs/database');

        expect(res.status).toBe(200);
        expect(res.body.title).toBe('Consensus Builder Database Schema');
        expect(res.body.database).toBe('geodata');
        expect(JSON.stringify(res.body)).not.toContain('docs_pw');
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
    const repoFile = (relative) => new URL(`../../${relative}`, import.meta.url);
    const PROGRAMS = JSON.parse(fs.readFileSync(repoFile('frontend/contracts/addresses.json'), 'utf8'))['solana-devnet'];
    const AGREEMENT_IDL = JSON.parse(fs.readFileSync(repoFile('blockchain/solana/idl/agreement.json'), 'utf8'));
    // The program ids the page fills in come from the program codecs.
    const require = createRequire(import.meta.url);
    const PROGRAM_IDS = {
        agreement: require('../../frontend/js/solana/agreement-client.js').constants.AGREEMENT_PROGRAM_ID,
        market: require('../../frontend/js/solana/market-client.js').constants.PROGRAM_ID,
        pledge: require('../../frontend/js/solana/pledge-client.js').constants.PROGRAM_ID
    };
    const X402_ENV = {
        PUBLIC_API_BASE_URL: 'https://api.example.test',
        X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        X402_FACILITATOR_URL: 'https://x402.org/facilitator',
        X402_PAY_TO: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ',
        X402_PRICE_ORACLE_FACT: '$0.01'
    };
    // The IDL's own spelling of an argument type, as the docs print it.
    const typeName = type => (typeof type === 'string' ? type
        : type.vec !== undefined ? `vec<${typeName(type.vec)}>`
            : Array.isArray(type.array) ? `[${typeName(type.array[0])}; ${type.array[1]}]` : `option<${typeName(type.option)}>`);

    it('GET /docs/agents renders the quickstart with every placeholder substituted', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool(), { env: X402_ENV });
        const res = await request(app).get('/docs/agents');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.text).toContain('<title>Agent quickstart');
        // No $(base), $(oraclePrice), $(agreementProgram), … survives into the page.
        expect(res.text).not.toMatch(/\$\([a-zA-Z]+\)/);
        expect(res.text).toContain('<strong>$0.01</strong> in devnet USDC');
        expect(res.text).toContain('https://api.example.test/agent/oracle/facts?subject=');
        expect(res.text).toContain('https://api.example.test/designs/binding');
        expect(res.text).toContain('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
        expect(res.text).toContain(`on <code>${X402_ENV.X402_NETWORK}</code>`);
    });

    it('GET /docs/agents documents publishing, then minting a binding agreement, with the program ids filled in', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool(), { env: X402_ENV });
        const res = await request(app).get('/docs/agents');
        const headings = [...res.text.matchAll(/<h2>([^<]*)<\/h2>/g)].map(match => match[1]);
        expect(headings).toEqual(expect.arrayContaining(['3. Build and publish a design', '5. Propose it', '6. Mint and fund it on devnet']));
        expect(headings.indexOf('3. Build and publish a design')).toBeLessThan(headings.indexOf('5. Propose it'));
        expect(headings.indexOf('5. Propose it')).toBeLessThan(headings.indexOf('6. Mint and fund it on devnet'));
        expect(res.text).toContain(PROGRAM_IDS.agreement);
        expect(res.text).toContain(PROGRAM_IDS.market);
        expect(res.text).toContain(PROGRAM_IDS.pledge);
        expect(res.text).toContain(PROGRAMS.ParcelNFT);
        // The agreement program is not deployed while its id is the readable placeholder, and the page says so.
        expect(res.text.includes('pending its devnet deployment')).toBe(/^Agreement1+$/.test(PROGRAM_IDS.agreement));
        // create's documented signature is the checked-in IDL's.
        const create = AGREEMENT_IDL.instructions.find(ix => ix.name === 'create');
        expect(res.text).toContain(`create(${create.args.map(arg => `${arg.name}: ${typeName(arg.type)}`).join(', ')})`);
        expect(res.text).toContain('/agreements/&lt;cid&gt;/onchain');
        expect(res.text).toContain('AgreementDecision-v1');
        expect(res.text).toContain('agreement-execution-v1');
        expect(res.text).toContain('Choosing a lens');
        expect(res.text).toContain('https://api.example.test/agent/lenses/members');
        expect(res.text).toContain('https://api.example.test/lenses/schemas');
        expect(res.text).toMatch(/<code>owner-consent<\/code>,\s+<code>court<\/code>, <code>permit<\/code>, <code>imagery<\/code>, <code>osm<\/code> or <code>lifecycle<\/code>/);
        // The proposal program's instructions are gone from the quickstart (M3: designs are not minted).
        for (const removed of ['mint_and_fund', 'accept_with_attestations', 'settle_with_verdict', 'verdict_may_execute', 'ProposalVerdict']) {
            expect(res.text, removed).not.toContain(removed);
        }
    });

    it('GET /docs/agents says when the price is not configured instead of printing a placeholder', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool(), { env: { PUBLIC_API_BASE_URL: 'https://api.example.test' } });
        const res = await request(app).get('/docs/agents');
        expect(res.status).toBe(200);
        expect(res.text).toContain('price not configured');
        expect(res.text).not.toMatch(/\$\([a-zA-Z]+\)/);
    });

    it('GET /docs/agents.json returns the design and agreement schemas, the flow and the live x402 terms', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool(), { env: X402_ENV });
        const res = await request(app).get('/docs/agents.json');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body.docs).toBe('https://api.example.test/docs/agents');
        // The schema is the two published objects, checked as the server checks them.
        expect(res.body.schema.oneOf).toEqual([{ $ref: '#/$defs/design' }, { $ref: '#/$defs/agreement' }]);
        expect(res.body.schema.$defs.design.required).toEqual(expect.arrayContaining(['schema', 'goal', 'site', 'toleranceM', 'origin', 'authoredAt']));
        expect(res.body.schema.$defs.agreement.properties).toHaveProperty('sponsor');
        expect(res.body.schema.$defs.agreement.required).toContain('planCid');
        expect(res.body.schema.$defs.agreement.required).not.toContain('designs');
        expect(res.body.schema.$defs.agreement.properties).not.toHaveProperty('designs');
        expect(res.body.schema.$defs.agreement.properties.rule.required).toEqual(['electorate', 'binding', 'lens', 'settlement']);
        expect(JSON.stringify(res.body.schema.$defs.agreement.properties.allocations)).not.toContain('joint');
        expect(res.body.schema.$defs.agreement.properties.rule.properties.settlement).toBeDefined();
        // The one paid resource, queried by agreement account.
        expect(res.body.x402).toMatchObject({
            enabled: true,
            resource: 'https://api.example.test/agent/oracle/facts',
            network: X402_ENV.X402_NETWORK,
            payTo: X402_ENV.X402_PAY_TO,
            priceOracleFact: '$0.01',
            paymentFlow: 'upfront',
            usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
        });
        expect(Object.keys(res.body.x402.query)).toEqual(['subject', 'market']);
        expect(res.body.x402.query.subject).toMatch(/agreement account/);
        expect(res.body.x402).not.toHaveProperty('priceProposal');
        // The flow, in order: bind, publish designs, propose the agreement, stop at a poll or mint a binding one.
        expect(res.body.flow).toHaveLength(6);
        expect(res.body.flow[0]).toMatch(/^POST \/designs\/binding/);
        expect(res.body.flow[1]).toMatch(/^POST \/designs \{ cid, content \}/);
        expect(res.body.flow[2]).toMatch(/^POST \/agreements \{ cid, content, designs\? \}/);
        // Publishing pins nothing: no step of the flow asks for POST /pins.
        expect(res.body.flow.join('\n')).not.toContain('/pins');
        expect(res.body.writes).toMatchObject({
            origin: expect.stringMatching(/^POST \/designs, \/plans, \/agreements, /),
            uploadLimit: 'POST /plans and /pins: 30 per 15 minutes per client; a 429 carries retryAfterSeconds'
        });
        expect(res.body.writes).not.toHaveProperty('pinLimit');
        expect(res.body.flow[3]).toMatch(/never minted/);
        expect(res.body.flow[4]).toMatch(/POST \/agreements\/\{cid\}\/onchain/);
        expect(res.body.flow[5]).toMatch(/AgreementDecision-v1/);
        // Endpoints: the publish and read routes, the market recipe and the paid fact by agreement account.
        expect(res.body.endpoints).toMatchObject({
            designBinding: 'https://api.example.test/designs/binding',
            pins: 'https://api.example.test/pins',
            publishDesign: 'https://api.example.test/designs',
            proposeAgreement: 'https://api.example.test/agreements',
            agreementDecisions: 'https://api.example.test/agreements/{cid}/decisions',
            agreementOnchain: 'https://api.example.test/agreements/{cid}/onchain',
            markets: 'https://api.example.test/markets?city={city}',
            marketRecipe: 'https://api.example.test/oracle/recipes/agreement-execution-v1?agreement={agreementAccount}',
            marketRecipeForMarket: 'https://api.example.test/oracle/recipes/agreement-execution-v1?agreement={agreementAccount}&market={marketAccount}',
            oracleFact: 'https://api.example.test/agent/oracle/facts?subject={agreementAccount}',
            oracleFactForMarket: 'https://api.example.test/agent/oracle/facts?subject={agreementAccount}&market={marketAccount}',
            oracleFactLatest: 'https://api.example.test/agent/oracle/facts',
            oracleFactDiscovery: 'https://api.example.test/agent/discovery?resource=oracle-facts',
            support: 'https://api.example.test/agent/pledges/{agreementAccount}',
            hackathonProof: 'https://api.example.test/hackathon/proof.json',
            prospectiveMarketStatus: 'https://api.example.test/oracle/markets/prospective/status',
            lensMembers: 'https://api.example.test/lenses/members',
            agentLensMembers: 'https://api.example.test/agent/lenses/members',
            lensSchemas: 'https://api.example.test/lenses/schemas'
        });
        // The proposal routes, the paid submit route and the proposal program are gone.
        expect(JSON.stringify(res.body.endpoints)).not.toMatch(/\/proposals|\/agent\/(proposals|binding|prepare)\b/);
        for (const removed of ['proposalAccount', 'parcelAccount', 'proposalSupport']) expect(res.body).not.toHaveProperty(removed);
        // Only a binding owners' agreement is minted.
        expect(res.body.agreement.rules).toEqual({
            ownerDeal: { electorate: 'owners', binding: true },
            ownerVote: { electorate: 'owners', binding: false },
            communityVote: { electorate: 'community', binding: false, approvalConfig: null }
        });
        expect(res.body.agreement.minting).toMatch(/binding owners' agreements only/);
        expect(res.body.design.types.parcelLayout).toMatchObject({ goals: ['parcel-layout'], payload: 'parcelLayout' });
        expect(res.body.mcp).toMatchObject({
            transport: 'streamable-http', source: 'backend/agents/mcp-server.mjs', liveActionsEnabledByDefault: false
        });
        // The advertised list must match exactly what the MCP server registers.
        const mcpSource = fs.readFileSync(new URL('../agents/mcp-server.mjs', import.meta.url), 'utf8');
        const registrations = fs.readFileSync(repoFile('backend/agents/mcp-server.mjs'), 'utf8')
            + fs.readFileSync(repoFile('backend/agents/mcp-companion.mjs'), 'utf8');
        const registered = [...new Set([...registrations.matchAll(/(?:registerTool|add)\('(ugt_[a-z_]+)'/g)].map(match => match[1]))];
        expect(registered.length).toBeGreaterThan(32);
        expect([...res.body.mcp.tools].sort()).toEqual([...registered].sort());
        expect(res.body.lens).toMatchObject({
            ruleField: 'rule.lens',
            schemas: 'https://api.example.test/lenses/schemas',
            attestations: ['ParcelOwnership-v1', 'AgreementDecision-v1', 'MarketEvidence-v1'],
            memberKinds: ['owner-consent', 'court', 'permit', 'imagery', 'osm', 'lifecycle']
        });
        expect(res.body.lens.memberFields).toContain('serviceUrl');
    });

    it('GET /docs/agents.json documents the agreement program from its checked-in IDL and codec', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool(), { env: X402_ENV });
        const { body } = await request(app).get('/docs/agents.json');
        const program = body.agreementProgram;
        expect(program).toMatchObject({
            programId: AGREEMENT_IDL.address,
            cluster: 'devnet',
            idl: 'blockchain/solana/idl/agreement.json',
            client: 'frontend/js/solana/agreement-client.js',
            readme: 'blockchain/solana/programs/agreement/README.md'
        });
        for (const file of [program.idl, program.client, program.readme]) expect(fs.existsSync(repoFile(file)), file).toBe(true);
        expect(program.deployed).toBe(!/^Agreement1+$/.test(program.programId));
        expect(program.status).toMatch(program.deployed ? /^deployed on devnet$/ : /placeholder/);
        expect(program.account).toMatchObject({ space: 296, offsets: { authority: 8, lens: 40, payout: 72, deadline: 104, status: 136, decision: 138, cid: 228 } });
        // Every instruction is documented with the IDL's own argument list and account order.
        expect(Object.keys(program.instructions).sort()).toEqual(AGREEMENT_IDL.instructions.map(ix => ix.name).sort());
        for (const ix of AGREEMENT_IDL.instructions) {
            const doc = program.instructions[ix.name];
            expect(doc.args, ix.name).toEqual(ix.args.map(arg => `${arg.name}: ${typeName(arg.type)}`));
            expect(doc.accounts.map(account => account.split(' ')[0]), ix.name).toEqual(ix.accounts.map(account => account.name));
        }
        expect(program.decisionAttestation).toMatchObject({
            schema: 'AgreementDecision-v1',
            layout: 'string agreementCid, string sponsor, string decision, string evidenceRef, int64 sourceObservedAt',
            sasLayout: [12, 12, 12, 12, 8]
        });
        expect(program.decisionAttestation.decision).toMatch(/always "satisfied"/);
    });

    it('GET /docs/agents.json names the market recipe, the land events and the support program on agreement accounts', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool(), { env: X402_ENV });
        const { body } = await request(app).get('/docs/agents.json');
        expect(body.oracle).toMatchObject({
            eventType: 'agreement_lifecycle',
            schema: 'https://api.example.test/oracle/recipe.schema.json',
            events: 'https://api.example.test/oracle/events?subject={agreementAccount}',
            recipeId: 'agreement-execution-v1',
            attester: AGREEMENT_IDL.address
        });
        expect(Object.keys(body.oracle.eventTypes)).toEqual(['agreement_lifecycle', 'agreement_executed']);
        expect(body.oracle.recipe.outcomes).toEqual({ executed: 'YES', cancelled: 'NO', expired: 'NO' });
        expect(body.oracle.recipe.url).toBe('https://api.example.test/oracle/recipes/agreement-execution-v1?agreement={agreementAccount}');
        expect(body.oracle.parcelHistory.eventTypes).toEqual(['agreement_published', 'parcel_ownership', 'agreement_executed']);
        expect(body.oracle.parcelHistory.url).toBe('https://api.example.test/parcels/{parcelUid}/history');
        expect(body.market).toMatchObject({
            programId: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
            pda: 'seeds ["market", agreementAccount]',
            stakeDecimals: 6,
            contests: 'https://api.example.test/markets?city={city}',
            resolution: { yes: expect.stringMatching(/Executed/), no: expect.stringMatching(/Cancelled or Expired/), permissionless: true, oracleRecipe: 'agreement-execution-v1' }
        });
        expect(body.support).toMatchObject({
            status: 'https://api.example.test/agent/pledges/{agreementAccount}',
            pdas: { donationEscrow: 'seeds ["donation_escrow", agreementAccount]', pledgeBook: 'seeds ["pledge_book", agreementAccount]' }
        });
        expect(body.support.donations.active).toMatch(/escrow immediately/);
        expect(body.support.pledges.active).toMatch(/unfunded/);
        // The court-evidence markets are unchanged by M3.
        expect(body.oracle.externalMarket).toMatchObject({
            status: 'live_devnet',
            recipeId: 'court-parcel-operation-v1',
            verification: expect.stringContaining('direct SAS account'),
            proofMarket: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
            proof: expect.objectContaining({
                yesStakeAtomic: '10000', noStakeAtomic: '10000', payoutAtomic: '20000', decimals: 6,
                chronology: expect.objectContaining({ classification: 'retrospective_integration', prospective: false, marketOrderValid: true, attestationAfterClose: false })
            })
        });
        expect(body.oracle.externalMarket.prospectiveProof).toMatchObject({
            status: 'market_open_awaiting_post_close_evidence',
            recipeId: 'court-parcel-operation-v2',
            recipe: expect.stringContaining('/oracle/recipes/court-parcel-operation-v2'),
            temporalGuard: expect.stringContaining('sourceObservedAt')
        });
        expect(body.market.externalResolution).toMatchObject({ status: 'live_devnet', account: 'ExternalMarket', proofMarket: body.oracle.externalMarket.proofMarket });
    });

    it('the /docs page links to the agent quickstart', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool(), { env: X402_ENV });
        const res = await request(app).get('/docs');
        expect(res.status).toBe(200);
        expect(res.text).toContain('href="/docs/agents"');
    });
});
