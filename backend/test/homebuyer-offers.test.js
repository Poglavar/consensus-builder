// The homebuyers' USDC flat offers on property_offer v2 (homebuyer-chain.js): the flats of executed
// rounds with their holder according to the round's lens member (its first-holder statement read from
// chain), the flats' offers checked against their chain accounts, and each offer action signed through
// the shared signer steps (publish then create, take, expire), with the offer terms a homebuyer makes.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { executeHomeAction, homeActivityEntity, homeOffer, readFlatOffers, readFlats } from '../agents/homebuyer-chain.js';
import { client, termsHashOf } from '../property-offers/onchain.js';
import { plotAssets } from '../agents/plot-market.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const Offer = require('../../frontend/js/property-offer-record.js');
const Statements = require('../../frontend/js/solana/property-statements.js').configure({ web3 });
const anchor = createRequire(new URL('../../blockchain/solana/package.json', import.meta.url))('@coral-xyz/anchor');
const coder = new anchor.BorshCoder(JSON.parse(readFileSync(new URL('../../blockchain/solana/idl/property_offer.json', import.meta.url), 'utf8')));

const kp = n => Keypair.fromSeed(new Uint8Array(32).fill(n));
const [meKp, otherKp, lensKp] = [61, 62, 63].map(kp);
const [ME, OTHER, LENS] = [meKp, otherKp, lensKp].map(k => k.publicKey.toBase58());
const BUILDING = 'design::bafkreign6yfigxrchcmsgzkvwfobaohxhwcibuwv6sxevauizastujd6cy::0';
const unit = id => ({ unitId: `u${id}`, label: `Flat ${id}`, xrayBuilding: BUILDING, unit: `3::${id}`, at: '43.8,77.09,19', priceUsdcAtomic: '5000000', depositUsdcAtomic: '1500000' });
const round = { summary: { cid: 'bafround', name: 'Round 1', account: 'acct', city: 'alatau' }, row: { planTitle: 'Towers' },
    content: { city: 'alatau', rule: { lens: [LENS] }, funding: { apartments: { units: [unit(1), unit(2)] } } } };
const flatAsset = id => ({ kind: 'flat', xrayBuilding: BUILDING, unit: `3::${id}`, at: '43.8,77.09,19' });

// The lens member's first-holder statement as SAS stores it.
function holdingData(asset, holder) {
    const hash = Offer.assetHash(asset);
    const payload = Buffer.from(Statements.encodeHoldingPayload({ assetHash: hash, asset: Offer.assetKey(asset), holder, basis: 'developer', observedAt: 1 }));
    const length = Buffer.alloc(4); length.writeUInt32LE(payload.length);
    return Buffer.concat([Buffer.from([2]), Buffer.alloc(96), length, payload, lensKp.publicKey.toBuffer(), Buffer.alloc(8, 0x7f)]);
}

describe('flats of executed rounds', () => {
    it('reads each reserved flat\'s holder from the round lens member\'s statements, in one batch', async () => {
        const held = Statements.holdingAddress(LENS, Offer.assetHash(flatAsset(1))).toBase58();
        const connection = {
            getMultipleAccountsInfo: vi.fn(async keys => keys.map(key => key.toBase58() === held ? { data: holdingData(flatAsset(1), ME) } : null)),
            getAccountInfo: vi.fn(async () => null)
        };
        const readInventory = vi.fn(async () => [{ unitId: 'u1', status: 'reserved', buyer: ME }, { unitId: 'u2', status: 'reserved', buyer: OTHER }]);
        const flats = await readFlats({ connection, executed: [round], readInventory });
        expect(connection.getMultipleAccountsInfo).toHaveBeenCalledOnce();
        expect(flats).toMatchObject([
            { roundCid: 'bafround', title: 'Flat 1 · Towers', lens: LENS, asset: flatAsset(1), assetHash: Offer.assetHash(flatAsset(1)), holder: ME, holding: held, pending: null, stale: false },
            // Bought in the round, but the lens member has stated no holder yet: nobody holds it for the market.
            { asset: flatAsset(2), holder: null }
        ]);
    });
    it('reads a plot-market plot\'s holder the same way, in the same batch', async () => {
        const [plot] = plotAssets({ cities: ['alatau'], personas: [{ name: 'lifecycle-01', role: 'lens-member', wallet: LENS }],
            markets: [{ city: 'alatau', lens: 'lifecycle-01', sourceId: 'kz-alatau-pkk', plots: [{ id: 'KZ-ALATAU-PKK-1', at: '43.61,77.02,18', label: 'Plot 1' }] }] });
        expect(plot).toMatchObject({ lens: LENS, asset: { kind: 'parcel', sourceId: 'kz-alatau-pkk', id: 'KZ-ALATAU-PKK-1', at: '43.61,77.02,18' } });
        const held = Statements.holdingAddress(LENS, plot.assetHash).toBase58();
        const connection = {
            getMultipleAccountsInfo: vi.fn(async keys => keys.map(key => key.toBase58() === held ? { data: holdingData(plot.asset, OTHER) } : null)),
            getAccountInfo: vi.fn(async () => null)
        };
        const flats = await readFlats({ connection, executed: [], plots: [plot], readInventory: vi.fn() });
        expect(connection.getMultipleAccountsInfo).toHaveBeenCalledOnce();
        expect(flats).toMatchObject([{ roundCid: null, roundTitle: 'Plot 1', title: 'Plot 1', city: 'alatau', asset: plot.asset, holder: OTHER, holding: held }]);
    });
});

