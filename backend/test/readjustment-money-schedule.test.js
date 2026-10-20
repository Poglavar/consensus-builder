// The land-readjustment money schedule: owners may pay as well as receive, the sponsor's line makes
// the schedule sum to zero, only the sponsor's share needs funding, and deals without owner payments
// keep the fingerprint their owners already signed.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const deal = require('../../frontend/js/reparcellization-deal.js');
const validation = require('../../frontend/js/reparcellization-validation.js');
const review = require('../../frontend/js/proposals/approval-review.js');
const agreements = require('../../frontend/js/reparcellization-agreements.js');

const square = (x, y, size) => ({ type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] });
function proposal(ownerShares, extra = {}) {
    const offer = ownerShares.reduce((sum, owner) => sum + (owner.cashOffer || 0), 0);
    return {
        proposalId: 'money-test', goal: 'reparcellization', cadastreParcelIds: ['parcel-a', 'parcel-b'],
        offer, offerCurrency: 'EUR', isConditional: true,
        approvalConfig: { schema: 'proposal-approval/v1', policy: { type: 'unanimous' }, rights: { schema: 'parcel-rights/v1',
            source: { provider: 'upload' }, parcels: [
                { parcelId: 'parcel-a', complete: true, areaM2: 100, owners: [{ ownerId: 'owner-a', share: '1/1' }] },
                { parcelId: 'parcel-b', complete: true, areaM2: 100, owners: [{ ownerId: 'owner-b', share: '1/1' }] }
            ] } },
        lens: ['member-a'],
        reparcellization: {
            poolGeometry: { type: 'Polygon', coordinates: [[[15.98, 45.8], [15.9804, 45.8], [15.9804, 45.8002], [15.98, 45.8002], [15.98, 45.8]]] },
            poolSource: 'site', contributionBasis: 'area',
            polygons: [
                { geometry: square(15.98, 45.8, 0.0002), owners: [{ ownerKey: 'owner-a', share: 1 }] },
                { geometry: square(15.9802, 45.8, 0.0002), owners: [{ ownerKey: 'owner-b', share: 1 }] }
            ],
            ownerShares
        },
        ...extra
    };
}

