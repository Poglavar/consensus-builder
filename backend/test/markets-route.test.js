// API contract for GET /markets (a city's contests of published agreements, each minted agreement with
// its pool) and GET /oracle/recipes/agreement-execution-v1: the city filter, the market subject (the
// PDA of the agreement's sponsor and CID), the shape, the per-city cache and BigInt-safe output. No test
// reaches a database or devnet: index rows and market accounts are injected.
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import * as web3 from '@solana/web3.js';
import { AGREEMENT_COLUMNS_SQL, DEVNET_USDC_MINT, agreementByAccount, rowToAgreement, setupMarketsRoute } from '../routes/markets.js';
import { AGREEMENT_PROGRAM_ID, agreementAccountOf } from '../agreements/onchain.js';
import { buildAgreementExecutionRecipe } from '../oracle/market-recipe.js';
import { cidOfObject } from '../cid.js';

const require = createRequire(import.meta.url);
const marketClient = require('../../frontend/js/solana/market-client.js');
marketClient.configure({ web3 });

const SPONSOR = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const STRANGER = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const CID = cidOfObject({ schema: 'agreement/v1', title: 'Plan-led infill' });
const RIVAL_CID = cidOfObject({ schema: 'agreement/v1', title: 'Rival' });
const ACCOUNT = agreementAccountOf(CID, SPONSOR);
const MARKET = marketClient.getMarketPda(ACCOUNT)[0].toBase58();
const onchain = (overrides = {}) => ({
    chain: 'solana', cluster: 'devnet', programId: AGREEMENT_PROGRAM_ID, account: ACCOUNT, sponsor: SPONSOR, status: 'active',
    decision: 'pending', observedAt: '2026-10-08T00:00:00.000Z', observedSlot: 100, ...overrides
});

// consensus.agreement rows as AGREEMENT_COLUMNS_SQL selects them.
function rows() {
    return [{
        cid: CID, city: 'zagreb', title: 'Plan-led infill', author: 'densifier-01', input_parcel_ids: ['HR-335614-2311'],
        parcel_source_id: null, deadline: new Date('2026-12-31T00:00:00Z'), sponsor: SPONSOR, design_titles: ['Six storeys', ' '],
        onchain: onchain(), screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null,
        created_at: new Date('2026-10-01T10:00:00Z')
    }, {
        cid: RIVAL_CID, city: 'zagreb', title: null, author: 'someone', input_parcel_ids: ['HR-335614-2311'],
        parcel_source_id: 'hr-cadastre', deadline: null, sponsor: null, design_titles: ['A park'],
        onchain: null, screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null,
        created_at: new Date('2026-10-02T10:00:00Z')
    }];
}

const poolFor = (agreementRows = rows()) => ({ query: vi.fn(async () => ({ rows: agreementRows })) });
const openPool = () => new Map([[ACCOUNT, { address: MARKET, market: { yesPool: 250000n, noPool: 0n, resolved: false, outcome: 0 } }]]);

function appFor({ pool, readMarkets, now } = {}) {
    const app = express();
    setupMarketsRoute(app, pool || poolFor(), {
        env: {}, readMarkets: readMarkets || (async () => openPool()),
        now: now || (() => new Date('2026-10-09T07:00:00Z'))
    });
    return app;
}

