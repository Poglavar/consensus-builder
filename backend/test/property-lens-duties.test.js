// A round's lens member's property duties (property-lens-duties.js): it states each buyer of an
// executed apartment round as first holder of the flat once (existing statements read first; one
// naming someone else is reported, never replaced), confirms only committed offers where it is the
// buyer's lens through the holder-checked confirmSale (a refusal leaves the offer waiting), stays
// within its per-run cap, and one item's failure never stops the rest. Chain steps are stubbed.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import { confirmAwaitingSales, lensMembersOfDevelopers, propertyLensStage, statePlotHolders, stateRoundHolders } from '../agents/property-lens-duties.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const Offer = require('../../frontend/js/property-offer-record.js');
const Statements = require('../../frontend/js/solana/property-statements.js').configure({ web3 });

const kp = n => Keypair.fromSeed(new Uint8Array(32).fill(n));
const memberKp = kp(71);
const MEMBER = memberKp.publicKey.toBase58();
const [A, B, C, D] = [72, 73, 74, 75].map(n => kp(n).publicKey.toBase58());
const BUILDING = 'design::bafkreign6yfigxrchcmsgzkvwfobaohxhwcibuwv6sxevauizastujd6cy::0';
const unit = id => ({ unitId: `u${id}`, label: `Flat ${id}`, xrayBuilding: BUILDING, unit: `2::${id}`, at: '43.8,77.09,19' });
const asset = id => ({ kind: 'flat', xrayBuilding: BUILDING, unit: `2::${id}`, at: '43.8,77.09,19' });
const round = { cid: 'bafround', title: 'Round 1', account: 'acct', content: { city: 'alatau', funding: { apartments: { units: [1, 2, 3, 4, 5].map(unit) } } } };

function statement(id, holder) {
    const hash = Offer.assetHash(asset(id));
    const payload = Buffer.from(Statements.encodeHoldingPayload({ assetHash: hash, asset: Offer.assetKey(asset(id)), holder, basis: 'developer', observedAt: 1 }));
    const length = Buffer.alloc(4); length.writeUInt32LE(payload.length);
    return Buffer.concat([Buffer.from([2]), Buffer.alloc(96), length, payload, memberKp.publicKey.toBuffer(), Buffer.alloc(8, 0x7f)]);
}

describe('first holders of an executed round', () => {
    it('states only missing buyers, reports a statement naming another holder, and defers past the cap', async () => {
        const existing = new Map([[Statements.holdingAddress(MEMBER, Offer.assetHash(asset(1))).toBase58(), statement(1, A)],
            [Statements.holdingAddress(MEMBER, Offer.assetHash(asset(2))).toBase58(), statement(2, D)]]);
        const connection = { getMultipleAccountsInfo: vi.fn(async keys => keys.map(key => existing.has(key.toBase58()) ? { data: existing.get(key.toBase58()) } : null)) };
        const readRoundInventory = vi.fn(async () => [
            { unitId: 'u1', status: 'reserved', buyer: A }, { unitId: 'u2', status: 'reserved', buyer: B }, { unitId: 'u3', status: 'reserved', buyer: C },
            { unitId: 'u4', status: 'reserved', buyer: D }, { unitId: 'u5', status: 'available', buyer: null }]);
        const stateHolding = vi.fn(async ({ holder }) => {
            if (holder === D) throw new Error('rpc timeout');
            return { signature: `sig-${holder.slice(0, 4)}`, replayed: false };
        });
        const budget = { left: 5 };
        const result = await stateRoundHolders({ connection, memberKeypair: memberKp, rounds: [round], budget, env: {}, deps: { readRoundInventory, stateHolding } });
        expect(result.already).toBe(1);
        expect(result.conflicts).toEqual([expect.stringContaining(`already states ${D}`)]);
        // u3 stated; u4's failure is recorded and did not stop u3 (order: u3 then u4).
        expect(result.stated).toEqual([{ round: 'bafround', unitId: 'u3', holder: C, signature: `sig-${C.slice(0, 4)}` }]);
        expect(result.failures).toEqual([expect.stringContaining('u4: rpc timeout')]);
        expect(stateHolding.mock.calls[0][0]).toMatchObject({ keypair: memberKp, asset: asset(3), city: 'alatau', holder: C, basis: 'developer', evidence: 'agreement:bafround' });
        expect(budget.left).toBe(4);
        const capped = await stateRoundHolders({ connection, memberKeypair: memberKp, rounds: [round], budget: { left: 0 }, env: {}, deps: { readRoundInventory, stateHolding: vi.fn() } });
        expect(capped).toMatchObject({ deferred: 2, stated: [] });
    });
});