describe('balanced money schedule', () => {
    it('lets an owner pay, and gives the sponsor the line that balances the schedule', () => {
        const both = proposal([{ ownerKey: 'owner-a', cashOffer: 0, cashPayment: 12.5 }, { ownerKey: 'owner-b', cashOffer: 30 }]);
        const content = deal.content(both);
        expect(content.ledger.find(row => row.ownerKey === 'owner-a')).toMatchObject({ cashCents: 0, payCents: 1250 });
        expect(content.ledger.find(row => row.ownerKey === 'owner-b')).not.toHaveProperty('payCents');
        expect(deal.schedule(content)).toEqual({
            currency: 'EUR', payOutCents: 3000, payInCents: 1250, sponsorCents: -1750, sponsorFundingCents: 1750, balanced: true,
            lines: [{ party: 'owner', ownerKey: 'owner-a', amountCents: -1250 }, { party: 'owner', ownerKey: 'owner-b', amountCents: 3000 },
                { party: 'sponsor', amountCents: -1750 }]
        });
        // Owners paying more than is paid out: the sponsor receives the difference.
        const surplus = deal.schedule(deal.content(proposal([{ ownerKey: 'owner-a', cashPayment: 40 }, { ownerKey: 'owner-b', cashOffer: 10 }])));
        expect(surplus).toMatchObject({ sponsorCents: 3000, sponsorFundingCents: 0, balanced: true, currency: 'EUR' });
        // Payments alone still name a currency.
        expect(deal.content(proposal([{ ownerKey: 'owner-a', cashPayment: 5 }, { ownerKey: 'owner-b' }])).terms.currency).toBe('EUR');
    });

    it('keeps the signed fingerprint of deals without owner payments', () => {
        const plain = proposal([{ ownerKey: 'owner-a', cashOffer: 10 }, { ownerKey: 'owner-b', cashOffer: 20 }]);
        const zero = proposal([{ ownerKey: 'owner-a', cashOffer: 10, cashPayment: 0 }, { ownerKey: 'owner-b', cashOffer: 20, cashPayment: null }]);
        expect(deal.fingerprint(zero)).toBe(deal.fingerprint(plain));
        const paying = proposal([{ ownerKey: 'owner-a', cashOffer: 0, cashPayment: 10 }, { ownerKey: 'owner-b', cashOffer: 20 }]);
        expect(deal.fingerprint(paying)).not.toBe(deal.fingerprint(plain));
    });

    it('refuses an owner who both receives and pays, payments for open ground and negative amounts', () => {
        expect(() => deal.content(proposal([{ ownerKey: 'owner-a', cashOffer: 5, cashPayment: 5 }, { ownerKey: 'owner-b' }])))
            .toThrow('An owner either receives or pays cash, not both.');
        expect(() => deal.content(proposal([{ ownerKey: 'open-ground', unrepresentedGround: true, cashPayment: 1 }, { ownerKey: 'owner-b' }])))
            .toThrow('Unrepresented ground cannot receive or pay cash.');
        expect(() => deal.content(proposal([{ ownerKey: 'owner-a', cashPayment: -1 }, { ownerKey: 'owner-b' }]))).toThrow(/non-negative/);
    });

    it('stores a signed amount as a payout or a payment and reads it back', () => {
        expect(deal.cashFields(12.5)).toEqual({ cashOffer: 12.5 });
        expect(deal.cashFields(-7)).toEqual({ cashOffer: 0, cashPayment: 7 });
        expect(deal.cashFields(0)).toEqual({ cashOffer: 0 });
        expect(() => deal.cashFields(Number.NaN)).toThrow();
        expect(deal.netCash({ cashOffer: 0, cashPayment: 7 })).toBe(-7);
        expect(deal.netCash({ cashOffer: 3 })).toBe(3);
    });

    it('needs funding only for the sponsor’s share; owner payments settle with the payouts', () => {
        const covered = proposal([{ ownerKey: 'owner-a', cashPayment: 30 }, { ownerKey: 'owner-b', cashOffer: 30 }]);
        expect(validation.validate(covered, { turf })).toMatchObject({ fundingReady: true, money: { sponsorFundingCents: 0 } });
        const short = proposal([{ ownerKey: 'owner-a', cashPayment: 10 }, { ownerKey: 'owner-b', cashOffer: 30 }]);
        expect(validation.validate(short, { turf })).toMatchObject({ fundingReady: false, money: { sponsorFundingCents: 2000 } });
        expect(validation.validate({ ...short, funded: true }, { turf }).fundingReady).toBe(true);
    });

    it('tells the paying owner what they pay and every owner the whole schedule', () => {
        const item = proposal([{ ownerKey: 'owner-a', cashPayment: 12.5, contributedArea: 100 }, { ownerKey: 'owner-b', cashOffer: 30, contributedArea: 100 }]);
        const payer = review.ownerReview(item, 'owner-a', { turf });
        expect(payer.receives).toMatchObject({ payCents: 1250, cashCents: 0 });
        expect(payer.conditions.money).toMatchObject({ payOutCents: 3000, payInCents: 1250, sponsorCents: -1750 });
        expect(review.ownerReview(item, 'owner-b', { turf }).receives).toMatchObject({ payCents: 0, cashCents: 3000 });
    });

    it('refuses owner payments in split parcel agreements, which cannot carry them, but counts the offer without them', () => {
        const plan = { ownerShares: [{ ownerKey: 'owner-a', cashPayment: 5 }, { ownerKey: 'owner-b', cashOffer: 5 }] };
        // The offer is what owners receive; a joint deal keeps the payment in its schedule.
        expect(agreements.cashOfferTotal(plan)).toBe(5);
        expect(() => agreements.buildBatch({ proposal: { offer: 5, reparcellization: plan }, parts: [{}], cadastralParcels: [], groupId: 'g',
            titleForParcel: () => 'x' }, turf)).toThrow('owner payments need one joint readjustment agreement');
    });
});
