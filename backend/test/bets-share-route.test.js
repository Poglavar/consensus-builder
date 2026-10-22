// GET /bets/:account: the link preview for one agreement's bet, found by its chain account in the
// index (`onchain.account`, kept only when the agreement's sponsor and CID derive it), and the hand-over
// to the app. No test reaches a database or devnet: index rows and the market account are injected.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { describeRow, escapeHtml, setupBetsShareRoute } from '../routes/bets-share.js';
import { AGREEMENT_PROGRAM_ID, agreementAccountOf } from '../agreements/onchain.js';
import { cidOfObject } from '../cid.js';

const SPONSOR = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const STRANGER = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const CID = cidOfObject({ schema: 'agreement/v1', title: 'Plan-led infill' });
const ACCOUNT = agreementAccountOf(CID, SPONSOR);
const OTHER = agreementAccountOf(CID, STRANGER);

// A consensus.agreement row as the by-account query selects it (routes/markets.js AGREEMENT_COLUMNS_SQL).
function row(overrides = {}) {
    return {
        cid: CID, city: 'zagreb', title: 'Plan-led infill in <Rudeš> & "more"', author: 'densifier-01',
        input_parcel_ids: ['HR-335614-2309/2'], parcel_source_id: null, deadline: new Date('2026-12-31T00:00:00Z'), sponsor: SPONSOR,
        design_titles: ['Six storeys'], screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null,
        onchain: { chain: 'solana', cluster: 'devnet', programId: AGREEMENT_PROGRAM_ID, account: ACCOUNT, sponsor: SPONSOR, status: 'active', observedSlot: 7 },
        created_at: new Date('2026-10-09T11:11:00Z'),
        ...overrides
    };
}

function appFor({ rows = [row()], market = { yesPool: 250000n, noPool: 50000n, resolved: false, outcome: 0 }, env = {} } = {}) {
    const app = express();
    const pool = { query: vi.fn(async (sql, params) => ({ rows: params[0] === ACCOUNT ? rows : [] })) };
    const readMarkets = vi.fn(async () => new Map([[ACCOUNT, { address: 'MKT', market }]]));
    setupBetsShareRoute(app, pool, { env, readMarkets, now: () => new Date('2026-10-09T12:00:00Z') });
    return { app, pool, readMarkets };
}

const meta = (html, property) => {
    const match = html.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)">`));
    return match ? match[1] : null;
};
const withStatus = status => row({ onchain: { ...row().onchain, status } });

