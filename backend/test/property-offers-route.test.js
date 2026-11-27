// The property-offer/v2 index: publication derives the asset columns from the canonical content, the
// list filters reach SQL as parameters, the chain mirror accepts only an account the server read and
// proved to carry the published terms (maker's lens and payouts included), and the "awaiting" list
// asks for the committed offers a lens member has yet to confirm.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { canonicalBytes } from '../cid.js';
import { setupPropertyOffersRoute, offerListQuery } from '../routes/property-offers.js';
import { client, mirrorOfferAccount } from '../property-offers/onchain.js';

const require = createRequire(import.meta.url);
const Offer = require('../../frontend/js/property-offer-record.js');
const anchor = createRequire(new URL('../../blockchain/solana/package.json', import.meta.url))('@coral-xyz/anchor');
const coder = new anchor.BorshCoder(JSON.parse(readFileSync(new URL('../../blockchain/solana/idl/property_offer.json', import.meta.url), 'utf8')));
const [seller, buyer, memberA, memberB, sellerLens] = [71, 72, 73, 74, 75].map(n => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey);
const NOW = Date.parse('2026-11-27T12:00:00.000Z');

function content(patch = {}) {
    return Offer.published({ schema: 'property-offer/v2', title: 'Plot 2', city: 'zagreb', createdAt: '2026-11-27T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
        direction: 'sell', proposer: seller.toBase58(), currency: 'USDC', price: '900', lens: { members: [sellerLens.toBase58()], threshold: 1 },
        asset: { kind: 'parcel', sourceId: 'oss-wfs', id: 'HR-1-1/2', at: '45.81,15.97,18' }, payouts: [{ recipient: seller.toBase58(), amount: '900' }], ...patch });
}

function fakePool() {
    const rows = new Map(), calls = [];
    return { rows, calls, query: vi.fn(async (sql, params = []) => {
        calls.push({ sql, params });
        if (/^\s*SELECT .* WHERE cid = \$1/s.test(sql)) return { rows: rows.has(params[0]) ? [rows.get(params[0])] : [] };
        if (/INSERT INTO consensus\.property_offer/.test(sql)) {
            const [cid, city, title, direction, proposer, currency, price, assetKind, assetHash, assetKey, lat, lng, expiresAt, contentJson, lensMembers] = params;
            rows.set(cid, { cid, city, title, direction, proposer, currency, price, asset_kind: assetKind, asset_hash: assetHash, asset_key: assetKey, lat, lng,
                expires_at: expiresAt, content: JSON.parse(contentJson), status: 'unminted', lens_members: lensMembers, onchain: null, created_at: new Date(NOW) });
            return { rows: [] };
        }
        if (/^\s*UPDATE consensus\.property_offer SET onchain/.test(sql)) {
            Object.assign(rows.get(params[0]), { onchain: JSON.parse(params[1]), status: params[2], lens_members: params[3] });
            return { rows: [] };
        }
        return { rows: [...rows.values()] };
    }) };
}
function app({ pool = fakePool(), read } = {}) {
    const server = express(); server.use(express.json());
    setupPropertyOffersRoute(server, { pool, now: () => NOW, propertyOfferChain: () => ({ read: read || (async () => { throw new Error('no chain'); }) }) });
    return { server, pool };
}
const published = (c = content()) => ({ cid: Offer.cid(c), content: c });

// A v2 account as Anchor encodes it, carrying the offer's terms unless patched.
async function account(row, patch = {}) {
    const c = row.content, lens = (members, threshold, confirmed = 0) => ({ members: [...members, ...Array(8 - members.length).fill(PublicKey.default)], count: members.length, threshold, confirmed });
    const bytes = await coder.accounts.encode('PropertyOffer', {
        maker: seller, buyer, seller, mint: new PublicKey(client.constants.USDC_MINT), side: { Sell: {} }, status: { Committed: {} },
        price: new anchor.BN(900), escrow: new anchor.BN(900), deadline: new anchor.BN(Math.floor(Date.parse(c.expiresAt) / 1000)), created_at: new anchor.BN(1), committed_at: new anchor.BN(2), settled_at: new anchor.BN(0),
        terms_hash: [...createHash('sha256').update(canonicalBytes(c)).digest()], payouts_hash: Array(32).fill(1),
        buyer_lens: lens([memberA, memberB], 2, 0b01), seller_lens: lens([sellerLens], 1, 0),
        payouts: [{ recipient: seller, amount: new anchor.BN(900) }], bump: 255, cid: row.cid, ...patch });
    return client.readPropertyOffer(new Uint8Array(bytes), client.getOfferPda(row.cid, c.proposer)[0].toBase58());
}

