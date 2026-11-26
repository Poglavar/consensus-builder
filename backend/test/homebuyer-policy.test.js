// policies/homebuyer.js: obligations come first (take back a deposit from a round that ended
// unexecuted, settle an accepted offer it buys, accept an offer it can take), then one seed-stable
// choice among reserving an apartment, listing a held one, bidding on another's and contributing to a
// plain round, within the persona's limits and the invocation budget.
import { describe, expect, it } from 'vitest';
import { decide, offerPrice, policyConfig } from '../agents/policies/homebuyer.js';

const ME = 'Me1111111111111111111111111111111111111111';
const OTHER = 'Other11111111111111111111111111111111111111';
const DEV = 'Dev111111111111111111111111111111111111111';
const NOW = Date.parse('2026-11-26T12:00:00Z');
const persona = (policy = {}) => ({ name: 'homebuyer-t', policy: { cities: ['alatau'], offerLens: 'lifecycle-01', ...policy } });
const unit = (id, { status = 'available', buyer = null, deposit = '2000000' } = {}) => ({ unitId: id, label: `Flat ${id}`, xrayBuilding: 'design::bafy::0', unit: `1::${id}::aaaaaaaaaaaaaaaaaaaaaaaa`,
    at: '43.8,77.09,19', priceUsdcAtomic: '7000000', depositUsdcAtomic: deposit, status, buyer });
const round = (cid, units, extra = {}) => ({ cid, account: `acct-${cid}`, sponsor: DEV, title: `Round ${cid}`, city: 'alatau', deadline: '2026-11-29T12:00:00Z',
    chainStatus: 'active', plain: false, targetUsdcAtomic: '5000000', units, ...extra });
const offer = (cid, { direction = 'sell', proposer = OTHER, status = 'Open', buyer = null, apartmentOf = unit('u1') } = {}) => ({ cid,
    content: { direction, proposer, title: `Offer ${cid}`, priceLamports: '20000000', expiresAt: '2026-11-28T12:00:00Z', apartment: { xrayBuilding: apartmentOf.xrayBuilding, unit: apartmentOf.unit, at: apartmentOf.at } },
    chain: { status, buyer, seller: null, escrowLamports: '0', priceLamports: '20000000', deadline: String(Date.parse('2026-11-28T12:00:00Z') / 1000) } });
const run = (homes, policy, budget = { actionsLeft: 3, usdcLeft: 4 }) => decide({ persona: persona(policy), seed: 's1', now: NOW, wallet: ME, homes, budget });

describe('obligations', () => {
    it('takes back a deposit first, then settles an accepted offer it buys, then accepts an offer', () => {
        const homes = { rounds: [round('r1', [unit('u1'), unit('u2')])],
            refunds: [{ cid: 'r0', account: 'acct-r0', title: 'Round r0', chainStatus: 'expired', amount: '2000000' }],
            offers: [offer('o-accepted', { status: 'Accepted', buyer: ME }), offer('o-open')] };
        expect(run(homes).action).toMatchObject({ type: 'refundMyDonations', agreementCid: 'r0' });
        expect(run({ ...homes, refunds: [] }).action).toMatchObject({ type: 'settle-offer', offerCid: 'o-accepted', signedActions: 2 });
        expect(run({ ...homes, refunds: [], offers: [offer('o-open')] }).action).toMatchObject({ type: 'accept-offer', offerCid: 'o-open', role: 'buyer' });
    });
    it('sells only an apartment it holds to a bid, and never accepts its own offer', () => {
        const held = unit('u1', { status: 'reserved', buyer: ME });
        const bid = offer('bid', { direction: 'buy', apartmentOf: held });
        expect(run({ rounds: [round('r1', [held])], refunds: [], offers: [bid] }).action).toMatchObject({ type: 'accept-offer', role: 'seller' });
        expect(run({ rounds: [round('r1', [unit('u1')])], refunds: [], offers: [bid] }, { weights: { reserve: 0, offerSell: 0, offerBuy: 0, donate: 0 } }).action).toBeNull();
        expect(run({ rounds: [], refunds: [], offers: [offer('mine', { proposer: ME })] }, { weights: { reserve: 0, offerSell: 0, offerBuy: 0, donate: 0 } }).action).toBeNull();
    });
});

describe('choices', () => {
    const only = kind => ({ weights: { reserve: 0, offerSell: 0, offerBuy: 0, donate: 0, [kind]: 1 } });
    it('reserves an available apartment within its deposit limit, one per round and up to maxReservations', () => {
        const homes = { rounds: [round('r1', [unit('u1', { deposit: '5000000' }), unit('u2')])], refunds: [], offers: [] };
        expect(run(homes, only('reserve')).action).toMatchObject({ type: 'reserve-apartment', unitId: 'u2', usdc: 2, amount: '2' });
        const holding = { rounds: [round('r1', [unit('u1', { status: 'reserved', buyer: ME }), unit('u2')]), round('r2', [unit('u3')])], refunds: [], offers: [] };
        expect(run(holding, only('reserve')).action).toMatchObject({ agreementCid: 'r2', unitId: 'u3' });
        expect(run(holding, { ...only('reserve'), maxReservations: 1 }).action).toBeNull();
        // A round closing within the hour or its own developer's round is not offered.
        expect(run({ rounds: [round('r3', [unit('u1')], { deadline: '2026-11-26T12:30:00Z' }), round('r4', [unit('u1')], { sponsor: ME })], refunds: [], offers: [] }, only('reserve')).action).toBeNull();
    });
    it('lists a held apartment, bids on another\'s, and contributes once to a plain round', () => {
        const held = unit('u1', { status: 'reserved', buyer: ME });
        const theirs = unit('u2', { status: 'reserved', buyer: OTHER });
        const homes = { rounds: [round('r1', [held, theirs]), round('p1', [], { plain: true })], refunds: [], offers: [] };
        expect(run(homes, only('offerSell')).action).toMatchObject({ type: 'make-offer', direction: 'sell', apartment: { unit: held.unit }, lens: 'lifecycle-01' });
        expect(run(homes, only('offerBuy')).action).toMatchObject({ type: 'make-offer', direction: 'buy', apartment: { unit: theirs.unit } });
        expect(run(homes, only('donate')).action).toMatchObject({ type: 'donate', agreementCid: 'p1', amount: '0.5' });
        expect(run({ ...homes, rounds: [round('p1', [], { plain: true, donatedByMe: true })] }, only('donate')).action).toBeNull();
    });
    it('stays within the invocation budget and reports the cap', () => {
        const homes = { rounds: [round('r1', [unit('u1')])], refunds: [], offers: [] };
        expect(run(homes, { weights: { reserve: 1, offerSell: 0, offerBuy: 0, donate: 0 } }, { actionsLeft: 3, usdcLeft: 1 })).toMatchObject({ action: null, capped: true });
    });
    it('prices offers between its bounds on 0.001 SOL steps, stable for a seed', () => {
        const config = policyConfig(persona({ offerMinSol: '0.01', offerMaxSol: '0.03' }));
        const price = offerPrice('seed', config);
        expect(price).toBe(offerPrice('seed', config));
        expect(price >= 10_000_000n && price <= 30_000_000n && price % 1_000_000n === 0n).toBe(true);
    });
});
