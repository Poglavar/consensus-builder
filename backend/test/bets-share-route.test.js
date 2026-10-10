// GET /bets/:proposalAccount: the link preview for one bet and the hand-over to the app. No test
// reaches a database or devnet: the row and the market account are injected.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { describeRow, escapeHtml, setupBetsShareRoute } from '../routes/bets-share.js';

const ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const OTHER = 'HQqbGtviQr5KRs4x8CWSCVhnkrLKDiYqXmVSBY8GZdfw';

function row(overrides = {}) {
    return {
        id: 789, proposal_id: 'agent-densifier-01-2026-10-09-1', city: 'zagreb', title: 'Plan-led infill in <Rudeš> & "more"',
        goal: 'single', lifecycle_status: 'Active', created_at: new Date('2026-10-09T11:11:00Z'), expires_at: null,
        cadastre_parcel_ids: ['HR-335614-2309/2'], onchain_data: { chainId: 'solana-devnet', proposalId: ACCOUNT },
        author: 'densifier-01', agent: true, proposal_role: null, screenshot_url: null, site_name: null,
        ...overrides
    };
}

function appFor({ rows = [row()], market = { yesPool: 250000n, noPool: 50000n, resolved: false, outcome: 0 }, status = 'Active', env = {} } = {}) {
    const app = express();
    const pool = { query: vi.fn(async (sql, params) => ({ rows: params[0] === ACCOUNT ? rows : [] })) };
    setupBetsShareRoute(app, pool, {
        env,
        readMarkets: async () => new Map([[ACCOUNT, { address: 'MKT', market }]]),
        readProposalStatuses: async () => new Map([[ACCOUNT, status]]),
        now: () => new Date('2026-10-09T12:00:00Z')
    });
    return { app, pool };
}

const meta = (html, property) => {
    const match = html.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)">`));
    return match ? match[1] : null;
};

