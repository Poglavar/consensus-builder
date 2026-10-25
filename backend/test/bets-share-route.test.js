// Terms-only preview for a shareable agreement bet. Reads the canonical agreement index row;
// pricing belongs to the separate points and devnet-USDC books and is never fetched here.
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

function row(overrides = {}) {
    return {
        cid: CID, city: 'zagreb', title: 'Plan-led infill in <Rudeš> & "more"', author: 'densifier-01',
        input_parcel_ids: ['HR-335614-2309/2'], parcel_source_id: null,
        deadline: new Date('2026-12-31T00:00:00Z'), sponsor: SPONSOR,
        design_titles: ['Six storeys'], screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null,
        onchain: { chain: 'solana', cluster: 'devnet', programId: AGREEMENT_PROGRAM_ID, account: ACCOUNT, sponsor: SPONSOR, status: 'active', observedSlot: 7 },
        created_at: new Date('2026-10-09T11:11:00Z'),
        ...overrides
    };
}

function appFor({ rows = [row()], env = {}, query } = {}) {
    const app = express();
    const pool = { query: vi.fn(query || (async (_sql, params) => ({ rows: params[0] === ACCOUNT ? rows : [] }))) };
    setupBetsShareRoute(app, pool, { env });
    return { app, pool };
}

const meta = (html, property) => {
    const match = html.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)">`));
    return match ? match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
};