describe('a homebuyer\'s offer terms', () => {
    const at = '2026-11-27T10:00:00.000Z';
    it('a sale pays the whole price to itself and names no seller\'s lens; a bid names the round\'s lens member', () => {
        const sell = homeOffer({ direction: 'sell', proposer: ME, asset: flatAsset(1), city: 'alatau', price: '2500000', offerTitle: 'Flat 1 · Towers', createdAt: at, days: 2 });
        expect(sell.content).toMatchObject({ schema: 'property-offer/v2', currency: 'USDC', price: '2500000', lens: { members: [], threshold: 0 },
            payouts: [{ recipient: ME, amount: '2500000' }], expiresAt: '2026-11-29T10:00:00.000Z', asset: flatAsset(1) });
        expect(sell.cid).toBe(Offer.cid(sell.content));
        const buy = homeOffer({ direction: 'buy', proposer: ME, lens: LENS, asset: flatAsset(2), city: 'alatau', price: '1200000', offerTitle: 'Flat 2', createdAt: at, days: 1 });
        expect(buy.content).toMatchObject({ direction: 'buy', lens: { members: [LENS], threshold: 1 } });
        expect(buy.content).not.toHaveProperty('payouts');
        // The same action resumed gives the same CID.
        expect(homeOffer({ direction: 'buy', proposer: ME, lens: LENS, asset: flatAsset(2), city: 'alatau', price: '1200000', offerTitle: 'Flat 2', createdAt: at, days: 1 }).cid).toBe(buy.cid);
    });
});

describe('offers on those flats', () => {
    const at = '2026-11-27T10:00:00.000Z';
    const flats = [{ assetHash: Offer.assetHash(flatAsset(1)) }, { assetHash: Offer.assetHash(flatAsset(2)) }];
    const listing = homeOffer({ direction: 'sell', proposer: OTHER, asset: flatAsset(1), city: 'alatau', price: '2000000', offerTitle: 'Flat 1', createdAt: at, days: 2 });
    const bid = homeOffer({ direction: 'buy', proposer: ME, lens: LENS, asset: flatAsset(2), city: 'alatau', price: '1000000', offerTitle: 'Flat 2', createdAt: at, days: 2 });
    const elsewhere = homeOffer({ direction: 'sell', proposer: OTHER, asset: flatAsset(9), city: 'alatau', price: '2000000', offerTitle: 'Flat 9', createdAt: at, days: 2 });
    async function openAccount({ cid, content }) {
        const lens = members => ({ members: [...members.map(m => new PublicKey(m)), ...Array(8 - members.length).fill(PublicKey.default)], count: members.length, threshold: members.length ? 1 : 0, confirmed: 0 });
        return coder.accounts.encode('PropertyOffer', { maker: new PublicKey(content.proposer), buyer: PublicKey.default, seller: new PublicKey(content.proposer),
            mint: new PublicKey(client.constants.USDC_MINT), side: { Sell: {} }, status: { Open: {} }, price: new anchor.BN(content.price), escrow: new anchor.BN(0),
            deadline: new anchor.BN(Math.floor(Date.parse(content.expiresAt) / 1000)), created_at: new anchor.BN(1), committed_at: new anchor.BN(0), settled_at: new anchor.BN(0),
            terms_hash: [...Buffer.from(termsHashOf(content), 'hex')], payouts_hash: Array(32).fill(7), buyer_lens: lens([]), seller_lens: lens([]),
            payouts: content.payouts.map(p => ({ recipient: new PublicKey(p.recipient), amount: new anchor.BN(p.amount) })), bump: 1, cid });
    }
    it('lists the cities\' and its own, keeps those on known flats, and reads each from chain (unminted = no account)', async () => {
        const data = await openAccount(listing);
        const program = new PublicKey(client.constants.PROPERTY_OFFER_PROGRAM_ID);
        const listingAddress = client.getOfferPda(listing.cid, OTHER)[0].toBase58();
        const connection = { getMultipleAccountsInfo: vi.fn(async keys => keys.map(key => key.toBase58() === listingAddress ? { owner: program, data } : null)) };
        const offerTools = { list: vi.fn(async query => ({ propertyOffers: query.maker ? [bid] : [listing, elsewhere, { ...listing, cid: 'bafkreiforged' }] })) };
        const offers = await readFlatOffers({ connection, offerTools, cities: ['alatau'], wallet: ME, flats });
        expect(offerTools.list.mock.calls.map(([query]) => query)).toEqual([
            // No kind: flat and plot offers both (the hashes keep only known assets).
            { city: 'alatau', currency: 'USDC', status: 'open,committed', limit: 100 },
            { maker: ME, currency: 'USDC', status: 'unminted,open,committed', limit: 100 }]);
        expect(offers).toMatchObject([
            { cid: listing.cid, assetHash: Offer.assetHash(flatAsset(1)), chain: { status: 'Open', maker: OTHER, seller: OTHER, buyer: null, price: '2000000', escrow: '0' } },
            { cid: bid.cid, chain: null }]);
        expect(offers).toHaveLength(2);
    });
});

