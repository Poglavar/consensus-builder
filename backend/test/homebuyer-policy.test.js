// policies/homebuyer.js: obligations come first (take back a deposit from a round that ended
// unexecuted, end an own expired offer, create a published one on chain, accept a bid on a flat it
// holds, take a listing whose seller holds the flat), then one seed-stable choice among reserving an
// apartment, listing a held flat, bidding for another's and contributing to a plain round, within the
// persona's limits and the invocation budget. "Holds" is the round's lens member's word.
import { describe, expect, it } from 'vitest';
import { decide, offerPrice, policyConfig } from '../agents/policies/homebuyer.js';

const ME = 'Me1111111111111111111111111111111111111111';
const DEV = 'Dev111111111111111111111111111111111111111';
const OTHER = 'Other11111111111111111111111111111111111111';
const LENS = 'Lens111111111111111111111111111111111111111';
const NOW = Date.parse('2026-11-26T12:00:00Z');
const persona = (policy = {}) => ({ name: 'homebuyer-t', policy: { cities: ['alatau'], ...policy } });
const unit = (id, { status = 'available', buyer = null, deposit = '2000000' } = {}) => ({ unitId: id, label: `Flat ${id}`, xrayBuilding: 'design::bafy::0', unit: `1::${id}::aaaaaaaaaaaaaaaaaaaaaaaa`,
    at: '43.8,77.09,19', priceUsdcAtomic: '7000000', depositUsdcAtomic: deposit, status, buyer });
const round = (cid, units, extra = {}) => ({ cid, account: `acct-${cid}`, sponsor: DEV, title: `Round ${cid}`, city: 'alatau', deadline: '2026-11-29T12:00:00Z',
    chainStatus: 'active', plain: false, targetUsdcAtomic: '5000000', units, ...extra });
const run = (homes, policy, budget = { actionsLeft: 3, usdcLeft: 4 }) => decide({ persona: persona(policy), seed: 's1', now: NOW, wallet: ME, homes, budget });

describe('obligations', () => {
    it('takes back a deposit first', () => {
        const homes = { rounds: [round('r1', [unit('u1'), unit('u2')])],
            refunds: [{ cid: 'r0', account: 'acct-r0', title: 'Round r0', chainStatus: 'expired', amount: '2000000' }] };
        expect(run(homes).action).toMatchObject({ type: 'refundMyDonations', agreementCid: 'r0' });
    });
});

describe('choices', () => {
    const only = kind => ({ weights: { reserve: 0, donate: 0, [kind]: 1 } });
    it('reserves an available apartment within its deposit limit, one per round and up to maxReservations', () => {
        const homes = { rounds: [round('r1', [unit('u1', { deposit: '5000000' }), unit('u2')])], refunds: [] };
        expect(run(homes, only('reserve')).action).toMatchObject({ type: 'reserve-apartment', unitId: 'u2', usdc: 2, amount: '2' });
        const holding = { rounds: [round('r1', [unit('u1', { status: 'reserved', buyer: ME }), unit('u2')]), round('r2', [unit('u3')])], refunds: [] };
        expect(run(holding, only('reserve')).action).toMatchObject({ agreementCid: 'r2', unitId: 'u3' });
        expect(run(holding, { ...only('reserve'), maxReservations: 1 }).action).toBeNull();
        // A round closing within the hour or its own developer's round is not offered.
        expect(run({ rounds: [round('r3', [unit('u1')], { deadline: '2026-11-26T12:30:00Z' }), round('r4', [unit('u1')], { sponsor: ME })], refunds: [] }, only('reserve')).action).toBeNull();
    });
    it('contributes once to a plain round', () => {
        const homes = { rounds: [round('r1', [unit('u1', { status: 'reserved', buyer: ME })]), round('p1', [], { plain: true })], refunds: [] };
        expect(run(homes, only('donate')).action).toMatchObject({ type: 'donate', agreementCid: 'p1', amount: '0.5' });
        expect(run({ ...homes, rounds: [round('p1', [], { plain: true, donatedByMe: true })] }, only('donate')).action).toBeNull();
    });
    it('stays within the invocation budget and reports the cap', () => {
        const homes = { rounds: [round('r1', [unit('u1')])], refunds: [] };
        expect(run(homes, { weights: { reserve: 1, donate: 0 } }, { actionsLeft: 3, usdcLeft: 1 })).toMatchObject({ action: null, capped: true });
    });
});