describe('GET /bets/:account', () => {
    it('previews the exact agreement deadline and terms, then hands over to the app', async () => {
        const { app, pool } = appFor();
        const res = await request(app).get(`/bets/${ACCOUNT}?city=zg&lang=hr`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.headers['cache-control']).toBe('public, max-age=60');
        expect(pool.query.mock.calls[0][0]).toMatch(/FROM consensus\.agreement\s+WHERE onchain->>'account' = \$1/);
        expect(pool.query.mock.calls[0][1]).toEqual([ACCOUNT]);
        expect(meta(res.text, 'og:title')).toBe('Will Plan-led infill in <Rudeš> & "more" execute on-chain by 2026-12-31T00:00:00.000Z? · Bet on cities');
        expect(meta(res.text, 'og:description')).toBe('Bet with points: YES if this agreement executes on-chain by its deadline; NO if it expires or misses the deadline. Cancellation pays 0.5 per share. Both agreements can succeed, or neither. Execution does not mean construction.');
        expect(meta(res.text, 'og:image')).toBe('https://urbangametheory.xyz/images/og-globe-20261019.jpg');
        expect(meta(res.text, 'og:url')).toBe(`https://urbangametheory.xyz/bets/${ACCOUNT}?city=zg&asset=points`);
        expect(meta(res.text, 'twitter:card')).toBe('summary_large_image');
        const next = `/?city=zg&bets=${ACCOUNT}&lang=hr&asset=points`;
        expect(res.text).toContain(`<meta http-equiv="refresh" content="0; url=${next.replace(/&/g, '&amp;')}">`);
        expect(res.text).toContain(`<a href="${next.replace(/&/g, '&amp;')}">Continue</a>`);
        expect(res.text).not.toContain('<script');
        expect(res.text).not.toContain('<Rudeš>');
    });

    it('uses an untitled agreement design label, then a generic label when neither title exists', async () => {
        const byDesigns = await request(appFor({ rows: [row({ title: null, design_titles: ['Six storeys', 'A park'] })] }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(byDesigns.text, 'og:title')).toBe('Will Six storeys + A park execute on-chain by 2026-12-31T00:00:00.000Z? · Bet on cities');
        const unnamed = await request(appFor({ rows: [row({ title: ' ', design_titles: [] })] }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(unnamed.text, 'og:title')).toBe('Will this agreement execute on-chain by 2026-12-31T00:00:00.000Z? · Bet on cities');
    });

    it('uses the agreement city when no city is supplied and resolves stored images against the API origin', async () => {
        const { app } = appFor({ rows: [row({ screenshot_url: '/uploads/thumbs/789.png' })], env: { PUBLIC_API_BASE_URL: 'https://api.urbangametheory.xyz/' } });
        const res = await request(app).get(`/bets/${ACCOUNT}`);
        expect(res.status).toBe(200);
        expect(meta(res.text, 'og:image')).toBe('https://api.urbangametheory.xyz/uploads/thumbs/789.png');
        expect(meta(res.text, 'og:url')).toBe(`https://urbangametheory.xyz/bets/${ACCOUNT}?city=zagreb&asset=points`);
        expect(res.text).toContain(`content="0; url=/?city=zagreb&amp;bets=${ACCOUNT}&amp;asset=points"`);
    });

    it('uses the before/after image when available, otherwise the thumbnail or default image', async () => {
        const env = { PUBLIC_API_BASE_URL: 'https://api.urbangametheory.xyz' };
        const paired = await request(appFor({ rows: [row({ screenshot_url: '/uploads/images/t.png', screenshot_pair_url: '/uploads/images/p.png' })], env }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(paired.text, 'og:image')).toBe('https://api.urbangametheory.xyz/uploads/images/p.png');
        const single = await request(appFor({ rows: [row({ screenshot_url: '/uploads/images/t.png', screenshot_pair_url: null })], env }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(single.text, 'og:image')).toBe('https://api.urbangametheory.xyz/uploads/images/t.png');
        const absolute = await request(appFor({ rows: [row({ screenshot_url: 'https://cdn.example/image.png' })] }).app).get(`/bets/${ACCOUNT}`);
        expect(meta(absolute.text, 'og:image')).toBe('https://cdn.example/image.png');
    });

    it('preserves selected asset, local backend override and simulation label in the app redirect', async () => {
        const { app } = appFor();
        const res = await request(app).get(`/bets/${ACCOUNT}?city=sf&asset=devnet-usdc&backend=http%3A%2F%2Flocalhost%3A8000%2F&betTest=curious-resident`);
        expect(res.status).toBe(200);
        expect(meta(res.text, 'og:description')).toContain('Bet with devnet USDC:');
        const expected = `/?city=sf&bets=${ACCOUNT}&asset=devnet-usdc&betTest=curious-resident&backend=http%3A%2F%2Flocalhost%3A8000`;
        expect(res.text).toContain(`<meta http-equiv="refresh" content="0; url=${expected.replace(/&/g, '&amp;')}">`);
        expect(meta(res.text, 'og:url')).toBe(`https://urbangametheory.xyz/bets/${ACCOUNT}?city=sf&asset=devnet-usdc`);
    });

    it('answers 404 with a generic card for an account without a canonical minted agreement', async () => {
        const res = await request(appFor().app).get(`/bets/${OTHER}?city=zg&asset=devnet-usdc&backend=http%3A%2F%2Flocalhost%3A8000&betTest=walkthrough`);
        expect(res.status).toBe(404);
        expect(meta(res.text, 'og:title')).toBe('Bet on cities · Consensus Builder');
        expect(meta(res.text, 'og:description')).toContain('Bet with devnet USDC:');
        expect(res.text).toContain('content="0; url=/?city=zg&amp;asset=devnet-usdc&amp;betTest=walkthrough&amp;backend=http%3A%2F%2Flocalhost%3A8000"');
    });

    it('does not preview a claimed account when CID, sponsor, cluster or chain identity fails', async () => {
        const bad = [
            row({ onchain: { ...row().onchain, cluster: 'mainnet-beta' } }),
            row({ onchain: { ...row().onchain, chain: 'evm' } }),
            row({ sponsor: STRANGER }),
            row({ cid: cidOfObject({ schema: 'agreement/v1', title: 'Other' }) })
        ];
        for (const candidate of bad) {
            const res = await request(appFor({ rows: [candidate] }).app).get(`/bets/${ACCOUNT}`);
            expect(res.status).toBe(404);
        }
        expect(agreementAccountOf(CID, SPONSOR)).toBe(ACCOUNT);
        expect(agreementAccountOf(CID, STRANGER)).not.toBe(ACCOUNT);
    });

    it('answers 400 for invalid accounts and ignores invalid city or context values', async () => {
        const { app, pool } = appFor();
        const res = await request(app).get('/bets/not-an-account?city=%3Cscript%3E&asset=USD&backend=javascript%3Aalert(1)&betTest=bad%20slug');
        expect(res.status).toBe(400);
        expect(res.text).toContain('content="0; url=/?asset=points"');
        expect(res.text).not.toContain('city=');
        expect(res.text).not.toContain('script&gt;');
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('keeps an app redirect with account context when the index lookup fails', async () => {
        const { app } = appFor({ query: async () => { throw new Error('index unavailable'); } });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(app).get(`/bets/${ACCOUNT}?city=zg&asset=points&backend=https%3A%2F%2Fpreview.example&betTest=walkthrough`);
        errorSpy.mockRestore();
        expect(res.status).toBe(502);
        expect(res.text).toContain(`content="0; url=/?city=zg&amp;bets=${ACCOUNT}&amp;asset=points&amp;betTest=walkthrough&amp;backend=https%3A%2F%2Fpreview.example"`);
    });
});

describe('describeRow and escapeHtml', () => {
    it('describes cutoff semantics without quoting live book prices', () => {
        expect(describeRow({ asset: 'points' })).toBe('Bet with points: YES if this agreement executes on-chain by its deadline; NO if it expires or misses the deadline. Cancellation pays 0.5 per share. Both agreements can succeed, or neither. Execution does not mean construction.');
        expect(describeRow({ asset: 'devnet-usdc' })).toContain('Bet with devnet USDC:');
        expect(describeRow(null)).toContain('Bet with points:');
    });

    it('escapes every character that could leave an HTML attribute', () => {
        expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    });
});
