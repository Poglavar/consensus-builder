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

    it('pins one apartment across changes of price, maker, lens and camera', () => {
        const apartment = { xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::A4-C-23', at: '45.7665,15.9722,19' };
        const { parcels, ...buy } = base;
        const draft = Offer.published({ ...buy, apartment });
        expect(draft).not.toHaveProperty('parcels');
        const other = Offer.published({ ...buy, apartment: { ...apartment, at: '45.7,15.9,18' }, priceLamports: '10', proposer: OTHER, buyer: OTHER, lens: MAKER });
        expect(Offer.cid(draft)).not.toEqual(Offer.cid(other));
        expect(Offer.apartmentHash(draft.apartment)).toEqual(Offer.apartmentHash(other.apartment));
        expect(Offer.apartmentHash({ ...apartment, unit: '6::A4-C-21' })).not.toEqual(Offer.apartmentHash(apartment));
        const estimated = { ...apartment, unit: '6::A-1::' + 'a'.repeat(24) };
        expect(Offer.apartmentHash(estimated)).not.toEqual(Offer.apartmentHash({ ...estimated, unit: '6::A-1::' + 'b'.repeat(24) }));
        expect(Offer.validate({ ...draft, parcels })).toBeTruthy();
        expect(Offer.validate({ ...draft, apartment: { ...apartment, unit: '%36::A4-C-23' } })).toBeTruthy();
        expect(Offer.validate({ ...draft, city: 'astana' })).toBeTruthy();
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