describe('signing an offer action', () => {
    const at = '2026-11-27T10:00:00.000Z';
    const base = () => {
        const offerTools = { publish: vi.fn(async () => ({})), get: vi.fn() };
        const signer = { createOfferOnChain: vi.fn(async () => ({ signature: 'sig', status: 'open' })), commitOffer: vi.fn(async () => ({ signature: 'sig', status: 'committed' })),
            expireOffer: vi.fn(async () => ({ signature: 'sig', status: 'expired' })) };
        const recordOnchain = vi.fn();
        return { offerTools, signer, recordOnchain, run: action => executeHomeAction({ action, connection: {}, keypair: meKp, persona: { name: 'homebuyer-t' }, index: null,
            offerTools, signer, recordOnchain, personas: [], env: {}, sendAndConfirm: vi.fn(), maxUsdcAtomic: 4_000_000n }) };
    };
    it('make-offer publishes the exact terms and creates them on Solana', async () => {
        const { offerTools, signer, run } = base();
        const action = { type: 'make-offer', direction: 'sell', agreementCid: 'bafround', offerTitle: 'Flat 1 · Towers', city: 'alatau', asset: flatAsset(1), price: '2500000', amount: '2.5',
            lens: null, days: 2, createdAt: at, usdc: 0, signedActions: 1 };
        const result = await run(action);
        const expected = homeOffer({ ...action, proposer: ME });
        expect(offerTools.publish).toHaveBeenCalledWith({ offer: expected.content, expectedCid: expected.cid, confirm: true });
        expect(signer.createOfferOnChain.mock.calls[0][0]).toMatchObject({ keypair: meKp, cluster: 'devnet', row: { cid: expected.cid, content: expected.content } });
        expect(result.offerCid).toBe(expected.cid);
        expect(homeActivityEntity(action)).toEqual({ type: 'agreement', id: 'bafround' });
    });
    it('take-offer commits as the buyer naming the round\'s lens member, or as the seller with the default payout; expire-offer ends it', async () => {
        const { offerTools, signer, run } = base();
        const listing = homeOffer({ direction: 'sell', proposer: OTHER, asset: flatAsset(1), city: 'alatau', price: '2000000', offerTitle: 'Flat 1', createdAt: at, days: 2 });
        offerTools.get.mockResolvedValue({ ...listing, onchain: { cluster: 'devnet' } });
        await run({ type: 'take-offer', role: 'buyer', offerCid: listing.cid, lens: LENS, usdc: 2, signedActions: 1 });
        expect(signer.commitOffer.mock.calls[0][0]).toMatchObject({ row: { cid: listing.cid }, lens: { members: [LENS], threshold: 1 } });
        await expect(run({ type: 'take-offer', role: 'seller', offerCid: listing.cid, usdc: 0, signedActions: 1 })).rejects.toThrow(/not a bid/);
        const bid = homeOffer({ direction: 'buy', proposer: OTHER, lens: LENS, asset: flatAsset(1), city: 'alatau', price: '1000000', offerTitle: 'Flat 1', createdAt: at, days: 2 });
        offerTools.get.mockResolvedValue(bid);
        await run({ type: 'take-offer', role: 'seller', offerCid: bid.cid, usdc: 0, signedActions: 1 });
        expect(signer.commitOffer.mock.calls[1][0]).not.toHaveProperty('lens');
        expect(signer.commitOffer.mock.calls[1][0]).not.toHaveProperty('payouts');
        const expire = { type: 'expire-offer', offerCid: bid.cid, usdc: 0, signedActions: 1 };
        await run(expire);
        expect(signer.expireOffer.mock.calls[0][0]).toMatchObject({ row: { cid: bid.cid } });
        expect(homeActivityEntity(expire)).toEqual({ type: 'property-offer', id: bid.cid });
    });
});