describe('GET /markets', () => {
    it('requires a city', async () => {
        const res = await request(appFor()).get('/markets');
        expect(res.status).toBe(400);
    });

    it('serves the city\'s contests, reading pools only for accounts the sponsor and CID derive', async () => {
        const pool = poolFor();
        const readMarkets = vi.fn(async () => openPool());
        const res = await request(appFor({ pool, readMarkets })).get('/markets?city=zg');
        expect(res.status).toBe(200);
        expect(pool.query.mock.calls[0][0]).toMatch(/FROM consensus\.agreement\s+WHERE city = \$1/);
        expect(pool.query.mock.calls[0][1]).toEqual(['zagreb', 2000]);
        expect(readMarkets).toHaveBeenCalledWith([ACCOUNT]);
        expect(res.body).toMatchObject({
            city: 'zagreb', cluster: 'devnet', agreementProgram: AGREEMENT_PROGRAM_ID,
            marketProgram: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', stakeMint: DEVNET_USDC_MINT, stakeDecimals: 6,
            summary: { contests: 1, agreements: 2, markets: 1, openMarkets: 1, poolAtomic: '250000' }
        });
        const [contest] = res.body.contests;
        expect(contest.agreements.map(entry => entry.cid)).toEqual([CID, RIVAL_CID]);
        expect(contest.agreements[0]).toMatchObject({
            cid: CID, account: ACCOUNT, title: 'Plan-led infill', designTitles: ['Six storeys'], status: 'active', chainStatus: 'active',
            deadline: '2026-12-31T00:00:00.000Z', bettable: true, canOpenMarket: false,
            market: { address: MARKET, yesPool: '250000', noPool: '0', poolAtomic: '250000', resolved: false, outcome: null }
        });
        // Proposed without a sponsor: never minted, so in the contest without a pool.
        expect(contest.agreements[1]).toMatchObject({ cid: RIVAL_CID, account: null, chainStatus: null, market: null, bettable: false, canOpenMarket: false });
        expect(res.headers['cache-control']).toBe('public, max-age=10');
    });

    it('caches a city for a short while and keys the cache per city; fresh=1 skips it', async () => {
        const pool = poolFor();
        let clock = Date.parse('2026-10-09T07:00:00Z');
        const app = appFor({ pool, now: () => new Date(clock) });
        await request(app).get('/markets?city=zagreb');
        await request(app).get('/markets?city=zagreb');
        expect(pool.query).toHaveBeenCalledTimes(1);
        await request(app).get('/markets?city=sibenik');
        expect(pool.query).toHaveBeenCalledTimes(2);
        // Cached for 20 seconds.
        clock += 19_999;
        await request(app).get('/markets?city=zagreb');
        expect(pool.query).toHaveBeenCalledTimes(2);
        clock += 1;
        await request(app).get('/markets?city=zagreb');
        expect(pool.query).toHaveBeenCalledTimes(3);
        // Right after a confirmed transaction the sheet needs the chain's answer, not the cache's.
        await request(app).get('/markets?city=zagreb&fresh=1');
        expect(pool.query).toHaveBeenCalledTimes(4);
    });

    it('lets the account status the lifecycle oracle observed decide whether a bet is open', async () => {
        for (const [status, open] of [['active', true], ['executed', false], ['cancelled', false], ['expired', false]]) {
            const pool = poolFor(rows().map(row => (row.onchain ? { ...row, onchain: onchain({ status }) } : row)));
            const res = await request(appFor({ pool })).get('/markets?city=zagreb');
            expect(res.body.contests[0].agreements[0], status).toMatchObject({ chainStatus: status, status, bettable: open });
        }
    });

    it('does not read a pool for an account the agreement\'s sponsor and CID do not derive', async () => {
        const readMarkets = vi.fn(async () => new Map());
        const squatted = agreementAccountOf(CID, STRANGER);
        for (const pointer of [onchain({ account: squatted }), onchain({ cluster: 'mainnet-beta' }), onchain({ chain: 'evm' })]) {
            const [row] = rows();
            const res = await request(appFor({ pool: poolFor([{ ...row, onchain: pointer }]), readMarkets })).get('/markets?city=test-city');
            expect(res.status).toBe(200);
            // No minted agreement left, so no contest.
            expect(res.body.contests).toEqual([]);
        }
        expect(readMarkets).not.toHaveBeenCalled();
    });

    it('answers 502 when the chain read fails instead of serving half a payload', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(appFor({ readMarkets: async () => { throw new Error('rpc down'); } })).get('/markets?city=zagreb');
        errorSpy.mockRestore();
        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/unavailable/);
    });
});