describe('confirming waiting sales', () => {
    const row = (cid, buyerLens, sellerLens = { members: [], confirmed: [] }) => ({ cid, content: { asset: asset(1) }, onchain: { cluster: 'devnet', buyerLens, sellerLens } });
    it('confirms as the buyer\'s lens through confirmSale; a refusal waits, a seller\'s-lens request waits, an error is a failure', async () => {
        const offerTools = { list: vi.fn(async () => ({ propertyOffers: [
            row('ok', { members: [MEMBER], confirmed: [] }), row('refused', { members: [MEMBER], confirmed: [] }),
            row('seller-lens', { members: [A], confirmed: [] }, { members: [MEMBER], confirmed: [] }), row('broken', { members: [MEMBER], confirmed: [] })] })) };
        const confirmSale = vi.fn(async ({ row: { cid } }) => {
            if (cid === 'refused') throw Object.assign(new Error('Your statements say X holds this, not the seller'), { code: 'refused' });
            if (cid === 'broken') throw new Error('blockhash expired');
            return { signature: 'sig', status: 'settled' };
        });
        const budget = { left: 5 };
        const recordOnchain = vi.fn();
        const result = await confirmAwaitingSales({ connection: {}, memberKeypair: memberKp, offerTools, recordOnchain, budget, deps: { confirmSale } });
        expect(offerTools.list).toHaveBeenCalledWith({ awaiting: MEMBER, limit: 100 });
        expect(result.confirmed).toEqual([{ cid: 'ok', signature: 'sig', status: 'settled' }]);
        expect(result.waiting.map(item => item.cid)).toEqual(['refused', 'seller-lens']);
        expect(result.failures).toEqual([expect.stringContaining('broken: blockhash expired')]);
        expect(confirmSale).toHaveBeenCalledTimes(3);
        expect(confirmSale.mock.calls[0][0]).toMatchObject({ keypair: memberKp, recordOnchain, row: { cid: 'ok', onchain: { cluster: 'devnet' } } });
        expect(budget.left).toBe(4);
    });
});

describe('first holders of plot-market plots', () => {
    const plot = id => ({ kind: 'parcel', sourceId: 'kz-alatau-pkk', id, at: '43.61,77.02,18' });
    const plots = ['P1', 'P2', 'P3', 'P4'].map(id => ({ key: id, label: `Plot ${id}`, city: 'alatau', asset: plot(id), assetHash: Offer.assetHash(plot(id)), lens: MEMBER }));
    function plotStatement(id, holder) {
        const payload = Buffer.from(Statements.encodeHoldingPayload({ assetHash: Offer.assetHash(plot(id)), asset: Offer.assetKey(plot(id)), holder, basis: 'registry', observedAt: 1 }));
        const length = Buffer.alloc(4); length.writeUInt32LE(payload.length);
        return Buffer.concat([Buffer.from([2]), Buffer.alloc(96), length, payload, memberKp.publicKey.toBuffer(), Buffer.alloc(8, 0x7f)]);
    }
    it('states the registry\'s sole owner once, skips shared or unowned plots, and never replaces another statement', async () => {
        const existing = new Map([[Statements.holdingAddress(MEMBER, plots[1].assetHash).toBase58(), plotStatement('P2', B)],
            [Statements.holdingAddress(MEMBER, plots[2].assetHash).toBase58(), plotStatement('P3', D)]]);
        const connection = { getMultipleAccountsInfo: vi.fn(async keys => keys.map(key => existing.has(key.toBase58()) ? { data: existing.get(key.toBase58()) } : null)) };
        const owners = new Map([['P1', [{ owner: A, ownerCount: 1 }]], ['P2', [{ owner: B, ownerCount: 1 }]], ['P3', [{ owner: C, ownerCount: 1 }]],
            ['P4', [{ owner: A, ownerCount: 2 }, { owner: C, ownerCount: 2 }]]]);
        const stateHolding = vi.fn(async () => ({ signature: 'sig' }));
        const budget = { left: 5 };
        const result = await statePlotHolders({ connection, memberKeypair: memberKp, plots, readOwners: async () => owners, budget, env: {}, deps: { stateHolding } });
        expect(result).toMatchObject({ stated: [{ plot: 'P1', holder: A, signature: 'sig' }], already: 1, unowned: 1, failures: [] });
        expect(result.conflicts).toEqual([expect.stringContaining(`P3: this lens member already states ${D}`)]);
        expect(stateHolding).toHaveBeenCalledTimes(1);
        expect(stateHolding.mock.calls[0][0]).toMatchObject({ asset: plot('P1'), city: 'alatau', holder: A, basis: 'registry', evidence: 'devnet-registry:P1' });
        expect(budget.left).toBe(4);
    });
});