describe('flat offers (USDC)', () => {
    const none = { weights: { reserve: 0, donate: 0, offerSell: 0, offerBuy: 0 } };
    const only = kind => ({ weights: { ...none.weights, [kind]: 1 } });
    const flat = (id, holder, extra = {}) => ({ roundCid: 'r9', roundTitle: 'Round r9', title: `Flat ${id} · Towers`, city: 'alatau', label: `Flat ${id}`,
        asset: { kind: 'flat', xrayBuilding: 'design::bafy::0', unit: `1::${id}`, at: '43.8,77.09,19' }, assetHash: `hash-${id}`, lens: LENS, holder, holding: holder ? `first-${id}` : null,
        pending: null, stale: false, ...extra });
    const offer = (cid, { id = '1', direction = 'sell', proposer = OTHER, price = '2000000', lens = direction === 'buy' ? { members: [LENS], threshold: 1 } : { members: [], threshold: 0 },
        status = 'Open', buyer = direction === 'buy' ? proposer : null, escrow = direction === 'buy' ? price : '0', expiresAt = '2026-11-28T12:00:00.000Z', chain = true } = {}) => ({
        cid, assetHash: `hash-${id}`,
        content: { schema: 'property-offer/v2', title: `Offer ${cid}`, city: 'alatau', direction, proposer, currency: 'USDC', price, lens, expiresAt, asset: flat(id).asset },
        chain: chain ? { status, maker: proposer, buyer, seller: direction === 'sell' ? proposer : null, price, escrow, deadline: String(Date.parse(expiresAt) / 1000) } : null });
    const homes = (flats, offers = []) => ({ rounds: [], refunds: [], flats, offers });

    it('trades a plot-market plot as it trades a flat: lists the plot it holds, bids for one another holds', () => {
        const plot = (id, holder) => ({ roundCid: null, roundTitle: `Plot ${id}`, title: `Plot ${id}`, city: 'alatau', label: `Plot ${id}`,
            asset: { kind: 'parcel', sourceId: 'kz-alatau-pkk', id: `KZ-${id}`, at: '43.61,77.02,18' }, assetHash: `hash-p${id}`, lens: LENS, holder, holding: `first-p${id}`, pending: null, stale: false });
        const sell = run(homes([plot('1', ME)]), only('offerSell')).action;
        expect(sell).toMatchObject({ type: 'make-offer', direction: 'sell', agreementCid: null, offerTitle: 'Plot 1', lens: null, usdc: 0,
            asset: { kind: 'parcel', id: 'KZ-1' } });
        const bid = run(homes([plot('2', OTHER)]), only('offerBuy')).action;
        expect(bid).toMatchObject({ type: 'make-offer', direction: 'buy', lens: LENS, asset: { kind: 'parcel', id: 'KZ-2' } });
        expect(bid.usdc).toBeGreaterThan(0);
    });
    it('ends its own offer past the deadline first, then creates a published one, then accepts a bid, then takes a listing', () => {
        const flats = [flat('1', ME), flat('2', OTHER), flat('3', ME), flat('4', OTHER)];
        const expired = offer('o-exp', { id: '3', proposer: ME, expiresAt: '2026-11-25T12:00:00.000Z' });
        const unminted = offer('o-new', { id: '3', proposer: ME, chain: false });
        const bid = offer('o-bid', { id: '1', direction: 'buy' });
        const listing = offer('o-list', { id: '2' });
        expect(run(homes(flats, [listing, bid, unminted, expired]), none).action).toMatchObject({ type: 'expire-offer', offerCid: 'o-exp' });
        expect(run(homes(flats, [listing, bid, unminted]), none).action).toMatchObject({ type: 'mint-offer', offerCid: 'o-new', usdc: 0 });
        expect(run(homes(flats, [listing, bid]), none).action).toMatchObject({ type: 'take-offer', role: 'seller', offerCid: 'o-bid', usdc: 0 });
        expect(run(homes(flats, [listing]), none).action).toMatchObject({ type: 'take-offer', role: 'buyer', offerCid: 'o-list', lens: LENS, usdc: 2, amount: '2' });
    });
    it('takes back the escrow of a listing it took that expired, but leaves another buyer\'s escrow to that buyer', () => {
        const flats = [flat('2', OTHER)];
        const taken = offer('o-taken', { id: '2', status: 'Committed', buyer: ME, escrow: '2000000', expiresAt: '2026-11-25T12:00:00.000Z' });
        expect(run(homes(flats, [taken]), none).action).toMatchObject({ type: 'expire-offer', amount: '2' });
        const theirs = offer('o-theirs', { id: '2', status: 'Committed', buyer: DEV, escrow: '2000000', expiresAt: '2026-11-25T12:00:00.000Z' });
        expect(run(homes(flats, [theirs]), none).action).toBeNull();
    });
    it('takes only what the lens member can confirm: the seller holds the flat, no seller\'s lens, the bid\'s lens is the round\'s', () => {
        // The listing's maker does not hold the flat according to the lens member.
        expect(run(homes([flat('2', DEV)], [offer('o', { id: '2' })]), none).action).toBeNull();
        // Nobody holds it yet (no first-holder statement).
        expect(run(homes([flat('2', null)], [offer('o', { id: '2' })]), none).action).toBeNull();
        // A seller's lens it cannot satisfy.
        expect(run(homes([flat('2', OTHER)], [offer('o', { id: '2', lens: { members: [DEV], threshold: 1 } })]), none).action).toBeNull();
        // A bid naming another lens member, or a flat with a sale in progress.
        expect(run(homes([flat('1', ME)], [offer('o', { id: '1', direction: 'buy', lens: { members: [DEV], threshold: 1 } })]), none).action).toBeNull();
        expect(run(homes([flat('1', ME, { pending: 'offer-x' })], [offer('o', { id: '1', direction: 'buy' })]), none).action).toBeNull();
        expect(run(homes([flat('2', OTHER)], [offer('o', { id: '2' }), offer('c', { id: '2', status: 'Committed', buyer: DEV, escrow: '2000000' })]), none).action).toBeNull();
        // An offer not on a flat of an executed round, in SOL, or its own.
        expect(run(homes([flat('2', OTHER)], [{ ...offer('o', { id: '2' }), assetHash: 'elsewhere' }]), none).action).toBeNull();
        expect(run(homes([flat('2', OTHER)], [{ ...offer('o', { id: '2' }), content: { ...offer('o', { id: '2' }).content, currency: 'SOL' } }]), none).action).toBeNull();
        expect(run(homes([flat('1', ME)], [offer('o', { id: '1', proposer: ME })]), none).action).toBeNull();
    });
    it('keeps to its price bounds and its number of open offers', () => {
        const flats = [flat('2', OTHER)];
        expect(run(homes(flats, [offer('o', { id: '2', price: '3500000' })]), { ...none, offerMaxUsdc: '3' }).action).toBeNull();
        expect(run(homes([flat('1', ME)], [offer('o', { id: '1', direction: 'buy', price: '500000' })]), { ...none, offerMinUsdc: '1' }).action).toBeNull();
        const busy = [offer('m1', { id: '5', proposer: ME }), offer('m2', { id: '6', proposer: ME, direction: 'buy' })];
        expect(run(homes([...flats, flat('5', ME), flat('6', DEV)], [offer('o', { id: '2' }), ...busy]), { ...none, maxOpenOffers: 2 }).action).toBeNull();
        expect(run(homes([...flats, flat('5', ME), flat('6', DEV)], [offer('o', { id: '2' }), ...busy]), { ...none, maxOpenOffers: 3 }).action).toMatchObject({ type: 'take-offer', offerCid: 'o' });
    });
    it('lists a held flat for sale and bids for another\'s, once per flat, priced within its bounds', () => {
        const flats = [flat('1', ME), flat('2', OTHER)];
        const sell = run(homes(flats), only('offerSell')).action;
        expect(sell).toMatchObject({ type: 'make-offer', direction: 'sell', asset: { unit: '1::1' }, lens: null, usdc: 0, days: 2, createdAt: '2026-11-26T12:00:00.000Z' });
        expect(BigInt(sell.price) >= 1_000_000n && BigInt(sell.price) <= 3_000_000n).toBe(true);
        const buy = run(homes(flats), only('offerBuy')).action;
        expect(buy).toMatchObject({ type: 'make-offer', direction: 'buy', asset: { unit: '1::2' }, lens: LENS, usdc: Number(buy.price) / 1e6 });
        expect(run(homes(flats, [offer('s', { id: '1', proposer: ME })]), only('offerSell')).action).toBeNull();
        expect(run(homes([flat('1', ME, { stale: true })]), only('offerSell')).action).toBeNull();
        expect(run(homes([flat('3', null)]), only('offerBuy')).action).toBeNull();
    });
    it('prices offers on 0.01 USDC steps between its bounds, stable for a seed', () => {
        const config = policyConfig(persona({ offerMinUsdc: '1', offerMaxUsdc: '3' }));
        expect(offerPrice('seed', config)).toBe(offerPrice('seed', config));
        const price = offerPrice('seed', config);
        expect(price >= 1_000_000n && price <= 3_000_000n && price % 10_000n === 0n).toBe(true);
        expect(() => policyConfig(persona({ offerMinUsdc: '4', offerMaxUsdc: '3' }))).toThrow(/exceeds/);
    });
});