describe('rowToAgreement and agreementByAccount', () => {
    it('maps an index row to the contest input, with the account only when it derives', () => {
        const [row, rival] = rows();
        expect(rowToAgreement(row)).toEqual({
            cid: CID, city: 'zagreb', title: 'Plan-led infill', author: 'densifier-01', designTitles: ['Six storeys'],
            inputParcelIds: ['HR-335614-2311'], parcelSourceId: null, deadline: '2026-12-31T00:00:00.000Z',
            createdAt: '2026-10-01T10:00:00.000Z', screenshotUrl: null, screenshotBeforeUrl: null, screenshotPairUrl: null,
            account: ACCOUNT, chainStatus: 'active'
        });
        expect(rowToAgreement(rival)).toMatchObject({ title: null, account: null, chainStatus: null, deadline: null, parcelSourceId: 'hr-cadastre' });
        // An unknown status word is no status.
        expect(rowToAgreement({ ...row, onchain: onchain({ status: 'Executed' }) }).chainStatus).toBeNull();
        expect(AGREEMENT_COLUMNS_SQL).toMatch(/content->>'sponsor' AS sponsor/);
        expect(AGREEMENT_COLUMNS_SQL).toMatch(/jsonb_array_elements\(content->'designs'\)/);
    });

    it('carries the before and pair pictures beside the thumbnail', () => {
        const [row] = rows();
        expect(rowToAgreement({ ...row, screenshot_url: '/uploads/images/t.png', screenshot_before_url: '/uploads/images/b.png', screenshot_pair_url: '/uploads/images/p.png' }))
            .toMatchObject({ screenshotUrl: '/uploads/images/t.png', screenshotBeforeUrl: '/uploads/images/b.png', screenshotPairUrl: '/uploads/images/p.png' });
    });

    it('finds the minted agreement of an account, never a row that only claims it', async () => {
        const [row] = rows();
        const claimed = { ...row, cid: RIVAL_CID };
        const pool = { query: vi.fn(async () => ({ rows: [claimed, row] })) };
        expect(await agreementByAccount(pool, ACCOUNT)).toMatchObject({ cid: CID, account: ACCOUNT });
        expect(pool.query.mock.calls[0][0]).toMatch(/WHERE onchain->>'account' = \$1/);
        expect(pool.query.mock.calls[0][1]).toEqual([ACCOUNT]);
        expect(await agreementByAccount({ query: async () => ({ rows: [claimed] }) }, ACCOUNT)).toBeNull();
    });
});

describe('GET /oracle/recipes/agreement-execution-v1', () => {
    const recipeApp = (agreementRows = [rows()[0]]) => {
        const pool = { query: vi.fn(async (sql, params) => ({ rows: params[0] === ACCOUNT ? agreementRows : [] })) };
        return { app: appFor({ pool }), pool };
    };

    it('serves the recipe of a minted agreement, with its CID from the index and its market when given', async () => {
        const { app } = recipeApp();
        const plain = await request(app).get(`/oracle/recipes/agreement-execution-v1?agreement=${ACCOUNT}`);
        expect(plain.status).toBe(200);
        expect(plain.body.recipe).toEqual(buildAgreementExecutionRecipe({ agreementAccount: ACCOUNT, agreementCid: CID }));
        const withMarket = await request(app).get(`/oracle/recipes/agreement-execution-v1?agreement=${ACCOUNT}&market=${MARKET}`);
        expect(withMarket.body.recipe.subject).toEqual({ chain: 'solana:devnet', agreementAccount: ACCOUNT, agreementCid: CID, marketAccount: MARKET });
        expect(withMarket.body.recipe.hash).not.toBe(plain.body.recipe.hash);
    });

    it('answers 400 for an account that is not canonical base58, or a market that is not the agreement\'s pool', async () => {
        const { app, pool } = recipeApp();
        for (const query of ['', '?agreement=not-an-account', `?agreement=${ACCOUNT.toLowerCase()}`]) {
            const res = await request(app).get(`/oracle/recipes/agreement-execution-v1${query}`);
            expect(res.status, query).toBe(400);
            expect(res.body.error).toBe('agreement must be a Solana address');
        }
        const wrongMarket = await request(app).get(`/oracle/recipes/agreement-execution-v1?agreement=${ACCOUNT}&market=${STRANGER}`);
        expect(wrongMarket.status).toBe(400);
        expect(wrongMarket.body).toEqual({ error: "market must be the agreement's market account", expected: MARKET });
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('answers 404 for an account no minted agreement has, and 500 when the index fails', async () => {
        const other = agreementAccountOf(RIVAL_CID, SPONSOR);
        const missing = await request(recipeApp().app).get(`/oracle/recipes/agreement-execution-v1?agreement=${other}`);
        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe('No minted agreement has this account.');
        const failing = express();
        setupMarketsRoute(failing, { query: async () => { throw new Error('index down'); } }, { env: {}, readMarkets: async () => new Map() });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(failing).get(`/oracle/recipes/agreement-execution-v1?agreement=${ACCOUNT}`);
        errorSpy.mockRestore();
        expect(res.status).toBe(500);
    });
});
