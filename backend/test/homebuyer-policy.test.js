// policies/homebuyer.js: obligations come first (take back a deposit from a round that ended
// unexecuted), then one seed-stable choice between reserving an apartment and contributing to a
// plain round, within the persona's limits and the invocation budget.
import { describe, expect, it } from 'vitest';
import { decide } from '../agents/policies/homebuyer.js';

const ME = 'Me1111111111111111111111111111111111111111';
const DEV = 'Dev111111111111111111111111111111111111111';
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