describe('POST /property-offers (v2)', () => {
    it('indexes canonical v2 content with its asset hash, key, location, status unminted and the maker’s lens', async () => {
        const { server, pool } = app(), body = published();
        const response = await request(server).post('/property-offers').send(body);
        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({ cid: body.cid, content: body.content, status: 'unminted', onchain: null });
        expect(pool.rows.get(body.cid)).toMatchObject({ asset_kind: 'parcel', asset_hash: Offer.assetHash(body.content.asset), asset_key: '["parcel/v1","oss-wfs","HR-1-1/2"]',
            lat: 45.81, lng: 15.97, currency: 'USDC', price: '900', lens_members: [sellerLens.toBase58()] });
        expect((await request(server).post('/property-offers').send(body)).status).toBe(409);
    });
    it('refuses v1 content, a CID that is not the content’s and expired terms', async () => {
        const { server } = app();
        const v1 = { schema: 'property-offer/v1', city: 'zagreb' };
        expect((await request(server).post('/property-offers').send({ cid: published().cid, content: v1 })).status).toBe(400);
        expect((await request(server).post('/property-offers').send({ cid: published().cid, content: content({ price: '901', payouts: [{ recipient: seller.toBase58(), amount: '901' }] }) })).body.code).toBe('cid-mismatch');
        const old = content({ createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z' });
        expect((await request(server).post('/property-offers').send(published(old))).status).toBe(422);
    });
});

describe('GET /property-offers filters', () => {
    it('defaults to the live market: open or committed and not expired', () => {
        expect(offerListQuery({}).where).toEqual([`status IN ('open', 'committed')`, 'expires_at > now()']);
    });
    it('turns every filter into a parameter', () => {
        const hash = 'ab'.repeat(32);
        const { where, params } = offerListQuery({ city: 'Zagreb', kind: 'flat', direction: 'buy', currency: 'SOL', asset: hash, maker: seller.toBase58(), member: memberA.toBase58(),
            bbox: '15.9,45.7,16.1,45.9', status: 'settled,expired' });
        expect(where).toEqual(['city = $1', 'asset_kind = $2', 'direction = $3', 'currency = $4', 'asset_hash = $5', 'proposer = $6', '$7 = ANY(lens_members)',
            'lng >= $8', 'lat >= $9', 'lng <= $10', 'lat <= $11', 'status = ANY($12::text[])']);
        expect(params).toEqual(['zagreb', 'flat', 'buy', 'SOL', hash, seller.toBase58(), memberA.toBase58(), 15.9, 45.7, 16.1, 45.9, ['settled', 'expired']]);
    });
    it('answers 400 to a malformed filter and pages newest first', async () => {
        const { server, pool } = app();
        for (const query of ['kind=house', 'status=open,sold', 'bbox=1,2,3', 'bbox=10,0,5,1', 'asset=xyz', 'member=not-a-key', 'currency=EUR', 'limit=0'])
            expect((await request(server).get(`/property-offers?${query}`)).status).toBe(400);
        const response = await request(server).get(`/property-offers?kind=parcel&limit=5&offset=10`);
        expect(response.status).toBe(200);
        const last = pool.calls.at(-1);
        expect(last.sql).toMatch(/ORDER BY created_at DESC, cid LIMIT \$2 OFFSET \$3/);
        expect(last.params).toEqual(['parcel', 6, 10]);
    });
});

describe('POST /property-offers/:cid/onchain', () => {
    it('mirrors the account the server read: status, parties, both lenses, payouts, and lens members of both sides', async () => {
        const body = published(), read = vi.fn(async row => account(row));
        const { server, pool } = app({ read });
        await request(server).post('/property-offers').send(body);
        const address = client.getOfferPda(body.cid, seller.toBase58())[0].toBase58();
        const response = await request(server).post(`/property-offers/${body.cid}/onchain`).send({ chain: 'solana', cluster: 'devnet', account: address, status: 'settled' });
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('committed');
        expect(response.body.onchain).toMatchObject({ cluster: 'devnet', account: address, status: 'committed', buyer: buyer.toBase58(), seller: seller.toBase58(), escrow: '900',
            buyerLens: { members: [memberA.toBase58(), memberB.toBase58()], threshold: 2, confirmed: [memberA.toBase58()], met: false },
            sellerLens: { members: [sellerLens.toBase58()], threshold: 1, confirmed: [], met: false }, payouts: [{ recipient: seller.toBase58(), amount: '900' }] });
        expect(pool.rows.get(body.cid).lens_members).toEqual([sellerLens.toBase58(), memberA.toBase58(), memberB.toBase58()]);
        expect((await request(server).post(`/property-offers/${body.cid}/onchain`).send({ chain: 'solana', cluster: 'devnet', account: memberA.toBase58() })).status).toBe(422);
        expect((await request(server).post(`/property-offers/${body.cid}/onchain`).send({ chain: 'solana', cluster: 'localnet', account: address })).status).toBe(409);
    });
    it('refuses an account whose maker lens, payouts, currency or price differ from the published terms', async () => {
        const row = published();
        const other = new PublicKey(memberB.toBase58());
        const lens = (members, threshold) => ({ members: [...members, ...Array(8 - members.length).fill(PublicKey.default)], count: members.length, threshold, confirmed: 0 });
        for (const patch of [{ seller_lens: lens([other], 1) }, { seller_lens: lens([sellerLens], 0) }, { payouts: [{ recipient: other, amount: new anchor.BN(900) }] },
            { mint: PublicKey.default }, { price: new anchor.BN(901) }, { terms_hash: Array(32).fill(0) }]) {
            const tampered = await account(row, patch);
            expect(() => mirrorOfferAccount(row, tampered, 'devnet'), JSON.stringify(Object.keys(patch))).toThrow(/does not match|differs/);
        }
        expect(mirrorOfferAccount(row, await account(row), 'devnet').status).toBe('committed');
    });
});

describe('GET /property-offers/awaiting', () => {
    it('asks for committed, unexpired offers where the member is in a lens it has not confirmed', async () => {
        const { server, pool } = app();
        expect((await request(server).get('/property-offers/awaiting')).status).toBe(400);
        expect((await request(server).get(`/property-offers/awaiting?member=${memberB.toBase58()}`)).status).toBe(200);
        const { sql, params } = pool.calls.at(-1);
        expect(params).toEqual([memberB.toBase58(), 21, 0]);
        expect(sql).toContain(`status = 'committed'`);
        expect(sql).toContain(`(onchain->'buyerLens'->'members' ? $1 AND NOT (onchain->'buyerLens'->'confirmed' ? $1))`);
        expect(sql).toContain(`(onchain->'sellerLens'->'members' ? $1 AND NOT (onchain->'sellerLens'->'confirmed' ? $1))`);
    });
});