describe('GET /bets/:proposalAccount', () => {
    it('previews an open pool with its chance, pool and payouts, and hands over to the app form', async () => {
        const { app, pool } = appFor();
        const res = await request(app).get(`/bets/${ACCOUNT}?city=zg&lang=hr`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.headers['cache-control']).toBe('public, max-age=60');
        expect(pool.query.mock.calls[0][1]).toEqual([ACCOUNT]);
        expect(meta(res.text, 'og:title')).toBe('Plan-led infill in &lt;Rudeš&gt; &amp; &quot;more&quot; · Bet on cities');
        expect(meta(res.text, 'og:description')).toBe('83.3% chance it gets built · Pool 0.3 USDC · Yes pays 1.04×, no pays 1.23×.');
        expect(meta(res.text, 'og:image')).toBe('https://urbangametheory.xyz/images/consensus-builder-logo-2.png');
        expect(meta(res.text, 'og:url')).toBe(`https://urbangametheory.xyz/bets/${ACCOUNT}?city=zg`);
        expect(meta(res.text, 'twitter:card')).toBe('summary_large_image');
        const next = `/?city=zg&bets=${ACCOUNT}&lang=hr`;
        expect(res.text).toContain(`<meta http-equiv="refresh" content="0; url=${next.replace(/&/g, '&amp;')}">`);
        expect(res.text).toContain(`<a href="${next.replace(/&/g, '&amp;')}">Continue</a>`);
        expect(res.text).not.toContain('<script');
        expect(res.text).not.toContain('<Rudeš>');
    });

    it('falls back to the row city and the pinned API origin for a stored thumbnail', async () => {
        const { app } = appFor({ rows: [row({ screenshot_url: '/uploads/thumbs/789.png' })], env: { PUBLIC_API_BASE_URL: 'https://api.urbangametheory.xyz/' } });
        const res = await request(app).get(`/bets/${ACCOUNT}`);
        expect(res.status).toBe(200);
        expect(meta(res.text, 'og:image')).toBe('https://api.urbangametheory.xyz/uploads/thumbs/789.png');
        expect(meta(res.text, 'og:url')).toBe(`https://urbangametheory.xyz/bets/${ACCOUNT}?city=zagreb`);
        expect(res.text).toContain(`content="0; url=/?city=zagreb&amp;bets=${ACCOUNT}"`);
    });

    it('words a settled pool and a pool nobody has bet on', async () => {
        const settled = await request(appFor({ market: { yesPool: 250000n, noPool: 50000n, resolved: true, outcome: 0 }, status: 'Expired' }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(settled.text, 'og:description')).toBe('Settled no: it was dropped · Pool 0.3 USDC.');
        const empty = await request(appFor({ market: { yesPool: 0n, noPool: 0n, resolved: false, outcome: 0 } }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(empty.text, 'og:description')).toBe('No bets yet · Pool 0 USDC · Bet yes or no on whether it gets built.');
        // A pool with one side only never reads "100% chance".
        const oneSided = await request(appFor({ market: { yesPool: 250000n, noPool: 0n, resolved: false, outcome: 0 } }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(oneSided.text, 'og:description')).toBe('Only yes bets so far · Pool 0.25 USDC · Yes pays 1.00×, no pays 1.25×.');
    });

    it('answers 404 with the generic card for an account nobody minted, still pointing at the city', async () => {
        const res = await request(appFor().app).get(`/bets/${OTHER}?city=zg`);
        expect(res.status).toBe(404);
        expect(meta(res.text, 'og:title')).toBe('Bet on cities · Consensus Builder');
        expect(res.text).toContain('content="0; url=/?city=zg"');
    });

    it('answers 400 for a path that is not an account, and ignores a city that is not one', async () => {
        const res = await request(appFor().app).get('/bets/not-an-account?city=%3Cscript%3E');
        expect(res.status).toBe(400);
        expect(res.text).toContain('content="0; url=/"');
        // The rejected city never reaches the page, escaped or not.
        expect(res.text).not.toContain('city=');
        expect(res.text).not.toContain('script&gt;');
    });

    it('still hands over to the app when the chain read fails', async () => {
        const app = express();
        setupBetsShareRoute(app, { query: async () => ({ rows: [row()] }) }, {
            env: {}, readMarkets: async () => { throw new Error('rpc down'); }, readProposalStatuses: async () => new Map()
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
        expect(describeRow({ state: 'needs-market', pool: null })).toMatch(/^No pool yet/);
        expect(describeRow({ state: 'settling', pool: '1' })).toBe('Decided on-chain · Pool 1 USDC · Anyone can settle the pool.');
        expect(describeRow({ state: 'closed', pool: null })).toBe('Decided on-chain before a pool was opened.');
        expect(describeRow({ state: 'resolved-yes', pool: '2.5' })).toBe('Settled yes: it gets built · Pool 2.5 USDC.');
        expect(describeRow(null)).toContain('Bet on cities');
    });

    it('escapes every character that could leave an attribute', () => {
        expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    });
});

describe('GET /bets/:account for a named plan', () => {
    it('previews the plan by its own title and a member thumbnail when no proposal holds the account', async () => {
        const app = express();
        const planRow = { slug: 'borovje-urbani-blokovi', title: 'Borovje – urban blocks', place: 'Borovje', author: 'UGT',
            created_at: new Date('2026-10-10T10:00:00Z'), proposal_ids: ['5', '6'], city: 'zagreb',
            onchain_data: { chainId: 'solana-devnet', proposalId: ACCOUNT } };
        const members = [
            row({ id: 5, proposal_id: 'street', onchain_data: null, screenshot_url: null, cadastre_parcel_ids: ['HR-1-1'] }),
            row({ id: 6, proposal_id: 'block', onchain_data: null, screenshot_url: 'https://cdn.example/block.png', cadastre_parcel_ids: ['HR-1-1'] })
        ];
        const pool = { query: vi.fn(async (sql) => ({
            rows: /FROM ens_plan/.test(sql) ? [planRow] : /id = ANY/.test(sql) ? members : []
        })) };
        setupBetsShareRoute(app, pool, {
            env: {},
            readMarkets: async () => new Map([[ACCOUNT, { address: 'MKT', market: { yesPool: 300000n, noPool: 100000n, resolved: false, outcome: 0 } }]]),
            readProposalStatuses: async () => new Map([[ACCOUNT, 'Active']]),
            now: () => new Date('2026-10-10T12:00:00Z')
        });
        const res = await request(app).get(`/bets/${ACCOUNT}?city=zg`);
        expect(res.status).toBe(200);
        expect(meta(res.text, 'og:title')).toBe('Borovje – urban blocks · Bet on cities');
        expect(meta(res.text, 'og:image')).toBe('https://cdn.example/block.png');
        expect(meta(res.text, 'og:description')).toMatch(/75%/);
    });
});
