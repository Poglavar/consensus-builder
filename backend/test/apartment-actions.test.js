// apartment-actions.js: the developer lists only unlisted units (escrow opened by the first listing,
// four listings a transaction), only the round's sponsor lists, a unit that is not available is never
// reserved, and the lens operator's qualification must name the buyer.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import { listApartments, qualifyApartmentBuyer, qualifyOfferCounterparty, reserveApartment, roundAccepting, roundStats } from '../agents/apartment-actions.js';

const require = createRequire(import.meta.url);
const pledge = require('../../frontend/js/solana/pledge-client.js');

const developer = Keypair.generate();
const account = Keypair.generate().publicKey.toBase58();
const unit = id => ({ unitId: id, label: id, xrayBuilding: 'zagreb::gdi-3d::148972', unit: `6::${id}`, at: '45.8,15.96,19',
    priceUsdcAtomic: '5000000', depositUsdcAtomic: '1000000', drawing: { name: `${id}.pdf`, mediaType: 'application/pdf', data: 'JVBERi0=' } });
const content = (count = 6) => ({ sponsor: developer.publicKey.toBase58(), funding: { targetUsdcAtomic: '3000000',
    contract: { name: 'terms.txt', mediaType: 'text/plain', data: 'dGVybXM=' }, apartments: { projectId: 'demo', units: Array.from({ length: count }, (_, i) => unit(`u${i + 1}`)) } } });
// Nothing exists on this chain yet: every unit unlisted, no escrow.
const emptyChain = () => ({ getMultipleAccountsInfo: vi.fn(async keys => keys.map(() => null)), getAccountInfo: vi.fn(async () => null) });

describe('listing a round\'s apartments', () => {
    it('lists every unlisted unit, four a transaction, the first one opening the escrow', async () => {
        const sent = [];
        const result = await listApartments({ connection: emptyChain(), developerKeypair: developer, account, content: content(6),
            sendAndConfirm: async (_c, transaction) => { sent.push(transaction.instructions.map(ix => Buffer.from(ix.data.subarray(0, 8)).toString('hex'))); return `sig${sent.length}`; } });
        expect(result).toEqual({ listed: 6, alreadyListed: 0, signatures: ['sig1', 'sig2'] });
        const disc = name => Buffer.from(pledge.IX_DISCRIMINATORS[name]).toString('hex');
        expect(sent[0]).toEqual([disc('create_donation_escrow'), ...Array(4).fill(disc('list_apartment'))]);
        expect(sent[1]).toEqual(Array(2).fill(disc('list_apartment')));
    });
    it('refuses a wallet other than the round\'s developer before reading anything', async () => {
        const connection = emptyChain();
        await expect(listApartments({ connection, developerKeypair: Keypair.generate(), account, content: content(1), sendAndConfirm: vi.fn() }))
            .rejects.toThrow(/Only the round's developer/);
        expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
    });
});

describe('reserving an apartment', () => {
    it('never signs for a unit that is not listed and available', async () => {
        const sendAndConfirm = vi.fn();
        const buyer = Keypair.generate();
        await expect(reserveApartment({ connection: emptyChain(), buyerKeypair: buyer, account, content: content(2), unitId: 'u1', qualification: {}, sendAndConfirm }))
            .rejects.toMatchObject({ code: 'UNIT_UNAVAILABLE' });
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });
});

describe('a round\'s states and counts', () => {
    const NOW = 1_800_000_000;
    const active = { status: 'Active', deadline: NOW + 3600 };
    it('accepts only while the account is Active on chain and before its deadline', () => {
        expect(roundAccepting(active, NOW)).toBe(true);
        expect(roundAccepting({ ...active, deadline: NOW - 1 }, NOW)).toBe(false);
        expect(roundAccepting({ ...active, status: 'Executed' }, NOW)).toBe(false);
        expect(roundAccepting(null, NOW)).toBe(false);
    });
    it('reads each unit\'s state and the counts, deposits and floors with the browser\'s model', () => {
        const buyer = Keypair.generate().publicKey.toBase58();
        const units = [{ unitId: 'u1', status: 'reserved', buyer }, { unitId: 'u2', status: 'available' }, { unitId: 'u3', status: 'unavailable' }];
        const stats = roundStats({ funding: content(4).funding, units, chainAccount: active, nowSeconds: NOW });
        expect(stats).toMatchObject({ accepting: true, chainStatus: 'Active', counts: { offered: 4, reserved: 1, available: 1, unavailable: 2 },
            reservedDeposits: '1000000', target: '3000000', percent: 33, floors: [{ building: 1, level: 6, offered: 4, reserved: 1, available: 1, unavailable: 2 }] });
        expect(stats.units.map(({ unitId, state, reason, buyer: holder }) => [unitId, state, reason, holder])).toEqual([
            ['u1', 'reserved', null, buyer], ['u2', 'available', null, null], ['u3', 'unavailable', 'heldElsewhere', null], ['u4', 'unavailable', 'unlisted', null]
        ]);
        // Past its deadline a listed unit is closed, not available.
        const closed = roundStats({ funding: content(4).funding, units, chainAccount: { ...active, deadline: NOW - 1 }, nowSeconds: NOW });
        expect(closed.units[1]).toMatchObject({ state: 'unavailable', reason: 'closed' });
        expect(closed.accepting).toBe(false);
    });
});

describe('the lens operator qualifying a buyer', () => {
    const buyer = Keypair.generate().publicKey.toBase58();
    it('posts the buyer with the operator token and returns the attestation naming it', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ address: 'att', credential: 'cred', payload: { buyer, counterpartyQualified: 1 } }) }));
        const record = await qualifyApartmentBuyer({ serviceUrl: 'http://lens/', operatorToken: 'secret', cid: 'bafy', unitId: 'u1', buyer, fetchImpl });
        expect(record.address).toBe('att');
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('http://lens/lens/agreements/bafy/apartments/u1/qualify');
        expect(init.headers['x-lens-operator-token']).toBe('secret');
        expect(JSON.parse(init.body)).toEqual({ buyer });
    });
    it('qualifies an offer\'s counterparty for its exact parties and payouts', async () => {
        const seller = Keypair.generate().publicKey.toBase58();
        const payouts = [{ recipient: seller, lamports: '10000000' }];
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ address: 'att', payload: { buyer, seller, counterpartyQualified: 1 } }) }));
        await qualifyOfferCounterparty({ serviceUrl: 'http://lens', operatorToken: 'secret', cid: 'bafy', buyer, seller, payouts, fetchImpl });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('http://lens/lens/property-offers/bafy/qualify');
        expect(JSON.parse(init.body)).toEqual({ buyer, seller, payouts });
        const swapped = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ payload: { buyer: seller, seller: buyer, counterpartyQualified: 1 } }) }));
        await expect(qualifyOfferCounterparty({ serviceUrl: 'http://lens', operatorToken: 'secret', cid: 'bafy', buyer, seller, payouts, fetchImpl: swapped })).rejects.toThrow(/other parties/);
    });
    it('refuses an answer for another buyer, and needs the token', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ address: 'att', credential: 'cred', payload: { buyer: 'someone-else', counterpartyQualified: 1 } }) }));
        await expect(qualifyApartmentBuyer({ serviceUrl: 'http://lens', operatorToken: 'secret', cid: 'bafy', unitId: 'u1', buyer, fetchImpl })).rejects.toThrow(/does not name this buyer/);
        await expect(qualifyApartmentBuyer({ serviceUrl: 'http://lens', operatorToken: null, cid: 'bafy', unitId: 'u1', buyer, fetchImpl })).rejects.toThrow(/operator token/);
    });
});