describe('GET /bets/:account', () => {
    it('previews an open pool with the agreement\'s question, chance, pool and payouts, and hands over to the app form', async () => {
        const { app, pool, readMarkets } = appFor();
        const res = await request(app).get(`/bets/${ACCOUNT}?city=zg&lang=hr`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.headers['cache-control']).toBe('public, max-age=60');
        expect(pool.query.mock.calls[0][0]).toMatch(/FROM consensus\.agreement\s+WHERE onchain->>'account' = \$1/);
        expect(pool.query.mock.calls[0][1]).toEqual([ACCOUNT]);
        expect(readMarkets).toHaveBeenCalledWith([ACCOUNT]);
        expect(meta(res.text, 'og:title')).toBe('Will Plan-led infill in &lt;Rudeš&gt; &amp; &quot;more&quot; execute on-chain? · Bet on cities');
        expect(meta(res.text, 'og:description')).toBe('Yes: 83.3% of pool · Pool 0.3 USDC · Yes pays 1.04×, no pays 1.23×.');
        expect(meta(res.text, 'og:image')).toBe('https://urbangametheory.xyz/images/og-globe-20261019.jpg');
        expect(meta(res.text, 'og:url')).toBe(`https://urbangametheory.xyz/bets/${ACCOUNT}?city=zg`);
        expect(meta(res.text, 'twitter:card')).toBe('summary_large_image');
        const next = `/?city=zg&bets=${ACCOUNT}&lang=hr`;
        expect(res.text).toContain(`<meta http-equiv="refresh" content="0; url=${next.replace(/&/g, '&amp;')}">`);
        expect(res.text).toContain(`<a href="${next.replace(/&/g, '&amp;')}">Continue</a>`);
        expect(res.text).not.toContain('<script');
        expect(res.text).not.toContain('<Rudeš>');
    });

    it('names an untitled agreement by its designs, and one with neither as "this agreement"', async () => {
        const byDesigns = await request(appFor({ rows: [row({ title: null, design_titles: ['Six storeys', 'A park'] })] }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(byDesigns.text, 'og:title')).toBe('Will Six storeys + A park execute on-chain? · Bet on cities');
        const unnamed = await request(appFor({ rows: [row({ title: ' ', design_titles: [] })] }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(unnamed.text, 'og:title')).toBe('Will this agreement execute on-chain? · Bet on cities');
    });

    it('falls back to the agreement\'s city and the pinned API origin for a stored thumbnail', async () => {
        const { app } = appFor({ rows: [row({ screenshot_url: '/uploads/thumbs/789.png' })], env: { PUBLIC_API_BASE_URL: 'https://api.urbangametheory.xyz/' } });
        const res = await request(app).get(`/bets/${ACCOUNT}`);
        expect(res.status).toBe(200);
        expect(meta(res.text, 'og:image')).toBe('https://api.urbangametheory.xyz/uploads/thumbs/789.png');
        expect(meta(res.text, 'og:url')).toBe(`https://urbangametheory.xyz/bets/${ACCOUNT}?city=zagreb`);
        expect(res.text).toContain(`content="0; url=/?city=zagreb&amp;bets=${ACCOUNT}"`);
    });

    it('previews the before/after pair when it has been rendered, else the thumbnail', async () => {
        const env = { PUBLIC_API_BASE_URL: 'https://api.urbangametheory.xyz' };
        const paired = await request(appFor({ rows: [row({ screenshot_url: '/uploads/images/t.png', screenshot_pair_url: '/uploads/images/p.png' })], env }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(paired.text, 'og:image')).toBe('https://api.urbangametheory.xyz/uploads/images/p.png');
        const single = await request(appFor({ rows: [row({ screenshot_url: '/uploads/images/t.png', screenshot_pair_url: null })], env }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(single.text, 'og:image')).toBe('https://api.urbangametheory.xyz/uploads/images/t.png');
    });

    it('words a settled pool, a pool waiting for settlement, an empty pool and a one-sided one', async () => {
        const settled = await request(appFor({ rows: [withStatus('expired')], market: { yesPool: 250000n, noPool: 50000n, resolved: true, outcome: 0 } }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(settled.text, 'og:description')).toBe('Settled no: Cancelled or Expired on-chain · Pool 0.3 USDC.');
        const settling = await request(appFor({ rows: [withStatus('executed')] }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(settling.text, 'og:description')).toBe('Decided on-chain · Pool 0.3 USDC · Anyone can settle the pool.');
        const empty = await request(appFor({ market: { yesPool: 0n, noPool: 0n, resolved: false, outcome: 0 } }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(empty.text, 'og:description')).toBe('No bets yet · Pool 0 USDC · Bet on on-chain execution.');
        // A pool with one side only never reads "100% chance".
        const oneSided = await request(appFor({ market: { yesPool: 250000n, noPool: 0n, resolved: false, outcome: 0 } }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(oneSided.text, 'og:description')).toBe('Only yes bets so far · Pool 0.25 USDC · Yes pays 1.00×, no pays 1.25×.');
    });

    it('answers 404 with the generic card for an account no agreement in the index was minted as, still pointing at the city', async () => {
        const res = await request(appFor().app).get(`/bets/${OTHER}?city=zg`);
        expect(res.status).toBe(404);
        expect(meta(res.text, 'og:title')).toBe('Bet on cities · Consensus Builder');
        expect(res.text).toContain('content="0; url=/?city=zg"');
    });

    it('does not preview an account a row only claims: another wallet\'s account for the CID, or another cluster', async () => {
        for (const onchain of [
            { ...row().onchain, cluster: 'mainnet-beta' },
            { ...row().onchain, chain: 'evm' }
        ]) {
            const res = await request(appFor({ rows: [row({ onchain })] }).app).get(`/bets/${ACCOUNT}`);
            expect(res.status).toBe(404);
        }
        // The stranger's account names this CID, but its sponsor is not the agreement's.
        const squat = await request(appFor({ rows: [row({ sponsor: STRANGER })] }).app).get(`/bets/${ACCOUNT}`);
        expect(squat.status).toBe(404);
    });

    it('answers 400 for a path that is not an account, and ignores a city that is not one', async () => {
        const { app, pool } = appFor();
        const res = await request(app).get('/bets/not-an-account?city=%3Cscript%3E');
        expect(res.status).toBe(400);
        expect(res.text).toContain('content="0; url=/"');
        // The rejected city never reaches the page, escaped or not.
        expect(res.text).not.toContain('city=');
        expect(res.text).not.toContain('script&gt;');
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('still hands over to the app when the chain read fails', async () => {
        const app = express();
        setupBetsShareRoute(app, { query: async () => ({ rows: [row()] }) }, {
            env: {}, readMarkets: async () => { throw new Error('rpc down'); }
        });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(app).get(`/bets/${ACCOUNT}?city=zg`);
        errorSpy.mockRestore();
        expect(res.status).toBe(502);
        expect(res.text).toContain(`content="0; url=/?city=zg&amp;bets=${ACCOUNT}"`);
    });
});

describe('describeRow and escapeHtml', () => {
    it('has a sentence for every row state', () => {
        expect(describeRow({ state: 'needs-market', pool: null })).toBe('No pool yet · Open the pool and bet on on-chain execution.');
        expect(describeRow({ state: 'settling', pool: '1' })).toBe('Decided on-chain · Pool 1 USDC · Anyone can settle the pool.');
        expect(describeRow({ state: 'closed', pool: null })).toBe('Not open for bets.');
        expect(describeRow({ state: 'not-minted', pool: null })).toBe('Not open for bets.');
        expect(describeRow({ state: 'resolved-yes', pool: '2.5' })).toBe('Settled yes: Executed on-chain · Pool 2.5 USDC.');
        expect(describeRow({ state: 'resolved-no', pool: '2.5' })).toBe('Settled no: Cancelled or Expired on-chain · Pool 2.5 USDC.');
        expect(describeRow(null)).toBe('Bet on cities: bet on whether an agreement executes on-chain.');
    });

    it('escapes every character that could leave an attribute', () => {
        expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    });
});
