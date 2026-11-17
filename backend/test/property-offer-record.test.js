import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Offer = require('../../frontend/js/property-offer-record.js');

const MAKER = '11111111111111111111111111111111';
const OTHER = 'SysvarRent111111111111111111111111111111111';
const base = {
    schema: 'property-offer/v1', city: 'zagreb', createdAt: '2026-11-17T00:00:00.000Z', expiresAt: '2026-12-17T00:00:00.000Z',
    direction: 'buy', proposer: MAKER, buyer: MAKER, seller: null, lens: OTHER,
    parcels: [{ sourceId: 'oss-wfs', id: '2' }, { sourceId: 'oss-wfs', id: '1' }], priceLamports: '1000000000'
};

describe('property-offer/v1', () => {
    it('canonically sorts an atomic parcel bundle and gives it one CID', () => {
        const content = Offer.published(base);
        expect(content.parcels.map(parcel => parcel.id)).toEqual(['1', '2']);
        expect(Offer.validate(content)).toBeNull();
        expect(Offer.cid(content)).toMatch(/^bafkrei[a-z2-7]{52}$/);
    });

    it('keeps counterparties explicit and refuses an invented buy payout split', () => {
        expect(Offer.validate({ ...base, seller: OTHER })).toMatchObject({ code: 'invalid-property-offer' });
        expect(Offer.validate({ ...base, payouts: [{ recipient: OTHER, lamports: base.priceLamports }] })).toMatchObject({ code: 'invalid-property-offer' });
    });

    it('requires a complete exact sell payout schedule', () => {
        const sale = { ...base, direction: 'sell', buyer: null, seller: MAKER,
            payouts: [{ recipient: OTHER, lamports: '700000000' }, { recipient: MAKER, lamports: '300000000' }] };
        expect(Offer.validate(sale)).toBeNull();
        expect(Offer.published(sale).payouts.map(row => row.recipient)).toEqual([MAKER, OTHER].sort());
        expect(Offer.validate({ ...sale, payouts: [{ recipient: OTHER, lamports: '1' }] })).toMatchObject({ code: 'invalid-property-offer' });
    });
});