describe('the runner stage', () => {
    const personas = [{ name: 'lifecycle-01', role: 'lens-member', wallet: MEMBER }, { name: 'notary-01', role: 'lens-member', wallet: A },
        { name: 'developer-01', role: 'developer', wallet: B, developer: { city: 'alatau', lens: 'lifecycle-01' } },
        { name: 'developer-02', role: 'developer', wallet: C, developer: { city: 'alatau', lens: 'notary-01' } }];
    it('acts only for lens members it signs for that serve a developer of this run', () => {
        expect([...lensMembersOfDevelopers(personas, personas, [MEMBER]).entries()]).toEqual([[MEMBER, [personas[2]]]]);
        expect(lensMembersOfDevelopers(personas, [personas[3]], [MEMBER]).size).toBe(0);
    });
    it('states holders, confirms sales, reports each problem into the run verdict and a summary line', async () => {
        const failures = [], report = [];
        const deps = {
            executedRoundsOf: vi.fn(async () => [round]),
            readRoundInventory: vi.fn(async () => [{ unitId: 'u1', status: 'reserved', buyer: A }]),
            stateHolding: vi.fn(async () => ({ signature: 'sig' })),
            confirmSale: vi.fn(async () => { throw Object.assign(new Error('not the seller'), { code: 'refused' }); })
        };
        const connection = { getMultipleAccountsInfo: vi.fn(async keys => keys.map(() => null)) };
        const offerTools = { list: vi.fn(async () => ({ propertyOffers: [{ cid: 'o1', content: {}, onchain: { buyerLens: { members: [MEMBER], confirmed: [] } } }] })) };
        // One plot market of this member: its plot's sole registry owner is stated too.
        const markets = [{ city: 'alatau', lens: 'lifecycle-01', sourceId: 'kz-alatau-pkk', plots: [{ id: 'KZ-1', at: '43.61,77.02,18', label: 'Plot 1' }] }];
        const readOwners = vi.fn(async ids => new Map(ids.map(id => [id, [{ owner: C, ownerCount: 1 }]])));
        await propertyLensStage({ connection, index: {}, personas, developers: [personas[2]], memberSigners: { [MEMBER]: () => memberKp }, offerTools, recordOnchain: vi.fn(),
            readOwners, markets, failures, report, env: { AGENT_PROPERTY_LENS_MAX_PER_RUN: '3' }, deps });
        expect(deps.executedRoundsOf.mock.calls[0][0]).toMatchObject({ member: MEMBER, developers: [personas[2]] });
        expect(readOwners).toHaveBeenCalledWith(['KZ-1']);
        expect(deps.stateHolding.mock.calls[1][0]).toMatchObject({ holder: C, basis: 'registry', city: 'alatau', asset: { kind: 'parcel', id: 'KZ-1' } });
        expect(failures).toEqual([]);
        expect(report).toEqual(['lifecycle-01: 1 flat first holder(s) stated (0 already) · 1 plot first holder(s) stated (0 already, 0 without a sole registry owner) · 0 sale(s) confirmed · 1 waiting']);
        deps.executedRoundsOf.mockRejectedValueOnce(new Error('index down'));
        await propertyLensStage({ connection, index: {}, personas, developers: [personas[2]], memberSigners: { [MEMBER]: () => memberKp }, offerTools, recordOnchain: vi.fn(),
            markets: [], failures, report, env: {}, deps });
        // The holders half failed; the confirmations half still ran.
        expect(failures).toEqual(['lifecycle-01 property lens: first holders: index down']);
        expect(deps.confirmSale).toHaveBeenCalledTimes(2);
    });
});
